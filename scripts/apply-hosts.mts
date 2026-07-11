import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildHostsBlock, loadStateForScript, replaceManagedHostsBlock } from "../src/hardening.js";
import { isDirectRun } from "../src/directRun.js";
import { buildResolvedFirewallBlock, buildPfConfBlock, firewallStatus, PF_ANCHOR_PATH, PF_CONF_PATH, replaceManagedPfConfBlock, validateAndLoadPf, writeFirewallFiles } from "../src/firewall.js";
import type { SentinelState } from "../src/types.js";

const execFileAsync = promisify(execFile);
const HOSTS_PATH = "/etc/hosts";

interface ApplyNetworkBlockOptions {
  state?: SentinelState;
  hostsPath?: string;
  pfConfPath?: string;
  anchorPath?: string;
  validateAndLoadPf?: (pfConfPath: string) => Promise<void>;
  flushDns?: () => Promise<void>;
}

if (isDirectRun(import.meta.url)) {
  if (process.getuid && process.getuid() !== 0) {
    console.error("Run with sudo: npm run network:apply");
    process.exit(1);
  }

  const result = await applyNetworkBlock();
  console.log(`Sentinel network block applied (${result.status.installedEntries || 0} PF address rules, ${result.domainCount} domains).`);
}

export async function applyNetworkBlock(options: ApplyNetworkBlockOptions = {}) {
  const state = options.state || await loadStateForScript();
  const hostsPath = options.hostsPath || HOSTS_PATH;
  const pfConfPath = options.pfConfPath || PF_CONF_PATH;
  const anchorPath = options.anchorPath || PF_ANCHOR_PATH;
  const block = buildHostsBlock(state);
  const currentHosts = await readFile(hostsPath, "utf8");
  const nextHosts = replaceManagedHostsBlock(currentHosts, block);
  const currentPfConf = await readOptional(pfConfPath);
  const currentAnchor = await readOptional(anchorPath);
  const firewall = await buildResolvedFirewallBlock(state);
  const nextPfConf = replaceManagedPfConfBlock(currentPfConf || defaultPfConf(), buildPfConfBlock(anchorPath));

  await writeFile(hostsPath, nextHosts.endsWith("\n") ? nextHosts : `${nextHosts}\n`);
  try {
    await writeFirewallFiles({
      pfConfText: nextPfConf,
      anchorText: firewall.block,
      pfConfPath,
      anchorPath
    });
    await (options.validateAndLoadPf || validateAndLoadPf)(pfConfPath);
  } catch (error) {
    await restoreNetworkFiles({
      hostsPath,
      hostsText: currentHosts,
      pfConfPath,
      pfConfText: currentPfConf,
      anchorPath,
      anchorText: currentAnchor
    });
    throw error;
  }

  await (options.flushDns || flushDns)();
  const status = await firewallStatus(state, new Date(), { pfConfPath, anchorPath });
  return {
    status,
    domainCount: firewall.domains.length
  };
}

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

async function restoreNetworkFiles(options: {
  hostsPath: string;
  hostsText: string;
  pfConfPath: string;
  pfConfText: string;
  anchorPath: string;
  anchorText: string;
}): Promise<void> {
  await writeFile(options.hostsPath, options.hostsText.endsWith("\n") ? options.hostsText : `${options.hostsText}\n`, "utf8");
  await writeFirewallFiles({
    pfConfText: options.pfConfText || defaultPfConf(),
    anchorText: options.anchorText || "",
    pfConfPath: options.pfConfPath,
    anchorPath: options.anchorPath
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
