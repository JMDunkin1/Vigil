import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../public/focus-sound.js", import.meta.url), "utf8");
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
assert.match(source, /function renderTrackAttribution[\s\S]*realAudioTrack\(preset\)/);
