import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

// The Audio view is retired, but distributed recordings still need provenance.
const tracks = JSON.parse(await readFile(new URL("../public/audio/attribution.json", import.meta.url), "utf8")) as Array<{
  id: string;
  src: string;
  attribution: string;
  sourcePage: string;
  license: string;
  licenseUrl: string;
}>;
assert.equal(tracks.length, 10);
assert.equal(new Set(tracks.map((track) => track.id)).size, tracks.length);
for (const track of tracks) {
  assert.ok(track.attribution.trim(), `${track.id} must retain recording attribution`);
  assert.ok(track.license.trim());
  assert.equal(new URL(track.sourcePage).protocol, "https:");
  assert.equal(new URL(track.licenseUrl).protocol, "https:");
  assert.ok((await stat(new URL(`../public${track.src}`, import.meta.url))).size > 1_000);
}
