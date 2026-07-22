import { activeAppLockPolicy } from "../appLocks.js";
import { matchAdultBlocklistHost } from "../adultBlocklist.js";
import { matchContentFilterUrl } from "../contentFilters.js";
import { FULL_BRICK_BLOCKED_APPS } from "../defaults.js";
import { activeLimitBlocks, activeLimitPolicy } from "../limits.js";
import { appCanReportUrls } from "../macos.js";
import {
  activePolicy,
  appMatchesAppTargets,
  baselinePolicy,
  isProcessSweepExemptApp,
  isStrictBypassAppForPolicy,
  matchStrictBrowserControlUrl,
  shouldBlockAppForPolicy,
  shouldBlockSite,
  shouldBlockUrl
} from "../policy.js";
import type { ActivePolicy, AppLockRule, LimitBlock, VigilState, UnknownRecord, UsageSample, UsageState } from "../types.js";

export interface AppBlockRecord {
  firstBlockedAt: number;
  lastSeenAt: number;
  attempts: number;
  lastForcedAt: number | null;
}

export type EnforcedPolicy = ActivePolicy & {
  adultBlocklist?: { id: string; label: string; hostname: string; domain: string; sourceId: string; sourceLabel: string };
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string };
  urlPattern?: { pattern: string; label: string };
  appLock?: AppLockRule;
  limitBlock?: LimitBlock;
};

export function policyForSample(state: VigilState, usage: UsageState, sample: UsageSample, now = new Date()): EnforcedPolicy | null {
  const sessionPolicy = activePolicy(state, now);
  const baseline = baselinePolicy(state, now, { device: "computer" });
  const sessionBrowserControl = sample.url && matchStrictBrowserControlUrl(state, sessionPolicy, sample.url);
  if (sessionBrowserControl && sessionPolicy) return { ...sessionPolicy, kind: "browser-control", browserControl: sessionBrowserControl };
  const contentPolicy = sessionPolicy || baseline;
  const contentFilter = sample.url && contentPolicy ? matchContentFilterUrl(state, sample.url, contentPolicy) : null;
  if (contentFilter && contentPolicy) return { ...contentPolicy, kind: "content-filter", contentFilter };
  const adultBlocklist = matchAdultBlocklistHost(state, sample.hostname || sample.url);
  if (adultBlocklist && contentPolicy) return { ...contentPolicy, kind: "adult-blocklist", adultBlocklist };
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
  return targetBlockedByPolicy(state, sample, baseline) ? baseline : null;
}

export function hostPathPatternCanUseSystemNetwork(pattern: string): boolean {
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

export function shouldAttemptBlockedBrowserRedirect({
  coolingDown,
  app,
  url
}: {
  coolingDown: boolean;
  app?: string;
  url?: string;
}): boolean {
  return Boolean(!coolingDown || (url && appCanReportUrls(app || "")));
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

export function shouldQuitAppForPolicy(state: VigilState, policy: EnforcedPolicy | null | undefined, appName: string): boolean {
  if (!policy?.profile) return false;
  if (policy.profile.id === "apple-content-filter-recovery") {
    return appMatchesAppTargets(appName, FULL_BRICK_BLOCKED_APPS);
  }
  return shouldBlockAppForPolicy(state, policy, appName);
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

function targetBlockedByPolicy(state: VigilState, front: UsageSample, policy: EnforcedPolicy | null): boolean {
  if (!policy) return false;
  if (front.url && shouldBlockUrl(policy.profile, front.url)) return true;
  if (front.hostname && shouldBlockSite(policy.profile, front.hostname)) return true;
  return shouldBlockAppForPolicy(state, policy, front.app);
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
  const block = activeLimitBlocks(state, now, { device: "computer" }).find((item) => (item.lockLevel || "deep") === "deep" && (item.sites || []).length);
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
  if (!shouldQuitAppForPolicy(state, policy, appName)) return false;
  return !isProcessSweepExemptApp(appName) || isStrictBypassAppForPolicy(state, policy, appName);
}
