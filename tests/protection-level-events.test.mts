import assert from "node:assert/strict";
import { applyProtectionLevelPresentation } from "../public/app-events.js";

const input = { value: "2" };
const control = { dataset: {} as DOMStringMap };
const label = { textContent: "Level 2" };
const status = { textContent: "Soft Lock" };
const elements = { input, control, label, status };

applyProtectionLevelPresentation(4, true, elements);
assert.deepEqual(
  { value: input.value, level: control.dataset.level, label: label.textContent, status: status.textContent },
  { value: "4", level: "4", label: "Panic", status: "3 min lock" },
  "the range preview should show Panic before confirmation"
);

applyProtectionLevelPresentation(2, false, elements);
assert.deepEqual(
  { value: input.value, level: control.dataset.level, label: label.textContent, status: status.textContent },
  { value: "2", level: "2", label: "Level 2", status: "Soft Lock" },
  "rejecting Panic must synchronously restore every visible value to the applied level"
);
