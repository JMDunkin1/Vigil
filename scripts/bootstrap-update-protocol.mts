import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireUpdaterLock } from "../app/updater.js";
import { isDirectRun } from "../src/directRun.js";
import { VIGIL_SAFETY_BOUNDARY_ARG } from "../src/hardening.js";
import { verifyMatchingSignedApps } from "../src/guardianSetup.js";
import type { SignedSetupBundleIdentity } from "../src/guardianSetup.js";
import {
  assertOwnedUpdaterLock,
  beginGuardianMaintenance,
  defaultUpdaterLockPath,
  guardianMaintenanceReadiness,
  publishBootstrapWorkerAuthorizationRequest,
  UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH
} from "../src/updateMaintenance.js";
import {
  atomicInstallBuiltApp,
  reconcileAtomicInstallResidue
} from "./update-packaged-app.mjs";
import type { AppInstallation, AtomicInstallOperations } from "./update-packaged-app.mjs";
import {
  updateProtocolBridgePayloadModulePath,
  verifyUpdateProtocolBridgeEquivalence
} from "./package-update-protocol-bridge.mjs";
import type { UpdateProtocolBridgeEquivalenceEvidence } from "./package-update-protocol-bridge.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TARGET_APP_PATH = "/Applications/Vigil.app";
const SUPERVISOR_LABEL = "tech.caseline.vigil.supervisor";
const AVAILABILITY_STABILITY_MS = 500;
const LOCK_TRANSFER_TIMEOUT_MS = 45_000;
const LOCK_TRANSFER_POLL_MS = 25;
const MAX_BUILD_INFO_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_RUNTIME_READY_BYTES = 8 * 1024;
const MAX_UPDATER_SCRIPT_BYTES = 2 * 1024 * 1024;
const UPDATE_SCRIPT_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"
);
const BOOTSTRAP_SCRIPT_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "bootstrap-update-protocol.mjs"
);
const SETUP_SCRIPT_RELATIVE_PATH = join(
  "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "setup-system-guardian.mjs"
);
const LAUNCHER_RELATIVE_PATH = join("Contents", "MacOS", "Vigil");
const BACKGROUND_LAUNCH_ARG = "--vigil-background";

export interface UpdateProtocolBootstrapRequest {
  sourceAppPath: string;
  targetAppPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  bootstrapToken: string;
  expectedUpdateCommit: string;
}

export interface BootstrapBuildIdentity {
  commit: string;
  fingerprint: string;
  sourceRoot: string;
}

export interface ProtectedProcessIdentity {
  pid: number;
  startedAt: string;
  readyAt?: string;
}

export interface ProtectedAvailabilitySnapshot {
  app: ProtectedProcessIdentity;
  supervisor: ProtectedProcessIdentity;
}

export interface BootstrapUpdaterCapability {
  revision: number;
  sha256: string;
  bootstrapSha256: string;
  setupSha256: string;
}

export interface BootstrapAuthorizationEvidence {
  sourceAppPath: string;
  targetAppPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  bootstrapToken: string;
  expectedUpdateCommit: string;
  sourceBuild: BootstrapBuildIdentity;
  targetBuild: BootstrapBuildIdentity;
  signatures: SignedSetupBundleIdentity;
  updater: BootstrapUpdaterCapability;
  bridge: UpdateProtocolBridgeEquivalenceEvidence;
}

export interface BootstrapAuthorizedTargetIdentity {
  cdHash: string;
  build: BootstrapBuildIdentity;
}

export interface UpdateProtocolBootstrapResult {
  ok: true;
  sourceCdHash: string;
  previousCdHash: string;
  installedCommit: string;
  installedFingerprint: string;
  appPid: number;
  supervisorPid: number;
}

export interface UpdateProtocolBootstrapOperations {
  canonicalDirectory(path: string, label: string, expectedUid: number, allowRoot: boolean): Promise<string>;
  assertSignedOrigin(sourceAppPath: string): Promise<void>;
  verifyMatchingApps(sourceAppPath: string, targetAppPath: string): Promise<SignedSetupBundleIdentity>;
  readBuildIdentity(appPath: string): Promise<BootstrapBuildIdentity>;
  readUpdaterCapability(appPath: string): Promise<BootstrapUpdaterCapability>;
  verifyBridgeEquivalence(
    installedAppPath: string | null,
    candidateAppPath: string,
    options?: { allowAtomicInstallBundlePaths?: boolean }
  ): Promise<UpdateProtocolBridgeEquivalenceEvidence>;
  assertBootstrapAuthorization(evidence: BootstrapAuthorizationEvidence): Promise<BootstrapAuthorizedTargetIdentity>;
  assertGuardianReady(): Promise<void>;
  assertUpdateContinuation(sourceBuild: BootstrapBuildIdentity, expectedUpdateCommit: string): Promise<void>;
  acquireLock(lockPath: string): Promise<BootstrapHeldLock>;
  beginMaintenance(lock: BootstrapHeldLock): Promise<BootstrapMaintenanceTransaction>;
  assertNoRecoveryTransaction(userDataDir: string): Promise<void>;
  captureAvailability(
    targetAppPath: string,
    targetUid: number,
    userDataDir: string
  ): Promise<ProtectedAvailabilitySnapshot>;
  installCandidate(
    sourceAppPath: string,
    targetAppPath: string,
    signatures: SignedSetupBundleIdentity,
    sourceBuild: BootstrapBuildIdentity,
    targetBuild: BootstrapBuildIdentity,
    authorizedTarget: BootstrapAuthorizedTargetIdentity,
    bridge: UpdateProtocolBridgeEquivalenceEvidence
  ): Promise<AppInstallation>;
  wait(milliseconds: number): Promise<void>;
}

export interface BootstrapHeldLock {
  path: string;
  token: string;
  ownerPid: number;
  release(): Promise<void>;
}

export interface BootstrapMaintenanceTransaction {
  release(): Promise<void>;
}

class AvailabilityContinuityError extends Error {
  constructor() {
    super("Vigil's main app or restart supervisor changed process identity during the online protocol bootstrap.");
    this.name = "AvailabilityContinuityError";
  }
}

/**
 * One-time bridge from the legacy v2 updater protocol to v3. A root-owned,
 * expiring authorization created by the administrator-approved guardian
 * migration pins every generation involved. The app and user supervisor are
 * never asked to stop or signaled.
 */
export async function bootstrapUpdateProtocol(
  request: UpdateProtocolBootstrapRequest,
  operations: UpdateProtocolBootstrapOperations = defaultOperations,
  heldLock: BootstrapHeldLock | null = null
): Promise<UpdateProtocolBootstrapResult> {
  validateRequest(request);
  const userDataDir = join(request.targetHome, "Library", "Application Support", "Vigil");
  assertPathTopology(resolve(request.sourceAppPath), resolve(request.targetAppPath), userDataDir);
  const lockPath = defaultUpdaterLockPath(request.targetHome);
  if (heldLock && heldLock.path !== lockPath) {
    throw new Error("Vigil refused an updater-protocol bridge under an unrelated updater lock.");
  }
  const lock = heldLock || await operations.acquireLock(lockPath);
  if (lock.path !== lockPath
    || !lock.token
    || !Number.isSafeInteger(lock.ownerPid)
    || lock.ownerPid < 1) {
    throw new Error("Vigil refused an updater-protocol bridge without an exact owned updater lock.");
  }
  const ownsLock = heldLock === null;
  let installation: AppInstallation | null = null;
  let maintenance: BootstrapMaintenanceTransaction | null = null;
  let verified = false;
  let result: UpdateProtocolBootstrapResult | null = null;
  let failure: unknown = null;
  try {
    await operations.assertNoRecoveryTransaction(userDataDir);
    const sourceAppPath = await operations.canonicalDirectory(
      request.sourceAppPath, "bootstrap source app", request.targetUid, false
    );
    const targetAppPath = await operations.canonicalDirectory(
      request.targetAppPath, "installed Vigil app", request.targetUid, true
    );
    if (targetAppPath !== DEFAULT_TARGET_APP_PATH) {
      throw new Error(`Vigil refused to bootstrap an unexpected app path at ${targetAppPath}.`);
    }
    assertPathTopology(sourceAppPath, targetAppPath, userDataDir);
    await operations.assertSignedOrigin(sourceAppPath);

    const firstSignatures = await operations.verifyMatchingApps(sourceAppPath, targetAppPath);
    const alreadyInstalled = firstSignatures.sourceCdHash === firstSignatures.targetCdHash;
    const [sourceBuild, targetBuild, updater, bridge] = await Promise.all([
      operations.readBuildIdentity(sourceAppPath),
      operations.readBuildIdentity(targetAppPath),
      operations.readUpdaterCapability(sourceAppPath),
      operations.verifyBridgeEquivalence(alreadyInstalled ? null : targetAppPath, sourceAppPath)
    ]);
    if (!sameBuildIdentity(sourceBuild, targetBuild)) {
      throw new Error("Vigil's update-protocol bridge must retain installed generation A's exact standard build identity.");
    }
    const signatures = await operations.verifyMatchingApps(sourceAppPath, targetAppPath);
    assertSameSignatures(firstSignatures, signatures,
      "Vigil's signed bridge or installed generation changed while bootstrap evidence was being captured.");
    const evidence: BootstrapAuthorizationEvidence = {
      sourceAppPath,
      targetAppPath,
      targetHome: request.targetHome,
      targetUid: request.targetUid,
      targetUser: request.targetUser,
      bootstrapToken: request.bootstrapToken,
      expectedUpdateCommit: request.expectedUpdateCommit.toLowerCase(),
      sourceBuild,
      targetBuild,
      signatures,
      updater,
      bridge
    };
    const authorizedTarget = await operations.assertBootstrapAuthorization(evidence);
    assertAuthorizedTargetIdentity(authorizedTarget);
    await operations.assertGuardianReady();
    await operations.assertUpdateContinuation(sourceBuild, evidence.expectedUpdateCommit);
    const before = await operations.captureAvailability(targetAppPath, request.targetUid, userDataDir);
    maintenance = await operations.beginMaintenance(lock);

    installation = await operations.installCandidate(
      sourceAppPath,
      targetAppPath,
      signatures,
      sourceBuild,
      targetBuild,
      authorizedTarget,
      bridge
    );

    const [installedSignatures, installedBuild, installedUpdater, installedBridge] = await Promise.all([
      operations.verifyMatchingApps(sourceAppPath, targetAppPath),
      operations.readBuildIdentity(targetAppPath),
      operations.readUpdaterCapability(targetAppPath),
      operations.verifyBridgeEquivalence(
        alreadyInstalled ? null : `${targetAppPath}.vigil-previous`,
        targetAppPath,
        { allowAtomicInstallBundlePaths: true }
      )
    ]);
    if (installedSignatures.sourceCdHash !== signatures.sourceCdHash
      || installedSignatures.targetCdHash !== signatures.sourceCdHash
      || !sameBuildIdentity(installedBuild, sourceBuild)
      || installedUpdater.revision !== updater.revision
      || installedUpdater.sha256 !== updater.sha256
      || installedUpdater.bootstrapSha256 !== updater.bootstrapSha256
      || installedUpdater.setupSha256 !== updater.setupSha256
      || !sameBridgeEquivalence(installedBridge, bridge)) {
      throw new Error("Vigil could not verify the exact signed v3 bridge app after activation.");
    }
    await operations.assertGuardianReady();
    await operations.assertUpdateContinuation(sourceBuild, evidence.expectedUpdateCommit);

    const immediate = await operations.captureAvailability(targetAppPath, request.targetUid, userDataDir);
    assertAvailabilityContinuity(before, immediate);
    await operations.wait(AVAILABILITY_STABILITY_MS);
    const stable = await operations.captureAvailability(targetAppPath, request.targetUid, userDataDir);
    assertAvailabilityContinuity(before, stable);

    const preMarkSignaturesBefore = await operations.verifyMatchingApps(sourceAppPath, targetAppPath);
    const [
      preMarkSourceBuild,
      preMarkInstalledBuild,
      preMarkSourceUpdater,
      preMarkInstalledUpdater,
      preMarkSourceBridge,
      preMarkInstalledBridge
    ] = await Promise.all([
      operations.readBuildIdentity(sourceAppPath),
      operations.readBuildIdentity(targetAppPath),
      operations.readUpdaterCapability(sourceAppPath),
      operations.readUpdaterCapability(targetAppPath),
      operations.verifyBridgeEquivalence(null, sourceAppPath),
      operations.verifyBridgeEquivalence(
        alreadyInstalled ? null : `${targetAppPath}.vigil-previous`,
        targetAppPath,
        { allowAtomicInstallBundlePaths: true }
      )
    ]);
    const preMarkSignatures = await operations.verifyMatchingApps(sourceAppPath, targetAppPath);
    assertSameSignatures(preMarkSignaturesBefore, preMarkSignatures,
      "Vigil's signed bridge evidence changed across the final verification boundary.");
    if (preMarkSignatures.sourceCdHash !== signatures.sourceCdHash
      || preMarkSignatures.targetCdHash !== signatures.sourceCdHash
      || !sameBuildIdentity(preMarkSourceBuild, sourceBuild)
      || !sameBuildIdentity(preMarkInstalledBuild, sourceBuild)
      || preMarkSourceUpdater.revision !== updater.revision
      || preMarkSourceUpdater.sha256 !== updater.sha256
      || preMarkSourceUpdater.bootstrapSha256 !== updater.bootstrapSha256
      || preMarkSourceUpdater.setupSha256 !== updater.setupSha256
      || preMarkInstalledUpdater.revision !== updater.revision
      || preMarkInstalledUpdater.sha256 !== updater.sha256
      || preMarkInstalledUpdater.bootstrapSha256 !== updater.bootstrapSha256
      || preMarkInstalledUpdater.setupSha256 !== updater.setupSha256
      || !sameBridgeEquivalence(preMarkSourceBridge, bridge)
      || !sameBridgeEquivalence(preMarkInstalledBridge, bridge)) {
      throw new Error("Vigil's exact signed bridge evidence changed at the final verification boundary.");
    }
    await operations.assertGuardianReady();
    const preMarkAuthorizedTarget = await operations.assertBootstrapAuthorization(evidence);
    if (!sameAuthorizedTargetIdentity(preMarkAuthorizedTarget, authorizedTarget)) {
      throw new Error("Vigil's root updater-protocol authorization changed before final verification.");
    }
    const preMarkAvailability = await operations.captureAvailability(targetAppPath, request.targetUid, userDataDir);
    assertAvailabilityContinuity(before, preMarkAvailability);
    await operations.assertUpdateContinuation(preMarkSourceBuild, evidence.expectedUpdateCommit);
    await installation.markVerified();
    verified = true;
    await installation.finalize();
    result = {
      ok: true,
      sourceCdHash: signatures.sourceCdHash,
      previousCdHash: authorizedTarget.cdHash,
      installedCommit: sourceBuild.commit,
      installedFingerprint: sourceBuild.fingerprint,
      appPid: before.app.pid,
      supervisorPid: before.supervisor.pid
    };
  } catch (error) {
    failure = error;
    if (installation && !verified) {
      try {
        if (error instanceof AvailabilityContinuityError) {
          // A replacement process may now have mapped the verified candidate.
          // Never put older bytes underneath that process. Durably verify and
          // finalize the exact candidate so a legacy supervisor cannot later
          // reinterpret bridge residue as a generation to promote.
          await installation.markVerified();
          verified = true;
          await installation.finalize();
        } else {
          await installation.rollback();
        }
      } catch (recoveryError) {
        failure = new AggregateError(
          [error, recoveryError],
          "Vigil's update-protocol bootstrap failed and its atomic recovery could not be completed; all recovery evidence was preserved."
        );
      }
    }
  }
  if (maintenance) {
    try {
      await maintenance.release();
    } catch (releaseError) {
      failure = failure
        ? new AggregateError([failure, releaseError], "Vigil's protocol bootstrap failed and authenticated maintenance could not be released.")
        : releaseError;
    }
  }
  if (ownsLock) {
    try {
      await lock.release();
    } catch (releaseError) {
      failure = failure
        ? new AggregateError([failure, releaseError], "Vigil's protocol bootstrap failed and its updater lock could not be released.")
        : releaseError;
    }
  }
  if (failure) throw failure;
  if (!result) throw new Error("Vigil's updater-protocol bootstrap ended without a verified result.");
  return result;
}

const defaultOperations: UpdateProtocolBootstrapOperations = {
  canonicalDirectory,
  assertSignedOrigin,
  verifyMatchingApps: verifyMatchingSignedApps,
  readBuildIdentity,
  readUpdaterCapability,
  verifyBridgeEquivalence: verifyUpdateProtocolBridgeEquivalence,
  assertBootstrapAuthorization,
  assertGuardianReady,
  assertUpdateContinuation,
  async acquireLock(path) {
    const lock = await acquireUpdaterLock(path);
    return {
      path: lock.path,
      token: lock.token,
      ownerPid: process.pid,
      release: () => lock.release()
    };
  },
  beginMaintenance: (lock) => beginGuardianMaintenance(lock.path, lock.token, lock.ownerPid),
  assertNoRecoveryTransaction,
  captureAvailability,
  installCandidate: installSignedCandidate,
  async wait(milliseconds) {
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds));
  }
};

async function canonicalDirectory(
  path: string,
  label: string,
  expectedUid: number,
  allowRoot: boolean
): Promise<string> {
  const requested = resolve(path);
  const requestedStat = await lstat(requested);
  if (requestedStat.isSymbolicLink()) {
    throw new Error(`Vigil refused a symbolic-link spelling for its ${label}.`);
  }
  const canonical = await realpath(requested);
  const value = await lstat(canonical);
  if (canonical !== requested
    || !value.isDirectory()
    || value.isSymbolicLink()
    || (value.uid !== expectedUid && !(allowRoot && value.uid === 0))) {
    throw new Error(`Vigil refused to use an unsafe ${label} at ${canonical}.`);
  }
  return canonical;
}

async function assertSignedOrigin(sourceAppPath: string): Promise<void> {
  const directScript = process.argv[1];
  if (!directScript) {
    throw new Error("Vigil refused an updater-protocol bridge without its direct signed wrapper.");
  }
  const [launcherPath, wrapperPath, payloadPath, expectedPayloadPath] = await Promise.all([
    realpath(process.execPath),
    realpath(directScript),
    realpath(fileURLToPath(import.meta.url)),
    updateProtocolBridgePayloadModulePath(sourceAppPath, "scripts/bootstrap-update-protocol.mjs")
  ]);
  if (launcherPath !== join(sourceAppPath, LAUNCHER_RELATIVE_PATH)
    || wrapperPath !== join(sourceAppPath, BOOTSTRAP_SCRIPT_RELATIVE_PATH)
    || payloadPath !== expectedPayloadPath) {
    throw new Error("Vigil refused an updater-protocol bridge not executed by the signed bridge bundle itself.");
  }
}

async function readBuildIdentity(appPath: string): Promise<BootstrapBuildIdentity> {
  const bytes = await readPinnedRegularFile(join(
    appPath,
    "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"
  ), MAX_BUILD_INFO_BYTES);
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    commit?: unknown;
    dirty?: unknown;
    name?: unknown;
    sourceFingerprint?: unknown;
    sourceRoot?: unknown;
  };
  const commit = String(parsed.commit || "").toLowerCase();
  const fingerprint = String(parsed.sourceFingerprint || "").toLowerCase();
  const sourceRoot = String(parsed.sourceRoot || "");
  if (parsed.name !== "vigil"
    || parsed.dirty !== false
    || !/^[a-f0-9]{40}$/u.test(commit)
    || !/^[a-f0-9]{64}$/u.test(fingerprint)
    || !isAbsolute(sourceRoot)) {
    throw new Error("Vigil's protocol bootstrap requires clean packaged build metadata.");
  }
  return { commit, fingerprint, sourceRoot };
}

async function readUpdaterCapability(appPath: string): Promise<BootstrapUpdaterCapability> {
  const [bytes, bootstrapBytes, setupBytes] = await Promise.all([
    readPinnedRegularFile(join(appPath, UPDATE_SCRIPT_RELATIVE_PATH), MAX_UPDATER_SCRIPT_BYTES),
    readPinnedRegularFile(join(appPath, BOOTSTRAP_SCRIPT_RELATIVE_PATH), MAX_UPDATER_SCRIPT_BYTES),
    readPinnedRegularFile(join(appPath, SETUP_SCRIPT_RELATIVE_PATH), MAX_UPDATER_SCRIPT_BYTES)
  ]);
  const script = bytes.toString("utf8");
  const marker = `export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = ${UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION};`;
  if (!script.includes(marker)) {
    throw new Error("Vigil's signed bridge app does not contain the required v3 packaged updater.");
  }
  return {
    revision: UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION,
    sha256: sha256(bytes),
    bootstrapSha256: sha256(bootstrapBytes),
    setupSha256: sha256(setupBytes)
  };
}

export interface BootstrapAuthorizationPayload {
  kind?: unknown;
  token?: unknown;
  sourceAppPath?: unknown;
  targetAppPath?: unknown;
  repoRoot?: unknown;
  targetHome?: unknown;
  targetUid?: unknown;
  targetUser?: unknown;
  sourceCdHash?: unknown;
  targetCdHash?: unknown;
  sourceCommit?: unknown;
  sourceFingerprint?: unknown;
  targetCommit?: unknown;
  targetFingerprint?: unknown;
  updaterScriptSha256?: unknown;
  bootstrapScriptSha256?: unknown;
  setupScriptSha256?: unknown;
  bridgeManifestSha256?: unknown;
  bridgeEquivalentTreeSha256?: unknown;
  bridgePayloadTreeSha256?: unknown;
  bridgeWrappersSha256?: unknown;
  bridgeBaselineBuildInfoSha256?: unknown;
  expectedUpdateCommit?: unknown;
  createdAtEpoch?: unknown;
  expiresAtEpoch?: unknown;
}

async function assertBootstrapAuthorization(
  evidence: BootstrapAuthorizationEvidence
): Promise<BootstrapAuthorizedTargetIdentity> {
  const { bytes, stat } = await readPinnedRootAuthorization(UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH);
  const value = JSON.parse(bytes.toString("utf8")) as BootstrapAuthorizationPayload;
  const nowEpoch = Math.floor(Date.now() / 1_000);
  const modifiedEpoch = Math.floor(stat.mtimeMs / 1_000);
  assertBootstrapAuthorizationPayload(evidence, value, modifiedEpoch, nowEpoch);
  return authorizedTargetIdentity(evidence, value);
}

export function assertBootstrapAuthorizationPayload(
  evidence: BootstrapAuthorizationEvidence,
  value: BootstrapAuthorizationPayload,
  modifiedEpoch: number,
  nowEpoch: number
): void {
  if (value.kind !== UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND
    || value.token !== evidence.bootstrapToken
    || value.sourceAppPath !== evidence.sourceAppPath
    || value.targetAppPath !== evidence.targetAppPath
    || value.repoRoot !== evidence.sourceBuild.sourceRoot
    || value.targetHome !== evidence.targetHome
    || value.targetUid !== evidence.targetUid
    || value.targetUser !== evidence.targetUser
    || value.sourceCdHash !== evidence.signatures.sourceCdHash
    || value.targetCdHash !== evidence.signatures.targetCdHash
    || value.sourceCommit !== evidence.sourceBuild.commit
    || value.sourceFingerprint !== evidence.sourceBuild.fingerprint
    || value.targetCommit !== evidence.targetBuild.commit
    || value.targetFingerprint !== evidence.targetBuild.fingerprint
    || value.updaterScriptSha256 !== evidence.updater.sha256
    || value.bootstrapScriptSha256 !== evidence.updater.bootstrapSha256
    || value.setupScriptSha256 !== evidence.updater.setupSha256
    || value.bridgeManifestSha256 !== evidence.bridge.manifestSha256
    || value.bridgeEquivalentTreeSha256 !== evidence.bridge.equivalentTreeSha256
    || value.bridgePayloadTreeSha256 !== evidence.bridge.payloadTreeSha256
    || value.bridgeWrappersSha256 !== evidence.bridge.wrappersSha256
    || value.bridgeBaselineBuildInfoSha256 !== evidence.bridge.baselineBuildInfoSha256
    || value.expectedUpdateCommit !== evidence.expectedUpdateCommit
    || !Number.isInteger(value.createdAtEpoch)
    || !Number.isInteger(value.expiresAtEpoch)
    || Number(value.createdAtEpoch) > nowEpoch
    || Number(value.createdAtEpoch) < modifiedEpoch - 5
    || Number(value.expiresAtEpoch) < nowEpoch
    || Number(value.expiresAtEpoch) > modifiedEpoch + UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS) {
    throw new Error("Vigil's root updater-protocol authorization does not match this exact bridge transaction.");
  }
}

function authorizedTargetIdentity(
  evidence: BootstrapAuthorizationEvidence,
  value: BootstrapAuthorizationPayload
): BootstrapAuthorizedTargetIdentity {
  return {
    cdHash: String(value.targetCdHash),
    build: {
      commit: String(value.targetCommit),
      fingerprint: String(value.targetFingerprint),
      sourceRoot: evidence.sourceBuild.sourceRoot
    }
  };
}

async function readPinnedRootAuthorization(path: string): Promise<{ bytes: Buffer; stat: Stats }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.uid !== 0
      || (before.mode & 0o777) !== 0o644
      || before.size > MAX_AUTHORIZATION_BYTES) {
      throw new Error("Vigil refused an unsafe root updater-protocol authorization.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) {
      throw new Error("Vigil's root updater-protocol authorization changed while it was being read.");
    }
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

async function assertGuardianReady(): Promise<void> {
  const readiness = await guardianMaintenanceReadiness();
  if (!readiness.ready || !readiness.guardianInstalled || readiness.reason !== "ready") {
    throw new Error(readiness.message || "Vigil's v4 system guardian is not ready for the protocol bridge.");
  }
}

async function assertUpdateContinuation(
  sourceBuild: BootstrapBuildIdentity,
  expectedUpdateCommit: string
): Promise<void> {
  const repoRoot = await realpath(sourceBuild.sourceRoot);
  if (repoRoot !== sourceBuild.sourceRoot) {
    throw new Error("Vigil's bridge source repository is not canonical.");
  }
  const repoStat = await lstat(repoRoot);
  const uid = process.getuid?.();
  if (!repoStat.isDirectory()
    || repoStat.isSymbolicLink()
    || (uid !== undefined && repoStat.uid !== uid)) {
    throw new Error("Vigil refused an unsafe source repository for its follow-on update.");
  }
  const git = "/usr/bin/git";
  const [head, upstream, branch, status] = await Promise.all([
    capture(git, ["rev-parse", "HEAD"], repoRoot),
    capture(git, ["rev-parse", "@{u}"], repoRoot),
    capture(git, ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot),
    capture(git, ["status", "--porcelain=v1"], repoRoot)
  ]);
  if (head !== expectedUpdateCommit
    || upstream !== expectedUpdateCommit
    || branch !== "main"
    || status
    || sourceBuild.commit === expectedUpdateCommit) {
    throw new Error("Vigil refused the protocol bridge because the exact clean main update is not still actionable.");
  }
  await execFileAsync(git, ["merge-base", "--is-ancestor", sourceBuild.commit, expectedUpdateCommit], {
    cwd: repoRoot,
    env: gitEnvironment(),
    timeout: 5_000,
    maxBuffer: 64 * 1024
  });
}

async function capture(command: string, args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    env: gitEnvironment(),
    timeout: 5_000,
    maxBuffer: 256 * 1024,
    encoding: "utf8"
  });
  return stdout.trim();
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
  );
}

async function assertNoRecoveryTransaction(userDataDir: string): Promise<void> {
  const updaterDir = join(userDataDir, "updater");
  for (const path of [
    join(updaterDir, "update-recovery.json"),
    join(updaterDir, "guardian-maintenance.json")
  ]) {
    if (await pathExists(path)) {
      throw new Error("Vigil must finish its existing protected update transaction before bootstrapping the updater protocol.");
    }
  }
}

async function captureAvailability(
  targetAppPath: string,
  targetUid: number,
  userDataDir: string
): Promise<ProtectedAvailabilitySnapshot> {
  const executablePath = join(targetAppPath, LAUNCHER_RELATIVE_PATH);
  const processPattern = `^${regexEscape(executablePath)}($| )`;
  let supervisorState: string;
  let appPidsText: string;
  let runtimeReady: { pid: number; startedAt: string; appPath: string; transport: string };
  try {
    [{ stdout: supervisorState }, { stdout: appPidsText }, runtimeReady] = await Promise.all([
      execFileAsync("/bin/launchctl", ["print", `gui/${targetUid}/${SUPERVISOR_LABEL}`], {
        timeout: 5_000, maxBuffer: 256 * 1024, encoding: "utf8"
      }),
      execFileAsync("/usr/bin/pgrep", ["-U", String(targetUid), "-f", processPattern], {
        timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8"
      }),
      readPinnedRuntimeReady(join(userDataDir, "runtime-ready.json"), targetUid)
    ]);
  } catch (error) {
    throw new Error(`Vigil refused the protocol bootstrap because its app and supervisor are not both online: ${errorMessage(error)}`);
  }
  if (!/^\s*state = running\s*$/mu.test(supervisorState)) {
    throw new Error("Vigil's restart supervisor is not running.");
  }
  const supervisorPid = Number(supervisorState.match(/^\s*pid = ([1-9]\d*)\s*$/mu)?.[1] || 0);
  const appPid = selectRuntimeReadyMainPid(runtimeReady.pid, appPidsText);
  if (!Number.isSafeInteger(supervisorPid) || supervisorPid < 1
    || runtimeReady.appPath !== executablePath
    || runtimeReady.transport !== "in-app") {
    throw new Error("Vigil could not unambiguously capture its main app and supervisor identities.");
  }
  const [app, supervisor] = await Promise.all([
    processIdentity(
      appPid,
      executablePath,
      `${executablePath} ${BACKGROUND_LAUNCH_ARG} ${VIGIL_SAFETY_BOUNDARY_ARG}`
    ),
    processIdentity(supervisorPid)
  ]);
  const readyAt = Date.parse(runtimeReady.startedAt);
  const processStartedAt = Date.parse(app.startedAt);
  if (!Number.isFinite(readyAt)
    || !Number.isFinite(processStartedAt)
    || processStartedAt > readyAt
    || readyAt > Date.now() + 5_000) {
    throw new Error("Vigil's runtime readiness evidence does not belong to the live main app process.");
  }
  return { app: { ...app, readyAt: runtimeReady.startedAt }, supervisor };
}

export function selectRuntimeReadyMainPid(readyPid: number, appPidsText: string): number {
  const appPids = new Set(appPidsText.split(/\s+/u)
    .filter((pid) => /^[1-9]\d*$/u.test(pid))
    .map(Number));
  if (!Number.isSafeInteger(readyPid) || readyPid < 1 || !appPids.has(readyPid)) {
    throw new Error("Vigil's runtime-ready main process is not among the live signed app processes.");
  }
  return readyPid;
}

async function readPinnedRuntimeReady(
  path: string,
  expectedUid: number
): Promise<{ pid: number; startedAt: string; appPath: string; transport: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.isSymbolicLink()
      || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o600
      || before.size > MAX_RUNTIME_READY_BYTES) {
      throw new Error("Vigil refused unsafe runtime readiness evidence.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) {
      throw new Error("Vigil's runtime readiness evidence changed while it was being read.");
    }
    const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
    const pid = Number(value.pid);
    const startedAt = String(value.startedAt || "");
    const appPath = String(value.appPath || "");
    const transport = String(value.transport || "");
    if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isFinite(Date.parse(startedAt))) {
      throw new Error("Vigil refused malformed runtime readiness evidence.");
    }
    return { pid, startedAt, appPath, transport };
  } finally {
    await handle.close();
  }
}

async function processIdentity(
  pid: number,
  expectedExecutable?: string,
  expectedCommand?: string
): Promise<ProtectedProcessIdentity> {
  const requests = [
    execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8"
    })
  ];
  if (expectedExecutable) {
    requests.push(execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8"
    }));
  }
  if (expectedCommand) {
    requests.push(execFileAsync("/bin/ps", ["-p", String(pid), "-o", "command="], {
      timeout: 5_000, maxBuffer: 64 * 1024, encoding: "utf8"
    }));
  }
  const values = await Promise.all(requests);
  const startedAt = values[0].stdout.trim();
  const executable = values[1]?.stdout.trim();
  const command = values[2]?.stdout.trim();
  if (!startedAt
    || (expectedExecutable && executable !== expectedExecutable)
    || (expectedCommand && command !== expectedCommand)) {
    throw new Error("Vigil could not pin the protected process start identity.");
  }
  return { pid, startedAt };
}

export function runtimeReadyMainCommandMatches(command: string, executablePath: string): boolean {
  return command === `${executablePath} ${BACKGROUND_LAUNCH_ARG} ${VIGIL_SAFETY_BOUNDARY_ARG}`;
}

export function assertAvailabilityContinuity(
  expected: ProtectedAvailabilitySnapshot,
  observed: ProtectedAvailabilitySnapshot
): void {
  if (!sameProcessIdentity(expected.app, observed.app)
    || !sameProcessIdentity(expected.supervisor, observed.supervisor)) {
    throw new AvailabilityContinuityError();
  }
}

function sameProcessIdentity(left: ProtectedProcessIdentity, right: ProtectedProcessIdentity): boolean {
  return left.pid === right.pid
    && left.startedAt === right.startedAt
    && left.readyAt === right.readyAt;
}

async function installSignedCandidate(
  sourceAppPath: string,
  targetAppPath: string,
  signatures: SignedSetupBundleIdentity,
  sourceBuild: BootstrapBuildIdentity,
  targetBuild: BootstrapBuildIdentity,
  authorizedTarget: BootstrapAuthorizedTargetIdentity,
  bridge: UpdateProtocolBridgeEquivalenceEvidence
): Promise<AppInstallation> {
  if (authorizedTarget.cdHash !== signatures.targetCdHash
    || !sameBuildIdentity(authorizedTarget.build, targetBuild)) {
    throw new Error("Vigil refused bootstrap installation without an exact authorized target generation.");
  }
  const nextAppPath = `${targetAppPath}.vigil-next`;
  const previousAppPath = `${targetAppPath}.vigil-previous`;
  const allowedPaths = new Set([targetAppPath, nextAppPath, previousAppPath]);
  const assertAllowedPath = (path: string): void => {
    if (!allowedPaths.has(path)) {
      throw new Error(`Vigil refused a bootstrap filesystem operation outside ${targetAppPath}.`);
    }
  };
  const operations: AtomicInstallOperations = {
    async pathExists(path) {
      assertAllowedPath(path);
      return await pathExists(path);
    },
    async copy(source, destination) {
      if (source !== sourceAppPath || destination !== nextAppPath) {
        throw new Error("Vigil refused an unexpected bootstrap copy target.");
      }
      await execFileAsync("/bin/cp", ["-ac", source, destination], {
        timeout: 2 * 60_000, maxBuffer: 1024 * 1024, encoding: "utf8"
      });
      await assertExactSignedGeneration(
        sourceAppPath, destination, signatures.sourceCdHash, signatures.sourceCdHash, sourceBuild
      );
      await assertExactBridgeGeneration(sourceAppPath, destination, true, bridge);
    },
    async move(source, destination) {
      assertAllowedPath(source);
      assertAllowedPath(destination);
      const expected = source === nextAppPath && destination === previousAppPath
        ? { cdHash: signatures.targetCdHash, build: targetBuild, bridgeCandidate: false }
        : source === targetAppPath && destination === previousAppPath
          ? { cdHash: signatures.targetCdHash, build: targetBuild, bridgeCandidate: false }
          : source === nextAppPath && destination === targetAppPath
            ? { cdHash: signatures.sourceCdHash, build: sourceBuild, bridgeCandidate: true }
            : source === previousAppPath && destination === targetAppPath
              ? { cdHash: signatures.targetCdHash, build: targetBuild, bridgeCandidate: false }
              : null;
      if (!expected) {
        throw new Error(`Vigil refused an unexpected bootstrap move from ${source} to ${destination}.`);
      }
      await assertExactSignedGeneration(
        sourceAppPath, source, signatures.sourceCdHash, expected.cdHash, expected.build
      );
      await assertExactBridgeGeneration(sourceAppPath, source, expected.bridgeCandidate, bridge);
      await rename(source, destination);
      await assertExactSignedGeneration(
        sourceAppPath, destination, signatures.sourceCdHash, expected.cdHash, expected.build
      );
      await assertExactBridgeGeneration(sourceAppPath, destination, expected.bridgeCandidate, bridge);
    },
    async remove(path) {
      assertAllowedPath(path);
      if (await pathExists(path)) {
        const safeGeneration = await exactSignedGenerationMatches(
          sourceAppPath, path, signatures.sourceCdHash, signatures.sourceCdHash, sourceBuild
        ) && await exactBridgeGenerationMatches(sourceAppPath, path, true, bridge)
          || await exactSignedGenerationMatches(
          sourceAppPath, path, signatures.sourceCdHash, signatures.targetCdHash, targetBuild
        ) && await exactBridgeGenerationMatches(sourceAppPath, path, false, bridge);
        if (!safeGeneration) {
          if (path !== previousAppPath && path !== nextAppPath) {
            throw new Error(`Vigil preserved an unrecognized bootstrap generation at ${path}.`);
          }
          const quarantinePath = `${path}.${randomUUID()}.preserved`;
          await rename(path, quarantinePath);
          return;
        }
      }
      await rm(path, { recursive: true, force: true });
    },
    async identity(path) {
      assertAllowedPath(path);
      const value = await lstat(path);
      if (!value.isDirectory() || value.isSymbolicLink()) {
        throw new Error("Vigil's staged bootstrap app is not a safe bundle directory.");
      }
      return { dev: value.dev, ino: value.ino };
    },
    async quarantinePartial(path, quarantinePath) {
      if (path !== nextAppPath
        || !new RegExp(
          `^${regexEscape(nextAppPath)}\\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\\.partial$`,
          "u"
        ).test(quarantinePath)) {
        throw new Error("Vigil refused an unexpected partial-bootstrap quarantine path.");
      }
      const before = await lstat(path);
      if (!before.isDirectory() || before.isSymbolicLink() || await pathExists(quarantinePath)) {
        throw new Error("Vigil refused to quarantine an unsafe partial bootstrap bundle.");
      }
      await rename(path, quarantinePath);
      const after = await lstat(quarantinePath);
      if (after.dev !== before.dev || after.ino !== before.ino) {
        throw new Error("Vigil could not pin its quarantined partial bootstrap bundle.");
      }
    },
    async swap(left, right) {
      assertAllowedPath(left);
      assertAllowedPath(right);
      const roles = await Promise.all([left, right].map(async (candidate) => ({
        candidate,
        isNew: await exactSignedGenerationMatches(
          sourceAppPath, candidate, signatures.sourceCdHash, signatures.sourceCdHash, sourceBuild
        ) && await exactBridgeGenerationMatches(sourceAppPath, candidate, true, bridge),
        isOld: await exactSignedGenerationMatches(
          sourceAppPath, candidate, signatures.sourceCdHash, signatures.targetCdHash, targetBuild
        ) && await exactBridgeGenerationMatches(sourceAppPath, candidate, false, bridge)
      })));
      if (roles.filter((role) => role.isNew && !role.isOld).length !== 1
        || roles.filter((role) => role.isOld && !role.isNew).length !== 1) {
        throw new Error("Vigil could not prove both exact signed generations for atomic bootstrap activation or rollback.");
      }
      const newGeneration = roles.find((role) => role.isNew && !role.isOld)?.candidate;
      if (!newGeneration) throw new Error("Vigil could not locate its exact signed bootstrap generation.");
      const helperPath = join(
        newGeneration,
        "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "bin", "vigil-atomic-swap"
      );
      const helper = await lstat(helperPath);
      if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
        throw new Error("Vigil's signed bootstrap app is missing its atomic-swap helper.");
      }
      await execFileAsync(helperPath, [left, right], {
        timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8"
      });
    }
  };
  await reconcileAtomicInstallResidue(
    targetAppPath,
    nextAppPath,
    previousAppPath,
    `${targetAppPath}.vigil-transaction.json`,
    operations
  );
  if (await exactSignedGenerationMatches(
    sourceAppPath,
    targetAppPath,
    signatures.sourceCdHash,
    signatures.sourceCdHash,
    sourceBuild
  ) && await exactBridgeGenerationMatches(sourceAppPath, targetAppPath, true, bridge)) {
    return alreadyInstalledCandidate(
      sourceAppPath,
      targetAppPath,
      signatures.sourceCdHash,
      sourceBuild,
      bridge
    );
  }
  await assertExactSignedGeneration(
    sourceAppPath,
    targetAppPath,
    signatures.sourceCdHash,
    signatures.targetCdHash,
    targetBuild
  );
  await assertExactBridgeGeneration(sourceAppPath, targetAppPath, false, bridge);
  const installation = await atomicInstallBuiltApp(sourceAppPath, targetAppPath, "", operations);
  return {
    attachStateSnapshot: (snapshot) => installation.attachStateSnapshot(snapshot),
    async markVerified() {
      await assertExactSignedGeneration(
        sourceAppPath, targetAppPath, signatures.sourceCdHash, signatures.sourceCdHash, sourceBuild
      );
      await assertExactBridgeGeneration(sourceAppPath, targetAppPath, true, bridge);
      await installation.markVerified();
    },
    async finalize() {
      await assertExactSignedGeneration(
        sourceAppPath, targetAppPath, signatures.sourceCdHash, signatures.sourceCdHash, sourceBuild
      );
      await assertExactBridgeGeneration(sourceAppPath, targetAppPath, true, bridge);
      if (await pathExists(previousAppPath)) {
        await assertExactSignedGeneration(
          sourceAppPath, previousAppPath, signatures.sourceCdHash, signatures.targetCdHash, targetBuild
        );
        await assertExactBridgeGeneration(sourceAppPath, previousAppPath, false, bridge);
      }
      await installation.finalize();
    },
    async rollback() {
      await installation.rollback();
      await assertExactSignedGeneration(
        sourceAppPath, targetAppPath, signatures.sourceCdHash, signatures.targetCdHash, targetBuild
      );
      await assertExactBridgeGeneration(sourceAppPath, targetAppPath, false, bridge);
    }
  };
}

function alreadyInstalledCandidate(
  sourceAppPath: string,
  targetAppPath: string,
  sourceCdHash: string,
  sourceBuild: BootstrapBuildIdentity,
  bridge: UpdateProtocolBridgeEquivalenceEvidence
): AppInstallation {
  const assertInstalled = async () => {
    await assertExactSignedGeneration(
      sourceAppPath,
      targetAppPath,
      sourceCdHash,
      sourceCdHash,
      sourceBuild
    );
    await assertExactBridgeGeneration(sourceAppPath, targetAppPath, true, bridge);
  };
  return {
    async attachStateSnapshot() {
      throw new Error("Vigil cannot attach rollback state to an already-installed protocol bridge.");
    },
    markVerified: assertInstalled,
    finalize: assertInstalled,
    rollback: assertInstalled
  };
}

async function assertExactSignedGeneration(
  trustedSourceAppPath: string,
  candidateAppPath: string,
  trustedSourceCdHash: string,
  expectedCandidateCdHash: string,
  expectedBuild: BootstrapBuildIdentity
): Promise<void> {
  const firstSignatures = await verifyMatchingSignedApps(trustedSourceAppPath, candidateAppPath);
  const build = await readBuildIdentity(candidateAppPath);
  const secondSignatures = await verifyMatchingSignedApps(trustedSourceAppPath, candidateAppPath);
  if (firstSignatures.sourceCdHash !== secondSignatures.sourceCdHash
    || firstSignatures.targetCdHash !== secondSignatures.targetCdHash
    || secondSignatures.sourceCdHash !== trustedSourceCdHash
    || secondSignatures.targetCdHash !== expectedCandidateCdHash
    || !sameBuildIdentity(build, expectedBuild)) {
    throw new Error("Vigil's bootstrap generation does not match its pinned signature and build identity.");
  }
}

async function exactSignedGenerationMatches(
  trustedSourceAppPath: string,
  candidateAppPath: string,
  trustedSourceCdHash: string,
  expectedCandidateCdHash: string,
  expectedBuild: BootstrapBuildIdentity
): Promise<boolean> {
  try {
    await assertExactSignedGeneration(
      trustedSourceAppPath,
      candidateAppPath,
      trustedSourceCdHash,
      expectedCandidateCdHash,
      expectedBuild
    );
    return true;
  } catch {
    return false;
  }
}

async function assertExactBridgeGeneration(
  trustedBridgeAppPath: string,
  candidateAppPath: string,
  bridgeCandidate: boolean,
  expected: UpdateProtocolBridgeEquivalenceEvidence
): Promise<void> {
  const observed = bridgeCandidate
    ? await verifyUpdateProtocolBridgeEquivalence(
      null,
      candidateAppPath,
      { allowAtomicInstallBundlePaths: true }
    )
    : await verifyUpdateProtocolBridgeEquivalence(
      candidateAppPath,
      trustedBridgeAppPath,
      { allowAtomicInstallBundlePaths: true }
    );
  if (!sameBridgeEquivalence(observed, expected)) {
    throw new Error("Vigil's bootstrap generation does not match its pinned A-equivalent bridge manifest.");
  }
}

async function exactBridgeGenerationMatches(
  trustedBridgeAppPath: string,
  candidateAppPath: string,
  bridgeCandidate: boolean,
  expected: UpdateProtocolBridgeEquivalenceEvidence
): Promise<boolean> {
  try {
    await assertExactBridgeGeneration(trustedBridgeAppPath, candidateAppPath, bridgeCandidate, expected);
    return true;
  } catch {
    return false;
  }
}

function sameBuildIdentity(left: BootstrapBuildIdentity, right: BootstrapBuildIdentity): boolean {
  return left.commit === right.commit
    && left.fingerprint === right.fingerprint
    && left.sourceRoot === right.sourceRoot;
}

function sameBridgeEquivalence(
  left: UpdateProtocolBridgeEquivalenceEvidence,
  right: UpdateProtocolBridgeEquivalenceEvidence
): boolean {
  return left.manifestSha256 === right.manifestSha256
    && left.equivalentTreeSha256 === right.equivalentTreeSha256
    && left.payloadTreeSha256 === right.payloadTreeSha256
    && left.wrappersSha256 === right.wrappersSha256
    && left.baselineBuildInfoSha256 === right.baselineBuildInfoSha256;
}

function assertSameSignatures(
  left: SignedSetupBundleIdentity,
  right: SignedSetupBundleIdentity,
  message: string
): void {
  if (left.sourceCdHash !== right.sourceCdHash || left.targetCdHash !== right.targetCdHash) {
    throw new Error(message);
  }
}

function assertAuthorizedTargetIdentity(value: BootstrapAuthorizedTargetIdentity): void {
  if (!/^[a-f0-9]{40,64}$/u.test(value.cdHash)
    || !/^[a-f0-9]{40}$/u.test(value.build.commit)
    || !/^[a-f0-9]{64}$/u.test(value.build.fingerprint)
    || !isAbsolute(value.build.sourceRoot)) {
    throw new Error("Vigil refused malformed authorized target-generation evidence.");
  }
}

function sameAuthorizedTargetIdentity(
  left: BootstrapAuthorizedTargetIdentity,
  right: BootstrapAuthorizedTargetIdentity
): boolean {
  return left.cdHash === right.cdHash && sameBuildIdentity(left.build, right.build);
}

async function readPinnedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new Error(`Vigil refused an unsafe signed bootstrap file at ${path}.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) {
      throw new Error(`Vigil refused a changing signed bootstrap file at ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

export function assertPathTopology(sourceAppPath: string, targetAppPath: string, userDataDir: string): void {
  const protectedPaths = [
    targetAppPath,
    `${targetAppPath}.vigil-next`,
    `${targetAppPath}.vigil-previous`,
    `${targetAppPath}.vigil-transaction.json`,
    userDataDir
  ].map((path) => resolve(path));
  const source = resolve(sourceAppPath);
  for (const protectedPath of protectedPaths) {
    if (pathsOverlap(source, protectedPath)) {
      throw new Error("Vigil's updater-protocol bridge source must be disjoint from installed, recovery, and user-data paths.");
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || pathIsInside(left, right) || pathIsInside(right, left);
}

function pathIsInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return Boolean(child && child !== ".." && !child.startsWith(`..${sep}`) && resolve(root, child) === path);
}

function validateRequest(request: UpdateProtocolBootstrapRequest): void {
  if (process.platform !== "darwin") {
    throw new Error("Vigil's update-protocol bootstrap is available only on macOS.");
  }
  if (!isAbsolute(request.sourceAppPath) || !request.sourceAppPath.endsWith(".app")) {
    throw new Error("Vigil's update-protocol bootstrap requires an absolute signed source app path.");
  }
  if (request.targetAppPath !== DEFAULT_TARGET_APP_PATH) {
    throw new Error(`Vigil's update-protocol bootstrap targets only ${DEFAULT_TARGET_APP_PATH}.`);
  }
  const account = userInfo();
  const uid = process.getuid?.();
  if (!Number.isInteger(request.targetUid)
    || request.targetUid < 501
    || uid === undefined
    || request.targetUid !== uid
    || request.targetHome !== account.homedir
    || request.targetUser !== account.username) {
    throw new Error("Vigil's update-protocol bootstrap requires the exact signed-in macOS account.");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(request.bootstrapToken)) {
    throw new Error("Vigil's update-protocol bootstrap requires its fresh administrator-approved token.");
  }
  if (!/^[a-f0-9]{40}$/iu.test(request.expectedUpdateCommit)) {
    throw new Error("Vigil's update-protocol bootstrap requires the exact follow-on update commit.");
  }
}

function parseOptions(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
    else values.set(argument.slice(2), String(argv[index + 1] || ""));
  }
  return values;
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

export async function runBootstrapCli(argv = process.argv.slice(2)): Promise<void> {
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") {
    throw new Error("Open the update-protocol bootstrap through Vigil's signed launcher.");
  }
  const values = parseOptions(argv);
  const account = userInfo();
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 501) {
    throw new Error("Open Vigil's update-protocol bootstrap from the signed-in macOS account.");
  }
  const lockPath = required(values, "lock-path");
  const lockToken = required(values, "lock-token");
  if (values.get("transferred-lock") !== "true"
    || lockPath !== defaultUpdaterLockPath(account.homedir)) {
    throw new Error("Vigil's update-protocol bootstrap requires its exact transferred updater lock.");
  }
  const sourceAppPath = await realpath(required(values, "source-app"));
  const targetAppPath = values.get("target-app") || DEFAULT_TARGET_APP_PATH;
  const bootstrapToken = required(values, "bootstrap-token");
  const expectedUpdateCommit = required(values, "expected-update-commit");
  const workerRequest = await publishBootstrapWorkerAuthorizationRequest({
    bootstrapToken,
    lockPath,
    lockToken,
    sourceAppPath,
    targetAppPath,
    expectedUpdateCommit,
    workerPid: process.pid,
    relayPid: process.ppid
  });
  try {
    await waitForTransferredUpdaterLock(lockPath, lockToken, process.pid);
    const result = await bootstrapUpdateProtocol({
      sourceAppPath,
      targetAppPath,
      targetHome: account.homedir,
      targetUid: Number(uid),
      targetUser: account.username,
      bootstrapToken,
      expectedUpdateCommit
    }, undefined, {
      path: lockPath,
      token: lockToken,
      ownerPid: process.pid,
      // The setup parent retains the token-bearing release capability and
      // releases only after this worker and its maintenance marker have exited.
      async release() {}
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await workerRequest.release();
  }
}

export async function waitForTransferredUpdaterLock(
  lockPath: string,
  lockToken: string,
  ownerPid = process.pid,
  timeoutMs = LOCK_TRANSFER_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil updater lock ownership has not transferred yet.");
  do {
    try {
      await assertOwnedUpdaterLock(lockPath, lockToken, ownerPid);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, LOCK_TRANSFER_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Vigil did not receive its exact transferred updater lock: ${errorMessage(lastError)}`);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown bootstrap error.");
}

if (isDirectRun(import.meta.url)) {
  try {
    await runBootstrapCli();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: errorMessage(error), id: randomUUID() })}\n`);
    process.exitCode = 1;
  }
}
