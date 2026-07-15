import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { minecraftAudioCatalog } from "../public/minecraft-audio-catalog.js";

interface MinecraftAssetIndex {
  objects?: Record<string, { hash?: unknown }>;
}

const trackBySourcePath = new Map(minecraftAudioCatalog.map((track) => [track.src, track]));
const indexCache = new Map<string, Promise<readonly MinecraftAssetIndex[]>>();

export async function readMinecraftAudioAsset(pathname: string, homeDirectory = homedir()): Promise<Buffer | null> {
  const track = trackBySourcePath.get(pathname);
  if (!track) return null;

  const minecraftRoot = join(homeDirectory, "Library", "Application Support", "minecraft", "assets");
  for (const index of await minecraftAssetIndexes(minecraftRoot)) {
    const hash = index.objects?.[track.resourcePath]?.hash;
    if (typeof hash !== "string" || !/^[a-f0-9]{40}$/u.test(hash)) continue;
    try {
      return await readFile(join(minecraftRoot, "objects", hash.slice(0, 2), hash));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
  return null;
}

async function minecraftAssetIndexes(minecraftRoot: string): Promise<readonly MinecraftAssetIndex[]> {
  let cached = indexCache.get(minecraftRoot);
  if (!cached) {
    cached = loadMinecraftAssetIndexes(minecraftRoot).catch((error) => {
      indexCache.delete(minecraftRoot);
      throw error;
    });
    indexCache.set(minecraftRoot, cached);
  }
  return await cached;
}

async function loadMinecraftAssetIndexes(minecraftRoot: string): Promise<readonly MinecraftAssetIndex[]> {
  let names: string[];
  try {
    names = (await readdir(join(minecraftRoot, "indexes")))
      .filter((name) => name.endsWith(".json"))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }

  const indexes: MinecraftAssetIndex[] = [];
  for (const name of names) {
    try {
      indexes.push(JSON.parse(await readFile(join(minecraftRoot, "indexes", name), "utf8")) as MinecraftAssetIndex);
    } catch (error) {
      if (!isMissingFile(error) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return indexes;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
