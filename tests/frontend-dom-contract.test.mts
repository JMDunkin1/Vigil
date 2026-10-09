import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, appSource, accountSource, updateSource, styles] = await Promise.all([
  readFile("public/index.html", "utf8"),
  readFile("public/app.js", "utf8"),
  readFile("public/account-ui.js", "utf8"),
  readFile("public/app-update.js", "utf8"),
  readFile("public/focused-redesign.css", "utf8")
]);

assert.match(html, /<title>Vigil<\/title>/u);
assert.match(html, /class="brand-mark"[\s\S]*?src="\/app-icons\/blue\.png"/u, "the sidebar brand must use the neutral Vigil app icon");
assert.doesNotMatch(html, /Focus protection|runtime-chip|runtimeDot|runtimeLabel|runtimeDetail/u, "the sidebar must omit the redundant subtitle and health summary chip");

const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicateIds)], [], "dashboard HTML must not contain duplicate IDs");
const idSet = new Set(ids);
for (const match of html.matchAll(/\bfor="([A-Za-z][\w:-]*)"/g)) {
  assert.ok(idSet.has(match[1]), `label references missing control #${match[1]}`);
}

const primaryNav = html.match(/<nav id="primaryNavigation"[\s\S]*?<\/nav>/u)?.[0] || "";
const navButtons = [...primaryNav.matchAll(/<button class="nav-item[^>]*data-view-target="([^"]+)"[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<\/button>/g)]
  .map((match) => ({ target: match[1], label: match[2] }));
assert.deepEqual(navButtons, [
  { target: "home", label: "Home" },
  { target: "schedules", label: "Schedules" },
  { target: "configuration", label: "Settings" }
], "primary navigation must expose exactly the focused three-view structure");
assert.equal((primaryNav.match(/class="nav-item is-active"/g) || []).length, 1, "Home must be the only initially active destination");
assert.match(primaryNav, /data-view-target="home"[^>]*aria-selected="true"/u, "Home must be selected initially");
for (const { target } of navButtons) {
  assert.match(html, new RegExp(`data-view="${target}"`), `${target} needs a matching view panel`);
}

assert.doesNotMatch(
  html,
  /data-view(?:-target)?="(?:activity|tracking|audio|journal)"|id="view-(?:activity|audio|journal)"/u,
  "Activity, Tracking, Audio, and Journal destinations must be removed"
);
assert.doesNotMatch(
  html,
  /focusSound|audioSoundLibrary|habitActivity|journalEntry|journalSecurity|totalUsageToday|activityFocusScore/u,
  "retired feature controls must not survive as hidden markup"
);
assert.doesNotMatch(appSource, /activity-view|tracking-view|focus-sound|life-log-view|journal-lock|minecraft-audio/u, "the focused renderer must not initialize retired feature modules");

const requiredRuntimeSources = [appSource, accountSource, updateSource];
const missingQueries = new Set<string>();
for (const source of requiredRuntimeSources) {
  for (const match of source.matchAll(/(?:\$\$?|querySelector(?:All)?)\(\s*["'`](#[A-Za-z][\w:-]*)/g)) {
    const id = match[1].slice(1);
    if (!idSet.has(id)) missingQueries.add(match[1]);
  }
}
assert.deepEqual([...missingQueries], [], "the active renderer graph must not query IDs missing from the new shell");

assert.match(html, /id="view-home"[\s\S]*?data-protection-level="1"[\s\S]*?data-protection-level="2"[\s\S]*?data-protection-level="3"/u, "Home must expose two numbered levels and the separate Panic action");
assert.doesNotMatch(html, /data-protection-level="4"/u, "the retired third numbered protection level must not remain in the Home selector");
assert.match(html, /id="emergencyPanel"[\s\S]*?id="requestEmergency"[\s\S]*?id="confirmEmergency"/u, "Settings must keep the protected emergency flow reachable");
assert.doesNotMatch(html, /saintStage|sacred portrait|art\/saints/u, "the shell must retire decorative religious imagery");

assert.match(html, /id="newSchedule"/u);
assert.match(html, /id="scheduleList"/u);
assert.match(html, /id="scheduleForm"/u);
assert.doesNotMatch(html, /value="grayscale"/u, "retired grayscale creation must not remain");
assert.match(html, /id="scheduleProfileId" name="profileId"/u, "protection schedules must choose an explicit ruleset");
assert.match(html, /id="scheduleDays"[\s\S]*?value="0"[\s\S]*?value="6"/u, "the schedule editor must expose every weekday");
assert.match(html, /name="deviceTargets"[^>]*value="computer"[\s\S]*?name="deviceTargets"[^>]*value="phone"/u, "schedule targets must be directly configurable");
assert.match(html, /name="commitmentLock"/u, "commitment locking must remain explicit");
assert.match(html, /name="wifiNetworks"/u, "Wi-Fi-qualified schedules must no longer be a hidden setting");
assert.match(appSource, /Start and end times must be different/u, "equal schedule boundaries must be rejected instead of silently creating a schedule that never runs");
assert.match(appSource, /selectedScheduleDays\(\)/u);
assert.match(appSource, /selectedScheduleDevices\(\)/u);
assert.match(appSource, /wifiNetworks: lines/u);
assert.match(appSource, /lockLevel: scheduleField[\s\S]*dataset\.lockLevel \|\| "deep"/u, "editing schedules must preserve their saved lock level");
assert.match(appSource, /const baseline = "brick-mode"/u, "new schedules must default to a real social pause");

const configTargets = [...html.matchAll(/data-config-target="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(configTargets, ["rules", "limits", "protection", "access", "devices", "appearance", "maintenance"], "Configuration must break important settings into focused destinations");
for (const target of configTargets) {
  assert.match(html, new RegExp(`data-config-panel="${target}"`), `${target} configuration card needs a detail panel`);
}
assert.match(html, /id="configurationSearch"[^>]*placeholder="Find a setting"/u);
assert.match(appSource, /openConfigurationPanel\("maintenance"\)/u, "protected edit failures and update details must route to maintenance");
assert.match(appSource, /resumeScheduleAfterMaintenance/u, "a schedule edit interrupted by protected maintenance must be resumable");

assert.match(html, /Always-on safeguards/u);
assert.doesNotMatch(html, /data-setting=|id="enforcementTimingForm"|id="limitForm"|id="appLockForm"|id="profileForm"/u, "retired or weakening controls must not survive hidden");
assert.match(html, /id="requestMaintenance"[\s\S]*?id="confirmMaintenance"/u, "authenticated maintenance must remain reachable");
assert.doesNotMatch(html, />\s*(?:Quit|Force Quit|Stop Vigil|Disable watchdog)\s*</iu, "the redesign must not expose an availability bypass");

assert.match(html, /name="appIconTheme" value="blue"/u);
assert.match(html, /name="appIconTheme" value="graphite"/u);
assert.match(html, /name="appIconTheme" value="mist"/u);
assert.match(html, /id="appUpdatePanel"[^>]*aria-busy="false"/u);
assert.match(html, /id="appUpdateStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
assert.match(html, /id="appUpdateProgress"[^>]*max="1"[^>]*hidden/u);
assert.match(updateSource, /deriveAppUpdateViewState/u, "the protected updater state machine must remain in use");

assert.match(appSource, /get\("\/api\/state"\)|get<DashboardData>\("\/api\/state"\)/u, "the renderer must read the authoritative dashboard state");
assert.match(appSource, /post\("\/api\/schedule"/u);
assert.doesNotMatch(appSource, /post\("\/api\/grayscale\/schedule"/u);
assert.match(appSource, /post\("\/api\/settings"/u);
assert.match(appSource, /post\("\/api\/devices\/ios\/settings"/u);
assert.match(appSource, /\/api\/protection\/maintenance\/request/u);
assert.match(appSource, /startDashboardRefresh/u, "dashboard polling must use the visibility-aware presentation scheduler");

assert.match(styles, /--sidebar-width:\s*172px/u);
assert.match(styles, /:root\[data-theme="dark"\]/u, "the shell must honor dark appearance");
assert.match(styles, /--bg:\s*#f5f6f8/u, "light appearance must use the neutral palette");
assert.match(styles, /#view-home \.home-stage\s*\{[^}]*display: flex/u);
assert.match(styles, /\.configuration-index\s*\{[^}]*grid-template-columns:\s*repeat\(2/u);
assert.match(styles, /@media \(max-width: 820px\)/u);
assert.match(styles, /@media \(max-height: 650px\)/u);
assert.doesNotMatch(styles, /Iowan|Baskerville|Georgia|saint|#b77952/u);

const home = html.match(/<section id="view-home"[\s\S]*?<\/footer>/u)?.[0] || "";
assert.doesNotMatch(home, /Pause|Level 1|Full Brick|emergencyPanel/u, "Home must stay sparse with no Pause or guarded exit controls");
assert.match(home, />Focus<\/button>[\s\S]*?>Brick<\/button>/u);
assert.match(html, /data-config-panel="access"[\s\S]*?id="emergencyPanel"/u, "Settings must retain the guarded emergency flow");
