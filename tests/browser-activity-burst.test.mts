import assert from "node:assert/strict";
import {
  BROWSER_ACTIVITY_BURST_DELAYS_MS,
  BROWSER_ACTIVITY_BURST_WINDOW_MS,
  BROWSER_ACTIVITY_MAX_PROBE_GAP_MS,
  BROWSER_ACTIVITY_MIN_PROBE_GAP_MS,
  BrowserActivityBurstScheduler
} from "../src/monitor/browserActivity.js";

interface FakeTimer {
  id: number;
  dueAt: number;
  callback: () => void;
}

class FakeClock {
  time = 0;
  timerSetCount = 0;
  timerClearCount = 0;
  private nextTimerId = 1;
  private timers = new Map<number, FakeTimer>();

  now = (): number => this.time;

  setTimeout = (callback: () => void, delayMs: number): number => {
    const id = this.nextTimerId;
    this.nextTimerId += 1;
    this.timerSetCount += 1;
    this.timers.set(id, { id, dueAt: this.time + delayMs, callback });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    if (this.timers.delete(Number(handle))) this.timerClearCount += 1;
  };

  nextTimerDueAt(): number | null {
    const dueAt = [...this.timers.values()].map((timer) => timer.dueAt).sort((left, right) => left - right)[0];
    return dueAt ?? null;
  }

  async flush(): Promise<void> {
    for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();
  }

  async advanceTo(target: number): Promise<void> {
    assert.ok(target >= this.time, "fake time cannot move backwards");
    await this.flush();
    while (true) {
      const next = [...this.timers.values()]
        .filter((timer) => timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      this.timers.delete(next.id);
      this.time = next.dueAt;
      next.callback();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

function schedulerDependencies(clock: FakeClock) {
  return {
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  };
}

assert.deepEqual(BROWSER_ACTIVITY_BURST_DELAYS_MS, [0, 125, 400, 900, 1_600, 2_600]);
assert.equal(BROWSER_ACTIVITY_BURST_WINDOW_MS, 2_600);
assert.equal(BROWSER_ACTIVITY_MIN_PROBE_GAP_MS, 250);
assert.equal(BROWSER_ACTIVITY_MAX_PROBE_GAP_MS, 300);

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes.push(clock.now());
    return clock.now() < 120;
  }, schedulerDependencies(clock));

  scheduler.wake();
  assert.deepEqual(probes, [0], "the first activity signal must launch a leading probe synchronously");
  await clock.advanceTo(125);
  assert.deepEqual(probes, [0, 125], "the first sparse follow-up must catch a URL that settles after the leading probe");
  await clock.advanceTo(5_000);
  assert.deepEqual(probes, [0, 125], "a false follow-up must stop the remaining tail");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes.push(clock.now());
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.advanceTo(BROWSER_ACTIVITY_BURST_WINDOW_MS);
  assert.deepEqual(
    probes,
    BROWSER_ACTIVITY_BURST_DELAYS_MS,
    "one isolated wake must have a finite leading-plus-sparse-tail query budget"
  );
  await clock.advanceTo(10_000);
  assert.deepEqual(probes, BROWSER_ACTIVITY_BURST_DELAYS_MS, "the burst must become dormant after its final horizon");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes.push(clock.now());
    return probes.length < 3;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.advanceTo(2_000);
  assert.deepEqual(probes, [0, 125, 400], "a false result must end the active burst");

  scheduler.wake();
  assert.deepEqual(probes, [0, 125, 400, 2_000], "activity after dormancy must get a new immediate leading probe");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes.push(clock.now());
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.flush();
  assert.equal(clock.nextTimerDueAt(), 125);
  assert.equal(clock.timerSetCount, 1);
  clock.time = 50;
  scheduler.wake();
  assert.equal(clock.nextTimerDueAt(), 125, "a newer wake must preserve an already-earlier probe");
  assert.equal(clock.timerSetCount, 1, "preserving an earlier probe must not allocate a replacement timer");
  assert.equal(clock.timerClearCount, 0, "preserving an earlier probe must not churn timer cancellation");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes.push(clock.now());
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  for (let at = 50; at <= 2_000; at += 50) {
    await clock.advanceTo(at);
    scheduler.wake();
  }
  await clock.advanceTo(2_300);

  assert.equal(probes[0], 0);
  const sustainedGaps = probes.slice(1).map((at, index) => at - probes[index]!).filter((_gap, index) => probes[index + 1]! <= 2_300);
  assert.ok(
    sustainedGaps.every((gap) => gap <= BROWSER_ACTIVITY_MAX_PROBE_GAP_MS),
    `sustained activity exceeded the ${BROWSER_ACTIVITY_MAX_PROBE_GAP_MS}ms probe bound: ${sustainedGaps.join(", ")}`
  );
  assert.ok(
    sustainedGaps.slice(1).every((gap) => gap >= BROWSER_ACTIVITY_MIN_PROBE_GAP_MS),
    "coalesced sustained input must not turn into one expensive query per event"
  );
  assert.equal(clock.timerClearCount, 0, "high-rate activity must reuse the earlier pending timer instead of churning it");

  const probesAtEndOfInput = probes.length;
  await clock.advanceTo(2_000 + BROWSER_ACTIVITY_BURST_WINDOW_MS + BROWSER_ACTIVITY_MIN_PROBE_GAP_MS);
  const settledProbeCount = probes.length;
  assert.ok(
    settledProbeCount - probesAtEndOfInput <= BROWSER_ACTIVITY_BURST_DELAYS_MS.length,
    "activity cessation must leave only a bounded sparse tail"
  );
  await clock.advanceTo(10_000);
  assert.equal(probes.length, settledProbeCount, "sustained activity must still converge to dormancy after input stops");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  let releaseFirstProbe = () => {};
  const firstProbe = new Promise<void>((resolve) => { releaseFirstProbe = resolve; });
  const scheduler = new BrowserActivityBurstScheduler(async () => {
    probes.push(clock.now());
    if (probes.length === 1) await firstProbe;
    return false;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.advanceTo(100);
  scheduler.wake();
  await clock.advanceTo(3_000);
  assert.deepEqual(probes, [0]);
  releaseFirstProbe();
  await clock.flush();
  assert.deepEqual(
    probes,
    [0, 3_000],
    "a wake during a slow probe must force an immediate catch-up even after the new wake's full horizon"
  );
  await clock.advanceTo(10_000);
  assert.deepEqual(probes, [0, 3_000], "a false catch-up must stop after observing the newer activity");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  let attempts = 0;
  const scheduler = new BrowserActivityBurstScheduler(() => {
    attempts += 1;
    probes.push(clock.now());
    if (attempts === 1) throw new Error("deterministic probe failure");
    return attempts < 3;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.advanceTo(500);
  assert.deepEqual(probes, [0, 125, 400], "a failed leading probe must not kill the sparse recovery tail");
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const scheduler = new BrowserActivityBurstScheduler(async () => {
    probes.push(clock.now());
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => {
      clock.setTimeout(resolve, 200);
    });
    active -= 1;
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  scheduler.wake();
  await clock.advanceTo(2_700);
  assert.equal(probes[0], 0);
  assert.equal(probes[1], 200, "activity coalesced during the leading probe must get one immediate catch-up");
  assert.equal(maximumActive, 1, "browser probes must never overlap");

  const stopping = scheduler.stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await clock.flush();
  assert.equal(stopped, false, "stop must drain the in-flight probe");
  scheduler.wake();
  await clock.advanceTo(3_000);
  await stopping;
  assert.equal(stopped, true);
  const completedProbeCount = probes.length;
  scheduler.wake();
  await clock.advanceTo(10_000);
  assert.equal(probes.length, completedProbeCount, "no probe callback may run after stop");
}

{
  const clock = new FakeClock();
  const probes: number[] = [];
  const scheduler = new BrowserActivityBurstScheduler(async () => {
    probes.push(clock.now());
    await new Promise<void>((resolve) => {
      clock.setTimeout(resolve, 40);
    });
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  await clock.advanceTo(10);
  scheduler.wake();
  await clock.advanceTo(40);
  assert.deepEqual(probes, [0, 40], "the leading probe may still get its immediate in-flight catch-up");

  await clock.advanceTo(50);
  scheduler.wake();
  await clock.advanceTo(80);
  assert.deepEqual(probes, [0, 40], "a wake during the catch-up probe must wait for the minimum gap");
  assert.equal(clock.nextTimerDueAt(), 290);

  await clock.advanceTo(290);
  await clock.advanceTo(300);
  scheduler.wake();
  await clock.advanceTo(330);
  assert.equal(clock.nextTimerDueAt(), 540);
  await clock.advanceTo(540);
  assert.deepEqual(probes, [0, 40, 290, 540]);
  assert.ok(
    probes.slice(2).every((at, index) => at - probes[index + 1]! >= BROWSER_ACTIVITY_MIN_PROBE_GAP_MS),
    "successive in-flight wakes must not drive probes faster than the minimum gap"
  );

  await clock.advanceTo(580);
  await scheduler.stop();
}

{
  const clock = new FakeClock();
  let probes = 0;
  const scheduler = new BrowserActivityBurstScheduler(() => {
    probes += 1;
    return true;
  }, schedulerDependencies(clock));

  scheduler.wake();
  assert.equal(probes, 1);
  await clock.flush();
  await scheduler.stop();
  await scheduler.stop();
  await clock.advanceTo(5_000);
  assert.equal(probes, 1, "stop must cancel the pending sparse tail and remain idempotent");
}
