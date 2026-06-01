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
  normalizeHost
} from "./policy.js";

export function activeLimitPolicy(state, usage, sample, now = new Date()) {
  cleanupExpiredLimitBlocks(state, now);
  if (!sample?.app) return null;

  const activeBlock = findActiveBlock(state, sample, now);
  if (activeBlock) return policyFromBlock(state, activeBlock);

  for (const rule of (state.limitRules || []).filter((item) => item.enabled)) {
    if (!ruleAppliesToday(rule, now) || !sampleMatchesRule(rule, sample, guardOptions(state))) continue;

    const progress = ruleProgress(usage, rule, now);
    const hit = rule.type === "open"
      ? progress.opens > (rule.unlocksAllowed || 0)
      : progress.seconds >= (rule.limitMinutes || 1) * 60;

    if (!hit) continue;

    const block = createLimitBlock(state, rule, progress, now);
    return policyFromBlock(state, block);
  }

  return null;
}

export function limitSummary(state, usage, now = new Date()) {
  cleanupExpiredLimitBlocks(state, now);
  return {
    rules: (state.limitRules || []).map((rule) => {
      const progress = ruleProgress(usage, rule, now);
      const limit = rule.type === "open" ? rule.unlocksAllowed || 0 : (rule.limitMinutes || 1) * 60;
      const used = rule.type === "open" ? progress.opens : progress.seconds;
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

export function activeLimitBlocks(state, now = new Date()) {
  cleanupExpiredLimitBlocks(state, now);
  return (state.limitBlocks || []).filter((block) => new Date(block.until) > now);
}

export function normalizeLimitRule(body, existing, fallbackId) {
  const type = body.type === "open" ? "open" : "time";
  return {
    id: body.id || existing?.id || fallbackId,
    name: String(body.name || existing?.name || (type === "open" ? "Open limit" : "Time limit")).slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    type,
    lockLevel: body.lockLevel || existing?.lockLevel || "deep",
    days: normalizeDays(body.days ?? existing?.days ?? [0, 1, 2, 3, 4, 5, 6]),
    apps: normalizeTargets(body.apps ?? existing?.apps),
    sites: normalizeTargets(body.sites ?? existing?.sites).map(normalizeHost).filter(Boolean),
    limitMinutes: clampInteger(body.limitMinutes ?? existing?.limitMinutes, 1, 24 * 60, 30),
    unlocksAllowed: clampInteger(body.unlocksAllowed ?? existing?.unlocksAllowed, 0, 200, 5),
    blockMinutes: clampInteger(body.blockMinutes ?? existing?.blockMinutes, 0, 24 * 60, 0)
  };
}

export function targetListsForRule(rule) {
  return {
    apps: expandAppTargets(rule.apps),
    sites: expandSiteTargets(rule.sites)
  };
}

function createLimitBlock(state, rule, progress, now) {
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

function policyFromBlock(state, block) {
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
      allowedApps: [],
      allowedSites: []
    },
    endsAt: block.until
  };
}

function findActiveBlock(state, sample, now) {
  return (state.limitBlocks || []).find((block) => {
    if (new Date(block.until) <= now) return false;
    return sampleMatchesRule(block, sample, guardOptions(state));
  });
}

function ruleProgress(usage, rule, now) {
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

function sampleMatchesRule(rule, sample, options = {}) {
  const lists = targetListsForRule(rule);

  if (shouldGuardSiteBypassApp(rule, sample, lists, options)) return true;
  if (appMatchesAppTargets(sample.app || "", lists.apps)) return true;
  return hostMatchesSiteTargets(sample.hostname || "", lists.sites);
}

function guardOptions(state) {
  return {
    strictUnsupportedBrowserGuard: state.settings?.strictBypassProtectionEnabled !== false
  };
}

function shouldGuardSiteBypassApp(rule, sample, lists, options) {
  const app = sample.app || "";
  return Boolean(
    options.strictUnsupportedBrowserGuard &&
    (rule.lockLevel || "deep") === "deep" &&
    lists.sites.length &&
    (isStrictUnsupportedBrowser(app) || isStrictEmbeddedBrowserApp(app))
  );
}

function sumTargetSeconds(apps, sites, lists) {
  let total = 0;
  for (const [app, seconds] of Object.entries(apps || {})) {
    if (appMatchesAppTargets(app, lists.apps)) total += seconds;
  }
  for (const [site, seconds] of Object.entries(sites || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) total += seconds;
  }
  return Math.round(total);
}

function sumTargetOpens(appOpens, siteOpens, lists) {
  let total = 0;
  for (const [app, count] of Object.entries(appOpens || {})) {
    if (appMatchesAppTargets(app, lists.apps)) total += count;
  }
  for (const [site, count] of Object.entries(siteOpens || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) total += count;
  }
  return total;
}

function ruleAppliesToday(rule, now) {
  const days = new Set(rule.days || []);
  return days.size === 0 || days.has(now.getDay());
}

function cleanupExpiredLimitBlocks(state, now) {
  state.limitBlocks = (state.limitBlocks || []).filter((block) => new Date(block.until) > now);
}

function blockUntil(rule, now) {
  if (!rule.blockMinutes) return endOfToday();
  return new Date(now.getTime() + rule.blockMinutes * 60 * 1000);
}

function normalizeTargets(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  }
  return [...new Set(String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean))];
}

function normalizeDays(value) {
  return [...new Set((value || []).map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
