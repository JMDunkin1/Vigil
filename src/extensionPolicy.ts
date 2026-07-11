import { PORT, REQUIRED_EXTENSION_VERSION } from "./defaults.js";
import { ADULT_BLOCKLIST_BROWSER_SITE_RULE_LIMIT, adultBlocklistPreloadDomains, matchAdultBlocklistHost } from "./adultBlocklist.js";
import { activeAppLockPolicy } from "./appLocks.js";
import { contentFilterEnabled, contentFilterRuleEntries, matchContentFilterUrl } from "./contentFilters.js";
import type { ContentFilterMatch } from "./contentFilters.js";
import { integrityLockdownActive } from "./integrityLockdown.js";
import { intentionalUseDecision, recordIntentionalUseTime } from "./intentionalUse.js";
import { activeLimitBlocks, activeLimitPolicy } from "./limits.js";
import { activePolicy, baselinePolicy, expandSiteTargets, matchBlockedUrlPattern, normalizeHost, normalizeUrlPattern, shouldBlockSite, shouldBlockUrl } from "./policy.js";
import { focusedSocialBrowserCleanupEnabled, focusedSocialBrowserCleanupSettings } from "./socialFeatureFilters.js";
import { recordOpen, recordUsage } from "./usage.js";
import type { ActivePolicy, FocusedSocialSettings, IntentionalPause, IntentionalUseRule, LimitBlock, SentinelState, UnknownRecord, UsageSample, UsageState } from "./types.js";

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
  until: string;
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

  for (const block of activeLimitBlocks(state, now, { device: "computer" })) {
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

  if (baseline) {
    addAdultBlocklistRuleEntries(entries, state, baseline);
  }

  const dynamic = canonicalExtensionDynamicSnapshot({
    rules: [...entries.values()],
    contentRules: contentRulesForPolicy(state, sessionPolicy, now),
    allowlistRules: allowlistRulesForPolicy(sessionPolicy)
  });
  return {
    ok: true,
    generatedAt: now.toISOString(),
    requiredExtensionVersion: REQUIRED_EXTENSION_VERSION,
    browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
    focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
    focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now),
    contentFilterEnabled: contentFilterEnabled(state),
    fallbackRequired: false,
    dynamicRuleCount: extensionDynamicRuleCount(dynamic),
    dynamicRuleSignature: extensionDynamicRuleSignature(dynamic),
    rules: dynamic.rules,
    contentRules: dynamic.contentRules,
    allowlistRules: dynamic.allowlistRules
  };
}

export function extensionDynamicRuleCount(snapshot: Partial<ExtensionDynamicSnapshot> = {}): number {
  const canonical = canonicalExtensionDynamicSnapshot(snapshot);
  return canonical.rules.length
    + canonical.contentRules.length
    + canonical.allowlistRules.length
    + (canonical.allowlistRules.length ? 1 : 0);
}

export function extensionDynamicRuleSignature(snapshot: Partial<ExtensionDynamicSnapshot> = {}): string {
  const canonical = canonicalExtensionDynamicSnapshot(snapshot);
  return JSON.stringify({
    site: canonical.rules.map((rule) => ({
      domain: rule.domain,
      redirectUrl: rule.redirectUrl,
      until: rule.until
    })),
    content: canonical.contentRules.map((rule) => ({
      urlFilter: rule.urlFilter,
      redirectUrl: rule.redirectUrl,
      until: rule.until
    })),
    allowlist: canonical.allowlistRules.map((rule) => ({
      excludedDomains: rule.excludedDomains || [],
      redirectUrl: rule.redirectUrl,
      until: rule.until
    })),
    localServerAllow: canonical.allowlistRules.length > 0
  });
}

function canonicalExtensionDynamicSnapshot(snapshot: Partial<ExtensionDynamicSnapshot>): ExtensionDynamicSnapshot {
  const rules = uniqueBy(snapshot.rules || [], (rule) => rule.domain)
    .sort((a, b) => a.domain.localeCompare(b.domain));
  const contentRules = uniqueBy(snapshot.contentRules || [], (rule) => String(rule.urlFilter || ""))
    .filter((rule) => Boolean(rule.urlFilter))
    .sort((a, b) => String(a.urlFilter).localeCompare(String(b.urlFilter)));
  const allowlistRules = uniqueBy((snapshot.allowlistRules || []).map((rule) => ({
    ...rule,
    excludedDomains: [...new Set(rule.excludedDomains || [])].sort((a, b) => a.localeCompare(b))
  })), (rule) => JSON.stringify({
    excludedDomains: rule.excludedDomains,
    redirectUrl: rule.redirectUrl,
    until: rule.until
  })).sort((a, b) => JSON.stringify(a.excludedDomains).localeCompare(JSON.stringify(b.excludedDomains)));
  return { rules, contentRules, allowlistRules };
}

function uniqueBy<T>(values: T[], keyFor: (value: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const value of values) {
    const key = keyFor(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
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
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
      focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
      focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
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
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
      focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
      focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
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
  const siteBlocked = policy ? shouldBlockSite(policy.profile, hostname) : false;
  const urlPattern = policy && !siteBlocked ? matchBlockedUrlPattern(policy.profile, sample.url) : null;
  if (contentMatch) {
    const redirectUrl = contentFilterEscapeUrl(state, input, parsed.url, contentMatch.policy, contentMatch.content, now)
      || blockedUrl(contentMatch.content.label, contentMatch.policy, sample.url, safeBackUrl(state, input.previousUrl, parsed.url, now));
    return {
      ok: true,
      blocked: true,
      ignored: false,
      reason: "content-filter",
      hostname,
      event,
      recorded,
      contentFilter: contentMatch.content,
      redirectUrl,
      policy: publicPolicy(contentMatch.policy),
      contentFilterEnabled: true,
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
      focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
      focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
    };
  }

  if (!policy || (!urlPattern && !siteBlocked)) {
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
        overlay: publicPauseOverlay(state, pause.pause, now),
        rule: publicPauseRule(pause.rule),
        contentFilterEnabled: contentFilterEnabled(state),
        browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
        focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
        focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
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
      browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
      focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
      focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
    };
  }

  const urlPatternContent = urlPattern ? matchContentFilterUrl(state, parsed.url) : null;
  const redirectUrl = contentFilterEscapeUrl(state, input, parsed.url, policy, urlPatternContent, now)
    || blockedUrl(urlPattern?.label || hostname, policy, sample.url, safeBackUrl(state, input.previousUrl, parsed.url, now));

  return {
    ok: true,
    blocked: true,
    paused: false,
    ignored: false,
    reason: urlPattern ? "url-pattern" : policy.kind,
    hostname: urlPattern?.label || hostname,
    event,
    recorded,
    redirectUrl,
    policy: publicPolicy(policy),
    urlPattern: urlPattern || null,
    contentFilterEnabled: contentFilterEnabled(state),
    browserNoiseBlockingEnabled: browserNoiseBlockingEnabled(state),
    focusedSocialCleanupEnabled: focusedSocialCleanupEnabled(state, now),
    focusedSocialCleanupSettings: focusedSocialCleanupSettingsForState(state, now)
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

function publicPauseOverlay(state: SentinelState, pause: IntentionalPause | null | undefined, now: Date) {
  if (!pause) return null;
  const budget = pause.budget || null;
  const context = pause.context || null;
  const budgetSeconds = Number(budget?.budgetSeconds || 0);
  const seconds = Number(budget?.seconds || 0);
  return {
    goalStatement: state.intentionalUse?.goal?.statement || "Use screens on purpose, not by reflex.",
    replacements: (state.intentionalUse?.goal?.replacements || []).slice(0, 6),
    waitSeconds: Math.max(0, Math.ceil((Date.parse(pause.eligibleAt || "") - now.getTime()) / 1000)),
    budgetText: budgetSeconds
      ? `${Math.round(seconds / 60)} of ${Math.round(budgetSeconds / 60)} min used today`
      : "No daily budget set",
    contextMessage: context?.message || "Normal pause"
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

function focusedSocialCleanupEnabled(state: SentinelState, now: Date): boolean {
  const policy = activePolicy(state, now);
  if (policy) return true;
  const ios = state.deviceControls?.ios;
  return Boolean(ios?.enabled && ios.blockWeb !== false && focusedSocialBrowserCleanupEnabled(ios.focusedSocial));
}

function focusedSocialCleanupSettingsForState(state: SentinelState, now: Date): FocusedSocialSettings {
  const settings = focusedSocialBrowserCleanupSettings(state.deviceControls?.ios?.focusedSocial);
  if (!activePolicy(state, now)) return settings;
  return {
    ...settings,
    enabled: true
  };
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

function addAdultBlocklistRuleEntries(entries: Map<string, ExtensionRule>, state: SentinelState, baseline: ActivePolicy): void {
  const available = Math.max(0, ADULT_BLOCKLIST_BROWSER_SITE_RULE_LIMIT - entries.size);
  if (!available) return;
  addRuleEntries(entries, adultBlocklistPreloadDomains(state, { limit: available }), {
    ...baseline,
    kind: "adult-blocklist",
    session: {
      ...baseline.session,
      title: "Adult blocklist"
    }
  }, "adult-blocklist");
}

function contentRulesForPolicy(state: SentinelState, policy: ActivePolicy | null, now: Date): UrlRuleEntry[] {
  if (!policy) return [];
  const builtIn = contentFilterRuleEntries(state, policy).map((entry) => ({
    ...entry,
    redirectUrl: safeContentFallbackUrlForPolicy(state, entry.fallbackUrl, policy, now) || blockedUrl(entry.label, {
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
  const allowed = new Set(["localhost", "127.0.0.1", "::1"]);
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
  if (baseline && (shouldBlockUrl(baseline.profile, sample.url) || shouldBlockSite(baseline.profile, sample.hostname))) return baseline;
  return adultBlocklistPolicyFor(state, sample.hostname, now);
}

function adultBlocklistPolicyFor(state: SentinelState, hostname: string | undefined, now: Date): ActivePolicy | null {
  const match = matchAdultBlocklistHost(state, hostname);
  if (!match) return null;
  const baseline = baselinePolicy(state, now, { device: "computer" });
  if (!baseline) return null;
  return {
    ...baseline,
    kind: "adult-blocklist",
    session: {
      ...baseline.session,
      id: "adult-blocklist:computer",
      title: "Adult blocklist",
      profileId: "adult-blocklist"
    },
    profile: {
      id: "adult-blocklist",
      name: match.sourceLabel || "Adult blocklist",
      mode: "blocklist",
      blockedApps: [],
      blockedSites: [match.domain],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    }
  };
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

function contentFilterEscapeUrl(
  state: SentinelState,
  input: ExtensionCheckInput,
  currentUrl: URL,
  policy: ActivePolicy,
  content: ContentFilterMatch | null | undefined,
  now: Date
): string {
  const fallbackUrl = safeContentFallbackUrlForPolicy(state, content?.fallbackUrl, policy, now);
  if (!fallbackUrl) return "";
  return safeBackUrl(state, input.previousUrl, currentUrl, now) || fallbackUrl;
}

function safeBackUrl(state: SentinelState, value: unknown, currentUrl: URL, now: Date): string {
  const parsed = parseHttpUrl(value);
  if (!parsed.ok || isSentinelUrl(parsed.url) || sameHttpUrl(parsed.url, currentUrl)) return "";
  if (matchContentFilterUrl(state, parsed.url)) return "";
  if (profileBlocksBrowserUrl(activePolicy(state, now), parsed.url)) return "";
  if (profileBlocksBrowserUrl(baselinePolicy(state, now, { device: "computer" }), parsed.url)) return "";
  return parsed.url.toString();
}

function profileBlocksBrowserUrl(policy: ActivePolicy | null | undefined, url: URL): boolean {
  if (!policy?.profile) return false;
  const hostname = normalizeHost(url.hostname);
  return shouldBlockSite(policy.profile, hostname) || Boolean(matchBlockedUrlPattern(policy.profile, url.toString()));
}

function safeContentFallbackUrlForPolicy(
  state: SentinelState,
  value: unknown,
  policy: ActivePolicy | null | undefined,
  now = new Date()
): string {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || isLocalHost(url.hostname)) return "";
    if (matchContentFilterUrl(state, url)) return "";
    if (profileBlocksBrowserUrl(policy, url)) return "";
    if (profileBlocksBrowserUrl(baselinePolicy(state, now, { device: "computer" }), url)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function sameHttpUrl(left: URL, right: URL): boolean {
  return left.protocol === right.protocol
    && left.hostname.toLowerCase() === right.hostname.toLowerCase()
    && String(left.port || defaultPort(left)) === String(right.port || defaultPort(right))
    && left.pathname === right.pathname
    && left.search === right.search;
}

function defaultPort(url: URL): string {
  return url.protocol === "https:" ? "443" : "80";
}

function blockedUrl(hostname: string, policy: BrowserPolicy, returnUrl = "", backUrl = ""): string {
  const target = new URL(`http://127.0.0.1:${PORT}/blocked`);
  target.searchParams.set("site", hostname);
  target.searchParams.set("until", policy.endsAt || "");
  target.searchParams.set("mode", policy.session?.mode || "focus");
  target.searchParams.set("kind", policy.kind || "manual");
  const lockId = policy.appLock?.id || policy.session?.lockId || "";
  if (lockId) target.searchParams.set("lockId", lockId);
  if (returnUrl) target.searchParams.set("return", returnUrl);
  if (backUrl) target.searchParams.set("back", backUrl);
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
