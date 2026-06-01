import { performance } from "node:perf_hooks";
import { addEvent, saveState, saveUsage } from "./store.js";
import { PORT } from "./defaults.js";
import { matchContentFilterUrl } from "./contentFilters.js";
import { reconcileFocusShortcut } from "./focusHooks.js";
import { activePolicy, baselinePolicy, isFullLockoutPolicy, isProcessSweepExemptApp, isStrictBypassAppForPolicy, matchBlockedUrlPattern, matchStrictBrowserControlUrl, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "./policy.js";
import { activeAppLockPolicy } from "./appLocks.js";
import { maybeApplyAndroidPolicy } from "./devices.js";
import { extensionDynamicRulesReady } from "./foolproof.js";
import { hostsStatus, launchAgentStatus, stateSealStatus } from "./hardening.js";
import { detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, recordRuntimeHeartbeat } from "./integrityLockdown.js";
import { maybeQueueIosMdmPolicyRefresh } from "./iosMdm.js";
import { activeLimitBlocks, activeLimitPolicy } from "./limits.js";
import { appCanReportUrls, getActiveBrowserUrl, getCurrentWifiNetwork, getFrontmostApp, listRunningAppNames, lockScreen, notify, redirectActiveBrowserTab, quitApp, urlHostname } from "./macos.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { recordOpen, recordUsage } from "./usage.js";

export function startMonitor(context) {
  const monitor = new Monitor(context);
  monitor.start();
  return monitor;
}

class Monitor {
  constructor({ state, usage }) {
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
      lastProcessSweep: null,
      lastImmediateEnforcement: null,
      lastSystemSleepLock: null,
      lastFocusShortcut: null,
      accessibilityLikelyMissing: false
    };
    this.recentBlocks = new Map();
    this.appBlockHistory = new Map();
    this.immediateEnforcement = null;
    this.nextEnvironmentRefreshAt = 0;
    this.nextIntegrityRefreshAt = 0;
    this.nextHardeningDriftRefreshAt = 0;
    this.nextProcessSweepAt = 0;
    this.nextSystemSleepLockAt = 0;
    this.runtimeGapChecked = false;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.state.settings.pollIntervalMs || 3000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    const now = Date.now();
    const monotonicNow = performance.now();
    const previousWall = this.lastPollAt;
    const previousMonotonic = this.lastMonotonicAt;
    const seconds = Math.max(0, (monotonicNow - previousMonotonic) / 1000);
    this.lastPollAt = now;
    this.lastMonotonicAt = monotonicNow;

    if (this.lastSample) {
      recordUsage(this.usage, this.lastSample, seconds);
    }

    this.checkRuntimeGap(now);
    this.checkClockTamper(now, previousWall, previousMonotonic, monotonicNow);
    await this.refreshIntegrity(now);
    await this.refreshHardeningDrift(now);
    await this.enforceSystemSleepLock(now);
    await this.syncFocusShortcut(now);
    const previousSample = this.lastSample;
    const front = await this.readFrontmost();
    const currentSample = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;

    if (front.ok) {
      await this.enforce(front);
    }

    await this.sweepBlockedProcesses(now);
    await this.refreshEnvironment(now);
    await maybeApplyAndroidPolicy(this.state);
    this.syncIosMdmPolicy(now);
    recordRuntimeHeartbeat(this.state, new Date(now));
    await saveUsage(this.usage);
    await saveState(this.state);
  }

  enforceImmediately(reason = "manual") {
    if (this.immediateEnforcement) return this.immediateEnforcement;
    this.immediateEnforcement = this.runImmediateEnforcement(reason)
      .finally(() => {
        this.immediateEnforcement = null;
      });
    return this.immediateEnforcement;
  }

  async runImmediateEnforcement(reason) {
    const now = Date.now();
    const previousSample = this.lastSample;
    const front = await this.readFrontmost();
    const currentSample = front.ok ? { app: front.app, hostname: front.hostname || "", url: front.url || "" } : null;
    if (currentSample) recordOpen(this.usage, currentSample, previousSample);
    this.lastSample = currentSample;
    this.status.lastSample = currentSample;

    if (front.ok) {
      await this.enforce(front);
    }

    await this.enforceSystemSleepLock(now, { force: true });
    await this.syncFocusShortcut(now, { force: true });
    await this.sweepBlockedProcesses(now, { force: true });
    await maybeApplyAndroidPolicy(this.state);
    this.syncIosMdmPolicy(now, "immediate-policy-refresh");
    recordRuntimeHeartbeat(this.state, new Date(now));
    await saveUsage(this.usage);
    await saveState(this.state);

    const summary = {
      reason,
      ok: front.ok,
      app: front.app || "",
      hostname: front.hostname || "",
      at: new Date(now).toISOString(),
      lastEnforcement: this.status.lastEnforcement,
      lastProcessSweep: this.status.lastProcessSweep
    };
    this.status.lastImmediateEnforcement = summary;
    return summary;
  }

  async enforceSystemSleepLock(now, options = {}) {
    const policy = activePolicy(this.state, new Date(now));
    if (!shouldLockScreenForPolicy(this.state, policy)) {
      this.nextSystemSleepLockAt = 0;
      return null;
    }

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

  async syncFocusShortcut(now) {
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

  syncIosMdmPolicy(now, reason = "monitor-policy-refresh") {
    const result = maybeQueueIosMdmPolicyRefresh(this.state, reason, new Date(now));
    if (result.queued) {
      addEvent(this.state, "ios_mdm_policy_queued", { reason, ...result });
    }
    return result;
  }

  async readFrontmost() {
    const front = await getFrontmostApp();
    if (!front.ok) {
      this.status.ok = false;
      this.status.lastError = front.error;
      this.status.accessibilityLikelyMissing = /not allowed|assistive|access/i.test(front.error || "");
      return front;
    }

    let url = "";
    let hostname = "";
    let urlError = "";
    if (appCanReportUrls(front.app)) {
      const browser = await getActiveBrowserUrl(front.app);
      url = browser.url || "";
      hostname = urlHostname(url);
      urlError = browser.ok ? "" : browser.error;
    }

    this.status.ok = true;
    this.status.lastError = urlError;
    this.status.accessibilityLikelyMissing = false;
    return { ok: true, app: front.app, url, hostname };
  }

  async enforce(front) {
    const policy = this.policyForTarget(front);
    if (!policy) {
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

    if (front.hostname && (lockdown || this.state.settings.siteRedirectEnabled) && shouldBlockSite(policy.profile, front.hostname)) {
      await this.blockSite(front, policy);
      return;
    }

    const urlPattern = front.url ? matchBlockedUrlPattern(policy.profile, front.url) : null;
    if (urlPattern && (lockdown || this.state.settings.siteRedirectEnabled)) {
      await this.blockSite({
        ...front,
        hostname: urlPattern.label
      }, policy, { urlPattern, originalHostname: front.hostname });
      return;
    }

    if ((lockdown || this.state.settings.appQuitEnabled) && shouldBlockAppForPolicy(this.state, policy, front.app)) {
      await this.blockApp(front, policy);
    }
  }

  policyForTarget(sample) {
    return policyForSample(this.state, this.usage, sample);
  }

  async blockSite(front, policy, options = {}) {
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
    await notify(options.browserControl ? "Blocked browser controls" : options.contentFilter ? "Blocked feed" : options.urlPattern ? "Blocked URL" : "Blocked site", `${front.hostname} is blocked until the session ends.`);
  }

  async blockApp(front, policy, options = {}) {
    const key = `app:${front.app}`;
    if (this.isCoolingDown(key)) return;
    this.markCoolingDown(key);

    const decision = appQuitEscalationDecision(this.state, this.appBlockHistory.get(front.app));
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
    if (options.notifyUser !== false) {
      await notify(decision.force ? "Force killed blocked app" : "Blocked app", `${front.app} is blocked until the session ends.`);
    }
  }

  async sweepBlockedProcesses(now, options = {}) {
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
      await this.blockApp({ app, hostname: "", url: "" }, policy, { source: "process-sweep", notifyUser: false });
    }

    this.status.lastProcessSweep = { ok: true, checked: running.apps.length, blocked: blocked.map((item) => item.app), at: new Date().toISOString() };
  }

  async refreshIntegrity(now) {
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

  async refreshHardeningDrift(now) {
    if (!this.state.settings?.foolproofModeEnabled) return;
    if (now < this.nextHardeningDriftRefreshAt) return;
    this.nextHardeningDriftRefreshAt = now + 15 * 1000;

    const hosts = await hostsStatus(this.state);
    const agent = await launchAgentStatus();
    const extensionRules = extensionDynamicRulesReady(this.state, new Date(now));
    const sourceSeal = await sourceSealStatus();
    const monitor = {
      ok: this.status.ok,
      accessibilityLikelyMissing: this.status.accessibilityLikelyMissing
    };
    const drift = detectHardeningDrift(this.state, { hosts, agent, monitor, extensionRules, sourceSeal }, new Date(now));
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
      extensionRules: {
        ok: extensionRules.ok,
        status: extensionRules.status,
        count: extensionRules.count || 0
      },
      drift
    };
    if (drift) addEvent(this.state, "hardening_drift_lockdown", drift);
  }

  checkRuntimeGap(now) {
    if (this.runtimeGapChecked) return;
    this.runtimeGapChecked = true;
    const gap = detectRuntimeGap(this.state, new Date(now));
    if (!gap) return;
    this.status.runtimeGap = gap;
    addEvent(this.state, "runtime_downtime_lockdown", gap);
  }

  checkClockTamper(now, previousWall, previousMonotonic, currentMonotonic) {
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

  async refreshEnvironment(now) {
    if (now < this.nextEnvironmentRefreshAt) return;
    this.nextEnvironmentRefreshAt = now + 30 * 1000;
    this.state.environment ||= {};
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

  isCoolingDown(key) {
    return (this.recentBlocks.get(key) || 0) > Date.now();
  }

  markCoolingDown(key) {
    this.recentBlocks.set(key, Date.now() + 12000);
  }

  pruneAppBlockHistory(now = Date.now()) {
    for (const [app, record] of this.appBlockHistory) {
      if (now - (record.lastSeenAt || 0) > 10 * 60 * 1000) this.appBlockHistory.delete(app);
    }
  }
}

function targetBlockedByPolicy(state, front, policy) {
  if (!policy) return false;
  if (front.url && shouldBlockUrl(policy.profile, front.url)) return true;
  if (front.hostname && shouldBlockSite(policy.profile, front.hostname)) return true;
  return shouldBlockAppForPolicy(state, policy, front.app);
}

export function sweepBlockedApps(state, usage, apps, now = new Date()) {
  const blocked = [];
  for (const app of apps || []) {
    const sample = { app, hostname: "", url: "" };
    const policy = policyForSample(state, usage, sample, now);
    if (!policy || !shouldSweepBlockApp(state, policy, app)) continue;
    blocked.push({ app, policy });
  }
  return blocked;
}

function policyForSample(state, usage, sample, now = new Date()) {
  const sessionPolicy = activePolicy(state, now);
  const sessionBrowserControl = sample.url && matchStrictBrowserControlUrl(state, sessionPolicy, sample.url);
  if (sessionBrowserControl) return { ...sessionPolicy, kind: "browser-control", browserControl: sessionBrowserControl };
  const contentFilter = sample.url && sessionPolicy ? matchContentFilterUrl(state, sample.url) : null;
  if (contentFilter) return { ...sessionPolicy, kind: "content-filter", contentFilter };
  const appLockPolicy = activeAppLockPolicy(state, sample, now);
  const limitPolicy = activeLimitPolicy(state, usage, sample, now);
  const appLockControlPolicy = sample.url ? strictAppLockBrowserControlPolicy(state, now) : null;
  const appLockBrowserControl = sample.url && matchStrictBrowserControlUrl(state, appLockControlPolicy, sample.url);
  if (appLockBrowserControl) return { ...appLockControlPolicy, kind: "browser-control", browserControl: appLockBrowserControl };
  const limitControlPolicy = sample.url ? strictLimitBrowserControlPolicy(state, now) : null;
  const limitBrowserControl = sample.url && matchStrictBrowserControlUrl(state, limitControlPolicy, sample.url);
  if (limitBrowserControl) return { ...limitControlPolicy, kind: "browser-control", browserControl: limitBrowserControl };
  if (targetBlockedByPolicy(state, sample, sessionPolicy)) return sessionPolicy;
  if (appLockPolicy || limitPolicy) return appLockPolicy || limitPolicy;
  const baseline = baselinePolicy(state, now, { device: "computer" });
  return targetBlockedByPolicy(state, sample, baseline) ? baseline : null;
}

function strictAppLockBrowserControlPolicy(state, now) {
  for (const lock of state.appLocks || []) {
    if (!lock.enabled || (lock.lockLevel || "deep") !== "deep" || !(lock.sites || []).length) continue;
    const days = new Set(lock.days || []);
    if (days.size && !days.has(now.getDay())) continue;
    const policy = activeAppLockPolicy(state, { app: "Browser Extension", hostname: lock.sites[0] }, now);
    if (policy?.appLock?.id === lock.id) return policy;
  }
  return null;
}

function strictLimitBrowserControlPolicy(state, now) {
  const block = activeLimitBlocks(state, now).find((item) => (item.lockLevel || "deep") === "deep" && (item.sites || []).length);
  if (!block) return null;
  return {
    kind: "limit",
    limitBlock: block,
    session: {
      id: `limit:${block.id}:browser-controls`,
      title: block.ruleName,
      mode: block.type === "open" ? "open-limit" : "time-limit",
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
      allowedApps: [],
      allowedSites: []
    },
    endsAt: block.until
  };
}

function shouldSweepBlockApp(state, policy, appName) {
  if (!policy?.profile) return false;
  if (!shouldBlockAppForPolicy(state, policy, appName)) return false;
  return !isProcessSweepExemptApp(appName) || isStrictBypassAppForPolicy(state, policy, appName);
}

export function shouldLockScreenForPolicy(state, policy) {
  if (policy?.session?.mode === "panic" && policy?.session?.lockLevel === "deep") return true;
  return Boolean(
    state.settings?.systemSleepLockEnabled &&
    policy?.session?.mode === "sleep" &&
    policy?.session?.lockLevel === "deep"
  );
}

export function appQuitEscalationDecision(state, existing = null, now = Date.now()) {
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
