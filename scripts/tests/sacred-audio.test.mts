import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { sacredAudioCatalog } from "../../public/sacred-audio-catalog.js";
import { defaultState } from "../../src/defaults.js";
import { updateSettings } from "../../src/server/settingsRoutes.js";

assert.equal(sacredAudioCatalog.length, 12);
assert.equal(new Set(sacredAudioCatalog.map((track) => track.id)).size, sacredAudioCatalog.length);
assert.equal(sacredAudioCatalog.filter((track) => track.styles.some((style) => style === "gregorian-chant")).length >= 9, true);

const settings = defaultState().settings;
for (const track of sacredAudioCatalog) {
  const path = join(process.cwd(), "public", track.src.replace(/^\//, ""));
  const info = await stat(path);
  assert.equal(info.isFile(), true, `${track.id} should be a file`);
  assert.equal(info.size > 1_000, true, `${track.id} should contain audio data`);
  const keys = updateSettings(settings, { focusSoundPreset: track.id });
  assert.deepEqual(keys, ["focusSoundPreset"]);
  assert.equal(settings.focusSoundPreset, track.id);
}

assert.equal(sacredAudioCatalog.some((track) => track.id === "rorate-caeli" && track.seasons.some((season) => season === "advent")), true);
assert.equal(sacredAudioCatalog.some((track) => track.id === "victimae-paschali-laudes" && track.seasons.some((season) => season === "easter")), true);
assert.equal(sacredAudioCatalog.some((track) => track.id === "dies-irae" && track.seasons.some((season) => season === "requiem")), true);
