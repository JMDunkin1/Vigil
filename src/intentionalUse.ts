import { randomUUID } from "node:crypto";
import { activeAppLockUnlockForSample } from "./appLocks.js";
import { DEFAULT_EXPLICIT_BLOCKED_SITES, DEFAULT_SHORT_FORM_URL_PATTERNS, PORT } from "./defaults.js";
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
  IntentionalBehavior,
  IntentionalBehaviorCheckIn,
  IntentionalJournalEntry,
  IntentionalOutcome,
  IntentionalPause,
  IntentionalRecoveryCheckIn,
  IntentionalRecoveryKind,
  IntentionalRecoveryStatus,
  IntentionalRuleLedger,
  IntentionalSosSession,
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
const JOURNAL_ENTRY_LIMIT = 250;
const BEHAVIOR_CHECK_IN_LIMIT = 500;
const RECOVERY_CHECK_IN_LIMIT = 500;
const SOS_SESSION_LIMIT = 100;
const RECOVERY_SETUP_RULE_ID = "porn-recovery-risk-pause";
const RECOVERY_CHECK_IN_BEHAVIOR_ID = "daily-recovery-check-in";
const RECOVERY_REPLACEMENT_BEHAVIOR_ID = "urge-replacement-loop";
const RECOVERY_RISK_SITES = [
  "reddit.com",
  "x.com",
  "twitter.com",
  "tumblr.com",
  "telegram.org",
  "discord.com",
  "onlyfans.com",
  "fansly.com"
];
const RECOVERY_RISK_URL_PATTERNS = [
  "porn",
  "nsfw",
  "xxx",
  "gonewild",
  "onlyfans",
  "fansly",
  ...DEFAULT_SHORT_FORM_URL_PATTERNS
];
const RECOVERY_DEFAULT_VALUES = ["Self-respect", "Sleep", "Real relationships", "Deep work"];
const RECOVERY_DEFAULT_REPLACEMENTS = [
  "Start the SOS reset",
  "Text or call the accountability partner",
  "Take a five-minute walk",
  "Open the journal and name the trigger",
  "Put the phone across the room"
];

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
    behaviors: normalizeBehaviors(current.behaviors || fresh.behaviors || []),
    behaviorCheckIns: normalizeBehaviorCheckIns(current.behaviorCheckIns || fresh.behaviorCheckIns || []).slice(0, BEHAVIOR_CHECK_IN_LIMIT),
    journalEntries: normalizeJournalEntries(current.journalEntries || fresh.journalEntries || []).slice(0, JOURNAL_ENTRY_LIMIT),
    recoveryCheckIns: normalizeRecoveryCheckIns(current.recoveryCheckIns || fresh.recoveryCheckIns || []).slice(0, RECOVERY_CHECK_IN_LIMIT),
    sosSessions: normalizeSosSessions(current.sosSessions || fresh.sosSessions || []).slice(0, SOS_SESSION_LIMIT),
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

export function upsertIntentionalBehavior(state: SentinelState, body: IntentionalBody = {}, now = new Date()): IntentionalBehavior {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.behaviors.find((behavior) => behavior.id === id);
  const behavior = normalizeBehavior(body, existing, id, now);
  if (existing) Object.assign(existing, behavior);
  else state.intentionalUse.behaviors.unshift(behavior);
  return behavior;
}

export function deleteIntentionalBehavior(state: SentinelState, behaviorId: string): IntentionalBehavior | null {
  ensureIntentionalUse(state);
  const behavior = state.intentionalUse.behaviors.find((item) => item.id === behaviorId);
  if (!behavior) return null;
  behavior.active = false;
  behavior.updatedAt = new Date().toISOString();
  return behavior;
}

export function addIntentionalJournalEntry(state: SentinelState, body: IntentionalBody = {}, now = new Date()): IntentionalJournalEntry {
  ensureIntentionalUse(state);
  const existing = body.id ? state.intentionalUse.journalEntries.find((entry) => entry.id === String(body.id)) : null;
  const entry = normalizeJournalEntry(body, existing || {}, String(body.id || randomUUID()), now);
  if (existing) Object.assign(existing, entry);
  else state.intentionalUse.journalEntries.unshift(entry);
  state.intentionalUse.journalEntries = state.intentionalUse.journalEntries.slice(0, JOURNAL_ENTRY_LIMIT);
  return entry;
}

export function deleteIntentionalJournalEntry(state: SentinelState, entryId: string): boolean {
  ensureIntentionalUse(state);
  const before = state.intentionalUse.journalEntries.length;
  state.intentionalUse.journalEntries = state.intentionalUse.journalEntries.filter((entry) => entry.id !== entryId);
  return state.intentionalUse.journalEntries.length !== before;
}

export function recordIntentionalBehaviorCheckIn(state: SentinelState, body: IntentionalBody = {}, now = new Date()): IntentionalBehaviorCheckIn {
  ensureIntentionalUse(state);
  const behaviorId = String(body.behaviorId || "");
  const behavior = state.intentionalUse.behaviors.find((item) => item.id === behaviorId && item.active !== false);
  if (!behavior) throw new IntentionalUseError("Behavior not found.", 404);
  const value = behavior.unit === "yes-no" ? (truthy(body.value) ? 1 : 0) : clampNumber(body.value, 0, 100000, 1);
  const checkIn: IntentionalBehaviorCheckIn = {
    id: randomUUID(),
    behaviorId: behavior.id,
    behaviorName: behavior.name,
    value,
    note: String(body.note || "").trim().slice(0, 500),
    at: now.toISOString(),
    dateKey: dateKey(now),
    weekKey: weekKey(now)
  };
  const journalEntryId = String(body.journalEntryId || "");
  if (journalEntryId) checkIn.journalEntryId = journalEntryId;
  state.intentionalUse.behaviorCheckIns.unshift(checkIn);
  state.intentionalUse.behaviorCheckIns = state.intentionalUse.behaviorCheckIns.slice(0, BEHAVIOR_CHECK_IN_LIMIT);
  return checkIn;
}

export function recordIntentionalRecoveryCheckIn(state: SentinelState, body: IntentionalBody = {}, now = new Date()): IntentionalRecoveryCheckIn {
  ensureIntentionalUse(state);
  const checkIn = normalizeRecoveryCheckIn({
    ...body,
    id: randomUUID(),
    at: now.toISOString(),
    dateKey: dateKey(now),
    weekKey: weekKey(now)
  });
  state.intentionalUse.recoveryCheckIns.unshift(checkIn);
  state.intentionalUse.recoveryCheckIns = state.intentionalUse.recoveryCheckIns.slice(0, RECOVERY_CHECK_IN_LIMIT);
  return checkIn;
}

export function startIntentionalSosSession(state: SentinelState, body: IntentionalBody = {}, now = new Date()) {
  ensureIntentionalUse(state);
  const intent = normalizeSosIntent(body.intent);
  const trigger = String(body.trigger || "").trim().slice(0, 240);
  const urgeIntensity = clampNumber(body.urgeIntensity, 0, 10, 7);
  const replacement = String(body.replacement || state.intentionalUse.goal?.replacements?.[0] || "Step away from the screen for five minutes").trim().slice(0, 160);
  const session: IntentionalSosSession = {
    id: randomUUID(),
    intent,
    trigger,
    urgeIntensity,
    reasonWhy: state.intentionalUse.goal?.statement || "Use screens on purpose, not by reflex.",
    replacement,
    plan: sosPlan(state, { intent, trigger, replacement }),
    startedAt: now.toISOString(),
    dateKey: dateKey(now),
    weekKey: weekKey(now)
  };
  state.intentionalUse.sosSessions.unshift(session);
  state.intentionalUse.sosSessions = state.intentionalUse.sosSessions.slice(0, SOS_SESSION_LIMIT);
  const checkIn = recordIntentionalRecoveryCheckIn(state, {
    kind: "sos",
    status: "urge",
    mood: intent,
    urgeIntensity,
    trigger,
    action: replacement,
    note: session.plan.join(" ")
  }, now);
  return { session, checkIn };
}

export function applyPornRecoverySetup(state: SentinelState, body: IntentionalBody = {}, now = new Date()) {
  ensureIntentionalUse(state);
  state.settings.intentionalUseEnabled = true;
  state.settings.contentFilterEnabled = true;
  state.settings.browserNoiseBlockingEnabled = true;
  const values = normalizeTargets(body.values);
  const replacements = normalizeTargets(body.replacements);
  state.intentionalUse.goal = normalizeGoal({
    statement: String(body.statement || state.intentionalUse.goal?.statement || "Stay clear, connected, and in control when urges hit."),
    values: values.length ? values : RECOVERY_DEFAULT_VALUES,
    replacements: replacements.length ? replacements : RECOVERY_DEFAULT_REPLACEMENTS,
    updatedAt: now.toISOString()
  });
  const rule = upsertIntentionalUseRule(state, {
    id: RECOVERY_SETUP_RULE_ID,
    name: "Recovery risk pause",
    enabled: true,
    frictionLevel: "strict",
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
    apps: [],
    sites: uniqueTargets([...RECOVERY_RISK_SITES, ...DEFAULT_EXPLICIT_BLOCKED_SITES]),
    urlPatterns: uniqueTargets(RECOVERY_RISK_URL_PATTERNS),
    delaySeconds: 30,
    sessionMinutes: 5,
    dailyBudgetMinutes: 10,
    budgetWarningPercent: 50,
    askMood: true
  });
  const checkInBehavior = upsertIntentionalBehavior(state, {
    id: RECOVERY_CHECK_IN_BEHAVIOR_ID,
    name: "Daily recovery check-in",
    description: "Record the day's urges, mood, sleep, and next right action.",
    direction: "build",
    unit: "yes-no",
    weeklyTarget: 7,
    ruleIds: [rule.id],
    replacement: "Use the Recovery Check-In before bed",
    active: true
  }, now);
  const replacementBehavior = upsertIntentionalBehavior(state, {
    id: RECOVERY_REPLACEMENT_BEHAVIOR_ID,
    name: "Urge replacement loop",
    description: "Choose a replacement action when the pull to explicit content shows up.",
    direction: "build",
    unit: "count",
    weeklyTarget: 3,
    ruleIds: [rule.id],
    replacement: "Step away, breathe, and do one planned replacement",
    active: true
  }, now);
  return { goal: state.intentionalUse.goal, rule, behaviors: [checkInBehavior, replacementBehavior] };
}

export function intentionalUseSummary(state: SentinelState, usage: UnknownRecord = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  const day = dateKey(now);
  const week = weekKey(now);
  const rules = state.intentionalUse.rules.map((rule) => ruleSummary(state, rule, now));
  const behaviorSummaries = state.intentionalUse.behaviors.map((behavior) => behaviorSummary(state, behavior, week));
  const journalEntries = [...(state.intentionalUse.journalEntries || [])]
    .sort((a, b) => Date.parse(b.entryDate || b.createdAt || "") - Date.parse(a.entryDate || a.createdAt || ""))
    .slice(0, 20);
  const journalThisWeek = journalEntriesForWeek(state, week);
  const behaviorCheckInsThisWeek = (state.intentionalUse.behaviorCheckIns || []).filter((entry) => entry.weekKey === week);
  const recovery = recoverySummary(state, now);
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
    lifeLog: {
      entries: journalEntries,
      behaviors: behaviorSummaries,
      recentCheckIns: (state.intentionalUse.behaviorCheckIns || []).slice(0, 20),
      stats: {
        weekKey: week,
        entriesThisWeek: journalThisWeek.length,
        totalEntries: state.intentionalUse.journalEntries.length,
        behaviorCheckInsThisWeek: behaviorCheckInsThisWeek.length,
        reflectionStreakDays: reflectionStreakDays(state, now),
        activeBehaviors: state.intentionalUse.behaviors.filter((behavior) => behavior.active !== false).length,
        recoveryCheckInsThisWeek: recovery.week.checkIns
      }
    },
    recovery,
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
  const recovery = recoverySummary(state, now);
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
    `Recovery check-ins: ${recovery.week.checkIns}`,
    `Victories: ${recovery.week.victories}`,
    `Setbacks: ${recovery.week.setbacks}`,
    `SOS starts: ${recovery.week.sos}`,
    `Top triggers: ${recovery.week.topTriggers.map((item) => `${item.label} x${item.count}`).join(", ") || "none"}`,
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
    recovery: recovery.week,
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
  state.intentionalUse.behaviors ||= [];
  state.intentionalUse.behaviorCheckIns ||= [];
  state.intentionalUse.journalEntries ||= [];
  state.intentionalUse.recoveryCheckIns ||= [];
  state.intentionalUse.sosSessions ||= [];
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

function normalizeBehaviors(behaviors: unknown): IntentionalBehavior[] {
  if (!Array.isArray(behaviors)) return [];
  return behaviors
    .filter(isUnknownRecord)
    .map((behavior) => normalizeBehavior(behavior, behavior, String(behavior.id || randomUUID())));
}

function normalizeBehavior(body: IntentionalBody = {}, existing: Partial<IntentionalBehavior> = {}, fallbackId: string = randomUUID(), now = new Date()): IntentionalBehavior {
  const direction = ["build", "reduce", "notice"].includes(String(body.direction || ""))
    ? body.direction as IntentionalBehavior["direction"]
    : existing.direction || "build";
  const unit = ["count", "minutes", "yes-no"].includes(String(body.unit || ""))
    ? body.unit as IntentionalBehavior["unit"]
    : existing.unit || "count";
  const createdAt = existing.createdAt || now.toISOString();
  return {
    id: String(body.id || existing.id || fallbackId),
    name: String(body.name || existing.name || "New behavior").trim().slice(0, 80),
    description: String(body.description || existing.description || "").trim().slice(0, 500),
    direction,
    unit,
    weeklyTarget: clampNumber(body.weeklyTarget ?? existing.weeklyTarget, 0, 100000, unit === "yes-no" ? 7 : 3),
    ruleIds: normalizeTargets(body.ruleIds ?? existing.ruleIds).slice(0, 20),
    replacement: String(body.replacement || existing.replacement || "").trim().slice(0, 160),
    active: body.active === undefined ? existing.active !== false : truthy(body.active),
    createdAt,
    updatedAt: now.toISOString()
  };
}

function normalizeBehaviorCheckIns(checkIns: unknown): IntentionalBehaviorCheckIn[] {
  if (!Array.isArray(checkIns)) return [];
  return checkIns
    .filter(isUnknownRecord)
    .map((checkIn) => normalizeBehaviorCheckIn(checkIn))
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
}

function normalizeBehaviorCheckIn(checkIn: UnknownRecord): IntentionalBehaviorCheckIn {
  const at = safeIsoDate(checkIn.at) || new Date().toISOString();
  return {
    id: String(checkIn.id || randomUUID()),
    behaviorId: String(checkIn.behaviorId || ""),
    behaviorName: String(checkIn.behaviorName || "Behavior").slice(0, 80),
    value: clampNumber(checkIn.value, 0, 100000, 1),
    note: String(checkIn.note || "").slice(0, 500),
    at,
    dateKey: String(checkIn.dateKey || dateKey(new Date(at))),
    weekKey: String(checkIn.weekKey || weekKey(new Date(at))),
    journalEntryId: checkIn.journalEntryId ? String(checkIn.journalEntryId) : undefined
  };
}

function normalizeJournalEntries(entries: unknown): IntentionalJournalEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter(isUnknownRecord)
    .map((entry) => normalizeJournalEntry(entry, entry, String(entry.id || randomUUID())))
    .sort((a, b) => Date.parse(b.entryDate || b.createdAt || "") - Date.parse(a.entryDate || a.createdAt || ""));
}

function normalizeJournalEntry(body: IntentionalBody = {}, existing: Partial<IntentionalJournalEntry> = {}, fallbackId: string = randomUUID(), now = new Date()): IntentionalJournalEntry {
  const createdAt = existing.createdAt || now.toISOString();
  const entryDate = safeIsoDate(body.entryDate) || existing.entryDate || now.toISOString();
  return {
    id: String(body.id || existing.id || fallbackId),
    title: String(body.title || existing.title || "Reflection").trim().slice(0, 120),
    body: String(body.body || existing.body || "").trim().slice(0, 8000),
    mood: String(body.mood || existing.mood || "").trim().slice(0, 80),
    energy: body.energy === "" || body.energy === null || body.energy === undefined
      ? existing.energy ?? null
      : clampNumber(body.energy, 1, 10, existing.energy ?? 5),
    tags: normalizeTargets(body.tags ?? existing.tags).slice(0, 20),
    behaviorIds: normalizeTargets(body.behaviorIds ?? existing.behaviorIds).slice(0, 20),
    ruleIds: normalizeTargets(body.ruleIds ?? existing.ruleIds).slice(0, 20),
    createdAt,
    updatedAt: now.toISOString(),
    entryDate
  };
}

function normalizeRecoveryCheckIns(checkIns: unknown): IntentionalRecoveryCheckIn[] {
  if (!Array.isArray(checkIns)) return [];
  return checkIns
    .filter(isUnknownRecord)
    .map((checkIn) => normalizeRecoveryCheckIn(checkIn))
    .sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
}

function normalizeRecoveryCheckIn(checkIn: UnknownRecord): IntentionalRecoveryCheckIn {
  const at = safeIsoDate(checkIn.at) || new Date().toISOString();
  const kindValue = String(checkIn.kind || "");
  const statusValue = String(checkIn.status || "");
  const kind: IntentionalRecoveryKind = ["daily", "sos", "manual"].includes(kindValue) ? kindValue as IntentionalRecoveryKind : "daily";
  const status: IntentionalRecoveryStatus = ["clean", "urge", "setback", "victory"].includes(statusValue)
    ? statusValue as IntentionalRecoveryStatus
    : "clean";
  return {
    id: String(checkIn.id || randomUUID()),
    kind,
    status,
    mood: String(checkIn.mood || "").trim().slice(0, 80),
    urgeIntensity: clampNumber(checkIn.urgeIntensity, 0, 10, 0),
    stress: optionalNumber(checkIn.stress, 0, 10),
    sleepHours: optionalNumber(checkIn.sleepHours, 0, 24),
    exerciseMinutes: optionalNumber(checkIn.exerciseMinutes, 0, 1440),
    trigger: String(checkIn.trigger || "").trim().slice(0, 240),
    action: String(checkIn.action || "").trim().slice(0, 240),
    note: String(checkIn.note || "").trim().slice(0, 1000),
    at,
    dateKey: String(checkIn.dateKey || dateKey(new Date(at))),
    weekKey: String(checkIn.weekKey || weekKey(new Date(at)))
  };
}

function normalizeSosSessions(sessions: unknown): IntentionalSosSession[] {
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter(isUnknownRecord)
    .map((session) => normalizeSosSession(session))
    .sort((a, b) => Date.parse(b.startedAt || "") - Date.parse(a.startedAt || ""));
}

function normalizeSosSession(session: UnknownRecord): IntentionalSosSession {
  const startedAt = safeIsoDate(session.startedAt) || new Date().toISOString();
  return {
    id: String(session.id || randomUUID()),
    intent: normalizeSosIntent(session.intent),
    trigger: String(session.trigger || "").trim().slice(0, 240),
    urgeIntensity: clampNumber(session.urgeIntensity, 0, 10, 7),
    reasonWhy: String(session.reasonWhy || "").trim().slice(0, 240),
    replacement: String(session.replacement || "").trim().slice(0, 160),
    plan: normalizeTargets(session.plan).slice(0, 8),
    startedAt,
    dateKey: String(session.dateKey || dateKey(new Date(startedAt))),
    weekKey: String(session.weekKey || weekKey(new Date(startedAt)))
  };
}

function behaviorSummary(state: SentinelState, behavior: IntentionalBehavior, currentWeekKey: string) {
  const checkIns = (state.intentionalUse.behaviorCheckIns || []).filter((entry) => entry.behaviorId === behavior.id);
  const weekly = checkIns.filter((entry) => entry.weekKey === currentWeekKey);
  const weeklyValue = weekly.reduce((total, entry) => total + Number(entry.value || 0), 0);
  const percent = behavior.weeklyTarget ? Math.min(100, Math.round((weeklyValue / behavior.weeklyTarget) * 100)) : 0;
  return {
    ...behavior,
    weeklyValue,
    weeklyCheckIns: weekly.length,
    percent,
    lastCheckInAt: checkIns[0]?.at || null
  };
}

function journalEntriesForWeek(state: SentinelState, currentWeekKey: string): IntentionalJournalEntry[] {
  return (state.intentionalUse.journalEntries || []).filter((entry) => weekKey(new Date(entry.entryDate || entry.createdAt)) === currentWeekKey);
}

function reflectionStreakDays(state: SentinelState, now: Date): number {
  const days = new Set((state.intentionalUse.journalEntries || []).map((entry) => dateKey(new Date(entry.entryDate || entry.createdAt))));
  let count = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  while (days.has(dateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function recoverySummary(state: SentinelState, now: Date) {
  ensureIntentionalUse(state);
  const day = dateKey(now);
  const week = weekKey(now);
  const checkIns = state.intentionalUse.recoveryCheckIns || [];
  const sosSessions = state.intentionalUse.sosSessions || [];
  const todayCheckIns = checkIns.filter((entry) => entry.dateKey === day);
  const weekCheckIns = checkIns.filter((entry) => entry.weekKey === week);
  const weekSos = sosSessions.filter((session) => session.weekKey === week);
  const cleanDays = cleanRecoveryDays(weekCheckIns);
  return {
    today: {
      checkIns: todayCheckIns.length,
      latest: todayCheckIns[0] || null,
      status: todayCheckIns[0]?.status || "none"
    },
    week: {
      weekKey: week,
      checkIns: weekCheckIns.length,
      cleanDays,
      victories: weekCheckIns.filter((entry) => entry.status === "victory").length,
      setbacks: weekCheckIns.filter((entry) => entry.status === "setback").length,
      urges: weekCheckIns.filter((entry) => entry.status === "urge").length,
      sos: weekSos.length,
      averageUrgeIntensity: average(weekCheckIns.map((entry) => entry.urgeIntensity)),
      averageStress: average(weekCheckIns.map((entry) => entry.stress).filter((value): value is number => value !== null)),
      averageSleepHours: average(weekCheckIns.map((entry) => entry.sleepHours).filter((value): value is number => value !== null)),
      exerciseMinutes: Math.round(weekCheckIns.reduce((total, entry) => total + Number(entry.exerciseMinutes || 0), 0)),
      topTriggers: topRecoveryTriggers(weekCheckIns)
    },
    recentCheckIns: checkIns.slice(0, 12),
    recentSos: sosSessions.slice(0, 5)
  };
}

function cleanRecoveryDays(checkIns: IntentionalRecoveryCheckIn[]): number {
  const byDay = new Map<string, IntentionalRecoveryCheckIn[]>();
  for (const entry of checkIns) {
    const items = byDay.get(entry.dateKey) || [];
    items.push(entry);
    byDay.set(entry.dateKey, items);
  }
  let count = 0;
  for (const entries of byDay.values()) {
    if (entries.some((entry) => entry.status === "setback")) continue;
    if (entries.some((entry) => ["clean", "victory"].includes(entry.status))) count += 1;
  }
  return count;
}

function topRecoveryTriggers(checkIns: IntentionalRecoveryCheckIn[]) {
  const counts = new Map<string, number>();
  for (const checkIn of checkIns) {
    for (const trigger of splitTags(checkIn.trigger)) {
      counts.set(trigger, (counts.get(trigger) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([label, count]) => ({ label, count }));
}

function splitTags(value: string): string[] {
  return String(value || "")
    .split(/[,|]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function sosPlan(state: SentinelState, { intent, trigger, replacement }: { intent: string; trigger: string; replacement: string }): string[] {
  const reason = state.intentionalUse.goal?.statement || "Use screens on purpose, not by reflex.";
  const values = state.intentionalUse.goal?.values || [];
  const steps = [
    intent === "sleep" ? "Dim the screen, leave the room, and start a short wind-down." : "Take ten slow breaths before touching the browser again.",
    `Remember why: ${reason}`,
    trigger ? `Name the trigger without arguing with it: ${trigger}.` : "Name the trigger in one sentence.",
    `Do this next: ${replacement}.`
  ];
  if (intent === "lift-mood") steps.push("Add a body reset: water, light, or a short walk.");
  if (intent === "distraction") steps.push("Open one planned replacement, then close the tempting tab.");
  if (values.length) steps.push(`Protect: ${values.slice(0, 3).join(", ")}.`);
  steps.push("If the urge is still high, start a strict lock or contact your partner.");
  return steps.slice(0, 8);
}

function normalizeSosIntent(value: unknown): string {
  const intent = String(value || "").trim().toLowerCase();
  return ["calm", "sleep", "lift-mood", "distraction", "unsure"].includes(intent) ? intent : "unsure";
}

function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  return clampNumber(value, min, max, min);
}

function average(values: number[]): number | null {
  const safe = values.filter((value) => Number.isFinite(value));
  if (!safe.length) return null;
  return Math.round((safe.reduce((total, value) => total + value, 0) / safe.length) * 10) / 10;
}

function uniqueTargets(values: unknown[]): string[] {
  return [...new Set(normalizeTargets(values))];
}

function safeIsoDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
  state.intentionalUse.behaviorCheckIns = (state.intentionalUse.behaviorCheckIns || []).slice(0, BEHAVIOR_CHECK_IN_LIMIT);
  state.intentionalUse.journalEntries = (state.intentionalUse.journalEntries || []).slice(0, JOURNAL_ENTRY_LIMIT);
  state.intentionalUse.recoveryCheckIns = (state.intentionalUse.recoveryCheckIns || []).slice(0, RECOVERY_CHECK_IN_LIMIT);
  state.intentionalUse.sosSessions = (state.intentionalUse.sosSessions || []).slice(0, SOS_SESSION_LIMIT);
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
