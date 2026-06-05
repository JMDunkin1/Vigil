import { activeAppLockPolicy } from "../appLocks.js";
import { matchContentFilterUrl } from "../contentFilters.js";
import { activeLimitBlocks, activeLimitPolicy } from "../limits.js";
import { appCanReportUrls } from "../macos.js";
import {
  activePolicy,
  baselinePolicy,
  isProcessSweepExemptApp,
  isStrictBypassAppForPolicy,
  matchStrictBrowserControlUrl,
  shouldBlockAppForPolicy,
  shouldBlockSite,
  shouldBlockUrl
} from "../policy.js";
import type { ActivePolicy, AppLockRule, LimitBlock, SentinelState, UnknownRecord, UsageSample, UsageState } from "../types.js";

export interface AppBlockRecord {
  firstBlockedAt: number;
  lastSeenAt: number;
  attempts: number;
  lastForcedAt: number | null;
}

export type EnforcedPolicy = ActivePolicy & {
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string };
  urlPattern?: { pattern: string; label: string };
  appLock?: AppLockRule;
  limitBlock?: LimitBlock;
};

export function policyForSample(state: SentinelState, usage: UsageState, sample: UsageSample, now = new Date()): EnforcedPolicy | null {
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

export function sweepBlockedApps(state: SentinelState, usage: UsageState, apps: string[], now = new Date()): Array<{ app: string; policy: EnforcedPolicy }> {
  const blocked: Array<{ app: string; policy: EnforcedPolicy }> = [];
  for (const app of apps || []) {
    const sample = { app, hostname: "", url: "" };
    const policy = policyForSample(state, usage, sample, now);
    if (!policy || !shouldSweepBlockApp(state, policy, app)) continue;
    blocked.push({ app, policy });
  }
  return blocked;
}

export function shouldLockScreenForPolicy(state: SentinelState, policy: ActivePolicy | null | undefined): boolean {
  if (policy?.session?.mode === "panic" && policy?.session?.lockLevel === "deep") return true;
  return Boolean(
    state.settings?.systemSleepLockEnabled &&
    policy?.session?.mode === "sleep" &&
    policy?.session?.lockLevel === "deep"
  );
}

export function appQuitEscalationDecision(state: SentinelState, existing: AppBlockRecord | null = null, now = Date.now()) {
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

function targetBlockedByPolicy(state: SentinelState, front: UsageSample, policy: EnforcedPolicy | null): boolean {
  if (!policy) return false;
  if (front.url && shouldBlockUrl(policy.profile, front.url)) return true;
  if (front.hostname && shouldBlockSite(policy.profile, front.hostname)) return true;
  return shouldBlockAppForPolicy(state, policy, front.app);
}

function strictAppLockBrowserControlPolicy(state: SentinelState, now: Date): EnforcedPolicy | null {
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

function strictLimitBrowserControlPolicy(state: SentinelState, now: Date): EnforcedPolicy | null {
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

function shouldSweepBlockApp(state: SentinelState, policy: EnforcedPolicy, appName: string): boolean {
  if (!policy?.profile) return false;
  if (!shouldBlockAppForPolicy(state, policy, appName)) return false;
  return !isProcessSweepExemptApp(appName) || isStrictBypassAppForPolicy(state, policy, appName);
}
