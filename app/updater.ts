import type { App } from "electron";
import { isLocallyRebuildableSignature } from "../scripts/mac-signing-identity.mjs";
import { inspectInstalledUpdateTopology } from "../scripts/update-packaged-app.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, readFileSync } from "node:fs";
import { access, link, lstat, mkdir, open, readFile, realpath, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { userInfo } from "node:os";
import { fileURLToPath } from "node:url";
import { plistStringForKey } from "../src/plist.js";
import { sourceFingerprint } from "../scripts/source-fingerprint.mjs";
import { gitExecutable } from "../scripts/git-executable.mjs";
import { assertGuardianMaintenanceActive, guardianMaintenanceReadiness } from "../src/updateMaintenance.js";
import {
  preflightGuardianUpdateCompatibility,
  setupSystemGuardian
} from "../src/guardianSetup.js";
import {
  verifyAndStagePrebuiltRelease
} from "../src/prebuiltRelease.js";
import type { VerifiedPrebuiltRelease } from "../src/prebuiltRelease.js";
import {
  cleanupDownloadedPrebuiltRelease,
  cleanupOrphanedPrebuiltDownloads,
  configuredPrebuiltUpdateManifestUrl,
  downloadPrebuiltRelease
} from "../src/prebuiltReleaseDownload.js";
import type { DownloadedPrebuiltRelease } from "../src/prebuiltReleaseDownload.js";
import {
  beginUpdateReceipt,
  failedUpdateReceiptSuperseded,
  isTerminalUpdateReceipt,
  mergeWriteUpdateReceipt,
  newUpdateReceipt,
  readUpdateReceipt,
  receiptMatchesActiveLock,
  receiptTargetInstalled
} from "../src/updateReceipt.js";
import type { LegacyUpdateReceipt, UpdateReceipt } from "../src/updateReceipt.js";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME,
  readUpdateRecoveryManifest,
  readUpdateRecoveryOutcome,
  readUpdateRecoveryPolicyFile
} from "../src/updateTransaction.js";
import type { UpdateRecoveryOutcome } from "../src/updateTransaction.js";
import {
  collectUpdatePreflight,
  firstUpdatePreflightFailure,
  updatePreflightFailureMessage
} from "../src/updatePreflight.js";
import type {
  UpdatePreflightCheck,
  UpdatePreflightCheckDefinition,
  UpdatePreflightCheckResult,
  UpdatePreflightReport
} from "../src/updatePreflight.js";

const UPDATE_STATUS_FILENAME = "update-status.json";
const UPDATE_LOG_FILENAME = "update.log";
const UPDATE_LOCK_FILENAME = "update.lock";
const EXEC_TIMEOUT_MS = 5000;
const FETCH_TIMEOUT_MS = 60_000;
const UPDATER_BOOTSTRAP_TIMEOUT_MS = 5_000;
const REPO_CHECK_ATTEMPTS = 3;
const REPO_CHECK_RETRY_MS = 150;
const EXEC_TERMINATION_GRACE_MS = 1_000;
const EXEC_KILL_CONFIRMATION_MS = 2_000;
const EXEC_TERMINATION_POLL_MS = 25;
const UPDATER_BOOTSTRAP_TERMINATION_TIMEOUT_MS = 5_000;
const UPDATER_BOOTSTRAP_TERMINATION_POLL_MS = 25;
const MINIMUM_BUILD_FREE_BYTES = 2 * 1024 * 1024 * 1024;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RepoInfo {
  ok: boolean;
  error: string | null;
  repoRoot: string;
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

interface BuildInfo {
  builtAt?: string;
  commit?: string;
  branch?: string;
  dirty?: boolean;
  sourceRoot?: string;
  sourceFingerprint?: string;
}

type LastUpdateStatus = UpdateReceipt | LegacyUpdateReceipt;

interface UpdateLockPayload {
  token: string;
  pid: number;
  startedAt: string;
  ownerStartedAt?: string;
}

export interface UpdaterLock {
  path: string;
  token: string;
  transferTo(pid: number): Promise<void>;
  release(): Promise<void>;
}

export interface UpdaterLockRecoveryHooks {
  afterSnapshot?(): Promise<void>;
  afterReleaseSnapshot?(): Promise<void>;
}

export interface UpdaterBootstrapTerminationOperations {
  signal(pid: number): void;
  processGroupExists(pid: number): boolean;
  wait(milliseconds: number): Promise<void>;
}

class UpdaterBootstrapOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdaterBootstrapOwnershipError";
  }
}

interface PinnedUpdaterLockSnapshot {
  handle: FileHandle;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  raw: string;
  payload: UpdateLockPayload | null;
}

interface SourceUpdatePreflight {
  report: UpdatePreflightReport;
  nodePath: string | null;
  npmPath: string | null;
}

interface PreparedPrebuiltRelease {
  download: DownloadedPrebuiltRelease;
  verified: VerifiedPrebuiltRelease;
}

export interface VigilAppUpdateController {
  status(options?: { checkRemote?: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
  relaunch(): Promise<unknown>;
}

interface ControllerOptions {
  app: App;
  quitForUpdate(): void | Promise<void>;
  relaunchApp?(): void | Promise<void>;
  maintenanceReadiness?: typeof guardianMaintenanceReadiness;
  setupGuardian?: typeof setupSystemGuardian;
}

interface GlobalUpdateRecoveryStatus {
  hasManifest: boolean;
  blocked: boolean;
  message: string | null;
  attemptId: string | null;
  outcome: UpdateRecoveryOutcome | null;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function createVigilAppUpdateController({
  app,
  quitForUpdate,
  relaunchApp,
  maintenanceReadiness = guardianMaintenanceReadiness,
  setupGuardian = setupSystemGuardian
}: ControllerOptions): VigilAppUpdateController {
  let repoRoot = findRepoRoot(app);
  let appPath = packagedAppPath(repoRoot);
  const userDataDir = app.getPath("userData");
  const updateDir = join(userDataDir, "updater");
  const statusPath = join(updateDir, UPDATE_STATUS_FILENAME);
  const logPath = join(updateDir, UPDATE_LOG_FILENAME);
  const lockPath = join(updateDir, UPDATE_LOCK_FILENAME);
  let scriptPath = updateScriptPath(repoRoot);
  let startInFlight: Promise<unknown> | null = null;

  async function readStatusPayload(
    { checkRemote = false, ownedLockToken = "" }: { checkRemote?: boolean; ownedLockToken?: string } = {}
  ): Promise<Record<string, unknown>> {
    const discoveredRepoRoot = findRepoRoot(app, repoRoot);
    if (discoveredRepoRoot !== repoRoot) {
      repoRoot = discoveredRepoRoot;
      appPath = packagedAppPath(repoRoot);
      scriptPath = updateScriptPath(repoRoot);
    }
    await mkdir(updateDir, { recursive: true });
    const remoteCheck = checkRemote ? await execGit(repoRoot, ["fetch", "--prune"], FETCH_TIMEOUT_MS) : null;
    const [repo, currentSourceFingerprint, runtimeBuild, appBuild, appStat, lastUpdateRead, activeLock, maintenance, recovery] = await Promise.all([
      readRepoInfo(repoRoot),
      sourceFingerprint(repoRoot),
      readBuildInfo(join(repoRoot, "dist", "runtime", "build-info.json")),
      readFirstBuildInfo([
        join(appPath, "Contents", "Resources", "app.asar", "dist", "runtime", "build-info.json"),
        join(appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json")
      ]),
      optionalStat(join(appPath, "Contents", "Resources", "app.asar")),
      readUpdateReceipt(statusPath),
      readActiveUpdaterLock(lockPath),
      maintenanceReadiness(),
      readGlobalUpdateRecovery(updateDir)
    ]);
    const running = Boolean(activeLock && activeLock.token !== ownedLockToken);
    const lastUpdate = lastUpdateRead.status === "valid" || lastUpdateRead.status === "legacy"
      ? lastUpdateRead.receipt
      : null;
    const activeAttemptStatus = running && receiptMatchesActiveLock(lastUpdate, activeLock) ? lastUpdate : null;
    const recoveryOutcomeApplies = Boolean(
      recovery.outcome
      && (!lastUpdate
        || ("attemptId" in lastUpdate && lastUpdate.attemptId === recovery.outcome.attemptId))
    );
    const recoveredComplete = recoveryOutcomeApplies && recovery.outcome?.status === "complete";
    const recoveredFailure = recoveryOutcomeApplies && recovery.outcome?.status === "failed-recovered";
    const recoveryBlocked = !running && recovery.hasManifest && recovery.blocked;
    const recoveryPending = !running && recovery.hasManifest && !recovery.blocked;
    const appCommit = appBuild?.commit || null;
    const currentCommit = repo.ok ? repo.head : runtimeBuild?.commit || "";
    const sourceFingerprintOk = typeof currentSourceFingerprint === "string"
      && /^[a-f0-9]{64}$/iu.test(currentSourceFingerprint);
    const appMatchesCheckout = Boolean(
      repo.ok
      && sourceFingerprintOk
      && currentCommit
      && appCommit === currentCommit
      && appBuild?.sourceFingerprint === currentSourceFingerprint
    );
    // A verified app update may complete even when the final best-effort Git
    // fast-forward is interrupted. In that state the installed bundle already
    // represents the fetched upstream target and must not be offered again or
    // described as a failed installation merely because the checkout lags.
    const appMatchesUpstream = Boolean(
      repo.ok
      && repo.upstream
      && appCommit === repo.upstream
      && appBuild?.dirty === false
    );
    const appBundleOutdated = Boolean(repo.ok && sourceFingerprintOk && !appMatchesCheckout);
    const localChanges = Boolean(repo.dirty && !appMatchesCheckout);
    const installedBuildEvidence = {
      builtAt: typeof appBuild?.builtAt === "string" ? appBuild.builtAt : null,
      modifiedAt: appStat?.mtime || null,
      commit: appCommit,
      fingerprint: appBuild?.sourceFingerprint || null
    };
    const lastUpdateTargetInstalled = receiptTargetInstalled(lastUpdate, installedBuildEvidence);
    const failureSupersededByBuild = failedUpdateReceiptSuperseded(lastUpdate, installedBuildEvidence);
    const lastUpdateCorrectedComplete = Boolean(
      recoveredComplete
      || (lastUpdate?.phase === "failed"
        && (lastUpdateTargetInstalled || appMatchesUpstream || failureSupersededByBuild))
    );
    const lastUpdateSuperseded = failureSupersededByBuild
      || lastUpdateCorrectedComplete;
    const orphanedAttempt = Boolean(
      lastUpdate
      && !running
      && !recoveryOutcomeApplies
      && !recovery.hasManifest
      && !isTerminalUpdateReceipt(lastUpdate)
    );
    const orphanedAttemptInstalled = orphanedAttempt && receiptTargetInstalled(lastUpdate, installedBuildEvidence);
    // A clean PR/worktree branch can legitimately have no upstream yet. Its
    // checked-out commit is still a valid local build source, just not a remote
    // update target.
    const localCheckoutBuild = shouldBuildLocalCheckout(repo, appBundleOutdated, localChanges);
    const remoteCheckOk = remoteCheck ? remoteCheck.ok : null;
    const checkOk = repo.ok
      && sourceFingerprintOk
      && !recovery.hasManifest
      && (localCheckoutBuild || remoteCheckOk !== false);
    const supported = repo.ok && Boolean(scriptPath);
    const updateCandidateAvailable = Boolean(checkOk && supported && (
      localCheckoutBuild || shouldInstallRemoteUpdate(repo, appBundleOutdated, appMatchesUpstream)
    ));
    const updateAvailable = updateCandidateAvailable;
    let displayPhase: string | null = lastUpdate?.phase || null;
    if (lastUpdateCorrectedComplete) displayPhase = "complete";
    if (orphanedAttempt) displayPhase = orphanedAttemptInstalled ? "complete" : "failed";
    if (recoveredFailure) displayPhase = "failed";
    if (recoveredComplete) displayPhase = "complete";
    if (updateAvailable) displayPhase = "available";
    if (recoveryPending) displayPhase = "recovering";
    if (recoveryBlocked) displayPhase = "failed";
    if (running) displayPhase = activeAttemptStatus?.phase || "starting";
    return {
      // `ok` describes a valid status response. Repository/fetch health is a
      // separate field so a transient check failure cannot erase a live update
      // lock or make either UI stop polling the active transaction.
      ok: true,
      checkOk,
      supported,
      running,
      recoveryPending,
      recoveryBlocked,
      recoveryAttemptId: recovery.attemptId,
      recoveryOutcome: recoveryOutcomeApplies ? recovery.outcome : null,
      updateAvailable,
      updateCandidateAvailable,
      appBundleOutdated,
      repoRoot,
      appPath,
      branch: repo.branch,
      currentCommit,
      currentSourceFingerprint,
      sourceFingerprintVerified: sourceFingerprintOk,
      appCommit,
      appSourceFingerprint: appBuild?.sourceFingerprint || null,
      appMatchesCheckout,
      appMatchesUpstream,
      installedAppCurrent: appMatchesCheckout || appMatchesUpstream,
      upstreamCommit: repo.upstream,
      ahead: repo.ahead,
      behind: repo.behind,
      dirty: repo.dirty,
      localChanges: localCheckoutBuild,
      repoError: repo.error,
      runtimeBuiltAt: runtimeBuild?.builtAt || null,
      appBuiltAt: appBuild?.builtAt || null,
      appBundleModifiedAt: appStat?.mtime.toISOString() || null,
      remoteCheckedAt: checkRemote ? new Date().toISOString() : null,
      remoteCheckOk,
      remoteCheckError: remoteCheck && !remoteCheck.ok ? execResultDetail(remoteCheck) : null,
      maintenanceReady: maintenance.ready,
      maintenanceMessage: maintenance.message,
      maintenanceSetupRequired: maintenance.setupRequired,
      maintenanceSetupSupported: maintenance.setupSupported,
      maintenanceReason: maintenance.reason,
      logPath,
      lastUpdate,
      lastUpdateTargetInstalled,
      lastUpdateCorrectedComplete,
      lastUpdateSuperseded,
      lastUpdateInterrupted: orphanedAttempt,
      lastUpdateInterruptedAfterInstall: orphanedAttemptInstalled,
      updateReceiptError: lastUpdateRead.status === "invalid" ? lastUpdateRead.reason : null,
      phase: displayPhase,
      message: updateMessage({
        repo,
        sourceFingerprintOk,
        appBundleOutdated,
        appMatchesUpstream,
        localChanges: localCheckoutBuild,
        running,
        recoveryPending,
        recoveryBlocked,
        recoveryMessage: recovery.message,
        recoveryOutcome: recoveryOutcomeApplies ? recovery.outcome : null,
        activeAttemptStatus,
        remoteCheckError: remoteCheck && !remoteCheck.ok,
        maintenance,
        updateCandidateAvailable,
        lastUpdate,
        lastUpdateCorrectedComplete,
        lastUpdateSuperseded,
        orphanedAttempt,
        orphanedAttemptInstalled
      })
    };
  }

  return {
    async status(options = {}) {
      return await readStatusPayload(options);
    },
    async start() {
      if (startInFlight) {
        return {
          ok: false,
          supported: true,
          running: true,
          phase: "starting",
          message: "A Vigil update is already starting.",
          error: "A Vigil update is already starting."
        };
      }
      startInFlight = startOnce();
      try {
        return await startInFlight;
      } finally {
        startInFlight = null;
      }
    },
    async relaunch() {
      if (!relaunchApp) {
        return {
          ok: false,
          relaunching: false,
          message: "Protected app relaunch is available from the packaged Vigil app."
        };
      }
      if (startInFlight) {
        return {
          ok: false,
          relaunching: false,
          running: true,
          message: "Vigil cannot relaunch while an update is starting."
        };
      }
      const currentStatus = await readStatusPayload();
      if (currentStatus.running === true
        || currentStatus.recoveryPending === true
        || currentStatus.recoveryBlocked === true) {
        return {
          ...currentStatus,
          ok: false,
          relaunching: false,
          message: String(
            currentStatus.message
            || "Vigil cannot relaunch while an update or recovery transaction is active."
          )
        };
      }
      await relaunchApp();
      return {
        ...currentStatus,
        ok: true,
        relaunching: true,
        message: "Vigil is relaunching under its restart supervisor."
      };
    }
  };

  async function startOnce(): Promise<unknown> {
    await mkdir(updateDir, { recursive: true });
    let updateLock: UpdaterLock;
    try {
      updateLock = await acquireUpdaterLock(lockPath);
    } catch (error) {
      const message = errorMessage(error);
      try {
        const activeStatus = await readStatusPayload();
        return { ...activeStatus, ok: false, error: message };
      } catch {
        return { ok: false, running: false, phase: "failed", message, error: message };
      }
    }
    let handedOff = false;
    let preserveUpdateLock = false;
    let receiptStarted = false;
    let currentStatus: Record<string, unknown> = {};
    let updaterChild: ReturnType<typeof spawn> | null = null;
    let updaterLockTransferred = false;
    let downloadedPrebuiltRelease: DownloadedPrebuiltRelease | null = null;
    let preparedPrebuiltRelease: PreparedPrebuiltRelease | null = null;
    const failAttempt = async (
      message: string,
      failure: UpdatePreflightCheck | null = null,
      preflight: UpdatePreflightReport | null = null
    ): Promise<Record<string, unknown>> => {
      let finalMessage = message;
      let finalFailure = failure;
      if (!handedOff && !preserveUpdateLock && downloadedPrebuiltRelease) {
        try {
          await cleanupDownloadedPrebuiltRelease(downloadedPrebuiltRelease.root, updateDir);
          downloadedPrebuiltRelease = null;
          preparedPrebuiltRelease = null;
        } catch (cleanupError) {
          const cleanupDetail = `Prebuilt-release cleanup also failed: ${errorMessage(cleanupError)}`;
          finalMessage = `${finalMessage} ${cleanupDetail}`;
          finalFailure = finalFailure
            ? {
                ...finalFailure,
                detail: finalFailure.detail
                  ? `${finalFailure.detail} ${cleanupDetail}`
                  : cleanupDetail
              }
            : {
                code: "vigil.update.prebuilt.cleanup",
                label: "Prebuilt release cleanup",
                status: "fail",
                message: finalMessage,
                detail: cleanupDetail
              };
        }
      }
      if (receiptStarted) {
        if (preserveUpdateLock) {
          await mergeWriteUpdateReceipt(statusPath, updateLock.token, {
            phase: "waiting",
            message: finalMessage
          }).catch(() => undefined);
        } else {
          await mergeWriteUpdateReceipt(statusPath, updateLock.token, {
            phase: "failed",
            message: finalMessage,
            error: finalMessage
          }).catch(() => undefined);
        }
      }
      return {
        ...currentStatus,
        ok: false,
        running: preserveUpdateLock,
        phase: preserveUpdateLock ? "waiting" : "failed",
        message: finalMessage,
        error: finalMessage,
        errorCode: finalFailure?.code || "vigil.update.start.failed",
        failedCheck: finalFailure?.label || "Updater start",
        errorDetail: finalFailure?.detail || null,
        preflight
      };
    };
    const failPreflight = async (preflight: SourceUpdatePreflight): Promise<Record<string, unknown>> => {
      const failure = firstUpdatePreflightFailure(preflight.report);
      const message = failure
        ? updatePreflightFailureMessage(failure)
        : "Vigil update preflight did not pass.";
      const structuredGuardianFailure = guardianCheckFailure(
        `${failure?.message || ""} ${failure?.detail || ""}`
      );
      return await failAttempt(message, structuredGuardianFailure || failure, preflight.report);
    };
    try {
      currentStatus = await readStatusPayload({ ownedLockToken: updateLock.token });
      if (currentStatus.recoveryPending === true || currentStatus.recoveryBlocked === true) {
        const message = String(currentStatus.message || "Vigil must finish recovering the previous update before another can start.");
        return await failAttempt(message, {
          code: "vigil.update.recovery.clear",
          label: "Previous update recovery",
          status: "fail",
          message: "The previous Vigil update still requires recovery.",
          detail: message
        });
      }
      try {
        await cleanupOrphanedPrebuiltDownloads(updateDir);
      } catch (error) {
        const failure: UpdatePreflightCheck = {
          code: "vigil.update.prebuilt.cleanup",
          label: "Prebuilt release cleanup",
          status: "fail",
          message: "Vigil could not safely reconcile an earlier prebuilt-release download.",
          detail: errorMessage(error)
        };
        return await failAttempt(updatePreflightFailureMessage(failure), failure);
      }
      const setupOnlyRequired = currentStatus.maintenanceReady !== true
        && currentStatus.maintenanceSetupRequired === true
        && currentStatus.maintenanceSetupSupported === true;
      if (setupOnlyRequired) {
        const account = userInfo();
        const uid = process.getuid?.();
        if (!Number.isInteger(uid) || Number(uid) < 501) {
          return await failAttempt(
            "Vigil could not identify the signed-in account for protected update setup.",
            {
              code: "vigil.guardian.setup.account",
              label: "Guardian setup account",
              status: "fail",
              message: "The signed-in account could not be verified.",
              detail: "No password, build, or installation was requested."
            }
          );
        }
        const setupResult = await setupGuardian({
          sourceAppPath: appPath,
          targetAppPath: appPath,
          targetHome: account.homedir,
          targetUid: Number(uid),
          targetUser: account.username,
          // A setup click promises a usable follow-on update. Refuse during
          // read-only preflight, before macOS can prompt, if a loaded
          // predecessor requires Vigil's protected background launch.
          requireNormalUpdateCompatibility: true
        });
        if (!setupResult.ok) {
          const structuredGuardianFailure = guardianCheckFailure(setupResult.message);
          return await failAttempt(
            setupResult.message || "Vigil update setup was canceled.",
            structuredGuardianFailure || {
              code: setupResult.canceled
                ? "vigil.guardian.setup.canceled"
                : "vigil.guardian.setup.failed",
              label: "Guardian setup",
              status: "fail",
              message: setupResult.message || "Guardian setup did not complete.",
              detail: "Vigil stayed online. No build or installation was started."
            }
          );
        }
        currentStatus = await readStatusPayload({ ownedLockToken: updateLock.token });
        if (currentStatus.maintenanceReady !== true) {
          return await failAttempt(
            String(
              currentStatus.maintenanceMessage
              || "Vigil could not verify protected update setup after approval."
            ),
            {
              code: "vigil.guardian.setup.postflight",
              label: "Guardian setup postflight",
              status: "fail",
              message: "The new guardian did not pass its post-setup readiness check.",
              detail: String(currentStatus.maintenanceReason || currentStatus.maintenanceMessage || "Readiness remained false.")
            }
          );
        }
        return {
          ...currentStatus,
          ok: true,
          running: false,
          phase: "",
          setupComplete: true,
          message: currentStatus.updateCandidateAvailable === true
            ? "Fast protected updates are ready. The selected update can now be installed without another password."
            : "Fast protected updates are ready."
        };
      }
      if (currentStatus.checkOk !== true) {
        const detail = String(
          currentStatus.repoError
          || currentStatus.message
          || "The Vigil source repository could not be verified."
        );
        return await failAttempt(detail, {
          code: "vigil.update.repository.verified",
          label: "Source repository",
          status: "fail",
          message: "Vigil could not verify its source repository.",
          detail
        });
      }
      if (currentStatus.supported !== true || !scriptPath) {
        return await failAttempt("Updater script is missing from this Vigil build.", {
          code: "vigil.update.updater.script",
          label: "Packaged updater script",
          status: "fail",
          message: "The packaged Vigil updater script is missing.",
          detail: scriptPath || "No updater script path was found in the signed app or runtime."
        });
      }

      // Complete every non-privileged, non-building check before macOS can ask
      // for an administrator password. Remote selection is refreshed first so
      // a disappeared target or changed checkout never causes a needless
      // guardian prompt.
      const initiallyLocalAttempt = currentStatus.localChanges === true;
      if (!initiallyLocalAttempt) {
        currentStatus = await readStatusPayload({ checkRemote: true, ownedLockToken: updateLock.token });
        if (currentStatus.remoteCheckOk !== true) {
          const failure: UpdatePreflightCheck = {
            code: "vigil.update.remote.fetch",
            label: "Remote update refresh",
            status: "fail",
            message: "Vigil could not refresh the remote update target.",
            detail: String(
              currentStatus.remoteCheckError
              || currentStatus.repoError
              || "The Git fetch did not complete successfully."
            )
          };
          return await failAttempt(updatePreflightFailureMessage(failure), failure);
        }
        if (currentStatus.checkOk !== true) {
          const failure: UpdatePreflightCheck = {
            code: "vigil.update.repository.verified",
            label: "Source repository",
            status: "fail",
            message: "The source repository failed verification after the remote refresh.",
            detail: String(
              currentStatus.repoError
              || currentStatus.message
              || "The repository or source fingerprint check failed."
            )
          };
          return await failAttempt(updatePreflightFailureMessage(failure), failure);
        }
        if (currentStatus.updateAvailable !== true) {
          const noUpdate = await prepareRemoteUpdateReceipt(statusPath, updateLock.token, currentStatus);
          return noUpdate.status;
        }
        let prebuiltManifestUrl: string | null;
        try {
          prebuiltManifestUrl = configuredPrebuiltUpdateManifestUrl();
        } catch (error) {
          const failure: UpdatePreflightCheck = {
            code: "vigil.update.prebuilt.configuration",
            label: "Prebuilt release configuration",
            status: "fail",
            message: "Vigil's configured prebuilt release URL is invalid.",
            detail: errorMessage(error)
          };
          return await failAttempt(updatePreflightFailureMessage(failure), failure);
        }
        if (prebuiltManifestUrl) {
          const targetCommit = String(currentStatus.upstreamCommit || "");
          try {
            const download = await downloadPrebuiltRelease({
              manifestUrl: prebuiltManifestUrl,
              selectedCommit: targetCommit,
              storageRoot: updateDir
            });
            downloadedPrebuiltRelease = download;
            preparedPrebuiltRelease = {
              download,
              verified: await verifyAndStagePrebuiltRelease({
                artifactPath: download.artifactPath,
                installedAppPath: appPath,
                manifestPath: download.manifestPath,
                stagingRoot: download.root
              })
            };
            if (preparedPrebuiltRelease.verified.manifest.commit !== targetCommit) {
              throw new Error("The verified signed release no longer matches the selected upstream commit.");
            }
          } catch (error) {
            let detail = errorMessage(error);
            if (downloadedPrebuiltRelease) {
              try {
                await cleanupDownloadedPrebuiltRelease(downloadedPrebuiltRelease.root, updateDir);
                downloadedPrebuiltRelease = null;
              } catch (cleanupError) {
                detail = `${detail} Cleanup also failed: ${errorMessage(cleanupError)}`;
              }
            }
            const failure: UpdatePreflightCheck = {
              code: "vigil.update.prebuilt.verified",
              label: "Prebuilt signed release",
              status: "fail",
              message: "Vigil could not verify the configured prebuilt signed release.",
              detail
            };
            return await failAttempt(updatePreflightFailureMessage(failure), failure);
          }
        }
      }
      const sourcePreflight = await collectSourceUpdatePreflight({
        app,
        appPath,
        currentStatus,
        localAttempt: initiallyLocalAttempt,
        prebuiltRelease: preparedPrebuiltRelease,
        repoRoot,
        scriptPath: initiallyLocalAttempt ? localLauncherPath(repoRoot) : scriptPath,
        updateDir
      });
      currentStatus = { ...currentStatus, preflight: sourcePreflight.report };
      if (!sourcePreflight.report.ok) return await failPreflight(sourcePreflight);

      if (currentStatus.maintenanceReady !== true) {
        return await failAttempt(
          String(currentStatus.maintenanceMessage || "Vigil's protected update setup is not ready."),
          {
            code: "vigil.guardian.readiness",
            label: "Guardian readiness",
            status: "fail",
            message: "Protected update maintenance is not ready.",
            detail: String(currentStatus.maintenanceReason || currentStatus.maintenanceMessage || "Guardian readiness remained false.")
          }
        );
      }

      const localAttempt = initiallyLocalAttempt;
      if (localAttempt) {
        await prepareLocalUpdateReceipt(statusPath, updateLock.token, currentStatus);
        receiptStarted = true;
        const result = await launchLocalChanges(currentStatus, updateLock, sourcePreflight);
        if (result.ok === true) handedOff = true;
        return result.ok === true ? result : await failAttempt(String(result.error || result.message || "The local Vigil update could not start."));
      }
      const remotePreparation = await prepareRemoteUpdateReceipt(statusPath, updateLock.token, currentStatus);
      currentStatus = remotePreparation.status;
      if (!remotePreparation.started) {
        return currentStatus;
      }
      receiptStarted = true;
      const { nodePath, npmPath } = sourcePreflight;
      if (!nodePath || (!preparedPrebuiltRelease && !npmPath)) return await failPreflight(sourcePreflight);
      const childEnv = updaterChildEnvironment(app.getPath("home"), nodePath, npmPath || nodePath);
      await mergeWriteUpdateReceipt(statusPath, updateLock.token, {
        phase: "starting",
        message: "Launching the protected Vigil updater",
        targetCommit: stringOrNull(currentStatus.upstreamCommit)
      });
      const command = [
        scriptPath,
        "--repo-root", repoRoot,
        "--app-path", appPath,
        "--parent-pid", String(process.pid),
        "--user-data-dir", userDataDir,
        "--status-path", statusPath,
        "--log-path", logPath,
        "--lock-path", lockPath,
        "--lock-token", updateLock.token,
        "--expected-initial-commit", String(currentStatus.currentCommit || ""),
        "--expected-branch", String(currentStatus.branch || ""),
        "--expected-commit", String(currentStatus.upstreamCommit || ""),
        "--restart"
      ];
      if (preparedPrebuiltRelease) {
        command.push(
          "--prebuilt-root", preparedPrebuiltRelease.download.root,
          "--prebuilt-manifest-path", preparedPrebuiltRelease.download.manifestPath,
          "--prebuilt-app-path", preparedPrebuiltRelease.verified.stagedAppPath,
          "--prebuilt-cdhash", preparedPrebuiltRelease.verified.candidateCdHash
        );
      }
      let quitAuthorizationInFlight = false;
      const requestQuit = () => {
        const childPid = updaterChild?.pid;
        if (!childPid || quitAuthorizationInFlight) return;
        quitAuthorizationInFlight = true;
        void authorizeQuit(childPid);
      };
      async function authorizeQuit(childPid: number): Promise<void> {
        try {
          await assertGuardianMaintenanceActive(lockPath, updateLock.token, childPid);
          await quitForUpdate();
          process.off("SIGUSR2", requestQuit);
        } catch (error) {
          quitAuthorizationInFlight = false;
          console.error("Vigil rejected an unauthenticated updater quit request.", error);
        }
      }
      process.on("SIGUSR2", requestQuit);
      try {
        updaterChild = spawn(nodePath, command, {
          detached: true,
          stdio: "ignore",
          cwd: repoRoot,
          env: {
            ...childEnv,
            VIGIL_UPDATE_LAUNCHED_BY: "vigil-app",
            ...(npmPath ? { VIGIL_UPDATE_NPM_PATH: npmPath } : {})
          }
        });
        await childStarted(updaterChild);
        if (!updaterChild.pid) throw new Error("The updater process did not report a process ID.");
      } catch (error) {
        process.off("SIGUSR2", requestQuit);
        throw error;
      }
      updaterChild.once("exit", () => process.off("SIGUSR2", requestQuit));
      await updateLock.transferTo(updaterChild.pid);
      updaterLockTransferred = true;
      await waitForUpdaterBootstrap(statusPath, updateLock.token, updaterChild.pid);
      handedOff = true;
      updaterChild.unref();
      return {
        ok: true,
        supported: true,
        running: true,
        phase: preparedPrebuiltRelease ? "staging" : "building",
        message: preparedPrebuiltRelease
          ? "Installing the verified signed Vigil release; Vigil will restart when ready."
          : "Building the Vigil update; Vigil will restart when ready.",
        logPath
      };
    } catch (error) {
      let failure = error;
      if (updaterChild && !handedOff) {
        const terminated = await terminateUpdaterChildAndConfirm(updaterChild.pid);
        if (!terminated && updaterLockTransferred) {
          preserveUpdateLock = true;
          failure = new UpdaterBootstrapOwnershipError(
            `${errorMessage(error)} Vigil could not confirm that the failed updater process group stopped, so its lock was preserved.`
          );
        }
      } else if (error instanceof UpdaterBootstrapOwnershipError) {
        preserveUpdateLock = true;
      }
      const message = errorMessage(failure) || "The updater process could not start.";
      return await failAttempt(message, guardianCheckFailure(message));
    } finally {
      if (!handedOff && !preserveUpdateLock && downloadedPrebuiltRelease) {
        await cleanupDownloadedPrebuiltRelease(downloadedPrebuiltRelease.root, updateDir).catch((error) => {
          console.error("Vigil could not clean its private prebuilt-release download.", error);
        });
      }
      if (!handedOff && !preserveUpdateLock) await updateLock.release();
    }
  }

  async function launchLocalChanges(
    currentStatus: Record<string, unknown>,
    updateLock: UpdaterLock,
    sourcePreflight: SourceUpdatePreflight
  ): Promise<Record<string, unknown>> {
    if (!/^[a-f0-9]{40}$/iu.test(String(currentStatus.currentCommit || ""))
      || !/^[a-f0-9]{64}$/iu.test(String(currentStatus.currentSourceFingerprint || ""))) {
      return { ...currentStatus, ok: false, error: "Vigil could not capture a stable identity for the local source. Nothing was changed." };
    }
    const { nodePath, npmPath } = sourcePreflight;
    const launcherPath = localLauncherPath(repoRoot);
    if (!nodePath || !npmPath || !launcherPath) {
      return { ...currentStatus, ok: false, error: "Node.js, npm, and the local launcher are required to run Vigil changes." };
    }
    const childEnv = updaterChildEnvironment(app.getPath("home"), nodePath, npmPath);
    const syntax = await execFile(nodePath, ["--check", launcherPath], { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
    if (!syntax.ok) return { ...currentStatus, ok: false, error: "The Vigil local launcher failed its preflight check." };
    const child = spawn(nodePath, [
      launcherPath,
      "--repo-root", repoRoot,
      "--app-path", appPath,
      "--parent-pid", String(process.pid),
      "--user-data-dir", userDataDir,
      "--node-path", nodePath,
      "--npm-path", npmPath,
      "--status-path", statusPath,
      "--log-path", logPath,
      "--expected-commit", String(currentStatus.currentCommit || ""),
      "--expected-branch", String(currentStatus.branch || ""),
      "--expected-fingerprint", String(currentStatus.currentSourceFingerprint || ""),
      "--lock-path", updateLock.path,
      "--lock-token", updateLock.token
    ], { detached: true, stdio: "ignore", cwd: repoRoot, env: childEnv });
    let quitAuthorizationInFlight = false;
    const requestQuit = () => {
      if (!child.pid || quitAuthorizationInFlight) return;
      quitAuthorizationInFlight = true;
      void authorizeQuit(child.pid);
    };
    async function authorizeQuit(childPid: number): Promise<void> {
      try {
        await assertGuardianMaintenanceActive(updateLock.path, updateLock.token, childPid);
        await quitForUpdate();
        process.off("SIGUSR2", requestQuit);
      } catch (error) {
        quitAuthorizationInFlight = false;
        console.error("Vigil rejected an unauthenticated local-update quit request.", error);
      }
    }
    process.on("SIGUSR2", requestQuit);
    let updateLockTransferred = false;
    try {
      await childStarted(child);
      if (!child.pid) throw new Error("The local launcher did not report a process ID.");
      child.once("exit", () => process.off("SIGUSR2", requestQuit));
      await updateLock.transferTo(child.pid);
      updateLockTransferred = true;
      await waitForUpdaterBootstrap(statusPath, updateLock.token, child.pid);
      child.unref();
      return {
        ...currentStatus,
        ok: true,
        supported: true,
        running: true,
        phase: "building",
        message: "Building local changes; Vigil will restart when ready."
      };
    } catch (error) {
      process.off("SIGUSR2", requestQuit);
      if (!await terminateUpdaterChildAndConfirm(child.pid) && updateLockTransferred) {
        throw new UpdaterBootstrapOwnershipError(
          `${errorMessage(error)} Vigil could not confirm that the failed local updater process group stopped, so its lock was preserved.`
        );
      }
      throw error;
    }
  }
}

interface SelectedUpdateIdentity {
  branch: string;
  currentCommit: string;
  localAttempt: boolean;
  sourceFingerprint: string;
  targetCommit: string;
}

interface CollectSourceUpdatePreflightOptions {
  app: App;
  appPath: string;
  currentStatus: Record<string, unknown>;
  expectedIdentity?: SelectedUpdateIdentity;
  localAttempt: boolean;
  prebuiltRelease?: PreparedPrebuiltRelease | null;
  repoRoot: string;
  scriptPath: string | null;
  updateDir: string;
}

interface LiveSourceSelection {
  identity: SelectedUpdateIdentity;
  repo: RepoInfo;
  sourceFingerprint: string;
}

function selectedUpdateIdentity(
  status: Record<string, unknown>,
  localAttempt: boolean
): SelectedUpdateIdentity {
  return {
    branch: String(status.branch || ""),
    currentCommit: String(status.currentCommit || ""),
    localAttempt,
    sourceFingerprint: String(status.currentSourceFingerprint || ""),
    targetCommit: localAttempt
      ? String(status.currentCommit || "")
      : String(status.upstreamCommit || "")
  };
}

function updateIdentitiesMatch(
  expected: SelectedUpdateIdentity,
  observed: SelectedUpdateIdentity
): boolean {
  return expected.branch === observed.branch
    && expected.currentCommit === observed.currentCommit
    && expected.localAttempt === observed.localAttempt
    && expected.sourceFingerprint === observed.sourceFingerprint
    && expected.targetCommit === observed.targetCommit;
}

async function readLiveSourceSelection(
  repoRoot: string,
  localAttempt: boolean
): Promise<LiveSourceSelection> {
  const [repo, fingerprint] = await Promise.all([
    readRepoInfo(repoRoot),
    sourceFingerprint(repoRoot)
  ]);
  if (!repo.ok) {
    throw new Error(repo.error || "The live repository state could not be read.");
  }
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/iu.test(fingerprint)) {
    throw new Error("The live source fingerprint is missing or malformed.");
  }
  return {
    repo,
    sourceFingerprint: fingerprint,
    identity: {
      branch: repo.branch,
      currentCommit: repo.head,
      localAttempt,
      sourceFingerprint: fingerprint,
      targetCommit: localAttempt ? repo.head : repo.upstream || ""
    }
  };
}

async function collectSourceUpdatePreflight({
  app,
  appPath,
  currentStatus,
  expectedIdentity,
  localAttempt,
  prebuiltRelease = null,
  repoRoot,
  scriptPath,
  updateDir
}: CollectSourceUpdatePreflightOptions): Promise<SourceUpdatePreflight> {
  const homeDir = app.getPath("home");
  const [nodePath, npmPath] = await Promise.all([
    findExecutable(repoRoot, "node", homeDir),
    prebuiltRelease ? Promise.resolve(null) : findExecutable(repoRoot, "npm", homeDir)
  ]);
  const liveSelection = readLiveSourceSelection(repoRoot, localAttempt);
  const installedTopology = inspectInstalledUpdateTopology(repoRoot, !localAttempt);
  const selectedSnapshot = selectedUpdateIdentity(currentStatus, localAttempt);
  const definitions: UpdatePreflightCheckDefinition[] = [
    {
      code: "vigil.update.recovery.clear",
      label: "Previous update recovery",
      run: () => currentStatus.recoveryPending === true || currentStatus.recoveryBlocked === true
        ? {
            status: "fail",
            message: "The previous Vigil update still requires recovery.",
            detail: String(currentStatus.message || "Recovery state is still active.")
          }
        : { message: "No previous update recovery blocks this attempt." }
    },
    {
      code: "vigil.update.repository.verified",
      label: "Source repository",
      run: async () => {
        if (currentStatus.checkOk !== true) {
          return {
            status: "fail",
            message: "Vigil could not verify its source repository.",
            detail: String(currentStatus.repoError || currentStatus.message || "Repository status check failed.")
          };
        }
        const live = await liveSelection;
        return {
          message: "The live Vigil repository and source fingerprint are readable.",
          detail: `Branch ${live.repo.branch}; HEAD ${live.repo.head}; fingerprint ${live.sourceFingerprint}.`
        };
      }
    },
    {
      code: "vigil.update.candidate.available",
      label: "Selected update candidate",
      run: () => currentStatus.updateCandidateAvailable === true
        ? { message: "The selected Vigil update candidate is still available." }
        : {
            status: "fail",
            message: "The selected Vigil update is no longer available.",
            detail: "Check for updates again; no password, build, or installation was started."
          }
    },
    {
      code: "vigil.update.source.identity",
      label: "Selected source identity",
      run: async () => {
        const observedIdentity = (await liveSelection).identity;
        const stable = /^[a-f0-9]{40}$/iu.test(observedIdentity.currentCommit)
          && /^[a-f0-9]{40}$/iu.test(observedIdentity.targetCommit)
          && /^[a-f0-9]{64}$/iu.test(observedIdentity.sourceFingerprint)
          && updateIdentitiesMatch(selectedSnapshot, observedIdentity)
          && (!expectedIdentity || updateIdentitiesMatch(expectedIdentity, observedIdentity));
        return stable
          ? { message: "The live branch, source commit, fingerprint, and target match the selected update exactly." }
          : {
            status: "fail",
            message: "Vigil could not pin the exact selected source and target identity.",
            detail: expectedIdentity
              ? "The source or target changed after the first preflight."
              : "The live branch, HEAD, source fingerprint, or upstream target changed after selection."
          };
      }
    },
    {
      code: "vigil.update.source.topology",
      label: "Source update topology",
      run: async () => {
        const live = await liveSelection;
        if (localAttempt) {
          return currentStatus.localChanges === true && live.repo.dirty
            ? { message: "The update remains on the protected local-changes path." }
            : {
                status: "fail",
                message: "The local source topology changed during preflight.",
                detail: "Check for updates again before building."
              };
        }
        if (live.repo.dirty) {
          return {
            status: "fail",
            message: "The remote update is blocked by local source changes.",
            detail: "Commit or stash local changes before installing the remote update."
          };
        }
        if (live.repo.ahead > 0) {
          return {
            status: "fail",
            message: "The source branch is ahead of or diverged from its upstream.",
            detail: "Vigil only installs a remote source update through an exact fast-forward."
          };
        }
        return { message: "The remote source topology is a clean fast-forward." };
      }
    },
    {
      code: "vigil.update.remote.fetch",
      label: "Remote update refresh",
      run: () => localAttempt || expectedIdentity || currentStatus.remoteCheckOk === true
        ? { message: localAttempt ? "A remote refresh is not required for local changes." : "The selected remote target was refreshed." }
        : {
            status: "fail",
            message: "Vigil could not refresh the remote update target.",
            detail: String(currentStatus.remoteCheckError || "The Git fetch did not complete successfully.")
          }
    },
    {
      code: "vigil.update.updater.script",
      label: "Packaged updater script",
      run: async () => {
        if (!scriptPath) {
          return { status: "fail", message: "The packaged Vigil updater script is missing." };
        }
        const value = await lstat(scriptPath);
        return value.isFile() && !value.isSymbolicLink()
          ? { message: "The packaged updater is a regular signed-bundle file." }
          : {
              status: "fail",
              message: "The packaged Vigil updater script has an unsafe filesystem type.",
              detail: scriptPath
            };
      }
    },
    {
      code: "vigil.update.tool.node",
      label: "Node.js executable",
      run: () => executableToolPreflight({
        args: ["--version"],
        commandPath: nodePath,
        cwd: repoRoot,
        label: "Node.js",
        minimumVersion: [22, 6, 0],
        missingDetail: "Install Node.js 22.6 or newer in a standard executable location before updating."
      })
    },
    {
      code: "vigil.update.tool.npm",
      label: "npm executable",
      run: () => prebuiltRelease
        ? { message: "The verified prebuilt release does not require npm." }
        : executableToolPreflight({
            args: ["--version"],
            commandPath: npmPath,
            cwd: repoRoot,
            env: nodePath && npmPath
              ? updaterChildEnvironment(homeDir, nodePath, npmPath)
              : undefined,
            label: "npm",
            missingDetail: "Install npm in a standard executable location before updating."
          })
    },
    {
      code: "vigil.update.updater.syntax",
      label: "Packaged updater syntax",
      run: async () => {
        if (!nodePath || !scriptPath) {
          return {
            status: "blocked",
            message: "Updater syntax could not be checked.",
            detail: !nodePath ? "The Node.js prerequisite failed." : "The updater-script prerequisite failed."
          };
        }
        const result = await execFile(nodePath, ["--check", scriptPath], {
          cwd: repoRoot,
          timeoutMs: EXEC_TIMEOUT_MS
        });
        return result.ok
          ? { message: "The packaged updater passed Node.js syntax validation." }
          : {
              status: "fail",
              message: "The packaged Vigil updater has invalid syntax.",
              detail: execResultDetail(result)
            };
      }
    },
    {
      code: "vigil.update.app.signature",
      label: "Installed app signing mode",
      run: async () => {
        if (prebuiltRelease) {
          return {
            message: "The installed app and prebuilt candidate passed strict Developer ID continuity and notarization checks.",
            detail: `Candidate CodeDirectory hash ${prebuiltRelease.verified.candidateCdHash}.`
          };
        }
        await assertLocallyRebuildableApp(appPath);
        return { message: "The installed app has a locally rebuildable signature." };
      }
    },
    {
      code: "vigil.update.guardian.command-compatibility",
      label: "Guardian update-command compatibility",
      run: async () => {
        if (process.platform !== "darwin" || !app.isPackaged) {
          return { message: "Guardian command compatibility is not applicable to this unpackaged development run." };
        }
        const account = userInfo();
        const uid = process.getuid?.();
        if (!Number.isInteger(uid) || Number(uid) < 501) {
          return {
            status: "fail",
            message: "Vigil could not identify the signed-in account for guardian compatibility preflight.",
            detail: "No build, password prompt, or quit request was started."
          };
        }
        await preflightGuardianUpdateCompatibility({
          appPath,
          targetHome: account.homedir,
          targetUid: Number(uid),
          targetUser: account.username
        });
        return { message: "Every loaded guardian accepts this exact signed updater parent command." };
      }
    },
    {
      code: "vigil.update.source.target",
      label: "Selected Git target",
      run: async () => {
        const observedIdentity = (await liveSelection).identity;
        const targetCommit = observedIdentity.targetCommit;
        const object = await execGit(repoRoot, ["cat-file", "-e", `${targetCommit}^{commit}`]);
        if (!object.ok) {
          return {
            status: "fail",
            message: "The exact selected Git target is unavailable locally.",
            detail: execResultDetail(object)
          };
        }
        if (!localAttempt) {
          const ancestry = await execGit(repoRoot, [
            "merge-base",
            "--is-ancestor",
            observedIdentity.currentCommit,
            targetCommit
          ]);
          if (!ancestry.ok) {
            return {
              status: "fail",
              message: "The selected remote target is not a fast-forward descendant.",
              detail: execResultDetail(ancestry)
            };
          }
        }
        const requiredPaths = ["package.json", "package-lock.json", "scripts/package-mac.mjs"];
        if (prebuiltRelease) {
          if (prebuiltRelease.verified.manifest.commit !== targetCommit) {
            return {
              status: "fail",
              message: "The signed release does not match the selected Git target.",
              detail: `Manifest ${prebuiltRelease.verified.manifest.commit}; selected ${targetCommit}.`
            };
          }
        } else if (localAttempt) {
          for (const requiredPath of requiredPaths) {
            const absolutePath = join(repoRoot, requiredPath);
            let value: Awaited<ReturnType<typeof lstat>>;
            try {
              value = await lstat(absolutePath);
            } catch (error) {
              return {
                status: "fail",
                message: `The selected local source is missing ${requiredPath}.`,
                detail: errorMessage(error)
              };
            }
            if (!value.isFile() || value.isSymbolicLink()) {
              return {
                status: "fail",
                message: `The selected local ${requiredPath} has an unsafe filesystem type.`,
                detail: absolutePath
              };
            }
            const contents = await readFile(absolutePath, "utf8");
            if (!contents.trim()) {
              return {
                status: "fail",
                message: `The selected local ${requiredPath} is empty.`,
                detail: absolutePath
              };
            }
            if (requiredPath.endsWith(".json")) {
              try {
                JSON.parse(contents);
              } catch (error) {
                return {
                  status: "fail",
                  message: `The selected local ${requiredPath} is not valid JSON.`,
                  detail: errorMessage(error)
                };
              }
            }
          }
        } else {
          for (const requiredPath of requiredPaths) {
            const required = await execGit(repoRoot, ["cat-file", "-e", `${targetCommit}:${requiredPath}`]);
            if (!required.ok) {
              return {
                status: "fail",
                message: `The selected update is missing ${requiredPath}.`,
                detail: execResultDetail(required)
              };
            }
          }
        }
        return {
          message: prebuiltRelease
            ? "The selected commit exactly matches the verified signed-release manifest."
            : localAttempt
            ? "The live working tree contains valid locked-build inputs."
            : "The selected commit and required locked-build inputs are available."
        };
      }
    },
    {
      code: "vigil.update.staging.directory",
      label: "Updater staging directory",
      run: async () => {
        const value = await lstat(updateDir);
        if (!value.isDirectory() || value.isSymbolicLink()) {
          return {
            status: "fail",
            message: "The updater staging location is not a safe directory.",
            detail: updateDir
          };
        }
        await access(updateDir, constants.R_OK | constants.W_OK | constants.X_OK);
        return { message: "The private updater staging directory is writable." };
      }
    },
    {
      code: "vigil.update.staging.space",
      label: "Updater staging free space",
      run: async () => {
        const filesystem = await statfs(updateDir);
        const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
        if (!Number.isFinite(availableBytes) || availableBytes < MINIMUM_BUILD_FREE_BYTES) {
          return {
            status: "fail",
            message: "The update volume does not have enough free staging space.",
            detail: `At least ${formatBytes(MINIMUM_BUILD_FREE_BYTES)} is required; ${formatBytes(availableBytes)} is available.`
          };
        }
        return {
          message: "The update volume has enough free staging space.",
          detail: `${formatBytes(availableBytes)} available.`
        };
      }
    },
    {
      code: "vigil.update.destination.app",
      label: "Installed app destination",
      run: async () => {
        const destinationParent = dirname(appPath);
        const parentStat = await lstat(destinationParent);
        if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
          return {
            status: "fail",
            message: "The installed-app parent is not a safe directory.",
            detail: destinationParent
          };
        }
        const canonicalParent = await realpath(destinationParent);
        if (canonicalParent !== resolve(destinationParent)) {
          return {
            status: "fail",
            message: "The installed-app parent resolves through an unexpected filesystem path.",
            detail: `Selected ${destinationParent}; resolved ${canonicalParent}.`
          };
        }
        await access(destinationParent, constants.W_OK | constants.X_OK);
        try {
          const appStat = await lstat(appPath);
          if (!appStat.isDirectory() || appStat.isSymbolicLink()) {
            return {
              status: "fail",
              message: "The installed Vigil destination is not a regular app directory.",
              detail: appPath
            };
          }
          const canonicalApp = await realpath(appPath);
          if (canonicalApp !== resolve(appPath)) {
            return {
              status: "fail",
              message: "The installed Vigil app resolves through an unexpected filesystem path.",
              detail: `Selected ${appPath}; resolved ${canonicalApp}.`
            };
          }
        } catch (error) {
          if (!isErrorCode(error, "ENOENT")) throw error;
        }
        const residue: string[] = [];
        for (const path of [
          `${appPath}.vigil-next`,
          `${appPath}.vigil-previous`,
          `${appPath}.vigil-transaction.json`
        ]) {
          try {
            await lstat(path);
            residue.push(path);
          } catch (error) {
            if (!isErrorCode(error, "ENOENT")) throw error;
          }
        }
        if (residue.length) {
          return {
            status: "fail",
            message: "A previous app replacement left transaction sidecars at the destination.",
            detail: residue.join(", ")
          };
        }
        return { message: "The installed app destination is canonical, writable, and free of transaction residue." };
      }
    },
    {
      code: "vigil.update.destination.space",
      label: "Installed app destination free space",
      run: async () => {
        const filesystem = await statfs(dirname(appPath));
        const availableBytes = Number(filesystem.bavail) * Number(filesystem.bsize);
        if (!Number.isFinite(availableBytes) || availableBytes < MINIMUM_BUILD_FREE_BYTES) {
          return {
            status: "fail",
            message: "The installed-app volume does not have enough replacement space.",
            detail: `At least ${formatBytes(MINIMUM_BUILD_FREE_BYTES)} is required; ${formatBytes(availableBytes)} is available.`
          };
        }
        return {
          message: "The installed-app volume has enough free replacement space.",
          detail: `${formatBytes(availableBytes)} available.`
        };
      }
    },
    {
      code: "vigil.update.installed.topology",
      label: "Installed update topology",
      run: async () => {
        const topology = await installedTopology;
        return {
          message: "The loaded background service, recovery data directory, and installed runtime topology are ready.",
          detail: [
            topology.launchAgentLoaded ? "Legacy LaunchAgent recovery captured." : "No legacy LaunchAgent is loaded.",
            `Data: ${topology.replacementDataDirectory}.`,
            topology.installedRuntimePath ? `Runtime: ${topology.installedRuntimePath}.` : "No separate runtime swap is required."
          ].join(" ")
        };
      }
    }
  ];
  if (!localAttempt) {
    definitions.push({
      code: "vigil.update.runtime.target",
      label: "Installed runtime target",
      run: async () => {
        const expectedRuntime = join(repoRoot, "dist.nosync", "runtime");
        const observedRuntime = await realpath(join(repoRoot, "dist", "runtime"));
        return observedRuntime === expectedRuntime
          ? { message: "The installed runtime maps to its authorized canonical target." }
          : {
              status: "fail",
              message: "The installed runtime target is outside its authorized update location.",
              detail: `Expected ${expectedRuntime}; found ${observedRuntime}.`
            };
      }
    });
  }
  const report = await collectUpdatePreflight(definitions);
  return { report, nodePath, npmPath };
}

async function executableToolPreflight({
  args,
  commandPath,
  cwd,
  env,
  label,
  minimumVersion,
  missingDetail
}: {
  args: string[];
  commandPath: string | null;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  label: string;
  minimumVersion?: readonly [number, number, number];
  missingDetail: string;
}): Promise<UpdatePreflightCheckResult> {
  if (!commandPath) {
    return {
      status: "fail",
      message: `${label} was not found for the protected source build.`,
      detail: missingDetail
    };
  }
  const value = await lstat(commandPath);
  if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o111) === 0) {
    return {
      status: "fail",
      message: `The canonical ${label} path is not an executable regular file.`,
      detail: commandPath
    };
  }
  await access(commandPath, constants.X_OK);
  const result = await execFile(commandPath, args, {
    cwd,
    env,
    timeoutMs: EXEC_TIMEOUT_MS
  });
  if (!result.ok) {
    return {
      status: "fail",
      message: `${label} did not run successfully.`,
      detail: execResultDetail(result)
    };
  }
  const versionText = result.stdout.trim() || result.stderr.trim();
  const parsed = /^v?(\d+)\.(\d+)(?:\.(\d+))?/u.exec(versionText);
  if (!parsed) {
    return {
      status: "fail",
      message: `${label} returned an unrecognized version.`,
      detail: versionText || commandPath
    };
  }
  const observed = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3] || 0)] as const;
  if (minimumVersion && compareVersionTuple(observed, minimumVersion) < 0) {
    return {
      status: "fail",
      message: `${label} ${versionText} is too old for this Vigil build.`,
      detail: `${commandPath}; required ${minimumVersion.join(".")} or newer.`
    };
  }
  return {
    message: `${label} ${versionText} is executable and compatible.`,
    detail: commandPath
  };
}

function compareVersionTuple(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function execResultDetail(result: ExecResult): string {
  const detail = String(result.stderr || result.stdout || "The command exited without diagnostic output.")
    .replace(/:\/\/[^/\s:@]+:[^/\s@]+@/gu, "://[redacted]@")
    .replace(/\s+/gu, " ")
    .trim();
  return detail.length <= 1_000 ? detail : `${detail.slice(0, 999)}…`;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "an unknown amount";
  const gibibytes = value / (1024 * 1024 * 1024);
  return `${gibibytes.toFixed(gibibytes >= 10 ? 0 : 1)} GiB`;
}

export interface RemoteUpdateReceiptPreparation {
  started: boolean;
  status: Record<string, unknown>;
}

/** Begin a local attempt only after its exact source identity is trustworthy. */
export async function prepareLocalUpdateReceipt(
  statusPath: string,
  attemptId: string,
  selectedStatus: Record<string, unknown>
): Promise<void> {
  const sourceCommit = stringOrNull(selectedStatus.currentCommit);
  const sourceFingerprint = stringOrNull(selectedStatus.currentSourceFingerprint);
  if (!sourceCommit
    || !/^[a-f0-9]{40}$/iu.test(sourceCommit)
    || !sourceFingerprint
    || !/^[a-f0-9]{64}$/iu.test(sourceFingerprint)) {
    throw new Error("Vigil could not capture a stable identity for the local source. Nothing was changed.");
  }
  await beginUpdateReceipt(statusPath, newUpdateReceipt({
    attemptId,
    kind: "local",
    message: "Preparing local Vigil changes",
    sourceCommit,
    sourceFingerprint,
    targetCommit: sourceCommit,
    targetFingerprint: sourceFingerprint
  }));
}

/**
 * Cross the durable attempt boundary only after the second remote check has
 * selected an installable target. A target that disappeared between Check and
 * Install is a successful no-op, not a failed update, and must leave the prior
 * terminal receipt byte-for-byte intact.
 */
export async function prepareRemoteUpdateReceipt(
  statusPath: string,
  attemptId: string,
  selectedStatus: Record<string, unknown>
): Promise<RemoteUpdateReceiptPreparation> {
  if (selectedStatus.checkOk !== true || selectedStatus.remoteCheckOk !== true) {
    throw new Error(
      `Vigil could not verify the remote update target. ${
        String(selectedStatus.remoteCheckError || selectedStatus.repoError || "The Git refresh did not pass.")
      }`
    );
  }
  if (selectedStatus.updateAvailable !== true) {
    return {
      started: false,
      status: {
        ...selectedStatus,
        ok: true,
        running: false,
        updateAvailable: false,
        noUpdate: true,
        phase: "",
        message: "No newer Vigil update is available."
      }
    };
  }
  const sourceCommit = stringOrNull(selectedStatus.currentCommit);
  const sourceFingerprint = stringOrNull(selectedStatus.currentSourceFingerprint);
  const targetCommit = stringOrNull(selectedStatus.upstreamCommit);
  if (!sourceCommit
    || !/^[a-f0-9]{40}$/iu.test(sourceCommit)
    || !sourceFingerprint
    || !/^[a-f0-9]{64}$/iu.test(sourceFingerprint)
    || !targetCommit
    || !/^[a-f0-9]{40}$/iu.test(targetCommit)) {
    throw new Error("Vigil could not capture the selected remote update identity. Nothing was changed.");
  }
  await beginUpdateReceipt(statusPath, newUpdateReceipt({
    attemptId,
    kind: "remote",
    message: "Preparing Vigil update",
    sourceCommit,
    sourceFingerprint,
    targetCommit,
    targetFingerprint: null
  }));
  return { started: true, status: selectedStatus };
}

function findRepoRoot(app: App, previousRoot = ""): string {
  const candidates = [
    process.env.VIGIL_SOURCE_ROOT || "",
    launchAgentRepoRoot(app),
    packagedBuildRepoRoot(app),
    previousRoot,
    process.cwd(),
    app.isPackaged ? resolve(process.resourcesPath, "../../../../../..") : "",
    app.isPackaged ? resolve(process.resourcesPath, "../../../../..") : "",
    resolve(moduleDir, "../..")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isRepoRoot(candidate)) return candidate;
  }
  return process.cwd();
}

function packagedBuildRepoRoot(app: App): string {
  if (!app.isPackaged) return "";
  for (const path of [
    join(process.resourcesPath, "app.asar.unpacked", "dist", "runtime", "build-info.json"),
    join(process.resourcesPath, "app.asar", "dist", "runtime", "build-info.json")
  ]) {
    try {
      const info = JSON.parse(readFileSync(path, "utf8")) as BuildInfo;
      if (typeof info.sourceRoot === "string") return info.sourceRoot;
    } catch {
      // Try the next packaged build metadata location.
    }
  }
  return "";
}

function launchAgentRepoRoot(app: App): string {
  try {
    const plistPath = join(app.getPath("home"), "Library", "LaunchAgents", "com.vigil.agent.plist");
    const plist = readFileSync(plistPath, "utf8");
    return plistStringForKey(plist, "VigilSourceRoot") || plistStringForKey(plist, "WorkingDirectory");
  } catch {
    return "";
  }
}

function isRepoRoot(candidate: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "vigil"
      && existsSync(join(candidate, "app", "main.ts"))
      && existsSync(join(candidate, ".git"));
  } catch {
    return false;
  }
}

function packagedAppPath(repoRoot: string): string {
  if (process.platform === "darwin" && process.execPath.includes(".app/Contents/MacOS/")) {
    return dirname(dirname(dirname(process.execPath)));
  }
  return join(repoRoot, "dist", "mac.noindex", "mac-universal", "Vigil.app");
}

function updateScriptPath(repoRoot: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"),
    join(repoRoot, "dist", "runtime", "scripts", "update-packaged-app.mjs")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function localLauncherPath(repoRoot: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "app.asar.unpacked", "dist", "runtime", "scripts", "launch-local-app.mjs"),
    join(repoRoot, "dist", "runtime", "scripts", "launch-local-app.mjs")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

export async function readRepoInfoForTest(repoRoot: string): Promise<RepoInfo> {
  return await readRepoInfo(repoRoot);
}

export function shouldBuildLocalCheckout(
  repo: Pick<RepoInfo, "upstream" | "ahead">,
  appBundleOutdated: boolean,
  localChanges: boolean
): boolean {
  // A checkout with commits that are not in its upstream cannot use the remote
  // updater's required fast-forward transaction. Rebuild its checked-out HEAD
  // through the protected local flow instead when the installed app is behind.
  return localChanges || Boolean(appBundleOutdated && (!repo.upstream || repo.ahead > 0));
}

export function shouldInstallRemoteUpdate(
  repo: Pick<RepoInfo, "upstream" | "ahead" | "behind" | "dirty">,
  appBundleOutdated: boolean,
  appMatchesUpstream = false
): boolean {
  return Boolean(
    !repo.dirty
    && repo.ahead === 0
    && repo.upstream
    && !appMatchesUpstream
    && (repo.behind > 0 || appBundleOutdated)
  );
}

async function readRepoInfo(repoRoot: string): Promise<RepoInfo> {
  let branch: ExecResult = failedExec("Repository branch was not checked.");
  let head: ExecResult = failedExec("Repository HEAD was not checked.");
  let status: ExecResult = failedExec("Repository working tree was not checked.");
  for (let attempt = 0; attempt < REPO_CHECK_ATTEMPTS; attempt += 1) {
    [branch, head, status] = await Promise.all([
      execGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
      execGit(repoRoot, ["rev-parse", "HEAD"]),
      execGit(repoRoot, ["status", "--porcelain=v1"])
    ]);
    if (branch.ok && head.ok && status.ok) break;
    if (attempt + 1 < REPO_CHECK_ATTEMPTS) await delay(REPO_CHECK_RETRY_MS);
  }
  const upstream = branch.ok && head.ok
    ? await execGit(repoRoot, ["rev-parse", "@{u}"])
    : failedExec("Repository HEAD was not available.");
  const counts = upstream.ok
    ? await execGit(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])
    : failedExec("This branch does not have an upstream.");
  const failedChecks = ([
    ["branch", branch],
    ["HEAD", head],
    ["working tree", status]
  ] as const).filter(([, result]) => !result.ok);
  const ok = failedChecks.length === 0;
  const [aheadRaw, behindRaw] = counts.ok ? counts.stdout.trim().split(/\s+/) : ["0", "0"];
  return {
    ok,
    error: ok
      ? null
      : failedChecks
          .map(([label, result]) => `Repository ${label} check failed: ${execResultDetail(result)}`)
          .join(" "),
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : "unknown",
    head: head.ok ? head.stdout.trim() : "",
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead: Number(aheadRaw || 0) || 0,
    behind: Number(behindRaw || 0) || 0,
    dirty: !status.ok || Boolean(status.stdout.trim())
  };
}

async function execGit(repoRoot: string, args: string[], timeoutMs = EXEC_TIMEOUT_MS): Promise<ExecResult> {
  try {
    return await execFile(await gitExecutable(repoRoot), args, { cwd: repoRoot, timeoutMs });
  } catch (error) {
    return failedExec(errorMessage(error));
  }
}

function failedExec(stderr: string): ExecResult {
  return { ok: false, stdout: "", stderr };
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function execFile(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }
): Promise<ExecResult> {
  return await new Promise((resolveExec) => {
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let terminationGrace: ReturnType<typeof setTimeout> | null = null;
    let killConfirmation: ReturnType<typeof setTimeout> | null = null;
    let terminationPoll: ReturnType<typeof setInterval> | null = null;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const clearLifecycleTimers = () => {
      clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      if (killConfirmation) clearTimeout(killConfirmation);
      if (terminationPoll) clearInterval(terminationPoll);
    };
    const finish = (result: ExecResult) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      resolveExec(result);
    };
    const finishTimedOutWhenStopped = () => {
      if (!timedOut || settled || updaterProcessGroupExists(child.pid)) return;
      if (childClosed) finish({ ok: false, stdout, stderr: stderr || "Command timed out" });
    };
    const awaitKillConfirmation = () => {
      killConfirmation = setTimeout(() => {
        if (settled) return;
        if (!updaterProcessGroupExists(child.pid)) {
          childClosed = true;
          finishTimedOutWhenStopped();
          return;
        }
        signalUpdaterChild(child.pid, "SIGKILL");
        awaitKillConfirmation();
      }, EXEC_KILL_CONFIRMATION_MS);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalUpdaterChild(child.pid, "SIGTERM");
      terminationPoll = setInterval(finishTimedOutWhenStopped, EXEC_TERMINATION_POLL_MS);
      terminationGrace = setTimeout(() => {
        if (settled) return;
        if (!updaterProcessGroupExists(child.pid)) {
          childClosed = true;
          finishTimedOutWhenStopped();
          return;
        }
        signalUpdaterChild(child.pid, "SIGKILL");
        awaitKillConfirmation();
      }, EXEC_TERMINATION_GRACE_MS);
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      childClosed = true;
      if (timedOut) {
        finishTimedOutWhenStopped();
        return;
      }
      finish({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      childClosed = true;
      if (timedOut) {
        finishTimedOutWhenStopped();
        return;
      }
      finish({ ok: code === 0, stdout, stderr });
    });
  });
}

async function readBuildInfo(path: string): Promise<BuildInfo | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

async function readFirstBuildInfo(paths: string[]): Promise<BuildInfo | null> {
  for (const path of paths) {
    const info = await readBuildInfo(path);
    if (info) return info;
  }
  return null;
}

async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function readGlobalUpdateRecovery(updateDir: string): Promise<GlobalUpdateRecoveryStatus> {
  const manifestPath = join(updateDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  let manifestStat: Awaited<ReturnType<typeof lstat>>;
  try {
    manifestStat = await lstat(manifestPath);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) {
      return {
        hasManifest: true,
        blocked: true,
        message: `Vigil could not inspect its durable update recovery record: ${errorMessage(error)}`,
        attemptId: null,
        outcome: null
      };
    }
    return {
      hasManifest: false,
      blocked: false,
      message: null,
      attemptId: null,
      outcome: await readUpdateRecoveryOutcome(updateDir).catch(() => null)
    };
  }
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) {
    return {
      hasManifest: true,
      blocked: true,
      message: "Vigil preserved an unsafe durable update recovery record for manual inspection.",
      attemptId: null,
      outcome: null
    };
  }

  try {
    const loadedPolicy = await readUpdateRecoveryPolicyFile(join(updateDir, UPDATE_RECOVERY_POLICY_FILENAME));
    const manifest = await readUpdateRecoveryManifest(loadedPolicy.policy);
    if (!manifest) {
      return {
        hasManifest: false,
        blocked: false,
        message: null,
        attemptId: null,
        outcome: await readUpdateRecoveryOutcome(updateDir).catch(() => null)
      };
    }
    const outcome = await readUpdateRecoveryOutcome(updateDir);
    const applicableOutcome = outcome?.attemptId === manifest.attemptId ? outcome : null;
    const blocked = applicableOutcome?.status === "recovery-failed";
    return {
      hasManifest: true,
      blocked,
      message: applicableOutcome?.message
        || "Vigil is recovering an interrupted update before it can check again.",
      attemptId: manifest.attemptId,
      outcome: applicableOutcome
    };
  } catch (error) {
    // Recovery may atomically remove its manifest while this read is in flight.
    // Recheck the authoritative pathname before reporting a persistent block.
    try {
      await lstat(manifestPath);
    } catch (restatError) {
      if (isErrorCode(restatError, "ENOENT")) {
        return {
          hasManifest: false,
          blocked: false,
          message: null,
          attemptId: null,
          outcome: await readUpdateRecoveryOutcome(updateDir).catch(() => null)
        };
      }
    }
    return {
      hasManifest: true,
      blocked: true,
      message: `Vigil preserved an interrupted update because its recovery evidence could not be verified: ${errorMessage(error)}`,
      attemptId: null,
      outcome: null
    };
  }
}

export function updateMessage(
  {
    repo,
    sourceFingerprintOk,
    appBundleOutdated,
    appMatchesUpstream,
    localChanges,
    running,
    recoveryPending,
    recoveryBlocked,
    recoveryMessage,
    recoveryOutcome,
    activeAttemptStatus,
    remoteCheckError,
    maintenance,
    updateCandidateAvailable = false,
    lastUpdate,
    lastUpdateCorrectedComplete,
    lastUpdateSuperseded,
    orphanedAttempt,
    orphanedAttemptInstalled
  }:
  {
    repo: RepoInfo;
    sourceFingerprintOk: boolean;
    appBundleOutdated: boolean;
    appMatchesUpstream: boolean;
    localChanges: boolean;
    running: boolean;
    recoveryPending: boolean;
    recoveryBlocked: boolean;
    recoveryMessage: string | null;
    recoveryOutcome: UpdateRecoveryOutcome | null;
    activeAttemptStatus: LastUpdateStatus | null;
    remoteCheckError?: boolean | null;
    maintenance: Awaited<ReturnType<typeof guardianMaintenanceReadiness>>;
    updateCandidateAvailable?: boolean;
    lastUpdate: LastUpdateStatus | null;
    lastUpdateCorrectedComplete: boolean;
    lastUpdateSuperseded: boolean;
    orphanedAttempt: boolean;
    orphanedAttemptInstalled: boolean;
  }
): string {
  if (running) {
    if (!activeAttemptStatus) return "Update starting";
    if (activeAttemptStatus.phase === "complete") return "Finishing the successful Vigil update";
    if (activeAttemptStatus.phase === "failed") return "Finishing protected recovery from the failed update";
    return activeAttemptStatus.message || "Update in progress";
  }
  if (recoveryBlocked) {
    return recoveryMessage || "Vigil preserved an interrupted update because automatic recovery needs attention.";
  }
  if (recoveryPending) return recoveryMessage || "Recovering the interrupted Vigil update";
  if (!maintenance.ready) {
    if (maintenance.setupSupported && updateCandidateAvailable) {
      return "One-time setup is needed; approve once and Vigil will continue the update automatically.";
    }
    return maintenance.message || "Vigil's protected update setup is not ready.";
  }
  if (!repo.ok) return "Vigil could not verify its source repository";
  if (!sourceFingerprintOk) return "Vigil could not verify its exact source identity";
  if (localChanges) return "Local changes ready to run";
  if (remoteCheckError) return "Could not verify remote updates";
  if (repo.dirty && repo.behind > 0) return "Commit or stash local edits before installing remote updates";
  if (repo.ahead > 0 && repo.behind > 0) return "This checkout has diverged from its upstream; remote updates are not auto-installed";
  if (appMatchesUpstream && repo.behind > 0) {
    return lastUpdate?.phase === "complete"
      ? lastUpdate.message || "Vigil update complete"
      : "Vigil is current; source checkout synchronization is pending";
  }
  if (repo.behind > 0 && repo.ahead === 0) return `${repo.behind} remote commit${repo.behind === 1 ? "" : "s"} ready`;
  if (appBundleOutdated) return "Installed app is behind this checkout";
  // Terminal receipts and recovery outcomes are historical evidence. They
  // remain useful once the current topology is settled, but must never mask a
  // newly actionable checkout or upstream target with a stale "current" or
  // "complete" message while the button correctly offers that newer action.
  if (orphanedAttempt && !orphanedAttemptInstalled && lastUpdate) {
    return `Last update was interrupted during ${lastUpdate.phase}: ${lastUpdate.message || "the updater stopped unexpectedly"}.`;
  }
  if (!recoveryOutcome
    && !lastUpdateSuperseded
    && lastUpdate?.phase === "failed"
    && (lastUpdate.error || lastUpdate.message)) {
    return `Last update failed: ${lastUpdate.error || lastUpdate.message}`;
  }
  if (orphanedAttemptInstalled) return "Vigil update installed; its final confirmation was interrupted";
  if (recoveryOutcome?.status === "complete") return recoveryOutcome.message;
  if (recoveryOutcome?.status === "failed-recovered") return recoveryOutcome.message;
  if (lastUpdateCorrectedComplete) return "Vigil is current; its earlier failed-update status is obsolete";
  if (lastUpdate?.phase === "complete") return lastUpdate.message || "Vigil update complete";
  return "Vigil is current";
}

async function findExecutable(repoRoot: string, command: string, homeDir: string): Promise<string | null> {
  const result = await execFile("/bin/zsh", ["-lc", "command -v -- \"$1\"", "vigil-updater", command], {
    cwd: repoRoot,
    timeoutMs: EXEC_TIMEOUT_MS,
    env: {
      ...process.env,
      PATH: updaterExecutableSearchPath(homeDir, process.env.PATH)
    }
  });
  const path = result.ok ? result.stdout.trim().split(/\r?\n/u)[0] : "";
  if (!path || resolve(path) !== path || !existsSync(path)) return null;
  try {
    const canonicalPath = await realpath(path);
    if (resolve(canonicalPath) !== canonicalPath || !existsSync(canonicalPath)) return null;
    const value = await lstat(canonicalPath);
    if (!value.isFile() || value.isSymbolicLink() || (value.mode & 0o111) === 0) return null;
    await access(canonicalPath, constants.X_OK);
    return canonicalPath;
  } catch {
    return null;
  }
}

export function updaterExecutableSearchPath(
  homeDir: string,
  inheritedPath = "",
  preferredDirectories: string[] = []
): string {
  return [...new Set([
    ...preferredDirectories.filter(Boolean),
    join(homeDir, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...inheritedPath.split(":").filter(Boolean),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ])].join(":");
}

export function updaterChildEnvironment(
  homeDir: string,
  nodePath: string,
  npmPath: string,
  inherited: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...inherited,
    PATH: updaterExecutableSearchPath(homeDir, inherited.PATH, [dirname(nodePath), dirname(npmPath)])
  };
}

export async function acquireUpdaterLock(
  lockPath: string,
  ownerPid = process.pid,
  recoveryHooks: UpdaterLockRecoveryHooks = {}
): Promise<UpdaterLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const ownerStartedAt = await processStartedAt(ownerPid, dirname(lockPath));
  if (!ownerStartedAt && processExists(ownerPid)) {
    throw new Error("Vigil could not verify the updater lock owner's process identity.");
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporaryPath = `${lockPath}.${token}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({
        token,
        pid: ownerPid,
        startedAt,
        ownerStartedAt: ownerStartedAt || undefined
      })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await link(temporaryPath, lockPath);
      return {
        path: lockPath,
        token,
        async transferTo(pid: number) {
          if (!Number.isInteger(pid) || pid <= 0) throw new Error("The updater lock owner must be a positive process ID.");
          const transferredOwnerStartedAt = await processStartedAt(pid, dirname(lockPath));
          if (!transferredOwnerStartedAt && processExists(pid)) {
            throw new Error("Vigil could not verify the updater process identity before transferring its lock.");
          }
          await replaceOwnedLockPayload(lockPath, token, {
            token,
            pid,
            startedAt,
            ownerStartedAt: transferredOwnerStartedAt || undefined
          });
        },
        async release() {
          await releaseOwnedUpdaterLock(lockPath, token, recoveryHooks);
        }
      };
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (attempt === 0 && await removeStaleUpdaterLock(lockPath, recoveryHooks)) continue;
      throw new Error("A Vigil update is already running.");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error("A Vigil update is already running.");
}

async function replaceOwnedLockPayload(lockPath: string, token: string, payload: UpdateLockPayload): Promise<void> {
  const current = await readUpdaterLock(lockPath);
  if (!current || current.token !== token) throw new Error("Vigil lost ownership of the updater lock.");
  const temporaryPath = `${lockPath}.${token}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, lockPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function releaseOwnedUpdaterLock(
  lockPath: string,
  token: string,
  recoveryHooks: UpdaterLockRecoveryHooks
): Promise<void> {
  let snapshot: PinnedUpdaterLockSnapshot | null;
  try {
    snapshot = await openPinnedUpdaterLock(lockPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  try {
    if (!snapshot || snapshot.payload?.token !== token) return;
    await recoveryHooks.afterReleaseSnapshot?.();
    const releasedPath = `${lockPath}.released.${Date.now()}.${randomUUID()}`;
    try {
      await rename(lockPath, releasedPath);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    const moved = await openPinnedUpdaterLock(releasedPath).catch(() => null);
    try {
      if (moved
        && moved.dev === snapshot.dev
        && moved.ino === snapshot.ino
        && moved.raw === snapshot.raw) {
        await rm(releasedPath, { force: true });
        return;
      }

      // Another owner replaced the canonical path after our snapshot. Restore
      // exactly the inode we displaced when the name is still vacant; when a
      // third contender already owns it, preserve the displaced lock for
      // diagnosis instead of deleting evidence that may still be live.
      let restored = false;
      try {
        await link(releasedPath, lockPath);
        restored = true;
      } catch (error) {
        if (!isErrorCode(error, "EEXIST") && !isErrorCode(error, "ENOENT")) throw error;
      }
      if (restored) await rm(releasedPath, { force: true });
    } finally {
      await moved?.handle.close().catch(() => undefined);
    }
  } finally {
    await snapshot?.handle.close().catch(() => undefined);
  }
}

async function readActiveUpdaterLock(lockPath: string): Promise<UpdateLockPayload | null> {
  const payload = await readUpdaterLock(lockPath);
  if (!payload || !processExists(payload.pid)) return null;
  if (payload.ownerStartedAt) {
    const observedStart = await processStartedAt(payload.pid, dirname(lockPath));
    if (observedStart && !sameProcessStart(payload.ownerStartedAt, observedStart)) return null;
  } else {
    const legacyOwner = await legacyUpdaterOwnerMatches(payload, lockPath);
    if (legacyOwner === false) return null;
  }
  return payload;
}

async function readUpdaterLock(lockPath: string): Promise<UpdateLockPayload | null> {
  try {
    return parseUpdaterLockPayload(await readFile(lockPath, "utf8"));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    return null;
  }
}

async function removeStaleUpdaterLock(
  lockPath: string,
  recoveryHooks: UpdaterLockRecoveryHooks = {}
): Promise<boolean> {
  let snapshot: PinnedUpdaterLockSnapshot | null;
  try {
    snapshot = await openPinnedUpdaterLock(lockPath);
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }
  try {
    if (!snapshot) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && snapshot.uid !== uid) return false;
    if ((snapshot.mode & 0o077) !== 0) return false;

    const payload = snapshot.payload;
    if (payload && processExists(payload.pid)) {
      if (payload.ownerStartedAt) {
        const observedStart = await processStartedAt(payload.pid, dirname(lockPath));
        if (!observedStart || sameProcessStart(payload.ownerStartedAt, observedStart)) return false;
      } else {
        // Pre-v1 locks had no process-start identity and can otherwise wedge
        // forever after PID reuse. Preserve one only when the live process's
        // exact argv still proves ownership of this path and unguessable token;
        // an unreadable process table remains fail-closed.
        const legacyOwner = await legacyUpdaterOwnerMatches(payload, lockPath);
        if (legacyOwner !== false) return false;
      }
    }
    await recoveryHooks.afterSnapshot?.();
    return await quarantinePinnedUpdaterLock(lockPath, snapshot, payload ? "stale" : "invalid");
  } finally {
    await snapshot?.handle.close().catch(() => undefined);
  }
}

async function openPinnedUpdaterLock(lockPath: string): Promise<PinnedUpdaterLockSnapshot | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(lockPath, "r");
    const [handleStat, pathStat] = await Promise.all([handle.stat(), lstat(lockPath)]);
    if (!pathStat.isFile()
      || pathStat.isSymbolicLink()
      || handleStat.dev !== pathStat.dev
      || handleStat.ino !== pathStat.ino) {
      await handle.close();
      return null;
    }
    const raw = await handle.readFile("utf8");
    return {
      handle,
      dev: handleStat.dev,
      ino: handleStat.ino,
      mode: handleStat.mode,
      uid: handleStat.uid,
      raw,
      payload: parseUpdaterLockPayload(raw)
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isErrorCode(error, "ENOENT")) throw error;
    return null;
  }
}

async function quarantinePinnedUpdaterLock(
  lockPath: string,
  expected: PinnedUpdaterLockSnapshot,
  reason: "invalid" | "stale"
): Promise<boolean> {
  const quarantinePath = `${lockPath}.${reason}.${Date.now()}.${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }

  const moved = await openPinnedUpdaterLock(quarantinePath).catch(() => null);
  try {
    if (moved
      && moved.dev === expected.dev
      && moved.ino === expected.ino
      && moved.raw === expected.raw) {
      return true;
    }

    // The canonical path changed after our snapshot. Put the displaced owner
    // back only when the canonical name is still empty; never overwrite a newer
    // contender and never treat this recovery attempt as lock acquisition.
    try {
      await link(quarantinePath, lockPath);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST") && !isErrorCode(error, "ENOENT")) throw error;
    }
    return false;
  } finally {
    await moved?.handle.close().catch(() => undefined);
  }
}

function parseUpdaterLockPayload(raw: string): UpdateLockPayload | null {
  try {
    const value = JSON.parse(raw) as Partial<UpdateLockPayload> | null;
    return value
      && typeof value.token === "string"
      && value.token.length > 0
      && value.token.length <= 512
      && !/[\u0000\r\n]/u.test(value.token)
      && Number.isInteger(value.pid)
      && Number(value.pid) > 0
      && typeof value.startedAt === "string"
      && Number.isFinite(Date.parse(value.startedAt))
      && (value.ownerStartedAt === undefined
        || (typeof value.ownerStartedAt === "string" && Number.isFinite(Date.parse(value.ownerStartedAt))))
      ? value as UpdateLockPayload
      : null;
  } catch {
    return null;
  }
}

async function legacyUpdaterOwnerMatches(
  payload: UpdateLockPayload,
  lockPath: string
): Promise<boolean | null> {
  const result = await execFile("/bin/ps", ["-ww", "-p", String(payload.pid), "-o", "command="], {
    cwd: dirname(lockPath),
    timeoutMs: EXEC_TIMEOUT_MS
  });
  if (!result.ok) return processExists(payload.pid) ? null : false;
  const command = result.stdout.trim();
  return command.includes(`--lock-path ${lockPath}`)
    && command.includes(`--lock-token ${payload.token}`);
}

async function processStartedAt(pid: number, cwd: string): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = await execFile("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
    cwd,
    timeoutMs: EXEC_TIMEOUT_MS
  });
  if (!result.ok) return null;
  const timestamp = Date.parse(result.stdout.trim());
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sameProcessStart(expected: string, observed: string): boolean {
  const expectedAt = Date.parse(expected);
  const observedAt = Date.parse(observed);
  return Number.isFinite(expectedAt) && Number.isFinite(observedAt) && Math.abs(expectedAt - observedAt) < 2_000;
}

async function assertLocallyRebuildableApp(appPath: string): Promise<void> {
  if (!existsSync(appPath)) return;
  const identity = await execFile("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    cwd: dirname(appPath),
    timeoutMs: EXEC_TIMEOUT_MS
  });
  const detail = `${identity.stdout}\n${identity.stderr}`;
  if (!identity.ok && /code object is not signed at all/iu.test(detail)) return;
  if (!identity.ok) {
    throw new Error(
      `Vigil could not inspect the installed app signature. ${execResultDetail(identity)}`
    );
  }
  const verification = await execFile(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", appPath],
    {
      cwd: dirname(appPath),
      timeoutMs: EXEC_TIMEOUT_MS
    }
  );
  if (!verification.ok) {
    throw new Error(
      `The installed Vigil app failed strict code-signature verification. ${execResultDetail(verification)}`
    );
  }
  if (!isLocallyRebuildableSignature(detail)) {
    throw new Error("This Vigil app has a distribution signature. Install a complete signed release instead of rebuilding it in place.");
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function guardianCheckFailure(message: string): UpdatePreflightCheck | null {
  const match = /(?:^|\s)check=([a-z0-9][a-z0-9.-]*)\s+detail=([\s\S]+)$/iu.exec(message.trim());
  if (!match) return null;
  const check = String(match[1] || "").trim();
  const detail = String(match[2] || "").trim();
  if (!check || !detail) return null;
  return {
    code: check,
    label: `Guardian check ${check}`,
    status: "fail",
    message: message.trim(),
    detail
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function signalUpdaterChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The child already exited.
    }
  }
}

/**
 * A detached updater owns both a process group and, after handoff, the durable
 * update lock. Never let the controller release that lock merely because a
 * signal was sent: confirmation that the entire group is gone is the boundary
 * which permits another attempt.
 */
export async function terminateUpdaterChildAndConfirm(
  pid: number | undefined,
  timeoutMs = UPDATER_BOOTSTRAP_TERMINATION_TIMEOUT_MS,
  overrides: Partial<UpdaterBootstrapTerminationOperations> = {}
): Promise<boolean> {
  if (!pid) return true;
  const operations: UpdaterBootstrapTerminationOperations = {
    signal: overrides.signal || ((targetPid) => signalUpdaterChild(targetPid, "SIGKILL")),
    processGroupExists: overrides.processGroupExists || updaterProcessGroupExists,
    wait: overrides.wait || delay
  };
  operations.signal(pid);
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (!operations.processGroupExists(pid)) return true;
    if (Date.now() >= deadline) return false;
    await operations.wait(Math.min(UPDATER_BOOTSTRAP_TERMINATION_POLL_MS, Math.max(1, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return !operations.processGroupExists(pid);
}

function updaterProcessGroupExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

async function childStarted(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolveStart, rejectStart) => {
    child.once("spawn", resolveStart);
    child.once("error", rejectStart);
  });
}

export async function waitForUpdaterBootstrap(
  statusPath: string,
  attemptId: string,
  childPid: number,
  timeoutMs = UPDATER_BOOTSTRAP_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await readUpdateReceipt(statusPath);
    if (receipt.status === "valid" && receipt.receipt.attemptId === attemptId) {
      if (receipt.receipt.phase === "failed") {
        throw new Error(receipt.receipt.error || receipt.receipt.message || "The Vigil updater failed during startup.");
      }
      if (receipt.receipt.phase !== "starting" && receipt.receipt.phase !== "checking") return;
    }
    if (!processExists(childPid)) throw new Error("The Vigil updater exited before confirming startup.");
    await delay(50);
  }
  throw new Error("The Vigil updater did not confirm startup in time.");
}
