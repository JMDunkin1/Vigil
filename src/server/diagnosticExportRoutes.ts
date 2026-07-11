import type { ServerResponse } from "node:http";
import { sentinelAppInfo, sentinelStateHeaders } from "../sentinelHealth.js";
import type { SentinelState, UnknownRecord, UsageState } from "../types.js";
import { sendDownload } from "./http.js";

const DIAGNOSTIC_EXPORT_VERSION = 1;
const REDACTION_MARKER = "[REDACTED]";

interface DiagnosticExportInput {
  state: SentinelState;
  usage: UsageState;
  activePort: number;
  startedAt: string | null;
  now?: Date;
}

interface DiagnosticRouteInput extends DiagnosticExportInput {
  method: string;
  path: string;
}

interface RedactionResult<T> {
  value: T;
  paths: string[];
}

export function handleDiagnosticExportApiRoute(response: ServerResponse, input: DiagnosticRouteInput): boolean {
  if (input.method !== "GET" || input.path !== "/api/diagnostic/export") return false;

  const body = `${JSON.stringify(buildDiagnosticExport(input), null, 2)}\n`;
  sendDownload(response, 200, body, diagnosticExportFilename(input.now), "application/json", {
    ...sentinelStateHeaders(),
    "Cache-Control": "no-store"
  });
  return true;
}

export function buildDiagnosticExport({ state, usage, activePort, startedAt, now = new Date() }: DiagnosticExportInput) {
  const exportedAt = now.toISOString();
  const safeState = redactSensitiveFields(state, "state");
  const safeUsage = redactSensitiveFields(usage, "usage");
  const redactedPaths = [...new Set([...safeState.paths, ...safeUsage.paths])].sort();

  return {
    app: {
      ...sentinelAppInfo({ port: activePort, startedAt }),
      diagnosticExportVersion: DIAGNOSTIC_EXPORT_VERSION
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
      purpose: "diagnostic-snapshot"
    },
    state: safeState.value,
    usage: safeUsage.value
  };
}

export function diagnosticExportFilename(now = new Date()): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[:.]/g, "-");
  return `sentinel-diagnostic-${stamp}.json`;
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
  if (["hash", "salt", "token", "tokenhex", "profilebase64", "journalentries"].includes(normalized)) return true;
  if (normalized.endsWith("token") || normalized === "pushmagic") return true;
  if ([
    "udid",
    "boundudid",
    "serial",
    "serialnumber",
    "deviceid",
    "deviceidentifier",
    "enrollmentid",
    "userid",
    "hardwareuuid",
    "imei",
    "meid",
    "iccid",
    "ecid"
  ].includes(normalized) || normalized.endsWith("udid")) return true;
  if (normalized.includes("passcode") || normalized.includes("password")) return true;
  if (normalized.endsWith("secret")) return true;
  if (normalized.includes("certificatepayloadbase64")) return true;
  if (normalized.includes("payloadbase64")) return true;
  return false;
}

function exportCounts(state: SentinelState, usage: UsageState) {
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
