import { randomUUID } from "node:crypto";
import { activeAppLockUnlockForSample } from "./appLocks.js";
import { DEFAULT_EXPLICIT_BLOCKED_SITES, DEFAULT_EXPLICIT_URL_PATTERNS, DEFAULT_SHORT_FORM_URL_PATTERNS, PORT } from "./defaults.js";
import { truthy } from "./booleans.js";
import {
  appMatchesAppTargets,
  expandSiteTargets,
  hostMatchesSiteTargets,
  matchBlockedUrlPattern,
  normalizeDeviceTargets,
  normalizeHost,
  normalizeLockLevel
} from "./policy.js";
import { normalizeTextList as normalizeTargets, normalizeWeekdays as normalizeDays } from "./normalizers.js";
import { clampNumber, dateKey, parseClock, weekKey } from "./time.js";
import { behaviorSummary, journalEntriesForWeek, plannerSummary, recoverySummary, reflectionStreakDays, sosPlan } from "./intentionalUseSummary.js";
import { journalVaultSummary, normalizeJournalVaultState } from "./journalVault.js";
import type {
  IntentionalGrant,
  IntentionalBehavior,
  IntentionalBehaviorCheckIn,
  IntentionalJournalEntry,
  IntentionalPlanBlock,
  IntentionalPlanItem,
  IntentionalPlanItemStatus,
  IntentionalPlanList,
  IntentionalPlanListKind,
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
  VigilState,
  UnknownRecord,
  UsageSample
} from "./types.js";

const PAUSE_EVENTS = new Set(["navigation", "history", "activated", "mac-app"]);
const PAUSE_RESET_EVENTS = new Set(["navigation", "history"]);
const OUTCOME_LIMIT = 200;
const OPEN_LIMIT = 40;
const JOURNAL_ENTRY_LIMIT = 250;
const PLAN_LIST_LIMIT = 50;
const PLAN_ITEM_LIMIT = 1000;
const PLAN_BLOCK_LIMIT = 500;
const BEHAVIOR_CHECK_IN_LIMIT = 500;
const RECOVERY_CHECK_IN_LIMIT = 500;
const SOS_SESSION_LIMIT = 100;
const RECOVERY_SETUP_RULE_ID = "porn-recovery-risk-pause";
const RECOVERY_CHECK_IN_BEHAVIOR_ID = "daily-recovery-check-in";
const RECOVERY_REPLACEMENT_BEHAVIOR_ID = "urge-replacement-loop";
const RECOVERY_RISK_SITES = [
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
  ...DEFAULT_EXPLICIT_URL_PATTERNS,
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
    behaviors: normalizeBehaviors(mergeSeededBehaviors(fresh.behaviors, current.behaviors)),
    behaviorCheckIns: normalizeBehaviorCheckIns(current.behaviorCheckIns || fresh.behaviorCheckIns || []).slice(0, BEHAVIOR_CHECK_IN_LIMIT),
    journalEntries: normalizeJournalEntries(current.journalEntries || fresh.journalEntries || []).slice(0, JOURNAL_ENTRY_LIMIT),
    journalVault: normalizeJournalVaultState(current.journalVault || {}, fresh.journalVault || {}),
    planLists: normalizePlanLists(current.planLists || fresh.planLists || []).slice(0, PLAN_LIST_LIMIT),
    planItems: normalizePlanItems(current.planItems || fresh.planItems || []).slice(0, PLAN_ITEM_LIMIT),
    planBlocks: normalizePlanBlocks(current.planBlocks || fresh.planBlocks || []).slice(0, PLAN_BLOCK_LIMIT),
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
  if (id === "short-form-intent-template") {
    sites = sites.filter((site) => !isRedditSiteTarget(site));
    urlPatterns = uniqueTargets([
      ...urlPatterns.filter((pattern) => !isRedditWholeSitePattern(pattern)),
      ...DEFAULT_SHORT_FORM_URL_PATTERNS.filter(isRedditFeedPattern)
    ]);
  }
  if (id === RECOVERY_SETUP_RULE_ID) {
    sites = sites.filter((site) => !isRedditSiteTarget(site));
    urlPatterns = uniqueTargets([
      ...urlPatterns.filter((pattern) => !isRedditWholeSitePattern(pattern)),
      ...DEFAULT_EXPLICIT_URL_PATTERNS,
      ...DEFAULT_SHORT_FORM_URL_PATTERNS.filter(isRedditFeedPattern)
    ]);
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

export function upsertIntentionalUseRule(state: VigilState, body: IntentionalBody = {}): IntentionalUseRule {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.rules.find((rule) => rule.id === id);
  const rule = normalizeIntentionalUseRule(body, existing, id);
  if (existing) Object.assign(existing, rule);
  else state.intentionalUse.rules.push(rule);
  return rule;
}

export function updateIntentionalUseGoal(state: VigilState, body: IntentionalBody = {}): IntentionalUseGoal {
  ensureIntentionalUse(state);
  state.intentionalUse.goal = normalizeGoal({
    statement: String(body.statement || ""),
    values: normalizeTargets(body.values),
    replacements: normalizeTargets(body.replacements),
    updatedAt: new Date().toISOString()
  });
  return state.intentionalUse.goal;
}

export function updateIntentionalUseAccountability(state: VigilState, body: IntentionalBody = {}) {
  ensureIntentionalUse(state);
  state.intentionalUse.accountability = {
    ...state.intentionalUse.accountability,
    enabled: truthy(body.enabled),
    partnerName: String(body.partnerName || "").trim().slice(0, 80),
    cadence: ["daily", "weekly"].includes(String(body.cadence || "")) ? String(body.cadence) : "weekly"
  };
  return state.intentionalUse.accountability;
}

export function upsertIntentionalBehavior(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalBehavior {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.behaviors.find((behavior) => behavior.id === id);
  const behavior = normalizeBehavior(body, existing, id, now);
  if (existing) Object.assign(existing, behavior);
  else state.intentionalUse.behaviors.unshift(behavior);
  return behavior;
}

export function deleteIntentionalBehavior(state: VigilState, behaviorId: string): IntentionalBehavior | null {
  ensureIntentionalUse(state);
  const behavior = state.intentionalUse.behaviors.find((item) => item.id === behaviorId);
  if (!behavior) return null;
  behavior.active = false;
  behavior.updatedAt = new Date().toISOString();
  return behavior;
}

export function addIntentionalJournalEntry(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalJournalEntry {
  ensureIntentionalUse(state);
  const existing = body.id ? state.intentionalUse.journalEntries.find((entry) => entry.id === String(body.id)) : null;
  const entry = normalizeJournalEntry(body, existing || {}, String(body.id || randomUUID()), now);
  if (existing) Object.assign(existing, entry);
  else state.intentionalUse.journalEntries.unshift(entry);
  state.intentionalUse.journalEntries = state.intentionalUse.journalEntries.slice(0, JOURNAL_ENTRY_LIMIT);
  return entry;
}

export function deleteIntentionalJournalEntry(state: VigilState, entryId: string): boolean {
  ensureIntentionalUse(state);
  const before = state.intentionalUse.journalEntries.length;
  state.intentionalUse.journalEntries = state.intentionalUse.journalEntries.filter((entry) => entry.id !== entryId);
  return state.intentionalUse.journalEntries.length !== before;
}

export function upsertIntentionalPlanList(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalPlanList {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.planLists.find((list) => list.id === id);
  const list = normalizePlanList(body, existing, id, now);
  if (existing) Object.assign(existing, list);
  else state.intentionalUse.planLists.unshift(list);
  state.intentionalUse.planLists = state.intentionalUse.planLists.slice(0, PLAN_LIST_LIMIT);
  return list;
}

export function deleteIntentionalPlanList(state: VigilState, listId: string, now = new Date()): IntentionalPlanList | null {
  ensureIntentionalUse(state);
  const list = state.intentionalUse.planLists.find((item) => item.id === listId);
  if (!list) return null;
  list.active = false;
  list.updatedAt = now.toISOString();
  return list;
}

export function upsertIntentionalPlanItem(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalPlanItem {
  ensureIntentionalUse(state);
  ensureDefaultPlanList(state, now);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.planItems.find((item) => item.id === id);
  const item = normalizePlanItem(body, existing, id, now, defaultPlanListId(state));
  if (existing) Object.assign(existing, item);
  else state.intentionalUse.planItems.unshift(item);
  state.intentionalUse.planItems = state.intentionalUse.planItems.slice(0, PLAN_ITEM_LIMIT);
  return item;
}

export function deleteIntentionalPlanItem(state: VigilState, itemId: string, now = new Date()): IntentionalPlanItem | null {
  ensureIntentionalUse(state);
  const item = state.intentionalUse.planItems.find((entry) => entry.id === itemId);
  if (!item) return null;
  item.status = "archived";
  item.updatedAt = now.toISOString();
  item.completedAt ||= now.toISOString();
  return item;
}

export function upsertIntentionalPlanBlock(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalPlanBlock {
  ensureIntentionalUse(state);
  const id = String(body.id || randomUUID());
  const existing = state.intentionalUse.planBlocks.find((block) => block.id === id);
  const block = normalizePlanBlock(body, existing, id, now, state);
  if (existing) Object.assign(existing, block);
  else state.intentionalUse.planBlocks.unshift(block);
  state.intentionalUse.planBlocks = state.intentionalUse.planBlocks
    .sort((a, b) => Date.parse(a.startsAt || "") - Date.parse(b.startsAt || ""))
    .slice(0, PLAN_BLOCK_LIMIT);
  return block;
}

export function deleteIntentionalPlanBlock(state: VigilState, blockId: string): boolean {
  ensureIntentionalUse(state);
  const before = state.intentionalUse.planBlocks.length;
  state.intentionalUse.planBlocks = state.intentionalUse.planBlocks.filter((block) => block.id !== blockId);
  return state.intentionalUse.planBlocks.length !== before;
}

export function completeIntentionalPlanBlock(state: VigilState, blockId: string, now = new Date()): IntentionalPlanBlock | null {
  ensureIntentionalUse(state);
  const block = state.intentionalUse.planBlocks.find((item) => item.id === blockId);
  if (!block) return null;
  block.completed = true;
  block.updatedAt = now.toISOString();
  return block;
}

export function recordIntentionalBehaviorCheckIn(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalBehaviorCheckIn | null {
  ensureIntentionalUse(state);
  const behaviorId = String(body.behaviorId || "");
  const behavior = state.intentionalUse.behaviors.find((item) => item.id === behaviorId && item.active !== false);
  if (!behavior) throw new IntentionalUseError("Behavior not found.", 404);
  const checkInDateKey = normalizeBehaviorDateKey(body.dateKey, now);
  const existingIndex = state.intentionalUse.behaviorCheckIns.findIndex((item) => (
    item.behaviorId === behavior.id && item.dateKey === checkInDateKey
  ));
  if (truthy(body.clear)) {
    if (existingIndex >= 0) state.intentionalUse.behaviorCheckIns.splice(existingIndex, 1);
    return null;
  }
  const value = behavior.unit === "yes-no" ? (truthy(body.value) ? 1 : 0) : clampNumber(body.value, 0, 100000, 1);
  const checkInDate = checkInDateKey === dateKey(now) ? now : new Date(`${checkInDateKey}T12:00:00`);
  const checkIn: IntentionalBehaviorCheckIn = {
    id: existingIndex >= 0 ? state.intentionalUse.behaviorCheckIns[existingIndex].id : randomUUID(),
    behaviorId: behavior.id,
    behaviorName: behavior.name,
    value,
    note: String(body.note || "").trim().slice(0, 500),
    at: checkInDate.toISOString(),
    dateKey: checkInDateKey,
    weekKey: weekKey(checkInDate)
  };
  const journalEntryId = String(body.journalEntryId || "");
  if (journalEntryId) checkIn.journalEntryId = journalEntryId;
  if (existingIndex >= 0) state.intentionalUse.behaviorCheckIns.splice(existingIndex, 1);
  state.intentionalUse.behaviorCheckIns.unshift(checkIn);
  state.intentionalUse.behaviorCheckIns = normalizeBehaviorCheckIns(state.intentionalUse.behaviorCheckIns).slice(0, BEHAVIOR_CHECK_IN_LIMIT);
  return checkIn;
}

export function recordIntentionalRecoveryCheckIn(state: VigilState, body: IntentionalBody = {}, now = new Date()): IntentionalRecoveryCheckIn {
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

export function startIntentionalSosSession(state: VigilState, body: IntentionalBody = {}, now = new Date()) {
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

export function applyPornRecoverySetup(state: VigilState, body: IntentionalBody = {}, now = new Date()) {
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

export function intentionalUseSummary(state: VigilState, usage: UnknownRecord = {}, now = new Date()) {
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
  const planner = plannerSummary(state, now);
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
      entries: [],
      entriesLocked: true,
      journalVault: journalVaultSummary(state),
      behaviors: behaviorSummaries,
      planner,
      recentCheckIns: (state.intentionalUse.behaviorCheckIns || []).slice(0, 20),
      habitCheckIns: (state.intentionalUse.behaviorCheckIns || []).map((entry) => ({
        id: entry.id,
        behaviorId: entry.behaviorId,
        behaviorName: entry.behaviorName,
        value: entry.value,
        dateKey: entry.dateKey,
        at: entry.at
      })),
      stats: {
        weekKey: week,
        entriesThisWeek: journalThisWeek.length,
        totalEntries: state.intentionalUse.journalEntries.length,
        behaviorCheckInsThisWeek: behaviorCheckInsThisWeek.length,
        reflectionStreakDays: reflectionStreakDays(state, now),
        activeBehaviors: state.intentionalUse.behaviors.filter((behavior) => behavior.active !== false).length,
        openPlanItems: planner.openItems,
        activePlanBlocks: planner.activeBlocks.length,
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

export function intentionalUseDecision(state: VigilState, sample: UsageSample, options: IntentionalUseOptions = {}, now = new Date()) {
  ensureIntentionalUse(state);
  cleanupIntentionalUse(state, now);
  if (state.settings?.intentionalUseEnabled === false) return { shouldPause: false, reason: "disabled" };
  if (!PAUSE_EVENTS.has(String(options.event || ""))) return { shouldPause: false, reason: "event" };
  if (!sample?.app) return { shouldPause: false, reason: "sample" };
  if (isVigilUrl(sample.url)) return { shouldPause: false, reason: "vigil" };

  const rule = matchingRule(state, sample, now);
  if (!rule) return { shouldPause: false, reason: "no-rule" };
  const appLockUnlock = activeAppLockUnlockForSample(state, sample, now);
  if (appLockUnlock) return { shouldPause: false, reason: "app-lock-unlock", appLockUnlock, rule };

  const grant = activeIntentionalUseGrant(state, sample, rule, now);
  if (grant) return { shouldPause: false, reason: "grant", grant, rule };

  const existing = pendingPauseFor(state, sample, rule, now);
  if (existing) {
    refreshPendingPauseOnReentry(state, existing, rule, sample, options, now);
    return { shouldPause: true, rule, pause: existing, redirectUrl: pauseUrl(existing.id) };
  }

  const pause = createPause(state, rule, sample, options, now);
  return { shouldPause: true, rule, pause, redirectUrl: pauseUrl(pause.id) };
}

export function activeIntentionalUseGrant(state: VigilState, sample: UsageSample, rule: IntentionalUseRule | null = null, now = new Date()): IntentionalGrant | null {
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

export function recordIntentionalUseTime(state: VigilState, sample: UsageSample, seconds: number, now = new Date()): IntentionalGrant | null {
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

export function confirmIntentionalPause(state: VigilState, requestId: string, body: IntentionalBody = {}, now = new Date()) {
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

export function skipIntentionalPause(state: VigilState, requestId: string, body: IntentionalBody = {}, now = new Date()) {
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

export function pausePageData(state: VigilState, requestId: string, now = new Date()) {
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

export function accountabilityDigest(state: VigilState, _usage: UnknownRecord = {}, now = new Date()) {
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
    `Vigil accountability digest for ${key}`,
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

function ensureIntentionalUse(state: VigilState): void {
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
  state.intentionalUse.journalVault ||= normalizeJournalVaultState();
  state.intentionalUse.planLists ||= [];
  state.intentionalUse.planItems ||= [];
  state.intentionalUse.planBlocks ||= [];
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

function mergeSeededBehaviors(seedBehaviors: unknown, currentBehaviors: unknown): unknown[] {
  const seeds = Array.isArray(seedBehaviors) ? seedBehaviors.filter(isUnknownRecord) : [];
  const current = Array.isArray(currentBehaviors) ? currentBehaviors.filter(isUnknownRecord) : [];
  const currentIds = new Set(current.map((behavior) => String(behavior.id || "")).filter(Boolean));
  return [...current, ...seeds.filter((behavior) => !currentIds.has(String(behavior.id || "")))];
}

function normalizeBehaviorDateKey(value: unknown, now: Date): string {
  const requested = String(value || "").trim();
  if (!requested) return dateKey(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(requested)) {
    throw new IntentionalUseError("Behavior date must use YYYY-MM-DD.");
  }
  const parsed = new Date(`${requested}T12:00:00`);
  if (!Number.isFinite(parsed.getTime()) || dateKey(parsed) !== requested) {
    throw new IntentionalUseError("Behavior date is invalid.");
  }
  const today = new Date(`${dateKey(now)}T12:00:00`);
  const ageDays = Math.round((today.getTime() - parsed.getTime()) / 86_400_000);
  if (ageDays < 0) throw new IntentionalUseError("Future behavior check-ins are not allowed.");
  if (ageDays > 400) throw new IntentionalUseError("Behavior check-ins can be backdated up to 400 days.");
  return requested;
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

function normalizePlanLists(lists: unknown): IntentionalPlanList[] {
  if (!Array.isArray(lists)) return [];
  return lists
    .filter(isUnknownRecord)
    .map((list) => normalizePlanList(list, list, String(list.id || randomUUID())))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
}

function normalizePlanList(body: IntentionalBody = {}, existing: Partial<IntentionalPlanList> = {}, fallbackId: string = randomUUID(), now = new Date()): IntentionalPlanList {
  const createdAt = existing.createdAt || now.toISOString();
  return {
    id: String(body.id || existing.id || fallbackId),
    name: String(body.name || existing.name || "List").trim().slice(0, 80),
    kind: normalizePlanListKind(body.kind || existing.kind),
    description: String(bodyValue(body, "description", existing.description || "")).trim().slice(0, 500),
    active: body.active === undefined ? existing.active !== false : truthy(body.active),
    createdAt,
    updatedAt: now.toISOString()
  };
}

function normalizePlanItems(items: unknown): IntentionalPlanItem[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter(isUnknownRecord)
    .map((item) => normalizePlanItem(item, item, String(item.id || randomUUID())))
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || "") - Date.parse(a.updatedAt || a.createdAt || ""));
}

function normalizePlanItem(
  body: IntentionalBody = {},
  existing: Partial<IntentionalPlanItem> = {},
  fallbackId: string = randomUUID(),
  now = new Date(),
  fallbackListId = ""
): IntentionalPlanItem {
  const createdAt = existing.createdAt || now.toISOString();
  const status = normalizePlanItemStatus(body.status || existing.status);
  const completedAt = status === "done" || status === "archived"
    ? (safeIsoDate(body.completedAt) || existing.completedAt || now.toISOString())
    : null;
  const dueAt = Object.hasOwn(body, "dueAt") ? safeIsoDate(body.dueAt) : existing.dueAt || null;
  return {
    id: String(body.id || existing.id || fallbackId),
    listId: String(body.listId || existing.listId || fallbackListId || "todo"),
    title: String(body.title || existing.title || "New item").trim().slice(0, 160),
    notes: String(bodyValue(body, "notes", existing.notes || "")).trim().slice(0, 2000),
    status,
    dueAt,
    tags: normalizeTargets(body.tags ?? existing.tags).slice(0, 20),
    createdAt,
    updatedAt: now.toISOString(),
    completedAt
  };
}

function normalizePlanBlocks(blocks: unknown): IntentionalPlanBlock[] {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter(isUnknownRecord)
    .map((block) => normalizePlanBlock(block, block, String(block.id || randomUUID())))
    .sort((a, b) => Date.parse(a.startsAt || "") - Date.parse(b.startsAt || ""));
}

function normalizePlanBlock(
  body: IntentionalBody = {},
  existing: Partial<IntentionalPlanBlock> = {},
  fallbackId: string = randomUUID(),
  now = new Date(),
  state?: VigilState
): IntentionalPlanBlock {
  const createdAt = existing.createdAt || now.toISOString();
  const startIso = safeIsoDate(body.startsAt) || safeIsoDate(existing.startsAt) || now.toISOString();
  const parsedStartMs = Date.parse(startIso);
  const startMs = Number.isFinite(parsedStartMs) ? parsedStartMs : now.getTime();
  const requestedEnd = safeIsoDate(body.endsAt) || existing.endsAt || "";
  const rawEndMs = Date.parse(requestedEnd);
  const maxEndMs = startMs + 24 * 60 * 60 * 1000;
  const endMs = Number.isFinite(rawEndMs) && rawEndMs > startMs
    ? Math.min(rawEndMs, maxEndMs)
    : startMs + 60 * 60 * 1000;
  const fallbackProfileId = state?.settings?.activeProfileId || existing.profileId || "default";
  const enabled = body.enabled === undefined ? existing.enabled !== false : truthy(body.enabled);
  return {
    id: String(body.id || existing.id || fallbackId),
    title: String(body.title || existing.title || "Focus block").trim().slice(0, 160),
    notes: String(bodyValue(body, "notes", existing.notes || "")).trim().slice(0, 2000),
    listId: String(bodyValue(body, "listId", existing.listId || "")),
    itemId: String(bodyValue(body, "itemId", existing.itemId || "")),
    startsAt: new Date(startMs).toISOString(),
    endsAt: new Date(endMs).toISOString(),
    enabled,
    completed: body.completed === undefined ? Boolean(existing.completed) : truthy(body.completed),
    mode: String(body.mode || existing.mode || "focus").trim().slice(0, 80),
    profileId: String(body.profileId || existing.profileId || fallbackProfileId),
    lockLevel: normalizeLockLevel(body.lockLevel, existing.lockLevel || "deep"),
    commitmentLock: body.commitmentLock === undefined ? Boolean(existing.commitmentLock) : truthy(body.commitmentLock),
    deviceTargets: normalizeDeviceTargets(body.deviceTargets ?? existing.deviceTargets),
    createdAt,
    updatedAt: now.toISOString()
  };
}

function bodyValue(body: IntentionalBody, key: string, fallback: unknown): unknown {
  return Object.hasOwn(body, key) ? body[key] : fallback;
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

function normalizeSosIntent(value: unknown): string {
  const intent = String(value || "").trim().toLowerCase();
  return ["calm", "sleep", "lift-mood", "distraction", "unsure"].includes(intent) ? intent : "unsure";
}

function optionalNumber(value: unknown, min: number, max: number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  return clampNumber(value, min, max, min);
}

function uniqueTargets(values: unknown[]): string[] {
  return [...new Set(normalizeTargets(values))];
}

function safeIsoDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function normalizePlanListKind(value: unknown): IntentionalPlanListKind {
  const kind = String(value || "").trim().toLowerCase();
  return ["todo", "watch", "read", "custom"].includes(kind) ? kind as IntentionalPlanListKind : "custom";
}

function normalizePlanItemStatus(value: unknown): IntentionalPlanItemStatus {
  const status = String(value || "").trim().toLowerCase();
  return ["open", "done", "archived"].includes(status) ? status as IntentionalPlanItemStatus : "open";
}

function ensureDefaultPlanList(state: VigilState, now = new Date()): void {
  if ((state.intentionalUse.planLists || []).some((list) => list.active !== false)) return;
  state.intentionalUse.planLists ||= [];
  state.intentionalUse.planLists.push({
    id: "todo",
    name: "To Do",
    kind: "todo",
    description: "Tasks and commitments to do soon.",
    active: true,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString()
  });
}

function defaultPlanListId(state: VigilState): string {
  return (state.intentionalUse.planLists || []).find((list) => list.active !== false)?.id || "todo";
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanupIntentionalUse(state: VigilState, now: Date): void {
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
  state.intentionalUse.planLists = normalizePlanLists(state.intentionalUse.planLists || []).slice(0, PLAN_LIST_LIMIT);
  state.intentionalUse.planItems = normalizePlanItems(state.intentionalUse.planItems || []).slice(0, PLAN_ITEM_LIMIT);
  state.intentionalUse.planBlocks = normalizePlanBlocks(state.intentionalUse.planBlocks || []).slice(0, PLAN_BLOCK_LIMIT);
  state.intentionalUse.recoveryCheckIns = (state.intentionalUse.recoveryCheckIns || []).slice(0, RECOVERY_CHECK_IN_LIMIT);
  state.intentionalUse.sosSessions = (state.intentionalUse.sosSessions || []).slice(0, SOS_SESSION_LIMIT);
}

function matchingRule(state: VigilState, sample: UsageSample, now: Date): IntentionalUseRule | null {
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

function pendingPauseFor(state: VigilState, sample: UsageSample, rule: IntentionalUseRule, now: Date): IntentionalPause | null {
  const label = targetLabel(sample);
  return (state.intentionalUse.pauses || []).find((pause) => {
    return pause.status === "pending"
      && pause.ruleId === rule.id
      && pause.targetLabel === label
      && Date.parse(pause.expiresAt || "") > now.getTime();
  }) || null;
}

function refreshPendingPauseOnReentry(
  state: VigilState,
  pause: IntentionalPause,
  rule: IntentionalUseRule,
  sample: UsageSample,
  options: IntentionalUseOptions,
  now: Date
): void {
  const event = String(options.event || "");
  if (!PAUSE_RESET_EVENTS.has(event)) return;

  const dayRule = ensureRuleLedger(state, rule.id, now);
  const budget = budgetSummary(rule, dayRule);
  const context = contextSummary(state, rule, sample, budget, now);
  const delaySeconds = adaptiveDelay(rule, context);

  pause.requestedAt = now.toISOString();
  pause.eligibleAt = new Date(now.getTime() + delaySeconds * 1000).toISOString();
  pause.expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
  pause.delaySeconds = delaySeconds;
  pause.sessionMinutes = rule.sessionMinutes;
  pause.frictionLevel = rule.frictionLevel;
  pause.returnUrl = safeReturnUrl(options.returnUrl || sample.url);
  pause.event = event;
  pause.context = context;
  pause.budget = budget;
}

function createPause(state: VigilState, rule: IntentionalUseRule, sample: UsageSample, options: IntentionalUseOptions, now: Date): IntentionalPause {
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

function contextSummary(state: VigilState, rule: IntentionalUseRule, sample: UsageSample, budget: BudgetSummary, now: Date): PauseContext {
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

function recordOutcome(state: VigilState, pause: IntentionalPause, outcome: string, now: Date): void {
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

function ensureRuleLedger(state: VigilState, ruleId: string, now: Date): IntentionalRuleLedger {
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

function bumpRuleLedger(state: VigilState, ruleId: string, key: "pauses" | "continued" | "skipped", now: Date): void {
  const dayRule = ensureRuleLedger(state, ruleId, now);
  dayRule[key] = (dayRule[key] || 0) + 1;
}

function ruleSummary(state: VigilState, rule: IntentionalUseRule, now: Date) {
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

function recentOutcomes(state: VigilState, sample: UsageSample, now: Date, minutes: number): IntentionalOutcome[] {
  const cutoff = now.getTime() - minutes * 60 * 1000;
  const label = targetLabel(sample);
  return (state.intentionalUse.outcomes || []).filter((item) => {
    return item.targetLabel === label && Date.parse(item.at || "") >= cutoff;
  }).slice(0, OPEN_LIMIT);
}

function topOutcomeTargets(state: VigilState, day: string) {
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

function findPendingPause(state: VigilState, requestId: string): IntentionalPause | null {
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

function isVigilUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase()) && String(url.port || "80") === String(PORT);
  } catch {
    return false;
  }
}

function isRedditSiteTarget(value: unknown): boolean {
  return ["reddit.com", "redd.it"].includes(normalizeHost(value));
}

function isRedditWholeSitePattern(value: unknown): boolean {
  const pattern = normalizeUrlTarget(value);
  return pattern === "reddit.com" || pattern === "redd.it";
}

function isRedditFeedPattern(value: unknown): boolean {
  const pattern = normalizeUrlTarget(value);
  return pattern === "reddit.com/r/all"
    || pattern === "reddit.com/r/popular"
    || pattern.startsWith("reddit.com/r/all/")
    || pattern.startsWith("reddit.com/r/popular/");
}

function normalizeUrlTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "")
    .replace(/\/+$/, "");
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
