import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  CHRIST_PANTOCRATOR,
  coerceStagePortraitId,
  nextStagePortraitId,
  normalizeSaintAesthetic,
  previousStagePortraitId,
  readSaintAesthetic,
  SAINT_AESTHETICS,
  SAINT_AESTHETIC_STORAGE_KEY,
  SAINT_PATRONS,
  saintArtworkPath,
  SERIOUS_STAGE_PORTRAITS,
  stagePortraitsForAesthetic,
  writeSaintAesthetic
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
  stagePortraitsForAesthetic("playful").map((portrait) => portrait.id),
  SAINT_PATRONS.map((saint) => saint.id),
  "playful mode must remain the original seven-saint rotation"
);
assert.deepEqual(
  stagePortraitsForAesthetic("serious").map((portrait) => portrait.id),
  [...SAINT_PATRONS.map((saint) => saint.id), "christ"],
  "serious mode must add Christ Pantocrator as its final bonus portrait"
);
assert.deepEqual(stagePortraitsForAesthetic("serious"), SERIOUS_STAGE_PORTRAITS);
assert.equal(new Set(SERIOUS_STAGE_PORTRAITS.map((portrait) => portrait.id)).size, SERIOUS_STAGE_PORTRAITS.length);

assert.equal(nextStagePortraitId("pio", "playful"), "michael");
assert.equal(nextStagePortraitId("pio", "serious"), "christ");
assert.equal(nextStagePortraitId("christ", "serious"), "michael");
assert.equal(previousStagePortraitId("michael", "playful"), "pio");
assert.equal(previousStagePortraitId("michael", "serious"), "christ");
assert.equal(coerceStagePortraitId("christ", "serious"), "christ");
assert.equal(coerceStagePortraitId("christ", "playful"), "michael", "leaving serious mode must never request missing playful Christ art");
assert.equal(coerceStagePortraitId("unknown", "serious"), "michael");
assert.equal(saintArtworkPath("christ", "serious"), "/art/saints/serious/christ.png");
assert.throws(() => saintArtworkPath("christ", "playful"), /unavailable in playful mode/u);

assert.deepEqual(SAINT_AESTHETICS, ["playful", "serious"], "the artwork picker must expose both visual modes");
assert.equal(normalizeSaintAesthetic("serious"), "serious");
assert.equal(normalizeSaintAesthetic("playful"), "playful");
assert.equal(normalizeSaintAesthetic("unknown"), "playful", "unknown values must preserve the existing playful default");
assert.equal(normalizeSaintAesthetic(undefined), "playful", "missing preferences must preserve the existing playful default");

const preferences = new Map<string, string>();
const storage = {
  getItem(key: string) {
    return preferences.get(key) || null;
  },
  setItem(key: string, value: string) {
    preferences.set(key, value);
  }
};
assert.equal(readSaintAesthetic(storage), "playful");
writeSaintAesthetic(storage, "serious");
assert.equal(preferences.get(SAINT_AESTHETIC_STORAGE_KEY), "serious");
assert.equal(readSaintAesthetic(storage), "serious");

for (const aesthetic of SAINT_AESTHETICS) {
  for (const portrait of stagePortraitsForAesthetic(aesthetic)) {
    const webPath = saintArtworkPath(portrait.id, aesthetic);
    const expectedPath = aesthetic === "serious"
      ? `/art/saints/serious/${portrait.id}.png`
      : `/art/saints/${portrait.id}.png`;
    assert.equal(webPath, expectedPath);
    const bytes = await readFile(`public${webPath}`);
    assert.ok(bytes.length > 8, `${aesthetic} ${portrait.id} artwork must not be empty`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${aesthetic} ${portrait.id} must be a PNG`);
  }
}

const christArtwork = await readFile("public/art/saints/serious/christ.png");
assert.equal(christArtwork.readUInt32BE(16), 1254, "Christ artwork must match the existing square asset width");
assert.equal(christArtwork.readUInt32BE(20), 1254, "Christ artwork must match the existing square asset height");
assert.equal(christArtwork[25], 6, "Christ artwork must retain an RGBA channel for the transparent stage silhouette");
