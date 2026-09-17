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

api.bindDeviceActions();
const iosForm = $("#iosForm") as unknown as HTMLFormElement;
$("#iosBlockWeb").checked = true;
iosForm.dispatchEvent(new Event("change"));
const iosSave = api.saveIosSettings();
$("#iosBlockApps").checked = true;
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

const profileForm = $("#profileForm") as unknown as HTMLFormElement;
trackFormChanges(profileForm);
const profileFields = new Map<string, { value: string }>();
const profileField = (_form: HTMLFormElement, name: string) => {
  let field = profileFields.get(name);
  if (!field) { field = { value: "" }; profileFields.set(name, field); }
  return field;
};
let completeProfile!: (result: { profile: { id: string } }) => void;
let failBaselineUpdate = false;
let profileCloses = 0;
const profileApi = runInNewContext(`let profileEditorGeneration = 0;\n${functionSource("saveProfile")}\n({ saveProfile, openAnotherEditor() { profileEditorGeneration += 1; } });`, {
  $, formInput: profileField, formRevision, markFormSavedAtRevision,
  lines: (value: string) => value.split("\n").filter(Boolean),
  post: (path: string) => {
    if (path === "/api/profile") return new Promise((resolve) => { completeProfile = resolve; });
    return failBaselineUpdate ? Promise.reject(new Error("maintenance required")) : Promise.resolve();
  },
  closeProfileEditor: () => { profileCloses += 1; },
  ui: {}, toast() {}, refresh: async () => {}, handleMutationError() {}
}) as { saveProfile(): Promise<void>; openAnotherEditor(): void };
profileField(profileForm, "name").value = "First draft";
profileForm.dispatchEvent(new Event("input"));
const profileSave = profileApi.saveProfile();
profileField(profileForm, "name").value = "A newer draft";
profileForm.dispatchEvent(new Event("input"));
completeProfile({ profile: { id: "created-profile" } });
await profileSave;
assert.equal(profileCloses, 0, "a completed profile save must not close an editor containing newer changes");
assert.equal(profileField(profileForm, "id").value, "created-profile", "the next save must update the newly created profile rather than duplicate it");
assert.equal(formHasUnsavedChanges(profileForm), true);
const nextProfileSave = profileApi.saveProfile();
completeProfile({ profile: { id: "created-profile" } });
await nextProfileSave;
assert.equal(profileCloses, 1, "saving the current revision may close the editor");

const staleProfileSave = profileApi.saveProfile();
profileApi.openAnotherEditor();
profileField(profileForm, "id").value = "another-profile";
completeProfile({ profile: { id: "created-profile" } });
await staleProfileSave;
assert.equal(profileCloses, 1, "an old save must not close a subsequently opened editor");
assert.equal(profileField(profileForm, "id").value, "another-profile");

profileField(profileForm, "id").value = "";
failBaselineUpdate = true;
const partialProfileSave = profileApi.saveProfile();
completeProfile({ profile: { id: "saved-before-baseline-failed" } });
await partialProfileSave;
assert.equal(profileField(profileForm, "id").value, "saved-before-baseline-failed", "a failed baseline update must not cause duplicate profile creation on retry");
