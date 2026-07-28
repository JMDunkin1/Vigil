import { dateKey } from "./time.js";
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
  const milestones = buildMilestones({ state, current, streak, allDays, focusScoreGoal });

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

function buildMilestones({ state, current, streak, allDays, focusScoreGoal }: {
  state: VigilState;
  current: WeekAggregate;
  streak: FocusStreak;
  allDays: DayReport[];
  focusScoreGoal: number;
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
    milestone("first-lock", "First lock", Boolean(state.functionalEvents?.firstSessionStartedAt)
      || events.some((event) => event.type === "session_started")),
    milestone("rules-enabled", "Rules armed", enabledRules >= 1),
    milestone("clean-tracked-day", "Clean tracked day", hasCleanTrackedDay),
    milestone("first-reflection", "First reflection", (state.intentionalUse?.journalEntries || []).length >= 1),
    milestone("behavior-tracked", "Track a behavior", (state.intentionalUse?.behaviorCheckIns || []).length >= 1),
    milestone("low-distraction-week", "Low distraction week", current.trackedDays >= 3 && current.averageDailyDistractionSeconds <= 30 * 60),
    milestone("three-day-streak", "3 day streak", streak.days >= 3),
    milestone("seven-day-streak", "7 day streak", streak.days >= 7),
    milestone("strong-week", "Strong week", current.trackedDays >= 5 && current.averageFocusScore >= focusScoreGoal)
  ];
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
  if (stats?.behaviorCheckInsThisWeek) output.push(`${stats.behaviorCheckInsThisWeek} behavior check-in${stats.behaviorCheckInsThisWeek === 1 ? "" : "s"} recorded this week.`);
  if (streak.days > 0) output.push(`Current focus streak: ${streak.label}.`);
  if (bestDay) output.push(`${bestDay.label} is your strongest tracked day.`);
  if (worstDay && bestDay && worstDay.key !== bestDay.key) output.push(`${worstDay.label} is the day to tighten next.`);
  return output.slice(0, 5);
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
