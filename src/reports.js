import { dateKey } from "./time.js";
import { appMatchesAppTargets, hostMatchesSiteTargets } from "./policy.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export function focusReport(usage, state, now = new Date()) {
  const today = startOfDay(now);
  const weekStart = startOfWeek(today);
  const previousWeekStart = addDays(weekStart, -7);
  const previousWeekEnd = addDays(weekStart, -1);
  const baselineSeconds = (state.settings.baselineDailyMinutes || 300) * 60;
  const focusScoreGoal = state.settings.focusScoreGoal || 80;
  const currentDays = rangeDays(weekStart, 7).map((date) => dayReport(usage, state, date, baselineSeconds));
  const previousDays = rangeDays(previousWeekStart, 7).map((date) => dayReport(usage, state, date, baselineSeconds));
  const current = aggregateWeek(currentDays);
  const previous = aggregateWeek(previousDays);
  const allDays = rangeDays(addDays(today, -60), 61).map((date) => dayReport(usage, state, date, baselineSeconds));
  const streak = focusStreak(allDays, focusScoreGoal, today);
  const milestones = buildMilestones({ state, current, streak, allDays, focusScoreGoal });
  const topCulprits = topCombined(currentDays, "sites").concat(topCombined(currentDays, "apps")).slice(0, 6);
  const bestDay = bestTrackedDay(currentDays);
  const worstDay = worstTrackedDay(currentDays);

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
    topCulprits,
    projections: projections(current, baselineSeconds),
    insights: insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal })
  };
}

function dayReport(usage, state, date, baselineSeconds) {
  const key = dateKey(date);
  const day = normalizeDay(usage[key]);
  const distractingSeconds = sumBlockedSeconds(day, state);
  const totalSeconds = day.totalSeconds || 0;
  const savedSeconds = Math.max(0, baselineSeconds - distractingSeconds);
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / Math.max(totalSeconds, 1)) * 100)) : 100;
  return {
    key,
    label: date.toLocaleDateString(undefined, { weekday: "short" }),
    totalSeconds: Math.round(totalSeconds),
    distractingSeconds: Math.round(distractingSeconds),
    savedSeconds: Math.round(savedSeconds),
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
    trackedDays: trackedDays.length,
    averageFocusScore: trackedDays.length ? Math.round(sum(trackedDays, "focusScore") / trackedDays.length) : 100,
    averageDailyDistractionSeconds: trackedDays.length ? Math.round(distractingSeconds / trackedDays.length) : 0
  };
}

function compareWeeks(current, previous) {
  return {
    savedSecondsDelta: current.savedSeconds - previous.savedSeconds,
    distractingSecondsDelta: current.distractingSeconds - previous.distractingSeconds,
    focusScoreDelta: current.averageFocusScore - previous.averageFocusScore,
    trackedDaysDelta: current.trackedDays - previous.trackedDays
  };
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
  const totalSavedSeconds = sum(allDays, "savedSeconds");
  const enabledRules = [
    ...(state.schedules || []).filter((item) => item.enabled),
    ...(state.limitRules || []).filter((item) => item.enabled),
    ...(state.appLocks || []).filter((item) => item.enabled)
  ].length;
  const events = state.events || [];
  return [
    milestone("first-lock", "First lock", events.some((event) => event.type === "session_started")),
    milestone("rules-enabled", "Rules armed", enabledRules >= 1),
    milestone("one-hour-saved", "1 hour saved", totalSavedSeconds >= 3600),
    milestone("ten-hours-saved", "10 hours saved", totalSavedSeconds >= 10 * 3600),
    milestone("full-day-saved", "1 day reclaimed", totalSavedSeconds >= 24 * 3600),
    milestone("three-day-streak", "3 day streak", streak.days >= 3),
    milestone("seven-day-streak", "7 day streak", streak.days >= 7),
    milestone("strong-week", "Strong week", current.trackedDays >= 5 && current.averageFocusScore >= focusScoreGoal)
  ];
}

function insights({ current, previous, topCulprits, streak, bestDay, worstDay, focusScoreGoal }) {
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
  if (streak.days > 0) output.push(`Current focus streak: ${streak.label}.`);
  if (bestDay) output.push(`${bestDay.label} is your strongest tracked day.`);
  if (worstDay && bestDay && worstDay.key !== bestDay.key) output.push(`${worstDay.label} is the day to tighten next.`);
  return output.slice(0, 5);
}

function projections(current, baselineSeconds) {
  const dailySaved = current.trackedDays ? current.savedSeconds / current.trackedDays : baselineSeconds;
  return {
    weeklySavedSeconds: Math.round(dailySaved * 7),
    yearlySavedSeconds: Math.round(dailySaved * 365),
    yearsReclaimedAtCurrentPace: Math.round((dailySaved * 365 * 10 / (365 * DAY_MS / 1000)) * 10) / 10
  };
}

function bestTrackedDay(days) {
  return days.filter((day) => day.tracked).sort((a, b) => b.focusScore - a.focusScore || b.savedSeconds - a.savedSeconds)[0] || null;
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

function normalizeDay(day = {}) {
  return {
    totalSeconds: day.totalSeconds || 0,
    apps: day.apps || {},
    sites: day.sites || {},
    opens: {
      apps: day.opens?.apps || {},
      sites: day.opens?.sites || {}
    }
  };
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
