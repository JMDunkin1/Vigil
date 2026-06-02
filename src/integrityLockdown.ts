import { DEFAULT_BLOCKED_APPS, DEFAULT_BLOCKED_SITES, STRICT_BYPASS_APPS } from "./defaults.js";
import { stateSealSummary } from "./seal.js";
import { parseClock } from "./time.js";
import type { ActivePolicy, HardeningIssue, IntegrityRuntimeState, Schedule, SentinelState } from "./types.js";

const LOCKDOWN_ENDS_AT = "until the tamper alarm is cleared";
const DEFAULT_GAP_LOCKDOWN_SECONDS = 120;
const DEFAULT_CLOCK_TAMPER_SECONDS = 90;

interface IntegrityAlarm {
  type: string;
  detectedAt: string;
  detail: string;
  status: string;
  issues?: HardeningIssue[];
  direction?: string;
  seconds?: number;
}

interface HardeningCheck {
  ok?: boolean;
  detail?: string;
  installed?: boolean;
  partial?: boolean;
  stale?: boolean;
  loaded?: boolean;
  running?: boolean;
  legacyInstalled?: boolean;
  accessibilityLikelyMissing?: boolean;
  [key: string]: unknown;
}

interface HardeningChecks {
  hosts?: HardeningCheck;
  firewall?: HardeningCheck;
  extensionRules?: HardeningCheck;
  sourceSeal?: HardeningCheck;
  agent?: HardeningCheck;
  monitor?: HardeningCheck;
  [key: string]: unknown;
}

interface ClockTamperSample {
  previousWallMs?: number;
  currentWallMs?: number;
  previousMonotonicMs?: number;
  currentMonotonicMs?: number;
}

interface ProtectedOverlap {
  kind: string;
  id: string;
  name: string;
  startsAt?: string;
  endsAt?: string;
}

export function integrityLockdownActive(state: SentinelState): boolean {
  return Boolean(activeIntegrityAlarm(state));
}

export function integrityLockdownPolicy(state: SentinelState, now = new Date()): (ActivePolicy & { alarm: IntegrityAlarm }) | null {
  const alarm = activeIntegrityAlarm(state);
  if (!alarm) return null;

  return {
    kind: "integrity",
    session: {
      id: "integrity:tamper-lockdown",
      title: "Integrity lockdown",
      mode: "integrity",
      profileId: "integrity-lockdown",
      lockLevel: "deep",
      startedAt: validDateText(alarm.detectedAt) || now.toISOString(),
      endsAt: LOCKDOWN_ENDS_AT,
      canEndEarly: false,
      source: "integrity"
    },
    profile: {
      id: "integrity-lockdown",
      name: "Integrity lockdown",
      mode: "blocklist",
      description: "Fail-closed defaults used after local state tampering is detected.",
      blockedApps: unique([...DEFAULT_BLOCKED_APPS, ...STRICT_BYPASS_APPS]),
      blockedSites: unique(DEFAULT_BLOCKED_SITES),
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: ["localhost", "127.0.0.1"]
    },
    endsAt: LOCKDOWN_ENDS_AT,
    alarm
  };
}

export function clearIntegrityTamper(state: SentinelState, now = new Date()): boolean {
  const seal = state.integrity?.stateSeal;
  const runtime = state.integrity?.runtime;
  const hadAlarm = Boolean(seal?.tamperDetectedAt || runtime?.downtimeDetectedAt || runtime?.hardeningDriftDetectedAt || runtime?.clockTamperDetectedAt);

  if (seal) {
    seal.tamperDetectedAt = null;
    seal.tamperDetail = "";
    seal.lastStatus = "sealed";
    seal.lastDetail = "State tamper alarm was cleared through a protected maintenance action.";
    seal.lastCheckedAt = now.toISOString();
  }

  if (runtime) {
    runtime.downtimeDetectedAt = null;
    runtime.downtimeDetail = "";
    runtime.lastGapSeconds = 0;
    runtime.lastGapStartedAt = null;
    runtime.lastGapEndedAt = null;
    runtime.hardeningDriftDetectedAt = null;
    runtime.hardeningDriftDetail = "";
    runtime.hardeningDriftIssues = [];
    runtime.clockTamperDetectedAt = null;
    runtime.clockTamperDetail = "";
    runtime.clockTamperSeconds = 0;
    runtime.clockTamperDirection = "";
    runtime.clockTamperPreviousWallAt = null;
    runtime.clockTamperCurrentWallAt = null;
  }

  return hadAlarm;
}

export function clearTrustedSourceSealDrift(state: SentinelState, now = new Date()): boolean {
  const runtime = state.integrity?.runtime;
  if (!runtime?.hardeningDriftDetectedAt) return false;
  const issues = Array.isArray(runtime.hardeningDriftIssues) ? runtime.hardeningDriftIssues : [];
  if (!issues.length || issues.some((issue) => issue.id !== "source-seal")) return false;

  runtime.hardeningDriftDetectedAt = null;
  runtime.hardeningDriftDetail = "";
  runtime.hardeningDriftIssues = [];
  runtime.lastSourceSealTrustedAt = now.toISOString();
  return true;
}

export function detectHardeningDrift(state: SentinelState, checks: HardeningChecks = {}, now = new Date()) {
  const runtime = ensureRuntime(state);
  if (runtime.hardeningDriftDetectedAt) return null;
  if (!state.settings?.foolproofModeEnabled) return null;

  const current = now.getTime();
  const overlap = protectedLockOverlap(state, current, current + 1);
  if (!overlap) return null;

  const issues = hardeningIssues(checks);
  if (!issues.length) return null;

  runtime.hardeningDriftDetectedAt = now.toISOString();
  runtime.hardeningDriftIssues = issues;
  runtime.hardeningDriftDetail = `Hardening drift detected during ${overlap.name}: ${issues.map((issue) => issue.detail).join(" ")}`;

  return {
    detectedAt: runtime.hardeningDriftDetectedAt,
    detail: runtime.hardeningDriftDetail,
    issues,
    overlap
  };
}

export function detectRuntimeGap(state: SentinelState, now = new Date()) {
  const runtime = ensureRuntime(state);
  if (runtime.downtimeDetectedAt) return null;

  const previous = Date.parse(runtime.lastHeartbeatAt || "");
  if (!Number.isFinite(previous)) return null;

  const current = now.getTime();
  const gapSeconds = Math.round((current - previous) / 1000);
  if (gapSeconds < runtimeGapLockdownSeconds(state)) return null;

  const overlap = protectedLockOverlap(state, previous, current);
  if (!overlap) return null;

  runtime.downtimeDetectedAt = now.toISOString();
  runtime.downtimeDetail = `Sentinel was offline for ${gapSeconds}s during ${overlap.name}.`;
  runtime.lastGapSeconds = gapSeconds;
  runtime.lastGapStartedAt = new Date(previous).toISOString();
  runtime.lastGapEndedAt = now.toISOString();
  return {
    detectedAt: runtime.downtimeDetectedAt,
    detail: runtime.downtimeDetail,
    gapSeconds,
    gapStartedAt: runtime.lastGapStartedAt,
    gapEndedAt: runtime.lastGapEndedAt,
    overlap
  };
}

export function detectClockTamper(state: SentinelState, sample: ClockTamperSample = {}, now = new Date()) {
  const runtime = ensureRuntime(state);
  if (runtime.clockTamperDetectedAt) return null;

  const previousWall = Number(sample.previousWallMs);
  const currentWall = Number(sample.currentWallMs);
  const previousMonotonic = Number(sample.previousMonotonicMs);
  const currentMonotonic = Number(sample.currentMonotonicMs);
  if (![previousWall, currentWall, previousMonotonic, currentMonotonic].every(Number.isFinite)) return null;

  const wallElapsed = currentWall - previousWall;
  const monotonicElapsed = currentMonotonic - previousMonotonic;
  if (monotonicElapsed < 0) return null;

  const driftSeconds = Math.round((wallElapsed - monotonicElapsed) / 1000);
  if (Math.abs(driftSeconds) < clockTamperLockdownSeconds(state)) return null;

  const rangeStart = Math.min(previousWall, currentWall);
  const rangeEnd = Math.max(previousWall, currentWall);
  const overlap = protectedLockOverlap(state, rangeStart, rangeEnd);
  if (!overlap) return null;

  const direction = driftSeconds > 0 ? "forward" : "backward";
  runtime.clockTamperDetectedAt = now.toISOString();
  runtime.clockTamperSeconds = driftSeconds;
  runtime.clockTamperDirection = direction;
  runtime.clockTamperPreviousWallAt = new Date(previousWall).toISOString();
  runtime.clockTamperCurrentWallAt = new Date(currentWall).toISOString();
  runtime.clockTamperDetail = `System clock moved ${direction} by ${Math.abs(driftSeconds)}s compared with monotonic runtime during ${overlap.name}.`;

  return {
    detectedAt: runtime.clockTamperDetectedAt,
    detail: runtime.clockTamperDetail,
    driftSeconds,
    direction,
    previousWallAt: runtime.clockTamperPreviousWallAt,
    currentWallAt: runtime.clockTamperCurrentWallAt,
    overlap
  };
}

export function recordRuntimeHeartbeat(state: SentinelState, now = new Date()): string {
  const runtime = ensureRuntime(state);
  runtime.lastHeartbeatAt = now.toISOString();
  return runtime.lastHeartbeatAt;
}

export function integrityRuntimeSummary(state: SentinelState) {
  const runtime = ensureRuntime(state);
  if (runtime.downtimeDetectedAt) {
    return {
      ok: false,
      status: "downtime-detected",
      detail: runtime.downtimeDetail || "Sentinel was offline during a protected lock.",
      lastHeartbeatAt: runtime.lastHeartbeatAt || null,
      downtimeDetectedAt: runtime.downtimeDetectedAt,
      lastGapSeconds: runtime.lastGapSeconds || 0
    };
  }

  if (runtime.hardeningDriftDetectedAt) {
    return {
      ok: false,
      status: "hardening-drift",
      detail: runtime.hardeningDriftDetail || "A hardening protection weakened during a protected lock.",
      lastHeartbeatAt: runtime.lastHeartbeatAt || null,
      hardeningDriftDetectedAt: runtime.hardeningDriftDetectedAt,
      hardeningDriftIssues: runtime.hardeningDriftIssues || []
    };
  }

  if (runtime.clockTamperDetectedAt) {
    return {
      ok: false,
      status: "clock-tamper",
      detail: runtime.clockTamperDetail || "System clock changed during a protected lock.",
      lastHeartbeatAt: runtime.lastHeartbeatAt || null,
      clockTamperDetectedAt: runtime.clockTamperDetectedAt,
      clockTamperSeconds: runtime.clockTamperSeconds || 0,
      clockTamperDirection: runtime.clockTamperDirection || ""
    };
  }

  const lastHeartbeatAt = runtime.lastHeartbeatAt || null;
  return {
    ok: true,
    status: lastHeartbeatAt ? "watching" : "starting",
    detail: lastHeartbeatAt
      ? `Runtime heartbeat is current (${lastHeartbeatAt}).`
      : "Runtime heartbeat will start after the watcher ticks.",
    lastHeartbeatAt,
    downtimeDetectedAt: null,
    lastGapSeconds: 0
  };
}

function unique(values: unknown[]): string[] {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function validDateText(value: unknown): string {
  const date = new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function activeIntegrityAlarm(state: SentinelState): IntegrityAlarm | null {
  const seal = stateSealSummary(state);
  if (seal.tamperDetectedAt) {
    return {
      type: "state-seal",
      detectedAt: seal.tamperDetectedAt,
      detail: seal.detail,
      status: seal.status
    };
  }

  const runtime = state?.integrity?.runtime || {};
  if (runtime.downtimeDetectedAt) {
    return {
      type: "runtime-downtime",
      detectedAt: runtime.downtimeDetectedAt,
      detail: runtime.downtimeDetail || "Sentinel was offline during a protected lock.",
      status: "downtime-detected"
    };
  }

  if (runtime.hardeningDriftDetectedAt) {
    return {
      type: "hardening-drift",
      detectedAt: runtime.hardeningDriftDetectedAt,
      detail: runtime.hardeningDriftDetail || "A hardening protection weakened during a protected lock.",
      status: "hardening-drift",
      issues: runtime.hardeningDriftIssues || []
    };
  }

  if (runtime.clockTamperDetectedAt) {
    return {
      type: "clock-tamper",
      detectedAt: runtime.clockTamperDetectedAt,
      detail: runtime.clockTamperDetail || "System clock changed during a protected lock.",
      status: "clock-tamper",
      direction: runtime.clockTamperDirection || "",
      seconds: runtime.clockTamperSeconds || 0
    };
  }

  return null;
}

function hardeningIssues(checks: HardeningChecks): HardeningIssue[] {
  const issues: HardeningIssue[] = [];
  const hosts = checks.hosts;
  const firewall = checks.firewall;
  const extensionRules = checks.extensionRules;
  const sourceSeal = checks.sourceSeal;
  const agent = checks.agent;
  const monitor = checks.monitor;

  if (sourceSeal && !sourceSeal.ok) {
    issues.push({
      id: "source-seal",
      detail: sourceSeal.detail || "Source integrity seal is not healthy."
    });
  }

  if (hosts && (!hosts.installed || hosts.partial || hosts.stale)) {
    issues.push({
      id: "hosts",
      detail: hosts.partial
        ? "Hosts block markers are incomplete."
        : (hosts.stale ? "Hosts block is stale." : "Hosts block is not installed.")
    });
  }

  if (firewall && (!firewall.installed || firewall.partial || firewall.stale)) {
    issues.push({
      id: "firewall",
      detail: firewall.partial
        ? "PF firewall markers are incomplete."
        : (firewall.stale ? "PF firewall block is stale." : "PF firewall block is not installed.")
    });
  }

  if (agent && (!agent.loaded || !agent.running)) {
    issues.push({
      id: "launch-agent",
      detail: agent.installed
        ? "LaunchAgent is not loaded and running."
        : "LaunchAgent is not installed."
    });
  } else if (agent?.legacyInstalled) {
    issues.push({
      id: "launch-agent",
      detail: "Legacy Local Screen Time LaunchAgent is still installed."
    });
  }

  if (monitor && (!monitor.ok || monitor.accessibilityLikelyMissing)) {
    issues.push({
      id: "accessibility",
      detail: monitor.accessibilityLikelyMissing
        ? "Foreground app detection lost macOS Accessibility permission."
        : "Foreground app detection is not healthy."
    });
  }

  if (extensionRules && !extensionRules.ok) {
    issues.push({
      id: "extension-rules",
      detail: extensionRules.detail || "Browser extension dynamic block rules are not healthy."
    });
  }

  return issues;
}

function ensureRuntime(state: SentinelState): IntegrityRuntimeState {
  state.integrity.runtime ||= {};
  return state.integrity.runtime;
}

function runtimeGapLockdownSeconds(state: SentinelState): number {
  return Math.max(30, Number(state.settings?.runtimeGapLockdownSeconds || DEFAULT_GAP_LOCKDOWN_SECONDS));
}

function clockTamperLockdownSeconds(state: SentinelState): number {
  return Math.max(30, Number(state.settings?.clockTamperLockdownSeconds || DEFAULT_CLOCK_TAMPER_SECONDS));
}

function protectedLockOverlap(state: SentinelState, startMs: number, endMs: number): ProtectedOverlap | null {
  const session = state.activeSession;
  if (session?.lockLevel === "deep" && rangesOverlap(startMs, endMs, Date.parse(session.startedAt || ""), Date.parse(session.endsAt || ""))) {
    return { kind: "manual", id: session.id, name: session.title || "strict session" };
  }

  for (const block of state.limitBlocks || []) {
    if (block.lockLevel === "deep" && rangesOverlap(startMs, endMs, Date.parse(block.createdAt || ""), Date.parse(block.until || ""))) {
      return { kind: "limit", id: block.id, name: block.ruleName || "limit block" };
    }
  }

  for (const schedule of state.schedules || []) {
    const overlap = strictScheduleOverlap(schedule, startMs, endMs, state.environment?.wifiSsid || "");
    if (overlap) return overlap;
  }

  return null;
}

function strictScheduleOverlap(schedule: Schedule, startMs: number, endMs: number, currentWifi = ""): ProtectedOverlap | null {
  if (!schedule?.enabled || schedule.lockLevel !== "deep") return null;
  if (!scheduleEnvironmentMatches(schedule, currentWifi)) return null;

  const first = new Date(startMs);
  first.setHours(0, 0, 0, 0);
  first.setDate(first.getDate() - 1);
  const totalDays = Math.min(120, Math.ceil((endMs - startMs) / 86_400_000) + 3);

  for (let offset = 0; offset < totalDays; offset += 1) {
    const day = new Date(first);
    day.setDate(first.getDate() + offset);
    if (!(schedule.days || []).includes(day.getDay())) continue;

    const window = scheduleWindowForStartDay(schedule, day);
    if (rangesOverlap(startMs, endMs, window.startsAt, window.endsAt)) {
      return {
        kind: "schedule",
        id: schedule.id,
        name: schedule.name || "strict schedule",
        startsAt: new Date(window.startsAt).toISOString(),
        endsAt: new Date(window.endsAt).toISOString()
      };
    }
  }

  return null;
}

function scheduleWindowForStartDay(schedule: Schedule, day: Date): { startsAt: number; endsAt: number } {
  const start = parseClock(schedule.start);
  const end = parseClock(schedule.end);
  const startsAt = new Date(day);
  startsAt.setHours(Math.floor(start / 60), start % 60, 0, 0);
  const endsAt = new Date(day);
  endsAt.setHours(Math.floor(end / 60), end % 60, 0, 0);
  if (start > end) endsAt.setDate(endsAt.getDate() + 1);
  return { startsAt: startsAt.getTime(), endsAt: endsAt.getTime() };
}

function scheduleEnvironmentMatches(schedule: Schedule, currentWifi: string): boolean {
  const networks = (schedule.wifiNetworks || []).map(normalizeText).filter(Boolean);
  if (!networks.length) return true;
  return networks.includes(normalizeText(currentWifi));
}

function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  if (![aStart, aEnd, bStart, bEnd].every(Number.isFinite)) return false;
  return aStart < bEnd && bStart < aEnd;
}

function normalizeText(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}
