import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gzip, gunzip } from "node:zlib";
import { dateKey, weekKey } from "./time.js";
import { normalizeUsageDay } from "./usage.js";
import type {
  IntentionalDayLedger,
  IntentionalGrant,
  IntentionalRuleLedger,
  UsageBucket,
  UsageDay,
  UsageState,
  VigilState
} from "./types.js";

export const RUNTIME_USAGE_CHECKPOINT_FILENAME = "runtime-usage.checkpoint.json";
export const RUNTIME_USAGE_CHECKPOINT_VERSION = 1;
export const MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES = 16 * 1024 * 1024;

const CHECKPOINT_ALGORITHM = "hmac-sha256";
const CHECKPOINT_ENCODING = "gzip+base64";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_KEY_FILE_BYTES = 4 * 1024;
const MAX_USAGE_MAP_ENTRIES = 50_000;
const MAX_USAGE_MAP_KEY_BYTES = 200;
const MAX_USAGE_CONTEXT_KEY_BYTES = 450;
const MAX_USAGE_SEGMENTS = 5_000;
const MAX_USAGE_SECONDS_PER_DEVICE_DAY = 24 * 60 * 60;
const MAX_USAGE_OPEN_COUNT = 100_000;
const MAX_LEDGER_RULES = 1_000;
const MAX_LEDGER_FIELDS = 32;
const MAX_LEDGER_COUNTER_ENTRIES = 1_000;
const MAX_LEDGER_KEY_BYTES = 256;
const MAX_GRANTS = 2_000;
const MAX_GRANT_ID_BYTES = 256;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
const ALLOWED_USAGE_DEVICES = ["computer", "phone"] as const;

interface RuntimeUsageCheckpointEnvelope {
  version: number;
  algorithm: string;
  encoding: string;
  createdAt: string;
  payloadBytes: number;
  compressedBytes: number;
  payload: string;
  digest: string;
}

interface RuntimeUsageGrantCounter {
  id: string;
  usedSeconds: number;
  lastSeenAt?: string;
}

interface RuntimeUsageCheckpointDayPayload {
  dayKey: string;
  usageDay: UsageDay;
  intentionalDayLedger: IntentionalDayLedger | null;
}

interface RuntimeUsageCheckpointPayload {
  version: number;
  createdAt: string;
  days?: RuntimeUsageCheckpointDayPayload[];
  // Legacy single-day fields remain readable so an in-place upgrade does not
  // reinterpret an authenticated hot checkpoint as integrity corruption.
  dayKey?: string;
  usageDay?: UsageDay;
  intentionalDayLedger?: IntentionalDayLedger | null;
  grants: RuntimeUsageGrantCounter[];
}

export type RuntimeUsageCheckpointSaveErrorCode =
  | "invalid-state"
  | "payload-too-large"
  | "compressed-payload-too-large"
  | "checkpoint-file-too-large";

export class RuntimeUsageCheckpointSaveError extends Error {
  readonly code: RuntimeUsageCheckpointSaveErrorCode;
  readonly retryable = false;

  constructor(code: RuntimeUsageCheckpointSaveErrorCode, message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "RuntimeUsageCheckpointSaveError";
    this.code = code;
  }
}

export function isNonRetryableRuntimeUsageCheckpointError(
  error: unknown
): error is RuntimeUsageCheckpointSaveError {
  return error instanceof RuntimeUsageCheckpointSaveError
    || Boolean(
      error
      && typeof error === "object"
      && "name" in error
      && error.name === "RuntimeUsageCheckpointSaveError"
      && "retryable" in error
      && error.retryable === false
    );
}

export interface RuntimeUsageCheckpointOptions {
  checkpointPath: string;
  keyPath: string;
  now?: Date;
}

export interface RuntimeUsageCheckpointSaveResult {
  ok: true;
  status: "saved";
  checkpointPath: string;
  dayKey: string;
  dayKeys: string[];
  createdAt: string;
  fileBytes: number;
  payloadBytes: number;
  compressedBytes: number;
}

export interface RuntimeUsageCheckpointRecoveryResult {
  ok: boolean;
  status: "missing" | "recovered" | "stale" | "invalid";
  detail: string;
  checkpointPath: string;
  dayKey: string | null;
  dayKeys: string[];
  createdAt: string | null;
  mergedDevices: number;
  staleDevices: number;
  mergedGrants: number;
  unmatchedGrants: number;
}

let checkpointSaveTail: Promise<void> = Promise.resolve();

export function runtimeUsageCheckpointPath(dataDir: string): string {
  return join(dataDir, RUNTIME_USAGE_CHECKPOINT_FILENAME);
}

export function runtimeUsageCheckpointDueDay(now = new Date()): string {
  return dateKey(now);
}

export async function saveRuntimeUsageCheckpoint(
  state: VigilState,
  usage: UsageState,
  options: RuntimeUsageCheckpointOptions
): Promise<RuntimeUsageCheckpointSaveResult> {
  let payload: RuntimeUsageCheckpointPayload;
  try {
    const now = validNow(options.now);
    payload = checkpointPayload(state, usage, now);
  } catch (error) {
    if (isNonRetryableRuntimeUsageCheckpointError(error)) throw error;
    throw new RuntimeUsageCheckpointSaveError(
      "invalid-state",
      `Runtime usage checkpoint cannot represent the current counters: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  const queued = checkpointSaveTail.then(() => writeCheckpoint(payload, options));
  checkpointSaveTail = queued.then(() => {}, () => {});
  return await queued;
}

export async function recoverRuntimeUsageCheckpoint(
  state: VigilState,
  usage: UsageState,
  options: RuntimeUsageCheckpointOptions
): Promise<RuntimeUsageCheckpointRecoveryResult> {
  const empty = recoveryResult(options.checkpointPath);
  let raw: Buffer;
  try {
    const info = await lstat(options.checkpointPath);
    if (!info.isFile()) throw new Error("Runtime usage checkpoint is not a regular file.");
    if (info.size > MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES) {
      throw new Error("Runtime usage checkpoint exceeds its file-size limit.");
    }
    raw = await readFile(options.checkpointPath);
    if (raw.byteLength > MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES) {
      throw new Error("Runtime usage checkpoint exceeds its file-size limit.");
    }
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return {
        ...empty,
        ok: true,
        status: "missing",
        detail: "No runtime usage checkpoint exists."
      };
    }
    return invalidRecovery(empty, error);
  }

  try {
    const now = validNow(options.now);
    const key = await readExistingSealKey(options.keyPath);
    const envelope = parseEnvelope(raw);
    verifyEnvelope(envelope, key);
    const payload = await decodePayload(envelope);
    const payloadDays = validatePayload(payload, envelope, now);

    const recoverableDays = new Set([dateKey(now), dateKey(offsetLocalDay(now, -1))]);
    const recoverablePayloadDays = payloadDays.filter((day) => recoverableDays.has(day.dayKey));
    if (!recoverablePayloadDays.length) {
      const checkpointDayKeys = payloadDays.map((day) => day.dayKey);
      return {
        ...empty,
        ok: true,
        status: "stale",
        detail: `Runtime usage checkpoint for ${checkpointDayKeys.join(", ")} is older than the recovery window.`,
        dayKey: checkpointDayKeys[0] || null,
        dayKeys: checkpointDayKeys,
        createdAt: payload.createdAt
      };
    }

    const nextUsage = structuredClone(usage);
    let mergedDevices = 0;
    let staleDevices = 0;
    const mergedLedgers: Record<string, IntentionalDayLedger> = {};
    for (const day of recoverablePayloadDays) {
      const usageMerge = mergeCheckpointUsage(nextUsage, day, payload.createdAt, now);
      mergedDevices += usageMerge.merged;
      staleDevices += usageMerge.stale;
      const ledger = mergeIntentionalDayLedger(
        state.intentionalUse.ledger?.[day.dayKey],
        day.intentionalDayLedger,
        day.dayKey
      );
      if (ledger) mergedLedgers[day.dayKey] = ledger;
    }
    const grantMerge = mergeGrantCounters(state.intentionalUse.grants || [], payload.grants);

    replaceRecord(usage, nextUsage);
    if (Object.keys(mergedLedgers).length) {
      state.intentionalUse.ledger = {
        ...(state.intentionalUse.ledger || {}),
        ...mergedLedgers
      };
    }
    state.intentionalUse.grants = grantMerge.grants;

    return {
      ...empty,
      ok: true,
      status: "recovered",
      detail: "Authenticated runtime usage checkpoint merged without regressing durable counters.",
      dayKey: payloadDays[0]?.dayKey || null,
      dayKeys: payloadDays.map((day) => day.dayKey),
      createdAt: payload.createdAt,
      mergedDevices,
      staleDevices,
      mergedGrants: grantMerge.merged,
      unmatchedGrants: grantMerge.unmatched
    };
  } catch (error) {
    return invalidRecovery(empty, error);
  }
}

export async function quarantineRuntimeUsageCheckpoint(
  checkpointPath: string,
  now = new Date()
): Promise<string> {
  const checkedAt = validNow(now);
  const info = await lstat(checkpointPath);
  if (!info.isFile()) throw new Error("Runtime usage checkpoint quarantine source is not a regular file.");
  await chmod(checkpointPath, PRIVATE_FILE_MODE);
  const evidencePath = `${checkpointPath}.corrupt.${checkedAt.toISOString().replace(/[:.]/gu, "-")}.${randomUUID()}`;
  await rename(checkpointPath, evidencePath);
  await syncDirectory(dirname(checkpointPath));
  return evidencePath;
}

async function writeCheckpoint(
  payload: RuntimeUsageCheckpointPayload,
  options: RuntimeUsageCheckpointOptions
): Promise<RuntimeUsageCheckpointSaveResult> {
  let payloadText: string;
  try {
    payloadText = JSON.stringify(payload);
  } catch (error) {
    throw new RuntimeUsageCheckpointSaveError(
      "invalid-state",
      `Runtime usage checkpoint payload could not be serialized: ${errorMessage(error)}`,
      { cause: error }
    );
  }
  const payloadBytes = Buffer.byteLength(payloadText, "utf8");
  if (payloadBytes > MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES) {
    throw new RuntimeUsageCheckpointSaveError(
      "payload-too-large",
      "Runtime usage checkpoint payload exceeds its decompressed size limit."
    );
  }
  const compressed = await gzipBuffer(Buffer.from(payloadText, "utf8"));
  if (compressed.byteLength > MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES) {
    throw new RuntimeUsageCheckpointSaveError(
      "compressed-payload-too-large",
      "Runtime usage checkpoint payload exceeds its compressed size limit."
    );
  }
  const envelope: RuntimeUsageCheckpointEnvelope = {
    version: RUNTIME_USAGE_CHECKPOINT_VERSION,
    algorithm: CHECKPOINT_ALGORITHM,
    encoding: CHECKPOINT_ENCODING,
    createdAt: payload.createdAt,
    payloadBytes,
    compressedBytes: compressed.byteLength,
    payload: compressed.toString("base64"),
    digest: ""
  };
  const key = await readExistingSealKey(options.keyPath);
  envelope.digest = checkpointDigest(envelope, key);
  const text = `${JSON.stringify(envelope)}\n`;
  const fileBytes = Buffer.byteLength(text, "utf8");
  if (fileBytes > MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES) {
    throw new RuntimeUsageCheckpointSaveError(
      "checkpoint-file-too-large",
      "Runtime usage checkpoint exceeds its file-size limit."
    );
  }
  await writeAtomicPrivateFile(options.checkpointPath, text);
  const days = checkpointPayloadDays(payload);
  return {
    ok: true,
    status: "saved",
    checkpointPath: options.checkpointPath,
    dayKey: days[0].dayKey,
    dayKeys: days.map((day) => day.dayKey),
    createdAt: payload.createdAt,
    fileBytes,
    payloadBytes,
    compressedBytes: compressed.byteLength
  };
}

function checkpointPayload(state: VigilState, usage: UsageState, now: Date): RuntimeUsageCheckpointPayload {
  const days = [now, offsetLocalDay(now, -1)].map((date) => checkpointDayPayload(state, usage, date, now));
  const grants = checkpointGrantCounters(state.intentionalUse.grants || []);
  const createdAt = now.toISOString();
  return {
    version: RUNTIME_USAGE_CHECKPOINT_VERSION,
    createdAt,
    days,
    grants
  };
}

function checkpointDayPayload(
  state: VigilState,
  usage: UsageState,
  date: Date,
  now: Date
): RuntimeUsageCheckpointDayPayload {
  const dayKey = dateKey(date);
  const usageDay = compactCheckpointUsageDay(usage[dayKey], now);
  validateUsageDay(usageDay, now);
  const rawLedger = state.intentionalUse.ledger?.[dayKey];
  return {
    dayKey,
    usageDay,
    intentionalDayLedger: rawLedger ? normalizeIntentionalDayLedger(rawLedger, dayKey) : null
  };
}

function compactCheckpointUsageDay(value: UsageDay | undefined, now: Date): UsageDay {
  const normalized = normalizeUsageDay(structuredClone(value || {}));
  const updatedAt = now.toISOString();
  if (!Object.keys(normalized.devices || {}).length) return { ...normalized, updatedAt };
  return {
    totalSeconds: 0,
    apps: {},
    sites: {},
    contexts: {},
    openContexts: {},
    contextVersion: 1,
    openContextVersion: 1,
    opens: { apps: {}, sites: {} },
    devices: normalized.devices,
    deviceTotalsMode: "by-device",
    updatedAt
  };
}

function checkpointGrantCounters(grants: IntentionalGrant[]): RuntimeUsageGrantCounter[] {
  if (grants.length > MAX_GRANTS) throw new Error("Runtime usage checkpoint has too many intentional-use grants.");
  const seen = new Set<string>();
  return grants.map((grant) => {
    const id = boundedIdentifier(grant.id, MAX_GRANT_ID_BYTES, "intentional-use grant id");
    if (seen.has(id)) throw new Error("Runtime usage checkpoint contains duplicate intentional-use grant ids.");
    seen.add(id);
    const counter: RuntimeUsageGrantCounter = {
      id,
      usedSeconds: nonNegativeNumber(grant.usedSeconds, "intentional-use grant seconds")
    };
    if (grant.lastSeenAt) counter.lastSeenAt = validTimestamp(grant.lastSeenAt, "intentional-use grant timestamp");
    return counter;
  });
}

function parseEnvelope(raw: Buffer): RuntimeUsageCheckpointEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error("Runtime usage checkpoint is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Runtime usage checkpoint envelope must be an object.");
  return parsed as unknown as RuntimeUsageCheckpointEnvelope;
}

function verifyEnvelope(envelope: RuntimeUsageCheckpointEnvelope, key: string): void {
  if (envelope.version !== RUNTIME_USAGE_CHECKPOINT_VERSION) throw new Error("Unsupported runtime usage checkpoint version.");
  if (envelope.algorithm !== CHECKPOINT_ALGORITHM) throw new Error("Unsupported runtime usage checkpoint algorithm.");
  if (envelope.encoding !== CHECKPOINT_ENCODING) throw new Error("Unsupported runtime usage checkpoint encoding.");
  validTimestamp(envelope.createdAt, "runtime usage checkpoint timestamp");
  boundedInteger(envelope.payloadBytes, 0, MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES, "runtime usage checkpoint payload size");
  boundedInteger(envelope.compressedBytes, 1, MAX_RUNTIME_USAGE_CHECKPOINT_FILE_BYTES, "runtime usage checkpoint compressed size");
  if (typeof envelope.payload !== "string" || !canonicalBase64(envelope.payload)) {
    throw new Error("Runtime usage checkpoint payload is not valid base64.");
  }
  const compressed = Buffer.from(envelope.payload, "base64");
  if (compressed.byteLength !== envelope.compressedBytes) throw new Error("Runtime usage checkpoint compressed size does not match.");
  if (typeof envelope.digest !== "string" || !/^[a-f\d]{64}$/u.test(envelope.digest)) {
    throw new Error("Runtime usage checkpoint digest is invalid.");
  }
  const expected = Buffer.from(envelope.digest, "hex");
  const actual = Buffer.from(checkpointDigest(envelope, key), "hex");
  if (expected.byteLength !== actual.byteLength || !timingSafeEqual(expected, actual)) {
    throw new Error("Runtime usage checkpoint authentication failed.");
  }
}

async function decodePayload(envelope: RuntimeUsageCheckpointEnvelope): Promise<RuntimeUsageCheckpointPayload> {
  const compressed = Buffer.from(envelope.payload, "base64");
  const decoded = await gunzipBuffer(compressed);
  if (decoded.byteLength !== envelope.payloadBytes) throw new Error("Runtime usage checkpoint payload size does not match.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    throw new Error("Runtime usage checkpoint payload is not valid JSON.");
  }
  if (!isRecord(parsed)) throw new Error("Runtime usage checkpoint payload must be an object.");
  return parsed as unknown as RuntimeUsageCheckpointPayload;
}

function validatePayload(
  payload: RuntimeUsageCheckpointPayload,
  envelope: RuntimeUsageCheckpointEnvelope,
  now: Date
): RuntimeUsageCheckpointDayPayload[] {
  if (payload.version !== RUNTIME_USAGE_CHECKPOINT_VERSION) throw new Error("Unsupported runtime usage checkpoint payload version.");
  if (payload.createdAt !== envelope.createdAt) throw new Error("Runtime usage checkpoint timestamps do not match.");
  const createdAt = Date.parse(validTimestamp(payload.createdAt, "runtime usage checkpoint payload timestamp"));
  if (createdAt > now.getTime() + FUTURE_TOLERANCE_MS) throw new Error("Runtime usage checkpoint timestamp is too far in the future.");
  const days = checkpointPayloadDays(payload);
  if (days.length < 1 || days.length > 2) throw new Error("Runtime usage checkpoint must contain one or two local days.");
  const seen = new Set<string>();
  for (const day of days) {
    if (!validDayKey(day.dayKey)) throw new Error("Runtime usage checkpoint day is invalid.");
    if (seen.has(day.dayKey)) throw new Error("Runtime usage checkpoint contains duplicate local days.");
    seen.add(day.dayKey);
    validateUsageDay(day.usageDay, now);
    if (day.intentionalDayLedger !== null) normalizeIntentionalDayLedger(day.intentionalDayLedger, day.dayKey);
  }
  validateGrantCounters(payload.grants, now);
  return days;
}

function checkpointPayloadDays(payload: RuntimeUsageCheckpointPayload): RuntimeUsageCheckpointDayPayload[] {
  if (Array.isArray(payload.days)) return payload.days;
  if (
    payload.dayKey !== undefined
    && payload.usageDay !== undefined
    && payload.intentionalDayLedger !== undefined
  ) {
    return [{
      dayKey: payload.dayKey,
      usageDay: payload.usageDay,
      intentionalDayLedger: payload.intentionalDayLedger
    }];
  }
  throw new Error("Runtime usage checkpoint day bundle is invalid.");
}

function validateUsageDay(value: unknown, now: Date): asserts value is UsageDay {
  if (!isRecord(value)) throw new Error("Runtime usage checkpoint day must be an object.");
  if (!isRecord(value.devices)) throw new Error("Runtime usage checkpoint devices must be an object.");
  const devices = Object.entries(value.devices);
  if (devices.length > ALLOWED_USAGE_DEVICES.length) throw new Error("Runtime usage checkpoint has too many devices.");
  validateUsageBucket(value, "aggregate usage", {
    maximumSeconds: MAX_USAGE_SECONDS_PER_DEVICE_DAY * Math.max(1, devices.length),
    maximumOpens: MAX_USAGE_OPEN_COUNT * Math.max(1, devices.length),
    now
  });
  for (const [device, bucket] of devices) {
    if (!ALLOWED_USAGE_DEVICES.includes(device as (typeof ALLOWED_USAGE_DEVICES)[number])) {
      throw new Error(`Runtime usage checkpoint has an unsupported device: ${device}.`);
    }
    validateUsageBucket(bucket, `${device} usage`, {
      maximumSeconds: MAX_USAGE_SECONDS_PER_DEVICE_DAY,
      maximumOpens: MAX_USAGE_OPEN_COUNT,
      now
    });
  }
}

function validateUsageBucket(
  value: unknown,
  label: string,
  limits: { maximumSeconds: number; maximumOpens: number; now: Date }
): asserts value is UsageBucket {
  if (!isRecord(value)) throw new Error(`Runtime usage checkpoint ${label} must be an object.`);
  boundedCounter(value.totalSeconds, limits.maximumSeconds, false, `${label} total seconds`);
  validateNumberMap(value.apps, `${label} apps`, limits.maximumSeconds);
  validateNumberMap(value.sites, `${label} sites`, limits.maximumSeconds);
  if (value.contexts !== undefined) validateNumberMap(value.contexts, `${label} contexts`, limits.maximumSeconds, false, MAX_USAGE_CONTEXT_KEY_BYTES);
  if (value.openContexts !== undefined) validateNumberMap(value.openContexts, `${label} open contexts`, limits.maximumOpens, true, MAX_USAGE_CONTEXT_KEY_BYTES);
  if (!isRecord(value.opens)) throw new Error(`Runtime usage checkpoint ${label} opens must be an object.`);
  validateNumberMap(value.opens.apps, `${label} app opens`, limits.maximumOpens, true);
  validateNumberMap(value.opens.sites, `${label} site opens`, limits.maximumOpens, true);
  if (value.updatedAt !== undefined && value.updatedAt !== null) {
    const updatedAt = Date.parse(validTimestamp(value.updatedAt, `${label} update timestamp`));
    if (updatedAt > limits.now.getTime() + FUTURE_TOLERANCE_MS) {
      throw new Error(`Runtime usage checkpoint ${label} timestamp is too far in the future.`);
    }
  }
  if (value.segments !== undefined) {
    if (!Array.isArray(value.segments) || value.segments.length > MAX_USAGE_SEGMENTS) {
      throw new Error(`Runtime usage checkpoint ${label} has too many segments.`);
    }
    for (const segment of value.segments) {
      if (!isRecord(segment)) throw new Error(`Runtime usage checkpoint ${label} segment is invalid.`);
      validTimestamp(segment.startedAt, `${label} segment start`);
      const endedAt = Date.parse(validTimestamp(segment.endedAt, `${label} segment end`));
      if (endedAt > limits.now.getTime() + FUTURE_TOLERANCE_MS) {
        throw new Error(`Runtime usage checkpoint ${label} segment is too far in the future.`);
      }
      boundedIdentifier(segment.app, MAX_USAGE_MAP_KEY_BYTES, `${label} segment app`);
      if (segment.hostname !== undefined) boundedIdentifier(segment.hostname, MAX_USAGE_MAP_KEY_BYTES, `${label} segment hostname`);
    }
  }
}

function validateNumberMap(
  value: unknown,
  label: string,
  maximum: number,
  integer = false,
  maximumKeyBytes = MAX_USAGE_MAP_KEY_BYTES
): void {
  if (!isRecord(value)) throw new Error(`Runtime usage checkpoint ${label} must be an object.`);
  const entries = Object.entries(value);
  if (entries.length > MAX_USAGE_MAP_ENTRIES) throw new Error(`Runtime usage checkpoint ${label} has too many entries.`);
  for (const [key, counter] of entries) {
    safeRecordKey(key, maximumKeyBytes, label);
    boundedCounter(counter, maximum, integer, `${label} counter`);
  }
}

function mergeCheckpointUsage(
  nextUsage: UsageState,
  payload: RuntimeUsageCheckpointDayPayload,
  createdAt: string,
  now: Date
): { merged: number; stale: number } {
  const previousDay = normalizeUsageDay(structuredClone(nextUsage[payload.dayKey] || {}));
  const previousUpdatedAt = previousDay.updatedAt || null;
  const checkpointDay = normalizeUsageDay(payload.usageDay);
  const currentDevices = usageDeviceSnapshots(previousDay);
  const checkpointDevices = usageDeviceSnapshots(checkpointDay);
  const mergedDeviceBuckets = structuredClone(currentDevices);
  let merged = 0;
  let stale = 0;
  for (const [device, checkpointBucket] of Object.entries(checkpointDevices)) {
    const currentBucket = currentDevices[device];
    if (currentBucket && (
      usageBucketRegressed(currentBucket, checkpointBucket)
      || !usageBucketAdvances(currentBucket, checkpointBucket)
    )) {
      stale += 1;
      continue;
    }
    mergedDeviceBuckets[device] = structuredClone(checkpointBucket);
    merged += 1;
  }
  if (merged > 0) {
    const recomputed = normalizeUsageDay({
      totalSeconds: 0,
      apps: {},
      sites: {},
      contexts: {},
      openContexts: {},
      contextVersion: 1,
      openContextVersion: 1,
      opens: { apps: {}, sites: {} },
      devices: mergedDeviceBuckets,
      deviceTotalsMode: "by-device",
      updatedAt: laterTimestamp(previousUpdatedAt || undefined, createdAt) || now.toISOString()
    });
    recomputed.deviceTotalsMode = "by-device";
    nextUsage[payload.dayKey] = recomputed;
  }
  return { merged, stale };
}

function usageDeviceSnapshots(day: UsageDay): Record<string, UsageBucket> {
  if (Object.keys(day.devices || {}).length) return structuredClone(day.devices);
  if (!usageBucketHasCounters(day)) return {};
  const { devices: _devices, ...legacyBucket } = day;
  return { computer: legacyBucket };
}

function usageBucketHasCounters(bucket: UsageBucket): boolean {
  return Boolean(
    bucket.totalSeconds > 0
    || Object.keys(bucket.apps || {}).length
    || Object.keys(bucket.sites || {}).length
    || Object.keys(bucket.contexts || {}).length
    || Object.keys(bucket.openContexts || {}).length
    || Object.keys(bucket.opens?.apps || {}).length
    || Object.keys(bucket.opens?.sites || {}).length
    || bucket.segments?.length
  );
}

function usageBucketRegressed(current: UsageBucket, checkpoint: UsageBucket): boolean {
  const currentUpdatedAt = Date.parse(String(current.updatedAt || ""));
  const checkpointUpdatedAt = Date.parse(String(checkpoint.updatedAt || ""));
  return (Number.isFinite(currentUpdatedAt) && (!Number.isFinite(checkpointUpdatedAt) || checkpointUpdatedAt < currentUpdatedAt))
    || checkpoint.totalSeconds < current.totalSeconds
    || (current.contextVersion === 1 && checkpoint.contextVersion !== 1)
    || (current.openContextVersion === 1 && checkpoint.openContextVersion !== 1)
    || numberMapRegressed(current.apps, checkpoint.apps)
    || numberMapRegressed(current.sites, checkpoint.sites)
    || numberMapRegressed(current.contexts, checkpoint.contexts)
    || numberMapRegressed(current.openContexts, checkpoint.openContexts)
    || numberMapRegressed(current.opens?.apps, checkpoint.opens?.apps)
    || numberMapRegressed(current.opens?.sites, checkpoint.opens?.sites)
    || usageSegmentsRegressed(current.segments, checkpoint.segments);
}

function usageBucketAdvances(current: UsageBucket, checkpoint: UsageBucket): boolean {
  return checkpoint.totalSeconds > current.totalSeconds
    || (current.contextVersion !== 1 && checkpoint.contextVersion === 1)
    || (current.openContextVersion !== 1 && checkpoint.openContextVersion === 1)
    || numberMapAdvances(current.apps, checkpoint.apps)
    || numberMapAdvances(current.sites, checkpoint.sites)
    || numberMapAdvances(current.contexts, checkpoint.contexts)
    || numberMapAdvances(current.openContexts, checkpoint.openContexts)
    || numberMapAdvances(current.opens?.apps, checkpoint.opens?.apps)
    || numberMapAdvances(current.opens?.sites, checkpoint.opens?.sites)
    || usageSegmentsAdvance(current.segments, checkpoint.segments);
}

function numberMapRegressed(
  current: Record<string, number> | undefined,
  checkpoint: Record<string, number> | undefined
): boolean {
  return Object.entries(current || {}).some(([key, value]) => Number(checkpoint?.[key] || 0) < value);
}

function numberMapAdvances(
  current: Record<string, number> | undefined,
  checkpoint: Record<string, number> | undefined
): boolean {
  return Object.entries(checkpoint || {}).some(([key, value]) => value > Number(current?.[key] || 0));
}

function usageSegmentsRegressed(
  current: UsageBucket["segments"],
  checkpoint: UsageBucket["segments"]
): boolean {
  if (!current?.length) return false;
  if (!checkpoint?.length) return true;
  const checkpointSegments = new Set(checkpoint.map(usageSegmentKey));
  return current.some((segment) => !checkpointSegments.has(usageSegmentKey(segment)));
}

function usageSegmentsAdvance(
  current: UsageBucket["segments"],
  checkpoint: UsageBucket["segments"]
): boolean {
  if (!checkpoint?.length) return false;
  const currentSegments = new Set((current || []).map(usageSegmentKey));
  return checkpoint.some((segment) => !currentSegments.has(usageSegmentKey(segment)));
}

function usageSegmentKey(segment: NonNullable<UsageBucket["segments"]>[number]): string {
  return `${segment.startedAt}\n${segment.endedAt}\n${segment.app}\n${segment.hostname || ""}`;
}

function mergeIntentionalDayLedger(
  current: IntentionalDayLedger | undefined,
  checkpoint: IntentionalDayLedger | null,
  day: string
): IntentionalDayLedger | null {
  if (!current && !checkpoint) return null;
  const left = current ? normalizeIntentionalDayLedger(current, day) : emptyIntentionalDayLedger(day);
  const right = checkpoint ? normalizeIntentionalDayLedger(checkpoint, day) : emptyIntentionalDayLedger(day);
  const ruleIds = [...new Set([...Object.keys(left.rules), ...Object.keys(right.rules)])];
  if (ruleIds.length > MAX_LEDGER_RULES) throw new Error("Runtime usage checkpoint merge has too many intentional-use rules.");
  return {
    weekKey: left.weekKey || right.weekKey,
    rules: Object.fromEntries(ruleIds.map((ruleId) => [
      ruleId,
      mergeIntentionalRuleLedger(left.rules[ruleId], right.rules[ruleId])
    ]))
  };
}

function normalizeIntentionalDayLedger(value: unknown, day: string): IntentionalDayLedger {
  if (!isRecord(value)) throw new Error("Runtime usage checkpoint intentional-use ledger must be an object.");
  const expectedWeek = weekKey(new Date(`${day}T12:00:00`));
  if (value.weekKey !== expectedWeek) throw new Error("Runtime usage checkpoint intentional-use week is invalid.");
  if (!isRecord(value.rules)) throw new Error("Runtime usage checkpoint intentional-use rules must be an object.");
  const entries = Object.entries(value.rules);
  if (entries.length > MAX_LEDGER_RULES) throw new Error("Runtime usage checkpoint has too many intentional-use rules.");
  return {
    weekKey: expectedWeek,
    rules: Object.fromEntries(entries.map(([ruleId, rule]) => [
      safeRecordKey(ruleId, MAX_LEDGER_KEY_BYTES, "intentional-use rule id"),
      normalizeIntentionalRuleLedger(rule)
    ]))
  };
}

function normalizeIntentionalRuleLedger(value: unknown): IntentionalRuleLedger {
  if (!isRecord(value)) throw new Error("Runtime usage checkpoint intentional-use rule ledger must be an object.");
  const entries = Object.entries(value);
  if (entries.length > MAX_LEDGER_FIELDS) throw new Error("Runtime usage checkpoint intentional-use rule has too many fields.");
  const normalized: Record<string, number | Record<string, number>> = {};
  for (const [field, counter] of entries) {
    const key = safeRecordKey(field, MAX_LEDGER_KEY_BYTES, "intentional-use ledger field");
    if (isRecord(counter)) {
      const counters = Object.entries(counter);
      if (counters.length > MAX_LEDGER_COUNTER_ENTRIES) throw new Error("Runtime usage checkpoint intentional-use counter map is too large.");
      normalized[key] = Object.fromEntries(counters.map(([target, amount]) => [
        safeRecordKey(target, MAX_LEDGER_KEY_BYTES, "intentional-use target"),
        nonNegativeNumber(amount, "intentional-use target counter")
      ]));
    } else {
      normalized[key] = nonNegativeNumber(counter, "intentional-use counter");
    }
  }
  normalized.seconds ||= 0;
  normalized.pauses ||= 0;
  normalized.continued ||= 0;
  normalized.skipped ||= 0;
  normalized.targets ||= {};
  return normalized as IntentionalRuleLedger;
}

function mergeIntentionalRuleLedger(
  current: IntentionalRuleLedger | undefined,
  checkpoint: IntentionalRuleLedger | undefined
): IntentionalRuleLedger {
  const left = current ? normalizeIntentionalRuleLedger(current) : normalizeIntentionalRuleLedger({});
  const right = checkpoint ? normalizeIntentionalRuleLedger(checkpoint) : normalizeIntentionalRuleLedger({});
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  const merged: Record<string, number | Record<string, number>> = {};
  for (const field of fields) {
    const leftValue = left[field];
    const rightValue = right[field];
    if (isRecord(leftValue) || isRecord(rightValue)) {
      if ((leftValue !== undefined && !isRecord(leftValue)) || (rightValue !== undefined && !isRecord(rightValue))) {
        throw new Error("Runtime usage checkpoint intentional-use counter type changed.");
      }
      merged[field] = maxCounterMap(leftValue, rightValue);
    } else {
      merged[field] = Math.max(Number(leftValue || 0), Number(rightValue || 0));
    }
  }
  return merged as IntentionalRuleLedger;
}

function maxCounterMap(left: unknown, right: unknown): Record<string, number> {
  const leftRecord = isRecord(left) ? left : {};
  const rightRecord = isRecord(right) ? right : {};
  const keys = [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])];
  if (keys.length > MAX_LEDGER_COUNTER_ENTRIES) throw new Error("Runtime usage checkpoint intentional-use counter merge is too large.");
  return Object.fromEntries(keys.map((key) => [
    safeRecordKey(key, MAX_LEDGER_KEY_BYTES, "intentional-use target"),
    Math.max(
      nonNegativeNumber(leftRecord[key] || 0, "intentional-use target counter"),
      nonNegativeNumber(rightRecord[key] || 0, "intentional-use target counter")
    )
  ]));
}

function emptyIntentionalDayLedger(day: string): IntentionalDayLedger {
  return { weekKey: weekKey(new Date(`${day}T12:00:00`)), rules: {} };
}

function validateGrantCounters(value: unknown, now: Date): asserts value is RuntimeUsageGrantCounter[] {
  if (!Array.isArray(value) || value.length > MAX_GRANTS) throw new Error("Runtime usage checkpoint has too many grant counters.");
  const seen = new Set<string>();
  for (const grant of value) {
    if (!isRecord(grant)) throw new Error("Runtime usage checkpoint grant counter is invalid.");
    const id = boundedIdentifier(grant.id, MAX_GRANT_ID_BYTES, "intentional-use grant id");
    if (seen.has(id)) throw new Error("Runtime usage checkpoint contains duplicate intentional-use grant ids.");
    seen.add(id);
    nonNegativeNumber(grant.usedSeconds, "intentional-use grant seconds");
    if (grant.lastSeenAt !== undefined) {
      const timestamp = Date.parse(validTimestamp(grant.lastSeenAt, "intentional-use grant timestamp"));
      if (timestamp > now.getTime() + FUTURE_TOLERANCE_MS) throw new Error("Runtime usage checkpoint grant timestamp is too far in the future.");
    }
  }
}

function mergeGrantCounters(
  current: IntentionalGrant[],
  checkpoint: RuntimeUsageGrantCounter[]
): { grants: IntentionalGrant[]; merged: number; unmatched: number } {
  const counters = new Map(checkpoint.map((counter) => [counter.id, counter]));
  let merged = 0;
  const grants = current.map((grant) => {
    const counter = counters.get(grant.id);
    if (!counter) return grant;
    counters.delete(grant.id);
    merged += 1;
    return {
      ...grant,
      usedSeconds: Math.max(
        nonNegativeNumber(grant.usedSeconds, "intentional-use grant seconds"),
        counter.usedSeconds
      ),
      lastSeenAt: laterTimestamp(grant.lastSeenAt, counter.lastSeenAt)
    };
  });
  return { grants, merged, unmatched: counters.size };
}

function laterTimestamp(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function checkpointDigest(envelope: RuntimeUsageCheckpointEnvelope, key: string): string {
  return createHmac("sha256", key)
    .update(checkpointSigningText(envelope), "utf8")
    .digest("hex");
}

function checkpointSigningText(envelope: RuntimeUsageCheckpointEnvelope): string {
  return [
    String(envelope.version),
    envelope.algorithm,
    envelope.encoding,
    envelope.createdAt,
    String(envelope.payloadBytes),
    String(envelope.compressedBytes),
    envelope.payload
  ].join("\n");
}

async function readExistingSealKey(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.size < 1 || info.size > MAX_KEY_FILE_BYTES) {
    throw new Error("Existing state seal key is unavailable or invalid.");
  }
  const key = (await readFile(path, "utf8")).trim();
  if (!key || Buffer.byteLength(key, "utf8") > MAX_KEY_FILE_BYTES) {
    throw new Error("Existing state seal key is unavailable or invalid.");
  }
  return key;
}

async function writeAtomicPrivateFile(path: string, text: string): Promise<void> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await chmod(parent, PRIVATE_DIRECTORY_MODE);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, text, { flag: "wx", mode: PRIVATE_FILE_MODE });
    await chmod(temp, PRIVATE_FILE_MODE);
    await syncFile(temp);
    await rename(temp, path);
    await chmod(path, PRIVATE_FILE_MODE);
    await syncDirectory(parent);
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

function gzipBuffer(value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gzip(value, { level: 1 }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function gunzipBuffer(value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    gunzip(value, { maxOutputLength: MAX_RUNTIME_USAGE_CHECKPOINT_PAYLOAD_BYTES }, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });
}

function canonicalBase64(value: string): boolean {
  if (!value || !/^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u.test(value)) return false;
  return Buffer.from(value, "base64").toString("base64") === value;
}

function validDayKey(value: unknown): value is string {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const parsed = new Date(`${text}T12:00:00`);
  return Number.isFinite(parsed.getTime()) && dateKey(parsed) === text;
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}.`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function boundedCounter(value: unknown, maximum: number, integer: boolean, label: string): number {
  const number = nonNegativeNumber(value, label);
  if (number > maximum || (integer && !Number.isInteger(number))) throw new Error(`Invalid ${label}.`);
  return number;
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new Error(`Invalid ${label}.`);
  return Number(value);
}

function boundedIdentifier(value: unknown, maximumBytes: number, label: string): string {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > maximumBytes) throw new Error(`Invalid ${label}.`);
  return value;
}

function safeRecordKey(value: string, maximumBytes: number, label: string): string {
  if (["__proto__", "constructor", "prototype"].includes(value)) throw new Error(`Invalid ${label}.`);
  return boundedIdentifier(value, maximumBytes, label);
}

function validNow(value: Date | undefined): Date {
  const now = value ? new Date(value) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Runtime usage checkpoint time is invalid.");
  return now;
}

function offsetLocalDay(value: Date, days: number): Date {
  const result = new Date(value);
  result.setDate(result.getDate() + days);
  return result;
}

function replaceRecord<T>(target: Record<string, T>, source: Record<string, T>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function recoveryResult(checkpointPath: string): RuntimeUsageCheckpointRecoveryResult {
  return {
    ok: false,
    status: "invalid",
    detail: "Runtime usage checkpoint is invalid.",
    checkpointPath,
    dayKey: null,
    dayKeys: [],
    createdAt: null,
    mergedDevices: 0,
    staleDevices: 0,
    mergedGrants: 0,
    unmatchedGrants: 0
  };
}

function invalidRecovery(
  base: RuntimeUsageCheckpointRecoveryResult,
  error: unknown
): RuntimeUsageCheckpointRecoveryResult {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ...base,
    ok: false,
    status: "invalid",
    detail: `Runtime usage checkpoint recovery failed closed: ${detail || "invalid checkpoint"}`
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as NodeJS.ErrnoException).code === code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "invalid checkpoint state");
}
