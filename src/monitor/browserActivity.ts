import { performance } from "node:perf_hooks";

// The leading zero is intentional: a wake gets one immediate look at the
// browser, followed by a sparse tail for URL and application state that settles
// shortly after the input. Repeated input may pull a tail probe earlier, but it
// cannot create overlapping probes or an unbounded per-event fan-out.
export const BROWSER_ACTIVITY_BURST_DELAYS_MS = Object.freeze([0, 125, 400, 900, 1_600, 2_600]);
export const BROWSER_ACTIVITY_BURST_WINDOW_MS = 2_600;
export const BROWSER_ACTIVITY_MIN_PROBE_GAP_MS = 250;
export const BROWSER_ACTIVITY_MAX_PROBE_GAP_MS = 300;

type TimerHandle = unknown;

export interface BrowserActivityBurstSchedulerDependencies {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

const defaultDependencies: BrowserActivityBurstSchedulerDependencies = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export class BrowserActivityBurstScheduler {
  private readonly probe: () => boolean | Promise<boolean>;
  private readonly dependencies: BrowserActivityBurstSchedulerDependencies;
  private wakeAt = 0;
  private wakeGeneration = 0;
  private active = false;
  private timer: TimerHandle | null = null;
  private timerDueAt: number | null = null;
  private inFlight: Promise<boolean> | null = null;
  private lastProbeAt: number | null = null;
  private lastProbeGeneration = 0;
  private probeCount = 0;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    probe: () => boolean | Promise<boolean>,
    dependencies: Partial<BrowserActivityBurstSchedulerDependencies> = {}
  ) {
    this.probe = probe;
    this.dependencies = { ...defaultDependencies, ...dependencies };
  }

  wake(): void {
    if (this.stopped) return;
    const now = this.dependencies.now();
    this.wakeAt = now;
    this.wakeGeneration += 1;

    if (!this.active) {
      this.active = true;
      this.lastProbeAt = null;
      this.lastProbeGeneration = 0;
      this.probeCount = 0;
      this.cancelTimer();
      this.launchProbe();
      return;
    }

    // Keep an already-earlier timer. scheduleNextProbe only replaces it when
    // this wake creates a stricter maximum-latency deadline.
    if (!this.inFlight) this.scheduleNextProbe();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.active = false;
    this.cancelTimer();
    const inFlight = this.inFlight;
    this.stopPromise = (async () => {
      if (inFlight) await inFlight;
    })();
    return this.stopPromise;
  }

  private launchProbe(): void {
    if (this.stopped || !this.active || this.inFlight) return;
    this.cancelTimer();
    const launchedGeneration = this.wakeGeneration;
    this.lastProbeAt = this.dependencies.now();
    this.lastProbeGeneration = launchedGeneration;
    this.probeCount += 1;
    const task = this.runProbe();
    this.inFlight = task;
    void task.then((keepRunning) => {
      if (this.inFlight !== task) return;
      this.inFlight = null;
      if (this.stopped) return;

      // A probe observes the browser state that existed while it was running.
      // Any later wake therefore requires one fresh catch-up, even if the slow
      // probe outlived the complete trailing horizon or asked to stop.
      if (this.wakeGeneration !== launchedGeneration) {
        this.scheduleNextProbe(true);
        return;
      }
      if (!keepRunning) {
        this.active = false;
        this.cancelTimer();
        return;
      }
      this.scheduleNextProbe();
    });
  }

  private async runProbe(): Promise<boolean> {
    try {
      return await this.probe();
    } catch {
      return true;
    }
  }

  private scheduleNextProbe(afterInFlightWake = false): void {
    if (this.inFlight || this.stopped || !this.active || this.lastProbeAt === null) return;
    const now = this.dependencies.now();
    const needsCatchUp = this.wakeGeneration !== this.lastProbeGeneration;
    const sparseDueAt = this.nextSparseDueAt(now);
    if (sparseDueAt === null && !needsCatchUp) {
      this.active = false;
      this.cancelTimer();
      return;
    }

    const minimumGap = this.probeCount <= 1 ? 0 : BROWSER_ACTIVITY_MIN_PROBE_GAP_MS;
    let dueAt = afterInFlightWake && needsCatchUp ? now : sparseDueAt!;
    if (needsCatchUp && !afterInFlightWake) {
      dueAt = Math.min(dueAt, this.lastProbeAt + BROWSER_ACTIVITY_MAX_PROBE_GAP_MS);
    }
    dueAt = Math.max(now, dueAt, this.lastProbeAt + minimumGap);

    if (this.timer !== null && this.timerDueAt !== null && this.timerDueAt <= dueAt) return;
    this.cancelTimer();
    if (dueAt <= now) {
      this.launchProbe();
      return;
    }
    this.timerDueAt = dueAt;
    this.timer = this.dependencies.setTimeout(() => {
      this.timer = null;
      this.timerDueAt = null;
      this.launchProbe();
    }, dueAt - now);
  }

  private nextSparseDueAt(now: number): number | null {
    for (const delayMs of BROWSER_ACTIVITY_BURST_DELAYS_MS) {
      const dueAt = this.wakeAt + delayMs;
      if (dueAt > now && (this.lastProbeAt === null || dueAt > this.lastProbeAt)) return dueAt;
    }
    return null;
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.dependencies.clearTimeout(this.timer);
    this.timer = null;
    this.timerDueAt = null;
  }
}
