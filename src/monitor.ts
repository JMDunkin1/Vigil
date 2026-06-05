import { performance } from "node:perf_hooks";
import { addEvent, saveState, saveUsage } from "./store.js";
import { PORT } from "./defaults.js";
import { contentFilterEnabled } from "./contentFilters.js";
import { reconcileFocusShortcut } from "./focusHooks.js";
import { activePolicy, isFullLockoutPolicy, matchBlockedUrlPattern, shouldBlockAppForPolicy, shouldBlockSite } from "./policy.js";
import { extensionDynamicRulesReady } from "./foolproof.js";
import { firewallStatus } from "./firewall.js";
import { grayscaleDecision, grayscaleGuardEnabled, MAC_GRAYSCALE_GUARD_APPS } from "./grayscale.js";
import { hostsStatus, launchAgentStatus, stateSealStatus } from "./hardening.js";
import { detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, recordRuntimeHeartbeat } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { maybeQueueIosMdmPolicyRefresh, pushIosMdmQueuedCommands } from "./iosMdm.js";
import { appCanReportUrls, getActiveBrowserUrl, getCurrentWifiNetwork, getFrontmostApp, getMacIdleTime, listRunningAppNames, lockScreen, openUrl, redirectActiveBrowserTab, quitApp, setMacGrayscaleEnabled, urlHostname } from "./macos.js";
import { appQuitEscalationDecision, hostPathPatternCanUseSystemNetwork, policyForSample, shouldLockScreenForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";
import type { AppBlockRecord, EnforcedPolicy } from "./monitor/policy.js";
import { activeSecondsBeforeIdleThreshold, idleUsageThresholdSeconds, roundSeconds } from "./monitor/timing.js";
import { safariFilterStatus } from "./safariFilter.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { MonitorHandle, VigilState, UnknownRecord, UsageSample, UsageState } from "./types.js";

export { appQuitEscalationDecision, shouldLockScreenForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "./monitor/policy.js";

interface MonitorContext {
  state: VigilState;
  usage: UsageState;
}

interface FrontSample extends UsageSample {
  app: string;
  hostname: string;
  url: string;
}

type FrontResult = (FrontSample & { ok: true }) | { ok: false; app: string; error: string };

interface MonitorStatus extends UnknownRecord {
  ok: boolean;
  lastError: string;
  lastSample: FrontSample | null;
  lastEnforcement: UnknownRecord | null;
  stateSeal: UnknownRecord | null;
  runtimeGap: UnknownRecord | null;
  clockTamper: UnknownRecord | null;
  hardeningDrift: UnknownRecord | null;
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

export function startMonitor(context: MonitorContext): MonitorHandle {
  const monitor = new Monitor(context);
  monitor.start();
  return monitor;
}

class Monitor implements MonitorHandle {
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
  nextEnvironmentRefreshAt: number;
  nextIntegrityRefreshAt: number;
  nextHardeningDriftRefreshAt: number;
  nextNetworkBlockRefreshAt: number;
  nextProcessSweepAt: number;
  nextSystemSleepLockAt: number;
  nextGrayscaleRefreshAt: number;
  runtimeGapChecked: boolean;

  constructor({ state, usage }: MonitorContext) {
    this.state = state;
    this.usage = usage;
    this.lastPollAt = Date.now();
    this.lastMonotonicAt = performance.now();
    this.lastSample = null;
    this.timer = null;
    this.status = {
      ok: true,
      lastError: "",
      lastSample: null,
      lastEnforcement: null,
      stateSeal: null,
      runtimeGap: null,
      clockTamper: null,
      hardeningDrift: null,
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
    this.nextEnvironmentRefreshAt = 0;
    this.nextIntegrityRefreshAt = 0;
    this.nextHardeningDriftRefreshAt = 0;
    this.nextNetworkBlockRefreshAt = 0;
    this.nextProcessSweepAt = 0;
    this.nextSystemSleepLockAt = 0;
    this.nextGrayscaleRefreshAt = 0;
    this.runtimeGapChecked = false;
  }

  start(): void {
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.state.settings.pollIntervalMs || 3000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const frame = this.beginPollFrame();
    await this.recordElapsedUsage(frame);
    await this.refreshSafetyRails(frame);
    const front = await this.updateFrontmostSample();
    await this.enforceFrontmost(front);
    await this.runBackgroundEnforcement(frame.now);
    await this.persistHeartbeat(frame.now);
  }

  enforceImmediately(reason = "manual"): Promise<UnknownRecord> {
    if (this.immediateEnforcement) return this.immediateEnforcement;
    this.immediateEnforcement = this.runImmediateEnforcement(reason)
      .finally(() => {
        this.immediateEnforcement = null;
      });
    return this.immediateEnforcement;
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
      return null;
    }
    if (!policy) return null;

    if (!options.force && now < this.nextSystemSleepLockAt) return this.status.lastSystemSleepLock;
    const interval = policy?.session?.mode === "panic"
      ? 3
      : Math.max(15, Number(this.state.settings?.systemSleepLockIntervalSeconds || 60));
    this.nextSystemSleepLockAt = now + interval * 1000;

    const result = await lockScreen();
    const summary = {
      ok: result.ok,
      result,
      policy: policy.session?.title || "Sleep lock",
      at: new Date(now).toISOString(),
      nextAt: new Date(this.nextSystemSleepLockAt).toISOString()
    };
    this.status.lastSystemSleepLock = summary;
    addEvent(this.state, "system_sleep_lock", summary);
    if (!result.ok) {
      this.status.ok = false;
      this.status.lastError = result.error || "macOS screen lock failed";
    }
    return summary;
  }

  async syncFocusShortcut(now: number, _options: { force?: boolean } = {}) {
    const policy = activePolicy(this.state, new Date(now));
    const summary = await reconcileFocusShortcut(this.state, policy, new Date(now));
    this.status.lastFocusShortcut = summary;
    if (summary.changed) {
      addEvent(this.state, "focus_shortcut_applied", {
        action: summary.lastAction,
        shortcut: summary.lastShortcutName,
        policy: summary.lastPolicy
      });
    }
    if (summary.enabled && summary.lastError) {
      this.status.ok = false;
      this.status.lastError = summary.lastError;
    }
    return summary;
  }

  async reconcileGrayscale(now: number, options: { force?: boolean } = {}) {
    if (!options.force && now < this.nextGrayscaleRefreshAt) return this.status.lastGrayscale;
    this.nextGrayscaleRefreshAt = now + 5000;

    const desired = grayscaleDecision(this.state, new Date(now), { device: "computer" });
    const result = await setMacGrayscaleEnabled(desired.desired);
    const blockedApps = desired.desired && grayscaleGuardEnabled(this.state, desired)
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
    if (!result.ok) {
      this.status.ok = false;
      this.status.lastError = summary.error;
    }
    return summary;
  }

  async blockGrayscaleGuardApps(_now: number): Promise<string[]> {
    const running = await listRunningAppNames();
    if (!running.ok) return [];
    const blocked = running.apps.filter((app) => MAC_GRAYSCALE_GUARD_APPS.some((guard) => guard.toLowerCase() === app.toLowerCase()));
    for (const app of blocked) {
      await quitApp(app, { force: true });
    }
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
    const result = await pushIosMdmQueuedCommands(this.state, reason, new Date(now), options) as UnknownRecord & { pushed?: number | boolean; failed?: number | boolean };
    if (result.pushed || result.failed) {
      addEvent(this.state, "ios_mdm_push", { reason, ...result });
    }
    return result;
  }

  async readFrontmost(): Promise<FrontResult> {
    const front = await getFrontmostApp() as { ok: boolean; app?: string; error?: string };
    if (!front.ok) {
      this.status.ok = false;
      this.status.lastError = front.error || "";
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

    this.status.ok = true;
    this.status.lastError = urlError;
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

    if ((lockdown || this.state.settings.appQuitEnabled) && shouldBlockAppForPolicy(this.state, policy, front.app)) {
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
    const result = browser
      ? await redirectActiveBrowserTab(front.app, redirectUrl)
      : {
          quit: await quitApp(front.app),
          open: await openUrl(redirectUrl)
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
    if (this.isCoolingDown(key)) return;
    this.markCoolingDown(key);

    const target = new URL(`http://127.0.0.1:${PORT}/blocked`);
    target.searchParams.set("site", front.hostname);
    target.searchParams.set("until", policy.endsAt);
    target.searchParams.set("mode", policy.session.mode || "focus");

    const result = await redirectActiveBrowserTab(front.app, target.toString());
    addEvent(this.state, options.browserControl ? "blocked_browser_control" : options.contentFilter ? "blocked_content" : options.urlPattern ? "blocked_url" : "blocked_site", {
      site: front.hostname,
      app: front.app,
      originalSite: options.originalHostname || front.hostname,
      browserControl: options.browserControl || null,
      contentFilter: options.contentFilter || null,
      urlPattern: options.urlPattern || null,
      policy: policy.session.title || policy.session.mode,
      result
    });
    this.status.lastEnforcement = { type: options.browserControl ? "browser-control" : options.contentFilter ? "content" : options.urlPattern ? "url" : "site", target: front.hostname, result, at: new Date().toISOString() };
  }

  async blockApp(front: FrontSample, policy: EnforcedPolicy, options: BlockAppOptions = {}): Promise<void> {
    const key = `app:${front.app}`;
    if (this.isCoolingDown(key)) return;
    this.markCoolingDown(key);

    const decision = appQuitEscalationDecision(this.state, this.appBlockHistory.get(front.app) || null);
    this.appBlockHistory.set(front.app, decision.record);
    this.pruneAppBlockHistory();

    const result = await quitApp(front.app, { force: decision.force });
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
    if (!lockdown && (!this.state.settings.processSweepEnabled || !this.state.settings.appQuitEnabled)) return;
    if (!options.force && now < this.nextProcessSweepAt) return;
    const interval = lockdown ? 3 : Math.max(3, Number(this.state.settings.processSweepIntervalSeconds || 15));
    this.nextProcessSweepAt = now + interval * 1000;

    const running = await listRunningAppNames();
    if (!running.ok) {
      this.status.lastProcessSweep = { ok: false, error: running.error, at: new Date().toISOString(), blocked: [] };
      return;
    }

    const blocked = sweepBlockedApps(this.state, this.usage, running.apps);
    for (const { app, policy } of blocked) {
      await this.blockApp({ app, hostname: "", url: "" }, policy, { source: "process-sweep" });
    }

    this.status.lastProcessSweep = { ok: true, checked: running.apps.length, blocked: blocked.map((item) => item.app), at: new Date().toISOString() };
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
        current: Boolean(safariFilter.current)
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
    this.state.environment.wifiCheckedAt = new Date().toISOString();
    if (wifi.ok) {
      this.state.environment.wifiSsid = wifi.ssid;
      this.state.environment.wifiError = "";
    } else {
      this.state.environment.wifiSsid = "";
      this.state.environment.wifiError = wifi.error || "Wi-Fi lookup failed";
    }
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
