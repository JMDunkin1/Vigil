import { access, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { STATE_PATH, STATE_SEAL_KEY_PATH, STATE_SEAL_PATH } from "./store.js";
import { adultBlocklistPreloadDomains } from "./adultBlocklist.js";
import { persistentAppLockSiteTargets } from "./appLocks.js";
import { removeCompleteManagedBlocks, removePartialManagedBlockFragments } from "./managedBlock.js";
import { activePolicy, baselinePolicy, expandSiteTargets, normalizeHost, normalizeUrlPattern } from "./policy.js";
import { integrityLockdownPolicy } from "./integrityLockdown.js";
import { applySealVerificationToState, stateSealSummary, verifyStateTextSeal } from "./seal.js";
import type { Profile, VigilState, UnknownRecord } from "./types.js";

export const HOSTS_BEGIN = "# BEGIN VIGIL";
export const HOSTS_END = "# END VIGIL";
export const LEGACY_HOSTS_BEGIN = "# BEGIN VIGIL";
export const LEGACY_HOSTS_END = "# END VIGIL";
export const LAUNCH_AGENT_LABEL = "com.vigil.agent";
export const LEGACY_LAUNCH_AGENT_LABEL = "tech.caseline.vigil.agent";
const HOSTS_MARKER_PAIRS = [
  [HOSTS_BEGIN, HOSTS_END],
  [LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END]
] as const;
const execFileAsync = promisify(execFile);

interface LaunchAgentPrintStatus {
  loaded: true;
  running: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

export function buildHostsBlock(state: VigilState, now = new Date()): string {
  const domains = managedBlockDomains(state, now);
  const lines = [HOSTS_BEGIN];
  for (const domain of domains) {
    lines.push(`0.0.0.0 ${domain}`);
    lines.push(`0.0.0.0 www.${domain}`);
  }

  lines.push(HOSTS_END);
  return lines.join("\n");
}

export function managedBlockDomains(state: VigilState, now = new Date()): string[] {
  const profile = hostsProfileForState(state, now);
  return expandSiteTargets(hostsSiteTargets(state, profile)).filter((domain) => !isLocalHost(domain));
}

export async function hostsStatus(state: VigilState | null = null, now = new Date()) {
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
    const uid = process.getuid?.();
    if (uid === undefined) return { ...base, error: "Current process does not expose a macOS user id." };
    const { stdout } = await execFileAsync("/bin/launchctl", ["print", `gui/${uid}/${LAUNCH_AGENT_LABEL}`], {
      timeout: 3000,
      maxBuffer: 1024 * 128
    });
    return { ...base, ...parseLaunchAgentPrint(stdout), loaded: true };
  } catch (error) {
    return { ...base, error: simplifyError(error) };
  }
}

export async function stateSealStatus(state: VigilState | null = null) {
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
        parsed = JSON.parse(text) as VigilState;
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
    if (isNodeErrorCode(error, "ENOENT")) {
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

export async function loadStateForScript(): Promise<VigilState> {
  return JSON.parse(await readFile(STATE_PATH, "utf8")) as VigilState;
}

export function extractHostsBlock(hosts: string): string {
  for (const [begin, endMarker] of HOSTS_MARKER_PAIRS) {
    const start = hosts.indexOf(begin);
    const end = hosts.indexOf(endMarker);
    if (start >= 0 && end > start) return hosts.slice(start, end + endMarker.length).trim();
  }
  return "";
}

export function hostsBlockMatches(currentBlock: string, expectedBlock: string): boolean {
  return normalizeBlock(currentBlock) === normalizeBlock(expectedBlock);
}

export function replaceManagedHostsBlock(currentHosts: string, blockText: string): string {
  let next = String(currentHosts || "");
  for (const [begin, end] of HOSTS_MARKER_PAIRS) {
    next = removeCompleteManagedBlocks(next, begin, end);
    next = removePartialManagedBlockFragments(next, begin, end);
  }
  const prefix = next.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${blockText}\n`;
}

export function parseLaunchAgentPrint(output = ""): LaunchAgentPrintStatus {
  const pid = numberMatch(output, /\bpid = (\d+)/);
  return {
    loaded: true,
    running: Boolean(pid),
    pid,
    lastExitStatus: numberMatch(output, /last exit code = (-?\d+)/)
  };
}

function hasPartialHostsBlock(hosts: string): boolean {
  return HOSTS_MARKER_PAIRS.some(([begin, end]) => hosts.includes(begin) !== hosts.includes(end));
}

function hasCompleteManagedHostsBlock(hosts: string, begin: string, endMarker: string): boolean {
  const start = hosts.indexOf(begin);
  const end = hosts.indexOf(endMarker, start + begin.length);
  return start >= 0 && end > start;
}

function countCompleteManagedHostsBlocks(hosts: string): number {
  return HOSTS_MARKER_PAIRS.reduce((count, [begin, end]) => count + countCompleteManagedHostsBlocksForPair(hosts, begin, end), 0);
}

function countCompleteManagedHostsBlocksForPair(hosts: string, begin: string, endMarker: string): number {
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

function hostsProfileForState(state: VigilState, now: Date): Profile | undefined {
  const integrity = integrityLockdownPolicy(state, now);
  if (integrity) return integrity.profile;
  return activePolicy(state, now)?.profile || baselinePolicy(state, now, { device: "computer" })?.profile;
}

function hostsSiteTargets(state: VigilState, profile: Profile | undefined): string[] {
  const targets: string[] = [];
  targets.push(...adultBlocklistPreloadDomains(state));
  if (profile?.mode === "blocklist") {
    targets.push(...(profile.blockedSites || []));
    if (profile.hostsUrlPatternBlocking !== false) {
      targets.push(...urlPatternHostTargets(profile.blockedUrlPatterns || []));
    }
  }

  targets.push(...persistentAppLockSiteTargets(state));

  return targets;
}

function urlPatternHostTargets(patterns: unknown[]): string[] {
  const hosts: string[] = [];
  for (const raw of patterns || []) {
    const pattern = normalizeUrlPattern(raw);
    if (!pattern || pattern.startsWith("/") || !pattern.includes("/")) continue;
    const host = normalizeHost(pattern.split("/")[0] || "");
    if (!isSafeHostsFileDomain(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

function isSafeHostsFileDomain(host: string): boolean {
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

function isLocalHost(domain: unknown): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(String(domain || "").toLowerCase());
}

function countHostEntries(block: string): number {
  return block
    .split(/\r?\n/)
    .filter((line: string) => /^0\.0\.0\.0\s+\S+/.test(line.trim()))
    .length;
}

function normalizeBlock(block: string): string {
  return String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line: string) => line.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function numberMatch(value: unknown, pattern: RegExp): number | null {
  const match = String(value || "").match(pattern);
  if (!match?.[1]) return null;
  const number = Number.parseInt(match[1], 10);
  return Number.isFinite(number) ? number : null;
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as UnknownRecord : {};
  return String(record.stderr || record.message || error || "").trim().split("\n").at(-1) || "";
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
