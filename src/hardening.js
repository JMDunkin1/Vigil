import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STATE_PATH, STATE_SEAL_KEY_PATH, STATE_SEAL_PATH } from "./store.js";
import { activePolicy, activeProfile, expandSiteTargets, normalizeHost, normalizeUrlPattern } from "./policy.js";
import { integrityLockdownPolicy } from "./integrityLockdown.js";
import { applySealVerificationToState, stateSealSummary, verifyStateTextSeal } from "./seal.js";

export const HOSTS_BEGIN = "# BEGIN SENTINEL";
export const HOSTS_END = "# END SENTINEL";
export const LEGACY_HOSTS_BEGIN = "# BEGIN LOCAL SCREEN TIME";
export const LEGACY_HOSTS_END = "# END LOCAL SCREEN TIME";
export const LAUNCH_AGENT_LABEL = "com.sentinel.agent";
export const LEGACY_LAUNCH_AGENT_LABEL = "com.local-screen-time.agent";
const HOSTS_MARKER_PAIRS = [
  [HOSTS_BEGIN, HOSTS_END],
  [LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END]
];
const execFileAsync = promisify(execFile);

export function buildHostsBlock(state, now = new Date()) {
  const profile = hostsProfileForState(state, now);
  const domains = expandSiteTargets(hostsSiteTargets(state, profile)).filter((domain) => !isLocalHost(domain));
  const lines = [
    HOSTS_BEGIN,
    "# Managed by Sentinel. Edit profile site blocklists or host/path URL patterns, then re-run npm run hosts:apply."
  ];

  if (!domains.length) {
    lines.push("# No hostname-based block targets are active for the current policy.");
  } else {
    for (const domain of domains) {
      lines.push(`0.0.0.0 ${domain}`);
      lines.push(`0.0.0.0 www.${domain}`);
    }
  }

  lines.push(HOSTS_END);
  return lines.join("\n");
}

export async function hostsStatus(state = null, now = new Date()) {
  try {
    const hosts = await readFile("/etc/hosts", "utf8");
    const currentBlock = extractHostsBlock(hosts);
    const expectedBlock = state ? buildHostsBlock(state, now) : "";
    const installed = Boolean(currentBlock);
    const legacyInstalled = hasCompleteManagedHostsBlock(hosts, LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END);
    const duplicate = countCompleteManagedHostsBlocks(hosts) > 1;
    const stale = Boolean(state && installed && (!hostsBlockMatches(currentBlock, expectedBlock) || legacyInstalled || duplicate));
    return {
      installed,
      partial: hasPartialHostsBlock(hosts),
      legacyInstalled,
      duplicate,
      stale,
      current: Boolean(installed && !stale),
      expectedEntries: expectedBlock ? countHostEntries(expectedBlock) : 0,
      installedEntries: currentBlock ? countHostEntries(currentBlock) : 0,
      writableByUser: false
    };
  } catch (error) {
    return { installed: false, partial: false, stale: false, current: false, expectedEntries: 0, installedEntries: 0, writableByUser: false, error: simplifyError(error) };
  }
}

export function launchAgentPath() {
  return `${process.env.HOME}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`;
}

export function legacyLaunchAgentPath() {
  return `${process.env.HOME}/Library/LaunchAgents/${LEGACY_LAUNCH_AGENT_LABEL}.plist`;
}

export async function launchAgentStatus() {
  const path = launchAgentPath();
  const legacyPath = legacyLaunchAgentPath();
  const installed = await fileExists(path);
  const legacyInstalled = await fileExists(legacyPath);
  const base = {
    installed,
    path,
    label: LAUNCH_AGENT_LABEL,
    legacyInstalled,
    legacyPath,
    legacyLabel: LEGACY_LAUNCH_AGENT_LABEL,
    loaded: false,
    running: false,
    pid: null,
    lastExitStatus: null
  };
  if (!installed) return base;

  try {
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`], {
      timeout: 3000,
      maxBuffer: 1024 * 128
    });
    return { ...base, ...parseLaunchAgentPrint(stdout), loaded: true };
  } catch (error) {
    return { ...base, error: simplifyError(error) };
  }
}

export async function stateSealStatus(state = null) {
  try {
    let text = await readFile(STATE_PATH, "utf8");
    let verification = await verifyStateTextSeal(text, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
    if (verification.status === "mismatch") {
      await sleep(300);
      const retryText = await readFile(STATE_PATH, "utf8");
      const retryVerification = await verifyStateTextSeal(retryText, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
      if (retryVerification.ok) {
        text = retryText;
        verification = retryVerification;
      }
    }
    let parsed = state;
    if (!parsed) {
      try {
        parsed = JSON.parse(text);
      } catch {
        return {
          ok: false,
          status: "invalid-state",
          detail: "State file is not valid JSON.",
          tamperDetectedAt: null,
          lastCheckedAt: verification.checkedAt,
          lastSealedAt: verification.sealedAt || null
        };
      }
    }
    applySealVerificationToState(parsed, verification);
    return stateSealSummary(parsed, verification);
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ok: false,
        status: "missing-state",
        detail: "State file does not exist yet.",
        tamperDetectedAt: null,
        lastCheckedAt: new Date().toISOString(),
        lastSealedAt: null
      };
    }
    return {
      ok: false,
      status: "error",
      detail: simplifyError(error) || "State seal could not be checked.",
      tamperDetectedAt: null,
      lastCheckedAt: new Date().toISOString(),
      lastSealedAt: null
    };
  }
}

export async function loadStateForScript() {
  return JSON.parse(await readFile(STATE_PATH, "utf8"));
}

export function extractHostsBlock(hosts) {
  for (const [begin, endMarker] of HOSTS_MARKER_PAIRS) {
    const start = hosts.indexOf(begin);
    const end = hosts.indexOf(endMarker);
    if (start >= 0 && end > start) return hosts.slice(start, end + endMarker.length).trim();
  }
  return "";
}

export function hostsBlockMatches(currentBlock, expectedBlock) {
  return normalizeBlock(currentBlock) === normalizeBlock(expectedBlock);
}

export function replaceManagedHostsBlock(currentHosts, blockText) {
  let next = String(currentHosts || "");
  for (const [begin, end] of HOSTS_MARKER_PAIRS) {
    next = removeCompleteManagedHostsBlocks(next, begin, end);
  }
  const prefix = next.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${blockText}\n`;
}

export function parseLaunchAgentPrint(output = "") {
  const pid = numberMatch(output, /\bpid = (\d+)/);
  return {
    loaded: true,
    running: Boolean(pid),
    pid,
    lastExitStatus: numberMatch(output, /last exit code = (-?\d+)/)
  };
}

function hasPartialHostsBlock(hosts) {
  return HOSTS_MARKER_PAIRS.some(([begin, end]) => hosts.includes(begin) !== hosts.includes(end));
}

function hasCompleteManagedHostsBlock(hosts, begin, endMarker) {
  const start = hosts.indexOf(begin);
  const end = hosts.indexOf(endMarker, start + begin.length);
  return start >= 0 && end > start;
}

function countCompleteManagedHostsBlocks(hosts) {
  return HOSTS_MARKER_PAIRS.reduce((count, [begin, end]) => count + countCompleteManagedHostsBlocksForPair(hosts, begin, end), 0);
}

function countCompleteManagedHostsBlocksForPair(hosts, begin, endMarker) {
  let count = 0;
  let offset = 0;
  while (true) {
    const start = hosts.indexOf(begin, offset);
    if (start < 0) return count;
    const end = hosts.indexOf(endMarker, start + begin.length);
    if (end <= start) return count;
    count += 1;
    offset = end + endMarker.length;
  }
}

function removeCompleteManagedHostsBlocks(currentHosts, begin, endMarker) {
  let next = currentHosts;
  while (true) {
    const start = next.indexOf(begin);
    if (start < 0) return next;
    const end = next.indexOf(endMarker, start + begin.length);
    if (end <= start) return next;
    const before = next.slice(0, start).trimEnd();
    const after = next.slice(end + endMarker.length).trimStart();
    next = `${before}${before && after ? "\n\n" : ""}${after}`;
  }
}

function hostsProfileForState(state, now) {
  const integrity = integrityLockdownPolicy(state, now);
  if (integrity) return integrity.profile;
  return activePolicy(state, now)?.profile || activeProfile(state);
}

function hostsSiteTargets(state, profile) {
  const targets = [];
  if (profile?.mode === "blocklist") {
    targets.push(...(profile.blockedSites || []));
    targets.push(...urlPatternHostTargets(profile.blockedUrlPatterns || []));
  }

  for (const lock of (state.appLocks || []).filter((item) => item.enabled)) {
    targets.push(...(lock.sites || []));
  }

  return targets;
}

function urlPatternHostTargets(patterns) {
  const hosts = [];
  for (const raw of patterns || []) {
    const pattern = normalizeUrlPattern(raw);
    if (!pattern || pattern.startsWith("/") || !pattern.includes("/")) continue;
    const host = normalizeHost(pattern.split("/")[0]);
    if (!isSafeHostsFileDomain(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

function isSafeHostsFileDomain(host) {
  return Boolean(
    host &&
    host.includes(".") &&
    /^[a-z0-9.-]+$/.test(host) &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    !isLocalHost(host)
  );
}

function isLocalHost(domain) {
  return ["localhost", "127.0.0.1", "::1"].includes(String(domain || "").toLowerCase());
}

function countHostEntries(block) {
  return block
    .split(/\r?\n/)
    .filter((line) => /^0\.0\.0\.0\s+\S+/.test(line.trim()))
    .length;
}

function normalizeBlock(block) {
  return String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function numberMatch(value, pattern) {
  const match = String(value || "").match(pattern);
  if (!match) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

function simplifyError(error) {
  return String(error?.stderr || error?.message || error || "").trim().split("\n").at(-1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
