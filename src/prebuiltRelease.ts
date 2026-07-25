import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import {
  captureRuntimeTreeDigest,
  runtimeTreeDigestContentsMatch
} from "./runtimeTreeDigest.js";
import type { RuntimeTreeDigest } from "./runtimeTreeDigest.js";

const execFileAsync = promisify(execFile);
const RELEASE_KIND = "vigil-macos-release-v1";
const APP_IDENTIFIER = "tech.caseline.vigil";
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASE_BYTES = 8 * 1024 * 1024 * 1024;
type FileHandle = Awaited<ReturnType<typeof open>>;

export interface VigilPrebuiltReleaseManifest {
  kind: typeof RELEASE_KIND;
  schemaVersion: 1;
  channel: "stable";
  version: string;
  buildVersion: string;
  commit: string;
  artifact: string;
  bytes: number;
  sha256: string;
  appIdentifier: typeof APP_IDENTIFIER;
  teamIdentifier: string;
}

export interface VerifiedPrebuiltRelease {
  manifest: VigilPrebuiltReleaseManifest;
  stagedAppPath: string;
  candidateCdHash: string;
}

export interface ReattestedPrebuiltRelease extends VerifiedPrebuiltRelease {
  runtimeTreeDigest: RuntimeTreeDigest;
}

export interface CodeSignatureIdentity {
  authorities: string[];
  cdHash: string;
  designatedRequirement: string;
  identifier: string;
  teamIdentifier: string;
}

/**
 * Verify and stage a complete notarized release without touching the installed
 * app. Activation remains the existing authenticated transaction's job.
 */
export async function verifyAndStagePrebuiltRelease({
  artifactPath,
  installedAppPath,
  manifestPath,
  stagingRoot
}: {
  artifactPath: string;
  installedAppPath: string;
  manifestPath: string;
  stagingRoot: string;
}): Promise<VerifiedPrebuiltRelease> {
  let attachAttempted = false;
  let mountRoot: string | undefined;
  let snapshotRoot: string | undefined;
  let stageRoot: string | undefined;
  let primaryError: unknown;
  let verifiedRelease: VerifiedPrebuiltRelease | undefined;
  try {
    const [installed, staging] = await Promise.all([
      pinnedDirectory(installedAppPath, "installed Vigil app"),
      pinnedDirectory(stagingRoot, "release staging directory")
    ]);
    if ((staging.mode & 0o022) !== 0) throw new Error("The release staging directory is writable by another account.");
    const uid = process.getuid?.();
    if (uid !== undefined && staging.uid !== uid) {
      throw new Error("The release staging directory is owned by another account.");
    }

    snapshotRoot = await mkdtemp(join(staging.realPath, ".vigil-prebuilt-snapshot-"));
    const artifact = await snapshotRegularFile(
      artifactPath,
      join(snapshotRoot, "release.dmg"),
      "release DMG",
      MAX_RELEASE_BYTES
    );
    const manifestBytes = await readPinnedRegularFile(manifestPath, "release manifest", MAX_MANIFEST_BYTES);
    const manifest = parsePrebuiltReleaseManifest(manifestBytes.toString("utf8"));
    if (manifest.artifact !== basename(artifact.sourceRealPath)) {
      throw new Error("The release manifest names a different DMG artifact.");
    }
    if (artifact.size !== manifest.bytes) {
      throw new Error(`The release DMG byte count failed verification: expected ${manifest.bytes}, found ${artifact.size}.`);
    }
    if (artifact.sha256 !== manifest.sha256) throw new Error("The release DMG SHA-256 failed verification.");

    // A DMG is untrusted input until both Gatekeeper and its notarization
    // ticket accept the exact private snapshot. Do not mount before this gate.
    await Promise.all([
      run("/usr/sbin/spctl", [
        "--assess",
        "--type", "open",
        "--context", "context:primary-signature",
        "--verbose=2",
        artifact.snapshotPath
      ]),
      run("/usr/bin/xcrun", ["stapler", "validate", artifact.snapshotPath])
    ]);
    const trustedDigest = await hashPinnedRegularFile(
      artifact.snapshotPath,
      "trusted release DMG snapshot",
      MAX_RELEASE_BYTES
    );
    if (trustedDigest.sha256 !== manifest.sha256 || trustedDigest.size !== manifest.bytes) {
      throw new Error("The trusted release DMG changed before it could be mounted.");
    }

    mountRoot = await mkdtemp(join(tmpdir(), "vigil-release-update-mount-"));
    attachAttempted = true;
    await run("/usr/bin/hdiutil", [
      "attach",
      "-readonly",
      "-nobrowse",
      "-mountpoint",
      mountRoot,
      artifact.snapshotPath
    ]);
    const entries = await readdir(mountRoot, { withFileTypes: true });
    const appEntries = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && entry.name.endsWith(".app"));
    if (appEntries.length !== 1) {
      throw new Error(`Expected exactly one app in the verified release DMG; found ${appEntries.length}.`);
    }
    const mountedAppPath = join(mountRoot, appEntries[0]!.name);
    const [installedIdentity, mountedIdentity] = await Promise.all([
      verifiedSignatureIdentity(installed.realPath),
      verifiedSignatureIdentity(mountedAppPath)
    ]);
    assertReleaseSignerContinuity(installedIdentity, mountedIdentity, manifest);
    await Promise.all([
      run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", mountedAppPath]),
      run("/usr/bin/xcrun", ["stapler", "validate", mountedAppPath])
    ]);
    await assertReleaseMetadata(mountedAppPath, installed.realPath, manifest);

    // Use a fresh, private stage container so a failed copy can only remove
    // paths this invocation created.
    stageRoot = await mkdtemp(join(staging.realPath, ".vigil-prebuilt-stage-"));
    const stagedAppPath = join(stageRoot, "Vigil.app");
    await run("/usr/bin/ditto", ["--noqtn", mountedAppPath, stagedAppPath]);
    const stagedIdentity = await verifiedSignatureIdentity(stagedAppPath);
    assertReleaseSignerContinuity(installedIdentity, stagedIdentity, manifest);
    if (!releaseCodeIdentitiesExactlyMatch(mountedIdentity, stagedIdentity)) {
      throw new Error("The staged Vigil app is not the exact signed app verified on the release DMG.");
    }
    await Promise.all([
      run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", stagedAppPath]),
      run("/usr/bin/xcrun", ["stapler", "validate", stagedAppPath])
    ]);
    await assertReleaseMetadata(stagedAppPath, installed.realPath, manifest);
    const finalDigest = await hashPinnedRegularFile(
      artifact.snapshotPath,
      "staged release DMG snapshot",
      MAX_RELEASE_BYTES
    );
    if (finalDigest.sha256 !== manifest.sha256 || finalDigest.size !== manifest.bytes) {
      throw new Error("The release DMG changed while its signed app was being staged.");
    }
    verifiedRelease = {
      manifest,
      stagedAppPath,
      candidateCdHash: stagedIdentity.cdHash
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupErrors = await cleanupVerificationResources({
    attachAttempted,
    mountRoot,
    removeStage: primaryError !== undefined,
    snapshotRoot,
    stageRoot
  });
  if (primaryError !== undefined) {
    preservePrimaryError(primaryError, cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    // A result is not successful while a private snapshot or mount remains.
    // Remove the otherwise-complete staged candidate before reporting cleanup.
    cleanupErrors = cleanupErrors.concat(await removeOwnedTree(stageRoot, "staged release candidate"));
    throw new AggregateError(cleanupErrors, "The verified release could not be safely cleaned up after staging.");
  }
  if (!verifiedRelease) throw new Error("The release verifier did not produce a staged candidate.");
  return verifiedRelease;
}

/**
 * Repeat the signed candidate and embedded metadata checks in the detached
 * updater process immediately before the durable transaction adopts it.
 */
export async function reattestStagedPrebuiltRelease({
  expectedCandidateCdHash,
  expectedCommit,
  installedAppPath,
  manifestPath,
  stagedAppPath
}: {
  expectedCandidateCdHash: string;
  expectedCommit: string;
  installedAppPath: string;
  manifestPath: string;
  stagedAppPath: string;
}): Promise<ReattestedPrebuiltRelease> {
  if (!/^[a-f0-9]{40,64}$/u.test(expectedCandidateCdHash)
    || !/^[a-f0-9]{40}$/u.test(expectedCommit)) {
    throw new Error("The prebuilt updater received malformed signed-release identity evidence.");
  }
  const [installed, staged, manifestBytes] = await Promise.all([
    pinnedDirectory(installedAppPath, "installed Vigil app"),
    pinnedDirectory(stagedAppPath, "staged Vigil release app"),
    readPinnedRegularFile(manifestPath, "release manifest", MAX_MANIFEST_BYTES)
  ]);
  const manifest = parsePrebuiltReleaseManifest(manifestBytes.toString("utf8"));
  if (manifest.commit !== expectedCommit) {
    throw new Error(
      `The staged release targets commit ${manifest.commit}, not the selected upstream commit ${expectedCommit}.`
    );
  }
  const [installedIdentity, stagedIdentity] = await Promise.all([
    verifiedSignatureIdentity(installed.realPath),
    verifiedSignatureIdentity(staged.realPath)
  ]);
  assertReleaseSignerContinuity(installedIdentity, stagedIdentity, manifest);
  if (stagedIdentity.cdHash !== expectedCandidateCdHash) {
    throw new Error("The staged Vigil release CodeDirectory hash changed after parent-process verification.");
  }
  await Promise.all([
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", staged.realPath]),
    run("/usr/bin/xcrun", ["stapler", "validate", staged.realPath])
  ]);
  await assertReleaseMetadata(staged.realPath, installed.realPath, manifest);
  const runtimePath = join(
    staged.realPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime"
  );
  const runtimeTreeDigest = await captureRuntimeTreeDigest(runtimePath);
  const postDigestIdentity = await verifiedSignatureIdentity(staged.realPath);
  if (!releaseCodeIdentitiesExactlyMatch(stagedIdentity, postDigestIdentity)) {
    throw new Error("The signed Vigil release identity changed while its embedded runtime was being hashed.");
  }
  const repeatedRuntimeTreeDigest = await captureRuntimeTreeDigest(runtimePath);
  if (!runtimeTreeDigestContentsMatch(runtimeTreeDigest, repeatedRuntimeTreeDigest)) {
    throw new Error("The signed Vigil release runtime changed between its verified digest captures.");
  }
  const finalIdentity = await verifiedSignatureIdentity(staged.realPath);
  if (!releaseCodeIdentitiesExactlyMatch(stagedIdentity, finalIdentity)) {
    throw new Error("The signed Vigil release identity changed after its embedded runtime was hashed.");
  }
  return {
    candidateCdHash: stagedIdentity.cdHash,
    manifest,
    stagedAppPath: staged.realPath,
    runtimeTreeDigest
  };
}

export function parsePrebuiltReleaseManifest(text: string): VigilPrebuiltReleaseManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`The Vigil release manifest is not valid JSON: ${errorMessage(error)}`);
  }
  if (!isRecord(value)
    || value.kind !== RELEASE_KIND
    || value.schemaVersion !== 1
    || value.channel !== "stable"
    || value.appIdentifier !== APP_IDENTIFIER
    || !validMarketingVersion(value.version)
    || !validBuildVersion(value.buildVersion)
    || !/^[a-f0-9]{40}$/u.test(String(value.commit || ""))
    || typeof value.artifact !== "string"
    || !/^Vigil-[A-Za-z0-9._+-]+-(?:universal\.)?dmg$/u.test(value.artifact)
    || basename(value.artifact) !== value.artifact
    || !Number.isSafeInteger(value.bytes)
    || Number(value.bytes) < 1
    || Number(value.bytes) > MAX_RELEASE_BYTES
    || !/^[a-f0-9]{64}$/u.test(String(value.sha256 || ""))
    || !/^[A-Z0-9]{10}$/u.test(String(value.teamIdentifier || ""))) {
    throw new Error("The Vigil release manifest has an unsupported or malformed field.");
  }
  return value as unknown as VigilPrebuiltReleaseManifest;
}

export function compareMacBuildVersions(left: string, right: string): number {
  if (!validBuildVersion(left) || !validBuildVersion(right)) {
    throw new Error("Cannot compare malformed macOS build versions.");
  }
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

export function releaseSignatureIdentitiesMatch(
  installed: CodeSignatureIdentity,
  candidate: CodeSignatureIdentity
): boolean {
  const installedLeaf = installed.authorities.find((authority) => authority.startsWith("Developer ID Application:"));
  const candidateLeaf = candidate.authorities.find((authority) => authority.startsWith("Developer ID Application:"));
  return Boolean(
    installed.identifier === APP_IDENTIFIER
    && candidate.identifier === APP_IDENTIFIER
    && installed.teamIdentifier
    && installed.teamIdentifier === candidate.teamIdentifier
    && installedLeaf
    && installedLeaf === candidateLeaf
    && installed.designatedRequirement
    && installed.designatedRequirement === candidate.designatedRequirement
  );
}

export function releaseCodeIdentitiesExactlyMatch(
  mounted: CodeSignatureIdentity,
  staged: CodeSignatureIdentity
): boolean {
  return mounted.cdHash === staged.cdHash
    && mounted.designatedRequirement === staged.designatedRequirement
    && mounted.identifier === staged.identifier
    && mounted.teamIdentifier === staged.teamIdentifier
    && mounted.authorities.length === staged.authorities.length
    && mounted.authorities.every((authority, index) => authority === staged.authorities[index]);
}

async function assertReleaseMetadata(
  candidateAppPath: string,
  installedAppPath: string,
  manifest: VigilPrebuiltReleaseManifest
): Promise<void> {
  const [candidateIdentifier, candidateVersion, candidateBuild, installedBuild, buildInfo] = await Promise.all([
    plistValue(join(candidateAppPath, "Contents", "Info.plist"), "CFBundleIdentifier"),
    plistValue(join(candidateAppPath, "Contents", "Info.plist"), "CFBundleShortVersionString"),
    plistValue(join(candidateAppPath, "Contents", "Info.plist"), "CFBundleVersion"),
    plistValue(join(installedAppPath, "Contents", "Info.plist"), "CFBundleVersion"),
    readPackagedBuildInfo(candidateAppPath)
  ]);
  if (candidateIdentifier !== manifest.appIdentifier
    || candidateVersion !== manifest.version
    || candidateBuild !== manifest.buildVersion) {
    throw new Error("The signed release app identity, version, or build does not match its release manifest.");
  }
  if (compareMacBuildVersions(candidateBuild, installedBuild) <= 0) {
    throw new Error(`The signed release build ${candidateBuild} is not newer than installed build ${installedBuild}.`);
  }
  if (buildInfo.commit !== manifest.commit || buildInfo.dirty !== false) {
    throw new Error("The signed release build metadata does not match the clean published commit.");
  }
}

async function readPackagedBuildInfo(appPath: string): Promise<{ commit?: unknown; dirty?: unknown }> {
  for (const candidatePath of [
    join(appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
    join(appPath, "Contents", "Resources", "app.asar", "dist", "runtime", "build-info.json")
  ]) {
    try {
      return JSON.parse(await readFile(candidatePath, "utf8")) as { commit?: unknown; dirty?: unknown };
    } catch (error) {
      if (!isErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("The signed release app has no readable packaged build metadata.");
}

async function verifiedSignatureIdentity(appPath: string): Promise<CodeSignatureIdentity> {
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const [detail, requirement] = await Promise.all([
    capture("/usr/bin/codesign", ["-dv", "--verbose=4", appPath]),
    capture("/usr/bin/codesign", ["-d", "-r-", appPath])
  ]);
  const identity: CodeSignatureIdentity = {
    authorities: [...detail.matchAll(/^Authority=(.+)$/gmu)].map((match) => String(match[1] || "").trim()),
    cdHash: detail.match(/^CDHash=([a-f0-9]+)$/imu)?.[1]?.toLowerCase() || "",
    designatedRequirement: requirement.match(/^designated => (.+)$/mu)?.[1]?.trim() || "",
    identifier: detail.match(/^Identifier=(.+)$/mu)?.[1]?.trim() || "",
    teamIdentifier: detail.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || ""
  };
  if (!/^[a-f0-9]{40,64}$/u.test(identity.cdHash)) {
    throw new Error("The signed release app has no valid CodeDirectory hash.");
  }
  return identity;
}

function assertReleaseSignerContinuity(
  installed: CodeSignatureIdentity,
  candidate: CodeSignatureIdentity,
  manifest: VigilPrebuiltReleaseManifest
): void {
  if (!releaseSignatureIdentitiesMatch(installed, candidate)) {
    throw new Error("The signed release app does not match the installed Developer ID identity.");
  }
  if (candidate.identifier !== manifest.appIdentifier || candidate.teamIdentifier !== manifest.teamIdentifier) {
    throw new Error("The signed release app identity does not match its release manifest.");
  }
}

async function readPinnedRegularFile(path: string, label: string, maxBytes: number): Promise<Buffer> {
  const absolutePath = resolve(path);
  const realPath = await realpath(absolutePath);
  if (realPath !== absolutePath) {
    throw new Error(`The ${label} must be a canonical regular file.`);
  }
  let bytes: Buffer | undefined;
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) {
      throw new Error(`The ${label} must be a bounded regular file.`);
    }
    bytes = await handle.readFile();
    const [after, pathname] = await Promise.all([handle.stat(), lstat(absolutePath)]);
    assertSameOpenFile(before, after, pathname, bytes.length, label);
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = await closeFileHandles([handle], label);
  if (primaryError !== undefined) {
    preservePrimaryError(primaryError, cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `The ${label} file descriptor could not be closed.`);
  if (!bytes) throw new Error(`The ${label} could not be read.`);
  return bytes;
}

async function snapshotRegularFile(
  path: string,
  snapshotPath: string,
  label: string,
  maxBytes: number
): Promise<{ sha256: string; size: number; snapshotPath: string; sourceRealPath: string }> {
  const absolutePath = resolve(path);
  const sourceRealPath = await realpath(absolutePath);
  if (sourceRealPath !== absolutePath) {
    throw new Error(`The ${label} must be a canonical regular file.`);
  }
  let destination: FileHandle | undefined;
  let primaryError: unknown;
  let result: { sha256: string; size: number; snapshotPath: string; sourceRealPath: string } | undefined;
  let source: FileHandle | undefined;
  try {
    source = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    destination = await open(snapshotPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400);
    const before = await source.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
      throw new Error(`The ${label} must be a bounded nonempty regular file.`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!bytesRead) throw new Error(`The ${label} ended while it was being snapshotted.`);
      const chunk = buffer.subarray(0, bytesRead);
      await writeAll(destination, chunk, offset, label);
      hash.update(chunk);
      offset += bytesRead;
    }
    await destination.sync();
    const [after, pathname, snapshotStat, snapshotPathname] = await Promise.all([
      source.stat(),
      lstat(absolutePath),
      destination.stat(),
      lstat(snapshotPath)
    ]);
    assertSameOpenFile(before, after, pathname, offset, label);
    if (!snapshotStat.isFile()
      || !snapshotPathname.isFile()
      || snapshotPathname.isSymbolicLink()
      || snapshotStat.dev !== snapshotPathname.dev
      || snapshotStat.ino !== snapshotPathname.ino
      || snapshotStat.size !== snapshotPathname.size
      || snapshotStat.ctimeMs !== snapshotPathname.ctimeMs
      || snapshotStat.mtimeMs !== snapshotPathname.mtimeMs
      || snapshotStat.size !== offset
      || (snapshotStat.mode & 0o777) !== 0o400
      || (snapshotPathname.mode & 0o777) !== 0o400) {
      throw new Error(`The private ${label} snapshot could not be verified.`);
    }
    result = {
      sha256: hash.digest("hex"),
      size: offset,
      snapshotPath,
      sourceRealPath
    };
  } catch (error) {
    primaryError = error;
  }
  let cleanupErrors = await closeFileHandles([destination, source], label);
  if (primaryError !== undefined || cleanupErrors.length > 0) {
    cleanupErrors = cleanupErrors.concat(await removeOwnedFile(snapshotPath, `partial ${label} snapshot`));
  }
  if (primaryError !== undefined) {
    preservePrimaryError(primaryError, cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `The private ${label} snapshot could not be finalized.`);
  }
  if (!result) throw new Error(`The ${label} snapshot was not produced.`);
  return result;
}

async function hashPinnedRegularFile(
  path: string,
  label: string,
  maxBytes: number
): Promise<{ sha256: string; size: number }> {
  const absolutePath = resolve(path);
  const realPath = await realpath(absolutePath);
  if (realPath !== absolutePath) throw new Error(`The ${label} must be a canonical regular file.`);
  let handle: FileHandle | undefined;
  let primaryError: unknown;
  let result: { sha256: string; size: number } | undefined;
  try {
    handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > maxBytes) {
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
    assertSameOpenFile(before, after, pathname, offset, label);
    result = { sha256: hash.digest("hex"), size: offset };
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors = await closeFileHandles([handle], label);
  if (primaryError !== undefined) {
    preservePrimaryError(primaryError, cleanupErrors);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, `The ${label} file descriptor could not be closed.`);
  if (!result) throw new Error(`The ${label} digest was not produced.`);
  return result;
}

async function writeAll(destination: FileHandle, bytes: Buffer, offset: number, label: string): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await destination.write(bytes, written, bytes.length - written, offset + written);
    if (!result.bytesWritten) throw new Error(`The private ${label} snapshot stopped accepting data.`);
    written += result.bytesWritten;
  }
}

async function cleanupVerificationResources({
  attachAttempted,
  mountRoot,
  removeStage,
  snapshotRoot,
  stageRoot
}: {
  attachAttempted: boolean;
  mountRoot: string | undefined;
  removeStage: boolean;
  snapshotRoot: string | undefined;
  stageRoot: string | undefined;
}): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  if (attachAttempted && mountRoot) {
    try {
      await run("/usr/bin/hdiutil", ["detach", mountRoot]);
    } catch {
      try {
        await run("/usr/bin/hdiutil", ["detach", "-force", mountRoot]);
      } catch (error) {
        cleanupErrors.push(new Error("The verified release DMG could not be detached.", { cause: error }));
      }
    }
  }
  cleanupErrors.push(...await removeEmptyMountDirectory(mountRoot));
  cleanupErrors.push(...await removeOwnedTree(snapshotRoot, "private release snapshot"));
  if (removeStage) cleanupErrors.push(...await removeOwnedTree(stageRoot, "partial staged release candidate"));
  return cleanupErrors;
}

async function removeEmptyMountDirectory(path: string | undefined): Promise<unknown[]> {
  if (!path) return [];
  try {
    await rmdir(path);
    return [];
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return [];
    return [new Error(`The release mount directory ${path} could not be removed.`, { cause: error })];
  }
}

async function removeOwnedTree(path: string | undefined, label: string): Promise<unknown[]> {
  if (!path) return [];
  try {
    await rm(path, { recursive: true, force: true });
    return [];
  } catch (error) {
    return [new Error(`The ${label} at ${path} could not be removed.`, { cause: error })];
  }
}

async function removeOwnedFile(path: string, label: string): Promise<unknown[]> {
  try {
    await rm(path, { force: true });
    return [];
  } catch (error) {
    return [new Error(`The ${label} at ${path} could not be removed.`, { cause: error })];
  }
}

async function closeFileHandles(handles: Array<FileHandle | undefined>, label: string): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  for (const handle of handles) {
    if (!handle) continue;
    try {
      await handle.close();
    } catch (error) {
      cleanupErrors.push(new Error(`A ${label} file descriptor could not be closed.`, { cause: error }));
    }
  }
  return cleanupErrors;
}

function preservePrimaryError(primaryError: unknown, cleanupErrors: unknown[]): void {
  if (!(primaryError instanceof Error) || cleanupErrors.length === 0) return;
  try {
    Object.defineProperty(primaryError, "cleanupErrors", {
      configurable: true,
      enumerable: false,
      value: cleanupErrors
    });
  } catch {
    // The original verification error remains authoritative even if it is not extensible.
  }
}

function assertSameOpenFile(
  before: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  after: Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>,
  pathname: Awaited<ReturnType<typeof lstat>>,
  bytesRead: number,
  label: string
): void {
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
    throw new Error(`The ${label} changed while it was being verified.`);
  }
}

async function pinnedDirectory(path: string, label: string): Promise<{ realPath: string; mode: number; uid: number }> {
  const absolutePath = resolve(path);
  const [realPath, value] = await Promise.all([realpath(absolutePath), lstat(absolutePath)]);
  if (realPath !== absolutePath || !value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`The ${label} must be a canonical directory.`);
  }
  return { realPath, mode: value.mode, uid: value.uid };
}

async function plistValue(path: string, key: string): Promise<string> {
  return (await capture("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, path])).trim();
}

async function run(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 2 * 60_000, maxBuffer: 1024 * 1024 });
}

async function capture(command: string, args: string[]): Promise<string> {
  const result = await execFileAsync(command, args, {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return `${result.stdout || ""}\n${result.stderr || ""}`;
}

function validMarketingVersion(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9]+(?:\.[0-9]+){1,2}(?:[-+][A-Za-z0-9.-]+)?$/u.test(value);
}

function validBuildVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+){0,2}$/u.test(value)) return false;
  const parts = value.split(".").map(Number);
  return parts.length <= 3
    && parts.every((part, index) => Number.isInteger(part) && part >= (index === 0 ? 1 : 0) && part <= (index === 0 ? 9999 : 99));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown release verification error.");
}
