import { randomUUID } from "node:crypto";
import { activeAppLockUnlockForSample } from "./appLocks.js";
import { PORT } from "./defaults.js";
import { truthy } from "./booleans.js";
import {
  appMatchesAppTargets,
  expandSiteTargets,
  hostMatchesSiteTargets,
  listFromTextarea,
  matchBlockedUrlPattern,
  normalizeHost
} from "./policy.js";
import { clampNumber, dateKey, parseClock, weekKey } from "./time.js";
import type {
  IntentionalGrant,
  IntentionalOutcome,
  IntentionalPause,
  IntentionalRuleLedger,
  IntentionalUseGoal,
  IntentionalUseRule,
  IntentionalUseState,
  SentinelState,
  UnknownRecord,
  UsageSample
} from "./types.js";

const PAUSE_EVENTS = new Set(["navigation", "history", "activated", "mac-app"]);
const OUTCOME_LIMIT = 200;
const OPEN_LIMIT = 40;

interface IntentionalUseOptions extends UnknownRecord {
  event?: string;
  returnUrl?: string;
}

interface BudgetSummary extends UnknownRecord {
  seconds: number;
  budgetSeconds: number;
  remainingSeconds: number | null;
  percent: number;
}

interface PauseContext extends UnknownRecord {
  recentCount: number;
  lateNight: boolean;
  budgetWarn: boolean;
  budgetOver: boolean;
  extraDelaySeconds: number;
  reasons: string[];
  message: string;
}

type IntentionalBody = UnknownRecord;

export function normalizeIntentionalUse(current: Partial<IntentionalUseState> = {}, fresh: Partial<IntentionalUseState> = {}): IntentionalUseState {
  return {
    ...fresh,
    ...current,
    goal: normalizeGoal(current.goal || fresh.goal || {}),
    rules: normalizeRules(current.rules || fresh.rules || []),
    pauses: Array.isArray(current.pauses) ? current.pauses : [],
    grants: Array.isArray(current.grants) ? current.grants : [],
    ledger: current.ledger && typeof current.ledger === "object" ? current.ledger : {},
    outcomes: Array.isArray(current.outcomes) ? current.outcomes.slice(0, OUTCOME_LIMIT) : [],
    accountability: {
      ...(fresh.accountability || {}),
      ...(current.accountability || {})
    }
  };
}

export function normalizeIntentionalUseRule(body: IntentionalBody = {}, existing: Partial<IntentionalUseRule> = {}, fallbackId: string = randomUUID()): IntentionalUseRule {
  const bodyFriction = String(body.frictionLevel || "");
  const friction = ["gentle", "standard", "strict"].includes(bodyFriction)
    ? bodyFriction as IntentionalUseRule["frictionLevel"]
    : existing.frictionLevel || "standard";
  const defaultDelay = friction === "strict" ? 30 : friction === "gentle" ? 5 : 12;
  const id = String(body.id || existing.id || fallbackId);
  let sites = normalizeTargets(body.sites ?? existing.sites).map(normalizeHost).filter(Boolean);
  let urlPatterns = normalizeTargets(body.urlPatterns ?? existing.urlPatterns);
  if (id === "short-form-intent-template" && sites.includes("youtube.com") && !urlPatterns.some((pattern) => normalizeHost(pattern) === "youtube.com" && pattern.includes("/shorts"))) {
    sites = sites.filter((site) => site !== "youtube.com");
    urlPatterns = [...urlPatterns, "youtube.com/shorts", "m.youtube.com/shorts"];
  }
  return {
    id,
    name: String(body.name || existing.name || "Intentional pause").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing.enabled) : truthy(body.enabled),
    frictionLevel: friction,
    days: normalizeDays(body.days ?? existing.days ?? [0, 1, 2, 3, 4, 5, 6]),
    start: normalizeClock(body.start || existing.start || "00:00"),
    end: normalizeClock(body.end || existing.end || "23:59"),
    apps: normalizeTargets(body.apps ?? existing.apps),
    sites,
    urlPatterns,
    delaySeconds: clampNumber(body.delaySeconds ?? existing.delaySeconds, 0, 3600, defaultDelay),
    sessionMinutes: clampNumber(body.sessionMinutes ?? existing.sessionMinutes, 1, 240, 10),
    dailyBudgetMinutes: clampNumber(body.dailyBudgetMinutes ?? existing.dailyBudgetMinutes, 0, 1440, 30),
    budgetWarningPercent: clampNumber(body.budgetWarningPercent ?? existing.budgetWarningPercent, 1, 100, 50),
    askMood: body.askMood === undefined ? existing.askMood !== false : truthy(body.askMood)
  };
}

export function upsertIntentionalUseRule(state: SentinelState, body: IntentionalBody = {}): IntentionalUseRule {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.rules.find((rule) => rule.id === id);
  const rule = normalizeIntentionalUseRule(body, existing, id);
  if (existing) Object.assign(existing, rule);
  else state.intentionalUse.rules.push(rule);
  return rule;
}

export function updateIntentionalUseGoal(state: SentinelState, body: IntentionalBody = {}): IntentionalUseGoal {
  ensureIntentionalUse(state);
  state.intentionalUse.goal = normalizeGoal({
    statement: String(body.statement || ""),
    values: normalizeTargets(body.values),
    replacements: normalizeTargets(body.replacements),
    updatedAt: new Date().toISOString()
  });
  return state.intentionalUse.goal;
}

export function updateIntentionalUseAccountability(state: SentinelState, body: IntentionalBody = {}) {
  ensureIntentionalUse(state);
  state.intentionalUse.accountability = {
    ...state.intentionalUse.accountability,
    enabled: truthy(body.enabled),
    partnerName: String(body.partnerName || "").trim().slice(0, 80),
    cadence: ["daily", "weekly"].includes(String(body.cadence || "")) ? String(body.cadence) : "weekly"
  };
  return state.intentionalUse.accountability;
}

export function intentionalUseSummary(state: SentinelState, usage: UnknownRecord = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  const day = dateKey(now);
  const rules = state.intentionalUse.rules.map((rule) => ruleSummary(state, rule, now));
  const today = state.intentionalUse.ledger?.[day] || {};
  const totals = Object.values(today.rules || {}).reduce((acc, item) => {
    acc.seconds += item.seconds || 0;
    acc.pauses += item.pauses || 0;
    acc.continued += item.continued || 0;
    acc.skipped += item.skipped || 0;
    return acc;
  }, { seconds: 0, pauses: 0, continued: 0, skipped: 0 });
  return {
    enabled: state.settings?.intentionalUseEnabled !== false,
    goal: state.intentionalUse.goal,
    accountability: {
      ...(state.intentionalUse.accountability || {}),
      digest: accountabilityDigest(state, usage, now)
    },
    activeGrants: (state.intentionalUse.grants || []).filter((grant) => Date.parse(grant.until || "") > now.getTime()),
    pendingPauses: (state.intentionalUse.pauses || []).filter((pause) => pause.status === "pending" && Date.parse(pause.expiresAt || "") > now.getTime()),
    rules,
    today: {
      key: day,
      ...totals,
      successRate: successRate(totals.skipped, totals.continued),
      topTargets: topOutcomeTargets(state, day)
    }
  };
}

export function intentionalUseDecision(state: SentinelState, sample: UsageSample, options: IntentionalUseOptions = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  if (state.settings?.intentionalUseEnabled === false) return { shouldPause: false, reason: "disabled" };
  if (!PAUSE_EVENTS.has(String(options.event || ""))) return { shouldPause: false, reason: "event" };
  if (!sample?.app) return { shouldPause: false, reason: "sample" };
  if (isSentinelUrl(sample.url)) return { shouldPause: false, reason: "sentinel" };

  const rule = matchingRule(state, sample, now);
  if (!rule) return { shouldPause: false, reason: "no-rule" };
  const appLockUnlock = activeAppLockUnlockForSample(state, sample, now);
  if (appLockUnlock) return { shouldPause: false, reason: "app-lock-unlock", appLockUnlock, rule };

  const grant = activeIntentionalUseGrant(state, sample, rule, now);
  if (grant) return { shouldPause: false, reason: "grant", grant, rule };

  const existing = pendingPauseFor(state, sample, rule, now);
  if (existing) return { shouldPause: true, rule, pause: existing, redirectUrl: pauseUrl(existing.id) };

  const pause = createPause(state, rule, sample, options, now);
  return { shouldPause: true, rule, pause, redirectUrl: pauseUrl(pause.id) };
}

export function activeIntentionalUseGrant(state: SentinelState, sample: UsageSample, rule: IntentionalUseRule | null = null, now = new Date()): IntentionalGrant | null {
  ensureIntentionalUse(state);
  const rules = rule ? [rule] : state.intentionalUse.rules;
  return (state.intentionalUse.grants || []).find((grant) => {
    if (grant.status !== "active" || Date.parse(grant.until || "") <= now.getTime()) return false;
    const grantRule = rules.find((item) => item.id === grant.ruleId);
    if (!grantRule) return false;
    if ((grant.targetType === "site" || grant.targetType === "url") && sample.hostname) {
      return hostMatchesSiteTargets(sample.hostname, [grant.hostname]);
    }
    if (grant.targetType === "app" && sample.app) {
      return appMatchesAppTargets(sample.app, [grant.app]);
    }
    return false;
  }) || null;
}

export function recordIntentionalUseTime(state: SentinelState, sample: UsageSample, seconds: number, now = new Date()): IntentionalGrant | null {
  if (!seconds || seconds < 0.25) return null;
  const grant = activeIntentionalUseGrant(state, sample, null, now);
  if (!grant) return null;
  const dayRule = ensureRuleLedger(state, grant.ruleId, now);
  dayRule.seconds = round((dayRule.seconds || 0) + seconds);
  dayRule.targets[grant.targetLabel] = round((dayRule.targets[grant.targetLabel] || 0) + seconds);
  grant.usedSeconds = round((grant.usedSeconds || 0) + seconds);
  grant.lastSeenAt = now.toISOString();
  return grant;
}

export function confirmIntentionalPause(state: SentinelState, requestId: string, body: IntentionalBody = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  const pause = findPendingPause(state, requestId);
  if (!pause) throw new IntentionalUseError("Pause request not found or expired.", 404);
  if (Date.parse(pause.eligibleAt || "") > now.getTime()) throw new IntentionalUseError("The pause timer is still running.", 425);

  pause.status = "continued";
  pause.completedAt = now.toISOString();
  pause.intention = String(body.intention || "").trim().slice(0, 240);
  pause.mood = String(body.mood || "").trim().slice(0, 80);
  const until = new Date(now.getTime() + Math.max(1, Number(pause.sessionMinutes || 10)) * 60 * 1000).toISOString();
  const grant = {
    id: randomUUID(),
    pauseId: pause.id,
    ruleId: pause.ruleId,
    status: "active",
    targetType: pause.targetType,
    targetLabel: pause.targetLabel,
    app: pause.app || "",
    hostname: pause.hostname || "",
    createdAt: now.toISOString(),
    until,
    intention: pause.intention,
    mood: pause.mood,
    usedSeconds: 0
  };
  state.intentionalUse.grants.push(grant);
  recordOutcome(state, pause, "continued", now);
  bumpRuleLedger(state, pause.ruleId, "continued", now);
  return { pause, grant, returnUrl: pause.returnUrl };
}

export function skipIntentionalPause(state: SentinelState, requestId: string, body: IntentionalBody = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  const pause = findPendingPause(state, requestId);
  if (!pause) throw new IntentionalUseError("Pause request not found or expired.", 404);
  pause.status = "skipped";
  pause.completedAt = now.toISOString();
  pause.replacement = String(body.replacement || "").trim().slice(0, 120);
  pause.mood = String(body.mood || "").trim().slice(0, 80);
  recordOutcome(state, pause, "skipped", now);
  bumpRuleLedger(state, pause.ruleId, "skipped", now);
  return { pause };
}

export function pausePageData(state: SentinelState, requestId: string, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  const pause = findPendingPause(state, requestId);
  if (!pause) return null;
  return {
    pause,
    goal: state.intentionalUse.goal,
    replacements: state.intentionalUse.goal.replacements || [],
    waitSeconds: Math.max(0, Math.ceil((Date.parse(pause.eligibleAt || "") - now.getTime()) / 1000)),
    budget: pause.budget || null,
    context: pause.context || {}
  };
}

export function accountabilityDigest(state: SentinelState, _usage: UnknownRecord = {}, now = new Date()) {
  ensureIntentionalUse(state);
  const key = weekKey(now);
  const outcomes = (state.intentionalUse.outcomes || []).filter((item) => item.weekKey === key);
  const continued = outcomes.filter((item) => item.outcome === "continued").length;
  const skipped = outcomes.filter((item) => item.outcome === "skipped").length;
  const seconds = Object.values(state.intentionalUse.ledger || {})
    .filter((day) => day.weekKey === key)
    .flatMap((day) => Object.values(day.rules || {}))
    .reduce((total, item) => total + (item.seconds || 0), 0);
  const topTargets = topTargetsFromOutcomes(outcomes);
  const partner = state.intentionalUse.accountability?.partnerName || "accountability partner";
  const goal = state.intentionalUse.goal?.statement || "Use screens on purpose.";
  const text = [
    `Sentinel accountability digest for ${key}`,
    `Goal: ${goal}`,
    `Intentional pauses: ${outcomes.length}`,
    `Chose replacement: ${skipped}`,
    `Continued intentionally: ${continued}`,
    `Intentional-use time: ${formatMinutes(seconds)}`,
    `Top targets: ${topTargets.map((item) => `${item.label} x${item.count}`).join(", ") || "none"}`,
    `For: ${partner}`
  ].join("\n");
  return {
    weekKey: key,
    generatedAt: now.toISOString(),
    pauses: outcomes.length,
    continued,
    skipped,
    seconds,
    successRate: successRate(skipped, continued),
    topTargets,
    text
  };
}

export class IntentionalUseError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function ensureIntentionalUse(state: SentinelState): void {
  state.intentionalUse ||= normalizeIntentionalUse();
  state.intentionalUse.goal ||= normalizeGoal();
  state.intentionalUse.rules ||= [];
  state.intentionalUse.pauses ||= [];
  state.intentionalUse.grants ||= [];
  state.intentionalUse.ledger ||= {};
  state.intentionalUse.outcomes ||= [];
  state.intentionalUse.accountability ||= {};
}

function normalizeGoal(goal: Partial<IntentionalUseGoal> = {}): IntentionalUseGoal {
  return {
    statement: String(goal.statement || "Use screens on purpose, not by reflex.").slice(0, 240),
    values: normalizeTargets(goal.values || ["Deep work", "Sleep", "Real relationships"]).slice(0, 12),
    replacements: normalizeTargets(goal.replacements || [
      "Write the next tiny task",
      "Take ten slow breaths",
      "Stand up and get water",
      "Open Notes instead"
    ]).slice(0, 12),
    updatedAt: goal.updatedAt || null
  };
}

function normalizeRules(rules: unknown): IntentionalUseRule[] {
  if (!Array.isArray(rules)) return [];
  return rules
    .filter(isUnknownRecord)
    .map((rule) => normalizeIntentionalUseRule(rule, rule, String(rule.id || randomUUID())));
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanupIntentionalUse(state: SentinelState, now: Date): void {
  const nowMs = now.getTime();
  state.intentionalUse.pauses = (state.intentionalUse.pauses || []).filter((pause) => {
    return pause.status === "pending" && Date.parse(pause.expiresAt || "") > nowMs;
  });
  state.intentionalUse.grants = (state.intentionalUse.grants || []).filter((grant) => {
    return grant.status === "active" && Date.parse(grant.until || "") > nowMs;
  });
  state.intentionalUse.outcomes = (state.intentionalUse.outcomes || []).slice(0, OUTCOME_LIMIT);
}

function matchingRule(state: SentinelState, sample: UsageSample, now: Date): IntentionalUseRule | null {
  return (state.intentionalUse.rules || []).find((rule) => {
    if (!rule.enabled || !ruleAppliesNow(rule, now)) return false;
    if (sample.url && rule.urlPatterns?.length && matchIntentionalUseUrlPattern(rule, sample.url)) return true;
    if (sample.hostname && rule.sites?.length && hostMatchesSiteTargets(sample.hostname, expandSiteTargets(rule.sites))) return true;
    return Boolean(sample.app && rule.apps?.length && appMatchesAppTargets(sample.app, rule.apps));
  }) || null;
}

function matchIntentionalUseUrlPattern(rule: IntentionalUseRule, url: string) {
  return matchBlockedUrlPattern({
    id: `intentional-use:${rule.id}`,
    name: rule.name,
    mode: "blocklist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: rule.urlPatterns || [],
    allowedApps: [],
    allowedSites: []
  }, url);
}

function ruleAppliesNow(rule: IntentionalUseRule, now: Date): boolean {
  const days = new Set(rule.days || []);
  if (days.size && !days.has(now.getDay())) return false;
  const start = parseClock(rule.start || "00:00");
  const end = parseClock(rule.end || "23:59");
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function pendingPauseFor(state: SentinelState, sample: UsageSample, rule: IntentionalUseRule, now: Date): IntentionalPause | null {
  const label = targetLabel(sample);
  return (state.intentionalUse.pauses || []).find((pause) => {
    return pause.status === "pending"
      && pause.ruleId === rule.id
      && pause.targetLabel === label
      && Date.parse(pause.expiresAt || "") > now.getTime();
  }) || null;
}

function createPause(state: SentinelState, rule: IntentionalUseRule, sample: UsageSample, options: IntentionalUseOptions, now: Date): IntentionalPause {
  const dayRule = ensureRuleLedger(state, rule.id, now);
  const budget = budgetSummary(rule, dayRule);
  const context = contextSummary(state, rule, sample, budget, now);
  const delaySeconds = adaptiveDelay(rule, context);
  const targetType = sample.url && rule.urlPatterns?.length && matchIntentionalUseUrlPattern(rule, sample.url)
    ? "url"
    : sample.hostname && rule.sites?.length && hostMatchesSiteTargets(sample.hostname, expandSiteTargets(rule.sites))
      ? "site"
      : "app";
  const pause = {
    id: randomUUID(),
    ruleId: rule.id,
    ruleName: rule.name,
    status: "pending",
    requestedAt: now.toISOString(),
    eligibleAt: new Date(now.getTime() + delaySeconds * 1000).toISOString(),
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    frictionLevel: rule.frictionLevel,
    delaySeconds,
    sessionMinutes: rule.sessionMinutes,
    targetType,
    targetLabel: targetLabel(sample),
    app: sample.app || "",
    hostname: sample.hostname || "",
    returnUrl: safeReturnUrl(options.returnUrl || sample.url),
    event: options.event || "",
    context,
    budget,
    goalSnapshot: state.intentionalUse.goal
  };
  state.intentionalUse.pauses.push(pause);
  bumpRuleLedger(state, rule.id, "pauses", now);
  return pause;
}

function adaptiveDelay(rule: IntentionalUseRule, context: PauseContext): number {
  const base = Number(rule.delaySeconds || 0);
  const extra = context.extraDelaySeconds || 0;
  const levelMinimum = rule.frictionLevel === "strict" ? 15 : rule.frictionLevel === "standard" ? 8 : 0;
  return Math.max(levelMinimum, Math.min(3600, base + extra));
}

function contextSummary(state: SentinelState, rule: IntentionalUseRule, sample: UsageSample, budget: BudgetSummary, now: Date): PauseContext {
  const recent = recentOutcomes(state, sample, now, 30);
  const hour = now.getHours();
  const lateNight = hour >= 22 || hour < 7;
  const budgetWarn = budget.percent >= (rule.budgetWarningPercent || 50);
  const budgetOver = budget.percent >= 100 && budget.budgetSeconds > 0;
  const extraDelaySeconds = [
    recent.length >= 3 ? 10 : 0,
    lateNight ? 10 : 0,
    budgetWarn ? 10 : 0,
    budgetOver ? 20 : 0
  ].reduce((total, value) => total + value, 0);
  const reasons = [];
  if (recent.length >= 3) reasons.push(`${recent.length} recent choices for this target`);
  if (lateNight) reasons.push("late-night risk window");
  if (budgetWarn) reasons.push("daily budget warning");
  if (budgetOver) reasons.push("daily budget spent");
  return {
    recentCount: recent.length,
    lateNight,
    budgetWarn,
    budgetOver,
    extraDelaySeconds,
    reasons,
    message: reasons.length ? reasons.join(" | ") : "Normal pause"
  };
}

function budgetSummary(rule: IntentionalUseRule, dayRule: IntentionalRuleLedger): BudgetSummary {
  const budgetSeconds = Math.max(0, Number(rule.dailyBudgetMinutes || 0)) * 60;
  const seconds = Math.round(dayRule.seconds || 0);
  return {
    seconds,
    budgetSeconds,
    remainingSeconds: budgetSeconds ? Math.max(0, budgetSeconds - seconds) : null,
    percent: budgetSeconds ? Math.min(999, Math.round((seconds / budgetSeconds) * 100)) : 0
  };
}

function recordOutcome(state: SentinelState, pause: IntentionalPause, outcome: string, now: Date): void {
  state.intentionalUse.outcomes.unshift({
    id: randomUUID(),
    pauseId: pause.id,
    ruleId: pause.ruleId,
    ruleName: pause.ruleName,
    outcome,
    targetType: pause.targetType,
    targetLabel: pause.targetLabel,
    app: pause.app || "",
    hostname: pause.hostname || "",
    intention: pause.intention || "",
    replacement: pause.replacement || "",
    mood: pause.mood || "",
    at: now.toISOString(),
    dateKey: dateKey(now),
    weekKey: weekKey(now)
  });
  state.intentionalUse.outcomes = state.intentionalUse.outcomes.slice(0, OUTCOME_LIMIT);
}

function ensureRuleLedger(state: SentinelState, ruleId: string, now: Date): IntentionalRuleLedger {
  const key = dateKey(now);
  state.intentionalUse.ledger[key] ||= { weekKey: weekKey(now), rules: {} };
  state.intentionalUse.ledger[key].rules[ruleId] ||= {
    seconds: 0,
    pauses: 0,
    continued: 0,
    skipped: 0,
    targets: {}
  };
  return state.intentionalUse.ledger[key].rules[ruleId];
}

function bumpRuleLedger(state: SentinelState, ruleId: string, key: "pauses" | "continued" | "skipped", now: Date): void {
  const dayRule = ensureRuleLedger(state, ruleId, now);
  dayRule[key] = (dayRule[key] || 0) + 1;
}

function ruleSummary(state: SentinelState, rule: IntentionalUseRule, now: Date) {
  const dayRule = ensureRuleLedger(state, rule.id, now);
  const budget = budgetSummary(rule, dayRule);
  return {
    ...rule,
    progress: {
      ...dayRule,
      budget,
      successRate: successRate(dayRule.skipped, dayRule.continued)
    },
    activeGrant: (state.intentionalUse.grants || []).find((grant) => grant.ruleId === rule.id && Date.parse(grant.until || "") > now.getTime()) || null,
    pendingPause: (state.intentionalUse.pauses || []).find((pause) => pause.ruleId === rule.id && pause.status === "pending" && Date.parse(pause.expiresAt || "") > now.getTime()) || null
  };
}

function recentOutcomes(state: SentinelState, sample: UsageSample, now: Date, minutes: number): IntentionalOutcome[] {
  const cutoff = now.getTime() - minutes * 60 * 1000;
  const label = targetLabel(sample);
  return (state.intentionalUse.outcomes || []).filter((item) => {
    return item.targetLabel === label && Date.parse(item.at || "") >= cutoff;
  }).slice(0, OPEN_LIMIT);
}

function topOutcomeTargets(state: SentinelState, day: string) {
  const outcomes = (state.intentionalUse.outcomes || []).filter((item) => item.dateKey === day);
  return topTargetsFromOutcomes(outcomes);
}

function topTargetsFromOutcomes(outcomes: IntentionalOutcome[]) {
  const counts = new Map<string, number>();
  for (const item of outcomes || []) {
    const label = item.targetLabel || "unknown";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function findPendingPause(state: SentinelState, requestId: string): IntentionalPause | null {
  return (state.intentionalUse.pauses || []).find((pause) => pause.id === requestId && pause.status === "pending") || null;
}

function targetLabel(sample: UsageSample): string {
  return sample.hostname ? normalizeHost(sample.hostname) : String(sample.app || "App").trim();
}

function pauseUrl(requestId: string): string {
  const url = new URL(`http://127.0.0.1:${PORT}/pause`);
  url.searchParams.set("requestId", requestId);
  return url.toString();
}

function safeReturnUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function isSentinelUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase()) && String(url.port || "80") === String(PORT);
  } catch {
    return false;
  }
}

function normalizeTargets(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return listFromTextarea(value);
}

function normalizeDays(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function normalizeClock(value: unknown): string {
  const text = String(value || "");
  return /^\d{2}:\d{2}$/.test(text) ? text : "00:00";
}

function successRate(skipped: number, continued: number): number {
  const total = skipped + continued;
  return total ? Math.round((skipped / total) * 100) : 0;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatMinutes(seconds: number): string {
  return `${Math.round((seconds || 0) / 60)}m`;
}
