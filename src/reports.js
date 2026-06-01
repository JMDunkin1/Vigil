import { dateKey } from "./time.js";
import { appMatchesAppTargets, hostMatchesSiteTargets } from "./policy.js";
import { intentionalUseSummary } from "./intentionalUse.js";
import { normalizeUsageDay } from "./usage.js";

export function focusReport(usage, state, now = new Date()) {
  const today = startOfDay(now);
  const weekStart = startOfWeek(today);
  const previousWeekStart = addDays(weekStart, -7);
  const previousWeekEnd = addDays(weekStart, -1);
  const baselineSeconds = (state.settings.baselineDailyMinutes || 300) * 60;
  const focusScoreGoal = state.settings.focusScoreGoal || 80;
  const currentDays = rangeDays(weekStart, 7).map((date) => dayReport(usage, state, date));
  const previousDays = rangeDays(previousWeekStart, 7).map((date) => dayReport(usage, state, date));
  const current = aggregateWeek(currentDays);
  const previous = aggregateWeek(previousDays);
  const allDays = rangeDays(addDays(today, -60), 61).map((date) => dayReport(usage, state, date));
  const streak = focusStreak(allDays, focusScoreGoal, today);
  const milestones = buildMilestones({ state, current, streak, allDays, focusScoreGoal });
  const topCulprits = topCombined(currentDays, "sites").concat(topCombined(currentDays, "apps")).slice(0, 6);
  const bestDay = bestTrackedDay(currentDays);
  const worstDay = worstTrackedDay(currentDays);
  const intentionalUse = intentionalUseSummary(state, usage, now);

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
    streak,
    milestones,
    intentionalUse,
    topCulprits,
    projections: projections(),
    insights: insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal, intentionalUse })
  };
}

function dayReport(usage, state, date) {
  const key = dateKey(date);
  const day = normalizeUsageDay(usage[key]);
  const distractingSeconds = sumBlockedSeconds(day, state);
  const totalSeconds = day.totalSeconds || 0;
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / Math.max(totalSeconds, 1)) * 100)) : 100;
  return {
    key,
    label: date.toLocaleDateString(undefined, { weekday: "short" }),
    totalSeconds: Math.round(totalSeconds),
    distractingSeconds: Math.round(distractingSeconds),
    savedSeconds: 0,
    openCount: sumOpenCounts(day.opens),
    focusScore,
    apps: day.apps,
    sites: day.sites,
    opens: day.opens,
    tracked: totalSeconds > 0
  };
}

function aggregateWeek(days) {
  const trackedDays = days.filter((day) => day.tracked);
  const totalSeconds = sum(days, "totalSeconds");
  const distractingSeconds = sum(days, "distractingSeconds");
  const savedSeconds = sum(days, "savedSeconds");
  return {
    totalSeconds,
    distractingSeconds,
    savedSeconds,
    openCount: sum(days, "openCount"),
    trackedDays: trackedDays.length,
    averageFocusScore: trackedDays.length ? Math.round(sum(trackedDays, "focusScore") / trackedDays.length) : 100,
    averageDailyDistractionSeconds: trackedDays.length ? Math.round(distractingSeconds / trackedDays.length) : 0,
    averageDailyOpens: trackedDays.length ? Math.round(sum(trackedDays, "openCount") / trackedDays.length) : 0
  };
}

function compareWeeks(current, previous) {
  return {
    savedSecondsDelta: current.savedSeconds - previous.savedSeconds,
    distractingSecondsDelta: current.distractingSeconds - previous.distractingSeconds,
    distractingPercentDelta: percentDelta(current.distractingSeconds, previous.distractingSeconds),
    focusScoreDelta: current.averageFocusScore - previous.averageFocusScore,
    trackedDaysDelta: current.trackedDays - previous.trackedDays
  };
}

function percentDelta(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function focusStreak(days, goal, today) {
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

function buildMilestones({ state, current, streak, allDays, focusScoreGoal }) {
  const enabledRules = [
    ...(state.schedules || []).filter((item) => item.enabled),
    ...(state.limitRules || []).filter((item) => item.enabled),
    ...(state.appLocks || []).filter((item) => item.enabled)
  ].length;
  const events = state.events || [];
  const hasCleanTrackedDay = allDays.some((day) => day.tracked && day.distractingSeconds === 0);
  return [
    milestone("first-lock", "First lock", events.some((event) => event.type === "session_started")),
    milestone("rules-enabled", "Rules armed", enabledRules >= 1),
    milestone("clean-tracked-day", "Clean tracked day", hasCleanTrackedDay),
    milestone("low-distraction-week", "Low distraction week", current.trackedDays >= 3 && current.averageDailyDistractionSeconds <= 30 * 60),
    milestone("three-day-streak", "3 day streak", streak.days >= 3),
    milestone("seven-day-streak", "7 day streak", streak.days >= 7),
    milestone("strong-week", "Strong week", current.trackedDays >= 5 && current.averageFocusScore >= focusScoreGoal)
  ];
}

function insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal, intentionalUse }) {
  const output = [];
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
  if (streak.days > 0) output.push(`Current focus streak: ${streak.label}.`);
  if (bestDay) output.push(`${bestDay.label} is your strongest tracked day.`);
  if (worstDay && bestDay && worstDay.key !== bestDay.key) output.push(`${worstDay.label} is the day to tighten next.`);
  return output.slice(0, 5);
}

function sumOpenCounts(opens = {}) {
  return sumObject(opens.apps) + sumObject(opens.sites);
}

function sumObject(values = {}) {
  return Object.values(values || {}).reduce((total, value) => total + Number(value || 0), 0);
}

function projections() {
  return {
    weeklySavedSeconds: 0,
    yearlySavedSeconds: 0,
    yearsReclaimedAtCurrentPace: 0
  };
}

function bestTrackedDay(days) {
  return days.filter((day) => day.tracked).sort((a, b) => b.focusScore - a.focusScore || a.distractingSeconds - b.distractingSeconds)[0] || null;
}

function worstTrackedDay(days) {
  return days.filter((day) => day.tracked).sort((a, b) => a.focusScore - b.focusScore || b.distractingSeconds - a.distractingSeconds)[0] || null;
}

function topCombined(days, kind) {
  const values = {};
  for (const day of days) {
    for (const [name, seconds] of Object.entries(day[kind] || {})) {
      values[name] = (values[name] || 0) + seconds;
    }
  }
  return Object.entries(values)
    .sort((a, b) => b[1] - a[1])
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds), kind: kind === "sites" ? "site" : "app" }));
}

function sumBlockedSeconds(day, state) {
  const profile = state.profiles.find((item) => item.id === state.settings.activeProfileId) || state.profiles[0];
  let total = 0;

  for (const [app, seconds] of Object.entries(day.apps || {})) {
    if (appMatchesAppTargets(app, profile?.blockedApps || [])) total += seconds;
  }

  for (const [site, seconds] of Object.entries(day.sites || {})) {
    if (hostMatchesSiteTargets(site, profile?.blockedSites || [])) {
      total += seconds;
    }
  }

  return Math.round(total);
}

function milestone(id, label, achieved) {
  return { id, label, achieved };
}

function sum(values, key) {
  return values.reduce((total, item) => total + (item[key] || 0), 0);
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeek(date) {
  const copy = startOfDay(date);
  copy.setDate(copy.getDate() - ((copy.getDay() + 6) % 7));
  return copy;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function rangeDays(start, count) {
  return Array.from({ length: count }, (_, index) => addDays(start, index));
}
