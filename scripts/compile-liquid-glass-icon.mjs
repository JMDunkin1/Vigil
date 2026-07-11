#!/usr/bin/env node

import { cp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const appPath = process.argv[2];
  if (!appPath) throw new Error("Usage: compile-liquid-glass-icon.mjs <app-path>");
  void compileLiquidGlassIcon(appPath).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export async function compileLiquidGlassIcon(targetAppPath) {
  const source = join(projectRoot, "build", "Vigil.icon");
  const resources = join(targetAppPath, "Contents", "Resources");
  const compiled = join(projectRoot, "dist", "liquid-glass-icon.noindex");
  await rm(compiled, { recursive: true, force: true });
  await mkdir(compiled, { recursive: true });

  await run("xcrun", [
    "actool",
    source,
    "--compile", compiled,
    "--platform", "macosx",
    "--minimum-deployment-target", "12.0",
    "--app-icon", "Vigil",
    "--output-partial-info-plist", join(compiled, "asset-info.plist")
  ]);

  await cp(join(compiled, "Assets.car"), join(resources, "Assets.car"));
  await cp(join(compiled, "Vigil.icns"), join(resources, "Vigil.icns"));
  const plist = join(targetAppPath, "Contents", "Info.plist");
  await run("/usr/libexec/PlistBuddy", ["-c", "Set :CFBundleIconFile Vigil", plist]);
  await run("/usr/libexec/PlistBuddy", ["-c", "Add :CFBundleIconName string Vigil", plist]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", cwd: projectRoot });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed${signal ? ` (${signal})` : ` with exit code ${code}`}`));
    });
  });
}
