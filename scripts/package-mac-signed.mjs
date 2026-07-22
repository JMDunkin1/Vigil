#!/usr/bin/env node

import { spawn } from "node:child_process";
import { resolveMacBuildVersion } from "./mac-build-version.mjs";

const target = process.argv[2];
if (target !== "dir" && target !== "dmg") {
  throw new Error("Usage: package-mac-signed.mjs <dir|dmg> [electron-builder options]");
}

const buildVersion = resolveMacBuildVersion();
console.log(`Packaging Vigil with macOS build version ${buildVersion}.`);

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "electron-builder", "--mac", target,
    ...process.argv.slice(3),
    `-c.buildVersion=${buildVersion}`
  ],
  { stdio: "inherit", env: process.env }
);
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
