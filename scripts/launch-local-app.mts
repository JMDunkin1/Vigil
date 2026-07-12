import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isDirectRun } from "../src/directRun.js";

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
  await waitForExit(options.parentPid, 45_000);
  await mkdir(dirname(options.logPath), { recursive: true });
  const log = createWriteStream(options.logPath, { flags: "a" });
  log.write(`\n[${new Date().toISOString()}] Launching Sentinel from ${options.repoRoot}\n`);
  try {
    let exitCode: number | null = 1;
    try {
      exitCode = await runLocalApp(options, log);
    } catch (error) {
      log.write(`[${new Date().toISOString()}] Local Sentinel could not start: ${errorMessage(error)}\n`);
    }
    if (exitCode === 0) return;
    log.write(`[${new Date().toISOString()}] Local Sentinel exited with status ${exitCode}. Reopening ${options.appPath}.\n`);
    await reopenInstalledApp(options.appPath, log);
    process.exitCode = exitCode ?? 1;
  } finally {
    log.end();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runLocalApp(options: Options, log: ReturnType<typeof createWriteStream>): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const child = spawn(options.npmPath, ["run", "app"], {
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
  throw new Error("Sentinel did not quit in time to launch local changes.");
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
    logPath: values.get("log-path") || join(homedir(), "Library", "Logs", "Sentinel", "local-launch.log")
  };
}

function required(values: Map<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}
