import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import type { RuntimeOutboxEntry } from "../src/store.js";

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

const componentMonitor = new Monitor({ state: defaultState(), usage: {} });
for (const component of ["grayscale", "grayscale-guard", "screen-lock", "process-sweep", "idle-usage", "wifi", "mdm-push"]) {
  componentMonitor.setComponentHealth(component, `${component} failed`);
  componentMonitor.setComponentHealth("frontmost", "");
  assert.equal(componentMonitor.status.ok, false, `a successful frontmost read must not clear ${component} health`);
  assert.equal(componentMonitor.status.componentErrors[component], `${component} failed`);
  componentMonitor.setComponentHealth(component, "");
  assert.equal(componentMonitor.status.ok, true, `${component} health clears only after that component succeeds`);
}

const durableState = defaultState();
const durableMonitor = new Monitor({
  state: durableState,
  usage: {},
  mutate: async (operation) => {
    const effects: Array<() => Promise<void>> = [];
    const result = await operation(durableState, {}, (effect, _descriptor, complete, fail) => effects.push(async () => {
      try {
        const effectResult = await effect();
        await complete?.(effectResult, durableState, {});
      } catch (error) {
        await fail?.(error instanceof Error ? error : new Error(String(error)), durableState, {});
      }
    }));
    for (const effect of effects) await effect();
    return result;
  }
});
const firstPlaceholder = await durableMonitor.runMutation(async () => await durableMonitor.externalEffect(
  "lock-screen",
  { policyId: "first" },
  async () => ({ ok: false, error: "deterministic lock failure" })
)) as Record<string, unknown>;
assert.equal(firstPlaceholder.pending, true);
assert.equal(firstPlaceholder.ok, false, "a durable placeholder must not report external success");
assert.equal(durableMonitor.status.componentHealth["screen-lock"]?.state, "degraded");
assert.match(durableMonitor.status.componentErrors["screen-lock"] || "", /deterministic lock failure/u);
durableMonitor.setComponentDisabled("screen-lock");
durableMonitor.setComponentHealth("screen-lock", "");
assert.equal(durableMonitor.status.componentHealth["screen-lock"]?.state, "degraded", "disabled or unrelated healthy checks cannot mask a durable failure");

await durableMonitor.runMutation(async () => await durableMonitor.externalEffect(
  "lock-screen",
  { policyId: "second" },
  async () => ({ ok: true })
));
assert.match(durableMonitor.status.componentErrors["screen-lock"] || "", /deterministic lock failure/u, "another intent succeeding must not mask a failed intent");
await durableMonitor.runMutation(async () => await durableMonitor.externalEffect(
  "lock-screen",
  { policyId: "first" },
  async () => ({ ok: true })
));
assert.equal(durableMonitor.status.componentHealth["screen-lock"]?.state, "healthy", "the exact failed intent must recover its component");

const recoveryState = defaultState();
let recoveryCoordinator: InstanceType<typeof RuntimeMutationCoordinator>;
const recoveryMonitor = new Monitor({
  state: recoveryState,
  usage: {},
  mutate: async (operation) => await recoveryCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
});
recoveryMonitor.updateFrontmostSample = async () => ({ ok: true, app: "Finder", hostname: "", url: "" });
recoveryMonitor.enforceFrontmost = async () => {};
recoveryMonitor.runImmediateSideEffects = async () => {
  await recoveryMonitor.externalEffect(
    "lock-screen",
    { policyId: "recovered-session" },
    async () => ({ ok: false, error: "recovered OS effect failed" })
  );
};
recoveryMonitor.persistHeartbeat = async () => {};
const recoveredIntent: RuntimeOutboxEntry = {
  id: "recovered-session-intent",
  key: "session-enforcement:recovered",
  kind: "session-enforcement",
  payload: { sessionId: "recovered-session" },
  createdAt: new Date().toISOString(),
  attempts: 0,
  lastError: "",
  status: "pending",
  startedAt: null,
  nextAttemptAt: null
};
recoveryCoordinator = new RuntimeMutationCoordinator(recoveryState, {}, [recoveredIntent], async () => {});
recoveryCoordinator.setEffectObserver((entry, transition, error) => recoveryMonitor.observeDurableEffect(entry, transition, error));
await recoveryCoordinator.retryPending(async (entry) => {
  await recoveryMonitor.reconcileDurableEffect(entry.kind, { ...entry.payload, intentKey: entry.key });
});
recoveryCoordinator.stopAdmission();
await recoveryCoordinator.drain();
assert.equal(recoveryCoordinator.pendingEffects().length, 1, "failed recovered enforcement must remain in the durable outbox");
assert.match(recoveryCoordinator.pendingEffects()[0]?.lastError || "", /recovered OS effect failed/u);
assert.equal(recoveryMonitor.status.ok, false, "failed recovered enforcement must degrade readiness even when front sampling succeeds");
assert.equal(recoveryMonitor.status.componentHealth["screen-lock"]?.state, "degraded");

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
