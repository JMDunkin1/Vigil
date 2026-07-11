import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRun } from "../src/directRun.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

interface RunNodeOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  executable?: string;
  killGraceMs?: number;
  killWaitMs?: number;
  stdio?: "ignore" | "inherit";
  timeoutMs?: number;
}

interface RunSuitesOptions extends RunNodeOptions {
  dataRoot?: string;
  displayRoot?: string;
  log?: (message: string) => void;
}

export interface TestRunResult {
  total: number;
  failed: number;
  exitCode: number;
  results: Array<{ suite: string; code: number }>;
}

export async function discoverSuites(projectRoot = root): Promise<string[]> {
  const testsDir = join(projectRoot, "tests");
  const entries = await readdir(testsDir, { withFileTypes: true });
  const testSuites = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => join(testsDir, entry.name));
  if (!testSuites.length) throw new Error(`No compiled test suites found in ${testsDir}.`);
  return testSuites.sort();
}

export async function runSuites(suites: readonly string[], options: RunSuitesOptions = {}): Promise<TestRunResult> {
  if (!suites.length) throw new Error("No test suites were provided.");
  const projectRoot = options.displayRoot || options.cwd || root;
  const log = options.log || console.log;
  const results: TestRunResult["results"] = [];

  for (const [index, suite] of suites.entries()) {
    log(`\n> ${relative(projectRoot, suite)}`);
    const suiteEnv = options.dataRoot
      ? {
          ...process.env,
          ...options.env,
          VIGIL_DATA_DIR: join(options.dataRoot, String(index).padStart(3, "0"))
        }
      : options.env;
    const code = await runNode(suite, { ...options, env: suiteEnv });
    results.push({ suite, code });
  }

  const failed = results.filter((result) => result.code !== 0).length;
  return {
    total: results.length,
    failed,
    exitCode: failed ? 1 : 0,
    results
  };
}

export function runNode(file: string, options: RunNodeOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKill: NodeJS.Timeout | undefined;
    let finalFallback: NodeJS.Timeout | undefined;
    let timedOut = false;
    const timeoutMs = options.timeoutMs ?? 120_000;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(forceKill);
      clearTimeout(finalFallback);
      resolve(code);
    };

    try {
      const child = spawn(options.executable || process.execPath, [file], {
        cwd: options.cwd || root,
        env: options.env,
        stdio: options.stdio || "inherit",
        detached: process.platform !== "win32"
      });
      const processGroupId = child.pid;
      timeout = setTimeout(() => {
        timedOut = true;
        terminateChild(child, "SIGTERM", processGroupId);
        forceKill = setTimeout(() => {
          terminateChild(child, "SIGKILL", processGroupId);
          finalFallback = setTimeout(() => finish(1), options.killWaitMs ?? 1_000);
        }, options.killGraceMs ?? 2_000);
      }, timeoutMs);
      child.once("error", () => {
        if (!timedOut) finish(1);
      });
      child.once("close", (code, signal) => {
        if (timedOut) return;
        if (signal || code === null) {
          finish(1);
          return;
        }
        finish(code);
      });
    } catch {
      finish(1);
    }
  });
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals, processGroupId = child.pid): void {
  try {
    if (process.platform !== "win32" && processGroupId) process.kill(-processGroupId, signal);
    else child.kill(signal);
  } catch {
    child.kill(signal);
  }
}

async function main(): Promise<void> {
  const suites = await discoverSuites(root);
  const dataRoot = await mkdtemp(join(tmpdir(), "vigil-test-data-"));
  try {
    const result = await runSuites(suites, { cwd: root, displayRoot: root, dataRoot });
    if (result.failed) {
      console.error(`\n${result.failed} of ${result.total} test suite(s) failed.`);
      process.exitCode = result.exitCode;
      return;
    }
    console.log(`\n${result.total} test suite(s) passed.`);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
}

if (isDirectRun(import.meta.url)) await main();
