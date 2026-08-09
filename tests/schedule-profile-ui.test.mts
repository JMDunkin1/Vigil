import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile("public/app.js", "utf8");

const baselineSelection = section(appSource, "async function selectBaselineProfile", "function openNewProfile");
assert.match(baselineSelection, /baselineProfileId: id/u, "the ruleset selector must update the idle baseline profile");
assert.doesNotMatch(baselineSelection, /activeProfileId/u, "selecting a baseline must not rewrite the current runtime policy");

const newSchedule = section(appSource, "function openNewSchedule", "function openScheduleTemplate");
assert.match(newSchedule, /baselineProfileId\(ui\.data\?\.state\)/u, "new schedules must default to the configured baseline ruleset");
assert.match(newSchedule, /dataset\.lockLevel = "deep"/u, "new schedules must reset to the safe deep-lock default");
assert.match(newSchedule, /setScheduleDevices\(\["computer", "phone"\]\)/u, "new schedules must clearly target both configured devices by default");

const saveSchedule = section(appSource, "async function saveSchedule", "function validateScheduleForm");
assert.match(saveSchedule, /profileId: \$\("#scheduleProfileId"\)\.value/u, "schedule saves must use the explicit ruleset control");
assert.match(saveSchedule, /lockLevel:[\s\S]*?dataset\.lockLevel \|\| "deep"/u, "schedule saves must preserve an edited schedule's hydrated lock level");
assert.match(saveSchedule, /commitmentLock:[\s\S]*?\.checked/u, "unchecked commitment state must be serialized explicitly");
assert.match(saveSchedule, /days: selectedScheduleDays\(\)/u, "schedule days must serialize as a numeric array");
assert.match(saveSchedule, /deviceTargets: selectedScheduleDevices\(\)/u, "device targets must serialize explicitly");
assert.match(saveSchedule, /wifiNetworks: lines/u, "Wi-Fi qualifiers must serialize as a clean list");
assert.match(saveSchedule, /post\("\/api\/grayscale\/schedule", shared\)/u, "the unified schedule surface must save grayscale routines through their protected endpoint");

const editSchedule = section(appSource, "function editSchedule", "async function toggleSchedule");
assert.match(editSchedule, /\$\("#scheduleProfileId"\)\.value = entry\.lock\.profileId/u, "editing a schedule must restore its bound ruleset");
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
assert.match(toggleSchedule, /grayscaleSchedulePayload\(entry\.grayscale, !entry\.enabled\)/u, "toggling must retain the full grayscale schedule payload");

const validation = section(appSource, "function validateScheduleForm", "function renderSchedules");
assert.match(validation, /Start and end times must be different/u, "start === end must be rejected because it never activates");
assert.match(validation, /Choose at least one day/u);
assert.match(validation, /Choose at least one device/u);
assert.match(validation, /Choose a ruleset/u);

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
