import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";

const RUNTIME_READY_FILENAME = "runtime-ready.json";
const RUNTIME_INTERRUPTION_FILENAME = "runtime-interruption.json";
const RUNTIME_INTERRUPTION_VERSION = 1;
const MAX_RUNTIME_INTERRUPTION_BYTES = 8 * 1024;
const PRIVATE_FILE_MODE = 0o600;

export interface RuntimeReadyRecord {
  pid: number;
  startedAt: string;
  appPath: string;
  transport: "in-app";
}

export type RuntimeInterruptionReason = "process-missing" | "process-identity-mismatch" | "invalid-ready-record";

export interface RuntimeInterruptionRecord extends RuntimeReadyRecord {
  version: 1;
  id: string;
  detectedAt: string;
  reason: RuntimeInterruptionReason;
}

export type RuntimeInterruptionInvalidReason =
  | "unsafe-file"
  | "oversized-file"
  | "unreadable-file"
  | "malformed-json"
  | "invalid-record";

export type RuntimeInterruptionReadResult =
  | { status: "missing" }
  | { status: "valid"; record: RuntimeInterruptionRecord }
  | { status: "invalid"; reason: RuntimeInterruptionInvalidReason };

export interface RuntimeSupervisorScriptOptions {
  markerPath: string;
  dataDir: string;
  appPath: string;
  executablePath: string;
  backgroundLaunchArg: string;
  safetyBoundaryArg: string;
}

export function runtimeReadyPath(dataDir: string): string {
  return join(dataDir, RUNTIME_READY_FILENAME);
}

export function runtimeInterruptionPath(dataDir: string): string {
  return join(dataDir, RUNTIME_INTERRUPTION_FILENAME);
}

export function runtimeInterruptionId(runtime: Pick<RuntimeReadyRecord, "pid" | "startedAt">): string {
  const pid = Number(runtime.pid);
  const startedAt = String(runtime.startedAt || "");
  if (!Number.isInteger(pid) || pid < 1 || !validTimestamp(startedAt)) {
    throw new Error("Vigil cannot identify an invalid runtime interruption record.");
  }
  return `runtime-interruption-v1:${pid}:${startedAt}`;
}

/**
 * The packaged supervisor and hardening diagnostics must use byte-identical
 * script text. Keeping the generator here also keeps the interruption record
 * schema beside its validator instead of duplicating shell protocol details.
 */
export function buildRuntimeSupervisorScript(options: RuntimeSupervisorScriptOptions): string {
  const ready = runtimeReadyPath(options.dataDir);
  const interruption = runtimeInterruptionPath(options.dataDir);
  return `#!/bin/zsh
set -u
marker=${shellSingleQuote(options.markerPath)}
ready=${shellSingleQuote(ready)}
interruption=${shellSingleQuote(interruption)}
app_path=${shellSingleQuote(options.appPath)}
executable_path=${shellSingleQuote(options.executablePath)}

preserve_interruption() {
  local stale_pid="$1"
  local stale_started_at="$2"
  local reason="$3"
  if [[ "$stale_pid" != <-> ]] || [[ -z "$stale_started_at" ]]; then
    return 1
  fi
  local interruption_id="runtime-interruption-v1:\${stale_pid}:\${stale_started_at}"
  if [[ -e "$interruption" || -L "$interruption" ]]; then
    if existing_interruption_matches "$interruption_id"; then
      /bin/sync || return 1
      return 0
    fi
    archive_existing_interruption || return 1
  fi
  local detected_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
  local temporary="\${interruption}.$$.tmp"
  /bin/rm -f "$temporary"
  /usr/bin/plutil -create json "$temporary" || return 1
  /usr/bin/plutil -insert version -integer ${RUNTIME_INTERRUPTION_VERSION} "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert id -string "$interruption_id" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert pid -integer "$stale_pid" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert startedAt -string "$stale_started_at" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert appPath -string "$executable_path" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert transport -string "in-app" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert detectedAt -string "$detected_at" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /usr/bin/plutil -insert reason -string "$reason" "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/chmod 0600 "$temporary" || { /bin/rm -f "$temporary"; return 1; }
  /bin/sync || { /bin/rm -f "$temporary"; return 1; }
  if [[ -e "$interruption" || -L "$interruption" ]]; then
    if existing_interruption_matches "$interruption_id"; then
      /bin/rm -f "$temporary"
      /bin/sync || return 1
      return 0
    fi
    archive_existing_interruption || { /bin/rm -f "$temporary"; return 1; }
  fi
  /bin/mv -f "$temporary" "$interruption" || return 1
  /bin/sync
}

existing_interruption_matches() {
  local expected_id="$1"
  if [[ ! -f "$interruption" ]] || [[ -L "$interruption" ]]; then
    return 1
  fi
  local existing_mode=$(/usr/bin/stat -f '%Lp' "$interruption" 2>/dev/null)
  local existing_owner=$(/usr/bin/stat -f '%u' "$interruption" 2>/dev/null)
  local existing_size=$(/usr/bin/stat -f '%z' "$interruption" 2>/dev/null)
  local current_owner=$(/usr/bin/id -u)
  if [[ "$existing_mode" != "600" ]] || [[ "$existing_owner" != "$current_owner" ]] || [[ "$existing_size" != <-> ]] || (( existing_size > ${MAX_RUNTIME_INTERRUPTION_BYTES} )); then
    return 1
  fi
  local existing_id=$(/usr/bin/plutil -extract id raw -o - "$interruption" 2>/dev/null)
  [[ "$existing_id" == "$expected_id" ]]
}

archive_existing_interruption() {
  if [[ ! -e "$interruption" ]] && [[ ! -L "$interruption" ]]; then
    return 0
  fi
  local archived_at=$(/bin/date -u '+%Y%m%dT%H%M%SZ')
  local archive_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  if [[ -z "$archive_uuid" ]]; then
    return 1
  fi
  local archive_path="\${interruption}.conflict.\${archived_at}.\${archive_uuid}"
  if [[ -e "$archive_path" || -L "$archive_path" ]]; then
    return 1
  fi
  /bin/mv "$interruption" "$archive_path"
}

archive_invalid_ready() {
  if [[ ! -e "$ready" ]] && [[ ! -L "$ready" ]]; then
    return 0
  fi
  local archived_at=$(/bin/date -u '+%Y%m%dT%H%M%SZ')
  local archive_uuid=$(/usr/bin/uuidgen 2>/dev/null)
  if [[ -z "$archive_uuid" ]]; then
    return 1
  fi
  local archive_path="\${ready}.invalid.\${archived_at}.\${archive_uuid}"
  if [[ -e "$archive_path" || -L "$archive_path" ]]; then
    return 1
  fi
  /bin/mv "$ready" "$archive_path" || return 1
  /bin/sync
}

pid=""
started_at=""
ready_app_path=""
ready_transport=""
ready_loaded=false
while [[ -e "$marker" ]]; do
  command=""
  ready_exists=false
  if [[ "$ready_loaded" == true ]]; then
    ready_exists=true
  elif [[ -e "$ready" || -L "$ready" ]]; then
    ready_exists=true
    pid=""
    started_at=""
    ready_app_path=""
    ready_transport=""
    pid=$(/usr/bin/plutil -extract pid raw -o - "$ready" 2>/dev/null)
    started_at=$(/usr/bin/plutil -extract startedAt raw -o - "$ready" 2>/dev/null)
    ready_app_path=$(/usr/bin/plutil -extract appPath raw -o - "$ready" 2>/dev/null)
    ready_transport=$(/usr/bin/plutil -extract transport raw -o - "$ready" 2>/dev/null)
    ready_loaded=true
  fi
  if [[ "$pid" == <-> ]]; then
    command=$(/bin/ps -p "$pid" -o command= 2>/dev/null)
  fi
  if [[ "$pid" == <-> ]] && [[ -n "$started_at" ]] && [[ "$ready_app_path" == "$executable_path" ]] && [[ "$ready_transport" == "in-app" ]] && [[ "$command" == "$executable_path" || "$command" == "$executable_path "* ]]; then
    /bin/sleep 2
    continue
  fi
  if [[ "$ready_exists" == true ]]; then
    if [[ "$pid" != <-> ]] || [[ -z "$started_at" ]] || [[ "$ready_app_path" != "$executable_path" ]] || [[ "$ready_transport" != "in-app" ]]; then
      invalid_started_at=$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')
      if ! preserve_interruption "$$" "$invalid_started_at" "invalid-ready-record"; then
        /usr/bin/printf '%s\n' "Vigil could not preserve invalid readiness evidence before recovery." >&2
        ready_loaded=false
        if [[ -e "$marker" ]]; then
          /usr/bin/open -g "$app_path" --args ${shellSingleQuote(options.backgroundLaunchArg)} ${shellSingleQuote(options.safetyBoundaryArg)}
        fi
        /bin/sleep 2
        continue
      fi
      if ! archive_invalid_ready; then
        /usr/bin/printf '%s\n' "Vigil preserved a fail-closed receipt but could not archive the malformed readiness file." >&2
      fi
    else
      reason="process-identity-mismatch"
      if [[ -z "$command" ]]; then
        reason="process-missing"
      fi
      if ! preserve_interruption "$pid" "$started_at" "$reason"; then
        /usr/bin/printf '%s\n' "Vigil could not preserve runtime interruption evidence before recovery." >&2
        ready_loaded=false
        if [[ -e "$marker" ]]; then
          /usr/bin/open -g "$app_path" --args ${shellSingleQuote(options.backgroundLaunchArg)} ${shellSingleQuote(options.safetyBoundaryArg)}
        fi
        /bin/sleep 2
        continue
      fi
    fi
  fi
  /bin/rm -f "$ready"
  pid=""
  started_at=""
  ready_app_path=""
  ready_transport=""
  ready_loaded=false
  if [[ ! -e "$marker" ]]; then
    break
  fi
  /usr/bin/open -g "$app_path" --args ${shellSingleQuote(options.backgroundLaunchArg)} ${shellSingleQuote(options.safetyBoundaryArg)}
  /bin/sleep 5
done
`;
}

export async function markRuntimeReady(dataDir: string, appPath: string): Promise<RuntimeReadyRecord> {
  const record: RuntimeReadyRecord = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    appPath,
    transport: "in-app"
  };
  const path = runtimeReadyPath(dataDir);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dataDir, { recursive: true });
  let temporary: Awaited<ReturnType<typeof open>> | null = null;
  try {
    temporary = await open(temporaryPath, "wx", PRIVATE_FILE_MODE);
    await temporary.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await rename(temporaryPath, path);
    await syncDirectory(dataDir);
  } finally {
    await temporary?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
  return record;
}

export async function readRuntimeReady(dataDir: string): Promise<RuntimeReadyRecord | null> {
  try {
    const value = JSON.parse(await readFile(runtimeReadyPath(dataDir), "utf8")) as Partial<RuntimeReadyRecord>;
    if (
      !Number.isInteger(value.pid)
      || Number(value.pid) < 1
      || !Number.isFinite(Date.parse(String(value.startedAt || "")))
      || typeof value.appPath !== "string"
      || value.transport !== "in-app"
    ) return null;
    return value as RuntimeReadyRecord;
  } catch {
    return null;
  }
}

export async function readRuntimeInterruption(dataDir: string): Promise<RuntimeInterruptionReadResult> {
  const path = runtimeInterruptionPath(dataDir);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    return fileErrorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", reason: "unreadable-file" };
  }
  if (
    !metadata.isFile()
    || metadata.isSymbolicLink()
    || (metadata.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && metadata.uid !== process.getuid())
  ) return { status: "invalid", reason: "unsafe-file" };
  if (metadata.size > MAX_RUNTIME_INTERRUPTION_BYTES) {
    return { status: "invalid", reason: "oversized-file" };
  }
  let raw: Buffer;
  try {
    raw = await readFile(path);
  } catch {
    return { status: "invalid", reason: "unreadable-file" };
  }
  if (raw.byteLength > MAX_RUNTIME_INTERRUPTION_BYTES) {
    return { status: "invalid", reason: "oversized-file" };
  }
  let value: Partial<RuntimeInterruptionRecord>;
  try {
    value = JSON.parse(raw.toString("utf8")) as Partial<RuntimeInterruptionRecord>;
  } catch {
    return { status: "invalid", reason: "malformed-json" };
  }
  if (
    value.version !== RUNTIME_INTERRUPTION_VERSION
    || !Number.isInteger(value.pid)
    || Number(value.pid) < 1
    || !validTimestamp(value.startedAt)
    || !validTimestamp(value.detectedAt)
    || Date.parse(value.startedAt) > Date.parse(value.detectedAt)
    || typeof value.appPath !== "string"
    || !value.appPath.startsWith("/")
    || value.appPath.length > 4_096
    || value.transport !== "in-app"
    || !runtimeInterruptionReason(value.reason)
    || value.id !== runtimeInterruptionId({ pid: Number(value.pid), startedAt: String(value.startedAt) })
  ) return { status: "invalid", reason: "invalid-record" };
  return { status: "valid", record: value as RuntimeInterruptionRecord };
}

export async function liveRuntimeReady(dataDir: string, startedAfter = 0): Promise<RuntimeReadyRecord | null> {
  const record = await readRuntimeReady(dataDir);
  if (!record || Date.parse(record.startedAt) < startedAfter || !processIsRunning(record.pid)) return null;
  return record;
}

export async function clearRuntimeReady(dataDir: string, pid = process.pid): Promise<void> {
  const record = await readRuntimeReady(dataDir);
  if (record?.pid !== pid) return;
  await rm(runtimeReadyPath(dataDir), { force: true });
  await syncDirectory(dataDir);
}

export async function clearRuntimeInterruption(dataDir: string, expectedId: string): Promise<boolean> {
  const result = await readRuntimeInterruption(dataDir);
  if (result.status !== "valid" || result.record.id !== expectedId) return false;
  await rm(runtimeInterruptionPath(dataDir), { force: true });
  await syncDirectory(dataDir);
  return true;
}

/**
 * Preserve an invalid canonical receipt while freeing its well-known path for
 * future supervisor evidence. Rename operates on the directory entry itself,
 * so a symlink is quarantined without reading or modifying its target.
 */
export async function quarantineRuntimeInterruption(dataDir: string, now = new Date()): Promise<string | null> {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error("Vigil cannot quarantine interruption evidence with an invalid timestamp.");
  const path = runtimeInterruptionPath(dataDir);
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (fileErrorCode(error) === "ENOENT") return null;
    throw error;
  }
  await chmodPrivateIfSameSafeFile(path, metadata);
  const evidencePath = `${path}.corrupt.${Math.trunc(timestamp)}.${randomUUID()}`;
  await rename(path, evidencePath);
  try {
    const movedMetadata = await lstat(evidencePath);
    await chmodPrivateIfSameSafeFile(evidencePath, movedMetadata);
    const directory = await open(dataDir, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    throw Object.assign(new Error(`Vigil quarantined invalid runtime interruption evidence at ${evidencePath}, but could not durably secure it.`), {
      cause: error,
      evidencePath
    });
  }
  return evidencePath;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM");
  }
}

function runtimeInterruptionReason(value: unknown): value is RuntimeInterruptionReason {
  return value === "process-missing" || value === "process-identity-mismatch" || value === "invalid-ready-record";
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function validTimestamp(value: unknown): value is string {
  const text = String(value || "");
  return text.length > 0 && text.length <= 64 && Number.isFinite(Date.parse(text));
}

function fileErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code || "")
    : "";
}

async function chmodPrivateIfSameSafeFile(
  path: string,
  expected: Awaited<ReturnType<typeof lstat>>
): Promise<void> {
  if (
    !expected.isFile()
    || expected.isSymbolicLink()
    || expected.nlink !== 1
    || (typeof process.getuid === "function" && expected.uid !== process.getuid())
  ) return;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const opened = await handle.stat();
    if (
      !opened.isFile()
      || opened.dev !== expected.dev
      || opened.ino !== expected.ino
      || opened.nlink !== 1
      || (typeof process.getuid === "function" && opened.uid !== process.getuid())
    ) return;
    await handle.chmod(PRIVATE_FILE_MODE);
  } catch {
    // Unsafe or inaccessible file types are still preserved by rename; only
    // descriptor-verified regular files are permission-normalized.
  } finally {
    await handle?.close().catch(() => {});
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
