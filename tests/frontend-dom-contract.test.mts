import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("public/index.html", "utf8");

assert.doesNotMatch(html, /data-view-target="ranking"|data-view="ranking"|<h2>Ranking<\/h2>/u, "retired ranking navigation and markup must not return");
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
assert.equal(navButtons.length, 4, "primary navigation must keep the four remaining destinations");
for (const button of navButtons) {
  assert.match(button, /<svg class="nav-icon"[^>]*aria-hidden="true"/, "each primary destination must use the shared SVG icon system");
  assert.match(button, /<span class="nav-label">[^<]+<\/span>/, "each primary destination must retain a visible label");
}
const audioNavButton = navButtons.find((button) => button.includes('data-view-target="audio"')) || "";
assert.match(audioNavButton, /<path d="M3\.5 10v4M7\.75 7\.5v9M12 4\.5v15M16\.25 8\.5v7M20\.5 10\.5v3"\/>/, "Audio navigation must use the rounded waveform icon");
assert.doesNotMatch(audioNavButton, /14\.75v-2\.5|A1\.25 1\.25/, "the retired headphone icon must not return");
assert.match(html, /<svg class="settings-icon"[^>]*aria-hidden="true"/, "settings must use the shared rounded SVG treatment");
assert.match(html, /name="appIconTheme" value="jerusalem-cross"/, "settings must offer the Jerusalem Cross icon");
assert.match(html, /name="appIconTheme" value="sacred-heart"/, "settings must offer the Sacred Heart icon");
assert.match(html, /name="appIconTheme" value="saint-michael"/, "settings must offer the Saint Michael icon");
assert.doesNotMatch(html, /saintAesthetic|Pixel Art|Portrait decorations|saintDecorations/, "Settings must not retain portrait style or decoration controls");
assert.match(html, /id="saintArtwork"[^>]*src="\/art\/saints\/traditional\/michael\.png"/, "the home stage must load traditional artwork directly");
assert.doesNotMatch(html, /saint-(?:halo|symbol|ambient|geometry|orbit|particles)/, "the home stage must not render portrait decorations");
assert.match(html, /aria-label="Browse sacred portraits"/, "portrait navigation must not describe Christ as a patron saint");
const rulesViewStart = html.indexOf('<section id="view-rules"');
const journalViewStart = html.indexOf('<section id="view-journal"');
const protectionViewStart = html.indexOf('<section id="view-settings"');
const devicesViewStart = html.indexOf('<section id="view-devices"');
assert.ok(rulesViewStart >= 0 && journalViewStart > rulesViewStart, "the Rules settings source must precede the Journal view");
assert.ok(protectionViewStart > journalViewStart && devicesViewStart > protectionViewStart, "the remaining settings sources must retain stable boundaries");
const rulesSettingsMarkup = html.slice(rulesViewStart, journalViewStart);
const protectionSettingsMarkup = html.slice(protectionViewStart, devicesViewStart);
assert.match(rulesSettingsMarkup, /id="settingsSearch"[^>]*type="search"[^>]*placeholder="Find a setting"/, "settings must expose one compact search control");
assert.match(rulesSettingsMarkup, /id="managedBlocklistSummary"/, "the Block list detail must report Vigil's effective managed policy");
assert.match(
  rulesSettingsMarkup,
  /<form id="profileForm"[^>]*\shidden\b[^>]*aria-hidden="true"/,
  "raw profile apps, sites, and URL patterns must remain an internal hidden control"
);
assert.match(rulesSettingsMarkup, /<select id="scheduleProfileId" name="profileId"/, "every schedule must explicitly select the ruleset it enforces");
assert.match(rulesSettingsMarkup, /<section class="journal-security-panel panel"[^>]*>[\s\S]*?id="journalSecurityForm"/, "Journal security must live directly in Rules instead of a separate Settings category");
assert.match(
  protectionSettingsMarkup,
  /<div class="settings-internal-fields" hidden aria-hidden="true">[\s\S]*?id="adultBlocklistPreloadLimit"[\s\S]*?id="adultBlocklistAllowlist"/,
  "raw managed unsafe-content source and exception controls must stay hidden"
);
const settingsUiSource = await readFile("public/settings-ui.js", "utf8");
const settingsAppSource = await readFile("public/app.js", "utf8");
const saintPortraitStageSource = await readFile("public/saint-stage.js", "utf8");
const stylesSource = await readFile("public/styles.css", "utf8");
const setupWizardSource = await readFile("public/setup-wizard.js", "utf8");
const hardeningPanelSource = await readFile("public/hardening-panel.js", "utf8");
const extensionOptionsSource = await readFile("extension/options.js", "utf8");
assert.doesNotMatch(extensionOptionsSource, /\nexport \{\};?\s*$/u, "the extension options page must load as a classic script");
assert.doesNotMatch(settingsAppSource, /ranking-view|createRankingView|rankingView/u, "the frontend must not initialize the retired ranking view");
assert.match(settingsUiSource, /wrapSettingsPanels\(\)/, "settings must turn source panels into focused details");
assert.match(settingsUiSource, /form\.getAttribute\("id"\)/, "editor routing must use the form attribute instead of a shadowing named control");
const settingsCategoriesSource = settingsUiSource.match(/const CATEGORIES = \[([\s\S]*?)\];/)?.[1] || "";
assert.deepEqual(
  [...settingsCategoriesSource.matchAll(/label: "([^"]+)"/g)].map((match) => match[1]),
  ["Rules", "Protection", "Devices", "Appearance"],
  "Settings must expose exactly four semantic categories and must not restore a separate Journal tab"
);
assert.match(settingsUiSource, /nav\.setAttribute\("role", "tablist"\)/, "the Settings category row must identify itself as a tab list");
assert.match(settingsUiSource, /disclosure\.setAttribute\("role", "tabpanel"\)/, "each Settings category must be exposed as a tab panel");
assert.match(settingsUiSource, /button\.setAttribute\("role", "tab"\)/, "each Settings category control must use tab semantics");
assert.match(settingsUiSource, /button\.setAttribute\("aria-controls", disclosure\.id\)/, "each Settings tab must name its controlled panel");
assert.match(
  settingsUiSource,
  /\["ArrowRight", "ArrowLeft", "Home", "End"\][\s\S]*?event\.key === "ArrowRight"[\s\S]*?event\.key === "ArrowLeft"[\s\S]*?event\.key === "Home"[\s\S]*?event\.key === "End"/,
  "horizontal Settings tabs must support Left, Right, Home, and End keyboard navigation"
);
assert.match(settingsUiSource, /main\.addEventListener\("click", \(\) => openSettingsDetail\(detail\)\)/, "each settings index row must open exactly one detail page");
assert.match(
  settingsUiSource,
  /function openSettingsDetail[\s\S]*?index\.hidden = true[\s\S]*?sibling\.hidden = sibling !== detail[\s\S]*?classList\.add\("is-detail-open"\)/,
  "opening a setting must replace the category index with one selected detail"
);
assert.match(
  settingsUiSource,
  /function closeCategoryDetail[\s\S]*?index\.hidden = false[\s\S]*?detail\.hidden = true[\s\S]*?classList\.remove\("is-detail-open"\)/,
  "the detail Back action must restore the category index and hide every detail"
);
assert.match(settingsUiSource, /editor\.className = "settings-editor";[\s\S]*?editor\.hidden = true/, "collection forms must use one hidden inline editor instead of another disclosure layer");
assert.doesNotMatch(settingsUiSource, /settings-subsection|createElement\("details"\)/, "the enhanced Settings UI must not generate nested disclosures");
assert.match(settingsUiSource, /data-editor-for|dataset\.editorFor/, "New and Edit actions must target a single settings editor");
assert.doesNotMatch(settingsUiSource, /addEventListener\("submit"/, "settings editors must not close before an asynchronous save succeeds");
assert.match(settingsUiSource, /resetSettingsUi[\s\S]*?\.settings-editor[\s\S]*?closeEditor\(editor\)[\s\S]*?\.settings-category[\s\S]*?closeCategoryDetail\(category, false\)/, "leaving Settings must close editors and return categories to their indexes");
assert.match(settingsUiSource, /function resetSettingsUi\(\)[\s\S]*?clearSettingsSearch\(settingsRoot\);\s+selectCategory/, "leaving settings must clear the settings search and its hidden state");
assert.match(settingsUiSource, /function selectCategory[\s\S]*?activeCategoryId = categoryId;\s+activeDetailId = null;\s+clearSettingsSearch\(settingsRoot\)/, "selecting a settings category must clear the active search filter");
assert.match(settingsUiSource, /function revealAppUpdateSettings[\s\S]*?selectCategory\("protection", false\)[\s\S]*?openSettingsDetail\(detail, false\)[\s\S]*?#checkAppUpdate/u, "native update details must reveal and focus the update detail instead of merely opening Vigil's home view");
assert.match(settingsAppSource, /subscribeDetails[\s\S]*?setView\("settings"\)[\s\S]*?revealAppUpdateSettings\(\)/u, "the renderer must route the tray's update-details request into Settings");
assert.match(protectionSettingsMarkup, /id="appUpdatePanel"[^>]*aria-busy="false"/u, "the update surface must expose whether its one-button transaction is busy");
assert.match(protectionSettingsMarkup, /id="appUpdateStatus"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u, "update phases must be announced without moving keyboard focus");
assert.match(protectionSettingsMarkup, /<progress id="appUpdateProgress"[^>]*max="1"[^>]*aria-label="Vigil update progress"[^>]*hidden/u, "the updater must use a labelled indeterminate progress indicator instead of a fake percentage");
assert.match(protectionSettingsMarkup, /id="checkAppUpdate"[^>]*aria-describedby="appUpdateStatus appUpdateHelp"/u, "the single update action must name its live status and one-time setup guidance");
assert.match(settingsUiSource, /clearSettingsSearch[\s\S]*search\.value = ""[\s\S]*\.settings-category, \.settings-index-item, \.settings-nav-item[\s\S]*filtered\.hidden = false/, "clearing settings search must restore every category, index row, and tab hidden by filtering");
assert.match(
  settingsUiSource,
  /for \(const child of \[\.\.\.header\.children\]\) \{\s*if \(child !== headingGroup\)\s*actions\.append\(child\)/,
  "panel enhancement must preserve Agent Health progress and Guided Setup actions instead of deleting them"
);
assert.match(settingsUiSource, /actions\.append\(\.\.\.source\.children\)/, "preserved panel actions must remain available from their settings index row");
assert.match(protectionSettingsMarkup, /id="setupProgress"[\s\S]*?id="openSetupAssistant"/, "Protection status must retain its progress and Guided Setup controls");
assert.doesNotMatch(saintPortraitStageSource, /aesthetic|vigil-saint-decorations|setDecorationsVisible/u, "the portrait runtime must not retain appearance modes or decoration preferences");
assert.match(saintPortraitStageSource, /return `\/art\/saints\/traditional\/\$\{id\}\.png`/, "the portrait runtime must resolve only traditional artwork");
assert.match(saintPortraitStageSource, /CHRIST_PANTOCRATOR[\s\S]*id: "christ"/, "the fixed portrait set must define Christ Pantocrator");
assert.match(saintPortraitStageSource, /SAINT_STAGE_PORTRAITS[\s\S]*CHRIST_PANTOCRATOR/, "Christ must belong to the one fixed portrait rotation");
assert.doesNotMatch(stylesSource, /saint-(?:halo|symbol|ambient|geometry|orbit|particles)|data-saint-(?:aesthetic|decorations)/, "portrait decorations and appearance-mode styling must be deleted");
const fixedThemeDeclaration = stylesSource.match(/\/\* Ember theme:[\s\S]*?:root\s*\{([^}]*)\}/)?.[1] || "";
assert.match(fixedThemeDeclaration, /--font-body: Georgia, "Times New Roman", serif/, "the fixed theme must use traditional body typography");
assert.match(fixedThemeDeclaration, /--font-display: Georgia, "Times New Roman", serif/, "the fixed theme must use traditional display typography");
assert.match(fixedThemeDeclaration, /--font-mono:/, "the fixed traditional theme must preserve functional monospace surfaces");
assert.match(stylesSource, /body\[data-active-view="settings"\] \.settings-root,[\s\S]*?\.settings-root :is\(button, input, select, textarea\)\s*\{\s*font-family: var\(--font-body\)/, "all Settings copy and controls must inherit the active body typography token");
assert.match(stylesSource, /body\[data-active-view="settings"\] \.settings-root :is\(h2, h3, strong\),[\s\S]*?\.settings-nav-item\s*\{\s*font-family: var\(--font-display\)/, "Settings titles, row labels, and tabs must share the active display typography token");
assert.match(stylesSource, /\.saint-info-eyebrow,[\s\S]*?#protectionLevelStatus\s*\{\s*font-family: var\(--font-body\)/, "traditional typography must carry through portrait metadata and utility labels");
assert.match(stylesSource, /\.protection-level-choice span\s*\{[^}]*font-family: var\(--font-display\)[^}]*font-variant-numeric: oldstyle-nums proportional-nums/, "protection buttons must use old-style serif numerals");
assert.match(stylesSource, /#view-home \.saint-artwork\s*\{[^}]*image-rendering: auto/, "traditional paintings must use natural image rendering");
assert.match(settingsAppSource, /previousView === "settings" && state\.activeView !== "settings"[\s\S]*resetSettingsUi\(\)/, "the settings reset must run only after navigating away");
assert.match(
  setupWizardSource,
  /launchAgentReady = Boolean\(launchAgent\.loaded && launchAgent\.running && \(!launchAgent\.embedded \|\| launchAgent\.restartHardened === true\)\)/u,
  "embedded runtime setup must not be ready without verified restart hardening"
);
assert.match(
  setupWizardSource,
  /detail: launchAgent\.embedded && launchAgent\.restartHardened !== true[\s\S]*?Repair automatic restart protection without leaving Vigil\.[\s\S]*?action: launchAgentReady \? "Open Login Items" : launchAgent\.embedded \? "Repair protection" : "Enable at login"[\s\S]*?actionTarget: launchAgentReady \? undefined : "installLaunchAgent"/u,
  "embedded runtime setup must route its recovery guidance to the working restart-protection control"
);
assert.match(
  setupWizardSource,
  /action\.addEventListener\("click", \(\) => \{[\s\S]*?runChecklistItemAction\(item\)\.catch\(\(error\) => assistant\?\.showActionError\(error\)\)[\s\S]*?async function runChecklistItemAction[\s\S]*?target\.click\(\)/u,
  "setup checklist recovery actions must invoke their matching hardening control"
);
assert.match(
  setupWizardSource,
  /runChecklistItemAction\(item\)\.catch\(\(error\) => assistant\?\.showActionError\(error\)\)[\s\S]*?if \(item\.nativeDestination\)[\s\S]*?await openNativeSetupDestination\(item\.nativeDestination\)[\s\S]*?showActionError\(error\)[\s\S]*?this\.options\.toast/u,
  "native checklist action failures must reach the shared setup toast"
);
assert.match(
  setupWizardSource,
  /startedOnRenderRevision = this\.pageRenderRevision[\s\S]*?if \(this\.pageRenderRevision !== startedOnRenderRevision\)[\s\S]*?return;[\s\S]*?this\.pageRenderRevision \+= 1[\s\S]*?actionButton\.disabled = false/u,
  "delayed action cleanup must not restore stale shared-button state after setup navigation"
);
assert.match(
  setupWizardSource,
  /focusReplacement[\s\S]*?dataset\.setupSignature === setupSignature\(item\)[\s\S]*?currentNode\.replaceWith\(node\)[\s\S]*?focusReplacement\?\.focus\(\)/u,
  "live setup updates must replace stale focused rows while preserving focus when the replacement remains actionable"
);
assert.match(html, /id="setupAssistant"[^>]*aria-labelledby="setupAssistantTitle"/u, "first run must have a dedicated guided setup dialog");
assert.match(html, /id="openSetupAssistant"[^>]*>Guided Setup</u, "the live setup checklist must always reopen the guide");
assert.match(setupWizardSource, /SETUP_SCHEMA_VERSION[\s\S]*SETUP_SNOOZE_KEY[\s\S]*coreReady/u, "guided setup must persist resumable, versioned completion state");
assert.match(setupWizardSource, /tier: networkEnabled \? "core" : "recommended"/u, "disabled network coverage must not block core completion");
assert.match(setupWizardSource, /tier: safariFilter\.required \? "core" : "optional"/u, "unneeded Safari coverage must not block core completion");
assert.match(setupWizardSource, /id: "extension"[\s\S]*?action: "Install Companion"/u, "the Chromium setup step must use consumer-facing install language");
assert.doesNotMatch(setupWizardSource, /Reveal Companion|Add the bundled companion/u, "the production Chromium setup must not expose development or sideloading language");
assert.match(setupWizardSource, /iPhoneReady = Boolean\(ios\.enabled && \(mdm\.ready \|\| \(manageEngine\.preferred && manageEngine\.currentGeneration\)\)\)/u, "iPhone setup must require enabled policy plus concrete delivery evidence");
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
assert.match(
  hardeningPanelSource,
  /Exporting Chrome profile for device management[\s\S]*?Chrome MDM profile exported[\s\S]*?manual installation is not accepted/u,
  "Chrome SafeSearch setup must export for device management instead of inviting a removable manual install"
);
assert.doesNotMatch(
  hardeningPanelSource,
  /Approve Chrome Filter|Opening Chrome Filter profile|Chrome Filter profile opened/u,
  "Chrome SafeSearch setup must not direct users into a manual System Settings approval flow"
);
assert.match(html, />Export Chrome policy<\/button>/u, "the Settings action must use concise user-facing Chrome policy language");
assert.match(extensionOptionsSource, /vigilUrl\("\/api\/health", localServer\)/u, "extension connection tests must use the companion-safe health route");
assert.doesNotMatch(extensionOptionsSource, /vigilUrl\("\/api\/state", localServer\)/u, "extension connection tests must not probe the private app state route");
const dayControlsSource = await readFile("public/day-controls.js", "utf8");
for (const preset of ["Every day", "Weekdays", "Weekends", "Custom days"]) {
  assert.match(dayControlsSource, new RegExp(preset), `day controls must offer the ${preset} preset`);
}
assert.match(dayControlsSource, /custom\.hidden = select\.value !== "custom"/, "the seven-day grid must stay hidden until Custom days is selected");
assert.match(html, /id="accountButton"[^>]*aria-expanded="false"/, "the account button must expose its toggle state");
const accountUiSource = await readFile("public/account-ui.js", "utf8");
assert.match(
  accountUiSource,
  /post\(["']\/api\/account\/logout["'][\s\S]*?clearJournalSession\(\)[\s\S]*?window\.location\.reload\(\)/u,
  "successful sign-out must clear the protected journal session before discarding renderer state"
);
const sidebarMarkup = html.match(/<aside class="app-chrome"[\s\S]*?<\/aside>/)?.[0] || "";
assert.doesNotMatch(sidebarMarkup, /&#(?:8962|10016|10003|9835|10070|9881);/, "font-glyph sidebar icons must not return");
assert.match(html, /id="sidebarToggle"[^>]*aria-controls="primarySidebar"[^>]*aria-expanded="true"/, "the sidebar must expose an explicit full-hide toggle");
assert.ok(html.indexOf('id="sidebarToggle"') < html.indexOf('<aside class="app-chrome"'), "the sidebar toggle must live outside the sidebar it hides");
assert.doesNotMatch(html, /maximizedWindowControls|data-window-action/, "web content must never imitate macOS traffic lights");
assert.match(sidebarMarkup, /id="primarySidebar"/, "the sidebar toggle must control the navigation sidebar");
assert.match(sidebarMarkup, /id="brandHomeButton"[^>]*data-view-target="home"[^>]*aria-label="Go to Home"/, "the Vigil wordmark must provide a keyboard-accessible route back Home");

const styles = await readFile("public/styles.css", "utf8");
assert.match(styles, /\.toast\s*\{[^}]*position:\s*fixed;[^}]*top:\s*20px;/, "shared toast notifications must appear at the top of the viewport");
assert.doesNotMatch(styles, /\.toast\s*\{[^}]*bottom:/, "shared toast notifications must never return to the bottom of the viewport");
assert.match(styles, /body\[data-active-view="settings"\] \.settings-category > summary\s*\{\s*display:\s*none;/, "source category disclosures must not appear as another visible navigation layer");
assert.match(styles, /\.settings-index-item\s*\{[^}]*min-height:\s*74px;[^}]*display:\s*flex;/, "each Settings category must use one consistent row index");
assert.match(styles, /\.settings-detail-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*42px minmax\(0, 1fr\)/, "every Settings destination must use the shared detail header and Back control layout");
assert.match(styles, /\.settings-index\[hidden\],[\s\S]*?\.settings-editor\[hidden\][\s\S]*?display:\s*none !important;/, "inactive details and collection editors must not create visible nested layers");
assert.match(styles, /\.day-custom-grid\[hidden\]\s*\{\s*display:\s*none;/, "custom weekday buttons must not consume space for preset schedules");
assert.match(styles, /body\.sidebar-collapsed \.app-chrome\s*\{\s*display:\s*none;/, "collapsing must fully hide the sidebar instead of leaving an icon rail");
assert.match(styles, /body\.sidebar-collapsed \.shell\s*\{\s*grid-column:\s*1;/, "collapsed content must occupy the first grid column without widening the viewport");
assert.match(styles, /body\.sidebar-collapsed \.sidebar-toggle\s*\{[\s\S]*?visibility:\s*visible;[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;/, "the full-hide toggle must remain visible and clickable after the sidebar disappears");
assert.match(styles, /--sidebar-toggle-safe-gutter:\s*64px;/, "the collapsed sidebar toggle must own a stable content-free gutter");
assert.match(styles, /body\.sidebar-collapsed \.shell\s*\{[\s\S]*?padding-left:\s*max\(\s*var\(--sidebar-toggle-safe-gutter\),\s*clamp\(18px, 3\.4vw, 52px\)\s*\);/, "collapsed content must stay clear of the fixed sidebar toggle at every scroll position");
assert.match(styles, /body\.sidebar-collapsed\[data-active-view="audio"\]\s*\{[\s\S]*?--audio-shell-gutter:\s*max\(\s*var\(--sidebar-toggle-safe-gutter\),\s*clamp\(24px, 4\.4vw, 68px\)\s*\);/, "the edge-to-edge audio layout must honor the collapsed sidebar toggle gutter");
assert.doesNotMatch(styles, /maximized-window-controls/, "styles must not contain fake window controls");
assert.doesNotMatch(styles, /body:not\(\[data-active-view="home"\]\) \.app-chrome/, "navigation must not automatically compact the sidebar away from Home");
assert.match(styles, /\.brand-home\s*\{[^}]*background:\s*transparent;[^}]*font:\s*inherit;/, "the Home button must preserve the Vigil wordmark styling");
const uiShellSource = await readFile("public/ui-shell.js", "utf8");
assert.match(uiShellSource, /localStorage\.setItem\("vigil-sidebar-collapsed"/, "the explicit sidebar choice must persist");
assert.match(
  uiShellSource,
  /button\.addEventListener\(["']pointerdown["'][\s\S]*?event\.isPrimary[\s\S]*?event\.button === 0[\s\S]*?event\.preventDefault\(\)/,
  "mouse activation of the sidebar toggle must not leave a stale focus highlight when the window reopens"
);
assert.match(uiShellSource, /renderActiveView[\s\S]*window\.scrollTo\(0, 0\)/, "view navigation must reset the document scroll position");
assert.doesNotMatch(styles, /@media \(max-width: 900px\)\s*\{\s*body\s*\{\s*display:\s*block/, "narrow windows must retain the sidebar grid");

const trackingMarkup = html.match(/<section id="view-journal"[\s\S]*?<div class="journal-page journal-only"/)?.[0] || "";
assert.match(trackingMarkup, /id="habitActivity"[\s\S]*?id="habitActivityGrid"[\s\S]*?id="habitFocus"[\s\S]*?id="habitQuickCheckIn"[\s\S]*?id="habitActivityMonths"/, "tracking must expand the one-at-a-time decision from inside the activity field and place month labels below it");
assert.doesNotMatch(trackingMarkup, /habitFocusConnector|habit-focus-connector/, "the floating check-in must not retain a connector line");
assert.doesNotMatch(trackingMarkup, /id="habitViewHistory"/, "the integrated activity view must not retain a redundant history link");
assert.equal([...trackingMarkup.matchAll(/data-activity-mode="(?:daily|weekly|cumulative)"/g)].length, 3, "habit activity must expose Daily, Weekly, and Cumulative modes");
assert.match(trackingMarkup, /class="habit-activity-tabs" role="group"[\s\S]*?aria-pressed="true"/, "activity modes must use native toggle-button semantics");
assert.doesNotMatch(trackingMarkup, /role="tab(?:list)?"/, "activity modes must not advertise an incomplete tab widget");
assert.doesNotMatch(trackingMarkup, /dailyCheckInMeterBar|habitMonthTrend|habitMonthPulse|habitQuickSelect|habitCalendarDetails|habitSelectedDate/, "the one-at-a-time view must not retain dashboard charts, pickers, or dense tables");
const trackingSource = await readFile("public/tracking-view.js", "utf8");
assert.match(trackingSource, /status === "success" \? "unreported" : "success"/, "selecting an active habit result again must clear it without a third row button");
assert.match(trackingSource, /behaviorAfterCheckIn/, "submitting a daily result must advance the compact card to another habit");
assert.match(trackingSource, /className = "habit-focus-skip"[\s\S]*?selectedBehaviorId = behaviors\[\(selectedIndex \+ 1\) % behaviors\.length\]\.id/, "Skip for now must advance locally without writing a result");
assert.match(trackingSource, /if \(locked\) \{[\s\S]*?completedDayView/, "a fully recorded day must replace editable habit controls with a completion screen");
assert.match(trackingSource, /editableCompletedDateKey = dateKey/, "editing a completed day must require a deliberate unlock action");
assert.match(trackingSource, /cell\.dataset\.level = String\(level\)/, "activity intensity must be projected through CSP-safe state attributes");
assert.match(trackingSource, /cell\.setAttribute\("aria-label", activityAriaLabel/, "every activity cell must announce its date and Done, Missed, and Not recorded counts");
assert.match(trackingSource, /cell\.disabled = future/, "future activity cells must not be interactive");
assert.match(trackingSource, /cell\.addEventListener\("click", \(\) => selectDate\(date, true\)\)/, "daily history cells must preserve backdated editing through the focused check-in");
assert.match(trackingSource, /togglingSelectedDate[\s\S]*?focusOpen = !focusOpen/, "selecting the active activity cell again must close and reopen its check-in");
assert.match(
  trackingSource,
  /const focusedActivity = captureActivityFocus\(activityRoot\);[\s\S]*?activityRoot\.replaceChildren\(\);[\s\S]*?restoreActivityFocus\(activityRoot, focusedActivity\);/,
  "activity rerenders must restore the focused history cell after replacing the grid"
);
assert.match(
  trackingSource,
  /const focusedControl = captureHabitFocusControl\(focusRoot\);[\s\S]*?focusRoot\.replaceChildren\(\);[\s\S]*?restoreHabitFocusControl\(focusRoot, focusedControl\);/,
  "polling must restore a surviving focused check-in control after rebuilding the compact editor"
);
for (const identity of [
  /habitFocusControl = `habit:\$\{behaviorId\}:status:\$\{value\}`/,
  /habitFocusControl = `habit:\$\{behavior\.id\}:skip`/,
  /habitFocusControl = `habit:\$\{behavior\.id\}`/,
  /habitFocusControl = `edit:\$\{localDateKey\(selectedDate\)\}`/
]) {
  assert.match(trackingSource, identity, "every interactive check-in action must have a stable focus identity");
}
assert.doesNotMatch(trackingSource, /positionFocusConnector|focusConnectorPath|style\.setProperty/, "the floating check-in must not calculate a connector or inject inline presentation");
assert.match(trackingSource, /cell\.setAttribute\("aria-controls", "habitFocus"\)[\s\S]*?cell\.setAttribute\("aria-expanded", String\(focusOpen\)\)/, "the selected day must expose the embedded check-in as an accessible disclosure");
assert.match(styles, /\.habit-focus-actions\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, "Done and Missed must remain the only two equal primary choices");
assert.match(styles, /faithful expandable-cell layout[\s\S]*?grid-template-columns:\s*repeat\(28,[\s\S]*?grid-template-rows:\s*repeat\(13, auto\)[\s\S]*?grid-auto-flow:\s*column/, "every activity mode must retain the dense 28-column by 13-row history layout");
assert.match(trackingSource, /dates\.forEach\(\(date, index\) => \{[\s\S]*?habitActivityPeriod\(dates, dailyCounts, index, activityMode, effectiveToday\)[\s\S]*?activityRoot\.append\(cell\)/, "Daily, Weekly, and Cumulative must render through the same full-size history cells");
assert.doesNotMatch(trackingSource, /renderActivityBars|habit-activity-bar/, "aggregate modes must not fall back to the retired compact bar renderer");
assert.doesNotMatch(styles, /\.habit-activity-grid\[data-mode="(?:weekly|cumulative)"\]|\.habit-activity-bar/, "aggregate modes must not override the shared dense-square geometry");
assert.match(styles, /faithful expandable-cell layout[\s\S]*?\.habit-activity-scroll\s*\{[^}]*overflow:\s*visible;/, "the integrated activity field must not create a nested scrollbar");
assert.match(styles, /faithful expandable-cell layout[\s\S]*?\.habit-activity-cell\s*\{[\s\S]*?width:\s*min\(76%, 18px\)[\s\S]*?border-radius:\s*clamp\(2px, 0\.24cqw, 4px\)/, "every activity mode must retain the old version's larger dense rounded-square treatment");
assert.match(styles, /\.habit-focus\s*\{[\s\S]*?position:\s*absolute/, "opening the check-in must not reflow or move calendar cells");
assert.match(styles, /faithful expandable-cell layout[\s\S]*?\.habit-activity\s*\{[^}]*overflow:\s*visible;/, "the floating check-in must be able to extend beyond the compact activity frame");
assert.match(styles, /faithful expandable-cell layout[\s\S]*?\.habit-activity-canvas\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;/, "the activity frame must hug the calendar without reserving popup space");
assert.match(styles, /\.habit-activity-cell\.is-today:not\(\.is-selected\)[\s\S]*?outline:\s*1px solid var\(--habit-done-strong\)[\s\S]*?\.habit-activity-cell\.is-selected[\s\S]*?outline:\s*2px solid var\(--gold-bright\)/, "today and the actively selected day must have distinct visual states");
assert.match(styles, /\.habit-focus::before\s*\{[^}]*display:\s*none;[^}]*content:\s*none;/, "the floating check-in must have a flat top edge without a pointer notch");
assert.match(styles, /body\[data-active-view="tracking"\]\s*\{[^}]*overflow:\s*hidden;/, "the tracking view must not expose blank vertical overscroll");

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
assert.doesNotMatch(styles, /\.protection-level-control:has\(#protectionLevel:disabled\)[^{]*\{[^}]*cursor:\s*wait/, "applying a protection level must not flash a wait cursor");
assert.match(styles, /\.protection-level-control:not\(\.is-open\) \.protection-level-choice:hover/, "the visible protection number must glow only when the orb itself is hovered");
assert.match(styles, /\.protection-level-choice:hover span\s*\{[\s\S]*?text-shadow:/, "hovering a protection number must brighten the number itself");
const protectionGlowStyles = styles.match(/\.protection-level-choice::after\s*\{[\s\S]*?\n\}/)?.[0] || "";
assert.match(protectionGlowStyles, /inset:\s*-28px/, "the protection button glow must remain close to the orb");
assert.match(protectionGlowStyles, /transition:\s*opacity 240ms ease,\s*transform 280ms/, "the protection button glow must respond at a deliberate pace");
assert.match(styles, /\.protection-level-choice:hover::after\s*\{[^}]*transition-duration:\s*240ms,\s*280ms;/, "hovering a protection button must use the balanced bloom timing");
assert.doesNotMatch(styles, /:has\(\.protection-level-choice:hover\) \.protection-level-trace/, "highlighting a protection number must not make the connecting line glow");
const protectionTraceStyles = styles.match(/\.protection-level-trace\s*\{[\s\S]*?\n\}/)?.[0] || "";
assert.match(protectionTraceStyles, /height:\s*12px/, "the protection connector must use the thicker two-tier track");
assert.match(protectionTraceStyles, /--protection-trace-inner:[\s\S]*?--protection-trace-outer:/, "the protection connector must define distinct inner and outer tracks");
assert.match(protectionTraceStyles, /#e2ad72[\s\S]*?#c98a57[\s\S]*?#bc624b[\s\S]*?#ff7b81/, "the protection connector must use one continuous gradient following all four button colors");
assert.doesNotMatch(styles, /\.protection-level-trace::(?:before|after)/, "the protection connector must not split its gradient into separate gap segments");
assert.doesNotMatch(protectionTraceStyles, /repeating-linear-gradient|ribs|sheen/, "the protection connector must stay subdued and stripe-free");
assert.match(
  protectionTraceStyles,
  /--protection-trace-hole-radius:[\s\S]*?mask:\s*[\s\S]*?at 0% 50%[\s\S]*?at 33\.333% 50%[\s\S]*?at 66\.667% 50%[\s\S]*?at 100% 50%[\s\S]*?mask-composite:\s*intersect/,
  "the continuous connector must tuck beneath each outer button ring without showing through its center"
);
const sidebarToggleLayer = Number(styles.match(/\.sidebar-toggle\s*\{[\s\S]*?z-index:\s*(\d+);/)?.[1] || 0);
const toastLayer = Number(styles.match(/\.toast\s*\{[\s\S]*?z-index:\s*(\d+);/)?.[1] || 0);
assert.ok(toastLayer > sidebarToggleLayer, "announcements must cover the fixed sidebar toggle instead of allowing it to punch through");
const appEventsSource = await readFile("public/app-events.js", "utf8");
assert.match(appEventsSource, /classList\.contains\(["']is-open["']\)/, "clicking the collapsed protection orb must open the selector before changing levels");
assert.match(appEventsSource, /const releaseProtectionLevelSettle = \(\) => \{\s*protectionLevelControl\.classList\.remove\(["']is-settling["']\);\s*\};/, "the protection selector must always leave its settling state even while the selected dot stays hovered or focused");
assert.match(appEventsSource, /if \(requestedLevel === Number\(protectionLevel\.value \|\| 1\)\)\s*\{\s*setProtectionLevelOpen\(false\);\s*return;\s*\}/, "clicking the selected protection dot again must close without starting a no-op protection request");
assert.doesNotMatch(appEventsSource, /addEventListener\(["']wheel["']/, "scrolling over the protection selector must never change levels or start Panic mode");
assert.match(appEventsSource, /const confirmPanicLevel = \(requestedLevel\) => requestedLevel !== 4\s*\|\| window\.confirm\(["']Start Panic mode for three minutes\? It cannot be ended early\.["']\)/, "Panic mode must require an explicit confirmation after its level is selected");
assert.ok([...appEventsSource.matchAll(/confirmPanicLevel\(requestedLevel\)/g)].length >= 2, "every interactive protection-level path must use the Panic confirmation gate");
assert.match(appEventsSource, /if \(!confirmPanicLevel\(requestedLevel\)\) \{\s*showProtectionLevel\(appliedProtectionLevel, false\);/, "rejecting a range-selected Panic level must synchronously restore the applied level");
assert.doesNotMatch(appEventsSource, /Focus sound saved|Sound on|Sound paused|Playing \$\{/, "routine sound controls must not trigger bottom-corner toast popups");
assert.match(appEventsSource, /const enabled = !focusSound\.isPlaying\(\)/, "Listen must retry silent-but-enabled audio instead of disabling it");
assert.match(appEventsSource, /if \(enabled\)\s*focusSound\.restartTimer\(\)/, "Listen must restart an expired timer before replaying it");
assert.match(
  appEventsSource,
  /\[data-focus-preset\][\s\S]*?focusSound\.restartTimer\(\)[\s\S]*?persistFocusSound\(true\)/,
  "choosing a library track must restart an expired finite timer before playback"
);
assert.match(
  appEventsSource,
  /state\.grayscaleSettingsSavePending = true[\s\S]*?drainLatestSettingsThroughRefresh[\s\S]*?finally[\s\S]*?state\.grayscaleSettingsSavePending = false/u,
  "grayscale polling must remain guarded through queue draining and its confirming refresh"
);

const appSource = await readFile("public/app.js", "utf8");
assert.match(
  appSource,
  /if \(!state\.grayscaleSettingsSavePending\)[\s\S]*?grayscaleSoftBlockEnabled[\s\S]*?grayscalePreventManualChanges/u,
  "state polls must not overwrite grayscale controls while their combined payload is queued"
);
assert.match(appSource, /!hasRuntimeStatus/, "the idle home screen must hide the redundant Ready and dash status row");
assert.match(appSource, /persistentLevelSelection[\s\S]*?source === "protection-level"[\s\S]*?!persistentLevelSelection/, "persistent level selections must leave the homepage to the number control alone");
assert.doesNotMatch(appSource, /Until changed/, "the homepage must not repeat persistent level state beneath the selected number");
assert.doesNotMatch(styles, /\.ranking-|@container ranking|\.knight-/u, "retired ranking and rank-avatar styles must not return");

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
assert.match(journalPageMarkup, /id="journalArchiveTitle">Journal<[\s\S]*?id="journalEntrySearch"[\s\S]*?id="journalEntryList"[\s\S]*?id="journalEntryForm"/, "journal history must remain visible beside the editor");
assert.match(journalPageMarkup, /id="journalNewEntry"[^>]*>New entry<\//, "journal history must expose an explicit new-entry action");
assert.match(journalPageMarkup, /name="title"[\s\S]*?name="body"[\s\S]*?>Save entry<\//, "the journal composer must contain Title, Entry, and Save in that order");
assert.match(styles, /\.journal-page\s*\{[^}]*grid-template-columns:\s*clamp\(150px, 29%, 300px\) minmax\(0, 1fr\);/, "journal history and editor must remain side by side at the real app window size");
assert.doesNotMatch(styles, /@media \(max-width: 820px\)[\s\S]*?\.journal-page\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/, "the real Retina app window must never stack journal history above the editor");
assert.match(styles, /\.journal-form \.journal-title-field input:focus,[\s\S]*?\.journal-form \.journal-body-field textarea:focus\s*\{[^}]*outline:\s*none;/, "journal writing fields must remain visually unboxed while editing");
assert.doesNotMatch(styles, /\.journal-search:focus-within/, "journal search must not add a focus highlight box around the field");
const lifeLogSource = await readFile("public/life-log-view.js", "utf8");
assert.doesNotMatch(lifeLogSource, /journal-entry-draft/, "the journal history must not manufacture a saved-looking row for an empty draft");
assert.match(lifeLogSource, /if \(query\)\s*list\.append\(empty\("No matching entries"\)\)/, "an empty journal history must stay blank unless a search has no matches");
assert.doesNotMatch(lifeLogSource, /No entries yet/, "the permanent journal history rail must stay visually blank when there are no saved entries");
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
assert.match(html, /class="saint-info-navigation" aria-label="Browse sacred portraits"/, "portrait details must expose in-card previous and next navigation");
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
assert.match(saintStageSource, /select\(previousStagePortraitId\(selectedId\), true, true\)/, "the open portrait card must browse backward without closing");
assert.match(saintStageSource, /select\(nextStagePortraitId\(selectedId\), true, true\)/, "the open portrait card must browse forward without closing");
assert.doesNotMatch(html, /saint-(?:ambient|geometry|orbit|particles)/, "the patron stage must not render geometric shapes behind sacred portraits");
assert.doesNotMatch(html, /saint-cursor-aura/, "the Home screen must not render a glow that follows the cursor");
assert.doesNotMatch(styles, /saint-cursor-aura|--saint-pointer-(?:x|y|distance)/, "cursor-following glow styles must stay removed");
assert.match(styles, /#view-home \.home-stage::before\s*\{\s*display:\s*none;/, "the Home background must not retain a stationary oval tint around the cursor glow");
assert.doesNotMatch(styles, /\.electron-shell \.saint-cursor-aura\s*\{\s*display:\s*none;/, "Electron must keep the cursor glow inside Vigil's real window");
assert.doesNotMatch(saintStageSource, /vigilCursorAura|screenX|screenY/, "the Home stage must not drive a second native aura window");
assert.doesNotMatch(saintStageSource, /pointermove|is-pointer-active|data\.look|dataset\.look/, "the fixed portrait stage must not retain cursor-driven motion state");
assert.match(
  styles,
  /@media \(hover: none\), \(pointer: coarse\), \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.saint-artifact:hover:not\(:disabled\)[\s\S]*?transform: none;/,
  "reduced-motion and coarse-pointer users must not receive the saint artwork hover scale"
);
assert.match(styles, /#view-home \.saint-artifact:hover:not\(:disabled\),[\s\S]*?#view-home \.saint-artifact:focus-visible\s*\{[\s\S]*?transform:\s*scale\(1\.012\);/, "hovering the saint composition must enlarge it slightly without cursor-driven translation or rotation");
assert.match(styles, /#view-home \.saint-artifact,[\s\S]*?#view-home \.saint-stage\[data-saint\] \.saint-artifact\s*\{[\s\S]*?width:\s*min\(720px, 100%\);/, "the patron composition must size from the usable stage instead of the full viewport");
assert.doesNotMatch(styles, /\.saint-artifact:focus-visible\s*\{\s*outline:\s*none;/, "the saint button must retain a visible keyboard focus indicator");
assert.match(styles, /\.audio-desk\s*\{[\s\S]*?container:\s*audio-desk \/ inline-size;/, "the audio player must respond to its usable panel width");

const audioMarkup = html.match(/<section id="view-audio"[\s\S]*?<div class="audio-control-bridge"/)?.[0] || "";
assert.doesNotMatch(audioMarkup, /audio-settings-disclosure|audio-volume-line/, "playback should not expose redundant session or volume controls");
assert.equal(
  [...audioMarkup.matchAll(/<details class="audio-library-group/g)].length,
  5,
  "each sound category should be a compact disclosure"
);
assert.match(audioMarkup, /id="minecraftSoundsTitle">Minecraft<[\s\S]*?id="minecraftAudioTracks"/, "the sound library must include a dedicated Minecraft category");
assert.doesNotMatch(audioMarkup, /<details class="audio-library-group[^>]*\sopen(?:\s|>)/, "the sound library should start collapsed");
assert.match(audioMarkup, /id="focusSoundPlayButton"/, "play and pause must remain outside the collapsed settings");
assert.doesNotMatch(audioMarkup, /focusSoundStatus|focusSoundCategory|focusSoundDescription/, "the player should omit redundant status and description copy");
const audioPlayerMarkup = audioMarkup.match(/<section id="audioPlayer"[\s\S]*?<\/section>/)?.[0] || "";
assert.doesNotMatch(audioPlayerMarkup, /focusSoundAttribution/, "the large player card must end at the Listen control");
assert.match(audioMarkup, /id="audioSoundLibrary"[\s\S]*?id="focusSoundAttribution"[^>]*hidden/, "recording details must live with the expandable sound library");
assert.match(audioMarkup, /id="audioSoundLibrary"[\s\S]*?id="audioPlayer"/, "the compact sound library must precede the persistent player dock");
assert.match(audioMarkup, /id="focusSoundWave" class="audio-wave"/, "the player should keep the compact live waveform");
assert.equal([...audioPlayerMarkup.matchAll(/<span><\/span>/g)].length, 96, "the wide player dock must have enough analyser bars to carry the waveform across its width");
const focusSoundSource = await readFile("public/focus-sound.js", "utf8");
assert.match(focusSoundSource, /createMediaElementSource/, "long recordings must stream instead of remaining as fully decoded audio buffers");
assert.match(focusSoundSource, /maximumDecodedAudioBuffers\s*=\s*1/, "the compatibility decoder must not retain every recording played during a long session");
assert.match(focusSoundSource, /waveformFrameIntervalMs\s*=\s*1000\s*\/\s*24/, "the live waveform must not redraw its analyser and every bar at display refresh rate");
assert.doesNotMatch(styles, /@keyframes listeningWave|animation:\s*listeningWave/, "the waveform must not regress to a decorative loop");
assert.match(styles, /\.audio-player\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?bottom:\s*0;/, "the player must remain docked to the bottom edge while the sound library scrolls");
assert.match(styles, /@container audio-desk \(max-width: 760px\)\s*\{[\s\S]*?grid-template-areas:[\s\S]*?"title title"[\s\S]*?"wave control";/, "the compact player dock must keep its Listen control aligned with the waveform");
assert.match(appSource, /visibilitychange/, "the renderer must react when its window becomes hidden");
assert.match(appSource, /vigilWindowActivity/, "the renderer must honor Electron's native focus state even when DOM focus reporting is stale");
assert.match(appSource, /INACTIVE_STATE_POLL_MS\s*=\s*30_000/, "an inactive window must not rebuild the full dashboard every three seconds");
assert.match(styles, /html\.app-inactive \*,[\s\S]*?animation:\s*none !important;[\s\S]*?will-change:\s*auto !important;/, "unfocused Vigil windows must release decorative animation compositor layers");
