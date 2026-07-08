import { activeAppLockPolicy } from "./appLocks.js";
import { matchAdultBlocklistHost } from "./adultBlocklist.js";
import { matchContentFilterUrl } from "./contentFilters.js";
import { EXTENSION_APP_NAME } from "./extensionPolicy.js";
import { activeLimitBlocks, activeLimitPolicy } from "./limits.js";
import { intentionalUseDecision } from "./intentionalUse.js";
import {
  activePolicy,
  baselinePolicy,
  expandSiteTargets,
  matchBlockedUrlPattern,
  matchStrictBrowserControlUrl,
  normalizeDeviceTarget,
  normalizeHost,
  shouldBlockAppForPolicy,
  shouldBlockSite
} from "./policy.js";
import type { ActivePolicy, DeviceTarget, LimitBlock, SentinelState, UnknownRecord, UsageSample, UsageState } from "./types.js";

export interface RuleSimulationInput extends UnknownRecord {
  app?: unknown;
  site?: unknown;
  hostname?: unknown;
  url?: unknown;
  device?: unknown;
  event?: unknown;
  at?: unknown;
  now?: unknown;
  time?: unknown;
}

interface SimulationTarget {
  app: string;
  hostname: string;
  url: string;
  device: DeviceTarget;
  event: string;
  label: string;
}

interface SimulationPolicy {
  kind: string;
  title: string;
  mode: string;
  lockLevel: string;
  source: string;
  endsAt: string;
  profileId: string;
  profileName: string;
  deviceTargets: DeviceTarget[];
}

interface SimulationMatch extends UnknownRecord {
  type: string;
  label: string;
  detail: string;
}

interface SimulationCheck {
  source: string;
  matched: boolean;
  action: "allow" | "block" | "pause" | "none";
  reason: string;
  policy?: SimulationPolicy | null;
  match?: SimulationMatch | null;
}

export interface RuleSimulationResult {
  ok: true;
  blocked: boolean;
  paused: boolean;
  allowed: boolean;
  reasonCode: string;
  reason: string;
  evaluatedAt: string;
  target: SimulationTarget;
  policy: SimulationPolicy | null;
  match: SimulationMatch | null;
  checks: SimulationCheck[];
}

export function explainRuleDecision(
  currentState: SentinelState,
  currentUsage: UsageState = {},
  input: RuleSimulationInput = {}
): RuleSimulationResult {
  const now = dateFromInput(input);
  const state = jsonClone(currentState);
  const usage = jsonClone(currentUsage);
  const target = simulationTarget(input);
  const sample = sampleFromTarget(target);
  const checks: SimulationCheck[] = [];

  const sessionPolicy = activePolicy(state, now, { device: target.device });
  const sessionBrowserControl = target.url ? matchStrictBrowserControlUrl(state, sessionPolicy, target.url) : null;
  if (sessionBrowserControl && sessionPolicy) {
    const match = {
      type: "browser-control",
      label: sessionBrowserControl.label,
      detail: `${sessionBrowserControl.url} is a protected browser control surface.`
    };
    checks.push(blockCheck("browser-control", "Browser-control rule matched the active policy.", sessionPolicy, match));
    return blockResult("browser-control", `Blocked by ${policyTitle(sessionPolicy)}: ${sessionBrowserControl.label}.`, now, target, sessionPolicy, match, checks);
  }
  checks.push(noneCheck("browser-control", sessionPolicy ? "No browser-control rule matched the active policy." : "No active policy for browser-control checks."));

  const contentFilter = target.url && sessionPolicy ? matchContentFilterUrl(state, target.url) : null;
  if (contentFilter && sessionPolicy) {
    const match = {
      type: "content-filter",
      label: contentFilter.label,
      detail: `${contentFilter.hostname} matches the ${contentFilter.label} content filter.`
    };
    checks.push(blockCheck("content-filter", "Content filter matched during the active policy.", sessionPolicy, match));
    return blockResult("content-filter", `Blocked by ${contentFilter.label} content filter during ${policyTitle(sessionPolicy)}.`, now, target, {
      ...sessionPolicy,
      kind: "content-filter",
      contentFilter
    }, match, checks);
  }
  checks.push(noneCheck("content-filter", sessionPolicy ? "No content filter matched this URL." : "Content filters only block while an active policy is present."));

  const appLockPolicy = activeAppLockPolicy(state, sample, now);
  const limitPolicy = activeLimitPolicy(state, usage, sample, now);

  const appLockBrowserControlPolicy = target.url ? strictAppLockBrowserControlPolicy(state, now) : null;
  const appLockBrowserControl = target.url ? matchStrictBrowserControlUrl(state, appLockBrowserControlPolicy, target.url) : null;
  if (appLockBrowserControl && appLockBrowserControlPolicy) {
    const match = {
      type: "browser-control",
      label: appLockBrowserControl.label,
      detail: `${appLockBrowserControl.url} is protected while a deep App Lock guards browser sites.`
    };
    checks.push(blockCheck("app-lock-browser-control", "Deep App Lock browser-control rule matched.", appLockBrowserControlPolicy, match));
    return blockResult("browser-control", `Blocked by ${policyTitle(appLockBrowserControlPolicy)}: ${appLockBrowserControl.label}.`, now, target, {
      ...appLockBrowserControlPolicy,
      kind: "browser-control",
      browserControl: appLockBrowserControl
    }, match, checks);
  }
  checks.push(noneCheck("app-lock-browser-control", "No App Lock browser-control rule matched."));

  const limitBrowserControlPolicy = target.url ? strictLimitBrowserControlPolicy(state, now) : null;
  const limitBrowserControl = target.url ? matchStrictBrowserControlUrl(state, limitBrowserControlPolicy, target.url) : null;
  if (limitBrowserControl && limitBrowserControlPolicy) {
    const match = {
      type: "browser-control",
      label: limitBrowserControl.label,
      detail: `${limitBrowserControl.url} is protected while a deep limit block guards browser sites.`
    };
    checks.push(blockCheck("limit-browser-control", "Deep limit browser-control rule matched.", limitBrowserControlPolicy, match));
    return blockResult("browser-control", `Blocked by ${policyTitle(limitBrowserControlPolicy)}: ${limitBrowserControl.label}.`, now, target, {
      ...limitBrowserControlPolicy,
      kind: "browser-control",
      browserControl: limitBrowserControl
    }, match, checks);
  }
  checks.push(noneCheck("limit-browser-control", "No limit browser-control rule matched."));

  const sessionMatch = matchTargetForPolicy(state, sessionPolicy, sample);
  if (sessionPolicy && sessionMatch) {
    checks.push(blockCheck("active-policy", "Active policy profile matched this target.", sessionPolicy, sessionMatch));
    return blockResult(`${sessionPolicy.kind}-${sessionMatch.type}`, `Blocked by ${policyTitle(sessionPolicy)}: ${sessionMatch.detail}`, now, target, sessionPolicy, sessionMatch, checks);
  }
  checks.push(noneCheck("active-policy", sessionPolicy ? "The active policy exists, but its profile did not match this target." : "No active policy targets this device right now."));

  const activeRulePolicy = appLockPolicy || limitPolicy;
  const activeRuleSource = appLockPolicy ? "app-lock" : "limit";
  const activeRuleMatch = matchTargetForPolicy(state, activeRulePolicy, sample);
  if (activeRulePolicy && activeRuleMatch) {
    checks.push(blockCheck(activeRuleSource, `${sourceLabel(activeRulePolicy)} matched this target.`, activeRulePolicy, activeRuleMatch));
    return blockResult(`${activeRulePolicy.kind}-${activeRuleMatch.type}`, `Blocked by ${policyTitle(activeRulePolicy)}: ${activeRuleMatch.detail}`, now, target, activeRulePolicy, activeRuleMatch, checks);
  }
  checks.push(noneCheck("app-lock", appLockPolicy ? "An App Lock policy was active, but its profile did not match this target." : "No App Lock matched this target."));
  checks.push(noneCheck("limit", limitPolicy ? "A limit block was active, but its profile did not match this target." : "No active or newly-triggered limit block matched this target."));

  const baseline = baselinePolicy(state, now, { device: target.device });
  const baselineMatch = matchTargetForPolicy(state, baseline, sample);
  if (baseline && baselineMatch) {
    checks.push(blockCheck("baseline", "Baseline profile matched this target.", baseline, baselineMatch));
    return blockResult(`baseline-${baselineMatch.type}`, `Blocked by baseline ${policyTitle(baseline)}: ${baselineMatch.detail}`, now, target, baseline, baselineMatch, checks);
  }
  checks.push(noneCheck("baseline", "Baseline profile did not match this target."));

  const adultBlocklistPolicy = adultBlocklistPolicyFor(state, sample.hostname, now);
  if (adultBlocklistPolicy) {
    const adultMatch = adultBlocklistMatch(sample.hostname, adultBlocklistPolicy);
    checks.push(blockCheck("adult-blocklist", "Imported adult blocklist matched this target.", adultBlocklistPolicy, adultMatch));
    return blockResult("adult-blocklist", `Blocked by adult blocklist: ${adultMatch.detail}`, now, target, adultBlocklistPolicy, adultMatch, checks);
  }
  checks.push(noneCheck("adult-blocklist", "Imported adult blocklist did not match this target."));

  const pause = intentionalUseDecision(state, sample, { event: target.event, returnUrl: target.url }, now);
  if (pause.shouldPause) {
    const ruleName = pause.rule?.name || "Intentional use";
    const match = {
      type: "intentional-use",
      label: ruleName,
      detail: `${target.label} triggers the ${ruleName} pause rule.`
    };
    checks.push({
      source: "intentional-use",
      matched: true,
      action: "pause",
      reason: "Intentional-use pause rule matched.",
      policy: null,
      match
    });
    return {
      ok: true,
      blocked: false,
      paused: true,
      allowed: false,
      reasonCode: "intentional-use",
      reason: `Paused by ${ruleName}: ${match.detail}`,
      evaluatedAt: now.toISOString(),
      target,
      policy: null,
      match,
      checks
    };
  }
  checks.push(noneCheck("intentional-use", `No intentional-use pause matched (${String(pause.reason || "no-rule")}).`));

  return {
    ok: true,
    blocked: false,
    paused: false,
    allowed: true,
    reasonCode: "allowed",
    reason: "Allowed: no baseline, active policy, profile, content filter, limit, App Lock, intentional-use pause, or browser-control rule matched this target.",
    evaluatedAt: now.toISOString(),
    target,
    policy: null,
    match: null,
    checks
  };
}

function matchTargetForPolicy(state: SentinelState, policy: ActivePolicy | null | undefined, sample: UsageSample): SimulationMatch | null {
  if (!policy?.profile) return null;
  if (sample.hostname && shouldBlockSite(policy.profile, sample.hostname)) {
    const mode = policy.profile.mode === "allowlist" ? "is outside the allowed sites" : "is on the profile site blocklist";
    return {
      type: "site",
      label: sample.hostname,
      detail: `${sample.hostname} ${mode}.`
    };
  }

  const urlPattern = sample.url ? matchBlockedUrlPattern(policy.profile, sample.url) : null;
  if (urlPattern) {
    return {
      type: "url-pattern",
      label: urlPattern.label,
      detail: `${urlPattern.url} matches URL pattern ${urlPattern.pattern}.`,
      pattern: urlPattern.pattern
    };
  }

  if (sample.app && shouldBlockAppForPolicy(state, policy, sample.app)) {
    const mode = policy.profile.mode === "allowlist" ? "is outside the allowed apps" : "is on the profile app blocklist";
    return {
      type: "app",
      label: sample.app,
      detail: `${sample.app} ${mode}.`
    };
  }

  return null;
}

function strictAppLockBrowserControlPolicy(state: SentinelState, now: Date): ActivePolicy | null {
  for (const lock of state.appLocks || []) {
    const sites = expandSiteTargets(lock.sites || []);
    if (!lock.enabled || (lock.lockLevel || "deep") !== "deep" || !sites.length) continue;
    const days = new Set(lock.days || []);
    if (days.size && !days.has(now.getDay())) continue;
    const policy = activeAppLockPolicy(state, { app: EXTENSION_APP_NAME, hostname: sites[0] || "" }, now);
    if (policy?.appLock?.id === lock.id) return policy;
  }
  return null;
}

function strictLimitBrowserControlPolicy(state: SentinelState, now: Date): ActivePolicy | null {
  const block = activeLimitBlocks(state, now, { device: "computer" }).find((item) => (item.lockLevel || "deep") === "deep" && (item.sites || []).length);
  if (!block) return null;
  return limitBrowserControlPolicy(block);
}

function limitBrowserControlPolicy(block: LimitBlock): ActivePolicy {
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

function adultBlocklistMatch(hostname: string | undefined, policy: ActivePolicy): SimulationMatch {
  const domain = policy.profile.blockedSites[0] || String(hostname || "");
  return {
    type: "adult-blocklist",
    label: domain,
    detail: `${hostname || domain} matches imported adult domain ${domain}.`,
    domain
  };
}

function blockResult(
  reasonCode: string,
  reason: string,
  now: Date,
  target: SimulationTarget,
  policy: ActivePolicy,
  match: SimulationMatch,
  checks: SimulationCheck[]
): RuleSimulationResult {
  return {
    ok: true,
    blocked: true,
    paused: false,
    allowed: false,
    reasonCode,
    reason,
    evaluatedAt: now.toISOString(),
    target,
    policy: publicPolicy(policy),
    match,
    checks
  };
}

function blockCheck(source: string, reason: string, policy: ActivePolicy, match: SimulationMatch): SimulationCheck {
  return {
    source,
    matched: true,
    action: "block",
    reason,
    policy: publicPolicy(policy),
    match
  };
}

function noneCheck(source: string, reason: string): SimulationCheck {
  return {
    source,
    matched: false,
    action: "none",
    reason
  };
}

function publicPolicy(policy: ActivePolicy | null | undefined): SimulationPolicy | null {
  if (!policy) return null;
  return {
    kind: policy.kind,
    title: policyTitle(policy),
    mode: policy.session?.mode || "focus",
    lockLevel: policy.session?.lockLevel || "",
    source: sourceLabel(policy),
    endsAt: policy.endsAt || policy.session?.endsAt || "",
    profileId: policy.profile?.id || "",
    profileName: policy.profile?.name || "",
    deviceTargets: [...(policy.session?.deviceTargets || [])]
  };
}

function sourceLabel(policy: ActivePolicy): string {
  const labels: Record<string, string> = {
    baseline: "Baseline",
    manual: "Active session",
    schedule: "Schedule",
    planner: "Planner block",
    panic: "Panic lock",
    integrity: "Integrity lockdown",
    "app-lock": "App Lock",
    limit: "Limit",
    "browser-control": "Browser control",
    "content-filter": "Content filter",
    "adult-blocklist": "Adult blocklist",
    "url-pattern": "URL pattern",
    allowlist: "Allowlist"
  };
  return labels[policy.kind] || policy.kind;
}

function policyTitle(policy: ActivePolicy): string {
  return policy.session?.title || policy.profile?.name || sourceLabel(policy);
}

function simulationTarget(input: RuleSimulationInput): SimulationTarget {
  const device = normalizeDeviceTarget(input.device);
  const url = normalizedTargetUrl(input.url, input.site ?? input.hostname);
  const hostname = normalizedTargetHostname(input.hostname ?? input.site, url);
  const app = stringValue(input.app) || (hostname || url ? EXTENSION_APP_NAME : "");
  const event = stringValue(input.event) || (hostname || url ? "navigation" : "mac-app");
  const label = url || hostname || app || `${device} at this time`;
  return { app, hostname, url, device, event, label };
}

function sampleFromTarget(target: SimulationTarget): UsageSample {
  return {
    app: target.app,
    hostname: target.hostname,
    url: target.url,
    device: target.device
  };
}

function normalizedTargetHostname(raw: unknown, url: string): string {
  const fromRaw = normalizeHost(raw);
  if (fromRaw) return fromRaw;
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) ? normalizeHost(parsed.hostname) : "";
  } catch {
    return "";
  }
}

function normalizedTargetUrl(rawUrl: unknown, rawSite: unknown): string {
  const explicit = stringValue(rawUrl);
  if (explicit) return normalizeUrlLike(explicit);
  const site = stringValue(rawSite);
  if (!site) return "";
  if (site.includes("/") || site.includes("?") || site.includes("#")) return normalizeUrlLike(site);
  const host = normalizeHost(site);
  return host ? `https://${host}/` : "";
}

function normalizeUrlLike(value: string): string {
  const raw = value.trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    return parsed.toString();
  } catch {
    try {
      return new URL(`https://${raw}`).toString();
    } catch {
      return raw;
    }
  }
}

function dateFromInput(input: RuleSimulationInput): Date {
  const value = input.at ?? input.now ?? input.time;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  const parsed = value ? new Date(String(value)) : new Date();
  return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function stringValue(value: unknown): string {
  return String(value || "").trim();
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
