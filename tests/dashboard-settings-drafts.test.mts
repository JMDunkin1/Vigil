import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { formHasUnsavedChanges, formRevision, markFormSavedAtRevision, trackFormChanges } from "../public/form-state.js";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const end = source.indexOf("\n}", start) + 2;
  assert.ok(end > start);
  return `${source.slice(start - 6, start) === "async " ? "async " : ""}${source.slice(start, end)}`;
}
runInNewContext(`${functionSource("render")}\nrender();`, { document: { hidden: true } });
// No UI bindings are supplied: a late response while hidden must return before
// touching data or rebuilding any DOM section.
class Control extends EventTarget {
  value = "";
  checked = false;
  form: HTMLFormElement | null = null;
  closest(): HTMLFormElement | null { return this.form; }
}
const controls = new Map<string, Control>();
const $ = (selector: string): Control => {
  let control = controls.get(selector);
  if (!control) { control = new Control(); controls.set(selector, control); }
  return control;
};
let resolvePost: () => void = () => {};
let rejectPost: (error: Error) => void = () => {};
const context = {
  $, $$: () => [], document: { activeElement: null },
  formHasUnsavedChanges, formRevision, markFormSavedAtRevision, trackFormChanges,
  post: () => new Promise<void>((resolve, reject) => { resolvePost = resolve; rejectPost = reject; }),
  refresh: async () => {}, toast() {}, handleMutationError() {},
  Number
};
const api = runInNewContext([
  "bindSettingActions", "setInputValue", "saveSettings", "saveKeyholder"
].map(functionSource).join("\n") + "\n({ bindSettingActions, setInputValue, saveSettings, saveKeyholder });", context) as {
  bindSettingActions(): void;
  setInputValue(selector: string, value: unknown): void;
  saveSettings(body: object, message: string, formSelector: string): Promise<void>;
  saveKeyholder(): Promise<void>;
};
api.bindSettingActions();
const form = $("#enforcementTimingForm") as unknown as HTMLFormElement;
const input = $("#appQuitEscalationSeconds");
input.form = form;
api.setInputValue("#appQuitEscalationSeconds", 10);
assert.equal(input.value, "10");
input.value = "25";
form.dispatchEvent(new Event("input"));
api.setInputValue("#appQuitEscalationSeconds", 10);
assert.equal(input.value, "25", "polling must retain a draft after focus leaves its control");

const save = api.saveSettings({}, "saved", "#enforcementTimingForm");
input.value = "30";
form.dispatchEvent(new Event("input"));
resolvePost();
await save;
api.setInputValue("#appQuitEscalationSeconds", 25);
assert.equal(input.value, "30", "edits made while the previous revision saves must survive its refresh");
const saveLatest = api.saveSettings({}, "saved", "#enforcementTimingForm");
resolvePost();
await saveLatest;
api.setInputValue("#appQuitEscalationSeconds", 30);
assert.equal(formHasUnsavedChanges(form), false);

input.value = "40";
form.dispatchEvent(new Event("input"));
const failed = api.saveSettings({}, "saved", "#enforcementTimingForm");
rejectPost(new Error("maintenance required"));
await failed;
api.setInputValue("#appQuitEscalationSeconds", 30);
assert.equal(input.value, "40", "failed protected saves must retain the draft");

const keyholder = $("#keyholderForm") as unknown as HTMLFormElement;
$("#keyholderPasscode").value = "first";
keyholder.dispatchEvent(new Event("input"));
const keyholderSave = api.saveKeyholder();
$("#keyholderPasscode").value = "second";
keyholder.dispatchEvent(new Event("input"));
resolvePost();
await keyholderSave;
assert.equal($("#keyholderPasscode").value, "second", "an earlier save must not erase a newer passcode draft");
