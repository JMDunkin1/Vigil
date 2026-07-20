import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parsePlist } from "./plist.js";

export const UPDATE_LOCK_FILENAME = "update.lock";
export const SYSTEM_GUARDIAN_MAINTENANCE_FILENAME = "guardian-maintenance.json";
export const SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS = 10 * 60;
export const SYSTEM_GUARDIAN_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/maintenance-authorization.plist";
const SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS = 10_000;
const SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS = 100;

interface UpdateLockPayload {
  token?: unknown;
  pid?: unknown;
}

interface GuardianMaintenancePayload {
  kind: "vigil-maintenance-request-v2";
  token: string;
  pid: number;
  lockPath: string;
  expiresAtEpoch: number;
}

interface GuardianAuthorizationPayload {
  kind?: unknown;
  token?: unknown;
  pid?: unknown;
  lockPath?: unknown;
  updaterExecutable?: unknown;
  updaterStarted?: unknown;
  expiresAtEpoch?: unknown;
}

export interface GuardianMaintenanceOptions {
  authorizationPath?: string | null;
  authorizationTimeoutMs?: number;
  expectedAuthorizationUid?: number;
}

export interface GuardianMaintenanceTransaction {
  markerPath: string;
  release(): Promise<void>;
}

export function defaultUpdaterLockPath(targetHome: string): string {
  return join(targetHome, "Library", "Application Support", "Vigil", "updater", UPDATE_LOCK_FILENAME);
}

export function guardianMaintenanceMarkerPath(lockPath: string): string {
  return join(dirname(lockPath), SYSTEM_GUARDIAN_MAINTENANCE_FILENAME);
}

export async function beginGuardianMaintenance(
  lockPath: string,
  lockToken: string,
  ownerPid = process.pid,
  now = Date.now(),
  options: GuardianMaintenanceOptions = {}
): Promise<GuardianMaintenanceTransaction> {
  await assertOwnedUpdaterLock(lockPath, lockToken, ownerPid);
  const markerPath = guardianMaintenanceMarkerPath(lockPath);
  const temporaryPath = `${markerPath}.${ownerPid}.${lockToken}.tmp`;
  const payload: GuardianMaintenancePayload = {
    kind: "vigil-maintenance-request-v2",
    token: lockToken,
    pid: ownerPid,
    lockPath,
    expiresAtEpoch: Math.floor(now / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, markerPath);
    // Close the race where lock ownership changes between the first check and
    // publishing the marker. A mismatched marker is removed and never trusted.
    await assertOwnedUpdaterLock(lockPath, lockToken, ownerPid);
    const authorizationPath = options.authorizationPath === undefined
      ? SYSTEM_GUARDIAN_AUTHORIZATION_PATH
      : options.authorizationPath;
    if (authorizationPath && await rootGuardianAuthorizationRequired(authorizationPath, options.expectedAuthorizationUid ?? 0)) {
      await waitForRootGuardianAuthorization(
        authorizationPath,
        payload,
        options.authorizationTimeoutMs ?? SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS,
        options.expectedAuthorizationUid ?? 0
      );
    }
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await removeOwnedGuardianMaintenanceMarker(markerPath, lockToken, ownerPid).catch(() => undefined);
    throw error;
  }

  let released = false;
  return {
    markerPath,
    async release() {
      if (released) return;
      await removeOwnedGuardianMaintenanceMarker(markerPath, lockToken, ownerPid);
      released = true;
    }
  };
}

async function rootGuardianAuthorizationRequired(authorizationPath: string, expectedUid: number): Promise<boolean> {
  try {
    const guardianRoot = await lstat(dirname(authorizationPath));
    if (!guardianRoot.isDirectory() || guardianRoot.isSymbolicLink() || guardianRoot.uid !== expectedUid || (guardianRoot.mode & 0o022) !== 0) {
      throw new Error("Vigil's system guardian authorization directory is unsafe.");
    }
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function waitForRootGuardianAuthorization(
  authorizationPath: string,
  request: GuardianMaintenancePayload,
  timeoutMs: number,
  expectedUid: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil's system guardian did not authorize maintenance.");
  do {
    try {
      const [authorization, authorizationStat] = await Promise.all([
        readGuardianAuthorization(authorizationPath),
        lstat(authorizationPath)
      ]);
      const nowEpoch = Math.floor(Date.now() / 1_000);
      if (!authorizationStat.isFile() || authorizationStat.isSymbolicLink() || authorizationStat.uid !== expectedUid) {
        throw new Error("Vigil's system guardian authorization is not root-owned.");
      }
      if ((authorizationStat.mode & 0o022) !== 0) {
        throw new Error("Vigil's system guardian authorization is writable outside root.");
      }
      if (
        authorization.kind !== "vigil-root-maintenance-authorization-v2"
        || authorization.token !== request.token
        || authorization.pid !== request.pid
        || authorization.lockPath !== request.lockPath
        || typeof authorization.updaterExecutable !== "string"
        || !authorization.updaterExecutable.startsWith("/")
        || typeof authorization.updaterStarted !== "string"
        || !authorization.updaterStarted
        || !Number.isInteger(authorization.expiresAtEpoch)
        || Number(authorization.expiresAtEpoch) < nowEpoch
        || Number(authorization.expiresAtEpoch) > Math.floor(authorizationStat.mtimeMs / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
      ) {
        throw new Error("Vigil's system guardian authorization does not match this updater.");
      }
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Vigil's system guardian did not authorize maintenance: ${errorMessage(lastError)}`);
}

export async function assertOwnedUpdaterLock(lockPath: string, lockToken: string, ownerPid = process.pid): Promise<void> {
  let payload: UpdateLockPayload;
  let lockStat: Awaited<ReturnType<typeof lstat>>;
  try {
    [payload, lockStat] = await Promise.all([
      readJson<UpdateLockPayload>(lockPath),
      lstat(lockPath)
    ]);
  } catch {
    throw new Error("Vigil updater lock is missing or unreadable.");
  }
  const uid = process.getuid?.();
  if (!lockStat.isFile() || lockStat.isSymbolicLink()) {
    throw new Error("Vigil updater lock is not a regular file.");
  }
  if (uid !== undefined && lockStat.uid !== uid) {
    throw new Error("Vigil updater lock is owned by another account.");
  }
  if ((lockStat.mode & 0o077) !== 0) {
    throw new Error("Vigil updater lock permissions are too broad.");
  }
  if (payload.token !== lockToken || payload.pid !== ownerPid) {
    throw new Error("Vigil updater lock ownership could not be verified.");
  }
}

async function removeOwnedGuardianMaintenanceMarker(markerPath: string, lockToken: string, ownerPid: number): Promise<void> {
  let payload: Partial<GuardianMaintenancePayload>;
  try {
    payload = await readJson<Partial<GuardianMaintenancePayload>>(markerPath);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (payload.token === lockToken && payload.pid === ownerPid) {
    await rm(markerPath, { force: true });
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function readGuardianAuthorization(path: string): Promise<GuardianAuthorizationPayload> {
  return parsePlist(await readFile(path, "utf8")) as GuardianAuthorizationPayload;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown authorization error.");
}
