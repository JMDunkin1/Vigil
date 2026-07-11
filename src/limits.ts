import { endOfToday, dateKey } from "./time.js";
import { normalizeUsageDay, usageContextSample } from "./usage.js";
import { parseBoolean } from "./booleans.js";
import { clampInteger, normalizeTextList as normalizeTargets, normalizeWeekdays as normalizeDays } from "./normalizers.js";
import {
  activePolicy,
  appMatchesAppTargets,
  expandAppTargets,
  expandSiteTargets,
  hostMatchesSiteTargets,
  isStrictEmbeddedBrowserApp,
  isStrictUnsupportedBrowser,
  normalizeDeviceTarget,
  normalizeLockLevel,
  normalizeHost
} from "./policy.js";
import type { ActivePolicy, DeviceTarget, DeviceTargetInput, LimitBlock, LimitProgress, LimitRule, SentinelState, UsageSample, UsageState } from "./types.js";

type TargetLists = { apps: string[]; sites: string[] };
type GuardOptions = { strictUnsupportedBrowserGuard?: boolean };

export function activeLimitPolicy(state: SentinelState, usage: UsageState, sample: UsageSample, now = new Date()): ActivePolicy | null {
  cleanupExpiredLimitBlocks(state, now);
  if (!sample?.app) return null;

  const activeBlock = findActiveBlock(state, sample, now);
  if (activeBlock) return policyFromBlock(state, activeBlock);

  for (const rule of (state.limitRules || []).filter((item) => item.enabled)) {
    if (!ruleAppliesToday(rule, now) || !sampleMatchesRule(rule, sample, guardOptions(state))) continue;
    if (!limitRuleContextMatches(state, rule, sample, now)) continue;
    if (limitRuleOverridden(state, rule.id, now)) continue;

    const activeRuleBlock = (state.limitBlocks || []).find((block) => (
      block.ruleId === rule.id && new Date(block.until) > now
    ));
    if (activeRuleBlock) {
      const device = normalizeDeviceTarget(sample.device || "computer");
      const targets: DeviceTarget[] = activeRuleBlock.deviceTargets?.length ? activeRuleBlock.deviceTargets : ["computer"];
      if (!targets.includes(device)) activeRuleBlock.deviceTargets = [...targets, device];
      return policyFromBlock(state, activeRuleBlock);
    }

    const rawProgress = rawRuleProgress(usage, rule, now);
    const progress = adjustedRuleProgress(rawProgress, rule, now);
    const hit = rule.type === "open"
      ? (progress.opens ?? 0) > (rule.unlocksAllowed || 0)
      : (progress.seconds ?? 0) >= (rule.limitMinutes || 1) * 60;

    if (!hit) continue;

    const block = createLimitBlock(state, rule, progress, rawProgress, sample, now);
    return policyFromBlock(state, block);
  }

  return null;
}

export function limitSummary(state: SentinelState, usage: UsageState, now = new Date()) {
  cleanupExpiredLimitBlocks(state, now);
  const activeBlocks = activeLimitBlocks(state, now);
  return {
    rules: (state.limitRules || []).map((rule) => {
      const progress = ruleProgress(usage, rule, now);
      const limit = rule.type === "open" ? rule.unlocksAllowed || 0 : (rule.limitMinutes || 1) * 60;
      const used = rule.type === "open" ? (progress.opens ?? 0) : (progress.seconds ?? 0);
      return {
        ...rule,
        progress,
        percent: limit ? Math.min(100, Math.round((used / limit) * 100)) : 0,
        activeBlock: activeBlocks.find((block) => block.ruleId === rule.id) || null
      };
    }),
    activeBlocks
  };
}

export function activeLimitBlocks(state: SentinelState, now = new Date(), options: { device?: DeviceTargetInput } = {}): LimitBlock[] {
  cleanupExpiredLimitBlocks(state, now);
  return (state.limitBlocks || []).filter((block) => {
    return new Date(block.until) > now
      && !limitRuleOverridden(state, block.ruleId, now)
      && limitBlockContextMatches(state, block, now, options.device);
  });
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
    blockMinutes: clampInteger(body.blockMinutes ?? existing?.blockMinutes, 0, 24 * 60, 0),
    requiredProfileId: optionalString(body.requiredProfileId ?? existing?.requiredProfileId),
    excludedProfileIds: optionalStringList(body.excludedProfileIds ?? existing?.excludedProfileIds),
    cycleAnchorDateKey: typeof existing?.cycleAnchorDateKey === "string" ? existing.cycleAnchorDateKey : undefined,
    cycleAnchorSeconds: clampOptionalInteger(existing?.cycleAnchorSeconds, 0),
    cycleAnchorOpens: clampOptionalInteger(existing?.cycleAnchorOpens, 0)
  };
}

export function overrideLimitRules(
  state: SentinelState,
  ruleIds: readonly unknown[],
  until: unknown,
  reason = "",
  now = new Date()
): string[] {
  const ids = [...new Set(ruleIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (!ids.length) return [];
  const overrideUntil = limitOverrideUntil(until, now);
  state.overrides ||= [];
  for (const ruleId of ids) {
    state.overrides.push({
      id: crypto.randomUUID(),
      limitRuleId: ruleId,
      until: overrideUntil.toISOString(),
      reason,
      createdAt: now.toISOString()
    });
  }
  return ids;
}

export function targetListsForRule(rule: Pick<LimitRule, "apps" | "sites"> | Pick<LimitBlock, "apps" | "sites">): TargetLists {
  return {
    apps: expandAppTargets(rule.apps),
    sites: expandSiteTargets(rule.sites)
  };
}

function createLimitBlock(state: SentinelState, rule: LimitRule, progress: LimitProgress, rawProgress: LimitProgress, sample: UsageSample, now: Date): LimitBlock {
  const device = normalizeDeviceTarget(sample.device || "computer");
  const existing = (state.limitBlocks || []).find((block) => (
    block.ruleId === rule.id
    && new Date(block.until) > now
    && limitBlockTargetsDevice(block, device)
  ));
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
    progress,
    requiredProfileId: rule.requiredProfileId,
    excludedProfileIds: rule.excludedProfileIds ? [...rule.excludedProfileIds] : undefined,
    deviceTargets: [device]
  };
  updateLimitRuleCycleAnchor(rule, rawProgress, now);
  state.limitBlocks ||= [];
  state.limitBlocks.push(block);
  return block;
}

function policyFromBlock(state: SentinelState, block: LimitBlock): ActivePolicy {
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
      ruleId: block.ruleId,
      deviceTargets: block.deviceTargets || ["computer"]
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

function findActiveBlock(state: SentinelState, sample: UsageSample, now: Date): LimitBlock | undefined {
  return (state.limitBlocks || []).find((block) => {
    if (new Date(block.until) <= now) return false;
    if (limitRuleOverridden(state, block.ruleId, now)) return false;
    if (!limitBlockContextMatches(state, block, now, sample.device || "computer")) return false;
    return sampleMatchesRule(block, sample, guardOptions(state));
  });
}

function ruleProgress(usage: UsageState, rule: LimitRule, now: Date): LimitProgress {
  return adjustedRuleProgress(rawRuleProgress(usage, rule, now), rule, now);
}

function rawRuleProgress(usage: UsageState, rule: LimitRule, now: Date): LimitProgress {
  const day = normalizeUsageDay(usage[dateKey(now)] || {});
  const lists = targetListsForRule(rule);
  const deviceBuckets = Object.values(day.devices || {});
  if (!deviceBuckets.length) return bucketRuleProgress(day, lists);
  return deviceBuckets.reduce<LimitProgress>((total, bucket) => {
    const progress = bucketRuleProgress(bucket, lists);
    return {
      seconds: Number(total.seconds || 0) + Number(progress.seconds || 0),
      opens: Number(total.opens || 0) + Number(progress.opens || 0)
    };
  }, { seconds: 0, opens: 0 });
}

function bucketRuleProgress(
  bucket: Pick<UsageState[string], "apps" | "sites" | "contexts" | "openContexts" | "contextVersion" | "openContextVersion" | "legacyTargetAggregation" | "opens">,
  lists: TargetLists
): LimitProgress {
  return {
    seconds: bucket.contextVersion === 1
      ? sumTargetContexts(bucket.contexts, lists)
      : sumTargetSeconds(bucket.apps || {}, bucket.sites || {}, lists, bucket.legacyTargetAggregation),
    opens: bucket.openContextVersion === 1
      ? sumTargetContexts(bucket.openContexts, lists)
      : sumTargetOpens(bucket.opens?.apps || {}, bucket.opens?.sites || {}, lists, bucket.legacyTargetAggregation)
  };
}

function adjustedRuleProgress(progress: LimitProgress, rule: LimitRule, now: Date): LimitProgress {
  if (!rule.blockMinutes || rule.cycleAnchorDateKey !== dateKey(now)) return progress;
  return {
    seconds: Math.max(0, Number(progress.seconds || 0) - Number(rule.cycleAnchorSeconds || 0)),
    opens: Math.max(0, Number(progress.opens || 0) - Number(rule.cycleAnchorOpens || 0))
  };
}

function sampleMatchesRule(rule: LimitRule | LimitBlock, sample: UsageSample, options: GuardOptions = {}): boolean {
  const lists = targetListsForRule(rule);

  if (shouldGuardSiteBypassApp(rule, sample, lists, options)) return true;
  if (appMatchesAppTargets(sample.app || "", lists.apps)) return true;
  return hostMatchesSiteTargets(sample.hostname || "", lists.sites);
}

function limitRuleContextMatches(state: SentinelState, rule: LimitRule, sample: UsageSample, now: Date): boolean {
  return limitContextMatches(state, rule, now, sample.device || "computer");
}

export function limitBlockContextMatches(
  state: SentinelState,
  block: Pick<LimitBlock, "requiredProfileId" | "excludedProfileIds" | "deviceTargets">,
  now = new Date(),
  device?: DeviceTargetInput
): boolean {
  if (device && !limitBlockTargetsDevice(block, normalizeDeviceTarget(device))) return false;
  return limitContextMatches(state, block, now, device);
}

function limitBlockTargetsDevice(block: Pick<LimitBlock, "deviceTargets">, device: DeviceTarget): boolean {
  const targets = block.deviceTargets?.length ? block.deviceTargets : ["computer"];
  return targets.includes(device);
}

function limitContextMatches(
  state: SentinelState,
  context: Pick<LimitRule | LimitBlock, "requiredProfileId" | "excludedProfileIds">,
  now: Date,
  device?: DeviceTargetInput
): boolean {
  const targets: DeviceTarget[] = device
    ? [normalizeDeviceTarget(device)]
    : ["computer", "phone"];
  return targets.some((target) => {
    if (context.requiredProfileId && !activeContextMatchesProfile(state, context.requiredProfileId, now, target)) return false;
    if ((context.excludedProfileIds || []).some((profileId) => activeContextMatchesProfile(state, profileId, now, target))) return false;
    return true;
  });
}

function activeContextMatchesProfile(state: SentinelState, profileId: string, now: Date, device: DeviceTarget): boolean {
  const policy = activePolicy(state, now, { device });
  return policy?.session?.profileId === profileId || policy?.profile?.id === profileId;
}

function guardOptions(state: SentinelState): GuardOptions {
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

function sumTargetSeconds(
  apps: Record<string, number>,
  sites: Record<string, number>,
  lists: TargetLists,
  aggregation: "max" | "sum" = "max"
): number {
  let appTotal = 0;
  for (const [app, seconds] of Object.entries(apps || {})) {
    if (appMatchesAppTargets(app, lists.apps)) appTotal += Number(seconds || 0);
  }
  let siteTotal = 0;
  for (const [site, seconds] of Object.entries(sites || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) siteTotal += Number(seconds || 0);
  }
  return Math.round(aggregation === "sum" ? appTotal + siteTotal : Math.max(appTotal, siteTotal));
}

function sumTargetOpens(
  appOpens: Record<string, number>,
  siteOpens: Record<string, number>,
  lists: TargetLists,
  aggregation: "max" | "sum" = "max"
): number {
  let appTotal = 0;
  for (const [app, count] of Object.entries(appOpens || {})) {
    if (appMatchesAppTargets(app, lists.apps)) appTotal += Number(count || 0);
  }
  let siteTotal = 0;
  for (const [site, count] of Object.entries(siteOpens || {})) {
    if (hostMatchesSiteTargets(site, lists.sites)) siteTotal += Number(count || 0);
  }
  return aggregation === "sum" ? appTotal + siteTotal : Math.max(appTotal, siteTotal);
}

function sumTargetContexts(contexts: Record<string, number> | undefined, lists: TargetLists): number {
  let total = 0;
  for (const [context, amount] of Object.entries(contexts || {})) {
    const sample = usageContextSample(context);
    if (!sample) continue;
    if (appMatchesAppTargets(sample.app || "", lists.apps) || hostMatchesSiteTargets(sample.hostname || "", lists.sites)) {
      total += Number(amount || 0);
    }
  }
  return Math.round(total);
}

function ruleAppliesToday(rule: LimitRule, now: Date): boolean {
  const days = new Set(rule.days || []);
  return days.size === 0 || days.has(now.getDay());
}

function cleanupExpiredLimitBlocks(state: SentinelState, now: Date): void {
  state.limitBlocks = (state.limitBlocks || []).filter((block) => new Date(block.until) > now);
  state.overrides = (state.overrides || []).filter((override) => new Date(override.until) > now);
}

function blockUntil(rule: LimitRule, now: Date): Date {
  if (!rule.blockMinutes) return endOfToday();
  return new Date(now.getTime() + rule.blockMinutes * 60 * 1000);
}

function updateLimitRuleCycleAnchor(rule: LimitRule, rawProgress: LimitProgress, now: Date): void {
  if (!rule.blockMinutes) return;
  rule.cycleAnchorDateKey = dateKey(now);
  rule.cycleAnchorSeconds = Math.max(0, Math.round(Number(rawProgress.seconds || 0)));
  rule.cycleAnchorOpens = Math.max(0, Math.round(Number(rawProgress.opens || 0)));
}

function limitRuleOverridden(state: SentinelState, ruleId: string, now: Date): boolean {
  return (state.overrides || []).some((override) => {
    return override.limitRuleId === ruleId && new Date(override.until) > now;
  });
}

function limitOverrideUntil(value: unknown, now: Date): Date {
  const parsed = new Date(String(value || ""));
  if (Number.isFinite(parsed.getTime()) && parsed > now) return parsed;
  return endOfToday();
}

function optionalString(value: unknown): string | undefined {
  const text = String(value || "").trim();
  return text || undefined;
}

function optionalStringList(value: unknown): string[] | undefined {
  const values = normalizeTargets(value);
  return values.length ? values : undefined;
}

function clampOptionalInteger(value: unknown, min: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Math.max(min, Math.trunc(number));
}
