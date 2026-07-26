import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  lstat,
  mkdtemp,
  open,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { acquireUpdaterLock } from "../app/updater.js";
import {
  CURRENT_GUARDIAN_PROTOCOL,
  SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS
} from "../src/guardianProtocol.js";
import type { GuardianProtocolDescriptor } from "../src/guardianProtocol.js";
import { isDirectRun } from "../src/directRun.js";
import { parsePlist } from "../src/plist.js";
import {
  SYSTEM_GUARDIAN_ROOT,
  systemGuardianPlist,
  systemGuardianScript
} from "../src/systemGuardian.js";
import { defaultUpdaterLockPath } from "../src/updateMaintenance.js";
import {
  predecessorAvailabilityProgramMatches,
  predecessorGuardianContentMatches,
  predecessorGuardianProgramFingerprint
} from "./install-system-guardian.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_APP_PATH = "/Applications/Vigil.app";
const SUPERVISOR_LABEL = "tech.caseline.vigil.supervisor";
const RETIREMENT_KIND = "vigil-guardian-retirement-v1";
const RETIREMENT_RECEIPT_PATH = join(
  SYSTEM_GUARDIAN_ROOT,
  `retirement-${CURRENT_GUARDIAN_PROTOCOL.key}.json`
);
export const GUARDIAN_RETIREMENT_STABILITY_MS = 1_000;
export const GUARDIAN_RETIREMENT_MINIMUM_AGE_MS = 60_000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;

interface ServiceSnapshot {
  label: string;
  loaded: boolean;
  output: string;
  pid: number | null;
  running: boolean;
}

export interface GuardianRetirementEligibility {
  currentFirst: Pick<ServiceSnapshot, "loaded" | "pid" | "running">;
  currentSecond: Pick<ServiceSnapshot, "loaded" | "pid" | "running">;
  currentStartedAt: number | null;
  lockValid: boolean;
  now: number;
  predecessors: ReadonlyArray<Pick<ServiceSnapshot, "label" | "loaded">>;
  supervisorFirst: Pick<ServiceSnapshot, "loaded" | "pid" | "running">;
  supervisorSecond: Pick<ServiceSnapshot, "loaded" | "pid" | "running">;
}

interface RetirementTargetPlan {
  key: GuardianProtocolDescriptor["key"];
  label: string;
  plist: PinnedFile | null;
  plistPath: string;
  script: PinnedFile | null;
  scriptPath: string;
}

interface RetiredTarget {
  disabled: boolean;
  key: GuardianProtocolDescriptor["key"];
  label: string;
  removed: string[];
}

interface RetirementReceipt {
  completedAt?: string;
  currentGuardian: {
    key: GuardianProtocolDescriptor["key"];
    label: string;
    pid: number;
  };
  error?: string;
  kind: typeof RETIREMENT_KIND;
  phase: "prepared" | "retiring" | "complete" | "failed";
  preparedAt: string;
  retired: RetiredTarget[];
  supervisor: {
    label: string;
    pid: number;
  };
  targets: Array<{
    key: GuardianProtocolDescriptor["key"];
    label: string;
    plistPresent: boolean;
    scriptPresent: boolean;
  }>;
  transactionId: string;
  version: 1;
}

interface RootWorkerOptions {
  appPath: string;
  lockOwnerPid: number;
  lockPath: string;
  lockToken: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
}

interface PinnedFile {
  bytes: Buffer;
  identity: FileIdentity;
  path: string;
}

interface FileIdentity {
  birthtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  sha256: string;
  size: number;
  uid: number;
}

interface LockPayload {
  ownerStartedAt?: string;
  pid?: number;
  token?: string;
}

export function guardianRetirementBlockers(
  evidence: GuardianRetirementEligibility
): string[] {
  const blockers: string[] = [];
  if (!evidence.lockValid) blockers.push("The normal Vigil updater lock is not held by this retirement transaction.");
  if (!stableRunningPair(evidence.currentFirst, evidence.currentSecond)) {
    blockers.push("The current system guardian did not remain running with one stable process.");
  }
  if (!stableRunningPair(evidence.supervisorFirst, evidence.supervisorSecond)) {
    blockers.push("The embedded supervisor did not remain running with one stable process.");
  }
  if (evidence.currentStartedAt === null
    || evidence.now - evidence.currentStartedAt < GUARDIAN_RETIREMENT_MINIMUM_AGE_MS) {
    blockers.push("The current system guardian has not completed the minimum healthy generation age.");
  }
  const loaded = evidence.predecessors.filter(({ loaded }) => loaded).map(({ label }) => label);
  if (loaded.length) {
    blockers.push(`Loaded predecessor guardians are never terminated by retirement: ${loaded.join(", ")}.`);
  }
  return blockers;
}

export function predecessorRetirementPlistMatches(
  plistText: string,
  protocol: GuardianProtocolDescriptor
): boolean {
  let plist: Record<string, unknown>;
  try {
    plist = parsePlist(plistText) as Record<string, unknown>;
  } catch {
    return false;
  }
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const expectedKeys = [
    "KeepAlive",
    "Label",
    "ProcessType",
    "ProgramArguments",
    "RunAtLoad",
    "StandardErrorPath",
    "StandardOutPath",
    "ThrottleInterval"
  ];
  const logPath = join(SYSTEM_GUARDIAN_ROOT, "guardian.log");
  return protocol.current === false
    && JSON.stringify(Object.keys(plist).sort()) === JSON.stringify(expectedKeys)
    && plist.KeepAlive === true
    && plist.Label === protocol.label
    && plist.ProcessType === "Background"
    && plist.RunAtLoad === true
    && plist.StandardErrorPath === logPath
    && plist.StandardOutPath === logPath
    && plist.ThrottleInterval === 5
    && args.length === 2
    && args[0] === protocol.scriptPath
    && args[1] === "--vigil-safety-boundary-do-not-terminate-or-bootout";
}

function stableRunningPair(
  first: Pick<ServiceSnapshot, "loaded" | "pid" | "running">,
  second: Pick<ServiceSnapshot, "loaded" | "pid" | "running">
): boolean {
  return first.loaded
    && first.running
    && first.pid !== null
    && second.loaded
    && second.running
    && second.pid === first.pid;
}

async function coordinateRetirement(argv: string[]): Promise<void> {
  const values = argumentValues(argv);
  const account = userInfo();
  const uid = process.getuid?.();
  if (!Number.isInteger(uid) || Number(uid) < 501 || account.username === "root") {
    throw new Error("Run guardian retirement from the signed-in macOS account, not as root.");
  }
  const targetUid = Number(uid);
  const targetHome = account.homedir;
  const targetUser = account.username;
  const appPath = values.get("app") || DEFAULT_APP_PATH;
  if (!appPath.startsWith("/") || !appPath.endsWith(".app")) {
    throw new Error("Pass Vigil's absolute application path with --app.");
  }
  const stageRoot = await mkdtemp("/private/var/tmp/tech.caseline.vigil.guardian-retirement.");
  const stagedRuntime = join(stageRoot, "runtime");
  const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  try {
    await cp(runtimeRoot, stagedRuntime, { recursive: true, errorOnExist: true });
    const lock = await acquireUpdaterLock(defaultUpdaterLockPath(targetHome));
    try {
      const { stdout } = await execFileAsync("/usr/bin/osascript", [
        "-e",
        retirementAdministratorAppleScript(),
        process.execPath,
        join(stagedRuntime, "scripts", "retire-legacy-guardians.mjs"),
        appPath,
        String(targetUid),
        targetUser,
        targetHome,
        lock.path,
        lock.token,
        String(process.pid)
      ], {
        timeout: 120_000,
        maxBuffer: MAX_FILE_BYTES
      });
      if (String(stdout || "").trim()) process.stdout.write(`${String(stdout).trim()}\n`);
    } finally {
      await lock.release();
    }
  } finally {
    if (!stageRoot.startsWith("/private/var/tmp/tech.caseline.vigil.guardian-retirement.")) {
      throw new Error("Vigil refused to clean an unexpected guardian-retirement staging path.");
    }
    await rm(stageRoot, { recursive: true, force: true });
  }
}

export function retirementAdministratorAppleScript(): string {
  return `on run argv
  set nodePath to item 1 of argv
  set workerPath to item 2 of argv
  set appPath to item 3 of argv
  set targetUid to item 4 of argv
  set targetUser to item 5 of argv
  set targetHome to item 6 of argv
  set lockPath to item 7 of argv
  set lockToken to item 8 of argv
  set lockOwnerPid to item 9 of argv
  set commandText to "/usr/bin/env PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin " & quoted form of nodePath
  set commandText to commandText & " " & quoted form of workerPath
  set commandText to commandText & " --root-worker true --app " & quoted form of appPath
  set commandText to commandText & " --uid " & quoted form of targetUid
  set commandText to commandText & " --user " & quoted form of targetUser
  set commandText to commandText & " --home " & quoted form of targetHome
  set commandText to commandText & " --lock-path " & quoted form of lockPath
  set commandText to commandText & " --lock-token " & quoted form of lockToken
  set commandText to commandText & " --lock-owner-pid " & quoted form of lockOwnerPid
  do shell script commandText with administrator privileges with prompt "Vigil will retire only inactive legacy guardian definitions. Vigil and its current protections stay online."
end run`;
}

async function runRootWorker(argv: string[]): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("The retirement worker requires administrator privileges.");
  }
  const options = parseRootWorkerOptions(argv);
  await validateAccount(options);
  await assertSafeGuardianRoot();
  await assertOwnedUserUpdaterLock(options);

  const currentFirst = await inspectService("system", CURRENT_GUARDIAN_PROTOCOL.label);
  const supervisorFirst = await inspectService(`gui/${options.targetUid}`, SUPERVISOR_LABEL);
  const currentStartedAt = currentFirst.pid ? await processStartedAt(currentFirst.pid) : null;
  await assertCurrentGuardianFiles(options, currentFirst);
  const predecessorFirst = await inspectPredecessors();
  await sleep(GUARDIAN_RETIREMENT_STABILITY_MS);
  await assertOwnedUserUpdaterLock(options);
  const currentSecond = await inspectService("system", CURRENT_GUARDIAN_PROTOCOL.label);
  const supervisorSecond = await inspectService(`gui/${options.targetUid}`, SUPERVISOR_LABEL);
  const predecessorSecond = await inspectPredecessors();
  const blockers = guardianRetirementBlockers({
    currentFirst,
    currentSecond,
    currentStartedAt,
    lockValid: true,
    now: Date.now(),
    predecessors: [...predecessorFirst, ...predecessorSecond],
    supervisorFirst,
    supervisorSecond
  });
  if (blockers.length) throw new Error(blockers.join(" "));
  await assertCurrentGuardianFiles(options, currentSecond);

  const plans = await Promise.all(SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS.map(
    (protocol) => planRetirementTarget(protocol, options)
  ));
  const transactionId = randomUUID();
  const receipt: RetirementReceipt = {
    currentGuardian: {
      key: CURRENT_GUARDIAN_PROTOCOL.key,
      label: CURRENT_GUARDIAN_PROTOCOL.label,
      pid: currentSecond.pid!
    },
    kind: RETIREMENT_KIND,
    phase: "prepared",
    preparedAt: new Date().toISOString(),
    retired: [],
    supervisor: {
      label: SUPERVISOR_LABEL,
      pid: supervisorSecond.pid!
    },
    targets: plans.map((plan) => ({
      key: plan.key,
      label: plan.label,
      plistPresent: Boolean(plan.plist),
      scriptPresent: Boolean(plan.script)
    })),
    transactionId,
    version: 1
  };
  let receiptStarted = false;
  try {
    await writeRetirementReceipt(receipt);
    receiptStarted = true;
    for (const plan of plans) {
      await assertOwnedUserUpdaterLock(options);
      await assertProtectionContinuity(currentSecond.pid!, supervisorSecond.pid!, options.targetUid);
      const predecessor = await inspectService("system", plan.label);
      if (predecessor.loaded) {
        throw new Error(`Vigil refused to terminate loaded predecessor ${plan.label}; its files were left intact.`);
      }
      await assertPlannedFilesUnchanged(plan);
      const retired: RetiredTarget = {
        disabled: false,
        key: plan.key,
        label: plan.label,
        removed: []
      };
      receipt.phase = "retiring";
      receipt.retired.push(retired);
      await writeRetirementReceipt(receipt);
      await runLaunchctl(["disable", `system/${plan.label}`]);
      await assertLabelDisabled(plan.label);
      retired.disabled = true;
      await writeRetirementReceipt(receipt);
      if (plan.plist) {
        await rm(plan.plistPath);
        retired.removed.push(plan.plistPath);
        await writeRetirementReceipt(receipt);
      }
      if (plan.script) {
        await rm(plan.scriptPath);
        retired.removed.push(plan.scriptPath);
        await writeRetirementReceipt(receipt);
      }
    }
    await assertOwnedUserUpdaterLock(options);
    await assertProtectionContinuity(currentSecond.pid!, supervisorSecond.pid!, options.targetUid);
    receipt.phase = "complete";
    receipt.completedAt = new Date().toISOString();
    await writeRetirementReceipt(receipt);
  } catch (error) {
    if (receiptStarted) {
      receipt.phase = "failed";
      receipt.error = errorMessage(error);
      await writeRetirementReceipt(receipt).catch(() => undefined);
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

async function planRetirementTarget(
  protocol: GuardianProtocolDescriptor,
  options: RootWorkerOptions
): Promise<RetirementTargetPlan> {
  const service = await inspectService("system", protocol.label);
  if (service.loaded) {
    throw new Error(`Vigil refused to terminate loaded predecessor ${protocol.label}; its files were left intact.`);
  }
  const [plist, script] = await Promise.all([
    readOptionalPinnedRootFile(protocol.plistPath, 0o644),
    readOptionalPinnedRootFile(protocol.scriptPath, 0o755)
  ]);
  if (plist && !predecessorRetirementPlistMatches(plist.bytes.toString("utf8"), protocol)) {
    throw new Error(`Vigil refused an unrecognized predecessor definition at ${protocol.plistPath}.`);
  }
  if (script) {
    const scriptText = script.bytes.toString("utf8");
    const scriptMatches = plist
      ? predecessorGuardianContentMatches(
          scriptText,
          plist.bytes.toString("utf8"),
          protocol,
          options
        )
      : protocol.programSha256 !== null
        && predecessorGuardianProgramFingerprint(scriptText, protocol) === protocol.programSha256
        && predecessorAvailabilityProgramMatches(scriptText);
    if (!scriptMatches) {
      throw new Error(`Vigil refused unrecognized predecessor code at ${protocol.scriptPath}.`);
    }
  }
  return {
    key: protocol.key,
    label: protocol.label,
    plist,
    plistPath: protocol.plistPath,
    script,
    scriptPath: protocol.scriptPath
  };
}

async function assertPlannedFilesUnchanged(plan: RetirementTargetPlan): Promise<void> {
  for (const file of [plan.plist, plan.script]) {
    if (!file) continue;
    const observed = await readPinnedRootFile(file.path, file.identity.mode);
    if (!sameFileIdentity(file.identity, observed.identity)) {
      throw new Error(`Vigil refused a changed predecessor file at ${file.path}.`);
    }
  }
}

async function assertCurrentGuardianFiles(
  options: RootWorkerOptions,
  service: ServiceSnapshot
): Promise<void> {
  assertServiceTopology(service, CURRENT_GUARDIAN_PROTOCOL.plistPath, CURRENT_GUARDIAN_PROTOCOL.scriptPath);
  const [plist, script] = await Promise.all([
    readPinnedRootFile(CURRENT_GUARDIAN_PROTOCOL.plistPath, 0o644),
    readPinnedRootFile(CURRENT_GUARDIAN_PROTOCOL.scriptPath, 0o755)
  ]);
  if (plist.bytes.toString("utf8") !== systemGuardianPlist()
    || script.bytes.toString("utf8") !== systemGuardianScript({
      appPath: options.appPath,
      targetHome: options.targetHome,
      targetUid: options.targetUid,
      targetUser: options.targetUser
    })) {
    throw new Error("Vigil refused retirement because the running current guardian does not match this exact generation.");
  }
}

function assertServiceTopology(service: ServiceSnapshot, plistPath: string, scriptPath: string): void {
  if (!service.loaded
    || !service.running
    || !service.pid
    || !launchctlFieldMatches(service.output, "path", plistPath)
    || !launchctlFieldMatches(service.output, "program", scriptPath)
    || !launchctlFieldMatches(service.output, "type", "LaunchDaemon")) {
    throw new Error(`Vigil refused retirement because ${service.label} lacks its exact running topology.`);
  }
}

async function assertProtectionContinuity(
  guardianPid: number,
  supervisorPid: number,
  targetUid: number
): Promise<void> {
  const [guardian, supervisor] = await Promise.all([
    inspectService("system", CURRENT_GUARDIAN_PROTOCOL.label),
    inspectService(`gui/${targetUid}`, SUPERVISOR_LABEL)
  ]);
  if (!guardian.loaded || !guardian.running || guardian.pid !== guardianPid) {
    throw new Error("The current guardian changed during predecessor retirement.");
  }
  if (!supervisor.loaded || !supervisor.running || supervisor.pid !== supervisorPid) {
    throw new Error("The embedded supervisor changed during predecessor retirement.");
  }
}

async function inspectPredecessors(): Promise<ServiceSnapshot[]> {
  return Promise.all(SUPPORTED_PREDECESSOR_GUARDIAN_PROTOCOLS.map(
    ({ label }) => inspectService("system", label)
  ));
}

async function inspectService(domain: string, label: string): Promise<ServiceSnapshot> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `${domain}/${label}`], {
      timeout: 5_000,
      maxBuffer: MAX_FILE_BYTES
    });
    const output = String(stdout || "");
    const pid = Number(output.match(/^\s*pid = ([0-9]+)\s*$/mu)?.[1] || 0);
    return {
      label,
      loaded: true,
      output,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      running: /^\s*state = running\s*$/mu.test(output)
    };
  } catch (error) {
    if (launchctlServiceMissing(error)) {
      return { label, loaded: false, output: "", pid: null, running: false };
    }
    throw error;
  }
}

async function assertLabelDisabled(label: string): Promise<void> {
  const { stdout } = await execFileAsync("/bin/launchctl", ["print-disabled", "system"], {
    timeout: 5_000,
    maxBuffer: MAX_FILE_BYTES
  });
  if (!launchctlDisabledStateMatches(String(stdout || ""), label)) {
    throw new Error(`launchd did not preserve the retired state for ${label}.`);
  }
}

export function launchctlDisabledStateMatches(output: string, label: string): boolean {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (new RegExp(`"${escaped}"\\s*=>\\s*(?:true|disabled)`, "u")).test(output);
}

async function runLaunchctl(args: string[]): Promise<void> {
  await execFileAsync("/bin/launchctl", args, { timeout: 5_000, maxBuffer: MAX_FILE_BYTES });
}

async function validateAccount(options: RootWorkerOptions): Promise<void> {
  const [{ stdout: uidOutput }, { stdout: homeOutput }] = await Promise.all([
    execFileAsync("/usr/bin/id", ["-u", options.targetUser], { timeout: 5_000 }),
    execFileAsync("/usr/bin/dscl", [".", "-read", `/Users/${options.targetUser}`, "NFSHomeDirectory"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })
  ]);
  const accountUid = Number(String(uidOutput).trim());
  const accountHome = String(homeOutput).match(/^NFSHomeDirectory:\s*(.+)$/mu)?.[1]?.trim() || "";
  if (accountUid !== options.targetUid || accountHome !== options.targetHome) {
    throw new Error("Vigil refused guardian retirement because the approved account tuple changed.");
  }
}

async function assertOwnedUserUpdaterLock(options: RootWorkerOptions): Promise<void> {
  const lock = await readPinnedFile(options.lockPath, MAX_LOCK_BYTES, options.targetUid, 0o600);
  let payload: LockPayload;
  try {
    payload = JSON.parse(lock.bytes.toString("utf8")) as LockPayload;
  } catch {
    throw new Error("Vigil refused guardian retirement because the updater lock is malformed.");
  }
  if (payload.token !== options.lockToken || payload.pid !== options.lockOwnerPid || !payload.ownerStartedAt) {
    throw new Error("Vigil refused guardian retirement because updater-lock ownership changed.");
  }
  const [startedAt, ownerUid] = await Promise.all([
    processStartedAt(options.lockOwnerPid),
    processUid(options.lockOwnerPid)
  ]);
  if (startedAt === null
    || ownerUid !== options.targetUid
    || Math.abs(startedAt - Date.parse(payload.ownerStartedAt)) >= 2_000) {
    throw new Error("Vigil refused guardian retirement because the updater-lock owner identity is stale.");
  }
}

async function assertSafeGuardianRoot(): Promise<void> {
  const value = await lstat(SYSTEM_GUARDIAN_ROOT);
  if (!value.isDirectory()
    || value.isSymbolicLink()
    || value.uid !== 0
    || (value.mode & 0o022) !== 0) {
    throw new Error("Vigil refused an unsafe system guardian directory.");
  }
}

async function readOptionalPinnedRootFile(path: string, mode: number): Promise<PinnedFile | null> {
  try {
    return await readPinnedRootFile(path, mode);
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function readPinnedRootFile(path: string, mode: number): Promise<PinnedFile> {
  return readPinnedFile(path, MAX_FILE_BYTES, 0, mode);
}

async function readPinnedFile(
  path: string,
  maximumBytes: number,
  expectedUid: number,
  expectedMode: number
): Promise<PinnedFile> {
  const before = await lstat(path);
  assertSafeFile(before, path, maximumBytes, expectedUid, expectedMode);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertSafeFile(opened, path, maximumBytes, expectedUid, expectedMode);
    if (!sameStat(before, opened)) throw new Error(`Vigil refused a changing file at ${path}.`);
    const bytes = await handle.readFile();
    if (bytes.length > maximumBytes) throw new Error(`Vigil refused an oversized file at ${path}.`);
    const after = await handle.stat();
    assertSafeFile(after, path, maximumBytes, expectedUid, expectedMode);
    if (!sameStat(opened, after)) throw new Error(`Vigil refused a changing file at ${path}.`);
    return {
      bytes,
      identity: fileIdentity(after, bytes),
      path
    };
  } finally {
    await handle.close();
  }
}

function assertSafeFile(
  value: Stats,
  path: string,
  maximumBytes: number,
  expectedUid: number,
  expectedMode: number
): void {
  if (!value.isFile()
    || value.isSymbolicLink()
    || value.uid !== expectedUid
    || (value.mode & 0o777) !== expectedMode
    || value.size > maximumBytes) {
    throw new Error(`Vigil refused an unsafe file at ${path}.`);
  }
}

function sameStat(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs;
}

function fileIdentity(value: Stats, bytes: Buffer): FileIdentity {
  return {
    birthtimeMs: value.birthtimeMs,
    ctimeMs: value.ctimeMs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode & 0o777,
    mtimeMs: value.mtimeMs,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: value.size,
    uid: value.uid
  };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256
    && left.size === right.size
    && left.uid === right.uid;
}

async function writeRetirementReceipt(receipt: RetirementReceipt): Promise<void> {
  const temporaryPath = `${RETIREMENT_RECEIPT_PATH}.${receipt.transactionId}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  try {
    await rename(temporaryPath, RETIREMENT_RECEIPT_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  const value = await lstat(RETIREMENT_RECEIPT_PATH);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== 0 || (value.mode & 0o777) !== 0o600) {
    throw new Error("Vigil could not verify its guardian-retirement receipt.");
  }
}

async function processStartedAt(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    });
    const value = Date.parse(String(stdout).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function processUid(pid: number): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "uid="], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    });
    const value = Number(String(stdout).trim());
    return Number.isInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function parseRootWorkerOptions(argv: string[]): RootWorkerOptions {
  const values = argumentValues(argv);
  const targetUid = Number(values.get("uid"));
  const targetUser = values.get("user") || "";
  const targetHome = values.get("home") || "";
  const appPath = values.get("app") || "";
  const lockPath = values.get("lock-path") || "";
  const lockToken = values.get("lock-token") || "";
  const lockOwnerPid = Number(values.get("lock-owner-pid"));
  if (!Number.isInteger(targetUid) || targetUid < 501) throw new Error("Pass the signed-in user's numeric id.");
  if (!/^[A-Za-z0-9._-]+$/u.test(targetUser) || targetUser === "root") throw new Error("Pass the signed-in account name.");
  if (!targetHome.startsWith("/Users/") || targetHome.includes("..")) throw new Error("Pass the signed-in account home.");
  if (!appPath.startsWith("/") || !appPath.endsWith(".app")) throw new Error("Pass Vigil's absolute application path.");
  if (lockPath !== defaultUpdaterLockPath(targetHome)) throw new Error("Pass Vigil's canonical updater lock.");
  if (!/^[a-f0-9-]{36}$/iu.test(lockToken)) throw new Error("Pass the retirement updater-lock token.");
  if (!Number.isInteger(lockOwnerPid) || lockOwnerPid < 1) throw new Error("Pass the updater-lock owner process.");
  return {
    appPath,
    lockOwnerPid,
    lockPath,
    lockToken,
    targetHome,
    targetUid,
    targetUser
  };
}

function argumentValues(argv: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] || "";
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
    else values.set(argument.slice(2), argv[index + 1] || "");
  }
  return values;
}

function launchctlFieldMatches(output: string, field: string, expected: string): boolean {
  return output.split("\n").filter((line) => line.trim() === `${field} = ${expected}`).length === 1;
}

function launchctlServiceMissing(error: unknown): boolean {
  return /could not find service|service not found|no such process/iu.test(errorMessage(error));
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Unknown guardian retirement error.");
  const record = error as { message?: unknown; stderr?: unknown };
  return `${String(record.stderr || "")}\n${String(record.message || "")}`.trim()
    || "Unknown guardian retirement error.";
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function main(): Promise<void> {
  const values = argumentValues(process.argv.slice(2));
  if (values.get("root-worker") === "true") await runRootWorker(process.argv.slice(2));
  else await coordinateRetirement(process.argv.slice(2));
}

if (isDirectRun(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(errorMessage(error));
    process.exitCode = 1;
  }
}
