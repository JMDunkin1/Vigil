#!/usr/bin/env node

import { execFile } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const outputDir = join(projectRoot, "dist", "runtime", "bin");
const outputPath = join(outputDir, "vigil-human-idle");
const minimumMacosVersion = "12.0";

if (process.platform !== "darwin") process.exit(0);

await mkdir(outputDir, { recursive: true });
await execFileAsync("/usr/bin/clang", [
  join(projectRoot, "app", "vigil-human-idle.c"),
  "-Os",
  "-Wall",
  "-Wextra",
  `-mmacosx-version-min=${minimumMacosVersion}`,
  "-framework",
  "ApplicationServices",
  "-o",
  outputPath
]);
const { stdout: loadCommands } = await execFileAsync("/usr/bin/otool", ["-l", outputPath]);
const builtMinimumVersion = loadCommands.match(/^\s+minos\s+(\S+)$/mu)?.[1];
if (builtMinimumVersion !== minimumMacosVersion) {
  throw new Error(`Expected ${outputPath} to target macOS ${minimumMacosVersion}, got ${builtMinimumVersion || "unknown"}.`);
}
await chmod(outputPath, 0o755);
