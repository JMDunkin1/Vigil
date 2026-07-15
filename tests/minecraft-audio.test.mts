import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { minecraftAudioCatalog } from "../public/minecraft-audio-catalog.js";
import { readMinecraftAudioAsset } from "../src/minecraftAudio.js";

assert.equal(minecraftAudioCatalog.length, 8, "the Minecraft library should stay focused on a short classic playlist");
assert.equal(new Set(minecraftAudioCatalog.map((track) => track.id)).size, minecraftAudioCatalog.length, "Minecraft preset ids must be unique");
assert.equal(new Set(minecraftAudioCatalog.map((track) => track.resourcePath)).size, minecraftAudioCatalog.length, "Minecraft asset paths must be unique");
assert.equal(minecraftAudioCatalog.every((track) => track.id.startsWith("minecraft-")), true);
assert.equal(minecraftAudioCatalog.every((track) => track.src.endsWith(".ogg")), true);
assert.deepEqual(
  [...new Set(minecraftAudioCatalog.map((track) => track.composer))],
  ["C418"]
);
assert.deepEqual(
  minecraftAudioCatalog.map((track) => track.title),
  ["Minecraft", "Sweden", "Mice on Venus", "Wet Hands", "Dry Hands", "Subwoofer Lullaby", "Haggstrom", "Living Mice"]
);

const fixtureHome = await mkdtemp(join(tmpdir(), "vigil-minecraft-audio-"));
try {
  const track = minecraftAudioCatalog.find((candidate) => candidate.title === "Sweden");
  assert.ok(track);
  const hash = "a".repeat(40);
  const assetRoot = join(fixtureHome, "Library", "Application Support", "minecraft", "assets");
  const objectPath = join(assetRoot, "objects", hash.slice(0, 2), hash);
  await mkdir(dirname(objectPath), { recursive: true });
  await mkdir(join(assetRoot, "indexes"), { recursive: true });
  await writeFile(objectPath, Buffer.from("local Minecraft audio"));
  await writeFile(join(assetRoot, "indexes", "32.json"), JSON.stringify({
    objects: {
      [track.resourcePath]: { hash, size: 21 }
    }
  }));

  assert.equal((await readMinecraftAudioAsset(track.src, fixtureHome))?.toString(), "local Minecraft audio");
  assert.equal(await readMinecraftAudioAsset("/audio/minecraft/not-a-real-track.ogg", fixtureHome), null);
} finally {
  await rm(fixtureHome, { recursive: true, force: true });
}
