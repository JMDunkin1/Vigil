import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { gitExecutable } from "./git-executable.mjs";

const SOURCE_FINGERPRINT_GIT_TIMEOUT_MS = 30_000;
const SOURCE_FINGERPRINT_TERMINATION_GRACE_MS = 1_000;
const SOURCE_FINGERPRINT_KILL_CONFIRMATION_MS = 2_000;

export interface SourceFingerprintOptions {
  gitTimeoutMs?: number;
}

export async function sourceFingerprint(
  repoRoot: string,
  options: SourceFingerprintOptions = {}
): Promise<string | null> {
  const gitTimeoutMs = Number.isFinite(options.gitTimeoutMs) && Number(options.gitTimeoutMs) > 0
    ? Number(options.gitTimeoutMs)
    : SOURCE_FINGERPRINT_GIT_TIMEOUT_MS;
  const [trackedDiff, untrackedOutput] = await Promise.all([
    captureGit(repoRoot, ["diff", "--binary", "--no-ext-diff", "--no-textconv", "HEAD", "--"], gitTimeoutMs),
    captureGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], gitTimeoutMs)
  ]);
  if (!trackedDiff || !untrackedOutput) return null;

  const hash = createHash("sha256");
  hash.update("vigil-source-fingerprint-v1\0");
  hash.update(trackedDiff);
  const untrackedPaths = untrackedOutput
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
  for (const relativePath of untrackedPaths) {
    hash.update("\0path\0");
    hash.update(relativePath);
    const path = join(repoRoot, relativePath);
    try {
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        hash.update("\0symlink\0");
        hash.update(await readlink(path));
      } else if (stats.isFile()) {
        hash.update("\0file\0");
        hash.update(await readFile(path));
      } else {
        hash.update(`\0${stats.isDirectory() ? "directory" : "other"}\0`);
      }
    } catch {
      return null;
    }
  }
  return hash.digest("hex");
}

async function captureGit(repoRoot: string, args: string[], timeoutMs: number): Promise<Buffer | null> {
  let command: string;
  try {
    command = await gitExecutable(repoRoot);
  } catch {
    return null;
  }
  return await new Promise((resolveCapture) => {
    let settled = false;
    let timedOut = false;
    let terminationGrace: ReturnType<typeof setTimeout> | null = null;
    let killConfirmation: ReturnType<typeof setTimeout> | null = null;
    const chunks: Buffer[] = [];
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const finish = (value: Buffer | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminationGrace) clearTimeout(terminationGrace);
      if (killConfirmation) clearTimeout(killConfirmation);
      resolveCapture(value);
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      signalProcessGroup(child.pid, "SIGTERM");
      terminationGrace = setTimeout(() => {
        if (settled) return;
        signalProcessGroup(child.pid, "SIGKILL");
        // This is a read-only status probe. If a kernel-stalled process cannot
        // be reaped, fail the check after one bounded confirmation interval so
        // the update button never remains permanently busy.
        killConfirmation = setTimeout(() => {
          child.stdout.destroy();
          finish(null);
        }, SOURCE_FINGERPRINT_KILL_CONFIRMATION_MS);
      }, SOURCE_FINGERPRINT_TERMINATION_GRACE_MS);
    }, timeoutMs);
    const finishTimedOutChild = () => {
      if (!processGroupExists(child.pid)) {
        finish(null);
        return;
      }
      signalProcessGroup(child.pid, "SIGKILL");
      if (!killConfirmation) {
        killConfirmation = setTimeout(() => {
          child.stdout.destroy();
          finish(null);
        }, SOURCE_FINGERPRINT_KILL_CONFIRMATION_MS);
      }
    };
    child.once("error", () => timedOut ? finishTimedOutChild() : finish(null));
    child.once("close", (code) => timedOut
      ? finishTimedOutChild()
      : finish(code === 0 ? Buffer.concat(chunks) : null));
  });
}

function signalProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The read-only Git probe already exited.
    }
  }
}

function processGroupExists(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}
