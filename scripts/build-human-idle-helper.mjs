#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

const developerTools = await resolveDeveloperTools();
await mkdir(outputDir, { recursive: true });
await execFileAsync(join(developerTools.bin, "clang"), [
  "-isysroot",
  developerTools.sdk,
  "-x",
  "objective-c",
  join(projectRoot, "app", "vigil-human-idle.c"),
  "-Os",
  "-Wall",
  "-Wextra",
  `-mmacosx-version-min=${minimumMacosVersion}`,
  "-framework",
  "ApplicationServices",
  "-framework",
  "AppKit",
  "-o",
  outputPath
]);
const { stdout: loadCommands } = await execFileAsync(join(developerTools.bin, "otool"), ["-l", outputPath]);
const builtMinimumVersion = loadCommands.match(/^\s+minos\s+(\S+)$/mu)?.[1];
if (builtMinimumVersion !== minimumMacosVersion) {
  throw new Error(`Expected ${outputPath} to target macOS ${minimumMacosVersion}, got ${builtMinimumVersion || "unknown"}.`);
}
await chmod(outputPath, 0o755);

async function resolveDeveloperTools() {
  const configured = process.env.VIGIL_DEVELOPER_BIN?.trim() || "";
  const configuredSdk = process.env.VIGIL_DEVELOPER_SDK?.trim() || "";
  const developerDir = process.env.DEVELOPER_DIR?.trim() || "";
  const candidates = [
    configured && configuredSdk ? { bin: configured, sdk: configuredSdk } : null,
    {
      bin: "/Library/Developer/CommandLineTools/usr/bin",
      sdk: "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk"
    },
    developerDir ? {
      bin: join(developerDir, "Toolchains", "XcodeDefault.xctoolchain", "usr", "bin"),
      sdk: join(developerDir, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk")
    } : null,
    {
      bin: "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin",
      sdk: "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    }
  ].filter(Boolean);
  const checkedBins = new Set();
  for (const candidate of candidates) {
    if (checkedBins.has(candidate.bin)) continue;
    checkedBins.add(candidate.bin);
    const clang = join(candidate.bin, "clang");
    const otool = join(candidate.bin, "otool");
    if (!existsSync(clang) || !existsSync(otool) || !existsSync(candidate.sdk)) continue;
    try {
      await execFileAsync(clang, ["--version"], { timeout: 5_000 });
      return candidate;
    } catch {
      // Apple command shims can exist while refusing to run after an Xcode update.
    }
  }
  throw new Error("Vigil could not find working macOS compiler tools.");
}
