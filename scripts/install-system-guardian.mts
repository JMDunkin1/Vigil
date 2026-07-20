import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { isDirectRun } from "../src/directRun.js";
import {
  SYSTEM_GUARDIAN_LABEL,
  SYSTEM_GUARDIAN_PLIST_PATH,
  SYSTEM_GUARDIAN_ROOT,
  SYSTEM_GUARDIAN_SCRIPT_PATH,
  systemGuardianPlist,
  systemGuardianScript
} from "../src/systemGuardian.js";

const execFileAsync = promisify(execFile);

export async function installSystemGuardian(argv = process.argv.slice(2)): Promise<void> {
  if (process.getuid?.() !== 0) {
    throw new Error("Installing Vigil's system guardian requires administrator privileges (run this command with sudo).");
  }
  const options = parseOptions(argv);
  const script = systemGuardianScript(options);
  await mkdir(SYSTEM_GUARDIAN_ROOT, { recursive: true, mode: 0o755 });
  await validateGuardianRoot();
  const transactionId = `${process.pid}-${randomUUID()}`;
  const files: StagedRootOwnedFile[] = [];
  try {
    files.push(await stageRootOwnedFile(SYSTEM_GUARDIAN_SCRIPT_PATH, script, 0o755, transactionId));
    files.push(await stageRootOwnedFile(SYSTEM_GUARDIAN_PLIST_PATH, systemGuardianPlist(), 0o644, transactionId));
  } catch (error) {
    await discardStagedFiles(files);
    throw error;
  }

  try {
    // Reject malformed candidates while the installed guardian and its live
    // launchd job are untouched.
    await Promise.all([
      validateStagedRootOwnedFile(files[0], 0o755),
      validateStagedRootOwnedFile(files[1], 0o644)
    ]);
    await execFileAsync("/bin/zsh", ["-n", files[0].stagedPath], { timeout: 5_000 });
    await execFileAsync("/usr/bin/plutil", ["-lint", files[1].stagedPath], { timeout: 5_000 });
  } catch (error) {
    await discardStagedFiles(files);
    throw error;
  }

  let launchdTransitionStarted = false;
  try {
    for (const file of files) await activateStagedFile(file);
    launchdTransitionStarted = true;
    await bootoutSystemGuardianIfLoaded();
    await bootstrapSystemGuardian();
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (launchdTransitionStarted) {
      await collectRollbackError(rollbackErrors, bootoutSystemGuardianIfLoaded());
    }
    for (const file of [...files].reverse()) {
      await collectRollbackError(rollbackErrors, restorePreviousFile(file));
    }
    if (launchdTransitionStarted && files[1].hadPrevious) {
      await collectRollbackError(rollbackErrors, bootstrapSystemGuardian());
    }
    await collectRollbackError(rollbackErrors, discardStagedFiles(files));
    if (rollbackErrors.length) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Vigil's system guardian installation failed and the previous guardian could not be fully restored."
      );
    }
    throw error;
  }

  await discardStagedFiles(files);
}

interface InstallOptions {
  appPath: string;
  targetHome: string;
  targetUid: number;
  targetUser: string;
}

function parseOptions(argv: string[]): InstallOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals >= 0) values.set(argument.slice(2, equals), argument.slice(equals + 1));
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
  return { appPath, targetHome, targetUid, targetUser };
}

interface StagedRootOwnedFile {
  activated: boolean;
  backupPath: string;
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
  return { activated: false, backupPath, hadPrevious: false, path, stagedPath };
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

async function activateStagedFile(file: StagedRootOwnedFile): Promise<void> {
  try {
    const previousStat = await lstat(file.path);
    if (!previousStat.isFile() || previousStat.isSymbolicLink() || previousStat.uid !== 0) {
      throw new Error(`Vigil refused to replace an unsafe installed guardian file at ${file.path}.`);
    }
    await rename(file.path, file.backupPath);
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

async function bootoutSystemGuardianIfLoaded(): Promise<void> {
  try {
    await execFileAsync("/bin/launchctl", ["bootout", `system/${SYSTEM_GUARDIAN_LABEL}`], { timeout: 5_000 });
  } catch (error) {
    if (launchctlServiceMissing(error)) return;
    throw error;
  }
}

async function bootstrapSystemGuardian(): Promise<void> {
  await runLaunchctl(["enable", `system/${SYSTEM_GUARDIAN_LABEL}`]);
  await runLaunchctl(["bootstrap", "system", SYSTEM_GUARDIAN_PLIST_PATH]);
  // bootstrap + RunAtLoad already starts the daemon. Some macOS releases send
  // SIGTERM to the transient launchctl client during a successful -k replace,
  // so final launchd state—not kickstart's client status—is authoritative.
  await runLaunchctl(["kickstart", "-k", `system/${SYSTEM_GUARDIAN_LABEL}`], true);
  await waitForSystemGuardianRunning();
}

async function collectRollbackError(errors: unknown[], operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(error);
  }
}

async function waitForSystemGuardianRunning(): Promise<void> {
  const deadline = Date.now() + 5_000;
  do {
    try {
      const { stdout } = await execFileAsync("/bin/launchctl", ["print", `system/${SYSTEM_GUARDIAN_LABEL}`], { timeout: 5_000 });
      if (/^\s*state = running\s*$/mu.test(stdout)) return;
    } catch {
      // launchd may briefly remove the old job before publishing its replacement.
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

if (isDirectRun(import.meta.url)) {
  await installSystemGuardian();
  console.log(`Installed and started ${SYSTEM_GUARDIAN_LABEL}.`);
}
