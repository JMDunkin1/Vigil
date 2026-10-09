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
  "bindSettingActions", "setInputValue", "saveSettings", "saveKeyholder", "bindDeviceActions", "saveIosSettings"
].map(functionSource).join("\n") + "\n({ bindSettingActions, setInputValue, saveSettings, saveKeyholder, bindDeviceActions, saveIosSettings });", context) as {
  bindSettingActions(): void;
  setInputValue(selector: string, value: unknown): void;
  saveSettings(body: object, message: string, formSelector: string): Promise<void>;
  saveKeyholder(): Promise<void>;
  bindDeviceActions(): void;
  saveIosSettings(): Promise<void>;
};
api.bindSettingActions();
const form = $("#accessTimingForm") as unknown as HTMLFormElement;
const input = $("#panicLockDurationMinutes");
input.form = form;
api.setInputValue("#panicLockDurationMinutes", 10);
assert.equal(input.value, "10");
input.value = "25";
form.dispatchEvent(new Event("input"));
api.setInputValue("#panicLockDurationMinutes", 10);
assert.equal(input.value, "25", "polling must retain a draft after focus leaves its control");

const save = api.saveSettings({}, "saved", "#accessTimingForm");
input.value = "30";
form.dispatchEvent(new Event("input"));
resolvePost();
await save;
api.setInputValue("#panicLockDurationMinutes", 25);
assert.equal(input.value, "30", "edits made while the previous revision saves must survive its refresh");
const saveLatest = api.saveSettings({}, "saved", "#accessTimingForm");
resolvePost();
await saveLatest;
api.setInputValue("#panicLockDurationMinutes", 30);
assert.equal(formHasUnsavedChanges(form), false);

input.value = "40";
form.dispatchEvent(new Event("input"));
const failed = api.saveSettings({}, "saved", "#accessTimingForm");
rejectPost(new Error("maintenance required"));
await failed;
api.setInputValue("#panicLockDurationMinutes", 30);
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

api.bindDeviceActions();
const iosForm = $("#iosForm") as unknown as HTMLFormElement;
$("#iosAllowSafariHistoryClearing").checked = true;
iosForm.dispatchEvent(new Event("change"));
const iosSave = api.saveIosSettings();
$("#iosRestrictInstallErase").checked = true;
iosForm.dispatchEvent(new Event("change"));
resolvePost();
await iosSave;
assert.equal(formHasUnsavedChanges(iosForm), true, "an earlier iPhone policy save must retain subsequent checkbox edits");
const iosSaveLatest = api.saveIosSettings();
resolvePost();
await iosSaveLatest;
assert.equal(formHasUnsavedChanges(iosForm), false, "the current iPhone policy revision may be refreshed once saved");
iosForm.dispatchEvent(new Event("change"));
const iosSaveFailed = api.saveIosSettings();
rejectPost(new Error("maintenance required"));
await iosSaveFailed;
assert.equal(formHasUnsavedChanges(iosForm), true, "a rejected policy save must retain the iPhone draft");

