import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { defaultState } from "../src/defaults.js";
import { hardeningDriftAttestationRequired } from "../src/integrityLockdown.js";
import { queueIosMdmPolicyRefresh } from "../src/iosMdm.js";
import { hotUsageCheckpointFingerprint, hotUsageCheckpointRetryDelayMs, MONITOR_ACTIVITY_ACCOUNTING_DELAY_MS, MONITOR_FULL_CHECKPOINT_INTERVAL_MS, MONITOR_HOT_CHECKPOINT_MAX_RETRY_MS, Monitor, wifiEnvironmentObservationRequired } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import type { UsageState } from "../src/types.js";
import { recordUsage } from "../src/usage.js";

assert.equal(defaultState().settings.pollIntervalMs, 15_000,
  "event-driven app and browser enforcement must keep the omnibus recovery sweep off the legacy three-second cadence");
assert.equal(MONITOR_ACTIVITY_ACCOUNTING_DELAY_MS, 60_000,
  "active usage accounting may use a coalesced one-shot delay, not a permanent recovery poll");
const monitorRuntimeSource = await readFile(new URL("../src/monitor.js", import.meta.url), "utf8");
assert.doesNotMatch(monitorRuntimeSource, /setInterval\(/u,
  "the monitor must stay event-driven instead of recreating a permanent three- or fifteen-second loop");
assert.equal(hotUsageCheckpointRetryDelayMs(1), 30_000);
assert.equal(hotUsageCheckpointRetryDelayMs(100), MONITOR_HOT_CHECKPOINT_MAX_RETRY_MS,
  "persistent compact-checkpoint failures must use a capped retry cadence");

{
  const cadenceStartedAt = performance.now();
  const monitor = new Monitor({
    state: defaultState(),
    usage: {},
    startupSnapshotPersisted: true
  });
  assert.ok(
    monitor.nextFullCheckpointAt >= cadenceStartedAt + MONITOR_FULL_CHECKPOINT_INTERVAL_MS,
    "a startup snapshot that already folded recovered counters must defer the next full checkpoint"
  );
}

{
  const checkedAt = new Date("2026-07-21T12:00:00-04:00");
  const state = defaultState();
  const usage: UsageState = {};
  const before = hotUsageCheckpointFingerprint(state, usage, checkedAt);
  usage["2026-07-20"] = {
    totalSeconds: 30,
    apps: {},
    sites: {},
    opens: { apps: {}, sites: {} },
    devices: {}
  };
  assert.notEqual(
    hotUsageCheckpointFingerprint(state, usage, checkedAt),
    before,
    "the compact checkpoint fingerprint must retain a late previous-day counter change"
  );
}

{
  const monitor = new Monitor({ state: defaultState(), usage: {} });
  const futureFullDeadline = performance.now() + 60_000;
  const futureHotDeadline = performance.now() + 60_000;
  monitor.nextFullCheckpointAt = futureFullDeadline;
  monitor.nextHotCheckpointAt = futureHotDeadline;
  let fullCheckpointRequested: boolean | null = null;
  const wallNow = Date.now();
  const originalDateNow = Date.now;
  Date.now = () => wallNow + 10 * 365 * 24 * 60 * 60_000;
  try {
    await monitor.persistHotUsageCheckpoint(wallNow);
    assert.equal(monitor.nextHotCheckpointAt, futureHotDeadline,
      "a forward wall-clock jump must not bypass the monotonic hot-checkpoint deadline");
    monitor.tick = async (forceCheckpoint = false) => {
      fullCheckpointRequested = forceCheckpoint;
      monitor.lastPollAt = wallNow;
    };
    monitor.hardeningDriftAttestationDue = () => false;
    monitor.persistHotUsageCheckpoint = async () => {};
    await monitor.runScheduledTick();
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(fullCheckpointRequested, false,
    "wall-clock jumps must not turn a future monotonic full deadline into an immediate fold");

  const backwardUsage: UsageState = {};
  let backwardHotWrites = 0;
  const backwardMonitor = new Monitor({
    state: defaultState(),
    usage: backwardUsage,
    runtimeUsageCheckpointWriter: async () => {
      backwardHotWrites += 1;
      return {} as never;
    },
    runtimeUsageCheckpointLocation: { checkpointPath: "/unused/checkpoint", keyPath: "/unused/key" }
  });
  recordUsage(backwardUsage, { app: "Safari", hostname: "example.com" }, 1);
  backwardMonitor.nextFullCheckpointAt = 0;
  backwardMonitor.nextHotCheckpointAt = 0;
  let backwardFullCheckpointRequested: boolean | null = null;
  backwardMonitor.tick = async (forceCheckpoint = false) => {
    backwardFullCheckpointRequested = forceCheckpoint;
    backwardMonitor.lastPollAt = wallNow;
  };
  backwardMonitor.hardeningDriftAttestationDue = () => false;
  const backwardDateNow = Date.now;
  Date.now = () => -1;
  try {
    await backwardMonitor.persistHotUsageCheckpoint(wallNow);
    backwardMonitor.persistHotUsageCheckpoint = async () => {};
    await backwardMonitor.runScheduledTick();
  } finally {
    Date.now = backwardDateNow;
  }
  assert.equal(backwardHotWrites, 1,
    "a backward wall-clock jump must not suppress a due compact checkpoint");
  assert.equal(backwardFullCheckpointRequested, true,
    "a backward wall-clock jump must not suppress a due full checkpoint");
}

{
  const state = defaultState();
  const usage: UsageState = {};
  let fullSnapshotWrites = 0;
  let compactAttempts = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    fullSnapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    runtimeUsageCheckpointWriter: async () => {
      compactAttempts += 1;
      throw Object.assign(new Error("checkpoint path denied"), { code: "EACCES" });
    },
    runtimeUsageCheckpointLocation: { checkpointPath: "/unused/checkpoint", keyPath: "/unused/key" },
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  recordUsage(usage, { app: "Safari", hostname: "example.com" }, 1);
  monitor.nextHotCheckpointAt = 0;
  await monitor.persistHotUsageCheckpoint(Date.now());
  const firstRetryAt = monitor.nextHotCheckpointAt;
  assert.equal(compactAttempts, 1);
  assert.equal(fullSnapshotWrites, 1, "the first compact I/O failure must fold current counters once");
  assert.ok(firstRetryAt >= performance.now() + 29_000,
    "the first compact I/O failure must back off instead of retrying on the next 15-second pulse");

  recordUsage(usage, { app: "Safari", hostname: "example.com" }, 1);
  await monitor.persistHotUsageCheckpoint(Date.now());
  assert.equal(compactAttempts, 1, "changed counters must respect compact-checkpoint backoff");
  assert.equal(fullSnapshotWrites, 1, "backoff must prevent a 15-second full-snapshot storm");

  monitor.nextHotCheckpointAt = 0;
  recordUsage(usage, { app: "Safari", hostname: "example.com" }, 1);
  await monitor.persistHotUsageCheckpoint(Date.now());
  assert.equal(compactAttempts, 2);
  assert.equal(fullSnapshotWrites, 2);
  assert.ok(monitor.nextHotCheckpointAt >= performance.now() + 59_000,
    "successive compact I/O failures must exponentially extend retry delay");
  assert.equal(state.events.filter((event) => event.type === "runtime_usage_checkpoint_failed").length, 1,
    "one persistent compact I/O incident must not append a new event on every retry");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  let fullSnapshotWrites = 0;
  let compactAttempts = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    fullSnapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    runtimeUsageCheckpointWriter: async () => {
      compactAttempts += 1;
      if (compactAttempts === 1) throw Object.assign(new Error("temporary checkpoint error"), { code: "EIO" });
      return {} as never;
    },
    runtimeUsageCheckpointLocation: { checkpointPath: "/unused/checkpoint", keyPath: "/unused/key" },
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  recordUsage(usage, { app: "Safari", hostname: "example.com" }, 1);
  monitor.nextHotCheckpointAt = 0;
  await monitor.persistHotUsageCheckpoint(Date.now());
  assert.equal(fullSnapshotWrites, 1);
  monitor.nextHotCheckpointAt = 0;
  await monitor.persistHotUsageCheckpoint(Date.now());
  assert.equal(compactAttempts, 2,
    "an idle runtime must probe the same checkpoint fingerprint after backoff");
  assert.equal(fullSnapshotWrites, 1,
    "a same-fingerprint recovery probe must not repeat the prior full fallback");
  assert.equal(monitor.hotCheckpointFailureCount, 0);
  assert.equal(monitor.status.componentHealth["runtime-usage-checkpoint"]?.state, "healthy");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const checkedAt = new Date();
  const mdm = state.deviceControls.ios.mdm;
  mdm.enabled = true;
  mdm.devices = [{
    id: "cancellation-device",
    udid: "cancellation-udid",
    status: "enrolled",
    pushMagic: "push-magic",
    token: "push-token",
    tokenHex: Buffer.from("push-token").toString("hex")
  }];
  const originalBlockedApps = [...state.deviceControls.ios.blockedAppBundleIds];
  const policyA = queueIosMdmPolicyRefresh(state, "policy-a", checkedAt);
  if (!("profileQueued" in policyA)) throw new Error("Expected enabled MDM policy A queue result.");
  assert.ok(policyA.profileQueued > 0);
  for (const command of state.deviceControls.ios.mdm.commands) command.status = "sent";
  state.deviceControls.ios.blockedAppBundleIds = [...originalBlockedApps, "com.example.policy-b"];
  const policyB = queueIosMdmPolicyRefresh(state, "policy-b", new Date(checkedAt.getTime() + 1_000));
  if (!("profileQueued" in policyB)) throw new Error("Expected enabled MDM policy B queue result.");
  assert.ok(policyB.profileQueued > 0);
  const staleCommand = state.deviceControls.ios.mdm.commands.find((command) => (
    command.policyHash === policyB.policyHash && command.status === "queued"
  ));
  assert.ok(staleCommand);
  const staleCommandId = staleCommand.id;
  state.deviceControls.ios.blockedAppBundleIds = originalBlockedApps;

  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  await monitor.runMutation(async () => {
    const result = monitor.syncIosMdmPolicy(checkedAt.getTime() + 2_000, "policy-returned-to-a");
    if (!("profileQueued" in result)) throw new Error("Expected enabled MDM cancellation result.");
    assert.equal(result.profileQueued, 0,
      "returning to an already-sent policy should cancel the stale command without a replacement");
  }, { persist: false });
  assert.equal(state.deviceControls.ios.mdm.commands.find((command) => command.id === staleCommandId)?.status, "cancelled");
  assert.equal(snapshotWrites, 1,
    "a stale MDM command cancellation must persist even when no replacement is queued");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const checkedAt = new Date();
  const mdm = state.deviceControls.ios.mdm;
  mdm.enabled = true;
  mdm.devices = [{
    id: "cooldown-device",
    udid: "cooldown-udid",
    status: "enrolled",
    pushMagic: "push-magic",
    token: "push-token",
    tokenHex: Buffer.from("push-token").toString("hex"),
    lastPushAt: checkedAt.toISOString()
  }];
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  await monitor.runMutation(async () => {
    const queued = monitor.syncIosMdmPolicy(checkedAt.getTime());
    assert.ok(Number(queued.queued) > 0);
    const pushed = await monitor.pushIosMdmPolicy(checkedAt.getTime());
    assert.equal(pushed.skipped, "no-queued-devices");
  }, { persist: false });
  assert.equal(snapshotWrites, 1,
    "new MDM commands must persist once even when cooldown suppresses the no-op push effect");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const checkedAt = new Date();
  state.settings.focusShortcutEnabled = true;
  state.activeSession = {
    id: "current-focus-shortcut",
    title: "Current focus shortcut",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(checkedAt.getTime() - 1_000).toISOString(),
    endsAt: new Date(checkedAt.getTime() + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  state.focusShortcut.active = true;
  state.focusShortcut.desiredActive = true;
  state.deviceControls.ios.mdm.enabled = true;
  state.deviceControls.ios.mdm.devices = [];
  state.deviceControls.ios.mdm.commands = [];
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  await monitor.runMutation(async () => {
    const focus = await monitor.syncFocusShortcut(checkedAt.getTime());
    const mdm = await monitor.pushIosMdmPolicy(checkedAt.getTime());
    assert.equal(focus.changed, false);
    assert.equal(mdm.skipped, "no-queued-devices");
  }, { persist: false });
  assert.equal(snapshotWrites, 0,
    "already-current Focus and empty MDM checks must not enqueue no-op durable snapshots");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  monitor.tick = async (forceCheckpoint = false) => {
    monitor.lastPollAt = Date.now();
    if (forceCheckpoint) monitor.activePersistenceRequest?.();
  };
  monitor.hardeningDriftAttestationDue = () => true;
  monitor.runHardeningDriftPhase = async () => { throw new Error("hardening probe failed"); };
  monitor.persistHotUsageCheckpoint = async () => {};
  await monitor.runScheduledTick();
  assert.equal(snapshotWrites, 2,
    "the first failed hardening pass includes one full fold and one durable failure receipt");
  assert.ok(monitor.nextFullCheckpointAt > performance.now(),
    "a committed full fold must advance its deadline before later hardening work fails");

  monitor.hardeningDriftAttestationDue = () => false;
  await monitor.runScheduledTick();
  assert.equal(snapshotWrites, 2,
    "a post-fold hardening failure must not make the next recovery poll repeat the full fold");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });

  await coordinator.run(async ({ state: draftState }) => {
    draftState.environment.wifiSsid = "efficient-monitor";
  }, { persist: false });

  assert.equal(state.environment.wifiSsid, "efficient-monitor", "transient monitor updates must still publish to live state");
  assert.equal(snapshotWrites, 0, "a routine monitor sample must not write a full sealed snapshot every poll");

  await coordinator.run(async ({ state: draftState, requestPersistence }) => {
    draftState.environment.wifiSsid = "safety-critical-monitor";
    requestPersistence();
  }, { persist: false });

  assert.equal(state.environment.wifiSsid, "safety-critical-monitor");
  assert.equal(snapshotWrites, 1, "a mutation must be able to promote a safety-critical result to a durable snapshot");

  const writesBeforeNoop = snapshotWrites;
  await coordinator.run(async () => {});
  assert.equal(snapshotWrites, writesBeforeNoop, "a no-op mutation must not rewrite the sealed runtime generation");

  await coordinator.run(async ({ state: draftState }) => {
    draftState.environment.wifiError = "unmarked mutation";
  });
  assert.equal(snapshotWrites, writesBeforeNoop + 1,
    "change detection must retain the default durability safety net for unmarked mutations");

  const writesBeforeEffect = snapshotWrites;
  await coordinator.run(async ({ afterCommit }) => {
    afterCommit(
      async () => ({ ok: true }),
      { key: "efficiency-durable-effect", kind: "test-effect", payload: {} }
    );
  }, { persist: false });

  assert.equal(snapshotWrites - writesBeforeEffect, 2,
    "a successful durable effect needs only the pending-intent and atomic completion snapshots");
  assert.equal(coordinator.pendingEffects().length, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const checkedAt = new Date();
  const state = defaultState();
  const usage: UsageState = {};
  state.activeSession = {
    id: "durable-clock-alarm",
    title: "Durable clock alarm",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(checkedAt.getTime() - 60_000).toISOString(),
    endsAt: new Date(checkedAt.getTime() + 20 * 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => { snapshotWrites += 1; });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });

  await monitor.runMutation(async () => {
    monitor.checkClockTamper(checkedAt.getTime() + 10 * 60_000, checkedAt.getTime(), 1_000, 4_000);
  }, { persist: false });
  assert.equal(snapshotWrites, 1, "a newly detected clock-tamper lockdown must be durable immediately");
  await monitor.runMutation(async () => {
    monitor.checkClockTamper(checkedAt.getTime() + 11 * 60_000, checkedAt.getTime(), 1_000, 4_000);
  }, { persist: false });
  assert.equal(snapshotWrites, 1, "an existing clock-tamper alarm must not rewrite the same snapshot every poll");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  state.integrity.runtime.appleContentFilterArmedAt = new Date().toISOString();
  state.integrity.runtime.appleContentFilterArmedLockId = "finished-lock";
  state.integrity.runtime.appleContentFilterArmedLockIds = ["finished-lock"];
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => { snapshotWrites += 1; });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });

  await monitor.runMutation(() => monitor.refreshAppleContentFilterLockdown(Date.now()), { persist: false });
  assert.equal(snapshotWrites, 1, "clearing obsolete Apple-filter arm evidence must persist once");
  await monitor.runMutation(() => monitor.refreshAppleContentFilterLockdown(Date.now()), { persist: false });
  assert.equal(snapshotWrites, 1, "unchanged Apple-filter state must not restore periodic full writes");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage: UsageState = {};
  state.limitRules = [{
    id: "durable-monitor-limit",
    name: "Durable monitor limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: ["Safari"],
    sites: [],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  recordUsage(usage, { app: "Safari", hostname: "" }, 61);
  let snapshotWrites = 0;
  let persistedLimitBlocks = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async (snapshotState) => {
    snapshotWrites += 1;
    persistedLimitBlocks = snapshotState.limitBlocks.length;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });

  await monitor.runMutation(async () => { monitor.policyForTarget({ app: "Safari", hostname: "", url: "" }); }, { persist: false });
  assert.equal(snapshotWrites, 1, "a monitor-created protective limit block must persist immediately");
  assert.equal(persistedLimitBlocks, 1);
  await monitor.runMutation(async () => { monitor.policyForTarget({ app: "Safari", hostname: "", url: "" }); }, { persist: false });
  assert.equal(snapshotWrites, 1, "re-evaluating an existing limit block must not trigger another snapshot");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const checkedAt = new Date();
  const state = defaultState();
  const usage: UsageState = {};
  let fullSnapshotFingerprint = "";
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async (snapshotState, snapshotUsage) => {
    fullSnapshotFingerprint = hotUsageCheckpointFingerprint(snapshotState, snapshotUsage, checkedAt);
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  monitor.tick = async () => {
    monitor.lastPollAt = checkedAt.getTime();
    recordUsage(monitor.usage, { app: "Safari", hostname: "example.com" }, 1, checkedAt);
  };
  monitor.hardeningDriftAttestationDue = () => true;
  let releaseHardening = () => {};
  const hardeningGate = new Promise<void>((resolve) => { releaseHardening = resolve; });
  let markHardeningStarted = () => {};
  const hardeningStarted = new Promise<void>((resolve) => { markHardeningStarted = resolve; });
  monitor.runHardeningDriftPhase = async () => {
    markHardeningStarted();
    await hardeningGate;
  };
  let forcedHotComparison = false;
  monitor.persistHotUsageCheckpoint = async (now, options = {}) => {
    assert.equal(options.force, true);
    assert.equal(monitor.lastHotCheckpointFingerprint, fullSnapshotFingerprint,
      "the hot baseline must describe the exact draft included in the full snapshot");
    assert.notEqual(hotUsageCheckpointFingerprint(state, usage, new Date(now)), fullSnapshotFingerprint,
      "a concurrent sparse counter mutation must remain visible after slow hardening");
    forcedHotComparison = true;
  };

  const ticking = monitor.runScheduledTick();
  await hardeningStarted;
  await coordinator.run(async ({ usage: draftUsage }) => {
    recordUsage(draftUsage, { app: "Safari", hostname: "example.com" }, 1, checkedAt);
  }, { persist: false });
  releaseHardening();
  await ticking;
  assert.equal(forcedHotComparison, true,
    "a full checkpoint must immediately compare live hot counters after slow hardening");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const now = Date.now();
  const state = defaultState();
  const usage: UsageState = {};
  state.settings.foolproofModeEnabled = true;
  state.activeSession = {
    id: "stale-hardening-evidence-lock",
    title: "Stale hardening evidence lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(now - 1_000).toISOString(),
    endsAt: new Date(now + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => (
        operation(draftState, draftUsage, afterCommit, requestPersistence)
      ),
      options
    )
  });
  let collections = 0;
  let releaseFirstCollection = () => {};
  const firstCollectionGate = new Promise<void>((resolve) => { releaseFirstCollection = resolve; });
  let markFirstCollection = () => {};
  const firstCollectionStarted = new Promise<void>((resolve) => { markFirstCollection = resolve; });
  monitor.collectHardeningDriftEvidence = async (_snapshot, checkedAt, policyFingerprint, monitorFingerprint) => {
    collections += 1;
    if (collections === 1) {
      markFirstCollection();
      await firstCollectionGate;
    }
    return {
      checkedAt,
      policyFingerprint: policyFingerprint!,
      monitorFingerprint: monitorFingerprint!,
      checks: {
        // The stale generation looks drifted on purpose. It must never create a
        // false lockdown after policy changes while evidence is in flight.
        hosts: { installed: collections !== 1, partial: false, stale: false },
        firewall: { installed: true, partial: false, stale: false },
        safariFilter: { required: false, installed: true, current: true },
        chromeSafeSearch: { required: false, installed: true, current: true },
        agent: { installed: true, loaded: true, running: true },
        monitor: JSON.parse(monitorFingerprint!),
        extensionRules: { ok: true, status: "current", count: 1 },
        sourceSeal: { ok: true, status: "sealed", fileCount: 1 }
      }
    };
  };

  const refresh = monitor.refreshHardeningDrift(now);
  await firstCollectionStarted;
  await coordinator.run(async ({ state: draftState }) => {
    draftState.profiles[0]!.blockedSites.push("generation-change.example");
  }, { persist: false });
  releaseFirstCollection();
  assert.equal(await refresh, false, "the fresh retry is clean and must not create an integrity lockdown");
  assert.equal(collections, 2,
    "stale hardening evidence must be discarded and recollected for the new policy generation");
  assert.equal(state.integrity.runtime.hardeningDriftDetectedAt, null,
    "a drift result measured for the stale generation must never be applied");
  assert.equal(monitor.status.hardeningDrift?.drift, null,
    "the accepted fresh evidence must publish clean status rather than stale drift");
  assert.ok(monitor.nextHardeningDriftRefreshAt > Date.now(),
    "only accepted fresh evidence may advance the hardening attestation deadline");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  assert.equal(wifiEnvironmentObservationRequired(state), false);
  await monitor.refreshEnvironment(Date.now());
  assert.equal(monitor.nextEnvironmentRefreshAt, 0, "Wi-Fi subprocess checks must stay dormant when no enabled schedule depends on an SSID");

  state.schedules[0].enabled = true;
  state.schedules[0].wifiNetworks = ["Office"];
  assert.equal(wifiEnvironmentObservationRequired(state), true, "adding an SSID-bound schedule must immediately restore Wi-Fi observation");
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const persistenceRequests: Array<boolean | undefined> = [];
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => {
      persistenceRequests.push(options?.persist);
      return await operation(state, usage, (effect) => { void effect(); });
    }
  });
  monitor.tick = async () => {};

  await monitor.runScheduledTick();
  await monitor.runScheduledTick();

  assert.deepEqual(persistenceRequests, [true, false], "the monitor must fold its first checkpoint and batch subsequent polls");
  assert.equal(MONITOR_FULL_CHECKPOINT_INTERVAL_MS, 15 * 60_000, "full state compaction must stay off the former 30-second cadence");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  let durableEffects = 0;
  monitor.externalEffect = (async () => {
    durableEffects += 1;
    return { ok: true };
  }) as typeof monitor.externalEffect;

  const summary = await monitor.syncFocusShortcut(Date.now());
  assert.equal(summary.enabled, false);
  assert.equal(durableEffects, 0, "a disabled and inactive Focus hook must not create a durable OS intent every poll");
  assert.equal(monitor.status.componentHealth["focus-shortcut"]?.state, "disabled");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });

  await monitor.refreshAppleContentFilterLockdown(Date.now());

  assert.equal(
    monitor.status.appleContentFilterLockdown?.skipped,
    "no-protected-lock",
    "Apple profile tools must stay idle when no protected lock or recovery needs them"
  );
  assert.equal(monitor.nextAppleContentFilterRefreshAt, 0, "a future protected lock must trigger an immediate filter check");
}

{
  const checkedAt = new Date("2026-07-21T12:00:00.000Z");
  const state = defaultState();
  state.activeSession = {
    id: "hardening-attestation-lock",
    title: "Hardening attestation lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: checkedAt.toISOString(),
    endsAt: new Date(checkedAt.getTime() + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const protectedSession = state.activeSession;
  const monitor = new Monitor({ state, usage: {} });

  monitor.nextHardeningDriftRefreshAt = checkedAt.getTime() + 15_000;
  await monitor.refreshHardeningDrift(checkedAt.getTime());
  assert.equal(
    monitor.nextHardeningDriftRefreshAt,
    0,
    "re-enabling foolproof mode during a protected lock must not inherit a disabled-state cooldown"
  );

  state.settings.foolproofModeEnabled = true;
  assert.equal(
    hardeningDriftAttestationRequired(state, checkedAt),
    true,
    "re-enabled foolproof mode must recognize an already-active protected overlap"
  );
  state.activeSession = null;
  assert.equal(hardeningDriftAttestationRequired(state, checkedAt), false);
  await monitor.refreshHardeningDrift(checkedAt.getTime());
  assert.equal(
    monitor.status.hardeningDrift?.skipped,
    "no-protected-lock",
    "idle foolproof monitoring must not launch fresh hardening attestation"
  );
  assert.equal(monitor.nextHardeningDriftRefreshAt, 0, "a future protected lock must attest hardening immediately");

  state.integrity.runtime.hardeningDriftDetectedAt = checkedAt.toISOString();
  state.integrity.runtime.hardeningDriftIssues = [{
    id: "apple-content-filter",
    detail: "Apple content filter recovery"
  }];
  await monitor.refreshHardeningDrift(checkedAt.getTime() + 1);
  assert.equal(
    monitor.status.hardeningDrift?.skipped,
    "apple-content-filter-recovery",
    "Apple filter recovery must stay on its dedicated fresh check without launching unrelated Chrome attestation"
  );

  state.activeSession = protectedSession;
  assert.equal(
    hardeningDriftAttestationRequired(state, checkedAt),
    true,
    "an active protected overlap must retain fresh fail-closed hardening attestation"
  );
}

{
  const state = defaultState();
  const usage: UsageState = {};
  const order: string[] = [];
  const effectStarts: string[] = [];
  const postDriftSideEffects: string[] = [];
  let mutationActive = false;
  let releaseAttestation = () => {};
  const attestationGate = new Promise<void>((resolve) => { releaseAttestation = resolve; });
  let markAttestationStarted = () => {};
  const attestationStarted = new Promise<void>((resolve) => { markAttestationStarted = resolve; });
  let attestationPhaseSnapshots = 0;
  state.settings.foolproofModeEnabled = true;
  state.activeSession = {
    id: "slow-attestation-lock",
    title: "Slow attestation lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: new Date(Date.now() - 1_000).toISOString(),
    endsAt: new Date(Date.now() + 60_000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    if (order.includes("attestation-end")) attestationPhaseSnapshots += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(async ({ state: draftState, usage: draftUsage, afterCommit, requestPersistence }) => {
      mutationActive = true;
      try {
        return await operation(draftState, draftUsage, afterCommit, requestPersistence);
      } finally {
        mutationActive = false;
      }
    }, options)
  });
  monitor.nextFullCheckpointAt = performance.now() + MONITOR_FULL_CHECKPOINT_INTERVAL_MS;
  monitor.recordElapsedUsage = async () => {};
  monitor.refreshSafetyRails = async () => {
    order.push("safety");
    await monitor.externalEffect("lock-screen", { policyId: "slow-attestation-lock" }, async () => {
      effectStarts.push("sleep-lock");
      return { ok: true };
    });
  };
  monitor.updateFrontmostSample = async () => {
    order.push("front");
    return { ok: true, app: "Safari", hostname: "reddit.com", url: "https://reddit.com/" };
  };
  let foregroundEnforcements = 0;
  monitor.enforceFrontmost = async () => {
    foregroundEnforcements += 1;
    if (foregroundEnforcements > 1) {
      order.push("enforce-after-drift");
      return;
    }
    order.push("enforce-before-attestation");
    await monitor.externalEffect(
      "redirect-browser",
      {
        app: "Safari",
        currentUrl: "https://reddit.com/",
        url: "http://127.0.0.1:43110/blocked",
        policyId: "slow-attestation-lock"
      },
      async () => {
        effectStarts.push("redirect");
        return { ok: true, matched: true };
      }
    );
  };
  monitor.collectHardeningDriftEvidence = async (_snapshot, checkedAt, policyFingerprint, monitorFingerprint) => {
    assert.equal(mutationActive, false,
      "slow hardening evidence collection must run outside both monitor and coordinator serialization");
    order.push("attestation-start");
    markAttestationStarted();
    await attestationGate;
    order.push("attestation-end");
    return {
      checkedAt,
      policyFingerprint: policyFingerprint!,
      monitorFingerprint: monitorFingerprint!,
      checks: {
        hosts: { installed: false, partial: false, stale: false },
        firewall: { installed: true, partial: false, stale: false },
        safariFilter: { required: false, installed: true, current: true },
        chromeSafeSearch: { required: false, installed: true, current: true },
        agent: { installed: true, loaded: true, running: true },
        monitor: JSON.parse(monitorFingerprint!),
        extensionRules: { ok: true, status: "current", count: 1 },
        sourceSeal: { ok: true, status: "sealed", fileCount: 1 }
      }
    };
  };
  monitor.readFrontmost = async (options) => {
    assert.equal(options?.fresh, true, "a newly detected drift lockdown must re-read the current target");
    assert.equal(mutationActive, false, "post-attestation foreground discovery must stay outside mutation serialization");
    order.push("fresh-front");
    return { ok: true, app: "Safari", hostname: "reddit.com", url: "https://reddit.com/" };
  };
  monitor.collectImmediateSideEffectObservations = async () => {
    assert.equal(mutationActive, false, "post-attestation process and grayscale discovery must stay outside mutation serialization");
    order.push("side-observations");
    return {
      grayscale: { ok: true, universalAccess: false, coreGraphics: false } as never,
      runningApps: { ok: true, apps: ["Chess"] } as never
    };
  };
  monitor.runBackgroundEnforcement = async () => {
    order.push("background");
    await monitor.externalEffect("quit-app", { app: "Chess", force: false }, async () => {
      effectStarts.push("process-sweep");
      return { ok: true };
    });
  };
  monitor.enforceSystemSleepLock = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("sleep-lock");
    order.push("post-sleep-lock");
    return null;
  };
  monitor.syncFocusShortcut = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("focus-shortcut");
    order.push("post-focus-shortcut");
    return {} as never;
  };
  monitor.reconcileGrayscale = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    assert.ok(options.observed);
    assert.ok(options.runningApps);
    postDriftSideEffects.push("grayscale");
    order.push("post-grayscale");
    return {};
  };
  monitor.sweepBlockedProcesses = async (_now, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    assert.ok(options.runningApps);
    postDriftSideEffects.push("process-sweep");
    order.push("post-process-sweep");
  };
  monitor.syncIosMdmPolicy = () => {
    assert.equal(mutationActive, true);
    postDriftSideEffects.push("mdm-sync");
    order.push("post-mdm-sync");
    return { queued: true } as never;
  };
  monitor.pushIosMdmPolicy = async (_now, _reason, options = {}) => {
    assert.equal(mutationActive, true);
    assert.equal(options.force, true);
    postDriftSideEffects.push("mdm-push");
    order.push("post-mdm-push");
    return { ok: true, pushed: 1 };
  };

  let tickFinished = false;
  const ticking = monitor.runScheduledTick().then(() => { tickFinished = true; });
  await attestationStarted;
  assert.deepEqual(effectStarts, ["sleep-lock", "redirect", "process-sweep"],
    "the real coordinator must commit and start every core enforcement effect before slow attestation");
  assert.deepEqual(order, ["safety", "front", "enforce-before-attestation", "background", "attestation-start"],
    "core enforcement must commit and dispatch before a slow fresh Chrome profile attestation");
  assert.equal(tickFinished, false);

  let markControlAttempted = () => {};
  const controlAttempted = new Promise<void>((resolve) => { markControlAttempted = resolve; });
  const concurrentPolicyRequest = coordinator.run(async ({ afterCommit }) => {
    afterCommit(
      () => {
        effectStarts.push("policy-enforcement");
        markControlAttempted();
        return { ok: true };
      },
      { key: "policy-enforcement:while-attestation-gated", kind: "policy-enforcement", payload: {} }
    );
  });
  await controlAttempted;
  await concurrentPolicyRequest;
  assert.equal(mutationActive, false);
  assert.deepEqual(effectStarts, ["sleep-lock", "redirect", "process-sweep", "policy-enforcement"],
    "a newly queued policy control attempt must enter while slow attestation is gated");

  releaseAttestation();
  await ticking;
  assert.deepEqual(order, [
    "safety",
    "front",
    "enforce-before-attestation",
    "background",
    "attestation-start",
    "attestation-end",
    "fresh-front",
    "side-observations",
    "enforce-after-drift",
    "post-sleep-lock",
    "post-focus-shortcut",
    "post-grayscale",
    "post-process-sweep",
    "post-mdm-sync",
    "post-mdm-push"
  ], "a fresh drift lockdown must publish every immediate enforcement intent in the same serialized tick");
  assert.deepEqual(postDriftSideEffects, [
    "sleep-lock",
    "focus-shortcut",
    "grayscale",
    "process-sweep",
    "mdm-sync",
    "mdm-push"
  ], "all fail-closed side effects must be published before waiting for a later poll");
  assert.equal(attestationPhaseSnapshots, 1,
    "a newly detected lockdown must request one durable snapshot between full checkpoint folds");
  assert.equal(coordinator.pendingEffects().length, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}
