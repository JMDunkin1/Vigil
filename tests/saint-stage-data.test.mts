import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  normalizeSaintAesthetic,
  readSaintAesthetic,
  SAINT_AESTHETICS,
  SAINT_AESTHETIC_STORAGE_KEY,
  SAINT_PATRONS,
  saintArtworkPath,
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
  for (const saint of SAINT_PATRONS) {
    const webPath = saintArtworkPath(saint.id, aesthetic);
    const expectedPath = aesthetic === "serious"
      ? `/art/saints/serious/${saint.id}.png`
      : `/art/saints/${saint.id}.png`;
    assert.equal(webPath, expectedPath);
    const bytes = await readFile(`public${webPath}`);
    assert.ok(bytes.length > 8, `${aesthetic} ${saint.id} artwork must not be empty`);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${aesthetic} ${saint.id} must be a PNG`);
  }
}
