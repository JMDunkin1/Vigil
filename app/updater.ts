import type { App } from "electron";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const UPDATE_STATUS_FILENAME = "update-status.json";
const UPDATE_LOG_FILENAME = "update.log";
const EXEC_TIMEOUT_MS = 5000;

interface ExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

interface RepoInfo {
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
  const scriptPath = updateScriptPath(repoRoot);

  async function readStatusPayload({ checkRemote = false }: { checkRemote?: boolean } = {}): Promise<Record<string, unknown>> {
    await mkdir(updateDir, { recursive: true });
    const remoteCheck = checkRemote ? await execGit(repoRoot, ["fetch", "--prune"]) : null;
    const [repo, runtimeBuild, appBuild, appStat, lastUpdate] = await Promise.all([
      readRepoInfo(repoRoot),
      readBuildInfo(join(repoRoot, "dist", "runtime", "build-info.json")),
      readBuildInfo(join(appPath, "Contents", "Resources", "app.asar.unpacked", "dist", "runtime", "build-info.json")),
      optionalStat(join(appPath, "Contents", "Resources", "app.asar")),
      readLastUpdate(statusPath)
    ]);
    const running = lastUpdate.phase ? !["complete", "failed"].includes(String(lastUpdate.phase)) : false;
    const appCommit = appBuild?.commit || null;
    const currentCommit = repo.head || runtimeBuild?.commit || "";
    const appBundleOutdated = Boolean(currentCommit && appCommit && appCommit !== currentCommit) || Boolean(currentCommit && !appCommit);
    const updateAvailable = Boolean(repo.behind > 0 || appBundleOutdated || repo.dirty);
    return {
      ok: true,
      supported: true,
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
      runtimeBuiltAt: runtimeBuild?.builtAt || null,
      appBuiltAt: appBuild?.builtAt || null,
      appBundleModifiedAt: appStat?.mtime.toISOString() || null,
      remoteCheckedAt: checkRemote ? new Date().toISOString() : null,
      remoteCheckOk: remoteCheck ? remoteCheck.ok : null,
      remoteCheckError: remoteCheck && !remoteCheck.ok ? remoteCheck.stderr || "Remote check timed out" : null,
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
      await mkdir(updateDir, { recursive: true });
      const currentStatus = await readStatusPayload();
      if (currentStatus.running) {
        return { ...currentStatus, ok: false, error: "A Sentinel update is already running." };
      }
      if (!currentStatus.updateAvailable) {
        return { ...currentStatus, ok: false, error: "No Sentinel update is available." };
      }
      if (!scriptPath) {
        return { ok: false, supported: false, error: "Updater script is missing from this Sentinel build." };
      }
      const startedAt = new Date().toISOString();
      await writeFile(statusPath, `${JSON.stringify({
        ok: true,
        phase: "starting",
        message: "Preparing Sentinel update",
        startedAt,
        updatedAt: startedAt
      }, null, 2)}\n`);
      const command = [
        shellQuote(scriptPath),
        "--repo-root", shellQuote(repoRoot),
        "--app-path", shellQuote(appPath),
        "--parent-pid", String(process.pid),
        "--status-path", shellQuote(statusPath),
        "--log-path", shellQuote(logPath),
        "--restart"
      ].join(" ");
      const child = spawn("/bin/zsh", ["-lc", `node ${command}`], {
        detached: true,
        stdio: "ignore",
        cwd: repoRoot,
        env: {
          ...process.env,
          SENTINEL_UPDATE_LAUNCHED_BY: "sentinel-app"
        }
      });
      child.unref();
      setTimeout(quitForUpdate, 200);
      return {
        ok: true,
        supported: true,
        phase: "starting",
        message: "Sentinel will quit, update, and reopen.",
        logPath
      };
    }
  };
}

function findRepoRoot(app: App): string {
  const candidates = [
    process.env.SENTINEL_SOURCE_ROOT || "",
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
  return join(repoRoot, "dist", "mac", "mac-arm64", "Sentinel.app");
}

function updateScriptPath(repoRoot: string): string | null {
  const candidates = [
    join(process.resourcesPath || "", "app.asar.unpacked", "dist", "runtime", "scripts", "update-packaged-app.mjs"),
    join(repoRoot, "dist", "runtime", "scripts", "update-packaged-app.mjs")
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
  const [aheadRaw, behindRaw] = counts.ok ? counts.stdout.trim().split(/\s+/) : ["0", "0"];
  return {
    repoRoot,
    branch: branch.ok ? branch.stdout.trim() : "unknown",
    head: head.ok ? head.stdout.trim() : "",
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead: Number(aheadRaw || 0) || 0,
    behind: Number(behindRaw || 0) || 0,
    dirty: Boolean(status.stdout.trim())
  };
}

async function execGit(repoRoot: string, args: string[]): Promise<ExecResult> {
  return await execFile("git", args, { cwd: repoRoot, timeoutMs: EXEC_TIMEOUT_MS });
}

async function execFile(command: string, args: string[], options: { cwd: string; timeoutMs: number }): Promise<ExecResult> {
  return await new Promise((resolveExec) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
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
      clearTimeout(timeout);
      resolveExec({ ok: false, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
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
  if (repo.behind > 0) return `${repo.behind} remote commit${repo.behind === 1 ? "" : "s"} ready`;
  if (appBundleOutdated) return "Installed app is behind this checkout";
  if (repo.dirty) return "Local changes will be rebuilt";
  if (remoteCheckError) return "Could not check remote updates";
  return "Sentinel is current";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
