import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isDirectRun } from "../src/directRun.js";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";
import { atomicInstallBuiltApp } from "./update-packaged-app.mjs";

const HEALTH_TIMEOUT_MS = 30_000;

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  npmPath: string;
  logPath: string;
}

if (isDirectRun(import.meta.url)) await main();

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a" });
  await waitForLogOpen(log);
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

    log.write(`[${new Date().toISOString()}] Local build is ready. Asking Vigil to quit for replacement.\n`);
    process.kill(options.parentPid, "SIGUSR2");
    try {
      await waitForExit(options.parentPid, 45_000);
    } catch (error) {
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
      await reopenInstalledApp(options.appPath, log);
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
      await terminateInstalledApp(options.appPath);
      await installation.rollback();
      await reopenInstalledApp(options.appPath, log);
      process.exitCode = 1;
    }
  } finally {
    log.end();
  }
}

async function verifyReplacement(appPath: string): Promise<void> {
  const dataDir = process.env.VIGIL_DATA_DIR || join(homedir(), "Library", "Application Support", "Vigil");
  const port = Number(process.env.VIGIL_PORT || "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Vigil has an invalid server port.");
  const instanceSecret = await getInstanceSecret(dataDir);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let healthySince = 0;
  while (Date.now() < deadline) {
    const [running, healthy] = await Promise.all([
      installedAppIsRunning(appPath),
      backendIsHealthy(port, instanceSecret)
    ]);
    if (running && healthy) {
      if (!healthySince) healthySince = Date.now();
      if (Date.now() - healthySince >= 1_500) return;
    } else {
      healthySince = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The rebuilt Vigil app or backend did not remain healthy after launch.");
}

async function backendIsHealthy(port: number, instanceSecret: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const health = await fetchVigilStateHealth(`http://127.0.0.1:${port}/api/health`, {
      signal: controller.signal,
      expectedPort: port,
      instanceSecret
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function installedAppIsRunning(appPath: string): Promise<boolean> {
  return (await installedAppProcessIds(appPath)).length > 0;
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
  await new Promise<void>((resolve, reject) => {
    const child = spawn("/usr/bin/open", ["-g", appPath], { stdio: ["ignore", log, log] });
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
    npmPath: required(values, "npm-path"),
    logPath: values.get("log-path") || join(homedir(), "Library", "Logs", "Vigil", "local-launch.log")
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
