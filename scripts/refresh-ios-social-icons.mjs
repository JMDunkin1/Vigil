#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CATALOG = join(ROOT, "ios", "VigilSocial", "VigilSocial", "Assets.xcassets");
const ICON_SOURCES = join(ROOT, "ios", "VigilSocial", "VigilSocial", "Icons", "IconSources");
const OPAQUE_PNG_RENDERER = join(ROOT, "scripts", "render-opaque-png.swift");
const services = [
  { name: "YouTube", id: "544007664", set: "YouTubeAppIcon.appiconset", light: "youtube-light.png" },
  { name: "Snapchat", id: "447188370", set: "SnapchatAppIcon.appiconset", light: "snapchat-light.png" }
];
const instagramVariants = ["light", "dark", "tinted"];

const temporary = await mkdtemp(join(tmpdir(), "vigil-social-icons-"));
try {
  const provenance = { generatedAt: new Date().toISOString(), storefront: "US", services: [] };
  const variants = [];
  for (const appearance of instagramVariants) {
    const sourceName = `instagram-${appearance}.svg`;
    const outputName = `instagram-${appearance}.png`;
    const rgba = join(temporary, `rgba-${outputName}`);
    const staged = join(temporary, outputName);
    await execFileAsync("/usr/bin/sips", [
      "-s", "format", "png", join(ICON_SOURCES, sourceName), "--out", rgba
    ]);
    await execFileAsync("/usr/bin/xcrun", ["swift", OPAQUE_PNG_RENDERER, rgba, staged]);
    await validateIcon(staged, "Instagram", { requireOpaque: true });
    const bytes = await readFile(staged);
    await rename(staged, join(CATALOG, "InstagramAppIcon.appiconset", outputName));
    variants.push({
      appearance,
      source: `IconSources/${sourceName}`,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  provenance.services.push({
    name: "Instagram",
    appStoreId: "389801252",
    source: "local-pre-glass-svg",
    variants
  });

  for (const service of services) {
    const lookup = await checkedJson(`https://itunes.apple.com/lookup?id=${service.id}&country=us`);
    const item = lookup.results?.[0];
    if (!item?.artworkUrl512) throw new Error(`${service.name} App Store artwork is unavailable.`);
    const artworkUrl = item.artworkUrl512.replace(/\/512x512bb\.[a-z]+(?:\?.*)?$/i, "/1024x1024bb.png");
    const bytes = await checkedBytes(artworkUrl);
    const staged = join(temporary, service.light);
    await writeFile(staged, bytes, { mode: 0o644 });
    await validateIcon(staged, service.name);
    const destination = join(CATALOG, service.set, service.light);
    await rename(staged, destination);
    provenance.services.push({
      name: service.name,
      appStoreId: service.id,
      version: String(item.version || ""),
      artworkUrl,
      sha256: createHash("sha256").update(bytes).digest("hex")
    });
  }
  await writeFile(join(ROOT, "ios", "VigilSocial", "VigilSocial", "Icons", "app-store-artwork.json"), `${JSON.stringify(provenance, null, 2)}\n`, { mode: 0o644 });
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function checkedJson(url) {
  return JSON.parse((await checkedBytes(url)).toString("utf8"));
}

async function checkedBytes(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Icon download failed: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function validateIcon(path, name, { requireOpaque = false } = {}) {
  const { stdout } = await execFileAsync("/usr/bin/sips", [
    "-g", "pixelWidth", "-g", "pixelHeight", "-g", "hasAlpha", path
  ]);
  if (!/pixelWidth:\s+1024/.test(stdout) || !/pixelHeight:\s+1024/.test(stdout)) {
    throw new Error(`${name} artwork is not 1024×1024.`);
  }
  if (requireOpaque && !/hasAlpha:\s+no/.test(stdout)) {
    throw new Error(`${name} artwork must not contain an alpha channel.`);
  }
}
