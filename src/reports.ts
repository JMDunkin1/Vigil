import { dateKey, weekKey } from "./time.js";
import { appMatchesAppTargets, hostMatchesSiteTargets } from "./policy.js";
import { intentionalUseSummary } from "./intentionalUse.js";
import { normalizeUsageDay, usageBlockedSeconds, usageDeviceScreenTimeSeconds, usageOpenCount } from "./usage.js";
import type { VigilState, UsageBucket, UsageDay, UsageState } from "./types.js";

interface DayReport {
  key: string;
  label: string;
  totalSeconds: number;
  distractingSeconds: number;
  savedSeconds: number | null;
  openCount: number;
  focusScore: number;
  apps: Record<string, number>;
  sites: Record<string, number>;
  opens: UsageBucket["opens"];
  devices: {
    computerSeconds: number | null;
    phoneSeconds: number | null;
  };
  tracked: boolean;
}

interface WeekAggregate {
  totalSeconds: number;
  distractingSeconds: number;
  savedSeconds: number | null;
  openCount: number;
  trackedDays: number;
  averageFocusScore: number;
  averageDailyDistractionSeconds: number;
  averageDailyOpens: number;
}

interface FocusStreak {
  days: number;
  goal: number;
  label: string;
}

interface Milestone {
  id: string;
  label: string;
  achieved: boolean;
}

interface ProgressionBadge {
  id: string;
  label: string;
  earned: boolean;
}

interface ProgressionSummary {
  level: number;
  title: string;
  xp: number;
  currentLevelXp: number;
  nextLevelXp: number;
  levelProgressPercent: number;
  brainHealth: number;
  brainState: string;
  cleanDays: number;
  replacementChoices: number;
  continuedChoices: number;
  journalEntries: number;
  behaviorCheckIns: number;
  recoveryCheckIns: number;
  sosStarts: number;
  setbacks: number;
  reflectionStreakDays: number;
  standingScore: number;
  standingTitle: string;
  standingDirection: "rising" | "holding" | "falling";
  armorTier: number;
  nextUnlock: string;
  badges: ProgressionBadge[];
}

interface Culprit {
  name: string;
  seconds: number;
  kind: "site" | "app";
}

export function focusReport(usage: UsageState, state: VigilState, now = new Date()) {
  const today = startOfDay(now);
  const weekStart = startOfWeek(today);
  const previousWeekStart = addDays(weekStart, -7);
  const previousWeekEnd = addDays(weekStart, -1);
  const baselineSeconds = (state.settings.baselineDailyMinutes || 300) * 60;
  const focusScoreGoal = state.settings.focusScoreGoal || 80;
  const trustedTimelineActive = Object.values(usage).some(usageDayHasComputerSegments);
  const currentDays = rangeDays(weekStart, 7).map((date) => dayReport(usage, state, date, trustedTimelineActive));
  const previousDays = rangeDays(previousWeekStart, 7).map((date) => dayReport(usage, state, date, trustedTimelineActive));
  const current = aggregateWeek(currentDays);
  const previous = aggregateWeek(previousDays);
  const allDays = rangeDays(addDays(today, -60), 61).map((date) => dayReport(usage, state, date, trustedTimelineActive));
  const streak = focusStreak(allDays, focusScoreGoal, today);
  const topCulprits = topCombined(currentDays, state, "sites")
    .concat(topCombined(currentDays, state, "apps"))
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, 6);
  const bestDay = bestTrackedDay(currentDays);
  const worstDay = worstTrackedDay(currentDays);
  const intentionalUse = intentionalUseSummary(state, usage, now);
  const progression = progressionSummary({ state, current, streak, allDays, intentionalUse, focusScoreGoal, now });
  const milestones = buildMilestones({ state, current, streak, allDays, focusScoreGoal, progression });

  return {
    generatedAt: now.toISOString(),
    focusScoreGoal,
    baselineDailySeconds: baselineSeconds,
    currentWeek: {
      startsAt: weekStart.toISOString(),
      endsAt: addDays(weekStart, 6).toISOString(),
      days: currentDays,
      totals: current,
      bestDay,
      worstDay
    },
    previousWeek: {
      startsAt: previousWeekStart.toISOString(),
      endsAt: previousWeekEnd.toISOString(),
      totals: previous
    },
    comparison: compareWeeks(current, previous),
    timeline: allDays,
    streak,
    progression,
    milestones,
    intentionalUse,
    topCulprits,
    projections: projections(),
    insights: insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal, intentionalUse })
  };
}

function dayReport(usage: UsageState, state: VigilState, date: Date, trustedTimelineActive: boolean): DayReport {
  const key = dateKey(date);
  const rawDay = usage[key];
  const day = reportUsageDay(rawDay, trustedTimelineActive);
  const distractingSeconds = usageBlockedSeconds(day, state);
  const totalSeconds = day.totalSeconds || 0;
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / Math.max(totalSeconds, 1)) * 100)) : 100;
  return {
    key,
    label: date.toLocaleDateString(undefined, { weekday: "short" }),
    totalSeconds: Math.round(totalSeconds),
    distractingSeconds: Math.round(distractingSeconds),
    savedSeconds: null,
    openCount: usageOpenCount(day),
    focusScore,
    apps: day.apps,
    sites: day.sites,
    opens: day.opens,
    devices: {
      computerSeconds: usageDeviceScreenTimeSeconds(day, "computer"),
      phoneSeconds: usageDeviceScreenTimeSeconds(day, "phone")
    },
    tracked: totalSeconds > 0
  };
}

function reportUsageDay(day: UsageDay | undefined, trustedTimelineActive: boolean): UsageDay {
  if (!trustedTimelineActive || usageDayHasComputerSegments(day)) return normalizeUsageDay(day);
  const phone = day?.devices?.phone;
  return normalizeUsageDay(phone ? { devices: { phone } } : {});
}

function usageDayHasComputerSegments(day: UsageState[string] | undefined): boolean {
  return Boolean(day?.devices?.computer?.segments?.length);
}

function aggregateWeek(days: DayReport[]): WeekAggregate {
  const trackedDays = days.filter((day) => day.tracked);
  const totalSeconds = sum(days, "totalSeconds");
  const distractingSeconds = sum(days, "distractingSeconds");
  return {
    totalSeconds,
    distractingSeconds,
    savedSeconds: null,
    openCount: sum(days, "openCount"),
    trackedDays: trackedDays.length,
    averageFocusScore: trackedDays.length ? Math.round(sum(trackedDays, "focusScore") / trackedDays.length) : 100,
    averageDailyDistractionSeconds: trackedDays.length ? Math.round(distractingSeconds / trackedDays.length) : 0,
    averageDailyOpens: trackedDays.length ? Math.round(sum(trackedDays, "openCount") / trackedDays.length) : 0
  };
}

function compareWeeks(current: WeekAggregate, previous: WeekAggregate) {
  return {
    savedSecondsDelta: null,
    distractingSecondsDelta: current.distractingSeconds - previous.distractingSeconds,
    distractingPercentDelta: percentDelta(current.distractingSeconds, previous.distractingSeconds),
    focusScoreDelta: current.averageFocusScore - previous.averageFocusScore,
    trackedDaysDelta: current.trackedDays - previous.trackedDays
  };
}

function percentDelta(current: number, previous: number): number | null {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function focusStreak(days: DayReport[], goal: number, today: Date): FocusStreak {
  let count = 0;
  const reversed = [...days].reverse();
  for (const day of reversed) {
    if (new Date(`${day.key}T00:00:00`).getTime() > startOfDay(today).getTime()) continue;
    const passes = day.tracked ? day.focusScore >= goal : false;
    if (!passes) break;
    count += 1;
  }
  return {
    days: count,
    goal,
    label: count === 1 ? "1 day" : `${count} days`
  };
}

function buildMilestones({ state, current, streak, allDays, focusScoreGoal, progression }: {
  state: VigilState;
  current: WeekAggregate;
  streak: FocusStreak;
  allDays: DayReport[];
  focusScoreGoal: number;
  progression: ProgressionSummary;
}): Milestone[] {
  const enabledRules = [
    ...(state.schedules || []).filter((item) => item.enabled),
    ...(state.intentionalUse?.planBlocks || []).filter((item) => item.enabled !== false && !item.completed),
    ...(state.limitRules || []).filter((item) => item.enabled),
    ...(state.appLocks || []).filter((item) => item.enabled)
  ].length;
  const events = state.events || [];
  const hasCleanTrackedDay = allDays.some((day) => day.tracked && day.distractingSeconds === 0);
  return [
    milestone("first-lock", "First lock", events.some((event) => event.type === "session_started")),
    milestone("rules-enabled", "Rules armed", enabledRules >= 1),
    milestone("clean-tracked-day", "Clean tracked day", hasCleanTrackedDay),
    milestone("first-reflection", "First reflection", (state.intentionalUse?.journalEntries || []).length >= 1),
    milestone("behavior-tracked", "Track a behavior", (state.intentionalUse?.behaviorCheckIns || []).length >= 1),
    milestone("low-distraction-week", "Low distraction week", current.trackedDays >= 3 && current.averageDailyDistractionSeconds <= 30 * 60),
    milestone("three-day-streak", "3 day streak", streak.days >= 3),
    milestone("seven-day-streak", "7 day streak", streak.days >= 7),
    milestone("level-three", "Reach level 3", progression.level >= 3),
    milestone("level-five", "Reach level 5", progression.level >= 5),
    milestone("brain-health-80", "Brain health 80", progression.brainHealth >= 80),
    milestone("strong-week", "Strong week", current.trackedDays >= 5 && current.averageFocusScore >= focusScoreGoal)
  ];
}

function progressionSummary({ state, current, streak, allDays, intentionalUse, focusScoreGoal, now }: {
  state: VigilState;
  current: WeekAggregate;
  streak: FocusStreak;
  allDays: DayReport[];
  intentionalUse: ReturnType<typeof intentionalUseSummary>;
  focusScoreGoal: number;
  now: Date;
}): ProgressionSummary {
  const trackedDays = allDays.filter((day) => day.tracked);
  const cleanDays = trackedDays.filter((day) => day.distractingSeconds === 0).length;
  const outcomes = state.intentionalUse?.outcomes || [];
  const replacementChoices = outcomes.filter((item) => item.outcome === "skipped").length;
  const continuedChoices = outcomes.filter((item) => item.outcome === "continued").length;
  const journalEntries = state.intentionalUse?.journalEntries || [];
  const behaviorCheckIns = state.intentionalUse?.behaviorCheckIns || [];
  const recoveryCheckIns = state.intentionalUse?.recoveryCheckIns || [];
  const sosSessions = state.intentionalUse?.sosSessions || [];
  const currentWeek = weekKey(now);
  const weeklyRecovery = recoveryCheckIns.filter((entry) => entry.weekKey === currentWeek);
  const weeklySetbacks = weeklyRecovery.filter((entry) => entry.status === "setback").length;
  const weeklyVictories = weeklyRecovery.filter((entry) => entry.status === "victory").length;
  const reflectionStreak = reflectionStreakDays(state, now);
  const xp = Math.max(0, Math.round(
    trackedDays.reduce((total, day) => total + 30 + day.focusScore + (day.focusScore >= focusScoreGoal ? 50 : 0) + (day.distractingSeconds === 0 ? 30 : 0), 0)
    + replacementChoices * 35
    + continuedChoices * 8
    + journalEntries.length * 20
    + behaviorCheckIns.length * 15
    + recoveryCheckIns.length * 18
    + sosSessions.length * 12
    + weeklyVictories * 25
    + reflectionStreak * 10
    + streak.days * 30
    + current.trackedDays * 20
  ));
  const levelState = levelFromXp(xp);
  const intentionalToday = intentionalUse.today || {};
  const replacementRate = successRate(Number(intentionalToday.skipped || 0), Number(intentionalToday.continued || 0));
  const pressurePenalty = Math.min(20, Math.round((current.averageDailyOpens || 0) * 1.5));
  const brainHealth = clamp(
    Math.round(
      (current.trackedDays ? current.averageFocusScore : 50)
      + Math.min(14, streak.days * 2)
      + Math.round(replacementRate * 0.12)
      + Math.min(8, weeklyVictories * 2)
      - pressurePenalty
      - Math.min(18, weeklySetbacks * 6)
    ),
    0,
    100
  );
  const badges = [
    badge("first-save", "First clean day", cleanDays >= 1),
    badge("first-reflection", "First reflection", journalEntries.length >= 1),
    badge("behavior-builder", "Behavior builder", behaviorCheckIns.length >= 5),
    badge("daily-check-in", "3 recovery check-ins", recoveryCheckIns.length >= 3),
    badge("sos-used", "SOS reset", sosSessions.length >= 1),
    badge("reflection-streak", "3 day reflection", reflectionStreak >= 3),
    badge("replacement-loop", "Replacement loop", replacementChoices >= 3),
    badge("streak-3", "3 day streak", streak.days >= 3),
    badge("streak-7", "7 day streak", streak.days >= 7),
    badge("level-5", "Level 5", levelState.level >= 5)
  ];
  const standingDirection = previousStandingDirection(current, allDays);
  const standing = standingFromScore(brainHealth);

  return {
    ...levelState,
    brainHealth,
    brainState: brainHealth >= 85 ? "Clear" : brainHealth >= 65 ? "Recovering" : brainHealth >= 40 ? "Fragile" : "Overloaded",
    cleanDays,
    replacementChoices,
    continuedChoices,
    journalEntries: journalEntries.length,
    behaviorCheckIns: behaviorCheckIns.length,
    recoveryCheckIns: recoveryCheckIns.length,
    sosStarts: sosSessions.length,
    setbacks: weeklySetbacks,
    reflectionStreakDays: reflectionStreak,
    standingScore: brainHealth,
    standingTitle: standing.title,
    standingDirection,
    armorTier: standing.armorTier,
    nextUnlock: nextUnlock({ streakDays: streak.days, cleanDays, level: levelState.level, replacementChoices, journalEntries: journalEntries.length, behaviorCheckIns: behaviorCheckIns.length, recoveryCheckIns: recoveryCheckIns.length, sosStarts: sosSessions.length }),
    badges
  };
}

function levelFromXp(xp: number) {
  let level = 1;
  let floor = 0;
  let needed = 300;
  while (xp >= floor + needed && level < 99) {
    floor += needed;
    level += 1;
    needed = Math.round(needed * 1.22 + 60);
  }
  const currentLevelXp = Math.max(0, xp - floor);
  const nextLevelXp = Math.max(1, needed);
  return {
    level,
    title: levelTitle(level),
    xp,
    currentLevelXp,
    nextLevelXp,
    levelProgressPercent: Math.min(100, Math.max(4, Math.round((currentLevelXp / nextLevelXp) * 100)))
  };
}

function levelTitle(level: number): string {
  if (level >= 15) return "Defender of the Gate";
  if (level >= 10) return "Banner Knight";
  if (level >= 7) return "Knight of the Cross";
  if (level >= 4) return "Armed Squire";
  if (level >= 2) return "Page";
  return "Pilgrim";
}

function standingFromScore(score: number): { title: string; armorTier: number } {
  if (score >= 90) return { title: "Crusader Captain", armorTier: 5 };
  if (score >= 75) return { title: "Banner Knight", armorTier: 4 };
  if (score >= 60) return { title: "Knight Errant", armorTier: 3 };
  if (score >= 40) return { title: "Squire", armorTier: 2 };
  return { title: "Wayfaring Pilgrim", armorTier: 1 };
}

function previousStandingDirection(
  current: WeekAggregate,
  allDays: DayReport[]
): "rising" | "holding" | "falling" {
  const priorDays = allDays.slice(-14, -7);
  const prior = aggregateWeek(priorDays);
  if (!current.trackedDays || !prior.trackedDays) return "holding";
  const delta = current.averageFocusScore - prior.averageFocusScore;
  if (delta >= 4) return "rising";
  if (delta <= -4) return "falling";
  return "holding";
}

function nextUnlock({ streakDays, cleanDays, level, replacementChoices, journalEntries, behaviorCheckIns, recoveryCheckIns, sosStarts }: {
  streakDays: number;
  cleanDays: number;
  level: number;
  replacementChoices: number;
  journalEntries?: number;
  behaviorCheckIns?: number;
  recoveryCheckIns?: number;
  sosStarts?: number;
}): string {
  if ((journalEntries || 0) < 1) return "Write one reflection to unlock First reflection";
  if ((recoveryCheckIns || 0) < 3) return `${3 - (recoveryCheckIns || 0)} more recovery check-in${3 - (recoveryCheckIns || 0) === 1 ? "" : "s"} to unlock 3 recovery check-ins`;
  if ((sosStarts || 0) < 1) return "Start one SOS reset to unlock SOS reset";
  if ((behaviorCheckIns || 0) < 1) return "Track one behavior to unlock Behavior tracked";
  if (streakDays < 3) return `${3 - streakDays} more streak day${3 - streakDays === 1 ? "" : "s"} to unlock 3 day streak`;
  if (replacementChoices < 3) return `${3 - replacementChoices} more replacement choice${3 - replacementChoices === 1 ? "" : "s"} to unlock Replacement loop`;
  if (cleanDays < 3) return `${3 - cleanDays} more clean day${3 - cleanDays === 1 ? "" : "s"} to unlock Clean run`;
  if (level < 5) return `Reach level 5 to unlock Builder status`;
  if (streakDays < 7) return `${7 - streakDays} more streak day${7 - streakDays === 1 ? "" : "s"} to unlock 7 day streak`;
  return "Next: keep the streak alive";
}

function badge(id: string, label: string, earned: boolean): ProgressionBadge {
  return { id, label, earned };
}

function insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal, intentionalUse }: {
  current: WeekAggregate;
  previous: WeekAggregate;
  topCulprits: Culprit[];
  streak: FocusStreak;
  bestDay: DayReport | null;
  worstDay: DayReport | null;
  focusScoreGoal: number;
  intentionalUse: ReturnType<typeof intentionalUseSummary> | null;
}): string[] {
  const output: string[] = [];
  if (current.trackedDays === 0) {
    output.push("No full usage day has been tracked yet. Leave the watcher running to build your first report.");
    return output;
  }
  if (current.averageFocusScore >= focusScoreGoal) {
    output.push(`Average focus score is above target at ${current.averageFocusScore}.`);
  } else {
    output.push(`Average focus score is ${current.averageFocusScore}, below the ${focusScoreGoal} target.`);
  }
  if (previous.trackedDays > 0) {
    const delta = current.distractingSeconds - previous.distractingSeconds;
    output.push(delta <= 0 ? "Distracting time is down versus last week." : "Distracting time is up versus last week.");
  }
  if (topCulprits[0]) output.push(`${topCulprits[0].name} is the top culprit this week.`);
  if (current.averageDailyOpens > 0) output.push(`Average open pressure is ${current.averageDailyOpens} app/site opens per tracked day.`);
  if (intentionalUse?.today?.pauses) {
    output.push(`Intentional Use paused ${intentionalUse.today.pauses} opens today; ${intentionalUse.today.skipped} became replacements.`);
  }
  const stats = intentionalUse?.lifeLog?.stats;
  if (stats?.entriesThisWeek) output.push(`You logged ${stats.entriesThisWeek} reflection${stats.entriesThisWeek === 1 ? "" : "s"} this week.`);
  if (stats?.behaviorCheckInsThisWeek) output.push(`${stats.behaviorCheckInsThisWeek} behavior check-in${stats.behaviorCheckInsThisWeek === 1 ? "" : "s"} are feeding your level progress this week.`);
  if (streak.days > 0) output.push(`Current focus streak: ${streak.label}.`);
  if (bestDay) output.push(`${bestDay.label} is your strongest tracked day.`);
  if (worstDay && bestDay && worstDay.key !== bestDay.key) output.push(`${worstDay.label} is the day to tighten next.`);
  return output.slice(0, 5);
}

function reflectionStreakDays(state: VigilState, now: Date): number {
  const days = new Set((state.intentionalUse?.journalEntries || []).map((entry) => dateKey(new Date(entry.entryDate || entry.createdAt))));
  let count = 0;
  const cursor = new Date(now);
  cursor.setHours(0, 0, 0, 0);
  while (days.has(dateKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

function projections() {
  return {
    weeklySavedSeconds: null,
    yearlySavedSeconds: null,
    yearsReclaimedAtCurrentPace: null
  };
}

function bestTrackedDay(days: DayReport[]): DayReport | null {
  return days.filter((day) => day.tracked).sort((a, b) => b.focusScore - a.focusScore || a.distractingSeconds - b.distractingSeconds)[0] || null;
}

function worstTrackedDay(days: DayReport[]): DayReport | null {
  return days.filter((day) => day.tracked).sort((a, b) => a.focusScore - b.focusScore || b.distractingSeconds - a.distractingSeconds)[0] || null;
}

function topCombined(days: DayReport[], state: VigilState, kind: "sites" | "apps"): Culprit[] {
  const profile = state.profiles.find((item) => item.id === state.settings.activeProfileId) || state.profiles[0];
  const blockedTargets = kind === "sites" ? profile?.blockedSites || [] : profile?.blockedApps || [];
  const values: Record<string, number> = {};
  for (const day of days) {
    for (const [name, seconds] of Object.entries(day[kind] || {})) {
      const blocked = kind === "sites"
        ? hostMatchesSiteTargets(name, blockedTargets)
        : appMatchesAppTargets(name, blockedTargets);
      if (!blocked) continue;
      values[name] = (values[name] || 0) + Number(seconds || 0);
    }
  }
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds), kind: kind === "sites" ? "site" : "app" }));
}

function milestone(id: string, label: string, achieved: boolean): Milestone {
  return { id, label, achieved };
}

function sum(values: DayReport[], key: keyof Pick<DayReport, "totalSeconds" | "distractingSeconds" | "openCount" | "focusScore">): number {
  return values.reduce((total, item) => total + (item[key] || 0), 0);
}

function successRate(skipped: number, continued: number): number {
  const total = skipped + continued;
  return total ? Math.round((skipped / total) * 100) : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeek(date: Date): Date {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function rangeDays(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}
