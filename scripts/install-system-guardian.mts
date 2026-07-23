import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import { verifyUpdateProtocolBridgeEquivalence } from "./package-update-protocol-bridge.mjs";
import {
  SYSTEM_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_PLIST_PATH,
  SYSTEM_GUARDIAN_ROOT,
  SYSTEM_GUARDIAN_SCRIPT_PATH,
  systemGuardianPlist,
  systemGuardianScript
} from "../src/systemGuardian.js";
import {
  guardianScriptRevision,
  SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND,
  SYSTEM_GUARDIAN_REVISION,
  UPDATE_PACKAGED_APP_RECOVERY_PROTOCOL_REVISION,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_KIND,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_MAX_SECONDS,
  UPDATE_PROTOCOL_BOOTSTRAP_AUTHORIZATION_PATH
} from "../src/updateMaintenance.js";

const execFileAsync = promisify(execFile);
const DEFAULT_TARGET_APP_PATH = "/Applications/Vigil.app";
export const SYSTEM_GUARDIAN_STABILITY_MS = 500;

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
    const serviceBeforeActivation = await inspectSystemGuardianService();
    if (serviceBeforeActivation.loaded) {
      throw new Error(
        "Vigil's parallel v3 guardian loaded while setup was being prepared. Its running files were left untouched."
      );
    }
    activationStarted = true;
    for (const file of files) await activateStagedFile(file);
    await verifyActivatedFiles(files);
    serviceBootstrapAttempted = true;
    await bootstrapSystemGuardian();
    await verifyActivatedFiles(files);
  } catch (error) {
    if (serviceBootstrapAttempted) {
      await discardStagedFiles(files).catch(() => undefined);
      throw new Error(
        `${errorMessage(error)} Vigil preserved the new parallel guardian files and never stopped either guardian; launchd can finish starting the v3 service safely.`
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
      throw new Error("Vigil refused authorization-only setup because its parallel v3 guardian is not running.");
    }
    await assertLoadedGuardianTopology(service.output, expectedPlist);
    const installed = await readFile(SYSTEM_GUARDIAN_SCRIPT_PATH, "utf8");
    const revision = guardianScriptRevision(installed);
    if (revision === null
      || revision < SYSTEM_GUARDIAN_REVISION
      || !installed.includes(SYSTEM_GUARDIAN_RECOVERY_AUTHORIZATION_KIND)) {
      throw new Error("Vigil refused authorization-only setup for a guardian without the required v3 protocol.");
    }
    return;
  }
  if (service.loaded) {
    throw new Error("Vigil refused to restart a loaded guardian while adding the parallel v3 update boundary.");
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
    throw new Error("Vigil's parallel v3 guardian appeared after setup was authorized. Nothing was replaced.");
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

async function inspectSystemGuardianService(): Promise<SystemGuardianServiceInspection> {
  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `system/${SYSTEM_GUARDIAN_LABEL}`], {
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
