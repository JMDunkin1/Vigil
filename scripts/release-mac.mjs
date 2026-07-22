#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolveMacBuildVersion } from "./mac-build-version.mjs";
import { verifyEntitlementObject } from "./release-entitlements.mjs";

if (process.platform !== "darwin") throw new Error("Developer ID releases must be built and verified on macOS.");
const buildVersion = resolveMacBuildVersion(process.env, { requireExplicit: true });
await verifyPublishedBrowserCompanion();
for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_TEAM_ID"]) {
  if (!process.env[name]) throw new Error(`Missing required release secret: ${name}`);
}
await access(process.env.APPLE_API_KEY);
const keyStat = await stat(process.env.APPLE_API_KEY);
if (!keyStat.isFile()) throw new Error("APPLE_API_KEY must point to a p8 file.");
if ((keyStat.mode & 0o077) !== 0) throw new Error("APPLE_API_KEY must have mode 600.");
await verifyEntitlements("build/mac-entitlements.plist");
await verifyEntitlements("build/mac-entitlements-inherit.plist");

await run("npx", [
  "electron-builder", "--mac", "dmg",
  "--universal",
  "-c.mac.hardenedRuntime=true",
  "-c.mac.gatekeeperAssess=true",
  "-c.mac.entitlements=build/mac-entitlements.plist",
  "-c.mac.entitlementsInherit=build/mac-entitlements-inherit.plist",
  "-c.mac.notarize=true",
  `-c.buildVersion=${buildVersion}`
]);

const outputDir = join(process.cwd(), "dist", "mac.noindex");
const entries = await readdir(outputDir, { withFileTypes: true });
const dmgNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dmg")).map((entry) => entry.name).sort();
if (dmgNames.length !== 1) throw new Error(`Expected exactly one release DMG, found ${dmgNames.length}.`);
const dmgPath = join(outputDir, dmgNames[0]);
await run("xcrun", ["stapler", "staple", dmgPath]);
await run("xcrun", ["stapler", "validate", dmgPath]);

const mountRoot = await mkdtemp(join(tmpdir(), "vigil-release-mount-"));
let mounted = false;
try {
  await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmgPath]);
  mounted = true;
  const mountedEntries = await readdir(mountRoot, { withFileTypes: true });
  const appPaths = mountedEntries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => join(mountRoot, entry.name));
  if (appPaths.length !== 1) throw new Error(`Expected exactly one release app on the mounted DMG, found ${appPaths.length}.`);
  const appPath = appPaths[0];
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  await run("xcrun", ["stapler", "validate", appPath]);
  for (const signedPath of await discoverSignedCode(appPath)) await verifySignedPath(signedPath, signedPath.endsWith(".app"));
} finally {
  if (mounted) await run("hdiutil", ["detach", mountRoot]).catch(async () => await run("hdiutil", ["detach", "-force", mountRoot]));
  await rm(mountRoot, { recursive: true, force: true });
}

const bytes = (await stat(dmgPath)).size;
const sha256 = createHash("sha256").update(await readFile(dmgPath)).digest("hex");
const manifestPath = join(outputDir, "release-checksums.json");
await writeFile(manifestPath, `${JSON.stringify({
  version: process.env.npm_package_version,
  buildVersion,
  artifact: basename(dmgPath),
  bytes,
  sha256
}, null, 2)}\n`, { mode: 0o644 });
console.log(`Verified notarized release: ${dmgPath}`);
console.log(`SHA-256: ${sha256}`);

async function verifyPublishedBrowserCompanion() {
  const [manifest, storeConfig, defaultsSource] = await Promise.all([
    readFile("extension/manifest.json", "utf8").then(JSON.parse),
    readFile("build/browser-store.json", "utf8").then(JSON.parse),
    readFile("src/defaults.ts", "utf8")
  ]);
  const builtInExtensionId = defaultsSource.match(/BUILT_IN_CHROME_EXTENSION_ID\s*=\s*"([a-p]{32})"/u)?.[1];
  if (!builtInExtensionId) throw new Error("Vigil's trusted browser companion ID could not be read.");
  const digest = createHash("sha256").update(Buffer.from(String(manifest.key || ""), "base64")).digest().subarray(0, 16).toString("hex");
  const extensionId = digest.replace(/[0-9a-f]/gu, (nibble) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(nibble, 16)));
  if (storeConfig.extensionId !== extensionId) throw new Error("The Chrome Web Store item ID does not match the browser companion manifest key.");
  if (storeConfig.extensionId !== builtInExtensionId) throw new Error("The Chrome Web Store item ID does not match Vigil's trusted companion origin.");
  if (storeConfig.published !== true || storeConfig.publishedVersion !== manifest.version) {
    throw new Error(`Chrome Web Store companion version ${String(manifest.version || "(missing)")} must be reviewed, publicly installable, and recorded as the exact published version before producing a consumer Mac release.`);
  }
}

async function verifyEntitlements(path) {
  verifyEntitlementObject(await parsePlist(path), path, { requireJit: true });
}

async function verifyEmittedEntitlements(source, label, requireJit) {
  verifyEntitlementObject(await parsePlist("-", source), label, { requireJit, allowOnlyJit: true });
}

async function verifySignedPath(path, requireJit) {
  await run("codesign", ["--verify", "--strict", "--verbose=2", path]);
  if ((await stat(path)).isFile()) {
    await run("lipo", [path, "-verify_arch", "x86_64"]);
    await run("lipo", [path, "-verify_arch", "arm64"]);
  }
  const signing = await runCapture("codesign", ["-dvv", path]);
  const signedTeam = signing.match(/^TeamIdentifier=(.+)$/mu)?.[1] || "";
  const authority = signing.match(/^Authority=(.+)$/mu)?.[1] || "";
  if (signedTeam !== process.env.APPLE_TEAM_ID) throw new Error(`${path} is not signed by the expected Apple team.`);
  if (!authority.startsWith("Developer ID Application:")) throw new Error(`${path} does not have the expected Developer ID Application authority.`);
  const emittedEntitlements = await runCapture("codesign", ["-d", "--entitlements", ":-", path], { includeStderr: false });
  await verifyEmittedEntitlements(emittedEntitlements, path, requireJit);
}

async function parsePlist(path, source) {
  const output = await runCapture("plutil", ["-convert", "json", "-o", "-", path], { input: source });
  return JSON.parse(output);
}

async function discoverSignedCode(appPath) {
  const appRoot = resolve(appPath);
  const paths = [appPath];
  const visitedDirectories = new Set();
  await visit(appRoot);
  return [...new Set(paths)];

  async function visit(directory) {
    const directoryIdentity = await realpath(directory);
    if (!insideApp(directoryIdentity, appRoot)) throw new Error(`Code traversal escaped the app bundle: ${directory}`);
    if (visitedDirectories.has(directoryIdentity)) return;
    visitedDirectories.add(directoryIdentity);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        await verifySafeSymlink(path, appRoot);
        continue;
      }
      if (entry.isDirectory()) {
        if (isCodeBundle(path)) paths.push(path);
        await visit(path);
        continue;
      }
      if (entry.isFile() && await isMachO(path)) paths.push(path);
    }
  }
}

const CODE_BUNDLE_EXTENSIONS = new Set([".app", ".appex", ".bundle", ".framework", ".plugin", ".xpc"]);

function isCodeBundle(path) {
  return CODE_BUNDLE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function verifySafeSymlink(path, appRoot) {
  const target = await readlink(path);
  const lexicalTarget = resolve(dirname(path), target);
  if (!insideApp(lexicalTarget, appRoot)) throw new Error(`Symlink escapes the app bundle: ${path} -> ${target}`);
  let resolvedTarget;
  try {
    resolvedTarget = await realpath(path);
  } catch (error) {
    throw new Error(`Unsafe or looping symlink in app bundle: ${path} -> ${target}.`, { cause: error });
  }
  if (!insideApp(resolvedTarget, appRoot)) throw new Error(`Symlink resolves outside the app bundle: ${path} -> ${resolvedTarget}`);
  const targetStat = await lstat(resolvedTarget);
  const executableTarget = targetStat.isFile() && await isMachO(resolvedTarget);
  const codeBundleTarget = targetStat.isDirectory() && isCodeBundle(resolvedTarget);
  if ((executableTarget || codeBundleTarget) && !expectedFrameworkCodeSymlink(path)) {
    throw new Error(`Unexpected executable-code symlink in app bundle: ${path} -> ${target}`);
  }
}

function expectedFrameworkCodeSymlink(path) {
  const parts = resolve(path).split(sep);
  const frameworkIndex = parts.findLastIndex((part) => part.endsWith(".framework"));
  if (frameworkIndex === -1) return false;
  const frameworkName = basename(parts[frameworkIndex], ".framework");
  return basename(path) === frameworkName;
}

function insideApp(path, appRoot) {
  const child = relative(appRoot, resolve(path));
  return child === "" || (!child.startsWith(`..${sep}`) && child !== "..");
}

async function isMachO(path) {
  const handle = await open(path, "r");
  try {
    const magic = Buffer.alloc(4);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (bytesRead !== 4) return false;
    return new Set([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]).has(magic.readUInt32BE(0));
  } finally {
    await handle.close();
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve();
      else reject(new Error(`${command} failed (${signal || code}).`));
    });
  });
}

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const child = spawn(command, args, { env: process.env });
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => {
      errorOutput += chunk;
      if (options.includeStderr !== false) output += chunk;
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 && !signal) resolve(output);
      else reject(new Error(`${command} failed (${signal || code}). ${output}${options.includeStderr === false ? errorOutput : ""}`));
    });
  });
}
