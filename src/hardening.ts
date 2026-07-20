import { access, lstat, readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { STATE_PATH, STATE_SEAL_KEY_PATH, STATE_SEAL_PATH } from "./store.js";
import { adultBlocklistPreloadDomains } from "./adultBlocklist.js";
import { persistentAppLockSiteTargets } from "./appLocks.js";
import { removeCompleteManagedBlocks, removePartialManagedBlockFragments } from "./managedBlock.js";
import { activePolicy, baselinePolicy, expandSiteTargets, normalizeHost, normalizeUrlPattern } from "./policy.js";
import { integrityLockdownPolicy } from "./integrityLockdown.js";
import { applySealVerificationToState, stateSealSummary, verifyStateTextSeal } from "./seal.js";
import { parsePlist } from "./plist.js";
import type { Profile, VigilState, UnknownRecord } from "./types.js";

export const HOSTS_BEGIN = "# BEGIN VIGIL";
export const HOSTS_END = "# END VIGIL";
export const LAUNCH_AGENT_LABEL = "com.vigil.agent";
export const EMBEDDED_SUPERVISOR_LABEL = "tech.caseline.vigil.supervisor";
export const VIGIL_SAFETY_BOUNDARY_ARG = "--vigil-safety-boundary-do-not-terminate-or-bootout";
const HOSTS_MARKER_PAIRS = [[HOSTS_BEGIN, HOSTS_END]] as const;
const execFileAsync = promisify(execFile);

interface LaunchAgentPrintStatus {
  loaded: true;
  running: boolean;
  pid: number | null;
  lastExitStatus: number | null;
}

export interface EmbeddedSupervisorExpectation {
  homeDir: string;
  userDataDir: string;
  dataDir: string;
  executablePath: string;
  port?: string;
}

interface EmbeddedSupervisorIntegrityEvidence {
  markerActive: boolean;
  script: string;
  scriptExecutable: boolean;
  supervisorRunning: boolean;
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
    const duplicate = countCompleteManagedHostsBlocks(hosts) > 1;
    const stale = Boolean(state && installed && (!hostsBlockMatches(currentBlock, expectedBlock) || duplicate));
    return {
      installed,
      partial: hasPartialHostsBlock(hosts),
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

export async function launchAgentStatus() {
  if (process.env.VIGIL_EMBEDDED_RUNTIME === "1") {
    const path = embeddedSupervisorPath();
    const installed = await fileExists(path);
    let source = "";
    let scriptSource = "";
    let scriptExecutable = false;
    let supervisionMarkerPath = "";
    let supervisionMarkerActive = false;
    const expectation = embeddedSupervisorExpectation();
    try {
      source = installed ? await readFile(path, "utf8") : "";
      supervisionMarkerPath = embeddedSupervisorMarkerPath(source);
      supervisionMarkerActive = Boolean(supervisionMarkerPath) && await fileExists(supervisionMarkerPath);
      if (expectation) {
        const scriptPath = embeddedSupervisorScriptPath(expectation);
        scriptSource = await readFile(scriptPath, "utf8");
        const scriptStat = await lstat(scriptPath);
        scriptExecutable = scriptStat.isFile()
          && !scriptStat.isSymbolicLink()
          && (scriptStat.mode & 0o777) === 0o700;
      }
    } catch {
      scriptSource = "";
      scriptExecutable = false;
    }
    const base = {
      installed,
      path,
      label: EMBEDDED_SUPERVISOR_LABEL,
      loaded: false,
      running: true,
      pid: process.pid,
      lastExitStatus: null,
      embedded: true,
      supervisionMarkerPath,
      supervisionMarkerActive,
      supervisorRunning: false,
      supervisorPid: null,
      restartHardened: false
    };
    const uid = process.getuid?.();
    if (uid === undefined) return { ...base, error: "Current process does not expose a macOS user id." };
    try {
      const { stdout } = await execFileAsync("/bin/launchctl", ["print", `gui/${uid}/${EMBEDDED_SUPERVISOR_LABEL}`], {
        timeout: 3000,
        maxBuffer: 1024 * 128
      });
      const supervisor = parseLaunchAgentPrint(stdout);
      return {
        ...base,
        loaded: true,
        supervisorRunning: supervisor.running,
        supervisorPid: supervisor.pid,
        restartHardened: expectation
          ? embeddedSupervisorRestartHardened(source, expectation, {
              markerActive: supervisionMarkerActive,
              script: scriptSource,
              scriptExecutable,
              supervisorRunning: supervisor.running
            })
          : false
      };
    } catch (error) {
      return { ...base, error: simplifyError(error) };
    }
  }
  const path = launchAgentPath();
  const installed = await fileExists(path);
  const base = {
    installed,
    path,
    label: LAUNCH_AGENT_LABEL,
    loaded: false,
    running: false,
    restartHardened: true,
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

export function embeddedSupervisorPath() {
  const homeDir = process.env.VIGIL_HOME_DIR || process.env.HOME || "";
  return join(homeDir, "Library", "LaunchAgents", `${EMBEDDED_SUPERVISOR_LABEL}.plist`);
}

export function embeddedSupervisorPlistRestartHardened(plist: string, expectation: EmbeddedSupervisorExpectation): boolean {
  return isDeepStrictEqual(embeddedSupervisorConfiguration(plist).root, embeddedSupervisorExpectedConfiguration(expectation));
}

export function embeddedSupervisorMarkerPath(plist: string): string {
  return embeddedSupervisorConfiguration(plist).markerPath;
}

export function embeddedSupervisorRestartHardened(
  plist: string,
  expectation: EmbeddedSupervisorExpectation,
  evidence: EmbeddedSupervisorIntegrityEvidence
): boolean {
  return embeddedSupervisorPlistRestartHardened(plist, expectation)
    && evidence.scriptExecutable
    && evidence.script === embeddedSupervisorExpectedScript(expectation)
    && evidence.markerActive
    && evidence.supervisorRunning;
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

function embeddedSupervisorExpectation(): EmbeddedSupervisorExpectation | null {
  const homeDir = String(process.env.VIGIL_HOME_DIR || "").trim();
  const userDataDir = String(process.env.VIGIL_USER_DATA_DIR || "").trim();
  const dataDir = String(process.env.VIGIL_DATA_DIR || "").trim();
  const executablePath = String(process.execPath || "").trim();
  if (!homeDir || !userDataDir || !dataDir || !executablePath) return null;
  return {
    homeDir,
    userDataDir,
    dataDir,
    executablePath,
    ...(process.env.VIGIL_PORT ? { port: process.env.VIGIL_PORT } : {})
  };
}

function embeddedSupervisorScriptPath(expectation: EmbeddedSupervisorExpectation): string {
  return join(expectation.userDataDir, "supervisor", "vigil-supervisor-DO-NOT-TERMINATE-OR-BOOTOUT.zsh");
}

function embeddedSupervisorConfiguration(plist: string): { root: Record<string, unknown> | null; markerPath: string } {
  const document = /<plist(?:\s|>)/u.test(plist) ? plist : `<plist><dict>${plist}</dict></plist>`;
  const parsedRoot = recordValue(parsePlist(document));
  const root = parsedRoot ? JSON.parse(JSON.stringify(parsedRoot)) as Record<string, unknown> : null;
  const keepAlive = recordValue(root?.KeepAlive);
  const pathState = recordValue(keepAlive?.PathState);
  const markerPath = Object.entries(pathState || {}).find(([, enabled]) => enabled === true)?.[0] || "";
  return { root, markerPath };
}

function embeddedSupervisorExpectedConfiguration(expectation: EmbeddedSupervisorExpectation): Record<string, unknown> {
  const markerPath = join(expectation.userDataDir, "supervisor", "SAFETY-BOUNDARY-DO-NOT-REMOVE.enabled");
  const environment: Record<string, string> = {
    HOME: expectation.homeDir,
    USER: basename(expectation.homeDir),
    LOGNAME: basename(expectation.homeDir),
    PATH: `${join(expectation.homeDir, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    VIGIL_DATA_DIR: expectation.dataDir,
    VIGIL_EMBEDDED_RUNTIME: "1",
    VIGIL_RESTART_SUPERVISED: "1"
  };
  if (expectation.port) environment.VIGIL_PORT = expectation.port;
  const logPath = join(expectation.userDataDir, "logs", "supervisor.log");
  return {
    Label: EMBEDDED_SUPERVISOR_LABEL,
    ProgramArguments: [embeddedSupervisorScriptPath(expectation), VIGIL_SAFETY_BOUNDARY_ARG],
    EnvironmentVariables: environment,
    RunAtLoad: true,
    KeepAlive: { PathState: { [markerPath]: true } },
    ThrottleInterval: 5,
    ProcessType: "Interactive",
    StandardOutPath: logPath,
    StandardErrorPath: logPath
  };
}

export function embeddedSupervisorExpectedScript(expectation: EmbeddedSupervisorExpectation): string {
  const markerPath = join(expectation.userDataDir, "supervisor", "SAFETY-BOUNDARY-DO-NOT-REMOVE.enabled");
  const readyPath = join(expectation.dataDir, "runtime-ready.json");
  const appPath = dirname(dirname(dirname(expectation.executablePath)));
  return `#!/bin/zsh
set -u
marker=${shellSingleQuote(markerPath)}
ready=${shellSingleQuote(readyPath)}
app_path=${shellSingleQuote(appPath)}
executable_path=${shellSingleQuote(expectation.executablePath)}
while [[ -e "$marker" ]]; do
  pid=""
  command=""
  if [[ -f "$ready" ]]; then
    pid=$(/usr/bin/sed -nE 's/^[[:space:]]*"pid":[[:space:]]*([0-9]+),?$/\\1/p' "$ready" | /usr/bin/head -n 1)
  fi
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    command=$(/bin/ps -p "$pid" -o command= 2>/dev/null)
  fi
  if [[ -z "$pid" ]] || [[ "$command" != "$executable_path" && "$command" != "$executable_path "* ]]; then
    /bin/rm -f "$ready"
    if [[ ! -e "$marker" ]]; then
      break
    fi
    /usr/bin/open -g "$app_path" --args --vigil-background ${VIGIL_SAFETY_BOUNDARY_ARG}
    /bin/sleep 5
  else
    /bin/sleep 2
  fi
done
`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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
