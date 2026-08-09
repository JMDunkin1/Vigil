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
assert.match(html, /class="brand-mark"[\s\S]*?src="\/app-icons\/jerusalem-cross\.png"/u, "the sidebar brand must use the Jerusalem Cross app icon");
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
  { target: "configuration", label: "Configuration" }
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
assert.match(html, /id="emergencyPanel"[\s\S]*?id="requestEmergency"[\s\S]*?id="confirmEmergency"/u, "Home must keep the protected emergency flow reachable");
assert.match(html, /src="\/art\/saints\/traditional\/michael\.png"/u, "Home must retain Saint Michael as its initial visual anchor");
assert.match(html, /id="saintInfoPopover"[\s\S]*?Browse sacred portraits[\s\S]*?id="saintStageButton"/u, "Home must retain the established sacred portrait interaction");

assert.match(html, /id="newSchedule"/u);
assert.match(html, /id="scheduleList"/u);
assert.match(html, /id="scheduleForm"/u);
assert.match(html, /id="scheduleKind"[\s\S]*?value="lock"[\s\S]*?value="grayscale"/u, "Schedules must manage protection and grayscale routines together");
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
assert.match(appSource, /baselineProfileId\(ui\.data\?\.state\)/u, "new schedules must default from the baseline profile, not the active runtime profile");

const configTargets = [...html.matchAll(/data-config-target="([^"]+)"/g)].map((match) => match[1]);
assert.deepEqual(configTargets, ["rules", "limits", "protection", "access", "devices", "appearance", "maintenance"], "Configuration must break important settings into focused destinations");
for (const target of configTargets) {
  assert.match(html, new RegExp(`data-config-panel="${target}"`), `${target} configuration card needs a detail panel`);
}
assert.match(html, /id="configurationSearch"[^>]*placeholder="Find a setting"/u);
assert.match(appSource, /openConfigurationPanel\("maintenance"\)/u, "protected edit failures and update details must route to maintenance");
assert.match(appSource, /resumeScheduleAfterMaintenance/u, "a schedule edit interrupted by protected maintenance must be resumable");

for (const permanentControl of ["safariUrlFilterEnabled", "contentFilterEnabled", "strictBypassProtectionEnabled"]) {
  assert.match(html, new RegExp(`id="${permanentControl}"[^>]*checked disabled`), `${permanentControl} must remain visibly forced on`);
}
assert.match(html, /id="protectedEditsEnabled"[^>]*data-setting="protectedEditsEnabled"/u);
assert.match(html, /id="requestMaintenance"[\s\S]*?id="confirmMaintenance"/u, "authenticated maintenance must remain reachable");
assert.doesNotMatch(html, />\s*(?:Quit|Force Quit|Stop Vigil|Disable watchdog)\s*</iu, "the redesign must not expose an availability bypass");

assert.match(html, /name="appIconTheme" value="jerusalem-cross"/u);
assert.match(html, /name="appIconTheme" value="sacred-heart"/u);
assert.match(html, /name="appIconTheme" value="saint-michael"/u);
assert.match(html, /id="appUpdatePanel"[^>]*aria-busy="false"/u);
assert.match(html, /id="appUpdateStatus"[^>]*role="status"[^>]*aria-live="polite"/u);
assert.match(html, /id="appUpdateProgress"[^>]*max="1"[^>]*hidden/u);
assert.match(updateSource, /deriveAppUpdateViewState/u, "the protected updater state machine must remain in use");

assert.match(appSource, /get\("\/api\/state"\)|get<DashboardData>\("\/api\/state"\)/u, "the renderer must read the authoritative dashboard state");
assert.match(appSource, /post\("\/api\/schedule"/u);
assert.match(appSource, /post\("\/api\/grayscale\/schedule"/u);
assert.match(appSource, /post\("\/api\/settings"/u);
assert.match(appSource, /post\("\/api\/devices\/ios\/settings"/u);
assert.match(appSource, /\/api\/protection\/maintenance\/request/u);
assert.match(appSource, /INACTIVE_STATE_POLL_MS\s*=\s*30_000/u, "an inactive window must poll less frequently");

assert.match(styles, /--sidebar-width:\s*218px/u, "the redesign must replace the oversized legacy sidebar");
assert.match(styles, /--bg:\s*#101111[\s\S]*?--bg-deep:\s*#0c0d0d[\s\S]*?--surface:\s*#1c1d1c[\s\S]*?--surface-raised:\s*#222321[\s\S]*?--surface-soft:\s*#242520/u, "the whole shell must use the neutral Ember surface palette");
assert.match(styles, /--sidebar:\s*#121313/u, "the sidebar must retain the established neutral Ember background");
assert.match(styles, /\.sidebar\s*\{[\s\S]*?radial-gradient\(circle at 24% 8%, rgba\(169, 111, 76, 0\.05\)/u, "the sidebar must retain the established warm Ember color treatment");
assert.doesNotMatch(styles, /#111514|#0b0f0e|#171c1a|#1b211f|#202724|#1c211e|#141917|#111614|#101412|#0f1312|#222825/u, "green-tinted neutral backgrounds must not return");
assert.match(styles, /\.home-layout\s*\{[\s\S]*?grid-template-columns:/u, "Home must use a purposeful dashboard composition");
assert.match(styles, /\.configuration-index\s*\{[^}]*grid-template-columns:\s*repeat\(2/u, "Configuration should scan as a compact card grid at wide sizes");
assert.match(styles, /@media \(max-width: 820px\)/u, "the redesign must handle the minimum Electron window width");
assert.match(styles, /@media \(max-height: 650px\)/u, "the redesign must handle the minimum Electron window height");
assert.doesNotMatch(styles, /\.audio-|\.habit-|\.journal-|\.activity-/u, "the new stylesheet must not carry legacy feature styling");
