import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import { parsePlist } from "../src/plist.js";
import { verifyUpdateProtocolBridgeEquivalence } from "./package-update-protocol-bridge.mjs";
import {
  SYSTEM_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_PLIST_PATH,
  SYSTEM_GUARDIAN_ROOT,
  SYSTEM_GUARDIAN_SAFETY_ARG,
  SYSTEM_GUARDIAN_SCRIPT_PATH,
  systemGuardianPlist,
  systemGuardianScript
} from "../src/systemGuardian.js";
import {
  guardianScriptRevision,
  LEGACY_SYSTEM_GUARDIAN_LABEL,
  LEGACY_SYSTEM_GUARDIAN_PLIST_PATH,
  LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_AUTHORIZATION_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_LABEL,
  PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH,
  PREVIOUS_SYSTEM_GUARDIAN_REVISION,
  PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH,
  PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH,
  SYSTEM_GUARDIAN_MAINTENANCE_FILENAME,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  SYSTEM_GUARDIAN_REVISION,
  UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH,
  UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME
} from "../src/updateMaintenance.js";
import {
  UPDATE_RECOVERY_MANIFEST_FILENAME,
  UPDATE_RECOVERY_POLICY_FILENAME
} from "../src/updateTransaction.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TARGET_APP_PATH = "/Applications/Vigil.app";
export const SYSTEM_GUARDIAN_STABILITY_MS = 500;
export const PREVIOUS_SYSTEM_GUARDIAN_PROGRAM_SHA256 = "ee0be79b4c686c1d28e38ed8ca185e941e0dce2b2fe2eefd030625958e20b88d";
export const LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256 = "62f041926840824e15c76361d508ac224c3b92ba7312003329c410d83fcc8ea1";

const COMMON_PREDECESSOR_DYNAMIC_ASSIGNMENTS = [
  "target_uid",
  "target_user",
  "target_home",
  "app_path",
  "executable_path",
  "process_pattern",
  "supervisor_service",
  "update_lock_path",
  "maintenance_marker_path",
  "global_update_manifest_path",
  "global_update_policy_path"
] as const;

const PREVIOUS_GUARDIAN_DYNAMIC_ASSIGNMENTS = [
  ...COMMON_PREDECESSOR_DYNAMIC_ASSIGNMENTS,
  "bootstrap_worker_request_path",
  "exact_main_command",
  "exact_main_process_pattern",
  "packaged_updater_script_path",
  "local_updater_script_path",
  "user_data_dir",
  "update_status_path",
  "update_log_path"
] as const;

export async function installSystemGuardian(argv = process.argv.slice(2)): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Installing Vigil's system guardian requires administrator privileges (run this command with sudo).");
  }
  const options = parseOptions(argv);
  await validateSignedSetupSource(options);
  await assertExpectedCurrentGuardian(options);
  const script = systemGuardianScript(options);
  const plist = systemGuardianPlist();
  await mkdir(SYSTEM_GUARDIAN_ROOT, { recursive: true, mode: 0o755 });
  await validateGuardianRoot();
  const initialService = await inspectSystemGuardianService();
  await assertProtocolBootstrapMigrationState(options, initialService, plist);
  const predecessor = options.authorizationOnly ? null : await runningPredecessorGuardian(options);
  const transactionId = `${process.pid}-${randomUUID()}`;
  if (options.authorizationOnly) {
    if (!options.bootstrapToken) throw new Error("Vigil cannot refresh an empty updater-protocol authorization.");
    await installRootAuthorization(await protocolBootstrapAuthorization(options), transactionId);
    return;
  }
  if (initialService.loaded) {
    throw new Error("Vigil refused to replace or restart a loaded guardian. Its existing availability process was left untouched.");
  }
  const files: StagedRootOwnedFile[] = [];
  try {
    files.push(await stageRootOwnedFile(SYSTEM_GUARDIAN_SCRIPT_PATH, script, 0o755, transactionId));
    files.push(await stageRootOwnedFile(SYSTEM_GUARDIAN_PLIST_PATH, plist, 0o644, transactionId));
  } catch (error) {
    await discardStagedFiles(files);
    throw error;
  }

  try {
    // Reject malformed candidates while the installed guardian and its live
    // launchd job are untouched.
    await Promise.all(files.map((file) => validateStagedRootOwnedFile(file, file.expectedMode)));
    await execFileAsync("/bin/zsh", ["-n", files[0].stagedPath], { timeout: 5_000 });
    await execFileAsync("/usr/bin/plutil", ["-lint", files[1].stagedPath], { timeout: 5_000 });
  } catch (error) {
    await discardStagedFiles(files);
    throw error;
  }

  let activationStarted = false;
  let serviceBootstrapAttempted = false;
  try {
    await assertExpectedCurrentGuardian(options);
    if (predecessor) await assertPredecessorGuardianContinuity(predecessor, options);
    const serviceBeforeActivation = await inspectSystemGuardianService();
    if (serviceBeforeActivation.loaded) {
      throw new Error(
        "Vigil's parallel v4 guardian loaded while setup was being prepared. Its running files were left untouched."
      );
    }
    activationStarted = true;
    for (const file of files) await activateStagedFile(file);
    await verifyActivatedFiles(files);
    serviceBootstrapAttempted = true;
    await bootstrapSystemGuardian();
    await verifyActivatedFiles(files);
    if (predecessor) await assertPredecessorGuardianContinuity(predecessor, options);
  } catch (error) {
    if (serviceBootstrapAttempted) {
      await discardStagedFiles(files).catch(() => undefined);
      throw new Error(
        `${errorMessage(error)} Vigil preserved the new parallel guardian files and never stopped any guardian; launchd can finish starting the v4 service safely.`
      );
    }
    const rollbackErrors: unknown[] = [];
    if (activationStarted) {
      for (const file of [...files].reverse()) {
        await collectRollbackError(rollbackErrors, restorePreviousFile(file));
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `Vigil's system guardian installation failed and the previous guardian could not be fully restored. Recovery files were preserved: ${files.map((file) => file.backupPath).join(", ")}`
      );
    }
    await discardStagedFiles(files);
    throw error;
  }

  await discardStagedFiles(files);
  if (options.bootstrapToken) {
    await installRootAuthorization(await protocolBootstrapAuthorization(options), transactionId);
  }
}

interface InstallOptions {
  appPath: string;
  expectedCurrentScriptSha256: string | null;
  expectedSourceCdHash: string | null;
  expectedTargetCdHash: string | null;
  json: boolean;
  sourceAppPath: string | null;
  targetHome: string;
  targetUid: number;
  targetUser: string;
  bootstrapSourceAppPath: string | null;
  bootstrapToken: string | null;
  bootstrapExpectedUpdateCommit: string | null;
  authorizationOnly: boolean;
}

function parseOptions(argv: string[]): InstallOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
    else if (argument === "--json") values.set("json", "true");
    else values.set(argument.slice(2), String(argv[index + 1] || ""));
  }
  const targetUid = Number(values.get("uid") || process.env.SUDO_UID || "");
  const targetUser = String(values.get("user") || process.env.SUDO_USER || "").trim();
  const targetHome = String(values.get("home") || (targetUser ? `/Users/${targetUser}` : "")).trim();
  const appPath = String(values.get("app") || "/Applications/Vigil.app").trim();
  if (!Number.isInteger(targetUid) || targetUid < 501) throw new Error("Pass the signed-in user's numeric id with --uid.");
  if (!/^[A-Za-z0-9._-]+$/u.test(targetUser) || targetUser === "root") throw new Error("Pass the signed-in account name with --user.");
  if (!targetHome.startsWith("/Users/") || targetHome.includes("..")) throw new Error("Pass the signed-in account's absolute home directory with --home.");
  if (!appPath.startsWith("/") || !appPath.endsWith(".app")) throw new Error("Pass Vigil's absolute app bundle path with --app.");
  const sourceAppPathValue = String(values.get("source-app") || "").trim();
  const sourceAppPath = sourceAppPathValue || null;
  if (sourceAppPath && (!sourceAppPath.startsWith("/") || !sourceAppPath.endsWith(".app"))) {
    throw new Error("Pass the signed guardian setup bundle's absolute path with --source-app.");
  }
  const expectedCurrentScriptSha256Value = String(values.get("expected-current-script-sha256") || "").trim();
  const expectedCurrentScriptSha256 = expectedCurrentScriptSha256Value || null;
  if (expectedCurrentScriptSha256
    && expectedCurrentScriptSha256 !== "absent"
    && !/^[a-f0-9]{64}$/u.test(expectedCurrentScriptSha256)) {
    throw new Error("Pass the installed guardian's SHA-256 digest with --expected-current-script-sha256.");
  }
  const expectedSourceCdHash = String(values.get("expected-source-cdhash") || "").trim().toLowerCase() || null;
  const expectedTargetCdHash = String(values.get("expected-target-cdhash") || "").trim().toLowerCase() || null;
  for (const [label, value] of [
    ["source", expectedSourceCdHash],
    ["target", expectedTargetCdHash]
  ] as const) {
    if (value && !/^[a-f0-9]{40,64}$/u.test(value)) {
      throw new Error(`Pass the signed ${label} app's CodeDirectory hash.`);
    }
  }
  const appOwnedInputs = [sourceAppPath, expectedCurrentScriptSha256, expectedSourceCdHash, expectedTargetCdHash];
  if (appOwnedInputs.some(Boolean) && !appOwnedInputs.every(Boolean)) {
    throw new Error("App-owned guardian setup requires its source, guardian digest, and signed app generation hashes together.");
  }
  const bootstrapToken = String(values.get("bootstrap-token") || "").trim().toLowerCase() || null;
  const bootstrapExpectedUpdateCommit = String(values.get("bootstrap-expected-update-commit") || "").trim().toLowerCase() || null;
  const bootstrapSourceAppPathValue = String(values.get("bootstrap-source-app") || "").trim();
  const bootstrapSourceAppPath = bootstrapToken ? bootstrapSourceAppPathValue : null;
  if ((bootstrapToken || bootstrapExpectedUpdateCommit)
    && (!bootstrapToken || !bootstrapExpectedUpdateCommit || !bootstrapSourceAppPath)) {
    throw new Error("Updater-protocol bootstrap authorization requires its token, source app, and follow-on commit together.");
  }
  if (bootstrapToken
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(bootstrapToken)) {
    throw new Error("Pass a fresh updater-protocol bootstrap token.");
  }
  if (bootstrapExpectedUpdateCommit && !/^[a-f0-9]{40}$/u.test(bootstrapExpectedUpdateCommit)) {
    throw new Error("Pass the exact follow-on update commit for updater-protocol bootstrap.");
  }
  if (bootstrapSourceAppPath && (!bootstrapSourceAppPath.startsWith("/") || !bootstrapSourceAppPath.endsWith(".app"))) {
    throw new Error("Pass the updater-protocol bootstrap bundle's absolute path.");
  }
  if (bootstrapToken && !sourceAppPath) {
    throw new Error("Updater-protocol bootstrap authorization is available only through app-owned guardian setup.");
  }
  const authorizationOnly = values.get("authorization-only") === "true";
  if (authorizationOnly && !bootstrapToken) {
    throw new Error("Authorization-only guardian setup requires an updater-protocol bootstrap request.");
  }
  return {
    appPath,
    expectedCurrentScriptSha256,
    expectedSourceCdHash,
    expectedTargetCdHash,
    json: values.get("json") === "true",
    sourceAppPath,
    targetHome,
    targetUid,
    targetUser,
    bootstrapSourceAppPath,
    bootstrapToken,
    bootstrapExpectedUpdateCommit,
    authorizationOnly
  };
}

interface CodeSignatureIdentity {
  adhoc: boolean;
  authorities: string[];
  cdHash: string;
  designatedRequirement: string;
  identifier: string;
  teamIdentifier: string;
}

async function validateSignedSetupSource(options: InstallOptions): Promise<void> {
  if (!options.sourceAppPath) return;
  const [sourcePath, targetPath] = await Promise.all([
    canonicalAppBundle(options.sourceAppPath, "guardian setup app"),
    canonicalAppBundle(options.appPath, "installed Vigil app")
  ]);
  if (targetPath !== DEFAULT_TARGET_APP_PATH) {
    throw new Error(`Vigil refused app-owned guardian setup for an unexpected target at ${targetPath}.`);
  }
  await validateAppOwnedAccount(options);
  await Promise.all([
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", sourcePath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetPath], { timeout: 30_000 })
  ]);
  const [source, target] = await Promise.all([
    codeSignatureIdentity(sourcePath),
    codeSignatureIdentity(targetPath)
  ]);
  if (source.identifier !== "tech.caseline.vigil" || target.identifier !== "tech.caseline.vigil") {
    throw new Error("Vigil refused a guardian setup app with an unexpected bundle identity.");
  }
  if (!locallyRebuildableSignaturesMatch(source, target)) {
    throw new Error("Vigil refused a guardian setup app that does not match the installed app's signing identity.");
  }
  if (source.cdHash !== options.expectedSourceCdHash || target.cdHash !== options.expectedTargetCdHash) {
    throw new Error("Vigil refused a signed app substitution during guardian setup.");
  }
}

async function validateAppOwnedAccount(options: InstallOptions): Promise<void> {
  const [{ stdout: uidOutput }, { stdout: homeOutput }] = await Promise.all([
    execFileAsync("/usr/bin/id", ["-u", options.targetUser], { timeout: 5_000 }),
    execFileAsync("/usr/bin/dscl", [".", "-read", `/Users/${options.targetUser}`, "NFSHomeDirectory"], {
      timeout: 5_000,
      maxBuffer: 64 * 1024
    })
  ]);
  const accountUid = Number(uidOutput.trim());
  const accountHome = homeOutput.match(/^NFSHomeDirectory:\s*(.+)$/mu)?.[1]?.trim() || "";
  if (!Number.isInteger(accountUid)
    || accountUid !== options.targetUid
    || accountHome !== options.targetHome) {
    throw new Error("Vigil refused guardian setup because the approved macOS account details do not match.");
  }
}

interface BootstrapBuildIdentity {
  commit: string;
  fingerprint: string;
  sourceRoot: string;
}

async function assertProtocolBootstrapMigrationState(
  options: InstallOptions,
  service: SystemGuardianServiceInspection,
  expectedPlist: string
): Promise<void> {
  if (options.authorizationOnly) {
    if (!service.loaded || !service.running) {
      throw new Error("Vigil refused authorization-only setup because its parallel v4 guardian is not running.");
    }
    await assertLoadedGuardianTopology(service.output, expectedPlist);
    const installed = await readFile(SYSTEM_GUARDIAN_SCRIPT_PATH, "utf8");
    const revision = guardianScriptRevision(installed);
    if (revision === null
      || revision < SYSTEM_GUARDIAN_REVISION
      || !installed.includes(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND)) {
      throw new Error("Vigil refused authorization-only setup for a guardian without the required v4 protocol.");
    }
    return;
  }
  if (service.loaded) {
    throw new Error("Vigil refused to restart a loaded guardian while adding the parallel v4 update boundary.");
  }
}

async function protocolBootstrapAuthorization(options: InstallOptions): Promise<string> {
  if (!options.bootstrapToken
    || !options.bootstrapExpectedUpdateCommit
    || !options.bootstrapSourceAppPath
    || !options.sourceAppPath
    || !options.expectedSourceCdHash
    || !options.expectedTargetCdHash) {
    throw new Error("Vigil cannot create an incomplete updater-protocol bootstrap authorization.");
  }
  const [stagedSourcePath, authorizedSourcePath, targetPath] = await Promise.all([
    canonicalAppBundle(options.sourceAppPath, "root-staged guardian setup app"),
    canonicalAppBundle(options.bootstrapSourceAppPath, "authorized updater-protocol bridge app"),
    canonicalAppBundle(options.appPath, "installed Vigil app")
  ]);
  const updaterScriptPath = join(
    stagedSourcePath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "scripts",
    "update-packaged-app.mjs"
  );
  const bootstrapScriptPath = join(
    stagedSourcePath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "scripts",
    "bootstrap-update-protocol.mjs"
  );
  const setupScriptPath = join(
    stagedSourcePath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "scripts",
    "setup-system-guardian.mjs"
  );
  await Promise.all([
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedSourcePath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", authorizedSourcePath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetPath], { timeout: 30_000 })
  ]);
  const [stagedSignatureBefore, authorizedSignatureBefore, targetSignatureBefore] = await Promise.all([
    codeSignatureIdentity(stagedSourcePath),
    codeSignatureIdentity(authorizedSourcePath),
    codeSignatureIdentity(targetPath)
  ]);
  const [
    stagedBuild,
    authorizedBuild,
    targetBuild,
    updaterBytes,
    bootstrapBytes,
    setupBytes,
    bridgeEquivalence
  ] = await Promise.all([
    readBootstrapBuildIdentity(stagedSourcePath),
    readBootstrapBuildIdentity(authorizedSourcePath),
    readBootstrapBuildIdentity(targetPath),
    readPinnedRegularFile(updaterScriptPath, 2 * 1024 * 1024),
    readPinnedRegularFile(bootstrapScriptPath, 2 * 1024 * 1024),
    readPinnedRegularFile(setupScriptPath, 2 * 1024 * 1024),
    verifyUpdateProtocolBridgeEquivalence(
      options.expectedSourceCdHash === options.expectedTargetCdHash ? null : targetPath,
      stagedSourcePath
    )
  ]);
  await Promise.all([
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedSourcePath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", authorizedSourcePath], { timeout: 30_000 }),
    execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetPath], { timeout: 30_000 })
  ]);
  const [stagedSignatureAfter, authorizedSignatureAfter, targetSignatureAfter] = await Promise.all([
    codeSignatureIdentity(stagedSourcePath),
    codeSignatureIdentity(authorizedSourcePath),
    codeSignatureIdentity(targetPath)
  ]);
  if (!sameCodeSignatureIdentity(stagedSignatureBefore, stagedSignatureAfter)
    || !sameCodeSignatureIdentity(authorizedSignatureBefore, authorizedSignatureAfter)
    || !sameCodeSignatureIdentity(targetSignatureBefore, targetSignatureAfter)
    || stagedSignatureAfter.identifier !== "tech.caseline.vigil"
    || authorizedSignatureAfter.identifier !== "tech.caseline.vigil"
    || targetSignatureAfter.identifier !== "tech.caseline.vigil"
    || stagedSignatureAfter.cdHash !== options.expectedSourceCdHash
    || authorizedSignatureAfter.cdHash !== options.expectedSourceCdHash
    || targetSignatureAfter.cdHash !== options.expectedTargetCdHash
    || !sameBootstrapBuildIdentity(stagedBuild, authorizedBuild)
    || !sameBootstrapBuildIdentity(authorizedBuild, targetBuild)) {
    throw new Error("Vigil refused a changed updater-protocol bridge app after administrator authorization.");
  }
  if (authorizedBuild.commit === options.bootstrapExpectedUpdateCommit) {
    throw new Error("Vigil's protocol bridge must be a distinct signed generation before the follow-on update.");
  }
  const repoRoot = await realpath(authorizedBuild.sourceRoot);
  const repoStat = await lstat(repoRoot);
  if (!repoStat.isDirectory()
    || repoStat.isSymbolicLink()
    || repoStat.uid !== options.targetUid
    || repoRoot !== authorizedBuild.sourceRoot) {
    throw new Error("Vigil refused an unsafe source repository for the updater-protocol bridge.");
  }
  assertPackagedUpdaterProtocol(updaterBytes.toString("utf8"));
  const nowEpoch = Math.floor(Date.now() / 1_000);
  return `${JSON.stringify({
    kind: UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
    token: options.bootstrapToken,
    sourceAppPath: authorizedSourcePath,
    targetAppPath: targetPath,
    repoRoot,
    targetHome: options.targetHome,
    targetUid: options.targetUid,
    targetUser: options.targetUser,
    sourceCdHash: options.expectedSourceCdHash,
    targetCdHash: options.expectedTargetCdHash,
    sourceCommit: authorizedBuild.commit,
    sourceFingerprint: authorizedBuild.fingerprint,
    targetCommit: targetBuild.commit,
    targetFingerprint: targetBuild.fingerprint,
    updaterScriptSha256: sha256(updaterBytes),
    bootstrapScriptSha256: sha256(bootstrapBytes),
    setupScriptSha256: sha256(setupBytes),
    bridgeManifestSha256: bridgeEquivalence.manifestSha256,
    bridgeEquivalentTreeSha256: bridgeEquivalence.equivalentTreeSha256,
    bridgePayloadTreeSha256: bridgeEquivalence.payloadTreeSha256,
    bridgeWrappersSha256: bridgeEquivalence.wrappersSha256,
    bridgeBaselineBuildInfoSha256: bridgeEquivalence.baselineBuildInfoSha256,
    expectedUpdateCommit: options.bootstrapExpectedUpdateCommit,
    createdAtEpoch: nowEpoch,
    expiresAtEpoch: nowEpoch + UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS
  }, null, 2)}\n`;
}

async function readBootstrapBuildIdentity(appPath: string): Promise<BootstrapBuildIdentity> {
  const path = join(
    appPath,
    "Contents",
    "Resources",
    "app.asar.unpacked",
    "dist",
    "runtime",
    "build-info.json"
  );
  const bytes = await readPinnedRegularFile(path, 64 * 1024);
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    commit?: unknown;
    dirty?: unknown;
    name?: unknown;
    sourceFingerprint?: unknown;
    sourceRoot?: unknown;
  };
  const commit = String(parsed.commit || "").toLowerCase();
  const fingerprint = String(parsed.sourceFingerprint || "").toLowerCase();
  const sourceRoot = String(parsed.sourceRoot || "");
  if (parsed.name !== "vigil"
    || parsed.dirty !== false
    || !/^[a-f0-9]{40}$/u.test(commit)
    || !/^[a-f0-9]{64}$/u.test(fingerprint)
    || !sourceRoot.startsWith("/")) {
    throw new Error("Vigil's updater-protocol bridge requires clean signed build metadata.");
  }
  return { commit, fingerprint, sourceRoot };
}

async function readPinnedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) {
      throw new Error(`Vigil refused an unsafe signed bootstrap file at ${path}.`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || bytes.length !== after.size) {
      throw new Error(`Vigil refused a changing signed bootstrap file at ${path}.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function assertPackagedUpdaterProtocol(script: string): void {
  const marker = `export const PACKAGED_UPDATE_RECOVERY_PROTOCOL_REVISION = ${UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION};`;
  if (!script.includes(marker)) {
    throw new Error("Vigil's signed bridge app does not contain the required v3 packaged updater.");
  }
}

function sameBootstrapBuildIdentity(left: BootstrapBuildIdentity, right: BootstrapBuildIdentity): boolean {
  return left.commit === right.commit
    && left.fingerprint === right.fingerprint
    && left.sourceRoot === right.sourceRoot;
}

function sameCodeSignatureIdentity(left: CodeSignatureIdentity, right: CodeSignatureIdentity): boolean {
  return left.adhoc === right.adhoc
    && left.cdHash === right.cdHash
    && left.designatedRequirement === right.designatedRequirement
    && left.identifier === right.identifier
    && left.teamIdentifier === right.teamIdentifier
    && left.authorities.length === right.authorities.length
    && left.authorities.every((authority, index) => authority === right.authorities[index]);
}

async function canonicalAppBundle(path: string, label: string): Promise<string> {
  const canonical = await realpath(path);
  const value = await lstat(canonical);
  if (!value.isDirectory() || value.isSymbolicLink()) {
    throw new Error(`Vigil refused to use an unsafe ${label} at ${canonical}.`);
  }
  return canonical;
}

async function codeSignatureIdentity(path: string): Promise<CodeSignatureIdentity> {
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

function locallyRebuildableSignaturesMatch(source: CodeSignatureIdentity, target: CodeSignatureIdentity): boolean {
  if (source.adhoc && target.adhoc) return true;
  const sourceLocalAuthority = source.authorities.find((authority) => authority === "Vigil Local Code Signing");
  if (sourceLocalAuthority
    && target.authorities.includes(sourceLocalAuthority)
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

async function assertExpectedCurrentGuardian(options: InstallOptions): Promise<void> {
  if (!options.expectedCurrentScriptSha256) return;
  if (options.expectedCurrentScriptSha256 === "absent") {
    try {
      await lstat(SYSTEM_GUARDIAN_SCRIPT_PATH);
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return;
      throw error;
    }
    throw new Error("Vigil's parallel v4 guardian appeared after setup was authorized. Nothing was replaced.");
  }
  const value = await lstat(SYSTEM_GUARDIAN_SCRIPT_PATH);
  if (!value.isFile() || value.isSymbolicLink() || value.uid !== 0 || (value.mode & 0o022) !== 0) {
    throw new Error("Vigil refused to replace an unsafe installed system guardian.");
  }
  const observed = sha256(await readFile(SYSTEM_GUARDIAN_SCRIPT_PATH));
  if (observed !== options.expectedCurrentScriptSha256) {
    throw new Error("Vigil's installed system guardian changed after setup was authorized. Nothing was replaced.");
  }
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface StagedRootOwnedFile {
  activated: boolean;
  backupPath: string;
  expectedMode: number;
  expectedSha256: string;
  hadPrevious: boolean;
  path: string;
  stagedPath: string;
}

async function validateGuardianRoot(): Promise<void> {
  const rootStat = await lstat(SYSTEM_GUARDIAN_ROOT);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== 0) {
    throw new Error(`Vigil refused to use an unsafe system guardian directory at ${SYSTEM_GUARDIAN_ROOT}.`);
  }
  await chmod(SYSTEM_GUARDIAN_ROOT, 0o755);
}

async function stageRootOwnedFile(
  path: string,
  contents: string,
  mode: number,
  transactionId: string
): Promise<StagedRootOwnedFile> {
  const stagedPath = `${path}.vigil-staged-${transactionId}`;
  const backupPath = `${path}.vigil-previous-${transactionId}`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(stagedPath, contents, { encoding: "utf8", flag: "wx", mode });
    await chmod(stagedPath, mode);
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    activated: false,
    backupPath,
    expectedMode: mode,
    expectedSha256: sha256(Buffer.from(contents, "utf8")),
    hadPrevious: false,
    path,
    stagedPath
  };
}

async function installRootAuthorization(contents: string, transactionId: string): Promise<void> {
  const file = await stageRootOwnedFile(
    UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH,
    contents,
    0o644,
    `${transactionId}-authorization`
  );
  let cleanupSafe = false;
  try {
    await validateStagedRootOwnedFile(file, 0o644);
    await activateStagedFile(file);
    await verifyActivatedFiles([file]);
    cleanupSafe = true;
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    await collectRollbackError(rollbackErrors, restorePreviousFile(file));
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Vigil could not atomically install or restore its root updater-protocol authorization. Recovery evidence was preserved."
      );
    }
    cleanupSafe = true;
    throw error;
  } finally {
    if (cleanupSafe) await discardStagedFiles([file]);
  }
}

async function validateStagedRootOwnedFile(file: StagedRootOwnedFile, expectedMode: number): Promise<void> {
  const stagedStat = await lstat(file.stagedPath);
  if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || stagedStat.uid !== 0) {
    throw new Error(`Vigil refused to install an unsafe staged guardian file at ${file.stagedPath}.`);
  }
  if ((stagedStat.mode & 0o777) !== expectedMode) {
    throw new Error(`Vigil staged the guardian file at ${file.stagedPath} with unexpected permissions.`);
  }
}

async function verifyActivatedFiles(files: StagedRootOwnedFile[]): Promise<void> {
  for (const file of files) {
    const value = await lstat(file.path);
    if (!value.isFile()
      || value.isSymbolicLink()
      || value.uid !== 0
      || (value.mode & 0o777) !== file.expectedMode
      || sha256(await readFile(file.path)) !== file.expectedSha256) {
      throw new Error(`Vigil could not verify the activated guardian file at ${file.path}.`);
    }
  }
}

async function activateStagedFile(file: StagedRootOwnedFile): Promise<void> {
  try {
    const previousStat = await lstat(file.path);
    if (!previousStat.isFile() || previousStat.isSymbolicLink() || previousStat.uid !== 0) {
      throw new Error(`Vigil refused to replace an unsafe installed guardian file at ${file.path}.`);
    }
    // Keep the prior inode reachable for rollback, then atomically replace the
    // live pathname. The loaded launchd job is never unloaded during this
    // topology-compatible refresh.
    await link(file.path, file.backupPath);
    const backupStat = await lstat(file.backupPath);
    if (!backupStat.isFile()
      || backupStat.isSymbolicLink()
      || backupStat.uid !== 0
      || backupStat.dev !== previousStat.dev
      || backupStat.ino !== previousStat.ino) {
      throw new Error(`Vigil could not verify the guardian rollback file at ${file.backupPath}.`);
    }
    file.hadPrevious = true;
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
  await rename(file.stagedPath, file.path);
  file.activated = true;
}

async function restorePreviousFile(file: StagedRootOwnedFile): Promise<void> {
  if (file.hadPrevious) {
    await rename(file.backupPath, file.path);
    file.activated = false;
    return;
  }
  if (file.activated) {
    await rm(file.path, { force: true });
    file.activated = false;
  }
}

async function discardStagedFiles(files: StagedRootOwnedFile[]): Promise<void> {
  const results = await Promise.allSettled(files.flatMap((file) => [
    rm(file.stagedPath, { force: true }),
    rm(file.backupPath, { force: true })
  ]));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length) throw new AggregateError(failures, "Vigil could not clean up staged system guardian files.");
}

async function runLaunchctl(args: string[], optional = false): Promise<void> {
  try {
    await execFileAsync("/bin/launchctl", args, { timeout: 5_000 });
  } catch (error) {
    if (!optional) throw error;
  }
}

interface SystemGuardianServiceInspection {
  loaded: boolean;
  output: string;
  pid: number | null;
  running: boolean;
}

interface RootOwnedFileIdentity {
  birthtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  sha256: string;
  size: number;
}

interface PredecessorGuardianIdentity {
  label: string;
  pid: number;
  plist: RootOwnedFileIdentity;
  plistPath: string;
  script: RootOwnedFileIdentity;
  scriptPath: string;
}

interface PredecessorProcessIdentity {
  started: string;
  startedEpochSeconds: number;
}

export interface PredecessorGuardianCandidate {
  label: string;
  plistPath: string;
  scriptPath: string;
}

export interface GuardianRunningStabilityState {
  pid: number | null;
  since: number;
}

export function observeGuardianRunningStability(
  state: GuardianRunningStabilityState,
  service: Pick<SystemGuardianServiceInspection, "loaded" | "pid" | "running">,
  previousPid: number | null,
  now: number
): { stable: boolean; state: GuardianRunningStabilityState } {
  const candidatePid = service.loaded
    && service.running
    && service.pid
    && (previousPid === null || service.pid !== previousPid)
    ? service.pid
    : null;
  if (!candidatePid) return { stable: false, state: { pid: null, since: 0 } };
  if (state.pid !== candidatePid) {
    return { stable: false, state: { pid: candidatePid, since: now } };
  }
  return {
    stable: now - state.since >= SYSTEM_GUARDIAN_STABILITY_MS,
    state
  };
}

async function inspectSystemGuardianService(
  label = SYSTEM_GUARDIAN_LABEL
): Promise<SystemGuardianServiceInspection> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `system/${label}`], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    });
    const pid = Number(stdout.match(/^\s*pid = (\d+)\s*$/mu)?.[1] || "");
    return {
      loaded: true,
      output: stdout,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      running: /^\s*state = running\s*$/mu.test(stdout)
    };
  } catch (error) {
    if (launchctlServiceMissing(error)) return { loaded: false, output: "", pid: null, running: false };
    throw error;
  }
}

async function runningPredecessorGuardian(options: InstallOptions): Promise<PredecessorGuardianIdentity> {
  const candidates: PredecessorGuardianCandidate[] = [
    {
      label: PREVIOUS_SYSTEM_GUARDIAN_LABEL,
      plistPath: PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH,
      scriptPath: PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH
    },
    {
      label: LEGACY_SYSTEM_GUARDIAN_LABEL,
      plistPath: LEGACY_SYSTEM_GUARDIAN_PLIST_PATH,
      scriptPath: LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH
    }
  ];
  const failures: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const identity = await inspectPredecessorGuardian(candidate, options);
      if (identity) return identity;
    } catch (error) {
      failures.push(error);
    }
  }
  const detail = failures.map((error) => errorMessage(error)).filter(Boolean).join(" ");
  throw new Error(
    `Vigil refused to add its parallel v4 guardian without one exact, safe predecessor remaining loaded and running.${detail ? ` ${detail}` : ""}`
  );
}

async function assertPredecessorGuardianContinuity(
  expected: PredecessorGuardianIdentity,
  options: InstallOptions
): Promise<void> {
  const observed = await inspectPredecessorGuardian(expected, options);
  if (!observed
    || observed.pid !== expected.pid
    || !sameRootOwnedFileIdentity(observed.script, expected.script)
    || !sameRootOwnedFileIdentity(observed.plist, expected.plist)) {
    throw new Error(
      "Vigil's predecessor guardian changed while the parallel v4 guardian was being prepared. No running guardian was stopped or replaced."
    );
  }
}

async function inspectPredecessorGuardian(
  candidate: PredecessorGuardianCandidate,
  options: InstallOptions
): Promise<PredecessorGuardianIdentity | null> {
  const service = await inspectSystemGuardianService(candidate.label);
  if (!service.loaded) return null;
  const processBefore = service.pid ? await predecessorProcessIdentity(service.pid, candidate) : null;
  if (!service.running
    || !service.pid
    || !predecessorLaunchctlTopologyMatches(service.output, candidate)
    || !processBefore) {
    throw new Error(`Vigil's predecessor guardian ${candidate.label} is not running with its exact protected topology.`);
  }
  const [scriptFile, plistFile] = await Promise.all([
    readPinnedRootOwnedFile(candidate.scriptPath, 1024 * 1024, 0o755),
    readPinnedRootOwnedFile(candidate.plistPath, 1024 * 1024, 0o644)
  ]);
  const script = scriptFile.bytes.toString("utf8");
  const plistText = plistFile.bytes.toString("utf8");
  if (!rootOwnedFilePredatesProcess(scriptFile.identity, processBefore)
    || !rootOwnedFilePredatesProcess(plistFile.identity, processBefore)) {
    throw new Error(`Vigil's predecessor guardian ${candidate.label} did not start from its exact pinned files.`);
  }
  if (!predecessorGuardianContentMatches(script, plistText, candidate, options)) {
    throw new Error(`Vigil's predecessor guardian ${candidate.label} does not protect this exact app and account.`);
  }
  const confirmedService = await inspectSystemGuardianService(candidate.label);
  const processAfter = confirmedService.pid
    ? await predecessorProcessIdentity(confirmedService.pid, candidate)
    : null;
  if (!confirmedService.loaded
    || !confirmedService.running
    || confirmedService.pid !== service.pid
    || !predecessorLaunchctlTopologyMatches(confirmedService.output, candidate)
    || !processAfter
    || processAfter.started !== processBefore.started) {
    throw new Error(`Vigil's predecessor guardian ${candidate.label} changed while its protected files were being verified.`);
  }
  return {
    label: candidate.label,
    pid: confirmedService.pid,
    plist: plistFile.identity,
    plistPath: candidate.plistPath,
    script: scriptFile.identity,
    scriptPath: candidate.scriptPath
  };
}

export function predecessorLaunchctlTopologyMatches(
  output: string,
  candidate: PredecessorGuardianCandidate
): boolean {
  const guardianLogPath = join(SYSTEM_GUARDIAN_ROOT, "guardian.log");
  const argumentsBlock = launchctlBlockEntries(output, "arguments");
  const defaultEnvironment = launchctlBlockEntries(output, "default environment");
  const environment = launchctlBlockEntries(output, "environment");
  return launchctlFieldMatches(output, "path", candidate.plistPath)
    && launchctlFieldMatches(output, "type", "LaunchDaemon")
    && launchctlFieldMatches(output, "program", candidate.scriptPath)
    && launchctlFieldMatches(output, "stdout path", guardianLogPath)
    && launchctlFieldMatches(output, "stderr path", guardianLogPath)
    && launchctlFieldMatches(output, "domain", "system")
    && launchctlFieldMatches(output, "minimum runtime", "5")
    && launchctlFieldMatches(output, "spawn type", "background (5)")
    && launchctlFieldMatches(output, "properties", "keepalive | runatload | inferred program")
    && JSON.stringify(argumentsBlock) === JSON.stringify([candidate.scriptPath, SYSTEM_GUARDIAN_SAFETY_ARG])
    && JSON.stringify(defaultEnvironment) === JSON.stringify(["PATH => /usr/bin:/bin:/usr/sbin:/sbin"])
    && JSON.stringify(environment?.sort()) === JSON.stringify([
      "OSLogRateLimit => 64",
      `XPC_SERVICE_NAME => ${candidate.label}`
    ])
    && !/^\s*(?:group|root directory|username|working directory) =/mu.test(output);
}

async function predecessorProcessIdentity(
  pid: number,
  candidate: PredecessorGuardianCandidate
): Promise<PredecessorProcessIdentity | null> {
  const expectedCommand = `/bin/zsh ${candidate.scriptPath} ${SYSTEM_GUARDIAN_SAFETY_ARG}`;
  try {
    const fields = await Promise.all([
      "uid=",
      "gid=",
      "ppid=",
      "comm=",
      "command=",
      "lstart="
    ].map(async (field) => (await execFileAsync("/bin/ps", [
      "-ww",
      "-p",
      String(pid),
      "-o",
      field
    ], {
      timeout: 5_000,
      maxBuffer: 1024 * 1024
    })).stdout.trim()));
    if (JSON.stringify(fields.slice(0, 5)) !== JSON.stringify(["0", "0", "1", "/bin/zsh", expectedCommand])) {
      return null;
    }
    const startedEpochMs = Date.parse(fields[5]);
    if (!Number.isFinite(startedEpochMs)) return null;
    return {
      started: fields[5],
      startedEpochSeconds: Math.floor(startedEpochMs / 1_000)
    };
  } catch {
    return null;
  }
}

function rootOwnedFilePredatesProcess(
  file: RootOwnedFileIdentity,
  processIdentity: PredecessorProcessIdentity
): boolean {
  const latestFileChangeSeconds = Math.floor(Math.max(file.birthtimeMs, file.ctimeMs, file.mtimeMs) / 1_000);
  return Number.isFinite(latestFileChangeSeconds)
    && latestFileChangeSeconds <= processIdentity.startedEpochSeconds;
}

function launchctlBlockEntries(output: string, name: string): string[] | null {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.trim() === `${name} = {`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trim() === "}");
  if (end < 0) return null;
  return lines.slice(start + 1, end).map((line) => line.trim()).filter(Boolean);
}

export function predecessorGuardianContentMatches(
  script: string,
  plistText: string,
  candidate: PredecessorGuardianCandidate,
  options: Pick<InstallOptions, "appPath" | "targetHome" | "targetUid" | "targetUser">
): boolean {
  let plist: Record<string, unknown>;
  try {
    plist = parsePlist(plistText) as Record<string, unknown>;
  } catch {
    return false;
  }
  const args = Array.isArray(plist.ProgramArguments) ? plist.ProgramArguments : [];
  const executablePath = join(options.appPath, "Contents", "MacOS", "Vigil");
  const exactMainCommand = `${executablePath} --vigil-background ${SYSTEM_GUARDIAN_SAFETY_ARG}`;
  const updaterDirectory = join(options.targetHome, "Library", "Application Support", "Vigil", "updater");
  const userDataDirectory = dirname(updaterDirectory);
  const isPrevious = candidate.label === PREVIOUS_SYSTEM_GUARDIAN_LABEL
    && candidate.plistPath === PREVIOUS_SYSTEM_GUARDIAN_PLIST_PATH
    && candidate.scriptPath === PREVIOUS_SYSTEM_GUARDIAN_SCRIPT_PATH;
  const isLegacy = candidate.label === LEGACY_SYSTEM_GUARDIAN_LABEL
    && candidate.plistPath === LEGACY_SYSTEM_GUARDIAN_PLIST_PATH
    && candidate.scriptPath === LEGACY_SYSTEM_GUARDIAN_SCRIPT_PATH;
  const recoveryAuthorizationPath = isPrevious
    ? PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH
    : LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_PATH;
  const recoveryAuthorizationKind = isPrevious
    ? PREVIOUS_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND
    : LEGACY_SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND;
  const expectedPlistKeys = [
    "KeepAlive",
    "Label",
    "ProcessType",
    "ProgramArguments",
    "RunAtLoad",
    "StandardErrorPath",
    "StandardOutPath",
    "ThrottleInterval"
  ];
  const guardianLogPath = join(SYSTEM_GUARDIAN_ROOT, "guardian.log");
  if ((!isPrevious && !isLegacy)
    || (isPrevious && guardianScriptRevision(script) !== PREVIOUS_SYSTEM_GUARDIAN_REVISION)
    || (isLegacy && guardianScriptRevision(script) !== null)) return false;
  if (JSON.stringify(Object.keys(plist).sort()) !== JSON.stringify(expectedPlistKeys)
    || plist.Label !== candidate.label
    || plist.KeepAlive !== true
    || plist.RunAtLoad !== true
    || plist.ProcessType !== "Background"
    || plist.ThrottleInterval !== 5
    || plist.StandardErrorPath !== guardianLogPath
    || plist.StandardOutPath !== guardianLogPath
    || args.length !== 2
    || args[0] !== candidate.scriptPath
    || args[1] !== SYSTEM_GUARDIAN_SAFETY_ARG
    || !scriptAssignmentMatches(script, "target_uid", String(options.targetUid))
    || !scriptAssignmentMatches(script, "target_user", shellSingleQuote(options.targetUser))
    || !scriptAssignmentMatches(script, "target_home", shellSingleQuote(options.targetHome))
    || !scriptAssignmentMatches(script, "app_path", shellSingleQuote(options.appPath))
    || !scriptAssignmentMatches(script, "executable_path", shellSingleQuote(executablePath))
    || !scriptAssignmentMatches(
      script,
      "process_pattern",
      shellSingleQuote(`^${regexEscape(executablePath)}($| )`)
    )
    || !scriptAssignmentMatches(
      script,
      "supervisor_service",
      shellSingleQuote(`gui/${options.targetUid}/tech.caseline.vigil.supervisor`)
    )
    || !scriptAssignmentMatches(script, "update_lock_path", shellSingleQuote(join(updaterDirectory, "update.lock")))
    || !scriptAssignmentMatches(
      script,
      "maintenance_marker_path",
      shellSingleQuote(join(updaterDirectory, SYSTEM_GUARDIAN_MAINTENANCE_FILENAME))
    )
    || !scriptAssignmentMatches(
      script,
      "root_authorization_path",
      shellSingleQuote(PREVIOUS_SYSTEM_GUARDIAN_AUTHORIZATION_PATH)
    )
    || !scriptAssignmentMatches(script, "root_recovery_authorization_path", shellSingleQuote(recoveryAuthorizationPath))
    || !scriptAssignmentMatches(
      script,
      "global_update_manifest_path",
      shellSingleQuote(join(updaterDirectory, UPDATE_RECOVERY_MANIFEST_FILENAME))
    )
    || !scriptAssignmentMatches(
      script,
      "global_update_policy_path",
      shellSingleQuote(join(updaterDirectory, UPDATE_RECOVERY_POLICY_FILENAME))
    )
    || (isPrevious
      && !scriptAssignmentMatches(script, "exact_main_command", shellSingleQuote(exactMainCommand)))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "bootstrap_authorization_path",
        shellSingleQuote(UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH)
      ))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "bootstrap_claim_path",
        shellSingleQuote(PREVIOUS_UPDATE_PROTOCOL_BOOTSTRAP_CLAIM_PATH)
      ))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "bootstrap_worker_request_path",
        shellSingleQuote(join(updaterDirectory, UPDATE_PROTOCOL_BOOTSTRAP_WORKER_REQUEST_FILENAME))
      ))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "exact_main_process_pattern",
        shellSingleQuote(`^${regexEscape(exactMainCommand)}$`)
      ))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "packaged_updater_script_path",
        shellSingleQuote(join(options.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"))
      ))
    || (isPrevious
      && !scriptAssignmentMatches(
        script,
        "local_updater_script_path",
        shellSingleQuote(join(options.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "scripts", "launch-local-app.mjs"))
      ))
    || (isPrevious && !scriptAssignmentMatches(script, "user_data_dir", shellSingleQuote(userDataDirectory)))
    || (isPrevious
      && !scriptAssignmentMatches(script, "update_status_path", shellSingleQuote(join(updaterDirectory, "update-status.json"))))
    || (isPrevious
      && !scriptAssignmentMatches(script, "update_log_path", shellSingleQuote(join(updaterDirectory, "update.log"))))
    || !script.includes("# VIGIL SAFETY BOUNDARY:")
    || !script.includes(recoveryAuthorizationKind)
    || predecessorGuardianProgramFingerprint(script, isPrevious) !== (isPrevious
      ? PREVIOUS_SYSTEM_GUARDIAN_PROGRAM_SHA256
      : LEGACY_SYSTEM_GUARDIAN_PROGRAM_SHA256)
    || !predecessorAvailabilityProgramMatches(script)) return false;
  return true;
}

export function predecessorGuardianProgramFingerprint(script: string, previous: boolean): string {
  const assignmentNames = previous
    ? PREVIOUS_GUARDIAN_DYNAMIC_ASSIGNMENTS
    : COMMON_PREDECESSOR_DYNAMIC_ASSIGNMENTS;
  const lines = script.split("\n");
  for (const name of assignmentNames) {
    const indexes = lines.flatMap((line, index) => line.startsWith(`${name}=`) ? [index] : []);
    if (indexes.length !== 1) return "";
    lines[indexes[0]] = `${name}=<vigil-config>`;
  }
  return sha256(Buffer.from(lines.join("\n"), "utf8"));
}

export function predecessorAvailabilityProgramMatches(script: string): boolean {
  const reopen = shellFunctionSection(script, "reopen_vigil");
  const authorize = shellFunctionSection(script, "authorize_maintenance_request");
  const writeAuthorization = shellFunctionSection(script, "write_maintenance_authorization");
  const active = shellFunctionSection(script, "authenticated_maintenance_active");
  const attestRecovery = shellFunctionSection(script, "attest_update_recovery");
  const rootRecoveryPresent = shellFunctionSection(script, "root_recovery_attestation_present");
  const attestedGeneration = shellFunctionSection(script, "attested_canonical_app_generation");
  const authorizationWriter = authorize.includes('/bin/mv -f "$authorization_tmp" "$root_authorization_path"')
    ? authorize
    : writeAuthorization;
  const loopStart = script.lastIndexOf("\nwhile true; do\n");
  const loop = loopStart >= 0 ? script.slice(loopStart) : "";
  const beforeLoop = loopStart >= 0 ? script.slice(0, loopStart) : "";
  return guardianTopLevelControlFlowSafe(script)
    && !/^\s*(?:break|continue|exit)(?:\s|$)/mu.test(script)
    && /\n\}\s*$/u.test(beforeLoop)
    && /^reopen_vigil\(\) \{\n\s*\/bin\/launchctl asuser "\$target_uid"[\s\S]*?\/usr\/bin\/sudo -H -u "\$target_user"[\s\S]*?\/usr\/bin\/open -gn "\$app_path" --args --vigil-background --vigil-safety-boundary-do-not-terminate-or-bootout\n\}\s*$/u.test(reopen)
    && guardedMaintenanceRequestMatches(authorize)
    && rootAuthorizationWriterMatches(authorizationWriter)
    && authenticatedMaintenanceProgramMatches(active)
    && /^attest_update_recovery\(\) \{\n\s*global_update_manifest_present \|\| \{ clear_recovery_attestation; return \$\?; \}[\s\S]*?private_target_file "\$global_update_manifest_path" 600 \|\| return 1[\s\S]*?bounded_root_copy "\$global_update_manifest_path" "\$manifest_snapshot" \|\| return 1[\s\S]*?attest_update_recovery_snapshot "\$manifest_snapshot"[\s\S]*?\/bin\/rm -f "\$manifest_snapshot"[\s\S]*?return "\$attestation_status"\n\}\s*$/u.test(attestRecovery)
    && /^root_recovery_attestation_present\(\) \{\n\s*\[\[ -f "\$root_recovery_authorization_path" && ! -L "\$root_recovery_authorization_path" \]\] \|\| return 1[\s\S]*?stat -f '%u' "\$root_recovery_authorization_path"[\s\S]*?== "0" \]\] \|\| return 1[\s\S]*?stat -f '%Lp' "\$root_recovery_authorization_path"[\s\S]*?== "644" \]\] \|\| return 1[\s\S]*?kind\)" == "vigil-root-update-recovery-authorization-v[234]" \]\] \|\| return 1[\s\S]*?recoveryManifestPath\)" == "\$global_update_manifest_path" \]\] \|\| return 1[\s\S]*?recoveryPolicyPath\)" == "\$global_update_policy_path" \]\] \|\| return 1[\s\S]*?recoveryAppPath\)" == "\$app_path" \]\] \|\| return 1[\s\S]*?appInitialPresent\)" == "true" \]\]\n\}\s*$/u.test(rootRecoveryPresent)
    && /^attested_canonical_app_generation\(\) \{\n\s*root_recovery_attestation_present \|\| return 1[\s\S]*?\[\[ -e "\$app_path" && ! -L "\$app_path" \]\] \|\| return 1[\s\S]*?stat -f '%d' "\$app_path"[\s\S]*?stat -f '%i' "\$app_path"[\s\S]*?for generation in Initial Target; do[\s\S]*?expected_dev[\s\S]*?expected_ino[\s\S]*?observed_dev[\s\S]*?observed_ino[\s\S]*?expected_commit[\s\S]*?expected_fingerprint[\s\S]*?app_content_matches "\$app_path"[\s\S]*?\|\| continue[\s\S]*?return 0[\s\S]*?done\s*return 1\n\}\s*$/u.test(attestedGeneration)
    && availabilityLoopMatches(loop);
}

export function guardedMaintenanceRequestMatches(authorize: string): boolean {
  return /^authorize_maintenance_request\(\) \{\n\s*local now="\$1"\s*\n\s*\[\[ -f "\$maintenance_marker_path" && ! -L "\$maintenance_marker_path" \]\] \|\| return 1/u.test(authorize)
    && /\[\[ -f "\$update_lock_path" && ! -L "\$update_lock_path" \]\] \|\| return 1/u.test(authorize)
    && /stat -f '%u' "\$maintenance_marker_path"[\s\S]*?== "\$target_uid" \]\] \|\| return 1/u.test(authorize)
    && /stat -f '%u' "\$update_lock_path"[\s\S]*?== "\$target_uid" \]\] \|\| return 1/u.test(authorize)
    && /marker_kind[\s\S]*?marker_token[\s\S]*?marker_pid[\s\S]*?marker_lock_path[\s\S]*?marker_expires[\s\S]*?lock_token[\s\S]*?lock_pid/u.test(authorize)
    && /marker_kind" == "vigil-maintenance-request-v2" \]\] \|\| return 1/u.test(authorize)
    && /marker_token" == "\$lock_token" \]\] \|\| return 1/u.test(authorize)
    && /marker_pid" == <-> && "\$marker_pid" == "\$lock_pid" \]\] \|\| return 1/u.test(authorize)
    && /marker_lock_path" == "\$update_lock_path" \]\] \|\| return 1/u.test(authorize)
    && /marker_expires >= now/u.test(authorize);
}

export function rootAuthorizationWriterMatches(writer: string): boolean {
  return /authorization_tmp/u.test(writer)
    && /\/usr\/bin\/plutil -create xml1 "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert kind -string "vigil-root-maintenance-authorization-v2" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert token -string "\$marker_token" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert pid -integer "\$marker_pid" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert lockPath -string "\$update_lock_path" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert updaterExecutable -string "\$owner_executable" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert updaterStarted -string "\$owner_started" "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/bin\/plutil -insert expiresAtEpoch -integer [^\n]+ "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/usr\/sbin\/chown 0:0 "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/bin\/chmod 0644 "\$authorization_tmp" \|\| return 1/u.test(writer)
    && /\/bin\/mv -f "\$authorization_tmp" "\$root_authorization_path"\n\}\s*$/u.test(writer);
}

export function authenticatedMaintenanceProgramMatches(active: string): boolean {
  const lines = active.split("\n");
  const standaloneReturns = lines.flatMap((line, index) => /^\s*return\b/u.test(line) ? [index] : []);
  const finalSuccess = standaloneReturns.at(-1);
  const safeStandaloneReturns = finalSuccess !== undefined
    && lines[finalSuccess].trim() === "return 0"
    && standaloneReturns.slice(0, -1).every((index) =>
      lines[index].trim() === "return $?"
        && (lines[index - 1] || "").includes("process_identity_matches")
    );
  const guardedOwner = /owner_command" == "\$authorization_command" \]\] \|\| return 1[\s\S]*?process_identity_matches "\$marker_pid"[\s\S]*?\|\| return 1/u.test(active)
    || /owner_command" == \*"--lock-path \$update_lock_path"\* \]\] \|\| return 1[\s\S]*?owner_command" == \*"--lock-token \$marker_token"\* \]\] \|\| return 1/u.test(active);
  return /^authenticated_maintenance_active\(\) \{\n\s*local now="\$1"\s*\n\s*\[\[ -f "\$maintenance_marker_path" && ! -L "\$maintenance_marker_path" \]\] \|\| return 1/u.test(active)
    && safeStandaloneReturns
    && /\n\s*return 0\n\}\s*$/u.test(active)
    && !/^\s*(?::|true)(?:\s|$)/mu.test(active)
    && /\[\[ -f "\$maintenance_marker_path" && ! -L "\$maintenance_marker_path" \]\] \|\| return 1/u.test(active)
    && /\[\[ -f "\$update_lock_path" && ! -L "\$update_lock_path" \]\] \|\| return 1/u.test(active)
    && /\[\[ -f "\$root_authorization_path" && ! -L "\$root_authorization_path" \]\] \|\| return 1/u.test(active)
    && /stat -f '%u' "\$maintenance_marker_path"[\s\S]*?== "\$target_uid" \]\] \|\| return 1/u.test(active)
    && /stat -f '%u' "\$update_lock_path"[\s\S]*?== "\$target_uid" \]\] \|\| return 1/u.test(active)
    && /stat -f '%u' "\$root_authorization_path"[\s\S]*?== "0" \]\] \|\| return 1/u.test(active)
    && /marker_kind[\s\S]*?marker_token[\s\S]*?marker_pid[\s\S]*?marker_lock_path[\s\S]*?marker_expires[\s\S]*?lock_token[\s\S]*?lock_pid[\s\S]*?authorization_kind[\s\S]*?authorization_token[\s\S]*?authorization_pid[\s\S]*?authorization_lock_path[\s\S]*?authorization_executable[\s\S]*?authorization_started[\s\S]*?authorization_expires/u.test(active)
    && /marker_kind" == "vigil-maintenance-request-v2" \]\] \|\| return 1/u.test(active)
    && /marker_token" == "\$lock_token" \]\] \|\| return 1/u.test(active)
    && /marker_pid" == <-> && "\$marker_pid" == "\$lock_pid" \]\] \|\| return 1/u.test(active)
    && /marker_lock_path" == "\$update_lock_path" \]\] \|\| return 1/u.test(active)
    && /authorization_kind" == "vigil-root-maintenance-authorization-v2" \]\] \|\| return 1/u.test(active)
    && /authorization_token" == "\$marker_token" \]\] \|\| return 1/u.test(active)
    && /authorization_pid" == "\$marker_pid" \]\] \|\| return 1/u.test(active)
    && /authorization_lock_path" == "\$update_lock_path" \]\] \|\| return 1/u.test(active)
    && /authorization_expires >= now/u.test(active)
    && /owner_uid" == "\$target_uid" \]\] \|\| return 1/u.test(active)
    && /owner_executable" == "\$authorization_executable" \]\] \|\| return 1/u.test(active)
    && /owner_started" == "\$authorization_started" \]\] \|\| return 1/u.test(active)
    && guardedOwner;
}

function guardianTopLevelControlFlowSafe(script: string): boolean {
  let insideFunction = false;
  for (const line of script.split("\n")) {
    if (!insideFunction && /^[a-z_][a-z0-9_]*\(\) \{$/u.test(line)) {
      insideFunction = true;
      continue;
    }
    if (insideFunction) {
      if (line === "}") insideFunction = false;
      continue;
    }
    if (/^\s*(?:break|continue|exit|return)(?:\s|$)/u.test(line)) return false;
  }
  return !insideFunction;
}

export function availabilityLoopMatches(loop: string): boolean {
  return /^\nwhile true; do\n\s*now=\$\(\/bin\/date \+%s\)\s*\n\s*app_running=false/u.test(loop)
    && /app_running=false\s*supervisor_loaded=false\s*if \/usr\/bin\/pgrep -U "\$target_uid" -f "\$process_pattern"[^\n]*; then\s*app_running=true\s*offline_since=0\s*elif \[\[ "\$offline_since" -eq 0 \]\]; then\s*offline_since="\$now"\s*fi/u.test(loop)
    && /if \/bin\/launchctl print "\$supervisor_service"[^\n]*; then\s*supervisor_loaded=true\s*fi/u.test(loop)
    && /authorize_maintenance_request "\$now"[^\n]*\s*maintenance_active=false\s*if authenticated_maintenance_active "\$now"; then\s*maintenance_active=true\s*offline_since=0\s*if ! attest_update_recovery; then[\s\S]*?fi\s*elif ! global_update_manifest_present; then[\s\S]*?clear_recovery_attestation[^\n]*\s*fi/u.test(loop)
    && /recovery_waiting=false\s*if \[\[ "\$maintenance_active" == false \]\] && global_update_manifest_present && root_recovery_attestation_present; then[\s\S]*?attested_canonical_app_generation \|\| recovery_waiting=true\s*fi/u.test(loop)
    && /if \[\[ "\$recovery_waiting" == true \]\]; then\s*:[^\n]*\s*elif \[\[ "\$maintenance_active" == false && "\$supervisor_loaded" == false \]\]; then\s*reopen_vigil\s*elif \[\[ "\$maintenance_active" == false && "\$app_running" == false \]\] && \(\( now - offline_since >= 15 \)\); then[\s\S]*?reopen_vigil\s*offline_since="\$now"\s*fi\s*\/bin\/sleep 2\s*done\s*$/u.test(loop);
}

export function shellFunctionSection(script: string, name: string): string {
  const marker = `\n${name}() {\n`;
  const start = script.indexOf(marker);
  if (start < 0) return "";
  const end = script.indexOf("\n}\n", start + marker.length);
  return end < 0 ? "" : script.slice(start + 1, end + 3);
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function readPinnedRootOwnedFile(
  path: string,
  maxBytes: number,
  expectedMode: number
): Promise<{ bytes: Buffer; identity: RootOwnedFileIdentity }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()
      || before.uid !== 0
      || (before.mode & 0o022) !== 0
      || (before.mode & 0o777) !== expectedMode
      || before.size > maxBytes) {
      throw new Error(`Vigil refused an unsafe predecessor guardian file at ${path}.`);
    }
    const bytes = await handle.readFile();
    const [after, pathname] = await Promise.all([handle.stat(), lstat(path)]);
    if (!pathname.isFile()
      || pathname.isSymbolicLink()
      || pathname.uid !== 0
      || (pathname.mode & 0o022) !== 0
      || (pathname.mode & 0o777) !== expectedMode
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.birthtimeMs !== after.birthtimeMs
      || before.ctimeMs !== after.ctimeMs
      || before.mtimeMs !== after.mtimeMs
      || after.dev !== pathname.dev
      || after.ino !== pathname.ino
      || after.size !== pathname.size
      || after.birthtimeMs !== pathname.birthtimeMs
      || after.ctimeMs !== pathname.ctimeMs
      || after.mtimeMs !== pathname.mtimeMs
      || bytes.length !== after.size) {
      throw new Error(`Vigil refused a changing predecessor guardian file at ${path}.`);
    }
    return {
      bytes,
      identity: {
        birthtimeMs: after.birthtimeMs,
        ctimeMs: after.ctimeMs,
        dev: after.dev,
        ino: after.ino,
        mode: after.mode & 0o777,
        mtimeMs: after.mtimeMs,
        sha256: sha256(bytes),
        size: after.size
      }
    };
  } finally {
    await handle.close();
  }
}

function sameRootOwnedFileIdentity(left: RootOwnedFileIdentity, right: RootOwnedFileIdentity): boolean {
  return left.birthtimeMs === right.birthtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256
    && left.size === right.size;
}

function launchctlFieldMatches(output: string, field: string, expected: string): boolean {
  return output.split("\n").filter((line) => line.trim() === `${field} = ${expected}`).length === 1;
}

function scriptAssignmentMatches(script: string, name: string, expected: string): boolean {
  return script.split("\n").filter((line) => line === `${name}=${expected}`).length === 1;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function assertLoadedGuardianTopology(serviceOutput: string, expectedPlist: string): Promise<void> {
  const [installedPlist, plistStat] = await Promise.all([
    readFile(SYSTEM_GUARDIAN_PLIST_PATH, "utf8"),
    lstat(SYSTEM_GUARDIAN_PLIST_PATH)
  ]);
  if (!plistStat.isFile()
    || plistStat.isSymbolicLink()
    || plistStat.uid !== 0
    || (plistStat.mode & 0o022) !== 0) {
    throw new Error("Vigil refused to refresh an unsafe loaded guardian launch configuration.");
  }
  if (installedPlist !== expectedPlist
    || !serviceOutput.includes(`path = ${SYSTEM_GUARDIAN_PLIST_PATH}`)
    || !serviceOutput.includes(`program = ${SYSTEM_GUARDIAN_SCRIPT_PATH}`)
    || !/^\s*state = running\s*$/mu.test(serviceOutput)
    || !/^\s*pid = \d+\s*$/mu.test(serviceOutput)) {
    throw new Error("Vigil's loaded guardian topology cannot be refreshed automatically without unloading protection.");
  }
}

async function bootstrapSystemGuardian(): Promise<void> {
  await runLaunchctl(["enable", `system/${SYSTEM_GUARDIAN_LABEL}`]);
  await runLaunchctl(["bootstrap", "system", SYSTEM_GUARDIAN_PLIST_PATH]);
  // RunAtLoad starts this new parallel guardian. Never kickstart or replace an
  // already-running Vigil availability process.
  await waitForSystemGuardianRunning(null);
}

async function collectRollbackError(errors: unknown[], operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

async function waitForSystemGuardianRunning(previousPid: number | null): Promise<void> {
  const deadline = Date.now() + 5_000;
  let stability: GuardianRunningStabilityState = { pid: null, since: 0 };
  do {
    try {
      const service = await inspectSystemGuardianService();
      const observation = observeGuardianRunningStability(stability, service, previousPid, Date.now());
      stability = observation.state;
      if (observation.stable) return;
    } catch {
      // launchd may briefly remove the old job before publishing its replacement.
      stability = { pid: null, since: 0 };
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Vigil installed the system guardian but launchd did not report it running.");
}

function launchctlServiceMissing(error: unknown): boolean {
  return /could not find service|service not found|no such process/iu.test(commandErrorText(error));
}

function commandErrorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error || "Unknown launchctl error.");
  const record = error as { message?: unknown; stderr?: unknown };
  return `${String(record.stderr || "")}\n${String(record.message || "")}`.trim() || "Unknown launchctl error.";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown guardian setup error.");
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

if (isDirectRun(import.meta.url)) {
  await installSystemGuardian();
  console.log(process.argv.includes("--json")
    ? JSON.stringify({ ok: true, label: SYSTEM_GUARDIAN_LABEL, running: true })
    : `Installed and started ${SYSTEM_GUARDIAN_LABEL}.`);
}
