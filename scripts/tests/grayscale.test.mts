import assert from "node:assert/strict";
import { defaultState, BRICK_MODE_PROFILE_ID, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { buildIosGrayscaleSettingsCommand, queueIosMdmPolicyRefresh } from "../../src/iosMdm.js";
import { grayscaleDecision, normalizeGrayscaleSchedule } from "../../src/grayscale.js";
import { snapshotProfile } from "../../src/policy.js";
import type { DeviceTarget, SentinelState, Session } from "../../src/types.js";

const mondayNight = new Date("2026-06-01T23:00:00");
const mondayNoon = new Date("2026-06-01T12:00:00");

{
  const state = defaultState();
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).desired, false);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "phone" }).desired, false);
}

{
  const state = defaultState();
  startSession(state, BRICK_MODE_PROFILE_ID, "brick", ["computer", "phone"]);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).desired, true);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "phone" }).desired, true);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "phone" }).source, "brick");
}

{
  const state = defaultState();
  startSession(state, SOFT_BLOCK_PROFILE_ID, "focus", ["computer"]);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).desired, false);
  state.grayscale.softBlockEnabled = true;
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).desired, true);
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).source, "soft-block");
}

{
  const state = defaultState();
  state.grayscale.schedules = [
    normalizeGrayscaleSchedule({
      id: "night",
      name: "Night grayscale",
      enabled: true,
      start: "22:00",
      end: "07:00",
      days: [0, 1, 2, 3, 4, 5, 6],
      deviceTargets: ["computer", "phone"]
    })
  ];
  assert.equal(grayscaleDecision(state, mondayNight, { device: "computer" }).desired, true);
  assert.equal(grayscaleDecision(state, mondayNight, { device: "phone" }).source, "schedule");
  assert.equal(grayscaleDecision(state, mondayNoon, { device: "computer" }).desired, false);
}

{
  assert.deepEqual(buildIosGrayscaleSettingsCommand(true), {
    RequestType: "Settings",
    Settings: [
      {
        Item: "AccessibilitySettings",
        GrayscaleEnabled: true
      }
    ]
  });
}

{
  const state = defaultState();
  state.deviceControls.ios.mdm.enabled = true;
  state.deviceControls.ios.mdm.devices = [{ udid: "phone-1", status: "enrolled" }];
  state.grayscale.schedules = [
    normalizeGrayscaleSchedule({
      id: "phone-night",
      name: "Phone night",
      enabled: true,
      start: "22:00",
      end: "07:00",
      days: [0, 1, 2, 3, 4, 5, 6],
      deviceTargets: ["phone"]
    })
  ];
  const result = queueIosMdmPolicyRefresh(state, "test", mondayNight) as { grayscaleQueued?: number };
  assert.equal(result.grayscaleQueued, 1);
  const command = state.deviceControls.ios.mdm.commands.find((item) => item.requestType === "Settings");
  assert.equal(command?.grayscaleDesired, true);
  assert.deepEqual(command?.command, buildIosGrayscaleSettingsCommand(true));
}

function startSession(state: SentinelState, profileId: string, mode: string, deviceTargets: DeviceTarget[]): void {
  const profile = state.profiles.find((item) => item.id === profileId);
  assert.ok(profile);
  const session: Session = {
    id: `${profileId}-session`,
    title: profile.name,
    mode,
    profileId,
    lockLevel: mode === "brick" ? "deep" : "light",
    startedAt: mondayNoon.toISOString(),
    endsAt: new Date(mondayNoon.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: mode !== "brick",
    commitmentLock: mode === "brick",
    emergencyUnlocksAllowed: mode !== "brick",
    source: "test",
    deviceTargets,
    profileSnapshot: snapshotProfile(profile)
  };
  state.activeSessions = {
    computer: deviceTargets.includes("computer") ? session : null,
    phone: deviceTargets.includes("phone") ? session : null
  };
  state.activeSession = state.activeSessions.computer || null;
}
