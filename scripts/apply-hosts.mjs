import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildHostsBlock, HOSTS_BEGIN, HOSTS_END, loadStateForScript } from "../src/hardening.js";

const execFileAsync = promisify(execFile);

if (process.getuid && process.getuid() !== 0) {
  console.error("Run with sudo: npm run hosts:apply");
  process.exit(1);
}

const state = await loadStateForScript();
const block = buildHostsBlock(state);
const hostsPath = "/etc/hosts";
const current = await readFile(hostsPath, "utf8");
const next = replaceManagedBlock(current, block);

await writeFile(hostsPath, next.endsWith("\n") ? next : `${next}\n`);
await flushDns();
console.log("Local Screen Time hosts block applied.");

function replaceManagedBlock(currentHosts, blockText) {
  const start = currentHosts.indexOf(HOSTS_BEGIN);
  const end = currentHosts.indexOf(HOSTS_END);
  if (start >= 0 && end > start) {
    const before = currentHosts.slice(0, start).trimEnd();
    const after = currentHosts.slice(end + HOSTS_END.length).trimStart();
    return `${before}\n\n${blockText}\n\n${after}`.trim();
  }
  return `${currentHosts.trimEnd()}\n\n${blockText}\n`;
}

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
