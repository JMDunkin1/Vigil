import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import type { RuntimeOutboxEntry } from "../src/store.js";

const state = defaultState();
const monitor = new Monitor({ state, usage: {} });

const monitorSource = await readFile(new URL("../src/monitor.js", import.meta.url), "utf8");
assert.match(
  monitorSource,
  /!result\.ok && !\("pending" in result && result\.pending\)/u,
  "durable quit placeholders must not stop grayscale guard fan-out"
);

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

const unguardedGrayscaleState = defaultState();
unguardedGrayscaleState.grayscale.preventManualChanges = false;
unguardedGrayscaleState.grayscale.schedules.push({
  id: "unguarded-active",
  name: "Unguarded active grayscale",
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: "00:00",
  end: "23:59",
  deviceTargets: ["computer"]
});
const unguardedGrayscaleMonitor = new Monitor({ state: unguardedGrayscaleState, usage: {} });
let guardSweeps = 0;
unguardedGrayscaleMonitor.externalEffect = (async () => ({ ok: true, changed: false, after: { active: true } })) as typeof unguardedGrayscaleMonitor.externalEffect;
unguardedGrayscaleMonitor.blockGrayscaleGuardApps = async () => { guardSweeps += 1; return []; };
const unguardedNow = new Date(2026, 6, 14, 12, 0, 0).getTime();
const unguardedSummary = await unguardedGrayscaleMonitor.reconcileGrayscale(unguardedNow);
assert.ok(unguardedSummary);
assert.equal(unguardedSummary.desired, true);
assert.equal(guardSweeps, 0, "manual grayscale protection must not enumerate guard apps when protection is disabled");
assert.equal(unguardedGrayscaleMonitor.status.componentHealth["grayscale-guard"]?.state, "disabled", "an inapplicable grayscale guard must not block readiness");

const inactiveGrayscaleMonitor = new Monitor({ state: defaultState(), usage: {} });
inactiveGrayscaleMonitor.status.lastGrayscale = { desired: false, current: true };
inactiveGrayscaleMonitor.nextGrayscaleRefreshAt = Date.now() + 5_000;
const inactiveGrayscaleSummary = await inactiveGrayscaleMonitor.reconcileGrayscale(Date.now());
assert.equal(inactiveGrayscaleSummary, inactiveGrayscaleMonitor.status.lastGrayscale);
assert.equal(inactiveGrayscaleMonitor.nextGrayscaleRefreshAt, 0, "confirmed inactive grayscale must stop polling macOS preferences");

const rollbackState = defaultState();
let rollbackEffects = 0;
const rollbackCoordinator = new RuntimeMutationCoordinator(rollbackState, {}, [], async () => {
  throw new Error("deterministic monitor snapshot failure");
});
const rollbackMonitor = new Monitor({
  state: rollbackState,
  usage: {},
  mutate: async (operation) => await rollbackCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
});
await assert.rejects(rollbackMonitor.runMutation(async () => {
  rollbackMonitor.nextSystemSleepLockAt = Date.now() + 60_000;
  rollbackMonitor.nextGrayscaleRefreshAt = Date.now() + 5_000;
  rollbackMonitor.markCoolingDown("app:Rollback");
  await rollbackMonitor.externalEffect("lock-screen", { policyId: "rollback" }, async () => {
    rollbackEffects += 1;
    return { ok: true };
  });
}), /deterministic monitor snapshot failure/u);
assert.equal(rollbackEffects, 0, "an effect must not run before its intent snapshot commits");
assert.equal(rollbackMonitor.nextSystemSleepLockAt, 0, "failed snapshots must roll back enforcement deadlines");
assert.equal(rollbackMonitor.nextGrayscaleRefreshAt, 0, "failed snapshots must roll back monitor refresh deadlines");
assert.equal(rollbackMonitor.isCoolingDown("app:Rollback"), false, "failed snapshots must roll back block cooldowns");
assert.equal(rollbackMonitor.durableEffectProblems.size, 0, "failed snapshots must roll back uncommitted durable health entries");
assert.equal(rollbackMonitor.status.componentHealth["screen-lock"], undefined, "failed snapshots must roll back uncommitted component health");
rollbackCoordinator.stopAdmission();
await rollbackCoordinator.drain();

const obsoleteState = defaultState();
let obsoleteRuns = 0;
const obsoleteCoordinator = new RuntimeMutationCoordinator(obsoleteState, {}, [], async () => {});
const obsoleteMonitor = new Monitor({
  state: obsoleteState,
  usage: {},
  mutate: async (operation) => await obsoleteCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
});
await obsoleteMonitor.runMutation(async () => await obsoleteMonitor.externalEffect(
  "grayscale",
  { desired: true },
  async () => {
    obsoleteRuns += 1;
    return { ok: false, error: "deterministic first grayscale failure" };
  }
));
assert.equal(obsoleteRuns, 1);
assert.equal(obsoleteCoordinator.pendingEffects().length, 1);
await obsoleteCoordinator.retryPending(async (entry) => await obsoleteMonitor.reconcileDurableEffect(
  String(entry.payload.action || ""),
  { ...entry.payload, intentKey: entry.key }
));
assert.equal(obsoleteRuns, 1, "a failed desired-state intent must be revalidated instead of replayed after policy changes");
assert.equal(obsoleteCoordinator.pendingEffects().length, 0, "an obsolete intent must complete without touching the OS");
const obsoleteQuit = await obsoleteMonitor.reconcileDurableEffect("quit-app", { app: "Chess", force: true });
assert.equal(obsoleteQuit.skipped, "obsolete", "recovered action intents must be cancelled when no blocking policy remains");
for (const [action, payload] of [
  ["lock-screen", { policyId: "ended-session" }],
  ["redirect-browser", { app: "Safari", currentUrl: "https://example.com", url: "http://127.0.0.1/blocked" }],
  ["open-url", { url: "http://127.0.0.1/intentional/pause/ended" }]
] as const) {
  const result = await obsoleteMonitor.reconcileDurableEffect(action, payload);
  assert.equal(result.skipped, "obsolete", `${action} recovery must not execute after its policy context ends`);
}
obsoleteCoordinator.stopAdmission();
await obsoleteCoordinator.drain();

const disabledMdmState = defaultState();
let disabledMdmEffects = 0;
const disabledMdmMonitor = new Monitor({
  state: disabledMdmState,
  usage: {},
  mutate: async (operation) => await operation(disabledMdmState, {}, () => { disabledMdmEffects += 1; })
});
const disabledPush = await disabledMdmMonitor.runMutation(
  async () => await disabledMdmMonitor.pushIosMdmPolicy(Date.now())
);
assert.deepEqual(disabledPush, { ok: true, pushed: 0, skipped: "disabled" });
assert.equal(disabledMdmEffects, 0, "disabled self-hosted MDM must not register durable monitor work");
assert.equal(disabledMdmMonitor.status.componentHealth["mdm-push"]?.state, "disabled");

const recoveredDisabledMdmState = defaultState();
const recoveredDisabledMdmIntent: RuntimeOutboxEntry = {
  id: "recovered-disabled-mdm",
  key: "monitor-os:mdm-push:recovered-disabled",
  kind: "monitor-os",
  payload: { action: "mdm-push", intentKey: "monitor-os:mdm-push:recovered-disabled" },
  createdAt: new Date().toISOString(),
  attempts: 0,
  lastError: "MDM was disabled",
  status: "pending",
  startedAt: null,
  nextAttemptAt: null
};
const recoveredDisabledMdmCoordinator = new RuntimeMutationCoordinator(recoveredDisabledMdmState, {}, [recoveredDisabledMdmIntent], async () => {});
const recoveredDisabledMdmMonitor = new Monitor({ state: recoveredDisabledMdmState, usage: {} });
assert.equal(
  recoveredDisabledMdmMonitor.durableEffectApplicable("mdm-push", recoveredDisabledMdmIntent.payload),
  false,
  "a pending MDM push becomes obsolete when MDM is disabled"
);
recoveredDisabledMdmCoordinator.setEffectObserver((entry, transition, error) => recoveredDisabledMdmMonitor.observeDurableEffect(entry, transition, error));
await recoveredDisabledMdmCoordinator.retryPending(
  async (entry) => await recoveredDisabledMdmMonitor.reconcileDurableEffect(String(entry.payload.action || ""), { ...entry.payload, intentKey: entry.key })
);
recoveredDisabledMdmCoordinator.stopAdmission();
await recoveredDisabledMdmCoordinator.drain();
assert.equal(recoveredDisabledMdmCoordinator.pendingEffects().length, 0, "a recovered MDM intent must complete when MDM is now disabled");
assert.equal(recoveredDisabledMdmMonitor.status.componentHealth["mdm-push"]?.state, "disabled");

const recoveredFailedMdmState = defaultState();
recoveredFailedMdmState.deviceControls.ios.mdm.enabled = true;
recoveredFailedMdmState.deviceControls.ios.mdm.devices = [{
  id: "failed-mdm-device",
  udid: "failed-mdm-udid",
  status: "enrolled"
}];
recoveredFailedMdmState.deviceControls.ios.mdm.commands = [{
  id: "failed-mdm-command",
  commandUuid: "failed-mdm-command-uuid",
  udid: "failed-mdm-udid",
  requestType: "InstallProfile",
  status: "queued"
}];
const recoveredFailedMdmMonitor = new Monitor({ state: recoveredFailedMdmState, usage: {} });
await assert.rejects(
  recoveredFailedMdmMonitor.reconcileDurableEffect("mdm-push", { intentKey: "monitor-os:mdm-push:recovered-failure" }),
  (error: Error & { effectState?: typeof recoveredFailedMdmState }) => {
    assert.match(error.message, /mdm-push failed/u);
    assert.ok(error.effectState, "a recovered MDM failure must expose its diagnostic state for durable failure handling");
    assert.equal(error.effectState.deviceControls.ios.mdm.lastPushStatus, "not-ready");
    assert.equal(error.effectState.deviceControls.ios.mdm.devices[0]?.lastPushStatus, "not-ready");
    assert.equal(error.effectState.deviceControls.ios.mdm.commands[0]?.lastPushStatus, "not-ready");
    return true;
  }
);

const focusState = defaultState();
const focusCoordinator = new RuntimeMutationCoordinator(focusState, {}, [], async () => {});
const focusMonitor = new Monitor({
  state: focusState,
  usage: {},
  mutate: async (operation) => await focusCoordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
});
const focusCheckedAt = Date.parse("2026-07-14T12:00:00.000Z");
await focusMonitor.runMutation(async () => await focusMonitor.syncFocusShortcut(focusCheckedAt));
assert.equal(focusState.focusShortcut.lastCheckedAt, new Date(focusCheckedAt).toISOString(), "a completed Focus effect must merge its reconciled state into the durable state");
focusCoordinator.stopAdmission();
await focusCoordinator.drain();

const recoveredFocusState = defaultState();
const recoveredFocusMonitor = new Monitor({ state: recoveredFocusState, usage: {} });
assert.equal(recoveredFocusMonitor.durableEffectApplicable("focus-shortcut", { policyId: "ended-session" }), false);
assert.equal(recoveredFocusMonitor.durableEffectApplicable("focus-shortcut", { policyId: "none" }), true);
const recoveredFocus = await recoveredFocusMonitor.reconcileDurableEffect("focus-shortcut", { intentKey: "monitor-os:focus-shortcut:recovered" });
const recoveredFocusEffectState = recoveredFocus.effectState as typeof recoveredFocusState;
assert.ok(recoveredFocusEffectState.focusShortcut.lastCheckedAt, "Focus recovery must return the reconciled state for durable completion");

const durableKindsMonitor = new Monitor({ state: defaultState(), usage: {} });
for (const kind of ["manageengine-export", "mdm-push", "session-enforcement", "policy-enforcement"]) {
  const entry: RuntimeOutboxEntry = {
    id: `${kind}-failure`,
    key: `${kind}:failure`,
    kind,
    payload: {},
    createdAt: new Date().toISOString(),
    attempts: 1,
    lastError: `${kind} failed`,
    status: "pending",
    startedAt: null,
    nextAttemptAt: null
  };
  durableKindsMonitor.observeDurableEffect(entry, "failed", entry.lastError);
  assert.equal(durableKindsMonitor.status.componentHealth[kind]?.state, "degraded", `${kind} failures must degrade runtime health`);
  assert.equal(durableKindsMonitor.status.ok, false, `${kind} failures must make readiness health fail`);
  durableKindsMonitor.observeDurableEffect(entry, "completed", "");
  assert.equal(durableKindsMonitor.status.componentErrors[kind], undefined, `${kind} health must recover only when its intent completes`);
}
assert.equal(durableKindsMonitor.status.ok, true);

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
recoveryMonitor.durableEffectApplicable = () => true;
recoveryMonitor.runImmediateSideEffects = async () => {
  await recoveryMonitor.externalEffect(
    "lock-screen",
    { policyId: "recovered-session" },
    async () => ({ ok: false, error: "recovered OS effect failed" })
  );
};
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
