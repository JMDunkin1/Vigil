import { performance } from "node:perf_hooks";
import { addEvent, saveState, saveUsage } from "./store.js";
import { PORT } from "./defaults.js";
import { contentFilterEnabled } from "./contentFilters.js";
import { reconcileFocusShortcut } from "./focusHooks.js";
import { activePolicy, isFullLockoutPolicy, matchBlockedUrlPattern, shouldBlockSite } from "./policy.js";
import { extensionDynamicRulesReady } from "./foolproof.js";
import { firewallStatus } from "./firewall.js";
import { grayscaleDecision, grayscaleGuardEnabled, MAC_GRAYSCALE_GUARD_APPS } from "./grayscale.js";
import { hostsStatus, launchAgentStatus, stateSealStatus } from "./hardening.js";
import { detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, recordRuntimeHeartbeat, syncAppleContentFilterLockdown } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { maybeQueueIosMdmPolicyRefresh, pushIosMdmQueuedCommands } from "./iosMdm.js";
import { appCanReportUrls, getActiveBrowserUrl, getCurrentWifiNetwork, getFrontmostApp, getMacIdleTime, listRunningAppNames, lockScreen, openUrl, redirectActiveBrowserTab, quitApp, setMacGrayscaleEnabled, urlHostname } from "./macos.js";
import { appQuitEscalationDecision, hostPathPatternCanUseSystemNetwork, policyForSample, shouldAttemptBlockedBrowserRedirect, shouldLockScreenForPolicy, shouldQuitAppForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";
import type { AppBlockRecord, EnforcedPolicy } from "./monitor/policy.js";
import { activeSecondsBeforeIdleThreshold, idleUsageThresholdSeconds, roundSeconds } from "./monitor/timing.js";
import { safariFilterStatus } from "./safariFilter.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { MonitorHandle, VigilState, UnknownRecord, UsageSample, UsageState } from "./types.js";

export { appQuitEscalationDecision, shouldAttemptBlockedBrowserRedirect, shouldLockScreenForPolicy, shouldQuitAppForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";

interface MonitorContext {
  state: VigilState;
  usage: UsageState;
  runtimeInstanceId?: string;
  mutate?: <T>(operation: (
    state: VigilState,
    usage: UsageState,
    afterCommit: <TResult>(
      effect: () => TResult | Promise<TResult>,
      descriptor?: { key: string; kind: string; payload: UnknownRecord },
      complete?: (result: TResult, state: VigilState, usage: UsageState) => void | Promise<void>,
      fail?: (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
    ) => void
  ) => Promise<T>) => Promise<T>;
}

interface FrontSample extends UsageSample {
  app: string;
  hostname: string;
  url: string;
}

type FrontResult = (FrontSample & { ok: true }) | { ok: false; app: string; error: string };

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
  runtimeGap: UnknownRecord | null;
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
}

interface BlockSiteOptions {
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string };
  urlPattern?: { pattern: string; label: string };
  originalHostname?: string;
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
  runtimeGapChecked: boolean;
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
  lastPollAt: number;
  lastMonotonicAt: number;
  lastSample: FrontSample | null;
  timer: ReturnType<typeof setInterval> | null;
  status: MonitorStatus;
  recentBlocks: Map<string, number>;
  appBlockHistory: Map<string, AppBlockRecord>;
  immediateEnforcement: Promise<UnknownRecord> | null;
  tickInFlight: Promise<void> | null;
  operationTail: Promise<void>;
  stopping: boolean;
  nextEnvironmentRefreshAt: number;
  nextIntegrityRefreshAt: number;
  nextAppleContentFilterRefreshAt: number;
  nextHardeningDriftRefreshAt: number;
  nextNetworkBlockRefreshAt: number;
  nextProcessSweepAt: number;
  nextSystemSleepLockAt: number;
  nextGrayscaleRefreshAt: number;
  runtimeGapChecked: boolean;
  mutate: NonNullable<MonitorContext["mutate"]>;
  activeAfterCommit: (<TResult>(
    effect: () => TResult | Promise<TResult>,
    descriptor?: { key: string; kind: string; payload: UnknownRecord },
    complete?: (result: TResult, state: VigilState, usage: UsageState) => void | Promise<void>,
    fail?: (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
  ) => void) | null;
  durableEffectProblems: Map<string, { component: string; error: string; pending: boolean }>;
  coordinatorManagedEffects: Set<string>;

  constructor({ state, usage, mutate, runtimeInstanceId }: MonitorContext) {
    this.state = state;
    this.usage = usage;
    this.lastPollAt = Date.now();
    this.lastMonotonicAt = performance.now();
    this.lastSample = null;
    this.timer = null;
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
      runtimeGap: null,
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
      accessibilityLikelyMissing: false
    };
    this.recentBlocks = new Map();
    this.appBlockHistory = new Map();
    this.immediateEnforcement = null;
    this.tickInFlight = null;
    this.operationTail = Promise.resolve();
    this.stopping = false;
    this.nextEnvironmentRefreshAt = 0;
    this.nextIntegrityRefreshAt = 0;
    this.nextAppleContentFilterRefreshAt = 0;
    this.nextHardeningDriftRefreshAt = 0;
    this.nextNetworkBlockRefreshAt = 0;
    this.nextProcessSweepAt = 0;
    this.nextSystemSleepLockAt = 0;
    this.nextGrayscaleRefreshAt = 0;
    this.runtimeGapChecked = false;
    this.mutate = mutate || (async (operation) => await operation(this.state, this.usage, (effect, _descriptor, complete, fail) => {
      void (async () => {
        try {
          const result = await effect();
          await complete?.(result, this.state, this.usage);
        } catch (error) {
          await fail?.(error instanceof Error ? error : new Error(String(error)), this.state, this.usage);
        }
      })();
    }));
    this.activeAfterCommit = null;
    this.durableEffectProblems = new Map();
    this.coordinatorManagedEffects = new Set();
  }

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.runScheduledTick();
    this.timer = setInterval(() => {
      void this.runScheduledTick();
    }, this.state.settings.pollIntervalMs || 3000);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopping = true;
    await this.operationTail;
  }

  runScheduledTick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.tickInFlight) return this.tickInFlight;
    const operation = this.enqueueOperation(() => this.runMutation(() => this.tick()))
      .catch(async (error) => {
        try {
          await this.runMutation(async () => {
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

  async tick(): Promise<void> {
    const frame = this.beginPollFrame();
    await this.recordElapsedUsage(frame);
    await this.refreshSafetyRails(frame);
    const front = await this.updateFrontmostSample();
    await this.enforceFrontmost(front);
    await this.runBackgroundEnforcement(frame.now);
    await this.persistHeartbeat(frame.now);
    this.setComponentHealth("tick", "");
    this.status.lastSuccessfulTickAt = new Date(frame.now).toISOString();
  }

  enforceImmediately(reason = "manual"): Promise<UnknownRecord> {
    if (this.stopping) return Promise.reject(new Error("Vigil monitor is stopping."));
    if (this.immediateEnforcement) return this.immediateEnforcement;
    const operation = this.enqueueOperation(() => this.runMutation(() => this.runImmediateEnforcement(reason)));
    const tracked = operation.finally(() => {
      if (this.immediateEnforcement === tracked) this.immediateEnforcement = null;
    });
    this.immediateEnforcement = tracked;
    return tracked;
  }

  reconcileDurableEffect(action: string, payload: UnknownRecord): Promise<UnknownRecord> {
    return this.enqueueOperation(async () => {
      const key = String(payload.intentKey || monitorEffectKey(action, payload));
      this.setDurableEffectHealth(key, action, "Recovered durable effect is pending.", true);
      try {
        let result: UnknownRecord;
        let effectState: VigilState | null = null;
        if (!this.durableEffectApplicable(action, payload)) result = obsoleteEffectResult(action);
        else if (action === "session-enforcement") result = await this.runMutation(() => this.runImmediateEnforcement("session-start"));
        else if (action === "policy-enforcement") result = await this.runMutation(() => this.runImmediateEnforcement(String(payload.reason || "recovered-policy-enforcement")));
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
        else if (action === "redirect-browser") result = await redirectActiveBrowserTab(String(payload.app || ""), String(payload.url || ""), { currentUrl: String(payload.currentUrl || "") });
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
    });
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
    const queued = this.operationTail.then(operation);
    this.operationTail = queued.then(() => {}, () => {});
    return queued;
  }

  async runMutation<T>(operation: () => Promise<T>): Promise<T> {
    let monitorSnapshot: MonitorTransactionSnapshot | null = null;
    try {
      return await this.mutate(async (draftState, draftUsage, afterCommit) => {
        monitorSnapshot = this.captureTransactionSnapshot();
        const previousState = this.state;
        const previousUsage = this.usage;
        const previousAfterCommit = this.activeAfterCommit;
        this.state = draftState;
        this.usage = draftUsage;
        this.activeAfterCommit = afterCommit;
        try {
          return await operation();
        } finally {
          this.state = previousState;
          this.usage = previousUsage;
          this.activeAfterCommit = previousAfterCommit;
        }
      });
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
    addEvent(this.state, "monitor_os_effect_intended", { kind, key, payload });
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
      runtimeGapChecked: this.runtimeGapChecked,
      durableEffectProblems: new Map([...this.durableEffectProblems].map(([key, value]) => [key, structuredClone(value)]))
    };
  }

  private restoreTransactionSnapshot(snapshot: MonitorTransactionSnapshot): void {
    this.lastPollAt = snapshot.lastPollAt;
    this.lastMonotonicAt = snapshot.lastMonotonicAt;
    this.lastSample = snapshot.lastSample;
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
    this.runtimeGapChecked = snapshot.runtimeGapChecked;
    this.durableEffectProblems = snapshot.durableEffectProblems;
  }

  async runImmediateEnforcement(reason: string): Promise<UnknownRecord> {
    const now = Date.now();
    const front = await this.updateFrontmostSample();
    await this.enforceFrontmost(front);
    await this.runImmediateSideEffects(now);
    await this.persistHeartbeat(now);

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

    const accounting = await this.idleAdjustedUsage(frame);
    if (accounting.countedSeconds > 0) {
      recordUsage(this.usage, this.lastSample, accounting.countedSeconds);
      recordIntentionalUseTime(this.state, this.lastSample, accounting.countedSeconds);
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
    this.checkRuntimeGap(frame.now);
    this.checkClockTamper(frame.now, frame.previousWall, frame.previousMonotonic, frame.monotonicNow);
    await this.refreshIntegrity(frame.now);
    await this.refreshAppleContentFilterLockdown(frame.now);
    await this.refreshHardeningDrift(frame.now);
    await this.enforceSystemSleepLock(frame.now);
    await this.syncFocusShortcut(frame.now);
    await this.reconcileGrayscale(frame.now);
  }

  async updateFrontmostSample(): Promise<FrontResult> {
    const previousSample = this.lastSample;
    const front = await this.readFrontmost();
    const currentSample: FrontSample | null = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;
    return front;
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

  async runImmediateSideEffects(now: number): Promise<void> {
    await this.enforceSystemSleepLock(now, { force: true });
    await this.syncFocusShortcut(now, { force: true });
    await this.reconcileGrayscale(now, { force: true });
    await this.sweepBlockedProcesses(now, { force: true });
    this.syncIosMdmPolicy(now, "immediate-policy-refresh");
    await this.pushIosMdmPolicy(now, "immediate-policy-refresh", { force: true });
  }

  async persistHeartbeat(now: number): Promise<void> {
    recordRuntimeHeartbeat(this.state, new Date(now));
    await saveUsage(this.usage);
    await saveState(this.state);
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

  async reconcileGrayscale(now: number, options: { force?: boolean } = {}) {
    if (!options.force && now < this.nextGrayscaleRefreshAt) return this.status.lastGrayscale;
    this.nextGrayscaleRefreshAt = now + 5000;

    const desired = grayscaleDecision(this.state, new Date(now), { device: "computer" });
    const result = await this.externalEffect("grayscale", { desired: desired.desired }, async () => await setMacGrayscaleEnabled(desired.desired));
    const guardEnabled = grayscaleGuardEnabled(this.state, desired);
    const blockedApps = guardEnabled
      ? await this.blockGrayscaleGuardApps(now)
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

  async blockGrayscaleGuardApps(_now: number): Promise<string[]> {
    const running = await listRunningAppNames();
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
    const result = maybeQueueIosMdmPolicyRefresh(this.state, reason, new Date(now));
    if (result.queued) {
      addEvent(this.state, "ios_mdm_policy_queued", { reason, ...result });
    }
    return result;
  }

  async pushIosMdmPolicy(now: number, reason = "monitor-policy-push", options: UnknownRecord = {}) {
    if (!this.state.deviceControls.ios.mdm.enabled) {
      this.setComponentDisabled("mdm-push");
      return { ok: true, pushed: 0, skipped: "disabled" };
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

  async readFrontmost(): Promise<FrontResult> {
    const front = await getFrontmostApp() as { ok: boolean; app?: string; error?: string };
    if (!front.ok) {
      this.setComponentHealth("frontmost", front.error || "Foreground app detection failed");
      this.status.accessibilityLikelyMissing = /not allowed|assistive|access/i.test(front.error || "");
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

    this.setComponentHealth("frontmost", urlError);
    this.status.accessibilityLikelyMissing = false;
    return { ok: true, app: front.app || "", url, hostname };
  }

  async enforce(front: FrontSample): Promise<void> {
    const policy = this.policyForTarget(front);
    if (!policy) {
      if (await this.pauseIntentionalUse(front)) return;
      this.status.lastEnforcement = null;
      if (front.app) this.appBlockHistory.delete(front.app);
      return;
    }

    const lockdown = policy.kind === "integrity" || isFullLockoutPolicy(policy);

    if (front.url && policy.browserControl) {
      await this.blockSite({
        ...front,
        hostname: policy.browserControl.label
      }, policy, { browserControl: policy.browserControl, originalHostname: front.url });
      return;
    }

    if (front.url && policy.contentFilter && (lockdown || contentFilterEnabled(this.state))) {
      await this.blockSite({
        ...front,
        hostname: policy.contentFilter.label
      }, policy, { contentFilter: policy.contentFilter, originalHostname: front.hostname });
      return;
    }

    const redirectEnabled = lockdown || this.state.settings.siteRedirectEnabled;
    const networkSiteEnabled = systemNetworkBlockingEnabled(this.state);
    if (front.hostname && (redirectEnabled || networkSiteEnabled) && shouldBlockSite(policy.profile, front.hostname)) {
      const networkBlocked = networkSiteEnabled && await this.blockSiteWithSystemNetwork(front, policy);
      if (shouldRedirectActiveBlockedBrowserTab({ redirectEnabled, networkBlocked, app: front.app, url: front.url })) {
        await this.blockSite(front, policy);
      }
      return;
    }

    const urlPattern = front.url ? matchBlockedUrlPattern(policy.profile, front.url) : null;
    if (urlPattern && (redirectEnabled || networkSiteEnabled)) {
      const networkEligible = policy.profile.hostsUrlPatternBlocking !== false && hostPathPatternCanUseSystemNetwork(urlPattern.pattern);
      const networkBlocked = networkSiteEnabled && networkEligible && await this.blockSiteWithSystemNetwork({
        ...front,
        hostname: urlPattern.label
      }, policy, { urlPattern, originalHostname: front.hostname });
      if (shouldRedirectActiveBlockedBrowserTab({ redirectEnabled, networkBlocked, app: front.app, url: front.url })) {
        await this.blockSite({
          ...front,
          hostname: urlPattern.label
        }, policy, { urlPattern, originalHostname: front.hostname });
      }
      return;
    }

    if ((lockdown || this.state.settings.appQuitEnabled) && shouldQuitAppForPolicy(this.state, policy, front.app)) {
      await this.blockApp(front, policy);
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
      ? await this.externalEffect("redirect-browser", { ...effectContext, url: redirectUrl }, async () => await redirectActiveBrowserTab(front.app, redirectUrl))
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
    return policyForSample(this.state, this.usage, sample);
  }

  async blockSite(front: FrontSample, policy: EnforcedPolicy, options: BlockSiteOptions = {}): Promise<void> {
    const key = options.browserControl
      ? `browser-control:${options.browserControl.area}:${front.url || front.hostname}`
      : options.contentFilter
      ? `content:${options.contentFilter.id}:${front.url || front.hostname}`
      : options.urlPattern
        ? `url:${options.urlPattern.pattern}:${front.url || front.hostname}`
        : `site:${front.hostname}`;
    const coolingDown = this.isCoolingDown(key);
    if (!shouldAttemptBlockedBrowserRedirect({ coolingDown, app: front.app, url: front.url })) return;
    if (!coolingDown) this.markCoolingDown(key);

    const target = new URL(`http://127.0.0.1:${PORT}/blocked`);
    target.searchParams.set("site", front.hostname);
    target.searchParams.set("until", policy.endsAt);
    target.searchParams.set("mode", policy.session.mode || "focus");

    const result = await this.externalEffect("redirect-browser", {
      app: front.app,
      hostname: front.hostname,
      url: target.toString(),
      currentUrl: front.url,
      policyId: policy.session?.id || ""
    }, async () => await redirectActiveBrowserTab(front.app, target.toString(), { currentUrl: front.url }));
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
      addEvent(this.state, options.browserControl ? "blocked_browser_control" : options.contentFilter ? "blocked_content" : options.urlPattern ? "blocked_url" : "blocked_site", detail);
    }
    this.status.lastEnforcement = { type: options.browserControl ? "browser-control" : options.contentFilter ? "content" : options.urlPattern ? "url" : "site", target: front.hostname, result, coolingDownRetry: coolingDown, at: new Date().toISOString() };
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

  async sweepBlockedProcesses(now: number, options: { force?: boolean } = {}): Promise<void> {
    const lockdown = integrityLockdownActive(this.state) || isFullLockoutPolicy(activePolicy(this.state, new Date(now)));
    if (!lockdown && (!this.state.settings.processSweepEnabled || !this.state.settings.appQuitEnabled)) {
      this.setComponentDisabled("process-sweep");
      return;
    }
    if (!options.force && now < this.nextProcessSweepAt) return;
    const interval = lockdown ? 3 : Math.max(3, Number(this.state.settings.processSweepIntervalSeconds || 15));
    this.nextProcessSweepAt = now + interval * 1000;

    const running = await listRunningAppNames();
    if (!running.ok) {
      this.status.lastProcessSweep = { ok: false, error: running.error, at: new Date().toISOString(), blocked: [] };
      this.setComponentHealth("process-sweep", running.error || "Running process enumeration failed");
      if (options.force) throw new Error(running.error || "Running process enumeration failed");
      return;
    }

    const blocked = sweepBlockedApps(this.state, this.usage, running.apps);
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
    }
  }

  async refreshAppleContentFilterLockdown(now: number): Promise<void> {
    if (now < this.nextAppleContentFilterRefreshAt) return;
    this.nextAppleContentFilterRefreshAt = now + 5000;
    const safariFilter = await safariFilterStatus(this.state);
    const recoveryRequired = Boolean(this.state.settings?.foolproofModeEnabled && safariFilter.required);
    const result = syncAppleContentFilterLockdown(this.state, {
      ...safariFilter,
      required: recoveryRequired
    }, new Date(now));
    this.status.appleContentFilterLockdown = {
      ...result,
      checkedAt: new Date(now).toISOString(),
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
  }

  async refreshHardeningDrift(now: number): Promise<void> {
    if (!this.state.settings?.foolproofModeEnabled) return;
    if (now < this.nextHardeningDriftRefreshAt) return;
    this.nextHardeningDriftRefreshAt = now + 15 * 1000;

    const hosts = await hostsStatus(this.state);
    const firewall = await firewallStatus(this.state);
    const safariFilter = await safariFilterStatus(this.state);
    const agent = await launchAgentStatus();
    const extensionRules = extensionDynamicRulesReady(this.state, new Date(now));
    const sourceSeal = await sourceSealStatus();
    const monitor = {
      ok: this.status.ok,
      accessibilityLikelyMissing: this.status.accessibilityLikelyMissing
    };
    const drift = detectHardeningDrift(this.state, { hosts, firewall, safariFilter, agent, monitor, extensionRules, sourceSeal }, new Date(now));
    this.status.hardeningDrift = {
      checkedAt: new Date(now).toISOString(),
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
      extensionRules: {
        ok: extensionRules.ok,
        status: extensionRules.status,
        count: extensionRules.count || 0
      },
      drift
    };
    if (drift) addEvent(this.state, "hardening_drift_lockdown", drift);
  }

  checkRuntimeGap(now: number): void {
    if (this.runtimeGapChecked) return;
    this.runtimeGapChecked = true;
    const gap = detectRuntimeGap(this.state, new Date(now));
    if (!gap) return;
    this.status.runtimeGap = gap;
    addEvent(this.state, "runtime_downtime_lockdown", gap);
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
  }

  async refreshEnvironment(now: number): Promise<void> {
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
  );
  return `monitor-os:${kind}:${JSON.stringify(canonicalPayload)}`;
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
