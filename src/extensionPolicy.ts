import { PORT, REQUIRED_EXTENSION_VERSION } from "./defaults.js";
import { activeAppLockPolicy } from "./appLocks.js";
import { contentFilterEnabled, contentFilterRuleEntries, matchContentFilterUrl } from "./contentFilters.js";
import { integrityLockdownActive } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { activeLimitBlocks, activeLimitPolicy } from "./limits.js";
import { activePolicy, baselinePolicy, expandSiteTargets, matchBlockedUrlPattern, normalizeHost, normalizeUrlPattern, shouldBlockSite, shouldBlockUrl } from "./policy.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { ActivePolicy, IntentionalPause, IntentionalUseRule, LimitBlock, SentinelState, UnknownRecord, UsageSample, UsageState } from "./types.js";

export const EXTENSION_APP_NAME = "Browser Extension";

type BrowserPolicy = Omit<Partial<ActivePolicy>, "session"> & {
  kind: string;
  appLock?: { id?: string };
  limitBlock?: LimitBlock;
  session?: Partial<ActivePolicy["session"]> & { lockId?: string };
  endsAt?: string;
};

interface ExtensionRule extends UnknownRecord {
  domain: string;
  reason: string;
  mode: string;
  kind: string;
  lockId: string | null;
  until: string;
  redirectUrl: string;
}

interface UrlRuleEntry extends UnknownRecord {
  id?: string;
  label: string;
  urlFilter?: string;
  excludedDomains?: string[];
  redirectUrl: string;
}

interface ExtensionDynamicSnapshot {
  rules: ExtensionRule[];
  contentRules: UrlRuleEntry[];
  allowlistRules: UrlRuleEntry[];
}

interface ExtensionCheckInput extends UnknownRecord {
  url?: unknown;
  event?: unknown;
  previousUrl?: unknown;
  seconds?: unknown;
}

type ParsedHttpUrl = { ok: true; url: URL } | { ok: false; reason: string };

export function extensionRuleSnapshot(state: SentinelState, now = new Date()) {
  const entries = new Map<string, ExtensionRule>();
  const sessionPolicy = activePolicy(state, now);
  const baseline = baselinePolicy(state, now, { device: "computer" });

  if (baseline?.profile?.mode === "blocklist") {
    addRuleEntries(entries, baseline.profile.blockedSites, baseline, "baseline");
  }

  if (sessionPolicy?.profile?.mode === "blocklist") {
    addRuleEntries(entries, sessionPolicy.profile.blockedSites, sessionPolicy, "session");
  }

  for (const lock of (state.appLocks || []).filter((item) => item.enabled)) {
    for (const site of expandSiteTargets(lock.sites || [])) {
      const policy = activeAppLockPolicy(state, { app: EXTENSION_APP_NAME, hostname: site }, now);
      const appLockPolicy = policy as BrowserPolicy | null;
      if (appLockPolicy?.appLock?.id === lock.id) addRuleEntries(entries, [site], appLockPolicy, "app-lock");
    }
  }

  for (const block of activeLimitBlocks(state, now)) {
    addRuleEntries(entries, block.sites || [], {
      kind: "limit",
      limitBlock: block,
      session: {
        title: block.ruleName,
        mode: block.type === "open" ? "open-limit" : "time-limit",
        lockLevel: block.lockLevel,
        endsAt: block.until
      },
      endsAt: block.until
    }, "limit");
  }

  const rules = [...entries.values()].sort((a, b) => a.domain.localeCompare(b.domain));
  const contentRules = contentRulesForPolicy(state, sessionPolicy);
  const allowlistRules = allowlistRulesForPolicy(sessionPolicy);

  const dynamic = { rules, contentRules, allowlistRules };
  return {
    ok: true,
    generatedAt: now.toISOString(),
    requiredExtensionVersion: REQUIRED_EXTENSION_VERSION,
    browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
    contentFilterEnabled: contentFilterEnabled(state),
    fallbackRequired: false,
    dynamicRuleCount: extensionDynamicRuleCount(dynamic),
    dynamicRuleSignature: extensionDynamicRuleSignature(dynamic),
    rules,
    contentRules,
    allowlistRules
  };
}

export function extensionDynamicRuleCount(snapshot: Partial<ExtensionDynamicSnapshot> = {}): number {
  return (snapshot.rules || []).length + (snapshot.contentRules || []).length + (snapshot.allowlistRules || []).length;
}

export function extensionDynamicRuleSignature(snapshot: Partial<ExtensionDynamicSnapshot> = {}): string {
  return JSON.stringify({
    site: (snapshot.rules || []).map((rule) => ({
      domain: rule.domain,
      redirectUrl: rule.redirectUrl
    })),
    content: (snapshot.contentRules || []).map((rule) => ({
      urlFilter: rule.urlFilter,
      redirectUrl: rule.redirectUrl
    })),
    allowlist: (snapshot.allowlistRules || []).map((rule) => ({
      excludedDomains: rule.excludedDomains || [],
      redirectUrl: rule.redirectUrl
    }))
  });
}

export function evaluateExtensionCheck(state: SentinelState, usage: UsageState, input: ExtensionCheckInput = {}, now = new Date()) {
  const parsed = parseHttpUrl(input.url);
  if (!parsed.ok) {
    return {
      ok: true,
      blocked: false,
      ignored: true,
      reason: parsed.reason,
      recorded: false,
      contentFilterEnabled: contentFilterEnabled(state),
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
    };
  }

  if (isSentinelUrl(parsed.url)) {
    return {
      ok: true,
      blocked: false,
      ignored: true,
      reason: "sentinel-app",
      recorded: false,
      contentFilterEnabled: contentFilterEnabled(state),
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
    };
  }

  const event = sanitizeEvent(input.event);
  const hostname = normalizeHost(parsed.url.hostname);
  const sample = {
    app: EXTENSION_APP_NAME,
    hostname,
    url: parsed.url.toString()
  };
  let recorded = false;

  if (shouldRecordOpen(event)) {
    recordOpen(usage, sample, previousSample(input.previousUrl), now);
    recorded = true;
  }

  const seconds = clampSeconds(input.seconds);
  if (seconds > 0) {
    recordUsage(usage, sample, seconds, now);
    recordIntentionalUseTime(state, sample, seconds, now);
    recorded = true;
  }

  const policy = blockingPolicyFor(state, usage, sample, now);
  const contentMatch = matchContentFilterForActivePolicy(state, parsed.url, now);
  const urlPattern = policy ? matchBlockedUrlPattern(policy.profile, sample.url) : null;
  if (contentMatch) {
    return {
      ok: true,
      blocked: true,
      ignored: false,
      reason: "content-filter",
      hostname,
      event,
      recorded,
      contentFilter: contentMatch.content,
      redirectUrl: blockedUrl(contentMatch.content.label, contentMatch.policy, sample.url),
      policy: publicPolicy(contentMatch.policy),
      contentFilterEnabled: true,
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
    };
  }

  if (!policy || (!urlPattern && !shouldBlockSite(policy.profile, hostname))) {
    const pause = intentionalUseDecision(state, sample, { event, returnUrl: sample.url }, now);
    if (pause.shouldPause) {
      return {
        ok: true,
        blocked: false,
        paused: true,
        ignored: false,
        reason: "intentional-use",
        hostname,
        event,
        recorded,
        redirectUrl: pause.redirectUrl,
        pause: publicPause(pause.pause),
        rule: publicPauseRule(pause.rule),
        contentFilterEnabled: contentFilterEnabled(state),
        browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
      };
    }

    return {
      ok: true,
      blocked: false,
      paused: false,
      ignored: false,
      reason: "allowed",
      hostname,
      event,
      recorded,
      contentFilterEnabled: contentFilterEnabled(state),
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
    };
  }

  return {
    ok: true,
    blocked: true,
    paused: false,
    ignored: false,
    reason: urlPattern ? "url-pattern" : policy.kind,
    hostname: urlPattern?.label || hostname,
    event,
    recorded,
    redirectUrl: blockedUrl(urlPattern?.label || hostname, policy, sample.url),
    policy: publicPolicy(policy),
    urlPattern: urlPattern || null,
    contentFilterEnabled: contentFilterEnabled(state),
    browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state)
  };
}

function publicPause(pause: IntentionalPause | null | undefined) {
  if (!pause) return null;
  return {
    id: pause.id,
    ruleId: pause.ruleId,
    targetLabel: pause.targetLabel,
    targetType: pause.targetType,
    eligibleAt: pause.eligibleAt,
    expiresAt: pause.expiresAt,
    delaySeconds: pause.delaySeconds,
    sessionMinutes: pause.sessionMinutes,
    budget: pause.budget || null,
    context: pause.context || null
  };
}

function publicPauseRule(rule: IntentionalUseRule | null | undefined) {
  if (!rule) return null;
  return {
    id: rule.id,
    name: rule.name,
    frictionLevel: rule.frictionLevel,
    sessionMinutes: rule.sessionMinutes,
    dailyBudgetMinutes: rule.dailyBudgetMinutes
  };
}

function browserNoiseBlockingEnabled(state: SentinelState): boolean {
  return integrityLockdownActive(state) || state.settings?.browserNoiseBlockingEnabled !== false;
}

function addRuleEntries(entries: Map<string, ExtensionRule>, sites: string[], policy: BrowserPolicy, reason: string): void {
  for (const domain of expandSiteTargets(sites || [])) {
    if (isLocalHost(domain)) continue;
    const existing = entries.get(domain);
    if (existing && rulePriority(existing.reason) >= rulePriority(reason)) continue;
    entries.set(domain, {
      domain,
      reason,
      mode: policy.session?.mode || "focus",
      kind: policy.kind || reason,
      lockId: policy.appLock?.id || policy.session?.lockId || null,
      until: policy.endsAt || policy.session?.endsAt || "",
      redirectUrl: blockedUrl(domain, policy)
    });
  }
}

function contentRulesForPolicy(state: SentinelState, policy: ActivePolicy | null): UrlRuleEntry[] {
  if (!policy) return [];
  const builtIn = contentFilterRuleEntries(state, policy).map((entry) => ({
    ...entry,
    redirectUrl: blockedUrl(entry.label, {
      ...policy,
      kind: "content-filter"
    })
  }));
  return [...builtIn, ...urlPatternRuleEntries(policy)];
}

function allowlistRulesForPolicy(policy: ActivePolicy | null): UrlRuleEntry[] {
  if (policy?.profile?.mode !== "allowlist") return [];
  const excludedDomains = allowedDomainsForPolicy(policy);
  return [{
    id: `allowlist:${policy.session?.id || policy.session?.mode || "session"}`,
    label: `${policy.session?.title || "Allowlist"} browser allowlist`,
    excludedDomains,
    mode: policy.session?.mode || "focus",
    kind: "allowlist",
    until: policy.endsAt || policy.session?.endsAt || "",
    redirectUrl: blockedUrl("Outside allowlist", {
      ...policy,
      kind: "allowlist"
    })
  }];
}

function allowedDomainsForPolicy(policy: ActivePolicy): string[] {
  const allowed = new Set(["localhost", "127.0.0.1"]);
  for (const domain of expandSiteTargets(policy.profile?.allowedSites || [])) {
    allowed.add(domain);
  }
  return [...allowed].filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function urlPatternRuleEntries(policy: ActivePolicy | null): UrlRuleEntry[] {
  if (!policy?.profile) return [];
  const entries: UrlRuleEntry[] = [];
  for (const raw of policy.profile.blockedUrlPatterns || []) {
    for (const urlFilter of urlPatternToUrlFilters(raw)) {
      entries.push({
        id: `url-pattern:${raw}`,
        label: `URL pattern: ${raw}`,
        urlFilter,
        mode: policy.session?.mode || "focus",
        kind: "url-pattern",
        until: policy.endsAt || policy.session?.endsAt || "",
        redirectUrl: blockedUrl(`URL pattern: ${raw}`, {
          ...policy,
          kind: "url-pattern"
        })
      });
    }
  }
  return entries;
}

function urlPatternToUrlFilters(value: string): string[] {
  const pattern = normalizeUrlPattern(value);
  if (!pattern || pattern.startsWith("/") || !pattern.includes("/")) return [];
  const [host, ...rest] = pattern.split("/");
  const path = rest.join("/");
  const domains = expandSiteTargets([host]);
  if (!domains.length || !path) return [];
  return domains.map((domain) => `||${domain}/${path}`);
}

function rulePriority(reason: string): number {
  const priorities: Record<string, number> = { session: 4, "app-lock": 3, limit: 2 };
  return priorities[reason] || 1;
}

function isLocalHost(domain: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(String(domain || "").toLowerCase());
}

function blockingPolicyFor(state: SentinelState, usage: UsageState, sample: UsageSample, now: Date): ActivePolicy | null {
  const sessionPolicy = activePolicy(state, now);
  if (sessionPolicy && (shouldBlockUrl(sessionPolicy.profile, sample.url) || shouldBlockSite(sessionPolicy.profile, sample.hostname))) return sessionPolicy;
  const active = activeAppLockPolicy(state, sample, now) || activeLimitPolicy(state, usage, sample, now);
  if (active) return active;
  const baseline = baselinePolicy(state, now, { device: "computer" });
  return baseline && (shouldBlockUrl(baseline.profile, sample.url) || shouldBlockSite(baseline.profile, sample.hostname)) ? baseline : null;
}

function matchContentFilterForActivePolicy(state: SentinelState, url: URL, now: Date) {
  const policy = activePolicy(state, now);
  if (!policy) return null;
  const content = matchContentFilterUrl(state, url);
  return content ? { policy, content } : null;
}

function publicPolicy(policy: BrowserPolicy) {
  return {
    kind: policy.kind,
    title: policy.session?.title || policy.kind,
    mode: policy.session?.mode || "focus",
    endsAt: policy.endsAt || policy.session?.endsAt || "",
    lockId: policy.appLock?.id || policy.session?.lockId || null
  };
}

function blockedUrl(hostname: string, policy: BrowserPolicy, returnUrl = ""): string {
  const target = new URL(`http://127.0.0.1:${PORT}/blocked`);
  target.searchParams.set("site", hostname);
  target.searchParams.set("until", policy.endsAt || "");
  target.searchParams.set("mode", policy.session?.mode || "focus");
  target.searchParams.set("kind", policy.kind || "manual");
  const lockId = policy.appLock?.id || policy.session?.lockId || "";
  if (lockId) target.searchParams.set("lockId", lockId);
  if (returnUrl) target.searchParams.set("return", returnUrl);
  return target.toString();
}

function parseHttpUrl(value: unknown): ParsedHttpUrl {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) {
      return { ok: false, reason: "unsupported-protocol" };
    }
    return { ok: true, url };
  } catch {
    return { ok: false, reason: "invalid-url" };
  }
}

function isSentinelUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return ["127.0.0.1", "localhost", "::1"].includes(host) && String(url.port || "80") === String(PORT);
}

function shouldRecordOpen(event: string): boolean {
  return ["navigation", "activated", "history"].includes(event);
}

function previousSample(value: unknown): UsageSample | null {
  const parsed = parseHttpUrl(value);
  if (!parsed.ok) return null;
  return {
    app: EXTENSION_APP_NAME,
    hostname: normalizeHost(parsed.url.hostname),
    url: parsed.url.toString()
  };
}

function sanitizeEvent(value: unknown): string {
  const event = String(value || "navigation").toLowerCase().replace(/[^a-z-]/g, "").slice(0, 40);
  return event || "navigation";
}

function clampSeconds(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(60, number));
}
