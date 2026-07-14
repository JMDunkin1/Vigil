import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { MONITOR_HEALTH_COMPONENTS } from "../src/monitor.js";
import { runtimeReadiness } from "../src/server.js";

const state = defaultState();
const instance = new Date(Date.now() - 1_000).toISOString();
const tick = new Date().toISOString();
state.integrity.runtime.lastHeartbeatAt = tick;
const monitorStatus = {
  ok: true,
  componentErrors: {},
  componentHealth: Object.fromEntries(MONITOR_HEALTH_COMPONENTS.map((component) => [component, {
    lastAttemptAt: tick,
    lastSuccessAt: tick as string | null,
    error: "",
    applicable: true,
    state: "healthy" as string
  }])),
  runtimeInstanceId: instance,
  runtimeStartedAt: instance,
  lastSuccessfulTickAt: tick
};
const healthy = runtimeReadiness(monitorStatus, state, instance);
assert.equal(healthy.ok, true);

assert.equal(runtimeReadiness({ ...monitorStatus, runtimeInstanceId: "prior-runtime" }, state, instance).ok, false);
assert.equal(runtimeReadiness({ ...monitorStatus, lastSuccessfulTickAt: null }, state, instance).ok, false);
const missingRequired = structuredClone(monitorStatus);
delete missingRequired.componentHealth.grayscale;
assert.equal(runtimeReadiness(missingRequired, state, instance).ok, false, "a missing required component must block readiness");

const disabled = structuredClone(monitorStatus);
disabled.componentHealth["grayscale-guard"] = { lastAttemptAt: tick, lastSuccessAt: null, error: "", applicable: false, state: "disabled" };
assert.equal(runtimeReadiness(disabled, state, instance).ok, true, "an explicitly disabled component is not required to succeed");
disabled.componentHealth["grayscale-guard"] = { lastAttemptAt: tick, lastSuccessAt: null, error: "", applicable: false, state: "healthy" };
assert.equal(runtimeReadiness(disabled, state, instance).ok, false, "non-applicable components must use explicit disabled state");

const stale = structuredClone(state);
stale.integrity.runtime.lastHeartbeatAt = new Date(Date.now() - 60_000).toISOString();
assert.equal(runtimeReadiness(monitorStatus, stale, instance).ok, false);

const degraded = structuredClone(state);
degraded.integrity.runtime.clockTamperDetectedAt = new Date().toISOString();
assert.equal(runtimeReadiness(monitorStatus, degraded, instance).ok, false);

degraded.integrity.runtime.clockTamperDetectedAt = null;
degraded.integrity.runtime.hardeningDriftDetectedAt = new Date().toISOString();
assert.equal(runtimeReadiness(monitorStatus, degraded, instance).ok, false);

degraded.integrity.runtime.hardeningDriftDetectedAt = null;
assert.equal(runtimeReadiness(monitorStatus, degraded, instance).ok, true, "readiness must recover when fresh checks recover");
