#!/usr/bin/env node
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareExtensionRelease } from "../dist/runtime/src/managedChatgptExtension.js";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(projectRoot, "dist", "runtime", "extension");
const outputDir = join(projectRoot, "dist", "browser");
const manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8"));
const storeConfig = JSON.parse(await readFile(join(projectRoot, "build", "browser-store.json"), "utf8"));
if (process.argv.includes("--release")
    && (storeConfig.published !== true || storeConfig.publishedVersion !== manifest.version)) {
  throw new Error(`Chrome Web Store approval for version ${manifest.version} is required for release packaging.`);
}
await mkdir(outputDir, { recursive: true });
const temporary = await mkdtemp(join(outputDir, ".release-"));
try {
  const directory = join(temporary, "verified");
  const release = await prepareExtensionRelease(sourceDir, directory, { storePublicKey: storeConfig.publicKey });
  if (release.extensionId !== storeConfig.extensionId) throw new Error("Chrome Web Store item ID mismatch.");
  const name = `Vigil-Companion-${release.version}.zip`;
  const artifact = join(outputDir, name);
  await copyFile(join(directory, "store-upload.zip"), artifact);
  await writeFile(join(outputDir, "extension-checksums.json"), JSON.stringify({
    version: release.version, artifact: name, bytes: (await stat(artifact)).size, sha256: release.archiveSha256
  }, null, 2) + "\n");
  console.log(`Packaged browser-store upload: ${artifact}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
