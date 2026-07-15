import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { saveRuntimeSnapshot, withStagedPersistence } from "../store.js";
import type { RuntimeOutboxEntry } from "../store.js";
import type { UsageState, VigilState } from "../types.js";

interface MutationContext {
  state: VigilState;
  usage: UsageState;
  afterCommit<TResult>(
    effect: () => TResult | Promise<TResult>,
    descriptor?: DurableEffectDescriptor,
    complete?: DurableEffectCompletion<TResult>,
    fail?: DurableEffectFailure
  ): void;
}

type SnapshotWriter = typeof saveRuntimeSnapshot;

export interface DurableEffectDescriptor {
  key: string;
  kind: string;
  payload?: Record<string, unknown>;
  awaitAttempt?: boolean;
}

export type DurableEffectCompletion<TResult = unknown> = (
  result: TResult,
  state: VigilState,
  usage: UsageState
) => void | Promise<void>;
export type DurableEffectFailure = (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>;

export type DurableEffectTransition = "pending" | "running" | "failed" | "completed";
type DurableEffectObserver = (entry: RuntimeOutboxEntry, transition: DurableEffectTransition, error: string) => void;

export class RuntimeMutationCoordinator {
  private mutationTail: Promise<void> = Promise.resolve();
  private effectTail: Promise<void> = Promise.resolve();
  private immediateEffectTail: Promise<void> = Promise.resolve();
  private accepting = true;
  private recoveryHandler: ((entry: RuntimeOutboxEntry) => unknown | Promise<unknown>) | null = null;
  private recoveryCompletion: ((entry: RuntimeOutboxEntry, result: unknown, state: VigilState, usage: UsageState) => void | Promise<void>) | null = null;
  private recoveryFailure: ((entry: RuntimeOutboxEntry, error: Error, state: VigilState, usage: UsageState) => void | Promise<void>) | null = null;
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private operations = new Map<string, {
    run: () => unknown | Promise<unknown>;
    complete?: DurableEffectCompletion;
    fail?: DurableEffectFailure;
  }>();
  private effectObserver: DurableEffectObserver | null = null;
  private effectContext = new AsyncLocalStorage<boolean>();

  constructor(
    private readonly liveState: VigilState,
    private readonly liveUsage: UsageState,
    private readonly outbox: RuntimeOutboxEntry[] = [],
    private readonly persistSnapshot: SnapshotWriter = saveRuntimeSnapshot
  ) {}

  run<T>(operation: (context: MutationContext) => Promise<T>): Promise<T> {
    if (!this.accepting) return Promise.reject(stoppingError());
    let committedEffects: Array<{ entry: RuntimeOutboxEntry; run: () => unknown | Promise<unknown>; complete?: DurableEffectCompletion; fail?: DurableEffectFailure; awaitAttempt: boolean }> = [];
    const mutation = this.enqueueMutation(async () => {
      if (!this.accepting) throw stoppingError();
      const draftState = structuredClone(this.liveState);
      const draftUsage = structuredClone(this.liveUsage);
      const commitOutbox = structuredClone(this.outbox);
      const effects: Array<{ entry: RuntimeOutboxEntry; run: () => unknown | Promise<unknown>; complete?: DurableEffectCompletion; fail?: DurableEffectFailure; awaitAttempt: boolean }> = [];
      const staged = await withStagedPersistence(() => operation({
        state: draftState,
        usage: draftUsage,
        afterCommit: (effect, descriptor, complete, fail) => {
          const normalized = descriptor || { key: randomUUID(), kind: "ephemeral", payload: {} };
          let entry = commitOutbox.find((candidate) => candidate.key === normalized.key);
          if (!entry) {
            entry = {
              id: randomUUID(),
              key: normalized.key,
              kind: normalized.kind,
              payload: normalized.payload || {},
              createdAt: new Date().toISOString(),
              attempts: 0,
              lastError: "",
              status: "pending",
              startedAt: null,
              nextAttemptAt: null
            };
            commitOutbox.push(entry);
          }
          effects.push({
            entry,
            run: effect,
            complete: complete as DurableEffectCompletion | undefined,
            fail,
            awaitAttempt: descriptor?.awaitAttempt !== false
          });
        }
      }));
      try {
        await this.persistSnapshot(draftState, draftUsage, { outbox: commitOutbox });
      } catch (error) {
        await staged.rollback();
        throw error;
      }
      replaceContents(this.liveState, draftState);
      replaceContents(this.liveUsage, draftUsage);
      this.outbox.splice(0, this.outbox.length, ...commitOutbox);
      for (const effect of effects) {
        this.operations.set(effect.entry.id, { run: effect.run, complete: effect.complete, fail: effect.fail });
      }
      committedEffects = effects;
      return staged.result;
    });
    return mutation.then(async (result) => {
      // The mutation tail is released before any monitor, OS, or other external
      // work is awaited. Callers still observe the historical contract that a
      // committed request resolves successfully after its immediate effects
      // have had one attempt unless a latency-sensitive acknowledgement marks
      // an effect for background delivery.
      const attempts = committedEffects.map(({ entry, awaitAttempt }) => ({
        awaitAttempt,
        promise: this.enqueueEffect(entry)
      }));
      // An effect may perform a short follow-up mutation which publishes a
      // second effect. It cannot wait for work queued behind itself on the
      // single-consumer worker, so let the outer worker pick that work up.
      const waitForAttempts = !this.effectContext.getStore();
      const awaited = attempts.filter((attempt) => waitForAttempts && attempt.awaitAttempt);
      const background = attempts.filter((attempt) => !waitForAttempts || !attempt.awaitAttempt);
      for (const attempt of background) {
        void attempt.promise.catch((error) => {
          console.error("Vigil background effect worker failed unexpectedly:", error);
        });
      }
      await Promise.all(awaited.map((attempt) => attempt.promise));
      return result;
    });
  }

  stopAdmission(): void {
    this.accepting = false;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
  }

  resumeAdmission(): void {
    this.accepting = true;
    for (const entry of this.outbox) this.scheduleRetry(entry);
  }

  async drain(): Promise<void> {
    await this.mutationTail;
    await this.drainEffectWorkers();
    if (this.recoveryHandler) {
      await Promise.all([...this.outbox].map((entry) => this.enqueueEffect(entry, { scheduleRetry: false })));
    }
    await this.drainEffectWorkers();
    await this.mutationTail;
  }

  retryPending(
    handler: (entry: RuntimeOutboxEntry) => unknown | Promise<unknown>,
    complete?: (entry: RuntimeOutboxEntry, result: unknown, state: VigilState, usage: UsageState) => void | Promise<void>,
    fail?: (entry: RuntimeOutboxEntry, error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
  ): Promise<void> {
    this.recoveryHandler = handler;
    this.recoveryCompletion = complete || null;
    this.recoveryFailure = fail || null;
    return this.enqueueMutation(async () => structuredClone(this.outbox)).then(async (pending) => {
      await Promise.all(pending.map((entry) => this.enqueueEffect(entry)));
    });
  }

  pendingEffects(): RuntimeOutboxEntry[] {
    return structuredClone(this.outbox);
  }

  setEffectObserver(observer: DurableEffectObserver): void {
    this.effectObserver = observer;
    for (const entry of this.outbox) observer(entry, "pending", entry.lastError || "Durable effect is awaiting retry.");
  }

  private async executeEffect(entry: RuntimeOutboxEntry, options: { scheduleRetry?: boolean } = {}): Promise<void> {
    const running = await this.markRunning(entry.id);
    if (!running) return;
    const registered = this.operations.get(running.id);
    const operation = registered?.run || (this.recoveryHandler ? () => this.recoveryHandler?.(running) : null);
    if (!operation) return;
    let result: unknown;
    try {
      result = await operation();
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      const failed: RuntimeOutboxEntry = {
        ...running,
        status: "pending",
        startedAt: null,
        lastError: failure.message,
        nextAttemptAt: new Date(Date.now() + retryDelayMs(running.attempts)).toISOString()
      };
      try {
        await this.enqueueMutation(() => this.commitFailure(
          running,
          failed,
          failure,
          registered?.fail || (this.recoveryFailure ? (caught, state, usage) => this.recoveryFailure?.(running, caught, state, usage) : undefined)
        ));
        this.effectObserver?.(failed, "failed", failed.lastError);
      } catch (persistError) {
        console.error("Vigil could not persist post-commit effect failure metadata; the running intent remains retryable:", persistError);
        this.effectObserver?.(running, "failed", failed.lastError);
      }
      if (options.scheduleRetry !== false) this.scheduleRetry(failed);
      return;
    }
    try {
      await this.enqueueMutation(() => this.commitCompletion(
        running,
        result,
        registered?.complete || (this.recoveryCompletion ? (value, state, usage) => this.recoveryCompletion?.(running, value, state, usage) : undefined)
      ));
      this.effectObserver?.(running, "completed", "");
    } catch (error) {
      // Do not mutate the live list: both memory and disk must retain the intent
      // when the completion acknowledgement cannot be made durable.
      console.error("Vigil could not persist post-commit effect completion; the idempotent effect remains retryable:", error);
      this.effectObserver?.(running, "pending", `Completion acknowledgement failed: ${error instanceof Error ? error.message : String(error)}`);
      if (options.scheduleRetry !== false) this.scheduleRetry(running);
    }
  }

  private async commitCompletion(
    running: RuntimeOutboxEntry,
    result: unknown,
    complete?: DurableEffectCompletion
  ): Promise<void> {
    const draftState = structuredClone(this.liveState);
    const draftUsage = structuredClone(this.liveUsage);
    const completed = this.outbox.filter((candidate) => candidate.id !== running.id);
    await complete?.(result, draftState, draftUsage);
    await this.persistSnapshot(draftState, draftUsage, { outbox: completed });
    replaceContents(this.liveState, draftState);
    replaceContents(this.liveUsage, draftUsage);
    this.outbox.splice(0, this.outbox.length, ...completed);
    this.operations.delete(running.id);
    const timer = this.retryTimers.get(running.id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(running.id);
  }

  private async commitFailure(
    running: RuntimeOutboxEntry,
    failed: RuntimeOutboxEntry,
    error: Error,
    fail?: DurableEffectFailure
  ): Promise<void> {
    const draftState = structuredClone(this.liveState);
    const draftUsage = structuredClone(this.liveUsage);
    const candidate = this.outbox.map((entry) => entry.id === running.id ? failed : entry);
    await fail?.(error, draftState, draftUsage);
    await this.persistSnapshot(draftState, draftUsage, { outbox: candidate });
    replaceContents(this.liveState, draftState);
    replaceContents(this.liveUsage, draftUsage);
    this.outbox.splice(0, this.outbox.length, ...candidate);
  }

  private async persistReplacement(id: string, replacement: RuntimeOutboxEntry): Promise<void> {
    const candidate = this.outbox.map((entry) => entry.id === id ? replacement : entry);
    await this.persistSnapshot(this.liveState, this.liveUsage, { outbox: candidate });
    this.outbox.splice(0, this.outbox.length, ...candidate);
  }

  private scheduleRetry(entry: RuntimeOutboxEntry): void {
    if (!this.accepting || !this.recoveryHandler || this.retryTimers.has(entry.id)) return;
    const delay = Math.max(0, entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) - Date.now() : retryDelayMs(Math.max(1, entry.attempts)));
    const timer = setTimeout(() => {
      this.retryTimers.delete(entry.id);
      void this.enqueueEffect(entry);
    }, Math.min(delay, 30_000));
    timer.unref();
    this.retryTimers.set(entry.id, timer);
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.mutationTail.then(operation);
    this.mutationTail = queued.then(() => {}, () => {});
    return queued;
  }

  private enqueueEffect(entry: RuntimeOutboxEntry, options: { scheduleRetry?: boolean } = {}): Promise<void> {
    const immediate = immediateRuntimeEffect(entry);
    const tail = immediate ? this.immediateEffectTail : this.effectTail;
    const queued = tail.then(() => this.effectContext.run(true, () => this.executeEffect(entry, options)));
    if (immediate) this.immediateEffectTail = queued.then(() => {}, () => {});
    else this.effectTail = queued.then(() => {}, () => {});
    return queued;
  }

  private async drainEffectWorkers(): Promise<void> {
    await Promise.all([this.immediateEffectTail, this.effectTail]);
  }

  private async markRunning(id: string): Promise<RuntimeOutboxEntry | null> {
    return await this.enqueueMutation(async () => {
      const current = this.outbox.find((candidate) => candidate.id === id);
      if (!current) return null;
      const operation = this.operations.get(current.id) || this.recoveryHandler;
      if (!operation) return null;
      const running: RuntimeOutboxEntry = {
        ...structuredClone(current),
        attempts: current.attempts + 1,
        lastError: "",
        status: "running",
        startedAt: new Date().toISOString(),
        nextAttemptAt: null
      };
      try {
        await this.persistReplacement(current.id, running);
        this.effectObserver?.(running, "running", "Durable effect is running.");
        return running;
      } catch (error) {
        console.error("Vigil could not persist the running outbox state; the effect was not executed:", error);
        this.effectObserver?.(current, "pending", error instanceof Error ? error.message : String(error));
        this.scheduleRetry(current);
        return null;
      }
    });
  }
}

function immediateRuntimeEffect(entry: RuntimeOutboxEntry): boolean {
  if (entry.kind === "session-enforcement" || entry.kind === "policy-enforcement") return true;
  return entry.kind === "monitor-os" && entry.payload.action !== "mdm-push";
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000, 250 * (2 ** Math.min(7, Math.max(0, attempts - 1))));
}

export class BufferedServerResponse {
  readonly response: ServerResponse;
  statusCode = 200;
  ended = false;
  private headers: Record<string, string | number | string[]> = {};
  private chunks: Buffer[] = [];

  constructor(private readonly target: ServerResponse) {
    const self = this;
    this.response = new Proxy(target, {
      get(original, property, receiver) {
        if (property === "statusCode") return self.statusCode;
        if (property === "headersSent") return self.ended;
        if (property === "writableEnded" || property === "writableFinished") return self.ended;
        if (property === "writeHead") return self.writeHead.bind(self);
        if (property === "setHeader") return self.setHeader.bind(self);
        if (property === "getHeader") return self.getHeader.bind(self);
        if (property === "getHeaders") return () => ({ ...self.headers });
        if (property === "removeHeader") return (name: string) => { delete self.headers[name.toLowerCase()]; };
        if (property === "write") return self.write.bind(self);
        if (property === "end") return self.end.bind(self);
        return Reflect.get(original, property, receiver);
      },
      set(original, property, value, receiver) {
        if (property === "statusCode") { self.statusCode = Number(value); return true; }
        return Reflect.set(original, property, value, receiver);
      }
    });
  }

  successful(): boolean {
    return this.ended && this.statusCode >= 200 && this.statusCode < 400;
  }

  status(): number {
    return this.statusCode;
  }

  flush(): void {
    this.target.writeHead(this.statusCode, this.headers);
    this.target.end(Buffer.concat(this.chunks));
  }

  private writeHead(status: number, statusMessageOrHeaders?: string | Record<string, string | number | string[]>, extraHeaders?: Record<string, string | number | string[]>): ServerResponse {
    this.statusCode = status;
    const headers = typeof statusMessageOrHeaders === "string" ? extraHeaders : statusMessageOrHeaders;
    for (const [name, value] of Object.entries(headers || {})) this.headers[name.toLowerCase()] = value;
    return this.response;
  }

  private setHeader(name: string, value: string | number | readonly string[]): ServerResponse {
    this.headers[name.toLowerCase()] = Array.isArray(value) ? [...value] : value as string | number;
    return this.response;
  }

  private getHeader(name: string): string | number | string[] | undefined {
    return this.headers[name.toLowerCase()];
  }

  private write(chunk: unknown): boolean {
    if (chunk !== undefined && chunk !== null) this.chunks.push(toBuffer(chunk));
    return true;
  }

  private end(chunk?: unknown, encodingOrCallback?: unknown, callback?: unknown): ServerResponse {
    if (chunk !== undefined && chunk !== null) this.chunks.push(toBuffer(chunk));
    this.ended = true;
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    if (typeof callback === "function") callback();
    return this.response;
  }
}

function replaceContents<T extends object>(target: T, source: T): void {
  for (const key of Object.keys(target) as Array<keyof T>) delete target[key];
  Object.assign(target, source);
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}

function stoppingError(): Error & { status: number } {
  return Object.assign(new Error("Vigil is stopping and is not accepting state mutations."), { status: 503 });
}
