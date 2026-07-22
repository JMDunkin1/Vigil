import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const UPDATE_RECEIPT_VERSION = 1 as const;
export const UPDATE_RECEIPT_MAX_BYTES = 64 * 1024;

const PRIVATE_FILE_MODE = 0o600;

export interface ReceiptWriteLockRecoveryHooks {
  afterSnapshot?(): Promise<void>;
  afterSwap?(): Promise<void>;
}

export interface ReceiptReadHooks {
  afterOpen?(): Promise<void>;
  afterRead?(): Promise<void>;
}

interface PinnedReceiptWriteLockSnapshot {
  handle: FileHandle;
  dev: number;
  ino: number;
  mode: number;
  uid: number;
  mtimeMs: number;
  raw: string;
}

interface ReceiptWriteLockRecord {
  token: string;
  pid: number;
  createdAt: string;
  ownerStartedAt?: string;
}

const execFileAsync = promisify(execFile);
let currentProcessStartedAtPromise: Promise<string | null> | null = null;
const UPDATE_RECEIPT_PHASES = new Set<UpdateReceiptPhase>([
  "starting",
  "checking",
  "selecting",
  "staging",
  "installing",
  "building",
  "packaging",
  "exporting-ios-policy",
  "waiting",
  "installing-runtime",
  "installing-app",
  "verifying",
  "updating-source",
  "recovering",
  "rolling-back",
  "complete",
  "failed"
]);

export type UpdateReceiptKind = "local" | "remote";

export type UpdateReceiptPhase =
  | "starting"
  | "checking"
  | "selecting"
  | "staging"
  | "installing"
  | "building"
  | "packaging"
  | "exporting-ios-policy"
  | "waiting"
  | "installing-runtime"
  | "installing-app"
  | "verifying"
  | "updating-source"
  | "recovering"
  | "rolling-back"
  | UpdateReceiptTerminalPhase;

export type UpdateReceiptTerminalPhase = "complete" | "failed";

/**
 * Durable evidence for one local or remote updater transaction.
 *
 * Identity fields are deliberately present (and nullable) throughout the
 * transaction. Phase writers merge into this record, so discovering an
 * identity later never erases an identity captured by an earlier phase.
 */
export interface UpdateReceipt {
  version: typeof UPDATE_RECEIPT_VERSION;
  attemptId: string;
  kind: UpdateReceiptKind;
  phase: UpdateReceiptPhase;
  message: string;
  error: string | null;
  ok: boolean | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
  sourceCommit: string | null;
  sourceFingerprint: string | null;
  targetCommit: string | null;
  targetFingerprint: string | null;
  installedCommit: string | null;
  installedFingerprint: string | null;
}

export type LocalUpdateReceipt = UpdateReceipt & { kind: "local" };
export type RemoteUpdateReceipt = UpdateReceipt & { kind: "remote" };

/** The unversioned update-status.json shape written by Vigil releases before v1. */
export interface LegacyUpdateReceipt {
  ok?: boolean;
  phase: string;
  message?: string;
  error?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  sourceCommit?: string;
  sourceFingerprint?: string;
  targetCommit?: string;
  targetFingerprint?: string;
  installedCommit?: string;
  installedFingerprint?: string;
}

export type UpdateReceiptInvalidReason =
  | "unsafe-file"
  | "oversized-file"
  | "unreadable-file"
  | "malformed-json"
  | "unsupported-version"
  | "invalid-record";

export type UpdateReceiptReadResult =
  | { status: "missing" }
  | { status: "valid"; receipt: UpdateReceipt }
  | { status: "legacy"; receipt: LegacyUpdateReceipt }
  | { status: "invalid"; reason: UpdateReceiptInvalidReason };

export interface ActiveUpdateLock {
  /** New locks carry this explicitly. The historical token is also accepted. */
  attemptId?: unknown;
  token?: unknown;
  startedAt?: unknown;
}

export interface InstalledBuildEvidence {
  builtAt?: string | Date | number | null;
  modifiedAt?: string | Date | number | null;
  commit?: string | null;
  fingerprint?: string | null;
}

export interface NewUpdateReceiptInput<Kind extends UpdateReceiptKind = UpdateReceiptKind> {
  attemptId: string;
  kind: Kind;
  phase?: UpdateReceiptPhase;
  message: string;
  startedAt?: string | Date;
  sourceCommit?: string | null;
  sourceFingerprint?: string | null;
  targetCommit?: string | null;
  targetFingerprint?: string | null;
  installedCommit?: string | null;
  installedFingerprint?: string | null;
}

export type UpdateReceiptPatch = Partial<Pick<UpdateReceipt,
  | "message"
  | "error"
  | "ok"
  | "finishedAt"
  | "sourceCommit"
  | "sourceFingerprint"
  | "targetCommit"
  | "targetFingerprint"
  | "installedCommit"
  | "installedFingerprint"
>> & {
  phase: UpdateReceiptPhase;
  updatedAt?: string;
};

export class UpdateReceiptConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateReceiptConflictError";
  }
}

export function newUpdateReceipt<Kind extends UpdateReceiptKind>(
  input: NewUpdateReceiptInput<Kind>
): UpdateReceipt & { kind: Kind } {
  const startedAt = timestampString(input.startedAt ?? new Date(), "update start");
  const phase = input.phase || "starting";
  const terminal = isTerminalUpdatePhase(phase);
  const receipt: UpdateReceipt = {
    version: UPDATE_RECEIPT_VERSION,
    attemptId: requiredIdentifier(input.attemptId, "update attempt"),
    kind: input.kind,
    phase,
    message: boundedString(input.message, "update message"),
    error: phase === "failed" ? boundedString(input.message, "update error") : null,
    ok: terminal ? phase === "complete" : null,
    startedAt,
    updatedAt: startedAt,
    finishedAt: terminal ? startedAt : null,
    sourceCommit: nullableIdentifier(input.sourceCommit, "source commit"),
    sourceFingerprint: nullableIdentifier(input.sourceFingerprint, "source fingerprint"),
    targetCommit: nullableIdentifier(input.targetCommit, "target commit"),
    targetFingerprint: nullableIdentifier(input.targetFingerprint, "target fingerprint"),
    installedCommit: nullableIdentifier(input.installedCommit, "installed commit"),
    installedFingerprint: nullableIdentifier(input.installedFingerprint, "installed fingerprint")
  };
  if (!validUpdateReceipt(receipt)) throw new Error("Vigil could not create a valid updater receipt.");
  return receipt as UpdateReceipt & { kind: Kind };
}

/**
 * Read without repairing or deleting evidence. Invalid bytes remain at the
 * canonical path until a caller deliberately begins a new updater attempt.
 */
export async function readUpdateReceipt(
  path: string,
  readHooks: ReceiptReadHooks = {}
): Promise<UpdateReceiptReadResult> {
  return await readUpdateReceiptPinned(path, readHooks, 0);
}

async function readUpdateReceiptPinned(
  path: string,
  readHooks: ReceiptReadHooks,
  retry: number
): Promise<UpdateReceiptReadResult> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
  } catch (error) {
    return isErrorCode(error, "ENOENT") ? { status: "missing" } : { status: "invalid", reason: "unreadable-file" };
  }
  try {
    const handleStat = await handle.stat();
    await readHooks.afterOpen?.();
    let pathStat;
    try {
      pathStat = await lstat(path);
    } catch {
      return { status: "invalid", reason: "unreadable-file" };
    }
    if (!pathStat.isFile() || pathStat.isSymbolicLink() || !handleStat.isFile()) {
      return { status: "invalid", reason: "unsafe-file" };
    }
    if (handleStat.dev !== pathStat.dev || handleStat.ino !== pathStat.ino) {
      return retry < 2
        ? await readUpdateReceiptPinned(path, {}, retry + 1)
        : { status: "invalid", reason: "unreadable-file" };
    }
    if (handleStat.size > UPDATE_RECEIPT_MAX_BYTES) return { status: "invalid", reason: "oversized-file" };

    const text = await readBoundedUtf8(handle, UPDATE_RECEIPT_MAX_BYTES);
    if (text === null) return { status: "invalid", reason: "oversized-file" };
    await readHooks.afterRead?.();
    const finalStat = await handle.stat();
    if (finalStat.dev !== handleStat.dev
      || finalStat.ino !== handleStat.ino
      || finalStat.size !== handleStat.size
      || finalStat.mtimeMs !== handleStat.mtimeMs) {
      return { status: "invalid", reason: "unreadable-file" };
    }
    let finalPathStat;
    try {
      finalPathStat = await lstat(path);
    } catch {
      return { status: "invalid", reason: "unreadable-file" };
    }
    if (!finalPathStat.isFile() || finalPathStat.isSymbolicLink()) {
      return { status: "invalid", reason: "unsafe-file" };
    }
    if (finalPathStat.dev !== handleStat.dev || finalPathStat.ino !== handleStat.ino) {
      return retry < 2
        ? await readUpdateReceiptPinned(path, {}, retry + 1)
        : { status: "invalid", reason: "unreadable-file" };
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return { status: "invalid", reason: "malformed-json" };
    }
    if (!isRecord(value)) return { status: "invalid", reason: "invalid-record" };
    if ("version" in value) {
      if (value.version !== UPDATE_RECEIPT_VERSION) return { status: "invalid", reason: "unsupported-version" };
      return validUpdateReceipt(value)
        ? { status: "valid", receipt: value }
        : { status: "invalid", reason: "invalid-record" };
    }
    return validLegacyUpdateReceipt(value)
      ? { status: "legacy", receipt: value }
      : { status: "invalid", reason: "invalid-record" };
  } catch {
    return { status: "invalid", reason: "unreadable-file" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Start (or idempotently re-start) one attempt. A malformed predecessor is
 * atomically moved aside first so its exact bytes remain available for
 * diagnosis; valid historical receipts can be replaced by the new attempt.
 */
export async function beginUpdateReceipt(path: string, receipt: UpdateReceipt): Promise<UpdateReceipt> {
  if (!validUpdateReceipt(receipt)) throw new Error("Vigil refused to persist an invalid updater receipt.");
  await mkdir(dirname(path), { recursive: true });
  return await withReceiptWriteLock(path, async () => {
    const current = await readUpdateReceipt(path);
    if (current.status === "valid" && current.receipt.attemptId === receipt.attemptId) {
      return current.receipt;
    }
    if (current.status === "invalid") await archiveInvalidUpdateReceipt(path);
    await atomicWriteUpdateReceipt(path, receipt);
    return receipt;
  });
}

/**
 * Merge a phase update into the exact attempt that created the receipt.
 * Different attempts, malformed evidence, and terminal-state regressions are
 * rejected without changing the canonical file.
 */
export async function mergeWriteUpdateReceipt(
  path: string,
  attemptId: string,
  patch: UpdateReceiptPatch
): Promise<UpdateReceipt> {
  const expectedAttemptId = requiredIdentifier(attemptId, "update attempt");
  return await withReceiptWriteLock(path, async () => {
    const current = await readUpdateReceipt(path);
    if (current.status === "missing") throw new UpdateReceiptConflictError("The updater receipt is missing.");
    if (current.status === "legacy") {
      throw new UpdateReceiptConflictError("A legacy updater receipt cannot be merged into a versioned attempt.");
    }
    if (current.status === "invalid") {
      throw new UpdateReceiptConflictError(`The updater receipt is invalid (${current.reason}) and was preserved.`);
    }
    if (current.receipt.attemptId !== expectedAttemptId) {
      throw new UpdateReceiptConflictError("The updater receipt belongs to a different attempt.");
    }
    if (isTerminalUpdateReceipt(current.receipt)) {
      if (patch.phase === current.receipt.phase) return current.receipt;
      throw new UpdateReceiptConflictError("A terminal updater receipt cannot return to an earlier phase.");
    }

    const requestedUpdatedAt = timestampString(patch.updatedAt ?? new Date(), "update timestamp");
    const updatedAt = Date.parse(requestedUpdatedAt) < Date.parse(current.receipt.updatedAt)
      ? current.receipt.updatedAt
      : requestedUpdatedAt;
    const terminal = isTerminalUpdatePhase(patch.phase);
    const requestedFinishedAt = terminal
      ? timestampString(patch.finishedAt ?? updatedAt, "update completion")
      : null;
    const finishedAt = requestedFinishedAt && Date.parse(requestedFinishedAt) < Date.parse(updatedAt)
      ? updatedAt
      : requestedFinishedAt;
    const next: UpdateReceipt = {
      ...current.receipt,
      ...patch,
      version: UPDATE_RECEIPT_VERSION,
      attemptId: current.receipt.attemptId,
      kind: current.receipt.kind,
      phase: patch.phase,
      error: patch.phase === "failed"
        ? boundedString(patch.error ?? patch.message ?? current.receipt.message, "update error")
        : null,
      ok: terminal ? patch.phase === "complete" : null,
      startedAt: current.receipt.startedAt,
      updatedAt,
      finishedAt
    };
    if (!validUpdateReceipt(next)) throw new Error("Vigil refused to persist an invalid updater receipt update.");
    await atomicWriteUpdateReceipt(path, next);
    return next;
  });
}

/** Move invalid evidence to a unique sibling path without reading through links. */
export async function archiveInvalidUpdateReceipt(path: string, now = new Date()): Promise<string | null> {
  const current = await readUpdateReceipt(path);
  if (current.status === "missing") return null;
  if (current.status !== "invalid") {
    throw new UpdateReceiptConflictError("Only an invalid updater receipt may be archived by this helper.");
  }
  const archivedPath = `${path}.invalid.${timestampForPath(now)}.${randomUUID()}`;
  try {
    await rename(path, archivedPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  const archivedStat = await lstat(archivedPath);
  if (archivedStat.isFile() && !archivedStat.isSymbolicLink()) {
    await chmod(archivedPath, PRIVATE_FILE_MODE);
  }
  await syncParentDirectory(path);
  return archivedPath;
}

export function isTerminalUpdatePhase(phase: unknown): phase is UpdateReceiptTerminalPhase {
  return phase === "complete" || phase === "failed";
}

export function isTerminalUpdateReceipt(receipt: Pick<UpdateReceipt, "phase"> | Pick<LegacyUpdateReceipt, "phase">): boolean {
  return isTerminalUpdatePhase(receipt.phase);
}

/**
 * A versioned receipt must match the active lock's exact attempt identity.
 * Only an unversioned receipt is allowed to use the historical timestamp
 * correlation used before attempt IDs existed. Legacy locks were acquired
 * shortly before their first status write, so current evidence is any receipt
 * timestamp at or after that lock's start (not only an equal timestamp).
 */
export function receiptMatchesActiveLock(
  receipt: UpdateReceipt | LegacyUpdateReceipt | null | undefined,
  lock: ActiveUpdateLock | null | undefined
): boolean {
  if (!receipt || !lock) return false;
  if ("attemptId" in receipt) {
    const lockAttemptId = nonEmptyString(lock.attemptId) || nonEmptyString(lock.token);
    return Boolean(lockAttemptId && lockAttemptId === receipt.attemptId);
  }
  const lockStartedAt = timestampValue(lock.startedAt);
  const receiptAt = latestTimestamp(receipt.startedAt, receipt.updatedAt, receipt.finishedAt);
  return receiptAt !== null && lockStartedAt !== null && receiptAt >= lockStartedAt;
}

/**
 * Legacy failures had no attempt identity and could remain visible forever.
 * Suppress one only with positive evidence that the installed app artifact was
 * produced or replaced after that failure receipt was last updated.
 */
export function failedLegacyReceiptSuperseded(
  receipt: LegacyUpdateReceipt | null | undefined,
  installed: InstalledBuildEvidence
): boolean {
  return failedUpdateReceiptSuperseded(receipt, installed);
}

/**
 * Historical failures from either receipt schema stop being UI truth once a
 * later installed artifact provides positive temporal evidence that another
 * replacement completed. This deliberately does not infer success merely from
 * matching a target: a failed health check may have installed and then rolled
 * back the same target during the attempt.
 */
export function failedUpdateReceiptSuperseded(
  receipt: UpdateReceipt | LegacyUpdateReceipt | null | undefined,
  installed: InstalledBuildEvidence
): boolean {
  if (!receipt || receipt.phase !== "failed") return false;
  const failedAt = latestTimestamp(receipt.finishedAt, receipt.updatedAt, receipt.startedAt);
  if (failedAt === null) return false;
  const installedAt = latestTimestamp(installed.builtAt, installed.modifiedAt);
  return installedAt !== null && installedAt > failedAt;
}

/** Positive evidence that an orphaned in-progress attempt produced this app. */
export function receiptTargetInstalled(
  receipt: UpdateReceipt | LegacyUpdateReceipt | null | undefined,
  installed: InstalledBuildEvidence
): boolean {
  if (!receipt || isTerminalUpdateReceipt(receipt)) return false;
  const targetCommit = nonEmptyString(receipt.targetCommit);
  const targetFingerprint = nonEmptyString(receipt.targetFingerprint);
  if (!targetCommit && !targetFingerprint) return false;
  if (targetCommit && targetCommit !== nonEmptyString(installed.commit)) return false;
  if (targetFingerprint && targetFingerprint !== nonEmptyString(installed.fingerprint)) return false;
  const attemptAt = latestTimestamp(receipt.startedAt);
  const installedAt = latestTimestamp(installed.builtAt, installed.modifiedAt);
  return attemptAt !== null && installedAt !== null && installedAt >= attemptAt;
}

async function atomicWriteUpdateReceipt(path: string, receipt: UpdateReceipt): Promise<void> {
  const temporaryPath = `${path}.${receipt.attemptId}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    temporaryCreated = true;
    try {
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;
    await syncParentDirectory(path);
  } finally {
    if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function readBoundedUtf8(handle: FileHandle, maxBytes: number): Promise<string | null> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset > maxBytes ? null : buffer.subarray(0, offset).toString("utf8");
}

async function withReceiptWriteLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.write-lock`;
  const token = randomUUID();
  const deadline = Date.now() + 5_000;
  const ownerStartedAt = await currentProcessStartedAt();
  let acquired = false;
  do {
    try {
      const handle = await open(lockPath, "wx", PRIVATE_FILE_MODE);
      try {
        const owner: ReceiptWriteLockRecord = {
          token,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          ...(ownerStartedAt ? { ownerStartedAt } : {})
        };
        await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      acquired = true;
      break;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (await removeStaleReceiptWriteLock(lockPath)) continue;
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, 20));
    }
  } while (Date.now() < deadline);
  if (!acquired) throw new UpdateReceiptConflictError("The updater receipt is busy.");
  try {
    return await operation();
  } finally {
    try {
      const pinned = await openPinnedReceiptWriteLock(lockPath);
      try {
        if (pinned && parseReceiptWriteLock(pinned.raw)?.token === token) {
          await releaseOwnedReceiptWriteLock(lockPath, pinned);
        }
      } finally {
        await pinned?.handle.close().catch(() => undefined);
      }
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) {
        // The receipt itself is already durable. A stale serialization lock is
        // bounded and self-reaped; cleanup failure must not rewrite outcome.
      }
    }
  }
}

async function removeStaleReceiptWriteLock(
  path: string,
  recoveryHooks: ReceiptWriteLockRecoveryHooks = {}
): Promise<boolean> {
  let snapshot: PinnedReceiptWriteLockSnapshot | null;
  try {
    snapshot = await openPinnedReceiptWriteLock(path);
  } catch (error) {
    return isErrorCode(error, "ENOENT");
  }
  try {
    if (!snapshot) return false;
    const uid = process.getuid?.();
    if (uid !== undefined && snapshot.uid !== uid) return false;
    if ((snapshot.mode & 0o077) !== 0) return false;
    const owner = parseReceiptWriteLock(snapshot.raw);
    if (!owner) {
      if (Date.now() - snapshot.mtimeMs < 30_000) return false;
    } else {
      const processState = processExists(owner.pid);
      if (processState === null) return false;
      if (processState) {
        const observedStartedAt = await processStartedAt(owner.pid);
        // Process-table failure is ambiguous and therefore fail-closed. When
        // reading an old lock without an explicit process-start identity, its
        // creation time still proves PID reuse if the observed process began
        // later than the lock could possibly have been created.
        if (!observedStartedAt) return false;
        if (owner.ownerStartedAt) {
          if (sameProcessStart(owner.ownerStartedAt, observedStartedAt)) return false;
        } else if (Date.parse(observedStartedAt) <= Date.parse(owner.createdAt) + 2_000) {
          return false;
        }
      }
    }
    await recoveryHooks.afterSnapshot?.();
    return await quarantinePinnedReceiptWriteLock(path, snapshot, recoveryHooks);
  } finally {
    await snapshot?.handle.close().catch(() => undefined);
  }
}

/** Test seam for deterministic stale-reaper interleavings. */
export async function recoverStaleReceiptWriteLockForTest(
  path: string,
  recoveryHooks: ReceiptWriteLockRecoveryHooks = {}
): Promise<boolean> {
  return await removeStaleReceiptWriteLock(path, recoveryHooks);
}

async function openPinnedReceiptWriteLock(path: string): Promise<PinnedReceiptWriteLockSnapshot | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await open(path, "r");
    const [handleStat, pathStat] = await Promise.all([handle.stat(), lstat(path)]);
    if (!pathStat.isFile()
      || pathStat.isSymbolicLink()
      || handleStat.dev !== pathStat.dev
      || handleStat.ino !== pathStat.ino) {
      await handle.close();
      return null;
    }
    return {
      handle,
      dev: handleStat.dev,
      ino: handleStat.ino,
      mode: handleStat.mode,
      uid: handleStat.uid,
      mtimeMs: handleStat.mtimeMs,
      raw: await handle.readFile("utf8")
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (isErrorCode(error, "ENOENT")) throw error;
    return null;
  }
}

async function quarantinePinnedReceiptWriteLock(
  path: string,
  expected: PinnedReceiptWriteLockSnapshot,
  recoveryHooks: ReceiptWriteLockRecoveryHooks = {}
): Promise<boolean> {
  const quarantinePath = `${path}.stale.${Date.now()}.${randomUUID()}`;
  const guardToken = randomUUID();
  const guardHandle = await open(quarantinePath, "wx", PRIVATE_FILE_MODE);
  try {
    await guardHandle.writeFile(`${JSON.stringify({ guardToken, createdAt: new Date().toISOString() })}\n`, "utf8");
    await guardHandle.sync();
  } finally {
    await guardHandle.close();
  }
  const guard = await lstat(quarantinePath);

  try {
    await atomicSwapReceiptLockPaths(path, quarantinePath, true);
  } catch (error) {
    await rm(quarantinePath, { force: true }).catch(() => undefined);
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
  await recoveryHooks.afterSwap?.();
  const canonical = await lstat(path);
  if (canonical.dev !== guard.dev || canonical.ino !== guard.ino) {
    throw new Error("Vigil's updater receipt lock guard changed during reconciliation.");
  }

  const moved = await openPinnedReceiptWriteLock(quarantinePath).catch(() => null);
  try {
    if (moved
      && moved.dev === expected.dev
      && moved.ino === expected.ino
      && moved.raw === expected.raw) {
      await removeFileWithIdentity(quarantinePath, moved.dev, moved.ino);
      await removeFileWithIdentity(path, guard.dev, guard.ino);
      await syncParentDirectory(path);
      return true;
    }

    // The canonical owner changed after our snapshot. Atomic exchange puts
    // that displaced owner back without ever exposing an empty lock name, so
    // a third contender cannot enter while reconciliation is in flight.
    await atomicSwapReceiptLockPaths(path, quarantinePath);
    const [restored, returnedGuard] = await Promise.all([lstat(path), lstat(quarantinePath)]);
    if (!moved
      || restored.dev !== moved.dev
      || restored.ino !== moved.ino
      || returnedGuard.dev !== guard.dev
      || returnedGuard.ino !== guard.ino) {
      throw new Error("The updater receipt lock changed during atomic reconciliation and was preserved.");
    }
    await removeFileWithIdentity(quarantinePath, guard.dev, guard.ino);
    await syncParentDirectory(path);
    return false;
  } finally {
    await moved?.handle.close().catch(() => undefined);
  }
}

async function releaseOwnedReceiptWriteLock(
  path: string,
  expected: PinnedReceiptWriteLockSnapshot
): Promise<void> {
  try {
    await quarantinePinnedReceiptWriteLock(path, expected);
    return;
  } catch (error) {
    if (!(error instanceof ReceiptAtomicSwapUnavailableError)) throw error;
  }

  // Receipt status writes remain usable in a damaged/development bundle that
  // lacks the swap helper. This fallback is release-only: the live owner's
  // process identity prevents a conforming stale reaper from replacing it,
  // and rename atomically turns the lock name from occupied to available.
  const releasedPath = `${path}.released.${Date.now()}.${randomUUID()}`;
  try {
    await rename(path, releasedPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = await openPinnedReceiptWriteLock(releasedPath).catch(() => null);
  try {
    if (moved
      && moved.dev === expected.dev
      && moved.ino === expected.ino
      && moved.raw === expected.raw) {
      await removeFileWithIdentity(releasedPath, moved.dev, moved.ino);
      await syncParentDirectory(path);
      return;
    }
    try {
      await rename(releasedPath, path);
    } catch (error) {
      if (!isErrorCode(error, "EEXIST") && !isErrorCode(error, "ENOENT")) throw error;
    }
    throw new Error("The updater receipt lock changed during fallback release and was preserved.");
  } finally {
    await moved?.handle.close().catch(() => undefined);
  }
}

function parseReceiptWriteLock(raw: string): ReceiptWriteLockRecord | null {
  try {
    const value = JSON.parse(raw) as Partial<ReceiptWriteLockRecord> | null;
    return value
      && requiredIdentifierOrFalse(value.token)
      && Number.isInteger(value.pid)
      && Number(value.pid) > 0
      && validTimestamp(value.createdAt)
      && (value.ownerStartedAt === undefined || validTimestamp(value.ownerStartedAt))
      ? value as ReceiptWriteLockRecord
      : null;
  } catch {
    return null;
  }
}

async function currentProcessStartedAt(): Promise<string | null> {
  currentProcessStartedAtPromise ||= processStartedAt(process.pid);
  return await currentProcessStartedAtPromise;
}

async function processStartedAt(pid: number): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const result = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000
    });
    const parsed = Date.parse(String(result.stdout).trim());
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  } catch {
    return null;
  }
}

function sameProcessStart(expected: string, observed: string): boolean {
  const expectedAt = Date.parse(expected);
  const observedAt = Date.parse(observed);
  return Number.isFinite(expectedAt)
    && Number.isFinite(observedAt)
    && Math.abs(expectedAt - observedAt) < 2_000;
}

function processExists(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ESRCH")) return false;
    if (isErrorCode(error, "EPERM")) return true;
    return null;
  }
}

async function atomicSwapReceiptLockPaths(
  left: string,
  right: string,
  classifyRejectedSwapAsUnavailable = false
): Promise<void> {
  const helperPath = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "vigil-atomic-swap");
  let helper;
  try {
    helper = await lstat(helperPath);
  } catch (error) {
    if (classifyRejectedSwapAsUnavailable && isErrorCode(error, "ENOENT")) {
      throw new ReceiptAtomicSwapUnavailableError();
    }
    throw error;
  }
  if (!helper.isFile() || helper.isSymbolicLink() || (helper.mode & 0o111) === 0) {
    if (classifyRejectedSwapAsUnavailable) throw new ReceiptAtomicSwapUnavailableError();
    throw new Error("Vigil's atomic swap helper is missing or unsafe.");
  }
  await new Promise<void>((resolveSwap, rejectSwap) => {
    const child = spawn(helperPath, [left, right], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      rejectSwap(classifyRejectedSwapAsUnavailable
        && (isErrorCode(error, "ENOENT") || isErrorCode(error, "EACCES") || isErrorCode(error, "ENOEXEC"))
        ? new ReceiptAtomicSwapUnavailableError()
        : error);
    });
    child.once("close", (code) => {
      if (code === 0) resolveSwap();
      else rejectSwap(classifyRejectedSwapAsUnavailable
        ? new ReceiptAtomicSwapUnavailableError(stderr.trim() || `Vigil's atomic swap helper exited with status ${code}.`)
        : new Error(stderr.trim() || `Vigil's atomic swap helper exited with status ${code}.`));
    });
  });
}

class ReceiptAtomicSwapUnavailableError extends Error {
  constructor(detail = "Vigil's atomic swap helper is missing or unsafe.") {
    super(detail);
    this.name = "ReceiptAtomicSwapUnavailableError";
  }
}

async function removeFileWithIdentity(path: string, dev: number, ino: number): Promise<void> {
  const current = await lstat(path);
  if (!current.isFile() || current.isSymbolicLink() || current.dev !== dev || current.ino !== ino) {
    throw new Error("The updater receipt lock changed before exact cleanup and was preserved.");
  }
  await rm(path);
}

async function syncParentDirectory(path: string): Promise<void> {
  let directory;
  try {
    directory = await open(dirname(path), "r");
    await directory.sync();
  } catch (error) {
    // Some filesystems do not support syncing directory handles. The receipt
    // itself was still fsynced before the atomic rename.
    if (!isErrorCode(error, "EINVAL") && !isErrorCode(error, "ENOTSUP") && !isErrorCode(error, "EISDIR")) throw error;
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

function validUpdateReceipt(value: unknown): value is UpdateReceipt {
  if (!isRecord(value)) return false;
  if (value.version !== UPDATE_RECEIPT_VERSION) return false;
  if (!requiredIdentifierOrFalse(value.attemptId) || (value.kind !== "local" && value.kind !== "remote")) return false;
  if (typeof value.phase !== "string" || !UPDATE_RECEIPT_PHASES.has(value.phase as UpdateReceiptPhase)) return false;
  if (!boundedStringOrFalse(value.message) || !nullableBoundedString(value.error)) return false;
  if (value.ok !== null && typeof value.ok !== "boolean") return false;
  if (!validTimestamp(value.startedAt) || !validTimestamp(value.updatedAt)) return false;
  if (Date.parse(value.updatedAt) < Date.parse(value.startedAt)) return false;
  if (isTerminalUpdatePhase(value.phase)) {
    if (!validTimestamp(value.finishedAt) || Date.parse(value.finishedAt) < Date.parse(value.updatedAt)) return false;
    if (value.ok !== (value.phase === "complete")) return false;
    if (value.phase === "failed" && !boundedStringOrFalse(value.error)) return false;
    if (value.phase === "complete" && value.error !== null) return false;
  } else {
    if (value.finishedAt !== null || value.ok !== null || value.error !== null) return false;
  }
  for (const field of [
    "sourceCommit",
    "sourceFingerprint",
    "targetCommit",
    "targetFingerprint",
    "installedCommit",
    "installedFingerprint"
  ] as const) {
    if (!nullableIdentifierOrFalse(value[field])) return false;
  }
  return true;
}

function validLegacyUpdateReceipt(value: Record<string, unknown>): value is Record<string, unknown> & LegacyUpdateReceipt {
  if (!boundedStringOrFalse(value.phase)) return false;
  if (value.ok !== undefined && typeof value.ok !== "boolean") return false;
  for (const field of ["message", "error"] as const) {
    if (value[field] !== undefined && !boundedStringOrFalse(value[field])) return false;
  }
  for (const field of ["startedAt", "updatedAt", "finishedAt"] as const) {
    if (value[field] !== undefined && !validTimestamp(value[field])) return false;
  }
  for (const field of [
    "sourceCommit",
    "sourceFingerprint",
    "targetCommit",
    "targetFingerprint",
    "installedCommit",
    "installedFingerprint"
  ] as const) {
    if (value[field] !== undefined && !requiredIdentifierOrFalse(value[field])) return false;
  }
  const startedAt = timestampValue(value.startedAt);
  const updatedAt = timestampValue(value.updatedAt);
  const finishedAt = timestampValue(value.finishedAt);
  if (startedAt !== null && updatedAt !== null && updatedAt < startedAt) return false;
  if (startedAt !== null && finishedAt !== null && finishedAt < startedAt) return false;
  return true;
}

function timestampString(value: string | Date | number, label: string): string {
  const milliseconds = timestampValue(value);
  if (milliseconds === null) throw new Error(`Vigil received an invalid ${label} timestamp.`);
  return new Date(milliseconds).toISOString();
}

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestampValue(value) !== null;
}

function timestampValue(value: unknown): number | null {
  if (!(typeof value === "string" || typeof value === "number" || value instanceof Date)) return null;
  const milliseconds = value instanceof Date
    ? value.getTime()
    : typeof value === "number"
      ? value
      : Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function latestTimestamp(...values: unknown[]): number | null {
  const timestamps = values.map(timestampValue).filter((value): value is number => value !== null);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function requiredIdentifier(value: unknown, label: string): string {
  if (!requiredIdentifierOrFalse(value)) throw new Error(`Vigil received an invalid ${label} identifier.`);
  return value;
}

function nullableIdentifier(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredIdentifier(value, label);
}

function requiredIdentifierOrFalse(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000\r\n]/u.test(value);
}

function nullableIdentifierOrFalse(value: unknown): value is string | null {
  return value === null || requiredIdentifierOrFalse(value);
}

function boundedString(value: unknown, label: string): string {
  if (!boundedStringOrFalse(value)) throw new Error(`Vigil received an invalid ${label}.`);
  return value;
}

function boundedStringOrFalse(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16 * 1024 && !value.includes("\u0000");
}

function nullableBoundedString(value: unknown): value is string | null {
  return value === null || boundedStringOrFalse(value);
}

function nonEmptyString(value: unknown): string | null {
  return requiredIdentifierOrFalse(value) ? value : null;
}

function timestampForPath(now: Date): string {
  const milliseconds = now.getTime();
  if (!Number.isFinite(milliseconds)) throw new Error("Vigil received an invalid receipt archive timestamp.");
  return now.toISOString().replace(/[-:.]/gu, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
