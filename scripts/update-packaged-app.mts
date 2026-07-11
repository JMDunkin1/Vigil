import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { fetchSentinelStateHealth } from "../src/sentinelHealth.js";
import { isDirectRun } from "../src/directRun.js";
import { plistStringForKey } from "../src/plist.js";

interface Options {
  repoRoot: string;
  appPath: string;
  parentPid: number;
  statusPath: string;
  logPath: string;
  lockPath: string;
  lockToken: string;
  restart: boolean;
}

interface StagedBuild {
  root: string;
  repoRoot: string;
  builtAppPath: string;
  expectedCommit: string;
  initialCommit: string;
}

interface BackendHealthContext {
  port: number;
  instanceSecret: string;
}

export interface AppInstallation {
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface AtomicInstallOperations {
  pathExists(path: string): Promise<boolean>;
  copy(source: string, destination: string): Promise<void>;
  move(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const FETCH_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 30_000;
let options: Options;
let log: ReturnType<typeof createWriteStream>;
let activeChild: ChildProcess | null = null;
let interrupted = false;

if (isDirectRun(import.meta.url)) await runUpdate();

async function runUpdate(): Promise<void> {
  let stagedBuild: StagedBuild | null = null;
  let appInstallation: AppInstallation | null = null;
  let runtimeInstallation: AppInstallation | null = null;
  let parentExited = false;
  let replacementCommitted = false;
  let launchAgentWasPresent = false;

  try {
    options = parseArgs(process.argv.slice(2));
    await mkdir(dirname(options.statusPath), { recursive: true });
    await mkdir(dirname(options.logPath), { recursive: true });
    log = createWriteStream(options.logPath, { flags: "a" });
    installSignalHandlers();
    await assertOwnedUpdaterLock();
    await assertLocallyRebuildableApp();

    await status("waiting", "Waiting for Sentinel to quit");
    await waitForExit(options.parentPid, 45_000);
    parentExited = true;

    const dirty = (await capture("git", ["status", "--porcelain=v1"], { cwd: options.repoRoot })).trim().length > 0;
    if (dirty) throw new Error("Sentinel source has uncommitted changes. Commit or stash them before installing an update.");

    stagedBuild = await buildInIsolatedWorktree();

    await status("exporting-ios-policy", "Refreshing ManageEngine iPhone policy artifact");
    await run("node", ["dist/runtime/scripts/export-manageengine-ios-profile.mjs", "--current-state"], {
      cwd: stagedBuild.repoRoot,
      env: manageEngineExportEnv()
    });

    await assertActiveCheckoutUnchanged(stagedBuild);
    await status("installing-runtime", "Staging the rebuilt Sentinel background runtime");
    runtimeInstallation = await atomicInstallBuiltApp(
      join(stagedBuild.repoRoot, "dist", "runtime"),
      join(options.repoRoot, "dist", "runtime"),
      ""
    );
    await verifyBuildInfo(
      join(options.repoRoot, "dist", "runtime", "build-info.json"),
      stagedBuild.expectedCommit,
      "installed Sentinel runtime"
    );

    await status("installing-app", "Installing the rebuilt Sentinel app");
    appInstallation = await atomicInstallBuiltApp(stagedBuild.builtAppPath, options.appPath, "");
    await verifyInstalledAppBuild(stagedBuild.expectedCommit);

    launchAgentWasPresent = await launchAgentExists();
    const backend = launchAgentWasPresent ? await restartLaunchAgent() : null;
    if (!options.restart) throw new Error("Sentinel app replacement verification requires --restart.");
    await status("verifying", "Reopening and verifying the rebuilt Sentinel app");
    await openAndVerifyReplacement(backend || await defaultBackendHealthContext());

    await assertActiveCheckoutUnchanged(stagedBuild);
    await status("updating-source", "Fast-forwarding Sentinel source to the verified build");
    try {
      await run("git", ["merge", "--ff-only", stagedBuild.expectedCommit], { cwd: options.repoRoot });
      replacementCommitted = true;
    } catch (error) {
      replacementCommitted = await activeHeadMatches(stagedBuild.expectedCommit);
      throw error;
    }

    const appToFinalize = appInstallation;
    const runtimeToFinalize = runtimeInstallation;
    appInstallation = null;
    runtimeInstallation = null;
    const cleanupErrors = await finalizeInstallations([appToFinalize, runtimeToFinalize]);
    const message = cleanupErrors.length
      ? `Sentinel update complete. Cleanup warning: ${cleanupErrors.join(" ")}`
      : "Sentinel update complete";
    await status("complete", message, { ok: true, finishedAt: new Date().toISOString() });
  } catch (error) {
    let message = errorMessage(error);
    if (!parentExited && typeof options !== "undefined" && options.restart) {
      parentExited = await parentExitedSoon(options.parentPid, 2_000);
    }
    if (!replacementCommitted) {
      const recoveryErrors = await recoverFailedUpdate({
        appInstallation,
        runtimeInstallation,
        parentExited,
        launchAgentWasPresent
      });
      if (recoveryErrors.length) message = `${message} Recovery also failed: ${recoveryErrors.join(" ")}`;
    }
    await safeStatus("failed", message, {
      ok: false,
      error: message,
      finishedAt: new Date().toISOString()
    });
    process.exitCode = 1;
  } finally {
    if (stagedBuild) await cleanupStagedBuild(stagedBuild);
    if (typeof options !== "undefined") await releaseOwnedUpdaterLock();
    log?.end();
  }
}

async function buildInIsolatedWorktree(): Promise<StagedBuild> {
  await status("fetching", "Checking for newer Sentinel source");
  await run("git", ["fetch", "--prune"], { cwd: options.repoRoot, timeoutMs: FETCH_TIMEOUT_MS });
  const [initialCommit, expectedCommit] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], { cwd: options.repoRoot }),
    capture("git", ["rev-parse", "@{u}"], { cwd: options.repoRoot })
  ]).then((values) => values.map((value) => value.trim()));
  if (!/^[a-f0-9]{40}$/iu.test(initialCommit) || !/^[a-f0-9]{40}$/iu.test(expectedCommit)) {
    throw new Error("Sentinel could not verify the source commits selected for this update.");
  }
  const fastForward = await run("git", ["merge-base", "--is-ancestor", initialCommit, expectedCommit], {
    allowFailure: true,
    capture: true,
    cwd: options.repoRoot
  });
  if (!fastForward.ok) throw new Error("Sentinel source cannot be fast-forwarded to its upstream commit.");

  const root = await mkdtemp(join(dirname(options.statusPath), "staged-update-"));
  const repoRoot = join(root, "source");
  try {
    await status("staging", "Creating an isolated Sentinel source checkout");
    await run("git", ["worktree", "add", "--detach", repoRoot, expectedCommit], { cwd: options.repoRoot });

    await status("installing", "Installing locked Sentinel dependencies in the staged checkout");
    await run(npmExecutable(), ["ci"], { cwd: repoRoot });

    await status("building", "Building the Sentinel runtime in the staged checkout");
    await run(npmExecutable(), ["run", "build"], { cwd: repoRoot });
    await verifyBuildInfo(
      join(repoRoot, "dist", "runtime", "build-info.json"),
      expectedCommit,
      "rebuilt Sentinel runtime"
    );

    const outputPath = join(repoRoot, "dist", "update-mac");
    await rm(outputPath, { recursive: true, force: true });
    await status("packaging", "Packaging a staged Sentinel app");
    await run(npmExecutable(), [
      "exec", "--", "electron-builder", "--mac", "dir",
      "-c.mac.identity=null",
      "-c.asarUnpack=dist.nosync/runtime/**/*",
      "-c.directories.output=dist/update-mac"
    ], { cwd: repoRoot });

    const builtAppPath = join(outputPath, process.arch === "arm64" ? "mac-arm64" : "mac", "Sentinel.app");
    if (!(await pathExists(builtAppPath))) throw new Error(`Rebuilt Sentinel app was not found at ${builtAppPath}`);
    await verifyBuildInfo(
      join(builtAppPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
      expectedCommit,
      "staged Sentinel app"
    );
    return { root, repoRoot, builtAppPath, expectedCommit, initialCommit };
  } catch (error) {
    await cleanupStagedBuild({ root, repoRoot, builtAppPath: "", expectedCommit, initialCommit });
    throw error;
  }
}

async function assertActiveCheckoutUnchanged(stagedBuild: StagedBuild): Promise<void> {
  const [head, dirty] = await Promise.all([
    capture("git", ["rev-parse", "HEAD"], { cwd: options.repoRoot }),
    capture("git", ["status", "--porcelain=v1"], { cwd: options.repoRoot })
  ]);
  if (head.trim() !== stagedBuild.initialCommit || dirty.trim()) {
    throw new Error("Sentinel source changed while the update was being prepared. Nothing was installed permanently.");
  }
}

export async function atomicInstallBuiltApp(
  builtAppPath: string,
  appPath: string,
  cleanupPath: string,
  operations: AtomicInstallOperations = defaultInstallOperations
): Promise<AppInstallation> {
  if (resolve(builtAppPath) === resolve(appPath)) {
    throw new Error("The staged Sentinel app must be separate from the installed app.");
  }

  const nextAppPath = `${appPath}.sentinel-next`;
  const previousAppPath = `${appPath}.sentinel-previous`;
  if (await operations.pathExists(previousAppPath)) {
    throw new Error(`A previous Sentinel recovery copy still exists at ${previousAppPath}.`);
  }
  let backedUp = false;
  let installed = false;
  try {
    await operations.remove(nextAppPath);
    await operations.copy(builtAppPath, nextAppPath);
    if (await operations.pathExists(appPath)) {
      await operations.move(appPath, previousAppPath);
      backedUp = true;
    }
    await operations.move(nextAppPath, appPath);
    installed = true;
  } catch (error) {
    if (backedUp) {
      if (await operations.pathExists(appPath)) await operations.remove(appPath);
      if (await operations.pathExists(previousAppPath)) await operations.move(previousAppPath, appPath);
    }
    throw error;
  } finally {
    await operations.remove(nextAppPath);
  }

  let settled = false;
  return {
    async finalize() {
      if (settled) return;
      await operations.remove(previousAppPath);
      if (cleanupPath) await operations.remove(cleanupPath);
      settled = true;
    },
    async rollback() {
      if (settled) return;
      if (backedUp) {
        if (!(await operations.pathExists(previousAppPath))) {
          throw new Error(`Sentinel recovery copy is missing at ${previousAppPath}; the installed copy was left untouched.`);
        }
        if (await operations.pathExists(appPath)) await operations.remove(appPath);
        await operations.move(previousAppPath, appPath);
      } else if (installed && await operations.pathExists(appPath)) {
        await operations.remove(appPath);
      }
      if (cleanupPath) await operations.remove(cleanupPath);
      settled = true;
    }
  };
}

const defaultInstallOperations: AtomicInstallOperations = {
  pathExists,
  async copy(source, destination) {
    await cp(source, destination, { recursive: true, preserveTimestamps: true });
  },
  async move(source, destination) {
    await rename(source, destination);
  },
  async remove(path) {
    await rm(path, { recursive: true, force: true });
  }
};

async function recoverFailedUpdate({
  appInstallation,
  runtimeInstallation,
  parentExited,
  launchAgentWasPresent
}: {
  appInstallation: AppInstallation | null;
  runtimeInstallation: AppInstallation | null;
  parentExited: boolean;
  launchAgentWasPresent: boolean;
}): Promise<string[]> {
  const errors: string[] = [];
  if (appInstallation) await collectRecoveryError(errors, "Could not stop the rebuilt app.", terminateInstalledApp());
  if (appInstallation) await collectRecoveryError(errors, "Could not restore the previous app.", appInstallation.rollback());
  if (runtimeInstallation) await collectRecoveryError(errors, "Could not restore the previous runtime.", runtimeInstallation.rollback());
  if (launchAgentWasPresent && runtimeInstallation) {
    await collectRecoveryError(errors, "Could not restart the previous background service.", restartLaunchAgent().then(() => undefined));
  }
  if (parentExited && options.restart) {
    await collectRecoveryError(errors, "Could not reopen the existing app.", run("/usr/bin/open", [options.appPath]).then(() => undefined));
  }
  return errors;
}

async function collectRecoveryError(errors: string[], prefix: string, operation: Promise<void>): Promise<void> {
  try {
    await operation;
  } catch (error) {
    errors.push(`${prefix} ${errorMessage(error)}`);
  }
}

async function finalizeInstallations(installations: Array<AppInstallation | null>): Promise<string[]> {
  const errors: string[] = [];
  for (const installation of installations) {
    if (!installation) continue;
    try {
      await installation.finalize();
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  return errors;
}

async function verifyInstalledAppBuild(expectedCommit: string): Promise<void> {
  await verifyBuildInfo(
    join(options.appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json"),
    expectedCommit,
    "installed Sentinel app"
  );
}

export async function verifyBuildInfo(path: string, expectedCommit: string, label = "Sentinel build"): Promise<void> {
  let buildInfo: { commit?: unknown; dirty?: unknown };
  try {
    buildInfo = JSON.parse(await readFile(path, "utf8")) as { commit?: unknown; dirty?: unknown };
  } catch {
    throw new Error(`The ${label} is missing valid build metadata.`);
  }
  if (buildInfo.commit !== expectedCommit || buildInfo.dirty !== false) {
    throw new Error(`The ${label} does not match the verified source commit.`);
  }
}

async function assertLocallyRebuildableApp(): Promise<void> {
  if (!(await pathExists(options.appPath))) return;
  const result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", options.appPath], {
    allowFailure: true,
    capture: true
  });
  const detail = `${result.stdout}\n${result.stderr}`;
  if (!result.ok && /code object is not signed at all/iu.test(detail)) return;
  if (!result.ok) throw new Error("Sentinel could not verify the installed app signature, so the update was stopped.");
  if (!/\bSignature=adhoc\b/u.test(detail)) {
    throw new Error("This Sentinel app has a distribution signature. Install a complete signed release instead of rebuilding it in place.");
  }
}

async function restartLaunchAgent(): Promise<BackendHealthContext | null> {
  const home = process.env.HOME;
  const uid = process.getuid?.();
  if (!home || uid === undefined) throw new Error("Sentinel could not identify the current user to restart its background service.");
  const plistPath = join(home, "Library", "LaunchAgents", "com.sentinel.agent.plist");
  if (!(await pathExists(plistPath))) return null;
  const plist = await readFile(plistPath, "utf8");
  const context = await backendHealthContext(plist);

  const restartedAfter = Date.now();
  await status("restarting-agent", "Restarting the Sentinel background service");
  await run("/bin/launchctl", ["kickstart", "-k", `gui/${uid}/com.sentinel.agent`]);
  await waitForLaunchAgent(restartedAfter, context);
  return context;
}

async function launchAgentExists(): Promise<boolean> {
  const home = process.env.HOME;
  return Boolean(home && await pathExists(join(home, "Library", "LaunchAgents", "com.sentinel.agent.plist")));
}

async function backendHealthContext(plist: string): Promise<BackendHealthContext> {
  const configuredPort = process.env.SENTINEL_PORT
    || process.env.SCREEN_TIME_PORT
    || plistStringForKey(plist, "SENTINEL_PORT")
    || plistStringForKey(plist, "SCREEN_TIME_PORT")
    || "8787";
  const port = validPort(configuredPort);
  const dataDir = process.env.SENTINEL_DATA_DIR || plistStringForKey(plist, "SENTINEL_DATA_DIR");
  if (!dataDir) throw new Error("The Sentinel LaunchAgent data directory could not be verified.");
  return { port, instanceSecret: await getInstanceSecret(dataDir) };
}

async function defaultBackendHealthContext(): Promise<BackendHealthContext> {
  const home = process.env.HOME;
  const dataDir = process.env.SENTINEL_DATA_DIR || (home ? join(home, "Library", "Application Support", "Sentinel") : "");
  if (!dataDir) throw new Error("Sentinel could not identify its data directory for the replacement health check.");
  return {
    port: validPort(process.env.SENTINEL_PORT || process.env.SCREEN_TIME_PORT || "8787"),
    instanceSecret: await getInstanceSecret(dataDir)
  };
}

function validPort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("Sentinel has an invalid server port.");
  return port;
}

async function waitForLaunchAgent(restartedAfter: number, context: BackendHealthContext): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const health = await fetchSentinelStateHealth(`http://127.0.0.1:${context.port}/api/state`, {
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
    await delay(500);
  }
  throw new Error("The updated Sentinel background service did not become healthy in time.");
}

async function openAndVerifyReplacement(context: BackendHealthContext): Promise<void> {
  await run("/usr/bin/open", [options.appPath]);
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let healthySince = 0;
  while (Date.now() < deadline) {
    const [pids, backendHealthy] = await Promise.all([
      installedAppProcessIds(),
      backendIsHealthy(context)
    ]);
    if (pids.length && backendHealthy) {
      if (!healthySince) healthySince = Date.now();
      if (Date.now() - healthySince >= 1_500) return;
    } else {
      healthySince = 0;
    }
    await delay(500);
  }
  throw new Error("The rebuilt Sentinel app or backend did not remain healthy after launch.");
}

async function backendIsHealthy(context: BackendHealthContext): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const health = await fetchSentinelStateHealth(`http://127.0.0.1:${context.port}/api/health`, {
      signal: controller.signal,
      expectedPort: context.port,
      instanceSecret: context.instanceSecret
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function installedAppProcessIds(): Promise<number[]> {
  const executableName = basename(options.appPath, ".app");
  const executablePath = join(options.appPath, "Contents", "MacOS", executableName);
  const processes = await capture("/bin/ps", ["-axo", "pid=,command="], { cwd: dirname(options.appPath) });
  const pids: number[] = [];
  for (const line of processes.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/u);
    if (!match) continue;
    const command = match[2];
    if (command !== executablePath && !command.startsWith(`${executablePath} `)) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

async function terminateInstalledApp(): Promise<void> {
  const pids = await installedAppProcessIds();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (!isErrorCode(error, "ESRCH")) throw error;
    }
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!(await installedAppProcessIds()).length) return;
    await delay(100);
  }
  throw new Error("The rebuilt Sentinel app did not stop for rollback.");
}

async function cleanupStagedBuild(stagedBuild: StagedBuild): Promise<void> {
  if (await pathExists(stagedBuild.repoRoot)) {
    try {
      await run("git", ["worktree", "remove", "--force", stagedBuild.repoRoot], {
        allowFailure: true,
        cwd: options.repoRoot,
        ignoreInterruption: true
      });
    } catch {
      // The temporary directory removal below is still safe.
    }
  }
  await rm(stagedBuild.root, { recursive: true, force: true });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    if (interrupted) throw new Error("Sentinel update was interrupted.");
    await delay(500);
  }
  throw new Error("Sentinel did not quit in time.");
}

async function parentExitedSoon(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await delay(100);
  }
  return !processExists(pid);
}

async function activeHeadMatches(expectedCommit: string): Promise<boolean> {
  try {
    const result = await run("git", ["rev-parse", "HEAD"], {
      allowFailure: true,
      capture: true,
      cwd: options.repoRoot,
      ignoreInterruption: true
    });
    return result.ok && result.stdout.trim() === expectedCommit;
  } catch {
    return false;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrorCode(error, "EPERM");
  }
}

async function assertOwnedUpdaterLock(): Promise<void> {
  let payload: { token?: unknown };
  try {
    payload = JSON.parse(await readFile(options.lockPath, "utf8")) as { token?: unknown };
  } catch {
    throw new Error("Sentinel updater lock is missing or unreadable.");
  }
  if (payload.token !== options.lockToken) throw new Error("Sentinel updater lock ownership could not be verified.");
}

async function releaseOwnedUpdaterLock(): Promise<void> {
  try {
    const payload = JSON.parse(await readFile(options.lockPath, "utf8")) as { token?: unknown };
    if (payload.token === options.lockToken) await rm(options.lockPath, { force: true });
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) log?.write(`Could not release updater lock: ${errorMessage(error)}\n`);
  }
}

function installSignalHandlers(): void {
  const interrupt = () => {
    interrupted = true;
    if (activeChild?.pid) stopChild(activeChild.pid, "SIGTERM");
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
}

async function capture(
  command: string,
  args: string[],
  runOptions: { cwd?: string; timeoutMs?: number } = {}
): Promise<string> {
  const result = await run(command, args, { ...runOptions, capture: true });
  return result.stdout;
}

async function run(
  command: string,
  args: string[],
  optionsForRun: {
    allowFailure?: boolean;
    capture?: boolean;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ignoreInterruption?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (interrupted && !optionsForRun.ignoreInterruption) throw new Error("Sentinel update was interrupted.");
  return await new Promise((resolveRun, rejectRun) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: optionsForRun.cwd || options.repoRoot,
      env: optionsForRun.env || process.env,
      detached: Boolean(optionsForRun.timeoutMs),
      stdio: ["ignore", "pipe", "pipe"]
    });
    activeChild = child;
    let stdout = "";
    let stderr = "";
    const timeout = optionsForRun.timeoutMs ? setTimeout(() => {
      if (settled) return;
      settled = true;
      stopChild(child.pid, "SIGTERM");
      activeChild = null;
      log.write(`${command} ${args.join(" ")} timed out after ${optionsForRun.timeoutMs}ms\n`);
      if (optionsForRun.allowFailure) {
        resolveRun({ ok: false, stdout: optionsForRun.capture ? stdout : "", stderr: "Command timed out" });
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
      stderr += chunk;
      log.write(chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      if (timeout) clearTimeout(timeout);
      rejectRun(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      activeChild = null;
      if (timeout) clearTimeout(timeout);
      if (interrupted && !optionsForRun.ignoreInterruption) {
        rejectRun(new Error("Sentinel update was interrupted."));
      } else if (code === 0 || optionsForRun.allowFailure) {
        resolveRun({ ok: code === 0, stdout: optionsForRun.capture ? stdout : "", stderr: optionsForRun.capture ? stderr : "" });
      } else {
        rejectRun(new Error(`${command} ${args.join(" ")} failed with exit code ${code}`));
      }
    });
  });
}

function manageEngineExportEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.SENTINEL_DATA_DIR && env.HOME) {
    env.SENTINEL_DATA_DIR = join(env.HOME, "Library", "Application Support", "Sentinel");
  }
  return env;
}

function npmExecutable(): string {
  const command = process.env.SENTINEL_UPDATE_NPM_PATH || "npm";
  if (command !== "npm" && resolve(command) !== command) {
    throw new Error("Sentinel updater received an invalid npm executable path.");
  }
  return command;
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

async function safeStatus(phase: string, message: string, extra: Record<string, unknown>): Promise<void> {
  try {
    await status(phase, message, extra);
  } catch (error) {
    log?.write(`Could not persist updater status: ${errorMessage(error)}\n`);
  }
}

async function status(phase: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  log.write(`[${now}] ${phase}: ${message}\n`);
  const temporaryPath = `${options.statusPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ phase, message, updatedAt: now, ...extra }, null, 2)}\n`);
  await rename(temporaryPath, options.statusPath);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
  const parentPid = Number(required(optionsMap, "parent-pid"));
  if (!Number.isInteger(parentPid) || parentPid <= 0) throw new Error("--parent-pid must be a positive process ID");
  return {
    repoRoot: required(optionsMap, "repo-root"),
    appPath: required(optionsMap, "app-path"),
    parentPid,
    statusPath: required(optionsMap, "status-path"),
    logPath: required(optionsMap, "log-path"),
    lockPath: required(optionsMap, "lock-path"),
    lockToken: required(optionsMap, "lock-token"),
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
