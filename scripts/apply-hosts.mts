import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildHostsBlock, loadStateForScript, replaceManagedHostsBlock } from "../src/hardening.js";
import { buildResolvedFirewallBlock, buildPfConfBlock, firewallStatus, PF_ANCHOR_PATH, PF_CONF_PATH, replaceManagedPfConfBlock, validateAndLoadPf, writeFirewallFiles } from "../src/firewall.js";

const execFileAsync = promisify(execFile);

if (process.getuid && process.getuid() !== 0) {
  console.error("Run with sudo: npm run network:apply");
  process.exit(1);
}

const state = await loadStateForScript();
const block = buildHostsBlock(state);
const hostsPath = "/etc/hosts";
const current = await readFile(hostsPath, "utf8");
const next = replaceManagedHostsBlock(current, block);
const currentPfConf = await readOptional(PF_CONF_PATH);
const currentAnchor = await readOptional(PF_ANCHOR_PATH);
const firewall = await buildResolvedFirewallBlock(state);
const nextPfConf = replaceManagedPfConfBlock(currentPfConf || defaultPfConf(), buildPfConfBlock());

await writeFile(hostsPath, next.endsWith("\n") ? next : `${next}\n`);
await writeFirewallFiles({
  pfConfText: nextPfConf,
  anchorText: firewall.block
});
try {
  await validateAndLoadPf(PF_CONF_PATH);
} catch (error) {
  await restoreFirewall(currentPfConf, currentAnchor);
  throw error;
}
await flushDns();
const status = await firewallStatus(state);
console.log(`Vigil network block applied (${status.installedEntries || 0} PF address rules, ${firewall.domains.length} domains).`);

async function flushDns(): Promise<void> {
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

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return "";
    throw error;
  }
}

async function restoreFirewall(pfConf: string, anchor: string): Promise<void> {
  await writeFirewallFiles({
    pfConfText: pfConf || defaultPfConf(),
    anchorText: anchor || ""
  });
}

function defaultPfConf(): string {
  return [
    "scrub-anchor \"com.apple/*\"",
    "nat-anchor \"com.apple/*\"",
    "rdr-anchor \"com.apple/*\"",
    "dummynet-anchor \"com.apple/*\"",
    "anchor \"com.apple/*\"",
    "load anchor \"com.apple\" from \"/etc/pf.anchors/com.apple\""
  ].join("\n");
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
