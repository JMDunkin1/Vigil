import { performance } from "node:perf_hooks";
import { addEvent, saveState, saveUsage } from "./store.js";
import { PORT } from "./defaults.js";
import { matchContentFilterUrl } from "./contentFilters.js";
import { reconcileFocusShortcut } from "./focusHooks.js";
import { activePolicy, baselinePolicy, isFullLockoutPolicy, isProcessSweepExemptApp, isStrictBypassAppForPolicy, matchBlockedUrlPattern, matchStrictBrowserControlUrl, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "./policy.js";
import { activeAppLockPolicy } from "./appLocks.js";
import { extensionDynamicRulesReady } from "./foolproof.js";
import { firewallStatus } from "./firewall.js";
import { grayscaleDecision, grayscaleGuardEnabled, MAC_GRAYSCALE_GUARD_APPS } from "./grayscale.js";
import { hostsStatus, launchAgentStatus, stateSealStatus } from "./hardening.js";
import { detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, recordRuntimeHeartbeat } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { maybeQueueIosMdmPolicyRefresh, pushIosMdmQueuedCommands } from "./iosMdm.js";
import { activeLimitBlocks, activeLimitPolicy } from "./limits.js";
import { appCanReportUrls, getActiveBrowserUrl, getCurrentWifiNetwork, getFrontmostApp, listRunningAppNames, lockScreen, openUrl, redirectActiveBrowserTab, quitApp, setMacGrayscaleEnabled, urlHostname } from "./macos.js";
import { safariFilterStatus } from "./safariFilter.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { ActivePolicy, AppLockRule, LimitBlock, MonitorHandle, VigilState, UnknownRecord, UsageSample, UsageState } from "./types.js";

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

interface AppBlockRecord {
  firstBlockedAt: number;
  lastSeenAt: number;
  attempts: number;
  lastForcedAt: number | null;
}

type EnforcedPolicy = ActivePolicy & {
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string };
  urlPattern?: { pattern: string; label: string };
  appLock?: AppLockRule;
  limitBlock?: LimitBlock;
};

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
    const now = Date.now();
    const monotonicNow = performance.now();
    const previousWall = this.lastPollAt;
    const previousMonotonic = this.lastMonotonicAt;
    const seconds = Math.max(0, (monotonicNow - previousMonotonic) / 1000);
    this.lastPollAt = now;
    this.lastMonotonicAt = monotonicNow;

    if (this.lastSample) {
      recordUsage(this.usage, this.lastSample, seconds);
      recordIntentionalUseTime(this.state, this.lastSample, seconds);
    }

    this.checkRuntimeGap(now);
    this.checkClockTamper(now, previousWall, previousMonotonic, monotonicNow);
    await this.refreshIntegrity(now);
    await this.refreshHardeningDrift(now);
    await this.enforceSystemSleepLock(now);
    await this.syncFocusShortcut(now);
    await this.reconcileGrayscale(now);
    const previousSample = this.lastSample;
    const front = await this.readFrontmost();
    const currentSample: FrontSample | null = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;

    if (front.ok) {
      await this.enforce(front);
    }

    await this.sweepBlockedProcesses(now);
    await this.refreshEnvironment(now);
    this.syncIosMdmPolicy(now);
    await this.pushIosMdmPolicy(now);
    recordRuntimeHeartbeat(this.state, new Date(now));
    await saveUsage(this.usage);
    await saveState(this.state);
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
    const previousSample = this.lastSample;
    const front = await this.readFrontmost();
    const currentSample: FrontSample | null = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;

    if (front.ok) {
      await this.enforce(front);
    }

    await this.enforceSystemSleepLock(now, { force: true });
    await this.syncFocusShortcut(now, { force: true });
    await this.reconcileGrayscale(now, { force: true });
    await this.sweepBlockedProcesses(now, { force: true });
    this.syncIosMdmPolicy(now, "immediate-policy-refresh");
    await this.pushIosMdmPolicy(now, "immediate-policy-refresh", { force: true });
    recordRuntimeHeartbeat(this.state, new Date(now));
    await saveUsage(this.usage);
    await saveState(this.state);

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

    if (front.url && policy.contentFilter && (lockdown || this.state.settings.contentFilterEnabled !== false)) {
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

function targetBlockedByPolicy(state: VigilState, front: UsageSample, policy: EnforcedPolicy | null): boolean {
  if (!policy) return false;
  if (front.url && shouldBlockUrl(policy.profile, front.url)) return true;
  if (front.hostname && shouldBlockSite(policy.profile, front.hostname)) return true;
  return shouldBlockAppForPolicy(state, policy, front.app);
}

function hostPathPatternCanUseSystemNetwork(pattern: string): boolean {
  const text = String(pattern || "").trim();
  return Boolean(text && !text.startsWith("/") && text.includes("/"));
}

export function shouldRedirectActiveBlockedBrowserTab({
  redirectEnabled,
  networkBlocked,
  app,
  url
}: {
  redirectEnabled: boolean;
  networkBlocked: boolean;
  app?: string;
  url?: string;
}): boolean {
  return Boolean(redirectEnabled || (networkBlocked && url && appCanReportUrls(app || "")));
}

export function sweepBlockedApps(state: VigilState, usage: UsageState, apps: string[], now = new Date()): Array<{ app: string; policy: EnforcedPolicy }> {
  const blocked: Array<{ app: string; policy: EnforcedPolicy }> = [];
  for (const app of apps || []) {
    const sample = { app, hostname: "", url: "" };
    const policy = policyForSample(state, usage, sample, now);
    if (!policy || !shouldSweepBlockApp(state, policy, app)) continue;
    blocked.push({ app, policy });
  }
  return blocked;
}

function policyForSample(state: VigilState, usage: UsageState, sample: UsageSample, now = new Date()): EnforcedPolicy | null {
  const sessionPolicy = activePolicy(state, now);
  const sessionBrowserControl = sample.url && matchStrictBrowserControlUrl(state, sessionPolicy, sample.url);
  if (sessionBrowserControl && sessionPolicy) return { ...sessionPolicy, kind: "browser-control", browserControl: sessionBrowserControl };
  const contentFilter = sample.url && sessionPolicy ? matchContentFilterUrl(state, sample.url) : null;
  if (contentFilter && sessionPolicy) return { ...sessionPolicy, kind: "content-filter", contentFilter };
  const appLockPolicy = activeAppLockPolicy(state, sample, now) as EnforcedPolicy | null;
  const limitPolicy = activeLimitPolicy(state, usage, sample, now) as EnforcedPolicy | null;
  const appLockControlPolicy = sample.url ? strictAppLockBrowserControlPolicy(state, now) : null;
  const appLockBrowserControl = sample.url && matchStrictBrowserControlUrl(state, appLockControlPolicy, sample.url);
  if (appLockBrowserControl && appLockControlPolicy) return { ...appLockControlPolicy, kind: "browser-control", browserControl: appLockBrowserControl };
  const limitControlPolicy = sample.url ? strictLimitBrowserControlPolicy(state, now) : null;
  const limitBrowserControl = sample.url && matchStrictBrowserControlUrl(state, limitControlPolicy, sample.url);
  if (limitBrowserControl && limitControlPolicy) return { ...limitControlPolicy, kind: "browser-control", browserControl: limitBrowserControl };
  if (targetBlockedByPolicy(state, sample, sessionPolicy)) return sessionPolicy;
  if (appLockPolicy || limitPolicy) return appLockPolicy || limitPolicy;
  const baseline = baselinePolicy(state, now, { device: "computer" });
  return targetBlockedByPolicy(state, sample, baseline) ? baseline : null;
}

function strictAppLockBrowserControlPolicy(state: VigilState, now: Date): EnforcedPolicy | null {
  for (const lock of state.appLocks || []) {
    const sites = lock.sites || [];
    if (!lock.enabled || (lock.lockLevel || "deep") !== "deep" || !sites.length) continue;
    const days = new Set(lock.days || []);
    if (days.size && !days.has(now.getDay())) continue;
    const policy = activeAppLockPolicy(state, { app: "Browser Extension", hostname: sites[0] || "" }, now) as EnforcedPolicy | null;
    if (policy?.appLock?.id === lock.id) return policy;
  }
  return null;
}

function strictLimitBrowserControlPolicy(state: VigilState, now: Date): EnforcedPolicy | null {
  const block = activeLimitBlocks(state, now).find((item) => (item.lockLevel || "deep") === "deep" && (item.sites || []).length);
  if (!block) return null;
  return {
    kind: "limit",
    limitBlock: block,
    session: {
      id: `limit:${block.id}:browser-controls`,
      title: block.ruleName,
      mode: block.type === "open" ? "open-limit" : "time-limit",
      profileId: `limit:${block.ruleId}:browser-controls`,
      lockLevel: block.lockLevel || "deep",
      startedAt: block.createdAt,
      endsAt: block.until,
      canEndEarly: false,
      source: "limit",
      ruleId: block.ruleId
    },
    profile: {
      id: `limit:${block.ruleId}:browser-controls`,
      name: block.ruleName,
      mode: "blocklist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    },
    endsAt: block.until
  };
}

function shouldSweepBlockApp(state: VigilState, policy: EnforcedPolicy, appName: string): boolean {
  if (!policy?.profile) return false;
  if (!shouldBlockAppForPolicy(state, policy, appName)) return false;
  return !isProcessSweepExemptApp(appName) || isStrictBypassAppForPolicy(state, policy, appName);
}

export function shouldLockScreenForPolicy(state: VigilState, policy: ActivePolicy | null | undefined): boolean {
  if (policy?.session?.mode === "panic" && policy?.session?.lockLevel === "deep") return true;
  return Boolean(
    state.settings?.systemSleepLockEnabled &&
    policy?.session?.mode === "sleep" &&
    policy?.session?.lockLevel === "deep"
  );
}

export function appQuitEscalationDecision(state: VigilState, existing: AppBlockRecord | null = null, now = Date.now()) {
  const escalationMs = Math.max(1, Number(state.settings?.appQuitEscalationSeconds || 10)) * 1000;
  const staleAfterMs = Math.max(30000, escalationMs * 3);
  const fresh = !existing || now - (existing.lastSeenAt || 0) > staleAfterMs;
  const firstBlockedAt = fresh ? now : existing.firstBlockedAt;
  const attempts = fresh ? 1 : (existing.attempts || 0) + 1;
  const force = !fresh && now - firstBlockedAt >= escalationMs;
  return {
    force,
    record: {
      firstBlockedAt,
      lastSeenAt: now,
      attempts,
      lastForcedAt: force ? now : existing?.lastForcedAt || null
    }
  };
}
