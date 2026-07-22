#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(projectRoot, "dist", "runtime", "extension");
const outputDir = join(projectRoot, "dist", "browser");
const manifest = JSON.parse(await readFile(join(sourceDir, "manifest.json"), "utf8"));
const storeConfig = JSON.parse(await readFile(join(projectRoot, "build", "browser-store.json"), "utf8"));
const packageEntries = [
  "manifest.json",
  "background.js",
  "content.js",
  "google-safe-search.js",
  "options.html",
  "options.js",
  "blocked.html",
  "rules.json",
  "icons/icon-16.png",
  "icons/icon-32.png",
  "icons/icon-48.png",
  "icons/icon-128.png"
];
const builtInExtensionId = (await readFile(join(projectRoot, "src", "defaults.ts"), "utf8"))
  .match(/BUILT_IN_CHROME_EXTENSION_ID\s*=\s*"([a-p]{32})"/u)?.[1];
if (!builtInExtensionId) throw new Error("Vigil's built-in trusted Chrome extension ID could not be read.");
if (manifest.manifest_version !== 3) throw new Error("The browser-store package must use Manifest V3.");
if (!/^\d+\.\d+\.\d+$/u.test(String(manifest.version || ""))) throw new Error("The extension needs a three-part store version.");
const extensionId = extensionIdFromKey(manifest.key);
if (storeConfig.extensionId !== extensionId) {
  throw new Error(`The manifest key derives ${extensionId}, but browser-store.json expects ${String(storeConfig.extensionId || "no ID")}. Upload the draft item, copy its dashboard public key into manifest.json, and align the configured item ID.`);
}
if (storeConfig.extensionId !== builtInExtensionId) {
  throw new Error(`The browser-store item ${String(storeConfig.extensionId || "has no ID")} does not match Vigil's trusted companion origin ${builtInExtensionId}.`);
}
if (typeof storeConfig.published !== "boolean" || !(typeof storeConfig.publishedVersion === "string" || storeConfig.publishedVersion === null)) {
  throw new Error("browser-store.json must explicitly record the publication gate and exact published version (or null while unpublished).");
}
if (process.argv.includes("--release")
    && (storeConfig.published !== true || storeConfig.publishedVersion !== manifest.version)) {
  throw new Error(`The browser companion cannot be release-packaged until version ${manifest.version} is published and browser-store.json records that exact published version.`);
}

for (const path of packageEntries) {
  if (!(await stat(join(sourceDir, path))).isFile()) throw new Error(`Missing extension store asset: ${path}`);
}

await mkdir(outputDir, { recursive: true });
const artifact = join(outputDir, `Vigil-Companion-${manifest.version}.zip`);
const checksumPath = join(outputDir, "extension-checksums.json");
await rm(artifact, { force: true });
await run("/usr/bin/zip", ["-q", artifact, ...packageEntries], { cwd: sourceDir });
const inventory = (await runCapture("/usr/bin/unzip", ["-Z1", artifact])).trim().split("\n").filter(Boolean);
if (JSON.stringify([...inventory].sort()) !== JSON.stringify([...packageEntries].sort())) {
  throw new Error(`The store archive inventory does not match the reviewed package allowlist: ${inventory.join(", ")}`);
}
const bytes = (await stat(artifact)).size;
const sha256 = createHash("sha256").update(await readFile(artifact)).digest("hex");
await writeFile(checksumPath, `${JSON.stringify({
  version: manifest.version,
  artifact: artifact.slice(resolve(outputDir).length + 1),
  bytes,
  sha256
}, null, 2)}\n`);
console.log(`Packaged browser-store upload: ${artifact}`);
console.log(`SHA-256: ${sha256}`);

function extensionIdFromKey(key) {
  if (typeof key !== "string" || !key.trim()) throw new Error("The extension manifest needs the Chrome Web Store item's public key.");
  let digest;
  try {
    digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16).toString("hex");
  } catch (error) {
    throw new Error("The extension manifest key is not valid base64.", { cause: error });
  }
  return digest.replace(/[0-9a-f]/gu, (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)));
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolvePromise();
      else reject(new Error(`${command} failed (${signal || code}).`));
    });
  });
}

function runCapture(command, args) {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    const child = spawn(command, args);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolvePromise(output);
      else reject(new Error(`${command} failed (${signal || code}).`));
    });
  });
}
