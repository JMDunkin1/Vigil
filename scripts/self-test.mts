import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { focusShortcutDetail, focusShortcutSummary, reconcileFocusShortcut } from "../src/focusHooks.js";
import { assertIntentReason, intentReasonSummary } from "../src/intentReason.js";
import { now } from "./tests/test-helpers.mjs";

{
  const state = defaultState();
  assert.equal(focusShortcutSummary(state).enabled, false);
  assert.match(focusShortcutDetail(focusShortcutSummary(state)), /disabled/);
  assert.equal((await reconcileFocusShortcut(state, null, now)).changed, false);
  state.focusShortcut.active = true;
  state.settings.focusShortcutOffName = "";
  const missingOff = await reconcileFocusShortcut(state, null, now);
  assert.equal(missingOff.ok, false);
  assert.match(missingOff.lastError, /Focus Off/);
}

{
  const state = defaultState();
  assert.equal(intentReasonSummary(state).enabled, true);
  assert.equal(state.settings.focusSoundEnabled, false);
  assert.equal(state.settings.focusSoundPreset, "brown-noise");
  assert.equal(state.settings.focusSoundVolume, 35);
  assert.throws(() => assertIntentReason(state, "too short", "Emergency unlock"), /at least 20/);
  assert.equal(
    assertIntentReason(state, "  I need to unblock this briefly for a real task.  ", "Emergency unlock"),
    "I need to unblock this briefly for a real task."
  );
  state.settings.intentReasonEnabled = false;
  assert.equal(assertIntentReason(state, "", "Emergency unlock"), "");
}

console.log("Self-test passed");
