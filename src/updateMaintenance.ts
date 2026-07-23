import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { parsePlist } from "./plist.js";

const execFileAsync = promisify(execFile);

export const UPDATE_LOCK_FILENAME = "update.lock";
export const SYSTEM_GUARDIAN_MAINTENANCE_FILENAME = "guardian-maintenance.json";
export const SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS = 10 * 60;
export const SYSTEM_GUARDIAN_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/maintenance-authorization.plist";
export const SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/update-recovery-authorization-v3.plist";
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/update-protocol-bootstrap-authorization.json";
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND = "vigil-root-update-protocol-bootstrap-authorization-v1";
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS = 5 * 60;
export const UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH = "/Library/Application Support/Vigil/System Guardian/update-protocol-bootstrap-worker-claim.plist";
export const UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND = "vigil-root-update-protocol-bootstrap-worker-claim-v1";
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME = "bootstrap-worker-request.json";
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND = "vigil-update-protocol-bootstrap-worker-request-v1";
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS = 5 * 60;
export const SYSTEM_GUARDIAN_SCRIPT_PATH = "/Library/Application Support/Vigil/System Guardian/vigil-system-guardian-v3-DO-NOT-TERMINATE.sh";
export const SYSTEM_GUARDIAN_PLIST_PATH = "/Library/LaunchDaemons/tech.caseline.vigil.system-guardian.v3.plist";
export const SYSTEM_GUARDIAN_LABEL = "tech.caseline.vigil.system-guardian.v3";
export const LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH = "/Library/Application Support/Vigil/System Guardian/vigil-system-guardian-DO-NOT-TERMINATE.sh";
export const LEGACY_SYSTEM_GUARDIAN_PLIST_PATH = "/Library/LaunchDaemons/tech.caseline.vigil.system-guardian.plist";
export const LEGACY_SYSTEM_GUARDIAN_LABEL = "tech.caseline.vigil.system-guardian";
export const LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/update-recovery-authorization.plist";
export const SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND = "vigil-root-update-recovery-authorization-v3";
export const SYSTEM_GUARDIAN_REVISION = 3;
export const SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX = "# vigil-system-guardian-revision=";
export const SYSTEM_GUARDIAN_REVISION_MARKER = `${SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX}${SYSTEM_GUARDIAN_REVISION}`;
export const UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION = 3;
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
  authorizationMode?: unknown;
  updaterCommand?: unknown;
  updaterScriptPath?: unknown;
  updaterScriptSha256?: unknown;
  updaterAppCdHash?: unknown;
  parentPid?: unknown;
  parentExecutable?: unknown;
  parentStarted?: unknown;
  parentCommand?: unknown;
  bootstrapAuthorizationSha256?: unknown;
  expiresAtEpoch?: unknown;
  recoveryAttemptId?: unknown;
  recoveryPolicySha256?: unknown;
  recoveryPendingManifestSha256?: unknown;
  appInitialCdHash?: unknown;
  appTargetCdHash?: unknown;
}

interface BootstrapWorkerRequestPayload {
  kind: typeof UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND;
  bootstrapToken: string;
  lockPath: string;
  lockToken: string;
  sourceAppPath: string;
  targetAppPath: string;
  expectedUpdateCommit: string;
  workerPid: number;
  relayPid: number;
  expiresAtEpoch: number;
}

interface BootstrapWorkerClaimPayload {
  kind?: unknown;
  bootstrapToken?: unknown;
  lockPath?: unknown;
  lockToken?: unknown;
  sourceAppPath?: unknown;
  targetAppPath?: unknown;
  expectedUpdateCommit?: unknown;
  workerPid?: unknown;
  relayPid?: unknown;
  workerStarted?: unknown;
  workerCommand?: unknown;
  relayStarted?: unknown;
  relayCommand?: unknown;
  bootstrapAuthorizationSha256?: unknown;
  expiresAtEpoch?: unknown;
}

export interface BootstrapWorkerAuthorizationRequest {
  bootstrapToken: string;
  lockPath: string;
  lockToken: string;
  sourceAppPath: string;
  targetAppPath: string;
  expectedUpdateCommit: string;
  workerPid: number;
  relayPid: number;
}

export interface BootstrapWorkerRequestTransaction {
  requestPath: string;
  release(): Promise<void>;
}

export interface GuardianMaintenanceOptions {
  authorizationPath?: string | null;
  recoveryAuthorizationPath?: string;
  authorizationTimeoutMs?: number;
  expectedAuthorizationUid?: number;
  expectedAppInitialCdHash?: string;
  expectedAppTargetCdHash?: string;
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
  | "outdated-revision"
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

export function guardianServiceAllowsParallelSetup(
  service: { loaded: boolean; running: boolean },
  legacyGuardianSafe: boolean
): boolean {
  return !service.loaded && !service.running && legacyGuardianSafe;
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
  if (inspectProductionTopology
    && await currentGuardianFilesMissingOrIncomplete(guardianScriptPath, guardianPlistPath)) {
    try {
      const service = await inspectLiveGuardianService(options.guardianLabel || SYSTEM_GUARDIAN_LABEL);
      if (service.loaded) {
        return maintenanceNotReady(
          "Vigil's parallel v3 system guardian is loaded with an incomplete on-disk installation. It was left untouched.",
          "incomplete"
        );
      }
      if (await legacyGuardianSupportsParallelMigration(expectedUid)) {
        return maintenanceNotReady(
          "Vigil's parallel v3 system guardian must be added before installing this update. The legacy guardian stays online during setup.",
          "outdated-revision",
          true
        );
      }
    } catch (error) {
      return maintenanceNotReady(
        `Vigil could not inspect its parallel v3 system guardian service: ${errorMessage(error)}`,
        "inspection-failed"
      );
    }
  }
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

  let productionService: { loaded: boolean; running: boolean } | null = null;
  let productionSetupSupported = false;
  if (inspectProductionTopology) {
    try {
      productionService = await inspectLiveGuardianService(options.guardianLabel || SYSTEM_GUARDIAN_LABEL);
      productionSetupSupported = guardianServiceAllowsParallelSetup(
        productionService,
        await legacyGuardianSupportsParallelMigration(expectedUid)
      );
      if (productionService.loaded && !productionService.running) {
        return maintenanceNotReady(
          "Vigil's parallel v3 system guardian is loaded but not running. It was left untouched.",
          "incomplete"
        );
      }
    } catch (error) {
      return maintenanceNotReady(
        `Vigil could not inspect its parallel v3 system guardian service: ${errorMessage(error)}`,
        "inspection-failed"
      );
    }
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
      && script.includes(authorizationPath);
    if (!supportsAuthenticatedMaintenance) {
      return maintenanceNotReady(
        "Vigil's system guardian predates authenticated app updates. Refresh it through Vigil's protected maintenance setup before installing this update.",
        "legacy-protocol",
        inspectProductionTopology ? productionSetupSupported : true
      );
    }
    const installedRevision = guardianScriptRevision(script);
    if (installedRevision === null
      || installedRevision < SYSTEM_GUARDIAN_REVISION
      || (installedRevision === SYSTEM_GUARDIAN_REVISION
        && !script.includes(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND))) {
      return maintenanceNotReady(
        "Vigil's system guardian needs the latest availability safety fixes. Refresh it through Vigil's protected maintenance setup before installing this update.",
        "outdated-revision",
        inspectProductionTopology ? productionSetupSupported : true
      );
    }
    if (productionService && !productionService.running) {
        return maintenanceNotReady(
          "Vigil's parallel v3 system guardian is installed but not yet running.",
          "incomplete",
          productionSetupSupported
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

async function currentGuardianFilesMissingOrIncomplete(
  scriptPath: string,
  plistPath: string | null
): Promise<boolean> {
  if (!plistPath) return false;
  try {
    const [scriptStat, plistStat] = await Promise.all([lstat(scriptPath), lstat(plistPath)]);
    return !scriptStat.isFile()
      || scriptStat.isSymbolicLink()
      || !plistStat.isFile()
      || plistStat.isSymbolicLink();
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return true;
    throw error;
  }
}

async function legacyGuardianSupportsParallelMigration(expectedUid: number): Promise<boolean> {
  try {
    const [script, plist, scriptStat, plistStat] = await Promise.all([
      readFile(LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH, "utf8"),
      readFile(LEGACY_SYSTEM_GUARDIAN_PLIST_PATH, "utf8"),
      lstat(LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH),
      lstat(LEGACY_SYSTEM_GUARDIAN_PLIST_PATH)
    ]);
    if (!scriptStat.isFile()
      || scriptStat.isSymbolicLink()
      || scriptStat.uid !== expectedUid
      || (scriptStat.mode & 0o022) !== 0
      || !plistStat.isFile()
      || plistStat.isSymbolicLink()
      || plistStat.uid !== expectedUid
      || (plistStat.mode & 0o022) !== 0
      || !script.includes("authorize_maintenance_request()")) return false;
    const parsed = parsePlist(plist) as Record<string, unknown>;
    const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments : [];
    return parsed.Label === LEGACY_SYSTEM_GUARDIAN_LABEL
      && args[0] === LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH
      && parsed.KeepAlive === true
      && parsed.RunAtLoad === true;
  } catch {
    return false;
  }
}

async function inspectLiveGuardianService(label: string): Promise<{ loaded: boolean; running: boolean }> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `system/${label}`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8"
    });
    return {
      loaded: true,
      running: /^\s*state = running\s*$/mu.test(stdout)
        && /^\s*pid = [1-9]\d*\s*$/mu.test(stdout)
    };
  } catch (error) {
    if (launchctlServiceMissing(error)) return { loaded: false, running: false };
    throw error;
  }
}

function launchctlServiceMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { message?: unknown; stderr?: unknown };
  const detail = `${String(record.stderr || "")}\n${String(record.message || "")}`;
  return /could not find service|service not found|no such process/iu.test(detail);
}

export function guardianScriptRevision(script: string): number | null {
  let revision: number | null = null;
  for (const line of script.split(/\r?\n/u)) {
    if (!line.startsWith(SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX)) continue;
    if (revision !== null) return null;
    const value = line.slice(SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX.length);
    if (!/^\d+$/u.test(value)) return null;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
    revision = parsed;
  }
  return revision;
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

export function bootstrapWorkerRequestPath(lockPath: string): string {
  return join(dirname(lockPath), UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME);
}

/**
 * Publish the signed bridge worker identity before updater-lock ownership is
 * transferred. The root guardian independently verifies the exact relay/worker
 * process chain and creates a one-shot root-owned claim; the launcher must wait
 * for that claim before it can hand the lock to the worker PID.
 */
export async function publishBootstrapWorkerAuthorizationRequest(
  request: BootstrapWorkerAuthorizationRequest,
  now = Date.now()
): Promise<BootstrapWorkerRequestTransaction> {
  validateBootstrapWorkerAuthorizationRequest(request);
  const requestPath = bootstrapWorkerRequestPath(request.lockPath);
  const temporaryPath = `${requestPath}.${request.workerPid}.${request.bootstrapToken}.tmp`;
  const payload: BootstrapWorkerRequestPayload = {
    kind: UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND,
    ...request,
    expiresAtEpoch: Math.floor(now / 1_000) + UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS
  };
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await rename(temporaryPath, requestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  let released = false;
  return {
    requestPath,
    async release() {
      if (released) return;
      let current: Partial<BootstrapWorkerRequestPayload> | null = null;
      try {
        current = await readJson<Partial<BootstrapWorkerRequestPayload>>(requestPath);
      } catch (error) {
        if (isErrorCode(error, "ENOENT")) {
          released = true;
          return;
        }
        throw error;
      }
      if (current.kind === UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND
        && current.bootstrapToken === request.bootstrapToken
        && current.workerPid === request.workerPid
        && current.relayPid === request.relayPid
        && current.lockToken === request.lockToken) {
        await rm(requestPath, { force: true });
      }
      released = true;
    }
  };
}

export async function waitForBootstrapWorkerAuthorization(
  request: BootstrapWorkerAuthorizationRequest,
  timeoutMs = SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS,
  expectedUid = 0,
  claimPath = UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH
): Promise<void> {
  validateBootstrapWorkerAuthorizationRequest(request);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil's system guardian has not attested the bootstrap worker.");
  do {
    try {
      const [claim, claimStat] = await Promise.all([
        readGuardianAuthorization(claimPath) as Promise<BootstrapWorkerClaimPayload>,
        lstat(claimPath)
      ]);
      const nowEpoch = Math.floor(Date.now() / 1_000);
      if (!claimStat.isFile()
        || claimStat.isSymbolicLink()
        || claimStat.uid !== expectedUid
        || (claimStat.mode & 0o777) !== 0o644
        || claim.kind !== UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND
        || claim.bootstrapToken !== request.bootstrapToken
        || claim.lockPath !== request.lockPath
        || claim.lockToken !== request.lockToken
        || claim.sourceAppPath !== request.sourceAppPath
        || claim.targetAppPath !== request.targetAppPath
        || claim.expectedUpdateCommit !== request.expectedUpdateCommit
        || claim.workerPid !== request.workerPid
        || claim.relayPid !== request.relayPid
        || typeof claim.workerStarted !== "string"
        || !claim.workerStarted
        || typeof claim.workerCommand !== "string"
        || !claim.workerCommand
        || typeof claim.relayStarted !== "string"
        || !claim.relayStarted
        || typeof claim.relayCommand !== "string"
        || !claim.relayCommand
        || typeof claim.bootstrapAuthorizationSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(claim.bootstrapAuthorizationSha256)
        || !Number.isInteger(claim.expiresAtEpoch)
        || Number(claim.expiresAtEpoch) < nowEpoch
        || Number(claim.expiresAtEpoch) > Math.floor(claimStat.mtimeMs / 1_000) + UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS) {
        throw new Error("Vigil's root bootstrap-worker claim does not match this exact relay transaction.");
      }
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Vigil's system guardian did not attest the bootstrap worker: ${errorMessage(lastError)}`);
}

function validateBootstrapWorkerAuthorizationRequest(request: BootstrapWorkerAuthorizationRequest): void {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(request.bootstrapToken)
    || !request.lockPath.startsWith("/")
    || !request.lockToken
    || request.lockToken.length > 256
    || !request.sourceAppPath.startsWith("/")
    || !request.sourceAppPath.endsWith(".app")
    || !request.targetAppPath.startsWith("/")
    || !request.targetAppPath.endsWith(".app")
    || !/^[a-f0-9]{40}$/iu.test(request.expectedUpdateCommit)
    || !Number.isSafeInteger(request.workerPid)
    || request.workerPid < 1
    || !Number.isSafeInteger(request.relayPid)
    || request.relayPid < 1
    || request.workerPid === request.relayPid) {
    throw new Error("Vigil refused an incomplete bootstrap worker authorization request.");
  }
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
  const expectedAppInitialCdHash = exactCodeDirectoryHash(
    options.expectedAppInitialCdHash,
    "initial app CodeDirectory hash"
  );
  const expectedAppTargetCdHash = exactCodeDirectoryHash(
    options.expectedAppTargetCdHash,
    "target app CodeDirectory hash"
  );
  const recoveryAuthorizationPath = options.recoveryAuthorizationPath
    ?? SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH;
  const recoveryPendingManifestSha256 = await guardianRecoveryManifestSha256(
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
        || authorization.kind !== SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND
        || authorization.recoveryAttemptId !== lockToken
        || authorization.recoveryPolicySha256 !== recoveryPolicySha256
        || typeof authorization.recoveryPendingManifestSha256 !== "string"
        || authorization.recoveryPendingManifestSha256 !== recoveryPendingManifestSha256
        || authorization.appInitialCdHash !== expectedAppInitialCdHash
        || authorization.appTargetCdHash !== expectedAppTargetCdHash) {
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

/** Verify and capture one exact signed app generation without trusting bundle resources. */
export async function verifiedAppCodeDirectoryHash(appPath: string): Promise<string> {
  const before = await lstat(appPath);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error(`Vigil refused an unsafe app bundle at ${appPath}.`);
  }
  await verifyAppCodeSignature(appPath);
  const first = await appCodeDirectoryHash(appPath);
  await verifyAppCodeSignature(appPath);
  const second = await appCodeDirectoryHash(appPath);
  const after = await lstat(appPath);
  if (after.isSymbolicLink()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || first !== second) {
    throw new Error(`Vigil's signed app generation changed while it was being identified at ${appPath}.`);
  }
  return first;
}

async function verifyAppCodeSignature(appPath: string): Promise<void> {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
}

async function appCodeDirectoryHash(appPath: string): Promise<string> {
  const { stderr } = await execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
    encoding: "utf8"
  });
  return exactCodeDirectoryHash(
    String(stderr).match(/^CDHash=([a-f0-9]+)$/imu)?.[1]?.toLowerCase(),
    `CodeDirectory hash for ${appPath}`
  );
}

function exactCodeDirectoryHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40,64}$/u.test(value)) {
    throw new Error(`Vigil's ${label} is invalid.`);
  }
  return value;
}

/** Hash the exact private pending-manifest bytes pinned by this updater. */
export async function guardianRecoveryManifestSha256(manifestPath: string): Promise<string> {
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const manifest = await handle.stat();
    const uid = process.getuid?.();
    if (!manifest.isFile()
      || (manifest.mode & 0o077) !== 0
      || manifest.size > 256 * 1024
      || (uid !== undefined && manifest.uid !== uid)) {
      throw new Error("Vigil's update recovery manifest is unsafe for root attestation.");
    }
    const bytes = await handle.readFile();
    if (bytes.length !== manifest.size || bytes.length > 256 * 1024) {
      throw new Error("Vigil's update recovery manifest changed while it was being attested.");
    }
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    await handle.close();
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
    || (authorization.authorizationMode !== "normal" && authorization.authorizationMode !== "bootstrap")
    || typeof authorization.updaterCommand !== "string"
    || !authorization.updaterCommand
    || typeof authorization.updaterScriptPath !== "string"
    || !authorization.updaterScriptPath.startsWith("/")
    || typeof authorization.updaterScriptSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(authorization.updaterScriptSha256)
    || typeof authorization.updaterAppCdHash !== "string"
    || !/^[a-f0-9]{40,64}$/u.test(authorization.updaterAppCdHash)
    || !Number.isInteger(authorization.parentPid)
    || Number(authorization.parentPid) < 1
    || typeof authorization.parentExecutable !== "string"
    || !authorization.parentExecutable.startsWith("/")
    || typeof authorization.parentStarted !== "string"
    || !authorization.parentStarted
    || typeof authorization.parentCommand !== "string"
    || !authorization.parentCommand
    || (authorization.authorizationMode === "normal" && authorization.bootstrapAuthorizationSha256 !== "-")
    || (authorization.authorizationMode === "bootstrap"
      && (typeof authorization.bootstrapAuthorizationSha256 !== "string"
        || !/^[a-f0-9]{64}$/u.test(authorization.bootstrapAuthorizationSha256)))
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
