import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFingerprint } from "./source-fingerprint.mjs";
import { gitExecutable } from "./git-executable.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const sourceRoot = await durableSourceRoot();

const info = {
  name: "vigil",
  builtAt: new Date().toISOString(),
  commit: (await git(["rev-parse", "HEAD"])).trim() || null,
  branch: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null,
  dirty: Boolean((await git(["status", "--porcelain=v1"])).trim()),
  sourceFingerprint: await sourceFingerprint(projectRoot),
  sourceRoot
};

const outputPath = join(runtimeRoot, "build-info.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(info, null, 2)}\n`);

async function durableSourceRoot(): Promise<string> {
  const configuredRoot = process.env.VIGIL_BUILD_SOURCE_ROOT?.trim();
  if (configuredRoot) return resolve(configuredRoot);
  const commonGitDir = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  if (basename(commonGitDir) === ".git") return dirname(commonGitDir);
  return projectRoot;
}

async function git(args: string[]): Promise<string> {
  let command: string;
  try {
    command = await gitExecutable(projectRoot);
  } catch {
    return "";
  }
  return await new Promise((resolveGit) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolveGit(""));
    child.on("close", (code) => resolveGit(code === 0 ? stdout : ""));
  });
}
