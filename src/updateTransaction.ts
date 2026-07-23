import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const UPDATE_RECOVERY_VERSION = 1 as const;
export const UPDATE_RECOVERY_MANIFEST_FILENAME = "update-recovery.json";
export const UPDATE_RECOVERY_LOCK_FILENAME = "update-recovery.lock";
export const UPDATE_RECOVERY_OUTCOME_FILENAME = "update-recovery-outcome.json";
export const UPDATE_RECOVERY_POLICY_FILENAME = "update-recovery-policy.json";
export const UPDATE_STATE_ROLLBACK_WAL_FILENAME = "state-rollback-wal.json";
export const UPDATE_RECOVERY_RUNTIME_DIRNAME = "recovery-runtime";
export const UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH = "scripts/recover-update-transaction.mjs";
export const UPDATE_RECOVERY_MODULE_RELATIVE_PATH = "src/updateTransaction.js";
export const UPDATE_RECOVERY_HELPER_RELATIVE_PATH = "bin/vigil-atomic-swap";
export const UPDATE_RECOVERY_PACKAGE_RELATIVE_PATH = "package.json";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const MAX_RECOVERY_FILE_BYTES = 256 * 1024;
const MAX_BUILD_INFO_BYTES = 64 * 1024;
const MAX_RUNTIME_TARGETS = 8;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_POLL_MS = 25;
const INCOMPLETE_LOCK_GRACE_MS = 10_000;
const RECOVERY_PACKAGE_BYTES = Buffer.from('{\n  "type": "module"\n}\n', "utf8");

export const UPDATE_TRANSACTION_STATE_FILES = [
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

export type UpdateTransactionStateFile = typeof UPDATE_TRANSACTION_STATE_FILES[number];
export type UpdateRecoveryState = "pending" | "commit-intent" | "committed" | "rolling-back";
export type UpdateRecoveryOutcomeStatus = "complete" | "failed-recovered" | "recovery-failed";
export type UpdateArtifactKind = "app" | "runtime";

export interface UpdateArtifactIdentity {
  commit: string | null;
  fingerprint: string | null;
  /** Verified CodeDirectory hash for app bundles; null for unsigned or non-app artifacts. */
  cdHash?: string | null;
  dev: number | null;
  ino: number | null;
}

export interface UpdateRecoveryArtifact {
  targetPath: string;
  nextPath: string;
  previousPath: string;
  journalPath: string;
  initialPresent: boolean;
  initialCommit: string | null;
  initialFingerprint: string | null;
  initialCdHash?: string | null;
  initialDev: number | null;
  initialIno: number | null;
  targetCommit: string | null;
  targetFingerprint: string | null;
  targetCdHash?: string | null;
  targetDev: number | null;
  targetIno: number | null;
}

export interface UpdateRecoveryManifest {
  version: typeof UPDATE_RECOVERY_VERSION;
  attemptId: string;
  state: UpdateRecoveryState;
  source: {
    initialCommit: string;
    initialBranch: string | null;
    targetCommit: string;
    syncPending: boolean;
  };
  app: UpdateRecoveryArtifact;
  runtimes: UpdateRecoveryArtifact[];
  stateSnapshot: {
    dataDir: string;
    root: string;
    manifestPath: string;
  };
  recovery: {
    policyPath: string;
    policySha256: string;
    bundleRoot: string;
    nodePath: string;
    gitPath: string;
    packagePath: string;
    scriptPath: string;
    modulePath: string;
    helperPath: string;
  };
  timestamps: {
    startedAt: string;
    updatedAt: string;
    commitIntentAt: string | null;
    committedAt: string | null;
  };
}

export interface UpdateRecoveryOutcome {
  version: typeof UPDATE_RECOVERY_VERSION;
  attemptId: string;
  status: UpdateRecoveryOutcomeStatus;
  message: string;
  recoveredAt: string;
  installedIdentity: UpdateArtifactIdentity | null;
  sourceSyncPending: boolean;
}

export interface UpdateStateRollbackEntry {
  name: UpdateTransactionStateFile;
  destinationPath: string;
  backupPath: string;
  original: "present" | "missing";
  sha256: string | null;
  mode: number | null;
  status: "captured" | "restoring" | "restored";
}

interface StateRollbackWal {
  version: typeof UPDATE_RECOVERY_VERSION;
  attemptId: string;
  dataDir: string;
  snapshotRoot: string;
  state: "ready" | "rolling-back" | "restored";
  createdAt: string;
  updatedAt: string;
  entries: UpdateStateRollbackEntry[];
}

export interface UpdateRecoveryPolicy {
  updaterDir: string;
  expectedAppPath: string;
  repoRoot: string;
  userDataDir: string;
  expectedDataDir: string;
  expectedRuntimePaths: readonly string[];
}

export interface UpdateArtifactPlan {
  targetPath: string;
  initialIdentity: UpdateArtifactIdentity | null;
  targetIdentity: UpdateArtifactIdentity;
  /** Exact signed bundle hashes used only for app recovery authorization. */
  initialCdHash?: string | null;
  targetCdHash?: string | null;
}

type StagedArtifactJournalPhase =
  | "preparing"
  | "prepared"
  | "swapping"
  | "backing-up"
  | "installed"
  | "verified"
  | "rolling-back"
  | "finalizing";

/**
 * Version 2 deliberately remains compatible with the pre-existing per-app
 * replacement journal. The additional fields bind pre-manifest residue to an
 * exact global attempt and to both filesystem generations.
 */
interface StagedArtifactJournal {
  version: 2;
  id: string;
  attemptId: string;
  kind: UpdateArtifactKind;
  globalManifestPath: string;
  targetPath: string;
  nextPath: string;
  previousPath: string;
  phase: StagedArtifactJournalPhase;
  hadPrevious: boolean;
  initialPresent: boolean;
  initialCommit: string | null;
  initialFingerprint: string | null;
  initialDevice: number | null;
  initialInode: number | null;
  candidateCommit?: string | null;
  candidateFingerprint?: string | null;
  candidateDevice?: number;
  candidateInode?: number;
  updatedAt: string;
}

export interface BeginUpdateRecoveryInput {
  attemptId: string;
  source: {
    initialCommit: string;
    initialBranch: string | null;
    targetCommit: string;
  };
  app: UpdateArtifactPlan;
  runtimes?: readonly UpdateArtifactPlan[];
  recoveryBundle: UpdateRecoveryBundleSource;
}

export interface UpdateRecoveryBundleSource {
  nodePath: string;
  gitPath: string;
  scriptSourcePath: string;
  moduleSourcePath: string;
  helperSourcePath: string;
}

export interface UpdateRecoveryPolicyFile {
  version: typeof UPDATE_RECOVERY_VERSION;
  attemptId: string;
  updaterDir: string;
  expectedAppPath: string;
  repoRoot: string;
  userDataDir: string;
  expectedDataDir: string;
  expectedRuntimePaths: string[];
  recoveryRuntime: {
    root: string;
    nodePath: string;
    gitPath: string;
    packagePath: string;
    scriptPath: string;
    modulePath: string;
    helperPath: string;
    packageSha256: string;
    scriptSha256: string;
    moduleSha256: string;
    helperSha256: string;
  };
  createdAt: string;
}

export interface LoadedUpdateRecoveryPolicy {
  policy: UpdateRecoveryPolicy;
  record: UpdateRecoveryPolicyFile;
  sha256: string;
}

export interface UpdateRecoveryOperations {
  identifyArtifact(path: string, kind: UpdateArtifactKind): Promise<UpdateArtifactIdentity | null>;
  copyPath(source: string, destination: string): Promise<void>;
  movePath(source: string, destination: string): Promise<void>;
  removePath(path: string): Promise<void>;
  swapPaths(left: string, right: string): Promise<void>;
  syncArtifact(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
  cleanupJournal(path: string): Promise<void>;
  readSourceHead(repoRoot: string, gitPath: string): Promise<string>;
  readSourceBranch(repoRoot: string, gitPath: string): Promise<string | null>;
  validateSourceTransition(repoRoot: string, initialCommit: string, initialBranch: string | null, targetCommit: string, gitPath: string): Promise<void>;
  assertSourceWorktreeClean(repoRoot: string, gitPath: string): Promise<void>;
  synchronizeSource(repoRoot: string, expectedCurrentCommit: string, expectedBranch: string | null, targetCommit: string, gitPath: string): Promise<void>;
  restoreSource(repoRoot: string, expectedCurrentCommit: string, expectedBranch: string | null, initialCommit: string, gitPath: string): Promise<void>;
  processIdentity(pid: number): Promise<string | null>;
  beforeStateEntryRestore?(entry: Readonly<UpdateStateRollbackEntry>): Promise<void>;
  now(): Date;
}

export interface UpdateRecoveryDependencies {
  operations?: Partial<UpdateRecoveryOperations>;
  allowRollback?: boolean;
  lockTimeoutMs?: number;
  lockPollMs?: number;
  incompleteLockGraceMs?: number;
}

interface RecoveryPaths {
  manifestPath: string;
  lockPath: string;
  outcomePath: string;
  policyPath: string;
}

interface RecoveryLockRecord {
  version: typeof UPDATE_RECOVERY_VERSION;
  token: string;
  pid: number;
  processStartedAt: string;
  createdAt: string;
}

interface PinnedFile {
  handle: FileHandle;
  dev: number;
  ino: number;
  uid: number;
  mode: number;
  mtimeMs: number;
  raw: string;
}

type ArtifactGeneration = "absent" | "initial" | "target" | "ambiguous";

export class UpdateRecoveryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateRecoveryValidationError";
  }
}

export class UpdateRecoveryBusyError extends Error {
  constructor(message = "Another Vigil update recovery operation is active.") {
    super(message);
    this.name = "UpdateRecoveryBusyError";
  }
}

export function updateRecoveryPaths(updaterDir: string): RecoveryPaths {
  const directory = exactAbsolutePath(updaterDir, "updater directory");
  return {
    manifestPath: join(directory, UPDATE_RECOVERY_MANIFEST_FILENAME),
    lockPath: join(directory, UPDATE_RECOVERY_LOCK_FILENAME),
    outcomePath: join(directory, UPDATE_RECOVERY_OUTCOME_FILENAME),
    policyPath: join(directory, UPDATE_RECOVERY_POLICY_FILENAME)
  };
}

export async function captureUpdateArtifactIdentity(
  path: string,
  kind: UpdateArtifactKind = "runtime"
): Promise<UpdateArtifactIdentity | null> {
  return await defaultIdentifyArtifact(exactAbsolutePath(path, `${kind} artifact`), kind);
}

/**
 * Copy a candidate to its exact transaction `.vigil-next` path and capture the
 * identities of both generations. Activation must use this returned plan so a
 * caller can never record an inode from a separate build-directory copy.
 */
export async function stageUpdateArtifactCandidate(
  policyInput: UpdateRecoveryPolicy,
  attemptIdInput: string,
  sourcePathInput: string,
  targetPathInput: string,
  kind: UpdateArtifactKind,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateArtifactPlan> {
  const policy = normalizedPolicy(policyInput);
  const attemptId = updateAttemptId(attemptIdInput);
  const sourcePath = exactAbsolutePath(sourcePathInput, `${kind} staged source`);
  const targetPath = exactAbsolutePath(targetPathInput, `${kind} target`);
  assertAllowlistedArtifactTarget(policy, targetPath, kind);
  if (sourcePath === targetPath) throw new UpdateRecoveryValidationError("The staged artifact must be separate from its canonical target.");
  const operations = resolvedOperations(dependencies.operations);
  return await withRecoveryLock(policy, operations, dependencies, async () => {
    await assertNoGlobalManifest(policy);
    await reconcileStagedArtifactUnlocked(policy, targetPath, kind, operations);
    const nextPath = `${targetPath}.vigil-next`;
    const previousPath = `${targetPath}.vigil-previous`;
    const journalPath = `${targetPath}.vigil-transaction.json`;
    const initialIdentity = await operations.identifyArtifact(targetPath, kind);
    await mkdir(dirname(targetPath), { recursive: true });
    const now = timestamp(operations.now(), "artifact staging");
    const journal: StagedArtifactJournal = {
      version: 2,
      id: attemptId,
      attemptId,
      kind,
      globalManifestPath: updateRecoveryPaths(policy.updaterDir).manifestPath,
      targetPath,
      nextPath,
      previousPath,
      phase: "preparing",
      hadPrevious: false,
      initialPresent: initialIdentity !== null,
      initialCommit: initialIdentity?.commit ?? null,
      initialFingerprint: initialIdentity?.fingerprint ?? null,
      initialDevice: initialIdentity?.dev ?? null,
      initialInode: initialIdentity?.ino ?? null,
      updatedAt: now
    };
    validateStagedArtifactJournal(journal, policy, targetPath, kind);
    await atomicWritePrivateJson(journalPath, journal);
    await operations.copyPath(sourcePath, nextPath);
    await operations.syncArtifact(nextPath);
    await operations.syncDirectory(dirname(nextPath));
    const targetIdentity = await operations.identifyArtifact(nextPath, kind);
    if (!targetIdentity) throw new UpdateRecoveryValidationError(`The staged ${kind} candidate could not be identified.`);
    const normalizedTarget = normalizedIdentity(targetIdentity, `${kind} staged candidate identity`);
    journal.candidateCommit = normalizedTarget.commit;
    journal.candidateFingerprint = normalizedTarget.fingerprint;
    if (normalizedTarget.dev !== null && normalizedTarget.ino !== null) {
      journal.candidateDevice = normalizedTarget.dev;
      journal.candidateInode = normalizedTarget.ino;
    }
    journal.phase = "prepared";
    journal.updatedAt = monotonicTimestamp(journal.updatedAt, operations.now());
    await atomicWritePrivateJson(journalPath, journal);
    return { targetPath, initialIdentity, targetIdentity };
  });
}

/**
 * Reconcile only a journal-proven preactivation candidate. This is safe to use
 * in an updater catch path or on the next launch: it refuses to touch residue
 * once a global manifest exists or once the canonical generation changed.
 */
export async function reconcileStagedUpdateArtifactCandidate(
  policyInput: UpdateRecoveryPolicy,
  targetPathInput: string,
  kind: UpdateArtifactKind,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<void> {
  const policy = normalizedPolicy(policyInput);
  const targetPath = exactAbsolutePath(targetPathInput, `${kind} target`);
  assertAllowlistedArtifactTarget(policy, targetPath, kind);
  const operations = resolvedOperations(dependencies.operations);
  await withRecoveryLock(policy, operations, dependencies, async () => {
    await assertNoGlobalManifest(policy);
    await reconcileStagedArtifactUnlocked(policy, targetPath, kind, operations);
  });
}

/** Activate the exact inode captured by stageUpdateArtifactCandidate. */
export async function activateStagedUpdateArtifact(
  policyInput: UpdateRecoveryPolicy,
  attemptIdInput: string,
  plan: UpdateArtifactPlan,
  kind: UpdateArtifactKind,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateArtifactIdentity> {
  const policy = normalizedPolicy(policyInput);
  const attemptId = updateAttemptId(attemptIdInput);
  const operations = resolvedOperations(dependencies.operations);
  return await withRecoveryLock(policy, operations, dependencies, async () => {
    const raw = await readPrivateJsonIfPresent(updateRecoveryPaths(policy.updaterDir).manifestPath);
    if (raw === null) throw new UpdateRecoveryValidationError("The global recovery manifest must be durable before artifact activation.");
    const manifest = validatedManifest(raw, policy);
    await verifyManifestPolicyBinding(manifest, policy);
    if (manifest.attemptId !== attemptId || manifest.state !== "pending") {
      throw new UpdateRecoveryValidationError("The artifact activation is not authorized by the pending transaction attempt.");
    }
    const artifact = artifactFromPlan(plan, kind);
    const registered = kind === "app"
      ? manifest.app
      : manifest.runtimes.find((runtime) => runtime.targetPath === artifact.targetPath);
    if (!registered || !artifactsEqual(registered, artifact)) {
      throw new UpdateRecoveryValidationError("The staged artifact identities do not match the durable global transaction.");
    }
    return await activateRegisteredStagedArtifact(policy, manifest.attemptId, artifact, plan, kind, operations);
  });
}

async function activateRegisteredStagedArtifact(
  policy: UpdateRecoveryPolicy,
  attemptId: string,
  artifact: UpdateRecoveryArtifact,
  plan: UpdateArtifactPlan,
  kind: UpdateArtifactKind,
  operations: UpdateRecoveryOperations
): Promise<UpdateArtifactIdentity> {
  const journalRaw = await readPrivateJsonIfPresent(artifact.journalPath);
  if (journalRaw === null) {
    throw new UpdateRecoveryValidationError(`The prepared ${kind} journal is missing.`);
  }
  const journal = validateStagedArtifactJournalForArtifact(journalRaw, policy, artifact, kind);
  if (journal.attemptId !== attemptId || journal.phase !== "prepared") {
    throw new UpdateRecoveryValidationError(`The ${kind} candidate is not in its durable prepared phase.`);
  }
  const canonical = await operations.identifyArtifact(artifact.targetPath, kind);
  const next = await operations.identifyArtifact(artifact.nextPath, kind);
  const expectedInitial = plan.initialIdentity ? normalizedIdentity(plan.initialIdentity, `${kind} initial identity`) : null;
  const expectedTarget = normalizedIdentity(plan.targetIdentity, `${kind} target identity`);
  if ((expectedInitial === null && canonical !== null)
    || (expectedInitial !== null && !exactIdentityMatches(expectedInitial, canonical))) {
    throw new UpdateRecoveryValidationError(`The canonical ${kind} changed after the transaction identities were captured.`);
  }
  if (!exactIdentityMatches(expectedTarget, next)) {
    throw new UpdateRecoveryValidationError(`The staged ${kind} candidate changed after its exact .vigil-next identity was captured.`);
  }
  if (await pathEntryExists(artifact.previousPath)) {
    throw new UpdateRecoveryValidationError(`The ${kind} previous-generation path is unexpectedly occupied.`);
  }
  journal.hadPrevious = canonical !== null;
  journal.phase = "swapping";
  journal.updatedAt = monotonicTimestamp(journal.updatedAt, operations.now());
  await atomicWritePrivateJson(artifact.journalPath, journal);
  if (canonical) {
    await operations.swapPaths(artifact.targetPath, artifact.nextPath);
    await operations.syncDirectory(dirname(artifact.targetPath));
    await operations.movePath(artifact.nextPath, artifact.previousPath);
  } else {
    await operations.movePath(artifact.nextPath, artifact.targetPath);
  }
  await operations.syncDirectory(dirname(artifact.targetPath));
  const installed = await operations.identifyArtifact(artifact.targetPath, kind);
  if (!exactIdentityMatches(expectedTarget, installed)) {
    throw new UpdateRecoveryValidationError(`The activated ${kind} does not retain the staged candidate identity.`);
  }
  journal.phase = "installed";
  journal.updatedAt = monotonicTimestamp(journal.updatedAt, operations.now());
  await atomicWritePrivateJson(artifact.journalPath, journal);
  return installed as UpdateArtifactIdentity;
}

export async function readUpdateRecoveryPolicyFile(pathInput: string): Promise<LoadedUpdateRecoveryPolicy> {
  const path = exactAbsolutePath(pathInput, "update recovery policy file");
  if (path !== join(dirname(path), UPDATE_RECOVERY_POLICY_FILENAME)) {
    throw new UpdateRecoveryValidationError("The update recovery policy filename is invalid.");
  }
  await assertPathHasNoSymlinkAncestors(dirname(path), "update recovery policy directory");
  const document = await readPrivateJsonDocument(path);
  if (!document) throw new UpdateRecoveryValidationError("The update recovery policy file is missing.");
  const record = validatedPolicyFile(document.value, dirname(path));
  await verifyRecoveryRuntimeFiles(record);
  const policy = policyFromRecord(record);
  await assertPolicyFilesystemBoundaries(policy);
  await validatedStableNodePath(record.recoveryRuntime.nodePath, policy);
  await validatedStableExecutablePath(record.recoveryRuntime.gitPath, "stable recovery Git executable", policy);
  await verifyExecutableVersion(record.recoveryRuntime.nodePath, "node");
  await verifyExecutableVersion(record.recoveryRuntime.gitPath, "git");
  return {
    policy,
    record,
    sha256: sha256Bytes(Buffer.from(document.raw, "utf8"))
  };
}

/**
 * Persist the global transaction before any canonical app, runtime, source, or
 * state mutation. Candidate artifacts may already exist at their allowlisted
 * `.vigil-next` paths; their identities must be captured before this call.
 */
export async function beginUpdateRecoveryTransaction(
  policyInput: UpdateRecoveryPolicy,
  input: BeginUpdateRecoveryInput,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateRecoveryManifest> {
  const policy = normalizedPolicy(policyInput);
  const operations = resolvedOperations(dependencies.operations);
  return await withRecoveryLock(policy, operations, dependencies, async () => {
    const paths = updateRecoveryPaths(policy.updaterDir);
    const attemptId = updateAttemptId(input.attemptId);
    const source = {
      initialCommit: gitObjectId(input.source.initialCommit, "initial source commit"),
      initialBranch: sourceBranch(input.source.initialBranch, "initial source branch"),
      targetCommit: gitObjectId(input.source.targetCommit, "target source commit"),
      syncPending: false
    };
    const app = artifactFromPlan(input.app, "app");
    const runtimes = (input.runtimes || []).map((runtime) => artifactFromPlan(runtime, "runtime"));
    const existing = await readPrivateJsonIfPresent(paths.manifestPath);
    if (existing !== null) {
      const manifest = validatedManifest(existing, policy);
      await verifyManifestPolicyBinding(manifest, policy);
      if (manifest.attemptId === attemptId
        && manifest.source.initialCommit === source.initialCommit
        && manifest.source.initialBranch === source.initialBranch
        && manifest.source.targetCommit === source.targetCommit
        && artifactsEqual(manifest.app, app)
        && artifactListsEqual(manifest.runtimes, runtimes)) {
        return manifest;
      }
      throw new UpdateRecoveryValidationError("A different Vigil update transaction is still pending recovery.");
    }

    await assertPreparedArtifactJournal(policy, attemptId, app, "app", operations);
    for (const runtime of runtimes) {
      await assertPreparedArtifactJournal(policy, attemptId, runtime, "runtime", operations);
    }
    await removeOrphanStateSnapshots(policy);

    const snapshotRoot = join(policy.updaterDir, `state-before-update-${attemptId}`);
    const stateSnapshot = {
      dataDir: policy.expectedDataDir,
      root: snapshotRoot,
      manifestPath: join(snapshotRoot, UPDATE_STATE_ROLLBACK_WAL_FILENAME)
    };
    const startedAt = timestamp(operations.now(), "transaction start");
    const recoveryPolicy = await stageRecoveryRuntimeAndBuildPolicy(
      policy,
      attemptId,
      input.recoveryBundle,
      startedAt,
      operations
    );
    await operations.validateSourceTransition(
      policy.repoRoot,
      source.initialCommit,
      source.initialBranch,
      source.targetCommit,
      recoveryPolicy.recoveryRuntime.gitPath
    );
    if (source.initialCommit !== source.targetCommit) {
      await operations.assertSourceWorktreeClean(policy.repoRoot, recoveryPolicy.recoveryRuntime.gitPath);
    }
    await atomicWritePrivateJson(paths.policyPath, recoveryPolicy);
    const policySha256 = sha256Bytes(serializedJsonBytes(recoveryPolicy));
    const manifest: UpdateRecoveryManifest = {
      version: UPDATE_RECOVERY_VERSION,
      attemptId,
      state: "pending",
      source,
      app,
      runtimes,
      stateSnapshot,
      recovery: {
        policyPath: paths.policyPath,
        policySha256,
        bundleRoot: recoveryPolicy.recoveryRuntime.root,
        nodePath: recoveryPolicy.recoveryRuntime.nodePath,
        gitPath: recoveryPolicy.recoveryRuntime.gitPath,
        packagePath: recoveryPolicy.recoveryRuntime.packagePath,
        scriptPath: recoveryPolicy.recoveryRuntime.scriptPath,
        modulePath: recoveryPolicy.recoveryRuntime.modulePath,
        helperPath: recoveryPolicy.recoveryRuntime.helperPath
      },
      timestamps: {
        startedAt,
        updatedAt: startedAt,
        commitIntentAt: null,
        committedAt: null
      }
    };
    validateManifestPaths(manifest, policy);
    validateManifestIdentities(manifest);

    await ensureSafeDirectory(policy.updaterDir, true);
    try {
      await captureStateRollbackWal(manifest, operations);
      await atomicWritePrivateJson(paths.manifestPath, manifest);
      await removePrivateRegularFileIfPresent(paths.outcomePath);
      return manifest;
    } catch (error) {
      if (!await privateRegularFileExists(paths.manifestPath)) {
        await removeSnapshotRoot(manifest, policy).catch(() => undefined);
      }
      throw error;
    }
  });
}

export async function markUpdateRecoveryCommitIntent(
  policyInput: UpdateRecoveryPolicy,
  attemptId: string,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateRecoveryManifest> {
  return await transitionUpdateRecoveryState(policyInput, attemptId, "commit-intent", dependencies);
}

export async function markUpdateRecoveryCommitted(
  policyInput: UpdateRecoveryPolicy,
  attemptId: string,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateRecoveryManifest> {
  return await transitionUpdateRecoveryState(policyInput, attemptId, "committed", dependencies);
}

export async function readUpdateRecoveryManifest(
  policyInput: UpdateRecoveryPolicy
): Promise<UpdateRecoveryManifest | null> {
  const policy = normalizedPolicy(policyInput);
  await assertPolicyFilesystemBoundaries(policy);
  const value = await readPrivateJsonIfPresent(updateRecoveryPaths(policy.updaterDir).manifestPath);
  if (value === null) return null;
  const manifest = validatedManifest(value, policy);
  await verifyManifestPolicyBinding(manifest, policy);
  return manifest;
}

export async function readUpdateRecoveryOutcome(
  updaterDir: string
): Promise<UpdateRecoveryOutcome | null> {
  const directory = exactAbsolutePath(updaterDir, "updater directory");
  await assertPathHasNoSymlinkAncestors(directory, "updater directory");
  const value = await readPrivateJsonIfPresent(updateRecoveryPaths(directory).outcomePath);
  return value === null ? null : validatedOutcome(value);
}

/**
 * Recover one interrupted global transaction. The recovery result is itself a
 * durable journal record so the updater receipt can reconcile a crash that
 * happened after installation but before its terminal status write.
 */
export async function recoverUpdateTransaction(
  policyInput: UpdateRecoveryPolicy,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateRecoveryOutcome | null> {
  const policy = normalizedPolicy(policyInput);
  const operations = resolvedOperations(dependencies.operations);
  return await withRecoveryLock(policy, operations, dependencies, async () => {
    const paths = updateRecoveryPaths(policy.updaterDir);
    const raw = await readPrivateJsonIfPresent(paths.manifestPath);
    if (raw === null) return await readUpdateRecoveryOutcome(policy.updaterDir);
    const manifest = validatedManifest(raw, policy);
    await verifyManifestPolicyBinding(manifest, policy);

    try {
      const outcome = await recoverValidManifest(manifest, policy, operations, dependencies.allowRollback !== false);
      await atomicWritePrivateJson(paths.outcomePath, outcome);
      await removePrivateRegularFile(paths.manifestPath);
      await removeSnapshotRoot(manifest, policy).catch(() => undefined);
      return outcome;
    } catch (error) {
      const outcome: UpdateRecoveryOutcome = {
        version: UPDATE_RECOVERY_VERSION,
        attemptId: manifest.attemptId,
        status: "recovery-failed",
        message: boundedMessage(`Vigil preserved the interrupted update because recovery was ambiguous or incomplete: ${errorMessage(error)}`),
        recoveredAt: timestamp(operations.now(), "recovery failure"),
        installedIdentity: await safeInstalledIdentity(manifest.app, operations),
        sourceSyncPending: await safeSourceSyncPending(manifest, policy, operations)
      };
      await atomicWritePrivateJson(paths.outcomePath, outcome);
      return outcome;
    }
  });
}

export async function recoverUpdateTransactionFromPolicyFile(
  policyPath: string,
  dependencies: UpdateRecoveryDependencies = {}
): Promise<UpdateRecoveryOutcome | null> {
  const loaded = await readUpdateRecoveryPolicyFile(policyPath);
  return await recoverUpdateTransaction(loaded.policy, dependencies);
}

async function transitionUpdateRecoveryState(
  policyInput: UpdateRecoveryPolicy,
  attemptIdInput: string,
  nextState: "commit-intent" | "committed",
  dependencies: UpdateRecoveryDependencies
): Promise<UpdateRecoveryManifest> {
  const policy = normalizedPolicy(policyInput);
  const operations = resolvedOperations(dependencies.operations);
  return await withRecoveryLock(policy, operations, dependencies, async () => {
    const path = updateRecoveryPaths(policy.updaterDir).manifestPath;
    const raw = await readPrivateJsonIfPresent(path);
    if (raw === null) throw new UpdateRecoveryValidationError("The Vigil update recovery manifest is missing.");
    const manifest = validatedManifest(raw, policy);
    await verifyManifestPolicyBinding(manifest, policy);
    const attemptId = updateAttemptId(attemptIdInput);
    if (manifest.attemptId !== attemptId) {
      throw new UpdateRecoveryValidationError("The Vigil update recovery manifest belongs to another attempt.");
    }
    if (manifest.state === "committed" && nextState === "commit-intent") return manifest;
    if (manifest.state === nextState) {
      await assertCanonicalTargetsReadyToCommit(manifest, policy, operations);
      return manifest;
    }
    if (nextState === "commit-intent" && manifest.state !== "pending") {
      throw new UpdateRecoveryValidationError(`The update transaction cannot enter commit-intent from ${manifest.state}.`);
    }
    if (nextState === "committed" && manifest.state !== "commit-intent") {
      throw new UpdateRecoveryValidationError(`The update transaction cannot be committed from ${manifest.state}.`);
    }
    const head = await assertCanonicalTargetsReadyToCommit(manifest, policy, operations);
    manifest.source.syncPending = head !== manifest.source.targetCommit;
    const updatedAt = monotonicTimestamp(manifest.timestamps.updatedAt, operations.now());
    manifest.state = nextState;
    manifest.timestamps.updatedAt = updatedAt;
    if (nextState === "commit-intent") manifest.timestamps.commitIntentAt = updatedAt;
    else manifest.timestamps.committedAt = updatedAt;
    await atomicWritePrivateJson(path, manifest);
    return manifest;
  });
}

async function assertCanonicalTargetsReadyToCommit(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations
): Promise<string> {
  await assertSourceBranchMatches(manifest, policy, operations);
  const head = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
  const generations = [
    await inspectCanonical(manifest.app, "app", operations),
    ...await Promise.all(manifest.runtimes.map(async (runtime) => await inspectCanonical(runtime, "runtime", operations)))
  ];
  if ((head !== manifest.source.initialCommit && head !== manifest.source.targetCommit)
    || generations.some((generation) => generation !== "target")) {
    throw new UpdateRecoveryValidationError("Vigil cannot attest update health until the source is expected and every canonical artifact matches its target identity.");
  }
  return head;
}

async function recoverValidManifest(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations,
  allowRollback: boolean
): Promise<UpdateRecoveryOutcome> {
  await assertSourceBranchMatches(manifest, policy, operations);
  let rollForward = manifest.state === "committed";
  if (manifest.state === "commit-intent") {
    const sourceHead = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
    const artifacts = [
      await inspectCanonical(manifest.app, "app", operations),
      ...await Promise.all(manifest.runtimes.map(async (runtime) => await inspectCanonical(runtime, "runtime", operations)))
    ];
    if (artifacts.some((generation) => generation === "ambiguous")) {
      throw new Error("one or more canonical artifacts have ambiguous identities");
    }
    rollForward = artifacts.every((generation) => generation === "target");
    if (rollForward && sourceHead !== manifest.source.initialCommit && sourceHead !== manifest.source.targetCommit) {
      throw new Error("the source checkout matches neither exact transaction commit while target artifacts are installed");
    }
    if (!rollForward && !allowRollback) {
      throw new Error("the interrupted transaction requires rollback after the live Vigil runtime exits");
    }
    manifest.state = rollForward ? "committed" : "rolling-back";
    manifest.source.syncPending = rollForward && sourceHead !== manifest.source.targetCommit;
    const updatedAt = monotonicTimestamp(manifest.timestamps.updatedAt, operations.now());
    manifest.timestamps.updatedAt = updatedAt;
    if (rollForward) manifest.timestamps.committedAt = updatedAt;
    await atomicWritePrivateJson(updateRecoveryPaths(policy.updaterDir).manifestPath, manifest);
  } else if (manifest.state === "pending") {
    if (!allowRollback) throw new Error("the pending transaction requires rollback after the live Vigil runtime exits");
    manifest.state = "rolling-back";
    manifest.timestamps.updatedAt = monotonicTimestamp(manifest.timestamps.updatedAt, operations.now());
    await atomicWritePrivateJson(updateRecoveryPaths(policy.updaterDir).manifestPath, manifest);
  }

  if (rollForward) {
    let head = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
    if (head !== manifest.source.initialCommit && head !== manifest.source.targetCommit) {
      throw new Error("the source checkout matches neither exact transaction commit for the committed artifacts");
    }
    if (!allowRollback) {
      const liveGenerations = [
        await inspectCanonical(manifest.app, "app", operations),
        ...await Promise.all(manifest.runtimes.map(async (runtime) => await inspectCanonical(runtime, "runtime", operations)))
      ];
      if (liveGenerations.some((generation) => generation !== "target")) {
        throw new Error("live-runtime recovery requires every canonical artifact to already match its target identity");
      }
    }
    if (head !== manifest.source.targetCommit && head === manifest.source.initialCommit) {
      manifest.source.syncPending = true;
      manifest.timestamps.updatedAt = monotonicTimestamp(manifest.timestamps.updatedAt, operations.now());
      await atomicWritePrivateJson(updateRecoveryPaths(policy.updaterDir).manifestPath, manifest);
      await operations.synchronizeSource(
        policy.repoRoot,
        manifest.source.initialCommit,
        manifest.source.initialBranch,
        manifest.source.targetCommit,
        manifest.recovery.gitPath
      );
      await assertSourceBranchMatches(manifest, policy, operations);
      head = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
      if (head !== manifest.source.targetCommit) {
        throw new Error("the source checkout fast-forward could not be verified");
      }
    }
    if (manifest.source.initialCommit !== manifest.source.targetCommit) {
      await operations.assertSourceWorktreeClean(policy.repoRoot, manifest.recovery.gitPath);
    }
    if (manifest.source.syncPending) {
      manifest.source.syncPending = false;
      manifest.timestamps.updatedAt = monotonicTimestamp(manifest.timestamps.updatedAt, operations.now());
      await atomicWritePrivateJson(updateRecoveryPaths(policy.updaterDir).manifestPath, manifest);
    }
    await ensureArtifactGeneration(manifest.app, "app", "target", operations);
    for (const runtime of manifest.runtimes) {
      await ensureArtifactGeneration(runtime, "runtime", "target", operations);
    }
    const installedIdentity = await requireInstalledIdentity(manifest.app, "app", "target", operations);
    return {
      version: UPDATE_RECOVERY_VERSION,
      attemptId: manifest.attemptId,
      status: "complete",
      message: "Vigil completed the interrupted update transaction.",
      recoveredAt: timestamp(operations.now(), "recovery completion"),
      installedIdentity,
      sourceSyncPending: false
    };
  }

  if (manifest.state !== "rolling-back") {
    throw new Error(`unsupported recovery state ${manifest.state}`);
  }
  if (!allowRollback) throw new Error("the transaction rollback is waiting for the live Vigil runtime to exit");
  await ensureArtifactGeneration(manifest.app, "app", "initial", operations);
  for (const runtime of manifest.runtimes) {
    await ensureArtifactGeneration(runtime, "runtime", "initial", operations);
  }
  await rollbackStateFromWal(manifest, policy, operations);
  await restoreInitialSource(manifest, policy, operations);
  if (manifest.source.initialCommit !== manifest.source.targetCommit) {
    await operations.assertSourceWorktreeClean(policy.repoRoot, manifest.recovery.gitPath);
  }
  const installedIdentity = manifest.app.initialPresent
    ? await requireInstalledIdentity(manifest.app, "app", "initial", operations)
    : null;
  return {
    version: UPDATE_RECOVERY_VERSION,
    attemptId: manifest.attemptId,
    status: "failed-recovered",
    message: "Vigil restored the pre-update app, runtime, source, and state after an interrupted update.",
    recoveredAt: timestamp(operations.now(), "rollback completion"),
    installedIdentity,
    sourceSyncPending: false
  };
}

async function restoreInitialSource(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const current = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
  if (current === manifest.source.initialCommit) return;
  if (current !== manifest.source.targetCommit) {
    throw new Error("the source checkout matches neither the initial nor target transaction commit");
  }
  await operations.restoreSource(
    policy.repoRoot,
    manifest.source.targetCommit,
    manifest.source.initialBranch,
    manifest.source.initialCommit,
    manifest.recovery.gitPath
  );
  await assertSourceBranchMatches(manifest, policy, operations);
  const restored = await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath);
  if (restored !== manifest.source.initialCommit) throw new Error("the source checkout rollback could not be verified");
}

async function assertSourceBranchMatches(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const branch = await operations.readSourceBranch(policy.repoRoot, manifest.recovery.gitPath);
  if (branch !== manifest.source.initialBranch) {
    throw new Error("the source checkout branch no longer matches the exact transaction source");
  }
}

async function ensureArtifactGeneration(
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind,
  goal: "initial" | "target",
  operations: UpdateRecoveryOperations
): Promise<void> {
  if (goal === "initial" && !artifact.initialPresent) {
    const canonical = await operations.identifyArtifact(artifact.targetPath, kind);
    const canonicalGeneration = classifyIdentity(canonical, artifact);
    if (canonicalGeneration === "target") await operations.removePath(artifact.targetPath);
    else if (canonicalGeneration !== "absent") {
      throw new Error(`the ${kind} canonical path has an ambiguous generation`);
    }
    await cleanupResidue(artifact, kind, operations);
    await operations.cleanupJournal(artifact.journalPath);
    return;
  }

  let canonical = await operations.identifyArtifact(artifact.targetPath, kind);
  let canonicalGeneration = classifyIdentity(canonical, artifact);
  if (canonicalGeneration !== goal) {
    if (canonicalGeneration === "ambiguous") {
      throw new Error(`the ${kind} canonical path has an ambiguous generation`);
    }
    const candidates: string[] = [];
    for (const path of [artifact.nextPath, artifact.previousPath]) {
      const identity = await operations.identifyArtifact(path, kind);
      if (classifyIdentity(identity, artifact) === goal) candidates.push(path);
    }
    if (candidates.length !== 1) {
      throw new Error(`the ${kind} ${goal} generation has ${candidates.length} unambiguous recovery candidates`);
    }
    const candidate = candidates[0];
    if (canonicalGeneration === "absent") await operations.movePath(candidate, artifact.targetPath);
    else await operations.swapPaths(artifact.targetPath, candidate);
    canonical = await operations.identifyArtifact(artifact.targetPath, kind);
    canonicalGeneration = classifyIdentity(canonical, artifact);
    if (canonicalGeneration !== goal) throw new Error(`the ${kind} ${goal} generation could not be verified after recovery`);
  }
  await cleanupResidue(artifact, kind, operations);
  await operations.cleanupJournal(artifact.journalPath);
}

async function cleanupResidue(
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind,
  operations: UpdateRecoveryOperations
): Promise<void> {
  for (const path of [artifact.nextPath, artifact.previousPath]) {
    const identity = await operations.identifyArtifact(path, kind);
    const generation = classifyIdentity(identity, artifact);
    if (generation === "absent") continue;
    if (generation === "ambiguous") {
      throw new Error(`the ${kind} residue at ${path} has an ambiguous identity and was preserved`);
    }
    await operations.removePath(path);
  }
}

async function inspectCanonical(
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind,
  operations: UpdateRecoveryOperations
): Promise<ArtifactGeneration> {
  return classifyIdentity(await operations.identifyArtifact(artifact.targetPath, kind), artifact);
}

async function requireInstalledIdentity(
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind,
  expected: "initial" | "target",
  operations: UpdateRecoveryOperations
): Promise<UpdateArtifactIdentity> {
  const identity = await operations.identifyArtifact(artifact.targetPath, kind);
  if (!identity || classifyIdentity(identity, artifact) !== expected) {
    throw new Error(`the installed ${kind} identity could not be verified as ${expected}`);
  }
  return identity;
}

async function safeInstalledIdentity(
  artifact: UpdateRecoveryArtifact,
  operations: UpdateRecoveryOperations
): Promise<UpdateArtifactIdentity | null> {
  try {
    return await operations.identifyArtifact(artifact.targetPath, "app");
  } catch {
    return null;
  }
}

async function safeSourceSyncPending(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations
): Promise<boolean> {
  try {
    const installed = await operations.identifyArtifact(manifest.app.targetPath, "app");
    if (classifyIdentity(installed, manifest.app) !== "target") return false;
    if (await operations.readSourceBranch(policy.repoRoot, manifest.recovery.gitPath) !== manifest.source.initialBranch) return true;
    if (await operations.readSourceHead(policy.repoRoot, manifest.recovery.gitPath) !== manifest.source.targetCommit) return true;
    if (manifest.source.initialCommit !== manifest.source.targetCommit) {
      try {
        await operations.assertSourceWorktreeClean(policy.repoRoot, manifest.recovery.gitPath);
      } catch {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function classifyIdentity(
  observed: UpdateArtifactIdentity | null,
  artifact: UpdateRecoveryArtifact
): ArtifactGeneration {
  if (!observed) return "absent";
  const initial = artifact.initialPresent
    ? {
        commit: artifact.initialCommit,
        fingerprint: artifact.initialFingerprint,
        cdHash: artifact.initialCdHash ?? null,
        dev: artifact.initialDev,
        ino: artifact.initialIno
      }
    : null;
  const target = {
    commit: artifact.targetCommit,
    fingerprint: artifact.targetFingerprint,
    cdHash: artifact.targetCdHash ?? null,
    dev: artifact.targetDev,
    ino: artifact.targetIno
  };

  const initialMatch = initial ? exactIdentityMatches(initial, observed) : false;
  const targetMatch = exactIdentityMatches(target, observed);
  if (initialMatch !== targetMatch) return initialMatch ? "initial" : "target";
  return "ambiguous";
}

function inodeMatches(expected: UpdateArtifactIdentity, observed: UpdateArtifactIdentity): boolean {
  return expected.dev !== null
    && expected.ino !== null
    && expected.dev === observed.dev
    && expected.ino === observed.ino;
}

function contentMatches(expected: UpdateArtifactIdentity, observed: UpdateArtifactIdentity): boolean {
  const comparable = expected.commit !== null || expected.fingerprint !== null || expected.cdHash != null;
  if (!comparable) return false;
  if (expected.commit !== null && expected.commit !== observed.commit) return false;
  if (expected.fingerprint !== null && expected.fingerprint !== observed.fingerprint) return false;
  return expected.cdHash == null || expected.cdHash === observed.cdHash;
}

function exactIdentityMatches(
  expected: UpdateArtifactIdentity,
  observed: UpdateArtifactIdentity | null
): boolean {
  if (!observed) return false;
  const hasInode = expected.dev !== null && expected.ino !== null;
  if (hasInode && !inodeMatches(expected, observed)) return false;
  const hasContent = expected.commit !== null || expected.fingerprint !== null || expected.cdHash != null;
  if (hasContent && !contentMatches(expected, observed)) return false;
  return hasInode || hasContent;
}

/** Compare captured artifact identities using every proof in the expected generation. */
export function updateArtifactIdentitiesExactlyMatch(
  expected: UpdateArtifactIdentity,
  observed: UpdateArtifactIdentity
): boolean {
  return exactIdentityMatches(
    normalizedIdentity(expected, "expected artifact identity"),
    normalizedIdentity(observed, "observed artifact identity")
  );
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function captureStateRollbackWal(
  manifest: UpdateRecoveryManifest,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const { root, manifestPath, dataDir } = manifest.stateSnapshot;
  await ensureSafeDirectory(dataDir, false);
  await mkdir(root, { mode: PRIVATE_DIRECTORY_MODE });
  await mkdir(join(root, "files"), { mode: PRIVATE_DIRECTORY_MODE });
  await syncDirectory(dirname(root));
  const createdAt = timestamp(operations.now(), "state snapshot creation");
  const entries: UpdateStateRollbackEntry[] = [];
  for (const name of UPDATE_TRANSACTION_STATE_FILES) {
    const destinationPath = join(dataDir, name);
    const backupPath = join(root, "files", name);
    let original: UpdateStateRollbackEntry["original"] = "missing";
    let sha256: string | null = null;
    let mode: number | null = null;
    let source: { bytes: Buffer; mode: number } | null = null;
    try {
      source = await readPinnedRegularFile(destinationPath, `state file ${name}`);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
    if (source) {
      const backup = await open(backupPath, "wx", PRIVATE_FILE_MODE);
      try {
        await backup.writeFile(source.bytes);
        await backup.sync();
      } finally {
        await backup.close();
      }
      original = "present";
      sha256 = sha256Bytes(source.bytes);
      mode = source.mode & 0o777;
    }
    entries.push({
      name,
      destinationPath,
      backupPath,
      original,
      sha256,
      mode,
      status: "captured"
    });
  }
  await syncDirectory(join(root, "files"));
  const wal: StateRollbackWal = {
    version: UPDATE_RECOVERY_VERSION,
    attemptId: manifest.attemptId,
    dataDir,
    snapshotRoot: root,
    state: "ready",
    createdAt,
    updatedAt: timestamp(operations.now(), "state snapshot completion"),
    entries
  };
  await atomicWritePrivateJson(manifestPath, wal);
}

async function rollbackStateFromWal(
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const raw = await readPrivateJsonIfPresent(manifest.stateSnapshot.manifestPath);
  if (raw === null) throw new Error("the durable state rollback WAL is missing");
  const wal = validatedStateWal(raw, manifest, policy);
  wal.state = "rolling-back";
  wal.updatedAt = monotonicTimestamp(wal.updatedAt, operations.now());
  await atomicWritePrivateJson(manifest.stateSnapshot.manifestPath, wal);

  await ensureSafeDirectory(wal.dataDir, false);
  for (const entry of wal.entries) {
    entry.status = "restoring";
    wal.updatedAt = monotonicTimestamp(wal.updatedAt, operations.now());
    await atomicWritePrivateJson(manifest.stateSnapshot.manifestPath, wal);
    await operations.beforeStateEntryRestore?.(entry);
    if (entry.original === "present") {
      const bytes = await verifiedBackupBytes(entry);
      const temporaryPath = `${entry.destinationPath}.${manifest.attemptId}.${randomUUID()}.rollback`;
      let temporaryCreated = false;
      try {
        const temporary = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
        temporaryCreated = true;
        try {
          await temporary.writeFile(bytes);
          if (entry.mode !== null) await temporary.chmod(entry.mode);
          await temporary.sync();
        } finally {
          await temporary.close();
        }
        await rename(temporaryPath, entry.destinationPath);
        temporaryCreated = false;
      } finally {
        if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
      }
    } else {
      await removeStateDestination(entry.destinationPath);
    }
    await syncDirectory(wal.dataDir);
    entry.status = "restored";
    wal.updatedAt = monotonicTimestamp(wal.updatedAt, operations.now());
    await atomicWritePrivateJson(manifest.stateSnapshot.manifestPath, wal);
  }
  wal.state = "restored";
  wal.updatedAt = monotonicTimestamp(wal.updatedAt, operations.now());
  await atomicWritePrivateJson(manifest.stateSnapshot.manifestPath, wal);
}

async function verifiedBackupBytes(entry: UpdateStateRollbackEntry): Promise<Buffer> {
  const backupStat = await lstat(entry.backupPath);
  if (!backupStat.isFile() || backupStat.isSymbolicLink()) {
    throw new Error(`the state backup for ${entry.name} is unsafe`);
  }
  const bytes = await readFile(entry.backupPath);
  if (!entry.sha256 || sha256Bytes(bytes) !== entry.sha256) {
    throw new Error(`the state backup for ${entry.name} failed its integrity check`);
  }
  return bytes;
}

async function removeStateDestination(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (value.isDirectory() && !value.isSymbolicLink()) {
      throw new Error(`the allowlisted state destination ${path} unexpectedly became a directory`);
    }
    await rm(path, { force: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function assertAllowlistedArtifactTarget(
  policy: UpdateRecoveryPolicy,
  targetPath: string,
  kind: UpdateArtifactKind
): void {
  const allowed = kind === "app"
    ? targetPath === policy.expectedAppPath
    : policy.expectedRuntimePaths.includes(targetPath);
  if (!allowed) {
    throw new UpdateRecoveryValidationError(`The ${kind} staging target is not exactly allowlisted.`);
  }
}

async function assertNoGlobalManifest(policy: UpdateRecoveryPolicy): Promise<void> {
  const manifestPath = updateRecoveryPaths(policy.updaterDir).manifestPath;
  if (await pathEntryExists(manifestPath)) {
    throw new UpdateRecoveryValidationError("A durable global update transaction already owns artifact recovery residue.");
  }
}

async function reconcileStagedArtifactUnlocked(
  policy: UpdateRecoveryPolicy,
  targetPath: string,
  kind: UpdateArtifactKind,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const artifact = {
    targetPath,
    nextPath: `${targetPath}.vigil-next`,
    previousPath: `${targetPath}.vigil-previous`,
    journalPath: `${targetPath}.vigil-transaction.json`
  };
  const journalRaw = await readPrivateJsonIfPresent(artifact.journalPath);
  if (journalRaw === null) {
    for (const residue of [artifact.nextPath, artifact.previousPath]) {
      if (await pathEntryExists(residue)) {
        throw new UpdateRecoveryValidationError(`The artifact recovery residue ${residue} has no trustworthy staging journal and was preserved.`);
      }
    }
    return;
  }
  const journal = validateStagedArtifactJournal(journalRaw, policy, targetPath, kind);
  if ((journal.phase !== "preparing" && journal.phase !== "prepared") || journal.hadPrevious) {
    throw new UpdateRecoveryValidationError(`The ${kind} journal is no longer a preactivation staging record and was preserved.`);
  }
  if (await pathEntryExists(artifact.previousPath)) {
    throw new UpdateRecoveryValidationError(`The ${kind} previous-generation residue is incompatible with preactivation cleanup and was preserved.`);
  }
  const canonical = await operations.identifyArtifact(targetPath, kind);
  const initial = stagedJournalInitialIdentity(journal);
  if ((initial === null && canonical !== null)
    || (initial !== null && !exactIdentityMatches(initial, canonical))) {
    throw new UpdateRecoveryValidationError(`The canonical ${kind} changed after preactivation staging began; all evidence was preserved.`);
  }
  if (await pathEntryExists(artifact.nextPath)) {
    if (journal.phase === "prepared") {
      const expectedCandidate = stagedJournalCandidateIdentity(journal, true);
      const observedCandidate = await operations.identifyArtifact(artifact.nextPath, kind);
      if (!expectedCandidate || !exactIdentityMatches(expectedCandidate, observedCandidate)) {
        throw new UpdateRecoveryValidationError(`The prepared ${kind} candidate identity changed and was preserved.`);
      }
    }
    await operations.removePath(artifact.nextPath);
    await operations.syncDirectory(dirname(artifact.nextPath));
  }
  await operations.cleanupJournal(artifact.journalPath);
  await operations.syncDirectory(dirname(artifact.journalPath));
}

async function assertPreparedArtifactJournal(
  policy: UpdateRecoveryPolicy,
  attemptId: string,
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const raw = await readPrivateJsonIfPresent(artifact.journalPath);
  if (raw === null) throw new UpdateRecoveryValidationError(`The staged ${kind} candidate has no durable preparation journal.`);
  const journal = validateStagedArtifactJournalForArtifact(raw, policy, artifact, kind);
  if (journal.attemptId !== attemptId || journal.phase !== "prepared" || journal.hadPrevious) {
    throw new UpdateRecoveryValidationError(`The staged ${kind} candidate is not owned by this prepared update attempt.`);
  }
  if (await pathEntryExists(artifact.previousPath)) {
    throw new UpdateRecoveryValidationError(`The staged ${kind} candidate has unexpected previous-generation residue.`);
  }
  const canonical = await operations.identifyArtifact(artifact.targetPath, kind);
  const initial = stagedJournalInitialIdentity(journal);
  if ((initial === null && canonical !== null) || (initial !== null && !exactIdentityMatches(initial, canonical))) {
    throw new UpdateRecoveryValidationError(`The canonical ${kind} no longer matches its durably journaled initial identity.`);
  }
  const candidate = await operations.identifyArtifact(artifact.nextPath, kind);
  if (!exactIdentityMatches(stagedJournalCandidateIdentity(journal, true)!, candidate)) {
    throw new UpdateRecoveryValidationError(`The staged ${kind} no longer matches its durably journaled candidate identity.`);
  }
}

function validateStagedArtifactJournalForArtifact(
  value: unknown,
  policy: UpdateRecoveryPolicy,
  artifact: UpdateRecoveryArtifact,
  kind: UpdateArtifactKind
): StagedArtifactJournal {
  const journal = validateStagedArtifactJournal(value, policy, artifact.targetPath, kind);
  const initial = stagedJournalInitialIdentity(journal);
  const candidate = stagedJournalCandidateIdentity(journal, journal.phase !== "preparing");
  const expectedInitial = artifact.initialPresent
    ? {
        commit: artifact.initialCommit,
        fingerprint: artifact.initialFingerprint,
        dev: artifact.initialDev,
        ino: artifact.initialIno
      }
    : null;
  const expectedCandidate = {
    commit: artifact.targetCommit,
    fingerprint: artifact.targetFingerprint,
    dev: artifact.targetDev,
    ino: artifact.targetIno
  };
  if ((expectedInitial === null && initial !== null)
    || (expectedInitial !== null && (initial === null || !identitiesEqual(expectedInitial, initial)))
    || candidate === null
    || !identitiesEqual(expectedCandidate, candidate)) {
    throw new UpdateRecoveryValidationError(`The ${kind} journal identities do not match the global transaction.`);
  }
  return journal;
}

function validateStagedArtifactJournal(
  value: unknown,
  policy: UpdateRecoveryPolicy,
  targetPath: string,
  kind: UpdateArtifactKind
): StagedArtifactJournal {
  if (!isRecord(value)
    || value.version !== 2
    || !validIdentifier(value.id)
    || !validIdentifier(value.attemptId)
    || value.id !== value.attemptId
    || value.kind !== kind
    || value.globalManifestPath !== updateRecoveryPaths(policy.updaterDir).manifestPath
    || value.targetPath !== targetPath
    || value.nextPath !== `${targetPath}.vigil-next`
    || value.previousPath !== `${targetPath}.vigil-previous`
    || !validStagedArtifactJournalPhase(value.phase)
    || typeof value.hadPrevious !== "boolean"
    || typeof value.initialPresent !== "boolean"
    || !validTimestamp(value.updatedAt)) {
    throw new UpdateRecoveryValidationError(`The ${kind} staging journal is invalid and was preserved.`);
  }
  const journal = value as unknown as StagedArtifactJournal;
  stagedJournalInitialIdentity(journal);
  stagedJournalCandidateIdentity(journal, journal.phase !== "preparing");
  return journal;
}

function stagedJournalInitialIdentity(journal: StagedArtifactJournal): UpdateArtifactIdentity | null {
  if (!journal.initialPresent) {
    if (journal.initialCommit !== null
      || journal.initialFingerprint !== null
      || journal.initialDevice !== null
      || journal.initialInode !== null) {
      throw new UpdateRecoveryValidationError("An absent initial staging generation carries an identity.");
    }
    return null;
  }
  return normalizedIdentity({
    commit: journal.initialCommit,
    fingerprint: journal.initialFingerprint,
    dev: journal.initialDevice,
    ino: journal.initialInode
  }, "staging journal initial identity");
}

function stagedJournalCandidateIdentity(
  journal: StagedArtifactJournal,
  required: boolean
): UpdateArtifactIdentity | null {
  const values = [
    journal.candidateCommit,
    journal.candidateFingerprint,
    journal.candidateDevice,
    journal.candidateInode
  ];
  if (values.every((value) => value === undefined)) {
    if (required) throw new UpdateRecoveryValidationError("The staging journal lacks its prepared candidate identity.");
    return null;
  }
  return normalizedIdentity({
    commit: journal.candidateCommit ?? null,
    fingerprint: journal.candidateFingerprint ?? null,
    dev: journal.candidateDevice ?? null,
    ino: journal.candidateInode ?? null
  }, "staging journal candidate identity");
}

function identitiesEqual(left: UpdateArtifactIdentity, right: UpdateArtifactIdentity): boolean {
  return left.commit === right.commit
    && left.fingerprint === right.fingerprint
    && left.dev === right.dev
    && left.ino === right.ino;
}

function validStagedArtifactJournalPhase(value: unknown): value is StagedArtifactJournalPhase {
  return value === "preparing"
    || value === "prepared"
    || value === "swapping"
    || value === "backing-up"
    || value === "installed"
    || value === "verified"
    || value === "rolling-back"
    || value === "finalizing";
}

function artifactFromPlan(plan: UpdateArtifactPlan, label: string): UpdateRecoveryArtifact {
  const targetPath = exactAbsolutePath(plan.targetPath, `${label} target`);
  const initial = plan.initialIdentity ? normalizedIdentity(plan.initialIdentity, `${label} initial identity`) : null;
  const target = normalizedIdentity(plan.targetIdentity, `${label} target identity`);
  return {
    targetPath,
    nextPath: `${targetPath}.vigil-next`,
    previousPath: `${targetPath}.vigil-previous`,
    journalPath: `${targetPath}.vigil-transaction.json`,
    initialPresent: initial !== null,
    initialCommit: initial?.commit ?? null,
    initialFingerprint: initial?.fingerprint ?? null,
    initialCdHash: nullableCdHash(plan.initialCdHash, `${label} initial CodeDirectory hash`),
    initialDev: initial?.dev ?? null,
    initialIno: initial?.ino ?? null,
    targetCommit: target.commit,
    targetFingerprint: target.fingerprint,
    targetCdHash: nullableCdHash(plan.targetCdHash, `${label} target CodeDirectory hash`),
    targetDev: target.dev,
    targetIno: target.ino
  };
}

function artifactsEqual(left: UpdateRecoveryArtifact, right: UpdateRecoveryArtifact): boolean {
  return (Object.keys(left) as Array<keyof UpdateRecoveryArtifact>).every((field) => left[field] === right[field]);
}

function artifactListsEqual(left: readonly UpdateRecoveryArtifact[], right: readonly UpdateRecoveryArtifact[]): boolean {
  if (left.length !== right.length) return false;
  const byTarget = new Map(right.map((artifact) => [artifact.targetPath, artifact]));
  return left.every((artifact) => {
    const match = byTarget.get(artifact.targetPath);
    return Boolean(match && artifactsEqual(artifact, match));
  });
}

async function stageRecoveryRuntimeAndBuildPolicy(
  policy: UpdateRecoveryPolicy,
  attemptId: string,
  source: UpdateRecoveryBundleSource,
  createdAt: string,
  operations: UpdateRecoveryOperations
): Promise<UpdateRecoveryPolicyFile> {
  if (!isRecord(source)) throw new UpdateRecoveryValidationError("The stable recovery runtime source is invalid.");
  const nodePath = await validatedStableNodePath(source.nodePath, policy);
  const gitPath = await validatedStableExecutablePath(source.gitPath, "stable recovery Git executable", policy);
  await verifyExecutableVersion(nodePath, "node");
  await verifyExecutableVersion(gitPath, "git");
  const scriptSourcePath = exactAbsolutePath(source.scriptSourcePath, "recovery CLI source");
  const moduleSourcePath = exactAbsolutePath(source.moduleSourcePath, "recovery module source");
  const helperSourcePath = exactAbsolutePath(source.helperSourcePath, "recovery swap helper source");
  const [script, module, helper] = await Promise.all([
    readPinnedRegularFile(scriptSourcePath, "recovery CLI source"),
    readPinnedRegularFile(moduleSourcePath, "recovery module source"),
    readPinnedRegularFile(helperSourcePath, "recovery swap helper source")
  ]);
  if ((helper.mode & 0o111) === 0) throw new UpdateRecoveryValidationError("The recovery swap helper source is not executable.");

  const bundleRoot = join(policy.updaterDir, UPDATE_RECOVERY_RUNTIME_DIRNAME);
  const nextRoot = `${bundleRoot}.next-${attemptId}`;
  await removeSafeRecoveryDirectoryIfPresent(nextRoot, policy.updaterDir);
  await mkdir(join(nextRoot, "scripts"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await mkdir(join(nextRoot, "src"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await mkdir(join(nextRoot, "bin"), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const nextScript = join(nextRoot, UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH);
  const nextModule = join(nextRoot, UPDATE_RECOVERY_MODULE_RELATIVE_PATH);
  const nextHelper = join(nextRoot, UPDATE_RECOVERY_HELPER_RELATIVE_PATH);
  const nextPackage = join(nextRoot, UPDATE_RECOVERY_PACKAGE_RELATIVE_PATH);
  await writeFsyncedFile(nextPackage, RECOVERY_PACKAGE_BYTES, PRIVATE_FILE_MODE);
  await writeFsyncedFile(nextScript, script.bytes, PRIVATE_FILE_MODE);
  await writeFsyncedFile(nextModule, module.bytes, PRIVATE_FILE_MODE);
  await writeFsyncedFile(nextHelper, helper.bytes, 0o700);
  await Promise.all([
    syncDirectory(join(nextRoot, "scripts")),
    syncDirectory(join(nextRoot, "src")),
    syncDirectory(join(nextRoot, "bin"))
  ]);
  await syncDirectory(nextRoot);
  await execFileText(nodePath, [
    "--input-type=module",
    "--eval",
    "await import(process.argv[1])",
    pathToFileURL(nextScript).href
  ]).catch((error) => {
    throw new UpdateRecoveryValidationError(`The staged recovery runtime could not execute with its bound Node: ${errorMessage(error)}`);
  });
  await verifyAtomicSwapHelper(nextHelper, nextRoot);

  if (await safeDirectoryExists(bundleRoot)) {
    await operations.swapPaths(bundleRoot, nextRoot);
    await removeSafeRecoveryDirectoryIfPresent(nextRoot, policy.updaterDir);
  } else {
    await rename(nextRoot, bundleRoot);
  }
  await syncDirectory(policy.updaterDir);

  const recoveryRuntime = {
    root: bundleRoot,
    nodePath,
    gitPath,
    packagePath: join(bundleRoot, UPDATE_RECOVERY_PACKAGE_RELATIVE_PATH),
    scriptPath: join(bundleRoot, UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH),
    modulePath: join(bundleRoot, UPDATE_RECOVERY_MODULE_RELATIVE_PATH),
    helperPath: join(bundleRoot, UPDATE_RECOVERY_HELPER_RELATIVE_PATH),
    packageSha256: sha256Bytes(RECOVERY_PACKAGE_BYTES),
    scriptSha256: sha256Bytes(script.bytes),
    moduleSha256: sha256Bytes(module.bytes),
    helperSha256: sha256Bytes(helper.bytes)
  };
  const record: UpdateRecoveryPolicyFile = {
    version: UPDATE_RECOVERY_VERSION,
    attemptId,
    updaterDir: policy.updaterDir,
    expectedAppPath: policy.expectedAppPath,
    repoRoot: policy.repoRoot,
    userDataDir: policy.userDataDir,
    expectedDataDir: policy.expectedDataDir,
    expectedRuntimePaths: [...policy.expectedRuntimePaths],
    recoveryRuntime,
    createdAt
  };
  validatedPolicyFile(record, policy.updaterDir);
  await verifyRecoveryRuntimeFiles(record);
  return record;
}

async function validatedStableNodePath(value: unknown, policy: UpdateRecoveryPolicy): Promise<string> {
  return await validatedStableExecutablePath(value, "stable recovery Node executable", policy);
}

async function validatedStableExecutablePath(
  value: unknown,
  label: string,
  policy: UpdateRecoveryPolicy
): Promise<string> {
  const path = exactAbsolutePath(value, label);
  const resolvedPath = await realpath(path);
  if (resolvedPath !== path) {
    throw new UpdateRecoveryValidationError(`The ${label} must already be realpath-resolved.`);
  }
  const executable = await lstat(path);
  const uid = process.getuid?.();
  if (!executable.isFile()
    || executable.isSymbolicLink()
    || (executable.mode & 0o111) === 0
    || (uid !== undefined && executable.uid !== uid && executable.uid !== 0)) {
    throw new UpdateRecoveryValidationError(`The ${label} is unsafe.`);
  }
  const transactionTargets = [
    policy.updaterDir,
    policy.repoRoot,
    policy.userDataDir,
    ...artifactTopologyPaths(policy.expectedAppPath),
    ...policy.expectedRuntimePaths.flatMap(artifactTopologyPaths)
  ];
  if (transactionTargets.some((target) => path === target || isStrictDescendant(path, target))) {
    throw new UpdateRecoveryValidationError(`The ${label} must be outside updater, source, state, and replaceable artifact roots.`);
  }
  return path;
}

function validatedPolicyFile(value: unknown, expectedUpdaterDir: string): UpdateRecoveryPolicyFile {
  if (!isRecord(value)
    || value.version !== UPDATE_RECOVERY_VERSION
    || !Array.isArray(value.expectedRuntimePaths)
    || !isRecord(value.recoveryRuntime)
    || !validTimestamp(value.createdAt)) {
    throw new UpdateRecoveryValidationError("The update recovery policy file is invalid.");
  }
  const record = value as unknown as UpdateRecoveryPolicyFile;
  updateAttemptId(record.attemptId);
  const policy = normalizedPolicy({
    updaterDir: record.updaterDir,
    expectedAppPath: record.expectedAppPath,
    repoRoot: record.repoRoot,
    userDataDir: record.userDataDir,
    expectedDataDir: record.expectedDataDir,
    expectedRuntimePaths: record.expectedRuntimePaths
  });
  if (policy.updaterDir !== expectedUpdaterDir) {
    throw new UpdateRecoveryValidationError("The recovery policy is not bound to its exact updater directory.");
  }
  const root = join(policy.updaterDir, UPDATE_RECOVERY_RUNTIME_DIRNAME);
  const runtime = record.recoveryRuntime;
  if (runtime.root !== root
    || runtime.packagePath !== join(root, UPDATE_RECOVERY_PACKAGE_RELATIVE_PATH)
    || runtime.scriptPath !== join(root, UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH)
    || runtime.modulePath !== join(root, UPDATE_RECOVERY_MODULE_RELATIVE_PATH)
    || runtime.helperPath !== join(root, UPDATE_RECOVERY_HELPER_RELATIVE_PATH)) {
    throw new UpdateRecoveryValidationError("The stable recovery runtime paths are invalid.");
  }
  exactAbsolutePath(runtime.nodePath, "stable recovery Node executable");
  exactAbsolutePath(runtime.gitPath, "stable recovery Git executable");
  for (const [label, digest] of [
    ["package", runtime.packageSha256],
    ["script", runtime.scriptSha256],
    ["module", runtime.moduleSha256],
    ["helper", runtime.helperSha256]
  ] as const) {
    if (!isSha256(digest)) throw new UpdateRecoveryValidationError(`The recovery ${label} digest is invalid.`);
  }
  if (runtime.packageSha256 !== sha256Bytes(RECOVERY_PACKAGE_BYTES)) {
    throw new UpdateRecoveryValidationError("The stable recovery package metadata is invalid.");
  }
  return record;
}

function policyFromRecord(record: UpdateRecoveryPolicyFile): UpdateRecoveryPolicy {
  return normalizedPolicy({
    updaterDir: record.updaterDir,
    expectedAppPath: record.expectedAppPath,
    repoRoot: record.repoRoot,
    userDataDir: record.userDataDir,
    expectedDataDir: record.expectedDataDir,
    expectedRuntimePaths: record.expectedRuntimePaths
  });
}

async function verifyRecoveryRuntimeFiles(record: UpdateRecoveryPolicyFile): Promise<void> {
  for (const directory of [
    record.recoveryRuntime.root,
    dirname(record.recoveryRuntime.scriptPath),
    dirname(record.recoveryRuntime.modulePath),
    dirname(record.recoveryRuntime.helperPath)
  ]) {
    const value = await lstat(directory);
    const uid = process.getuid?.();
    if (!value.isDirectory()
      || value.isSymbolicLink()
      || (value.mode & 0o077) !== 0
      || (uid !== undefined && value.uid !== uid)) {
      throw new UpdateRecoveryValidationError(`The stable recovery runtime directory ${directory} is unsafe.`);
    }
  }
  const files = [
    [record.recoveryRuntime.packagePath, record.recoveryRuntime.packageSha256, false],
    [record.recoveryRuntime.scriptPath, record.recoveryRuntime.scriptSha256, false],
    [record.recoveryRuntime.modulePath, record.recoveryRuntime.moduleSha256, false],
    [record.recoveryRuntime.helperPath, record.recoveryRuntime.helperSha256, true]
  ] as const;
  for (const [path, expectedHash, executable] of files) {
    const file = await readPinnedRegularFile(path, "stable recovery runtime file");
    const uid = process.getuid?.();
    if (sha256Bytes(file.bytes) !== expectedHash
      || (file.mode & 0o077) !== 0
      || (uid !== undefined && file.uid !== uid)
      || (executable && (file.mode & 0o111) === 0)) {
      throw new UpdateRecoveryValidationError(`The stable recovery runtime file ${path} failed validation.`);
    }
  }
}

async function verifyManifestPolicyBinding(manifest: UpdateRecoveryManifest, policy: UpdateRecoveryPolicy): Promise<void> {
  const loaded = await readUpdateRecoveryPolicyFile(manifest.recovery.policyPath);
  if (loaded.sha256 !== manifest.recovery.policySha256
    || loaded.record.attemptId !== manifest.attemptId
    || !policiesEqual(loaded.policy, policy)
    || loaded.record.recoveryRuntime.root !== manifest.recovery.bundleRoot
    || loaded.record.recoveryRuntime.nodePath !== manifest.recovery.nodePath
    || loaded.record.recoveryRuntime.gitPath !== manifest.recovery.gitPath
    || loaded.record.recoveryRuntime.packagePath !== manifest.recovery.packagePath
    || loaded.record.recoveryRuntime.scriptPath !== manifest.recovery.scriptPath
    || loaded.record.recoveryRuntime.modulePath !== manifest.recovery.modulePath
    || loaded.record.recoveryRuntime.helperPath !== manifest.recovery.helperPath) {
    throw new UpdateRecoveryValidationError("The update recovery manifest and private recovery policy do not match.");
  }
}

function policiesEqual(left: UpdateRecoveryPolicy, right: UpdateRecoveryPolicy): boolean {
  return left.updaterDir === right.updaterDir
    && left.expectedAppPath === right.expectedAppPath
    && left.repoRoot === right.repoRoot
    && left.userDataDir === right.userDataDir
    && left.expectedDataDir === right.expectedDataDir
    && sameStringSet(left.expectedRuntimePaths, right.expectedRuntimePaths);
}

function normalizedIdentity(identity: UpdateArtifactIdentity, label: string): UpdateArtifactIdentity {
  if (!isRecord(identity)) throw new UpdateRecoveryValidationError(`The ${label} is invalid.`);
  const normalized: UpdateArtifactIdentity = {
    commit: nullableIdentifier(identity.commit, `${label} commit`),
    fingerprint: nullableIdentifier(identity.fingerprint, `${label} fingerprint`),
    cdHash: nullableCdHash(identity.cdHash, `${label} CodeDirectory hash`),
    dev: nullableNonNegativeInteger(identity.dev, `${label} device`),
    ino: nullablePositiveInteger(identity.ino, `${label} inode`)
  };
  const contentProof = normalized.commit !== null || normalized.fingerprint !== null || normalized.cdHash !== null;
  const inodeProof = normalized.dev !== null && normalized.ino !== null;
  if (!contentProof && !inodeProof) {
    throw new UpdateRecoveryValidationError(`The ${label} has neither content nor inode identity.`);
  }
  if ((normalized.dev === null) !== (normalized.ino === null)) {
    throw new UpdateRecoveryValidationError(`The ${label} has an incomplete inode identity.`);
  }
  return normalized;
}

function normalizedPolicy(input: UpdateRecoveryPolicy): UpdateRecoveryPolicy {
  const updaterDir = exactAbsolutePath(input.updaterDir, "updater directory");
  const expectedAppPath = exactAbsolutePath(input.expectedAppPath, "expected app path");
  const repoRoot = exactAbsolutePath(input.repoRoot, "repository root");
  const userDataDir = exactAbsolutePath(input.userDataDir, "user data directory");
  const expectedDataDir = exactAbsolutePath(input.expectedDataDir, "expected state data directory");
  if (!Array.isArray(input.expectedRuntimePaths) || input.expectedRuntimePaths.length > MAX_RUNTIME_TARGETS) {
    throw new UpdateRecoveryValidationError("The runtime recovery allowlist is invalid.");
  }
  const expectedRuntimePaths = input.expectedRuntimePaths.map((path) => exactAbsolutePath(path, "expected runtime path"));
  if (new Set(expectedRuntimePaths).size !== expectedRuntimePaths.length) {
    throw new UpdateRecoveryValidationError("The runtime recovery allowlist contains duplicate paths.");
  }
  for (const path of expectedRuntimePaths) {
    if (!isStrictDescendant(path, repoRoot) && !isStrictDescendant(path, userDataDir)) {
      throw new UpdateRecoveryValidationError(`The runtime path ${path} is outside the repository and user data roots.`);
    }
  }
  if (!isStrictDescendant(updaterDir, userDataDir)) {
    throw new UpdateRecoveryValidationError("The updater recovery directory must be an exact descendant of the user data directory.");
  }
  const artifactTargets = [expectedAppPath, ...expectedRuntimePaths];
  const artifactTopology = artifactTargets.flatMap(artifactTopologyPaths);
  for (const mutableRoot of [repoRoot, ...artifactTopology]) {
    if (pathsOverlap(updaterDir, mutableRoot)) {
      throw new UpdateRecoveryValidationError("The updater recovery directory must be disjoint from every replaceable artifact and source root.");
    }
  }
  for (let left = 0; left < artifactTargets.length; left += 1) {
    for (let right = left + 1; right < artifactTargets.length; right += 1) {
      if (artifactTopologyPaths(artifactTargets[left]!).some((leftPath) =>
        artifactTopologyPaths(artifactTargets[right]!).some((rightPath) => pathsOverlap(leftPath, rightPath)))) {
        throw new UpdateRecoveryValidationError("App and runtime recovery topologies must be pairwise disjoint.");
      }
    }
  }
  return { updaterDir, expectedAppPath, repoRoot, userDataDir, expectedDataDir, expectedRuntimePaths };
}

function validatedManifest(value: unknown, policy: UpdateRecoveryPolicy): UpdateRecoveryManifest {
  if (!isRecord(value) || value.version !== UPDATE_RECOVERY_VERSION) {
    throw new UpdateRecoveryValidationError("The Vigil update recovery manifest has an unsupported version.");
  }
  if (!validRecoveryState(value.state)
    || !isRecord(value.source)
    || !isRecord(value.stateSnapshot)
    || !isRecord(value.recovery)
    || !isRecord(value.timestamps)) {
    throw new UpdateRecoveryValidationError("The Vigil update recovery manifest is malformed.");
  }
  const manifest = value as unknown as UpdateRecoveryManifest;
  updateAttemptId(manifest.attemptId);
  gitObjectId(manifest.source.initialCommit, "initial source commit");
  sourceBranch(manifest.source.initialBranch, "initial source branch");
  gitObjectId(manifest.source.targetCommit, "target source commit");
  if (typeof manifest.source.syncPending !== "boolean") {
    throw new UpdateRecoveryValidationError("The recovery manifest source synchronization state is invalid.");
  }
  if (!Array.isArray(manifest.runtimes) || manifest.runtimes.length > MAX_RUNTIME_TARGETS) {
    throw new UpdateRecoveryValidationError("The Vigil runtime recovery records are invalid.");
  }
  validateArtifactShape(manifest.app, "app");
  manifest.runtimes.forEach((runtime, index) => validateArtifactShape(runtime, `runtime ${index + 1}`));
  validateTimestamps(manifest);
  validateManifestPaths(manifest, policy);
  validateManifestIdentities(manifest);
  return manifest;
}

function validateArtifactShape(value: unknown, label: string): asserts value is UpdateRecoveryArtifact {
  if (!isRecord(value) || typeof value.initialPresent !== "boolean") {
    throw new UpdateRecoveryValidationError(`The ${label} recovery record is malformed.`);
  }
  for (const field of ["targetPath", "nextPath", "previousPath", "journalPath"] as const) {
    exactAbsolutePath(value[field], `${label} ${field}`);
  }
  for (const field of ["initialCommit", "initialFingerprint", "targetCommit", "targetFingerprint"] as const) {
    nullableIdentifier(value[field], `${label} ${field}`);
  }
  nullableCdHash(value.initialCdHash, `${label} initial CodeDirectory hash`);
  nullableCdHash(value.targetCdHash, `${label} target CodeDirectory hash`);
  nullableNonNegativeInteger(value.initialDev, `${label} initial device`);
  nullablePositiveInteger(value.initialIno, `${label} initial inode`);
  nullableNonNegativeInteger(value.targetDev, `${label} target device`);
  nullablePositiveInteger(value.targetIno, `${label} target inode`);
}

function nullableCdHash(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new UpdateRecoveryValidationError(`The ${label} is invalid.`);
  }
  return value;
}

function validateManifestIdentities(manifest: UpdateRecoveryManifest): void {
  for (const [label, artifact] of [["app", manifest.app], ...manifest.runtimes.map((runtime, index) => [`runtime ${index + 1}`, runtime] as const)] as const) {
    const initialValues = [artifact.initialCommit, artifact.initialFingerprint, artifact.initialDev, artifact.initialIno];
    if (!artifact.initialPresent && initialValues.some((value) => value !== null)) {
      throw new UpdateRecoveryValidationError(`The ${label} absent initial generation carries an identity.`);
    }
    if (artifact.initialPresent) {
      normalizedIdentity({
        commit: artifact.initialCommit,
        fingerprint: artifact.initialFingerprint,
        dev: artifact.initialDev,
        ino: artifact.initialIno
      }, `${label} initial identity`);
    }
    normalizedIdentity({
      commit: artifact.targetCommit,
      fingerprint: artifact.targetFingerprint,
      dev: artifact.targetDev,
      ino: artifact.targetIno
    }, `${label} target identity`);
  }
}

function validateManifestPaths(manifest: UpdateRecoveryManifest, policy: UpdateRecoveryPolicy): void {
  if (manifest.app.targetPath !== policy.expectedAppPath) {
    throw new UpdateRecoveryValidationError("The recovery manifest app path is not the exact allowlisted app path.");
  }
  validateArtifactTopology(manifest.app, "app");
  const runtimeTargets = manifest.runtimes.map((runtime) => runtime.targetPath);
  if (new Set(runtimeTargets).size !== runtimeTargets.length || !sameStringSet(runtimeTargets, policy.expectedRuntimePaths)) {
    throw new UpdateRecoveryValidationError("The recovery manifest runtime paths do not exactly match the supplied allowlist.");
  }
  manifest.runtimes.forEach((runtime) => validateArtifactTopology(runtime, "runtime"));
  if (manifest.stateSnapshot.dataDir !== policy.expectedDataDir) {
    throw new UpdateRecoveryValidationError("The recovery manifest state directory is not the exact allowlisted data directory.");
  }
  const expectedSnapshotRoot = join(policy.updaterDir, `state-before-update-${manifest.attemptId}`);
  if (manifest.stateSnapshot.root !== expectedSnapshotRoot || !isStrictDescendant(expectedSnapshotRoot, policy.updaterDir)) {
    throw new UpdateRecoveryValidationError("The recovery manifest snapshot root is outside its exact updater location.");
  }
  if (manifest.stateSnapshot.manifestPath !== join(expectedSnapshotRoot, UPDATE_STATE_ROLLBACK_WAL_FILENAME)) {
    throw new UpdateRecoveryValidationError("The recovery manifest state WAL path is invalid.");
  }
  const expectedPolicyPath = join(policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  const expectedBundleRoot = join(policy.updaterDir, UPDATE_RECOVERY_RUNTIME_DIRNAME);
  if (manifest.recovery.policyPath !== expectedPolicyPath
    || !isSha256(manifest.recovery.policySha256)
    || manifest.recovery.bundleRoot !== expectedBundleRoot
    || manifest.recovery.packagePath !== join(expectedBundleRoot, UPDATE_RECOVERY_PACKAGE_RELATIVE_PATH)
    || manifest.recovery.scriptPath !== join(expectedBundleRoot, UPDATE_RECOVERY_SCRIPT_RELATIVE_PATH)
    || manifest.recovery.modulePath !== join(expectedBundleRoot, UPDATE_RECOVERY_MODULE_RELATIVE_PATH)
    || manifest.recovery.helperPath !== join(expectedBundleRoot, UPDATE_RECOVERY_HELPER_RELATIVE_PATH)) {
    throw new UpdateRecoveryValidationError("The recovery manifest stable runtime paths are invalid.");
  }
  exactAbsolutePath(manifest.recovery.nodePath, "manifest recovery Node executable");
  exactAbsolutePath(manifest.recovery.gitPath, "manifest recovery Git executable");
}

function validateArtifactTopology(artifact: UpdateRecoveryArtifact, label: string): void {
  if (artifact.nextPath !== `${artifact.targetPath}.vigil-next`
    || artifact.previousPath !== `${artifact.targetPath}.vigil-previous`
    || artifact.journalPath !== `${artifact.targetPath}.vigil-transaction.json`) {
    throw new UpdateRecoveryValidationError(`The ${label} recovery topology is not exact.`);
  }
}

function validateTimestamps(manifest: UpdateRecoveryManifest): void {
  const { startedAt, updatedAt, commitIntentAt, committedAt } = manifest.timestamps;
  const started = timestampValue(startedAt);
  const updated = timestampValue(updatedAt);
  if (started === null || updated === null || updated < started) {
    throw new UpdateRecoveryValidationError("The recovery manifest timestamps are invalid.");
  }
  for (const [label, value] of [["commit intent", commitIntentAt], ["commit", committedAt]] as const) {
    if (value !== null) {
      const parsed = timestampValue(value);
      if (parsed === null || parsed < started || parsed > updated) {
        throw new UpdateRecoveryValidationError(`The recovery manifest ${label} timestamp is invalid.`);
      }
    }
  }
  if ((manifest.state === "commit-intent" || manifest.state === "committed") && commitIntentAt === null) {
    throw new UpdateRecoveryValidationError("The recovery manifest is missing its commit-intent timestamp.");
  }
  if (manifest.state === "committed" && committedAt === null) {
    throw new UpdateRecoveryValidationError("The recovery manifest is missing its committed timestamp.");
  }
}

function validatedStateWal(
  value: unknown,
  manifest: UpdateRecoveryManifest,
  policy: UpdateRecoveryPolicy
): StateRollbackWal {
  if (!isRecord(value)
    || value.version !== UPDATE_RECOVERY_VERSION
    || value.attemptId !== manifest.attemptId
    || value.dataDir !== policy.expectedDataDir
    || value.snapshotRoot !== manifest.stateSnapshot.root
    || (value.state !== "ready" && value.state !== "rolling-back" && value.state !== "restored")
    || !validTimestamp(value.createdAt)
    || !validTimestamp(value.updatedAt)
    || !Array.isArray(value.entries)) {
    throw new UpdateRecoveryValidationError("The durable state rollback WAL is invalid.");
  }
  if (value.entries.length !== UPDATE_TRANSACTION_STATE_FILES.length) {
    throw new UpdateRecoveryValidationError("The state rollback WAL does not cover every allowlisted state file.");
  }
  const names = new Set<string>();
  for (const rawEntry of value.entries) {
    if (!isRecord(rawEntry) || !UPDATE_TRANSACTION_STATE_FILES.includes(rawEntry.name as UpdateTransactionStateFile)) {
      throw new UpdateRecoveryValidationError("The state rollback WAL contains an unknown state entry.");
    }
    const name = rawEntry.name as UpdateTransactionStateFile;
    if (names.has(name)) throw new UpdateRecoveryValidationError("The state rollback WAL contains duplicate state entries.");
    names.add(name);
    if (rawEntry.destinationPath !== join(policy.expectedDataDir, name)
      || rawEntry.backupPath !== join(manifest.stateSnapshot.root, "files", name)
      || (rawEntry.original !== "present" && rawEntry.original !== "missing")
      || (rawEntry.status !== "captured" && rawEntry.status !== "restoring" && rawEntry.status !== "restored")) {
      throw new UpdateRecoveryValidationError(`The state rollback WAL entry for ${name} is invalid.`);
    }
    if (rawEntry.original === "present") {
      if (!isSha256(rawEntry.sha256) || !isFileMode(rawEntry.mode)) {
        throw new UpdateRecoveryValidationError(`The state rollback WAL entry for ${name} lacks its durable preimage.`);
      }
    } else if (rawEntry.sha256 !== null || rawEntry.mode !== null) {
      throw new UpdateRecoveryValidationError(`The absent state rollback WAL entry for ${name} carries a preimage.`);
    }
  }
  return value as unknown as StateRollbackWal;
}

function validatedOutcome(value: unknown): UpdateRecoveryOutcome {
  if (!isRecord(value)
    || value.version !== UPDATE_RECOVERY_VERSION
    || !validOutcomeStatus(value.status)
    || !validTimestamp(value.recoveredAt)
    || typeof value.message !== "string"
    || value.message.length < 1
    || value.message.length > 16 * 1024
    || typeof value.sourceSyncPending !== "boolean") {
    throw new UpdateRecoveryValidationError("The Vigil update recovery outcome is invalid.");
  }
  updateAttemptId(value.attemptId);
  if (value.installedIdentity !== null) {
    normalizedIdentity(value.installedIdentity as UpdateArtifactIdentity, "installed recovery identity");
  }
  return value as unknown as UpdateRecoveryOutcome;
}

async function removeSnapshotRoot(manifest: UpdateRecoveryManifest, policy: UpdateRecoveryPolicy): Promise<void> {
  validateManifestPaths(manifest, policy);
  try {
    const value = await lstat(manifest.stateSnapshot.root);
    if (!value.isDirectory() || value.isSymbolicLink()) {
      throw new UpdateRecoveryValidationError("The state snapshot root is unsafe and was preserved.");
    }
    await rm(manifest.stateSnapshot.root, { recursive: true, force: true });
    await syncDirectory(dirname(manifest.stateSnapshot.root));
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function removeOrphanStateSnapshots(policy: UpdateRecoveryPolicy): Promise<void> {
  const prefix = "state-before-update-";
  let removed = false;
  for (const name of await readdir(policy.updaterDir)) {
    if (!name.startsWith(prefix)) continue;
    const attemptId = name.slice(prefix.length);
    updateAttemptId(attemptId);
    const root = join(policy.updaterDir, name);
    const value = await lstat(root);
    const uid = process.getuid?.();
    if (!value.isDirectory()
      || value.isSymbolicLink()
      || (value.mode & 0o077) !== 0
      || (uid !== undefined && value.uid !== uid)) {
      throw new UpdateRecoveryValidationError(`The orphan state snapshot ${root} is unsafe and was preserved.`);
    }
    await rm(root, { recursive: true, force: true });
    removed = true;
  }
  if (removed) await syncDirectory(policy.updaterDir);
}

async function withRecoveryLock<T>(
  policy: UpdateRecoveryPolicy,
  operations: UpdateRecoveryOperations,
  dependencies: UpdateRecoveryDependencies,
  operation: () => Promise<T>
): Promise<T> {
  await assertPolicyFilesystemBoundaries(policy);
  await ensureSafeDirectory(policy.updaterDir, true);
  const lockPath = updateRecoveryPaths(policy.updaterDir).lockPath;
  const token = randomUUID();
  const processStartedAt = await operations.processIdentity(process.pid);
  if (!processStartedAt) throw new UpdateRecoveryValidationError("Vigil could not establish the recovery process identity.");
  const lock: RecoveryLockRecord = {
    version: UPDATE_RECOVERY_VERSION,
    token,
    pid: process.pid,
    processStartedAt,
    createdAt: timestamp(operations.now(), "recovery lock creation")
  };
  const deadline = Date.now() + (dependencies.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  const pollMs = dependencies.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const incompleteGraceMs = dependencies.incompleteLockGraceMs ?? INCOMPLETE_LOCK_GRACE_MS;
  let acquired = false;
  do {
    try {
      await createExclusivePrivateJson(lockPath, lock);
      acquired = true;
      break;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (await quarantineStaleRecoveryLock(lockPath, operations, incompleteGraceMs, lock)) continue;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, pollMs));
    }
  } while (Date.now() < deadline);
  if (!acquired) throw new UpdateRecoveryBusyError();
  try {
    return await operation();
  } finally {
    await releaseRecoveryLock(lockPath, lock, operations).catch(() => undefined);
  }
}

async function quarantineStaleRecoveryLock(
  path: string,
  operations: UpdateRecoveryOperations,
  incompleteGraceMs: number,
  replacementGuard: RecoveryLockRecord
): Promise<boolean> {
  const pinned = await openPinnedFile(path).catch((error) => {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!pinned) return false;
  try {
    assertPrivatePinnedFile(pinned, "recovery lock");
    let owner: RecoveryLockRecord | null = null;
    try {
      owner = validatedLockRecord(JSON.parse(pinned.raw));
    } catch {
      if (Date.now() - pinned.mtimeMs < incompleteGraceMs) return false;
    }
    if (owner) {
      let currentIdentity = await operations.processIdentity(owner.pid);
      if (currentIdentity === owner.processStartedAt) return false;
      if (currentIdentity === null) {
        if (Date.now() - pinned.mtimeMs < incompleteGraceMs) return false;
        for (let confirmation = 0; confirmation < 2 && currentIdentity === null; confirmation += 1) {
          await new Promise<void>((resolveWait) => setTimeout(resolveWait, DEFAULT_LOCK_POLL_MS));
          currentIdentity = await operations.processIdentity(owner.pid);
        }
        // Three post-grace failures are the bounded evidence that the PID no
        // longer has an observable process identity.
        if (currentIdentity === owner.processStartedAt) return false;
      }
    }
    return await quarantinePinnedFile(path, pinned, "stale", replacementGuard, operations);
  } finally {
    await pinned.handle.close().catch(() => undefined);
  }
}

async function releaseRecoveryLock(
  path: string,
  lock: RecoveryLockRecord,
  operations: UpdateRecoveryOperations
): Promise<void> {
  const pinned = await openPinnedFile(path).catch((error) => {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (!pinned) return;
  try {
    assertPrivatePinnedFile(pinned, "recovery lock");
    const owner = validatedLockRecord(JSON.parse(pinned.raw));
    if (owner.token !== lock.token) return;
    await quarantinePinnedFile(path, pinned, "released", lock, operations);
  } finally {
    await pinned.handle.close().catch(() => undefined);
  }
}

async function quarantinePinnedFile(
  path: string,
  pinned: PinnedFile,
  suffix: string,
  replacementGuard: RecoveryLockRecord,
  operations: UpdateRecoveryOperations
): Promise<boolean> {
  const quarantinePath = `${path}.${suffix}.${Date.now()}.${randomUUID()}`;
  const guardNonce = randomUUID();
  const nonOwnerGuard: RecoveryLockRecord = {
    ...replacementGuard,
    token: `quarantine-${guardNonce}`,
    processStartedAt: `non-owner-guard-${guardNonce}`
  };
  await createExclusivePrivateJson(quarantinePath, nonOwnerGuard);
  const guard = await lstat(quarantinePath);
  try {
    await operations.swapPaths(path, quarantinePath);
  } catch (error) {
    await removeFileWithIdentity(quarantinePath, guard.dev, guard.ino).catch(() => undefined);
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  const displaced = await lstat(quarantinePath).catch(() => null);
  if (!displaced || displaced.dev !== pinned.dev || displaced.ino !== pinned.ino) {
    await operations.swapPaths(path, quarantinePath);
    const [restored, returnedGuard] = await Promise.all([
      lstat(path),
      lstat(quarantinePath)
    ]);
    if (!displaced
      || restored.dev !== displaced.dev
      || restored.ino !== displaced.ino
      || returnedGuard.dev !== guard.dev
      || returnedGuard.ino !== guard.ino) {
      throw new UpdateRecoveryValidationError("The recovery lock changed during atomic stale-lock reconciliation and was preserved.");
    }
    await removeFileWithIdentity(quarantinePath, guard.dev, guard.ino);
    await syncDirectory(dirname(path));
    return false;
  }
  const installedGuard = await lstat(path);
  if (installedGuard.dev !== guard.dev || installedGuard.ino !== guard.ino) {
    throw new UpdateRecoveryValidationError("The recovery lock guard changed during atomic stale-lock reconciliation.");
  }
  await removeFileWithIdentity(quarantinePath, pinned.dev, pinned.ino);
  await removeFileWithIdentity(path, guard.dev, guard.ino);
  await syncDirectory(dirname(path));
  return true;
}

async function removeFileWithIdentity(path: string, dev: number, ino: number): Promise<void> {
  const value = await lstat(path);
  if (!value.isFile() || value.isSymbolicLink() || value.dev !== dev || value.ino !== ino) {
    throw new UpdateRecoveryValidationError(`The private recovery file ${path} changed before removal and was preserved.`);
  }
  await rm(path);
}

async function createExclusivePrivateJson(path: string, value: unknown): Promise<void> {
  let handle: FileHandle | null = null;
  let created = false;
  try {
    handle = await open(path, "wx", PRIVATE_FILE_MODE);
    created = true;
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await syncDirectory(dirname(path));
    created = false;
  } finally {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true }).catch(() => undefined);
  }
}

async function writeFsyncedFile(path: string, bytes: Buffer, mode: number): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function safeDirectoryExists(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    const uid = process.getuid?.();
    if (!value.isDirectory() || value.isSymbolicLink() || (uid !== undefined && value.uid !== uid)) {
      throw new UpdateRecoveryValidationError(`The recovery runtime directory ${path} is unsafe.`);
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function removeSafeRecoveryDirectoryIfPresent(path: string, updaterDir: string): Promise<void> {
  if (!isStrictDescendant(path, updaterDir)) {
    throw new UpdateRecoveryValidationError("Vigil refused to remove a recovery runtime outside the updater directory.");
  }
  if (!await safeDirectoryExists(path)) return;
  await rm(path, { recursive: true, force: true });
  await syncDirectory(dirname(path));
}

async function atomicWritePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await assertSafeReplaceTarget(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    created = true;
    try {
      await handle.writeFile(serializedJsonBytes(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    created = false;
    await syncDirectory(dirname(path));
  } finally {
    if (created) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function assertSafeReplaceTarget(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    const uid = process.getuid?.();
    if (!value.isFile() || value.isSymbolicLink() || (uid !== undefined && value.uid !== uid)) {
      throw new UpdateRecoveryValidationError(`The private recovery file ${path} is unsafe and was preserved.`);
    }
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function readPrivateJsonIfPresent(path: string): Promise<unknown | null> {
  return (await readPrivateJsonDocument(path))?.value ?? null;
}

async function readPrivateJsonDocument(path: string): Promise<{ value: unknown; raw: string } | null> {
  let pinned: PinnedFile | null = null;
  try {
    pinned = await openPinnedFile(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  try {
    assertPrivatePinnedFile(pinned, `recovery file ${path}`);
    return { value: JSON.parse(pinned.raw) as unknown, raw: pinned.raw };
  } catch {
    throw new UpdateRecoveryValidationError(`The private recovery file ${path} is malformed and was preserved.`);
  } finally {
    await pinned.handle.close().catch(() => undefined);
  }
}

async function openPinnedFile(path: string): Promise<PinnedFile> {
  const handle = await open(path, "r");
  try {
    const [descriptor, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (!pathname.isFile()
      || pathname.isSymbolicLink()
      || descriptor.dev !== pathname.dev
      || descriptor.ino !== pathname.ino) {
      throw new UpdateRecoveryValidationError(`The recovery file ${path} changed while it was opened.`);
    }
    if (descriptor.size > MAX_RECOVERY_FILE_BYTES) {
      throw new UpdateRecoveryValidationError(`The recovery file ${path} is oversized.`);
    }
    return {
      handle,
      dev: descriptor.dev,
      ino: descriptor.ino,
      uid: descriptor.uid,
      mode: descriptor.mode,
      mtimeMs: descriptor.mtimeMs,
      raw: await handle.readFile("utf8")
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readPinnedRegularFile(path: string, label: string): Promise<{ bytes: Buffer; mode: number; uid: number }> {
  const handle = await open(path, "r");
  try {
    const [descriptor, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (!descriptor.isFile()
      || !pathname.isFile()
      || pathname.isSymbolicLink()
      || descriptor.dev !== pathname.dev
      || descriptor.ino !== pathname.ino) {
      throw new UpdateRecoveryValidationError(`The ${label} is unsafe or changed while it was opened.`);
    }
    return { bytes: await handle.readFile(), mode: descriptor.mode, uid: descriptor.uid };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertPrivatePinnedFile(file: PinnedFile, label: string): void {
  const uid = process.getuid?.();
  if ((file.mode & 0o077) !== 0 || (uid !== undefined && file.uid !== uid)) {
    throw new UpdateRecoveryValidationError(`The ${label} is not private to the current user.`);
  }
}

function validatedLockRecord(value: unknown): RecoveryLockRecord {
  if (!isRecord(value)
    || value.version !== UPDATE_RECOVERY_VERSION
    || !validIdentifier(value.token)
    || !Number.isInteger(value.pid)
    || Number(value.pid) < 1
    || !validIdentifier(value.processStartedAt)
    || !validTimestamp(value.createdAt)) {
    throw new UpdateRecoveryValidationError("The Vigil recovery lock record is invalid.");
  }
  return value as unknown as RecoveryLockRecord;
}

async function ensureSafeDirectory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const value = await lstat(path);
  const uid = process.getuid?.();
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || (value.mode & 0o022) !== 0
    || (uid !== undefined && value.uid !== uid)) {
    throw new UpdateRecoveryValidationError(`The recovery directory ${path} is unsafe.`);
  }
}

async function removePrivateRegularFileIfPresent(path: string): Promise<void> {
  try {
    await removePrivateRegularFile(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function removePrivateRegularFile(path: string): Promise<void> {
  const value = await lstat(path);
  const uid = process.getuid?.();
  if (!value.isFile() || value.isSymbolicLink() || (uid !== undefined && value.uid !== uid)) {
    throw new UpdateRecoveryValidationError(`The private recovery file ${path} is unsafe and was preserved.`);
  }
  await rm(path);
  await syncDirectory(dirname(path));
}

async function privateRegularFileExists(path: string): Promise<boolean> {
  try {
    const value = await lstat(path);
    return value.isFile() && !value.isSymbolicLink();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function syncArtifactTree(path: string): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink()) return;
  if (value.isFile()) {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close().catch(() => undefined);
    }
    return;
  }
  if (!value.isDirectory()) {
    throw new UpdateRecoveryValidationError(`The staged artifact contains an unsupported filesystem entry at ${path}.`);
  }
  const children = await readdir(path);
  for (const child of children) await syncArtifactTree(join(path, child));
  await syncDirectory(path);
}

async function syncDirectory(path: string): Promise<void> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (!isErrorCode(error, "EINVAL") && !isErrorCode(error, "ENOTSUP") && !isErrorCode(error, "EISDIR")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function resolvedOperations(overrides: Partial<UpdateRecoveryOperations> | undefined): UpdateRecoveryOperations {
  return {
    identifyArtifact: overrides?.identifyArtifact || defaultIdentifyArtifact,
    copyPath: overrides?.copyPath || (async (source, destination) => await cp(source, destination, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true
    })),
    movePath: overrides?.movePath || (async (source, destination) => await rename(source, destination)),
    removePath: overrides?.removePath || (async (path) => await rm(path, { recursive: true, force: true })),
    swapPaths: overrides?.swapPaths || defaultAtomicSwap,
    syncArtifact: overrides?.syncArtifact || syncArtifactTree,
    syncDirectory: overrides?.syncDirectory || syncDirectory,
    cleanupJournal: overrides?.cleanupJournal || defaultCleanupJournal,
    readSourceHead: overrides?.readSourceHead || defaultReadSourceHead,
    readSourceBranch: overrides?.readSourceBranch || defaultReadSourceBranch,
    validateSourceTransition: overrides?.validateSourceTransition || defaultValidateSourceTransition,
    assertSourceWorktreeClean: overrides?.assertSourceWorktreeClean || defaultAssertSourceWorktreeClean,
    synchronizeSource: overrides?.synchronizeSource || defaultSynchronizeSource,
    restoreSource: overrides?.restoreSource || defaultRestoreSource,
    processIdentity: overrides?.processIdentity || defaultProcessIdentity,
    beforeStateEntryRestore: overrides?.beforeStateEntryRestore,
    now: overrides?.now || (() => new Date())
  };
}

async function defaultIdentifyArtifact(path: string, kind: UpdateArtifactKind): Promise<UpdateArtifactIdentity | null> {
  let value;
  try {
    value = await lstat(path);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (value.isSymbolicLink() || (!value.isDirectory() && !value.isFile())) {
    throw new UpdateRecoveryValidationError(`The ${kind} artifact at ${path} is unsafe.`);
  }
  const buildInfoPaths = kind === "app"
    ? [
        join(path, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
        join(path, "Contents", "Resources", "app.asar", "dist", "runtime", "build-info.json")
      ]
    : [join(path, "build-info.json")];
  let commit: string | null = null;
  let fingerprint: string | null = null;
  for (const buildInfoPath of buildInfoPaths) {
    const info = await safeReadBuildInfo(buildInfoPath);
    if (!info) continue;
    commit = nullableIdentifier(info.commit, "build commit");
    fingerprint = nullableIdentifier(info.sourceFingerprint, "build fingerprint");
    break;
  }
  const cdHash = kind === "app" ? await safeVerifiedAppCodeDirectoryHash(path) : null;
  const after = await lstat(path);
  if (after.isSymbolicLink() || after.dev !== value.dev || after.ino !== value.ino) {
    throw new UpdateRecoveryValidationError(`The ${kind} artifact at ${path} changed during identity capture.`);
  }
  return { commit, fingerprint, cdHash, dev: value.dev, ino: value.ino };
}

async function safeVerifiedAppCodeDirectoryHash(path: string): Promise<string | null> {
  try {
    await execFileText("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
    const first = await codeDirectoryHash(path);
    await execFileText("/usr/bin/codesign", ["--verify", "--deep", "--strict", path]);
    const second = await codeDirectoryHash(path);
    return first === second ? first : null;
  } catch {
    return null;
  }
}

async function codeDirectoryHash(path: string): Promise<string> {
  const output = await execFileOutput("/usr/bin/codesign", ["-dv", "--verbose=4", path]);
  const match = output.stderr.match(/^CDHash=([a-f0-9]+)$/imu)?.[1]?.toLowerCase();
  const cdHash = nullableCdHash(match, `CodeDirectory hash for ${path}`);
  if (!cdHash) throw new UpdateRecoveryValidationError(`The CodeDirectory hash for ${path} is missing.`);
  return cdHash;
}

async function safeReadBuildInfo(path: string): Promise<Record<string, unknown> | null> {
  let pinned: PinnedFile | null = null;
  try {
    pinned = await openPinnedFile(path);
    if (Buffer.byteLength(pinned.raw, "utf8") > MAX_BUILD_INFO_BYTES) return null;
    const parsed: unknown = JSON.parse(pinned.raw);
    return isRecord(parsed) ? parsed : null;
  } catch (error) {
    if (isErrorCode(error, "ENOENT") || isErrorCode(error, "ENOTDIR")) return null;
    return null;
  } finally {
    await pinned?.handle.close().catch(() => undefined);
  }
}

async function defaultAtomicSwap(left: string, right: string): Promise<void> {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vigil-atomic-swap");
  const helper = await lstat(helperPath);
  if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
    throw new Error("Vigil's atomic swap helper is missing or unsafe.");
  }
  await executeAtomicSwapHelper(helperPath, left, right);
}

async function executeAtomicSwapHelper(helperPath: string, left: string, right: string): Promise<void> {
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
      else rejectSwap(new Error(stderr.trim() || `Vigil's atomic swap helper exited with status ${code}.`));
    });
  });
}

async function verifyAtomicSwapHelper(helperPath: string, root: string): Promise<void> {
  const left = join(root, ".swap-probe-left");
  const right = join(root, ".swap-probe-right");
  await writeFsyncedFile(left, Buffer.from("left\n", "utf8"), PRIVATE_FILE_MODE);
  await writeFsyncedFile(right, Buffer.from("right\n", "utf8"), PRIVATE_FILE_MODE);
  await syncDirectory(root);
  const [leftBefore, rightBefore] = await Promise.all([lstat(left), lstat(right)]);
  try {
    await executeAtomicSwapHelper(helperPath, left, right);
    const [leftAfter, rightAfter] = await Promise.all([lstat(left), lstat(right)]);
    if (leftAfter.dev !== rightBefore.dev
      || leftAfter.ino !== rightBefore.ino
      || rightAfter.dev !== leftBefore.dev
      || rightAfter.ino !== leftBefore.ino) {
      throw new UpdateRecoveryValidationError("The stable atomic-swap helper failed its exact inode exchange probe.");
    }
  } finally {
    await rm(left, { force: true }).catch(() => undefined);
    await rm(right, { force: true }).catch(() => undefined);
    await syncDirectory(root).catch(() => undefined);
  }
}

async function defaultCleanupJournal(path: string): Promise<void> {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) {
      throw new UpdateRecoveryValidationError(`The artifact journal ${path} is unsafe and was preserved.`);
    }
    await rm(path);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

async function defaultReadSourceHead(repoRoot: string, gitPath: string): Promise<string> {
  return (await execFileText(gitPath, ["-C", repoRoot, "rev-parse", "HEAD"])).trim();
}

async function defaultReadSourceBranch(repoRoot: string, gitPath: string): Promise<string | null> {
  const branch = (await execFileText(gitPath, ["-C", repoRoot, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  return branch === "HEAD" ? null : sourceBranch(branch, "current source branch");
}

async function defaultValidateSourceTransition(
  repoRoot: string,
  initialCommit: string,
  initialBranch: string | null,
  targetCommit: string,
  gitPath: string
): Promise<void> {
  const [current, branch] = await Promise.all([
    defaultReadSourceHead(repoRoot, gitPath),
    defaultReadSourceBranch(repoRoot, gitPath)
  ]);
  if (current !== initialCommit || branch !== initialBranch) {
    throw new UpdateRecoveryValidationError("The source checkout no longer matches the transaction's exact initial commit and branch.");
  }
  const [resolvedInitial, resolvedTarget] = await Promise.all([
    execFileText(gitPath, ["-C", repoRoot, "rev-parse", "--verify", `${initialCommit}^{commit}`]),
    execFileText(gitPath, ["-C", repoRoot, "rev-parse", "--verify", `${targetCommit}^{commit}`])
  ]);
  if (resolvedInitial.trim() !== initialCommit || resolvedTarget.trim() !== targetCommit) {
    throw new UpdateRecoveryValidationError("The exact source commits could not be resolved for durable recovery.");
  }
  if (initialCommit !== targetCommit) {
    await execFileText(gitPath, ["-C", repoRoot, "merge-base", "--is-ancestor", initialCommit, targetCommit]);
  }
}

async function defaultAssertSourceWorktreeClean(repoRoot: string, gitPath: string): Promise<void> {
  const status = await execFileText(gitPath, ["-C", repoRoot, "status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.trim()) {
    throw new UpdateRecoveryValidationError("The source checkout or index is mixed after Git recovery; concurrent edits were preserved.");
  }
}

async function defaultSynchronizeSource(
  repoRoot: string,
  expectedCurrentCommit: string,
  expectedBranch: string | null,
  targetCommit: string,
  gitPath: string
): Promise<void> {
  const [current, branch] = await Promise.all([
    defaultReadSourceHead(repoRoot, gitPath),
    defaultReadSourceBranch(repoRoot, gitPath)
  ]);
  if (current !== expectedCurrentCommit || branch !== expectedBranch) {
    throw new Error("the source checkout changed before fast-forward synchronization");
  }
  await execFileText(gitPath, ["-C", repoRoot, "merge", "--ff-only", "--no-edit", targetCommit]);
}

async function defaultRestoreSource(
  repoRoot: string,
  expectedCurrentCommit: string,
  expectedBranch: string | null,
  initialCommit: string,
  gitPath: string
): Promise<void> {
  const [current, branch] = await Promise.all([
    defaultReadSourceHead(repoRoot, gitPath),
    defaultReadSourceBranch(repoRoot, gitPath)
  ]);
  if (current !== expectedCurrentCommit || branch !== expectedBranch) {
    throw new Error("the source checkout changed before rollback");
  }
  await execFileText(gitPath, ["-C", repoRoot, "reset", "--keep", initialCommit]);
}

async function defaultProcessIdentity(pid: number): Promise<string | null> {
  return await new Promise<string | null>((resolveIdentity, rejectIdentity) => {
    execFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const identity = String(stdout).trim();
        if (!error) {
          if (!identity) {
            rejectIdentity(new Error("Process inspection succeeded without returning an identity."));
            return;
          }
          resolveIdentity(identity);
          return;
        }
        if (typeof error.code === "number"
          && error.code === 1
          && !identity
          && !String(stderr).trim()
          && !error.killed
          && !error.signal) {
          resolveIdentity(null);
          return;
        }
        rejectIdentity(new Error(String(stderr).trim() || `Process identity inspection failed: ${error.message}`));
      }
    );
  });
}

async function execFileText(command: string, args: readonly string[]): Promise<string> {
  return await new Promise<string>((resolveCommand, rejectCommand) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectCommand(new Error(String(stderr || "").trim() || error.message));
        return;
      }
      resolveCommand(String(stdout));
    });
  });
}

async function execFileOutput(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await new Promise<{ stdout: string; stderr: string }>((resolveCommand, rejectCommand) => {
    execFile(command, [...args], { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        rejectCommand(new Error(String(stderr || "").trim() || error.message));
        return;
      }
      resolveCommand({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

async function verifyExecutableVersion(path: string, kind: "node" | "git"): Promise<void> {
  let output: string;
  try {
    output = (await execFileText(path, ["--version"])).trim();
  } catch (error) {
    throw new UpdateRecoveryValidationError(`The bound recovery ${kind} executable could not run: ${errorMessage(error)}`);
  }
  const valid = kind === "node" ? /^v\d+(?:\.|$)/u.test(output) : /^git version \d+(?:\.|$)/u.test(output);
  if (!valid) throw new UpdateRecoveryValidationError(`The bound recovery ${kind} executable returned an invalid version.`);
}

function exactAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !isAbsolute(value) || resolve(value) !== value || value.includes("\u0000")) {
    throw new UpdateRecoveryValidationError(`The ${label} must be an exact absolute path.`);
  }
  return value;
}

function isStrictDescendant(path: string, root: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(child);
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || isStrictDescendant(left, right) || isStrictDescendant(right, left);
}

function artifactTopologyPaths(targetPath: string): string[] {
  return [
    targetPath,
    `${targetPath}.vigil-next`,
    `${targetPath}.vigil-previous`,
    `${targetPath}.vigil-transaction.json`
  ];
}

async function assertPolicyFilesystemBoundaries(policy: UpdateRecoveryPolicy): Promise<void> {
  for (const [label, path] of [
    ["updater directory", policy.updaterDir],
    ["app target", policy.expectedAppPath],
    ["repository root", policy.repoRoot],
    ["user data directory", policy.userDataDir],
    ["state data directory", policy.expectedDataDir],
    ...policy.expectedRuntimePaths.map((path) => ["runtime target", path] as const)
  ] as const) {
    await assertPathHasNoSymlinkAncestors(path, label);
  }
}

async function assertPathHasNoSymlinkAncestors(path: string, label: string): Promise<void> {
  let candidate = path;
  for (;;) {
    try {
      const resolvedPath = await realpath(candidate);
      if (resolvedPath !== candidate) {
        throw new UpdateRecoveryValidationError(`The ${label} contains a symbolic-link or non-canonical filesystem ancestor.`);
      }
      return;
    } catch (error) {
      if (!isErrorCode(error, "ENOENT") && !isErrorCode(error, "ENOTDIR")) throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw new UpdateRecoveryValidationError(`The ${label} has no trustworthy existing filesystem ancestor.`);
      candidate = parent;
    }
  }
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function updateAttemptId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new UpdateRecoveryValidationError("The update recovery attempt ID is invalid.");
  }
  return value;
}

function identifier(value: unknown, label: string): string {
  if (!validIdentifier(value)) throw new UpdateRecoveryValidationError(`The ${label} is invalid.`);
  return value;
}

function gitObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
    throw new UpdateRecoveryValidationError(`The ${label} must be a full immutable Git object ID.`);
  }
  return value;
}

function sourceBranch(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string"
    || value === "HEAD"
    || value.length === 0
    || value.length > 1_024
    || /[\u0000\r\n]/u.test(value)) {
    throw new UpdateRecoveryValidationError(`The ${label} is invalid; detached HEAD must be represented explicitly.`);
  }
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  return identifier(value, label);
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/u.test(value);
}

function nullableNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new UpdateRecoveryValidationError(`The ${label} is invalid.`);
  return Number(value);
}

function nullablePositiveInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new UpdateRecoveryValidationError(`The ${label} is invalid.`);
  return Number(value);
}

function timestamp(value: Date, label: string): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) throw new UpdateRecoveryValidationError(`The ${label} timestamp is invalid.`);
  return value.toISOString();
}

function monotonicTimestamp(previous: string, now: Date): string {
  const current = timestamp(now, "recovery update");
  return Date.parse(current) < Date.parse(previous) ? previous : current;
}

function timestampValue(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function validTimestamp(value: unknown): value is string {
  return timestampValue(value) !== null;
}

function validRecoveryState(value: unknown): value is UpdateRecoveryState {
  return value === "pending" || value === "commit-intent" || value === "committed" || value === "rolling-back";
}

function validOutcomeStatus(value: unknown): value is UpdateRecoveryOutcomeStatus {
  return value === "complete" || value === "failed-recovered" || value === "recovery-failed";
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isFileMode(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0o777;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function serializedJsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function boundedMessage(value: string): string {
  const withoutNulls = value.replaceAll("\u0000", "");
  return withoutNulls.length <= 16 * 1024 ? withoutNulls : `${withoutNulls.slice(0, 16 * 1024 - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
