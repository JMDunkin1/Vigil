import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));

const info = {
  name: "sentinel",
  builtAt: new Date().toISOString(),
  commit: (await git(["rev-parse", "HEAD"])).trim() || null,
  branch: (await git(["rev-parse", "--abbrev-ref", "HEAD"])).trim() || null,
  dirty: Boolean((await git(["status", "--porcelain=v1"])).trim()),
  sourceRoot: resolve(process.env.SENTINEL_BUILD_SOURCE_ROOT || projectRoot)
};

const outputPath = join(runtimeRoot, "build-info.json");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(info, null, 2)}\n`);

async function git(args: string[]): Promise<string> {
  return await new Promise((resolveGit) => {
    const child = spawn("git", args, { cwd: projectRoot, stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolveGit(""));
    child.on("close", (code) => resolveGit(code === 0 ? stdout : ""));
  });
}
