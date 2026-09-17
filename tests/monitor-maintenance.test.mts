import assert from "node:assert/strict";
import { mock } from "node:test";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";

const now = Date.now();
const state = defaultState();
const monitor = new Monitor({ state, usage: {}, externalEffectsEnabled: false });
monitor.lastPollAt = now - 10_000;
monitor.lastScheduledTickAt = now - 10_000;
monitor.status.browserActivityAccelerationHealthy = true;
assert.equal(monitor.maintenanceTickRequired(now), false,
  "healthy unrestricted idle monitoring must not repeat OS checks");
for (const url of ["https://example.com/", "http://127.0.0.1:8787/blocked", ""]) {
  monitor.lastSample = { app: "Safari", hostname: "", url };
  assert.equal(monitor.maintenanceTickRequired(now), false,
    "a healthy foreground browser must not create recurring OS polling, including on the blocker");
}
monitor.lastSample = { app: "TextEdit", hostname: "", url: "" };
assert.equal(monitor.maintenanceTickRequired(now), false,
  "switching away from the browser must let healthy unrestricted monitoring become idle again");
monitor.lastSample = null;
monitor.lastScheduledTickAt = now - 10_000;
monitor.status.browserActivityAccelerationHealthy = false;
assert.equal(monitor.maintenanceTickRequired(now), true,
  "loss of the activity source must retain an independent enforcement backstop");
monitor.lastPollAt = now - 1_000;
monitor.lastScheduledTickAt = now - 1_000;
assert.equal(monitor.maintenanceTickRequired(now), false, "failure recovery must be rate limited");
assert.equal(monitor.maintenanceTickRequired(now - 20_000), true,
  "a backwards wall clock must not suspend integrity checks");
monitor.lastPollAt = now - 10_000;
monitor.lastScheduledTickAt = now - 10_000;
monitor.status.browserActivityAccelerationHealthy = true;
monitor.nextGrayscaleRefreshAt = now - 1;
assert.equal(monitor.maintenanceTickRequired(now), true, "active grayscale observations must keep their deadline");
monitor.nextGrayscaleRefreshAt = 0;
state.integrity.runtime.clockTamperDetectedAt = new Date(now).toISOString();
monitor.nextIntegrityRefreshAt = now + 1_000;
assert.equal(monitor.maintenanceTickRequired(now), false,
  "zero deadlines for disabled components must not create a polling loop");
assert.equal(monitor.maintenanceTickRequired(now + 1_000), true,
  "idle integrity recovery must honor its existing deadline");
monitor.lastPollAt = now + 1_000;
assert.equal(monitor.maintenanceTickRequired(now + 1_000), true,
  "frequent application-activation accounting must not postpone integrity maintenance");

monitor.recentBlocks.set("expired", now - 1);
monitor.recentBlocks.set("live", now + 60_000);
monitor.markCoolingDown("new");
assert.equal(monitor.recentBlocks.has("expired"), false);
assert.equal(monitor.recentBlocks.has("live"), true, "pruning must preserve active cooldowns");
assert.equal(monitor.isCoolingDown("new"), true);

const checkpointMonitor = new Monitor({ state: defaultState(), usage: {}, externalEffectsEnabled: false });
checkpointMonitor.status.browserActivityAccelerationHealthy = true;
checkpointMonitor.lastScheduledTickAt = now - 10_000;
checkpointMonitor.runtimeUsageCheckpointEnabled = true;
checkpointMonitor.hotCheckpointFailureCount = 1;
checkpointMonitor.nextHotCheckpointAt = 30_000;
assert.equal(checkpointMonitor.maintenanceTickRequired(now, 29_999), false,
  "idle checkpoint recovery must honor monotonic backoff without extra writes");
assert.equal(checkpointMonitor.maintenanceTickRequired(now, 30_000), true,
  "a retryable checkpoint failure must recover even after user activity stops");
checkpointMonitor.hotCheckpointFailureCount = 0;
assert.equal(checkpointMonitor.maintenanceTickRequired(now, 30_000), false,
  "healthy idle checkpoints must not cause periodic OS polling");
checkpointMonitor.hotCheckpointFailureCount = 1;
checkpointMonitor.runtimeUsageCheckpointEnabled = false;
assert.equal(checkpointMonitor.maintenanceTickRequired(now, 30_000), false,
  "permanently disabled compact checkpoints must not cause a retry loop");

for (const mode of ["protected-browsers", "full-lockout", "ordinary"] as const) {
  const sweepState = defaultState();
  if (mode === "protected-browsers") sweepState.settings.protectedBrowsersOnly = true;
  if (mode === "full-lockout") {
    sweepState.activeSession = {
      id: "light-full-lockout",
      title: "Full lockout",
      mode: "focus",
      profileId: "default",
      lockLevel: "light",
      startedAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 60_000).toISOString(),
      fullLockout: true
    };
  }
  const sweepMonitor = new Monitor({ state: sweepState, usage: {}, externalEffectsEnabled: false });
  sweepMonitor.status.browserActivityAccelerationHealthy = true;
  sweepMonitor.lastScheduledTickAt = now - 60_000;
  await sweepMonitor.sweepBlockedProcesses(now, {
    runningApps: { ok: false, apps: [], error: "test enumeration failure" }
  });
  assert.equal(sweepMonitor.appBlockHistory.size, 0);
  const retryAt = sweepMonitor.nextProcessSweepAt;
  assert.ok(retryAt > now);
  assert.equal(sweepMonitor.maintenanceTickRequired(retryAt - 1), false,
    `${mode}: failure must honor the sweep retry deadline`);
  assert.equal(sweepMonitor.maintenanceTickRequired(retryAt), true,
    `${mode}: failed enumeration must retry without input or prior blocked-app history`);
  await sweepMonitor.sweepBlockedProcesses(retryAt, { runningApps: { ok: true, apps: [] } });
  assert.equal(sweepMonitor.maintenanceTickRequired(sweepMonitor.nextProcessSweepAt), mode !== "ordinary",
    `${mode}: only mandatory continuous sweeps should continue after recovery`);
  sweepState.settings.processSweepEnabled = false;
  sweepState.settings.appQuitEnabled = false;
  sweepState.settings.protectedBrowsersOnly = false;
  sweepState.activeSession = null;
  await sweepMonitor.sweepBlockedProcesses(retryAt + 60_000);
  sweepMonitor.status.componentErrors["process-sweep"] = "stale failure";
  assert.equal(sweepMonitor.maintenanceTickRequired(retryAt + 60_000), false,
    `${mode}: a disabled sweep must not wake repeatedly for stale health/deadline state`);
}

mock.timers.enable({ apis: ["setTimeout", "Date"], now });
try {
  const idleState = defaultState();
  let healthy = true;
  let ticks = 0;
  const idleMonitor = new Monitor({
    state: idleState,
    usage: {},
    externalEffectsEnabled: false,
    browserActivitySubscribe: () => () => {},
    browserActivityHealthy: () => healthy
  });
  idleMonitor.runScheduledTick = async () => {
    ticks += 1;
    idleMonitor.lastPollAt = Date.now();
    idleMonitor.lastScheduledTickAt = Date.now();
  };
  idleMonitor.start();
  assert.equal(ticks, 1);
  mock.timers.tick(10_000);
  assert.equal(ticks, 1, "maintenance timer must leave healthy idle OS enforcement asleep");
  healthy = false;
  mock.timers.tick(1_000);
  assert.equal(ticks, 2, "helper failure without any input must trigger reconciliation");
  await idleMonitor.stop();
  mock.timers.tick(10_000);
  assert.equal(ticks, 2, "shutdown must cancel the maintenance timer");

  const accountingState = defaultState();
  const accountingMonitor = new Monitor({ state: accountingState, usage: {}, externalEffectsEnabled: false });
  accountingMonitor.running = true;
  accountingMonitor.lastSample = { app: "Example", hostname: "", url: "" };
  let accountingTicks = 0;
  accountingMonitor.runScheduledTick = async () => {
    accountingTicks += 1;
    accountingMonitor.status.lastIdleAccounting = { ok: true, idleSeconds: accountingTicks * 60 };
  };
  accountingMonitor.scheduleActivityAccounting();
  mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(accountingTicks, 1);
  assert.ok(accountingMonitor.activityAccountingTimer,
    "one final input must keep accounting until the 120-second idle threshold");
  mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(accountingTicks, 2);
  assert.equal(accountingMonitor.activityAccountingTimer, null,
    "idle accounting must stop when the configured threshold is reached");
  accountingState.settings.idleUsageTrackingEnabled = false;
  assert.equal(accountingMonitor.activityAccountingRequired(), true,
    "disabling idle exclusion must continue passive-use accounting");
  accountingState.settings.idleUsageTrackingEnabled = true;
  accountingState.settings.idleUsageThresholdSeconds = 300;
  assert.equal(accountingMonitor.activityAccountingRequired(), true,
    "custom idle thresholds must not inherit a fixed two-minute cutoff");
  accountingMonitor.status.lastIdleAccounting = { ok: false };
  assert.equal(accountingMonitor.activityAccountingRequired(), true);
  await accountingMonitor.stop();
} finally {
  mock.timers.reset();
}
