import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageDay, UsageState } from "../src/types.js";

const dataDir = await mkdtemp(join(tmpdir(), "vigil-runtime-commit-"));
process.env.VIGIL_DATA_DIR = dataDir;

const [{ defaultState }, store, { RuntimeMutationCoordinator }, { Monitor }] = await Promise.all([
  import("../src/defaults.js"),
  import("../src/store.js"),
  import("../src/server/mutationCoordinator.js"),
  import("../src/monitor.js")
]);

try {
  const liveState = defaultState();
  const liveUsage: UsageState = {};
  await store.saveRuntimeSnapshot(liveState, liveUsage);
  const paths = [store.STATE_PATH, store.STATE_SEAL_PATH, store.USAGE_PATH, store.USAGE_SEAL_PATH];
  const before = await Promise.all(paths.map((path) => readFile(path)));
  const next = structuredClone(liveState);
  next.settings.siteRedirectEnabled = !next.settings.siteRedirectEnabled;
  next.integrity.stateSeal.lastCheckedAt = "2000-01-01T00:00:00.000Z";
  next.integrity.stateSeal.lastSealedAt = "2000-01-01T00:00:00.000Z";
  const nextBeforeFailedSnapshot = structuredClone(next);
  await assert.rejects(
    store.saveRuntimeSnapshot(next, { "2026-07-14": usageDay(7) }, {
      beforeUsageWrite() { throw new Error("deterministic second-write failure"); }
    }),
    /second-write failure/u
  );
  const after = await Promise.all(paths.map((path) => readFile(path)));
  for (let index = 0; index < paths.length; index += 1) {
    assert.deepEqual(after[index], before[index], `partial commit must restore ${paths[index]}`);
  }
  assert.deepEqual(next, nextBeforeFailedSnapshot, "a failed snapshot must not mutate the caller's live seal metadata");
  await store.saveRuntimeSnapshot(next, { "2026-07-14": usageDay(7) });
  assert.notEqual(next.integrity.stateSeal.lastSealedAt, "2000-01-01T00:00:00.000Z", "a successful snapshot must publish its seal marker to the caller");
  const storedNext = JSON.parse(await readFile(store.STATE_PATH, "utf8"));
  assert.deepEqual(storedNext.integrity.stateSeal, next.integrity.stateSeal, "the published caller marker must match the committed state file");

  for (const failedBoundary of ["journal-renamed", "journal-published", "state-published"]) {
    const committed = structuredClone(next);
    committed.settings.siteRedirectEnabled = !committed.settings.siteRedirectEnabled;
    const committedUsage = { "2026-07-14": usageDay(failedBoundary === "journal-renamed" ? 29 : failedBoundary === "journal-published" ? 31 : 37) };
    let boundaryReached = false;
    await store.saveRuntimeSnapshot(committed, committedUsage, {
      afterBoundary(boundary) {
        if (boundary === failedBoundary) {
          boundaryReached = true;
          throw new Error(`deterministic ${failedBoundary} replay failure`);
        }
      }
    });
    assert.equal(boundaryReached, true, `${failedBoundary} failure injection must reach its commit boundary`);
    const storedState = JSON.parse(await readFile(store.STATE_PATH, "utf8"));
    const storedUsage = JSON.parse(await readFile(store.USAGE_PATH, "utf8"));
    assert.equal(storedState.settings.siteRedirectEnabled, committed.settings.siteRedirectEnabled, `${failedBoundary} must still commit the new state generation`);
    assert.equal(storedUsage["2026-07-14"]?.totalSeconds, committedUsage["2026-07-14"].totalSeconds, `${failedBoundary} must finish the committed WAL replay`);
    await assert.rejects(readFile(store.RUNTIME_SNAPSHOT_JOURNAL_PATH), { code: "ENOENT" }, `${failedBoundary} replay must remove the completed WAL`);
    next.settings.siteRedirectEnabled = committed.settings.siteRedirectEnabled;
  }

  const coordinator = new RuntimeMutationCoordinator(liveState, liveUsage);
  let releaseFirst = () => {};
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted = () => {};
  const firstReady = new Promise<void>((resolve) => { firstStarted = resolve; });
  const first = coordinator.run(async ({ usage }) => {
    firstStarted();
    await firstGate;
    usage["2026-07-14"] = usageDay(11);
    await store.saveUsage(usage);
  });
  await firstReady;
  const second = coordinator.run(async ({ state }) => {
    state.settings.siteRedirectEnabled = false;
    await store.saveState(state);
  });
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(liveUsage["2026-07-14"]?.totalSeconds, 11, "monitor-like usage mutation must survive a queued request draft");
  assert.equal(liveState.settings.siteRedirectEnabled, false, "queued request mutation must build on the committed monitor draft");

  const completionState = defaultState();
  const completionCoordinator = new RuntimeMutationCoordinator(completionState, {}, [], async () => {});
  let markEffectStarted = () => {};
  const effectStarted = new Promise<void>((resolve) => { markEffectStarted = resolve; });
  let releaseEffect = () => {};
  const effectGate = new Promise<void>((resolve) => { releaseEffect = resolve; });
  const gatedEffect = completionCoordinator.run(async ({ state, afterCommit }) => {
    state.settings.siteRedirectEnabled = false;
    afterCommit(async () => {
      markEffectStarted();
      await effectGate;
      return { removalPassword: "effect-result" };
    }, { key: "gated-fresh-draft", kind: "test-effect", payload: {} }, (result, committedState) => {
      committedState.deviceControls.ios.removalPassword = result.removalPassword;
      committedState.events.unshift({ id: "effect-completed", type: "effect_completed", at: new Date().toISOString(), detail: {} });
    });
  });
  await effectStarted;
  await completionCoordinator.run(async ({ state }) => {
    state.settings.siteRedirectEnabled = true;
    state.settings.processSweepEnabled = false;
  });
  releaseEffect();
  await gatedEffect;
  assert.equal(completionState.settings.siteRedirectEnabled, true, "an intervening mutation must survive effect completion");
  assert.equal(completionState.settings.processSweepEnabled, false, "effect completion must draft from the latest committed state");
  assert.equal(completionState.deviceControls.ios.removalPassword, "effect-result", "the external effect result must be committed");
  assert.equal(completionState.events[0]?.type, "effect_completed", "the completion event must share the result transaction");
  assert.equal(completionCoordinator.pendingEffects().length, 0, "effect result and outbox removal must commit atomically");

  const eventsBefore = liveState.events.length;
  await assert.rejects(coordinator.run(async ({ state }) => {
    state.events.push({ id: "discard", type: "discard", at: new Date().toISOString(), detail: {} });
    await store.saveState(state);
    throw new Error("handler failed after staged save");
  }), /handler failed/u);
  assert.equal(liveState.events.length, eventsBefore, "a handler error after saveState must discard its draft");

  let detachedSave: Promise<void> | null = null;
  await coordinator.run(async ({ state }) => {
    setTimeout(() => {
      detachedSave = store.saveState(state);
      void detachedSave.catch(() => {});
    }, 0);
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(detachedSave);
  await assert.rejects(detachedSave, /closed/u, "detached async callbacks must not save through an inherited closed transaction");

  await coordinator.run(async ({ state, afterCommit }) => {
    state.settings.siteRedirectEnabled = true;
    afterCommit(() => { throw new Error("representative post-commit effect failure"); });
    await store.saveState(state);
  });
  assert.equal(liveState.settings.siteRedirectEnabled, true, "post-commit effect failure must not reject or roll back a committed mutation");
  assert.equal(coordinator.pendingEffects().length, 1, "failed post-commit effects remain durably retryable");

  const backgroundCoordinator = new RuntimeMutationCoordinator(defaultState(), {}, [], async () => {});
  let markBackgroundStarted = () => {};
  const backgroundStarted = new Promise<void>((resolve) => { markBackgroundStarted = resolve; });
  let releaseBackground = () => {};
  const backgroundGate = new Promise<void>((resolve) => { releaseBackground = resolve; });
  const backgroundCommit = backgroundCoordinator.run(async ({ afterCommit }) => {
    afterCommit(
      async () => {
        markBackgroundStarted();
        await backgroundGate;
      },
      { key: "background-delivery", kind: "test-effect", payload: {}, awaitAttempt: false }
    );
  });
  await withTimeout(backgroundCommit, "background effect commit acknowledgement");
  await backgroundStarted;
  assert.equal(backgroundCoordinator.pendingEffects().length, 1, "background delivery intent must remain durable while its attempt is active");
  releaseBackground();
  backgroundCoordinator.stopAdmission();
  await withTimeout(backgroundCoordinator.drain(), "background effect drain");
  assert.equal(backgroundCoordinator.pendingEffects().length, 0, "background delivery completion must still clear its durable intent");

  const priorityCoordinator = new RuntimeMutationCoordinator(defaultState(), {}, [], async () => {});
  let markPhoneEffectStarted = () => {};
  const phoneEffectStarted = new Promise<void>((resolve) => { markPhoneEffectStarted = resolve; });
  let releasePhoneEffect = () => {};
  const phoneEffectGate = new Promise<void>((resolve) => { releasePhoneEffect = resolve; });
  await priorityCoordinator.run(async ({ afterCommit }) => {
    afterCommit(async () => {
      markPhoneEffectStarted();
      await phoneEffectGate;
    }, { key: "slow-phone-effect", kind: "mdm-push", payload: {}, awaitAttempt: false });
  });
  await phoneEffectStarted;
  let immediateRuns = 0;
  await withTimeout(priorityCoordinator.run(async ({ afterCommit }) => {
    afterCommit(() => { immediateRuns += 1; }, {
      key: "urgent-session-enforcement",
      kind: "session-enforcement",
      payload: { sessionId: "urgent" }
    });
  }), "immediate enforcement priority lane");
  assert.equal(immediateRuns, 1, "local session enforcement must not wait for a slow phone/network effect");
  releasePhoneEffect();
  priorityCoordinator.stopAdmission();
  await withTimeout(priorityCoordinator.drain(), "priority effect drain");

  let effectRuns = 0;
  let failCompletionAck = true;
  const ackCoordinator = new RuntimeMutationCoordinator(liveState, liveUsage, [], async (nextState, nextUsage, options = {}) => {
    if (failCompletionAck && effectRuns > 0 && (options.outbox || []).length === 0) {
      failCompletionAck = false;
      throw new Error("deterministic completion acknowledgement failure");
    }
    await store.saveRuntimeSnapshot(nextState, nextUsage, options);
  });
  const effectTransitions: string[] = [];
  ackCoordinator.setEffectObserver((_entry, transition) => effectTransitions.push(transition));
  await ackCoordinator.retryPending(async () => { effectRuns += 1; });
  await ackCoordinator.run(async ({ afterCommit }) => {
    afterCommit(async () => { effectRuns += 1; }, { key: "ack-failure", kind: "test-effect", payload: {} });
  });
  assert.equal(effectRuns, 1);
  assert.equal(ackCoordinator.pendingEffects().length, 1, "ack failure must retain the completed intent in memory");
  assert.equal((await store.loadRuntimeOutbox()).length, 1, "ack failure must retain the completed intent on disk");
  assert.equal(effectTransitions.at(-1), "pending", "health observers must not see success before the completion acknowledgement is durable");
  await ackCoordinator.retryPending(async () => { effectRuns += 1; });
  assert.equal(effectRuns, 2, "an unacknowledged idempotent effect must be replayed");
  assert.equal(ackCoordinator.pendingEffects().length, 0);
  assert.equal((await store.loadRuntimeOutbox()).length, 0);
  assert.equal(effectTransitions.at(-1), "completed", "only a durable outbox removal may publish effect recovery");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(effectRuns, 2, "a cleared retry timer must not replay an effect after its manual retry completed");
  ackCoordinator.stopAdmission();
  await ackCoordinator.drain();

  const transitionState = defaultState();
  transitionState.integrity.stateSeal.lastCheckedAt = "2001-01-01T00:00:00.000Z";
  transitionState.integrity.stateSeal.lastSealedAt = "2001-01-01T00:00:00.000Z";
  const transitionBefore = structuredClone(transitionState);
  const transitionOutbox = [{
    id: "seal-transition",
    key: "seal-transition",
    kind: "test-effect",
    payload: {},
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: "",
    status: "pending" as const,
    startedAt: null,
    nextAttemptAt: null
  }];
  let failRunningTransition = true;
  let transitionRuns = 0;
  const transitionCoordinator = new RuntimeMutationCoordinator(transitionState, {}, transitionOutbox, async (state, usage, options = {}) => {
    await store.saveRuntimeSnapshot(state, usage, {
      ...options,
      ...(failRunningTransition ? { beforeUsageWrite() { throw new Error("deterministic running transition failure"); } } : {})
    });
  });
  await transitionCoordinator.retryPending(async () => { transitionRuns += 1; });
  transitionCoordinator.stopAdmission();
  assert.equal(transitionRuns, 0, "an effect must not run when its running transition was not persisted");
  assert.deepEqual(transitionState, transitionBefore, "a failed outbox transition must leave the entire live state unchanged");
  failRunningTransition = false;
  await transitionCoordinator.retryPending(async () => { transitionRuns += 1; });
  assert.equal(transitionRuns, 1);
  assert.notEqual(transitionState.integrity.stateSeal.lastSealedAt, "2001-01-01T00:00:00.000Z", "a successful outbox transition must publish committed seal metadata");
  const storedTransitionState = JSON.parse(await readFile(store.STATE_PATH, "utf8"));
  assert.deepEqual(storedTransitionState.integrity.stateSeal, transitionState.integrity.stateSeal, "outbox completion must publish the same seal metadata held on disk");
  assert.equal(transitionCoordinator.pendingEffects().length, 0);
  await transitionCoordinator.drain();

  const reentrantCoordinator = new RuntimeMutationCoordinator(defaultState(), {}, [], async () => {});
  let nestedEffectRuns = 0;
  await withTimeout(reentrantCoordinator.run(async ({ afterCommit }) => {
    afterCommit(async () => {
      await reentrantCoordinator.run(async ({ afterCommit: afterNestedCommit }) => {
        afterNestedCommit(
          () => { nestedEffectRuns += 1; },
          { key: "nested-worker-effect", kind: "test-effect", payload: {} }
        );
      });
    }, { key: "outer-worker-effect", kind: "test-effect", payload: {} });
  }), "effect-worker reentrant mutation");
  reentrantCoordinator.stopAdmission();
  await withTimeout(reentrantCoordinator.drain(), "effect-worker reentrant drain");
  assert.equal(nestedEffectRuns, 1, "an effect-worker mutation may enqueue follow-up work without waiting behind itself");
  assert.equal(reentrantCoordinator.pendingEffects().length, 0, "reentrant effect work must preserve all completion acknowledgements");

  const deadlockState = defaultState();
  const deadlockUsage: UsageState = {};
  let deadlockCoordinator: InstanceType<typeof RuntimeMutationCoordinator>;
  let markTickWaiting = () => {};
  const tickWaitingOnCoordinator = new Promise<void>((resolve) => { markTickWaiting = resolve; });
  const deadlockMonitor = new Monitor({
    state: deadlockState,
    usage: deadlockUsage,
    mutate: async (operation) => {
      markTickWaiting();
      return await deadlockCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit));
    }
  });
  let tickRuns = 0;
  deadlockMonitor.tick = async () => { tickRuns += 1; };
  let effectRunsAfterBarrier = 0;
  deadlockMonitor.runImmediateEnforcement = async () => {
    effectRunsAfterBarrier += 1;
    return { ok: true };
  };
  deadlockCoordinator = new RuntimeMutationCoordinator(deadlockState, deadlockUsage, [], async () => {});
  const deadlockTransitions: string[] = [];
  deadlockCoordinator.setEffectObserver((_entry, transition) => deadlockTransitions.push(transition));
  let releaseRequestCommit = () => {};
  const requestCommitGate = new Promise<void>((resolve) => { releaseRequestCommit = resolve; });
  let markRequestAtCommit = () => {};
  const requestAtCommit = new Promise<void>((resolve) => { markRequestAtCommit = resolve; });
  const deadlockRequest = deadlockCoordinator.run(async ({ afterCommit }) => {
    afterCommit(
      async () => { await deadlockMonitor.reconcileDurableEffect("session-enforcement", { sessionId: "deadlock-regression" }); },
      { key: "session-enforcement:deadlock-regression", kind: "session-enforcement", payload: { sessionId: "deadlock-regression" } }
    );
    markRequestAtCommit();
    await requestCommitGate;
  });
  await requestAtCommit;
  // The tick now owns Monitor.operationTail and is queued behind the request's
  // coordinator mutation. The request effect will in turn queue behind this
  // tick: awaiting it on the mutation tail produced the old three-way cycle.
  const blockedTick = deadlockMonitor.runScheduledTick();
  await tickWaitingOnCoordinator;
  releaseRequestCommit();
  await withTimeout(Promise.all([deadlockRequest, blockedTick]), "coordinator/monitor deadlock regression");
  assert.equal(tickRuns, 1);
  assert.equal(effectRunsAfterBarrier, 1);
  assert.deepEqual(deadlockTransitions, ["running", "completed"], "the effect worker must durably publish the exact running/completed transitions");
  assert.equal(deadlockCoordinator.pendingEffects().length, 0, "completed deadlock-regression effect must not be lost in the outbox");
  deadlockCoordinator.stopAdmission();
  await withTimeout((async () => {
    await deadlockMonitor.stop();
    await deadlockCoordinator.drain();
  })(), "coordinator/monitor shutdown drain");

  const recoveredState = defaultState();
  const recoveredUsage: UsageState = {};
  const recoveredOutbox = [
    {
      id: "recovered-session",
      key: "session-enforcement:recovered-session",
      kind: "session-enforcement",
      payload: { sessionId: "recovered-session" },
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: "",
      status: "pending" as const,
      startedAt: null,
      nextAttemptAt: null
    },
    {
      id: "recovered-policy",
      key: "policy-enforcement:recovered-policy",
      kind: "policy-enforcement",
      payload: { reason: "recovered-policy" },
      createdAt: new Date().toISOString(),
      attempts: 0,
      lastError: "",
      status: "pending" as const,
      startedAt: null,
      nextAttemptAt: null
    }
  ];
  let recoveredCoordinator: InstanceType<typeof RuntimeMutationCoordinator>;
  const recoveredMonitor = new Monitor({
    state: recoveredState,
    usage: recoveredUsage,
    mutate: async (operation) => await recoveredCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
  });
  let markRecoveredSessionStarted = () => {};
  const recoveredSessionStarted = new Promise<void>((resolve) => { markRecoveredSessionStarted = resolve; });
  let releaseRecoveredSession = () => {};
  const recoveredSessionGate = new Promise<void>((resolve) => { releaseRecoveredSession = resolve; });
  let markRecoveredMutation = () => {};
  const recoveredMutation = new Promise<void>((resolve) => { markRecoveredMutation = resolve; });
  let releaseConcurrentApi = () => {};
  const concurrentApiGate = new Promise<void>((resolve) => { releaseConcurrentApi = resolve; });
  const recoveredReasons: string[] = [];
  const nestedWasDurable: boolean[] = [];
  let nestedOsRuns = 0;
  recoveredMonitor.runImmediateEnforcement = async (reason: string) => {
    if (reason === "session-start") {
      markRecoveredSessionStarted();
      await recoveredSessionGate;
    }
    recoveredMonitor.state.events.unshift({ id: `recovered-${reason}`, type: `recovered_${reason}`, at: new Date().toISOString(), detail: {} });
    const day = recoveredMonitor.usage["2026-07-14"] ||= usageDay(0);
    day.totalSeconds += reason === "session-start" ? 13 : 17;
    const nested = await recoveredMonitor.externalEffect(
      "audit-nested-os",
      { reason },
      async () => {
        nestedOsRuns += 1;
        return { ok: true, reason };
      }
    );
    nestedWasDurable.push("pending" in nested && Boolean(nested.pending));
    recoveredReasons.push(reason);
    if (reason === "session-start") markRecoveredMutation();
    return { ok: true, reason };
  };
  recoveredCoordinator = new RuntimeMutationCoordinator(recoveredState, recoveredUsage, recoveredOutbox, async () => {});
  const nestedTransitions: string[] = [];
  recoveredCoordinator.setEffectObserver((entry, transition) => {
    if (entry.kind === "monitor-os") nestedTransitions.push(transition);
  });
  const recovery = recoveredCoordinator.retryPending(
    async (entry) => await recoveredMonitor.reconcileDurableEffect(entry.kind, { ...entry.payload, intentKey: entry.key })
  );
  await recoveredSessionStarted;
  const concurrentApi = recoveredCoordinator.run(async ({ state }) => {
    state.settings.processSweepEnabled = false;
    state.events.unshift({ id: "concurrent-api", type: "concurrent_api", at: new Date().toISOString(), detail: {} });
    await concurrentApiGate;
  });
  releaseRecoveredSession();
  await recoveredMutation;
  releaseConcurrentApi();
  await withTimeout(Promise.all([recovery, concurrentApi]), "recovered enforcement serialization");
  await withTimeout(recoveredCoordinator.drain(), "recovered nested intent drain");
  assert.deepEqual(recoveredReasons, ["session-start", "recovered-policy"], "both recovered enforcement kinds must run");
  assert.deepEqual(nestedWasDurable, [true, true], "nested OS work must be registered in the durable outbox");
  assert.equal(nestedOsRuns, 2, "the effect worker must drain nested OS intents without self-awaiting");
  assert.equal(recoveredUsage["2026-07-14"]?.totalSeconds, 30, "all recovered usage accounting must survive the concurrent API commit");
  assert.equal(recoveredState.settings.processSweepEnabled, false, "the concurrent API mutation must survive recovered enforcement");
  assert.ok(recoveredState.events.some((event) => event.type === "recovered_session-start"));
  assert.ok(recoveredState.events.some((event) => event.type === "recovered_recovered-policy"));
  assert.ok(recoveredState.events.some((event) => event.type === "concurrent_api"));
  assert.deepEqual(nestedTransitions, ["running", "completed", "running", "completed"], "nested intents must make durable running/completed transitions");
  assert.equal(recoveredCoordinator.pendingEffects().length, 0, "recovered and nested intents must all complete");
  recoveredCoordinator.stopAdmission();
  await withTimeout((async () => {
    await recoveredMonitor.stop();
    await recoveredCoordinator.drain();
  })(), "recovered enforcement shutdown drain");

  coordinator.stopAdmission();
  await assert.rejects(coordinator.run(async () => {}), /stopping/u);
  await coordinator.drain();
} finally {
  await rm(dataDir, { recursive: true, force: true });
}

async function withTimeout<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

for (const boundary of [
  "journal-temp-fsynced",
  "journal-published",
  "state-published",
  "stateSeal-published",
  "usage-published",
  "usageSeal-published",
  "outbox-published",
  "journal-removed"
]) {
  const crashDir = await mkdtemp(join(tmpdir(), `vigil-runtime-crash-${boundary}-`));
  try {
    await snapshotChild("save-old", crashDir);
    const crash = await snapshotChild("save-new", crashDir, boundary, true);
    assert.equal(crash.signal, "SIGKILL", `crash injection must kill the writer at ${boundary}`);
    const recovered = JSON.parse((await snapshotChild("load", crashDir)).stdout) as { enabled: boolean; seconds: number };
    const expectedNew = boundary !== "journal-temp-fsynced";
    assert.equal(recovered.enabled, expectedNew, `${boundary} restart must select one complete generation`);
    assert.equal(recovered.seconds, expectedNew ? 23 : 5, `${boundary} must never mix state and usage generations`);
  } finally {
    await rm(crashDir, { recursive: true, force: true });
  }
}

const aggregateJournalDir = await mkdtemp(join(tmpdir(), "vigil-runtime-large-journal-"));
try {
  await snapshotChild("save-old", aggregateJournalDir);
  const crash = await snapshotChild("save-large", aggregateJournalDir, "journal-published", true);
  assert.equal(crash.signal, "SIGKILL", "large aggregate WAL fixture must crash after publication");
  const recovered = JSON.parse((await snapshotChild("load-large", aggregateJournalDir)).stdout) as { enabled: boolean; paddingLength: number };
  assert.equal(recovered.enabled, true, "a valid aggregate WAL larger than one file limit must be replayed");
  assert.equal(recovered.paddingLength, 17 * 1024 * 1024, "large aggregate WAL recovery must preserve its complete usage payload");
} finally {
  await rm(aggregateJournalDir, { recursive: true, force: true });
}

function usageDay(totalSeconds: number): UsageDay {
  return { totalSeconds, apps: {}, sites: {}, opens: { apps: {}, sites: {} }, devices: {} };
}

async function snapshotChild(
  mode: "save-old" | "save-new" | "save-large" | "load" | "load-large",
  directory: string,
  boundary = "",
  allowFailure = false
): Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }> {
  const storeUrl = new URL("../src/store.js", import.meta.url).href;
  const defaultsUrl = new URL("../src/defaults.js", import.meta.url).href;
  const source = `
    const store = await import(${JSON.stringify(storeUrl)});
    const { defaultState } = await import(${JSON.stringify(defaultsUrl)});
    const mode = ${JSON.stringify(mode)};
    if (mode === "load" || mode === "load-large") {
      const state = await store.loadState();
      if (mode === "load-large") {
        const { readFile } = await import("node:fs/promises");
        const usage = JSON.parse(await readFile(store.USAGE_PATH, "utf8"));
        process.stdout.write(JSON.stringify({ enabled: state.settings.siteRedirectEnabled, paddingLength: usage.padding?.length || 0 }));
      } else {
        const usage = await store.loadUsage(state);
        process.stdout.write(JSON.stringify({ enabled: state.settings.siteRedirectEnabled, seconds: usage["2026-07-14"]?.totalSeconds || 0 }));
      }
    } else {
      const state = defaultState();
      state.settings.siteRedirectEnabled = mode !== "save-old";
      if (mode === "save-large") {
        await store.saveRuntimeSnapshot(state, { padding: String.fromCharCode(92).repeat(17 * 1024 * 1024) });
      } else {
        const seconds = mode === "save-new" ? 23 : 5;
        await store.saveRuntimeSnapshot(state, { "2026-07-14": { totalSeconds: seconds, apps: {}, sites: {}, opens: { apps: {}, sites: {} }, devices: {} } });
      }
    }
  `;
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      env: {
        ...process.env,
        VIGIL_DATA_DIR: directory,
        ...(boundary ? { VIGIL_SNAPSHOT_CRASH_AT: boundary } : {})
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ stdout, stderr, code, signal }));
  });
  if (!allowFailure && result.code !== 0) throw new Error(`Snapshot child failed: ${result.stderr}`);
  return result;
}
