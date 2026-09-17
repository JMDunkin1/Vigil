import assert from "node:assert/strict";
import { startDashboardRefresh } from "../public/dashboard-refresh.js";

class Visibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

const document = new Visibility();
const timers = new Map<number, { callback: () => void; delay: number; interval: boolean }>();
let nextTimer = 0;
const schedule = (handler: TimerHandler, delay: number, interval: boolean): number => {
  assert.equal(typeof handler, "function");
  const id = ++nextTimer;
  timers.set(id, { callback: handler as () => void, delay, interval });
  return id;
};
let refreshes = 0;
let countdowns = 0;
let completeRefresh: () => void = () => {};
const stop = startDashboardRefresh({
  document,
  timers: {
    setTimeout: (callback, delay = 0) => schedule(callback, delay, false),
    clearTimeout: (id) => { if (id !== undefined) timers.delete(id); },
    setInterval: (callback, delay = 0) => schedule(callback, delay, true),
    clearInterval: (id) => { if (id !== undefined) timers.delete(id); }
  },
  pollMs: 3_000,
  refresh: () => {
    refreshes += 1;
    return new Promise<void>((resolve) => { completeRefresh = resolve; });
  },
  renderCountdowns: () => { countdowns += 1; }
});
const settle = async () => { await new Promise<void>((resolve) => setImmediate(resolve)); };

assert.equal(refreshes, 1, "visible startup must immediately read authoritative state");
assert.equal(countdowns, 1);
assert.equal(timers.size, 1, "a slow request must not start overlapping poll requests");
document.setHidden(true);
assert.equal(timers.size, 0, "hidden dashboards must schedule no poll or countdown wakeups");
document.setHidden(false);
assert.equal(refreshes, 1, "resume during a request must reuse that request");
completeRefresh();
await settle();
assert.equal(timers.size, 2, "only the current visibility generation may schedule the next poll");

document.setHidden(true);
assert.equal(timers.size, 0);
document.setHidden(false);
assert.equal(refreshes, 2, "returning to the dashboard must refresh immediately, without a 30-second stale window");
const countdown = [...timers.values()].find((timer) => timer.interval);
assert.ok(countdown);
countdown.callback();
assert.equal(countdowns, 4);
completeRefresh();
await settle();
const poll = [...timers.entries()].find(([, timer]) => !timer.interval);
assert.ok(poll);
assert.equal(poll[1].delay, 3_000);
timers.delete(poll[0]);
poll[1].callback();
assert.equal(refreshes, 3);
document.setHidden(true);
completeRefresh();
await settle();
assert.equal(timers.size, 0, "a request completing while hidden must not restart timers");
stop();
document.setHidden(false);
assert.equal(refreshes, 3, "disposing must detach the visibility listener");

document.setHidden(true);
const stopHidden = startDashboardRefresh({
  document,
  timers: {
    setTimeout: () => { throw new Error("hidden startup scheduled timeout"); },
    clearTimeout() {},
    setInterval: () => { throw new Error("hidden startup scheduled interval"); },
    clearInterval() {}
  },
  pollMs: 3_000,
  refresh: async () => { throw new Error("hidden startup fetched state"); },
  renderCountdowns: () => { throw new Error("hidden startup rendered"); }
});
stopHidden();

document.setHidden(false);
let failures = 0;
let resumedRenders = 0;
const stopFailing = startDashboardRefresh({
  document,
  timers: {
    setTimeout: (callback, delay = 0) => schedule(callback, delay, false),
    clearTimeout: (id) => { if (id !== undefined) timers.delete(id); },
    setInterval: (callback, delay = 0) => schedule(callback, delay, true),
    clearInterval: (id) => { if (id !== undefined) timers.delete(id); }
  },
  pollMs: 3_000,
  refresh: async () => { throw new Error("network unavailable"); },
  renderCountdowns: () => {},
  renderOnResume: () => { resumedRenders += 1; },
  onError: () => { failures += 1; }
});
await settle();
assert.equal(failures, 1, "failed requests must be handled without an unhandled rejection");
assert.equal(resumedRenders, 1, "resuming may repaint the latest cached state before the request completes");
assert.equal(timers.size, 2, "polling must recover after a request failure");
stopFailing();
