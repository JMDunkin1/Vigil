import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const html = await readFile("public/index.html", "utf8");
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
assert.match(html, /id="accountButton"[^>]*aria-expanded="false"/, "the account button must expose its toggle state");
const sidebarMarkup = html.match(/<aside class="app-chrome"[\s\S]*?<\/aside>/)?.[0] || "";
assert.doesNotMatch(sidebarMarkup, /&#(?:8962|10016|10003|9835|10070|9881);/, "font-glyph sidebar icons must not return");
assert.doesNotMatch(html, /sidebarToggle|sidebar-toggle|data-sidebar-open|>Menu<\//, "the sidebar must never collapse into a top menu");

const styles = await readFile("public/styles.css", "utf8");
assert.doesNotMatch(styles, /data-sidebar-open|\.sidebar-toggle/, "responsive styles must not restore the collapsible top menu");
assert.doesNotMatch(styles, /@media \(max-width: 900px\)\s*\{\s*body\s*\{\s*display:\s*block/, "narrow windows must retain the sidebar grid");

const protectionMarkup = html.match(/<div id="protectionLevelControl"[\s\S]*?<div[^>]*class="home-runtime-status"/)?.[0] || "";
assert.equal(
  [...protectionMarkup.matchAll(/data-protection-level-choice="[1-4]"/g)].length,
  4,
  "the protection selector bloom must expose all four levels"
);
assert.match(protectionMarkup, /class="protection-level-scroll-hint">Scroll to choose</, "the expanded selector should explain wheel interaction");

const emergencyMarkup = html.match(/<details id="emergencyPanel"[\s\S]*?<\/details>/)?.[0] || "";
assert.match(emergencyMarkup, /<summary class="emergency-summary">/, "emergency UI must be a collapsible top drawer");
assert.match(emergencyMarkup, /id="emergencyExplanation"/, "integrity lockdowns must expose protected-maintenance guidance");
assert.doesNotMatch(emergencyMarkup, /emergency-indicator/, "the floating integrity notice must not include a misaligned status dot");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?position:\s*absolute;/, "the emergency drawer must overlay the home view instead of stretching it");
assert.match(styles, /#view-home \.emergency-drawer\s*\{[\s\S]*?top:\s*12px;[\s\S]*?width:\s*min\(420px,[\s\S]*?border-radius:\s*13px;/, "the integrity notice must float independently near the top of the home view");
assert.match(styles, /\.electron-shell \.app-chrome::before\s*\{\s*content:\s*none;/, "the title-bar drag layer must not cover the emergency drawer");
assert.match(styles, /\.electron-shell \.app-chrome\s*\{\s*-webkit-app-region:\s*drag;/, "the sidebar must remain available for window dragging");

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
