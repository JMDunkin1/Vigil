import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import {
  SYSTEM_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_SCRIPT_PATH,
  guardianMaintenanceReadiness
} from "./updateMaintenance.js";
import type { GuardianMaintenanceReadiness } from "./updateMaintenance.js";

const execFileAsync = promisify(execFile);
const APP_IDENTIFIER = "tech.caseline.vigil";
const DEFAULT_TARGET_APP_PATH = "/Applications/Vigil.app";
const DEFAULT_ELECTRON_RELATIVE_PATH = join("Contents", "MacOS", "Vigil");
const DEFAULT_INSTALLER_RELATIVE_PATH = join(
  "Contents",
  "Resources",
  "app.asar.unpacked",
  "dist",
  "runtime",
  "scripts",
  "install-system-guardian.mjs"
);
const SUPERVISOR_LABEL = "tech.caseline.vigil.supervisor";
const ADMIN_TIMEOUT_MS = 2 * 60_000;

export interface GuardianSetupRequest {
  /** Signed Vigil bundle supplying the privileged installer module. */
  sourceAppPath: string;
  /** Canonical installed Vigil bundle protected by the guardian. */
  targetAppPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  electronPath?: string;
  installerPath?: string;
  /**
   * Require the currently loaded predecessor guardians to accept an immediate
   * update from this exact parent command. Guardian-only migrations leave this
   * false so the new compatible guardian can be installed first.
   */
  requireNormalUpdateCompatibility?: boolean;
  protocolBootstrap?: {
    token: string;
    expectedUpdateCommit: string;
  };
}

export interface GuardianSetupResult {
  ok: boolean;
  canceled: boolean;
  message: string;
  readiness: GuardianMaintenanceReadiness;
}

export interface GuardianSetupAdminRequest {
  sourceAppPath: string;
  targetAppPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  expectedCurrentGuardianSha256: string;
  expectedSourceCdHash: string;
  expectedTargetCdHash: string;
  protocolBootstrapToken: string | null;
  protocolBootstrapExpectedUpdateCommit: string | null;
  authorizationOnly: boolean;
  requireNormalUpdateCompatibility: boolean;
}

export interface SignedSetupBundleIdentity {
  sourceCdHash: string;
  targetCdHash: string;
}

export interface GuardianUpdateCompatibilityRequest {
  appPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  electronPath?: string;
  installerPath?: string;
}

export interface GuardianSetupOperations {
  readiness(): Promise<GuardianMaintenanceReadiness>;
  canonicalPath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
  read(path: string): Promise<Buffer>;
  verifyMatchingSignedApps(sourceAppPath: string, targetAppPath: string): Promise<SignedSetupBundleIdentity>;
  assertProtectedAvailability(targetAppPath: string, targetUid: number): Promise<void>;
  preflight(request: GuardianSetupAdminRequest): Promise<void>;
  runAdministrator(request: GuardianSetupAdminRequest): Promise<void>;
}

/**
 * Upgrade a safe legacy guardian through one native administrator prompt.
 * This operation never asks Vigil to quit and never stops its user supervisor.
 */
export async function setupSystemGuardian(
  request: GuardianSetupRequest,
  operations: GuardianSetupOperations = defaultGuardianSetupOperations
): Promise<GuardianSetupResult> {
  validateRequest(request);
  const initialReadiness = await operations.readiness();
  if (initialReadiness.ready && !request.protocolBootstrap) {
    return {
      ok: true,
      canceled: false,
      message: "Vigil's protected update setup is already ready.",
      readiness: initialReadiness
    };
  }
  if (!initialReadiness.ready && !initialReadiness.setupSupported) {
    throw new Error(initialReadiness.message || "Vigil's guardian cannot be refreshed automatically.");
  }

  const sourceAppPath = await canonicalDirectory(request.sourceAppPath, "setup source app", operations);
  const targetAppPath = await canonicalDirectory(request.targetAppPath, "installed Vigil app", operations);
  if (targetAppPath !== DEFAULT_TARGET_APP_PATH) {
    throw new Error(`Vigil refused to refresh a guardian for an unexpected app path at ${targetAppPath}.`);
  }
  const electronPath = await canonicalRegularFile(
    request.electronPath || join(sourceAppPath, "Contents", "MacOS", "Vigil"),
    "setup executable",
    operations
  );
  const installerPath = await canonicalRegularFile(
    request.installerPath || join(
      sourceAppPath,
      "Contents",
      "Resources",
      "app.asar.unpacked",
      "dist",
      "runtime",
      "scripts",
      "install-system-guardian.mjs"
    ),
    "guardian installer",
    operations
  );
  assertDescendant(sourceAppPath, electronPath, "setup executable");
  assertDescendant(sourceAppPath, installerPath, "guardian installer");
  if (relative(sourceAppPath, electronPath) !== DEFAULT_ELECTRON_RELATIVE_PATH
    || relative(sourceAppPath, installerPath) !== DEFAULT_INSTALLER_RELATIVE_PATH) {
    throw new Error("Vigil refused to run guardian setup from unexpected signed-app executables.");
  }

  let expectedCurrentGuardianSha256 = "absent";
  try {
    const guardianStat = await operations.stat(SYSTEM_GUARDIAN_SCRIPT_PATH);
    if (!guardianStat.isFile()
      || guardianStat.isSymbolicLink()
      || guardianStat.uid !== 0
      || (guardianStat.mode & 0o022) !== 0) {
      throw new Error("Vigil refused to refresh an unsafe installed system guardian.");
    }
    expectedCurrentGuardianSha256 = createHash("sha256")
      .update(await operations.read(SYSTEM_GUARDIAN_SCRIPT_PATH))
      .digest("hex");
  } catch (error) {
    if (!isErrorCode(error, "ENOENT") || initialReadiness.ready) throw error;
  }

  const signedBundles = await operations.verifyMatchingSignedApps(sourceAppPath, targetAppPath);
  await operations.assertProtectedAvailability(targetAppPath, request.targetUid);
  const adminRequest: GuardianSetupAdminRequest = {
    sourceAppPath,
    targetAppPath,
    targetHome: request.targetHome,
    targetUid: request.targetUid,
    targetUser: request.targetUser,
    expectedCurrentGuardianSha256,
    expectedSourceCdHash: signedBundles.sourceCdHash,
    expectedTargetCdHash: signedBundles.targetCdHash,
    protocolBootstrapToken: request.protocolBootstrap?.token || null,
    protocolBootstrapExpectedUpdateCommit: request.protocolBootstrap?.expectedUpdateCommit || null,
    authorizationOnly: initialReadiness.ready,
    requireNormalUpdateCompatibility: request.requireNormalUpdateCompatibility === true
  };
  await operations.preflight(adminRequest);
  try {
    await operations.runAdministrator(adminRequest);
  } catch (error) {
    if (administratorPromptCanceled(error)) {
      return {
        ok: false,
        canceled: true,
        message: "Guardian setup was canceled. Vigil stayed online.",
        readiness: initialReadiness
      };
    }
    throw error;
  }

  await operations.assertProtectedAvailability(targetAppPath, request.targetUid);
  const readiness = await operations.readiness();
  if (!readiness.ready) {
    throw new Error(readiness.message || "Vigil could not verify its refreshed system guardian.");
  }
  return {
    ok: true,
    canceled: false,
    message: "Fast protected updates are ready.",
    readiness
  };
}

const defaultGuardianSetupOperations: GuardianSetupOperations = {
  readiness: () => guardianMaintenanceReadiness(),
  canonicalPath: (path) => realpath(path),
  stat: (path) => lstat(path),
  read: (path) => readFile(path),
  verifyMatchingSignedApps,
  assertProtectedAvailability,
  preflight: runGuardianInstallerPreflight,
  runAdministrator: runGuardianInstallerWithAdministratorPrivileges
};

/**
 * Prove that every still-loaded historical guardian can attest a normal update
 * from this exact running Vigil command. This is read-only and never enters an
 * administrator transaction.
 */
export async function preflightGuardianUpdateCompatibility(
  request: GuardianUpdateCompatibilityRequest
): Promise<void> {
  validateRequest({
    sourceAppPath: request.appPath,
    targetAppPath: request.appPath,
    targetHome: request.targetHome,
    targetUid: request.targetUid,
    targetUser: request.targetUser
  });
  const appPath = await canonicalDirectory(request.appPath, "installed Vigil app", defaultGuardianSetupOperations);
  if (appPath !== DEFAULT_TARGET_APP_PATH) {
    throw new Error(`Vigil refused to inspect guardian compatibility for an unexpected app path at ${appPath}.`);
  }
  const electronPath = await canonicalRegularFile(
    request.electronPath || join(appPath, DEFAULT_ELECTRON_RELATIVE_PATH),
    "compatibility preflight executable",
    defaultGuardianSetupOperations
  );
  const installerPath = await canonicalRegularFile(
    request.installerPath || join(appPath, DEFAULT_INSTALLER_RELATIVE_PATH),
    "compatibility preflight module",
    defaultGuardianSetupOperations
  );
  assertDescendant(appPath, electronPath, "compatibility preflight executable");
  assertDescendant(appPath, installerPath, "compatibility preflight module");
  if (relative(appPath, electronPath) !== DEFAULT_ELECTRON_RELATIVE_PATH
    || relative(appPath, installerPath) !== DEFAULT_INSTALLER_RELATIVE_PATH) {
    throw new Error("Vigil refused to run update compatibility checks from unexpected app files.");
  }
  await defaultGuardianSetupOperations.verifyMatchingSignedApps(appPath, appPath);
  await defaultGuardianSetupOperations.assertProtectedAvailability(appPath, request.targetUid);
  await execFileAsync(electronPath, [
    installerPath,
    "--app", appPath,
    "--home", request.targetHome,
    "--uid", String(request.targetUid),
    "--user", request.targetUser,
    "--require-normal-update-compatibility", "true",
    "--read-only-update-compatibility",
    "--json"
  ], {
    timeout: ADMIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    }
  });
}

function validateRequest(request: GuardianSetupRequest): void {
  if (process.platform !== "darwin") throw new Error("Vigil's guardian setup is available only on macOS.");
  if (!Number.isInteger(request.targetUid) || request.targetUid < 501) {
    throw new Error("Vigil guardian setup requires the signed-in user's numeric account id.");
  }
  if (!/^[A-Za-z0-9._-]+$/u.test(request.targetUser) || request.targetUser === "root") {
    throw new Error("Vigil guardian setup requires the signed-in account name.");
  }
  if (!request.targetHome.startsWith("/Users/") || request.targetHome.includes("..")) {
    throw new Error("Vigil guardian setup requires the signed-in account's absolute home directory.");
  }
  for (const [label, path] of [
    ["source app", request.sourceAppPath],
    ["target app", request.targetAppPath]
  ]) {
    if (!path.startsWith("/") || !path.endsWith(".app")) {
      throw new Error(`Vigil guardian setup requires an absolute ${label} path.`);
    }
  }
  if (request.protocolBootstrap) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(request.protocolBootstrap.token)) {
      throw new Error("Vigil's updater-protocol bridge requires a fresh authorization token.");
    }
    if (!/^[a-f0-9]{40}$/iu.test(request.protocolBootstrap.expectedUpdateCommit)) {
      throw new Error("Vigil's updater-protocol bridge requires the exact follow-on update commit.");
    }
  }
}

async function canonicalDirectory(
  path: string,
  label: string,
  operations: GuardianSetupOperations
): Promise<string> {
  const canonical = await operations.canonicalPath(resolve(path));
  const value = await operations.stat(canonical);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`Vigil refused to use an unsafe ${label} at ${canonical}.`);
  }
  return canonical;
}

async function canonicalRegularFile(
  path: string,
  label: string,
  operations: GuardianSetupOperations
): Promise<string> {
  const canonical = await operations.canonicalPath(resolve(path));
  const value = await operations.stat(canonical);
  if (!value.isFile() || value.isSymbolicLink()) {
    throw new Error(`Vigil refused to use an unsafe ${label} at ${canonical}.`);
  }
  return canonical;
}

function assertDescendant(root: string, path: string, label: string): void {
  const child = relative(root, path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || resolve(root, child) !== path) {
    throw new Error(`Vigil's ${label} is not inside its signed setup app.`);
  }
}

export interface CodeSignatureIdentity {
  adhoc: boolean;
  authorities: string[];
  cdHash: string;
  designatedRequirement: string;
  identifier: string;
  teamIdentifier: string;
}

export async function verifyMatchingSignedApps(
  sourceAppPath: string,
  targetAppPath: string
): Promise<SignedSetupBundleIdentity> {
  await Promise.all([
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", sourceAppPath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetAppPath], { timeout: 30_000 })
  ]);
  const [source, target] = await Promise.all([
    codeSignatureDetails(sourceAppPath),
    codeSignatureDetails(targetAppPath)
  ]);
  if (source.identifier !== APP_IDENTIFIER || target.identifier !== APP_IDENTIFIER) {
    throw new Error("Vigil refused a guardian setup app with an unexpected bundle identity.");
  }
  if (!locallyRebuildableSignaturesMatch(source, target)) {
    throw new Error("Vigil refused a guardian setup app that does not match the installed app's signing identity.");
  }
  if (!validCdHash(source.cdHash) || !validCdHash(target.cdHash)) {
    throw new Error("Vigil could not pin the signed app generation for guardian setup.");
  }
  return { sourceCdHash: source.cdHash, targetCdHash: target.cdHash };
}

async function codeSignatureDetails(path: string): Promise<CodeSignatureIdentity> {
  const [{ stderr }, requirement] = await Promise.all([
    execFileAsync("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    }),
    execFileAsync("/usr/bin/codesign", ["-d", "-r-", path], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024
    })
  ]);
  return {
    adhoc: /^Signature=adhoc$/mu.test(stderr),
    authorities: [...stderr.matchAll(/^Authority=(.+)$/gmu)].map((match) => String(match[1] || "").trim()),
    cdHash: stderr.match(/^CDHash=([a-f0-9]+)$/imu)?.[1]?.toLowerCase() || "",
    designatedRequirement: requirement.stderr.match(/^designated => (.+)$/mu)?.[1]?.trim() || "",
    identifier: stderr.match(/^Identifier=(.+)$/mu)?.[1]?.trim() || "",
    teamIdentifier: stderr.match(/^TeamIdentifier=(.+)$/mu)?.[1]?.trim() || ""
  };
}

export function locallyRebuildableSignaturesMatch(
  source: CodeSignatureIdentity,
  target: CodeSignatureIdentity
): boolean {
  if (source.adhoc && target.adhoc) return true;
  const sourceLocalAuthority = source.authorities.find((authority) => authority === "Vigil Local Code Signing");
  if (sourceLocalAuthority
    && target.authorities.includes(sourceLocalAuthority)
    && source.designatedRequirement
    && source.designatedRequirement === target.designatedRequirement) return true;
  const sourceDeveloperIdAuthority = source.authorities.find((authority) =>
    authority.startsWith("Developer ID Application:")
  );
  const targetDeveloperIdAuthority = target.authorities.find((authority) =>
    authority.startsWith("Developer ID Application:")
  );
  if (sourceDeveloperIdAuthority
    && sourceDeveloperIdAuthority === targetDeveloperIdAuthority
    && source.identifier
    && source.identifier === target.identifier
    && source.teamIdentifier
    && source.teamIdentifier === target.teamIdentifier
    && source.designatedRequirement
    && source.designatedRequirement === target.designatedRequirement) return true;
  const sourceDevelopmentAuthority = source.authorities.find((authority) => authority.startsWith("Apple Development:"));
  const targetDevelopmentAuthority = target.authorities.find((authority) => authority.startsWith("Apple Development:"));
  return Boolean(
    sourceDevelopmentAuthority
    && targetDevelopmentAuthority
    && (
      (source.teamIdentifier && source.teamIdentifier === target.teamIdentifier)
      || sourceDevelopmentAuthority === targetDevelopmentAuthority
    )
  );
}

function validCdHash(value: string): boolean {
  return /^[a-f0-9]{40,64}$/u.test(value);
}

async function assertProtectedAvailability(targetAppPath: string, targetUid: number): Promise<void> {
  const executablePath = join(targetAppPath, "Contents", "MacOS", "Vigil");
  const [{ stdout: supervisorState }, { stdout: userDomainState }] = await Promise.all([
    execFileAsync(
      "/bin/launchctl",
      ["print", `gui/${targetUid}/${SUPERVISOR_LABEL}`],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }
    ),
    execFileAsync(
      "/bin/launchctl",
      ["print", `gui/${targetUid}`],
      { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }
    )
  ]).catch((error) => {
    throw new Error(`Vigil refused guardian setup because its app and restart supervisor are not both online: ${errorMessage(error)}`);
  });
  const appServiceStates = await Promise.all(
    protectedAppServiceLabels(userDomainState).map(async (label) => {
      try {
        const { stdout } = await execFileAsync(
          "/bin/launchctl",
          ["print", `gui/${targetUid}/${label}`],
          { timeout: 5_000, maxBuffer: 4 * 1024 * 1024 }
        );
        return stdout;
      } catch {
        return "";
      }
    })
  );
  if (!protectedAvailabilityIsRunning(
    supervisorState,
    appServiceStates,
    executablePath
  )) {
    throw new Error("Vigil refused guardian setup because its app and restart supervisor are not both running.");
  }
}

export function protectedAvailabilityIsRunning(
  supervisorState: string,
  appServiceStates: readonly string[],
  expectedExecutablePath: string
): boolean {
  return /^\s*state = running\s*$/mu.test(supervisorState)
    && /^\s*pid = [1-9]\d*\s*$/mu.test(supervisorState)
    && appServiceStates.some((state) =>
      /^\s*state = running\s*$/mu.test(state)
      && /^\s*pid = [1-9]\d*\s*$/mu.test(state)
      && /^\s*bundle id = tech\.caseline\.vigil\s*$/mu.test(state)
      && new RegExp(`^\\s*program = ${regexEscape(expectedExecutablePath)}\\s*$`, "mu").test(state)
    );
}

function protectedAppServiceLabels(userDomainState: string): string[] {
  return [...new Set(
    [...userDomainState.matchAll(
      /^\s*\d+\s+\S+\s+(application\.tech\.caseline\.vigil\.[A-Za-z0-9._-]+)\s*$/gmu
    )].map((match) => String(match[1] || ""))
  )];
}

async function runGuardianInstallerWithAdministratorPrivileges(request: GuardianSetupAdminRequest): Promise<void> {
  await execFileAsync("/usr/bin/osascript", [
    "-e", administratorAppleScript(),
    request.sourceAppPath,
    request.targetAppPath,
    request.targetHome,
    String(request.targetUid),
    request.targetUser,
    request.expectedCurrentGuardianSha256,
    request.expectedSourceCdHash,
    request.expectedTargetCdHash,
    request.protocolBootstrapToken || "",
    request.protocolBootstrapExpectedUpdateCommit || "",
    request.authorizationOnly ? "true" : "false",
    request.requireNormalUpdateCompatibility ? "true" : "false"
  ], {
    timeout: ADMIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024
  });
}

async function runGuardianInstallerPreflight(request: GuardianSetupAdminRequest): Promise<void> {
  const electronPath = join(request.sourceAppPath, DEFAULT_ELECTRON_RELATIVE_PATH);
  const installerPath = join(request.sourceAppPath, DEFAULT_INSTALLER_RELATIVE_PATH);
  await execFileAsync(electronPath, [
    installerPath,
    ...guardianInstallerArguments(request),
    "--read-only-preflight"
  ], {
    timeout: ADMIN_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1"
    }
  });
}

function guardianInstallerArguments(request: GuardianSetupAdminRequest): string[] {
  return [
    "--source-app", request.sourceAppPath,
    "--app", request.targetAppPath,
    "--home", request.targetHome,
    "--uid", String(request.targetUid),
    "--user", request.targetUser,
    "--expected-current-script-sha256", request.expectedCurrentGuardianSha256,
    "--expected-source-cdhash", request.expectedSourceCdHash,
    "--expected-target-cdhash", request.expectedTargetCdHash,
    "--bootstrap-source-app", request.sourceAppPath,
    "--bootstrap-token", request.protocolBootstrapToken || "",
    "--bootstrap-expected-update-commit", request.protocolBootstrapExpectedUpdateCommit || "",
    "--authorization-only", request.authorizationOnly ? "true" : "false",
    "--require-normal-update-compatibility", request.requireNormalUpdateCompatibility ? "true" : "false",
    "--json"
  ];
}

export function administratorAppleScript(): string {
  return `on run argv
  set sourceAppPath to item 1 of argv
  set targetAppPath to item 2 of argv
  set targetHome to item 3 of argv
  set targetUid to item 4 of argv
  set targetUser to item 5 of argv
  set guardianSha to item 6 of argv
  set sourceCdHash to item 7 of argv
  set targetCdHash to item 8 of argv
  set bootstrapToken to item 9 of argv
  set bootstrapCommit to item 10 of argv
  set authorizationOnly to item 11 of argv
  set requireNormalUpdateCompatibility to item 12 of argv
  set shellProgram to "set -eu; setup_root=$(/usr/bin/mktemp -d /private/var/tmp/tech.caseline.vigil.guardian-setup.XXXXXX); /bin/chmod 700 \\\"$setup_root\\\"; cleanup() { case \\\"$setup_root\\\" in /private/var/tmp/tech.caseline.vigil.guardian-setup.*) /bin/rm -rf \\\"$setup_root\\\" ;; esac; }; trap cleanup EXIT HUP INT TERM; stage_app=\\\"$setup_root/Vigil.app\\\"; /usr/bin/ditto --noqtn \\\"$1\\\" \\\"$stage_app\\\"; /usr/bin/codesign --verify --deep --strict \\\"$stage_app\\\"; staged_cdhash=$(/usr/bin/codesign -dv --verbose=4 \\\"$stage_app\\\" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'); /usr/bin/codesign --verify --deep --strict \\\"$2\\\"; target_cdhash=$(/usr/bin/codesign -dv --verbose=4 \\\"$2\\\" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p'); if [ \\\"$staged_cdhash\\\" != \\\"$7\\\" ] || [ \\\"$target_cdhash\\\" != \\\"$8\\\" ]; then echo 'Vigil refused a signed app substitution during guardian setup.' >&2; exit 65; fi; /usr/bin/env ELECTRON_RUN_AS_NODE=1 \\\"$stage_app/Contents/MacOS/Vigil\\\" \\\"$stage_app/Contents/Resources/app.asar.unpacked/dist/runtime/scripts/install-system-guardian.mjs\\\" --source-app \\\"$stage_app\\\" --app \\\"$2\\\" --home \\\"$3\\\" --uid \\\"$4\\\" --user \\\"$5\\\" --expected-current-script-sha256 \\\"$6\\\" --expected-source-cdhash \\\"$7\\\" --expected-target-cdhash \\\"$8\\\" --json"
  set shellProgram to shellProgram & " --bootstrap-source-app \\\"$1\\\" --bootstrap-token \\\"$9\\\" --bootstrap-expected-update-commit \\\"\${10}\\\" --authorization-only \\\"\${11}\\\" --require-normal-update-compatibility \\\"\${12}\\\""
  set commandText to "/bin/sh -c " & quoted form of shellProgram & " vigil-guardian-setup"
  set commandText to commandText & " " & quoted form of sourceAppPath
  set commandText to commandText & " " & quoted form of targetAppPath
  set commandText to commandText & " " & quoted form of targetHome
  set commandText to commandText & " " & quoted form of targetUid
  set commandText to commandText & " " & quoted form of targetUser
  set commandText to commandText & " " & quoted form of guardianSha
  set commandText to commandText & " " & quoted form of sourceCdHash
  set commandText to commandText & " " & quoted form of targetCdHash
  set commandText to commandText & " " & quoted form of bootstrapToken
  set commandText to commandText & " " & quoted form of bootstrapCommit
  set commandText to commandText & " " & quoted form of authorizationOnly
  set commandText to commandText & " " & quoted form of requireNormalUpdateCompatibility
  do shell script commandText with administrator privileges with prompt "Vigil needs one-time administrator approval to enable fast protected updates. Vigil stays online."
end run`;
}

function administratorPromptCanceled(error: unknown): boolean {
  return /user canceled|\(-128\)|canceled by the user/iu.test(commandErrorText(error));
}

function commandErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Unknown guardian setup error.");
  const record = error as { message?: unknown; stderr?: unknown; stdout?: unknown };
  return `${String(record.stderr || "")}\n${String(record.stdout || "")}\n${String(record.message || "")}`.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown guardian setup error.");
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export const GUARDIAN_SETUP_SERVICE_LABEL = SYSTEM_GUARDIAN_LABEL;
