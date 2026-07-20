import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDirectRun } from "../src/directRun.js";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { plistStringForKey } from "../src/plist.js";
import { liveRuntimeReady } from "../src/runtimeReady.js";
import { resumeEmbeddedRuntimeSupervisor, suspendEmbeddedRuntimeSupervisor } from "../src/embeddedSupervisor.js";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";
import { beginGuardianMaintenance } from "../src/updateMaintenance.js";
import type { GuardianMaintenanceTransaction } from "../src/updateMaintenance.js";
import { atomicInstallBuiltApp } from "./update-packaged-app.mjs";

const HEALTH_TIMEOUT_MS = 30_000;
const BACKGROUND_LAUNCH_ARG = "--vigil-background";
const SAFETY_BOUNDARY_ARG = "--vigil-safety-boundary-do-not-terminate-or-bootout";

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  userDataDir: string;
  npmPath: string;
  logPath: string;
  lockPath: string;
  lockToken: string;
}

interface LegacyAgentRecovery {
  context: {
    port: number;
    instanceSecret: string;
  };
  plist: string;
  plistMode: number;
  plistPath: string;
  uid: number;
}

if (isDirectRun(import.meta.url)) await main();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a" });
  await waitForLogOpen(log);
  let guardianMaintenance: GuardianMaintenanceTransaction | null = null;
  log.write(`\n[${new Date().toISOString()}] Building local changes while Vigil process ${options.parentPid} keeps running.\n`);
  try {
    log.write(`[${new Date().toISOString()}] Building packaged Vigil from ${options.repoRoot}\n`);
    let exitCode: number | null = 1;
    try {
      exitCode = await buildLocalApp(options, log);
    } catch (error) {
      log.write(`[${new Date().toISOString()}] Local Vigil could not be built: ${errorMessage(error)}\n`);
    }
    if (exitCode !== 0) {
      log.write(`[${new Date().toISOString()}] Local Vigil build exited with status ${exitCode}. The running app was left in place.\n`);
      process.exitCode = exitCode ?? 1;
      return;
    }

    let legacyAgent: LegacyAgentRecovery | null;
    try {
      legacyAgent = await captureLegacyLaunchAgentRecovery();
    } catch (error) {
      log.write(`[${new Date().toISOString()}] The legacy Vigil background service could not be prepared for rollback: ${errorMessage(error)} The running app was left in place.\n`);
      process.exitCode = 1;
      return;
    }

    try {
      guardianMaintenance = await beginGuardianMaintenance(options.lockPath, options.lockToken);
    } catch (error) {
      log.write(`[${new Date().toISOString()}] The authenticated guardian maintenance transaction could not start: ${errorMessage(error)} The running app was left in place.\n`);
      process.exitCode = 1;
      return;
    }
    log.write(`[${new Date().toISOString()}] Local build is ready. Asking Vigil to quit for replacement.\n`);
    process.kill(options.parentPid, "SIGUSR2");
    try {
      await waitForExit(options.parentPid, 45_000);
    } catch (error) {
      await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
      log.write(`[${new Date().toISOString()}] ${errorMessage(error)} The built app was not installed.\n`);
      process.exitCode = 1;
      return;
    }

    const builtAppPath = join(
      options.repoRoot,
      "dist",
      "mac.noindex",
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "Vigil.app"
    );
    let installation: Awaited<ReturnType<typeof atomicInstallBuiltApp>>;
    try {
      installation = await atomicInstallBuiltApp(builtAppPath, options.appPath, "");
    } catch (error) {
      log.write(`[${new Date().toISOString()}] Rebuilt Vigil could not be installed: ${errorMessage(error)} Reopening ${options.appPath}.\n`);
      let persistentRecovery = false;
      try {
        await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
        persistentRecovery = true;
      } catch (supervisorError) {
        log.write(`[${new Date().toISOString()}] Restart supervision could not be restored: ${errorMessage(supervisorError)}\n`);
        if (legacyAgent) {
          try {
            await restoreLegacyLaunchAgent(legacyAgent);
            persistentRecovery = true;
          } catch (legacyError) {
            log.write(`[${new Date().toISOString()}] The legacy Vigil background service could not be restored: ${errorMessage(legacyError)}\n`);
          }
        }
      }
      try {
        await reopenInstalledApp(options.appPath, log);
      } catch (reopenError) {
        log.write(`[${new Date().toISOString()}] The restored Vigil app could not be reopened: ${errorMessage(reopenError)}${persistentRecovery ? " Persistent supervision will keep enforcement running and retry the app launch." : ""}\n`);
      }
      process.exitCode = 1;
      return;
    }
    try {
      log.write(`[${new Date().toISOString()}] Reopening rebuilt Vigil at ${options.appPath}.\n`);
      await reopenInstalledApp(options.appPath, log);
      await verifyReplacement(options.appPath);
      await installation.finalize();
    } catch (error) {
      log.write(`[${new Date().toISOString()}] Rebuilt Vigil could not reopen: ${errorMessage(error)} Restoring the previous app.\n`);
      try {
        await suspendEmbeddedRuntimeSupervisor(options.userDataDir);
        await terminateInstalledApp(options.appPath);
        await installation.rollback();
        if (legacyAgent) {
          await restoreLegacyLaunchAgent(legacyAgent);
        } else {
          await resumeEmbeddedRuntimeSupervisor(options.userDataDir);
        }
        await reopenInstalledApp(options.appPath, log);
      } catch (recoveryError) {
        log.write(`[${new Date().toISOString()}] Rebuilt Vigil could not be safely rolled back: ${errorMessage(recoveryError)}\n`);
      }
      process.exitCode = 1;
    }
  } finally {
    if (guardianMaintenance) {
      await guardianMaintenance.release().catch((error) => {
        log.write(`[${new Date().toISOString()}] The guardian maintenance marker could not be cleared: ${errorMessage(error)}\n`);
      });
    }
    await releaseOwnedUpdaterLock(options.lockPath, options.lockToken).catch((error) => {
      log.write(`[${new Date().toISOString()}] The updater lock could not be released: ${errorMessage(error)}\n`);
    });
    log.end();
  }
}

async function captureLegacyLaunchAgentRecovery(): Promise<LegacyAgentRecovery | null> {
  const home = process.env.HOME || homedir();
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Vigil could not identify the current user for background-service recovery.");
  const plistPath = join(home, "Library", "LaunchAgents", "com.vigil.agent.plist");
  let plist: string;
  let plistMode: number;
  try {
    const [contents, plistStat] = await Promise.all([readFile(plistPath, "utf8"), lstat(plistPath)]);
    plist = contents;
    plistMode = plistStat.mode & 0o777;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  const configuredPort = process.env.VIGIL_PORT || plistStringForKey(plist, "VIGIL_PORT") || "8787";
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("The legacy Vigil background service has an invalid port.");
  const dataDir = process.env.VIGIL_DATA_DIR || plistStringForKey(plist, "VIGIL_DATA_DIR");
  if (!dataDir) throw new Error("The legacy Vigil background service data directory could not be verified.");
  return {
    context: { port, instanceSecret: await getInstanceSecret(dataDir) },
    plist,
    plistMode,
    plistPath,
    uid
  };
}

async function restoreLegacyLaunchAgent(recovery: LegacyAgentRecovery | null): Promise<void> {
  if (!recovery) return;
  const restartedAfter = Date.now();
  for (const args of [
    ["bootout", `gui/${recovery.uid}/com.vigil.agent`],
    ["bootout", `gui/${recovery.uid}`, recovery.plistPath]
  ]) {
    await runCommand("/bin/launchctl", args, true);
  }
  await mkdir(dirname(recovery.plistPath), { recursive: true });
  await writeFile(recovery.plistPath, recovery.plist, { mode: recovery.plistMode });
  await runCommand("/bin/launchctl", ["enable", `gui/${recovery.uid}/com.vigil.agent`]);
  await runCommand("/bin/launchctl", ["bootstrap", `gui/${recovery.uid}`, recovery.plistPath]);
  await runCommand("/bin/launchctl", ["kickstart", "-k", `gui/${recovery.uid}/com.vigil.agent`]);
  await waitForLegacyLaunchAgent(restartedAfter, recovery.context);
}

async function waitForLegacyLaunchAgent(
  restartedAfter: number,
  context: LegacyAgentRecovery["context"]
): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const health = await fetchVigilStateHealth(`http://127.0.0.1:${context.port}/api/state`, {
        signal: controller.signal,
        expectedPort: context.port,
        instanceSecret: context.instanceSecret
      });
      const body = health.ok && "body" in health ? health.body as { app?: { startedAt?: unknown } } : null;
      const startedAt = Date.parse(String(body?.app?.startedAt || ""));
      if (Number.isFinite(startedAt) && startedAt >= restartedAfter) return;
    } catch {
      // Retried until the bounded deadline.
    } finally {
      clearTimeout(timeout);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The restored Vigil background service did not become healthy in time.");
}

async function runCommand(command: string, args: string[], allowFailure = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 || allowFailure
      ? resolve()
      : reject(new Error(`${command} exited with status ${code}: ${stderr.trim() || "Unknown error"}`)));
  });
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function verifyReplacement(appPath: string): Promise<void> {
  const dataDir = process.env.VIGIL_DATA_DIR || join(homedir(), "Library", "Application Support", "Vigil");
  const launchedAfter = Date.now() - 2_000;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let healthySince = 0;
  while (Date.now() < deadline) {
    const [pids, ready] = await Promise.all([
      installedAppProcessIds(appPath),
      liveRuntimeReady(dataDir, launchedAfter)
    ]);
    const running = Boolean(ready && pids.includes(ready.pid) && ready.appPath === join(appPath, "Contents", "MacOS", basename(appPath, ".app")));
    const healthy = ready?.transport === "in-app";
    if (running && healthy) {
      if (!healthySince) healthySince = Date.now();
      if (Date.now() - healthySince >= 1_500) return;
    } else {
      healthySince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The rebuilt Vigil app or its private enforcement runtime did not remain healthy after launch.");
}

async function installedAppProcessIds(appPath: string): Promise<number[]> {
  const executablePath = join(appPath, "Contents", "MacOS", basename(appPath, ".app"));
  const processes = await captureProcessList();
  const pids: number[] = [];
  for (const line of processes.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match || (match[2] !== executablePath && !match[2].startsWith(`${executablePath} `))) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function terminateInstalledApp(appPath: string): Promise<void> {
  for (const pid of await installedAppProcessIds(appPath)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await installedAppProcessIds(appPath)).length) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The rebuilt Vigil process did not stop before rollback.");
}

async function captureProcessList(): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = spawn("/bin/ps", ["-axo", "pid=,command="], { stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(`ps exited with status ${code}`)));
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForLogOpen(log: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolveOpen, rejectOpen) => {
    log.once("open", () => resolveOpen());
    log.once("error", rejectOpen);
  });
}

async function buildLocalApp(options: Options, log: ReturnType<typeof createWriteStream>): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.npmPath, ["run", "build:mac"], {
      cwd: options.repoRoot,
      stdio: ["ignore", log, log],
      env: process.env
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
}

async function reopenInstalledApp(appPath: string, log: ReturnType<typeof createWriteStream>): Promise<void> {
  const account = userInfo();
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", appPath, "--args", BACKGROUND_LAUNCH_ARG, SAFETY_BOUNDARY_ARG], {
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        HOME: account.homedir,
        USER: account.username,
        LOGNAME: account.username,
        PATH: `${join(account.homedir, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
      }
    });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`open exited with status ${code}`)));
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Vigil did not quit in time to launch local changes.");
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    values.set(String(args[index] || "").replace(/^--/u, ""), args[index + 1] || "");
  }
  const parentPid = Number(required(values, "parent-pid"));
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid must be a positive process ID");
  return {
    repoRoot: required(values, "repo-root"),
    appPath: required(values, "app-path"),
    parentPid,
    userDataDir: required(values, "user-data-dir"),
    npmPath: required(values, "npm-path"),
    logPath: values.get("log-path") || join(homedir(), "Library", "Logs", "Vigil", "local-launch.log"),
    lockPath: required(values, "lock-path"),
    lockToken: required(values, "lock-token")
  };
}

async function releaseOwnedUpdaterLock(lockPath: string, lockToken: string): Promise<void> {
  let payload: { token?: unknown; pid?: unknown };
  try {
    payload = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown; pid?: unknown };
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    throw error;
  }
  if (payload.token === lockToken && payload.pid === process.pid) {
    await rm(lockPath, { force: true });
  }
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
