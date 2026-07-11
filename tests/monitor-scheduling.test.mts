import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";

const state = defaultState();
const monitor = new Monitor({ state, usage: {} });

let releaseTick = () => {};
const tickGate = new Promise<void>((resolve) => {
  releaseTick = resolve;
});
let tickCalls = 0;
monitor.tick = async () => {
  tickCalls += 1;
  await tickGate;
};

const first = monitor.runScheduledTick();
const overlapping = monitor.runScheduledTick();
assert.equal(overlapping, first);
await Promise.resolve();
assert.equal(tickCalls, 1);
releaseTick();
await first;

monitor.tick = async () => {
  tickCalls += 1;
  throw new Error("scheduled tick exploded");
};
await monitor.runScheduledTick();

assert.equal(tickCalls, 2);
assert.equal(monitor.status.ok, false);
assert.match(monitor.status.lastError, /scheduled tick exploded/);
assert.equal(state.events[0]?.type, "monitor_tick_failed");
assert.equal(state.events[0]?.detail.error, "scheduled tick exploded");

const serializedMonitor = new Monitor({ state: defaultState(), usage: {} });
let activeOperations = 0;
let maximumActiveOperations = 0;
let serializedTickCalls = 0;
let releaseSerializedTick = () => {};
let markTickStarted = () => {};
const serializedTickGate = new Promise<void>((resolve) => {
  releaseSerializedTick = resolve;
});
const tickStarted = new Promise<void>((resolve) => {
  markTickStarted = resolve;
});

serializedMonitor.tick = async () => {
  serializedTickCalls += 1;
  activeOperations += 1;
  maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
  markTickStarted();
  await serializedTickGate;
  activeOperations -= 1;
};

let immediateStarted = false;
let releaseImmediate = () => {};
let markImmediateStarted = () => {};
const immediateGate = new Promise<void>((resolve) => {
  releaseImmediate = resolve;
});
const immediateDidStart = new Promise<void>((resolve) => {
  markImmediateStarted = resolve;
});
serializedMonitor.runImmediateEnforcement = async (reason: string) => {
  immediateStarted = true;
  activeOperations += 1;
  maximumActiveOperations = Math.max(maximumActiveOperations, activeOperations);
  markImmediateStarted();
  await immediateGate;
  activeOperations -= 1;
  return { reason };
};

const serializedTick = serializedMonitor.runScheduledTick();
await tickStarted;
const immediate = serializedMonitor.enforceImmediately("test-immediate");
assert.equal(serializedMonitor.enforceImmediately("coalesced"), immediate);
await Promise.resolve();
assert.equal(immediateStarted, false);

let stopResolved = false;
const stopping = serializedMonitor.stop().then(() => {
  stopResolved = true;
});
await Promise.resolve();
assert.equal(stopResolved, false);
await assert.rejects(serializedMonitor.enforceImmediately("after-stop"), /stopping/);

releaseSerializedTick();
await immediateDidStart;
assert.equal(maximumActiveOperations, 1);
assert.equal(stopResolved, false);
releaseImmediate();

assert.deepEqual(await immediate, { reason: "test-immediate" });
await serializedTick;
await stopping;
assert.equal(stopResolved, true);
assert.equal(activeOperations, 0);
assert.equal(maximumActiveOperations, 1);

await serializedMonitor.runScheduledTick();
assert.equal(serializedTickCalls, 1);
