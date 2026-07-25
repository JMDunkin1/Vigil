import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CURRENT_GUARDIAN_PROTOCOL,
  GUARDIAN_PROTOCOL_V7,
  LEGACY_GUARDIAN_PROTOCOL,
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS
} from "./guardianProtocol.js";
import { parsePlist } from "./plist.js";
import { UPDATE_RECOVERY_MANIFEST_FILENAME, UPDATE_RECOVERY_POLICY_FILENAME } from "./updateTransaction.js";

const execFileAsync = promisify(execFile);

export const UPDATE_LOCK_FILENAME = "update.lock";
export const SYSTEM_GUARDIAN_MAINTENANCE_FILENAME = "guardian-maintenance.json";
export const SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS = 10 * 60;
export const SYSTEM_GUARDIAN_AUTHORIZATION_PATH = CURRENT_GUARDIAN_PROTOCOL.maintenanceAuthorizationPath;
export const SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = CURRENT_GUARDIAN_PROTOCOL.recoveryAuthorizationPath;
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH = "/Library/Application Support/Vigil/System Guardian/update-protocol-bootstrap-authorization.json";
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND = "vigil-root-update-protocol-bootstrap-authorization-v1";
export const UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS = 5 * 60;
export const UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH = CURRENT_GUARDIAN_PROTOCOL.bootstrapClaimPath;
export const UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND = CURRENT_GUARDIAN_PROTOCOL.bootstrapClaimKind;
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME = "bootstrap-worker-request.json";
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_KIND = "vigil-update-protocol-bootstrap-worker-request-v1";
export const UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS = 5 * 60;
export const SYSTEM_GUARDIAN_SCRIPT_PATH = CURRENT_GUARDIAN_PROTOCOL.scriptPath;
export const SYSTEM_GUARDIAN_PLIST_PATH = CURRENT_GUARDIAN_PROTOCOL.plistPath;
export const SYSTEM_GUARDIAN_LABEL = CURRENT_GUARDIAN_PROTOCOL.label;
export const PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH = GUARDIAN_PROTOCOL_V7.scriptPath;
export const PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH = GUARDIAN_PROTOCOL_V7.plistPath;
export const PREVIOUS_SYSTEM_GUARDIAN_LABEL = GUARDIAN_PROTOCOL_V7.label;
export const PREVIOUS_SYSTEM_GUARDIAN_REVISION = GUARDIAN_PROTOCOL_V7.revision;
export const PREVIOUS_SYSTEM_GUARDIAN_AUTHORIZATION_PATH = GUARDIAN_PROTOCOL_V7.maintenanceAuthorizationPath;
export const PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = GUARDIAN_PROTOCOL_V7.recoveryAuthorizationPath;
export const PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND = GUARDIAN_PROTOCOL_V7.recoveryAuthorizationKind;
export const PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH = GUARDIAN_PROTOCOL_V7.bootstrapClaimPath;
export const LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH = LEGACY_GUARDIAN_PROTOCOL.scriptPath;
export const LEGACY_SYSTEM_GUARDIAN_PLIST_PATH = LEGACY_GUARDIAN_PROTOCOL.plistPath;
export const LEGACY_SYSTEM_GUARDIAN_LABEL = LEGACY_GUARDIAN_PROTOCOL.label;
export const LEGACY_SYSTEM_GUARDIAN_AUTHORIZATION_PATH = LEGACY_GUARDIAN_PROTOCOL.maintenanceAuthorizationPath;
export const LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH = LEGACY_GUARDIAN_PROTOCOL.recoveryAuthorizationPath;
export const LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND = LEGACY_GUARDIAN_PROTOCOL.recoveryAuthorizationKind;
export const SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND = CURRENT_GUARDIAN_PROTOCOL.recoveryAuthorizationKind;
export const SYSTEM_GUARDIAN_REVISION = CURRENT_GUARDIAN_PROTOCOL.revision;
export const SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX = "# vigil-system-guardian-revision=";
export const SYSTEM_GUARDIAN_REVISION_MARKER = `${SYSTEM_GUARDIAN_REVISION_MARKER_PREFIX}${SYSTEM_GUARDIAN_REVISION}`;
export const UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION = 3;
// Root bootstrap attestation re-hashes both signed app generations and the
// closed bridge tree before publishing its grant. On slower or busy systems
// that can consume most of the old 15-second client wait. Waiting longer does
// not extend the root-created authorization deadline; it only lets the client
// observe the existing bounded grant for the required stability window.
export const SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS = 45_000;
const SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS = 100;
const SYSTEM_GUARDIAN_AUTHORIZATION_STABILITY_MS = 2_500;

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
  [key: string]: unknown;
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
  recoveryAppPath?: unknown;
  recoveryManifestPath?: unknown;
  recoveryManifestSha256?: unknown;
  recoveryPolicyPath?: unknown;
  recoveryPolicySha256?: unknown;
  recoveryPendingManifestSha256?: unknown;
  appInitialPresent?: unknown;
  appInitialDev?: unknown;
  appInitialIno?: unknown;
  appInitialCommit?: unknown;
  appInitialFingerprint?: unknown;
  appInitialCdHash?: unknown;
  appTargetDev?: unknown;
  appTargetIno?: unknown;
  appTargetCommit?: unknown;
  appTargetFingerprint?: unknown;
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
  allowLegacySparseAuthorization?: boolean;
  recoveryAuthorizationPath?: string;
  authorizationTimeoutMs?: number;
  expectedAuthorizationUid?: number;
  expectedAppInitialCdHash?: string;
  expectedAppTargetCdHash?: string;
  recoveryAuthorizationRequirements?: GuardianRecoveryAuthorizationRequirement[];
}

export interface GuardianRecoveryAuthorizationRequirement {
  kind: string;
  label: string;
  path: string;
  protocol: "pinned-pending" | "legacy-normalized";
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
          `Vigil's ${SYSTEM_GUARDIAN_LABEL} guardian is loaded with an incomplete on-disk installation. It was left untouched.`,
          "incomplete"
        );
      }
      if (await legacyGuardianSupportsParallelMigration(expectedUid)) {
        return maintenanceNotReady(
          `Vigil's ${SYSTEM_GUARDIAN_LABEL} guardian must be added before installing this update. Earlier guardians stay online during setup.`,
          "outdated-revision",
          true
        );
      }
    } catch (error) {
      return maintenanceNotReady(
        `Vigil could not inspect guardian service ${SYSTEM_GUARDIAN_LABEL}: ${errorMessage(error)}`,
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
          `Vigil's ${SYSTEM_GUARDIAN_LABEL} guardian is loaded but not running. It was left untouched.`,
          "incomplete"
        );
      }
    } catch (error) {
      return maintenanceNotReady(
        `Vigil could not inspect guardian service ${SYSTEM_GUARDIAN_LABEL}: ${errorMessage(error)}`,
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
      && script.includes("write_maintenance_authorization()")
      && script.includes("normal_updater_script_for_command()")
      && script.includes("verified_signed_script_hash()")
      && [
        "authorizationMode",
        "updaterCommand",
        "updaterScriptPath",
        "updaterScriptSha256",
        "updaterAppCdHash",
        "parentPid",
        "parentExecutable",
        "parentStarted",
        "parentCommand",
        "bootstrapAuthorizationSha256"
      ].every((field) => script.includes(field))
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
          `Vigil's ${SYSTEM_GUARDIAN_LABEL} guardian is installed but not yet running.`,
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
  for (const guardian of SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS) {
    try {
      const [script, plist, scriptStat, plistStat] = await Promise.all([
        readFile(guardian.scriptPath, "utf8"),
        readFile(guardian.plistPath, "utf8"),
        lstat(guardian.scriptPath),
        lstat(guardian.plistPath)
      ]);
      if (!scriptStat.isFile()
        || scriptStat.isSymbolicLink()
        || scriptStat.uid !== expectedUid
        || (scriptStat.mode & 0o022) !== 0
        || !plistStat.isFile()
        || plistStat.isSymbolicLink()
        || plistStat.uid !== expectedUid
        || (plistStat.mode & 0o022) !== 0
        || guardianScriptRevision(script) !== guardian.revision
        || !script.includes("authorize_maintenance_request()")
        || !script.includes(guardian.maintenanceAuthorizationKind)
        || !script.includes(guardian.recoveryAuthorizationKind)) continue;
      const parsed = parsePlist(plist) as Record<string, unknown>;
      const args = Array.isArray(parsed.ProgramArguments) ? parsed.ProgramArguments : [];
      if (parsed.Label === guardian.label
        && args[0] === guardian.scriptPath
        && parsed.KeepAlive === true
        && parsed.RunAtLoad === true) {
        const service = await inspectLiveGuardianService(guardian.label);
        if (service.loaded && service.running) return true;
      }
    } catch {
      // A different intact predecessor may still preserve availability.
    }
  }
  return false;
}

interface LiveGuardianServiceInspection {
  loaded: boolean;
  output: string;
  pid: number | null;
  running: boolean;
}

async function inspectLiveGuardianService(label: string): Promise<LiveGuardianServiceInspection> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `system/${label}`], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
      encoding: "utf8"
    });
    const pid = Number(stdout.match(/^\s*pid = ([1-9]\d*)\s*$/mu)?.[1] || "");
    return {
      loaded: true,
      output: stdout,
      pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
      running: /^\s*state = running\s*$/mu.test(stdout) && Number.isSafeInteger(pid) && pid > 0
    };
  } catch (error) {
    if (launchctlServiceMissing(error)) return { loaded: false, output: "", pid: null, running: false };
    throw error;
  }
}

function launchctlOutputFieldMatches(output: string, field: string, expected: string): boolean {
  return output.split("\n").filter((line) => line.trim() === `${field} = ${expected}`).length === 1;
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
      assertGuardianCheck(
        claimStat.isFile() && !claimStat.isSymbolicLink(),
        "guardian.bootstrap.claim.file",
        "The bootstrap-worker claim is not a regular unlinked file."
      );
      assertGuardianCheck(
        claimStat.uid === expectedUid,
        "guardian.bootstrap.claim.owner",
        `The bootstrap-worker claim has UID ${claimStat.uid}; expected ${expectedUid}.`
      );
      assertGuardianCheck(
        (claimStat.mode & 0o777) === 0o644,
        "guardian.bootstrap.claim.mode",
        `The bootstrap-worker claim has mode ${(claimStat.mode & 0o777).toString(8)}; expected 644.`
      );
      assertGuardianCheck(
        claim.kind === UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_KIND,
        "guardian.bootstrap.claim.kind",
        "The bootstrap-worker claim has an incompatible schema kind."
      );
      assertGuardianCheck(
        claim.bootstrapToken === request.bootstrapToken,
        "guardian.bootstrap.claim.bootstrap-token",
        "The bootstrap-worker claim belongs to a different administrator authorization."
      );
      assertGuardianCheck(
        claim.lockPath === request.lockPath,
        "guardian.bootstrap.claim.lock-path",
        "The bootstrap-worker claim names a different updater lock."
      );
      assertGuardianCheck(
        claim.lockToken === request.lockToken,
        "guardian.bootstrap.claim.lock-token",
        "The bootstrap-worker claim belongs to a different updater attempt."
      );
      assertGuardianCheck(
        claim.sourceAppPath === request.sourceAppPath,
        "guardian.bootstrap.claim.source-app",
        "The bootstrap-worker claim names a different source app."
      );
      assertGuardianCheck(
        claim.targetAppPath === request.targetAppPath,
        "guardian.bootstrap.claim.target-app",
        "The bootstrap-worker claim names a different target app."
      );
      assertGuardianCheck(
        claim.expectedUpdateCommit === request.expectedUpdateCommit,
        "guardian.bootstrap.claim.target-commit",
        "The bootstrap-worker claim names a different update commit."
      );
      assertGuardianCheck(
        claim.workerPid === request.workerPid,
        "guardian.bootstrap.claim.worker-pid",
        "The bootstrap-worker claim names a different worker process."
      );
      assertGuardianCheck(
        claim.relayPid === request.relayPid,
        "guardian.bootstrap.claim.relay-pid",
        "The bootstrap-worker claim names a different relay process."
      );
      assertGuardianCheck(
        typeof claim.workerStarted === "string" && Boolean(claim.workerStarted),
        "guardian.bootstrap.claim.worker-started",
        "The bootstrap-worker claim has no worker start identity."
      );
      assertGuardianCheck(
        typeof claim.workerCommand === "string" && Boolean(claim.workerCommand),
        "guardian.bootstrap.claim.worker-command",
        "The bootstrap-worker claim has no worker command identity."
      );
      assertGuardianCheck(
        typeof claim.relayStarted === "string" && Boolean(claim.relayStarted),
        "guardian.bootstrap.claim.relay-started",
        "The bootstrap-worker claim has no relay start identity."
      );
      assertGuardianCheck(
        typeof claim.relayCommand === "string" && Boolean(claim.relayCommand),
        "guardian.bootstrap.claim.relay-command",
        "The bootstrap-worker claim has no relay command identity."
      );
      assertGuardianCheck(
        typeof claim.bootstrapAuthorizationSha256 === "string"
          && /^[a-f0-9]{64}$/u.test(claim.bootstrapAuthorizationSha256),
        "guardian.bootstrap.claim.authorization-sha256",
        "The bootstrap-worker claim has no valid root-authorization SHA-256."
      );
      assertGuardianCheck(
        Number.isInteger(claim.expiresAtEpoch),
        "guardian.bootstrap.claim.expiry",
        "The bootstrap-worker claim has no integer expiry."
      );
      assertGuardianCheck(
        Number(claim.expiresAtEpoch) >= nowEpoch,
        "guardian.bootstrap.claim.expired",
        "The bootstrap-worker claim has expired."
      );
      assertGuardianCheck(
        Number(claim.expiresAtEpoch)
          <= Math.floor(claimStat.mtimeMs / 1_000) + UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_MAX_SECONDS,
        "guardian.bootstrap.claim.expiry-bound",
        "The bootstrap-worker claim exceeds its protocol lifetime."
      );
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
        options.expectedAuthorizationUid ?? 0,
        options.allowLegacySparseAuthorization === true
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
  expectedUid: number,
  allowLegacySparseAuthorization: boolean
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil's system guardian did not authorize maintenance.");
  let stableIdentity = "";
  let stableSince = 0;
  do {
    try {
      const observedAt = Date.now();
      const identity = await assertRootGuardianAuthorization(
        authorizationPath,
        request,
        observedAt,
        expectedUid,
        allowLegacySparseAuthorization
      );
      if (identity !== stableIdentity) {
        stableIdentity = identity;
        stableSince = observedAt;
        lastError = new Error("Vigil's system guardian authorization appeared but did not remain stable long enough.");
      } else if (observedAt - stableSince >= SYSTEM_GUARDIAN_AUTHORIZATION_STABILITY_MS) {
        return;
      }
    } catch (error) {
      lastError = error;
      stableIdentity = "";
      stableSince = 0;
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
      expectedAuthorizationUid,
      options.allowLegacySparseAuthorization === true
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
  const manifest = await pendingRecoveryManifestEvidence(lockPath, lockToken, recoveryPolicySha256);
  const requirements = await recoveryAuthorizationRequirements(options);

  const timeoutMs = options.authorizationTimeoutMs ?? SYSTEM_GUARDIAN_AUTHORIZATION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = new Error("Vigil's system guardian did not attest update recovery.");
  do {
    try {
      const now = Date.now();
      await assertGuardianMaintenanceActive(lockPath, lockToken, ownerPid, now, options);
      for (const requirement of requirements) {
        await assertGuardianRecoveryAttestation(
          requirement,
          manifest,
          recoveryPolicySha256,
          expectedAppInitialCdHash,
          expectedAppTargetCdHash,
          expectedUid
        );
      }
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, SYSTEM_GUARDIAN_AUTHORIZATION_POLL_MS));
  } while (Date.now() < deadline);
  throw new Error(`Vigil's system guardian did not attest update recovery: ${errorMessage(lastError)}`);
}

interface PendingRecoveryManifestEvidence {
  app: Record<string, unknown>;
  manifestPath: string;
  pendingSha256: string;
  policyPath: string;
  targetAppPath: string;
  token: string;
}

async function pendingRecoveryManifestEvidence(
  lockPath: string,
  lockToken: string,
  recoveryPolicySha256: string
): Promise<PendingRecoveryManifestEvidence> {
  const manifestPath = join(dirname(lockPath), UPDATE_RECOVERY_MANIFEST_FILENAME);
  const bytes = await readPinnedPrivateRecoveryManifest(manifestPath);
  const payload = JSON.parse(bytes.toString("utf8")) as {
    app?: unknown;
    attemptId?: unknown;
    recovery?: unknown;
    state?: unknown;
  };
  const app = payload.app && typeof payload.app === "object" && !Array.isArray(payload.app)
    ? payload.app as Record<string, unknown>
    : null;
  const recovery = payload.recovery && typeof payload.recovery === "object" && !Array.isArray(payload.recovery)
    ? payload.recovery as Record<string, unknown>
    : null;
  const policyPath = join(dirname(lockPath), UPDATE_RECOVERY_POLICY_FILENAME);
  const targetAppPath = String(app?.targetPath || "");
  if (payload.attemptId !== lockToken
    || payload.state !== "pending"
    || !app
    || app.initialPresent !== true
    || !targetAppPath.startsWith("/")
    || !recovery
    || recovery.policyPath !== policyPath
    || recovery.policySha256 !== recoveryPolicySha256) {
    throw new Error("Vigil's pending recovery manifest does not match this protected update.");
  }
  return {
    app,
    manifestPath,
    pendingSha256: createHash("sha256").update(bytes).digest("hex"),
    policyPath,
    targetAppPath,
    token: lockToken
  };
}

async function recoveryAuthorizationRequirements(
  options: GuardianMaintenanceOptions
): Promise<GuardianRecoveryAuthorizationRequirement[]> {
  if (options.recoveryAuthorizationRequirements) {
    return validatedRecoveryAuthorizationRequirements(options.recoveryAuthorizationRequirements);
  }
  if (options.recoveryAuthorizationPath) {
    return [{
      kind: SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
      label: SYSTEM_GUARDIAN_LABEL,
      path: options.recoveryAuthorizationPath,
      protocol: "pinned-pending"
    }];
  }
  const requirements: GuardianRecoveryAuthorizationRequirement[] = [{
    kind: CURRENT_GUARDIAN_PROTOCOL.recoveryAuthorizationKind,
    label: CURRENT_GUARDIAN_PROTOCOL.label,
    path: CURRENT_GUARDIAN_PROTOCOL.recoveryAuthorizationPath,
    protocol: CURRENT_GUARDIAN_PROTOCOL.recoveryProtocol
  }];
  for (const predecessor of SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS) {
    const service = await inspectLiveGuardianService(predecessor.label);
    if (!service.loaded) continue;
    if (!service.running
      || !launchctlOutputFieldMatches(service.output, "path", predecessor.plistPath)
      || !launchctlOutputFieldMatches(service.output, "program", predecessor.scriptPath)) {
      throw new Error(
        `Vigil refused update activation because predecessor guardian ${predecessor.label} has an unsafe live topology.`
      );
    }
    requirements.push({
      kind: predecessor.recoveryAuthorizationKind,
      label: predecessor.label,
      path: predecessor.recoveryAuthorizationPath,
      protocol: predecessor.recoveryProtocol
    });
  }
  return requirements;
}

function validatedRecoveryAuthorizationRequirements(
  requirements: GuardianRecoveryAuthorizationRequirement[]
): GuardianRecoveryAuthorizationRequirement[] {
  const paths = new Set<string>();
  if (!requirements.length) throw new Error("Vigil requires at least one guardian recovery attestation.");
  for (const requirement of requirements) {
    if (!requirement.path.startsWith("/")
      || !requirement.kind.startsWith("vigil-root-update-recovery-authorization-")
      || !requirement.label
      || paths.has(requirement.path)) {
      throw new Error("Vigil refused an invalid guardian recovery-attestation requirement.");
    }
    paths.add(requirement.path);
  }
  return requirements.map((requirement) => ({ ...requirement }));
}

async function assertGuardianRecoveryAttestation(
  requirement: GuardianRecoveryAuthorizationRequirement,
  manifest: PendingRecoveryManifestEvidence,
  recoveryPolicySha256: string,
  expectedAppInitialCdHash: string,
  expectedAppTargetCdHash: string,
  expectedUid: number
): Promise<void> {
  const checkPrefix = `guardian.recovery.${guardianCheckComponent(requirement.label)}`;
  let authorization: GuardianAuthorizationPayload;
  try {
    ({ authorization } = await readPinnedGuardianAuthorization(requirement.path, expectedUid));
  } catch (error) {
    throw new Error(
      `Vigil guardian check failed: check=${checkPrefix}.authorization-file detail=${errorMessage(error)}`
    );
  }
  const appIdentityFields = [
    ["appInitialDev", "initialDev", "initial-dev"],
    ["appInitialIno", "initialIno", "initial-ino"],
    ["appInitialCommit", "initialCommit", "initial-commit"],
    ["appInitialFingerprint", "initialFingerprint", "initial-fingerprint"],
    ["appTargetDev", "targetDev", "target-dev"],
    ["appTargetIno", "targetIno", "target-ino"],
    ["appTargetCommit", "targetCommit", "target-commit"],
    ["appTargetFingerprint", "targetFingerprint", "target-fingerprint"]
  ] as const;
  assertGuardianCheck(
    authorization.kind === requirement.kind,
    `${checkPrefix}.kind`,
    `${requirement.label} published an incompatible recovery schema kind.`
  );
  assertGuardianCheck(
    authorization.recoveryAttemptId === manifest.token,
    `${checkPrefix}.attempt-id`,
    `${requirement.label} attested a different update attempt.`
  );
  assertGuardianCheck(
    authorization.recoveryPolicySha256 === recoveryPolicySha256,
    `${checkPrefix}.policy-sha256`,
    `${requirement.label} attested different recovery-policy bytes.`
  );
  assertGuardianCheck(
    authorization.recoveryManifestPath === manifest.manifestPath,
    `${checkPrefix}.manifest-path`,
    `${requirement.label} attested a different recovery-manifest path.`
  );
  assertGuardianCheck(
    authorization.recoveryPolicyPath === manifest.policyPath,
    `${checkPrefix}.policy-path`,
    `${requirement.label} attested a different recovery-policy path.`
  );
  assertGuardianCheck(
    authorization.recoveryAppPath === manifest.targetAppPath,
    `${checkPrefix}.app-path`,
    `${requirement.label} attested a different canonical app path.`
  );
  assertGuardianCheck(
    authorization.appInitialPresent === true,
    `${checkPrefix}.initial-present`,
    `${requirement.label} did not attest an installed initial app generation.`
  );
  for (const [authorizationKey, manifestKey, checkName] of appIdentityFields) {
    const expected = String(manifest.app[manifestKey] ?? "");
    assertGuardianCheck(
      Boolean(expected) && String(authorization[authorizationKey] ?? "") === expected,
      `${checkPrefix}.${checkName}`,
      `${requirement.label} attested a different ${checkName.replaceAll("-", " ")} value.`
    );
  }
  if (requirement.protocol === "pinned-pending") {
    assertGuardianCheck(
      authorization.recoveryPendingManifestSha256 === manifest.pendingSha256,
      `${checkPrefix}.pending-manifest-sha256`,
      `${requirement.label} attested different pending-manifest bytes.`
    );
    assertGuardianCheck(
      authorization.appInitialCdHash === expectedAppInitialCdHash,
      `${checkPrefix}.initial-cdhash`,
      `${requirement.label} attested a different initial app CodeDirectory hash.`
    );
    assertGuardianCheck(
      authorization.appTargetCdHash === expectedAppTargetCdHash,
      `${checkPrefix}.target-cdhash`,
      `${requirement.label} attested a different target app CodeDirectory hash.`
    );
  } else {
    assertGuardianCheck(
      typeof authorization.recoveryManifestSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(authorization.recoveryManifestSha256),
      `${checkPrefix}.normalized-manifest-sha256`,
      `${requirement.label} did not publish a valid normalized-manifest SHA-256.`
    );
  }
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
  return createHash("sha256").update(await readPinnedPrivateRecoveryManifest(manifestPath)).digest("hex");
}

async function readPinnedPrivateRecoveryManifest(manifestPath: string): Promise<Buffer> {
  const handle = await open(manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    const uid = process.getuid?.();
    if (!before.isFile()
      || (before.mode & 0o077) !== 0
      || before.size > 256 * 1024
      || (uid !== undefined && before.uid !== uid)) {
      throw new Error("Vigil's update recovery manifest is unsafe for root attestation.");
    }
    const bytes = await handle.readFile();
    const [after, pathname] = await Promise.all([handle.stat(), lstat(manifestPath)]);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || !pathname.isFile()
      || pathname.isSymbolicLink()
      || (pathname.mode & 0o077) !== 0
      || (uid !== undefined && pathname.uid !== uid)
      || after.dev !== pathname.dev
      || after.ino !== pathname.ino
      || after.size !== pathname.size
      || after.mtimeMs !== pathname.mtimeMs
      || bytes.length !== after.size
      || bytes.length > 256 * 1024) {
      throw new Error("Vigil's update recovery manifest changed while it was being attested.");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertRootGuardianAuthorization(
  authorizationPath: string,
  request: GuardianMaintenancePayload,
  now: number,
  expectedUid: number,
  allowLegacySparseAuthorization = false
): Promise<string> {
  let pinned: Awaited<ReturnType<typeof readPinnedGuardianAuthorization>>;
  try {
    pinned = await readPinnedGuardianAuthorization(authorizationPath, expectedUid);
  } catch (error) {
    throw new Error(
      `Vigil guardian check failed: check=guardian.maintenance.authorization.file detail=${errorMessage(error)}`
    );
  }
  const {
    authorization,
    identity,
    stat: authorizationStat
  } = pinned;
  const nowEpoch = Math.floor(now / 1_000);
  if (!authorizationStat.isFile() || authorizationStat.isSymbolicLink() || authorizationStat.uid !== expectedUid) {
    throw new Error("Vigil's system guardian authorization is not root-owned.");
  }
  if ((authorizationStat.mode & 0o022) !== 0) {
    throw new Error("Vigil's system guardian authorization is writable outside root.");
  }
  assertGuardianCheck(
    authorization.kind === "vigil-root-maintenance-authorization-v2",
    "guardian.maintenance.authorization.kind",
    "The root maintenance authorization has an incompatible schema kind."
  );
  assertGuardianCheck(
    authorization.token === request.token,
    "guardian.maintenance.authorization.token",
    "The root maintenance authorization belongs to a different updater attempt."
  );
  assertGuardianCheck(
    authorization.pid === request.pid,
    "guardian.maintenance.authorization.pid",
    "The root maintenance authorization names a different updater process."
  );
  assertGuardianCheck(
    authorization.lockPath === request.lockPath,
    "guardian.maintenance.authorization.lock-path",
    "The root maintenance authorization names a different updater lock."
  );
  assertGuardianCheck(
    typeof authorization.updaterExecutable === "string"
      && authorization.updaterExecutable.startsWith("/"),
    "guardian.maintenance.authorization.executable",
    "The root maintenance authorization has no absolute updater executable."
  );
  assertGuardianCheck(
    typeof authorization.updaterStarted === "string" && Boolean(authorization.updaterStarted),
    "guardian.maintenance.authorization.started",
    "The root maintenance authorization has no updater start identity."
  );
  assertGuardianCheck(
    Number.isInteger(authorization.expiresAtEpoch),
    "guardian.maintenance.authorization.expiry",
    "The root maintenance authorization has no integer expiry."
  );
  assertGuardianCheck(
    Number(authorization.expiresAtEpoch) >= nowEpoch,
    "guardian.maintenance.authorization.expired",
    "The root maintenance authorization has expired."
  );
  assertGuardianCheck(
    Number(authorization.expiresAtEpoch)
      <= Math.floor(authorizationStat.mtimeMs / 1_000) + SYSTEM_GUARDIAN_MAINTENANCE_MAX_SECONDS,
    "guardian.maintenance.authorization.expiry-bound",
    "The root maintenance authorization exceeds its protocol lifetime."
  );
  if (allowLegacySparseAuthorization
    && authorization.authorizationMode === undefined
    && authorization.updaterCommand === undefined
    && authorization.updaterScriptPath === undefined
    && authorization.updaterScriptSha256 === undefined
    && authorization.updaterAppCdHash === undefined
    && authorization.parentPid === undefined
    && authorization.parentExecutable === undefined
    && authorization.parentStarted === undefined
    && authorization.parentCommand === undefined
    && authorization.bootstrapAuthorizationSha256 === undefined) {
    return identity;
  }
  assertGuardianCheck(
    authorization.authorizationMode === "normal" || authorization.authorizationMode === "bootstrap",
    "guardian.maintenance.authorization.mode",
    "The root maintenance authorization has an unsupported authorization mode."
  );
  assertGuardianCheck(
    typeof authorization.updaterCommand === "string" && Boolean(authorization.updaterCommand),
    "guardian.maintenance.authorization.command",
    "The root maintenance authorization has no updater command identity."
  );
  assertGuardianCheck(
    typeof authorization.updaterScriptPath === "string"
      && authorization.updaterScriptPath.startsWith("/"),
    "guardian.maintenance.authorization.script-path",
    "The root maintenance authorization has no absolute updater-script path."
  );
  assertGuardianCheck(
    typeof authorization.updaterScriptSha256 === "string"
      && /^[a-f0-9]{64}$/u.test(authorization.updaterScriptSha256),
    "guardian.maintenance.authorization.script-sha256",
    "The root maintenance authorization has no valid updater-script SHA-256."
  );
  assertGuardianCheck(
    typeof authorization.updaterAppCdHash === "string"
      && /^[a-f0-9]{40,64}$/u.test(authorization.updaterAppCdHash),
    "guardian.maintenance.authorization.app-cdhash",
    "The root maintenance authorization has no valid updater app CodeDirectory hash."
  );
  assertGuardianCheck(
    Number.isInteger(authorization.parentPid) && Number(authorization.parentPid) >= 1,
    "guardian.maintenance.authorization.parent-pid",
    "The root maintenance authorization has no valid parent process."
  );
  assertGuardianCheck(
    typeof authorization.parentExecutable === "string"
      && authorization.parentExecutable.startsWith("/"),
    "guardian.maintenance.authorization.parent-executable",
    "The root maintenance authorization has no absolute parent executable."
  );
  assertGuardianCheck(
    typeof authorization.parentStarted === "string" && Boolean(authorization.parentStarted),
    "guardian.maintenance.authorization.parent-started",
    "The root maintenance authorization has no parent start identity."
  );
  assertGuardianCheck(
    typeof authorization.parentCommand === "string" && Boolean(authorization.parentCommand),
    "guardian.maintenance.authorization.parent-command",
    "The root maintenance authorization has no parent command identity."
  );
  assertGuardianCheck(
    authorization.authorizationMode === "normal"
      ? authorization.bootstrapAuthorizationSha256 === "-"
      : typeof authorization.bootstrapAuthorizationSha256 === "string"
        && /^[a-f0-9]{64}$/u.test(authorization.bootstrapAuthorizationSha256),
    "guardian.maintenance.authorization.bootstrap-sha256",
    authorization.authorizationMode === "normal"
      ? "A normal root maintenance authorization contains unexpected bootstrap evidence."
      : "The bootstrap root maintenance authorization has no valid bootstrap SHA-256."
  );
  return identity;
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

async function readPinnedGuardianAuthorization(path: string, expectedUid: number): Promise<{
  authorization: GuardianAuthorizationPayload;
  identity: string;
  stat: Stats;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.uid !== expectedUid
      || (before.mode & 0o777) !== 0o644
      || before.size > 64 * 1024) {
      throw new Error("Vigil's system guardian authorization is not a safe regular file.");
    }
    const bytes = await handle.readFile();
    const [after, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || !pathname.isFile()
      || pathname.isSymbolicLink()
      || pathname.uid !== expectedUid
      || (pathname.mode & 0o777) !== 0o644
      || after.dev !== pathname.dev
      || after.ino !== pathname.ino
      || after.size !== pathname.size
      || after.mtimeMs !== pathname.mtimeMs
      || bytes.length !== after.size) {
      throw new Error("Vigil's system guardian authorization changed while it was being verified.");
    }
    return {
      authorization: parsePlist(bytes) as GuardianAuthorizationPayload,
      identity: `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}`,
      stat: after
    };
  } finally {
    await handle.close();
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function assertGuardianCheck(
  condition: unknown,
  check: string,
  detail: string
): asserts condition {
  if (!condition) {
    throw new Error(`Vigil guardian check failed: check=${check} detail=${detail}`);
  }
}

function guardianCheckComponent(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "unknown";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown authorization error.");
}
