import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parsePlist } from "./plist.js";

const execFileAsync = promisify(execFile);

export const UPDATE_LOCK_FILENAME = "update.lock";
export const SYSTEM_GUARDIAN_MAINTENANCE_FILENAME = "guardian-maintenance.json";
export const SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS = 10 * 60;
export const SYSTEM_GUARDIAN_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/maintenance-authorization.plist";
export const SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/update-recovery-authorization.plist";
export const SYSTEM_GUARDIAN_SCRIPT_PATH = "/Library/Application Support/Vigil/System Guardian/vigil-system-guardian-DO-NOT-TERMINATE.sh";
export const SYSTEM_GUARDIAN_PLIST_PATH = "/Library/LaunchDaemons/tech.caseline.vigil.system-guardian.plist";
export const SYSTEM_GUARDIAN_LABEL = "tech.caseline.vigil.system-guardian";
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
  recoveryAttemptId?: unknown;
  recoveryPolicySha256?: unknown;
  recoveryManifestSha256?: unknown;
}

export interface GuardianMaintenanceOptions {
  authorizationPath?: string | null;
  recoveryAuthorizationPath?: string;
  authorizationTimeoutMs?: number;
  expectedAuthorizationUid?: number;
}

export interface GuardianMaintenanceTransaction {
  markerPath: string;
  release(): Promise<void>;
}

export interface GuardianMaintenanceReadiness {
  ready: boolean;
  guardianInstalled: boolean;
  reason?: GuardianMaintenanceReadinessReason;
  setupRequired?: boolean;
  setupSupported?: boolean;
  message: string | null;
}

export type GuardianMaintenanceReadinessReason =
  | "not-installed"
  | "ready"
  | "legacy-protocol"
  | "incomplete"
  | "unsafe"
  | "topology-mismatch"
  | "inspection-failed";

export interface GuardianMaintenanceReadinessOptions {
  /**
   * Custom tests and migrations can explicitly select a launchd plist. The
   * production default is inspected automatically only when the production
   * authorization and guardian paths are in use.
   */
  guardianPlistPath?: string | null;
  guardianLabel?: string;
}

export function defaultUpdaterLockPath(targetHome: string): string {
  return join(targetHome, "Library", "Application Support", "Vigil", "updater", UPDATE_LOCK_FILENAME);
}

export function guardianMaintenanceMarkerPath(lockPath: string): string {
  return join(dirname(lockPath), SYSTEM_GUARDIAN_MAINTENANCE_FILENAME);
}

export async function guardianMaintenanceReadiness(
  authorizationPath = SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  guardianScriptPath = SYSTEM_GUARDIAN_SCRIPT_PATH,
  expectedUid = 0,
  options: GuardianMaintenanceReadinessOptions = {}
): Promise<GuardianMaintenanceReadiness> {
  let guardianRoot: Awaited<ReturnType<typeof lstat>>;
  try {
    guardianRoot = await lstat(dirname(authorizationPath));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return {
        ready: true,
        guardianInstalled: false,
        reason: "not-installed",
        setupRequired: false,
        setupSupported: false,
        message: null
      };
    }
    return maintenanceNotReady(
      `Vigil could not inspect its system guardian: ${errorMessage(error)}`,
      "inspection-failed"
    );
  }
  if (!guardianRoot.isDirectory() || guardianRoot.isSymbolicLink() || guardianRoot.uid !== expectedUid || (guardianRoot.mode & 0o022) !== 0) {
    return maintenanceNotReady("Vigil's system guardian directory is unsafe.", "unsafe");
  }

  const inspectProductionTopology = authorizationPath === SYSTEM_GUARDIAN_AUTHORIZATION_PATH
    && guardianScriptPath === SYSTEM_GUARDIAN_SCRIPT_PATH
    && expectedUid === 0;
  const guardianPlistPath = options.guardianPlistPath === undefined
    ? (inspectProductionTopology ? SYSTEM_GUARDIAN_PLIST_PATH : null)
    : options.guardianPlistPath;
  const topology = guardianPlistPath
    ? await inspectGuardianPlistTopology(
        guardianPlistPath,
        guardianScriptPath,
        options.guardianLabel || SYSTEM_GUARDIAN_LABEL,
        expectedUid
      )
    : { ready: true as const, reason: "ready" as const, message: "" };
  if (!topology.ready) {
    return maintenanceNotReady(
      topology.message,
      topology.reason as Exclude<GuardianMaintenanceReadinessReason, "not-installed" | "ready">
    );
  }

  try {
    const [script, scriptStat] = await Promise.all([
      readFile(guardianScriptPath, "utf8"),
      lstat(guardianScriptPath)
    ]);
    if (!scriptStat.isFile() || scriptStat.isSymbolicLink() || scriptStat.uid !== expectedUid || (scriptStat.mode & 0o022) !== 0) {
      return maintenanceNotReady("Vigil's installed system guardian is unsafe.", "unsafe");
    }
    const supportsAuthenticatedMaintenance = script.includes("authorize_maintenance_request()")
      && script.includes("vigil-root-maintenance-authorization-v2")
      && script.includes("attest_update_recovery()")
      && script.includes("attested_canonical_app_generation()")
      && script.includes("bounded_root_copy()")
      && script.includes("vigil-root-update-recovery-authorization-v2")
      && script.includes(authorizationPath);
    if (!supportsAuthenticatedMaintenance) {
      return maintenanceNotReady(
        "Vigil's system guardian predates authenticated app updates. Refresh it through Vigil's protected maintenance setup before installing this update.",
        "legacy-protocol",
        true
      );
    }
    return {
      ready: true,
      guardianInstalled: true,
      reason: "ready",
      setupRequired: false,
      setupSupported: false,
      message: null
    };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return maintenanceNotReady(
        "Vigil's system guardian installation is incomplete. Refresh it through Vigil's protected maintenance setup.",
        "incomplete"
      );
    }
    return maintenanceNotReady(
      `Vigil could not verify its system guardian: ${errorMessage(error)}`,
      "inspection-failed"
    );
  }
}

interface GuardianPlistTopologyInspection {
  ready: boolean;
  reason: "ready" | "incomplete" | "unsafe" | "topology-mismatch" | "inspection-failed";
  message: string;
}

async function inspectGuardianPlistTopology(
  plistPath: string,
  guardianScriptPath: string,
  guardianLabel: string,
  expectedUid: number
): Promise<GuardianPlistTopologyInspection> {
  let text: string;
  let plistStat: Awaited<ReturnType<typeof lstat>>;
  try {
    [text, plistStat] = await Promise.all([
      readFile(plistPath, "utf8"),
      lstat(plistPath)
    ]);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return {
        ready: false,
        reason: "incomplete",
        message: "Vigil's system guardian launch configuration is missing. Refresh it through Vigil's protected maintenance setup."
      };
    }
    return {
      ready: false,
      reason: "inspection-failed",
      message: `Vigil could not inspect its system guardian launch configuration: ${errorMessage(error)}`
    };
  }
  if (!plistStat.isFile()
    || plistStat.isSymbolicLink()
    || plistStat.uid !== expectedUid
    || (plistStat.mode & 0o022) !== 0) {
    return {
      ready: false,
      reason: "unsafe",
      message: "Vigil's system guardian launch configuration is unsafe."
    };
  }
  try {
    const plist = parsePlist(text) as Record<string, unknown>;
    const argumentsValue = Array.isArray(plist.ProgramArguments)
      ? plist.ProgramArguments
      : [];
    const topologyMatches = plist.Label === guardianLabel
      && argumentsValue[0] === guardianScriptPath
      && plist.KeepAlive === true
      && plist.RunAtLoad === true;
    if (!topologyMatches) {
      return {
        ready: false,
        reason: "topology-mismatch",
        message: "Vigil's system guardian uses an older launch configuration that cannot be refreshed automatically."
      };
    }
  } catch (error) {
    return {
      ready: false,
      reason: "topology-mismatch",
      message: `Vigil's system guardian launch configuration is invalid: ${errorMessage(error)}`
    };
  }
  return { ready: true, reason: "ready", message: "" };
}

function maintenanceNotReady(
  message: string,
  reason: Exclude<GuardianMaintenanceReadinessReason, "not-installed" | "ready">,
  setupSupported = false
): GuardianMaintenanceReadiness {
  return {
    ready: false,
    guardianInstalled: true,
    reason,
    setupRequired: true,
    setupSupported,
    message
  };
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
      await assertRootGuardianAuthorization(authorizationPath, request, Date.now(), expectedUid);
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

export async function assertGuardianMaintenanceActive(
  lockPath: string,
  lockToken: string,
  ownerPid: number,
  now = Date.now(),
  options: GuardianMaintenanceOptions = {}
): Promise<void> {
  await assertOwnedUpdaterLock(lockPath, lockToken, ownerPid);
  const markerPath = guardianMaintenanceMarkerPath(lockPath);
  let payload: Partial<GuardianMaintenancePayload>;
  let markerStat: Awaited<ReturnType<typeof lstat>>;
  try {
    [payload, markerStat] = await Promise.all([
      readJson<Partial<GuardianMaintenancePayload>>(markerPath),
      lstat(markerPath)
    ]);
  } catch {
    throw new Error("Vigil's authenticated update maintenance marker is missing or unreadable.");
  }
  const uid = process.getuid?.();
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error("Vigil's update maintenance marker is not a regular file.");
  }
  if (uid !== undefined && markerStat.uid !== uid) {
    throw new Error("Vigil's update maintenance marker is owned by another account.");
  }
  if ((markerStat.mode & 0o077) !== 0) {
    throw new Error("Vigil's update maintenance marker permissions are too broad.");
  }
  const nowEpoch = Math.floor(now / 1_000);
  if (
    payload.kind !== "vigil-maintenance-request-v2"
    || payload.token !== lockToken
    || payload.pid !== ownerPid
    || payload.lockPath !== lockPath
    || !Number.isInteger(payload.expiresAtEpoch)
    || Number(payload.expiresAtEpoch) < nowEpoch
    || Number(payload.expiresAtEpoch) > Math.floor(markerStat.mtimeMs / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS
  ) {
    throw new Error("Vigil's update maintenance marker does not authorize this updater.");
  }
  const authorizationPath = options.authorizationPath === undefined
    ? SYSTEM_GUARDIAN_AUTHORIZATION_PATH
    : options.authorizationPath;
  const expectedAuthorizationUid = options.expectedAuthorizationUid ?? 0;
  if (authorizationPath && await rootGuardianAuthorizationRequired(authorizationPath, expectedAuthorizationUid)) {
    await assertRootGuardianAuthorization(
      authorizationPath,
      payload as GuardianMaintenancePayload,
      now,
      expectedAuthorizationUid
    );
  }
}

/**
 * Wait for the root guardian to bind the immutable recovery transaction before
 * any canonical artifact is activated. Systems without the optional root
 * guardian have no root authorization directory and continue to rely on the
 * always-loaded user supervisor.
 */
export async function waitForGuardianRecoveryAuthorization(
  lockPath: string,
  lockToken: string,
  recoveryPolicySha256: string,
  ownerPid = process.pid,
  options: GuardianMaintenanceOptions = {}
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(recoveryPolicySha256)) {
    throw new Error("Vigil's update recovery policy digest is invalid.");
  }
  const authorizationPath = options.authorizationPath === undefined
    ? SYSTEM_GUARDIAN_AUTHORIZATION_PATH
    : options.authorizationPath;
  if (!authorizationPath) return;
  const expectedUid = options.expectedAuthorizationUid ?? 0;
  if (!await rootGuardianAuthorizationRequired(authorizationPath, expectedUid)) return;
  const recoveryAuthorizationPath = options.recoveryAuthorizationPath
    ?? SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH;
  const recoveryManifestSha256 = await guardianRecoveryManifestSha256(
    join(dirname(lockPath), "update-recovery.json")
  );

  const timeoutMs = options.authorizationTimeoutMs ?? SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil's system guardian did not attest update recovery.");
  do {
    try {
      const now = Date.now();
      await assertGuardianMaintenanceActive(lockPath, lockToken, ownerPid, now, options);
      const [authorization, authorizationStat] = await Promise.all([
        readGuardianAuthorization(recoveryAuthorizationPath),
        lstat(recoveryAuthorizationPath)
      ]);
      if (!authorizationStat.isFile()
        || authorizationStat.isSymbolicLink()
        || authorizationStat.uid !== expectedUid
        || (authorizationStat.mode & 0o777) !== 0o644
        || authorization.kind !== "vigil-root-update-recovery-authorization-v2"
        || authorization.recoveryAttemptId !== lockToken
        || authorization.recoveryPolicySha256 !== recoveryPolicySha256
        || typeof authorization.recoveryManifestSha256 !== "string"
        || authorization.recoveryManifestSha256 !== recoveryManifestSha256) {
        throw new Error("Vigil's system guardian recovery attestation does not match this update.");
      }
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Vigil's system guardian did not attest update recovery: ${errorMessage(lastError)}`);
}

/** Hash the immutable manifest projection exactly as the installed zsh guardian does. */
export async function guardianRecoveryManifestSha256(manifestPath: string): Promise<string> {
  const manifest = await lstat(manifestPath);
  const uid = process.getuid?.();
  if (!manifest.isFile()
    || manifest.isSymbolicLink()
    || (manifest.mode & 0o077) !== 0
    || (uid !== undefined && manifest.uid !== uid)) {
    throw new Error("Vigil's update recovery manifest is unsafe for root attestation.");
  }
  const temporaryRoot = await mkdtemp(join(dirname(manifestPath), ".guardian-attestation-"));
  const temporaryPath = join(temporaryRoot, "manifest.plist");
  try {
    await cp(manifestPath, temporaryPath, { force: false });
    for (const key of ["state", "source.syncPending", "timestamps"]) {
      await execFileAsync("/usr/bin/plutil", ["-remove", key, temporaryPath]);
    }
    await execFileAsync("/usr/bin/plutil", ["-convert", "binary1", temporaryPath]);
    return createHash("sha256").update(await readFile(temporaryPath)).digest("hex");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function assertRootGuardianAuthorization(
  authorizationPath: string,
  request: GuardianMaintenancePayload,
  now: number,
  expectedUid: number
): Promise<void> {
  const [authorization, authorizationStat] = await Promise.all([
    readGuardianAuthorization(authorizationPath),
    lstat(authorizationPath)
  ]);
  const nowEpoch = Math.floor(now / 1_000);
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
