import { endOfToday, dateKey } from "./time.js";
import { normalizeUsageDay } from "./usage.js";
import { parseBoolean } from "./booleans.js";
import {
  appMatchesAppTargets,
  expandAppTargets,
  expandSiteTargets,
  hostMatchesSiteTargets,
  isStrictEmbeddedBrowserApp,
  isStrictUnsupportedBrowser,
  normalizeLockLevel,
  normalizeHost
} from "./policy.js";
import type { ActivePolicy, LimitBlock, LimitProgress, LimitRule, VigilState, UsageSample, UsageState } from "./types.js";

type TargetLists = { apps: string[]; sites: string[] };
type GuardOptions = { strictUnsupportedBrowserGuard?: boolean };

export function activeLimitPolicy(state: VigilState, usage: UsageState, sample: UsageSample, now = new Date()): ActivePolicy | null {
  cleanupExpiredLimitBlocks(state, now);
  if (!sample?.app) return null;

  const activeBlock = findActiveBlock(state, sample, now);
  if (activeBlock) return policyFromBlock(state, activeBlock);

  for (const rule of (state.limitRules || []).filter((item) => item.enabled)) {
    if (!ruleAppliesToday(rule, now) || !sampleMatchesRule(rule, sample, guardOptions(state))) continue;

    const progress = ruleProgress(usage, rule, now);
    const hit = rule.type === "open"
      ? (progress.opens ?? 0) > (rule.unlocksAllowed || 0)
      : (progress.seconds ?? 0) >= (rule.limitMinutes || 1) * 60;

    if (!hit) continue;

    const block = createLimitBlock(state, rule, progress, now);
    return policyFromBlock(state, block);
  }

  return null;
}

export function limitSummary(state: VigilState, usage: UsageState, now = new Date()) {
  cleanupExpiredLimitBlocks(state, now);
  return {
    rules: (state.limitRules || []).map((rule) => {
      const progress = ruleProgress(usage, rule, now);
      const limit = rule.type === "open" ? rule.unlocksAllowed || 0 : (rule.limitMinutes || 1) * 60;
      const used = rule.type === "open" ? (progress.opens ?? 0) : (progress.seconds ?? 0);
      return {
        ...rule,
        progress,
        percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        activeBlock: (state.limitBlocks || []).find((block) => block.ruleId === rule.id && new Date(block.until) > now) || null
      };
    }),
    activeBlocks: (state.limitBlocks || []).filter((block) => new Date(block.until) > now)
  };
}

export function activeLimitBlocks(state: VigilState, now = new Date()): LimitBlock[] {
  cleanupExpiredLimitBlocks(state, now);
  return (state.limitBlocks || []).filter((block) => new Date(block.until) > now);
}

export function normalizeLimitRule(body: Record<string, unknown>, existing: Partial<LimitRule> | undefined, fallbackId: string): LimitRule {
  const type = body.type === "open" ? "open" : "time";
  return {
    id: String(body.id || existing?.id || fallbackId),
    name: String(body.name || existing?.name || (type === "open" ? "Open limit" : "Time limit")).slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    type,
    lockLevel: normalizeLockLevel(body.lockLevel, existing?.lockLevel || "deep"),
    days: normalizeDays(body.days ?? existing?.days ?? [0, 1, 2, 3, 4, 5, 6]),
    apps: normalizeTargets(body.apps ?? existing?.apps),
    sites: normalizeTargets(body.sites ?? existing?.sites).map(normalizeHost).filter(Boolean),
    limitMinutes: clampInteger(body.limitMinutes ?? existing?.limitMinutes, 1, 24 * 60, 30),
    unlocksAllowed: clampInteger(body.unlocksAllowed ?? existing?.unlocksAllowed, 0, 200, 5),
    blockMinutes: clampInteger(body.blockMinutes ?? existing?.blockMinutes, 0, 24 * 60, 0)
  };
}

export function targetListsForRule(rule: Pick<LimitRule, "apps" | "sites"> | Pick<LimitBlock, "apps" | "sites">): TargetLists {
  return {
    apps: expandAppTargets(rule.apps),
    sites: expandSiteTargets(rule.sites)
  };
}

function createLimitBlock(state: VigilState, rule: LimitRule, progress: LimitProgress, now: Date): LimitBlock {
  const existing = (state.limitBlocks || []).find((block) => block.ruleId === rule.id && new Date(block.until) > now);
  if (existing) return existing;

  const block = {
    id: crypto.randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    type: rule.type,
    lockLevel: rule.lockLevel || "deep",
    apps: expandAppTargets(rule.apps),
    sites: expandSiteTargets(rule.sites),
    createdAt: now.toISOString(),
    until: blockUntil(rule, now).toISOString(),
    progress
  };
  state.limitBlocks ||= [];
  state.limitBlocks.push(block);
  return block;
}

function policyFromBlock(state: VigilState, block: LimitBlock): ActivePolicy {
  return {
    kind: "limit",
    limitBlock: block,
    session: {
      id: `limit:${block.id}`,
      title: block.ruleName,
      mode: block.type === "open" ? "open-limit" : "time-limit",
      profileId: state.settings.activeProfileId,
      lockLevel: block.lockLevel,
      startedAt: block.createdAt,
      endsAt: block.until,
      canEndEarly: false,
      source: "limit",
      ruleId: block.ruleId
    },
    profile: {
      id: `limit:${block.ruleId}`,
      name: block.ruleName,
      mode: "blocklist",
      blockedApps: block.apps,
      blockedSites: block.sites,
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    },
    endsAt: block.until
  };
}

function findActiveBlock(state: VigilState, sample: UsageSample, now: Date): LimitBlock | undefined {
  return (state.limitBlocks || []).find((block) => {
    if (new Date(block.until) <= now) return false;
    return sampleMatchesRule(block, sample, guardOptions(state));
  });
}

function ruleProgress(usage: UsageState, rule: LimitRule, now: Date): LimitProgress {
  const day = normalizeUsageDay(usage[dateKey(now)] || {});
  const lists = targetListsForRule(rule);
  const apps = day.apps || {};
  const sites = day.sites || {};
  const appOpens = day.opens?.apps || {};
  const siteOpens = day.opens?.sites || {};

  return {
    seconds: sumTargetSeconds(apps, sites, lists),
    opens: sumTargetOpens(appOpens, siteOpens, lists)
  };
}

function sampleMatchesRule(rule: LimitRule | LimitBlock, sample: UsageSample, options: GuardOptions = {}): boolean {
  const lists = targetListsForRule(rule);

  if (shouldGuardSiteBypassApp(rule, sample, lists, options)) return true;
  if (appMatchesAppTargets(sample.app || "", lists.apps)) return true;
  return hostMatchesSiteTargets(sample.hostname || "", lists.sites);
}

function guardOptions(state: VigilState): GuardOptions {
  return {
    strictUnsupportedBrowserGuard: state.settings?.strictBypassProtectionEnabled !== false
  };
}

function shouldGuardSiteBypassApp(rule: LimitRule | LimitBlock, sample: UsageSample, lists: TargetLists, options: GuardOptions): boolean {
  const app = sample.app || "";
  return Boolean(
    options.strictUnsupportedBrowserGuard &&
    (rule.lockLevel || "deep") === "deep" &&
    lists.sites.length &&
    (isStrictUnsupportedBrowser(app) || isStrictEmbeddedBrowserApp(app))
  );
}

function sumTargetSeconds(apps: Record<string, number>, sites: Record<string, number>, lists: TargetLists): number {
  let total = 0;
  for (const [app, seconds] of Object.entries(apps || {})) {
    if (appMatchesAppTargets(app, lists.apps)) total += Number(seconds || 0);
  }
  for (const [site, seconds] of Object.entries(sites || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) total += Number(seconds || 0);
  }
  return Math.round(total);
}

function sumTargetOpens(appOpens: Record<string, number>, siteOpens: Record<string, number>, lists: TargetLists): number {
  let total = 0;
  for (const [app, count] of Object.entries(appOpens || {})) {
    if (appMatchesAppTargets(app, lists.apps)) total += Number(count || 0);
  }
  for (const [site, count] of Object.entries(siteOpens || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) total += Number(count || 0);
  }
  return total;
}

function ruleAppliesToday(rule: LimitRule, now: Date): boolean {
  const days = new Set(rule.days || []);
  return days.size === 0 || days.has(now.getDay());
}

function cleanupExpiredLimitBlocks(state: VigilState, now: Date): void {
  state.limitBlocks = (state.limitBlocks || []).filter((block) => new Date(block.until) > now);
}

function blockUntil(rule: LimitRule, now: Date): Date {
  if (!rule.blockMinutes) return endOfToday();
  return new Date(now.getTime() + rule.blockMinutes * 60 * 1000);
}

function normalizeTargets(value: unknown): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  }
  return [...new Set(String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeDays(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number.parseInt(String(value), 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
