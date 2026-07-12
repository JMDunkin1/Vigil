import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

export async function sourceFingerprint(repoRoot: string): Promise<string | null> {
  const [trackedDiff, untrackedOutput] = await Promise.all([
    captureGit(repoRoot, ["diff", "--binary", "HEAD", "--"]),
    captureGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
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

async function captureGit(repoRoot: string, args: string[]): Promise<Buffer | null> {
  return await new Promise((resolveCapture) => {
    const chunks: Buffer[] = [];
    const child = spawn("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.once("error", () => resolveCapture(null));
    child.once("close", (code) => resolveCapture(code === 0 ? Buffer.concat(chunks) : null));
  });
}
