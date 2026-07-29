#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, open, readdir, readFile, readlink, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { resolveMacBuildVersion } from "./mac-build-version.mjs";
import { verifyEntitlementObject, verifyEntitlementSource } from "./release-entitlements.mjs";

if (process.platform !== "darwin") throw new Error("Developer ID releases must be built and verified on macOS.");
const buildVersion = resolveMacBuildVersion(process.env, { requireExplicit: true });
const releaseCommit = (await runCapture("git", ["rev-parse", "HEAD"])).trim().toLowerCase();
if (!/^[a-f0-9]{40}$/u.test(releaseCommit)) throw new Error("The release commit could not be verified.");
if ((await runCapture("git", ["status", "--porcelain=v1"])).trim()) {
  throw new Error("Developer ID releases require a clean source checkout.");
}
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

// The repository path is intentionally a symlink into the user's cache.
// Resolve it once so every artifact pathname handed to trust tools is pinned
// to the canonical release output directory.
const outputDir = await realpath(join(process.cwd(), "dist", "mac.noindex"));
const entries = await readdir(outputDir, { withFileTypes: true });
const dmgNames = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".dmg")).map((entry) => entry.name).sort();
if (dmgNames.length !== 1) throw new Error(`Expected exactly one release DMG, found ${dmgNames.length}.`);
const dmgPath = join(outputDir, dmgNames[0]);
await run("xcrun", ["stapler", "staple", dmgPath]);
const releaseVersion = String(process.env.npm_package_version || "");
const releaseTeamIdentifier = String(process.env.APPLE_TEAM_ID || "");
if (!/^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9.-]+)?$/u.test(releaseVersion)) {
  throw new Error("The release version is missing or malformed.");
}
if (!/^[A-Z0-9]{10}$/u.test(releaseTeamIdentifier)) {
  throw new Error("APPLE_TEAM_ID must be the exact ten-character signing team identifier.");
}
const initialDigest = await hashPinnedRegularFile(dmgPath, "release DMG");
const releaseManifest = {
  kind: "vigil-macos-release-v1",
  schemaVersion: 1,
  channel: "stable",
  version: releaseVersion,
  buildVersion,
  commit: releaseCommit,
  artifact: basename(dmgPath),
  bytes: initialDigest.bytes,
  sha256: initialDigest.sha256,
  appIdentifier: "tech.caseline.vigil",
  teamIdentifier: releaseTeamIdentifier
};
await Promise.all([
  run("spctl", [
    "--assess",
    "--type", "open",
    "--context", "context:primary-signature",
    "--verbose=2",
    dmgPath
  ]),
  run("xcrun", ["stapler", "validate", dmgPath])
]);
const trustedDigest = await hashPinnedRegularFile(dmgPath, "trusted release DMG");
assertSameDigest(initialDigest, trustedDigest, "The trusted release DMG changed before it could be mounted.");

const mountRoot = await mkdtemp(join(tmpdir(), "vigil-release-mount-"));
let attachAttempted = false;
let releaseVerificationError;
try {
  attachAttempted = true;
  await run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountRoot, dmgPath]);
  const mountedEntries = await readdir(mountRoot, { withFileTypes: true });
  const appPaths = mountedEntries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"))
    .map((entry) => join(mountRoot, entry.name));
  if (appPaths.length !== 1) throw new Error(`Expected exactly one release app on the mounted DMG, found ${appPaths.length}.`);
  const appPath = appPaths[0];
  await run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  await run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]);
  await run("xcrun", ["stapler", "validate", appPath]);
  await verifyReleaseAppManifest(appPath, releaseManifest);
  for (const signedPath of await discoverSignedCode(appPath)) await verifySignedPath(signedPath, signedPath.endsWith(".app"));
} catch (error) {
  releaseVerificationError = error;
}
const releaseCleanupErrors = await cleanupReleaseMount({ attachAttempted, mountRoot });
if (releaseVerificationError !== undefined) {
  preservePrimaryError(releaseVerificationError, releaseCleanupErrors);
  throw releaseVerificationError;
}
if (releaseCleanupErrors.length > 0) {
  throw new AggregateError(releaseCleanupErrors, "The verified release DMG mount could not be safely cleaned up.");
}

const finalDigest = await hashPinnedRegularFile(dmgPath, "verified release DMG");
assertSameDigest(initialDigest, finalDigest, "The release DMG changed while its packaged app was being verified.");
const manifestPath = join(outputDir, "release-checksums.json");
await writeFile(manifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, { mode: 0o644 });
console.log(`Verified notarized release: ${dmgPath}`);
console.log(`SHA-256: ${releaseManifest.sha256}`);

async function verifyReleaseAppManifest(appPath, manifest) {
  const [info, signing, buildInfo] = await Promise.all([
    parsePlist(join(appPath, "Contents", "Info.plist")),
    runCapture("codesign", ["-dvvv", appPath]),
    readPackagedBuildInfo(appPath)
  ]);
  if (info.CFBundleIdentifier !== manifest.appIdentifier) {
    throw new Error("The packaged app identifier does not match the release manifest.");
  }
  if (info.CFBundleShortVersionString !== manifest.version || info.CFBundleVersion !== manifest.buildVersion) {
    throw new Error("The packaged app version and build do not match the release manifest.");
  }
  const signedIdentifier = signing.match(/^Identifier=(.+)$/mu)?.[1]?.trim() || "";
  const signedTeam = signing.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || "";
  const authorities = [...signing.matchAll(/^Authority=(.+)$/gmu)].map((match) => String(match[1] || "").trim());
  if (signedIdentifier !== manifest.appIdentifier || signedTeam !== manifest.teamIdentifier) {
    throw new Error("The packaged app code-signing identity does not match the release manifest.");
  }
  if (!authorities.some((authority) => authority.startsWith("Developer ID Application:"))) {
    throw new Error("The packaged app is not signed by a Developer ID Application identity.");
  }
  if (buildInfo.commit !== manifest.commit || buildInfo.dirty !== false) {
    throw new Error("The packaged app build metadata does not match the clean release commit.");
  }
}

async function readPackagedBuildInfo(appPath) {
  const path = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "build-info.json"
  );
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error("The packaged app has no valid unpacked build metadata.", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The packaged app build metadata is malformed.");
  }
  return parsed;
}

async function hashPinnedRegularFile(path, label) {
  const absolutePath = resolve(path);
  const canonicalPath = await realpath(absolutePath);
  if (canonicalPath !== absolutePath) throw new Error(`The ${label} must be a canonical regular file.`);
  let digest;
  let handle;
  let primaryError;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > 8 * 1024 * 1024 * 1024) {
      throw new Error(`The ${label} must be a bounded nonempty regular file.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error(`The ${label} ended while it was being hashed.`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const [after, pathname] = await Promise.all([handle.stat(), lstat(absolutePath)]);
    assertPinnedFileUnchanged(before, after, pathname, offset, label);
    digest = { bytes: offset, sha256: hash.digest("hex") };
  } catch (error) {
    primaryError = error;
  }
  const closeErrors = [];
  if (handle) {
    try {
      await handle.close();
    } catch (error) {
      closeErrors.push(new Error(`The ${label} file descriptor could not be closed.`, { cause: error }));
    }
  }
  if (primaryError !== undefined) {
    preservePrimaryError(primaryError, closeErrors);
    throw primaryError;
  }
  if (closeErrors.length > 0) throw new AggregateError(closeErrors, `The ${label} file descriptor could not be closed.`);
  if (!digest) throw new Error(`The ${label} digest was not produced.`);
  return digest;
}

function assertPinnedFileUnchanged(before, after, pathname, bytesRead, label) {
  if (!pathname.isFile()
    || pathname.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
    || before.birthtimeMs !== after.birthtimeMs
    || before.ctimeMs !== after.ctimeMs
    || before.mtimeMs !== after.mtimeMs
    || after.dev !== pathname.dev
    || after.ino !== pathname.ino
    || after.size !== pathname.size
    || after.birthtimeMs !== pathname.birthtimeMs
    || after.ctimeMs !== pathname.ctimeMs
    || after.mtimeMs !== pathname.mtimeMs
    || bytesRead !== after.size) {
    throw new Error(`The ${label} changed while it was being hashed.`);
  }
}

function assertSameDigest(expected, actual, message) {
  if (expected.bytes !== actual.bytes || expected.sha256 !== actual.sha256) throw new Error(message);
}

async function cleanupReleaseMount({ attachAttempted, mountRoot }) {
  const cleanupErrors = [];
  if (attachAttempted) {
    try {
      await run("hdiutil", ["detach", mountRoot]);
    } catch {
      try {
        await run("hdiutil", ["detach", "-force", mountRoot]);
      } catch (error) {
        cleanupErrors.push(new Error("The release DMG could not be detached.", { cause: error }));
      }
    }
  }
  try {
    await rmdir(mountRoot);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      cleanupErrors.push(new Error(`The release mount directory ${mountRoot} could not be removed.`, { cause: error }));
    }
  }
  return cleanupErrors;
}

function preservePrimaryError(primaryError, cleanupErrors) {
  if (!(primaryError instanceof Error) || cleanupErrors.length === 0) return;
  try {
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: cleanupErrors
    });
  } catch {
    // Never replace the authoritative release failure with a cleanup detail.
  }
}

function isErrorCode(error, code) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

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
  await verifyEntitlementSource(source, label, {
    requireJit,
    allowOnlyJit: true,
    parse: (value) => parsePlist("-", value)
  });
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
