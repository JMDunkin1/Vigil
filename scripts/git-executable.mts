import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const GIT_PROBE_TIMEOUT_MS = 5_000;
let cachedGitExecutable: Promise<string> | null = null;

export async function gitExecutable(cwd: string): Promise<string> {
  cachedGitExecutable ||= selectGitExecutable(gitExecutableCandidates(), cwd);
  try {
    return await cachedGitExecutable;
  } catch (error) {
    cachedGitExecutable = null;
    throw error;
  }
}

export function gitExecutableCandidates(
  platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env
): string[] {
  const configured = environment.VIGIL_GIT_EXECUTABLE?.trim() || "";
  const developerGit = environment.DEVELOPER_DIR?.trim()
    ? join(environment.DEVELOPER_DIR.trim(), "usr", "bin", "git")
    : "";
  const candidates = platform === "darwin"
    ? [
        configured,
        developerGit,
        "/Library/Developer/CommandLineTools/usr/bin/git",
        "/Applications/Xcode.app/Contents/Developer/usr/bin/git",
        "git",
        "/usr/bin/git"
      ]
    : [configured, "git"];
  return [...new Set(candidates.filter(Boolean))];
}

export async function selectGitExecutable(candidates: string[], cwd: string): Promise<string> {
  for (const candidate of candidates) {
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    if (await canRunGit(candidate, cwd)) return candidate;
  }
  throw new Error("Vigil could not find a working Git installation.");
}

async function canRunGit(candidate: string, cwd: string): Promise<boolean> {
  return await new Promise((resolveProbe) => {
    let settled = false;
    const child = spawn(candidate, ["--version"], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"]
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolveProbe(false);
    }, GIT_PROBE_TIMEOUT_MS);
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe(false);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveProbe(code === 0);
    });
  });
}
