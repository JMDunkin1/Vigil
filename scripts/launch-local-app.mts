import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { plistStringForKey } from "../src/plist.js";
import { liveRuntimeReady } from "../src/runtimeReady.js";
import { resumeEmbeddedRuntimeSupervisor } from "../src/embeddedSupervisor.js";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";
import {
  beginGuardianMaintenance,
  guardianMaintenanceReadiness,
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
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { gitExecutable } from "./git-executable.mjs";
import {
  attachLocalDependencyCache,
  describeLocalDependencyCache,
  publishLocalDependencyCache
} from "./local-dependency-cache.mjs";

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

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  userDataDir: string;
  nodePath: string;
  npmPath: string;
  statusPath: string;
  expectedCommit: string;
  expectedBranch: string;
  expectedFingerprint: string;
  logPath: string;
  lockPath: string;
  lockToken: string;
}

interface LegacyAgentRecovery {
  context: {
    port: number;
    instanceSecret: string;
  };
  dataDir: string;
  plist: string;
  plistMode: number;
  plistPath: string;
  uid: number;
}

if (isDirectRun(import.meta.url)) await main();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.statusPath), { recursive: true });
  await mkdir(dirname(options.logPath), { recursive: true });
  const buildRoot = await mkdtemp(join(dirname(options.statusPath), "local-build-"));
  const snapshotRoot = join(buildRoot, "source");
  const packageOutputRoot = join(buildRoot, "output");
  const builtAppPath = join(packageOutputRoot, "mac-universal", "Vigil.app");
  const log = createWriteStream(options.logPath, { flags: "a" });
  log.on("error", () => undefined);
  await waitForLogOpen(log);
  let guardianMaintenance: GuardianMaintenanceTransaction | null = null;
  let appPlan: UpdateArtifactPlan | null = null;
  let recoveryPolicy: UpdateRecoveryPolicy | null = null;
  let recoveryDependencies: UpdateRecoveryDependencies | null = null;
  let legacyAgent: LegacyAgentRecovery | null = null;
  let legacyAgentStopped = false;
  let parentExited = false;
  log.write(`\n[${new Date().toISOString()}] Preparing local update preflight while Vigil process ${options.parentPid} keeps running.\n`);
  try {
    await waitForOwnedUpdaterLock(options.lockPath, options.lockToken);
    await reconcilePreviousLocalGlobalUpdate(options);
    const maintenance = await guardianMaintenanceReadiness();
    if (!maintenance.ready) {
      throw new Error(maintenance.message || "Vigil's protected update setup is not ready.");
    }
    try {
      legacyAgent = await captureLegacyLaunchAgentRecovery();
    } catch (error) {
      throw new Error(
        `The legacy Vigil background service could not be prepared for rollback: ${errorMessage(error)} `
        + "The running app was left in place and no build was started."
      );
    }
    const expectedDataDir = legacyAgent?.dataDir
      || process.env.VIGIL_DATA_DIR
      || options.userDataDir;
    recoveryPolicy = {
      updaterDir: dirname(options.statusPath),
      expectedAppPath: options.appPath,
      repoRoot: options.repoRoot,
      userDataDir: options.userDataDir,
      expectedDataDir,
      expectedRuntimePaths: []
    };
    await localStatus(options, log, "building", "Building local Vigil changes");
    log.write(`[${new Date().toISOString()}] Building packaged Vigil from ${options.repoRoot}\n`);
    let exitCode: number | null = 1;
    let buildError = "";
    const buildStartedAt = Date.now();
    try {
      await assertSourceIdentity(options);
      await createLocalBuildSnapshot(options, snapshotRoot, buildRoot, log);
      exitCode = await buildLocalApp(options, snapshotRoot, packageOutputRoot, log);
      if (exitCode === 0) {
        await assertSourceIdentity(options);
        await verifyLocalBuildCandidate(builtAppPath, options, buildStartedAt);
      }
    } catch (error) {
      buildError = errorMessage(error);
      log.write(`[${new Date().toISOString()}] Local Vigil could not be built: ${buildError}\n`);
    }
    if (buildError || exitCode !== 0) {
      const message = buildError
        ? `Local Vigil could not be built: ${buildError}`
        : `Local Vigil build exited with status ${exitCode}. The running app was left in place.`;
      log.write(`[${new Date().toISOString()}] ${message}\n`);
      await safeLocalStatus(options, log, "failed", message, { error: message });
      process.exitCode = 1;
      return;
    }

    await localStatus(options, log, "installing-app", "Durably staging the verified local Vigil build");
    appPlan = await stageUpdateArtifactCandidate(
      recoveryPolicy,
      options.lockToken,
      builtAppPath,
      options.appPath,
      "app"
    );
    await bindLocalAppCodeDirectoryHashes(appPlan);

    try {
      guardianMaintenance = await beginGuardianMaintenance(options.lockPath, options.lockToken);
    } catch (error) {
      throw new Error(`The authenticated guardian maintenance transaction could not start: ${errorMessage(error)} The running app was left in place.`);
    }
    await assertSourceIdentity(options);
    await localStatus(options, log, "waiting", "Local Vigil build verified; waiting to replace the running app");
    log.write(`[${new Date().toISOString()}] Local build is ready. Asking Vigil to quit for replacement.\n`);
    process.kill(options.parentPid, "SIGUSR2");
    try {
      await waitForExit(options.parentPid, 45_000);
      parentExited = true;
    } catch (error) {
      await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
      throw new Error(`${errorMessage(error)} The built app was not installed.`);
    }

    if (legacyAgent) {
      await localStatus(options, log, "installing-runtime", "Pausing the legacy Vigil runtime for a coherent update snapshot");
      await stopLegacyLaunchAgentForUpdate(legacyAgent);
      legacyAgentStopped = true;
    }
    const recoveryBundle = await localUpdateRecoveryBundleSource(options);
    await localStatus(options, log, "installing-app", "Recording the crash-recoverable local update transaction");
    const recoveryManifest = await beginUpdateRecoveryTransaction(recoveryPolicy, {
      attemptId: options.lockToken,
      source: {
        initialCommit: options.expectedCommit,
        initialBranch: expectedBranchName(options.expectedBranch),
        targetCommit: options.expectedCommit
      },
      app: appPlan,
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
      localGuardianCodeDirectoryHashOptions(appPlan)
    );
    await assertLocalAppCodeDirectoryHashes(appPlan, false);
    await activateStagedUpdateArtifact(
      recoveryPolicy,
      options.lockToken,
      appPlan,
      "app",
      recoveryDependencies
    );
    await assertLocalAppCodeDirectoryHashes(appPlan, true);
    await verifyLocalBuildCandidate(options.appPath, options, buildStartedAt);
    await localStatus(options, log, "verifying", "Reopening and verifying the local Vigil build");
    log.write(`[${new Date().toISOString()}] Reopening rebuilt Vigil at ${options.appPath}.\n`);
    await reopenInstalledApp(options.appPath, log);
    await verifyReplacement(options.appPath, recoveryPolicy.expectedDataDir, legacyAgent?.context);
    await markUpdateRecoveryCommitIntent(recoveryPolicy, options.lockToken, recoveryDependencies);
    await markUpdateRecoveryCommitted(recoveryPolicy, options.lockToken, recoveryDependencies);
    const outcome = await recoverUpdateTransaction(recoveryPolicy, {
      ...recoveryDependencies,
      allowRollback: false
    });
    if (!outcome || outcome.attemptId !== options.lockToken || outcome.status !== "complete") {
      throw new Error(outcome?.message || "Vigil could not durably finalize the verified local update transaction.");
    }
    await safeLocalStatus(options, log, "complete", "Local Vigil update complete", {
      installedCommit: options.expectedCommit,
      installedFingerprint: options.expectedFingerprint
    });
  } catch (error) {
    let message = errorMessage(error) || "The local Vigil updater failed unexpectedly.";
    if (!parentExited) parentExited = !(await processStillExistsAfter(options.parentPid, 2_000));
    const recovery = await settleLocalGlobalUpdateAfterFailure({
      options,
      log,
      recoveryPolicy,
      recoveryDependencies,
      appPlan,
      legacyAgent,
      legacyAgentStopped,
      parentExited
    });
    if (recovery.errors.length) message = `${message} Recovery also reported: ${recovery.errors.join(" ")}`;
    log.write(`[${new Date().toISOString()}] ${message}\n`);
    if (recovery.committed) {
      await safeLocalStatus(options, log, "complete", `Local Vigil update complete. Final confirmation warning: ${message}`, {
        installedCommit: options.expectedCommit,
        installedFingerprint: options.expectedFingerprint
      });
    } else {
      await safeLocalStatus(options, log, "failed", message, { error: message });
      process.exitCode = 1;
    }
  } finally {
    if (guardianMaintenance) {
      await guardianMaintenance.release().catch((error) => {
        log.write(`[${new Date().toISOString()}] The guardian maintenance marker could not be cleared: ${errorMessage(error)}\n`);
      });
    }
    await releaseOwnedUpdaterLock(options.lockPath, options.lockToken).catch((error) => {
      log.write(`[${new Date().toISOString()}] The updater lock could not be released: ${errorMessage(error)}\n`);
    });
    await removeLocalBuildSnapshot(options.repoRoot, snapshotRoot, log);
    await rm(buildRoot, { recursive: true, force: true }).catch((error) => {
      log.write(`[${new Date().toISOString()}] The isolated local build could not be removed: ${errorMessage(error)}\n`);
    });
    log.end();
  }
}

async function bindLocalAppCodeDirectoryHashes(plan: UpdateArtifactPlan): Promise<void> {
  if (!plan.initialIdentity) {
    throw new Error("Vigil's protected local app update requires an installed signed generation.");
  }
  [plan.initialCdHash, plan.targetCdHash] = await Promise.all([
    verifiedAppCodeDirectoryHash(plan.targetPath),
    verifiedAppCodeDirectoryHash(`${plan.targetPath}.vigil-next`)
  ]);
}

function localGuardianCodeDirectoryHashOptions(plan: UpdateArtifactPlan): {
  expectedAppInitialCdHash: string;
  expectedAppTargetCdHash: string;
} {
  if (!plan.initialCdHash || !plan.targetCdHash) {
    throw new Error("Vigil's protected local app update is missing its signed generation hashes.");
  }
  return {
    expectedAppInitialCdHash: plan.initialCdHash,
    expectedAppTargetCdHash: plan.targetCdHash
  };
}

async function assertLocalAppCodeDirectoryHashes(plan: UpdateArtifactPlan, activated: boolean): Promise<void> {
  const expected = localGuardianCodeDirectoryHashOptions(plan);
  const [initialCdHash, targetCdHash] = await Promise.all([
    verifiedAppCodeDirectoryHash(activated ? `${plan.targetPath}.vigil-previous` : plan.targetPath),
    verifiedAppCodeDirectoryHash(activated ? plan.targetPath : `${plan.targetPath}.vigil-next`)
  ]);
  if (initialCdHash !== expected.expectedAppInitialCdHash
    || targetCdHash !== expected.expectedAppTargetCdHash) {
    throw new Error("Vigil's exact signed local app generations changed across protected activation.");
  }
}

interface LocalFailureRecovery {
  committed: boolean;
  errors: string[];
}

async function reconcilePreviousLocalGlobalUpdate(options: Options): Promise<void> {
  const paths = updateRecoveryPaths(dirname(options.statusPath));
  if (!(await pathExists(paths.manifestPath))) return;
  const outcome = await recoverUpdateTransactionFromPolicyFile(paths.policyPath, { allowRollback: false });
  if (outcome?.status === "complete" && !(await pathExists(paths.manifestPath))) return;
  throw new Error(outcome?.message || "Vigil must finish recovering the previous update before local changes can start.");
}

async function localUpdateRecoveryBundleSource(options: Options): Promise<UpdateRecoveryBundleSource> {
  const runtimeScriptsDir = dirname(fileURLToPath(import.meta.url));
  const selectedGit = await gitExecutable(options.repoRoot);
  const absoluteGit = isAbsolute(selectedGit)
    ? selectedGit
    : await lookupExecutablePath(selectedGit, options.repoRoot);
  return {
    nodePath: await realpath(options.nodePath),
    gitPath: await realpath(absoluteGit),
    scriptSourcePath: join(runtimeScriptsDir, "recover-update-transaction.mjs"),
    moduleSourcePath: join(runtimeScriptsDir, "..", "src", "updateTransaction.js"),
    treeDigestModuleSourcePath: join(runtimeScriptsDir, "..", "src", "runtimeTreeDigest.js"),
    helperSourcePath: join(runtimeScriptsDir, "..", "bin", "vigil-atomic-swap")
  };
}

async function lookupExecutablePath(command: string, cwd: string): Promise<string> {
  return await new Promise<string>((resolveLookup, rejectLookup) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn("/usr/bin/which", [command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      rejectLookup(new Error(`Vigil timed out while resolving the exact ${command} executable.`));
    }, 5_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectLookup(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const path = stdout.trim();
      if (code === 0 && isAbsolute(path)) resolveLookup(path);
      else rejectLookup(new Error(stderr.trim() || `Vigil could not resolve the exact ${command} executable.`));
    });
  });
}

async function settleLocalGlobalUpdateAfterFailure({
  options,
  log,
  recoveryPolicy,
  recoveryDependencies,
  appPlan,
  legacyAgent,
  legacyAgentStopped,
  parentExited
}: {
  options: Options;
  log: ReturnType<typeof createWriteStream>;
  recoveryPolicy: UpdateRecoveryPolicy | null;
  recoveryDependencies: UpdateRecoveryDependencies | null;
  appPlan: UpdateArtifactPlan | null;
  legacyAgent: LegacyAgentRecovery | null;
  legacyAgentStopped: boolean;
  parentExited: boolean;
}): Promise<LocalFailureRecovery> {
  const errors: string[] = [];
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
          errors.push("The pending local transaction is waiting for the original Vigil process to exit before rollback.");
        } else {
          await terminateLocalInstalledCandidate(options.appPath, appPlan);
          outcome = await recoverUpdateTransaction(recoveryPolicy, activeRecoveryDependencies);
        }
      } else {
        const priorOutcome = await recoverUpdateTransaction(recoveryPolicy, {
          ...activeRecoveryDependencies,
          allowRollback: false
        });
        if (priorOutcome?.attemptId === options.lockToken) outcome = priorOutcome;
      }
    } catch (recoveryError) {
      errors.push(`The durable local update transaction could not be reconciled: ${errorMessage(recoveryError)}`);
    }
  }

  if (outcome?.attemptId === options.lockToken && outcome.status === "complete") {
    return { committed: true, errors };
  }
  if (outcome?.attemptId === options.lockToken && outcome.status === "recovery-failed") {
    errors.push(outcome.message);
    return { committed: false, errors };
  }
  if (!manifestObserved && outcome?.attemptId !== options.lockToken && recoveryPolicy) {
    try {
      await reconcileStagedUpdateArtifactCandidate(recoveryPolicy, recoveryPolicy.expectedAppPath, "app");
    } catch (cleanupError) {
      errors.push(`The staged local app could not be reconciled: ${errorMessage(cleanupError)}`);
    }
  }

  const rolledBack = outcome?.attemptId === options.lockToken && outcome.status === "failed-recovered";
  const unchangedBeforeTransaction = !manifestObserved && outcome?.attemptId !== options.lockToken;
  if (parentExited && (rolledBack || unchangedBeforeTransaction)) {
    let legacyRestored = false;
    if (legacyAgent && legacyAgentStopped) {
      try {
        await restoreLegacyLaunchAgent(legacyAgent);
        legacyRestored = true;
      } catch (restoreError) {
        errors.push(`The previous legacy runtime could not be restored: ${errorMessage(restoreError)}`);
      }
    }
    try {
      if (!legacyRestored) await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
      await reopenInstalledApp(options.appPath, log);
      await verifyReplacement(
        options.appPath,
        recoveryPolicy?.expectedDataDir || legacyAgent?.dataDir || options.userDataDir,
        legacyAgent?.context
      );
    } catch (reopenError) {
      errors.push(`The restored Vigil app could not be verified; persistent supervision will retry: ${errorMessage(reopenError)}`);
    }
  }
  for (const recoveryError of errors) log.write(`[${new Date().toISOString()}] ${recoveryError}\n`);
  return { committed: false, errors };
}

async function terminateLocalInstalledCandidate(appPath: string, plan: UpdateArtifactPlan | null): Promise<void> {
  if (!plan) return;
  const installed = await captureUpdateArtifactIdentity(appPath, "app");
  if (installed && artifactIdentitiesMatch(plan.targetIdentity, installed)) {
    await terminateInstalledApp(appPath);
    return;
  }
  if ((installed === null && plan.initialIdentity === null)
    || (installed !== null && plan.initialIdentity !== null && artifactIdentitiesMatch(plan.initialIdentity, installed))) {
    return;
  }
  throw new Error("Vigil preserved a local app with an ambiguous identity instead of terminating it for rollback.");
}

function artifactIdentitiesMatch(expected: UpdateArtifactIdentity, observed: UpdateArtifactIdentity): boolean {
  return updateArtifactIdentitiesExactlyMatch(expected, observed);
}

async function processStillExistsAfter(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!processExists(pid)) return false;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 100));
  } while (Date.now() < deadline);
  return processExists(pid);
}

async function safeLocalStatus(
  options: Options,
  log: ReturnType<typeof createWriteStream>,
  phase: UpdateReceiptPhase,
  message: string,
  extra: Omit<UpdateReceiptPatch, "phase" | "message"> = {}
): Promise<void> {
  try {
    await localStatus(options, log, phase, message, extra);
  } catch (error) {
    log.write(`[${new Date().toISOString()}] Updater status could not be persisted: ${errorMessage(error)}\n`);
  }
}

async function localStatus(
  options: Options,
  log: ReturnType<typeof createWriteStream>,
  phase: UpdateReceiptPhase,
  message: string,
  extra: Omit<UpdateReceiptPatch, "phase" | "message"> = {}
): Promise<void> {
  const updatedAt = new Date().toISOString();
  log.write(`[${updatedAt}] ${phase}: ${message}\n`);
  await mergeWriteUpdateReceipt(options.statusPath, options.lockToken, {
    phase,
    message,
    updatedAt,
    ...extra
  });
}

async function captureLegacyLaunchAgentRecovery(): Promise<LegacyAgentRecovery | null> {
  const home = process.env.HOME || homedir();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Vigil could not identify the current user for background-service recovery.");
  const plistPath = join(home, "Library", "LaunchAgents", "com.vigil.agent.plist");
  const loaded = await runCommandResult("/bin/launchctl", ["print", `gui/${uid}/com.vigil.agent`]);
  if (!loaded.ok) {
    if (launchctlServiceMissing(loaded.stderr)) return null;
    throw new Error(`Vigil could not verify its legacy background service: ${loaded.stderr || "launchctl failed"}`);
  }
  let plist: string;
  let plistMode: number;
  try {
    const [contents, plistStat] = await Promise.all([readFile(plistPath, "utf8"), lstat(plistPath)]);
    if (!plistStat.isFile() || plistStat.isSymbolicLink() || plistStat.uid !== uid) {
      throw new Error("The loaded legacy Vigil background service has an unsafe recovery plist.");
    }
    plist = contents;
    plistMode = plistStat.mode & 0o777;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      throw new Error("The loaded legacy Vigil background service has no recovery plist.");
    }
    throw error;
  }
  const configuredPort = process.env.VIGIL_PORT || plistStringForKey(plist, "VIGIL_PORT") || "8787";
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("The legacy Vigil background service has an invalid port.");
  const dataDir = process.env.VIGIL_DATA_DIR || plistStringForKey(plist, "VIGIL_DATA_DIR");
  if (!dataDir) throw new Error("The legacy Vigil background service data directory could not be verified.");
  return {
    context: { port, instanceSecret: await getInstanceSecret(dataDir) },
    dataDir,
    plist,
    plistMode,
    plistPath,
    uid
  };
}

async function stopLegacyLaunchAgentForUpdate(recovery: LegacyAgentRecovery): Promise<void> {
  for (const args of [
    ["bootout", `gui/${recovery.uid}/com.vigil.agent`],
    ["bootout", `gui/${recovery.uid}`, recovery.plistPath]
  ]) {
    await runCommand("/bin/launchctl", args, true);
  }
  const loaded = await runCommandResult("/bin/launchctl", ["print", `gui/${recovery.uid}/com.vigil.agent`]);
  if (loaded.ok) throw new Error("The legacy Vigil background service remained loaded during the protected update.");
  if (!launchctlServiceMissing(loaded.stderr)) {
    throw new Error(`Vigil could not verify that its legacy background service stopped: ${loaded.stderr || "launchctl failed"}`);
  }
  await waitForLegacyBackendStopped(recovery.context);
}

async function restoreLegacyLaunchAgent(recovery: LegacyAgentRecovery | null): Promise<void> {
  if (!recovery) return;
  const restartedAfter = Date.now();
  for (const args of [
    ["bootout", `gui/${recovery.uid}/com.vigil.agent`],
    ["bootout", `gui/${recovery.uid}`, recovery.plistPath]
  ]) {
    await runCommand("/bin/launchctl", args, true);
  }
  await mkdir(dirname(recovery.plistPath), { recursive: true });
  await writeFile(recovery.plistPath, recovery.plist, { mode: recovery.plistMode });
  await runCommand("/bin/launchctl", ["enable", `gui/${recovery.uid}/com.vigil.agent`]);
  await runCommand("/bin/launchctl", ["bootstrap", `gui/${recovery.uid}`, recovery.plistPath]);
  await runCommand("/bin/launchctl", ["kickstart", "-k", `gui/${recovery.uid}/com.vigil.agent`]);
  await waitForLegacyLaunchAgent(restartedAfter, recovery.context);
}

async function waitForLegacyLaunchAgent(
  restartedAfter: number,
  context: LegacyAgentRecovery["context"]
): Promise<void> {
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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The restored Vigil background service did not become healthy in time.");
}

async function waitForLegacyBackendStopped(context: LegacyAgentRecovery["context"]): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await legacyBackendIsHealthy(context))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The legacy Vigil background service did not stop before update state was captured.");
}

async function legacyBackendIsHealthy(context: LegacyAgentRecovery["context"]): Promise<boolean> {
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

async function runCommand(command: string, args: string[], allowFailure = false): Promise<void> {
  const result = await runCommandResult(command, args);
  if (!result.ok && !allowFailure) {
    throw new Error(`${command} exited unsuccessfully: ${result.stderr || "Unknown error"}`);
  }
}

async function runCommandResult(command: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => {
      if (settled) return;
      try {
        child.kill("SIGKILL");
      } catch {
        // launchctl already exited.
      }
    }, 5_000);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: code === 0,
        stderr: stderr.trim() || (signal ? `${command} was terminated by ${signal}` : `${command} exited with status ${code}`)
      });
    });
  });
}

function launchctlServiceMissing(detail: string): boolean {
  return /could not find service|service not found|no such process/iu.test(detail);
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Vigil has an invalid server port.");
  }
  return port;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function verifyReplacement(
  appPath: string,
  dataDir: string,
  preservedContext?: LegacyAgentRecovery["context"]
): Promise<void> {
  const healthContext = preservedContext || {
    port: validPort(process.env.VIGIL_PORT || "8787"),
    instanceSecret: await getInstanceSecret(dataDir)
  };
  const launchedAfter = Date.now() - 2_000;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let healthySince = 0;
  while (Date.now() < deadline) {
    const [pids, ready, signedHealthy] = await Promise.all([
      installedAppProcessIds(appPath),
      liveRuntimeReady(dataDir, launchedAfter),
      legacyBackendIsHealthy(healthContext)
    ]);
    const running = Boolean(ready && pids.includes(ready.pid) && ready.appPath === join(appPath, "Contents", "MacOS", basename(appPath, ".app")));
    const healthy = ready?.transport === "in-app" && signedHealthy;
    if (running && healthy) {
      if (!healthySince) healthySince = Date.now();
      if (Date.now() - healthySince >= 1_500) return;
    } else {
      healthySince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The rebuilt Vigil app or its private enforcement runtime did not remain healthy after launch.");
}

async function installedAppProcessIds(appPath: string): Promise<number[]> {
  const executablePath = join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
  const processes = await captureProcessList();
  const pids: number[] = [];
  for (const line of processes.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match || (match[2] !== executablePath && !match[2].startsWith(`${executablePath} `))) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function terminateInstalledApp(appPath: string): Promise<void> {
  for (const pid of await installedAppProcessIds(appPath)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await installedAppProcessIds(appPath)).length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The rebuilt Vigil process did not stop before rollback.");
}

async function captureProcessList(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ps exited with status ${code}`)));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForLogOpen(log: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    log.once("open", () => resolveOpen());
    log.once("error", rejectOpen);
  });
}

interface LocalBuildInfo {
  builtAt?: unknown;
  commit?: unknown;
  sourceFingerprint?: unknown;
}

export function localBuildIdentityMatches(
  build: LocalBuildInfo,
  expectedCommit: string,
  expectedFingerprint: string,
  builtAfter: number
): boolean {
  const builtAt = Date.parse(String(build.builtAt || ""));
  return build.commit === expectedCommit
    && build.sourceFingerprint === expectedFingerprint
    && Number.isFinite(builtAt)
    && builtAt >= builtAfter - 1_000;
}

async function assertSourceIdentity(options: Options): Promise<void> {
  const [head, branch, fingerprint] = await Promise.all([
    captureGitHead(options.repoRoot),
    captureGitBranch(options.repoRoot),
    sourceFingerprint(options.repoRoot)
  ]);
  if (head !== options.expectedCommit
    || branch !== options.expectedBranch
    || fingerprint !== options.expectedFingerprint) {
    throw new Error("Vigil source changed while local changes were being prepared. Nothing was installed.");
  }
}

async function verifyLocalBuildCandidate(appPath: string, options: Options, builtAfter: number): Promise<void> {
  const candidateStat = await lstat(appPath);
  if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
    throw new Error("The isolated Vigil build did not produce a trustworthy app bundle.");
  }
  const infoPath = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "build-info.json"
  );
  let build: LocalBuildInfo;
  try {
    build = JSON.parse(await readFile(infoPath, "utf8")) as LocalBuildInfo;
  } catch {
    throw new Error("The isolated Vigil build is missing valid source identity metadata.");
  }
  if (!localBuildIdentityMatches(build, options.expectedCommit, options.expectedFingerprint, builtAfter)) {
    throw new Error("The isolated Vigil build does not match the source selected for this update. Nothing was installed.");
  }
}

async function captureGitHead(repoRoot: string): Promise<string> {
  return await captureGitText(repoRoot, ["rev-parse", "HEAD"]);
}

async function captureGitBranch(repoRoot: string): Promise<string> {
  return await captureGitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

async function captureGitText(repoRoot: string, args: string[]): Promise<string> {
  const command = await gitExecutable(repoRoot);
  return await new Promise<string>((resolveCapture, rejectCapture) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectCapture);
    child.once("close", (code) => code === 0
      ? resolveCapture(stdout.trim())
      : rejectCapture(new Error(`git ${args.join(" ")} failed with status ${code}: ${stderr.trim() || "Unknown error"}`)));
  });
}

function expectedBranchName(value: string): string | null {
  return value === "HEAD" ? null : value;
}

async function buildLocalApp(
  options: Options,
  snapshotRoot: string,
  packageOutputRoot: string,
  log: ReturnType<typeof createWriteStream>
): Promise<number | null> {
  const dependencyStartedAt = Date.now();
  const dependencyCache = await describeLocalDependencyCache(snapshotRoot, options.nodePath, options.npmPath);
  const updaterDir = dirname(options.statusPath);
  const cacheHit = await attachLocalDependencyCache(snapshotRoot, updaterDir, dependencyCache);
  if (cacheHit) {
    log.write(
      `[${new Date().toISOString()}] Reusing locked local build dependencies ${dependencyCache.key.slice(0, 12)} `
      + `(warm dependency stage ${formatBuildSeconds(dependencyStartedAt)}s).\n`
    );
  } else {
    log.write(`[${new Date().toISOString()}] Preparing locked local build dependencies ${dependencyCache.key.slice(0, 12)}.\n`);
    const installCode = await runBuildCommand(
      options.npmPath,
      ["ci", "--prefer-offline", "--no-audit", "--no-fund"],
      snapshotRoot,
      log,
      { VIGIL_BUILD_SOURCE_ROOT: options.repoRoot },
      DEPENDENCY_INSTALL_TIMEOUT_MS
    );
    if (installCode !== 0) return installCode;
    await publishLocalDependencyCache(snapshotRoot, updaterDir, dependencyCache);
    log.write(
      `[${new Date().toISOString()}] Locked local build dependencies cached `
      + `(cold dependency stage ${formatBuildSeconds(dependencyStartedAt)}s).\n`
    );
  }
  const runtimeStartedAt = Date.now();
  const buildCode = await runBuildCommand(options.npmPath, ["run", "build"], snapshotRoot, log, {
    VIGIL_BUILD_SOURCE_ROOT: options.repoRoot
  }, RUNTIME_BUILD_TIMEOUT_MS);
  if (buildCode !== 0) return buildCode;
  log.write(`[${new Date().toISOString()}] Rebuilt local runtime in ${formatBuildSeconds(runtimeStartedAt)}s.\n`);
  const packageStartedAt = Date.now();
  const packageCode = await runBuildCommand(options.nodePath, [
    join(snapshotRoot, "scripts", "package-local-mac.mjs"),
    "--template-app", options.appPath,
    "--output", packageOutputRoot
  ], snapshotRoot, log, {
    VIGIL_BUILD_SOURCE_ROOT: options.repoRoot
  }, APP_PACKAGE_TIMEOUT_MS);
  log.write(
    `[${new Date().toISOString()}] Local package stage finished in ${formatBuildSeconds(packageStartedAt)}s `
    + `(status ${packageCode ?? "signal"}).\n`
  );
  return packageCode;
}

function formatBuildSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1_000).toFixed(2);
}

async function runBuildCommand(
  command: string,
  args: string[],
  cwd: string,
  log: ReturnType<typeof createWriteStream>,
  environment: NodeJS.ProcessEnv = process.env,
  timeoutMs = SOURCE_COMMAND_TIMEOUT_MS
): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let childClosed = false;
    let killConfirmationReached = false;
    let terminationGrace: ReturnType<typeof setTimeout> | null = null;
    let killConfirmation: ReturnType<typeof setTimeout> | null = null;
    let terminationPoll: ReturnType<typeof setInterval> | null = null;
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", log, log],
      env: { ...process.env, ...environment },
      detached: true
    });
    const clearLifecycleTimers = () => {
      clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      if (killConfirmation) clearTimeout(killConfirmation);
      if (terminationPoll) clearInterval(terminationPoll);
    };
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      resolve(code);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearLifecycleTimers();
      reject(error);
    };
    const processGroupStillExists = () => buildProcessGroupExists(child.pid);
    const finishTimedOutCommandWhenStopped = () => {
      if (!timedOut || settled || processGroupStillExists()) return;
      if (childClosed || killConfirmationReached) finish(124);
    };
    const waitForKillConfirmation = () => {
      killConfirmation = setTimeout(() => {
        if (settled) return;
        killConfirmationReached = true;
        if (!processGroupStillExists()) {
          finish(124);
          return;
        }
        // A process in an uninterruptible kernel wait can outlive SIGKILL.
        // Retain the updater lock and retry instead of allowing cleanup to race it.
        stopBuildCommand(child.pid, "SIGKILL");
        waitForKillConfirmation();
      }, COMMAND_KILL_CONFIRMATION_MS);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      log.write(`[${new Date().toISOString()}] ${command} timed out after ${timeoutMs}ms; terminating its process group.\n`);
      stopBuildCommand(child.pid, "SIGTERM");
      terminationPoll = setInterval(finishTimedOutCommandWhenStopped, COMMAND_TERMINATION_POLL_MS);
      terminationGrace = setTimeout(() => {
        if (settled) return;
        if (!processGroupStillExists()) {
          finishTimedOutCommandWhenStopped();
          if (!settled) waitForKillConfirmation();
          return;
        }
        stopBuildCommand(child.pid, "SIGKILL");
        waitForKillConfirmation();
      }, COMMAND_TERMINATION_GRACE_MS);
    }, timeoutMs);
    child.once("error", (error) => {
      if (settled) return;
      if (timedOut) {
        childClosed = true;
        finishTimedOutCommandWhenStopped();
        return;
      }
      fail(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      childClosed = true;
      if (timedOut) {
        finishTimedOutCommandWhenStopped();
        return;
      }
      finish(code);
    });
  });
}

function stopBuildCommand(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The bounded build command already exited.
    }
  }
}

function buildProcessGroupExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function createLocalBuildSnapshot(
  options: Options,
  snapshotRoot: string,
  buildRoot: string,
  log: ReturnType<typeof createWriteStream>
): Promise<void> {
  const git = await gitExecutable(options.repoRoot);
  const patchPath = join(buildRoot, "working-tree.patch");
  const [trackedPatch, untrackedOutput] = await Promise.all([
    captureGitBytes(git, options.repoRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"]),
    captureGitBytes(git, options.repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
  ]);
  await writeFile(patchPath, trackedPatch, { mode: 0o600 });
  const worktreeCode = await runBuildCommand(
    git,
    ["worktree", "add", "--detach", snapshotRoot, options.expectedCommit],
    options.repoRoot,
    log
  );
  if (worktreeCode !== 0) throw new Error(`Vigil could not create an isolated local source snapshot (status ${worktreeCode}).`);
  if (trackedPatch.length) {
    const applyCode = await runBuildCommand(git, ["apply", "--binary", patchPath], snapshotRoot, log);
    if (applyCode !== 0) throw new Error(`Vigil could not reproduce tracked local changes in its isolated snapshot (status ${applyCode}).`);
  }
  const untrackedPaths = untrackedOutput.toString("utf8").split("\0").filter(Boolean);
  for (const relativePath of untrackedPaths) {
    if (relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error("Vigil found an unsafe untracked path while isolating local changes.");
    }
    const source = join(options.repoRoot, relativePath);
    const destination = join(snapshotRoot, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination, {
      recursive: true,
      force: false,
      preserveTimestamps: true,
      verbatimSymlinks: true
    });
  }
  const snapshotFingerprint = await sourceFingerprint(snapshotRoot);
  if (snapshotFingerprint !== options.expectedFingerprint) {
    throw new Error("The isolated local source snapshot does not match the selected source fingerprint.");
  }
}

async function captureGitBytes(command: string, cwd: string, args: string[]): Promise<Buffer> {
  return await new Promise<Buffer>((resolveCapture, rejectCapture) => {
    const chunks: Buffer[] = [];
    const errors: Buffer[] = [];
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", rejectCapture);
    child.once("close", (code) => code === 0
      ? resolveCapture(Buffer.concat(chunks))
      : rejectCapture(new Error(`git ${args.join(" ")} failed with status ${code}: ${Buffer.concat(errors).toString("utf8").trim()}`)));
  });
}

async function removeLocalBuildSnapshot(
  repoRoot: string,
  snapshotRoot: string,
  log: ReturnType<typeof createWriteStream>
): Promise<void> {
  try {
    const git = await gitExecutable(repoRoot);
    if (await pathExists(snapshotRoot)) {
      const code = await runBuildCommand(git, ["worktree", "remove", "--force", snapshotRoot], repoRoot, log);
      if (code !== 0) log.write(`[${new Date().toISOString()}] Isolated worktree cleanup exited with status ${code}.\n`);
    }
    await runBuildCommand(git, ["worktree", "prune"], repoRoot, log);
  } catch (error) {
    log.write(`[${new Date().toISOString()}] The isolated source worktree could not be fully retired: ${errorMessage(error)}\n`);
  }
}

async function reopenInstalledApp(appPath: string, log: ReturnType<typeof createWriteStream>): Promise<void> {
  const account = userInfo();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG], {
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        HOME: account.homedir,
        USER: account.username,
        LOGNAME: account.username,
        PATH: `${join(account.homedir, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
      }
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`open exited with status ${code}`)));
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Vigil did not quit in time to launch local changes.");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    values.set(String(args[index] || "").replace(/^--/u, ""), args[index + 1] || "");
  }
  const parentPid = Number(required(values, "parent-pid"));
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid must be a positive process ID");
  const expectedCommit = required(values, "expected-commit");
  const expectedBranch = required(values, "expected-branch");
  const expectedFingerprint = required(values, "expected-fingerprint");
  if (!/^[a-f0-9]{40}$/iu.test(expectedCommit) || !/^[a-f0-9]{64}$/iu.test(expectedFingerprint)) {
    throw new Error("The selected local source identity is invalid.");
  }
  return {
      repoRoot: required(values, "repo-root"),
      appPath: required(values, "app-path"),
      parentPid,
      userDataDir: required(values, "user-data-dir"),
      nodePath: required(values, "node-path"),
      npmPath: required(values, "npm-path"),
      statusPath: required(values, "status-path"),
      expectedCommit,
      expectedBranch,
      expectedFingerprint,
    logPath: values.get("log-path") || join(homedir(), "Library", "Logs", "Vigil", "local-launch.log"),
    lockPath: required(values, "lock-path"),
    lockToken: required(values, "lock-token")
  };
}

async function releaseOwnedUpdaterLock(lockPath: string, lockToken: string): Promise<void> {
  let payload: { token?: unknown; pid?: unknown };
  try {
    payload = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown; pid?: unknown };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (payload.token === lockToken && payload.pid === process.pid) {
    await rm(lockPath, { force: true });
  }
}

async function waitForOwnedUpdaterLock(lockPath: string, lockToken: string): Promise<void> {
  const deadline = Date.now() + UPDATER_LOCK_HANDOFF_TIMEOUT_MS;
  do {
    try {
      const payload = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown; pid?: unknown };
      if (payload.token === lockToken && payload.pid === process.pid) return;
    } catch {
      // The controller may still be atomically transferring the lock payload.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  } while (Date.now() < deadline);
  throw new Error("Vigil updater lock ownership could not be verified after startup handoff.");
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

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
