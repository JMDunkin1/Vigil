import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  UPDATE_RECEIPT_VERSION,
  UPDATE_RECEIPT_MAX_BYTES,
  UpdateReceiptConflictError,
  beginUpdateReceipt,
  failedLegacyReceiptSuperseded,
  failedUpdateReceiptSuperseded,
  isTerminalUpdatePhase,
  isTerminalUpdateReceipt,
  mergeWriteUpdateReceipt,
  newUpdateReceipt,
  readUpdateReceipt,
  recoverStaleReceiptWriteLockForTest,
  receiptMatchesActiveLock,
  receiptTargetInstalled
} from "../src/updateReceipt.js";
import type { LegacyUpdateReceipt, LocalUpdateReceipt, RemoteUpdateReceipt } from "../src/updateReceipt.js";

const root = await mkdtemp(join(tmpdir(), "vigil-update-receipt-"));
const receiptPath = join(root, "updater", "update-status.json");
const sourceCommit = "1".repeat(40);
const targetCommit = "2".repeat(40);
const targetFingerprint = "a".repeat(64);
const installedFingerprint = "b".repeat(64);
const attemptId = "remote-attempt-1";
const execFileAsync = promisify(execFile);

try {
  const initial: RemoteUpdateReceipt = newUpdateReceipt({
    attemptId,
    kind: "remote",
    message: "Preparing Vigil update",
    startedAt: "2026-07-22T14:00:00.000Z",
    sourceCommit,
    targetCommit
  });
  assert.equal(initial.version, UPDATE_RECEIPT_VERSION);
  assert.equal(initial.phase, "starting");
  assert.equal(initial.updatedAt, initial.startedAt);
  assert.equal(initial.sourceCommit, sourceCommit);
  assert.equal(initial.targetCommit, targetCommit);
  assert.equal(initial.installedCommit, null);
  assert.equal(isTerminalUpdateReceipt(initial), false);

  await beginUpdateReceipt(receiptPath, initial);
  assert.equal((await stat(receiptPath)).mode & 0o777, 0o600, "new receipts must be private");
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "valid", receipt: initial });
  await verifyPinnedReceiptReads(receiptPath, root, initial);

  const built = await mergeWriteUpdateReceipt(receiptPath, attemptId, {
    phase: "building",
    message: "Building Vigil",
    targetFingerprint,
    updatedAt: "2026-07-22T14:01:00.000Z"
  });
  assert.equal(built.startedAt, initial.startedAt, "phase writes must retain the attempt start");
  assert.equal(built.sourceCommit, sourceCommit, "phase writes must merge rather than erase source identity");
  assert.equal(built.targetCommit, targetCommit, "phase writes must merge rather than erase target identity");
  assert.equal(built.targetFingerprint, targetFingerprint);

  const beforeWrongAttempt = await readFile(receiptPath, "utf8");
  await assert.rejects(
    mergeWriteUpdateReceipt(receiptPath, "remote-attempt-2", {
      phase: "failed",
      message: "A stale updater failed",
      updatedAt: "2026-07-22T14:02:00.000Z"
    }),
    UpdateReceiptConflictError
  );
  assert.equal(await readFile(receiptPath, "utf8"), beforeWrongAttempt, "another attempt must not overwrite this attempt's evidence");

  const clockAdjusted = await mergeWriteUpdateReceipt(receiptPath, attemptId, {
    phase: "installing",
    message: "Continuing after a wall-clock adjustment",
    updatedAt: "2026-07-22T14:00:30.000Z"
  });
  assert.equal(clockAdjusted.updatedAt, built.updatedAt, "a backward wall-clock adjustment must not strand the attempt");

  const complete = await mergeWriteUpdateReceipt(receiptPath, attemptId, {
    phase: "complete",
    message: "Vigil update complete",
    installedCommit: targetCommit,
    installedFingerprint,
    updatedAt: "2026-07-22T14:03:00.000Z",
    finishedAt: "2026-07-22T14:02:00.000Z"
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.finishedAt, "2026-07-22T14:03:00.000Z");
  assert.equal(complete.installedCommit, targetCommit);
  assert.equal(complete.installedFingerprint, installedFingerprint);
  assert.equal(complete.finishedAt, complete.updatedAt, "terminal time must not predate the last persisted phase update");
  assert.equal(isTerminalUpdatePhase(complete.phase), true);
  assert.equal(isTerminalUpdateReceipt(complete), true);
  await assert.rejects(
    mergeWriteUpdateReceipt(receiptPath, attemptId, {
      phase: "verifying",
      message: "Regressed",
      updatedAt: "2026-07-22T14:04:00.000Z"
    }),
    /terminal updater receipt/u
  );
  const terminalRetry = await mergeWriteUpdateReceipt(receiptPath, attemptId, {
    phase: "complete",
    message: "A late writer must not rewrite terminal evidence",
    updatedAt: "2026-07-22T14:05:00.000Z"
  });
  assert.deepEqual(terminalRetry, complete, "terminal receipts must be immutable under idempotent retries");

  assert.equal(receiptMatchesActiveLock(complete, {
    token: attemptId,
    startedAt: complete.startedAt
  }), true, "the historical lock token can carry the exact v1 attempt ID");
  assert.equal(receiptMatchesActiveLock(complete, {
    attemptId: "wrong-attempt",
    startedAt: complete.startedAt
  }), false, "matching timestamps must never override mismatched v1 attempt IDs");

  const legacy: LegacyUpdateReceipt = {
    ok: false,
    phase: "failed",
    message: "Old failure",
    error: "Old failure",
    startedAt: "2026-07-22T12:00:00.000Z",
    updatedAt: "2026-07-22T12:05:00.000Z",
    finishedAt: "2026-07-22T12:05:00.000Z"
  };
  await writeFile(receiptPath, `${JSON.stringify(legacy)}\n`);
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "legacy", receipt: legacy });
  assert.equal(receiptMatchesActiveLock(legacy, {
    token: "legacy-lock-token",
    startedAt: "2026-07-22T12:00:00Z"
  }), true, "legacy receipts may correlate by the exact start instant");
  assert.equal(receiptMatchesActiveLock(legacy, {
    token: "legacy-lock-token",
    startedAt: "2026-07-22T12:00:01.000Z"
  }), true, "legacy phase writes after lock acquisition still belong to that active attempt");
  assert.equal(receiptMatchesActiveLock(legacy, {
    token: "legacy-lock-token",
    startedAt: "2026-07-22T12:05:00.001Z"
  }), false, "legacy evidence older than the active lock belongs to a prior attempt");
  assert.equal(receiptMatchesActiveLock({
    phase: "building",
    updatedAt: "2026-07-22T12:03:00.000Z"
  }, {
    token: "legacy-lock-token",
    startedAt: "2026-07-22T12:00:01.000Z"
  }), true, "legacy child phase records lost startedAt and must fall back to their update timestamp");
  assert.equal(failedLegacyReceiptSuperseded(legacy, {
    builtAt: "2026-07-22T12:06:00.000Z"
  }), true, "a newer installed build must supersede an old unversioned failure");
  assert.equal(failedLegacyReceiptSuperseded(legacy, {
    modifiedAt: Date.parse("2026-07-22T12:06:00.000Z")
  }), true, "a newer app artifact mtime must supersede an old unversioned failure");
  assert.equal(failedLegacyReceiptSuperseded(legacy, {
    builtAt: "2026-07-22T12:04:59.999Z",
    modifiedAt: "2026-07-22T12:05:00.000Z"
  }), false, "equal or older installed evidence is not enough to hide a failure");
  assert.equal(failedLegacyReceiptSuperseded({ ...legacy, phase: "complete" }, {
    builtAt: "2026-07-22T12:06:00.000Z"
  }), false, "supersession applies only to stale failures");

  const versionedFailure = newUpdateReceipt({
    attemptId: "failed-v1",
    kind: "remote",
    phase: "failed",
    message: "Old versioned failure",
    startedAt: "2026-07-22T13:00:00.000Z",
    targetCommit
  });
  assert.equal(failedUpdateReceiptSuperseded(versionedFailure, {
    builtAt: "2026-07-22T13:01:00.000Z",
    commit: targetCommit
  }), true, "a later installed build must supersede stale failures from the versioned schema too");

  const local: LocalUpdateReceipt = newUpdateReceipt({
    attemptId: "local-attempt-1",
    kind: "local",
    message: "Building local changes",
    startedAt: "2026-07-22T15:00:00.000Z",
    sourceCommit,
    sourceFingerprint: targetFingerprint,
    targetCommit: sourceCommit,
    targetFingerprint
  });
  await beginUpdateReceipt(receiptPath, local);
  const localRead = await readUpdateReceipt(receiptPath);
  assert.equal(localRead.status, "valid");
  if (localRead.status === "valid") {
    assert.equal(localRead.receipt.kind, "local");
    assert.equal(localRead.receipt.sourceFingerprint, targetFingerprint);
  }
  assert.equal(receiptTargetInstalled(local, {
    builtAt: "2026-07-22T15:01:00.000Z",
    commit: sourceCommit,
    fingerprint: targetFingerprint
  }), true, "an orphaned local attempt must reconcile only against its exact installed target identity");
  assert.equal(receiptTargetInstalled(local, {
    builtAt: "2026-07-22T15:01:00.000Z",
    commit: sourceCommit,
    fingerprint: installedFingerprint
  }), false, "a mismatched installed fingerprint must not turn an interrupted attempt into success");

  const concurrent = newUpdateReceipt({
    attemptId: "concurrent-attempt",
    kind: "local",
    message: "Concurrent writers",
    startedAt: "2026-07-22T15:30:00.000Z"
  });
  await beginUpdateReceipt(receiptPath, concurrent);
  await Promise.all([
    mergeWriteUpdateReceipt(receiptPath, concurrent.attemptId, {
      phase: "building",
      message: "Writer one",
      sourceFingerprint: targetFingerprint,
      updatedAt: "2026-07-22T15:31:00.000Z"
    }),
    mergeWriteUpdateReceipt(receiptPath, concurrent.attemptId, {
      phase: "packaging",
      message: "Writer two",
      targetFingerprint: installedFingerprint,
      updatedAt: "2026-07-22T15:31:00.000Z"
    })
  ]);
  const concurrentRead = await readUpdateReceipt(receiptPath);
  assert.equal(concurrentRead.status, "valid");
  if (concurrentRead.status === "valid") {
    assert.equal(concurrentRead.receipt.sourceFingerprint, targetFingerprint);
    assert.equal(concurrentRead.receipt.targetFingerprint, installedFingerprint);
  }
  await verifyRejectedSwapHelperDoesNotWedgeOwnedRelease(receiptPath, concurrent.attemptId);

  await verifyIdentityBoundReceiptLockRecovery(receiptPath, `${JSON.stringify({
    token: "stale-writer",
    pid: process.pid,
    createdAt: "2026-07-22T15:00:00.000Z"
  })}\n`, "stale");
  await verifyIdentityBoundReceiptLockRecovery(receiptPath, "{malformed-stale-writer\n", "malformed");
  await verifyOldLiveReceiptLockIsPreserved(receiptPath);

  const malformedBytes = "{this is not json\n";
  await writeFile(receiptPath, malformedBytes, { mode: 0o644 });
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "invalid", reason: "malformed-json" });
  await assert.rejects(
    mergeWriteUpdateReceipt(receiptPath, local.attemptId, {
      phase: "failed",
      message: "Must not overwrite malformed evidence"
    }),
    /was preserved/u
  );
  assert.equal(await readFile(receiptPath, "utf8"), malformedBytes);

  const replacement = newUpdateReceipt({
    attemptId: "local-attempt-2",
    kind: "local",
    message: "Fresh attempt",
    startedAt: "2026-07-22T16:00:00.000Z"
  });
  await beginUpdateReceipt(receiptPath, replacement);
  const siblings = await readdir(join(root, "updater"));
  const archivedName = siblings.find((name) => name.startsWith("update-status.json.invalid."));
  assert.ok(archivedName, "a fresh attempt must archive malformed predecessor evidence");
  const archivedPath = join(root, "updater", archivedName);
  assert.equal(await readFile(archivedPath, "utf8"), malformedBytes);
  assert.equal((await stat(archivedPath)).mode & 0o777, 0o600, "archived malformed evidence must become private");
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "valid", receipt: replacement });

  const unsupportedBytes = `${JSON.stringify({ version: 99, phase: "failed" })}\n`;
  await writeFile(receiptPath, unsupportedBytes);
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "invalid", reason: "unsupported-version" });
  await assert.rejects(
    mergeWriteUpdateReceipt(receiptPath, replacement.attemptId, {
      phase: "failed",
      message: "Do not replace a future schema"
    }),
    /was preserved/u
  );
  assert.equal(await readFile(receiptPath, "utf8"), unsupportedBytes);

  const symlinkTarget = join(root, "untrusted-target.json");
  await writeFile(symlinkTarget, malformedBytes, { mode: 0o644 });
  await rm(receiptPath, { force: true });
  await symlink(symlinkTarget, receiptPath);
  assert.deepEqual(await readUpdateReceipt(receiptPath), { status: "invalid", reason: "unsafe-file" });
  await beginUpdateReceipt(receiptPath, replacement);
  assert.equal(await readFile(symlinkTarget, "utf8"), malformedBytes, "archiving a symlink must not read or modify its target");
  assert.equal((await stat(symlinkTarget)).mode & 0o777, 0o644);
  assert.equal((await lstat(receiptPath)).isFile(), true);
} finally {
  await rm(root, { recursive: true, force: true });
}

async function verifyPinnedReceiptReads(
  path: string,
  testRoot: string,
  receipt: RemoteUpdateReceipt
): Promise<void> {
  const displacedPath = join(testRoot, "pinned-receipt-original.json");
  const replacementTarget = join(testRoot, "pinned-receipt-replacement.json");
  const replacementBytes = `${JSON.stringify({ ...receipt, attemptId: "replacement-attempt" }, null, 2)}\n`;
  await writeFile(replacementTarget, replacementBytes, { mode: 0o644 });
  const readCompleted = deferred();
  const releaseRead = deferred();
  const replacementRead = readUpdateReceipt(path, {
    async afterRead() {
      readCompleted.resolve();
      await releaseRead.promise;
    }
  });
  await readCompleted.promise;
  await rename(path, displacedPath);
  await symlink(replacementTarget, path);
  releaseRead.resolve();
  assert.deepEqual(await replacementRead, { status: "invalid", reason: "unsafe-file" },
    "a receipt path replacement after the bounded read must not be reported as the pinned old status");
  await rm(path);
  await rename(displacedPath, path);
  await rm(replacementTarget);

  const fileOpened = deferred();
  const releaseOversizedRead = deferred();
  const oversizedRead = readUpdateReceipt(path, {
    async afterOpen() {
      fileOpened.resolve();
      await releaseOversizedRead.promise;
    }
  });
  await fileOpened.promise;
  await writeFile(path, "x".repeat(UPDATE_RECEIPT_MAX_BYTES + 1));
  releaseOversizedRead.resolve();
  assert.deepEqual(await oversizedRead, { status: "invalid", reason: "oversized-file" },
    "growing the pinned inode after its first stat must not bypass the receipt size bound");
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

async function verifyOldLiveReceiptLockIsPreserved(path: string): Promise<void> {
  const lockPath = `${path}.write-lock`;
  const { stdout } = await execFileAsync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" });
  const ownerStartedAt = new Date(Date.parse(String(stdout).trim())).toISOString();
  const liveBytes = `${JSON.stringify({
    token: "old-live-writer",
    pid: process.pid,
    createdAt: new Date().toISOString(),
    ownerStartedAt
  })}\n`;
  await writeFile(lockPath, liveBytes, { mode: 0o600, flag: "wx" });
  const oldAt = new Date(Date.now() - 60_000);
  await utimes(lockPath, oldAt, oldAt);
  assert.equal(await recoverStaleReceiptWriteLockForTest(lockPath), false,
    "lock age must never permit reaping the exact live writer process");
  assert.equal(await readFile(lockPath, "utf8"), liveBytes);
  await rm(lockPath);
}

async function verifyRejectedSwapHelperDoesNotWedgeOwnedRelease(
  path: string,
  receiptAttemptId: string
): Promise<void> {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vigil-atomic-swap");
  const savedHelperPath = `${helperPath}.receipt-test-${process.pid}`;
  await rename(helperPath, savedHelperPath);
  try {
    // The production helper returns nonzero only when its single atomic-swap
    // syscall failed before changing either name. Exercise that exact failure
    // contract without depending on a filesystem that rejects RENAME_SWAP.
    await writeFile(helperPath, "#!/bin/sh\nexit 69\n", { mode: 0o755, flag: "wx" });
    await mergeWriteUpdateReceipt(path, receiptAttemptId, {
      phase: "waiting",
      message: "First write with a rejected lock swap"
    });
    await assert.rejects(lstat(`${path}.write-lock`), (error: unknown) => isErrorCode(error, "ENOENT"),
      "a rejected helper call must still release the exact owned lock");
    const second = await mergeWriteUpdateReceipt(path, receiptAttemptId, {
      phase: "verifying",
      message: "A later writer must not be wedged"
    });
    assert.equal(second.phase, "verifying");

    const staleLockPath = `${path}.write-lock`;
    const staleBytes = "{malformed-stale-owner\n";
    await writeFile(staleLockPath, staleBytes, { mode: 0o600, flag: "wx" });
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(staleLockPath, staleAt, staleAt);
    await assert.rejects(recoverStaleReceiptWriteLockForTest(staleLockPath), /status 69/u,
      "a rejected helper call must fail closed when reaping a stale lock");
    assert.equal(await readFile(staleLockPath, "utf8"), staleBytes,
      "failed stale recovery must preserve the canonical lock evidence");
    await rm(staleLockPath);
  } finally {
    await rm(helperPath, { force: true });
    await rename(savedHelperPath, helperPath);
  }
}

async function verifyIdentityBoundReceiptLockRecovery(
  path: string,
  staleContents: string,
  label: string
): Promise<void> {
  const lockPath = `${path}.write-lock`;
  await writeFile(lockPath, staleContents, { mode: 0o600, flag: "wx" });
  const staleAt = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleAt, staleAt);
  const firstSnapshotted = deferred();
  const secondSnapshotted = deferred();
  const secondSwapped = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const releaseSecondSwap = deferred();
  const firstReaper = recoverStaleReceiptWriteLockForTest(lockPath, {
    async afterSnapshot() {
      firstSnapshotted.resolve();
      await releaseFirst.promise;
    }
  });
  await firstSnapshotted.promise;
  const secondReaper = recoverStaleReceiptWriteLockForTest(lockPath, {
    async afterSnapshot() {
      secondSnapshotted.resolve();
      await releaseSecond.promise;
    },
    async afterSwap() {
      secondSwapped.resolve();
      await releaseSecondSwap.promise;
    }
  });
  await secondSnapshotted.promise;

  releaseFirst.resolve();
  assert.equal(await firstReaper, true, `${label} fixture's first stale reaper must claim the old inode`);
  const liveBytes = `${JSON.stringify({ token: `live-${label}`, pid: process.pid, createdAt: new Date().toISOString() })}\n`;
  await writeFile(lockPath, liveBytes, { mode: 0o600, flag: "wx" });
  releaseSecond.resolve();
  await secondSwapped.promise;
  assert.equal((await lstat(lockPath)).isFile(), true,
    `${label} reconciliation must keep an occupied canonical lock name during replacement recovery`);
  assert.notEqual(await readFile(lockPath, "utf8"), liveBytes,
    `${label} reconciliation must install a guard rather than exposing the displaced owner as unlocked`);
  releaseSecondSwap.resolve();
  assert.equal(await secondReaper, false, `${label} fixture's delayed reaper must reject the replacement inode`);
  assert.equal(await readFile(lockPath, "utf8"), liveBytes, `${label} recovery must restore the displaced live receipt writer`);
  await rm(lockPath);
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
