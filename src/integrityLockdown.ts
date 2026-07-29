import { DEFAULT_BLOCKED_APPS, DEFAULT_BLOCKED_SITES, STRICT_BYPASS_APPS } from "./defaults.js";
import { stateSealSummary } from "./seal.js";
import { parseClock } from "./time.js";
import type { ActivePolicy, HardeningIssue, IntegrityRuntimeState, Schedule, VigilState } from "./types.js";

const LOCKDOWN_ENDS_AT = "until the tamper alarm is cleared";
const APPLE_CONTENT_FILTER_LOCKDOWN_ENDS_AT = "until Apple Screen Time Limit Adult Websites and Content & Privacy Restrictions are turned back on";
const DEFAULT_GAP_LOCKDOWN_SECONDS = 120;
const DEFAULT_CLOCK_TAMPER_SECONDS = 90;
export const APPLE_CONTENT_FILTER_ISSUE_ID = "apple-content-filter";
export const CHROME_SAFE_SEARCH_ISSUE_ID = "chrome-safe-search";

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
  accessibilityLikelyMissing?: boolean;
  [key: string]: unknown;
}

interface HardeningChecks {
  hosts?: HardeningCheck;
  firewall?: HardeningCheck;
  safariFilter?: HardeningCheck;
  chromeSafeSearch?: HardeningCheck;
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

export interface RuntimeInterruptionEvidenceInput {
  id: string;
  detectedAt: string;
  previousRuntimeStartedAt?: string | null;
}

interface RuntimeInterruptionOptions {
  rebooted?: boolean;
  bootedAt?: Date | null;
  gapStartedAt?: Date | null;
}

export function integrityLockdownActive(state: VigilState): boolean {
  return Boolean(activeIntegrityAlarm(state));
}

export function integrityLockdownPolicy(state: VigilState, now = new Date()): (ActivePolicy & { alarm: IntegrityAlarm }) | null {
  const alarm = activeIntegrityAlarm(state);
  if (!alarm) return null;
  const contentFilterRecovery = appleContentFilterRecoveryAlarm(alarm);

  return {
    kind: "integrity",
    session: {
      id: "integrity:tamper-lockdown",
      title: contentFilterRecovery ? "Apple content filter recovery" : "Integrity lockdown",
      mode: "integrity",
      profileId: contentFilterRecovery ? "apple-content-filter-recovery" : "integrity-lockdown",
      lockLevel: "deep",
      startedAt: validDateText(alarm.detectedAt) || now.toISOString(),
      endsAt: contentFilterRecovery ? APPLE_CONTENT_FILTER_LOCKDOWN_ENDS_AT : LOCKDOWN_ENDS_AT,
      canEndEarly: false,
      source: "integrity"
    },
    profile: contentFilterRecovery ? appleContentFilterRecoveryProfile() : integrityTamperProfile(),
    endsAt: contentFilterRecovery ? APPLE_CONTENT_FILTER_LOCKDOWN_ENDS_AT : LOCKDOWN_ENDS_AT,
    alarm
  };
}

export function clearIntegrityTamper(state: VigilState, now = new Date()): boolean {
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

export function clearTrustedSourceSealDrift(state: VigilState, now = new Date()): boolean {
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

export function syncAppleContentFilterLockdown(state: VigilState, safariFilter: HardeningCheck = {}, now = new Date()) {
  const runtime = ensureRuntime(state);
  const current = appleContentFilterCurrent(safariFilter);
  const issues = Array.isArray(runtime.hardeningDriftIssues) ? runtime.hardeningDriftIssues : [];
  let existingRecovery = Boolean(runtime.hardeningDriftDetectedAt && onlyAppleContentFilterIssue(issues));
  const uncorroboratedRecovery = Boolean(
    existingRecovery
    && (!runtime.appleContentFilterArmedAt || !appleContentFilterArmedLockIds(runtime).length)
  );
  if (uncorroboratedRecovery) {
    runtime.hardeningDriftDetectedAt = null;
    runtime.hardeningDriftDetail = "";
    runtime.hardeningDriftIssues = [];
    existingRecovery = false;
  }

  if (current) {
    armAppleContentFilterForProtectedLock(state, now);
    if (!existingRecovery) {
      return { active: false, started: false, cleared: false, current: true };
    }
    runtime.hardeningDriftDetectedAt = null;
    runtime.hardeningDriftDetail = "";
    runtime.hardeningDriftIssues = [];
    return {
      active: false,
      started: false,
      cleared: true,
      current: true,
      detail: "Apple Screen Time Limit Adult Websites is back on; recovery lockdown cleared."
    };
  }

  if (existingRecovery) {
    return {
      active: true,
      started: false,
      cleared: false,
      current: false,
      detail: runtime.hardeningDriftDetail || "Apple Screen Time web protection was disabled during a protected lock."
    };
  }

  const protectedLocks = protectedLockOverlaps(state, now.getTime(), now.getTime() + 1);
  const protectedLock = protectedLocks.find((lock) => appleContentFilterArmedForLock(runtime, lock));
  if (
    !safariFilter.required
    || !protectedLock
  ) {
    if (!protectedLocks.length) clearAppleContentFilterArm(runtime);
    return {
      active: false,
      started: false,
      cleared: false,
      current: false,
      reason: uncorroboratedRecovery
        ? "uncorroborated-recovery-cleared"
        : safariFilter.required ? "not-armed" : "not-required",
      detail: uncorroboratedRecovery
        ? "A legacy Apple-filter recovery alarm had no verified protected-lock transition, so Vigil cleared it as an uncorroborated setup warning."
        : safariFilter.required
        ? "Apple Screen Time web protection is not active. Finish setup before relying on it for a protected lock."
        : "Apple Screen Time web protection is not required for the current policy."
    };
  }

  const issue = {
    id: APPLE_CONTENT_FILTER_ISSUE_ID,
    detail: `Apple Screen Time web protection was disabled during ${protectedLock.name}.`
  };
  if (runtime.hardeningDriftDetectedAt) {
    return {
      active: true,
      started: false,
      cleared: false,
      current: false,
      detail: runtime.hardeningDriftDetail || issue.detail
    };
  }

  const started = !existingRecovery;
  runtime.hardeningDriftDetectedAt ||= now.toISOString();
  runtime.hardeningDriftIssues = [issue];
  runtime.hardeningDriftDetail = `Apple Screen Time web protection was disabled after Vigil verified it during ${protectedLock.name}; recovery lockdown blocks almost everything until it is restored.`;
  return {
    active: true,
    started,
    cleared: false,
    current: false,
    detectedAt: runtime.hardeningDriftDetectedAt,
    detail: runtime.hardeningDriftDetail,
    issues: runtime.hardeningDriftIssues
  };
}

export function protectedLockActive(state: VigilState, now = new Date()): boolean {
  const current = now.getTime();
  return protectedLockOverlaps(state, current, current + 1).length > 0;
}

export function hardeningDriftAttestationRequired(state: VigilState, now = new Date()): boolean {
  return Boolean(state.settings?.foolproofModeEnabled && protectedLockActive(state, now));
}

export function appleContentFilterRecoveryActive(state: VigilState): boolean {
  const runtime = ensureRuntime(state);
  const issues = Array.isArray(runtime.hardeningDriftIssues) ? runtime.hardeningDriftIssues : [];
  return Boolean(runtime.hardeningDriftDetectedAt && onlyAppleContentFilterIssue(issues));
}

function armAppleContentFilterForProtectedLock(state: VigilState, now: Date): void {
  const runtime = ensureRuntime(state);
  const protectedLocks = protectedLockOverlaps(state, now.getTime(), now.getTime() + 1);
  if (!protectedLocks.length) {
    clearAppleContentFilterArm(runtime);
    return;
  }
  runtime.appleContentFilterArmedAt = now.toISOString();
  runtime.appleContentFilterArmedLockId = protectedLocks[0].id;
  runtime.appleContentFilterArmedLockIds = [...new Set(protectedLocks.map((lock) => lock.id))];
}

function clearAppleContentFilterArm(runtime: IntegrityRuntimeState): void {
  runtime.appleContentFilterArmedAt = null;
  runtime.appleContentFilterArmedLockId = null;
  runtime.appleContentFilterArmedLockIds = [];
}

export function detectHardeningDrift(state: VigilState, checks: HardeningChecks = {}, now = new Date()) {
  const runtime = ensureRuntime(state);
  const existingIssues = Array.isArray(runtime.hardeningDriftIssues) ? runtime.hardeningDriftIssues : [];
  const existingAppleContentFilterRecovery = Boolean(runtime.hardeningDriftDetectedAt && onlyAppleContentFilterIssue(existingIssues));
  if (runtime.hardeningDriftDetectedAt && !existingAppleContentFilterRecovery) return null;
  if (!state.settings?.foolproofModeEnabled) return null;

  const current = now.getTime();
  const overlaps = protectedLockOverlaps(state, current, current + 1);
  if (!overlaps.length) return null;
  const armedAppleContentFilterOverlap = overlaps.find((lock) => appleContentFilterArmedForLock(runtime, lock));

  const issues = hardeningIssues(checks).filter((issue) =>
    issue.id !== APPLE_CONTENT_FILTER_ISSUE_ID
    || Boolean(armedAppleContentFilterOverlap)
  );
  if (!issues.length) return null;
  if (existingAppleContentFilterRecovery && onlyAppleContentFilterIssue(issues)) return null;
  const overlap = issues.some((issue) => issue.id === APPLE_CONTENT_FILTER_ISSUE_ID)
    ? armedAppleContentFilterOverlap || overlaps[0]
    : overlaps[0];

  runtime.hardeningDriftDetectedAt = runtime.hardeningDriftDetectedAt || now.toISOString();
  runtime.hardeningDriftIssues = issues;
  runtime.hardeningDriftDetail = `Hardening drift detected during ${overlap.name}: ${issues.map((issue) => issue.detail).join(" ")}`;

  return {
    detectedAt: runtime.hardeningDriftDetectedAt,
    detail: runtime.hardeningDriftDetail,
    issues,
    overlap
  };
}

function appleContentFilterArmedForLock(runtime: IntegrityRuntimeState, lock: ProtectedOverlap): boolean {
  return Boolean(runtime.appleContentFilterArmedAt && appleContentFilterArmedLockIds(runtime).includes(lock.id));
}

function appleContentFilterArmedLockIds(runtime: IntegrityRuntimeState): string[] {
  const ids = Array.isArray(runtime.appleContentFilterArmedLockIds)
    ? runtime.appleContentFilterArmedLockIds.filter((id): id is string => typeof id === "string" && Boolean(id))
    : [];
  if (typeof runtime.appleContentFilterArmedLockId === "string" && runtime.appleContentFilterArmedLockId) {
    ids.push(runtime.appleContentFilterArmedLockId);
  }
  return [...new Set(ids)];
}

export function detectRuntimeInterruption(
  state: VigilState,
  evidence: RuntimeInterruptionEvidenceInput,
  now = new Date(),
  options: RuntimeInterruptionOptions = {}
) {
  const runtime = ensureRuntime(state);
  const evidenceId = String(evidence.id || "").trim();
  if (!evidenceId || runtime.lastInterruptionId === evidenceId) return null;

  const current = now.getTime();
  const reported = Date.parse(evidence.detectedAt || "");
  const bootedAt = options.bootedAt instanceof Date && Number.isFinite(options.bootedAt.getTime())
    ? options.bootedAt.getTime()
    : current;
  const explicitGapStartedAt = options.gapStartedAt instanceof Date && Number.isFinite(options.gapStartedAt.getTime())
    ? options.gapStartedAt.getTime()
    : null;
  const futureEvidence = Number.isFinite(reported) && reported > current;
  let gapStartedAt = current;
  if (explicitGapStartedAt !== null) gapStartedAt = Math.min(explicitGapStartedAt, current);
  else if (options.rebooted) gapStartedAt = Math.min(bootedAt, current);
  else if (Number.isFinite(reported)) gapStartedAt = Math.min(reported, current);
  const gapEndedAt = futureEvidence ? reported : current;
  const gapSeconds = Math.max(0, Math.round(Math.abs(gapEndedAt - gapStartedAt) / 1000));

  runtime.lastInterruptionId = evidenceId;
  runtime.lastInterruptionObservedAt = now.toISOString();

  const overlap = protectedLockOverlap(state, gapStartedAt, Math.max(gapStartedAt + 1, gapEndedAt));
  const thresholdReached = options.rebooted || futureEvidence || gapSeconds >= runtimeGapLockdownSeconds(state);
  if (runtime.downtimeDetectedAt || !overlap || !thresholdReached) {
    return {
      id: evidenceId,
      observedAt: runtime.lastInterruptionObservedAt,
      gapSeconds,
      gapStartedAt: new Date(gapStartedAt).toISOString(),
      gapEndedAt: new Date(gapEndedAt).toISOString(),
      rebooted: Boolean(options.rebooted),
      futureEvidence,
      lockdown: false,
      overlap
    };
  }

  runtime.downtimeDetectedAt = now.toISOString();
  runtime.downtimeDetail = options.rebooted
    ? `Restart supervision found an unclean prior runtime across a system restart during ${overlap.name}.`
    : futureEvidence
      ? `Restart supervision evidence was ${gapSeconds}s in the future during ${overlap.name}.`
      : `Restart supervision detected a ${gapSeconds}s runtime interruption during ${overlap.name}.`;
  runtime.lastGapSeconds = gapSeconds;
  runtime.lastGapStartedAt = new Date(gapStartedAt).toISOString();
  runtime.lastGapEndedAt = new Date(gapEndedAt).toISOString();
  return {
    id: evidenceId,
    detectedAt: runtime.downtimeDetectedAt,
    detail: runtime.downtimeDetail,
    gapSeconds,
    gapStartedAt: runtime.lastGapStartedAt,
    gapEndedAt: runtime.lastGapEndedAt,
    rebooted: Boolean(options.rebooted),
    futureEvidence,
    lockdown: true,
    overlap
  };
}

export function detectClockTamper(state: VigilState, sample: ClockTamperSample = {}, now = new Date()) {
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

export function integrityRuntimeSummary(state: VigilState) {
  const runtime = ensureRuntime(state);
  if (runtime.downtimeDetectedAt) {
    return {
      ok: false,
      status: "downtime-detected",
      detail: runtime.downtimeDetail || "Vigil was offline during a protected lock.",
      downtimeDetectedAt: runtime.downtimeDetectedAt,
      lastGapSeconds: runtime.lastGapSeconds || 0
    };
  }

  if (runtime.hardeningDriftDetectedAt) {
    return {
      ok: false,
      status: "hardening-drift",
      detail: runtime.hardeningDriftDetail || "A hardening protection weakened during a protected lock.",
      hardeningDriftDetectedAt: runtime.hardeningDriftDetectedAt,
      hardeningDriftIssues: runtime.hardeningDriftIssues || []
    };
  }

  if (runtime.clockTamperDetectedAt) {
    return {
      ok: false,
      status: "clock-tamper",
      detail: runtime.clockTamperDetail || "System clock changed during a protected lock.",
      clockTamperDetectedAt: runtime.clockTamperDetectedAt,
      clockTamperSeconds: runtime.clockTamperSeconds || 0,
      clockTamperDirection: runtime.clockTamperDirection || ""
    };
  }

  return {
    ok: true,
    status: "clear",
    detail: "No runtime integrity alarm is active.",
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

function activeIntegrityAlarm(state: VigilState): IntegrityAlarm | null {
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
      detail: runtime.downtimeDetail || "Vigil was offline during a protected lock.",
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
  const safariFilter = checks.safariFilter;
  const chromeSafeSearch = checks.chromeSafeSearch;
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

  if (safariFilter?.required && !appleContentFilterCurrent(safariFilter)) {
    issues.push({
      id: APPLE_CONTENT_FILTER_ISSUE_ID,
      detail: "Apple Screen Time Limit Adult Websites or Content & Privacy Restrictions are not active."
    });
  }

  if (chromeSafeSearch && chromeSafeSearch.required !== false && !chromeSafeSearchCurrent(chromeSafeSearch)) {
    issues.push({
      id: CHROME_SAFE_SEARCH_ISSUE_ID,
      detail: chromeSafeSearch.detail || "Chrome SafeSearch is not locked to Filter by a protected, current device-management profile."
    });
  }

  if (agent && (!agent.loaded || !agent.running)) {
    issues.push({
      id: "launch-agent",
      detail: agent.installed
        ? "LaunchAgent is not loaded and running."
        : "LaunchAgent is not installed."
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

function appleContentFilterCurrent(safariFilter: HardeningCheck): boolean {
  const apple = safariFilter.appleContentFilter;
  if (isRecord(apple) && "current" in apple) return Boolean(apple.current);
  if ("appleCurrent" in safariFilter) return Boolean(safariFilter.appleCurrent);
  return false;
}

function chromeSafeSearchCurrent(chromeSafeSearch: HardeningCheck): boolean {
  if ("effectiveCurrent" in chromeSafeSearch) return Boolean(chromeSafeSearch.effectiveCurrent);
  return Boolean(chromeSafeSearch.current);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function integrityTamperProfile(): ActivePolicy["profile"] {
  return {
    id: "integrity-lockdown",
    name: "Integrity lockdown",
    mode: "blocklist",
    description: "Fail-closed defaults used after local state tampering is detected.",
    blockedApps: unique([...DEFAULT_BLOCKED_APPS, ...STRICT_BYPASS_APPS]),
    blockedSites: unique(DEFAULT_BLOCKED_SITES),
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: ["localhost", "127.0.0.1"]
  };
}

function appleContentFilterRecoveryProfile(): ActivePolicy["profile"] {
  return {
    id: "apple-content-filter-recovery",
    name: "Apple content filter recovery",
    mode: "allowlist",
    description: "Blocks almost everything until Apple Screen Time Limit Adult Websites and Content & Privacy Restrictions are turned back on.",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [
      "Vigil",
      "System Settings",
      "System Preferences",
      "Finder",
      "loginwindow",
      "Codex"
    ],
    allowedSites: ["localhost", "127.0.0.1"]
  };
}

function appleContentFilterRecoveryAlarm(alarm: IntegrityAlarm): boolean {
  return onlyAppleContentFilterIssue(alarm.issues || []);
}

function onlyAppleContentFilterIssue(issues: readonly HardeningIssue[]): boolean {
  return Boolean(issues.length && issues.every((issue) => issue.id === APPLE_CONTENT_FILTER_ISSUE_ID));
}

function ensureRuntime(state: VigilState): IntegrityRuntimeState {
  state.integrity.runtime ||= {};
  return state.integrity.runtime;
}

function runtimeGapLockdownSeconds(state: VigilState): number {
  return Math.max(30, Number(state.settings?.runtimeGapLockdownSeconds || DEFAULT_GAP_LOCKDOWN_SECONDS));
}

function clockTamperLockdownSeconds(state: VigilState): number {
  return Math.max(30, Number(state.settings?.clockTamperLockdownSeconds || DEFAULT_CLOCK_TAMPER_SECONDS));
}

function protectedLockOverlap(state: VigilState, startMs: number, endMs: number): ProtectedOverlap | null {
  return protectedLockOverlaps(state, startMs, endMs)[0] || null;
}

function protectedLockOverlaps(state: VigilState, startMs: number, endMs: number): ProtectedOverlap[] {
  const overlaps = protectedSessionOverlaps(state, startMs, endMs);

  for (const block of state.limitBlocks || []) {
    const blockStartsAt = Date.parse(block.createdAt || "");
    const blockEndsAt = Date.parse(block.until || "");
    const overrides = (state.overrides || [])
      .filter((override) => override.limitRuleId === block.ruleId)
      .map((override) => [overrideStart(override.createdAt), Date.parse(override.until || "")] as const);
    if (
      block.lockLevel === "deep"
      && rangeHasUncoveredOverlap(startMs, endMs, blockStartsAt, blockEndsAt, overrides)
    ) {
      overlaps.push({ kind: "limit", id: block.id, name: block.ruleName || "limit block" });
    }
  }

  for (const schedule of state.schedules || []) {
    const overlap = strictScheduleOverlap(state, schedule, startMs, endMs, state.environment?.wifiSsid || "");
    if (overlap) overlaps.push(overlap);
  }

  for (const block of state.intentionalUse?.planBlocks || []) {
    if (block.enabled === false || block.completed || block.lockLevel !== "deep") continue;
    if (rangesOverlap(startMs, endMs, Date.parse(block.startsAt || ""), Date.parse(block.endsAt || ""))) {
      overlaps.push({
        kind: "schedule",
        id: block.id,
        name: block.title || "planner block",
        startsAt: block.startsAt,
        endsAt: block.endsAt
      });
    }
  }

  return overlaps;
}

function protectedSessionOverlaps(state: VigilState, startMs: number, endMs: number): ProtectedOverlap[] {
  const sessions = [
    ...Object.values(state.activeSessions || {}),
    state.activeSession
  ];
  const seen = new Set<string>();
  const overlaps: ProtectedOverlap[] = [];
  for (const session of sessions) {
    if (!session) continue;
    const key = session.id || `${session.startedAt}:${session.endsAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (session.lockLevel === "deep" && rangesOverlap(startMs, endMs, Date.parse(session.startedAt || ""), Date.parse(session.endsAt || ""))) {
      overlaps.push({
        kind: "manual",
        id: session.id,
        name: session.title || "strict session",
        startsAt: session.startedAt,
        endsAt: session.endsAt
      });
    }
  }
  return overlaps;
}

function strictScheduleOverlap(
  state: VigilState,
  schedule: Schedule,
  startMs: number,
  endMs: number,
  currentWifi = ""
): ProtectedOverlap | null {
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
    const overrides = (state.overrides || [])
      .filter((override) => (
        override.scheduleId === schedule.id
        && Date.parse(override.until || "") >= window.endsAt
      ))
      .map((override) => [overrideStart(override.createdAt), window.endsAt] as const);
    if (rangeHasUncoveredOverlap(startMs, endMs, window.startsAt, window.endsAt, overrides)) {
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

function rangeHasUncoveredOverlap(
  rangeStart: number,
  rangeEnd: number,
  protectedStart: number,
  protectedEnd: number,
  overrideRanges: readonly (readonly [number, number])[]
): boolean {
  if (![rangeStart, rangeEnd, protectedStart, protectedEnd].every(Number.isFinite)) return false;
  const overlapStart = Math.max(rangeStart, protectedStart);
  const overlapEnd = Math.min(rangeEnd, protectedEnd);
  if (overlapStart >= overlapEnd) return false;

  let coveredUntil = overlapStart;
  const orderedOverrides = overrideRanges
    .filter(([startsAt, endsAt]) => (
      Number.isFinite(startsAt)
      && Number.isFinite(endsAt)
      && startsAt < endsAt
      && rangesOverlap(overlapStart, overlapEnd, startsAt, endsAt)
    ))
    .sort((left, right) => left[0] - right[0]);
  for (const [startsAt, endsAt] of orderedOverrides) {
    if (endsAt <= coveredUntil) continue;
    if (startsAt > coveredUntil) return true;
    coveredUntil = Math.max(coveredUntil, endsAt);
    if (coveredUntil >= overlapEnd) return false;
  }
  return coveredUntil < overlapEnd;
}

function overrideStart(value: unknown): number {
  const createdAt = Date.parse(String(value || ""));
  // Legacy overrides predate createdAt. They were historically treated as
  // active for their whole retained lifetime, so preserve that behavior.
  return Number.isFinite(createdAt) ? createdAt : 0;
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
