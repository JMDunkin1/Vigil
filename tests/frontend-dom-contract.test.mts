import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("public/index.html", "utf8");

assert.match(html, />Combined today</u);
assert.doesNotMatch(html, />Devices included</u, "ranking should show only the three decision-useful headline statistics");
assert.match(html, /<svg viewBox="0 0 120 168"[^>]*>[\s\S]*class="knight-shield"/, "ranking journey should use the detailed vector knight artwork");
assert.match(html, /Combined Mac and iPhone screen time by day/u);
assert.doesNotMatch(html, />iPhone today</u);
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
assert.match(html, /id="accountButton"[^>]*aria-expanded="false"/, "the account button must expose its toggle state");
const sidebarMarkup = html.match(/<aside class="app-chrome"[\s\S]*?<\/aside>/)?.[0] || "";
assert.doesNotMatch(sidebarMarkup, /&#(?:8962|10016|10003|9835|10070|9881);/, "font-glyph sidebar icons must not return");
assert.match(html, /id="sidebarToggle"[^>]*aria-controls="primarySidebar"[^>]*aria-expanded="true"/, "the sidebar must expose an explicit full-hide toggle");
assert.doesNotMatch(html, /maximizedWindowControls|data-window-action/, "web content must never imitate macOS traffic lights");
assert.match(sidebarMarkup, /id="primarySidebar"/, "the sidebar toggle must control the navigation sidebar");

const styles = await readFile("public/styles.css", "utf8");
assert.match(styles, /\.settings-disclosure \+ \.settings-disclosure\s*\{[\s\S]*?margin-top:\s*16px;/, "adjacent settings disclosures must use the shared row spacing");
assert.match(styles, /\.settings-disclosure\s*\{[\s\S]*?container-type:\s*inline-size;/, "settings disclosures must respond to their own available width");
assert.match(styles, /grid-template-columns:\s*minmax\(min-content, max-content\) minmax\(0, 1fr\) auto;/, "settings titles must keep a readable intrinsic column before descriptions flex");
assert.match(styles, /body\.sidebar-collapsed \.app-chrome\s*\{\s*display:\s*none;/, "collapsing must fully hide the sidebar instead of leaving an icon rail");
assert.match(styles, /body\.sidebar-collapsed \.shell\s*\{\s*grid-column:\s*1;/, "collapsed content must occupy the first grid column without widening the viewport");
assert.doesNotMatch(styles, /maximized-window-controls/, "styles must not contain fake window controls");
assert.doesNotMatch(styles, /body:not\(\[data-active-view="home"\]\) \.app-chrome/, "navigation must not automatically compact the sidebar away from Home");
const uiShellSource = await readFile("public/ui-shell.js", "utf8");
assert.match(uiShellSource, /localStorage\.setItem\("vigil-sidebar-collapsed"/, "the explicit sidebar choice must persist");
assert.doesNotMatch(styles, /@media \(max-width: 900px\)\s*\{\s*body\s*\{\s*display:\s*block/, "narrow windows must retain the sidebar grid");

const trackingMarkup = html.match(/<section id="view-journal"[\s\S]*?<div class="journal-page journal-only"/)?.[0] || "";
assert.match(trackingMarkup, /id="dailyCheckInMeterBar"/, "daily tracking must expose a visible completion meter");
assert.match(trackingMarkup, /id="habitMonthPulse"/, "monthly tracking must expose the compact rhythm visualization");
assert.match(trackingMarkup, /id="habitMonthDayCount"/, "monthly tracking must expose a dynamic day count");
assert.match(trackingMarkup, /<details id="habitCalendarDetails" class="habit-calendar-details">/, "the dense habit grid must start collapsed behind optional detail");
assert.doesNotMatch(trackingMarkup, /<details id="habitCalendarDetails"[^>]*\sopen(?:\s|>)/, "the dense monthly grid must not dominate the initial tracking view");
const trackingSource = await readFile("public/tracking-view.js", "utf8");
assert.match(trackingSource, /status === "success" \? "unreported" : "success"/, "selecting an active habit result again must clear it without a third row button");
assert.match(trackingSource, /className = "habit-quick-select"/, "daily tracking must use one selectable habit card instead of rendering every card at once");
assert.match(trackingSource, /behaviorAfterCheckIn/, "submitting a daily result must advance the compact card to another habit");
assert.match(trackingSource, /monthDayCount\.textContent = `\$\{dates\.length\} days`/, "the selected month must control the displayed day count");

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

const appSource = await readFile("public/app.js", "utf8");
assert.match(appSource, /!hasRuntimeStatus/, "the idle home screen must hide the redundant Ready and dash status row");

const journalGateMarkup = html.match(/<section id="journalUnlockGate"[\s\S]*?<\/section>/)?.[0] || "";
assert.doesNotMatch(journalGateMarkup, /\bpanel\b/, "journal access must not regress to the oversized generic panel");
assert.match(journalGateMarkup, /class="journal-gate-copy"/, "journal access must keep a minimal copy block");
assert.match(journalGateMarkup, />Unlock it</, "journal access must use the requested minimal unlock instruction");
assert.match(journalGateMarkup, /id="journalTouchIdUnlock"[\s\S]*?<svg/, "journal access must expose a clickable fingerprint control");
assert.doesNotMatch(journalGateMarkup, /type="password"|data-journal-unlock-method="password"/, "journal access must not expose a password fallback");
assert.match(styles, /\.journal-unlock-gate\s*\{[\s\S]*?width:\s*min\(620px, 100%\)/, "journal access must remain compact within the writing surface");

const emergencyMarkup = html.match(/<details id="emergencyPanel"[\s\S]*?<\/details>/)?.[0] || "";
assert.match(emergencyMarkup, /<summary class="emergency-summary">/, "emergency UI must be a collapsible top drawer");
assert.match(emergencyMarkup, /id="emergencyExplanation"/, "integrity lockdowns must expose protected-maintenance guidance");
assert.doesNotMatch(emergencyMarkup, /emergency-indicator/, "the floating integrity notice must not include a misaligned status dot");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?position:\s*absolute;/, "the emergency drawer must overlay the home view instead of stretching it");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?top:\s*12px;[\s\S]*?width:\s*min\(420px,[\s\S]*?border-radius:\s*13px;/, "the integrity notice must float independently near the top of the home view");
assert.match(styles, /\.electron-shell \.app-chrome::before\s*\{\s*content:\s*none;/, "the title-bar drag layer must not cover the emergency drawer");
assert.match(styles, /\.electron-shell \.app-chrome\s*\{\s*-webkit-app-region:\s*drag;/, "the sidebar must remain available for window dragging");
assert.match(styles, /\.sidebar-toggle\s*\{[\s\S]*?top:\s*50px;[\s\S]*?-webkit-app-region:\s*no-drag;/, "the sidebar toggle must always sit below the native title bar and remain clickable");

assert.match(html, /id="saintStageButton"[^>]*aria-controls="saintInfoPopover"[^>]*aria-expanded="false"/, "saint artwork must expose its details popover");
assert.match(html, /id="saintStageButton"[^>]*title="[^"]*Two-finger click for details\./, "saint details must advertise the trackpad gesture");
assert.match(html, /id="saintInfoPopover"[^>]*role="dialog"[^>]*aria-labelledby="saintInfoName"[^>]*hidden/, "saint details must start closed and have an accessible name");
for (const id of ["saintInfoName", "saintInfoEpithet", "saintInfoQuote", "saintInfoSource", "saintInfoClose"]) {
  assert.ok(idSet.has(id), `saint details are missing #${id}`);
}
const saintStageSource = await readFile("public/saint-stage.js", "utf8");
assert.doesNotMatch(saintStageSource, /addEventListener\(["']dblclick["']/, "double-click must not open saint details");
assert.match(saintStageSource, /addEventListener\(["']contextmenu["']/, "two-finger and right-click must open saint details");
assert.doesNotMatch(saintStageSource, /event\.detail|clickTimer|setTimeout/, "every rapid left click must advance the saint immediately");
assert.match(styles, /\.saint-artifact:focus-visible\s*\{\s*outline:\s*none;/, "the saint button must not draw a rectangular focus artifact");

const audioMarkup = html.match(/<section id="view-audio"[\s\S]*?<div class="audio-control-bridge"/)?.[0] || "";
assert.doesNotMatch(audioMarkup, /audio-settings-disclosure|audio-volume-line/, "playback should not expose redundant session or volume controls");
assert.equal(
  [...audioMarkup.matchAll(/<details class="audio-library-group/g)].length,
  4,
  "each sound category should be a compact disclosure"
);
assert.doesNotMatch(audioMarkup, /<details class="audio-library-group[^>]*\sopen(?:\s|>)/, "the sound library should start collapsed");
assert.match(audioMarkup, /id="focusSoundPlayButton"/, "play and pause must remain outside the collapsed settings");
