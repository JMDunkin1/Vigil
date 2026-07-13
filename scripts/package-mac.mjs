#!/usr/bin/env node

import { spawn } from "node:child_process";
import { macSigningTimestamp, resolveMacSigningIdentity } from "./mac-signing-identity.mjs";

const target = process.argv[2];
if (target !== "dir" && target !== "dmg") throw new Error("Usage: package-mac.mjs <dir|dmg> [electron-builder options]");

const identity = await resolveMacSigningIdentity();
const timestamp = macSigningTimestamp(identity);
if (identity === "-") {
  console.warn("No Apple Development signing identity was found; using an ad-hoc signature. macOS may ask for folder access again after rebuilds.");
} else {
  console.log(`Signing Vigil with stable local identity: ${identity}`);
}

const child = spawn(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "electron-builder", "--mac", target,
    `-c.mac.identity=${identity}`,
    ...(timestamp ? [`-c.mac.timestamp=${timestamp}`] : []),
    ...process.argv.slice(3)
  ],
  { stdio: "inherit", env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: "false" } }
);
child.once("error", (error) => { throw error; });
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
