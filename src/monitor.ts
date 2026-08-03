import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { addEvent, DATA_DIR, saveState, STATE_SEAL_KEY_PATH } from "./store.js";
import { PORT } from "./defaults.js";
import { buildBlockedPageUrl, safeExternalPageUrl } from "./blockedPageUrl.js";
import { contentFilterEnabled } from "./contentFilters.js";
import { attestChromeSafeSearchStatus } from "./chromeSafeSearch.js";
import { reconcileFocusShortcut } from "./focusHooks.js";
import { activePolicy, isFullLockoutPolicy, matchBlockedUrlPattern, shouldBlockSite } from "./policy.js";
import { extensionDynamicRulesReady } from "./foolproof.js";
import { firewallStatus } from "./firewall.js";
import { grayscaleDecision, grayscaleGuardEnabled, MAC_GRAYSCALE_GUARD_APPS } from "./grayscale.js";
import { hostsStatus, launchAgentStatus, managedBlockDomains, stateSealStatus } from "./hardening.js";
import { appleContentFilterRecoveryActive, detectClockTamper, detectHardeningDrift, hardeningDriftAttestationRequired, integrityLockdownActive, protectedLockActive, syncAppleContentFilterLockdown } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { iosMdmQueuedPushEligible, maybeQueueIosMdmPolicyRefresh, pushIosMdmQueuedCommands } from "./iosMdm.js";
import { activeLimitBlocks } from "./limits.js";
import { appCanReportUrls, browserActivityWatchHealthy, getActiveBrowserUrl, getCurrentWifiNetwork, getFrontmostApp, getMacIdleTime, listRunningAppNames, lockScreen, openUrl, readMacGrayscaleState, redirectActiveBrowserTab, quitApp, setMacGrayscaleEnabled, subscribeBrowserActivity, urlHostname } from "./macos.js";
import type { BrowserActivitySignal } from "./macos.js";
import { BrowserActivityBurstScheduler } from "./monitor/browserActivity.js";
import type { BrowserActivityBurstSchedulerDependencies } from "./monitor/browserActivity.js";
import { appQuitEscalationDecision, hostPathPatternCanUseSystemNetwork, policyForSample, shouldAttemptBlockedBrowserRedirect, shouldLockScreenForPolicy, shouldQuitAppForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";
import type { AppBlockRecord, EnforcedPolicy } from "./monitor/policy.js";
import { activeSecondsBeforeIdleThreshold, idleUsageThresholdSeconds, isInterruptedPollGap, roundSeconds } from "./monitor/timing.js";
import { safariFilterDenyMatch, safariFilterStatus } from "./safariFilter.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { isNonRetryableRuntimeUsageCheckpointError, runtimeUsageCheckpointPath, saveRuntimeUsageCheckpoint } from "./runtimeUsageCheckpoint.js";
import { networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import { dateKey } from "./time.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { MonitorHandle, VigilState, UnknownRecord, UsageSample, UsageState } from "./types.js";

export { appQuitEscalationDecision, shouldAttemptBlockedBrowserRedirect, shouldLockScreenForPolicy, shouldQuitAppForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";

interface MonitorContext {
  state: VigilState;
  usage: UsageState;
  externalEffectsEnabled?: boolean;
  runtimeInstanceId?: string;
  committedRevision?: () => number;
  browserActivityNow?: () => number;
  browserActivitySubscribe?: (listener: (signal: BrowserActivitySignal) => void) => () => void;
  browserActivityHealthy?: () => boolean;
  browserActivityBurstDependencies?: Partial<BrowserActivityBurstSchedulerDependencies>;
  browserRedirect?: typeof redirectActiveBrowserTab;
  runtimeUsageCheckpointEnabled?: boolean;
  runtimeUsageCheckpointWriter?: typeof saveRuntimeUsageCheckpoint;
  runtimeUsageCheckpointLocation?: { checkpointPath: string; keyPath: string };
  startupSnapshotPersisted?: boolean;
  mutate?: <T>(operation: (
    state: VigilState,
    usage: UsageState,
    afterCommit: <TResult>(
      effect: () => TResult | Promise<TResult>,
      descriptor?: { key: string; kind: string; payload: UnknownRecord },
      complete?: (result: TResult, state: VigilState, usage: UsageState) => void | Promise<void>,
      fail?: (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
    ) => void,
    requestPersistence?: () => void
  ) => Promise<T>, options?: MonitorMutationOptions) => Promise<T>;
}

interface MonitorMutationOptions {
  persist?: boolean;
  deferEffectAttempts?: boolean;
  captureEffectAttemptBarrier?: (barrier: Promise<void>) => void;
}

export const MONITOR_FULL_CHECKPOINT_INTERVAL_MS = 15 * 60_000;
export const MONITOR_HOT_CHECKPOINT_INTERVAL_MS = 15_000;
export const MONITOR_HOT_CHECKPOINT_MAX_RETRY_MS = MONITOR_FULL_CHECKPOINT_INTERVAL_MS;
export const MONITOR_RECOVERY_POLL_INTERVAL_MS = 3_000;
export const HARDENING_DRIFT_EVIDENCE_MAX_AGE_MS = 15_000;
export const BROWSER_ACTIVITY_PERSISTENCE_RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 3_000]);
export const BROWSER_ACTIVITY_PERSISTENCE_SHUTDOWN_MAX_ATTEMPTS = 4;

export function monitorPollIntervalMs(configuredIntervalMs: unknown, activityAccelerationHealthy: boolean): number {
  const configured = Number(configuredIntervalMs);
  const intervalMs = Number.isFinite(configured) && configured > 0 ? configured : 15_000;
  return activityAccelerationHealthy ? intervalMs : Math.min(intervalMs, MONITOR_RECOVERY_POLL_INTERVAL_MS);
}

export function hotUsageCheckpointRetryDelayMs(failureCount: unknown): number {
  const failures = Math.max(1, Math.trunc(Number(failureCount) || 1));
  return Math.min(
    MONITOR_HOT_CHECKPOINT_MAX_RETRY_MS,
    MONITOR_HOT_CHECKPOINT_INTERVAL_MS * (2 ** Math.min(failures, 16))
  );
}

export function hotUsageCheckpointFingerprint(state: VigilState, usage: UsageState, now = new Date()): string {
  const day = dateKey(now);
  const previousLocalDay = new Date(now);
  previousLocalDay.setDate(previousLocalDay.getDate() - 1);
  const previousDay = dateKey(previousLocalDay);
  const grantCounters = (state.intentionalUse?.grants || [])
    .map((grant) => ({
      id: grant.id,
      usedSeconds: Number(grant.usedSeconds || 0),
      lastSeenAt: grant.lastSeenAt || null
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(JSON.stringify({
    days: [previousDay, day].map((dayKey) => ({
      dayKey,
      usage: usage[dayKey] || null,
      intentionalDay: state.intentionalUse?.ledger?.[dayKey] || null
    })),
    grantCounters
  }), "utf8").digest("hex");
}

function appleContentFilterDurabilityFingerprint(state: VigilState): string {
  const runtime = state.integrity?.runtime || {};
  const armedLockIds = [
    ...(Array.isArray(runtime.appleContentFilterArmedLockIds)
      ? runtime.appleContentFilterArmedLockIds
      : []),
    runtime.appleContentFilterArmedLockId
  ]
    .filter((id): id is string => typeof id === "string" && Boolean(id))
    .sort();
  return JSON.stringify({
    armed: Boolean(runtime.appleContentFilterArmedAt),
    armedLockIds: [...new Set(armedLockIds)],
    recoveryDetectedAt: runtime.hardeningDriftDetectedAt || null,
    recoveryDetail: runtime.hardeningDriftDetail || "",
    recoveryIssues: runtime.hardeningDriftIssues || []
  });
}

function iosMdmQueueDurabilityFingerprint(state: VigilState): string {
  const mdm = state.deviceControls?.ios?.mdm;
  return JSON.stringify({
    lastPolicyHash: mdm?.lastPolicyHash || "",
    lastGrayscaleHash: mdm?.lastGrayscaleHash || "",
    lastCommandQueuedAt: mdm?.lastCommandQueuedAt || null,
    commands: (mdm?.commands || [])
      .map((command) => ({
        id: String(command.id || ""),
        commandUuid: String(command.commandUuid || ""),
        requestType: String(command.requestType || ""),
        status: String(command.status || ""),
        policyHash: String(command.policyHash || "") || null,
        grayscaleHash: String(command.grayscaleHash || "") || null,
        queuedAt: String(command.queuedAt || ""),
        completedAt: String(command.completedAt || "") || null
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  });
}

export function isVigilBlockedPageUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/blocked") return false;
    if (String(url.port || "80") === String(PORT)) return true;
    // A prior Vigil process may have used another loopback port. Recognize its
    // fully marked receipt so it is not recursively nested into a new `back`
    // parameter after an update or restart.
    return ["site", "until", "mode", "policyId"].every((key) => url.searchParams.has(key));
  } catch {
    return false;
  }
}

function browserOriginUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? `${url.origin}/` : "";
  } catch {
    return "";
  }
}

function sameBrowserUrl(left: unknown, right: unknown): boolean {
  try {
    return new URL(String(left || "")).toString() === new URL(String(right || "")).toString();
  } catch {
    return false;
  }
}

function browserActivityPersistenceRetryDelayMs(attempts: number): number {
  const index = Math.min(
    Math.max(0, Math.trunc(attempts) - 1),
    BROWSER_ACTIVITY_PERSISTENCE_RETRY_DELAYS_MS.length - 1
  );
  return BROWSER_ACTIVITY_PERSISTENCE_RETRY_DELAYS_MS[index]!;
}

interface FrontSample extends UsageSample {
  app: string;
  hostname: string;
  url: string;
}

type FrontResult = (FrontSample & { ok: true }) | { ok: false; app: string; error: string };

interface FrontReadOptions {
  fresh?: boolean;
  updateHealth?: boolean;
}

interface WifiEnvironmentObservation {
  ok: boolean;
  ssid?: string;
  error?: string;
}

export const MONITOR_HEALTH_COMPONENTS = Object.freeze([
  "tick", "frontmost", "idle-usage", "wifi", "screen-lock", "focus-shortcut",
  "grayscale", "grayscale-guard", "process-sweep", "mdm-push"
]);

export function applyWifiEnvironmentObservation(
  state: VigilState,
  observation: WifiEnvironmentObservation,
  now = new Date()
): void {
  if (observation.ok) {
    state.environment.wifiSsid = String(observation.ssid || "");
    state.environment.wifiCheckedAt = now.toISOString();
    state.environment.wifiError = "";
    return;
  }

  state.environment.wifiError = observation.error || "Wi-Fi lookup failed";
}

export function wifiEnvironmentObservationRequired(state: VigilState): boolean {
  return (state.schedules || []).some((schedule) => (
    schedule.enabled !== false
    && Array.isArray(schedule.wifiNetworks)
    && schedule.wifiNetworks.some((network) => String(network || "").trim())
  ));
}

export function hardeningDriftPolicyFingerprint(state: VigilState, now = new Date()): string {
  const runtime = state.integrity?.runtime || {};
  // Keep persistence-only metadata (events, seal timestamps, effect
  // acknowledgements) out of this generation. Those can change while evidence
  // is collected without changing what hardening the active policy requires.
  // The raw policy inputs plus derived time-sensitive outputs cover session,
  // schedule, limit, app-lock, Safari/hosts/firewall, and extension rules.
  return JSON.stringify({
    foolproofModeEnabled: Boolean(state.settings?.foolproofModeEnabled),
    attestationRequired: hardeningDriftAttestationRequired(state, now),
    activePolicy: activePolicy(structuredClone(state), now),
    managedDomains: managedBlockDomains(structuredClone(state), now),
    settings: state.settings,
    adultBlocklist: state.adultBlocklist,
    profiles: state.profiles,
    schedules: state.schedules,
    limitRules: state.limitRules,
    limitBlocks: state.limitBlocks,
    appLocks: state.appLocks,
    planBlocks: state.intentionalUse?.planBlocks || [],
    extensionDynamicRules: state.extension?.dynamicRules || {},
    extensionRules: extensionDynamicRulesReady(structuredClone(state), now),
    wifiSsid: state.environment?.wifiSsid || "",
    activeSessions: state.activeSessions,
    activeSession: state.activeSession,
    panicLock: state.panicLock,
    overrides: state.overrides,
    hardeningRuntime: {
      appleContentFilterArmedAt: runtime.appleContentFilterArmedAt || null,
      appleContentFilterArmedLockId: runtime.appleContentFilterArmedLockId || null,
      appleContentFilterArmedLockIds: runtime.appleContentFilterArmedLockIds || [],
      hardeningDriftDetectedAt: runtime.hardeningDriftDetectedAt || null,
      hardeningDriftIssues: runtime.hardeningDriftIssues || []
    }
  });
}

export function browserActivityPolicyFingerprint(
  state: VigilState,
  usage: UsageState,
  now = new Date(),
  networkBlock: UnknownRecord | null = null
): string {
  const evaluatedState = structuredClone(state);
  const active = activePolicy(evaluatedState, now);
  const timestamp = now.getTime();
  const activeIds = <T extends UnknownRecord>(items: T[] | undefined, field: keyof T): string[] => (
    (items || [])
      .filter((item) => {
        const until = Date.parse(String(item[field] || ""));
        return Number.isFinite(until) && until > timestamp;
      })
      .map((item) => String(item.id || ""))
      .filter(Boolean)
      .sort()
  );
  const runtime = state.integrity?.runtime || {};
  const stateSeal = state.integrity?.stateSeal || {};

  // This selector is evaluated only when the coordinator publishes a new
  // committed revision or a known time boundary is crossed. It intentionally
  // excludes events and other telemetry while retaining every input
  // used by foreground app/site, network-only, intentional-use, app-lock, and
  // usage-limit decisions.
  return JSON.stringify({
    minute: now.toISOString().slice(0, 16),
    activePolicy: active,
    settings: state.settings,
    adultBlocklist: state.adultBlocklist,
    profiles: state.profiles,
    schedules: state.schedules,
    limitRules: state.limitRules,
    limitBlocks: state.limitBlocks,
    appLocks: state.appLocks,
    appLockUnlocks: state.appLockUnlocks,
    appLockLedger: state.appLockLedger,
    intentionalUse: {
      rules: state.intentionalUse?.rules || [],
      pauses: state.intentionalUse?.pauses || [],
      grants: state.intentionalUse?.grants || [],
      ledger: state.intentionalUse?.ledger || {},
      planBlocks: state.intentionalUse?.planBlocks || []
    },
    activeSessions: state.activeSessions,
    activeSession: state.activeSession,
    panicLock: state.panicLock,
    overrides: state.overrides,
    environment: { wifiSsid: state.environment?.wifiSsid || "" },
    integrityAlarm: {
      stateSealTamperDetectedAt: stateSeal.tamperDetectedAt || null,
      downtimeDetectedAt: runtime.downtimeDetectedAt || null,
      hardeningDriftDetectedAt: runtime.hardeningDriftDetectedAt || null,
      hardeningDriftIssues: runtime.hardeningDriftIssues || [],
      clockTamperDetectedAt: runtime.clockTamperDetectedAt || null
    },
    activeDeadlines: {
      limitBlocks: activeIds(state.limitBlocks as unknown as UnknownRecord[], "until"),
      appLockUnlocks: activeIds(state.appLockUnlocks as unknown as UnknownRecord[], "until"),
      overrides: activeIds(state.overrides as unknown as UnknownRecord[], "until"),
      intentionalGrants: activeIds(state.intentionalUse?.grants as unknown as UnknownRecord[], "until"),
      intentionalPauses: activeIds(state.intentionalUse?.pauses as unknown as UnknownRecord[], "expiresAt")
    },
    networkBlock: networkBlock ? {
      current: Boolean(networkBlock.current),
      hosts: {
        installed: Boolean((networkBlock.hosts as UnknownRecord | undefined)?.installed),
        partial: Boolean((networkBlock.hosts as UnknownRecord | undefined)?.partial),
        stale: Boolean((networkBlock.hosts as UnknownRecord | undefined)?.stale)
      },
      firewall: {
        installed: Boolean((networkBlock.firewall as UnknownRecord | undefined)?.installed),
        partial: Boolean((networkBlock.firewall as UnknownRecord | undefined)?.partial),
        stale: Boolean((networkBlock.firewall as UnknownRecord | undefined)?.stale)
      }
    } : null,
    usage: usage[dateKey(now)] || {}
  });
}

export function policyBoundaryTransitionFingerprint(state: VigilState, at = new Date()): string {
  const timestamp = at.getTime();
  const activeIds = (items: UnknownRecord[] | undefined, field: string, status?: [string, string]): string[] => (
    (items || [])
      .filter((item) => {
        if (status && String(item[status[0]] || "") !== status[1]) return false;
        const until = Date.parse(String(item[field] || ""));
        return Number.isFinite(until) && until > timestamp;
      })
      .map((item) => String(item.id || ""))
      .filter(Boolean)
      .sort()
  );
  const policyForDevice = (device: "computer" | "phone") => (
    activePolicy(structuredClone(state), at, { device })
  );
  const grayscaleForDevice = (device: "computer" | "phone") => {
    const decision = grayscaleDecision(structuredClone(state), at, { device });
    return {
      desired: decision.desired,
      reason: decision.reason,
      source: decision.source,
      scheduleId: decision.schedule?.id || null,
      policy: decision.policy
    };
  };
  const activeLimitIds = (device: "computer" | "phone") => (
    activeLimitBlocks(structuredClone(state), at, { device }).map((block) => block.id).sort()
  );
  const extensionRules = extensionDynamicRulesReady(structuredClone(state), at);
  const activeAppLockIds = (state.appLocks || [])
    .filter((lock) => lock.enabled && (!(lock.days || []).length || lock.days.includes(at.getDay())))
    .map((lock) => lock.id)
    .sort();

  return JSON.stringify({
    date: dateKey(at),
    policies: {
      computer: policyForDevice("computer"),
      phone: policyForDevice("phone")
    },
    activeAppLockIds,
    activeLimitIds: {
      computer: activeLimitIds("computer"),
      phone: activeLimitIds("phone")
    },
    activeDeadlines: {
      appLockUnlocks: activeIds(state.appLockUnlocks as unknown as UnknownRecord[], "until"),
      overrides: activeIds(state.overrides as unknown as UnknownRecord[], "until"),
      intentionalGrants: activeIds(state.intentionalUse?.grants as unknown as UnknownRecord[], "until", ["status", "active"]),
      intentionalPauses: activeIds(state.intentionalUse?.pauses as unknown as UnknownRecord[], "expiresAt", ["status", "pending"])
    },
    grayscale: {
      computer: grayscaleForDevice("computer"),
      phone: grayscaleForDevice("phone")
    },
    managedDomains: managedBlockDomains(structuredClone(state), at),
    extensionRules: {
      expectedCount: extensionRules.expectedCount,
      expectedSignature: extensionRules.expectedSignature
    }
  });
}

export function policyBoundaryRequiresImmediateEnforcement(
  state: VigilState,
  boundary: number,
  checkedAt = Date.now()
): boolean {
  const before = policyBoundaryTransitionFingerprint(state, new Date(boundary - 1));
  const after = policyBoundaryTransitionFingerprint(state, new Date(Math.max(boundary, checkedAt)));
  return before !== after;
}

function nextBrowserActivityPolicyBoundary(state: VigilState, now: number): number {
  let next = Math.floor(now / 60_000) * 60_000 + 60_000;
  const consider = (value: unknown) => {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp) && timestamp > now) next = Math.min(next, timestamp);
  };
  const policy = activePolicy(structuredClone(state), new Date(now));
  consider(policy?.endsAt);
  consider(policy?.phase?.endsAt);
  consider(state.activeSession?.endsAt);
  for (const session of Object.values(state.activeSessions || {})) consider(session?.endsAt);
  consider((state.panicLock as UnknownRecord | null)?.until);
  consider((state.panicLock as UnknownRecord | null)?.endsAt);
  for (const item of state.limitBlocks || []) consider(item.until);
  for (const item of state.appLockUnlocks || []) consider(item.until);
  for (const item of state.overrides || []) consider(item.until);
  for (const item of state.intentionalUse?.grants || []) consider(item.until);
  for (const item of state.intentionalUse?.pauses || []) {
    consider(item.expiresAt);
  }
  for (const item of state.intentionalUse?.planBlocks || []) {
    consider(item.startsAt);
    consider(item.endsAt);
  }
  return next;
}

interface MonitorStatus extends UnknownRecord {
  ok: boolean;
  lastError: string;
  componentErrors: Record<string, string>;
  componentHealth: Record<string, { lastAttemptAt: string; lastSuccessAt: string | null; error: string; applicable: boolean; state: "healthy" | "degraded" | "pending" | "disabled" }>;
  runtimeInstanceId: string;
  runtimeStartedAt: string;
  lastSuccessfulTickAt: string | null;
  lastSample: FrontSample | null;
  lastEnforcement: UnknownRecord | null;
  stateSeal: UnknownRecord | null;
  clockTamper: UnknownRecord | null;
  hardeningDrift: UnknownRecord | null;
  appleContentFilterLockdown: UnknownRecord | null;
  networkBlock: UnknownRecord | null;
  lastProcessSweep: UnknownRecord | null;
  lastImmediateEnforcement: UnknownRecord | null;
  lastSystemSleepLock: UnknownRecord | null;
  lastFocusShortcut: UnknownRecord | null;
  lastGrayscale: UnknownRecord | null;
  lastIdleAccounting: UnknownRecord | null;
  accessibilityLikelyMissing: boolean;
  browserActivityAccelerationHealthy: boolean;
  effectivePollIntervalMs: number;
}

interface BlockSiteOptions {
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string; fallbackUrl?: string };
  urlPattern?: { pattern: string; label: string };
  originalHostname?: string;
}

interface BlockedPageValidationSnapshot {
  state: VigilState;
  usage: UsageState;
}

interface BrowserBlockRecord {
  front: FrontSample;
  policy: EnforcedPolicy;
  options: BlockSiteOptions;
}

interface BrowserBlockDecision extends BrowserBlockRecord {
  sample: FrontSample;
  evaluatedAt: string;
}

interface PendingBrowserActivityMutation {
  operation: () => Promise<void>;
  persist: boolean;
  attempts: number;
  nextRetryAt: number;
}

interface HardeningDriftMeasurement {
  checkedAt: number;
  policyFingerprint: string;
  monitorFingerprint: string;
  checks: {
    hosts: UnknownRecord;
    firewall: UnknownRecord;
    safariFilter: UnknownRecord;
    chromeSafeSearch: UnknownRecord;
    agent: UnknownRecord;
    monitor: UnknownRecord;
    extensionRules: UnknownRecord;
    sourceSeal: UnknownRecord;
  };
}

interface HardeningDriftApplyResult {
  stale: boolean;
  drift: boolean;
}

interface ImmediateSideEffectObservations {
  grayscale: Awaited<ReturnType<typeof readMacGrayscaleState>>;
  runningApps: Awaited<ReturnType<typeof listRunningAppNames>>;
}

interface BlockAppOptions {
  source?: string;
}

interface PollFrame {
  now: number;
  monotonicNow: number;
  previousWall: number;
  previousMonotonic: number;
  seconds: number;
}

interface MonitorTransactionSnapshot {
  lastPollAt: number;
  lastMonotonicAt: number;
  lastSample: FrontSample | null;
  previousSample: FrontSample | null;
  status: MonitorStatus;
  recentBlocks: Map<string, number>;
  appBlockHistory: Map<string, AppBlockRecord>;
  nextEnvironmentRefreshAt: number;
  nextIntegrityRefreshAt: number;
  nextAppleContentFilterRefreshAt: number;
  nextHardeningDriftRefreshAt: number;
  nextNetworkBlockRefreshAt: number;
  nextProcessSweepAt: number;
  nextSystemSleepLockAt: number;
  nextGrayscaleRefreshAt: number;
  lastBrowserActivityEvaluatedTarget: string;
  lastBrowserActivityEvaluatedGeneration: number;
  lastBrowserActivityEvaluatedPolicyGeneration: number;
  browserActivityPolicyGeneration: number;
  browserActivityPolicyFingerprint: string;
  browserActivityObservedCommitRevision: number;
  browserActivityNextPolicyRefreshAt: number;
  durableEffectProblems: Map<string, { component: string; error: string; pending: boolean }>;
}

export function startMonitor(context: MonitorContext, options: { start?: boolean } = {}): MonitorHandle {
  const monitor = new Monitor(context);
  if (options.start !== false) monitor.start();
  return monitor;
}

export class Monitor implements MonitorHandle {
  state: VigilState;
  usage: UsageState;
  committedState: VigilState;
  committedUsage: UsageState;
  lastPollAt: number;
  lastMonotonicAt: number;
  lastSample: FrontSample | null;
  previousSample: FrontSample | null;
  timer: ReturnType<typeof setInterval> | null;
  lastScheduledTickMonotonicAt: number;
  policyBoundaryTimer: ReturnType<typeof setTimeout> | null;
  status: MonitorStatus;
  recentBlocks: Map<string, number>;
  appBlockHistory: Map<string, AppBlockRecord>;
  immediateEnforcement: Promise<UnknownRecord> | null;
  pendingImmediateEnforcementReasons: Set<string>;
  tickInFlight: Promise<void> | null;
  operationCommitTail: Promise<void>;
  operationTail: Promise<void>;
  pendingMutationEffectAttempts: Set<Promise<void>>;
  stopping: boolean;
  nextEnvironmentRefreshAt: number;
  nextIntegrityRefreshAt: number;
  nextAppleContentFilterRefreshAt: number;
  nextHardeningDriftRefreshAt: number;
  hardeningDriftMeasurement: Promise<boolean> | null;
  nextNetworkBlockRefreshAt: number;
  nextProcessSweepAt: number;
  nextSystemSleepLockAt: number;
  nextGrayscaleRefreshAt: number;
  nextFullCheckpointAt: number;
  nextHotCheckpointAt: number;
  lastHotCheckpointFingerprint: string;
  runtimeUsageCheckpointEnabled: boolean;
  hotCheckpointFailureCount: number;
  hotCheckpointFailureReported: boolean;
  runtimeUsageCheckpointWriter: typeof saveRuntimeUsageCheckpoint;
  runtimeUsageCheckpointLocation: { checkpointPath: string; keyPath: string };
  mutate: NonNullable<MonitorContext["mutate"]>;
  activeAfterCommit: (<TResult>(
    effect: () => TResult | Promise<TResult>,
    descriptor?: { key: string; kind: string; payload: UnknownRecord },
    complete?: (result: TResult, state: VigilState, usage: UsageState) => void | Promise<void>,
    fail?: (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
  ) => void) | null;
  activePersistenceRequest: (() => void) | null;
  durableEffectProblems: Map<string, { component: string; error: string; pending: boolean }>;
  coordinatorManagedEffects: Set<string>;
  browserActivitySubscribe: NonNullable<MonitorContext["browserActivitySubscribe"]>;
  browserActivityHealthy: NonNullable<MonitorContext["browserActivityHealthy"]>;
  browserActivityBurstDependencies: Partial<BrowserActivityBurstSchedulerDependencies>;
  browserActivityUnsubscribe: (() => void) | null;
  browserActivityBurst: BrowserActivityBurstScheduler | null;
  browserActivityMutationAdmissionOpen: boolean;
  browserActivityContinuityGeneration: number;
  committedRevision: (() => number) | null;
  browserActivityNow: () => number;
  browserActivityPolicyGeneration: number;
  browserActivityPolicyFingerprint: string;
  browserActivityObservedCommitRevision: number;
  browserActivityNextPolicyRefreshAt: number;
  lastBrowserActivityEvaluatedTarget: string;
  lastBrowserActivityEvaluatedGeneration: number;
  lastBrowserActivityEvaluatedPolicyGeneration: number;
  browserActivityQueuedTargets: Set<string>;
  // This replay queue intentionally survives MonitorTransactionSnapshot
  // rollback: its purpose is to recover the mutation that just rolled back.
  pendingBrowserActivityMutations: Map<string, PendingBrowserActivityMutation>;
  browserRedirect: NonNullable<MonitorContext["browserRedirect"]>;
  externalEffectsEnabled: boolean;

  constructor({
    state,
    usage,
    externalEffectsEnabled,
    mutate,
    runtimeInstanceId,
    committedRevision,
    browserActivityNow,
    browserActivitySubscribe,
    browserActivityHealthy,
    browserActivityBurstDependencies,
    browserRedirect,
    runtimeUsageCheckpointEnabled,
    runtimeUsageCheckpointWriter,
    runtimeUsageCheckpointLocation,
    startupSnapshotPersisted
  }: MonitorContext) {
    this.state = state;
    this.usage = usage;
    // The mutation coordinator replaces the contents of these original objects
    // after commit. Keep stable references so the latency-critical browser path
    // never reads a draft while a longer monitor transaction is awaiting I/O.
    this.committedState = state;
    this.committedUsage = usage;
    this.externalEffectsEnabled = externalEffectsEnabled !== false;
    this.lastPollAt = Date.now();
    this.lastMonotonicAt = performance.now();
    this.lastSample = null;
    this.previousSample = null;
    this.timer = null;
    this.lastScheduledTickMonotonicAt = performance.now();
    this.policyBoundaryTimer = null;
    this.status = {
      ok: true,
      lastError: "",
      componentErrors: {},
      componentHealth: {},
      runtimeInstanceId: runtimeInstanceId || new Date().toISOString(),
      runtimeStartedAt: runtimeInstanceId || new Date().toISOString(),
      lastSuccessfulTickAt: null,
      lastSample: null,
      lastEnforcement: null,
      stateSeal: null,
      clockTamper: null,
      hardeningDrift: null,
      appleContentFilterLockdown: null,
      networkBlock: null,
      lastProcessSweep: null,
      lastImmediateEnforcement: null,
      lastSystemSleepLock: null,
      lastFocusShortcut: null,
      lastGrayscale: null,
      lastIdleAccounting: null,
      accessibilityLikelyMissing: false,
      browserActivityAccelerationHealthy: false,
      effectivePollIntervalMs: MONITOR_RECOVERY_POLL_INTERVAL_MS
    };
    this.recentBlocks = new Map();
    this.appBlockHistory = new Map();
    this.immediateEnforcement = null;
    this.pendingImmediateEnforcementReasons = new Set();
    this.tickInFlight = null;
    this.operationCommitTail = Promise.resolve();
    this.operationTail = Promise.resolve();
    this.pendingMutationEffectAttempts = new Set();
    this.stopping = false;
    this.nextEnvironmentRefreshAt = 0;
    this.nextIntegrityRefreshAt = 0;
    this.nextAppleContentFilterRefreshAt = 0;
    this.nextHardeningDriftRefreshAt = 0;
    this.hardeningDriftMeasurement = null;
    this.nextNetworkBlockRefreshAt = 0;
    this.nextProcessSweepAt = 0;
    this.nextSystemSleepLockAt = 0;
    this.nextGrayscaleRefreshAt = 0;
    const checkpointCadenceNow = performance.now();
    this.nextFullCheckpointAt = startupSnapshotPersisted
      ? checkpointCadenceNow + MONITOR_FULL_CHECKPOINT_INTERVAL_MS
      : 0;
    this.nextHotCheckpointAt = checkpointCadenceNow + MONITOR_HOT_CHECKPOINT_INTERVAL_MS;
    this.lastHotCheckpointFingerprint = hotUsageCheckpointFingerprint(this.state, this.usage);
    this.runtimeUsageCheckpointEnabled = runtimeUsageCheckpointEnabled !== false;
    this.hotCheckpointFailureCount = 0;
    this.hotCheckpointFailureReported = false;
    this.runtimeUsageCheckpointWriter = runtimeUsageCheckpointWriter || saveRuntimeUsageCheckpoint;
    this.runtimeUsageCheckpointLocation = runtimeUsageCheckpointLocation || {
      checkpointPath: runtimeUsageCheckpointPath(DATA_DIR),
      keyPath: STATE_SEAL_KEY_PATH
    };
    this.mutate = mutate || (async (operation, options) => {
      const attempts: Promise<void>[] = [];
      const result = await operation(
        this.state,
        this.usage,
        (effect, _descriptor, complete, fail) => {
          attempts.push((async () => {
            try {
              const effectResult = await effect();
              await complete?.(effectResult, this.state, this.usage);
            } catch (error) {
              await fail?.(error instanceof Error ? error : new Error(String(error)), this.state, this.usage);
            }
          })());
        },
        () => {}
      );
      const barrier = Promise.all(attempts).then(() => {});
      options?.captureEffectAttemptBarrier?.(barrier);
      if (options?.deferEffectAttempts) {
        void barrier.catch((error) => {
          console.error("Vigil deferred monitor effect failed unexpectedly:", error);
        });
      } else {
        await barrier;
      }
      return result;
    });
    this.activeAfterCommit = null;
    this.activePersistenceRequest = null;
    this.durableEffectProblems = new Map();
    this.coordinatorManagedEffects = new Set();
    const usingDefaultBrowserActivitySource = !browserActivitySubscribe;
    this.browserActivitySubscribe = browserActivitySubscribe || subscribeBrowserActivity;
    this.browserActivityHealthy = browserActivityHealthy
      || (usingDefaultBrowserActivitySource
        ? browserActivityWatchHealthy
        : () => this.browserActivityUnsubscribe !== null);
    this.browserActivityBurstDependencies = browserActivityBurstDependencies || {};
    this.browserActivityUnsubscribe = null;
    this.browserActivityBurst = null;
    this.browserActivityMutationAdmissionOpen = true;
    this.browserActivityContinuityGeneration = 0;
    this.committedRevision = committedRevision || null;
    this.browserActivityNow = browserActivityNow || Date.now;
    this.browserActivityPolicyGeneration = 0;
    this.browserActivityObservedCommitRevision = this.committedRevision?.() || 0;
    const browserPolicyNow = this.browserActivityNow();
    this.browserActivityPolicyFingerprint = browserActivityPolicyFingerprint(
      this.committedState,
      this.committedUsage,
      new Date(browserPolicyNow),
      this.status.networkBlock
    );
    this.browserActivityNextPolicyRefreshAt = nextBrowserActivityPolicyBoundary(this.committedState, browserPolicyNow);
    this.lastBrowserActivityEvaluatedTarget = "";
    this.lastBrowserActivityEvaluatedGeneration = 0;
    this.lastBrowserActivityEvaluatedPolicyGeneration = -1;
    this.browserActivityQueuedTargets = new Set();
    this.pendingBrowserActivityMutations = new Map();
    this.browserRedirect = browserRedirect || redirectActiveBrowserTab;
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.browserActivityMutationAdmissionOpen = true;
    this.startBrowserActivityAcceleration();
    this.lastScheduledTickMonotonicAt = performance.now();
    this.refreshEffectivePollInterval();
    void this.runScheduledTick();
    const recoveryCheckIntervalMs = monitorPollIntervalMs(this.state.settings.pollIntervalMs, false);
    this.timer = setInterval(() => {
      const now = performance.now();
      const intervalMs = this.refreshEffectivePollInterval();
      if (now - this.lastScheduledTickMonotonicAt < intervalMs) return;
      this.lastScheduledTickMonotonicAt = now;
      void this.runScheduledTick();
    }, recoveryCheckIntervalMs);
    this.armPolicyBoundaryTimer();
  }

  refreshEffectivePollInterval(): number {
    const healthy = this.browserActivityUnsubscribe !== null && this.browserActivityHealthy();
    const intervalMs = monitorPollIntervalMs(this.state.settings.pollIntervalMs, healthy);
    this.status.browserActivityAccelerationHealthy = healthy;
    this.status.effectivePollIntervalMs = intervalMs;
    return intervalMs;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.policyBoundaryTimer) clearTimeout(this.policyBoundaryTimer);
    this.policyBoundaryTimer = null;
    this.stopping = true;
    this.pendingImmediateEnforcementReasons.clear();
    // Detach the signal source first, but leave mutation admission available
    // while an exact-tab decision already in flight finishes its bookkeeping.
    this.browserActivityUnsubscribe?.();
    this.browserActivityUnsubscribe = null;
    const browserActivityBurst = this.browserActivityBurst;
    this.browserActivityBurst = null;
    let stopError: unknown = null;
    try {
      await browserActivityBurst?.stop();
      // A confirmed exact-tab redirect can have failed only its durable state
      // commit and be sleeping in the normal retry backoff. Shutdown must force
      // that bookkeeping through before the server freezes mutation admission;
      // otherwise the event, limit block, and rolling-cycle anchor disappear.
      await this.drainPendingBrowserActivityMutationsForStop();
    } catch (error) {
      stopError = error;
    }
    // A scheduled tick can release the monitor tail while its durable OS
    // attempts drain. Keep shutdown admission open until both phases finish,
    // even when stopping the optional activity accelerator reported an error.
    try {
      await this.tickInFlight;
      await this.hardeningDriftMeasurement;
    } catch (error) {
      stopError ||= error;
    }
    this.browserActivityMutationAdmissionOpen = false;
    await this.operationTail;
    await this.drainMutationEffectAttempts();
    await this.operationTail;
    if (stopError) throw stopError;
  }

  startBrowserActivityAcceleration(): void {
    const defaultSourceDisabled = process.env.VIGIL_BROWSER_ACTIVITY_WATCH === "0"
      && this.browserActivitySubscribe === subscribeBrowserActivity;
    if (defaultSourceDisabled || this.browserActivityBurst) return;
    const burst = new BrowserActivityBurstScheduler(
      () => this.probeBrowserActivity(),
      this.browserActivityBurstDependencies
    );
    this.browserActivityBurst = burst;
    try {
      this.browserActivityUnsubscribe = this.browserActivitySubscribe((signal) => {
        if (this.stopping || this.browserActivityBurst !== burst) return;
        if (signal.kind === "activate" || signal.kind === "launch") {
          this.handleApplicationActivity(signal.kind, burst);
          return;
        }
        burst.wake();
      });
    } catch {
      this.browserActivityBurst = null;
      void burst.stop();
    }
  }

  handleApplicationActivity(kind: "activate" | "launch", burst: BrowserActivityBurstScheduler): void {
    const operation = kind === "activate"
      ? this.enforceActivatedApplication(burst)
      : this.enforceLaunchedApplications();
    this.trackOperationCompletion(operation);
    void operation.catch((error) => {
      this.setComponentHealth(
        kind === "activate" ? "frontmost" : "process-sweep",
        `Application ${kind} enforcement failed: ${errorMessage(error)}`
      );
    });
  }

  async enforceActivatedApplication(burst: BrowserActivityBurstScheduler): Promise<void> {
    const front = await this.readFrontmost({ fresh: true });
    if (this.stopping || !front.ok) return;
    if (appCanReportUrls(front.app)) burst.wake();
    await this.enqueueMutationOperation(async () => {
      this.applyFrontmostSample(front);
      await this.enforceFrontmost(front);
    }, { persist: false });
  }

  async enforceLaunchedApplications(): Promise<void> {
    if (this.stopping) return;
    await this.enqueueMutationOperation(
      () => this.sweepBlockedProcesses(Date.now(), { force: true }),
      { persist: false }
    );
  }

  armPolicyBoundaryTimer(): void {
    if (this.policyBoundaryTimer) clearTimeout(this.policyBoundaryTimer);
    this.policyBoundaryTimer = null;
    if (this.stopping || !this.timer) return;
    const now = Date.now();
    const boundary = nextBrowserActivityPolicyBoundary(this.committedState, now);
    const delayMs = Math.max(25, boundary - now + 25);
    this.policyBoundaryTimer = setTimeout(() => {
      this.policyBoundaryTimer = null;
      if (!policyBoundaryRequiresImmediateEnforcement(this.committedState, boundary, Date.now())) {
        this.armPolicyBoundaryTimer();
        return;
      }
      void this.enforceImmediately("policy-boundary")
        .catch((error) => {
          this.setComponentHealth("tick", `Policy-boundary enforcement failed: ${errorMessage(error)}`);
        })
        .finally(() => { this.armPolicyBoundaryTimer(); });
    }, delayMs);
    this.policyBoundaryTimer.unref?.();
  }

  async probeBrowserActivity(): Promise<boolean> {
    if (this.stopping) return false;
    this.retryPendingBrowserActivityMutations();
    const candidate = await this.readFrontmost({ fresh: true, updateHealth: false });
    if (!candidate.ok || !appCanReportUrls(candidate.app)) {
      this.breakBrowserActivityContinuity();
      return true;
    }
    const candidateTarget = `${candidate.app}\n${candidate.url}`;
    if (!candidate.url) {
      this.breakBrowserActivityContinuity();
      return true;
    }
    const continuityGeneration = this.browserActivityContinuityGeneration;
    const policyGeneration = this.currentBrowserActivityPolicyGeneration();
    const blockMutationKey = `block:${candidateTarget}`;
    const bookkeepingPending = this.pendingBrowserActivityMutations.has(blockMutationKey);

    // A browser block must not wait behind integrity inventory, device sync, or
    // any other routine monitor work. Decide from committed state, redirect the
    // exact observed tab immediately, then serialize only the bookkeeping. The
    // ordinary tick and durable path remain fail-closed retry backstops.
    const immediateBlock = this.browserBlockDecision(candidate);
    if (immediateBlock) {
      const redirectUrl = this.blockedPageTarget(
        immediateBlock.front,
        immediateBlock.policy,
        immediateBlock.options,
        { state: this.committedState, usage: this.committedUsage }
      );
      const result = this.externalEffectsEnabled
        ? await this.browserRedirect(candidate.app, redirectUrl, { currentUrl: candidate.url })
        : { ok: true, matched: false, redirectedTabCount: 0, method: "external-effects-isolated" };
      // Only the target-atomic redirect implementations can positively confirm
      // that the offending tab was replaced. A legacy/ambiguous `{ ok: true }`
      // result must retain the recovery tail instead of being treated as proof.
      const matched = result.ok && result.matched === true;
      if (!bookkeepingPending) {
        this.queueBrowserActivityMutation(blockMutationKey, async () => {
          if (matched) {
            this.commitImmediateBrowserDecision(immediateBlock);
            this.recordImmediateBrowserBlock(immediateBlock, result);
            return;
          }
          // The redirect operation is target-atomic, so retrying the observed URL
          // cannot rewrite an unrelated tab even if the user switched meanwhile.
          await this.enforce(immediateBlock.front);
        }, { persist: matched, retryOnFailure: matched });
      }
      // Keep the sparse tail alive while confirmed redirect bookkeeping is
      // still awaiting a durable commit. Retry due-times bound persistence work;
      // the regular monitor tick remains the recovery backstop.
      return true;
    }

    if (this.browserActivityTargetAlreadyEvaluated(candidateTarget, continuityGeneration, policyGeneration)) return true;
    this.queueBrowserActivityMutation(`check:${continuityGeneration}:${policyGeneration}:${candidateTarget}`, async () => {
      // A later probe may have observed a non-browser app or an empty URL while
      // this check waited behind serialized monitor work. Such a check belongs
      // to the old browsing continuity and must neither enforce stale policy nor
      // repopulate the de-duplication marker after the user returns.
      if (continuityGeneration !== this.browserActivityContinuityGeneration) return;
      // Re-read inside the serialized mutation for non-blocking/intentional-use
      // decisions. Immediate blocker redirects above already use an atomic URL
      // precondition and therefore do not inherit this queue's latency.
      const front = await this.readFrontmost({ fresh: true });
      if (!front.ok || !appCanReportUrls(front.app) || !front.url) {
        if (continuityGeneration === this.browserActivityContinuityGeneration) {
          this.breakBrowserActivityContinuity();
        }
        return;
      }
      if (continuityGeneration !== this.browserActivityContinuityGeneration) return;
      const target = `${front.app}\n${front.url}`;
      const evaluationPolicyGeneration = this.currentBrowserActivityPolicyGeneration();
      if (this.browserActivityTargetAlreadyEvaluated(target, continuityGeneration, evaluationPolicyGeneration)) return;
      const previousEnforcement = this.status.lastEnforcement;
      await this.enforce(front);
      const completedPolicyGeneration = this.currentBrowserActivityPolicyGeneration();
      if (
        continuityGeneration === this.browserActivityContinuityGeneration
        && evaluationPolicyGeneration === completedPolicyGeneration
        && this.status.lastEnforcement === previousEnforcement
      ) {
        this.lastBrowserActivityEvaluatedTarget = target;
        this.lastBrowserActivityEvaluatedGeneration = continuityGeneration;
        this.lastBrowserActivityEvaluatedPolicyGeneration = completedPolicyGeneration;
      }
    });
    return true;
  }

  breakBrowserActivityContinuity(): void {
    this.browserActivityContinuityGeneration += 1;
    this.lastBrowserActivityEvaluatedTarget = "";
    this.lastBrowserActivityEvaluatedGeneration = -1;
    this.lastBrowserActivityEvaluatedPolicyGeneration = -1;
  }

  currentBrowserActivityPolicyGeneration(now = this.browserActivityNow()): number {
    const committedRevision = this.committedRevision?.() ?? this.browserActivityObservedCommitRevision;
    const revisionChanged = this.committedRevision
      ? committedRevision !== this.browserActivityObservedCommitRevision
      : true;
    if (revisionChanged || now >= this.browserActivityNextPolicyRefreshAt) {
      const fingerprint = browserActivityPolicyFingerprint(
        this.committedState,
        this.committedUsage,
        new Date(now),
        this.status.networkBlock
      );
      if (fingerprint !== this.browserActivityPolicyFingerprint) {
        this.browserActivityPolicyFingerprint = fingerprint;
        this.browserActivityPolicyGeneration += 1;
      }
      this.browserActivityObservedCommitRevision = committedRevision;
      this.browserActivityNextPolicyRefreshAt = nextBrowserActivityPolicyBoundary(this.committedState, now);
    }
    return this.browserActivityPolicyGeneration;
  }

  browserActivityTargetAlreadyEvaluated(
    target: string,
    generation = this.browserActivityContinuityGeneration,
    policyGeneration = this.currentBrowserActivityPolicyGeneration()
  ): boolean {
    return generation === this.browserActivityContinuityGeneration
      && this.lastBrowserActivityEvaluatedGeneration === generation
      && this.lastBrowserActivityEvaluatedPolicyGeneration === policyGeneration
      && target === this.lastBrowserActivityEvaluatedTarget;
  }

  browserBlockDecision(front: FrontSample): BrowserBlockDecision | null {
    if (isVigilBlockedPageUrl(front.url)) return null;

    // activePolicy performs expiry cleanup as part of evaluation. Use a private
    // snapshot so the out-of-band latency path remains read-only with respect
    // to the coordinator's committed objects.
    const state = structuredClone(this.committedState);
    const evaluatedAt = new Date(this.browserActivityNow());
    const policy = policyForSample(state, this.committedUsage, front, evaluatedAt);
    if (!policy) return null;
    const lockdown = policy.kind === "integrity" || isFullLockoutPolicy(policy);
    const decisionContext = { sample: front, evaluatedAt: evaluatedAt.toISOString() };

    if (front.url && policy.browserControl) {
      return {
        ...decisionContext,
        front: { ...front, hostname: policy.browserControl.label },
        policy,
        options: { browserControl: policy.browserControl, originalHostname: front.url }
      };
    }
    if (front.url && policy.contentFilter && (lockdown || contentFilterEnabled(state))) {
      return {
        ...decisionContext,
        front: { ...front, hostname: policy.contentFilter.label },
        policy,
        options: { contentFilter: policy.contentFilter, originalHostname: front.hostname }
      };
    }

    // Network-only blocking still goes through the ordinary path because it
    // must first confirm that the system network layer is current. Redirects
    // enabled in policy can safely take the immediate, exact-tab path.
    const redirectEnabled = lockdown || state.settings.siteRedirectEnabled;
    if (!redirectEnabled) return null;
    if (front.hostname && shouldBlockSite(policy.profile, front.hostname)) {
      return { ...decisionContext, front, policy, options: {} };
    }
    const urlPattern = front.url ? matchBlockedUrlPattern(policy.profile, front.url) : null;
    if (!urlPattern) return null;
    return {
      ...decisionContext,
      front: { ...front, hostname: urlPattern.pattern },
      policy,
      options: { urlPattern, originalHostname: front.hostname }
    };
  }

  commitImmediateBrowserDecision(decision: BrowserBlockDecision): void {
    // The latency path evaluates against a disposable snapshot so it can
    // redirect without waiting for the mutation queue. Re-evaluate the exact
    // observed sample against current transactional state, usage, and policy
    // time whenever serialization resumes. The same closure can survive a
    // persistence rollback and run much later, so replaying evaluatedAt could
    // create an already-expired limit block while anchoring all usage accrued
    // since the redirect. A fresh evaluation either commits a currently active
    // block with a matching current anchor or observes that the policy no
    // longer applies. The original decision remains the receipt for the
    // already-confirmed redirect event.
    policyForSample(
      this.state,
      this.usage,
      decision.sample,
      new Date(this.browserActivityNow())
    );
  }

  blockedPageTarget(
    front: FrontSample,
    policy: EnforcedPolicy,
    options: BlockSiteOptions = {},
    validation: BlockedPageValidationSnapshot = { state: this.state, usage: this.usage }
  ): string {
    const backUrl = this.safeBlockedPageBackUrl(front, options, validation);
    return buildBlockedPageUrl({
      site: front.hostname,
      until: policy.endsAt,
      mode: policy.session.mode || "focus",
      policyId: policy.session.id || "",
      backUrl,
      port: PORT
    });
  }

  safeBlockedPageBackUrl(
    front: FrontSample,
    options: BlockSiteOptions = {},
    validation: BlockedPageValidationSnapshot = { state: this.state, usage: this.usage }
  ): string {
    const recentSampleCandidates = [this.lastSample, this.previousSample]
      .flatMap((sample) => (
        sample?.app === front.app
        && Boolean(sample.url)
        && !sameBrowserUrl(sample.url, front.url)
          ? [sample.url]
          : []
      ));
    const candidates = [
      ...recentSampleCandidates,
      options.contentFilter?.fallbackUrl || "",
      browserOriginUrl(front.url)
    ];
    for (const value of candidates) {
      const candidate = safeExternalPageUrl(value);
      if (!candidate || sameBrowserUrl(candidate, front.url)) continue;
      const parsed = new URL(candidate);
      const sample = {
        app: front.app,
        hostname: urlHostname(candidate),
        url: candidate
      };
      const state = structuredClone(validation.state);
      const usage = structuredClone(validation.usage);
      const evaluatedAt = new Date(this.browserActivityNow());
      if (!policyForSample(state, usage, sample, evaluatedAt)) {
        if (safariFilterDenyMatch(state, candidate, evaluatedAt)) continue;
        return parsed.toString();
      }
    }
    return "";
  }

  browserBlockKey(front: FrontSample, options: BlockSiteOptions = {}): string {
    return options.browserControl
      ? `browser-control:${options.browserControl.area}:${front.url || front.hostname}`
      : options.contentFilter
        ? `content:${options.contentFilter.id}:${front.url || front.hostname}`
        : options.urlPattern
          ? `url:${options.urlPattern.pattern}:${front.url || front.hostname}`
          : `site:${front.hostname}`;
  }

  recordImmediateBrowserBlock(
    decision: BrowserBlockDecision,
    result: UnknownRecord & { ok?: boolean }
  ): void {
    const key = this.browserBlockKey(decision.front, decision.options);
    const coolingDown = this.isCoolingDown(key);
    if (!coolingDown) this.markCoolingDown(key);
    this.recordBrowserBlock(decision, result, coolingDown);
  }

  recordBrowserBlock(
    { front, policy, options }: BrowserBlockRecord,
    result: UnknownRecord & { ok?: boolean },
    coolingDown: boolean
  ): void {
    const detail = {
      site: front.hostname,
      app: front.app,
      originalSite: options.originalHostname || front.hostname,
      browserControl: options.browserControl || null,
      contentFilter: options.contentFilter || null,
      urlPattern: options.urlPattern || null,
      policy: policy.session.title || policy.session.mode,
      result,
      coolingDownRetry: coolingDown
    };
    if (!coolingDown || !result.ok) {
      addEvent(
        this.state,
        options.browserControl ? "blocked_browser_control" : options.contentFilter ? "blocked_content" : options.urlPattern ? "blocked_url" : "blocked_site",
        detail
      );
    }
    this.status.lastEnforcement = {
      type: options.browserControl ? "browser-control" : options.contentFilter ? "content" : options.urlPattern ? "url" : "site",
      target: front.hostname,
      result,
      coolingDownRetry: coolingDown,
      at: new Date().toISOString()
    };
  }

  queueBrowserActivityMutation(
    key: string,
    operation: () => Promise<void>,
    options: { persist?: boolean; retryOnFailure?: boolean } = {}
  ): void {
    if (!this.browserActivityMutationAdmissionOpen) return;
    if (options.retryOnFailure && !this.pendingBrowserActivityMutations.has(key)) {
      this.pendingBrowserActivityMutations.set(key, {
        operation,
        persist: options.persist === true,
        attempts: 0,
        nextRetryAt: 0
      });
    }
    if (this.browserActivityQueuedTargets.has(key)) return;
    this.browserActivityQueuedTargets.add(key);
    const queued = this.enqueueMutationOperation(operation, { persist: options.persist === true });
    void queued.then(
      () => {
        this.browserActivityQueuedTargets.delete(key);
        if (!options.retryOnFailure) return;
        const pending = this.pendingBrowserActivityMutations.get(key);
        if (pending?.operation === operation) this.pendingBrowserActivityMutations.delete(key);
        if (!this.pendingBrowserActivityMutations.size) {
          this.setComponentHealth("browser-activity-persistence", "");
        }
      },
      (error) => {
        this.browserActivityQueuedTargets.delete(key);
        if (!options.retryOnFailure) return;
        const message = errorMessage(error);
        this.setComponentHealth(
          "browser-activity-persistence",
          `Browser block bookkeeping persistence failed and will be retried: ${message}`
        );
        console.error("Vigil could not persist browser-activity block bookkeeping; retrying:", error);
        const pending = this.pendingBrowserActivityMutations.get(key);
        if (pending?.operation === operation) {
          pending.attempts += 1;
          pending.nextRetryAt = Date.now() + browserActivityPersistenceRetryDelayMs(pending.attempts);
        }
      }
    );
  }

  retryPendingBrowserActivityMutations(options: { force?: boolean } = {}): void {
    const now = Date.now();
    for (const [key, pending] of this.pendingBrowserActivityMutations) {
      if (!options.force && pending.nextRetryAt > now) continue;
      this.queueBrowserActivityMutation(key, pending.operation, {
        persist: pending.persist,
        retryOnFailure: true
      });
    }
  }

  async drainPendingBrowserActivityMutationsForStop(): Promise<void> {
    // First let any mutation queued by the final burst probe settle and publish
    // its retry record. Promise callbacks that maintain the replay map run in a
    // neighboring microtask, hence the explicit yield after each tail drain.
    await this.operationTail;
    await Promise.resolve();
    for (
      let attempt = 0;
      this.pendingBrowserActivityMutations.size > 0
        && attempt < BROWSER_ACTIVITY_PERSISTENCE_SHUTDOWN_MAX_ATTEMPTS;
      attempt += 1
    ) {
      this.retryPendingBrowserActivityMutations({ force: true });
      await this.operationTail;
      await Promise.resolve();
    }
    if (!this.pendingBrowserActivityMutations.size) return;
    throw new Error(
      `Vigil could not persist ${this.pendingBrowserActivityMutations.size} browser block bookkeeping mutation(s) during shutdown.`
    );
  }

  runScheduledTick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    // The ordinary monitor cadence is a recovery backstop when the native
    // activity source is disabled or unavailable.
    this.retryPendingBrowserActivityMutations();
    if (this.tickInFlight) return this.tickInFlight;
    const fullCheckpoint = performance.now() >= this.nextFullCheckpointAt;
    let persistedHotFingerprint: string | null = null;
    const scheduled = (async () => {
      await this.enqueueMutationOperation(
        async () => {
          await this.tick(fullCheckpoint);
          if (fullCheckpoint) {
            // Capture the hot-data fingerprint from the exact draft that the
            // coordinator is about to commit. Other request mutations may run
            // while slow hardening evidence is collected below.
            persistedHotFingerprint = hotUsageCheckpointFingerprint(
              this.state,
              this.usage,
              new Date(this.lastPollAt)
            );
          }
        },
        { persist: fullCheckpoint }
      );
      // The full generation is already durable here. Advance its monotonic
      // deadline before slower hardening and compact-checkpoint work so a
      // failure in either phase cannot turn every recovery poll into another
      // full disk fold.
      if (fullCheckpoint) {
        this.nextFullCheckpointAt = performance.now() + MONITOR_FULL_CHECKPOINT_INTERVAL_MS;
      }

      const hardeningCheckedAt = this.lastPollAt;
      const hardeningDue = this.hardeningDriftAttestationDue(hardeningCheckedAt);
      if (hardeningDue) await this.runHardeningDriftPhase(hardeningCheckedAt);
      if (fullCheckpoint) {
        this.lastHotCheckpointFingerprint = persistedHotFingerprint!;
        // An extension heartbeat or another sparse request can advance hot
        // counters while hardening I/O is in flight. Compare immediately with
        // the committed baseline so those counters are never mistaken for data
        // already present in the full snapshot.
        await this.persistHotUsageCheckpoint(Date.now(), { force: true });
      } else {
        await this.persistHotUsageCheckpoint(hardeningCheckedAt);
      }
      await this.enqueueOperation(async () => {
        this.setComponentHealth("tick", "");
        this.status.lastSuccessfulTickAt = new Date(hardeningCheckedAt).toISOString();
      });
    })();
    const operation = scheduled
      .catch(async (error) => {
        try {
          await this.enqueueMutationOperation(async () => {
            this.reportTickFailure(error);
            await saveState(this.state);
          });
        } catch {
          const message = error instanceof Error ? error.message : String(error);
          this.setComponentHealth("tick", `Monitor tick failed: ${message || "Unknown monitor tick failure"}`);
        }
      });
    const tracked = operation.finally(() => {
      if (this.tickInFlight === tracked) this.tickInFlight = null;
    });
    this.tickInFlight = tracked;
    return tracked;
  }

  reportTickFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const detail = {
      error: message || "Unknown monitor tick failure",
      at: new Date().toISOString()
    };
    this.setComponentHealth("tick", `Monitor tick failed: ${detail.error}`);
    addEvent(this.state, "monitor_tick_failed", detail);
  }

  async tick(forceCheckpoint = false): Promise<void> {
    const frame = this.beginPollFrame();
    await this.recordElapsedUsage(frame);
    await this.refreshSafetyRails(frame);
    const front = await this.updateFrontmostSample();
    await this.enforceFrontmost(front);
    // Only prepare the hardening decision here. Fresh Chrome/profile evidence
    // is collected outside all serialization after this transaction commits
    // and its foreground, sleep-lock, and process-sweep effects are dispatched.
    this.prepareHardeningDrift(frame.now);
    await this.runBackgroundEnforcement(frame.now);
    if (forceCheckpoint) this.activePersistenceRequest?.();
  }

  async persistHotUsageCheckpoint(now: number, options: { force?: boolean } = {}): Promise<void> {
    if (!this.runtimeUsageCheckpointEnabled) return;
    const cadenceNow = performance.now();
    if (!options.force && cadenceNow < this.nextHotCheckpointAt) return;
    const checkedAt = new Date(now);
    const fingerprint = hotUsageCheckpointFingerprint(this.state, this.usage, checkedAt);
    const countersChanged = fingerprint !== this.lastHotCheckpointFingerprint;
    this.nextHotCheckpointAt = cadenceNow + MONITOR_HOT_CHECKPOINT_INTERVAL_MS;
    // After a failed write, retry the same fingerprint once backoff expires so
    // an idle runtime can verify recovery and clear degraded health. With no
    // active failure, an unchanged fingerprint remains completely write-free.
    if (!countersChanged && this.hotCheckpointFailureCount === 0) return;
    try {
      await this.runtimeUsageCheckpointWriter(this.state, this.usage, {
        ...this.runtimeUsageCheckpointLocation,
        now: checkedAt
      });
      this.lastHotCheckpointFingerprint = fingerprint;
      if (this.hotCheckpointFailureCount > 0) {
        this.hotCheckpointFailureCount = 0;
        this.hotCheckpointFailureReported = false;
        this.setComponentHealth("runtime-usage-checkpoint", "");
      }
    } catch (error) {
      const disabledForRuntime = isNonRetryableRuntimeUsageCheckpointError(error);
      this.hotCheckpointFailureCount += 1;
      const retryDelayMs = disabledForRuntime
        ? null
        : hotUsageCheckpointRetryDelayMs(this.hotCheckpointFailureCount);
      if (disabledForRuntime) this.runtimeUsageCheckpointEnabled = false;
      else this.nextHotCheckpointAt = performance.now() + retryDelayMs!;
      const reportFailure = !this.hotCheckpointFailureReported || disabledForRuntime;
      if (countersChanged || reportFailure) {
        await this.enqueueMutationOperation(async () => {
          if (reportFailure) {
            addEvent(this.state, "runtime_usage_checkpoint_failed", {
              error: errorMessage(error),
              disabledForRuntime,
              retryDelayMs,
              at: checkedAt.toISOString()
            });
          }
          // A same-fingerprint health probe is already covered by the prior
          // full fallback and must not create another full snapshot.
          if (countersChanged || reportFailure) this.activePersistenceRequest?.();
        }, { persist: true });
      }
      this.hotCheckpointFailureReported = true;
      if (disabledForRuntime) {
        this.setComponentHealth(
          "runtime-usage-checkpoint",
          "Compact usage checkpoints are disabled for this runtime; sealed full snapshots remain active."
        );
      } else {
        this.setComponentHealth(
          "runtime-usage-checkpoint",
          `Compact usage checkpoint failed; retrying in ${Math.round(retryDelayMs! / 1000)}s while sealed full snapshots remain active.`
        );
      }
      if (countersChanged) this.lastHotCheckpointFingerprint = fingerprint;
    }
  }

  async runHardeningDriftPhase(now: number): Promise<void> {
    const hardeningDriftStarted = await this.refreshHardeningDrift(now);
    if (!hardeningDriftStarted) return;
    // Foreground, grayscale, and process discovery are external measurements.
    // Keep all of them outside the monitor/coordinator commit tails, then
    // publish the complete fail-closed side-effect set in one short mutation.
    // Browser redirects still carry their URL precondition, so a tab switch
    // cannot rewrite an unrelated target while the intent is dispatched.
    const [hardenedFront, sideEffectObservations] = await Promise.all([
      this.readFrontmost({ fresh: true, updateHealth: false }),
      this.collectImmediateSideEffectObservations()
    ]);
    await this.enqueueMutationOperation(async () => {
      if (!integrityLockdownActive(this.state)) return;
      const enforcedAt = Date.now();
      await this.enforceFrontmost(hardenedFront);
      await this.runImmediateSideEffects(enforcedAt, sideEffectObservations, { continueOnError: true });
    }, { persist: false });
  }

  enforceImmediately(reason = "manual"): Promise<UnknownRecord> {
    if (this.stopping) return Promise.reject(new Error("Vigil monitor is stopping."));
    this.pendingImmediateEnforcementReasons.add(reason);
    if (this.immediateEnforcement) return this.immediateEnforcement;
    const operation = (async () => {
      let result: UnknownRecord = {};
      let firstError: unknown = null;
      while (!this.stopping && this.pendingImmediateEnforcementReasons.size) {
        const reasons = [...this.pendingImmediateEnforcementReasons];
        this.pendingImmediateEnforcementReasons.clear();
        try {
          result = await this.enqueueMutationOperation(() => this.runImmediateEnforcement(reasons.join(",")));
        } catch (error) {
          firstError ||= error;
        }
      }
      if (firstError) throw firstError;
      return result;
    })();
    const tracked = operation.finally(() => {
      if (this.immediateEnforcement === tracked) this.immediateEnforcement = null;
      if (!this.stopping && this.pendingImmediateEnforcementReasons.size) {
        const pendingReason = this.pendingImmediateEnforcementReasons.values().next().value || "queued";
        void this.enforceImmediately(pendingReason).catch((error) => {
          this.setComponentHealth("tick", `Queued immediate enforcement failed: ${errorMessage(error)}`);
          this.armPolicyBoundaryTimer();
        });
      } else {
        this.armPolicyBoundaryTimer();
      }
    });
    this.immediateEnforcement = tracked;
    return tracked;
  }

  reconcileDurableEffect(action: string, payload: UnknownRecord): Promise<UnknownRecord> {
    const reconcile = async () => {
      const key = String(payload.intentKey || monitorEffectKey(action, payload));
      this.setDurableEffectHealth(key, action, "Recovered durable effect is pending.", true);
      try {
        let result: UnknownRecord;
        let effectState: VigilState | null = null;
        if (!this.durableEffectApplicable(action, payload)) result = obsoleteEffectResult(action);
        else if (!this.externalEffectsEnabled && action !== "session-enforcement" && action !== "policy-enforcement") {
          result = { ok: true, skipped: "external-effects-isolated" };
        }
        else if (action === "session-enforcement") result = await this.runImmediateEnforcement("session-start");
        else if (action === "policy-enforcement") result = await this.runImmediateEnforcement(String(payload.reason || "recovered-policy-enforcement"));
        else if (action === "lock-screen") result = await lockScreen();
        else if (action === "focus-shortcut") {
          const snapshot = structuredClone(this.state);
          effectState = snapshot;
          result = {
            ...await reconcileFocusShortcut(snapshot, activePolicy(snapshot, new Date()), new Date()) as UnknownRecord,
            effectState: snapshot
          };
        } else if (action === "grayscale") result = await setMacGrayscaleEnabled(Boolean(payload.desired));
        else if (action === "quit-app") result = await quitApp(String(payload.app || ""), { force: Boolean(payload.force) });
        else if (action === "redirect-browser") result = await this.browserRedirect(String(payload.app || ""), String(payload.url || ""), { currentUrl: String(payload.currentUrl || "") });
        else if (action === "open-url") result = await openUrl(String(payload.url || ""));
        else if (action === "mdm-push") {
          if (!this.state.deviceControls.ios.mdm.enabled) {
            result = { ok: true, pushed: 0, skipped: "disabled" };
          } else {
            effectState = structuredClone(this.state);
            result = await pushIosMdmQueuedCommands(effectState, String(payload.reason || "recovered-monitor-mdm-push"), new Date(), payload.options as UnknownRecord || {}) as UnknownRecord;
            result = { ...result, effectState };
          }
        }
        else throw new Error(`Unknown monitor OS effect: ${action}`);
        const failure = monitorEffectFailure(action, result);
        if (failure) {
          const error = new Error(failure) as Error & { effectState?: VigilState };
          if (effectState) error.effectState = effectState;
          throw error;
        }
        if (!this.coordinatorManagedEffects.has(key)) this.clearDurableEffectHealth(key, action);
        return result;
      } catch (error) {
        this.setDurableEffectHealth(key, action, errorMessage(error), false);
        throw error;
      }
    };
    // Session and policy control triggers mutate monitor state and can publish
    // descendant monitor-OS intents. Run their mutation through the normal
    // commit barrier so operationTail, shutdown, and the originating request
    // all observe those first attempts. The coordinator executes the parent on
    // a distinct control lane, so awaiting the captured immediate-lane barrier
    // outside operationCommitTail cannot cycle back onto the same worker.
    if (action === "session-enforcement" || action === "policy-enforcement") {
      return this.enqueueMutationOperation(reconcile);
    }
    return this.enqueueOperation(reconcile);
  }

  observeDurableEffect(
    entry: { key: string; kind: string; payload: UnknownRecord },
    transition: "pending" | "running" | "failed" | "completed",
    error: string
  ): void {
    const action = entry.kind === "monitor-os" ? String(entry.payload.action || "") : entry.kind;
    if (transition === "completed") {
      this.coordinatorManagedEffects.delete(entry.key);
      this.clearDurableEffectHealth(entry.key, action);
      return;
    }
    this.coordinatorManagedEffects.add(entry.key);
    this.setDurableEffectHealth(entry.key, action, error || "Durable effect is pending.", transition === "pending" || transition === "running");
  }

  enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.operationCommitTail.then(operation);
    this.operationCommitTail = queued.then(() => {}, () => {});
    this.trackOperationCompletion(queued);
    return queued;
  }

  trackOperationCompletion(operation: Promise<unknown>): void {
    this.operationTail = Promise.all([this.operationTail, operation]).then(() => {}, () => {});
  }

  enqueueMutationOperation<T>(
    operation: () => Promise<T>,
    options: { persist?: boolean } = {}
  ): Promise<T> {
    let effectAttemptBarrier = Promise.resolve();
    const committed = this.enqueueOperation(() => this.runMutation(operation, {
      ...options,
      deferEffectAttempts: true,
      captureEffectAttemptBarrier: (barrier) => {
        effectAttemptBarrier = barrier;
        this.trackMutationEffectAttempts(barrier);
      }
    }));
    const completed = committed.then(async (result) => {
      await effectAttemptBarrier;
      return result;
    });
    void committed.then(
      () => { this.armPolicyBoundaryTimer(); },
      () => {}
    );
    this.trackOperationCompletion(completed);
    return completed;
  }

  trackMutationEffectAttempts(barrier: Promise<void>): void {
    this.pendingMutationEffectAttempts.add(barrier);
    void barrier.then(
      () => { this.pendingMutationEffectAttempts.delete(barrier); },
      () => { this.pendingMutationEffectAttempts.delete(barrier); }
    );
  }

  async drainMutationEffectAttempts(): Promise<void> {
    while (this.pendingMutationEffectAttempts.size) {
      await Promise.allSettled([...this.pendingMutationEffectAttempts]);
    }
  }

  async runMutation<T>(operation: () => Promise<T>, options: MonitorMutationOptions = {}): Promise<T> {
    let monitorSnapshot: MonitorTransactionSnapshot | null = null;
    try {
      return await this.mutate(async (draftState, draftUsage, afterCommit, requestPersistence) => {
        monitorSnapshot = this.captureTransactionSnapshot();
        const previousState = this.state;
        const previousUsage = this.usage;
        const previousAfterCommit = this.activeAfterCommit;
        const previousPersistenceRequest = this.activePersistenceRequest;
        this.state = draftState;
        this.usage = draftUsage;
        this.activeAfterCommit = afterCommit;
        this.activePersistenceRequest = requestPersistence || null;
        try {
          return await operation();
        } finally {
          this.state = previousState;
          this.usage = previousUsage;
          this.activeAfterCommit = previousAfterCommit;
          this.activePersistenceRequest = previousPersistenceRequest;
        }
      }, options);
    } catch (error) {
      if (monitorSnapshot) this.restoreTransactionSnapshot(monitorSnapshot);
      throw error;
    }
  }

  async externalEffect<T extends UnknownRecord>(
    kind: string,
    payload: UnknownRecord,
    operation: (attempt: number) => Promise<T>,
    commitResult?: (result: T, state: VigilState) => void
  ): Promise<T> {
    if (!this.externalEffectsEnabled) {
      return { ok: true, skipped: "external-effects-isolated" } as unknown as T;
    }
    if (!this.activeAfterCommit) {
      const key = monitorEffectKey(kind, payload);
      try {
        const result = await operation(1);
        commitResult?.(result, this.state);
        const failure = monitorEffectFailure(kind, result);
        if (failure) throw new Error(failure);
        if (!this.coordinatorManagedEffects.has(key)) this.clearDurableEffectHealth(key, kind);
        return result;
      } catch (error) {
        this.setDurableEffectHealth(key, kind, errorMessage(error), false);
        addEvent(this.state, "monitor_os_effect_failed", { kind, key, payload, error: errorMessage(error) });
        throw error;
      }
    }
    const key = monitorEffectKey(kind, payload);
    // The coordinator already owns retries for a durable effect with this
    // exact intent key. Re-enqueuing it from every monitor poll would add a
    // pending and completion/failure snapshot without improving enforcement.
    if (this.coordinatorManagedEffects.has(key)) {
      return { ok: false, pending: true, intentKey: key, error: "Durable macOS effect is already pending." } as unknown as T;
    }
    this.setDurableEffectHealth(key, kind, "Durable macOS effect is pending.", true);
    let attemptedResult: T | undefined;
    let attempts = 0;
    this.activeAfterCommit(async () => {
      attemptedResult = undefined;
      attempts += 1;
      if (attempts > 1 && !this.durableEffectApplicable(kind, payload)) {
        return obsoleteEffectResult(kind) as T;
      }
      const result = await operation(attempts);
      attemptedResult = result;
      const failure = monitorEffectFailure(kind, result);
      if (failure) throw new Error(failure);
      return result;
    }, { key, kind: "monitor-os", payload: { action: kind, intentKey: key, ...payload } }, (result, committedState) => {
      commitResult?.(result, committedState);
      addEvent(committedState, "monitor_os_effect_completed", { kind, key, payload, result });
      if (!this.coordinatorManagedEffects.has(key)) this.clearDurableEffectHealth(key, kind);
    }, (error, committedState) => {
      if (attemptedResult) commitResult?.(attemptedResult, committedState);
      this.setDurableEffectHealth(key, kind, error.message, false);
      addEvent(committedState, "monitor_os_effect_failed", { kind, key, payload, error: error.message });
    });
    return { ok: false, pending: true, intentKey: key, error: "Durable macOS effect is pending." } as unknown as T;
  }

  durableEffectApplicable(kind: string, payload: UnknownRecord, now = new Date()): boolean {
    const state = structuredClone(this.state);
    if (kind === "grayscale") {
      return grayscaleDecision(state, now, { device: "computer" }).desired === Boolean(payload.desired);
    }
    if (kind === "lock-screen") {
      const policy = activePolicy(state, now);
      return Boolean(
        policy &&
        shouldLockScreenForPolicy(state, policy) &&
        (!payload.policyId || payload.policyId === policy.session?.id)
      );
    }
    if (kind === "quit-app") {
      const app = String(payload.app || "");
      const grayscale = grayscaleDecision(state, now, { device: "computer" });
      if (
        MAC_GRAYSCALE_GUARD_APPS.some((guard) => guard.toLowerCase() === app.toLowerCase()) &&
        grayscaleGuardEnabled(state, grayscale)
      ) return true;
      const sample = effectSample(payload);
      if (payload.intentionalPauseId && intentionalPauseStillApplies(state, sample, payload, now)) return true;
      const policy = policyForSample(state, this.usage, sample, now);
      const lockdown = policy?.kind === "integrity" || isFullLockoutPolicy(policy);
      return Boolean(
        policy &&
        (!payload.policyId || payload.policyId === policy.session?.id) &&
        (lockdown || state.settings.appQuitEnabled) &&
        shouldQuitAppForPolicy(state, policy, app)
      );
    }
    if (kind === "redirect-browser") {
      const sample = effectSample(payload);
      if (payload.intentionalPauseId && intentionalPauseStillApplies(state, sample, payload, now)) return true;
      if (!sample.url) return false;
      const policy = policyForSample(state, this.usage, sample, now);
      if (!policy || (payload.policyId && payload.policyId !== policy.session?.id)) return false;
      const lockdown = policy.kind === "integrity" || isFullLockoutPolicy(policy);
      const contentBlocked = Boolean(policy.contentFilter && (lockdown || contentFilterEnabled(state)));
      const siteBlocked = Boolean(sample.hostname && shouldBlockSite(policy.profile, sample.hostname));
      const urlBlocked = Boolean(sample.url && matchBlockedUrlPattern(policy.profile, sample.url));
      return Boolean(
        policy.browserControl ||
        contentBlocked ||
        ((siteBlocked || urlBlocked) && (lockdown || state.settings.siteRedirectEnabled || systemNetworkBlockingEnabled(state)))
      );
    }
    if (kind === "open-url") {
      return Boolean(payload.intentionalPauseId && intentionalPauseStillApplies(state, effectSample(payload), payload, now));
    }
    if (kind === "focus-shortcut") {
      const policy = activePolicy(state, now);
      return String(payload.policyId || "none") === String(policy?.session?.id || "none");
    }
    if (kind === "mdm-push") {
      return state.deviceControls.ios.mdm.enabled;
    }
    return true;
  }

  private captureTransactionSnapshot(): MonitorTransactionSnapshot {
    return {
      lastPollAt: this.lastPollAt,
      lastMonotonicAt: this.lastMonotonicAt,
      lastSample: structuredClone(this.lastSample),
      previousSample: structuredClone(this.previousSample),
      status: structuredClone(this.status),
      recentBlocks: new Map(this.recentBlocks),
      appBlockHistory: new Map([...this.appBlockHistory].map(([key, value]) => [key, structuredClone(value)])),
      nextEnvironmentRefreshAt: this.nextEnvironmentRefreshAt,
      nextIntegrityRefreshAt: this.nextIntegrityRefreshAt,
      nextAppleContentFilterRefreshAt: this.nextAppleContentFilterRefreshAt,
      nextHardeningDriftRefreshAt: this.nextHardeningDriftRefreshAt,
      nextNetworkBlockRefreshAt: this.nextNetworkBlockRefreshAt,
      nextProcessSweepAt: this.nextProcessSweepAt,
      nextSystemSleepLockAt: this.nextSystemSleepLockAt,
      nextGrayscaleRefreshAt: this.nextGrayscaleRefreshAt,
      lastBrowserActivityEvaluatedTarget: this.lastBrowserActivityEvaluatedTarget,
      lastBrowserActivityEvaluatedGeneration: this.lastBrowserActivityEvaluatedGeneration,
      lastBrowserActivityEvaluatedPolicyGeneration: this.lastBrowserActivityEvaluatedPolicyGeneration,
      browserActivityPolicyGeneration: this.browserActivityPolicyGeneration,
      browserActivityPolicyFingerprint: this.browserActivityPolicyFingerprint,
      browserActivityObservedCommitRevision: this.browserActivityObservedCommitRevision,
      browserActivityNextPolicyRefreshAt: this.browserActivityNextPolicyRefreshAt,
      durableEffectProblems: new Map([...this.durableEffectProblems].map(([key, value]) => [key, structuredClone(value)]))
    };
  }

  private restoreTransactionSnapshot(snapshot: MonitorTransactionSnapshot): void {
    this.lastPollAt = snapshot.lastPollAt;
    this.lastMonotonicAt = snapshot.lastMonotonicAt;
    this.lastSample = snapshot.lastSample;
    this.previousSample = snapshot.previousSample;
    this.status = snapshot.status;
    this.recentBlocks = snapshot.recentBlocks;
    this.appBlockHistory = snapshot.appBlockHistory;
    this.nextEnvironmentRefreshAt = snapshot.nextEnvironmentRefreshAt;
    this.nextIntegrityRefreshAt = snapshot.nextIntegrityRefreshAt;
    this.nextAppleContentFilterRefreshAt = snapshot.nextAppleContentFilterRefreshAt;
    this.nextHardeningDriftRefreshAt = snapshot.nextHardeningDriftRefreshAt;
    this.nextNetworkBlockRefreshAt = snapshot.nextNetworkBlockRefreshAt;
    this.nextProcessSweepAt = snapshot.nextProcessSweepAt;
    this.nextSystemSleepLockAt = snapshot.nextSystemSleepLockAt;
    this.nextGrayscaleRefreshAt = snapshot.nextGrayscaleRefreshAt;
    this.lastBrowserActivityEvaluatedTarget = snapshot.lastBrowserActivityEvaluatedTarget;
    this.lastBrowserActivityEvaluatedGeneration = snapshot.lastBrowserActivityEvaluatedGeneration;
    this.lastBrowserActivityEvaluatedPolicyGeneration = snapshot.lastBrowserActivityEvaluatedPolicyGeneration;
    this.browserActivityPolicyGeneration = snapshot.browserActivityPolicyGeneration;
    this.browserActivityPolicyFingerprint = snapshot.browserActivityPolicyFingerprint;
    this.browserActivityObservedCommitRevision = snapshot.browserActivityObservedCommitRevision;
    this.browserActivityNextPolicyRefreshAt = snapshot.browserActivityNextPolicyRefreshAt;
    this.durableEffectProblems = snapshot.durableEffectProblems;
  }

  async runImmediateEnforcement(reason: string): Promise<UnknownRecord> {
    const now = Date.now();
    const front = await this.updateFrontmostSample();
    await this.enforceFrontmost(front);
    await this.runImmediateSideEffects(now);

    const summary = {
      reason,
      ok: front.ok,
      app: front.app || "",
      hostname: front.ok ? front.hostname : "",
      at: new Date(now).toISOString(),
      lastEnforcement: this.status.lastEnforcement,
      lastProcessSweep: this.status.lastProcessSweep
    };
    this.status.lastImmediateEnforcement = summary;
    if (!front.ok) throw new Error(front.error || "Foreground app detection failed during immediate enforcement.");
    return summary;
  }

  beginPollFrame(): PollFrame {
    const now = Date.now();
    const monotonicNow = performance.now();
    const previousWall = this.lastPollAt;
    const previousMonotonic = this.lastMonotonicAt;
    this.lastPollAt = now;
    this.lastMonotonicAt = monotonicNow;
    return {
      now,
      monotonicNow,
      previousWall,
      previousMonotonic,
      seconds: Math.max(0, (monotonicNow - previousMonotonic) / 1000)
    };
  }

  async recordElapsedUsage(frame: PollFrame): Promise<void> {
    if (!this.lastSample) {
      this.status.lastIdleAccounting = this.idleAccountingStatus(frame, {
        countedSeconds: 0,
        skippedSeconds: 0,
        reason: "no-sample"
      });
      return;
    }

    const wallSeconds = Math.max(0, (frame.now - frame.previousWall) / 1000);
    const elapsedSeconds = Math.max(frame.seconds, wallSeconds);
    if (isInterruptedPollGap(elapsedSeconds, this.state.settings?.pollIntervalMs)) {
      this.status.lastIdleAccounting = this.idleAccountingStatus(frame, {
        countedSeconds: 0,
        skippedSeconds: elapsedSeconds,
        reason: "interrupted-poll"
      });
      return;
    }

    const accounting = await this.idleAdjustedUsage(frame);
    if (accounting.countedSeconds > 0) {
      const startedAt = new Date(frame.now - frame.seconds * 1000);
      const endedAt = new Date(startedAt.getTime() + accounting.countedSeconds * 1000);
      recordUsage(this.usage, this.lastSample, accounting.countedSeconds, new Date(frame.now), {
        segment: { startedAt, endedAt }
      });
      recordIntentionalUseTime(this.state, this.lastSample, accounting.countedSeconds, new Date(frame.now), {
        segment: { startedAt, endedAt }
      });
    }
    this.status.lastIdleAccounting = this.idleAccountingStatus(frame, accounting);
    this.setComponentHealth("idle-usage", accounting.ok === false ? accounting.error || "Idle usage lookup failed" : "");
  }

  async idleAdjustedUsage(frame: PollFrame): Promise<IdleUsageAccounting> {
    const thresholdSeconds = idleUsageThresholdSeconds(this.state.settings?.idleUsageThresholdSeconds);
    if (this.state.settings?.idleUsageTrackingEnabled === false) {
      return {
        enabled: false,
        ok: true,
        countedSeconds: frame.seconds,
        skippedSeconds: 0,
        thresholdSeconds,
        reason: "disabled"
      };
    }

    const idle = await getMacIdleTime();
    if (!idle.ok) {
      return {
        enabled: true,
        ok: false,
        countedSeconds: frame.seconds,
        skippedSeconds: 0,
        idleSeconds: idle.idleSeconds,
        thresholdSeconds,
        source: idle.source,
        error: idle.error,
        reason: "idle-unavailable"
      };
    }

    const countedSeconds = activeSecondsBeforeIdleThreshold(frame.seconds, idle.idleSeconds, thresholdSeconds);
    return {
      enabled: true,
      ok: true,
      countedSeconds,
      skippedSeconds: Math.max(0, frame.seconds - countedSeconds),
      idleSeconds: idle.idleSeconds,
      thresholdSeconds,
      source: idle.source,
      reason: countedSeconds > 0 ? "active" : "idle"
    };
  }

  idleAccountingStatus(frame: PollFrame, accounting: IdleUsageAccounting): UnknownRecord {
    return {
      enabled: accounting.enabled !== false && this.state.settings?.idleUsageTrackingEnabled !== false,
      ok: accounting.ok !== false,
      reason: accounting.reason || "",
      sample: this.lastSample,
      elapsedSeconds: roundSeconds(frame.seconds),
      countedSeconds: roundSeconds(accounting.countedSeconds || 0),
      skippedSeconds: roundSeconds(accounting.skippedSeconds || 0),
      idleSeconds: accounting.idleSeconds === undefined ? null : roundSeconds(accounting.idleSeconds),
      thresholdSeconds: accounting.thresholdSeconds || idleUsageThresholdSeconds(this.state.settings?.idleUsageThresholdSeconds),
      source: accounting.source || "",
      error: accounting.error || "",
      at: new Date(frame.now).toISOString()
    };
  }

  async refreshSafetyRails(frame: PollFrame): Promise<void> {
    this.checkClockTamper(frame.now, frame.previousWall, frame.previousMonotonic, frame.monotonicNow);
    await this.refreshIntegrity(frame.now);
    await this.refreshAppleContentFilterLockdown(frame.now);
    await this.enforceSystemSleepLock(frame.now);
    await this.syncFocusShortcut(frame.now);
    await this.reconcileGrayscale(frame.now);
  }

  async updateFrontmostSample(): Promise<FrontResult> {
    const front = await this.readFrontmost();
    this.applyFrontmostSample(front);
    return front;
  }

  applyFrontmostSample(front: FrontResult): void {
    const previousSample = this.lastSample;
    const currentSample: FrontSample | null = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    if (
      currentSample
      && previousSample
      && (currentSample.app !== previousSample.app || !sameBrowserUrl(currentSample.url, previousSample.url))
    ) this.previousSample = previousSample;
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;
  }

  async enforceFrontmost(front: FrontResult): Promise<void> {
    if (front.ok) await this.enforce(front);
  }

  async runBackgroundEnforcement(now: number): Promise<void> {
    await this.sweepBlockedProcesses(now);
    await this.refreshEnvironment(now);
    this.syncIosMdmPolicy(now);
    await this.pushIosMdmPolicy(now);
  }

  async collectImmediateSideEffectObservations(): Promise<ImmediateSideEffectObservations> {
    const [grayscale, runningApps] = await Promise.all([
      readMacGrayscaleState(),
      listRunningAppNames()
    ]);
    return { grayscale, runningApps };
  }

  async runImmediateSideEffects(
    now: number,
    observations?: ImmediateSideEffectObservations,
    options: { continueOnError?: boolean } = {}
  ): Promise<void> {
    const attempt = async (kind: string, operation: () => unknown | Promise<unknown>) => {
      try {
        await operation();
      } catch (error) {
        if (!options.continueOnError) throw error;
        addEvent(this.state, "immediate_side_effect_prepare_failed", {
          kind,
          error: errorMessage(error),
          at: new Date(now).toISOString()
        });
      }
    };
    await attempt("sleep-lock", () => this.enforceSystemSleepLock(now, { force: true }));
    await attempt("focus-shortcut", () => this.syncFocusShortcut(now, { force: true }));
    await attempt("grayscale", () => this.reconcileGrayscale(now, {
      force: true,
      observed: observations?.grayscale,
      runningApps: observations?.runningApps
    }));
    await attempt("process-sweep", () => this.sweepBlockedProcesses(now, { force: true, runningApps: observations?.runningApps }));
    await attempt("mdm-policy-sync", () => this.syncIosMdmPolicy(now, "immediate-policy-refresh"));
    await attempt("mdm-policy-push", () => this.pushIosMdmPolicy(now, "immediate-policy-refresh", { force: true }));
  }

  async enforceSystemSleepLock(now: number, options: { force?: boolean } = {}) {
    const policy = activePolicy(this.state, new Date(now));
    if (!shouldLockScreenForPolicy(this.state, policy)) {
      this.nextSystemSleepLockAt = 0;
      this.setComponentDisabled("screen-lock");
      return null;
    }
    if (!policy) return null;

    if (!options.force && now < this.nextSystemSleepLockAt) return this.status.lastSystemSleepLock;
    const interval = policy?.session?.mode === "panic"
      ? 3
      : Math.max(15, Number(this.state.settings?.systemSleepLockIntervalSeconds || 60));
    this.nextSystemSleepLockAt = now + interval * 1000;

    const result = await this.externalEffect("lock-screen", { policyId: policy.session?.id || "policy" }, lockScreen);
    const summary = {
      ok: result.ok,
      result,
      policy: policy.session?.title || "Sleep lock",
      at: new Date(now).toISOString(),
      nextAt: new Date(this.nextSystemSleepLockAt).toISOString()
    };
    this.status.lastSystemSleepLock = summary;
    addEvent(this.state, "system_sleep_lock", summary);
    if (!("pending" in result)) this.setComponentHealth("screen-lock", result.ok ? "" : result.error || "macOS screen lock failed");
    return summary;
  }

  async syncFocusShortcut(now: number, _options: { force?: boolean } = {}) {
    const policy = activePolicy(this.state, new Date(now));
    const enabled = Boolean(this.state.settings.focusShortcutEnabled);
    const desiredActive = Boolean(enabled && policy);
    const active = Boolean(this.state.focusShortcut.active);
    const shortcutName = desiredActive
      ? String(this.state.settings.focusShortcutOnName || "").trim()
      : String(this.state.settings.focusShortcutOffName || "").trim();
    if (active === desiredActive || !shortcutName) {
      const durableBefore = JSON.stringify({
        active,
        desiredActive: Boolean(this.state.focusShortcut.desiredActive),
        lastError: this.state.focusShortcut.lastError || ""
      });
      const summary = await reconcileFocusShortcut(this.state, policy, new Date(now));
      this.status.lastFocusShortcut = summary;
      const durableAfter = JSON.stringify({
        active: Boolean(this.state.focusShortcut.active),
        desiredActive: Boolean(this.state.focusShortcut.desiredActive),
        lastError: this.state.focusShortcut.lastError || ""
      });
      if (durableAfter !== durableBefore) this.activePersistenceRequest?.();
      if (!enabled && !active) this.setComponentDisabled("focus-shortcut");
      else this.setComponentHealth("focus-shortcut", summary.enabled && summary.lastError ? String(summary.lastError) : "");
      return summary;
    }
    let effectState = structuredClone(this.state);
    const summary = await this.externalEffect(
      "focus-shortcut",
      { policyId: policy?.session?.id || "none" },
      async (attempt) => {
        effectState = structuredClone(this.state);
        const checkedAt = attempt === 1 ? new Date(now) : new Date();
        return await reconcileFocusShortcut(effectState, activePolicy(effectState, checkedAt), checkedAt);
      },
      (result, committedState) => {
        if (!("skipped" in result) || result.skipped !== "obsolete") {
          committedState.focusShortcut = structuredClone(effectState.focusShortcut);
        }
      }
    );
    this.status.lastFocusShortcut = summary;
    if (summary.changed) {
      addEvent(this.state, "focus_shortcut_applied", {
        action: summary.lastAction,
        shortcut: summary.lastShortcutName,
        policy: summary.lastPolicy
      });
    }
    if (!("pending" in summary)) this.setComponentHealth("focus-shortcut", summary.enabled && summary.lastError ? String(summary.lastError) : "");
    return summary;
  }

  async reconcileGrayscale(now: number, options: {
    force?: boolean;
    observed?: Awaited<ReturnType<typeof readMacGrayscaleState>>;
    runningApps?: Awaited<ReturnType<typeof listRunningAppNames>>;
  } = {}) {
    const desired = grayscaleDecision(this.state, new Date(now), { device: "computer" });
    const previous = this.status.lastGrayscale as { desired?: unknown; current?: unknown } | null;
    const requiresObservation = desired.desired
      || previous === null
      || previous.desired === true
      || previous.current !== true;
    if (!options.force && !requiresObservation) {
      this.nextGrayscaleRefreshAt = 0;
      return this.status.lastGrayscale;
    }
    if (!options.force && now < this.nextGrayscaleRefreshAt) return this.status.lastGrayscale;
    this.nextGrayscaleRefreshAt = now + 5000;

    const observed = options.observed || await readMacGrayscaleState();
    const alreadyCurrent = observed.ok
      && observed.universalAccess === desired.desired
      && observed.coreGraphics === desired.desired;
    const result = alreadyCurrent
      ? { ok: true, desired: desired.desired, changed: false, before: observed, after: observed }
      : await this.externalEffect("grayscale", { desired: desired.desired }, async () => await setMacGrayscaleEnabled(desired.desired));
    const guardEnabled = grayscaleGuardEnabled(this.state, desired);
    const blockedApps = guardEnabled
      ? await this.blockGrayscaleGuardApps(now, options.runningApps)
      : [];

    const after = result.after && typeof result.after === "object" ? result.after as UnknownRecord : {};
    const summary = {
      ok: Boolean(result.ok),
      desired: desired.desired,
      active: Boolean(after.active),
      current: Boolean(result.ok && after.active === desired.desired),
      reason: desired.reason,
      label: desired.label,
      source: desired.source,
      changed: Boolean(result.changed),
      blockedApps,
      error: result.ok ? "" : String(result.error || "macOS grayscale update failed"),
      at: new Date(now).toISOString()
    };
    this.status.lastGrayscale = summary;

    if (summary.changed || blockedApps.length) {
      addEvent(this.state, "grayscale_reconciled", summary);
    }
    if (!("pending" in result)) this.setComponentHealth("grayscale", result.ok ? "" : summary.error);
    if (!guardEnabled) this.setComponentDisabled("grayscale-guard");
    return summary;
  }

  async blockGrayscaleGuardApps(
    _now: number,
    observation?: Awaited<ReturnType<typeof listRunningAppNames>>
  ): Promise<string[]> {
    const running = observation || await listRunningAppNames();
    if (!running.ok) {
      this.setComponentHealth("grayscale-guard", running.error || "Grayscale guard process enumeration failed");
      return [];
    }
    const blocked = running.apps.filter((app) => MAC_GRAYSCALE_GUARD_APPS.some((guard) => guard.toLowerCase() === app.toLowerCase()));
    for (const app of blocked) {
      const result = await this.externalEffect("quit-app", { app, force: true, reason: "grayscale-guard" }, async () => await quitApp(app, { force: true }));
      if (!result.ok && !("pending" in result && result.pending)) {
        this.setComponentHealth("grayscale-guard", result.error || `Could not close ${app}`);
        return blocked;
      }
    }
    this.setComponentHealth("grayscale-guard", "");
    return blocked;
  }

  syncIosMdmPolicy(now: number, reason = "monitor-policy-refresh") {
    const durabilityBefore = iosMdmQueueDurabilityFingerprint(this.state);
    const result = maybeQueueIosMdmPolicyRefresh(this.state, reason, new Date(now));
    if (result.queued) {
      addEvent(this.state, "ios_mdm_policy_queued", { reason, ...result });
    }
    // Persist both additions and cancellations. A cancellation can queue zero
    // replacements when an older matching command is already sent; losing it
    // could resurrect and later deliver a stale policy after a crash.
    if (iosMdmQueueDurabilityFingerprint(this.state) !== durabilityBefore) {
      this.activePersistenceRequest?.();
    }
    return result;
  }

  async pushIosMdmPolicy(now: number, reason = "monitor-policy-push", options: UnknownRecord = {}) {
    if (!this.state.deviceControls.ios.mdm.enabled) {
      this.setComponentDisabled("mdm-push");
      return { ok: true, pushed: 0, skipped: "disabled" };
    }
    if (!iosMdmQueuedPushEligible(this.state, new Date(now), options)) {
      this.setComponentHealth("mdm-push", "");
      return { ok: true, pushed: 0, skipped: "no-queued-devices" };
    }
    try {
      let effectState = structuredClone(this.state);
      const result = await this.externalEffect(
        "mdm-push",
        {
          reason,
          policyHash: this.state.deviceControls.ios.mdm.lastPolicyHash,
          queuedAt: this.state.deviceControls.ios.mdm.lastCommandQueuedAt || "none",
          options
        },
        async (attempt) => {
          effectState = structuredClone(this.state);
          return await pushIosMdmQueuedCommands(effectState, reason, attempt === 1 ? new Date(now) : new Date(), options) as UnknownRecord & { pushed?: number | boolean; failed?: number | boolean };
        },
        (effectResult, committedState) => {
          if (effectResult.skipped !== "obsolete") applyIosMdmPushState(committedState, effectState);
        }
      ) as UnknownRecord & { pushed?: number | boolean; failed?: number | boolean };
      if (result.pushed || result.failed) addEvent(this.state, "ios_mdm_push", { reason, ...result });
      if (!result.pending) this.setComponentHealth("mdm-push", result.failed ? `${result.failed} MDM push command(s) failed` : "");
      return result;
    } catch (error) {
      this.setComponentHealth("mdm-push", error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async readFrontmost(options: FrontReadOptions = {}): Promise<FrontResult> {
    const updateHealth = options.updateHealth !== false;
    const front = await getFrontmostApp({ fresh: options.fresh }) as { ok: boolean; app?: string; error?: string };
    if (!front.ok) {
      if (updateHealth) {
        this.setComponentHealth("frontmost", front.error || "Foreground app detection failed");
        this.status.accessibilityLikelyMissing = /not allowed|assistive|access/i.test(front.error || "");
      }
      return { ok: false, app: front.app || "", error: front.error || "" };
    }

    let url = "";
    let hostname = "";
    let urlError = "";
    if (front.app && appCanReportUrls(front.app)) {
      const browser = await getActiveBrowserUrl(front.app);
      url = browser.url || "";
      hostname = urlHostname(url);
      urlError = browser.ok ? "" : String(browser.error || "");
    }

    if (updateHealth) {
      this.setComponentHealth("frontmost", urlError);
      this.status.accessibilityLikelyMissing = false;
    }
    return { ok: true, app: front.app || "", url, hostname };
  }

  async enforce(front: FrontSample): Promise<void> {
    const preserveBlockedPage = isVigilBlockedPageUrl(front.url);
    const evaluationSample = preserveBlockedPage
      ? { ...front, hostname: "", url: "" }
      : front;

    const policy = this.policyForTarget(evaluationSample);
    if (!policy) {
      if (await this.pauseIntentionalUse(evaluationSample)) return;
      this.status.lastEnforcement = null;
      if (front.app) this.appBlockHistory.delete(front.app);
      return;
    }

    const lockdown = policy.kind === "integrity" || isFullLockoutPolicy(policy);

    if (!preserveBlockedPage && front.url && policy.browserControl) {
      await this.blockSite({
        ...front,
        hostname: policy.browserControl.label
      }, policy, { browserControl: policy.browserControl, originalHostname: front.url });
      return;
    }

    if (!preserveBlockedPage && front.url && policy.contentFilter && (lockdown || contentFilterEnabled(this.state))) {
      await this.blockSite({
        ...front,
        hostname: policy.contentFilter.label
      }, policy, { contentFilter: policy.contentFilter, originalHostname: front.hostname });
      return;
    }

    const redirectEnabled = lockdown || this.state.settings.siteRedirectEnabled;
    const networkSiteEnabled = systemNetworkBlockingEnabled(this.state);
    if (!preserveBlockedPage && front.hostname && (redirectEnabled || networkSiteEnabled) && shouldBlockSite(policy.profile, front.hostname)) {
      const networkBlocked = networkSiteEnabled && await this.blockSiteWithSystemNetwork(front, policy);
      if (shouldRedirectActiveBlockedBrowserTab({ redirectEnabled, networkBlocked, app: front.app, url: front.url })) {
        await this.blockSite(front, policy);
      }
      return;
    }

    const urlPattern = !preserveBlockedPage && front.url ? matchBlockedUrlPattern(policy.profile, front.url) : null;
    if (urlPattern && (redirectEnabled || networkSiteEnabled)) {
      const networkEligible = policy.profile.hostsUrlPatternBlocking !== false && hostPathPatternCanUseSystemNetwork(urlPattern.pattern);
      const networkBlocked = networkSiteEnabled && networkEligible && await this.blockSiteWithSystemNetwork({
        ...front,
        hostname: urlPattern.pattern
      }, policy, { urlPattern, originalHostname: front.hostname });
      if (shouldRedirectActiveBlockedBrowserTab({ redirectEnabled, networkBlocked, app: front.app, url: front.url })) {
        await this.blockSite({
          ...front,
          hostname: urlPattern.pattern
        }, policy, { urlPattern, originalHostname: front.hostname });
      }
      return;
    }

    if ((lockdown || this.state.settings.appQuitEnabled) && shouldQuitAppForPolicy(this.state, policy, front.app)) {
      await this.blockApp(evaluationSample, policy);
    }
  }

  async blockSiteWithSystemNetwork(front: FrontSample, policy: EnforcedPolicy, options: BlockSiteOptions = {}): Promise<boolean> {
    if (!systemNetworkBlockingEnabled(this.state)) return false;
    const network = await this.refreshSystemNetworkBlock(Date.now());
    if (!network.current) return false;

    const type = options.urlPattern ? "url-network" : "site-network";
    const key = `network:${type}:${options.urlPattern?.pattern || front.hostname}`;
    if (this.isCoolingDown(key)) return true;
    this.markCoolingDown(key);

    const result = {
      ok: true,
      method: "system-network-block",
      hosts: network.hosts,
      firewall: network.firewall
    };
    addEvent(this.state, options.urlPattern ? "blocked_url_network" : "blocked_site_network", {
      site: front.hostname,
      app: front.app,
      originalSite: options.originalHostname || front.hostname,
      urlPattern: options.urlPattern || null,
      policy: policy.session.title || policy.session.mode,
      result
    });
    this.status.lastEnforcement = { type, target: front.hostname, result, at: new Date().toISOString() };
    return true;
  }

  async refreshSystemNetworkBlock(now: number, options: { force?: boolean } = {}): Promise<UnknownRecord & { current?: boolean; hosts?: UnknownRecord; firewall?: UnknownRecord }> {
    if (!systemNetworkBlockingEnabled(this.state)) {
      const disabled = {
        enabled: false,
        current: false,
        checkedAt: new Date(now).toISOString()
      };
      this.status.networkBlock = disabled;
      return disabled;
    }

    if (!options.force && this.status.networkBlock && now < this.nextNetworkBlockRefreshAt) {
      return this.status.networkBlock as UnknownRecord & { current?: boolean; hosts?: UnknownRecord; firewall?: UnknownRecord };
    }

    this.nextNetworkBlockRefreshAt = now + 15 * 1000;
    const checkedAt = new Date(now);
    const [hosts, firewall] = await Promise.all([
      hostsStatus(this.state, checkedAt),
      firewallStatus(this.state, checkedAt)
    ]);
    const summary = {
      enabled: true,
      current: networkBlockCurrent(hosts, firewall),
      checkedAt: checkedAt.toISOString(),
      hosts: {
        installed: Boolean(hosts.installed),
        partial: Boolean(hosts.partial),
        stale: Boolean(hosts.stale),
        expectedEntries: hosts.expectedEntries || 0,
        installedEntries: hosts.installedEntries || 0
      },
      firewall: {
        installed: Boolean(firewall.installed),
        partial: Boolean(firewall.partial),
        stale: Boolean(firewall.stale),
        expectedDomainCount: firewall.expectedDomainCount || 0,
        installedEntries: firewall.installedEntries || 0
      }
    };
    this.status.networkBlock = summary;
    return summary;
  }

  async pauseIntentionalUse(front: FrontSample): Promise<boolean> {
    const sample = { app: front.app || "", hostname: front.hostname || "", url: front.url || "" };
    const decision = intentionalUseDecision(this.state, sample, { event: "mac-app", returnUrl: front.url || "" });
    if (!decision.shouldPause) return false;

    const browser = Boolean(front.url && front.app && appCanReportUrls(front.app));
    const redirectUrl = String(decision.redirectUrl || "");
    const effectContext = {
      app: front.app,
      hostname: front.hostname,
      currentUrl: front.url,
      intentionalPauseId: decision.pause?.id || ""
    };
    const result = browser
      ? await this.externalEffect(
          "redirect-browser",
          { ...effectContext, url: redirectUrl },
          async () => await this.browserRedirect(front.app, redirectUrl, { currentUrl: front.url })
        )
      : {
          quit: await this.externalEffect("quit-app", { ...effectContext, force: false }, async () => await quitApp(front.app)),
          open: await this.externalEffect("open-url", { ...effectContext, url: redirectUrl }, async () => await openUrl(redirectUrl))
        };
    addEvent(this.state, "intentional_pause_interrupted", {
      app: front.app,
      site: front.hostname,
      ruleId: decision.rule?.id,
      ruleName: decision.rule?.name,
      pauseId: decision.pause?.id,
      result
    });
    this.status.lastEnforcement = { type: "intentional-pause", target: front.hostname || front.app, result, at: new Date().toISOString() };
    return true;
  }

  policyForTarget(sample: UsageSample): EnforcedPolicy | null {
    const limitBlockIdsBefore = new Set((this.state.limitBlocks || []).map((block) => block.id));
    const policy = policyForSample(this.state, this.usage, sample);
    this.requestPersistenceForNewLimitBlocks(limitBlockIdsBefore);
    return policy;
  }

  requestPersistenceForNewLimitBlocks(previousIds: ReadonlySet<string>): void {
    if ((this.state.limitBlocks || []).some((block) => !previousIds.has(block.id))) {
      this.activePersistenceRequest?.();
    }
  }

  async blockSite(front: FrontSample, policy: EnforcedPolicy, options: BlockSiteOptions = {}): Promise<void> {
    const key = this.browserBlockKey(front, options);
    const coolingDown = this.isCoolingDown(key);
    if (!shouldAttemptBlockedBrowserRedirect({ coolingDown, app: front.app, url: front.url })) return;
    if (!coolingDown) this.markCoolingDown(key);

    const target = this.blockedPageTarget(front, policy, options);

    const result = await this.externalEffect("redirect-browser", {
      app: front.app,
      hostname: front.hostname,
      url: target,
      currentUrl: front.url,
      policyId: policy.session?.id || ""
    }, async () => await this.browserRedirect(front.app, target, { currentUrl: front.url }));
    this.recordBrowserBlock({ front, policy, options }, result, coolingDown);
  }

  async blockApp(front: FrontSample, policy: EnforcedPolicy, options: BlockAppOptions = {}): Promise<void> {
    const key = `app:${front.app}`;
    if (this.isCoolingDown(key)) return;
    this.markCoolingDown(key);

    const decision = appQuitEscalationDecision(this.state, this.appBlockHistory.get(front.app) || null);
    this.appBlockHistory.set(front.app, decision.record);
    this.pruneAppBlockHistory();

    const result = await this.externalEffect("quit-app", {
      app: front.app,
      hostname: front.hostname,
      url: front.url,
      force: decision.force,
      policyId: policy.session?.id || ""
    }, async () => await quitApp(front.app, { force: decision.force }));
    addEvent(this.state, "blocked_app", {
      app: front.app,
      policy: policy.session.title || policy.session.mode,
      source: options.source || "frontmost",
      escalated: decision.force,
      attempts: decision.record.attempts,
      result
    });
    this.status.lastEnforcement = { type: "app", target: front.app, source: options.source || "frontmost", escalated: decision.force, attempts: decision.record.attempts, result, at: new Date().toISOString() };
  }

  async sweepBlockedProcesses(now: number, options: {
    force?: boolean;
    runningApps?: Awaited<ReturnType<typeof listRunningAppNames>>;
  } = {}): Promise<void> {
    const lockdown = integrityLockdownActive(this.state) || isFullLockoutPolicy(activePolicy(this.state, new Date(now)));
    if (!lockdown && (!this.state.settings.processSweepEnabled || !this.state.settings.appQuitEnabled)) {
      this.setComponentDisabled("process-sweep");
      return;
    }
    if (!options.force && now < this.nextProcessSweepAt) return;
    const interval = lockdown ? 3 : Math.max(3, Number(this.state.settings.processSweepIntervalSeconds || 15));
    this.nextProcessSweepAt = now + interval * 1000;

    const running = options.runningApps || await listRunningAppNames();
    if (!running.ok) {
      this.status.lastProcessSweep = { ok: false, error: running.error, at: new Date().toISOString(), blocked: [] };
      this.setComponentHealth("process-sweep", running.error || "Running process enumeration failed");
      if (options.force) throw new Error(running.error || "Running process enumeration failed");
      return;
    }

    const limitBlockIdsBefore = new Set((this.state.limitBlocks || []).map((block) => block.id));
    const blocked = sweepBlockedApps(this.state, this.usage, running.apps);
    this.requestPersistenceForNewLimitBlocks(limitBlockIdsBefore);
    for (const { app, policy } of blocked) {
      await this.blockApp({ app, hostname: "", url: "" }, policy, { source: "process-sweep" });
    }

    this.status.lastProcessSweep = { ok: true, checked: running.apps.length, blocked: blocked.map((item) => item.app), at: new Date().toISOString() };
    this.setComponentHealth("process-sweep", "");
  }

  setComponentHealth(component: string, error: string, options: { pending?: boolean; durableOverride?: boolean } = {}): void {
    if (!error && !options.pending && !options.durableOverride) {
      const durableProblems = [...this.durableEffectProblems.values()].filter((problem) => problem.component === component);
      if (durableProblems.length) {
        const failed = durableProblems.find((problem) => !problem.pending);
        this.setComponentHealth(component, failed?.error || durableProblems[0]?.error || "Durable effect is pending.", {
          pending: !failed,
          durableOverride: true
        });
        return;
      }
    }
    const at = new Date().toISOString();
    this.status.componentHealth[component] = {
      lastAttemptAt: at,
      lastSuccessAt: error || options.pending ? this.status.componentHealth[component]?.lastSuccessAt || null : at,
      error,
      applicable: true,
      state: options.pending ? "pending" : error ? "degraded" : "healthy"
    };
    if (error) {
      delete this.status.componentErrors[component];
      this.status.componentErrors[component] = error;
    } else {
      delete this.status.componentErrors[component];
    }
    const errors = Object.values(this.status.componentErrors);
    this.status.ok = errors.length === 0;
    this.status.lastError = errors.at(-1) || "";
  }

  setComponentDisabled(component: string): void {
    if ([...this.durableEffectProblems.values()].some((problem) => problem.component === component)) {
      this.refreshDurableEffectComponent(component);
      return;
    }
    const at = new Date().toISOString();
    this.status.componentHealth[component] = {
      lastAttemptAt: at,
      lastSuccessAt: this.status.componentHealth[component]?.lastSuccessAt || null,
      error: "",
      applicable: false,
      state: "disabled"
    };
    delete this.status.componentErrors[component];
    const errors = Object.values(this.status.componentErrors);
    this.status.ok = errors.length === 0;
    this.status.lastError = errors.at(-1) || "";
  }

  setDurableEffectHealth(key: string, kind: string, error: string, pending: boolean): void {
    const component = monitorEffectComponent(kind);
    this.durableEffectProblems.set(key, { component, error, pending });
    this.refreshDurableEffectComponent(component);
  }

  clearDurableEffectHealth(key: string, kind: string): void {
    const component = this.durableEffectProblems.get(key)?.component || monitorEffectComponent(kind);
    this.durableEffectProblems.delete(key);
    this.refreshDurableEffectComponent(component);
  }

  private refreshDurableEffectComponent(component: string): void {
    const problems = [...this.durableEffectProblems.values()].filter((problem) => problem.component === component);
    if (!problems.length) {
      if (component === "mdm-push" && !this.state.deviceControls.ios.mdm.enabled) {
        this.setComponentDisabled(component);
        return;
      }
      this.setComponentHealth(component, "", { durableOverride: true });
      return;
    }
    const failed = problems.find((problem) => !problem.pending);
    this.setComponentHealth(component, failed?.error || problems[0]?.error || "Durable effect is pending.", { pending: !failed, durableOverride: true });
  }

  async refreshIntegrity(now: number): Promise<void> {
    if (now < this.nextIntegrityRefreshAt) return;
    this.nextIntegrityRefreshAt = now + 5000;
    const previousTamperAt = this.state.integrity?.stateSeal?.tamperDetectedAt || null;
    const stateSeal = await stateSealStatus(this.state);
    this.status.stateSeal = stateSeal;
    if (stateSeal.tamperDetectedAt && stateSeal.tamperDetectedAt !== previousTamperAt) {
      addEvent(this.state, "state_tamper_lockdown", {
        status: stateSeal.status,
        detail: stateSeal.detail
      });
      this.activePersistenceRequest?.();
    }
  }

  async refreshAppleContentFilterLockdown(now: number): Promise<void> {
    const checkedAt = new Date(now);
    const durabilityBefore = appleContentFilterDurabilityFingerprint(this.state);
    const protectedLock = protectedLockActive(this.state, checkedAt);
    const recovery = appleContentFilterRecoveryActive(this.state);
    const armed = Boolean(this.state.integrity?.runtime?.appleContentFilterArmedAt);
    if (!protectedLock && !recovery) {
      this.nextAppleContentFilterRefreshAt = 0;
      const result = armed
        ? syncAppleContentFilterLockdown(this.state, { required: false }, checkedAt)
        : { active: false, started: false, cleared: false, current: false, reason: "no-protected-lock" };
      this.status.appleContentFilterLockdown = {
        ...result,
        checkedAt: checkedAt.toISOString(),
        skipped: "no-protected-lock"
      };
      if (appleContentFilterDurabilityFingerprint(this.state) !== durabilityBefore) {
        this.activePersistenceRequest?.();
      }
      return;
    }
    if (now < this.nextAppleContentFilterRefreshAt) return;
    this.nextAppleContentFilterRefreshAt = now + 5000;
    const safariFilter = await safariFilterStatus(this.state);
    const result = syncAppleContentFilterLockdown(this.state, safariFilter, checkedAt);
    this.status.appleContentFilterLockdown = {
      ...result,
      checkedAt: checkedAt.toISOString(),
      safariFilter: {
        required: Boolean(safariFilter.required),
        installed: Boolean(safariFilter.installed),
        stale: Boolean(safariFilter.stale),
        current: Boolean(safariFilter.appleCurrent),
        profileCurrent: Boolean(safariFilter.current),
        effectiveCurrent: Boolean(safariFilter.effectiveCurrent),
        appleCurrent: Boolean(safariFilter.appleCurrent),
        appleContentFilter: safariFilter.appleContentFilter || null
      }
    };
    if (result.started) addEvent(this.state, "apple_content_filter_lockdown", result);
    if (result.cleared) addEvent(this.state, "apple_content_filter_restored", result);
    if (result.reason === "uncorroborated-recovery-cleared") {
      addEvent(this.state, "apple_content_filter_recovery_discarded", result);
    }
    if (appleContentFilterDurabilityFingerprint(this.state) !== durabilityBefore) {
      this.activePersistenceRequest?.();
    }
  }

  prepareHardeningDrift(now: number): boolean {
    if (!this.state.settings?.foolproofModeEnabled) {
      this.nextHardeningDriftRefreshAt = 0;
      return false;
    }
    const checkedAt = new Date(now);
    if (!hardeningDriftAttestationRequired(this.state, checkedAt)) {
      // The Apple content-filter recovery has its own fresh five-second check.
      // Resetting this deadline makes a future protected overlap attest all
      // other hardening immediately instead of inheriting an idle cooldown.
      this.nextHardeningDriftRefreshAt = 0;
      this.status.hardeningDrift = {
        checkedAt: checkedAt.toISOString(),
        skipped: appleContentFilterRecoveryActive(this.state)
          ? "apple-content-filter-recovery"
          : "no-protected-lock"
      };
      return false;
    }
    if (now < this.nextHardeningDriftRefreshAt) return false;
    return true;
  }

  hardeningDriftAttestationDue(now: number): boolean {
    return Boolean(
      this.state.settings?.foolproofModeEnabled
      && hardeningDriftAttestationRequired(this.state, new Date(now))
      && now >= this.nextHardeningDriftRefreshAt
    );
  }

  async refreshHardeningDrift(now: number): Promise<boolean> {
    if (this.hardeningDriftMeasurement) return await this.hardeningDriftMeasurement;
    const measurement = this.measureAndApplyHardeningDrift(now);
    const tracked = measurement.finally(() => {
      if (this.hardeningDriftMeasurement === tracked) this.hardeningDriftMeasurement = null;
    });
    this.hardeningDriftMeasurement = tracked;
    return await tracked;
  }

  async measureAndApplyHardeningDrift(initialNow: number): Promise<boolean> {
    let checkedAt = initialNow;
    // A relevant state generation can change while system_profiler or another
    // external attestor is running. Retry one fresh generation immediately;
    // another conflict leaves the deadline at zero so the next cadence retries
    // without ever publishing the stale result as either clean or drifted.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (!this.prepareHardeningDrift(checkedAt)) return false;
      const snapshot = structuredClone(this.committedState);
      const checkedAtDate = new Date(checkedAt);
      if (!hardeningDriftAttestationRequired(snapshot, checkedAtDate)) return false;
      const policyFingerprint = hardeningDriftPolicyFingerprint(snapshot, checkedAtDate);
      const monitorFingerprint = this.hardeningDriftMonitorFingerprint();
      const evidence = await this.collectHardeningDriftEvidence(
        snapshot,
        checkedAt,
        policyFingerprint,
        monitorFingerprint
      );
      const applied = await this.enqueueMutationOperation(
        () => Promise.resolve(this.applyHardeningDriftEvidence(evidence)),
        { persist: false }
      );
      if (!applied.stale) return applied.drift;
      checkedAt = Date.now();
    }
    return false;
  }

  async collectHardeningDriftEvidence(
    snapshot: VigilState,
    checkedAt: number,
    policyFingerprint = hardeningDriftPolicyFingerprint(snapshot, new Date(checkedAt)),
    monitorFingerprint = this.hardeningDriftMonitorFingerprint()
  ): Promise<HardeningDriftMeasurement> {
    const checkedAtDate = new Date(checkedAt);
    const [hosts, firewall, safariFilter, chromeSafeSearch, agent, sourceSeal] = await Promise.all([
      hostsStatus(snapshot, checkedAtDate),
      firewallStatus(snapshot, checkedAtDate),
      safariFilterStatus(snapshot, checkedAtDate),
      attestChromeSafeSearchStatus(),
      launchAgentStatus(),
      sourceSealStatus()
    ]);
    return {
      checkedAt,
      policyFingerprint,
      monitorFingerprint,
      checks: {
        hosts: hosts as UnknownRecord,
        firewall: firewall as UnknownRecord,
        safariFilter: safariFilter as UnknownRecord,
        chromeSafeSearch: chromeSafeSearch as UnknownRecord,
        agent: agent as UnknownRecord,
        monitor: JSON.parse(monitorFingerprint) as UnknownRecord,
        extensionRules: extensionDynamicRulesReady(snapshot, checkedAtDate),
        sourceSeal: sourceSeal as UnknownRecord
      }
    };
  }

  applyHardeningDriftEvidence(evidence: HardeningDriftMeasurement): HardeningDriftApplyResult {
    const checkedAt = new Date(evidence.checkedAt);
    const appliedAt = new Date();
    if (!hardeningDriftAttestationRequired(this.state, appliedAt)) {
      this.nextHardeningDriftRefreshAt = 0;
      this.status.hardeningDrift = {
        checkedAt: appliedAt.toISOString(),
        skipped: appleContentFilterRecoveryActive(this.state)
          ? "apple-content-filter-recovery"
          : "no-protected-lock"
      };
      return { stale: false, drift: false };
    }
    const evidenceAgeMs = appliedAt.getTime() - checkedAt.getTime();
    const fresh = evidenceAgeMs >= 0 && evidenceAgeMs <= HARDENING_DRIFT_EVIDENCE_MAX_AGE_MS;
    const samePolicyGeneration = fresh
      && hardeningDriftPolicyFingerprint(this.state, checkedAt) === evidence.policyFingerprint
      && hardeningDriftPolicyFingerprint(this.state, appliedAt) === evidence.policyFingerprint;
    if (!samePolicyGeneration || this.hardeningDriftMonitorFingerprint() !== evidence.monitorFingerprint) {
      this.nextHardeningDriftRefreshAt = 0;
      return { stale: true, drift: false };
    }

    this.nextHardeningDriftRefreshAt = appliedAt.getTime() + 15 * 1000;
    const { hosts, firewall, safariFilter, chromeSafeSearch, agent, monitor, extensionRules, sourceSeal } = evidence.checks;
    const drift = detectHardeningDrift(
      this.state,
      { hosts, firewall, safariFilter, chromeSafeSearch, agent, monitor, extensionRules, sourceSeal },
      appliedAt
    );
    this.status.hardeningDrift = {
      checkedAt: appliedAt.toISOString(),
      measuredAt: checkedAt.toISOString(),
      sourceSeal: {
        ok: sourceSeal.ok,
        status: sourceSeal.status,
        fileCount: sourceSeal.fileCount || 0
      },
      launchAgent: {
        installed: Boolean(agent.installed),
        loaded: Boolean(agent.loaded),
        running: Boolean(agent.running)
      },
      accessibility: monitor,
      hosts: {
        installed: Boolean(hosts.installed),
        partial: Boolean(hosts.partial),
        stale: Boolean(hosts.stale)
      },
      firewall: {
        installed: Boolean(firewall.installed),
        partial: Boolean(firewall.partial),
        stale: Boolean(firewall.stale)
      },
      safariFilter: {
        required: Boolean(safariFilter.required),
        installed: Boolean(safariFilter.installed),
        stale: Boolean(safariFilter.stale),
        current: Boolean(safariFilter.appleCurrent),
        profileCurrent: Boolean(safariFilter.current),
        effectiveCurrent: Boolean(safariFilter.effectiveCurrent),
        appleCurrent: Boolean(safariFilter.appleCurrent),
        appleContentFilter: safariFilter.appleContentFilter || null
      },
      chromeSafeSearch: {
        required: Boolean(chromeSafeSearch.required),
        installed: Boolean(chromeSafeSearch.installed),
        stale: Boolean(chromeSafeSearch.stale),
        current: Boolean(chromeSafeSearch.current),
        effectiveCurrent: Boolean(chromeSafeSearch.effectiveCurrent),
        profileCurrent: Boolean(chromeSafeSearch.profileCurrent),
        forced: Boolean(chromeSafeSearch.forced),
        locked: Boolean(chromeSafeSearch.locked),
        detail: chromeSafeSearch.detail
      },
      extensionRules: {
        ok: extensionRules.ok,
        status: extensionRules.status,
        count: extensionRules.count || 0
      },
      drift
    };
    if (drift) {
      addEvent(this.state, "hardening_drift_lockdown", drift);
      // New integrity lockdown state must survive a crash between routine
      // checkpoints. This request happens only after evidence matches
      // the currently committed hardening-policy generation.
      this.activePersistenceRequest?.();
    }
    return { stale: false, drift: Boolean(drift) };
  }

  hardeningDriftMonitorFingerprint(): string {
    return JSON.stringify({
      ok: !this.status.componentErrors.frontmost,
      accessibilityLikelyMissing: this.status.accessibilityLikelyMissing
    });
  }

  checkClockTamper(now: number, previousWall: number, previousMonotonic: number, currentMonotonic: number): void {
    const tamper = detectClockTamper(this.state, {
      previousWallMs: previousWall,
      currentWallMs: now,
      previousMonotonicMs: previousMonotonic,
      currentMonotonicMs: currentMonotonic
    }, new Date(now));
    if (!tamper) return;
    this.status.clockTamper = tamper;
    addEvent(this.state, "clock_tamper_lockdown", tamper);
    this.activePersistenceRequest?.();
  }

  async refreshEnvironment(now: number): Promise<void> {
    if (!wifiEnvironmentObservationRequired(this.state)) {
      this.nextEnvironmentRefreshAt = 0;
      this.setComponentDisabled("wifi");
      return;
    }
    if (now < this.nextEnvironmentRefreshAt) return;
    this.nextEnvironmentRefreshAt = now + 30 * 1000;
    const wifi = await getCurrentWifiNetwork();
    applyWifiEnvironmentObservation(this.state, wifi, new Date(now));
    this.setComponentHealth("wifi", wifi.ok ? "" : wifi.error || "Wi-Fi lookup failed");
  }

  isCoolingDown(key: string): boolean {
    return (this.recentBlocks.get(key) || 0) > Date.now();
  }

  markCoolingDown(key: string): void {
    this.recentBlocks.set(key, Date.now() + 12000);
  }

  pruneAppBlockHistory(now = Date.now()): void {
    for (const [app, record] of this.appBlockHistory) {
      if (now - (record.lastSeenAt || 0) > 10 * 60 * 1000) this.appBlockHistory.delete(app);
    }
  }
}

function monitorEffectKey(kind: string, payload: UnknownRecord): string {
  const canonicalPayload = Object.fromEntries(
    Object.entries(payload)
      .filter(([key]) => key !== "intentKey")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, canonicalEffectValue(value)])
  );
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalPayload), "utf8")
    .digest("hex");
  return `monitor-os:${kind}:${digest}`;
}

function canonicalEffectValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEffectValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as UnknownRecord)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalEffectValue(item)])
  );
}

function obsoleteEffectResult(action: string): UnknownRecord {
  return { ok: true, skipped: "obsolete", action };
}

function effectSample(payload: UnknownRecord): FrontSample {
  const url = String(payload.currentUrl || payload.sourceUrl || "");
  return {
    app: String(payload.app || ""),
    hostname: String(payload.hostname || urlHostname(url) || ""),
    url
  };
}

function intentionalPauseStillApplies(
  state: VigilState,
  sample: FrontSample,
  payload: UnknownRecord,
  now: Date
): boolean {
  const decision = intentionalUseDecision(state, sample, { event: "mac-app", returnUrl: sample.url }, now);
  return Boolean(decision.shouldPause && decision.pause?.id === String(payload.intentionalPauseId || ""));
}

function applyIosMdmPushState(targetState: VigilState, effectState: VigilState): void {
  const target = targetState.deviceControls.ios.mdm;
  const effect = effectState.deviceControls.ios.mdm;
  target.lastPushAt = effect.lastPushAt;
  target.lastPushStatus = effect.lastPushStatus;
  target.lastPushError = effect.lastPushError;
  const effectDevices = new Map(effect.devices.map((device) => [String(device.udid || ""), device]));
  for (const device of target.devices) {
    const update = effectDevices.get(String(device.udid || ""));
    if (!update) continue;
    for (const field of ["lastPushAt", "lastPushStatus", "lastPushError"] as const) device[field] = update[field];
  }
  const effectCommands = new Map(effect.commands.map((command) => [String(command.id || ""), command]));
  for (const command of target.commands) {
    const update = effectCommands.get(String(command.id || ""));
    if (!update) continue;
    for (const field of ["lastPushAt", "lastPushStatus", "lastPushError"] as const) command[field] = update[field];
  }
}

function monitorEffectComponent(kind: string): string {
  if (kind === "lock-screen") return "screen-lock";
  if (kind === "focus-shortcut") return "focus-shortcut";
  if (kind === "grayscale") return "grayscale";
  if (kind === "mdm-push") return "mdm-push";
  if (kind === "quit-app") return "process-sweep";
  if (kind === "redirect-browser" || kind === "open-url") return "frontmost";
  return kind || "durable-effect";
}

function monitorEffectFailure(kind: string, result: UnknownRecord): string {
  if (result.pending) return "Durable macOS effect is still pending.";
  if (kind === "mdm-push" && result.skipped === "disabled") return "";
  if (result.ok === false) return String(result.error || `${kind} failed.`);
  if (kind === "focus-shortcut" && result.enabled && result.lastError) return String(result.lastError);
  const failed = Number(result.failed || 0);
  if (kind === "mdm-push" && Number.isFinite(failed) && failed > 0) return `${failed} MDM push command(s) failed.`;
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Unknown durable effect failure");
}

interface IdleUsageAccounting extends UnknownRecord {
  enabled?: boolean;
  ok?: boolean;
  countedSeconds: number;
  skippedSeconds: number;
  idleSeconds?: number;
  thresholdSeconds?: number;
  source?: string;
  error?: string;
  reason?: string;
}

export { activeSecondsBeforeIdleThreshold } from "./monitor/timing.js";
