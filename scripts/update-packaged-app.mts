import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  statusPath: string;
  logPath: string;
  restart: boolean;
}

const options = parseArgs(process.argv.slice(2));
const log = createWriteStream(options.logPath, { flags: "a" });
const FETCH_TIMEOUT_MS = 8_000;

try {
  await mkdir(dirname(options.statusPath), { recursive: true });
  await mkdir(dirname(options.logPath), { recursive: true });
  await status("waiting", "Waiting for Vigil to quit");
  await waitForExit(options.parentPid, 45_000);

  await status("fetching", "Checking for newer Vigil source");
  await run("git", ["fetch", "--prune"], { allowFailure: true, timeoutMs: FETCH_TIMEOUT_MS });

  const dirty = (await capture("git", ["status", "--porcelain=v1"])).trim().length > 0;
  if (!dirty) {
    await status("pulling", "Fast-forwarding Vigil source");
    await run("git", ["merge", "--ff-only", "@{u}"], { allowFailure: true });
  } else {
    await status("rebuilding", "Rebuilding current checkout");
  }

  await status("building", "Building Vigil runtime");
  await run("npm", ["run", "build"]);

  await status("packing", "Refreshing packaged Vigil app");
  await refreshPackagedApp();

  if (options.restart) {
    await status("relaunching", "Reopening Vigil");
    await run("/usr/bin/open", [options.appPath]);
  }
  await status("complete", "Vigil update complete", { ok: true, finishedAt: new Date().toISOString() });
} catch (error) {
  await status("failed", errorMessage(error), {
    ok: false,
    error: errorMessage(error),
    finishedAt: new Date().toISOString()
  });
  process.exitCode = 1;
} finally {
  log.end();
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await delay(500);
  }
  throw new Error("Vigil did not quit in time.");
}

async function refreshPackagedApp(): Promise<void> {
  const stagePath = join(options.repoRoot, "dist", "_asar-stage");
  const runtimePath = join(options.repoRoot, "dist", "runtime");
  const appResourcesPath = join(options.appPath, "Contents", "Resources");
  const unpackedRuntimePath = join(appResourcesPath, "app.asar.unpacked", "dist", "runtime");
  const asarBinPath = join(options.repoRoot, "node_modules", "@electron", "asar", "bin", "asar.js");

  await rm(stagePath, { recursive: true, force: true });
  await mkdir(join(stagePath, "dist"), { recursive: true });
  await cp(join(options.repoRoot, "package.json"), join(stagePath, "package.json"));
  await cp(runtimePath, join(stagePath, "dist", "runtime"), { recursive: true });
  await run("node", [asarBinPath, "pack", stagePath, join(appResourcesPath, "app.asar")]);

  await rm(unpackedRuntimePath, { recursive: true, force: true });
  await mkdir(dirname(unpackedRuntimePath), { recursive: true });
  await cp(runtimePath, unpackedRuntimePath, { recursive: true });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function capture(command: string, args: string[]): Promise<string> {
  const result = await run(command, args, { capture: true });
  return result.stdout;
}

async function run(
  command: string,
  args: string[],
  optionsForRun: { allowFailure?: boolean; capture?: boolean; timeoutMs?: number } = {}
): Promise<{ stdout: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.repoRoot,
      env: process.env,
      detached: Boolean(optionsForRun.timeoutMs),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    const timeout = optionsForRun.timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      stopChild(child.pid, "SIGTERM");
      log.write(`${command} ${args.join(" ")} timed out after ${optionsForRun.timeoutMs}ms\n`);
      if (optionsForRun.allowFailure) {
        resolveRun({ stdout: optionsForRun.capture ? stdout : "" });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} timed out after ${optionsForRun.timeoutMs}ms`));
      }
    }, optionsForRun.timeoutMs) : null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      log.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (code === 0 || optionsForRun.allowFailure) {
        resolveRun({ stdout: optionsForRun.capture ? stdout : "" });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

function stopChild(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Process already exited.
    }
  }
}

async function status(phase: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  log.write(`[${now}] ${phase}: ${message}\n`);
  await writeFile(options.statusPath, `${JSON.stringify({
    phase,
    message,
    updatedAt: now,
    ...extra
  }, null, 2)}\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function parseArgs(args: string[]): Options {
  const optionsMap = new Map<string, string>();
  let restart = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--restart") {
      restart = true;
      continue;
    }
    if (arg.startsWith("--")) {
      optionsMap.set(arg.slice(2), args[index + 1] || "");
      index += 1;
    }
  }
  return {
    repoRoot: required(optionsMap, "repo-root"),
    appPath: required(optionsMap, "app-path"),
    parentPid: Number(required(optionsMap, "parent-pid")),
    statusPath: required(optionsMap, "status-path"),
    logPath: required(optionsMap, "log-path"),
    restart
  };
}

function required(optionsMap: Map<string, string>, key: string): string {
  const value = optionsMap.get(key);
  if (!value) throw new Error(`Missing --${key}`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
