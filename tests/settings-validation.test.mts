import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { updateSettings } from "../src/server/settingsRoutes.js";

{
  const state = defaultState();
  const before = structuredClone(state.settings);
  assert.throws(
    () => updateSettings(state.settings, {
      focusSoundVolume: before.focusSoundVolume === 17 ? 18 : 17,
      focusSoundMode: "not-a-focus-sound-mode"
    }, state.profiles.map((profile) => profile.id)),
    isValidationError
  );
  assert.deepEqual(state.settings, before, "an invalid enum must reject the complete settings update before mutation");
}

{
  const state = defaultState();
  const before = structuredClone(state.settings);
  assert.throws(
    () => updateSettings(state.settings, {
      focusSoundVolume: before.focusSoundVolume === 23 ? 24 : 23,
      activeProfileId: "missing-profile"
    }, state.profiles.map((profile) => profile.id)),
    isValidationError
  );
  assert.deepEqual(state.settings, before, "a missing profile reference must reject the complete settings update before mutation");

  const nextProfile = state.profiles.find((profile) => profile.id !== state.settings.baselineProfileId);
  assert.ok(nextProfile);
  assert.deepEqual(
    updateSettings(state.settings, { baselineProfileId: nextProfile.id }, state.profiles.map((profile) => profile.id)),
    ["baselineProfileId"]
  );
  assert.equal(state.settings.baselineProfileId, nextProfile.id);
}

function isValidationError(error: unknown): boolean {
  const validation = error as { status?: number; message?: string };
  assert.equal(validation.status, 400);
  assert.match(validation.message || "", /Invalid value|Unknown profile/u);
  return true;
}
