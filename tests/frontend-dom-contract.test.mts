import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("public/index.html", "utf8");

assert.match(html, /<h2>Ranking<\/h2>/u);
assert.match(html, />Screen time</u);
assert.match(html, />Focus score</u);
assert.match(html, />From last week</u);
assert.match(html, /Daily focus score and combined Mac and iPhone screen time for this week/u);
assert.doesNotMatch(html, />This week|>Your path|>Combined today|>Daily focus|>Combined screen time|>Seven-day wave|>The week's ascent/u, "ranking should not repeat explanatory labels around the same data");
assert.doesNotMatch(html, /rankJourney|usageWave|journeyKnight/u, "ranking should use one combined weekly comparison instead of two competing charts");
assert.doesNotMatch(html, />Devices included</u, "ranking should show only the three decision-useful headline statistics");
assert.match(html, /id="totalUsageDevices">Mac</u, "screen time should name only devices that actually contributed usage");
assert.doesNotMatch(html, />iPhone today</u);
assert.doesNotMatch(html, /knightState|clean days?/u, "ranking should not spend header space repeating the clean-day count");
const ids = [...html.matchAll(/\bid="([A-Za-z][\w:-]*)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
assert.deepEqual([...new Set(duplicateIds)], [], "dashboard HTML must not contain duplicate IDs");

const idSet = new Set(ids);
for (const match of html.matchAll(/\bfor="([A-Za-z][\w:-]*)"/g)) {
  assert.ok(idSet.has(match[1]), `label references missing control #${match[1]}`);
}

const scripts = (await readdir("public"))
  .filter((name) => name.endsWith(".js"))
  .sort();
const missing = new Set<string>();
for (const name of scripts) {
  const source = await readFile(join("public", name), "utf8");
  for (const match of source.matchAll(/(?:\$\$?|querySelector(?:All)?)\(\s*["'`](#[A-Za-z][\w:-]*)/g)) {
    const id = match[1].slice(1);
    if (!idSet.has(id)) missing.add(`${name}:${match[1]}`);
  }
}
assert.deepEqual([...missing], [], "frontend code must not query dashboard IDs that do not exist");
assert.doesNotMatch(html, /tracking-legacy-surface|legacy-home-actions/, "retired hidden UI must not return");

const navButtons = [...html.matchAll(/<button class="nav-tab[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]);
assert.equal(navButtons.length, 5, "primary navigation must keep all five destinations");
for (const button of navButtons) {
  assert.match(button, /<svg class="nav-icon"[^>]*aria-hidden="true"/, "each primary destination must use the shared SVG icon system");
  assert.match(button, /<span class="nav-label">[^<]+<\/span>/, "each primary destination must retain a visible label");
}
assert.match(html, /<svg class="settings-icon"[^>]*aria-hidden="true"/, "settings must use the shared rounded SVG treatment");
assert.match(html, /name="appIconTheme" value="jerusalem-cross"/, "settings must offer the Jerusalem Cross icon");
assert.match(html, /name="appIconTheme" value="sacred-heart"/, "settings must offer the Sacred Heart icon");
assert.match(html, /name="appIconTheme" value="saint-michael"/, "settings must offer the Saint Michael icon");
const settingsMarkup = html.match(/<section id="view-rules"[\s\S]*?<section id="view-devices"/)?.[0] || "";
const firstSettingsDisclosure = settingsMarkup.match(/<details class="settings-disclosure[^>]*>[\s\S]*?<\/summary>/)?.[0] || "";
assert.match(firstSettingsDisclosure, />App icon</, "app icon must be the first settings disclosure");
assert.doesNotMatch(firstSettingsDisclosure, /<details[^>]*\sopen(?:\s|>)/, "app icon must start collapsed like the other settings disclosures");
assert.match(settingsMarkup, /id="settingsSearch"[^>]*type="search"[^>]*placeholder="Find a setting"/, "settings must expose one compact search control");
const settingsUiSource = await readFile("public/settings-ui.js", "utf8");
const settingsAppSource = await readFile("public/app.js", "utf8");
const setupWizardSource = await readFile("public/setup-wizard.js", "utf8");
const hardeningPanelSource = await readFile("public/hardening-panel.js", "utf8");
const extensionOptionsSource = await readFile("extension/options.js", "utf8");
assert.match(settingsUiSource, /wrapSettingsPanels\(\)/, "settings must turn large panels into focused subsections");
assert.match(settingsUiSource, /form\.getAttribute\("id"\)/, "editor routing must use the form attribute instead of a shadowing named control");
assert.match(settingsUiSource, /if \(sibling !== disclosure\)\s+sibling\.open = false/, "opening a settings category must close competing categories");
assert.match(settingsUiSource, /data-editor-for|dataset\.editorFor/, "New and Edit actions must target a single settings editor");
assert.doesNotMatch(settingsUiSource, /addEventListener\("submit"/, "settings editors must not close before an asynchronous save succeeds");
assert.match(settingsUiSource, /resetSettingsUi[\s\S]*querySelectorAll\("details"\)[\s\S]*disclosure\.open = false/, "leaving settings must collapse every expanded setting");
assert.match(settingsUiSource, /resetSettingsUi[\s\S]*search\.value = ""/, "leaving settings must clear the settings search");
assert.match(settingsAppSource, /previousView === "settings" && state\.activeView !== "settings"[\s\S]*resetSettingsUi\(\)/, "the settings reset must run only after navigating away");
assert.match(
  setupWizardSource,
  /launchAgentReady = Boolean\(launchAgent\.loaded && launchAgent\.running && \(!launchAgent\.embedded \|\| launchAgent\.restartHardened === true\)\)/u,
  "embedded runtime setup must not be ready without verified restart hardening"
);
assert.match(
  setupWizardSource,
  /detail: launchAgent\.embedded && launchAgent\.restartHardened !== true[\s\S]*?Repair automatic restart protection without leaving Vigil\.[\s\S]*?action: launchAgent\.embedded \? "Repair Restart Protection"[\s\S]*?actionTarget: launchAgentReady \? undefined : "installLaunchAgent"/u,
  "embedded runtime setup must route its recovery guidance to the working restart-protection control"
);
assert.match(
  setupWizardSource,
  /action\.addEventListener\("click", \(\) => document\.querySelector\(`#\$\{item\.actionTarget\}`\)\?\.click\(\)\)/u,
  "setup checklist recovery actions must invoke their matching hardening control"
);
assert.match(
  hardeningPanelSource,
  /restartProtectionNeedsRepair = agent\.embedded === true && agent\.restartHardened !== true[\s\S]*?Repair Restart Protection[\s\S]*?disabled = agent\.embedded === true && !restartProtectionNeedsRepair/u,
  "embedded mode must enable a clearly labeled repair control exactly while restart protection is unhealthy"
);
assert.match(
  hardeningPanelSource,
  /repairingRestartProtection[\s\S]*?\/api\/hardening\/launch-agent\/install[\s\S]*?Restart protection repaired/u,
  "the embedded repair control must execute the hardening request and report successful recovery"
);
assert.match(extensionOptionsSource, /vigilUrl\("\/api\/health", localServer\)/u, "extension connection tests must use the companion-safe health route");
assert.doesNotMatch(extensionOptionsSource, /vigilUrl\("\/api\/state", localServer\)/u, "extension connection tests must not probe the private app state route");
const dayControlsSource = await readFile("public/day-controls.js", "utf8");
for (const preset of ["Every day", "Weekdays", "Weekends", "Custom days"]) {
  assert.match(dayControlsSource, new RegExp(preset), `day controls must offer the ${preset} preset`);
}
assert.match(dayControlsSource, /custom\.hidden = select\.value !== "custom"/, "the seven-day grid must stay hidden until Custom days is selected");
assert.match(html, /id="accountButton"[^>]*aria-expanded="false"/, "the account button must expose its toggle state");
const sidebarMarkup = html.match(/<aside class="app-chrome"[\s\S]*?<\/aside>/)?.[0] || "";
assert.doesNotMatch(sidebarMarkup, /&#(?:8962|10016|10003|9835|10070|9881);/, "font-glyph sidebar icons must not return");
assert.match(html, /id="sidebarToggle"[^>]*aria-controls="primarySidebar"[^>]*aria-expanded="true"/, "the sidebar must expose an explicit full-hide toggle");
assert.ok(html.indexOf('id="sidebarToggle"') < html.indexOf('<aside class="app-chrome"'), "the sidebar toggle must live outside the sidebar it hides");
assert.doesNotMatch(html, /maximizedWindowControls|data-window-action/, "web content must never imitate macOS traffic lights");
assert.match(sidebarMarkup, /id="primarySidebar"/, "the sidebar toggle must control the navigation sidebar");
assert.match(sidebarMarkup, /id="brandHomeButton"[^>]*data-view-target="home"[^>]*aria-label="Go to Home"/, "the Vigil wordmark must provide a keyboard-accessible route back Home");

const styles = await readFile("public/styles.css", "utf8");
assert.match(styles, /\.settings-disclosure \+ \.settings-disclosure\s*\{[\s\S]*?margin-top:\s*16px;/, "adjacent settings disclosures must use the shared row spacing");
assert.match(styles, /\.settings-disclosure\s*\{[\s\S]*?container-type:\s*inline-size;/, "settings disclosures must respond to their own available width");
assert.match(styles, /grid-template-columns:\s*minmax\(min-content, max-content\) minmax\(0, 1fr\) auto;/, "settings titles must keep a readable intrinsic column before descriptions flex");
assert.match(styles, /\.settings-subsection-body > \.list[\s\S]*?margin:\s*10px 0 0;/, "saved settings must appear as a compact list before their editor");
assert.match(styles, /\.day-custom-grid\[hidden\]\s*\{\s*display:\s*none;/, "custom weekday buttons must not consume space for preset schedules");
assert.match(styles, /body\.sidebar-collapsed \.app-chrome\s*\{\s*display:\s*none;/, "collapsing must fully hide the sidebar instead of leaving an icon rail");
assert.match(styles, /body\.sidebar-collapsed \.shell\s*\{\s*grid-column:\s*1;/, "collapsed content must occupy the first grid column without widening the viewport");
assert.match(styles, /body\.sidebar-collapsed \.sidebar-toggle\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/, "the full-hide toggle must remain visible and clickable after the sidebar disappears");
assert.doesNotMatch(styles, /maximized-window-controls/, "styles must not contain fake window controls");
assert.doesNotMatch(styles, /body:not\(\[data-active-view="home"\]\) \.app-chrome/, "navigation must not automatically compact the sidebar away from Home");
assert.match(styles, /\.brand-home\s*\{[^}]*background:\s*transparent;[^}]*font:\s*inherit;/, "the Home button must preserve the Vigil wordmark styling");
const uiShellSource = await readFile("public/ui-shell.js", "utf8");
assert.match(uiShellSource, /localStorage\.setItem\("vigil-sidebar-collapsed"/, "the explicit sidebar choice must persist");
assert.doesNotMatch(styles, /@media \(max-width: 900px\)\s*\{\s*body\s*\{\s*display:\s*block/, "narrow windows must retain the sidebar grid");

const trackingMarkup = html.match(/<section id="view-journal"[\s\S]*?<div class="journal-page journal-only"/)?.[0] || "";
assert.match(trackingMarkup, /id="dailyCheckInMeterBar"/, "daily tracking must expose a visible completion meter");
assert.match(trackingMarkup, /id="habitMonthPulse"/, "monthly tracking must expose the compact rhythm visualization");
assert.match(trackingMarkup, /id="habitMonthDayCount"/, "monthly tracking must expose a dynamic day count");
assert.doesNotMatch(trackingMarkup, /habitMonthSummary|habitMonthCompleted|habitMonthRecorded/, "monthly tracking must keep only the completion percentage above its visual graphs");
assert.match(trackingMarkup, /<details id="habitCalendarDetails" class="habit-calendar-details">/, "the dense habit grid must start collapsed behind optional detail");
assert.doesNotMatch(trackingMarkup, /<details id="habitCalendarDetails"[^>]*\sopen(?:\s|>)/, "the dense monthly grid must not dominate the initial tracking view");
const trackingSource = await readFile("public/tracking-view.js", "utf8");
assert.match(trackingSource, /status === "success" \? "unreported" : "success"/, "selecting an active habit result again must clear it without a third row button");
assert.match(trackingSource, /className = "habit-quick-select"/, "daily tracking must use one selectable habit card instead of rendering every card at once");
assert.match(trackingSource, /behaviorAfterCheckIn/, "submitting a daily result must advance the compact card to another habit");
assert.match(trackingSource, /if \(locked\) \{[\s\S]*?completedDayCard/, "a fully recorded day must replace editable habit controls with a completion screen");
assert.match(trackingSource, /dateIsComplete\(dateKey, behaviors, values\)[\s\S]*?button\.disabled = future \|\| saving \|\| locked/, "completed days must lock detailed-grid buttons against accidental changes");
assert.doesNotMatch(trackingSource, /Your answers are locked|All \$\{total\} item/, "the completion screen must not repeat results already shown in the tracking graphs");
assert.match(trackingSource, /editableCompletedDateKey = dateKey/, "editing a completed day must require a deliberate unlock action");
assert.match(trackingSource, /monthDayCount\.textContent = `\$\{dates\.length\} days`/, "the selected month must control the displayed day count");
assert.match(styles, /@media \(max-width: 800px\)[\s\S]*?\.tracking-trend\s*\{[\s\S]*?height:\s*clamp\(88px, 17vh, 108px\);/, "the stacked monthly trend must expand vertically at the default desktop aspect ratio");
assert.match(styles, /@media \(max-width: 800px\)[\s\S]*?body\[data-active-view="tracking"\] \.habit-month-pulse\s*\{[\s\S]*?height:\s*clamp\(98px, 19vh, 122px\);/, "the stacked monthly pulse must use the space freed by redundant summary copy");

const protectionMarkup = html.match(/<div id="protectionLevelControl"[\s\S]*?<div[^>]*class="home-runtime-status"/)?.[0] || "";
assert.match(protectionMarkup, /id="protectionLevelControl"[^>]*aria-expanded="false"/, "the protection selector must start collapsed");
assert.equal(
  [...protectionMarkup.matchAll(/data-protection-level-choice="[1-4]"/g)].length,
  4,
  "the protection selector bloom must expose all four levels"
);
assert.doesNotMatch(protectionMarkup, /Scroll to choose|protection-level-scroll-hint/i, "the protection selector must not show a scroll instruction");
assert.doesNotMatch(styles, /\.protection-level-control:hover:not\(\.is-settling\) \.protection-level-choice/, "hovering must not expand the protection selector");
assert.match(styles, /\.protection-level-control\.is-open:not\(\.is-settling\) \.protection-level-choice/, "the protection selector must expand only in its explicit open state");
assert.match(styles, /\.protection-level-control:not\(\.is-open\) \.protection-level-choice:hover/, "the visible protection number must glow only when the orb itself is hovered");
assert.match(styles, /\.protection-level-choice:hover span\s*\{[\s\S]*?text-shadow:/, "hovering a protection number must brighten the number itself");
const appEventsSource = await readFile("public/app-events.js", "utf8");
assert.match(appEventsSource, /classList\.contains\(["']is-open["']\)/, "clicking the collapsed protection orb must open the selector before changing levels");
assert.doesNotMatch(appEventsSource, /Focus sound saved|Sound on|Sound paused|Playing \$\{/, "routine sound controls must not trigger bottom-corner toast popups");
assert.match(appEventsSource, /const enabled = !focusSound\.isPlaying\(\)/, "Listen must retry silent-but-enabled audio instead of disabling it");
assert.match(appEventsSource, /if \(enabled\)\s*focusSound\.restartTimer\(\)/, "Listen must restart an expired timer before replaying it");
assert.match(
  appEventsSource,
  /\[data-focus-preset\][\s\S]*?focusSound\.restartTimer\(\)[\s\S]*?persistFocusSound\(true\)/,
  "choosing a library track must restart an expired finite timer before playback"
);

const appSource = await readFile("public/app.js", "utf8");
assert.match(appSource, /!hasRuntimeStatus/, "the idle home screen must hide the redundant Ready and dash status row");
const rankingSource = await readFile("public/ranking-view.js", "utf8");
assert.match(rankingSource, /Number\(data\.usage\?\.totalSeconds \|\| 0\) > 0/, "focus labels must require recorded usage instead of treating an empty usage object as activity");
assert.match(rankingSource, /textEl\("strong", duration, \{ className: "ranking-week-duration" \}\),\s*el\("div", \{ className: "ranking-week-bar-stage" \}, bar\)/, "weekly duration labels must stay outside the variable-height bars");
assert.match(styles, /\.ranking-dashboard\s*\{[^}]*container:\s*ranking \/ inline-size;/, "ranking must respond to its usable panel width rather than only the window width");
assert.match(styles, /@container ranking \(max-width: 760px\)\s*\{[\s\S]*?\.ranking-vitals\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/, "ranking vitals must remain in one compact row at the minimum window size");
assert.match(styles, /@container ranking \(max-width: 520px\)\s*\{[\s\S]*?\.ranking-vitals\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/, "the narrowest ranking layout must preserve the three-card strip above the chart");
assert.match(styles, /@media \(max-height: 560px\)\s*\{[\s\S]*?\.ranking-card\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?\.ranking-week\s*\{[\s\S]*?height:\s*200px;/, "the minimum-height window must shrink the weekly chart enough to keep its bottom visible");

const journalGateMarkup = html.match(/<section id="journalUnlockGate"[\s\S]*?<\/section>/)?.[0] || "";
const journalPageMarkup = html.match(/<div class="journal-page journal-only"[\s\S]*?<div class="workspace two-column split-surface">/)?.[0] || "";
assert.doesNotMatch(journalGateMarkup, /\bpanel\b/, "journal access must not regress to the oversized generic panel");
assert.match(journalGateMarkup, /class="journal-gate-copy"/, "journal access must keep a minimal copy block");
assert.match(journalGateMarkup, />Unlock it</, "journal access must use the requested minimal unlock instruction");
assert.match(journalGateMarkup, /id="journalTouchIdUnlock"[\s\S]*?<svg/, "journal access must expose a clickable fingerprint control");
assert.doesNotMatch(journalGateMarkup, /type="password"|data-journal-unlock-method="password"/, "journal access must not expose a password fallback");
assert.doesNotMatch(html, /<span class="pill neutral">Local<\/span>/, "the journal header must not show a redundant Local badge");
assert.doesNotMatch(html, /<p class="eyebrow">Reflection<\/p>[\s\S]*?<h2>Journal<\/h2>/, "the journal must not repeat Reflection and Journal above the writing area");
assert.doesNotMatch(journalPageMarkup, /Write it down|New Entry|Stored locally with access controls|Entries are not encrypted|Local Archive|Past entries/, "the journal must not include redundant headings or storage commentary");
assert.match(journalPageMarkup, /name="title"[\s\S]*?name="body"[\s\S]*?>Save<\//, "the journal composer must contain Title, Entry, and Save in that order");
assert.match(journalPageMarkup, /id="journalArchiveTitle">Archives<\//, "saved journal entries must appear under Archives");
assert.match(styles, /\.journal-unlock-gate\s*\{[\s\S]*?width:\s*min\(620px, 100%\)/, "journal access must remain compact within the writing surface");
assert.doesNotMatch(styles, /\.journal-unlock-gate\s*\{[^}]*border-block:/, "the journal unlock prompt must not be boxed in by divider lines");
assert.match(styles, /body\[data-active-view="journal"\]:has\(#journalUnlockGate:not\(\[hidden\]\)\) \.shell\s*\{[^}]*padding-block:\s*0;/, "the locked journal must use the full height of its right-hand panel");
assert.match(styles, /body\[data-active-view="journal"\]:has\(#journalUnlockGate:not\(\[hidden\]\)\) #view-journal\s*\{[^}]*min-height:\s*100vh;[^}]*place-items:\s*center;/, "the journal unlock prompt must stay centered within the right-hand panel");
assert.match(styles, /body\[data-active-view="journal"\]:has\(#journalUnlockGate:not\(\[hidden\]\)\) #view-journal > :not\(#journalUnlockGate\)\s*\{[^}]*display:\s*none !important;/, "hidden tracking wrappers must not pull the journal unlock prompt above center");
assert.match(styles, /\.journal-unlock-gate\s*\{[^}]*--journal-unlock-size:\s*clamp\(84px,[^;]*116px\);/, "the fingerprint control must grow with wider journal layouts");
assert.match(styles, /\.journal-touch-id\s*\{[^}]*width:\s*var\(--journal-unlock-size\);[^}]*height:\s*var\(--journal-unlock-size\);/, "the fingerprint control must use its responsive size for both dimensions");
assert.match(styles, /\.journal-gate-copy > h2\s*\{[^}]*font-size:\s*clamp\(1\.85rem,[^;]*2\.45rem\);/, "the minimal unlock instruction must scale with the fingerprint control");

const emergencyMarkup = html.match(/<details id="emergencyPanel"[\s\S]*?<\/details>/)?.[0] || "";
assert.match(emergencyMarkup, /<summary class="emergency-summary">/, "emergency UI must be a collapsible top drawer");
assert.match(emergencyMarkup, /id="emergencyExplanation"/, "integrity lockdowns must expose protected-maintenance guidance");
assert.doesNotMatch(emergencyMarkup, /emergency-indicator/, "the floating integrity notice must not include a misaligned status dot");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?position:\s*absolute;/, "the emergency drawer must overlay the home view instead of stretching it");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?top:\s*12px;[\s\S]*?width:\s*min\(420px,[\s\S]*?border-radius:\s*13px;/, "the integrity notice must float independently near the top of the home view");
assert.match(styles, /\.electron-shell \.app-chrome::before\s*\{[\s\S]*?height:\s*38px;[\s\S]*?-webkit-app-region:\s*drag;/, "Electron window dragging must use a dedicated top strip that cannot cover the sidebar toggle");
assert.match(styles, /\.electron-shell \.app-chrome\s*\{\s*-webkit-app-region:\s*no-drag;/, "the full sidebar must never swallow real clicks as a native drag region");
assert.match(styles, /\.window-resize-s\s*\{[\s\S]*?height:\s*14px;[\s\S]*?cursor:\s*ns-resize;/, "the bottom window edge must provide a forgiving resize target");
assert.match(styles, /\.window-resize-se,[\s\S]*?\.window-resize-sw\s*\{[\s\S]*?width:\s*32px;[\s\S]*?height:\s*32px;/, "both bottom corners must provide large resize targets");
assert.match(styles, /\.sidebar-toggle\s*\{[\s\S]*?top:\s*50px;[\s\S]*?-webkit-app-region:\s*no-drag;/, "the sidebar toggle must always sit below the native title bar and remain clickable");

assert.match(html, /id="saintStageButton"[^>]*aria-controls="saintInfoPopover"[^>]*aria-expanded="false"/, "saint artwork must expose its details popover");
assert.doesNotMatch(html, /id="saintStageButton"[^>]*title=/, "saint artwork must not show an instructional hover tooltip");
assert.match(html, /id="saintArtwork"[^>]*draggable="false"/, "saint artwork must not expose the source image through native dragging");
assert.match(html, /id="saintInfoPopover"[^>]*role="dialog"[^>]*aria-labelledby="saintInfoName"[^>]*hidden/, "saint details must start closed and have an accessible name");
for (const id of ["saintInfoName", "saintInfoEpithet", "saintInfoQuote", "saintInfoSource", "saintInfoClose", "saintInfoPrevious", "saintInfoNext"]) {
  assert.ok(idSet.has(id), `saint details are missing #${id}`);
}
assert.match(html, /class="saint-info-navigation" aria-label="Browse patron saints"/, "saint details must expose in-card previous and next navigation");
assert.match(html, /class="saint-info-actions">[\s\S]*?class="saint-info-navigation"[\s\S]*?id="saintInfoClose"/, "saint navigation and close must share a dedicated visible action area");
assert.ok(html.indexOf('id="saintInfoPopover"') < html.indexOf('id="saintStage"'), "saint details must sit above rather than inside the artwork stage");
assert.match(styles, /body\[data-active-view="home"\]\s*\{[^}]*height:\s*100vh;[^}]*overflow:\s*hidden;/, "Home must remain a fixed app viewport without page-level scrollbars");
assert.doesNotMatch(styles, /home-stage:has\(> \.saint-info-popover:not\(\[hidden\]\)\)/, "opening saint details must not reflow the Home composition");
assert.match(styles, /#view-home \.saint-info-popover\s*\{[\s\S]*?position:\s*absolute;[\s\S]*?top:\s*clamp\(12px, 2\.4vh, 24px\);[\s\S]*?left:\s*50%;[\s\S]*?width:\s*min\(720px,[\s\S]*?max-height:\s*min\(190px,[\s\S]*?overflow:\s*hidden;[\s\S]*?transform:\s*translateX\(-50%\);/, "saint details must float in a wide bounded card above the artwork without moving it");
assert.match(styles, /#view-home \.saint-info-popover\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 0\.8fr\) minmax\(0, 1\.35fr\);[\s\S]*?"eyebrow actions"[\s\S]*?"name quote";/, "saint details must shrink to the available Home width without clipping its actions");
assert.match(styles, /#view-home \.saint-info-close\s*\{[\s\S]*?position:\s*static;[\s\S]*?border:\s*1px solid[^;]*;/, "the saint close control must have a dedicated visible button instead of overlaying text");
assert.match(styles, /#view-home \.saint-info-popover blockquote\s*\{[\s\S]*?max-height:\s*92px;[\s\S]*?overflow-y:\s*auto;[\s\S]*?scrollbar-width:\s*thin;/, "long saint details must use a subtle scrollbar inside the bounded card");
assert.doesNotMatch(styles, /saint-stage:has\(\.saint-info-popover:not\(\[hidden\]\)\)/, "opening saint details must not resize the saint stage");
const saintStageSource = await readFile("public/saint-stage.js", "utf8");
assert.doesNotMatch(saintStageSource, /addEventListener\(["']dblclick["']/, "double-click must not open saint details");
assert.match(saintStageSource, /addEventListener\(["']contextmenu["']/, "two-finger and right-click must open saint details");
assert.doesNotMatch(saintStageSource, /event\.detail|clickTimer|setTimeout/, "every rapid left click must advance the saint immediately");
assert.match(saintStageSource, /select\(previousSaintId\(selectedId\), true, true\)/, "the open saint card must browse backward without closing");
assert.match(saintStageSource, /select\(nextSaintId\(selectedId\), true, true\)/, "the open saint card must browse forward without closing");
assert.match(html, /class="saint-ambient"[\s\S]*?class="saint-geometry"[\s\S]*?class="saint-particles"/, "the patron stage must expose layered ambient geometry");
assert.doesNotMatch(html, /saint-cursor-aura/, "the Home screen must not render a glow that follows the cursor");
assert.doesNotMatch(styles, /saint-cursor-aura|--saint-pointer-(?:x|y|distance)/, "cursor-following glow styles must stay removed");
assert.match(styles, /#view-home \.home-stage::before\s*\{\s*display:\s*none;/, "the Home background must not retain a stationary oval tint around the cursor glow");
assert.doesNotMatch(styles, /\.electron-shell \.saint-cursor-aura\s*\{\s*display:\s*none;/, "Electron must keep the cursor glow inside Vigil's real window");
assert.doesNotMatch(saintStageSource, /vigilCursorAura|screenX|screenY/, "the Home stage must not drive a second native aura window");
assert.doesNotMatch(styles, /is-pointer-active \.saint-(?:geometry|orbit|particles|symbol)/, "the ambient geometry must keep its calm resting brightness and motion under the cursor");
assert.match(
  styles,
  /@media \(hover: none\), \(pointer: coarse\), \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.home-stage\.is-pointer-active \.saint-artifact,[\s\S]*?\.saint-artifact:hover:not\(:disabled\)[\s\S]*?transform: none;/,
  "reduced-motion and coarse-pointer users must not receive the saint artwork hover scale"
);
assert.match(styles, /#view-home \.saint-artifact:hover:not\(:disabled\),[\s\S]*?#view-home \.saint-artifact:focus-visible\s*\{[\s\S]*?transform:\s*scale\(1\.012\);/, "hovering the saint composition must enlarge it slightly without cursor-driven translation or rotation");
assert.match(styles, /#view-home \.saint-artifact,[\s\S]*?#view-home \.saint-stage\[data-saint\] \.saint-artifact\s*\{[\s\S]*?width:\s*min\(720px, 100%\);/, "the patron composition must size from the usable stage instead of the full viewport");
assert.match(styles, /\.saint-artifact:focus-visible\s*\{\s*outline:\s*none;/, "the saint button must not draw a rectangular focus artifact");
assert.match(styles, /\.audio-desk\s*\{[\s\S]*?container:\s*audio-desk \/ inline-size;/, "the audio player must respond to its usable panel width");

const audioMarkup = html.match(/<section id="view-audio"[\s\S]*?<div class="audio-control-bridge"/)?.[0] || "";
assert.doesNotMatch(audioMarkup, /audio-settings-disclosure|audio-volume-line/, "playback should not expose redundant session or volume controls");
assert.equal(
  [...audioMarkup.matchAll(/<details class="audio-library-group/g)].length,
  4,
  "each sound category should be a compact disclosure"
);
assert.doesNotMatch(audioMarkup, /<details class="audio-library-group[^>]*\sopen(?:\s|>)/, "the sound library should start collapsed");
assert.match(audioMarkup, /id="focusSoundPlayButton"/, "play and pause must remain outside the collapsed settings");
assert.doesNotMatch(audioMarkup, /focusSoundStatus|focusSoundCategory|focusSoundDescription/, "the player should omit redundant status and description copy");
const audioPlayerMarkup = audioMarkup.match(/<section id="audioPlayer"[\s\S]*?<\/section>/)?.[0] || "";
assert.doesNotMatch(audioPlayerMarkup, /focusSoundAttribution/, "the large player card must end at the Listen control");
assert.match(audioMarkup, /id="audioSoundLibrary"[\s\S]*?id="focusSoundAttribution"[^>]*hidden/, "recording details must live with the expandable sound library");
assert.match(audioMarkup, /id="focusSoundWave" class="audio-wave"/, "the player should keep the compact live waveform");
const focusSoundSource = await readFile("public/focus-sound.js", "utf8");
assert.match(focusSoundSource, /createAnalyser\(\)/, "the waveform must measure the playback signal instead of inventing motion");
assert.match(focusSoundSource, /getFloatTimeDomainData/, "quiet passages must reduce the waveform using the signal's real loudness");
assert.match(focusSoundSource, /getByteFrequencyData/, "each waveform bar must reflect the signal's real frequency shape");
assert.doesNotMatch(styles, /@keyframes listeningWave|animation:\s*listeningWave/, "the waveform must not regress to a decorative loop");
assert.match(styles, /@container audio-desk \(max-width: 760px\)\s*\{[\s\S]*?grid-template-areas:[\s\S]*?"title wave"[\s\S]*?"control control";/, "the compact waveform must stay at the top right above the full-width playback control");
