import type { App } from "electron";
import { isLocallyRebuildableSignature } from "../scripts/mac-signing-identity.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plistStringForKey } from "../src/plist.js";

const UPDATE_STATUS_FILENAME = "update-status.json";
const UPDATE_LOG_FILENAME = "update.log";
const UPDATE_LOCK_FILENAME = "update.lock";
const EXEC_TIMEOUT_MS = 5000;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RepoInfo {
  ok: boolean;
  error: string | null;
  repoRoot: string;
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
}

interface BuildInfo {
  builtAt?: string;
  commit?: string;
  branch?: string;
  dirty?: boolean;
  sourceRoot?: string;
}

interface LastUpdateStatus {
  ok?: boolean;
  phase?: string;
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  error?: string;
}

interface UpdateLockPayload {
  token: string;
  pid: number;
  startedAt: string;
}

export interface UpdaterLock {
  path: string;
  token: string;
  transferTo(pid: number): Promise<void>;
  release(): Promise<void>;
}

export interface SentinelAppUpdateController {
  status(options?: { checkRemote?: boolean }): Promise<unknown>;
  start(): Promise<unknown>;
}

interface ControllerOptions {
  app: App;
  quitForUpdate(): void;
}

const moduleDir = dirname(fileURLToPath(import.meta.url));

export function createSentinelAppUpdateController({ app, quitForUpdate }: ControllerOptions): SentinelAppUpdateController {
  const repoRoot = findRepoRoot(app);
  const appPath = packagedAppPath(repoRoot);
  const updateDir = join(app.getPath("userData"), "updater");
  const statusPath = join(updateDir, UPDATE_STATUS_FILENAME);
  const logPath = join(updateDir, UPDATE_LOG_FILENAME);
  const lockPath = join(updateDir, UPDATE_LOCK_FILENAME);
  const scriptPath = updateScriptPath(repoRoot);
  let startInFlight: Promise<unknown> | null = null;

  async function readStatusPayload(
    { checkRemote = false, ownedLockToken = "" }: { checkRemote?: boolean; ownedLockToken?: string } = {}
  ): Promise<Record<string, unknown>> {
    await mkdir(updateDir, { recursive: true });
    const remoteCheck = checkRemote ? await execGit(repoRoot, ["fetch", "--prune"]) : null;
    const [repo, runtimeBuild, appBuild, appStat, lastUpdate, activeLock] = await Promise.all([
      readRepoInfo(repoRoot),
      readBuildInfo(join(repoRoot, "dist", "runtime", "build-info.json")),
      readFirstBuildInfo([
        join(appPath, "Contents", "Resources", "app.asar", "dist", "runtime", "build-info.json"),
        join(appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json")
      ]),
      optionalStat(join(appPath, "Contents", "Resources", "app.asar")),
      readLastUpdate(statusPath),
      readActiveUpdaterLock(lockPath)
    ]);
    const running = Boolean(activeLock && activeLock.token !== ownedLockToken);
    const appCommit = appBuild?.commit || null;
    const currentCommit = repo.ok ? repo.head : runtimeBuild?.commit || "";
    const appBundleOutdated = repo.ok && (Boolean(currentCommit && appCommit && appCommit !== currentCommit) || Boolean(currentCommit && !appCommit));
    const remoteCheckOk = remoteCheck ? remoteCheck.ok : null;
    const checkOk = repo.ok && (repo.dirty || remoteCheckOk !== false);
    const supported = repo.ok && Boolean(scriptPath);
    const updateAvailable = Boolean(checkOk && supported && (repo.dirty || repo.behind > 0 || appBundleOutdated));
    return {
      ok: checkOk,
      supported,
      running,
      updateAvailable,
      appBundleOutdated,
      repoRoot,
      appPath,
      branch: repo.branch,
      currentCommit,
      upstreamCommit: repo.upstream,
      ahead: repo.ahead,
      behind: repo.behind,
      dirty: repo.dirty,
      repoError: repo.error,
      runtimeBuiltAt: runtimeBuild?.builtAt || null,
      appBuiltAt: appBuild?.builtAt || null,
      appBundleModifiedAt: appStat?.mtime.toISOString() || null,
      remoteCheckedAt: checkRemote ? new Date().toISOString() : null,
      remoteCheckOk,
      remoteCheckError: remoteCheck && !remoteCheck.ok ? "Remote check failed" : null,
      logPath,
      lastUpdate,
      message: updateMessage({ repo, appBundleOutdated, running, remoteCheckError: remoteCheck && !remoteCheck.ok })
    };
  }

  return {
    async status(options = {}) {
      return await readStatusPayload(options);
    },
    async start() {
      if (startInFlight) {
        return { ok: false, running: true, error: "A Sentinel update is already starting." };
      }
      startInFlight = startOnce();
      try {
        return await startInFlight;
      } finally {
        startInFlight = null;
      }
    }
  };

  async function startOnce(): Promise<unknown> {
    await mkdir(updateDir, { recursive: true });
    let updateLock: UpdaterLock;
    try {
      updateLock = await acquireUpdaterLock(lockPath);
    } catch (error) {
      return { ok: false, running: true, error: errorMessage(error) };
    }
    let handedOff = false;
    let startedAt = "";
    let currentStatus: Record<string, unknown> = {};
    let updaterChild: ReturnType<typeof spawn> | null = null;
    try {
      currentStatus = await readStatusPayload({ ownedLockToken: updateLock.token });
      if (currentStatus.ok !== true) {
        return { ...currentStatus, ok: false, error: "The Sentinel source repository could not be verified." };
      }
      if (currentStatus.supported !== true || !scriptPath) {
        return { ok: false, supported: false, error: "Updater script is missing from this Sentinel build." };
      }
      if (currentStatus.dirty) {
        const result = await launchLocalChanges(currentStatus, updateLock);
        if (result.ok === true) handedOff = true;
        return result;
      }
      currentStatus = await readStatusPayload({ checkRemote: true, ownedLockToken: updateLock.token });
      if (currentStatus.ok !== true || currentStatus.remoteCheckOk !== true) {
        return { ...currentStatus, ok: false, error: "Sentinel could not verify remote updates. Nothing was changed." };
      }
      if (currentStatus.dirty) {
        return { ...currentStatus, ok: false, error: "Commit or stash local changes before installing a Sentinel update." };
      }
      if (!currentStatus.updateAvailable) {
        return { ...currentStatus, ok: false, error: "No Sentinel update is available." };
      }
      const [nodePath, npmPath] = await Promise.all([
        findExecutable(repoRoot, "node"),
        findExecutable(repoRoot, "npm")
      ]);
      if (!nodePath || !npmPath) {
        return { ...currentStatus, ok: false, error: "Node.js and npm are required to rebuild Sentinel, but they were not found." };
      }
      const updaterSyntax = await execFile(nodePath, ["--check", scriptPath], { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
      if (!updaterSyntax.ok) {
        return { ...currentStatus, ok: false, error: "The packaged Sentinel updater failed its preflight check." };
      }
      await assertLocallyRebuildableApp(appPath);
      startedAt = new Date().toISOString();
      await writeFile(statusPath, `${JSON.stringify({
        ok: true,
        phase: "starting",
        message: "Preparing Sentinel update",
        startedAt,
        updatedAt: startedAt
      }, null, 2)}\n`);
      const command = [
        scriptPath,
        "--repo-root", repoRoot,
        "--app-path", appPath,
        "--parent-pid", String(process.pid),
        "--status-path", statusPath,
        "--log-path", logPath,
        "--lock-path", lockPath,
        "--lock-token", updateLock.token,
        "--restart"
      ];
      updaterChild = spawn(nodePath, command, {
        detached: true,
        stdio: "ignore",
        cwd: repoRoot,
        env: {
          ...process.env,
          SENTINEL_UPDATE_LAUNCHED_BY: "sentinel-app",
          SENTINEL_UPDATE_NPM_PATH: npmPath
        }
      });
      await childStarted(updaterChild);
      if (!updaterChild.pid) throw new Error("The updater process did not report a process ID.");
      await updateLock.transferTo(updaterChild.pid);
      handedOff = true;
      updaterChild.unref();
      setTimeout(quitForUpdate, 200);
      return {
        ok: true,
        supported: true,
        phase: "starting",
        message: "Sentinel will quit, update, and reopen.",
        logPath
      };
    } catch (error) {
      if (updaterChild && !handedOff) stopUpdaterChild(updaterChild.pid);
      const message = errorMessage(error) || "The updater process could not start.";
      const now = new Date().toISOString();
      await writeFile(statusPath, `${JSON.stringify({
        ok: false,
        phase: "failed",
        message,
        error: message,
        ...(startedAt ? { startedAt } : {}),
        updatedAt: now,
        finishedAt: now
      }, null, 2)}\n`);
      return { ...currentStatus, ok: false, error: message };
    } finally {
      if (!handedOff) await updateLock.release();
    }
  }

  async function launchLocalChanges(currentStatus: Record<string, unknown>, updateLock: UpdaterLock): Promise<Record<string, unknown>> {
    const [nodePath, npmPath] = await Promise.all([findExecutable(repoRoot, "node"), findExecutable(repoRoot, "npm")]);
    const launcherPath = localLauncherPath(repoRoot);
    if (!nodePath || !npmPath || !launcherPath) {
      return { ...currentStatus, ok: false, error: "Node.js, npm, and the local launcher are required to run Sentinel changes." };
    }
    const syntax = await execFile(nodePath, ["--check", launcherPath], { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
    if (!syntax.ok) return { ...currentStatus, ok: false, error: "The Sentinel local launcher failed its preflight check." };
    const child = spawn(nodePath, [
      launcherPath,
      "--repo-root", repoRoot,
      "--app-path", appPath,
      "--parent-pid", String(process.pid),
      "--npm-path", npmPath
    ], { detached: true, stdio: "ignore", cwd: repoRoot, env: process.env });
    await childStarted(child);
    if (!child.pid) throw new Error("The local launcher did not report a process ID.");
    await updateLock.transferTo(child.pid);
    child.unref();
    setTimeout(quitForUpdate, 200);
    return { ok: true, supported: true, phase: "starting", message: "Sentinel will reopen with local changes." };
  }
}

function findRepoRoot(app: App): string {
  const candidates = [
    process.env.SENTINEL_SOURCE_ROOT || "",
    launchAgentRepoRoot(app),
    packagedBuildRepoRoot(app),
    process.cwd(),
    app.isPackaged ? resolve(process.resourcesPath, "../../../../../..") : "",
    app.isPackaged ? resolve(process.resourcesPath, "../../../../..") : "",
    resolve(moduleDir, "../..")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isRepoRoot(candidate)) return candidate;
  }
  return process.cwd();
}

function packagedBuildRepoRoot(app: App): string {
  if (!app.isPackaged) return "";
  for (const path of [
    join(process.resourcesPath, "app.asar.unpacked", "dist", "runtime", "build-info.json"),
    join(process.resourcesPath, "app.asar", "dist", "runtime", "build-info.json")
  ]) {
    try {
      const info = JSON.parse(readFileSync(path, "utf8")) as BuildInfo;
      if (typeof info.sourceRoot === "string") return info.sourceRoot;
    } catch {
      // Try the next packaged build metadata location.
    }
  }
  return "";
}

function launchAgentRepoRoot(app: App): string {
  try {
    const plistPath = join(app.getPath("home"), "Library", "LaunchAgents", "com.sentinel.agent.plist");
    const plist = readFileSync(plistPath, "utf8");
    return plistStringForKey(plist, "SentinelSourceRoot") || plistStringForKey(plist, "WorkingDirectory");
  } catch {
    return "";
  }
}

function isRepoRoot(candidate: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8")) as { name?: string };
    return pkg.name === "sentinel" && existsSync(join(candidate, "app", "main.ts"));
  } catch {
    return false;
  }
}

function packagedAppPath(repoRoot: string): string {
  if (process.platform === "darwin" && process.execPath.includes(".app/Contents/MacOS/")) {
    return dirname(dirname(dirname(process.execPath)));
  }
  return join(repoRoot, "dist", "mac.noindex", process.arch === "arm64" ? "mac-arm64" : "mac", "Sentinel.app");
}

function updateScriptPath(repoRoot: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"),
    join(repoRoot, "dist", "runtime", "scripts", "update-packaged-app.mjs")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

function localLauncherPath(repoRoot: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "app.asar.unpacked", "dist", "runtime", "scripts", "launch-local-app.mjs"),
    join(repoRoot, "dist", "runtime", "scripts", "launch-local-app.mjs")
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

async function readRepoInfo(repoRoot: string): Promise<RepoInfo> {
  const [branch, head, upstream, counts, status] = await Promise.all([
    execGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
    execGit(repoRoot, ["rev-parse", "HEAD"]),
    execGit(repoRoot, ["rev-parse", "@{u}"]),
    execGit(repoRoot, ["rev-list", "--left-right", "--count", "HEAD...@{u}"]),
    execGit(repoRoot, ["status", "--porcelain=v1"])
  ]);
  const failedChecks = [
    ["branch", branch],
    ["HEAD", head],
    ["upstream", upstream],
    ["ahead/behind", counts],
    ["working tree", status]
  ].filter(([, result]) => !(result as ExecResult).ok).map(([label]) => label as string);
  const ok = failedChecks.length === 0;
  const [aheadRaw, behindRaw] = counts.ok ? counts.stdout.trim().split(/\s+/) : ["0", "0"];
  return {
    ok,
    error: ok ? null : `Could not verify repository ${failedChecks.join(", ")}.`,
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : "unknown",
    head: head.ok ? head.stdout.trim() : "",
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead: Number(aheadRaw || 0) || 0,
    behind: Number(behindRaw || 0) || 0,
    dirty: !status.ok || Boolean(status.stdout.trim())
  };
}

async function execGit(repoRoot: string, args: string[]): Promise<ExecResult> {
  return await execFile("git", args, { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
}

async function execFile(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
  return await new Promise((resolveExec) => {
    let settled = false;
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveExec({ ok: false, stdout, stderr: stderr || "Command timed out" });
    }, options.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExec({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveExec({ ok: code === 0, stdout, stderr });
    });
  });
}

async function readBuildInfo(path: string): Promise<BuildInfo | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BuildInfo;
  } catch {
    return null;
  }
}

async function readFirstBuildInfo(paths: string[]): Promise<BuildInfo | null> {
  for (const path of paths) {
    const info = await readBuildInfo(path);
    if (info) return info;
  }
  return null;
}

async function readLastUpdate(path: string): Promise<LastUpdateStatus> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as LastUpdateStatus;
  } catch {
    return {};
  }
}

async function optionalStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

function updateMessage(
  { repo, appBundleOutdated, running, remoteCheckError }:
  { repo: RepoInfo; appBundleOutdated: boolean; running: boolean; remoteCheckError?: boolean | null }
): string {
  if (running) return "Update in progress";
  if (!repo.ok) return "Sentinel could not verify its source repository";
  if (repo.dirty) return "Local changes ready to run";
  if (remoteCheckError) return "Could not verify remote updates";
  if (repo.behind > 0) return `${repo.behind} remote commit${repo.behind === 1 ? "" : "s"} ready`;
  if (appBundleOutdated) return "Installed app is behind this checkout";
  return "Sentinel is current";
}

async function findExecutable(repoRoot: string, command: string): Promise<string | null> {
  const result = await execFile("/bin/zsh", ["-lc", "command -v -- \"$1\"", "sentinel-updater", command], {
    cwd: repoRoot,
    timeoutMs: EXEC_TIMEOUT_MS
  });
  const path = result.ok ? result.stdout.trim().split(/\r?\n/u)[0] : "";
  return path && resolve(path) === path && existsSync(path) ? path : null;
}

export async function acquireUpdaterLock(lockPath: string, ownerPid = process.pid): Promise<UpdaterLock> {
  await mkdir(dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const temporaryPath = `${lockPath}.${token}.tmp`;
    try {
      await writeFile(temporaryPath, `${JSON.stringify({ token, pid: ownerPid, startedAt })}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await link(temporaryPath, lockPath);
      return {
        path: lockPath,
        token,
        async transferTo(pid: number) {
          if (!Number.isInteger(pid) || pid <= 0) throw new Error("The updater lock owner must be a positive process ID.");
          await replaceOwnedLockPayload(lockPath, token, { token, pid, startedAt });
        },
        async release() {
          const current = await readUpdaterLock(lockPath);
          if (current?.token === token) await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (attempt === 0 && await removeStaleUpdaterLock(lockPath)) continue;
      throw new Error("A Sentinel update is already running.");
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
  throw new Error("A Sentinel update is already running.");
}

async function replaceOwnedLockPayload(lockPath: string, token: string, payload: UpdateLockPayload): Promise<void> {
  const current = await readUpdaterLock(lockPath);
  if (!current || current.token !== token) throw new Error("Sentinel lost ownership of the updater lock.");
  const temporaryPath = `${lockPath}.${token}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, lockPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function readActiveUpdaterLock(lockPath: string): Promise<UpdateLockPayload | null> {
  const payload = await readUpdaterLock(lockPath);
  return payload && processExists(payload.pid) ? payload : null;
}

async function readUpdaterLock(lockPath: string): Promise<UpdateLockPayload | null> {
  try {
    const value = JSON.parse(await readFile(lockPath, "utf8")) as Partial<UpdateLockPayload>;
    return typeof value.token === "string"
      && Number.isInteger(value.pid)
      && Number(value.pid) > 0
      && typeof value.startedAt === "string"
      ? value as UpdateLockPayload
      : null;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    return null;
  }
}

async function removeStaleUpdaterLock(lockPath: string): Promise<boolean> {
  const payload = await readUpdaterLock(lockPath);
  if (!payload || processExists(payload.pid)) return false;
  const current = await readUpdaterLock(lockPath);
  if (!current || current.token !== payload.token) return false;
  await rm(lockPath, { force: true });
  return true;
}

async function assertLocallyRebuildableApp(appPath: string): Promise<void> {
  if (!existsSync(appPath)) return;
  const result = await execFile("/usr/bin/codesign", ["-dv", "--verbose=4", appPath], {
    cwd: dirname(appPath),
    timeoutMs: EXEC_TIMEOUT_MS
  });
  const detail = `${result.stdout}\n${result.stderr}`;
  if (!result.ok && /code object is not signed at all/iu.test(detail)) return;
  if (!result.ok) throw new Error("Sentinel could not verify the installed app signature, so the update was stopped before quitting.");
  if (!isLocallyRebuildableSignature(detail)) {
    throw new Error("This Sentinel app has a distribution signature. Install a complete signed release instead of rebuilding it in place.");
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

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stopUpdaterChild(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The child already exited.
    }
  }
}

async function childStarted(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.pid) return;
  await new Promise<void>((resolveStart, rejectStart) => {
    child.once("spawn", resolveStart);
    child.once("error", rejectStart);
  });
}
