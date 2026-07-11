import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { applyWifiEnvironmentObservation } from "../src/monitor.js";
import { activeSchedule } from "../src/policy.js";
import { now, TEST_DAYS } from "./test-helpers.mjs";

{
  const state = defaultState();
  state.schedules = [{
    id: "wifi-fail-closed",
    name: "Wi-Fi fail closed",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    commitmentLock: true,
    days: TEST_DAYS,
    start: "00:00",
    end: "23:59",
    wifiNetworks: ["Office"]
  }];
  applyWifiEnvironmentObservation(state, { ok: true, ssid: "Office" }, now);
  assert.ok(activeSchedule(state, now));
  const successfulCheck = state.environment.wifiCheckedAt;
  applyWifiEnvironmentObservation(state, { ok: false, error: "CoreWLAN permission denied" }, new Date(now.getTime() + 60 * 1000));
  assert.equal(state.environment.wifiSsid, "Office");
  assert.equal(state.environment.wifiCheckedAt, successfulCheck);
  assert.match(state.environment.wifiError, /permission denied/);
  assert.ok(activeSchedule(state, new Date(now.getTime() + 10 * 60 * 1000)), "lookup failure must retain a schedule that was active at the last successful Wi-Fi observation");
  applyWifiEnvironmentObservation(state, { ok: true, ssid: "" }, new Date(now.getTime() + 11 * 60 * 1000));
  assert.equal(activeSchedule(state, new Date(now.getTime() + 11 * 60 * 1000)), null, "a successful disconnect observation must release the Wi-Fi schedule");
}

{
  const state = defaultState();
  state.schedules = [{
    id: "wifi-not-yet-active",
    name: "Wi-Fi not yet active",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    commitmentLock: true,
    days: TEST_DAYS,
    start: "14:05",
    end: "15:00",
    wifiNetworks: ["Office"]
  }];
  applyWifiEnvironmentObservation(state, { ok: true, ssid: "Office" }, now);
  applyWifiEnvironmentObservation(state, { ok: false, error: "Wi-Fi lookup failed" }, new Date(now.getTime() + 60 * 1000));
  assert.equal(activeSchedule(state, new Date(now.getTime() + 10 * 60 * 1000)), null, "a stale observation from before the window must not start a new Wi-Fi schedule during lookup failure");
}
