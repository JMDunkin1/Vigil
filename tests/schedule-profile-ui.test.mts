import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const appSource = await readFile("public/app.js", "utf8");

assert.doesNotMatch(appSource, /function openNewProfile|function saveProfile/u, "retired custom-profile editing must not initialize");

const newSchedule = section(appSource, "function openNewSchedule", "function openScheduleTemplate");
assert.match(newSchedule, /const baseline = "brick-mode"/u, "new schedules must default to a real social pause");
assert.match(newSchedule, /dataset\.lockLevel = "deep"/u, "new schedules must reset to the safe deep-lock default");
assert.match(newSchedule, /setScheduleDevices\(\["computer", "phone"\]\)/u, "new schedules must clearly target both configured devices by default");

const saveSchedule = section(appSource, "async function saveSchedule", "function validateScheduleForm");
assert.match(saveSchedule, /profileId: \$\("#scheduleProfileId"\)\.value/u, "schedule saves must use the explicit ruleset control");
assert.match(saveSchedule, /lockLevel:[\s\S]*?dataset\.lockLevel \|\| "deep"/u, "schedule saves must preserve an edited schedule's hydrated lock level");
assert.match(saveSchedule, /commitmentLock:[\s\S]*?\.checked/u, "unchecked commitment state must be serialized explicitly");
assert.match(saveSchedule, /days: selectedScheduleDays\(\)/u, "schedule days must serialize as a numeric array");
assert.match(saveSchedule, /deviceTargets: selectedScheduleDevices\(\)/u, "device targets must serialize explicitly");
assert.match(saveSchedule, /wifiNetworks: lines/u, "Wi-Fi qualifiers must serialize as a clean list");

const editSchedule = section(appSource, "function editSchedule", "async function toggleSchedule");
assert.match(editSchedule, /\$\("#scheduleProfileId"\)\.value = entry\.lock\.profileId/u, "editing a schedule must restore its bound ruleset");
assert.match(editSchedule, /fillScheduleProfileOptions\(ui\.data\?\.state, entry\.lock\.profileId\)/u, "editing must make its retained ruleset available before selecting it");
assert.match(editSchedule, /dataset\.lockLevel = entry\.lock\.lockLevel \|\| "deep"/u, "editing a schedule must restore its saved lock level");
assert.match(editSchedule, /setScheduleDays\(entry\.days\)/u);
assert.match(editSchedule, /setScheduleDevices\(entry\.deviceTargets\)/u);
assert.match(editSchedule, /wifiNetworks[\s\S]*?join\("\\n"\)/u);

const scheduleRows = section(appSource, "function scheduleRow", "function scheduleActionButton");
assert.match(scheduleRows, /profileName\(entry\.lock\.profileId\)/u, "schedule summaries must resolve the bound profile name");
assert.match(scheduleRows, /scheduleModeLabel\(entry\.lock\?\.mode/u, "schedule summaries must show the session mode");
assert.match(scheduleRows, /deviceTargetsLabel\(entry\.deviceTargets\)/u, "schedule summaries must show their device scope");
assert.match(scheduleRows, /commitment/u, "schedule summaries must disclose commitment locking");

const toggleSchedule = section(appSource, "async function toggleSchedule", "async function deleteSchedule");
assert.match(toggleSchedule, /lockSchedulePayload\(entry\.lock, !entry\.enabled\)/u, "toggling must retain the full saved lock schedule payload");

const validation = section(appSource, "function validateScheduleForm", "function renderSchedules");
assert.match(validation, /Start and end times must be different/u, "start === end must be rejected because it never activates");
assert.match(validation, /Choose at least one day/u);
assert.match(validation, /Choose at least one device/u);
assert.match(validation, /Choose a ruleset/u);

{
  // Match a select's behavior: setting an unavailable value clears selection.
  let selected = "";
  let options: Array<{ value: string }> = [];
  const select = {
    dataset: {} as Record<string, string>,
    get value() { return selected; },
    set value(value: string) { selected = options.some(option => option.value === value) ? value : ""; },
    replaceChildren(...children: Array<{ value: string }>) { options = children; selected = children[0]?.value || ""; }
  };
  const state = {
    profiles: ["normal", "brick-mode", "default", "custom"].map(id => ({ id, name: id })),
    settings: { baselineProfileId: "default" }
  };
  const context = createContext({
    $: () => select,
    profileOption: (profile: { id: string }) => ({ value: profile.id }),
    baselineProfileId: () => state.settings.baselineProfileId,
    state
  });
  runInContext(section(appSource, "function fillScheduleProfileOptions", "function profileOption"), context);
  for (const retained of ["default", "custom"]) {
    runInContext(`fillScheduleProfileOptions(state, "${retained}")`, context);
    select.value = retained;
    assert.equal(select.value, retained, "the saved ruleset must exist in the editing select");
    runInContext("fillScheduleProfileOptions(state)", context);
    assert.equal(select.value, retained, "a dashboard refresh must preserve the edited ruleset");
  }
  runInContext('fillScheduleProfileOptions(state, "")', context);
  assert.deepEqual(options.map(option => option.value), ["normal", "brick-mode"], "new schedules keep only the supported ruleset choices");
  assert.equal(select.value, "normal", "a retired baseline must not clear the select");
}

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
