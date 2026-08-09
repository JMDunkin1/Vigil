import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/focus-sound.js", import.meta.url), "utf8");
const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
for (const expected of [
  "File:Rain_(1).ogg",
  "File:Waves.ogg",
  "File:Storm_thunderbolts.ogg",
  "File:Forest_lawn_creek.ogg",
  "Goldberg-Variationen",
  "Invention_8",
  "Italian_Concerto",
  "Harmonious_Blacksmith",
  "Kirkpatrick.87",
  "Kirkpatrick.466",
  "creativecommons.org/publicdomain/zero/1.0"
]) {
  assert.ok(source.includes(expected), `missing bundled-audio provenance: ${expected}`);
}

for (const id of ["focusSoundAttribution", "focusSoundAttributionText", "focusSoundSourceLink", "focusSoundLicenseLink", "audioSoundLibrary"]) {
  assert.doesNotMatch(html, new RegExp(`id="${id}"`), `retired Audio UI must not expose #${id}`);
}
assert.doesNotMatch(html, /data-view(?:-target)?="audio"/u, "Audio must not remain as a visible or hidden destination");
// Keep provenance in the dormant compatibility controller while old stored
// settings and packaged assets are migrated independently from this UI redo.
assert.match(source, /closest\("\.audio-library-group"\)\?\.append\(attribution\)/, "recording attribution must follow the active track into its dropdown");
assert.match(source, /attribution\.hidden = !track/);
assert.match(source, /attributionText\.textContent = track\.attribution/);
assert.match(source, /sourceLink\.href = track\.sourcePage/);
assert.match(source, /licenseLink\.href = track\.licenseUrl/);
assert.match(source, /licenseLink\.textContent = track\.license/);
