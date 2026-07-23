#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import asar from "@electron/asar";
import {
  localMacShellDescriptor,
  localMacShellMarkerMatches,
  readLocalMacShellMarker
} from "./local-mac-shell.mjs";
import { isLocallyRebuildableSignature } from "./mac-signing-identity.mjs";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const APP_NAME = "Vigil.app";
const APP_IDENTIFIER = "tech.caseline.vigil";
const APP_EXECUTABLE = "Vigil";
const APP_OUTPUT_DIRECTORY = "mac-universal";
const PACKAGING_TIMEOUT_MS = 20 * 60_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EXCLUDED_RUNTIME_SCRIPTS = new Set([
  "build-ios-social-app.mjs",
  "copy-assets.mjs",
  "dev-server.mjs",
  "ios-phone-suite.mjs",
  "run-tests.mjs",
  "test-ios-social.mjs",
  "write-build-info.mjs"
]);
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca]);

if (await isDirectRun(import.meta.url, process.argv[1])) await main();

async function main() {
  if (process.platform !== "darwin") throw new Error("The fast local Vigil packager is available only on macOS.");
  const options = parseArgs(process.argv.slice(2));
  const descriptor = await localMacShellDescriptor(projectRoot);
  const template = await assessFastLocalTemplate(options.templateAppPath, descriptor);
  if (!template.compatible) {
    console.log(`Fast local package unavailable (${template.reason}); using the complete Electron packager.`);
    const fullStartedAt = Date.now();
    const code = await runInherited(process.execPath, [
      join(projectRoot, "scripts", "package-mac.mjs"),
      "dir",
      `-c.directories.output=${options.outputRoot}`
    ], projectRoot, PACKAGING_TIMEOUT_MS);
    if (code !== 0) {
      process.exitCode = code ?? 1;
      return;
    }
    const builtAppPath = localBuiltAppPath(options.outputRoot);
    const marker = await readLocalMacShellMarker(builtAppPath);
    if (!localMacShellMarkerMatches(marker, descriptor)) {
      throw new Error("The complete local package did not emit the expected signed shell compatibility marker.");
    }
    console.log(`Complete local package finished in ${formatSeconds(Date.now() - fullStartedAt)}s.`);
    return;
  }

  const startedAt = Date.now();
  const result = await buildFastLocalApp({
    descriptor,
    outputRoot: options.outputRoot,
    projectRoot,
    templateAppPath: options.templateAppPath,
    templateSignature: template.signature
  });
  console.log(
    `Fast local payload packaged in ${formatSeconds(Date.now() - startedAt)}s `
    + `(${result.reusedMachOCount} native helper${result.reusedMachOCount === 1 ? "" : "s"} reused, `
    + `${result.signedMachOCount} re-signed).`
  );
}

export async function assessFastLocalTemplate(templateAppPath, expectedDescriptor) {
  const appStats = await lstat(templateAppPath);
  if (!appStats.isDirectory() || appStats.isSymbolicLink()) {
    throw new Error("The installed Vigil template is not a safe app directory.");
  }
  await runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", templateAppPath]);
  const signature = await codeSignatureMetadata(templateAppPath);
  if (signature.identifier !== APP_IDENTIFIER) {
    throw new Error("The installed Vigil template has an unexpected code-signing identifier.");
  }
  if (templateSigningIdentityDisposition(signature, expectedDescriptor.signingIdentity) === "fallback") {
    return { compatible: false, reason: "the selected local signing identity changed" };
  }

  let marker;
  try {
    marker = await readLocalMacShellMarker(templateAppPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { compatible: false, reason: "the installed app predates fast payload rebuilds" };
    throw error;
  }
  if (!localMacShellMarkerMatches(marker, expectedDescriptor)) {
    return { compatible: false, reason: "the installed Electron shell differs from this checkout" };
  }

  const infoPath = join(templateAppPath, "Contents", "Info.plist");
  const [identifier, executable, electronVersion, architectures] = await Promise.all([
    plistValue(infoPath, "CFBundleIdentifier"),
    plistValue(infoPath, "CFBundleExecutable"),
    plistValue(join(templateAppPath, "Contents", "Frameworks", "Electron Framework.framework", "Resources", "Info.plist"), "CFBundleVersion"),
    captureChecked("/usr/bin/lipo", ["-archs", join(templateAppPath, "Contents", "MacOS", APP_EXECUTABLE)])
  ]);
  if (identifier !== expectedDescriptor.appId || identifier !== APP_IDENTIFIER) {
    return { compatible: false, reason: "the installed app identifier differs" };
  }
  if (executable !== APP_EXECUTABLE) return { compatible: false, reason: "the installed executable layout differs" };
  if (electronVersion !== expectedDescriptor.electronVersion) return { compatible: false, reason: "the installed Electron version differs" };
  const expectedArchitecture = expectedDescriptor.architecture === "x64" ? "x86_64" : expectedDescriptor.architecture;
  if (!architectures.trim().split(/\s+/u).includes(expectedArchitecture)) {
    return { compatible: false, reason: "the installed app architecture differs" };
  }
  return { compatible: true, reason: null, signature };
}

export async function buildFastLocalApp({ descriptor, outputRoot, projectRoot: root, templateAppPath, templateSignature }) {
  if (!isAbsolute(outputRoot) || !isAbsolute(templateAppPath)) {
    throw new Error("Fast local packaging requires absolute output and template app paths.");
  }
  const candidateAppPath = localBuiltAppPath(outputRoot);
  const candidateParent = dirname(candidateAppPath);
  await mkdir(candidateParent, { recursive: true });
  if (await pathExists(candidateAppPath)) throw new Error("The fast local package output path is already occupied.");
  await runChecked("/bin/cp", ["-ac", templateAppPath, candidateAppPath], { timeoutMs: PACKAGING_TIMEOUT_MS });
  const [templateStats, candidateStats] = await Promise.all([lstat(templateAppPath), lstat(candidateAppPath)]);
  if (!candidateStats.isDirectory() || candidateStats.isSymbolicLink()
    || (candidateStats.dev === templateStats.dev && candidateStats.ino === templateStats.ino)) {
    await rm(candidateAppPath, { recursive: true, force: true });
    throw new Error("The fast local package did not create a distinct candidate app directory.");
  }
  try {
    await runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", candidateAppPath]);
    const clonedSignature = await codeSignatureMetadata(candidateAppPath);
    assertTemplateCloneContinuity(templateSignature, clonedSignature);
    const clonedMarker = await readLocalMacShellMarker(candidateAppPath);
    if (!localMacShellMarkerMatches(clonedMarker, descriptor)) {
      throw new Error("The cloned installed app no longer matches the assessed reusable shell.");
    }
  } catch (error) {
    await rm(candidateAppPath, { recursive: true, force: true });
    throw error;
  }

  const payloadRoot = await mkdtemp(join(outputRoot, ".vigil-payload-"));
  try {
    await preparePayloadRoot(root, payloadRoot);
    const nativePreparation = await preparePayloadMachOFiles(root, candidateAppPath, payloadRoot, descriptor.signingIdentity);
    const resourcesPath = join(candidateAppPath, "Contents", "Resources");
    const appAsarPath = join(resourcesPath, "app.asar");
    await rm(appAsarPath, { force: true });
    await rm(`${appAsarPath}.unpacked`, { recursive: true, force: true });
    await asar.createPackageWithOptions(payloadRoot, appAsarPath, { unpackDir: "dist/runtime" });
    await runChecked("/usr/bin/xattr", ["-cr", appAsarPath]);
    await runChecked("/usr/bin/xattr", ["-cr", `${appAsarPath}.unpacked`]);
    await updateElectronAsarIntegrity(candidateAppPath, appAsarPath);
    await signOuterApp(root, candidateAppPath, descriptor.signingIdentity);
    await runChecked("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", candidateAppPath]);
    const candidateSignature = await codeSignatureMetadata(candidateAppPath);
    assertSignatureContinuity(templateSignature, candidateSignature);
    const marker = await readLocalMacShellMarker(candidateAppPath);
    if (!localMacShellMarkerMatches(marker, descriptor)) {
      throw new Error("The fast local package lost its shell compatibility marker.");
    }
    return nativePreparation;
  } catch (error) {
    await rm(candidateAppPath, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally {
    await rm(payloadRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function preparePayloadRoot(root, payloadRoot) {
  const runtimeRoot = join(root, "dist", "runtime");
  const runtimeStats = await lstat(runtimeRoot);
  if (!runtimeStats.isDirectory() || runtimeStats.isSymbolicLink()) {
    throw new Error("The rebuilt Vigil runtime is not a safe directory.");
  }
  await copyFile(join(root, "package.json"), join(payloadRoot, "package.json"));
  await mkdir(join(payloadRoot, "dist"), { recursive: true });
  await cp(runtimeRoot, join(payloadRoot, "dist", "runtime"), {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter(source) {
      const path = relative(runtimeRoot, source);
      return packagedRuntimePathIncluded(path);
    }
  });
  await assertPayloadTreeSafe(payloadRoot);
}

export function packagedRuntimePathIncluded(relativePath) {
  if (!relativePath) return true;
  const normalized = relativePath.split(sep).join("/");
  const parts = normalized.split("/");
  if (parts[0] === "tests") return false;
  if (parts[0] === "scripts" && parts.length === 2 && EXCLUDED_RUNTIME_SCRIPTS.has(parts[1])) return false;
  return !/(?:^|\/)\S* [0-9][^/]*$/u.test(normalized);
}

async function assertPayloadTreeSafe(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Fast local packaging does not accept symlinks in the rebuilt app payload.");
  }
}

async function preparePayloadMachOFiles(root, templateAppPath, payloadRoot, signingIdentity) {
  const payloadRuntime = join(payloadRoot, "dist", "runtime");
  const templateRuntime = join(templateAppPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime");
  const machOPaths = await findMachOFiles(payloadRuntime);
  let reusedMachOCount = 0;
  let signedMachOCount = 0;
  for (const payloadPath of machOPaths) {
    const relativePath = relative(payloadRuntime, payloadPath);
    const templatePath = join(templateRuntime, relativePath);
    if (await pathExists(templatePath)
      && await codeSignatureIsValid(templatePath)
      && await machOPayloadsMatchIgnoringSignature(templatePath, payloadPath, dirname(payloadRoot))) {
      await copyFile(templatePath, payloadPath);
      await chmod(payloadPath, (await stat(templatePath)).mode & 0o777);
      reusedMachOCount += 1;
      continue;
    }
    await signMachO(root, payloadPath, signingIdentity);
    signedMachOCount += 1;
  }
  return { reusedMachOCount, signedMachOCount };
}

async function findMachOFiles(root) {
  const result = [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const handle = await open(path, "r");
    try {
      const magic = Buffer.alloc(4);
      if ((await handle.read(magic, 0, 4, 0)).bytesRead === 4 && MACHO_MAGICS.has(magic.readUInt32BE(0))) result.push(path);
    } finally {
      await handle.close();
    }
  }
  return result.sort();
}

async function codeSignatureIsValid(path) {
  try {
    await runChecked("/usr/bin/codesign", ["--verify", "--strict", path]);
    return true;
  } catch {
    return false;
  }
}

export async function machOPayloadsMatchIgnoringSignature(signedPath, rebuiltPath, temporaryParent) {
  const root = await mkdtemp(join(temporaryParent, ".macho-compare-"));
  const signedCopy = join(root, `signed-${randomUUID()}`);
  const rebuiltCopy = join(root, `rebuilt-${randomUUID()}`);
  try {
    await Promise.all([copyFile(signedPath, signedCopy), copyFile(rebuiltPath, rebuiltCopy)]);
    await Promise.all([
      runChecked("/usr/bin/codesign", ["--remove-signature", signedCopy]),
      runChecked("/usr/bin/codesign", ["--remove-signature", rebuiltCopy])
    ]);
    const [signedBytes, rebuiltBytes] = await Promise.all([readFile(signedCopy), readFile(rebuiltCopy)]);
    return normalizeUnsignedMachO(signedBytes).equals(normalizeUnsignedMachO(rebuiltBytes));
  } catch {
    return false;
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function normalizeUnsignedMachO(input) {
  const bytes = Buffer.from(input);
  for (const slice of machOSlices(bytes)) normalizeMachOSlice(bytes, slice.offset);
  return bytes;
}

function machOSlices(bytes) {
  const magic = bytes.readUInt32BE(0);
  if (magic === 0xcafebabe || magic === 0xbebafeca) {
    const littleEndian = magic === 0xbebafeca;
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const count = read32.call(bytes, 4);
    const slices = [];
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * 20;
      slices.push({ offset: read32.call(bytes, base + 8), size: read32.call(bytes, base + 12) });
    }
    return slices;
  }
  if (magic === 0xcafebabf || magic === 0xbfbafeca) {
    const littleEndian = magic === 0xbfbafeca;
    const read32 = littleEndian ? Buffer.prototype.readUInt32LE : Buffer.prototype.readUInt32BE;
    const read64 = littleEndian ? Buffer.prototype.readBigUInt64LE : Buffer.prototype.readBigUInt64BE;
    const count = read32.call(bytes, 4);
    const slices = [];
    for (let index = 0; index < count; index += 1) {
      const base = 8 + index * 32;
      slices.push({ offset: Number(read64.call(bytes, base + 8)), size: Number(read64.call(bytes, base + 16)) });
    }
    return slices;
  }
  return [{ offset: 0, size: bytes.length }];
}

function normalizeMachOSlice(bytes, sliceOffset) {
  const magic = bytes.readUInt32LE(sliceOffset);
  if (magic !== 0xfeedfacf) throw new Error("Fast helper comparison supports only 64-bit little-endian Mach-O slices.");
  const commandCount = bytes.readUInt32LE(sliceOffset + 16);
  let commandOffset = sliceOffset + 32;
  for (let index = 0; index < commandCount; index += 1) {
    const command = bytes.readUInt32LE(commandOffset);
    const commandSize = bytes.readUInt32LE(commandOffset + 4);
    if (commandSize < 8 || commandOffset + commandSize > bytes.length) throw new Error("The Mach-O load commands are malformed.");
    if (command === 0x19) {
      const segment = bytes.subarray(commandOffset + 8, commandOffset + 24).toString("ascii").replace(/\0.*$/u, "");
      if (segment === "__LINKEDIT") {
        bytes.fill(0, commandOffset + 32, commandOffset + 40);
        bytes.fill(0, commandOffset + 48, commandOffset + 56);
      }
    }
    commandOffset += commandSize;
  }
}

async function signMachO(root, path, signingIdentity) {
  const args = ["--force", "--sign", signingIdentity, "--options", "runtime"];
  if (signingIdentity !== "-") args.push("--timestamp=none");
  args.push("--entitlements", join(root, "build", "mac-entitlements-inherit.plist"), path);
  await runChecked("/usr/bin/codesign", args);
  await runChecked("/usr/bin/codesign", ["--verify", "--strict", path]);
}

async function signOuterApp(root, appPath, signingIdentity) {
  const args = ["--force", "--sign", signingIdentity, "--options", "runtime"];
  if (signingIdentity !== "-") args.push("--timestamp=none");
  args.push("--entitlements", join(root, "build", "mac-entitlements.plist"), appPath);
  await runChecked("/usr/bin/codesign", args, { timeoutMs: PACKAGING_TIMEOUT_MS });
}

export async function updateElectronAsarIntegrity(appPath, appAsarPath) {
  const headerString = asar.getRawHeader(appAsarPath).headerString;
  const hash = createHash("sha256").update(headerString).digest("hex");
  const infoPath = join(appPath, "Contents", "Info.plist");
  await runChecked("/usr/libexec/PlistBuddy", [
    "-c",
    "Set :ElectronAsarIntegrity:Resources/app.asar:algorithm SHA256",
    infoPath
  ]);
  await runChecked("/usr/libexec/PlistBuddy", [
    "-c",
    `Set :ElectronAsarIntegrity:Resources/app.asar:hash ${hash}`,
    infoPath
  ]);
  await runChecked("/usr/bin/plutil", ["-lint", infoPath]);
  const [algorithm, persistedHash] = await Promise.all([
    plistValue(infoPath, "ElectronAsarIntegrity:Resources/app.asar:algorithm"),
    plistValue(infoPath, "ElectronAsarIntegrity:Resources/app.asar:hash")
  ]);
  if (algorithm !== "SHA256" || persistedHash !== hash) {
    throw new Error("The fast local package could not bind Electron to the rebuilt ASAR header.");
  }
  return hash;
}

async function codeSignatureMetadata(path) {
  const detail = await captureChecked("/usr/bin/codesign", ["-dv", "--verbose=4", path], { includeStderr: true });
  const authorities = [...detail.matchAll(/^Authority=(.+)$/gmu)].map((match) => match[1].trim());
  const adhoc = /^Signature=adhoc$/mu.test(detail);
  let leafCertificateSha256 = null;
  if (!adhoc) {
    const certificateRoot = await mkdtemp(join(tmpdir(), "vigil-codesign-certificate-"));
    const certificatePrefix = join(certificateRoot, "certificate");
    try {
      await runChecked("/usr/bin/codesign", ["-d", `--extract-certificates=${certificatePrefix}`, path]);
      leafCertificateSha256 = createHash("sha256").update(await readFile(`${certificatePrefix}0`)).digest("hex");
    } finally {
      await rm(certificateRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return {
    adhoc,
    authority: authorities[0] || null,
    cdHash: detail.match(/^CDHash=(.+)$/mu)?.[1]?.trim() || null,
    identifier: detail.match(/^Identifier=(.+)$/mu)?.[1]?.trim() || null,
    leafCertificateSha256,
    locallyRebuildable: isLocallyRebuildableSignature(detail),
    teamIdentifier: detail.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || null
  };
}

export function assertTemplateCloneContinuity(template, clone) {
  if (!template.cdHash || !clone.cdHash || template.cdHash !== clone.cdHash
    || template.adhoc !== clone.adhoc
    || template.authority !== clone.authority
    || template.identifier !== clone.identifier
    || template.leafCertificateSha256 !== clone.leafCertificateSha256
    || template.locallyRebuildable !== clone.locallyRebuildable
    || template.teamIdentifier !== clone.teamIdentifier) {
    throw new Error("The installed Vigil template changed while its reusable shell was being cloned.");
  }
}

export function templateSigningIdentityDisposition(signature, signingIdentity) {
  const matches = signingIdentity === "-"
    ? signature.adhoc
    : !signature.adhoc && signature.authority === signingIdentity;
  if (matches) return "match";
  if (signature.locallyRebuildable) return "fallback";
  throw new Error("The installed Vigil template has a distribution signature that cannot be replaced by a local build.");
}

function assertSignatureContinuity(template, candidate) {
  if (candidate.identifier !== APP_IDENTIFIER) throw new Error("The fast local candidate has an unexpected signing identifier.");
  if (template.adhoc !== candidate.adhoc
    || template.authority !== candidate.authority
    || template.leafCertificateSha256 !== candidate.leafCertificateSha256
    || template.teamIdentifier !== candidate.teamIdentifier) {
    throw new Error("The fast local candidate did not preserve the installed app's signing authority and team.");
  }
}

async function plistValue(path, key) {
  return (await captureChecked("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path])).trim();
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("Usage: package-local-mac.mjs --template-app <Vigil.app> --output <directory>");
    values.set(key.slice(2), value);
  }
  const templateAppPath = resolve(required(values, "template-app"));
  const outputRoot = resolve(required(values, "output"));
  if (basename(templateAppPath) !== APP_NAME) throw new Error("The local package template must be Vigil.app.");
  return { outputRoot, templateAppPath };
}

function localBuiltAppPath(outputRoot) {
  return join(outputRoot, APP_OUTPUT_DIRECTORY, APP_NAME);
}

function required(values, key) {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}.`);
  return value;
}

async function runInherited(command, args, cwd, timeoutMs) {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: "inherit" });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectRun(new Error(`${basename(command)} timed out.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectRun(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal) rejectRun(new Error(`${basename(command)} exited after ${signal}.`));
      else resolveRun(code);
    });
  });
}

async function runChecked(command, args, { timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  await captureChecked(command, args, { timeoutMs, includeStderr: true });
}

async function captureChecked(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, includeStderr = false } = {}) {
  return await new Promise((resolveCapture, rejectCapture) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      rejectCapture(new Error(`${basename(command)} timed out.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectCapture(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      if (signal || code !== 0) {
        rejectCapture(new Error(`${basename(command)} failed: ${(stderr || stdout).trim() || signal || code}`));
      } else {
        resolveCapture(includeStderr ? `${stdout}${stderr}` : stdout);
      }
    });
  });
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

function errorCode(error) {
  return typeof error === "object" && error !== null && "code" in error ? String(error.code || "") : "";
}

function formatSeconds(milliseconds) {
  return (milliseconds / 1_000).toFixed(2);
}

async function isDirectRun(moduleUrl, argvPath) {
  if (!argvPath) return false;
  try {
    return await realpath(fileURLToPath(moduleUrl)) === await realpath(resolve(argvPath));
  } catch {
    return fileURLToPath(moduleUrl) === resolve(argvPath);
  }
}
