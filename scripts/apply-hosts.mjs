import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildHostsBlock, loadStateForScript, replaceManagedHostsBlock } from "../src/hardening.js";

const execFileAsync = promisify(execFile);

if (process.getuid && process.getuid() !== 0) {
  console.error("Run with sudo: npm run hosts:apply");
  process.exit(1);
}

const state = await loadStateForScript();
const block = buildHostsBlock(state);
const hostsPath = "/etc/hosts";
const current = await readFile(hostsPath, "utf8");
const next = replaceManagedHostsBlock(current, block);

await writeFile(hostsPath, next.endsWith("\n") ? next : `${next}\n`);
await flushDns();
console.log("Sentinel hosts block applied.");

async function flushDns() {
  try {
    await execFileAsync("/usr/bin/dscacheutil", ["-flushcache"], { timeout: 3000 });
  } catch {
    // Best effort.
  }

  try {
    await execFileAsync("/usr/bin/killall", ["-HUP", "mDNSResponder"], { timeout: 3000 });
  } catch {
    // Best effort.
  }
}
