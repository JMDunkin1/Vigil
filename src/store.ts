import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preserveCorruptStateEvidence } from "./corruptStateEvidence.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT, DEFAULT_ADULT_BLOCKLIST_SOURCE_ID, DEFAULT_ALLOWED_APPS, DEFAULT_ALLOWED_SITES, DEFAULT_ALWAYS_BANNED_URL_PATTERNS, DEFAULT_BLOCKED_SITES, DEFAULT_EXPLICIT_BLOCKED_SITES, DEFAULT_EXPLICIT_URL_PATTERNS, DEFAULT_SHORT_FORM_URL_PATTERNS, FULL_BRICK_BLOCKED_APPS, NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } from "./defaults.js";
import { normalizeIntentionalUse } from "./intentionalUse.js";
import { decryptJournalEntries, encryptJournalEntries, hasEncryptedJournalEntries } from "./journalEncryption.js";
import { resolveDefaultDataDir } from "./dataPaths.js";
import { compactExtensionRuleSignature } from "./extensionRuleSignature.js";
import { normalizeWeekdays } from "./normalizers.js";
import { applySealVerificationToState, markStateSealed, verifyStateTextSeal, writeStateTextSeal } from "./seal.js";
import { withoutFocusedSocialDeniedUrls } from "./socialFeatureFilters.js";
import { dateKey, normalizeClock } from "./time.js";
import type { AdultBlocklistState, AppSettings, GrayscaleSchedule, GrayscaleState, Profile, Schedule, VigilState, Session, UsageState, UnknownRecord } from "./types.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.VIGIL_DATA_DIR || resolveDefaultDataDir(ROOT);
export const STATE_PATH = join(DATA_DIR, "state.json");
export const STATE_SEAL_PATH = join(DATA_DIR, "state.seal.json");
export const STATE_SEAL_KEY_PATH = join(DATA_DIR, "state-seal.key");
export const SOURCE_SEAL_PATH = join(DATA_DIR, "source.seal.json");
export const USAGE_PATH = join(DATA_DIR, "usage.json");
export const USAGE_SEAL_PATH = join(DATA_DIR, "usage.seal.json");
export const RUNTIME_SNAPSHOT_JOURNAL_PATH = join(DATA_DIR, "runtime-snapshot.wal.json");

const RUNTIME_SNAPSHOT_VERSION = 1;
const MAX_RUNTIME_SNAPSHOT_FILE_BYTES = 64 * 1024 * 1024;
const RUNTIME_SNAPSHOT_FILES = ["state", "stateSeal", "usage", "usageSeal", "outbox"] as const;
// Embedded JSON text can be escaped to almost twice its original size. Keep
// recovery's aggregate bound consistent with five individually valid files.
const MAX_RUNTIME_SNAPSHOT_JOURNAL_BYTES = MAX_RUNTIME_SNAPSHOT_FILE_BYTES * RUNTIME_SNAPSHOT_FILES.length * 2 + 1024 * 1024;
export const RUNTIME_OUTBOX_PATH = join(DATA_DIR, "runtime-effects.json");

export interface RuntimeOutboxEntry {
  id: string;
  key: string;
  kind: string;
  payload: UnknownRecord;
  createdAt: string;
  attempts: number;
  lastError: string;
  status?: "pending" | "running";
  startedAt?: string | null;
  nextAttemptAt?: string | null;
}

interface RuntimeSnapshotJournal {
  version: number;
  generation: string;
  createdAt: string;
  files: Record<(typeof RUNTIME_SNAPSHOT_FILES)[number], { bytes: number; sha256: string; text: string }>;
}

export { resolveDefaultDataDir } from "./dataPaths.js";

type RawState = Partial<VigilState> & Record<string, unknown>;
let stateSaveQueue: Promise<void> = Promise.resolve();
let usageSaveQueue: Promise<void> = Promise.resolve();
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
let stateWritesSuppressedForCorruptEvidence = false;

interface PersistenceTransaction {
  owner: symbol;
  closed: boolean;
  stateSaveRequested: boolean;
  usageSaveRequested: boolean;
  rollbackEffects: Array<() => void | Promise<void>>;
}

const persistenceTransaction = new AsyncLocalStorage<PersistenceTransaction>();

export async function withStagedPersistence<T>(operation: () => Promise<T>): Promise<{
  result: T;
  stateSaveRequested: boolean;
  usageSaveRequested: boolean;
  rollback: () => Promise<void>;
}> {
  if (persistenceTransaction.getStore()) {
    throw new Error("Nested Vigil persistence transactions are not supported.");
  }
  const transaction: PersistenceTransaction = {
    owner: Symbol("vigil-persistence-transaction"),
    closed: false,
    stateSaveRequested: false,
    usageSaveRequested: false,
    rollbackEffects: []
  };
  try {
    const result = await persistenceTransaction.run(transaction, operation);
    transaction.closed = true;
    return {
      result,
      stateSaveRequested: transaction.stateSaveRequested,
      usageSaveRequested: transaction.usageSaveRequested,
      rollback: async () => runRollbackEffects(transaction)
    };
  } catch (error) {
    transaction.closed = true;
    await runRollbackEffects(transaction);
    throw error;
  }
}

export function registerPersistenceRollback(effect: () => void | Promise<void>): boolean {
  const transaction = persistenceTransaction.getStore();
  if (!transaction) return false;
  if (transaction.closed) throw new Error("The Vigil persistence transaction is closed.");
  transaction.rollbackEffects.push(effect);
  return true;
}

export async function loadState(): Promise<VigilState> {
  await ensurePrivateDirectory(DATA_DIR);
  await recoverRuntimeSnapshotJournal();
  let raw: string;
  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(STATE_PATH);
    raw = rawBytes.toString("utf8");
    await chmod(STATE_PATH, PRIVATE_FILE_MODE);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
    const fresh = defaultState();
    await saveState(fresh);
    return fresh;
  }

  let verification = await verifyStateTextSeal(raw, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
  if (verification.status === "mismatch") {
    await sleep(300);
    const retryBytes = await readFile(STATE_PATH);
    const retryRaw = retryBytes.toString("utf8");
    const retryVerification = await verifyStateTextSeal(retryRaw, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
    if (retryVerification.ok) {
      rawBytes = retryBytes;
      raw = retryRaw;
      verification = retryVerification;
    }
  }
  let parsed: RawState;
  try {
    parsed = JSON.parse(raw) as RawState;
  } catch (error) {
    return await recoverMalformedState(rawBytes, error);
  }
  const migratedPlaintextJournal = await restoreJournalEntries(parsed);
  const state = migrateState(parsed);
  applySealVerificationToState(state, verification);
  if (verification.status === "missing" || migratedPlaintextJournal) await saveState(state);
  return state;
}

export function saveState(state: VigilState): Promise<void> {
  const transaction = persistenceTransaction.getStore();
  if (transaction) {
    if (transaction.closed) return Promise.reject(new Error("The Vigil persistence transaction is closed."));
    transaction.stateSaveRequested = true;
    return Promise.resolve();
  }
  if (stateWritesSuppressedForCorruptEvidence) return Promise.resolve();
  const sealedAt = new Date().toISOString();
  markStateSealed(state, sealedAt);
  const snapshot = jsonClone(state);
  const save = stateSaveQueue.then(
    () => writeStateAndSeal(snapshot, sealedAt),
    () => writeStateAndSeal(snapshot, sealedAt)
  );
  stateSaveQueue = save.catch(() => {});
  return save;
}

async function recoverMalformedState(raw: Buffer, error: unknown, now = new Date()): Promise<VigilState> {
  const recovered = defaultState();
  const evidence = await preserveCorruptStateEvidence(raw, {
    dataDir: DATA_DIR,
    sealPath: STATE_SEAL_PATH,
    now
  });
  if (!evidence.complete) {
    stateWritesSuppressedForCorruptEvidence = true;
    console.error("Vigil could not preserve all corrupt-state evidence; state writes are suppressed to preserve the originals:", evidence.error);
  }

  const parseDetail = error instanceof Error && error.message
    ? error.message
    : "State data could not be parsed.";
  const detail = evidence.complete
    ? `State file is invalid and was quarantined at ${evidence.stateEvidencePath}. ${parseDetail}`
    : `State file is invalid. Vigil could not preserve all evidence, so the original files remain in place and state writes are disabled. ${parseDetail}`;
  recovered.integrity.stateSeal.tamperDetectedAt = now.toISOString();
  recovered.integrity.stateSeal.tamperDetail = detail;
  recovered.integrity.stateSeal.lastStatus = "invalid-state";
  recovered.integrity.stateSeal.lastDetail = detail;
  recovered.integrity.stateSeal.lastCheckedAt = now.toISOString();
  addEvent(recovered, "invalid_state_quarantined", {
    evidencePath: evidence.stateEvidenceSaved ? evidence.stateEvidencePath : null,
    detail
  });

  if (evidence.complete) {
    try {
      await saveState(recovered);
    } catch (saveError) {
      console.error("Vigil preserved corrupt state evidence but could not persist the fail-closed recovery state:", saveError);
    }
  }
  return recovered;
}

export async function loadUsage(state: VigilState): Promise<UsageState> {
  await ensurePrivateDirectory(DATA_DIR);
  await recoverRuntimeSnapshotJournal();
  let current = await readUsageText();
  let verification = await verifyStateTextSeal(current.text, {
    keyPath: STATE_SEAL_KEY_PATH,
    sealPath: USAGE_SEAL_PATH
  });
  if (verification.status === "mismatch") {
    await sleep(300);
    const retry = await readUsageText();
    const retryVerification = await verifyStateTextSeal(retry.text, {
      keyPath: STATE_SEAL_KEY_PATH,
      sealPath: USAGE_SEAL_PATH
    });
    if (retryVerification.ok) {
      current = retry;
      verification = retryVerification;
    }
  }

  const marker = state.integrity.usageSeal;
  const sealRequired = marker.required === true
    || marker.migrationVersion >= 1
    || Boolean(marker.migratedAt);
  const legacyMigrationAllowed = !sealRequired
    && !verification.hasSeal
    && !state.integrity.stateSeal.tamperDetectedAt;

  if (legacyMigrationAllowed) {
    let usage: UsageState;
    try {
      usage = parseUsageText(current.text);
    } catch {
      return recoverUsageConservatively(state, "The legacy usage file is not valid JSON.");
    }
    await saveUsage(usage);
    markUsageSealRequired(state);
    await saveState(state);
    return usage;
  }

  if (!current.exists || !verification.ok) {
    return recoverUsageConservatively(state, usageSealFailureDetail(verification.status));
  }

  let usage: UsageState;
  try {
    usage = parseUsageText(current.text);
  } catch {
    return recoverUsageConservatively(state, "The sealed usage file is not valid JSON.");
  }
  if (!sealRequired) {
    markUsageSealRequired(state);
    await saveState(state);
  }
  return usage;
}

export function saveUsage(usage: UsageState): Promise<void> {
  const transaction = persistenceTransaction.getStore();
  if (transaction) {
    if (transaction.closed) return Promise.reject(new Error("The Vigil persistence transaction is closed."));
    transaction.usageSaveRequested = true;
    return Promise.resolve();
  }
  const snapshot = jsonClone(usage);
  const save = usageSaveQueue.then(
    () => writeUsageSnapshot(snapshot),
    () => writeUsageSnapshot(snapshot)
  );
  usageSaveQueue = save.catch(() => {});
  return save;
}

/** Persist state and usage as one recoverable commit. Live objects must only be
 * published after this resolves. Before WAL publication, failures leave the
 * prior files untouched. Once the WAL is published, the mutation is committed;
 * canonical replay is retried and any remaining WAL is recovered on startup. */
export async function saveRuntimeSnapshot(
  state: VigilState,
  usage: UsageState,
  options: {
    beforeUsageWrite?: () => void | Promise<void>;
    outbox?: RuntimeOutboxEntry[];
    afterBoundary?: (boundary: string) => void | Promise<void>;
  } = {}
): Promise<void> {
  if (stateWritesSuppressedForCorruptEvidence) {
    throw new Error("Runtime persistence is suppressed until corrupt-state evidence is preserved.");
  }
  if (persistenceTransaction.getStore()) {
    throw new Error("Runtime commits must be performed by the coordinator outside staged handler persistence.");
  }
  const sealedAt = new Date().toISOString();
  const stateSnapshot = jsonClone(state);
  markStateSealed(stateSnapshot, sealedAt);
  const usageSnapshot = jsonClone(usage);
  await assertRuntimeSnapshotTargetsReplaceable();
  const stateText = await serializeStoredState(stateSnapshot);
  const usageText = jsonText(usageSnapshot);
  const generation = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const stagingDir = join(DATA_DIR, `.runtime-snapshot-${generation}`);
  await ensurePrivateDirectory(stagingDir);
  const stateSealStagingPath = join(stagingDir, "state.seal.json");
  const usageSealStagingPath = join(stagingDir, "usage.seal.json");
  try {
    const stateSeal = await writeStateTextSeal(stateText, {
      keyPath: STATE_SEAL_KEY_PATH,
      sealPath: stateSealStagingPath,
      scope: "state"
    }, sealedAt);
    const usageSeal = await writeStateTextSeal(usageText, {
      keyPath: STATE_SEAL_KEY_PATH,
      sealPath: usageSealStagingPath
    }, sealedAt);
    await options.beforeUsageWrite?.();
    const journal = createRuntimeSnapshotJournal(generation, {
      state: stateText,
      stateSeal: jsonText(stateSeal),
      usage: usageText,
      usageSeal: jsonText(usageSeal),
      outbox: jsonText(options.outbox || [])
    });
    let journalPublished = false;
    const boundary = async (name: string) => {
      if (name === "journal-renamed" || name === "journal-published") journalPublished = true;
      await options.afterBoundary?.(name);
    };
    try {
      await publishRuntimeSnapshotJournal(journal, boundary);
    } catch (error) {
      if (!journalPublished) throw error;
    }
    try {
      await applyRuntimeSnapshotJournal(journal, boundary);
    } catch {
      // Publishing the WAL is the commit point. Replay is idempotent, so retry
      // once without diagnostic boundary hooks and leave the WAL for startup
      // recovery if the canonical filesystem remains unavailable.
      await applyRuntimeSnapshotJournal(journal).catch(() => {});
    }
    state.integrity.stateSeal = jsonClone(stateSnapshot.integrity.stateSeal);
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function assertRuntimeSnapshotTargetsReplaceable(): Promise<void> {
  for (const path of [STATE_PATH, STATE_SEAL_PATH, USAGE_PATH, USAGE_SEAL_PATH, RUNTIME_OUTBOX_PATH]) {
    try {
      const info = await lstat(path);
      if (!info.isFile()) throw new Error(`Runtime snapshot target is not a regular file: ${path}`);
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) continue;
      throw error;
    }
  }
}

export async function loadRuntimeOutbox(): Promise<RuntimeOutboxEntry[]> {
  await ensurePrivateDirectory(DATA_DIR);
  await recoverRuntimeSnapshotJournal();
  try {
    const parsed: unknown = JSON.parse(await readFile(RUNTIME_OUTBOX_PATH, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("Runtime effect outbox must be an array.");
    return parsed.map(validateRuntimeOutboxEntry);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return [];
    throw error;
  }
}

function createRuntimeSnapshotJournal(
  generation: string,
  contents: Record<(typeof RUNTIME_SNAPSHOT_FILES)[number], string>
): RuntimeSnapshotJournal {
  return {
    version: RUNTIME_SNAPSHOT_VERSION,
    generation,
    createdAt: new Date().toISOString(),
    files: Object.fromEntries(RUNTIME_SNAPSHOT_FILES.map((name) => {
      const text = contents[name];
      return [name, {
        bytes: Buffer.byteLength(text, "utf8"),
        sha256: createHash("sha256").update(text, "utf8").digest("hex"),
        text
      }];
    })) as RuntimeSnapshotJournal["files"]
  };
}

async function publishRuntimeSnapshotJournal(
  journal: RuntimeSnapshotJournal,
  boundary?: (name: string) => void | Promise<void>
): Promise<void> {
  validateRuntimeSnapshotJournal(journal);
  const journalText = jsonText(journal);
  if (Buffer.byteLength(journalText, "utf8") > MAX_RUNTIME_SNAPSHOT_JOURNAL_BYTES) {
    throw new Error("Runtime snapshot journal exceeds the aggregate size limit.");
  }
  const temp = `${RUNTIME_SNAPSHOT_JOURNAL_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, journalText, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await syncFile(temp);
    await snapshotBoundary("journal-temp-fsynced", boundary);
    await rename(temp, RUNTIME_SNAPSHOT_JOURNAL_PATH);
    await snapshotBoundary("journal-renamed", boundary);
    await syncDirectory(DATA_DIR);
    await snapshotBoundary("journal-published", boundary);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function applyRuntimeSnapshotJournal(
  journal: RuntimeSnapshotJournal,
  boundary?: (name: string) => void | Promise<void>
): Promise<void> {
  validateRuntimeSnapshotJournal(journal);
  const targets: Array<[(typeof RUNTIME_SNAPSHOT_FILES)[number], string]> = [
    ["state", STATE_PATH],
    ["stateSeal", STATE_SEAL_PATH],
    ["usage", USAGE_PATH],
    ["usageSeal", USAGE_SEAL_PATH],
    ["outbox", RUNTIME_OUTBOX_PATH]
  ];
  for (const [name, path] of targets) {
    await writeDurableReplacement(path, journal.files[name].text);
    await snapshotBoundary(`${name}-published`, boundary);
  }
  await rm(RUNTIME_SNAPSHOT_JOURNAL_PATH, { force: true });
  await syncDirectory(DATA_DIR);
  await snapshotBoundary("journal-removed", boundary);
}

async function recoverRuntimeSnapshotJournal(): Promise<void> {
  let raw: Buffer;
  try {
    raw = await readFile(RUNTIME_SNAPSHOT_JOURNAL_PATH);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return;
    throw error;
  }
  let journal: RuntimeSnapshotJournal;
  try {
    if (raw.byteLength > MAX_RUNTIME_SNAPSHOT_JOURNAL_BYTES) throw new Error("Runtime snapshot journal exceeds the aggregate size limit.");
    journal = JSON.parse(raw.toString("utf8")) as RuntimeSnapshotJournal;
    validateRuntimeSnapshotJournal(journal);
  } catch (error) {
    const evidencePath = join(DATA_DIR, `runtime-snapshot.corrupt.${new Date().toISOString().replace(/[:.]/g, "-")}.${randomUUID()}.json`);
    await rename(RUNTIME_SNAPSHOT_JOURNAL_PATH, evidencePath);
    await syncDirectory(DATA_DIR);
    throw new Error(`Vigil quarantined an invalid runtime snapshot journal at ${evidencePath}; canonical state was not modified.`, { cause: error });
  }
  await applyRuntimeSnapshotJournal(journal);
}

function validateRuntimeSnapshotJournal(value: unknown): asserts value is RuntimeSnapshotJournal {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Runtime snapshot journal must be an object.");
  const journal = value as Partial<RuntimeSnapshotJournal>;
  if (journal.version !== RUNTIME_SNAPSHOT_VERSION) throw new Error("Unsupported runtime snapshot journal version.");
  if (typeof journal.generation !== "string" || !/^[\w-]{1,160}$/u.test(journal.generation)) throw new Error("Invalid runtime snapshot generation.");
  if (typeof journal.createdAt !== "string" || !Number.isFinite(Date.parse(journal.createdAt))) throw new Error("Invalid runtime snapshot timestamp.");
  if (!journal.files || typeof journal.files !== "object" || Array.isArray(journal.files)) throw new Error("Runtime snapshot files are missing.");
  for (const name of RUNTIME_SNAPSHOT_FILES) {
    const file = journal.files[name];
    if (!file || typeof file !== "object" || typeof file.text !== "string") throw new Error(`Runtime snapshot ${name} is missing.`);
    const bytes = Buffer.byteLength(file.text, "utf8");
    if (!Number.isSafeInteger(file.bytes) || file.bytes !== bytes || bytes > MAX_RUNTIME_SNAPSHOT_FILE_BYTES) throw new Error(`Runtime snapshot ${name} has an invalid size.`);
    const digest = createHash("sha256").update(file.text, "utf8").digest("hex");
    if (typeof file.sha256 !== "string" || file.sha256 !== digest) throw new Error(`Runtime snapshot ${name} checksum failed.`);
  }
  const state = JSON.parse(journal.files.state.text) as unknown;
  const usage = JSON.parse(journal.files.usage.text) as unknown;
  const outbox = JSON.parse(journal.files.outbox.text) as unknown;
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new Error("Runtime snapshot state is invalid.");
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) throw new Error("Runtime snapshot usage is invalid.");
  if (!Array.isArray(outbox)) throw new Error("Runtime snapshot outbox is invalid.");
  outbox.forEach(validateRuntimeOutboxEntry);
  for (const name of ["stateSeal", "usageSeal"] as const) {
    const seal = JSON.parse(journal.files[name].text) as UnknownRecord;
    if (seal.algorithm !== "hmac-sha256" || typeof seal.digest !== "string" || !/^[a-f\d]{64}$/u.test(seal.digest)) {
      throw new Error(`Runtime snapshot ${name} is invalid.`);
    }
  }
}

function validateRuntimeOutboxEntry(value: unknown): RuntimeOutboxEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid runtime effect outbox entry.");
  const entry = value as Partial<RuntimeOutboxEntry>;
  if (typeof entry.id !== "string" || !entry.id || typeof entry.key !== "string" || !entry.key || typeof entry.kind !== "string" || !entry.kind) {
    throw new Error("Runtime effect outbox entry is missing its identity.");
  }
  if (!entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) throw new Error("Runtime effect outbox payload is invalid.");
  if (typeof entry.createdAt !== "string" || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error("Runtime effect outbox timestamp is invalid.");
  if (!Number.isSafeInteger(entry.attempts) || Number(entry.attempts) < 0 || typeof entry.lastError !== "string") throw new Error("Runtime effect outbox attempt metadata is invalid.");
  if (entry.status !== undefined && !["pending", "running"].includes(entry.status)) throw new Error("Runtime effect outbox status is invalid.");
  for (const field of ["startedAt", "nextAttemptAt"] as const) {
    const timestamp = entry[field];
    if (timestamp !== undefined && timestamp !== null && (typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp)))) {
      throw new Error(`Runtime effect outbox ${field} is invalid.`);
    }
  }
  return entry as RuntimeOutboxEntry;
}

async function writeDurableReplacement(path: string, text: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(temp, PRIVATE_FILE_MODE);
    await syncFile(temp);
    await rename(temp, path);
    await chmod(path, PRIVATE_FILE_MODE);
    await syncFile(path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function syncFile(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function snapshotBoundary(name: string, hook?: (name: string) => void | Promise<void>): Promise<void> {
  await hook?.(name);
  if (process.env.VIGIL_SNAPSHOT_CRASH_AT === name) process.kill(process.pid, "SIGKILL");
}

async function runRollbackEffects(transaction: PersistenceTransaction): Promise<void> {
  const effects = transaction.rollbackEffects.splice(0).reverse();
  const errors: unknown[] = [];
  for (const effect of effects) {
    try { await effect(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Vigil could not fully compensate a failed transaction.");
}

export function addEvent(state: VigilState, type: string, detail: object = {}): void {
  state.events.unshift({
    id: randomUUID(),
    type,
    detail: detail as Record<string, unknown>,
    at: new Date().toISOString()
  });
  state.events = state.events.slice(0, 250);
}

function migrateState(state: RawState): VigilState {
  const fresh = defaultState();
  const rawProfiles = Array.isArray(state.profiles) && state.profiles.length ? state.profiles : fresh.profiles;
  const profiles = normalizeProfiles(migrateBuiltinProfiles(mergeBuiltinProfiles(rawProfiles, fresh.profiles)));
  const settings = migrateSettings({ ...fresh.settings, ...(state.settings || {}) });
  const activeSessions = migrateActiveSessions(state, fresh, profiles);
  const extensionDynamicRules = {
    ...fresh.extension.dynamicRules,
    ...(state.extension?.dynamicRules || {})
  };
  for (const key of ["signature", "expectedSignature"] as const) {
    if (extensionDynamicRules[key]) {
      extensionDynamicRules[key] = compactExtensionRuleSignature(extensionDynamicRules[key]);
    }
  }
  return {
    ...fresh,
    ...state,
    settings,
    adultBlocklist: normalizeAdultBlocklistState(state.adultBlocklist, fresh.adultBlocklist),
    profiles,
    schedules: normalizeSchedules(Array.isArray(state.schedules) ? state.schedules : fresh.schedules),
    limitRules: normalizeLimitRules(Array.isArray(state.limitRules) ? state.limitRules : [], fresh.limitRules),
    limitBlocks: Array.isArray(state.limitBlocks) ? state.limitBlocks : [],
    appLocks: Array.isArray(state.appLocks) ? state.appLocks : fresh.appLocks,
    appLockUnlocks: Array.isArray(state.appLockUnlocks) ? state.appLockUnlocks : [],
    appLockRequests: Array.isArray(state.appLockRequests) ? state.appLockRequests : [],
    appLockLedger: state.appLockLedger || {},
    intentionalUse: normalizeIntentionalUse(state.intentionalUse || {}, fresh.intentionalUse || {}),
    extension: {
      ...fresh.extension,
      ...(state.extension || {}),
      dynamicRules: extensionDynamicRules
    },
    focusShortcut: {
      ...fresh.focusShortcut,
      ...(state.focusShortcut || {})
    },
    environment: {
      ...fresh.environment,
      ...(state.environment || {})
    },
    keyholder: {
      ...fresh.keyholder,
      ...(state.keyholder || {})
    },
    distanceKey: {
      ...fresh.distanceKey,
      ...(state.distanceKey || {})
    },
    integrity: {
      stateSeal: {
        ...fresh.integrity.stateSeal,
        ...(state.integrity?.stateSeal || {})
      },
      usageSeal: {
        required: state.integrity?.usageSeal?.required === true,
        migrationVersion: clampInteger(state.integrity?.usageSeal?.migrationVersion, 0, 1, 0),
        migratedAt: nullableString(state.integrity?.usageSeal?.migratedAt)
      },
      runtime: {
        ...fresh.integrity.runtime,
        ...(state.integrity?.runtime || {})
      }
    },
    grayscale: normalizeGrayscaleState(state.grayscale, fresh.grayscale),
    deviceControls: {
      ios: {
        ...fresh.deviceControls.ios,
        ...(state.deviceControls?.ios || {}),
        blockedAppBundleIds: Array.isArray(state.deviceControls?.ios?.blockedAppBundleIds)
          ? state.deviceControls.ios.blockedAppBundleIds
          : fresh.deviceControls.ios.blockedAppBundleIds,
        allowedAppBundleIds: Array.isArray(state.deviceControls?.ios?.allowedAppBundleIds)
          ? state.deviceControls.ios.allowedAppBundleIds
          : fresh.deviceControls.ios.allowedAppBundleIds,
        deniedUrls: Array.isArray(state.deviceControls?.ios?.deniedUrls)
          ? state.deviceControls.ios.deniedUrls
          : fresh.deviceControls.ios.deniedUrls,
        allowedUrls: Array.isArray(state.deviceControls?.ios?.allowedUrls)
          ? state.deviceControls.ios.allowedUrls
          : fresh.deviceControls.ios.allowedUrls,
        mdm: {
          ...fresh.deviceControls.ios.mdm,
          ...(state.deviceControls?.ios?.mdm || {}),
          devices: Array.isArray(state.deviceControls?.ios?.mdm?.devices)
            ? state.deviceControls.ios.mdm.devices
            : fresh.deviceControls.ios.mdm.devices,
          commands: Array.isArray(state.deviceControls?.ios?.mdm?.commands)
            ? state.deviceControls.ios.mdm.commands
            : fresh.deviceControls.ios.mdm.commands
        }
      }
    },
    maintenance: {
      pending: Array.isArray(state.maintenance?.pending) ? state.maintenance.pending : [],
      windows: Array.isArray(state.maintenance?.windows) ? state.maintenance.windows : []
    },
    activeSessions,
    activeSession: activeSessions.computer || null,
    panicLock: state.panicLock || null,
    emergency: {
      ...fresh.emergency,
      ...(state.emergency || {}),
      pending: Array.isArray(state.emergency?.pending) ? state.emergency.pending : []
    },
    overrides: Array.isArray(state.overrides) ? state.overrides : [],
    events: Array.isArray(state.events) ? state.events : []
  };
}

function migrateSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  const legacyName = ["Local", "Screen", "Time"].join(" ");
  if (next.focusShortcutOnName === `${legacyName} Focus On`) {
    next.focusShortcutOnName = "Vigil Focus On";
  }
  if (next.focusShortcutOffName === `${legacyName} Focus Off`) {
    next.focusShortcutOffName = "Vigil Focus Off";
  }
  if (next.externalNetworkBlockProvider !== "manual") {
    next.externalNetworkBlockProvider = "manual";
  }
  next.adultBlocklistEnabled = next.adultBlocklistEnabled !== false;
  const adultBlocklistSourceId = String(next.adultBlocklistSourceId || "");
  next.adultBlocklistSourceId = adultBlocklistSourceId || DEFAULT_ADULT_BLOCKLIST_SOURCE_ID;
  next.adultBlocklistCustomUrl = String(next.adultBlocklistCustomUrl || "");
  next.adultBlocklistPreloadLimit = clampInteger(next.adultBlocklistPreloadLimit, 0, 250, DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT);
  next.contentFilterEnabled = true;
  next.safariUrlFilterEnabled = true;
  next.strictBypassProtectionEnabled = true;
  return next;
}

function normalizeAdultBlocklistState(value: unknown, fallback: AdultBlocklistState): AdultBlocklistState {
  const raw = value && typeof value === "object" ? value as Partial<AdultBlocklistState> : {};
  const source = raw.source && typeof raw.source === "object" ? raw.source as unknown as UnknownRecord : null;
  return {
    allowlist: normalizeDomainList(raw.allowlist),
    domainCount: clampInteger(raw.domainCount, 0, 10_000_000, fallback.domainCount),
    activeDomainCount: clampInteger(raw.activeDomainCount, 0, 10_000_000, fallback.activeDomainCount),
    hash: String(raw.hash || ""),
    snapshotPath: String(raw.snapshotPath || fallback.snapshotPath || ""),
    lastAttemptAt: nullableString(raw.lastAttemptAt),
    lastRefreshAt: nullableString(raw.lastRefreshAt),
    lastError: String(raw.lastError || ""),
    source: source ? {
      id: String(source.id || ""),
      label: String(source.label || ""),
      url: String(source.url || ""),
      homepage: String(source.homepage || ""),
      license: String(source.license || "")
    } : null
  };
}

function mergeBuiltinProfiles(profiles: Profile[], builtinProfiles: Profile[]): Profile[] {
  const existing = new Set(profiles.map((profile) => profile.id).filter(Boolean));
  const missing = builtinProfiles.filter((profile) => profile.id && !existing.has(profile.id));
  return [...profiles, ...missing.map(cloneProfile)];
}

function migrateBuiltinProfiles(profiles: Profile[]): Profile[] {
  return profiles.map(sanitizeBuiltinProfile);
}

export function sanitizeSoftBlockProfile(profile: Profile): Profile {
  const blockedUrlPatterns = uniqueList([
    ...withoutFocusedSocialDeniedUrls((profile.blockedUrlPatterns || []).filter((pattern) => !isRedditWholeSitePattern(pattern))),
    ...DEFAULT_EXPLICIT_URL_PATTERNS,
    ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS,
    ...DEFAULT_SHORT_FORM_URL_PATTERNS
  ]);
  return {
    ...profile,
    name: profile.name === "Soft Block" ? "Soft Lock" : profile.name,
    description: profile.description && profile.description !== "Blocks the normal explicit baseline plus short-form feeds while leaving regular sites usable."
      ? profile.description
      : "Blocks explicit sites and non-social short-form surfaces while leaving regular apps usable.",
    blockedApps: [],
    blockedSites: (profile.blockedSites || []).filter((site) => !isInstagramSiteTarget(site) && !isRedditSiteTarget(site)),
    blockedUrlPatterns,
    phoneAppBlocking: false,
    hostsUrlPatternBlocking: false
  };
}

export function sanitizeDefaultFocusProfile(profile: Profile): Profile {
  return sanitizeRedditUrlPolicyProfile(profile, {
    blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS, ...DEFAULT_SHORT_FORM_URL_PATTERNS],
    hostsUrlPatternBlocking: false
  });
}

function sanitizeNormalProfile(profile: Profile): Profile {
  return {
    ...profile,
    description: "Normal use with permanent explicit-content, YouTube Shorts, and Snapchat Spotlight/Stories protection.",
    blockedApps: [],
    blockedSites: [...DEFAULT_EXPLICIT_BLOCKED_SITES],
    blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS],
    phoneAppBlocking: false,
    hostsUrlPatternBlocking: false
  };
}

export function sanitizeFullBrickProfile(profile: Profile): Profile {
  return {
    ...profile,
    name: "Full Brick",
    mode: "blocklist",
    description: "Removes social apps and blocks social sites while leaving unrelated work and system apps alone.",
    blockedApps: [...FULL_BRICK_BLOCKED_APPS],
    blockedSites: [...DEFAULT_BLOCKED_SITES],
    blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS, ...DEFAULT_SHORT_FORM_URL_PATTERNS],
    allowedApps: [...DEFAULT_ALLOWED_APPS],
    allowedSites: [...DEFAULT_ALLOWED_SITES],
    hostsUrlPatternBlocking: false
  };
}

function sanitizeRedditUrlPolicyProfile(
  profile: Profile,
  options: { blockedUrlPatterns: string[]; phoneAppBlocking?: false; hostsUrlPatternBlocking?: false }
): Profile {
  return {
    ...profile,
    blockedSites: (profile.blockedSites || []).filter((site) => !isRedditSiteTarget(site)),
    blockedUrlPatterns: uniqueList([
      ...withoutFocusedSocialDeniedUrls((profile.blockedUrlPatterns || []).filter((pattern) => !isRedditWholeSitePattern(pattern))),
      ...options.blockedUrlPatterns
    ]),
    phoneAppBlocking: options.phoneAppBlocking === false ? false : profile.phoneAppBlocking,
    hostsUrlPatternBlocking: options.hostsUrlPatternBlocking === false ? false : profile.hostsUrlPatternBlocking
  };
}

function sanitizeBuiltinProfile(profile: Profile): Profile {
  if (profile.id === "default") return sanitizeDefaultFocusProfile(profile);
  if (profile.id === NORMAL_PROFILE_ID) return sanitizeNormalProfile(profile);
  if (profile.id === SOFT_BLOCK_PROFILE_ID) return sanitizeSoftBlockProfile(profile);
  if (profile.id === BRICK_MODE_PROFILE_ID) return sanitizeFullBrickProfile(profile);
  return profile;
}

function cloneProfile(profile: Profile): Profile {
  return {
    ...profile,
    blockedApps: [...(profile.blockedApps || [])],
    blockedSites: [...(profile.blockedSites || [])],
    blockedUrlPatterns: [...(profile.blockedUrlPatterns || [])],
    allowedApps: [...(profile.allowedApps || [])],
    allowedSites: [...(profile.allowedSites || [])],
    phoneAppBlocking: profile.phoneAppBlocking === false ? false : undefined,
    hostsUrlPatternBlocking: profile.hostsUrlPatternBlocking === false ? false : undefined
  };
}

function uniqueList(values: unknown[] = []): string[] {
  return [...new Set((values || []).map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeDomainList(values: unknown): string[] {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  return [...new Set(source.map(normalizeHostTarget).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function nullableString(value: unknown): string | null {
  const text = String(value || "").trim();
  return text || null;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

async function writeStateAndSeal(state: VigilState, sealedAt: string): Promise<void> {
  const text = await serializeStoredState(state);
  await writeJsonText(STATE_PATH, text);
  await writeStateTextSeal(text, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH, scope: "state" }, sealedAt);
}

async function serializeStoredState(state: VigilState): Promise<string> {
  const storedState = state as unknown as RawState;
  const intentionalUse = storedState.intentionalUse as unknown as UnknownRecord | undefined;
  if (intentionalUse) {
    intentionalUse.journalEntriesEncrypted = await encryptJournalEntries(intentionalUse.journalEntries, DATA_DIR);
    delete intentionalUse.journalEntries;
  }
  return jsonText(storedState);
}

async function restoreJournalEntries(state: RawState): Promise<boolean> {
  const intentionalUse = state.intentionalUse as unknown as UnknownRecord | undefined;
  if (!intentionalUse) return false;
  if (hasEncryptedJournalEntries(intentionalUse)) {
    intentionalUse.journalEntries = await decryptJournalEntries(intentionalUse.journalEntriesEncrypted, DATA_DIR);
    delete intentionalUse.journalEntriesEncrypted;
    return false;
  }
  return Array.isArray(intentionalUse.journalEntries);
}

async function writeUsageSnapshot(usage: UsageState): Promise<void> {
  const sealedAt = new Date().toISOString();
  const text = jsonText(usage);
  await writeJsonText(USAGE_PATH, text);
  await writeStateTextSeal(text, {
    keyPath: STATE_SEAL_KEY_PATH,
    sealPath: USAGE_SEAL_PATH
  }, sealedAt);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function writeJsonText(path: string, text: string): Promise<void> {
  await ensurePrivateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(temp, PRIVATE_FILE_MODE);
    await rename(temp, path);
    await chmod(path, PRIVATE_FILE_MODE);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function readUsageText(): Promise<{ exists: boolean; text: string }> {
  try {
    const text = await readFile(USAGE_PATH, "utf8");
    await chmod(USAGE_PATH, PRIVATE_FILE_MODE);
    return { exists: true, text };
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return { exists: false, text: "{}\n" };
    throw error;
  }
}

function parseUsageText(text: string): UsageState {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Usage data must be a JSON object.");
  }
  return parsed as UsageState;
}

function markUsageSealRequired(state: VigilState, now = new Date()): void {
  state.integrity.usageSeal = {
    required: true,
    migrationVersion: 1,
    migratedAt: state.integrity.usageSeal.migratedAt || now.toISOString()
  };
}

async function recoverUsageConservatively(state: VigilState, reason: string, now = new Date()): Promise<UsageState> {
  const usage = conservativeUsageState(state, now);
  await saveUsage(usage);
  markUsageSealRequired(state, now);

  const detail = `Usage integrity failure: ${reason} Usage counters were recovered conservatively.`;
  const stateSeal = state.integrity.stateSeal;
  const previousDetail = String(stateSeal.tamperDetail || "").trim();
  stateSeal.tamperDetectedAt ||= now.toISOString();
  stateSeal.tamperDetail = previousDetail && previousDetail !== detail
    ? `${previousDetail} ${detail}`
    : detail;
  stateSeal.lastStatus = "tamper-detected";
  stateSeal.lastDetail = detail;
  stateSeal.lastCheckedAt = now.toISOString();
  await saveState(state);
  return usage;
}

function conservativeUsageState(state: VigilState, now = new Date()): UsageState {
  const maximumSeconds = 24 * 60 * 60;
  const maximumOpens = 100_000;
  const apps: Record<string, number> = {};
  const sites: Record<string, number> = {};
  for (const rule of state.limitRules || []) {
    for (const app of rule.apps || []) apps[app] = maximumSeconds;
    for (const site of rule.sites || []) sites[site] = maximumSeconds;
  }
  return {
    [dateKey(now)]: {
      totalSeconds: maximumSeconds,
      apps,
      sites,
      opens: {
        apps: Object.fromEntries(Object.keys(apps).map((app) => [app, maximumOpens])),
        sites: Object.fromEntries(Object.keys(sites).map((site) => [site, maximumOpens]))
      },
      devices: {},
      updatedAt: now.toISOString()
    }
  };
}

function usageSealFailureDetail(status: string): string {
  switch (status) {
    case "missing": return "The usage seal key and seal file are missing.";
    case "missing-key": return "The usage seal key is missing.";
    case "missing-seal": return "The usage seal file is missing.";
    case "invalid-seal": return "The usage seal file is invalid.";
    case "mismatch": return "The usage file does not match its integrity seal.";
    default: return `The usage integrity check failed with status ${status}.`;
  }
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isInstagramSiteTarget(value: unknown): boolean {
  return ["instagram.com", "cdninstagram.com"].includes(normalizeHostTarget(value));
}

function isRedditSiteTarget(value: unknown): boolean {
  return ["reddit.com", "redd.it"].includes(normalizeHostTarget(value));
}

function isRedditWholeSitePattern(value: unknown): boolean {
  const pattern = normalizePatternTarget(value).replace(/\/+$/, "");
  return pattern === "reddit.com" || pattern === "redd.it";
}

function normalizeHostTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
}

function normalizePatternTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "")
    .replace(/^\/+$/, "");
}

function normalizeSchedules(schedules: Schedule[]): Schedule[] {
  return schedules.map((schedule) => ({
    ...schedule,
    wifiNetworks: Array.isArray(schedule.wifiNetworks) ? schedule.wifiNetworks : [],
    commitmentLock: Boolean(schedule.commitmentLock)
  }));
}

function normalizeGrayscaleState(value: unknown, fallback: GrayscaleState): GrayscaleState {
  const raw = value && typeof value === "object" ? value as Partial<GrayscaleState> : {};
  return {
    softBlockEnabled: Boolean(raw.softBlockEnabled),
    preventManualChanges: raw.preventManualChanges === false ? false : fallback.preventManualChanges,
    schedules: Array.isArray(raw.schedules)
      ? raw.schedules.map(normalizeGrayscaleSchedule).filter((schedule) => schedule.name)
      : []
  };
}

function normalizeGrayscaleSchedule(schedule: Partial<GrayscaleSchedule>): GrayscaleSchedule {
  return {
    id: String(schedule.id || randomUUID()),
    name: String(schedule.name || "Grayscale schedule").slice(0, 80),
    enabled: Boolean(schedule.enabled),
    days: normalizeWeekdays(schedule.days, { fallback: [0, 1, 2, 3, 4, 5, 6], integersOnly: true, sort: false }),
    start: normalizeClock(schedule.start, "22:00"),
    end: normalizeClock(schedule.end, "07:00"),
    deviceTargets: normalizeDeviceTargetList(schedule.deviceTargets)
  };
}

function normalizeDeviceTargetList(value: unknown): Array<"computer" | "phone"> {
  const source = Array.isArray(value) ? value : [];
  const targets = [...new Set(source.map((item) => String(item || "").trim().toLowerCase()).filter((item) => item === "computer" || item === "phone"))];
  return targets.length ? targets as Array<"computer" | "phone"> : ["computer", "phone"];
}

function normalizeProfiles(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => ({
    ...profile,
    blockedApps: Array.isArray(profile.blockedApps) ? profile.blockedApps : [],
    blockedSites: Array.isArray(profile.blockedSites) ? profile.blockedSites : [],
    blockedUrlPatterns: Array.isArray(profile.blockedUrlPatterns) ? profile.blockedUrlPatterns : [],
    allowedApps: Array.isArray(profile.allowedApps) ? profile.allowedApps : [],
    allowedSites: Array.isArray(profile.allowedSites) ? profile.allowedSites : [],
    phoneAppBlocking: profile.phoneAppBlocking === false ? false : undefined,
    hostsUrlPatternBlocking: profile.hostsUrlPatternBlocking === false ? false : undefined
  }));
}

function normalizeLimitRules(existingRules: VigilState["limitRules"], builtinRules: VigilState["limitRules"]): VigilState["limitRules"] {
  const builtinById = new Map(builtinRules.map((rule) => [rule.id, rule]));
  const mergedExisting = existingRules.map((rule) => {
    const builtin = builtinById.get(rule.id);
    if (!builtin) return rule;
    return {
      ...rule,
      requiredProfileId: builtin.requiredProfileId || rule.requiredProfileId,
      excludedProfileIds: uniqueList([
        ...(rule.excludedProfileIds || []),
        ...(builtin.excludedProfileIds || [])
      ])
    };
  });
  const existingIds = new Set(mergedExisting.map((rule) => rule.id).filter(Boolean));
  const missingBuiltins = builtinRules.filter((rule) => rule.id && !existingIds.has(rule.id));
  return [...mergedExisting, ...missingBuiltins.map(cloneLimitRule)];
}

function cloneLimitRule(rule: VigilState["limitRules"][number]): VigilState["limitRules"][number] {
  return {
    ...rule,
    apps: [...rule.apps],
    sites: [...rule.sites],
    days: [...rule.days],
    excludedProfileIds: rule.excludedProfileIds ? [...rule.excludedProfileIds] : undefined
  };
}

function migrateActiveSessions(
  state: RawState,
  fresh: VigilState,
  profiles: Profile[]
): Partial<Record<"computer" | "phone", Session | null>> {
  const existing = state.activeSessions && typeof state.activeSessions === "object"
    ? state.activeSessions
    : null;
  const legacy = state.activeSession || null;
  return {
    ...fresh.activeSessions,
    computer: migrateSessionProfileSnapshot(existing?.computer || legacy || null, profiles),
    phone: migrateSessionProfileSnapshot(existing?.phone || (!existing && legacy ? legacy : null), profiles)
  };
}

function migrateSessionProfileSnapshot(session: Session | null, profiles: Profile[]): Session | null {
  if (!session) return null;
  const profileId = session.profileSnapshot?.id || session.profileId;
  const fallback = profiles.find((profile) => profile.id === profileId);
  const profileSnapshot = session.profileSnapshot || fallback;
  if (!profileSnapshot) return session;
  if (!session.profileSnapshot && profileId !== SOFT_BLOCK_PROFILE_ID) return session;
  return {
    ...session,
    profileSnapshot: sanitizeBuiltinProfile(profileSnapshot)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
