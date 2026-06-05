import type { ServerResponse } from "node:http";
import { vigilAppInfo, vigilStateHeaders } from "../vigilHealth.js";
import type { VigilState, UnknownRecord, UsageState } from "../types.js";
import { sendDownload } from "./http.js";

const BACKUP_EXPORT_VERSION = 1;
const REDACTION_MARKER = "[REDACTED]";

interface BackupExportInput {
  state: VigilState;
  usage: UsageState;
  activePort: number;
  startedAt: string | null;
  now?: Date;
}

interface BackupRouteInput extends BackupExportInput {
  method: string;
  path: string;
}

interface RedactionResult<T> {
  value: T;
  paths: string[];
}

export function handleBackupApiRoute(response: ServerResponse, input: BackupRouteInput): boolean {
  if (input.method !== "GET" || input.path !== "/api/backup/export") return false;

  const body = `${JSON.stringify(buildBackupExport(input), null, 2)}\n`;
  sendDownload(response, 200, body, backupExportFilename(input.now), "application/json", {
    ...vigilStateHeaders(),
    "Cache-Control": "no-store"
  });
  return true;
}

export function buildBackupExport({ state, usage, activePort, startedAt, now = new Date() }: BackupExportInput) {
  const exportedAt = now.toISOString();
  const safeState = redactSensitiveFields(state, "state");
  const safeUsage = redactSensitiveFields(usage, "usage");
  const redactedPaths = [...new Set([...safeState.paths, ...safeUsage.paths])].sort();

  return {
    app: {
      ...vigilAppInfo({ port: activePort, startedAt }),
      backupExportVersion: BACKUP_EXPORT_VERSION
    },
    metadata: {
      exportedAt,
      stateVersion: state.version || null,
      counts: exportCounts(state, usage),
      sensitiveFields: {
        mode: "redacted",
        marker: REDACTION_MARKER,
        redactedPaths
      },
      restore: {
        supported: false,
        reason: "Restore/import is not exposed because Vigil state is protected by integrity seals and should be reintroduced only through a verified migration flow."
      }
    },
    state: safeState.value,
    usage: safeUsage.value
  };
}

export function backupExportFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
  return `vigil-backup-${stamp}.json`;
}

function redactSensitiveFields<T>(value: T, path: string): RedactionResult<T> {
  const paths: string[] = [];
  return {
    value: redactValue(value, path, paths) as T,
    paths
  };
}

function redactValue(value: unknown, path: string, paths: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, `${path}[${index}]`, paths));
  }

  if (isRecord(value)) {
    const output: UnknownRecord = {};
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      if (isSensitiveKey(key)) {
        output[key] = redactScalar(child);
        if (output[key] !== child) paths.push(childPath);
        continue;
      }
      output[key] = redactValue(child, childPath, paths);
    }
    return output;
  }

  if (typeof value === "string") {
    const redactedUrl = redactTokenQuery(value);
    if (redactedUrl !== value) paths.push(path);
    return redactedUrl;
  }

  return value;
}

function redactScalar(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string" && !value) return "";
  if (Array.isArray(value) && value.length === 0) return [];
  if (isRecord(value) && !Object.keys(value).length) return {};
  return REDACTION_MARKER;
}

function redactTokenQuery(value: string): string {
  if (!/[?&]token=/i.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.searchParams.has("token")) url.searchParams.set("token", REDACTION_MARKER);
    return url.toString();
  } catch {
    return value.replace(/([?&]token=)[^&#\s]*/gi, `$1${REDACTION_MARKER}`);
  }
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (["hash", "salt", "token", "tokenhex", "profilebase64"].includes(normalized)) return true;
  if (normalized.includes("passcode") || normalized.includes("password")) return true;
  if (normalized.endsWith("secret")) return true;
  if (normalized.includes("certificatepayloadbase64")) return true;
  if (normalized.includes("payloadbase64")) return true;
  return false;
}

function exportCounts(state: VigilState, usage: UsageState) {
  const usageDays = Object.keys(usage || {});
  return {
    profiles: state.profiles.length,
    schedules: state.schedules.length,
    limitRules: state.limitRules.length,
    appLocks: state.appLocks.length,
    events: state.events.length,
    usageDays: usageDays.length,
    usageDeviceBuckets: usageDays.reduce((total, day) => (
      total + Object.keys(usage[day]?.devices || {}).length
    ), 0)
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
