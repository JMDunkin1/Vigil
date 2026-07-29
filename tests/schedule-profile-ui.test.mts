import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appEventsSource, appSource, formsSource] = await Promise.all([
  readFile("public/app-events.js", "utf8"),
  readFile("public/app.js", "utf8"),
  readFile("public/forms.js", "utf8")
]);

const profileChangeHandler = section(appEventsSource, '$("#profileSelect").addEventListener', '$("#profileForm").addEventListener');
assert.match(profileChangeHandler, /baselineProfileId: state\.selectedProfileId/u, "the ruleset selector must update the idle baseline profile");
assert.doesNotMatch(profileChangeHandler, /activeProfileId/u, "viewing a ruleset must not rewrite the runtime active profile");

const scheduleSubmitHandler = section(appEventsSource, '$("#scheduleForm").addEventListener', '$("#newSchedule").addEventListener');
assert.match(scheduleSubmitHandler, /body\.profileId = \$\("#scheduleProfileId"\)\.value/u, "schedule saves must use the schedule's explicit ruleset control");
assert.doesNotMatch(scheduleSubmitHandler, /body\.lockLevel = "deep"/u, "schedule saves must preserve the form's hydrated lock level");
assert.doesNotMatch(scheduleSubmitHandler, /settings\.activeProfileId/u, "schedule saves must not inherit whichever runtime profile is active");

const loadSchedule = section(formsSource, "function loadSchedule", "function loadGrayscaleSchedule");
assert.match(loadSchedule, /\$\("#scheduleProfileId"\)\.value = schedule\.profileId/u, "editing a schedule must restore its saved ruleset");
assert.match(loadSchedule, /form\.elements\.lockLevel\.value = schedule\.lockLevel \|\| "deep"/u, "editing a schedule must preserve its saved lock level");

const resetSchedule = section(formsSource, "function resetScheduleForm", "function resetGrayscaleScheduleForm");
assert.match(resetSchedule, /dataset\.baselineProfileId/u, "new schedules must default to the configured baseline ruleset");

const loadIntentionalRule = section(formsSource, "function loadIntentionalRule", "function resetIntentionalRuleForm");
assert.match(loadIntentionalRule, /rule\.delaySeconds \?\? 12/u, "a saved zero-second intentional delay must survive form hydration");
assert.match(loadIntentionalRule, /rule\.dailyBudgetMinutes \?\? 30/u, "a saved zero-minute intentional budget must survive form hydration");

const renderProfiles = section(appSource, "function renderProfiles", "function renderSchedules");
assert.match(renderProfiles, /settings\.baselineProfileId/u, "the ruleset selector must render from baselineProfileId");
assert.match(renderProfiles, /fillSelect\(scheduleProfileSelect, profiles, baselineId\)/u, "available profiles must populate the schedule ruleset control");

const renderSchedules = section(appSource, "function renderSchedules", "function scheduleModeLabel");
assert.match(renderSchedules, /profileNames\.get\(schedule\.profileId\)/u, "schedule summaries must resolve their bound profile name");
assert.match(renderSchedules, /scheduleModeLabel\(schedule\.mode\).*profileName/u, "schedule summaries must show both protection mode and bound profile");

function section(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}
