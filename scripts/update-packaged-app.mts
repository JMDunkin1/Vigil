import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";
import { liveRuntimeReady } from "../src/runtimeReady.js";
import { resumeEmbeddedRuntimeSupervisor } from "../src/embeddedSupervisor.js";
import { isDirectRun } from "../src/directRun.js";
import { plistStringForKey } from "../src/plist.js";
import {
  beginGuardianMaintenance,
  guardianMaintenanceReadiness,
  UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION,
  verifiedAppCodeDirectoryHash,
  waitForGuardianRecoveryAuthorization
} from "../src/updateMaintenance.js";
import type { GuardianMaintenanceTransaction } from "../src/updateMaintenance.js";
import { mergeWriteUpdateReceipt } from "../src/updateReceipt.js";
import type { UpdateReceiptPatch, UpdateReceiptPhase } from "../src/updateReceipt.js";
import {
  activateStagedUpdateArtifact,
  beginUpdateRecoveryTransaction,
  captureUpdateArtifactIdentity,
  markUpdateRecoveryCommitIntent,
  markUpdateRecoveryCommitted,
  readUpdateRecoveryManifest,
  reconcileStagedUpdateArtifactCandidate,
  recoveryDependenciesForStableHelper,
  recoverUpdateTransaction,
  recoverUpdateTransactionFromPolicyFile,
  stageUpdateArtifactCandidate,
  updateArtifactIdentitiesExactlyMatch,
  updateRecoveryPaths
} from "../src/updateTransaction.js";
import type {
  UpdateArtifactIdentity,
  UpdateArtifactPlan,
  UpdateRecoveryBundleSource,
  UpdateRecoveryDependencies,
  UpdateRecoveryOutcome,
  UpdateRecoveryPolicy
} from "../src/updateTransaction.js";
import { gitExecutable } from "./git-executable.mjs";
import { isLocallyRebuildableSignature } from "./mac-signing-identity.mjs";
import { reattestStagedPrebuiltRelease } from "../src/prebuiltRelease.js";
import { cleanupDownloadedPrebuiltRelease } from "../src/prebuiltReleaseDownload.js";

interface PrebuiltReleaseOptions {
  root: string;
  manifestPath: string;
  stagedAppPath: string;
  candidateCdHash: string;
}

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  userDataDir: string;
  statusPath: string;
  logPath: string;
  lockPath: string;
  lockToken: string;
  expectedInitialCommit: string;
  expectedBranch: string;
  expectedCommit: string;
  prebuiltRelease: PrebuiltReleaseOptions | null;
  restart: boolean;
}

interface StagedBuild {
  sourceKind: "source" | "prebuilt";
  root: string;
  repoRoot: string;
  builtAppPath: string;
  builtRuntimePath: string;
  runtimeTreeSha256: string | null;
  candidateCdHash: string | null;
  expectedCommit: string;
  initialCommit: string;
  initialBranch: string | null;
}

interface BackendHealthContext {
  port: number;
  instanceSecret: string;
}

interface LaunchAgentRecovery {
  context: BackendHealthContext;
  plist: string;
  plistMode: number;
  plistPath: string;
  uid: number;
}

export interface InstalledUpdateTopologyPreflight {
  installedRuntimePath: string | null;
  launchAgentLoaded: boolean;
  replacementDataDirectory: string;
}

export async function inspectInstalledUpdateTopology(
  repoRoot: string,
  includeRuntime: boolean
): Promise<InstalledUpdateTopologyPreflight> {
  const launchAgent = await captureLoadedLaunchAgentRecovery();
  const replacementDataDirectory = await replacementDataDir(
    launchAgent !== null,
    launchAgent?.plist
  );
  return {
    installedRuntimePath: includeRuntime
      ? await resolveInstalledRuntimeTarget(repoRoot)
      : null,
    launchAgentLoaded: launchAgent !== null,
    replacementDataDirectory
  };
}

export interface AppInstallation {
  attachStateSnapshot(snapshot: UpdateStateSnapshot): Promise<void>;
  markVerified(): Promise<void>;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface UpdateStateSnapshot extends AppInstallation {
  dataDir: string;
  snapshotRoot: string;
  restore(): Promise<void>;
}

export interface AtomicInstallOperations {
  pathExists(path: string): Promise<boolean>;
  copy(source: string, destination: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
  identity(path: string): Promise<FileIdentity>;
  quarantinePartial?(path: string, quarantinePath: string): Promise<void>;
  swap?(left: string, right: string): Promise<void>;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

interface AtomicInstallJournal {
  version: 2;
  id: string;
  targetPath: string;
  nextPath: string;
  previousPath: string;
  phase: "preparing" | "prepared" | "swapping" | "backing-up" | "installed" | "verified" | "rolling-back" | "finalizing";
  hadPrevious: boolean;
  candidateDevice?: number;
  candidateInode?: number;
  initialPresent?: boolean;
  initialCommit?: string | null;
  initialFingerprint?: string | null;
  initialDevice?: number | null;
  initialInode?: number | null;
  stateDataDir?: string;
  stateSnapshotRoot?: string;
  updatedAt: string;
}

const HEALTH_TIMEOUT_MS = 30_000;
const UPDATER_LOCK_HANDOFF_TIMEOUT_MS = 10_000;
// The restarted candidate independently records the same commit intent after
// sustained health. Its exact app verification can legitimately hold the
// recovery lock longer than the short default used by ordinary callers, so
// the updater's redundant handoff must wait for that bounded operation instead
// of mistaking safe serialization for a failed update.
const RECOVERY_LOCK_HANDOFF_TIMEOUT_MS = 60_000;
const SOURCE_COMMAND_TIMEOUT_MS = 60_000;
const DEPENDENCY_INSTALL_TIMEOUT_MS = 15 * 60_000;
const RUNTIME_BUILD_TIMEOUT_MS = 15 * 60_000;
const APP_PACKAGE_TIMEOUT_MS = 20 * 60_000;
const COMMAND_TERMINATION_GRACE_MS = 5_000;
const COMMAND_KILL_CONFIRMATION_MS = 5_000;
const COMMAND_TERMINATION_POLL_MS = 50;
const BACKGROUND_LAUNCH_ARG = "--vigil-background";
const SAFETY_BOUNDARY_ARG = "--vigil-safety-boundary-do-not-terminate-or-bootout";
// Signed protocol capability consumed by the one-time v2-to-v3 online bridge.
// Keep this literal export in the packaged updater so the bridge can pin the
// exact script it will cause the already-running controller to resolve.
export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = 3;
if (PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION !== UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION) {
  throw new Error("Vigil's packaged updater protocol revision is inconsistent.");
}
let options: Options;
let log: ReturnType<typeof createWriteStream>;
let activeChild: ChildProcess | null = null;
let interrupted = false;

export async function runPackagedUpdate(): Promise<void> {
  let stagedBuild: StagedBuild | null = null;
  let appPlan: UpdateArtifactPlan | null = null;
  let runtimePlan: UpdateArtifactPlan | null = null;
  let recoveryPolicy: UpdateRecoveryPolicy | null = null;
  let recoveryDependencies: UpdateRecoveryDependencies | null = null;
  let recoveryBundle: UpdateRecoveryBundleSource | null = null;
  let launchAgentTransition: LaunchAgentRecovery | null = null;
  let guardianMaintenance: GuardianMaintenanceTransaction | null = null;
  let prebuiltCleanupRoot: string | null = null;
  let parentExited = false;
  let launchAgentWasLoaded = false;
  let launchAgentStopped = false;
  let replacementDataDirectory = "";

  try {
    options = parseArgs(process.argv.slice(2));
    // Retain the untrusted attempt root immediately so every later validation
    // failure reaches the constrained cleanup routine. The path is never
    // removed unless cleanupDownloadedPrebuiltRelease independently proves it
    // belongs to this exact private updater directory.
    prebuiltCleanupRoot = options.prebuiltRelease?.root || null;
    await mkdir(dirname(options.statusPath), { recursive: true });
    await mkdir(dirname(options.logPath), { recursive: true });
    log = createWriteStream(options.logPath, { flags: "a" });
    // Logging is diagnostic only. A late filesystem error must never bypass the
    // updater's transactional catch/finally recovery path via EventEmitter's
    // special unhandled `error` behavior.
    log.on("error", () => undefined);
    installSignalHandlers();
    await assertOwnedUpdaterLock();
    await status("selecting", "Protected Vigil updater started");
    await reconcilePreviousGlobalUpdateWhileRuntimeIsLive();
    if (!options.prebuiltRelease) await assertLocallyRebuildableApp();

    const maintenance = await guardianMaintenanceReadiness();
    if (!maintenance.ready) throw new Error(maintenance.message || "Vigil's protected update setup is not ready.");

    await assertSelectedSourceIdentity();
    const dirty = (await capture("git", ["status", "--porcelain=v1"], { cwd: options.repoRoot })).trim().length > 0;
    if (dirty) throw new Error("Vigil source has uncommitted changes. Commit or stash them before installing an update.");

    // Finish the installed-topology preflight before npm, TypeScript, signing,
    // or packaging begins. These checks do not stop either Vigil process.
    launchAgentTransition = await captureLoadedLaunchAgentRecovery();
    launchAgentWasLoaded = launchAgentTransition !== null;
    replacementDataDirectory = await replacementDataDir(
      launchAgentWasLoaded,
      launchAgentTransition?.plist
    );
    // `dist` is intentionally a convenience symlink to `dist.nosync` in the
    // primary checkout. Recovery policy paths are durable security boundaries,
    // so bind the runtime target to its canonical location before any staging
    // journal is created rather than teaching recovery to follow a mutable
    // symlink after a crash or reboot.
    const installedRuntimePath = await resolveInstalledRuntimeTarget(options.repoRoot);
    recoveryPolicy = {
      updaterDir: dirname(options.statusPath),
      expectedAppPath: options.appPath,
      repoRoot: options.repoRoot,
      userDataDir: options.userDataDir,
      expectedDataDir: replacementDataDirectory,
      expectedRuntimePaths: [installedRuntimePath]
    };

    if (options.prebuiltRelease) {
      prebuiltCleanupRoot = await assertPrivatePrebuiltReleasePaths(options.prebuiltRelease);
      stagedBuild = await preparePrebuiltRelease(prebuiltCleanupRoot);
    } else {
      stagedBuild = await buildInIsolatedWorktree();
    }

    await assertActiveCheckoutUnchanged(stagedBuild);
    await status(
      "installing-runtime",
      stagedBuild.sourceKind === "prebuilt"
        ? "Durably staging the verified signed Vigil runtime"
        : "Durably staging the rebuilt Vigil runtime"
    );
    runtimePlan = await stageUpdateArtifactCandidate(
      recoveryPolicy,
      options.lockToken,
      stagedBuild.builtRuntimePath,
      installedRuntimePath,
      "runtime"
    );
    await assertPrebuiltRuntimeTreeBinding(stagedBuild, runtimePlan);
    await status(
      "installing-app",
      stagedBuild.sourceKind === "prebuilt"
        ? "Durably staging the verified signed Vigil app"
        : "Durably staging the rebuilt Vigil app"
    );
    appPlan = await stageUpdateArtifactCandidate(
      recoveryPolicy,
      options.lockToken,
      stagedBuild.builtAppPath,
      options.appPath,
      "app"
    );
    await bindAppPlanCodeDirectoryHashes(appPlan);
    if (stagedBuild.candidateCdHash && appPlan.targetCdHash !== stagedBuild.candidateCdHash) {
      throw new Error("The durable staged app does not match the parent-verified prebuilt release CodeDirectory hash.");
    }
    await assertActiveCheckoutUnchanged(stagedBuild);
    // This is the final potentially expensive operation before entering
    // guardian maintenance. Re-hash the exact .vigil-next generation so no
    // same-user mutation after staging can cross the availability boundary.
    await assertPrebuiltRuntimeTreeBinding(stagedBuild, runtimePlan);

    guardianMaintenance = await beginGuardianMaintenance(options.lockPath, options.lockToken);
    await status("waiting", "Update ready; waiting for Vigil to quit");
    process.kill(options.parentPid, "SIGUSR2");
    try {
      await waitForExit(options.parentPid, 45_000);
      parentExited = true;
    } catch (error) {
      await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
      throw error;
    }

    if (launchAgentTransition) {
      launchAgentTransition = await stopLaunchAgentForStateTransition(launchAgentTransition);
      launchAgentStopped = true;
    }
    await status("installing-runtime", "Recording the crash-recoverable Vigil update transaction");
    recoveryBundle = await updateRecoveryBundleSource();
    const recoveryManifest = await beginUpdateRecoveryTransaction(recoveryPolicy, {
      attemptId: options.lockToken,
      source: {
        initialCommit: stagedBuild.initialCommit,
        initialBranch: stagedBuild.initialBranch,
        targetCommit: stagedBuild.expectedCommit
      },
      app: appPlan,
      runtimes: [runtimePlan],
      recoveryBundle
    });
    recoveryDependencies = {
      ...await recoveryDependenciesForStableHelper(recoveryPolicy, recoveryManifest),
      lockTimeoutMs: RECOVERY_LOCK_HANDOFF_TIMEOUT_MS
    };
    await waitForGuardianRecoveryAuthorization(
      options.lockPath,
      options.lockToken,
      recoveryManifest.recovery.policySha256,
      process.pid,
      guardianCodeDirectoryHashOptions(appPlan)
    );

    await assertAppPlanCodeDirectoryHashes(appPlan, false);
    await activateStagedUpdateArtifact(
      recoveryPolicy,
      options.lockToken,
      runtimePlan,
      "runtime",
      recoveryDependencies
    );
    await verifyBuildInfo(
      join(installedRuntimePath, "build-info.json"),
      stagedBuild.expectedCommit,
      "installed Vigil runtime"
    );
    await status("installing-app", "Activating the exact staged Vigil app");
    await activateStagedUpdateArtifact(
      recoveryPolicy,
      options.lockToken,
      appPlan,
      "app",
      recoveryDependencies
    );
    await assertAppPlanCodeDirectoryHashes(appPlan, true);
    await verifyInstalledAppBuild(stagedBuild.expectedCommit);
    if (!options.restart) throw new Error("Vigil app replacement verification requires --restart.");
    await status(
      "verifying",
      stagedBuild.sourceKind === "prebuilt"
        ? "Reopening and verifying the signed Vigil release"
        : "Reopening and verifying the rebuilt Vigil app"
    );
    await openAndVerifyReplacement(replacementDataDirectory, launchAgentTransition?.context);

    // The candidate app repeats this transition after its own sustained,
    // signed-health check. Recording the same attempt here makes the handshake
    // idempotent if either process exits immediately after attestation.
    await markUpdateRecoveryCommitIntent(recoveryPolicy, options.lockToken, recoveryDependencies);

    await assertActiveCheckoutUnchanged(stagedBuild, recoveryBundle.gitPath);
    await status("updating-source", "Fast-forwarding Vigil source to the verified build");
    let sourceSyncDiagnostic = "";
    try {
      await run(recoveryBundle.gitPath, ["merge", "--ff-only", stagedBuild.expectedCommit], {
        cwd: options.repoRoot,
        timeoutMs: SOURCE_COMMAND_TIMEOUT_MS
      });
    } catch (error) {
      if (await activeHeadMatches(stagedBuild.expectedCommit, recoveryBundle.gitPath)) {
        sourceSyncDiagnostic = `Git reported an error after the checkout reached ${stagedBuild.expectedCommit}: ${errorMessage(error)}`;
      } else {
        sourceSyncDiagnostic = `The initial source fast-forward attempt did not complete: ${errorMessage(error)}`;
      }
    }

    await markUpdateRecoveryCommitted(recoveryPolicy, options.lockToken, recoveryDependencies);
    const outcome = await recoverUpdateTransaction(recoveryPolicy, {
      ...recoveryDependencies,
      allowRollback: false
    });
    if (!outcome
      || outcome.attemptId !== options.lockToken
      || outcome.status !== "complete"
      || outcome.sourceSyncPending) {
      throw new Error(outcome?.message || "Vigil could not durably finalize the verified update transaction.");
    }
    // A `complete` global outcome proves that recovery either observed or
    // retried the exact source fast-forward successfully. Keep an earlier Git
    // process error in the diagnostic log, but never resurrect it as a stale UI
    // warning after the authoritative finalizer has proved success.
    if (sourceSyncDiagnostic) log?.write(`${sourceSyncDiagnostic} Durable finalization subsequently verified the source checkout.\n`);
    const cleanupErrors: string[] = [];
    if (launchAgentTransition && process.env.VIGIL_KEEP_LEGACY_SERVER !== "1") {
      const legacyAgentCleanupError = await finalizeLegacyLaunchAgentRetirement(launchAgentTransition);
      if (legacyAgentCleanupError) cleanupErrors.push(legacyAgentCleanupError);
    }
    const message = cleanupErrors.length
      ? `Vigil update complete. Cleanup warning: ${cleanupErrors.join(" ")}`
      : "Vigil update complete";
    await status("complete", message, {
      ok: true,
      installedCommit: stagedBuild.expectedCommit,
      finishedAt: new Date().toISOString()
    });
  } catch (error) {
    let message = errorMessage(error);
    if (!parentExited && typeof options !== "undefined" && options.restart) {
      parentExited = await parentExitedSoon(options.parentPid, 2_000);
    }
    const recovery = await settleGlobalUpdateAfterFailure({
      recoveryPolicy,
      recoveryDependencies,
      stagedPlans: [appPlan, runtimePlan],
      launchAgentTransition,
      launchAgentStopped,
      parentExited,
      launchAgentWasLoaded,
      replacementDataDirectory
    });
    if (recovery.errors.length) message = `${message} Recovery also reported: ${recovery.errors.join(" ")}`;
    if (recovery.committed) {
      const completionMessage = `Vigil update complete. Final confirmation warning: ${message}`;
      await safeStatus("complete", completionMessage, {
        ok: true,
        installedCommit: stagedBuild?.expectedCommit || options.expectedCommit,
        finishedAt: new Date().toISOString()
      });
    } else {
      await safeStatus("failed", message, {
        ok: false,
        error: message,
        finishedAt: new Date().toISOString()
      });
      process.exitCode = 1;
    }
  } finally {
    if (guardianMaintenance) {
      await guardianMaintenance.release().catch((error) => {
        log?.write(`Could not clear the guardian maintenance marker: ${errorMessage(error)}\n`);
      });
    }
    if (stagedBuild) {
      await cleanupStagedBuild(stagedBuild).catch((error) => {
        log?.write(`Could not clean up the staged update: ${errorMessage(error)}\n`);
      });
    } else if (prebuiltCleanupRoot) {
      await cleanupDownloadedPrebuiltRelease(prebuiltCleanupRoot, dirname(options.statusPath)).catch((error) => {
        log?.write(`Could not clean up the downloaded signed release: ${errorMessage(error)}\n`);
      });
    }
    if (typeof options !== "undefined") await releaseOwnedUpdaterLock();
    log?.end();
  }
}

async function bindAppPlanCodeDirectoryHashes(plan: UpdateArtifactPlan): Promise<void> {
  if (!plan.initialIdentity) {
    throw new Error("Vigil's protected app update requires an installed signed generation.");
  }
  const [initialCdHash, targetCdHash] = await Promise.all([
    verifiedAppCodeDirectoryHash(plan.targetPath),
    verifiedAppCodeDirectoryHash(`${plan.targetPath}.vigil-next`)
  ]);
  plan.initialCdHash = initialCdHash;
  plan.targetCdHash = targetCdHash;
}

function guardianCodeDirectoryHashOptions(plan: UpdateArtifactPlan): {
  expectedAppInitialCdHash: string;
  expectedAppTargetCdHash: string;
} {
  if (!plan.initialCdHash || !plan.targetCdHash) {
    throw new Error("Vigil's protected app update is missing its signed generation hashes.");
  }
  return {
    expectedAppInitialCdHash: plan.initialCdHash,
    expectedAppTargetCdHash: plan.targetCdHash
  };
}

async function assertAppPlanCodeDirectoryHashes(plan: UpdateArtifactPlan, activated: boolean): Promise<void> {
  const expected = guardianCodeDirectoryHashOptions(plan);
  const initialPath = activated ? `${plan.targetPath}.vigil-previous` : plan.targetPath;
  const targetPath = activated ? plan.targetPath : `${plan.targetPath}.vigil-next`;
  const [initialCdHash, targetCdHash] = await Promise.all([
    verifiedAppCodeDirectoryHash(initialPath),
    verifiedAppCodeDirectoryHash(targetPath)
  ]);
  if (initialCdHash !== expected.expectedAppInitialCdHash
    || targetCdHash !== expected.expectedAppTargetCdHash) {
    throw new Error("Vigil's exact signed app generations changed across protected activation.");
  }
}

interface GlobalFailureRecovery {
  committed: boolean;
  errors: string[];
}

async function reconcilePreviousGlobalUpdateWhileRuntimeIsLive(): Promise<void> {
  const paths = updateRecoveryPaths(dirname(options.statusPath));
  if (!(await pathExists(paths.manifestPath))) return;
  const outcome = await recoverUpdateTransactionFromPolicyFile(paths.policyPath, { allowRollback: false });
  if (outcome?.status === "complete" && !(await pathExists(paths.manifestPath))) return;
  throw new Error(outcome?.message || "Vigil must finish recovering the previous update before another can start.");
}

async function updateRecoveryBundleSource(): Promise<UpdateRecoveryBundleSource> {
  const runtimeScriptsDir = dirname(fileURLToPath(import.meta.url));
  const selectedGit = await gitExecutable(options.repoRoot);
  const absoluteGit = isAbsolute(selectedGit)
    ? selectedGit
    : (await capture("/usr/bin/which", [selectedGit], {
        cwd: options.repoRoot,
        timeoutMs: SOURCE_COMMAND_TIMEOUT_MS
      })).trim();
  if (!absoluteGit || !isAbsolute(absoluteGit)) {
    throw new Error("Vigil could not bind update recovery to an exact Git executable.");
  }
  return {
    nodePath: await realpath(process.execPath),
    gitPath: await realpath(absoluteGit),
    scriptSourcePath: join(runtimeScriptsDir, "recover-update-transaction.mjs"),
    moduleSourcePath: join(runtimeScriptsDir, "..", "src", "updateTransaction.js"),
    treeDigestModuleSourcePath: join(runtimeScriptsDir, "..", "src", "runtimeTreeDigest.js"),
    helperSourcePath: join(runtimeScriptsDir, "..", "bin", "vigil-atomic-swap")
  };
}

/**
 * Bind the ignored `dist` convenience link to the one runtime location this
 * updater is authorized to replace. Merely accepting `realpath(dist/runtime)`
 * would let a stale or retargeted ignored link redirect the transaction to an
 * unrelated directory without making the Git checkout dirty.
 */
export async function resolveInstalledRuntimeTarget(repoRootInput: string): Promise<string> {
  const repoRoot = resolve(repoRootInput);
  const canonicalRepoRoot = await realpath(repoRoot);
  if (canonicalRepoRoot !== repoRoot) {
    throw new Error("Vigil's source repository path must be canonical before selecting its runtime target.");
  }
  const intendedRuntimePath = join(canonicalRepoRoot, "dist.nosync", "runtime");
  const [canonicalIntendedRuntimePath, linkedRuntimePath] = await Promise.all([
    realpath(intendedRuntimePath),
    realpath(join(canonicalRepoRoot, "dist", "runtime"))
  ]);
  if (canonicalIntendedRuntimePath !== intendedRuntimePath || linkedRuntimePath !== intendedRuntimePath) {
    throw new Error("Vigil's dist runtime link does not resolve to its authorized dist.nosync runtime target.");
  }
  return intendedRuntimePath;
}

async function settleGlobalUpdateAfterFailure({
  recoveryPolicy,
  recoveryDependencies,
  stagedPlans,
  launchAgentTransition,
  launchAgentStopped,
  parentExited,
  launchAgentWasLoaded,
  replacementDataDirectory
}: {
  recoveryPolicy: UpdateRecoveryPolicy | null;
  recoveryDependencies: UpdateRecoveryDependencies | null;
  stagedPlans: Array<UpdateArtifactPlan | null>;
  launchAgentTransition: LaunchAgentRecovery | null;
  launchAgentStopped: boolean;
  parentExited: boolean;
  launchAgentWasLoaded: boolean;
  replacementDataDirectory: string;
}): Promise<GlobalFailureRecovery> {
  const errors: string[] = [];
  const attemptId = typeof options === "undefined" ? "" : options.lockToken;
  let outcome: UpdateRecoveryOutcome | null = null;
  let manifestObserved = false;
  const activeRecoveryDependencies = recoveryDependencies || {};
  if (recoveryPolicy) {
    try {
      manifestObserved = true;
      manifestObserved = await pathExists(updateRecoveryPaths(recoveryPolicy.updaterDir).manifestPath);
      const manifest = await readUpdateRecoveryManifest(recoveryPolicy);
      manifestObserved ||= manifest !== null;
      if (manifest && (manifest.state === "commit-intent" || manifest.state === "committed")) {
        outcome = await recoverUpdateTransaction(recoveryPolicy, {
          ...activeRecoveryDependencies,
          allowRollback: false
        });
      } else if (manifest) {
        if (!parentExited) {
          errors.push("The pending transaction is waiting for the original Vigil process to exit before rollback.");
        } else {
          const appPlan = stagedPlans.find((plan) => plan?.targetPath === options.appPath) || null;
          await terminateInstalledCandidate(appPlan);
          outcome = await recoverUpdateTransaction(recoveryPolicy, activeRecoveryDependencies);
        }
      } else {
        const priorOutcome = await recoverUpdateTransaction(recoveryPolicy, {
          ...activeRecoveryDependencies,
          allowRollback: false
        });
        if (priorOutcome?.attemptId === attemptId) outcome = priorOutcome;
      }
    } catch (recoveryError) {
      errors.push(`The durable update transaction could not be reconciled: ${errorMessage(recoveryError)}`);
    }
  }

  if (attemptId && outcome?.attemptId === attemptId && outcome.status === "complete") {
    return { committed: true, errors };
  }
  if (attemptId && outcome?.attemptId === attemptId && outcome.status === "recovery-failed") {
    errors.push(outcome.message);
    return { committed: false, errors };
  }

  if (!manifestObserved && outcome?.attemptId !== attemptId && recoveryPolicy) {
    const stagedTargets = [
      ...recoveryPolicy.expectedRuntimePaths.map((targetPath) => ({ targetPath, kind: "runtime" as const })),
      { targetPath: recoveryPolicy.expectedAppPath, kind: "app" as const }
    ];
    for (const target of stagedTargets.reverse()) {
      try {
        await reconcileStagedUpdateArtifactCandidate(recoveryPolicy, target.targetPath, target.kind);
      } catch (cleanupError) {
        errors.push(`The staged artifact at ${target.targetPath} could not be reconciled: ${errorMessage(cleanupError)}`);
      }
    }
  }

  const rolledBack = attemptId !== "" && outcome?.attemptId === attemptId && outcome.status === "failed-recovered";
  const unchangedBeforeTransaction = !manifestObserved && outcome?.attemptId !== attemptId;
  if (typeof options !== "undefined" && parentExited && options.restart && (rolledBack || unchangedBeforeTransaction)) {
    let legacyRestored = false;
    if (launchAgentWasLoaded && launchAgentStopped && launchAgentTransition) {
      try {
        await startLaunchAgentAfterStateTransition(launchAgentTransition);
        legacyRestored = true;
      } catch (restoreError) {
        errors.push(`The previous background service could not be restored: ${errorMessage(restoreError)}`);
      }
    }
    try {
      if (!legacyRestored) await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
      const dataDir = replacementDataDirectory || await replacementDataDir(launchAgentWasLoaded, launchAgentTransition?.plist);
      await openAndVerifyRecoveredApp(dataDir, launchAgentTransition?.context);
    } catch (reopenError) {
      errors.push(`The restored Vigil app could not be verified; persistent supervision will retry: ${errorMessage(reopenError)}`);
    }
  }
  return { committed: false, errors };
}

async function terminateInstalledCandidate(plan: UpdateArtifactPlan | null): Promise<void> {
  if (!plan) return;
  const installed = await captureUpdateArtifactIdentity(plan.targetPath, "app");
  if (installed && artifactIdentitiesMatch(plan.targetIdentity, installed)) {
    await terminateInstalledApp();
    return;
  }
  if ((installed === null && plan.initialIdentity === null)
    || (installed !== null && plan.initialIdentity !== null && artifactIdentitiesMatch(plan.initialIdentity, installed))) {
    return;
  }
  throw new Error("Vigil preserved an app with an ambiguous identity instead of terminating it for rollback.");
}

function artifactIdentitiesMatch(expected: UpdateArtifactIdentity, observed: UpdateArtifactIdentity): boolean {
  return updateArtifactIdentitiesExactlyMatch(expected, observed);
}

async function assertPrebuiltRuntimeTreeBinding(
  stagedBuild: StagedBuild,
  runtimePlan: UpdateArtifactPlan
): Promise<void> {
  if (stagedBuild.sourceKind !== "prebuilt") return;
  const expectedTreeSha256 = stagedBuild.runtimeTreeSha256;
  if (!expectedTreeSha256 || !/^[a-f0-9]{64}$/u.test(expectedTreeSha256)) {
    throw new Error("The verified signed Vigil release is missing its embedded runtime-tree digest.");
  }
  if (runtimePlan.targetIdentity.treeSha256 !== expectedTreeSha256) {
    throw new Error("The durably staged Vigil runtime does not reproduce the verified signed app runtime tree.");
  }
  const stagedPath = `${runtimePlan.targetPath}.vigil-next`;
  const observed = await captureUpdateArtifactIdentity(stagedPath, "runtime");
  if (!observed
    || observed.treeSha256 !== expectedTreeSha256
    || !updateArtifactIdentitiesExactlyMatch(runtimePlan.targetIdentity, observed)) {
    throw new Error("The durably staged Vigil runtime changed after its signed-tree identity was captured.");
  }
}

async function preparePrebuiltRelease(privateRoot: string): Promise<StagedBuild> {
  const release = options.prebuiltRelease;
  if (!release) throw new Error("The prebuilt release selection is missing.");
  await status("staging", "Re-attesting the downloaded signed Vigil release");
  const verified = await reattestStagedPrebuiltRelease({
    expectedCandidateCdHash: release.candidateCdHash,
    expectedCommit: options.expectedCommit,
    installedAppPath: options.appPath,
    manifestPath: release.manifestPath,
    stagedAppPath: release.stagedAppPath
  });
  if (verified.manifest.commit !== options.expectedCommit
    || verified.candidateCdHash !== release.candidateCdHash) {
    throw new Error("The child updater could not reproduce the selected signed-release identity.");
  }
  const builtRuntimePath = join(
    verified.stagedAppPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime"
  );
  const [runtimeRealPath, runtimeStat] = await Promise.all([
    realpath(builtRuntimePath),
    lstat(builtRuntimePath)
  ]);
  if (runtimeRealPath !== builtRuntimePath
    || !runtimeStat.isDirectory()
    || runtimeStat.isSymbolicLink()
    || !runtimeRealPath.startsWith(`${verified.stagedAppPath}/`)) {
    throw new Error("The signed release app has an unsafe embedded runtime path.");
  }
  await Promise.all([
    verifyBuildInfo(
      join(runtimeRealPath, "build-info.json"),
      options.expectedCommit,
      "prebuilt Vigil runtime"
    ),
    verifyBuildInfo(
      join(verified.stagedAppPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
      options.expectedCommit,
      "prebuilt Vigil app"
    )
  ]);
  return {
    sourceKind: "prebuilt",
    root: privateRoot,
    repoRoot: "",
    builtAppPath: verified.stagedAppPath,
    builtRuntimePath: runtimeRealPath,
    runtimeTreeSha256: verified.runtimeTreeDigest.sha256,
    candidateCdHash: verified.candidateCdHash,
    expectedCommit: options.expectedCommit,
    initialCommit: options.expectedInitialCommit,
    initialBranch: expectedBranchName(options.expectedBranch)
  };
}

async function assertPrivatePrebuiltReleasePaths(release: PrebuiltReleaseOptions): Promise<string> {
  const updaterDir = resolve(dirname(options.statusPath));
  const root = resolve(release.root);
  const [updaterRealPath, rootRealPath, rootStat] = await Promise.all([
    realpath(updaterDir),
    realpath(root),
    lstat(root)
  ]);
  const uid = process.getuid?.();
  if (updaterRealPath !== updaterDir
    || rootRealPath !== root
    || dirname(root) !== updaterDir
    || !basename(root).startsWith("prebuilt-download-")
    || !rootStat.isDirectory()
    || rootStat.isSymbolicLink()
    || (uid !== undefined && rootStat.uid !== uid)
    || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error("The prebuilt release is not in this updater attempt's private storage.");
  }
  for (const [path, label] of [
    [release.manifestPath, "manifest"],
    [release.stagedAppPath, "staged app"]
  ] as const) {
    const absolutePath = resolve(path);
    const canonicalPath = await realpath(absolutePath);
    if (canonicalPath !== absolutePath || !canonicalPath.startsWith(`${root}/`)) {
      throw new Error(`The prebuilt release ${label} escaped its private download directory.`);
    }
  }
  return root;
}

async function buildInIsolatedWorktree(): Promise<StagedBuild> {
  await status("selecting", "Verifying the selected Vigil update");
  const initialCommit = options.expectedInitialCommit;
  const initialBranch = expectedBranchName(options.expectedBranch);
  const expectedCommit = options.expectedCommit;
  if (!/^[a-f0-9]{40}$/iu.test(initialCommit) || !/^[a-f0-9]{40}$/iu.test(expectedCommit)) {
    throw new Error("Vigil could not verify the source commits selected for this update.");
  }
  const fastForward = await run("git", ["merge-base", "--is-ancestor", initialCommit, expectedCommit], {
    allowFailure: true,
    capture: true,
    cwd: options.repoRoot
  });
  if (!fastForward.ok) throw new Error("Vigil source cannot be fast-forwarded to its upstream commit.");

  const root = await mkdtemp(join(dirname(options.statusPath), "staged-update-"));
  const repoRoot = join(root, "source");
  try {
    await status("staging", "Creating an isolated Vigil source checkout");
    await run("git", ["worktree", "add", "--detach", repoRoot, expectedCommit], {
      cwd: options.repoRoot,
      timeoutMs: SOURCE_COMMAND_TIMEOUT_MS
    });

    await status("installing", "Installing locked Vigil dependencies in the staged checkout");
    await run(npmExecutable(), ["ci"], { cwd: repoRoot, timeoutMs: DEPENDENCY_INSTALL_TIMEOUT_MS });

    await status("building", "Building the Vigil runtime in the staged checkout");
    await run(npmExecutable(), ["run", "build"], {
      cwd: repoRoot,
      env: { ...process.env, VIGIL_BUILD_SOURCE_ROOT: options.repoRoot },
      timeoutMs: RUNTIME_BUILD_TIMEOUT_MS
    });
    await verifyBuildInfo(
      join(repoRoot, "dist", "runtime", "build-info.json"),
      expectedCommit,
      "rebuilt Vigil runtime"
    );

    const outputPath = join(repoRoot, "dist", "update-mac.noindex");
    await rm(outputPath, { recursive: true, force: true });
    await status("packaging", "Packaging a staged Vigil app");
    await run(process.execPath, [
      join(repoRoot, "scripts", "package-mac.mjs"),
      "dir",
      "-c.directories.output=dist/update-mac.noindex"
    ], { cwd: repoRoot, timeoutMs: APP_PACKAGE_TIMEOUT_MS });

    const builtAppPath = join(outputPath, "mac-universal", "Vigil.app");
    if (!(await pathExists(builtAppPath))) throw new Error(`Rebuilt Vigil app was not found at ${builtAppPath}`);
    await verifyBuildInfo(
      join(builtAppPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
      expectedCommit,
      "staged Vigil app"
    );
    return {
      sourceKind: "source",
      root,
      repoRoot,
      builtAppPath,
      builtRuntimePath: join(repoRoot, "dist", "runtime"),
      runtimeTreeSha256: null,
      candidateCdHash: null,
      expectedCommit,
      initialCommit,
      initialBranch
    };
  } catch (error) {
    await cleanupStagedBuild({
      sourceKind: "source",
      root,
      repoRoot,
      builtAppPath: "",
      builtRuntimePath: "",
      runtimeTreeSha256: null,
      candidateCdHash: null,
      expectedCommit,
      initialCommit,
      initialBranch
    });
    throw error;
  }
}

async function assertActiveCheckoutUnchanged(stagedBuild: StagedBuild, gitCommand = "git"): Promise<void> {
  const [head, branch, dirty] = await Promise.all([
    capture(gitCommand, ["rev-parse", "HEAD"], { cwd: options.repoRoot }),
    capture(gitCommand, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: options.repoRoot }),
    capture(gitCommand, ["status", "--porcelain=v1"], { cwd: options.repoRoot })
  ]);
  if (head.trim() !== stagedBuild.initialCommit
    || expectedBranchName(branch.trim()) !== stagedBuild.initialBranch
    || dirty.trim()) {
    throw new Error("Vigil source changed while the update was being prepared. Nothing was installed permanently.");
  }
}

async function assertSelectedSourceIdentity(): Promise<void> {
  const [head, branch] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], { cwd: options.repoRoot }),
    capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: options.repoRoot })
  ]);
  if (!selectedSourceIdentityMatches(
    options.expectedInitialCommit,
    options.expectedBranch,
    head.trim(),
    branch.trim()
  )) {
    throw new Error("Vigil source branch or HEAD changed after the update was selected. Nothing was staged or installed.");
  }
}

export function selectedSourceIdentityMatches(
  expectedCommit: string,
  expectedBranch: string,
  observedCommit: string,
  observedBranch: string
): boolean {
  return expectedCommit === observedCommit && expectedBranch === observedBranch;
}

function expectedBranchName(value: string): string | null {
  return value === "HEAD" ? null : value;
}

export async function atomicInstallBuiltApp(
  builtAppPath: string,
  appPath: string,
  cleanupPath: string,
  operations: AtomicInstallOperations = defaultInstallOperations
): Promise<AppInstallation> {
  if (resolve(builtAppPath) === resolve(appPath)) {
    throw new Error("The staged Vigil app must be separate from the installed app.");
  }
  await mkdir(dirname(appPath), { recursive: true });

  const nextAppPath = `${appPath}.vigil-next`;
  const previousAppPath = `${appPath}.vigil-previous`;
  const journalPath = `${appPath}.vigil-transaction.json`;
  await reconcileAtomicInstallResidue(appPath, nextAppPath, previousAppPath, journalPath, operations);
  const journal: AtomicInstallJournal = {
    version: 2,
    id: randomUUID(),
    targetPath: appPath,
    nextPath: nextAppPath,
    previousPath: previousAppPath,
    phase: "preparing",
    hadPrevious: false,
    updatedAt: new Date().toISOString()
  };
  const initialPresent = await operations.pathExists(appPath);
  journal.initialPresent = initialPresent;
  if (initialPresent) {
    const initialIdentity = await operations.identity(appPath);
    journal.initialDevice = initialIdentity.dev;
    journal.initialInode = initialIdentity.ino;
  }
  await writeAtomicInstallJournal(journalPath, journal);
  try {
    await operations.remove(nextAppPath);
    await operations.copy(builtAppPath, nextAppPath);
    const candidateIdentity = await operations.identity(nextAppPath);
    journal.candidateDevice = candidateIdentity.dev;
    journal.candidateInode = candidateIdentity.ino;
    await updateAtomicInstallJournal(journalPath, journal, "prepared");
    if (await operations.pathExists(appPath)) {
      journal.hadPrevious = true;
      if (operations.swap) {
        await updateAtomicInstallJournal(journalPath, journal, "swapping");
        await operations.swap(appPath, nextAppPath);
        await operations.move(nextAppPath, previousAppPath);
      } else {
        await updateAtomicInstallJournal(journalPath, journal, "backing-up");
        await operations.move(appPath, previousAppPath);
        await operations.move(nextAppPath, appPath);
      }
    } else {
      await operations.move(nextAppPath, appPath);
    }
    await updateAtomicInstallJournal(journalPath, journal, "installed");
  } catch (error) {
    try {
      if (journal.phase === "preparing"
        && !Number.isInteger(journal.candidateDevice)
        && !Number.isInteger(journal.candidateInode)) {
        if (await operations.pathExists(nextAppPath)) {
          const quarantinePath = `${nextAppPath}.${journal.id}.partial`;
          if (operations.quarantinePartial) {
            await operations.quarantinePartial(nextAppPath, quarantinePath);
          } else {
            await operations.remove(nextAppPath);
          }
        }
        await rm(journalPath, { force: true });
        await syncDirectory(dirname(journalPath));
        throw error;
      }
      await safeUpdateAtomicInstallJournal(journalPath, journal, "rolling-back");
      // A swap helper can complete the kernel exchange and still report an
      // error (for example if it exits before its success status is observed).
      // Re-read the pinned candidate/initial inode topology from the durable
      // journal instead of trusting an in-memory `swapped` boolean.
      await reconcileAtomicInstallResidue(appPath, nextAppPath, previousAppPath, journalPath, operations);
    } catch (recoveryError) {
      if (recoveryError === error) throw error;
      throw new Error(`${errorMessage(error)} Automatic app replacement recovery also failed: ${errorMessage(recoveryError)}`);
    }
    throw error;
  }

  let settled = false;
  let verified = false;
  let attachedStateSnapshot: UpdateStateSnapshot | null = null;
  return {
    async attachStateSnapshot(snapshot) {
      if (settled || verified) {
        throw new Error("Vigil cannot attach rollback state after the replacement transaction is settled.");
      }
      journal.stateDataDir = snapshot.dataDir;
      journal.stateSnapshotRoot = snapshot.snapshotRoot;
      await writeAtomicInstallJournal(journalPath, journal);
      attachedStateSnapshot = snapshot;
    },
    async markVerified() {
      if (settled || verified) return;
      await assertVerifiedAtomicInstallTopology(appPath, nextAppPath, previousAppPath, journal, operations);
      await updateAtomicInstallJournal(journalPath, journal, "verified");
      verified = true;
    },
    async finalize() {
      if (settled) return;
      if (!verified) throw new Error("Vigil cannot discard its recovery copy before the replacement is verified.");
      await assertVerifiedAtomicInstallTopology(appPath, nextAppPath, previousAppPath, journal, operations);
      await updateAtomicInstallJournal(journalPath, journal, "finalizing");
      await assertVerifiedAtomicInstallTopology(appPath, nextAppPath, previousAppPath, journal, operations);
      await operations.remove(previousAppPath);
      await assertJournalCandidateAtTarget(appPath, journal, operations);
      await assertJournalSidecarPinned(nextAppPath, journal, operations);
      await operations.remove(nextAppPath);
      await assertJournalCandidateAtTarget(appPath, journal, operations);
      if (cleanupPath) await operations.remove(cleanupPath);
      await rm(journalPath, { force: true });
      settled = true;
    },
    async rollback() {
      if (settled) return;
      if (verified) throw new Error("Vigil will not roll back a replacement after it was durably marked verified.");
      await safeUpdateAtomicInstallJournal(journalPath, journal, "rolling-back");
      await attachedStateSnapshot?.restore();
      await reconcileAtomicInstallResidue(appPath, nextAppPath, previousAppPath, journalPath, operations);
      if (cleanupPath) await operations.remove(cleanupPath);
      await attachedStateSnapshot?.finalize();
      settled = true;
    }
  };
}

/**
 * Reconcile a replacement interrupted by process death or power loss. A
 * present canonical path is not proof of success: before `verified`, it may be
 * the candidate that failed its health check. Recovery therefore follows the
 * fsynced journal and the copied candidate's inode identity, and never discards
 * an ambiguous recovery copy.
 */
export async function reconcileAtomicInstallResidue(
  appPath: string,
  nextAppPath = `${appPath}.vigil-next`,
  previousAppPath = `${appPath}.vigil-previous`,
  journalPath = `${appPath}.vigil-transaction.json`,
  operations: AtomicInstallOperations = defaultInstallOperations
): Promise<void> {
  const journal = await readAtomicInstallJournal(journalPath, appPath, nextAppPath, previousAppPath);
  const targetExists = await operations.pathExists(appPath);
  const previousExists = await operations.pathExists(previousAppPath);
  const nextExists = await operations.pathExists(nextAppPath);

  if (!journal) {
    if (previousExists || nextExists) {
      throw new Error(`Vigil found replacement residue for ${appPath} without a trustworthy transaction journal.`);
    }
    return;
  }

  if (journal.phase === "preparing" && !previousExists) {
    const initialMatches = journal.initialPresent === false
      ? !targetExists
      : journal.initialPresent === true
        && targetExists
        && await pathMatchesJournalInitial(appPath, journal, operations) === true;
    if (initialMatches) {
      if (nextExists) {
        if (operations.quarantinePartial) {
          await operations.quarantinePartial(nextAppPath, `${nextAppPath}.${journal.id}.partial`);
        } else {
          await operations.remove(nextAppPath);
        }
      }
      await rm(journalPath, { force: true });
      await syncDirectory(dirname(journalPath));
      return;
    }
  }

  if (journal.phase === "verified" || journal.phase === "finalizing") {
    await assertVerifiedAtomicInstallSidecars(nextAppPath, previousAppPath, journal, operations);
    if (!targetExists) {
      if (nextExists && await pathMatchesJournalCandidate(nextAppPath, journal, operations) === true) {
        await operations.move(nextAppPath, appPath);
      } else {
        // Verification belongs to the candidate generation. Restoring an old
        // previous copy under a verified journal would silently promote the
        // wrong bytes, so preserve every generation for explicit recovery.
        throw new Error(`Vigil's verified candidate is missing at ${appPath}; its recovery evidence was preserved.`);
      }
    }
    await assertVerifiedAtomicInstallTopology(appPath, nextAppPath, previousAppPath, journal, operations);
    await operations.remove(previousAppPath);
    await assertJournalCandidateAtTarget(appPath, journal, operations);
    await assertJournalSidecarPinned(nextAppPath, journal, operations);
    await operations.remove(nextAppPath);
    await assertJournalCandidateAtTarget(appPath, journal, operations);
    await rm(journalPath, { force: true });
    return;
  }

  if (previousExists) {
    if (nextExists) await assertJournalSidecarPinned(nextAppPath, journal, operations);
    const previousGeneration = await classifyJournalGeneration(previousAppPath, journal, operations);
    if (previousGeneration !== "candidate" && previousGeneration !== "initial") {
      throw new Error(`Vigil refused to use an unrecognized replacement sidecar at ${previousAppPath}; recovery evidence was preserved.`);
    }
    if (targetExists) {
      const targetGeneration = await classifyJournalGeneration(appPath, journal, operations);
      if (targetGeneration === "candidate" && previousGeneration === "initial") {
        if (operations.swap) {
          await operations.swap(appPath, previousAppPath);
          await operations.remove(previousAppPath);
        } else {
          await operations.remove(appPath);
          await operations.move(previousAppPath, appPath);
        }
      } else if (previousGeneration === "candidate" && targetGeneration === "initial") {
        // A prior rollback already swapped the known-good generation back into
        // place and then lost power before deleting the displaced candidate.
        // Cleanup must be idempotent: never swap that candidate into service.
        await operations.remove(previousAppPath);
      } else {
        throw new Error(`Vigil cannot identify the interrupted candidate for ${appPath}; its recovery copies were preserved.`);
      }
    } else {
      if (previousGeneration !== "initial") {
        throw new Error(`Vigil cannot prove the recovery copy at ${previousAppPath} is the original generation; recovery evidence was preserved.`);
      }
      await operations.move(previousAppPath, appPath);
    }
    if (nextExists) await operations.remove(nextAppPath);
    await rm(journalPath, { force: true });
    return;
  }

  if (targetExists && nextExists) {
    const [targetGeneration, nextGeneration] = await Promise.all([
      classifyJournalGeneration(appPath, journal, operations),
      classifyJournalGeneration(nextAppPath, journal, operations)
    ]);
    if (nextGeneration === "candidate" && targetGeneration === "initial") {
      await operations.remove(nextAppPath);
    } else if (targetGeneration === "candidate" && nextGeneration === "initial") {
      if (operations.swap) {
        await operations.swap(appPath, nextAppPath);
        await operations.remove(nextAppPath);
      } else {
        const displacedCandidate = `${nextAppPath}.${journal.id}.failed`;
        await operations.move(appPath, displacedCandidate);
        try {
          await operations.move(nextAppPath, appPath);
        } catch (error) {
          await operations.move(displacedCandidate, appPath).catch(() => undefined);
          throw error;
        }
        await operations.remove(displacedCandidate);
      }
    } else {
      throw new Error(`Vigil cannot identify the interrupted candidate for ${appPath}; its recovery copies were preserved.`);
    }
    await rm(journalPath, { force: true });
    return;
  }

  if (targetExists) {
    const targetGeneration = await classifyJournalGeneration(appPath, journal, operations);
    if (targetGeneration === "candidate") {
      if (journal.initialPresent !== false || journal.hadPrevious) {
        throw new Error(`Vigil's previous recovery copy is missing for the unverified replacement at ${appPath}.`);
      }
      await operations.remove(appPath);
    } else if (targetGeneration !== "initial") {
      throw new Error(`Vigil cannot prove that the canonical copy at ${appPath} is the exact initial generation; recovery evidence was preserved.`);
    }
    await rm(journalPath, { force: true });
    return;
  }

  if (nextExists) {
    const nextGeneration = await classifyJournalGeneration(nextAppPath, journal, operations);
    if (journal.hadPrevious || journal.initialPresent === true) {
      throw new Error(`Vigil's canonical and previous copies are missing for the interrupted replacement at ${appPath}.`);
    }
    if (nextGeneration !== "candidate") {
      throw new Error(`Vigil cannot identify the remaining replacement copy for ${appPath}.`);
    }
    await operations.remove(nextAppPath);
  }
  if (journal.initialPresent === true) {
    throw new Error(`Vigil's initial generation is missing for the interrupted replacement at ${appPath}; recovery evidence was preserved.`);
  }
  await rm(journalPath, { force: true });
}

async function pathMatchesJournalCandidate(
  path: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<boolean> {
  return await classifyJournalGeneration(path, journal, operations) === "candidate";
}

async function assertJournalCandidateAtTarget(
  appPath: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<void> {
  const matches = await pathMatchesJournalCandidate(appPath, journal, operations);
  if (matches !== true) {
    throw new Error(`Vigil refused to commit a replacement whose exact canonical candidate could not be proved at ${appPath}; recovery evidence was preserved.`);
  }
}

async function assertJournalSidecarPinned(
  path: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<void> {
  if (!await operations.pathExists(path)) return;
  const generation = await classifyJournalGeneration(path, journal, operations);
  if (generation !== "candidate" && generation !== "initial") {
    throw new Error(`Vigil refused to discard an unrecognized replacement sidecar at ${path}; recovery evidence was preserved.`);
  }
}

async function assertVerifiedAtomicInstallSidecars(
  nextAppPath: string,
  previousAppPath: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<void> {
  await assertJournalSidecarPinned(previousAppPath, journal, operations);
  await assertJournalSidecarPinned(nextAppPath, journal, operations);
}

async function assertVerifiedAtomicInstallTopology(
  appPath: string,
  nextAppPath: string,
  previousAppPath: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<void> {
  await assertJournalCandidateAtTarget(appPath, journal, operations);
  await assertVerifiedAtomicInstallSidecars(nextAppPath, previousAppPath, journal, operations);
}

async function pathMatchesJournalInitial(
  path: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<boolean> {
  return await classifyJournalGeneration(path, journal, operations) === "initial";
}

type JournalGeneration = "candidate" | "initial" | "ambiguous" | "unrecognized";

async function classifyJournalGeneration(
  path: string,
  journal: AtomicInstallJournal,
  operations: AtomicInstallOperations
): Promise<JournalGeneration> {
  try {
    const identity = await operations.identity(path);
    const candidate = identity.dev === journal.candidateDevice && identity.ino === journal.candidateInode;
    const initial = journal.initialPresent === true
      && identity.dev === journal.initialDevice
      && identity.ino === journal.initialInode;
    if (candidate && initial) return "ambiguous";
    if (candidate) return "candidate";
    if (initial) return "initial";
    return "unrecognized";
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return "unrecognized";
    throw error;
  }
}

async function readAtomicInstallJournal(
  path: string,
  appPath: string,
  nextAppPath: string,
  previousAppPath: string
): Promise<AtomicInstallJournal | null> {
  if (!(await pathExists(path))) return null;
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<AtomicInstallJournal>;
    if (
      value.version === 2
      && typeof value.id === "string"
      && value.id.length > 0
      && value.targetPath === appPath
      && value.nextPath === nextAppPath
      && value.previousPath === previousAppPath
      && typeof value.phase === "string"
      && ["preparing", "prepared", "swapping", "backing-up", "installed", "verified", "rolling-back", "finalizing"].includes(value.phase)
      && typeof value.hadPrevious === "boolean"
      && validAtomicInstallJournalIdentityShape(value)
      && typeof value.updatedAt === "string"
    ) return value as AtomicInstallJournal;
  } catch {
    // Archive malformed transaction evidence below.
  }
  const archivePath = `${path}.invalid.${Date.now()}.${randomUUID()}`;
  await rename(path, archivePath);
  throw new Error(`Vigil found an invalid replacement journal for ${appPath}; recovery evidence was preserved at ${archivePath}.`);
}

function validAtomicInstallJournalIdentityShape(value: Partial<AtomicInstallJournal>): boolean {
  const candidateComplete = validFileIdentity(value.candidateDevice, value.candidateInode);
  const candidateAbsent = value.candidateDevice === undefined && value.candidateInode === undefined;
  if (!candidateComplete && !(value.phase === "preparing" && candidateAbsent)) return false;
  if (typeof value.initialPresent !== "boolean") return false;
  const initialComplete = validFileIdentity(value.initialDevice, value.initialInode);
  const initialAbsent = (value.initialDevice === undefined || value.initialDevice === null)
    && (value.initialInode === undefined || value.initialInode === null);
  if (value.initialPresent ? !initialComplete : !initialAbsent) return false;
  if (value.hadPrevious && !value.initialPresent) return false;
  return !candidateComplete
    || !initialComplete
    || value.candidateDevice !== value.initialDevice
    || value.candidateInode !== value.initialInode;
}

function validFileIdentity(dev: unknown, ino: unknown): boolean {
  return Number.isInteger(dev) && Number(dev) >= 0 && Number.isInteger(ino) && Number(ino) > 0;
}

async function writeAtomicInstallJournal(path: string, journal: AtomicInstallJournal): Promise<void> {
  const temporaryPath = `${path}.${journal.id}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await syncDirectory(dirname(path));
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function updateAtomicInstallJournal(
  path: string,
  journal: AtomicInstallJournal,
  phase: AtomicInstallJournal["phase"]
): Promise<void> {
  journal.phase = phase;
  journal.updatedAt = new Date().toISOString();
  await writeAtomicInstallJournal(path, journal);
}

async function safeUpdateAtomicInstallJournal(
  path: string,
  journal: AtomicInstallJournal,
  phase: AtomicInstallJournal["phase"]
): Promise<void> {
  try {
    await updateAtomicInstallJournal(path, journal, phase);
  } catch {
    // Recovery/finalization must continue even when diagnostic journal storage
    // itself is unavailable. The path topology remains self-reconciling.
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isErrorCode(error, "EINVAL") && !isErrorCode(error, "ENOTSUP") && !isErrorCode(error, "EISDIR")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const defaultInstallOperations: AtomicInstallOperations = {
  pathExists,
  async copy(source, destination) {
    await cp(source, destination, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
  },
  async move(source, destination) {
    await rename(source, destination);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  },
  async identity(path) {
    const value = await lstat(path);
    return { dev: value.dev, ino: value.ino };
  },
  async quarantinePartial(path, quarantinePath) {
    await rename(path, quarantinePath);
  },
  async swap(left, right) {
    await atomicSwap(left, right);
  }
};

async function atomicSwap(left: string, right: string): Promise<void> {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vigil-atomic-swap");
  const helperStat = await lstat(helperPath);
  if (!helperStat.isFile() || helperStat.isSymbolicLink() || (helperStat.mode & 0o111) === 0) {
    throw new Error("Vigil's atomic app-swap helper is missing or unsafe.");
  }
  await new Promise<void>((resolveSwap, rejectSwap) => {
    const child = spawn(helperPath, [left, right], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", rejectSwap);
    child.once("close", (code) => {
      if (code === 0) resolveSwap();
      else rejectSwap(new Error(stderr.trim() || `Vigil's atomic app-swap helper exited with status ${code}.`));
    });
  });
}

const UPDATE_STATE_FILES = [
  "state.json",
  "state.seal.json",
  "state-seal.key",
  "usage.json",
  "usage.seal.json",
  "runtime-snapshot.wal.json",
  "runtime-effects.json",
  "runtime-usage.checkpoint.json",
  "runtime-interruption.json",
  "journal-encryption.key"
] as const;

export async function snapshotUpdateState(dataDir: string, snapshotParent: string): Promise<UpdateStateSnapshot> {
  const snapshotRoot = await mkdtemp(join(snapshotParent, "state-before-update-"));
  const present = new Set<string>();
  try {
    for (const name of UPDATE_STATE_FILES) {
      const source = join(dataDir, name);
      if (!(await pathExists(source))) continue;
      const sourceStat = await lstat(source);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        throw new Error(`Vigil refused to snapshot unsafe update state at ${source}.`);
      }
      const destination = join(snapshotRoot, name);
      await cp(source, destination, { preserveTimestamps: true });
      await syncFile(destination);
      present.add(name);
    }
    await syncDirectory(snapshotRoot);
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }

  let settled = false;
  let restored = false;
  const restore = async () => {
    if (settled || restored) return;
    await mkdir(dataDir, { recursive: true });
    for (const name of UPDATE_STATE_FILES) {
      const destination = join(dataDir, name);
      if (!present.has(name)) {
        await rm(destination, { force: true });
        await syncDirectory(dataDir);
        continue;
      }
      const temporary = `${destination}.${process.pid}.rollback`;
      await rm(temporary, { force: true });
      await cp(join(snapshotRoot, name), temporary, { preserveTimestamps: true });
      await syncFile(temporary);
      await rename(temporary, destination);
      await syncDirectory(dataDir);
    }
    restored = true;
  };
  return {
    dataDir,
    snapshotRoot,
    restore,
    async attachStateSnapshot() {
      // A state snapshot is itself the recovery payload and has nothing to
      // attach to another state snapshot.
    },
    async markVerified() {
      // The snapshot remains available until the whole replacement is
      // finalized. Marking the app verified merely makes rollback ineligible.
    },
    async finalize() {
      if (settled) return;
      await rm(snapshotRoot, { recursive: true, force: true });
      settled = true;
    },
    async rollback() {
      if (settled) return;
      await restore();
      settled = true;
      await rm(snapshotRoot, { recursive: true, force: true }).catch(() => {});
    }
  };
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function finalizeLegacyLaunchAgentRetirement(recovery: LaunchAgentRecovery): Promise<string | null> {
  try {
    await rm(recovery.plistPath, { force: true });
    return null;
  } catch (error) {
    return `Could not remove the retired legacy LaunchAgent plist. ${errorMessage(error)}`;
  }
}

async function verifyInstalledAppBuild(expectedCommit: string): Promise<void> {
  await verifyBuildInfo(
    join(options.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
    expectedCommit,
    "installed Vigil app"
  );
}

export async function verifyBuildInfo(path: string, expectedCommit: string, label = "Vigil build"): Promise<void> {
  let buildInfo: { commit?: unknown; dirty?: unknown };
  try {
    buildInfo = JSON.parse(await readFile(path, "utf8")) as { commit?: unknown; dirty?: unknown };
  } catch {
    throw new Error(`The ${label} is missing valid build metadata.`);
  }
  if (buildInfo.commit !== expectedCommit || buildInfo.dirty !== false) {
    throw new Error(`The ${label} does not match the verified source commit.`);
  }
}

async function assertLocallyRebuildableApp(): Promise<void> {
  if (!(await pathExists(options.appPath))) return;
  const identity = await run("/usr/bin/codesign", ["-dv", "--verbose=4", options.appPath], {
    allowFailure: true,
    capture: true
  });
  const detail = `${identity.stdout}\n${identity.stderr}`;
  if (!identity.ok && /code object is not signed at all/iu.test(detail)) return;
  if (!identity.ok) {
    throw new Error(
      `Vigil could not inspect the installed app signature, so the update was stopped: ${
        identity.stderr || identity.stdout || "codesign returned no details"
      }`
    );
  }
  const verification = await run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", options.appPath],
    {
      allowFailure: true,
      capture: true
    }
  );
  if (!verification.ok) {
    throw new Error(
      `The installed Vigil app failed strict code-signature verification: ${
        verification.stderr || verification.stdout || "codesign returned no details"
      }`
    );
  }
  if (!isLocallyRebuildableSignature(detail)) {
    throw new Error("This Vigil app has a distribution signature. Install a complete signed release instead of rebuilding it in place.");
  }
}

async function stopLaunchAgentForStateTransition(preserved: LaunchAgentRecovery | null = null): Promise<LaunchAgentRecovery> {
  const recovery = preserved || await captureLaunchAgentRecovery();
  for (const args of [
    ["bootout", `gui/${recovery.uid}/com.vigil.agent`],
    ["bootout", `gui/${recovery.uid}`, recovery.plistPath]
  ]) {
    await run("/bin/launchctl", args, {
      allowFailure: true,
      capture: true,
      ignoreInterruption: true
    });
  }
  const stillLoaded = await run("/bin/launchctl", ["print", `gui/${recovery.uid}/com.vigil.agent`], {
    allowFailure: true,
    capture: true,
    ignoreInterruption: true
  });
  if (stillLoaded.ok) throw new Error("The Vigil background service remained loaded during the state transition.");
  if (!launchctlServiceMissingDetail(stillLoaded.stderr)) {
    throw new Error(`Vigil could not verify that its background service stopped: ${stillLoaded.stderr || "launchctl failed"}`);
  }
  await waitForBackendStopped(recovery.context);
  return recovery;
}

async function captureLaunchAgentRecovery(): Promise<LaunchAgentRecovery> {
  const home = process.env.HOME;
  const uid = process.getuid?.();
  if (!home || uid === undefined) throw new Error("Vigil could not identify the current user to stop its background service.");
  const plistPath = join(home, "Library", "LaunchAgents", "com.vigil.agent.plist");
  const [plist, plistStat] = await Promise.all([
    readFile(plistPath, "utf8"),
    lstat(plistPath)
  ]);
  if (!plistStat.isFile() || plistStat.isSymbolicLink() || plistStat.uid !== uid) {
    throw new Error("The loaded Vigil background service has an unsafe recovery plist.");
  }
  const context = await backendHealthContext(plist);
  return { context, plist, plistMode: plistStat.mode & 0o777, plistPath, uid };
}

async function captureLoadedLaunchAgentRecovery(): Promise<LaunchAgentRecovery | null> {
  const home = process.env.HOME;
  const uid = process.getuid?.();
  if (!home || uid === undefined) throw new Error("Vigil could not identify the current user's background service.");
  const plistPath = join(home, "Library", "LaunchAgents", "com.vigil.agent.plist");
  const loaded = await run("/bin/launchctl", ["print", `gui/${uid}/com.vigil.agent`], {
    allowFailure: true,
    capture: true
  });
  if (!loaded.ok) {
    if (launchctlServiceMissingDetail(loaded.stderr)) return null;
    throw new Error(`Vigil could not verify its legacy background service: ${loaded.stderr || "launchctl failed"}`);
  }
  if (!(await pathExists(plistPath))) {
    throw new Error("The loaded Vigil background service has no recovery plist.");
  }
  return await captureLaunchAgentRecovery();
}

function launchctlServiceMissingDetail(detail: string): boolean {
  return /could not find service|service not found|no such process/iu.test(detail);
}

async function startLaunchAgentAfterStateTransition(recovery: LaunchAgentRecovery): Promise<void> {
  const restartedAfter = Date.now();
  await mkdir(dirname(recovery.plistPath), { recursive: true });
  await writeFile(recovery.plistPath, recovery.plist, { mode: recovery.plistMode });
  await run("/bin/launchctl", ["enable", `gui/${recovery.uid}/com.vigil.agent`], {
    ignoreInterruption: true
  });
  await run("/bin/launchctl", ["bootstrap", `gui/${recovery.uid}`, recovery.plistPath], {
    ignoreInterruption: true
  });
  await run("/bin/launchctl", ["kickstart", "-k", `gui/${recovery.uid}/com.vigil.agent`], {
    ignoreInterruption: true
  });
  await waitForLaunchAgent(restartedAfter, recovery.context);
}

async function waitForBackendStopped(context: BackendHealthContext): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await backendIsHealthy(context))) return;
    await delay(100);
  }
  throw new Error("The Vigil background service did not stop for the state transition.");
}

async function replacementDataDir(launchAgentWasLoaded: boolean, preservedLaunchAgentPlist = ""): Promise<string> {
  if (process.env.VIGIL_DATA_DIR) return process.env.VIGIL_DATA_DIR;
  const home = process.env.HOME;
  if (!home) throw new Error("Vigil could not identify its data directory for update recovery.");
  if (!launchAgentWasLoaded) return join(home, "Library", "Application Support", "Vigil");
  const plistPath = join(home, "Library", "LaunchAgents", "com.vigil.agent.plist");
  const plist = preservedLaunchAgentPlist || await readFile(plistPath, "utf8");
  const dataDir = plistStringForKey(plist, "VIGIL_DATA_DIR");
  if (!dataDir) throw new Error("The Vigil LaunchAgent data directory could not be verified for update recovery.");
  return dataDir;
}

async function backendHealthContext(plist: string): Promise<BackendHealthContext> {
  const configuredPort = process.env.VIGIL_PORT
    || plistStringForKey(plist, "VIGIL_PORT")
    || "8787";
  const port = validPort(configuredPort);
  const dataDir = process.env.VIGIL_DATA_DIR || plistStringForKey(plist, "VIGIL_DATA_DIR");
  if (!dataDir) throw new Error("The Vigil LaunchAgent data directory could not be verified.");
  return { port, instanceSecret: await getInstanceSecret(dataDir) };
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Vigil has an invalid server port.");
  return port;
}

async function waitForLaunchAgent(restartedAfter: number, context: BackendHealthContext): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const health = await fetchVigilStateHealth(`http://127.0.0.1:${context.port}/api/state`, {
        signal: controller.signal,
        expectedPort: context.port,
        instanceSecret: context.instanceSecret
      });
      const body = health.ok && "body" in health ? health.body as { app?: { startedAt?: unknown } } : null;
      const startedAt = Date.parse(String(body?.app?.startedAt || ""));
      if (Number.isFinite(startedAt) && startedAt >= restartedAfter) return;
    } catch {
      // Retried until the bounded deadline.
    } finally {
      clearTimeout(timeout);
    }
    await delay(500);
  }
  throw new Error("The updated Vigil background service did not become healthy in time.");
}

async function openAndVerifyReplacement(
  dataDir: string,
  preservedContext?: BackendHealthContext
): Promise<void> {
  await openAndVerifyInstalledApp(
    dataDir,
    "The rebuilt Vigil app or its private enforcement runtime did not remain healthy after launch.",
    preservedContext
  );
}

async function openAndVerifyRecoveredApp(
  dataDir: string,
  preservedContext?: BackendHealthContext
): Promise<void> {
  await openAndVerifyInstalledApp(
    dataDir,
    "The restored Vigil app or its private enforcement runtime did not remain healthy after recovery.",
    preservedContext
  );
}

async function openAndVerifyInstalledApp(
  dataDir: string,
  failureMessage: string,
  preservedContext?: BackendHealthContext
): Promise<void> {
  const launchedAfter = Date.now() - 2_000;
  const healthContext = preservedContext || {
    port: validPort(process.env.VIGIL_PORT || "8787"),
    instanceSecret: await getInstanceSecret(dataDir)
  };
  const executablePath = join(options.appPath, "Contents", "MacOS", basename(options.appPath, ".app"));
  await openAppInBackground();
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let healthySince = 0;
  while (Date.now() < deadline) {
    const [pids, ready, signedHealthy] = await Promise.all([
      installedAppProcessIds(),
      liveRuntimeReady(dataDir, launchedAfter),
      backendIsHealthy(healthContext)
    ]);
    if (ready
      && ready.transport === "in-app"
      && ready.appPath === executablePath
      && pids.includes(ready.pid)
      && signedHealthy) {
      if (!healthySince) healthySince = Date.now();
      if (Date.now() - healthySince >= 1_500) return;
    } else {
      healthySince = 0;
    }
    await delay(500);
  }
  throw new Error(failureMessage);
}

async function openAppInBackground(): Promise<void> {
  await run("/usr/bin/open", ["-g", options.appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG]);
}

async function backendIsHealthy(context: BackendHealthContext): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const health = await fetchVigilStateHealth(`http://127.0.0.1:${context.port}/api/health`, {
      signal: controller.signal,
      expectedPort: context.port,
      instanceSecret: context.instanceSecret
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function installedAppProcessIds(): Promise<number[]> {
  const executableName = basename(options.appPath, ".app");
  const executablePath = join(options.appPath, "Contents", "MacOS", executableName);
  const processes = await capture("/bin/ps", ["-axo", "pid=,command="], { cwd: dirname(options.appPath) });
  const pids: number[] = [];
  for (const line of processes.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match) continue;
    const command = match[2];
    if (command !== executablePath && !command.startsWith(`${executablePath} `)) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function terminateInstalledApp(): Promise<void> {
  const pids = await installedAppProcessIds();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!isErrorCode(error, "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await installedAppProcessIds()).length) return;
    await delay(100);
  }
  throw new Error("The rebuilt Vigil app did not stop for rollback.");
}

async function cleanupStagedBuild(stagedBuild: StagedBuild): Promise<void> {
  if (stagedBuild.sourceKind === "prebuilt") {
    await cleanupDownloadedPrebuiltRelease(stagedBuild.root, dirname(options.statusPath));
    return;
  }
  if (await pathExists(stagedBuild.repoRoot)) {
    try {
      await run("git", ["worktree", "remove", "--force", stagedBuild.repoRoot], {
        allowFailure: true,
        cwd: options.repoRoot,
        ignoreInterruption: true
      });
    } catch {
      // The temporary directory removal below is still safe.
    }
  }
  await rm(stagedBuild.root, { recursive: true, force: true });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    if (interrupted) throw new Error("Vigil update was interrupted.");
    await delay(500);
  }
  throw new Error("Vigil did not quit in time.");
}

async function parentExitedSoon(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(100);
  }
  return !processExists(pid);
}

async function activeHeadMatches(expectedCommit: string, gitCommand = "git"): Promise<boolean> {
  try {
    const result = await run(gitCommand, ["rev-parse", "HEAD"], {
      allowFailure: true,
      capture: true,
      cwd: options.repoRoot,
      ignoreInterruption: true
    });
    return result.ok && result.stdout.trim() === expectedCommit;
  } catch {
    return false;
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

async function assertOwnedUpdaterLock(): Promise<void> {
  const deadline = Date.now() + UPDATER_LOCK_HANDOFF_TIMEOUT_MS;
  do {
    try {
      const payload = JSON.parse(await readFile(options.lockPath, "utf8")) as { token?: unknown; pid?: unknown };
      if (payload.token === options.lockToken && payload.pid === process.pid) return;
    } catch {
      // The controller may still be atomically transferring the lock payload.
    }
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error("Vigil updater lock ownership could not be verified after startup handoff.");
}

async function releaseOwnedUpdaterLock(): Promise<void> {
  try {
    const payload = JSON.parse(await readFile(options.lockPath, "utf8")) as { token?: unknown };
    if (payload.token === options.lockToken) await rm(options.lockPath, { force: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) log?.write(`Could not release updater lock: ${errorMessage(error)}\n`);
  }
}

function installSignalHandlers(): void {
  const interrupt = () => {
    interrupted = true;
    if (activeChild?.pid) stopChild(activeChild.pid, "SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
}

async function capture(
  command: string,
  args: string[],
  runOptions: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const result = await run(command, args, { ...runOptions, capture: true });
  return result.stdout;
}

async function run(
  command: string,
  args: string[],
  optionsForRun: {
    allowFailure?: boolean;
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ignoreInterruption?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (interrupted && !optionsForRun.ignoreInterruption) throw new Error("Vigil update was interrupted.");
  // This module is also imported by the live app for read-only installed
  // topology preflight, before the direct updater CLI has parsed `options`.
  // Keep those library calls independent of the CLI-only global while
  // preserving the selected repository root once a packaged update is running.
  const cwd = optionsForRun.cwd || options?.repoRoot || process.cwd();
  const executable = command === "git" ? await gitExecutable(cwd) : command;
  return await new Promise((resolveRun, rejectRun) => {
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let killConfirmationReached = false;
    let terminationGrace: ReturnType<typeof setTimeout> | null = null;
    let killConfirmation: ReturnType<typeof setTimeout> | null = null;
    let terminationPoll: ReturnType<typeof setInterval> | null = null;
    const child = spawn(executable, args, {
      cwd,
      env: optionsForRun.env || process.env,
      detached: Boolean(optionsForRun.timeoutMs),
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    const clearLifecycleTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      if (killConfirmation) clearTimeout(killConfirmation);
      if (terminationPoll) clearInterval(terminationPoll);
    };
    const finishTimedOutCommand = () => {
      if (settled) return;
      settled = true;
      activeChild = null;
      clearLifecycleTimers();
      if (optionsForRun.allowFailure) {
        resolveRun({ ok: false, stdout: optionsForRun.capture ? stdout : "", stderr: "Command timed out" });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} timed out after ${optionsForRun.timeoutMs}ms`));
      }
    };
    const finishWithError = (error: unknown) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      clearLifecycleTimers();
      rejectRun(error);
    };
    const finishWithExit = (code: number | null) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      clearLifecycleTimers();
      if (interrupted && !optionsForRun.ignoreInterruption) {
        rejectRun(new Error("Vigil update was interrupted."));
      } else if (code === 0 || optionsForRun.allowFailure) {
        resolveRun({ ok: code === 0, stdout: optionsForRun.capture ? stdout : "", stderr: optionsForRun.capture ? stderr : "" });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    };
    const processGroupStillExists = () => commandProcessGroupExists(child.pid);
    const finishTimedOutCommandWhenStopped = () => {
      if (!timedOut || settled || processGroupStillExists()) return;
      if (childClosed || killConfirmationReached) finishTimedOutCommand();
    };
    const waitForKillConfirmation = () => {
      killConfirmation = setTimeout(() => {
        if (settled) return;
        killConfirmationReached = true;
        if (!processGroupStillExists()) {
          finishTimedOutCommand();
          return;
        }
        // Do not release the update lock while a timed-out child can still
        // mutate the source or staged artifacts. Retry until SIGKILL is observed.
        stopChild(child.pid, "SIGKILL");
        waitForKillConfirmation();
      }, COMMAND_KILL_CONFIRMATION_MS);
    };
    const timeout = optionsForRun.timeoutMs ? setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log.write(`${command} ${args.join(" ")} timed out after ${optionsForRun.timeoutMs}ms; terminating its process group.\n`);
      stopChild(child.pid, "SIGTERM");
      terminationPoll = setInterval(finishTimedOutCommandWhenStopped, COMMAND_TERMINATION_POLL_MS);
      terminationGrace = setTimeout(() => {
        if (settled) return;
        if (!processGroupStillExists()) {
          finishTimedOutCommandWhenStopped();
          if (!settled) waitForKillConfirmation();
          return;
        }
        stopChild(child.pid, "SIGKILL");
        waitForKillConfirmation();
      }, COMMAND_TERMINATION_GRACE_MS);
    }, optionsForRun.timeoutMs) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      log.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      if (timedOut) {
        childClosed = true;
        finishTimedOutCommandWhenStopped();
        return;
      }
      finishWithError(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      childClosed = true;
      if (timedOut) {
        finishTimedOutCommandWhenStopped();
        return;
      }
      finishWithExit(code);
    });
  });
}

function npmExecutable(): string {
  const command = process.env.VIGIL_UPDATE_NPM_PATH || "npm";
  if (command !== "npm" && resolve(command) !== command) {
    throw new Error("Vigil updater received an invalid npm executable path.");
  }
  return command;
}

function stopChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

function commandProcessGroupExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

async function safeStatus(phase: UpdateReceiptPhase, message: string, extra: Omit<UpdateReceiptPatch, "phase">): Promise<void> {
  try {
    await status(phase, message, extra);
  } catch (error) {
    log?.write(`Could not persist updater status: ${errorMessage(error)}\n`);
  }
}

async function status(
  phase: UpdateReceiptPhase,
  message: string,
  extra: Omit<UpdateReceiptPatch, "phase"> = {}
): Promise<void> {
  const now = new Date().toISOString();
  log.write(`[${now}] ${phase}: ${message}\n`);
  await mergeWriteUpdateReceipt(options.statusPath, options.lockToken, {
    phase,
    message,
    updatedAt: now,
    ...extra
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(args: string[]): Options {
  const optionsMap = new Map<string, string>();
  let restart = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--restart") {
      restart = true;
      continue;
    }
    if (arg.startsWith("--")) {
      optionsMap.set(arg.slice(2), args[index + 1] || "");
      index += 1;
    }
  }
  const parentPid = Number(required(optionsMap, "parent-pid"));
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid must be a positive process ID");
  const prebuiltValues = {
    root: optionsMap.get("prebuilt-root") || "",
    manifestPath: optionsMap.get("prebuilt-manifest-path") || "",
    stagedAppPath: optionsMap.get("prebuilt-app-path") || "",
    candidateCdHash: optionsMap.get("prebuilt-cdhash") || ""
  };
  const prebuiltValueCount = Object.values(prebuiltValues).filter(Boolean).length;
  if (prebuiltValueCount !== 0 && prebuiltValueCount !== Object.keys(prebuiltValues).length) {
    throw new Error("The prebuilt release arguments must be supplied as one complete identity set.");
  }
  if (prebuiltValueCount > 0 && !/^[a-f0-9]{40,64}$/u.test(prebuiltValues.candidateCdHash)) {
    throw new Error("--prebuilt-cdhash must be a valid CodeDirectory hash.");
  }
  return {
    repoRoot: required(optionsMap, "repo-root"),
    appPath: required(optionsMap, "app-path"),
    parentPid,
    userDataDir: required(optionsMap, "user-data-dir"),
    statusPath: required(optionsMap, "status-path"),
    logPath: required(optionsMap, "log-path"),
    lockPath: required(optionsMap, "lock-path"),
    lockToken: required(optionsMap, "lock-token"),
    expectedInitialCommit: required(optionsMap, "expected-initial-commit"),
    expectedBranch: required(optionsMap, "expected-branch"),
    expectedCommit: required(optionsMap, "expected-commit"),
    prebuiltRelease: prebuiltValueCount > 0 ? prebuiltValues : null,
    restart
  };
}

function required(optionsMap: Map<string, string>, key: string): string {
  const value = optionsMap.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Run only after every module-level dependency (including the default atomic
// install operations) has been initialized. Starting above those declarations
// leaves them in the temporal dead zone during a real packaged update.
if (isDirectRun(import.meta.url)) await runPackagedUpdate();
