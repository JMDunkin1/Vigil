import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_OUTCOME_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME,
  UPDATE_RECOVERY_RUNTIME_DIRNAME,
  UPDATE_STATE_ROLLBACK_WAL_FILENAME,
  UPDATE_TRANSACTION_STATE_FILES,
  UpdateRecoveryValidationError,
  activateStagedUpdateArtifact,
  beginUpdateRecoveryTransaction,
  markUpdateRecoveryCommitIntent,
  markUpdateRecoveryCommitted,
  readUpdateRecoveryManifest,
  readUpdateRecoveryOutcome,
  readUpdateRecoveryPolicyFile,
  reconcileStagedUpdateArtifactCandidate,
  recoverUpdateTransaction,
  stageUpdateArtifactCandidate,
  updateArtifactIdentitiesExactlyMatch
} from "../src/updateTransaction.js";
import type {
  BeginUpdateRecoveryInput,
  UpdateArtifactIdentity,
  UpdateArtifactKind,
  UpdateRecoveryDependencies,
  UpdateRecoveryOperations,
  UpdateRecoveryPolicy
} from "../src/updateTransaction.js";

interface Fixture {
  root: string;
  policy: UpdateRecoveryPolicy;
  input: BeginUpdateRecoveryInput;
  appPath: string;
  runtimePath: string | null;
  dataDir: string;
  source: { head: string; branch: string | null; restoreCalls: number; dirty: boolean };
  dependencies: UpdateRecoveryDependencies;
  operations: UpdateRecoveryOperations;
}

const roots: string[] = [];
const SOURCE_INITIAL = "1111111111111111111111111111111111111111";
const SOURCE_TARGET = "2222222222222222222222222222222222222222";
const SOURCE_OTHER = "3333333333333333333333333333333333333333";

try {
  await verifyExactNextCandidateIdentityIsActivatedWithoutRecopy();
  await verifyInterruptedPrestageIsDurablyReconciled();
  await verifyPrestageTamperingAndMissingEvidenceFailClosed();
  await verifyPendingRollbackAndDurableStateWal();
  await verifyCommitIntentRollsForwardOnlyWithCompleteEvidence();
  await verifyHealthyArtifactsSynchronizeSourceBeforeCompletion();
  await verifyFailedSourceSynchronizationRemainsDurablyRetryable();
  await verifyRecoveryRejectsSameCommitBranchSwitch();
  await verifyCommitIntentMismatchRollsEverythingBack();
  await verifyCommittedRecoveryFinishesPreparedTopology();
  await verifyStateRollbackWalRetriesAfterInterruption();
  await verifyAmbiguousIdentityFailsClosed();
  await verifyContradictoryInodeAndContentFailsClosed();
  verifyExactIdentityComparisonRejectsPartialAgreement();
  await verifyRecoveryLockSerializesConcurrentCallers();
  await verifyLiveRuntimeModeNeverSwapsCanonicalArtifacts();
  await verifyTamperedAllowlistedPathIsPreserved();
  await verifyPolicyAndStableBundleTamperingFailClosed();
  await verifyStableRecoveryCliExecutesAsEsm();
  console.log("update transaction recovery tests passed");
} finally {
  await Promise.all(roots.map(async (root) => await rm(root, { recursive: true, force: true })));
}

async function verifyExactNextCandidateIdentityIsActivatedWithoutRecopy(): Promise<void> {
  const fixture = await createFixture("stage-exact-next", false);
  const source = join(fixture.root, "build", "Vigil.app");
  const target = fixture.appPath;
  await rm(`${target}.vigil-next`, { recursive: true, force: true });
  await rm(`${target}.vigil-transaction.json`, { force: true });
  await writeArtifact(source, "target-app", "target-fingerprint");
  const durabilityEvents: string[] = [];
  const dependencies: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    operations: {
      ...fixture.dependencies.operations,
      identifyArtifact: artifactIdentity,
      async copyPath(from, to) {
        durabilityEvents.push("copy");
        await cp(from, to, { recursive: true });
      },
      async syncArtifact() {
        durabilityEvents.push("sync-artifact");
      },
      async syncDirectory() {
        durabilityEvents.push("sync-directory");
      }
    }
  };
  const plan = await stageUpdateArtifactCandidate(
    fixture.policy,
    fixture.input.attemptId,
    source,
    target,
    "app",
    dependencies
  );
  assert.deepEqual(durabilityEvents, ["copy", "sync-artifact", "sync-directory"],
    "the exact next candidate and its parent directory must be durable before its identity is returned");
  const exactNext = await requiredIdentity(`${target}.vigil-next`, "app");
  assert.deepEqual(plan.targetIdentity, exactNext, "the transaction must capture the identity of the exact .vigil-next copy");
  const input: BeginUpdateRecoveryInput = { ...fixture.input, app: plan };
  await beginUpdateRecoveryTransaction(fixture.policy, input, dependencies);
  await writeFile(join(source, "identity.json"), `${JSON.stringify({
    commit: "changed-build-directory",
    fingerprint: "changed-build-directory-fingerprint"
  })}\n`);
  const installed = await activateStagedUpdateArtifact(
    fixture.policy,
    input.attemptId,
    plan,
    "app",
    dependencies
  );
  assert.equal(durabilityEvents.filter((event) => event === "sync-directory").length, 3,
    "activation must sync the swap and previous-generation move before returning");
  assert.equal(installed.ino, plan.targetIdentity.ino, "activation must preserve the staged candidate inode");
  assert.equal(installed.commit, "target-app", "activation must never recopy a later-mutated build directory");
  assert.equal((await requiredIdentity(`${target}.vigil-previous`, "app")).ino, plan.initialIdentity?.ino);
}

async function verifyInterruptedPrestageIsDurablyReconciled(): Promise<void> {
  const fixture = await createFixture("prestage-retry", false);
  const source = join(fixture.root, "build", "Vigil.app");
  await writeArtifact(source, "target-app", "target-app-fingerprint");
  await reconcileStagedUpdateArtifactCandidate(fixture.policy, fixture.appPath, "app", fixture.dependencies);
  let observedPreparingJournal = false;
  const interruptedDependencies: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    operations: {
      ...fixture.dependencies.operations,
      async copyPath(_from, to) {
        const journal = JSON.parse(await readFile(`${fixture.appPath}.vigil-transaction.json`, "utf8")) as {
          phase: string;
          candidateDevice?: number;
        };
        observedPreparingJournal = journal.phase === "preparing" && journal.candidateDevice === undefined;
        await mkdir(to, { recursive: true });
        await writeFile(join(to, "partial-copy"), "interrupted\n");
        throw new Error("injected staging interruption");
      }
    }
  };
  await assert.rejects(
    stageUpdateArtifactCandidate(
      fixture.policy,
      fixture.input.attemptId,
      source,
      fixture.appPath,
      "app",
      interruptedDependencies
    ),
    /injected staging interruption/u
  );
  assert.equal(observedPreparingJournal, true, "the private preparation journal must be durable before candidate copy starts");
  assert.equal((JSON.parse(await readFile(`${fixture.appPath}.vigil-transaction.json`, "utf8")) as { phase: string }).phase, "preparing");

  const plan = await stageUpdateArtifactCandidate(
    fixture.policy,
    fixture.input.attemptId,
    source,
    fixture.appPath,
    "app",
    fixture.dependencies
  );
  assert.equal(plan.targetIdentity.commit, "target-app", "a retry must safely remove journal-owned partial residue and restage");
  assert.equal((JSON.parse(await readFile(`${fixture.appPath}.vigil-transaction.json`, "utf8")) as { phase: string }).phase, "prepared");

  await beginUpdateRecoveryTransaction(fixture.policy, { ...fixture.input, app: plan }, fixture.dependencies);
  await assert.rejects(
    reconcileStagedUpdateArtifactCandidate(fixture.policy, fixture.appPath, "app", fixture.dependencies),
    /global update transaction/u,
    "prestage cleanup must never touch residue after the global manifest takes ownership"
  );
  assert.ok(await lstat(`${fixture.appPath}.vigil-next`));
}

async function verifyPrestageTamperingAndMissingEvidenceFailClosed(): Promise<void> {
  const tampered = await createFixture("prestage-tamper", false);
  await rm(`${tampered.appPath}.vigil-next`, { recursive: true, force: true });
  await writeArtifact(`${tampered.appPath}.vigil-next`, "unknown-candidate", "unknown-candidate-fingerprint");
  await assert.rejects(
    reconcileStagedUpdateArtifactCandidate(tampered.policy, tampered.appPath, "app", tampered.dependencies),
    /candidate identity changed/u
  );
  assert.equal((await requiredIdentity(`${tampered.appPath}.vigil-next`, "app")).commit, "unknown-candidate",
    "candidate residue with a changed identity must be preserved");

  const unjournaled = await createFixture("prestage-no-journal", false);
  await rm(`${unjournaled.appPath}.vigil-transaction.json`);
  await assert.rejects(
    beginUpdateRecoveryTransaction(unjournaled.policy, unjournaled.input, unjournaled.dependencies),
    /no durable preparation journal/u,
    "the global manifest must never adopt an unjournaled candidate"
  );
  assert.equal((await requiredIdentity(`${unjournaled.appPath}.vigil-next`, "app")).commit, "target-app");
}

async function verifyPendingRollbackAndDurableStateWal(): Promise<void> {
  const fixture = await createFixture("pending", true);
  const orphanSnapshot = join(fixture.policy.updaterDir, "state-before-update-orphan-attempt");
  await mkdir(orphanSnapshot, { mode: 0o700 });
  await writeFile(join(orphanSnapshot, "interrupted-preimage"), "secret\n", { mode: 0o600 });
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await assert.rejects(lstat(orphanSnapshot), { code: "ENOENT" }, "a manifest-less state preimage must be removed on retry");
  const manifestPath = join(fixture.policy.updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  assert.equal((await stat(manifestPath)).mode & 0o777, 0o600, "the global recovery manifest must be private");
  const manifest = await readUpdateRecoveryManifest(fixture.policy);
  assert.ok(manifest);
  await assert.rejects(
    beginUpdateRecoveryTransaction(fixture.policy, {
      ...fixture.input,
      source: { ...fixture.input.source, targetCommit: SOURCE_OTHER }
    }, fixture.dependencies),
    /different Vigil update transaction/u,
    "an attempt ID must not make a materially different begin request idempotent"
  );
  const policyPath = join(fixture.policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  const loadedPolicy = await readUpdateRecoveryPolicyFile(policyPath);
  assert.equal((await stat(policyPath)).mode & 0o777, 0o600, "the exact recovery allowlist must be private");
  assert.equal(loadedPolicy.record.attemptId, fixture.input.attemptId);
  assert.equal(loadedPolicy.sha256, manifest.recovery.policySha256, "the manifest must bind the exact private policy bytes");
  assert.equal(loadedPolicy.record.recoveryRuntime.root, join(fixture.policy.updaterDir, UPDATE_RECOVERY_RUNTIME_DIRNAME));
  const wal = JSON.parse(await readFile(join(manifest.stateSnapshot.root, UPDATE_STATE_ROLLBACK_WAL_FILENAME), "utf8")) as {
    entries: Array<{ name: string; original: string }>;
  };
  assert.deepEqual(wal.entries.map((entry) => entry.name), [...UPDATE_TRANSACTION_STATE_FILES]);
  assert.equal(wal.entries.find((entry) => entry.name === "runtime-interruption.json")?.original, "present",
    "the runtime interruption receipt must be part of the durable rollback preimage");

  await installTargetTopology(fixture.appPath);
  if (fixture.runtimePath) await installTargetTopology(fixture.runtimePath);
  await writeFile(join(fixture.dataDir, "state.json"), "new-state\n");
  await writeFile(join(fixture.dataDir, "runtime-interruption.json"), "new-interruption\n");
  await writeFile(join(fixture.dataDir, "usage.json"), "created-during-update\n");

  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "failed-recovered");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "initial-app");
  assert.equal((await artifactIdentity(fixture.runtimePath!, "runtime"))?.commit, "initial-runtime");
  assert.equal(await readFile(join(fixture.dataDir, "state.json"), "utf8"), "old-state\n");
  assert.equal(await readFile(join(fixture.dataDir, "runtime-interruption.json"), "utf8"), "old-interruption\n");
  await assert.rejects(lstat(join(fixture.dataDir, "usage.json")), { code: "ENOENT" });
  await assert.rejects(lstat(manifestPath), { code: "ENOENT" });
  const outcomePath = join(fixture.policy.updaterDir, UPDATE_RECOVERY_OUTCOME_FILENAME);
  assert.equal((await stat(outcomePath)).mode & 0o777, 0o600, "the reconciliation outcome must be private");
  assert.deepEqual(await recoverUpdateTransaction(fixture.policy, fixture.dependencies), outcome,
    "a completed recovery must be idempotently discoverable from its durable outcome");
}

async function verifyCommitIntentRollsForwardOnlyWithCompleteEvidence(): Promise<void> {
  const fixture = await createFixture("intent-forward", true);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await installTargetTopology(fixture.runtimePath!);
  await writeFile(join(fixture.dataDir, "state.json"), "verified-new-state\n");
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);

  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "complete");
  assert.equal(outcome?.installedIdentity?.commit, "target-app");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "target-app");
  assert.equal((await artifactIdentity(fixture.runtimePath!, "runtime"))?.commit, "target-runtime");
  assert.equal(await readFile(join(fixture.dataDir, "state.json"), "utf8"), "verified-new-state\n",
    "roll-forward must retain verified replacement state");
  assert.equal(fixture.source.restoreCalls, 0);
  assert.equal(outcome?.sourceSyncPending, false);
}

async function verifyHealthyArtifactsSynchronizeSourceBeforeCompletion(): Promise<void> {
  const fixture = await createFixture("source-sync-pending", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await writeFile(join(fixture.dataDir, "state.json"), "healthy-target-state\n");
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);

  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "complete");
  assert.equal(outcome?.sourceSyncPending, false,
    "a healthy target app must not be finalized until exact source synchronization succeeds");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "target-app");
  assert.equal(fixture.source.head, fixture.input.source.targetCommit);
  assert.equal(fixture.source.restoreCalls, 0);
  assert.equal(await readFile(join(fixture.dataDir, "state.json"), "utf8"), "healthy-target-state\n");
}

async function verifyFailedSourceSynchronizationRemainsDurablyRetryable(): Promise<void> {
  const fixture = await createFixture("source-sync-retry", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  const failing: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    operations: {
      ...fixture.dependencies.operations,
      async synchronizeSource() {
        fixture.source.head = fixture.input.source.targetCommit;
        fixture.source.dirty = true;
        throw new Error("injected failure after ref movement and partial checkout");
      }
    }
  };
  const failed = await recoverUpdateTransaction(fixture.policy, failing);
  assert.equal(failed?.status, "recovery-failed");
  assert.equal(failed?.sourceSyncPending, true);
  assert.match(failed?.message || "", /partial checkout/u);
  assert.ok(await readUpdateRecoveryManifest(fixture.policy), "source sync failure must retain the committed manifest for retry");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "target-app");

  const mixedRetry = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(mixedRetry?.status, "recovery-failed");
  assert.match(mixedRetry?.message || "", /worktree is mixed/u);
  assert.ok(await readUpdateRecoveryManifest(fixture.policy), "a mixed checkout must preserve recovery evidence and concurrent edits");
  fixture.source.dirty = false;
  const retried = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(retried?.status, "complete");
  assert.equal(retried?.sourceSyncPending, false);
  assert.equal(fixture.source.head, fixture.input.source.targetCommit);
  assert.equal(await readUpdateRecoveryManifest(fixture.policy), null);
}

async function verifyRecoveryRejectsSameCommitBranchSwitch(): Promise<void> {
  const preflight = await createFixture("source-branch-preflight", false);
  preflight.source.branch = "same-commit-other-branch";
  await assert.rejects(
    beginUpdateRecoveryTransaction(preflight.policy, preflight.input, preflight.dependencies),
    /exact initial commit/u,
    "transaction creation must reject a same-commit branch switch before any canonical artifact changes"
  );
  assert.equal(await readUpdateRecoveryManifest(preflight.policy), null);

  const fixture = await createFixture("source-branch-recovery", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  fixture.source.branch = "same-commit-other-branch";
  const blocked = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(blocked?.status, "recovery-failed");
  assert.match(blocked?.message || "", /branch no longer matches/u);
  assert.equal(fixture.source.head, fixture.input.source.initialCommit,
    "recovery must not fast-forward a different branch that happens to share the initial commit");
  assert.ok(await readUpdateRecoveryManifest(fixture.policy), "branch mismatch must preserve recovery evidence");

  fixture.source.branch = fixture.input.source.initialBranch;
  const completed = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(completed?.status, "complete");
  assert.equal(fixture.source.head, fixture.input.source.targetCommit);
}

async function verifyCommitIntentMismatchRollsEverythingBack(): Promise<void> {
  const fixture = await createFixture("intent-rollback", true);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  // Runtime remains initial with its target only staged, so commit-intent lacks
  // the complete installed identity proof required to roll forward.
  await writeFile(join(fixture.dataDir, "state.json"), "unverified-state\n");
  fixture.source.head = fixture.input.source.targetCommit;
  await assert.rejects(
    markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies),
    /cannot attest update health/u,
    "commit-intent must be impossible until every canonical artifact is the exact target"
  );

  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "failed-recovered");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "initial-app");
  assert.equal((await artifactIdentity(fixture.runtimePath!, "runtime"))?.commit, "initial-runtime");
  assert.equal(await readFile(join(fixture.dataDir, "state.json"), "utf8"), "old-state\n");
  assert.equal(fixture.source.head, fixture.input.source.initialCommit);
  assert.equal(fixture.source.restoreCalls, 1, "source rollback must be exact and independently verified");
}

async function verifyCommittedRecoveryFinishesPreparedTopology(): Promise<void> {
  const fixture = await createFixture("committed", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  fixture.source.head = fixture.input.source.targetCommit;
  await installTargetTopology(fixture.appPath);
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  await markUpdateRecoveryCommitted(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  // Simulate a crash after the durable commit but before the previous
  // generation and per-artifact journal were cleaned up.
  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "complete");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "target-app");
  await assert.rejects(lstat(`${fixture.appPath}.vigil-next`), { code: "ENOENT" });
  await assert.rejects(lstat(`${fixture.appPath}.vigil-previous`), { code: "ENOENT" });
}

async function verifyStateRollbackWalRetriesAfterInterruption(): Promise<void> {
  const fixture = await createFixture("wal-retry", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await writeFile(join(fixture.dataDir, "state.json"), "new-state\n");
  await writeFile(join(fixture.dataDir, "runtime-interruption.json"), "new-interruption\n");
  let interrupted = false;
  const failingDependencies: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    operations: {
      ...fixture.dependencies.operations,
      async beforeStateEntryRestore(entry) {
        if (!interrupted && entry.name === "runtime-interruption.json") {
          interrupted = true;
          throw new Error("injected WAL interruption");
        }
      }
    }
  };
  const first = await recoverUpdateTransaction(fixture.policy, failingDependencies);
  assert.equal(first?.status, "recovery-failed");
  assert.equal(await readFile(join(fixture.dataDir, "state.json"), "utf8"), "old-state\n",
    "completed per-file WAL records may precede a later interrupted entry");
  assert.ok(await readUpdateRecoveryManifest(fixture.policy), "failed recovery must preserve the global manifest for retry");

  const retried = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(retried?.status, "failed-recovered");
  assert.equal(await readFile(join(fixture.dataDir, "runtime-interruption.json"), "utf8"), "old-interruption\n");
  assert.equal(await readUpdateRecoveryManifest(fixture.policy), null);
}

async function verifyAmbiguousIdentityFailsClosed(): Promise<void> {
  const fixture = await createFixture("ambiguous", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await rm(fixture.appPath, { recursive: true, force: true });
  await writeArtifact(fixture.appPath, "unknown-app", "unknown-fingerprint");
  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "recovery-failed");
  assert.match(outcome?.message || "", /ambiguous/u);
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "unknown-app",
    "an unknown canonical generation must never be deleted or replaced by a guess");
  assert.equal((await artifactIdentity(`${fixture.appPath}.vigil-next`, "app"))?.commit, "target-app",
    "candidate evidence must remain available after ambiguous recovery");
  assert.ok(await readUpdateRecoveryManifest(fixture.policy));
}

async function verifyContradictoryInodeAndContentFailsClosed(): Promise<void> {
  const fixture = await createFixture("identity-contradiction", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  const inodeBefore = (await requiredIdentity(fixture.appPath, "app")).ino;
  await writeFile(join(fixture.appPath, "identity.json"), `${JSON.stringify({
    commit: "tampered-app",
    fingerprint: "tampered-fingerprint"
  })}\n`);
  assert.equal((await requiredIdentity(fixture.appPath, "app")).ino, inodeBefore);
  await assert.rejects(
    markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies),
    /cannot attest update health/u,
    "a matching root inode must never override contradictory content identity"
  );
  const outcome = await recoverUpdateTransaction(fixture.policy, fixture.dependencies);
  assert.equal(outcome?.status, "recovery-failed");
  assert.equal((await requiredIdentity(fixture.appPath, "app")).commit, "tampered-app");
}

function verifyExactIdentityComparisonRejectsPartialAgreement(): void {
  const expected: UpdateArtifactIdentity = {
    commit: "expected",
    fingerprint: "expected-fingerprint",
    dev: 10,
    ino: 20
  };
  assert.equal(updateArtifactIdentitiesExactlyMatch(expected, { ...expected }), true);
  assert.equal(updateArtifactIdentitiesExactlyMatch(expected, {
    ...expected,
    commit: "different"
  }), false, "matching inode evidence must not override contradictory content metadata");
  assert.equal(updateArtifactIdentitiesExactlyMatch(expected, {
    ...expected,
    ino: 21
  }), false, "matching content metadata must not authorize a different recorded inode");
}

async function verifyRecoveryLockSerializesConcurrentCallers(): Promise<void> {
  const fixture = await createFixture("concurrent", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  fixture.source.head = fixture.input.source.targetCommit;
  await installTargetTopology(fixture.appPath);
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  await markUpdateRecoveryCommitted(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  let removals = 0;
  const concurrentDependencies: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    operations: {
      ...fixture.dependencies.operations,
      async removePath(path) {
        removals += 1;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 75));
        await rm(path, { recursive: true, force: true });
      }
    },
    lockTimeoutMs: 2_000,
    lockPollMs: 5
  };
  const [first, second] = await Promise.all([
    recoverUpdateTransaction(fixture.policy, concurrentDependencies),
    recoverUpdateTransaction(fixture.policy, concurrentDependencies)
  ]);
  assert.deepEqual(second, first);
  assert.equal(first?.status, "complete");
  assert.equal(removals, 1, "the recovery lock must serialize mutation and outcome publication");
}

async function verifyLiveRuntimeModeNeverSwapsCanonicalArtifacts(): Promise<void> {
  const fixture = await createFixture("live-no-swap", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  await installTargetTopology(fixture.appPath);
  await markUpdateRecoveryCommitIntent(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  await markUpdateRecoveryCommitted(fixture.policy, fixture.input.attemptId, fixture.dependencies);
  await swapDirectories(fixture.appPath, `${fixture.appPath}.vigil-previous`);
  let recoverySwaps = 0;
  const liveDependencies: UpdateRecoveryDependencies = {
    ...fixture.dependencies,
    allowRollback: false,
    operations: {
      ...fixture.dependencies.operations,
      async swapPaths(left, right) {
        if (left === fixture.appPath || right === fixture.appPath) recoverySwaps += 1;
        await swapDirectories(left, right);
      }
    }
  };
  const outcome = await recoverUpdateTransaction(fixture.policy, liveDependencies);
  assert.equal(outcome?.status, "recovery-failed");
  assert.match(outcome?.message || "", /live-runtime recovery requires/u);
  assert.equal(recoverySwaps, 0, "live-runtime recovery must fail before any canonical swap");
  assert.equal(fixture.source.head, SOURCE_INITIAL, "live-runtime preflight must fail before source synchronization");
  assert.equal((await artifactIdentity(fixture.appPath, "app"))?.commit, "initial-app");
  assert.ok(await readUpdateRecoveryManifest(fixture.policy));
}

async function verifyTamperedAllowlistedPathIsPreserved(): Promise<void> {
  const fixture = await createFixture("tampered-path", false);
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  const manifestPath = join(fixture.policy.updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME);
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as { app: { targetPath: string } };
  raw.app.targetPath = join(fixture.root, "not-allowlisted.app");
  await writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  await assert.rejects(
    recoverUpdateTransaction(fixture.policy, fixture.dependencies),
    UpdateRecoveryValidationError
  );
  assert.equal((JSON.parse(await readFile(manifestPath, "utf8")) as typeof raw).app.targetPath, raw.app.targetPath,
    "path-tampered recovery evidence must be preserved verbatim");
  assert.equal(await readUpdateRecoveryOutcome(fixture.policy.updaterDir), null);
}

async function verifyPolicyAndStableBundleTamperingFailClosed(): Promise<void> {
  const policyFixture = await createFixture("tampered-policy", false);
  await beginUpdateRecoveryTransaction(policyFixture.policy, policyFixture.input, policyFixture.dependencies);
  const policyPath = join(policyFixture.policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME);
  const policyRecord = JSON.parse(await readFile(policyPath, "utf8")) as { expectedAppPath: string };
  policyRecord.expectedAppPath = join(policyFixture.root, "Applications", "Other.app");
  await writeFile(policyPath, `${JSON.stringify(policyRecord, null, 2)}\n`);
  await chmod(policyPath, 0o600);
  await assert.rejects(
    recoverUpdateTransaction(policyFixture.policy, policyFixture.dependencies),
    UpdateRecoveryValidationError
  );
  assert.equal((await artifactIdentity(policyFixture.appPath, "app"))?.commit, "initial-app");
  assert.ok(await lstat(join(policyFixture.policy.updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME)));

  const bundleFixture = await createFixture("tampered-bundle", false);
  await beginUpdateRecoveryTransaction(bundleFixture.policy, bundleFixture.input, bundleFixture.dependencies);
  const loaded = await readUpdateRecoveryPolicyFile(join(bundleFixture.policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME));
  await writeFile(loaded.record.recoveryRuntime.modulePath, "// corrupted stable recovery module\n");
  await assert.rejects(
    recoverUpdateTransaction(bundleFixture.policy, bundleFixture.dependencies),
    /failed validation/u
  );
  assert.equal((await artifactIdentity(bundleFixture.appPath, "app"))?.commit, "initial-app");
  assert.ok(await lstat(join(bundleFixture.policy.updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME)));
}

async function verifyStableRecoveryCliExecutesAsEsm(): Promise<void> {
  const fixture = await createFixture("stable-cli-esm", false);
  await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "init"]);
  await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "config", "user.email", "vigil-test@example.invalid"]);
  await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "config", "user.name", "Vigil Test"]);
  await writeFile(join(fixture.policy.repoRoot, "tracked.txt"), "initial\n");
  await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "add", "tracked.txt"]);
  await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "commit", "-m", "initial"]);
  const headResult = await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "rev-parse", "HEAD"]);
  assert.equal(headResult.code, 0, headResult.stderr);
  const branchResult = await executeFile("/usr/bin/git", ["-C", fixture.policy.repoRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branchResult.code, 0, branchResult.stderr);
  const head = headResult.stdout.trim();
  fixture.source.head = head;
  fixture.source.branch = branchResult.stdout.trim() === "HEAD" ? null : branchResult.stdout.trim();
  fixture.input.source = { initialCommit: head, initialBranch: fixture.source.branch, targetCommit: head };
  fixture.input.recoveryBundle.scriptSourcePath = fileURLToPath(new URL("../scripts/recover-update-transaction.mjs", import.meta.url));
  fixture.input.recoveryBundle.moduleSourcePath = fileURLToPath(new URL("../src/updateTransaction.js", import.meta.url));
  await beginUpdateRecoveryTransaction(fixture.policy, fixture.input, fixture.dependencies);
  const loaded = await readUpdateRecoveryPolicyFile(join(fixture.policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME));
  assert.deepEqual(
    JSON.parse(await readFile(loaded.record.recoveryRuntime.packagePath, "utf8")),
    { type: "module" },
    "the self-contained recovery bundle must classify its copied .js module as ESM"
  );
  await installTargetTopology(fixture.appPath);
  const result = await executeFile(loaded.record.recoveryRuntime.nodePath, [
    loaded.record.recoveryRuntime.scriptPath,
    "--policy-file",
    join(fixture.policy.updaterDir, UPDATE_RECOVERY_POLICY_FILENAME)
  ]);
  assert.equal(result.code, 0, `the staged recovery CLI must execute with its bound Node runtime: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { status: string; attemptId: string };
  assert.equal(outcome.status, "failed-recovered", "the copied CLI must perform a real pending rollback");
  assert.equal(outcome.attemptId, fixture.input.attemptId);
  assert.equal((await requiredIdentity(fixture.appPath, "app")).commit, "initial-app");
}

async function executeFile(command: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return await new Promise((resolveExecution) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolveExecution({
        code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        stdout: String(stdout),
        stderr: String(stderr)
      });
    });
  });
}

async function createFixture(name: string, includeRuntime: boolean): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), `vigil-update-transaction-${name}-`)));
  roots.push(root);
  const updaterDir = join(root, "user-data", "updater");
  const dataDir = join(root, "user-data");
  const repoRoot = join(root, "repo");
  const appPath = join(root, "Applications", "Vigil.app");
  const runtimePath = includeRuntime ? join(repoRoot, "dist", "runtime") : null;
  await Promise.all([
    mkdir(updaterDir, { recursive: true }),
    mkdir(repoRoot, { recursive: true }),
    mkdir(join(root, "Applications"), { recursive: true })
  ]);
  await writeFile(join(dataDir, "state.json"), "old-state\n");
  await writeFile(join(dataDir, "runtime-interruption.json"), "old-interruption\n");
  await writeArtifact(appPath, "initial-app", "initial-app-fingerprint");
  await writeArtifact(`${appPath}.vigil-next`, "target-app", "target-app-fingerprint");
  if (runtimePath) {
    await writeArtifact(runtimePath, "initial-runtime", "initial-runtime-fingerprint");
    await writeArtifact(`${runtimePath}.vigil-next`, "target-runtime", "target-runtime-fingerprint");
  }
  const bundleSourceRoot = join(root, "bundle-source");
  const scriptSourcePath = join(bundleSourceRoot, "recover-update-transaction.mjs");
  const moduleSourcePath = join(bundleSourceRoot, "updateTransaction.js");
  const helperSourcePath = join(bundleSourceRoot, "vigil-atomic-swap");
  await mkdir(bundleSourceRoot, { recursive: true });
  await writeFile(scriptSourcePath, "// fixture recovery CLI\n");
  await writeFile(moduleSourcePath, "// fixture recovery module\n");
  await writeFile(helperSourcePath, [
    "#!/bin/sh",
    "set -eu",
    "probe_tmp=\"$1.vigil-test-swap\"",
    "mv \"$1\" \"$probe_tmp\"",
    "mv \"$2\" \"$1\"",
    "mv \"$probe_tmp\" \"$2\"",
    ""
  ].join("\n"), { mode: 0o700 });
  await chmod(helperSourcePath, 0o700);

  const source = { head: SOURCE_INITIAL, branch: "main" as string | null, restoreCalls: 0, dirty: false };
  const operations: UpdateRecoveryOperations = {
    identifyArtifact: artifactIdentity,
    copyPath: async (from, to) => await cp(from, to, { recursive: true }),
    movePath: async (from, to) => await rename(from, to),
    removePath: async (path) => await rm(path, { recursive: true, force: true }),
    swapPaths: swapDirectories,
    syncArtifact: async () => undefined,
    syncDirectory: async () => undefined,
    cleanupJournal: async (path) => await rm(path, { force: true }),
    readSourceHead: async () => source.head,
    readSourceBranch: async () => source.branch,
    async validateSourceTransition(_repoRoot, initial, branch, target) {
      if (source.head !== initial || source.branch !== branch) {
        throw new UpdateRecoveryValidationError("fixture source no longer matches its exact initial commit or branch");
      }
      assert.match(target, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    },
    async assertSourceWorktreeClean() {
      if (source.dirty) throw new Error("fixture source worktree is mixed");
    },
    async synchronizeSource(_repoRoot, expected, branch, target) {
      assert.equal(source.head, expected);
      assert.equal(source.branch, branch);
      source.head = target;
    },
    async restoreSource(_repoRoot, expected, branch, initial) {
      assert.equal(source.head, expected);
      assert.equal(source.branch, branch);
      source.restoreCalls += 1;
      source.head = initial;
    },
    processIdentity: async (pid) => `test-process-${pid}`,
    now: () => new Date()
  };
  const appInitial = await requiredIdentity(appPath, "app");
  const appTarget = await requiredIdentity(`${appPath}.vigil-next`, "app");
  const runtimePlans = runtimePath
    ? [{
        targetPath: runtimePath,
        initialIdentity: await requiredIdentity(runtimePath, "runtime"),
        targetIdentity: await requiredIdentity(`${runtimePath}.vigil-next`, "runtime")
      }]
    : [];
  const policy: UpdateRecoveryPolicy = {
    updaterDir,
    expectedAppPath: appPath,
    repoRoot,
    userDataDir: dataDir,
    expectedDataDir: dataDir,
    expectedRuntimePaths: runtimePath ? [runtimePath] : []
  };
  const input: BeginUpdateRecoveryInput = {
    attemptId: `attempt-${name}`,
    source: { initialCommit: SOURCE_INITIAL, initialBranch: source.branch, targetCommit: SOURCE_TARGET },
    app: { targetPath: appPath, initialIdentity: appInitial, targetIdentity: appTarget },
    runtimes: runtimePlans,
    recoveryBundle: {
      nodePath: await realpath(process.execPath),
      gitPath: await realpath("/usr/bin/git"),
      scriptSourcePath,
      moduleSourcePath,
      helperSourcePath
    }
  };
  await writePreparedStagingJournal(policy, input.attemptId, "app", input.app);
  for (const runtime of input.runtimes || []) {
    await writePreparedStagingJournal(policy, input.attemptId, "runtime", runtime);
  }
  return {
    root,
    policy,
    input,
    appPath,
    runtimePath,
    dataDir,
    source,
    operations,
    dependencies: { operations, lockTimeoutMs: 2_000, lockPollMs: 5 }
  };
}

async function writePreparedStagingJournal(
  policy: UpdateRecoveryPolicy,
  attemptId: string,
  kind: UpdateArtifactKind,
  plan: BeginUpdateRecoveryInput["app"]
): Promise<void> {
  const initial = plan.initialIdentity;
  const candidate = plan.targetIdentity;
  await writeFile(`${plan.targetPath}.vigil-transaction.json`, `${JSON.stringify({
    version: 2,
    id: attemptId,
    attemptId,
    kind,
    globalManifestPath: join(policy.updaterDir, UPDATE_RECOVERY_MANIFEST_FILENAME),
    targetPath: plan.targetPath,
    nextPath: `${plan.targetPath}.vigil-next`,
    previousPath: `${plan.targetPath}.vigil-previous`,
    phase: "prepared",
    hadPrevious: false,
    initialPresent: initial !== null,
    initialCommit: initial?.commit ?? null,
    initialFingerprint: initial?.fingerprint ?? null,
    initialDevice: initial?.dev ?? null,
    initialInode: initial?.ino ?? null,
    candidateCommit: candidate.commit,
    candidateFingerprint: candidate.fingerprint,
    candidateDevice: candidate.dev,
    candidateInode: candidate.ino,
    updatedAt: new Date().toISOString()
  }, null, 2)}\n`, { mode: 0o600 });
  await chmod(`${plan.targetPath}.vigil-transaction.json`, 0o600);
}

async function writeArtifact(path: string, commit: string, fingerprint: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "identity.json"), `${JSON.stringify({ commit, fingerprint })}\n`);
  await writeFile(join(path, "build-info.json"), `${JSON.stringify({ commit, sourceFingerprint: fingerprint })}\n`);
  const appBuildInfoDir = join(path, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime");
  await mkdir(appBuildInfoDir, { recursive: true });
  await writeFile(join(appBuildInfoDir, "build-info.json"), `${JSON.stringify({ commit, sourceFingerprint: fingerprint })}\n`);
}

async function artifactIdentity(path: string, _kind: UpdateArtifactKind): Promise<UpdateArtifactIdentity | null> {
  try {
    const value = await lstat(path);
    if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(`unsafe fixture artifact ${path}`);
    const record = JSON.parse(await readFile(join(path, "identity.json"), "utf8")) as {
      commit: string;
      fingerprint: string;
    };
    return { commit: record.commit, fingerprint: record.fingerprint, dev: value.dev, ino: value.ino };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function requiredIdentity(path: string, kind: UpdateArtifactKind): Promise<UpdateArtifactIdentity> {
  const identity = await artifactIdentity(path, kind);
  assert.ok(identity);
  return identity;
}

async function installTargetTopology(targetPath: string): Promise<void> {
  const nextPath = `${targetPath}.vigil-next`;
  const previousPath = `${targetPath}.vigil-previous`;
  await swapDirectories(targetPath, nextPath);
  await rename(nextPath, previousPath);
}

async function swapDirectories(left: string, right: string): Promise<void> {
  const temporary = `${left}.test-swap`;
  await rm(temporary, { recursive: true, force: true });
  await rename(left, temporary);
  try {
    await rename(right, left);
    await rename(temporary, right);
  } catch (error) {
    await rename(temporary, left).catch(() => undefined);
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
