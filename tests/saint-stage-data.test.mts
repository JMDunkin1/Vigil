import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  CHRIST_PANTOCRATOR,
  coerceStagePortraitId,
  nextStagePortraitId,
  previousStagePortraitId,
  SAINT_PATRONS,
  saintArtworkPath,
  SAINT_STAGE_PORTRAITS
} from "../public/saint-stage.js";

assert.deepEqual(
  SAINT_PATRONS.map((saint) => saint.id),
  ["michael", "augustine", "mary", "joseph", "thomas", "benedict", "pio"],
  "the home stage must rotate through the complete patron-saint set"
);
assert.equal(new Set(SAINT_PATRONS.map((saint) => saint.id)).size, SAINT_PATRONS.length, "saint scene IDs must be unique");
for (const saint of SAINT_PATRONS) {
  assert.ok(saint.name.trim(), `${saint.id} must have a display name`);
  assert.ok(saint.epithet.trim(), `${saint.id} must have an epithet or detail`);
  assert.ok(saint.quote.trim(), `${saint.id} must have a quote`);
  assert.ok(saint.source.trim(), `${saint.id} must identify the quote or tradition`);
}

assert.equal(CHRIST_PANTOCRATOR.id, "christ");
assert.equal(CHRIST_PANTOCRATOR.name, "Jesus Christ Pantocrator");
assert.match(CHRIST_PANTOCRATOR.epithet, /Ruler of All/u);
assert.match(CHRIST_PANTOCRATOR.source, /John 8:12/u);
assert.deepEqual(
  SAINT_STAGE_PORTRAITS.map((portrait) => portrait.id),
  [...SAINT_PATRONS.map((saint) => saint.id), "christ"],
  "the fixed traditional rotation must include Christ Pantocrator"
);
assert.equal(new Set(SAINT_STAGE_PORTRAITS.map((portrait) => portrait.id)).size, SAINT_STAGE_PORTRAITS.length);

assert.equal(nextStagePortraitId("pio"), "christ");
assert.equal(nextStagePortraitId("christ"), "michael");
assert.equal(previousStagePortraitId("michael"), "christ");
assert.equal(coerceStagePortraitId("christ"), "christ");
assert.equal(coerceStagePortraitId("unknown"), "michael");
assert.equal(saintArtworkPath("christ"), "/art/saints/traditional/christ.png");
assert.deepEqual(
  (await readdir("public/art/saints")).sort(),
  ["traditional"],
  "the retired alternate portrait assets must not remain alongside the fixed traditional set"
);

for (const portrait of SAINT_STAGE_PORTRAITS) {
  const webPath = saintArtworkPath(portrait.id);
  assert.equal(webPath, `/art/saints/traditional/${portrait.id}.png`);
  const bytes = await readFile(`public${webPath}`);
  assert.ok(bytes.length > 8, `${portrait.id} traditional artwork must not be empty`);
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${portrait.id} must be a PNG`);
}

const christArtwork = await readFile("public/art/saints/traditional/christ.png");
assert.equal(christArtwork.readUInt32BE(16), 1254, "Christ artwork must match the existing square asset width");
assert.equal(christArtwork.readUInt32BE(20), 1254, "Christ artwork must match the existing square asset height");
assert.equal(christArtwork[25], 6, "Christ artwork must retain an RGBA channel for the transparent stage silhouette");
