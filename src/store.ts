import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzip, gunzip } from "node:zlib";
import { preserveCorruptStateEvidence } from "./corruptStateEvidence.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT, DEFAULT_ADULT_BLOCKLIST_SOURCE_ID, DEFAULT_ALLOWED_APPS, DEFAULT_ALLOWED_SITES, DEFAULT_ALWAYS_BANNED_URL_PATTERNS, DEFAULT_BLOCKED_SITES, DEFAULT_EXPLICIT_BLOCKED_SITES, DEFAULT_EXPLICIT_URL_PATTERNS, DEFAULT_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, DEFAULT_SHORT_FORM_URL_PATTERNS, FULL_BRICK_BLOCKED_APPS, NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } from "./defaults.js";
import { normalizeIntentionalUse } from "./intentionalUse.js";
import { decryptJournalEntries, encryptJournalEntries, hasEncryptedJournalEntries } from "./journalEncryption.js";
import { resolveDefaultDataDir } from "./dataPaths.js";
import { compactExtensionRuleSignature } from "./extensionRuleSignature.js";
import { normalizeWeekdays } from "./normalizers.js";
import { applySealVerificationToState, createStateTextSeal, markStateSealed, verifyStateTextSeal, writeStateTextSeal } from "./seal.js";
import { withoutFocusedSocialDeniedUrls } from "./socialFeatureFilters.js";
import { dateKey, normalizeClock } from "./time.js";
import type { AdultBlocklistState, AppSettings, FunctionalEventState, FunctionalSessionRecord, GrayscaleSchedule, GrayscaleState, Profile, Schedule, StateEvent, VigilState, Session, UsageState, UnknownRecord } from "./types.js";

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
export const STATE_EVENT_HISTORY_MAX = 250;
export const STATE_EVENT_MAX_BYTES = 768;
// Intervention settings saturate by 3,649 attempts even at their most extreme
// allowed values. Retaining 4,096 keeps friction fail-closed while bounding an
// abusive input burst independently of the display-oriented event history.
export const FUNCTIONAL_BLOCK_ATTEMPT_HISTORY_MAX = 4_096;
export const FUNCTIONAL_SESSION_HISTORY_MAX = 4_096;
const FUNCTIONAL_BLOCK_ATTEMPT_RETENTION_MS = 4 * 60 * 60 * 1000;
const FUNCTIONAL_SESSION_RETENTION_MS = 2 * 24 * 60 * 60 * 1000;
const FUNCTIONAL_DAILY_COUNT_HISTORY_MAX = 32;
const INTERVENTION_BLOCK_EVENT_TYPES = new Set(["blocked_app", "blocked_site", "extension_blocked_site"]);
const USAGE_BLOCK_EVENT_TYPES = new Set([
  "blocked_app", "blocked_browser_control", "blocked_content", "blocked_site", "blocked_url", "extension_blocked_site"
]);
const STATE_EVENT_STRING_MAX_BYTES = 192;
const STATE_EVENT_ARRAY_MAX_ITEMS = 12;
const STATE_EVENT_OBJECT_MAX_KEYS = 24;
const STATE_EVENT_MAX_DEPTH = 4;
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
  // Event compaction is persisted by the first coordinated runtime snapshot.
  // Avoid introducing a startup-only state-then-seal crash window merely to
  // rewrite non-protected audit history.
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
  const stateSeal = await createStateTextSeal(stateText, {
    keyPath: STATE_SEAL_KEY_PATH,
    scope: "state"
  }, sealedAt);
  const usageSeal = await createStateTextSeal(usageText, {
    keyPath: STATE_SEAL_KEY_PATH
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
  const journalBytes = await gzipText(journalText);
  const temp = `${RUNTIME_SNAPSHOT_JOURNAL_PATH}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, journalBytes, { flag: "wx", mode: PRIVATE_FILE_MODE });
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
    await writeDurableReplacement(path, journal.files[name].text, { syncParent: false });
    await snapshotBoundary(`${name}-published`, boundary);
  }
  await syncDirectory(DATA_DIR);
  await snapshotBoundary("canonical-directory-fsynced", boundary);
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
    const journalText = await decodeRuntimeSnapshotJournal(raw);
    journal = JSON.parse(journalText) as RuntimeSnapshotJournal;
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

async function writeDurableReplacement(
  path: string,
  text: string,
  { syncParent = true }: { syncParent?: boolean } = {}
): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(temp, PRIVATE_FILE_MODE);
    await syncFile(temp);
    await rename(temp, path);
    if (syncParent) await syncDirectory(dirname(path));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function gzipText(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(Buffer.from(text, "utf8"), { level: 1 }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
}

async function decodeRuntimeSnapshotJournal(raw: Buffer): Promise<string> {
  if (raw[0] !== 0x1f || raw[1] !== 0x8b) return raw.toString("utf8");
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    gunzip(raw, { maxOutputLength: MAX_RUNTIME_SNAPSHOT_JOURNAL_BYTES }, (error, value) => {
      if (error) reject(error);
      else resolve(value);
    });
  });
  if (decoded.byteLength > MAX_RUNTIME_SNAPSHOT_JOURNAL_BYTES) {
    throw new Error("Runtime snapshot journal exceeds the aggregate size limit.");
  }
  return decoded.toString("utf8");
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
  const event = compactStateEvents([{
    id: randomUUID(),
    type,
    detail: detail as UnknownRecord,
    at: new Date().toISOString()
  }])[0]!;
  const functionalEvents = state.functionalEvents?.version === 1
    ? state.functionalEvents
    : normalizeFunctionalEventState(state.functionalEvents, state.events);
  state.functionalEvents = functionalEventRelevant(event.type)
    ? recordFunctionalEvent(functionalEvents, event)
    : functionalEvents;
  state.events = compactStateEvents([event, ...(state.events || [])]);
}

function normalizeFunctionalEventState(
  value: unknown,
  legacyEvents: unknown = [],
  now = new Date()
): FunctionalEventState {
  if (!value || typeof value !== "object" || Array.isArray(value) || Number((value as UnknownRecord).version) !== 1) {
    const functional = emptyFunctionalEventState();
    const source = Array.isArray(legacyEvents) ? legacyEvents : [];
    for (let index = source.length - 1; index >= 0; index -= 1) {
      const event = compactStateEvent(source[index]);
      if (event) applyFunctionalEvent(functional, event);
    }
    return pruneFunctionalEventState(functional, now);
  }
  const raw = value as Partial<FunctionalEventState>;
  const attempts = (Array.isArray(raw.blockAttempts) ? raw.blockAttempts : [])
    .flatMap((attempt) => {
      if (!attempt || typeof attempt !== "object") return [];
      const at = String(attempt.at || "");
      if (!Number.isFinite(Date.parse(at))) return [];
      return [{
        at,
        type: boundedAuditString(attempt.type, 96),
        targetType: boundedAuditString(attempt.targetType, 32),
        targetLabel: boundedAuditString(attempt.targetLabel, STATE_EVENT_STRING_MAX_BYTES)
      }];
    });
  const counts = Object.fromEntries(
    Object.entries(raw.dailyBlockCounts || {})
      .filter(([day, count]) => /^\d{4}-\d{2}-\d{2}$/u.test(day) && Number.isFinite(Number(count)) && Number(count) > 0)
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, FUNCTIONAL_DAILY_COUNT_HISTORY_MAX)
      .map(([day, count]) => [day, Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(Number(count))))])
  );
  const sessions = normalizeFunctionalSessions(raw.sessions, now);
  const firstSessionStartedAt = nullableFunctionalTimestamp(raw.firstSessionStartedAt);
  return pruneFunctionalEventState({
    version: 1,
    blockAttempts: attempts,
    dailyBlockCounts: counts,
    sessions,
    firstSessionStartedAt
  }, now);
}

function recordFunctionalEvent(
  source: FunctionalEventState,
  event: StateEvent,
  now = new Date()
): FunctionalEventState {
  const next: FunctionalEventState = {
    version: 1,
    blockAttempts: [...source.blockAttempts],
    dailyBlockCounts: { ...source.dailyBlockCounts },
    sessions: source.sessions.map((session) => ({ ...session })),
    firstSessionStartedAt: source.firstSessionStartedAt
  };
  applyFunctionalEvent(next, event);
  return pruneFunctionalEventState(next, now);
}

function applyFunctionalEvent(next: FunctionalEventState, event: StateEvent): void {
  if (INTERVENTION_BLOCK_EVENT_TYPES.has(event.type)) {
    const target = functionalEventTarget(event);
    next.blockAttempts.unshift({
      at: event.at,
      type: event.type,
      targetType: target.type,
      targetLabel: target.label
    });
  }
  if (USAGE_BLOCK_EVENT_TYPES.has(event.type)) {
    const at = new Date(event.at);
    if (Number.isFinite(at.getTime())) {
      const day = dateKey(at);
      next.dailyBlockCounts[day] = Math.min(Number.MAX_SAFE_INTEGER, (next.dailyBlockCounts[day] || 0) + 1);
    }
  }
  if (["session_started", "panic_lock_started", "session_ended"].includes(event.type)) {
    const detail = event.detail || {};
    const id = boundedAuditString(detail.id, 128);
    if (id) {
      const existing = next.sessions.find((session) => session.id === id) || { id };
      const updated: FunctionalSessionRecord = {
        ...existing,
        startedAt: nullableFunctionalTimestamp(existing.startedAt || detail.startedAt) || undefined,
        endsAt: nullableFunctionalTimestamp(detail.endsAt || existing.endsAt) || undefined,
        endedAt: event.type === "session_ended"
          ? event.at
          : nullableFunctionalTimestamp(existing.endedAt) || undefined
      };
      next.sessions = [updated, ...next.sessions.filter((session) => session.id !== id)];
    }
  }
  if (event.type === "session_started" && !next.firstSessionStartedAt) {
    next.firstSessionStartedAt = event.at;
  }
}

function functionalEventRelevant(type: string): boolean {
  return INTERVENTION_BLOCK_EVENT_TYPES.has(type)
    || USAGE_BLOCK_EVENT_TYPES.has(type)
    || ["session_started", "panic_lock_started", "session_ended"].includes(type);
}

function pruneFunctionalEventState(value: FunctionalEventState, now = new Date()): FunctionalEventState {
  const nowMs = now.getTime();
  const attemptCutoff = nowMs - FUNCTIONAL_BLOCK_ATTEMPT_RETENTION_MS;
  const blockAttempts = value.blockAttempts
    .filter((attempt) => {
      const at = Date.parse(attempt.at);
      return Number.isFinite(at) && at >= attemptCutoff && at <= nowMs + 5 * 60 * 1000;
    })
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, FUNCTIONAL_BLOCK_ATTEMPT_HISTORY_MAX);
  const dailyBlockCounts = Object.fromEntries(
    Object.entries(value.dailyBlockCounts)
      .filter(([, count]) => Number.isFinite(count) && count > 0)
      .sort(([left], [right]) => right.localeCompare(left))
      .slice(0, FUNCTIONAL_DAILY_COUNT_HISTORY_MAX)
  );
  return {
    version: 1,
    blockAttempts,
    dailyBlockCounts,
    sessions: normalizeFunctionalSessions(value.sessions, now),
    firstSessionStartedAt: nullableFunctionalTimestamp(value.firstSessionStartedAt)
  };
}

function normalizeFunctionalSessions(value: unknown, now = new Date()): FunctionalSessionRecord[] {
  const cutoff = now.getTime() - FUNCTIONAL_SESSION_RETENTION_MS;
  const sessions = new Map<string, FunctionalSessionRecord>();
  for (const candidate of Array.isArray(value) ? value : []) {
    if (!candidate || typeof candidate !== "object") continue;
    const raw = candidate as Partial<FunctionalSessionRecord>;
    const id = boundedAuditString(raw.id, 128);
    if (!id) continue;
    const session: FunctionalSessionRecord = {
      id,
      startedAt: nullableFunctionalTimestamp(raw.startedAt) || undefined,
      endsAt: nullableFunctionalTimestamp(raw.endsAt) || undefined,
      endedAt: nullableFunctionalTimestamp(raw.endedAt) || undefined
    };
    const lastRelevantAt = Date.parse(session.endedAt || session.endsAt || session.startedAt || "");
    if (!Number.isFinite(lastRelevantAt) || lastRelevantAt < cutoff) continue;
    const existing = sessions.get(id);
    sessions.set(id, existing ? {
      ...existing,
      startedAt: existing.startedAt || session.startedAt,
      endsAt: session.endsAt || existing.endsAt,
      endedAt: session.endedAt || existing.endedAt
    } : session);
  }
  return [...sessions.values()]
    .sort((left, right) => functionalSessionSortTime(right) - functionalSessionSortTime(left))
    .slice(0, FUNCTIONAL_SESSION_HISTORY_MAX);
}

function functionalSessionSortTime(session: FunctionalSessionRecord): number {
  const value = Date.parse(session.endedAt || session.endsAt || session.startedAt || "");
  return Number.isFinite(value) ? value : 0;
}

function nullableFunctionalTimestamp(value: unknown): string | null {
  const text = String(value || "");
  return Number.isFinite(Date.parse(text)) ? text : null;
}

function functionalEventTarget(event: StateEvent): { type: string; label: string } {
  const detail = event.detail || {};
  if (detail.site) return { type: "site", label: boundedAuditString(detail.site, STATE_EVENT_STRING_MAX_BYTES) };
  if (detail.app) return { type: "app", label: boundedAuditString(detail.app, STATE_EVENT_STRING_MAX_BYTES) };
  if (detail.target) return { type: "target", label: boundedAuditString(detail.target, STATE_EVENT_STRING_MAX_BYTES) };
  return { type: "target", label: event.type.replaceAll("_", " ") };
}

function emptyFunctionalEventState(): FunctionalEventState {
  return { version: 1, blockAttempts: [], dailyBlockCounts: {}, sessions: [], firstSessionStartedAt: null };
}

/** Keep the audit trail useful and deterministic while preventing diagnostic
 * payloads (especially URLs and effect receipts) from becoming state storage. */
export function compactStateEvents(value: unknown): StateEvent[] {
  if (!Array.isArray(value)) return [];
  const compacted: StateEvent[] = [];
  for (const candidate of value) {
    const event = compactStateEvent(candidate);
    if (event) compacted.push(event);
    if (compacted.length >= STATE_EVENT_HISTORY_MAX) break;
  }
  return compacted;
}

function compactStateEvent(value: unknown): StateEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Partial<StateEvent>;
  const id = boundedAuditString(source.id, 128);
  const type = boundedAuditString(source.type, 96);
  const at = boundedAuditString(source.at, 64);
  if (!id || !type || !at || !Number.isFinite(Date.parse(at))) return null;
  const rawDetail = source.detail && typeof source.detail === "object" && !Array.isArray(source.detail)
    ? source.detail as UnknownRecord
    : {};
  const plainDetail = jsonCompatibleRecord(rawDetail);
  let detail: UnknownRecord;
  const unchanged: StateEvent = { id, type, at, detail: plainDetail };
  if (plainDetail.compacted === true && serializedBytes(unchanged) <= STATE_EVENT_MAX_BYTES) {
    return unchanged;
  }
  if (serializedBytes(unchanged) <= STATE_EVENT_MAX_BYTES) return unchanged;
  const known = knownEventSummary(type, plainDetail);
  if (known) {
    detail = compactedDetail(plainDetail, known);
  } else {
    detail = compactedDetail(plainDetail, genericEventSummary(plainDetail));
  }
  return fitEventToLimit({ id, type, at, detail });
}

function knownEventSummary(type: string, detail: UnknownRecord): UnknownRecord | null {
  if (type.startsWith("monitor_os_effect_")) return monitorEffectEventSummary(detail);
  if (type.startsWith("blocked_") || type === "extension_blocked_site") return blockedEventSummary(detail);
  if (["session_started", "session_ended", "panic_lock_started"].includes(type)) return sessionEventSummary(detail);
  if (["policy_immediate_enforcement", "session_immediate_enforcement"].includes(type)) {
    return compactRecord({
      reason: detail.reason,
      sessionId: detail.sessionId,
      ok: detail.ok,
      result: resultEventSummary(detail.result)
    });
  }
  return null;
}

function monitorEffectEventSummary(detail: UnknownRecord): UnknownRecord {
  const payload = asAuditRecord(detail.payload);
  const kind = boundedAuditString(detail.kind || payload.action, 80);
  return compactRecord({
    kind,
    key: compactMonitorEffectKey(kind, detail.key || payload.intentKey, payload),
    app: payload.app,
    hostname: auditHostname(payload.hostname || payload.currentUrl || payload.url),
    policyId: payload.policyId,
    sessionId: payload.sessionId,
    reason: payload.reason,
    desired: payload.desired,
    force: payload.force,
    result: resultEventSummary(detail.result),
    error: detail.error
  });
}

function blockedEventSummary(detail: UnknownRecord): UnknownRecord {
  const browserControl = asAuditRecord(detail.browserControl);
  const contentFilter = asAuditRecord(detail.contentFilter);
  const urlPattern = asAuditRecord(detail.urlPattern);
  return compactRecord({
    site: auditTarget(detail.site),
    app: detail.app,
    target: auditTarget(detail.target),
    originalSite: auditTarget(detail.originalSite),
    policy: detail.policy,
    browserControl: compactRecord({ id: browserControl.id, area: browserControl.area, label: browserControl.label }),
    contentFilter: compactRecord({ id: contentFilter.id, label: contentFilter.label }),
    urlPattern: Object.keys(urlPattern).length ? compactRecord({
      id: urlPattern.id,
      label: urlPattern.label,
      patternSha256: detailDigest(urlPattern.pattern)
    }) : undefined,
    result: resultEventSummary(detail.result),
    coolingDownRetry: detail.coolingDownRetry
  });
}

function sessionEventSummary(detail: UnknownRecord): UnknownRecord {
  const profileSnapshot = asAuditRecord(detail.profileSnapshot);
  return compactRecord({
    id: detail.id,
    title: detail.title,
    mode: detail.mode,
    profileId: detail.profileId,
    lockLevel: detail.lockLevel,
    startedAt: detail.startedAt,
    endsAt: detail.endsAt,
    endedAt: detail.endedAt,
    endedTarget: detail.endedTarget,
    source: detail.source,
    deviceTargets: detail.deviceTargets,
    canEndEarly: detail.canEndEarly,
    emergencyUnlocksAllowed: detail.emergencyUnlocksAllowed,
    commitmentLock: detail.commitmentLock,
    durationMinutes: detail.durationMinutes,
    profileSnapshotSha256: Object.keys(profileSnapshot).length ? detailDigest(profileSnapshot) : undefined
  });
}

function resultEventSummary(value: unknown): UnknownRecord | undefined {
  const result = asAuditRecord(value);
  if (!Object.keys(result).length) return undefined;
  return compactRecord({
    ok: result.ok,
    status: result.status,
    method: result.method,
    skipped: result.skipped,
    error: result.error,
    code: result.code,
    action: result.action,
    app: result.app,
    hostname: auditHostname(result.hostname || result.url),
    target: auditTarget(result.target),
    desired: result.desired,
    enabled: result.enabled,
    current: result.current,
    escalated: result.escalated,
    pushed: result.pushed,
    failed: result.failed,
    blocked: result.blocked,
    killed: result.killed
  });
}

const GENERIC_AUDIT_KEYS = [
  "id", "requestId", "sessionId", "policyId", "profileId", "ruleId", "lockId", "scheduleId",
  "app", "site", "target", "name", "title", "label", "ruleName", "kind", "status", "reason", "mode", "source",
  "startedAt", "createdAt", "checkedAt", "endsAt", "endedAt", "expiredAt", "until", "expiresAt", "at",
  "ok", "enabled", "desired", "current", "force", "cleared", "rotated", "error", "detail", "message",
  "bytes", "count", "keys", "deviceTargets", "evidencePath"
] as const;

function genericEventSummary(detail: UnknownRecord): UnknownRecord {
  const summary: UnknownRecord = {};
  for (const key of GENERIC_AUDIT_KEYS) {
    if (!Object.hasOwn(detail, key)) continue;
    const compacted = compactAuditValue(detail[key], 0, new Set());
    if (compacted !== undefined) summary[key] = compacted;
  }
  return summary;
}

function compactedDetail(original: UnknownRecord, summary: UnknownRecord): UnknownRecord {
  const text = safeJsonText(original);
  return {
    ...summary,
    compacted: true,
    originalBytes: Buffer.byteLength(text, "utf8"),
    detailSha256: createHash("sha256").update(text, "utf8").digest("hex")
  };
}

function fitEventToLimit(event: StateEvent): StateEvent {
  if (serializedBytes(event) <= STATE_EVENT_MAX_BYTES) return event;
  const detail = { ...event.detail };
  const metadata = new Set(["compacted", "originalBytes", "detailSha256"]);
  const removable = Object.keys(detail).filter((key) => !metadata.has(key));
  while (serializedBytes({ ...event, detail }) > STATE_EVENT_MAX_BYTES && removable.length) {
    delete detail[removable.pop()!];
  }
  if (serializedBytes({ ...event, detail }) <= STATE_EVENT_MAX_BYTES) return { ...event, detail };
  return {
    ...event,
    detail: {
      compacted: true,
      originalBytes: Number(detail.originalBytes || 0),
      detailSha256: boundedAuditString(detail.detailSha256, 64)
    }
  };
}

function jsonCompatibleRecord(value: UnknownRecord): UnknownRecord {
  try {
    const parsed: unknown = JSON.parse(JSON.stringify(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as UnknownRecord : {};
  } catch {
    const compacted = compactAuditValue(value, 0, new Set());
    return compacted && typeof compacted === "object" && !Array.isArray(compacted) ? compacted as UnknownRecord : {};
  }
}

function compactAuditValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return boundedAuditString(value.toString(), STATE_EVENT_STRING_MAX_BYTES);
  if (typeof value === "string") return boundedAuditString(value, STATE_EVENT_STRING_MAX_BYTES);
  if (typeof value !== "object" || depth >= STATE_EVENT_MAX_DEPTH) return undefined;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, STATE_EVENT_ARRAY_MAX_ITEMS)
        .map((item) => compactAuditValue(item, depth + 1, seen))
        .filter((item) => item !== undefined);
    }
    const output: UnknownRecord = {};
    for (const [key, item] of Object.entries(value).slice(0, STATE_EVENT_OBJECT_MAX_KEYS)) {
      const compacted = compactAuditValue(item, depth + 1, seen);
      if (compacted !== undefined) output[boundedAuditString(key, 80)] = compacted;
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function compactRecord(value: UnknownRecord): UnknownRecord {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (item === undefined || item === null || item === "") return [];
    if (typeof item === "object" && !Array.isArray(item) && !Object.keys(item as object).length) return [];
    const compacted = compactAuditValue(item, 0, new Set());
    return compacted === undefined ? [] : [[key, compacted]];
  }));
}

function compactMonitorEffectKey(kind: string, value: unknown, payload: UnknownRecord): string {
  const key = String(value || "");
  if (/^monitor-os:[^:]+:[a-f\d]{64}$/u.test(key)) return key;
  const source = key || safeJsonText(payload);
  const digest = createHash("sha256").update(source, "utf8").digest("hex");
  return `monitor-os:${kind || "effect"}:${digest}`;
}

function auditTarget(value: unknown): string {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return boundedAuditString(url.hostname || text, STATE_EVENT_STRING_MAX_BYTES);
  } catch {
    return boundedAuditString(text, STATE_EVENT_STRING_MAX_BYTES);
  }
}

function auditHostname(value: unknown): string {
  return auditTarget(value);
}

function asAuditRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
}

function boundedAuditString(value: unknown, maxBytes = STATE_EVENT_STRING_MAX_BYTES): string {
  const text = String(value || "");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = `…[${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}]`;
  const available = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let prefix = "";
  let bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > available) break;
    prefix += character;
    bytes += size;
  }
  return `${prefix}${suffix}`;
}

function detailDigest(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return createHash("sha256").update(safeJsonText(value), "utf8").digest("hex");
}

function safeJsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return JSON.stringify(compactAuditValue(value, 0, new Set())) ?? "null";
  }
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(safeJsonText(value), "utf8");
}

function migrateState(state: RawState): VigilState {
  const fresh = defaultState();
  const rawProfiles = Array.isArray(state.profiles) && state.profiles.length ? state.profiles : fresh.profiles;
  const profiles = normalizeProfiles(migrateBuiltinProfiles(mergeBuiltinProfiles(rawProfiles, fresh.profiles)));
  const settings = migrateSettings({ ...fresh.settings, ...(state.settings || {}) });
  const activeSessions = migrateActiveSessions(state, fresh, profiles);
  const events = compactStateEvents(state.events);
  const runtime = { ...((state.integrity?.runtime || {}) as UnknownRecord) };
  delete runtime.lastHeartbeatAt;
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
        ...runtime
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
    functionalEvents: normalizeFunctionalEventState(state.functionalEvents, state.events),
    events
  };
}

function migrateSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  // Keep persisted cadence choices exact. New installs use the event-driven
  // default, while an existing explicit three-second safety cadence remains a
  // three-second cadence because it cannot be distinguished from the old default.
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
    blockedSites: uniqueList([
      ...(profile.blockedSites || []).filter((site) => !isInstagramSiteTarget(site) && !isRedditSiteTarget(site)),
      ...DEFAULT_EXPLICIT_BLOCKED_SITES,
      ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES,
      ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES
    ]),
    blockedUrlPatterns,
    phoneAppBlocking: false,
    hostsUrlPatternBlocking: false
  };
}

export function sanitizeDefaultFocusProfile(profile: Profile): Profile {
  const sanitized = sanitizeRedditUrlPolicyProfile(profile, {
    blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS, ...DEFAULT_SHORT_FORM_URL_PATTERNS],
    hostsUrlPatternBlocking: false
  });
  return {
    ...sanitized,
    blockedSites: uniqueList([
      ...(sanitized.blockedSites || []),
      ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES,
      ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES
    ])
  };
}

function sanitizeNormalProfile(profile: Profile): Profile {
  return {
    ...profile,
    description: "Normal use with permanent explicit-content, YouTube Shorts, and Snapchat Spotlight/Discover protection.",
    blockedApps: [],
    blockedSites: [...DEFAULT_EXPLICIT_BLOCKED_SITES, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES],
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
    blockedSites: [...DEFAULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES],
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
  return `${JSON.stringify(value)}\n`;
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
  const socialCompanionByNativeBundleId = new Map([
    ["com.burbn.instagram", "tech.caseline.vigil.instagram"],
    ["com.google.ios.youtube", "tech.caseline.vigil.youtube"],
    ["com.toyopagroup.picaboo", "tech.caseline.vigil.snapchat"]
  ]);
  const mergedExisting = existingRules.map((rule) => {
    const builtin = builtinById.get(rule.id);
    const targetedCompanionApps = rule.apps.flatMap((app) => {
      const companion = socialCompanionByNativeBundleId.get(String(app).trim().toLowerCase());
      return companion ? [companion] : [];
    });
    if (!builtin) {
      if (!targetedCompanionApps.length) return rule;
      return {
        ...rule,
        // Custom limits that explicitly target a native social app must also
        // follow that app's fixed Vigil companion, without broadening any
        // unrelated target.
        apps: uniqueList([...rule.apps, ...targetedCompanionApps])
      };
    }
    return {
      ...rule,
      // Built-in phone limits must follow the filtered companion as well as
      // the original signed app. Preserve user targets and only append Vigil's
      // own companion identifiers when a release adds them.
      apps: uniqueList([
        ...rule.apps,
        ...targetedCompanionApps,
        ...builtin.apps.filter((app) => app.startsWith("tech.caseline.vigil."))
      ]),
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
  const migrated = session.source === "protection-level"
    && (profileId === SOFT_BLOCK_PROFILE_ID || profileId === BRICK_MODE_PROFILE_ID)
    ? {
        ...session,
        canEndEarly: true,
        commitmentLock: false,
        emergencyUnlocksAllowed: true
      }
    : session;
  if (!profileSnapshot) return migrated;
  if (!session.profileSnapshot && profileId !== SOFT_BLOCK_PROFILE_ID) return migrated;
  return {
    ...migrated,
    profileSnapshot: sanitizeBuiltinProfile(profileSnapshot)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
