import { dateKey, parseClock } from "./time.js";
import { appMatchesAppTargets, hostMatchesSiteTargets, normalizeList } from "./policy.js";

const BLOCK_EVENT_TYPES = new Set([
  "blocked_app",
  "blocked_browser_control",
  "blocked_content",
  "blocked_site",
  "blocked_url",
  "extension_blocked_site"
]);

export function recordUsage(usage, sample, seconds, now = new Date()) {
  if (!sample?.app || !seconds || seconds < 0.25) return;
  const day = ensureDay(usage, dateKey(now));
  day.apps[sample.app] = round((day.apps[sample.app] || 0) + seconds);

  if (sample.hostname) {
    day.sites[sample.hostname] = round((day.sites[sample.hostname] || 0) + seconds);
  }

  day.totalSeconds = round((day.totalSeconds || 0) + seconds);
  day.updatedAt = new Date().toISOString();
}

export function recordOpen(usage, sample, previousSample, now = new Date()) {
  if (!sample?.app) return;
  const day = ensureDay(usage, dateKey(now));

  if (sample.app !== previousSample?.app) {
    day.opens.apps[sample.app] = (day.opens.apps[sample.app] || 0) + 1;
  }

  if (sample.hostname && sample.hostname !== previousSample?.hostname) {
    day.opens.sites[sample.hostname] = (day.opens.sites[sample.hostname] || 0) + 1;
  }

  day.updatedAt = new Date().toISOString();
}

export function usageSummary(usage, state, now = new Date()) {
  const todayKey = dateKey(now);
  const today = ensureDay(usage, todayKey);
  const topApps = topEntries(today.apps);
  const topSites = topEntries(today.sites);
  const distractingSeconds = sumBlockedSeconds(today, state);
  const totalSeconds = today.totalSeconds || 0;
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / totalSeconds) * 100)) : 100;
  const protectedSeconds = protectedSecondsToday(state, now);
  const blockCount = blockCountToday(state, now);
  const appOpenCount = sumValues(today.opens.apps);
  const siteOpenCount = sumValues(today.opens.sites);

  return {
    todayKey,
    totalSeconds,
    distractingSeconds,
    protectedSeconds,
    blockCount,
    appOpenCount,
    siteOpenCount,
    openPressure: appOpenCount + siteOpenCount,
    savedSeconds: 0,
    focusScore,
    topApps,
    topSites,
    topAppOpens: topOpenEntries(today.opens.apps),
    topSiteOpens: topOpenEntries(today.opens.sites)
  };
}

function ensureDay(usage, key) {
  usage[key] ||= { totalSeconds: 0, apps: {}, sites: {}, opens: { apps: {}, sites: {} }, updatedAt: new Date().toISOString() };
  usage[key].apps ||= {};
  usage[key].sites ||= {};
  usage[key].opens ||= { apps: {}, sites: {} };
  usage[key].opens.apps ||= {};
  usage[key].opens.sites ||= {};
  usage[key].totalSeconds ||= 0;
  return usage[key];
}

function topEntries(values) {
  return Object.entries(values || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, seconds]) => ({ name, seconds: Math.round(seconds) }));
}

function topOpenEntries(values) {
  return Object.entries(values || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, count]) => ({ name, count }));
}

function sumValues(values) {
  return Object.values(values || {}).reduce((total, value) => total + Number(value || 0), 0);
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

function protectedSecondsToday(state, now) {
  const { startMs, endMs } = dayBounds(now);
  const intervals = [];
  const sessions = sessionRecords(state, now);

  for (const session of sessions.values()) {
    const startedAt = parseTime(session.startedAt);
    if (!Number.isFinite(startedAt)) continue;
    const plannedEnd = parseTime(session.endsAt);
    const endedAt = Number.isFinite(parseTime(session.endedAt)) ? parseTime(session.endedAt) : null;
    const naturalEnd = Number.isFinite(plannedEnd) ? plannedEnd : now.getTime();
    const finishedAt = session.active ? Math.min(naturalEnd, now.getTime()) : (endedAt || Math.min(naturalEnd, now.getTime()));
    const clippedStart = Math.max(startMs, startedAt);
    const clippedEnd = Math.min(endMs, finishedAt);
    if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
  }

  intervals.push(...scheduleIntervalsToday(state, now, startMs, endMs));

  return Math.round(mergedIntervalMs(intervals) / 1000);
}

function blockCountToday(state, now) {
  const { startMs, endMs } = dayBounds(now);
  return (state.events || []).filter((event) => {
    if (!BLOCK_EVENT_TYPES.has(event.type)) return false;
    const at = parseTime(event.at);
    return Number.isFinite(at) && at >= startMs && at < endMs;
  }).length;
}

function sessionRecords(state, now) {
  const records = new Map();

  for (const event of state.events || []) {
    const detail = event.detail || {};
    if ((event.type === "session_started" || event.type === "panic_lock_started") && detail.id) {
      upsertSession(records, detail);
    }
    if (event.type === "session_ended" && detail.id) {
      upsertSession(records, { ...detail, endedAt: event.at });
    }
  }

  for (const session of activeSessions(state)) {
    upsertSession(records, session, { active: true });
  }

  if (state.panicLock) upsertSession(records, state.panicLock, { active: true });

  for (const record of records.values()) {
    const plannedEnd = parseTime(record.endsAt);
    if (record.active && Number.isFinite(plannedEnd) && plannedEnd <= now.getTime()) {
      record.active = false;
    }
  }

  return records;
}

function upsertSession(records, session, options = {}) {
  const id = String(session?.id || "");
  if (!id) return;
  const existing = records.get(id) || { id };
  records.set(id, {
    ...existing,
    startedAt: existing.startedAt || session.startedAt,
    endsAt: session.endsAt || existing.endsAt,
    endedAt: session.endedAt || existing.endedAt,
    active: Boolean(existing.active || options.active)
  });
}

function activeSessions(state) {
  const sessions = [
    state.activeSession,
    state.activeSessions?.computer,
    state.activeSessions?.phone
  ].filter(Boolean);
  const seen = new Set();
  return sessions.filter((session) => {
    const id = String(session.id || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function scheduleIntervalsToday(state, now, startMs, endMs) {
  const intervals = [];
  const today = new Date(startMs);
  const yesterday = new Date(startMs);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const schedule of state.schedules || []) {
    if (!schedule.enabled) continue;
    if (!scheduleEnvironmentMatches(state, schedule)) continue;
    const startMinutes = parseClock(schedule.start);
    const endMinutes = parseClock(schedule.end);
    if (!Number.isFinite(startMinutes) || !Number.isFinite(endMinutes) || startMinutes === endMinutes) continue;

    for (const dayStart of [yesterday, today]) {
      if (!(schedule.days || []).includes(dayStart.getDay())) continue;
      const window = scheduleIntervalForDay(dayStart, startMinutes, endMinutes);
      if (!window) continue;
      const overrideStart = scheduleOverrideStart(state, schedule, window[1]);
      const clippedEnd = Math.min(endMs, now.getTime(), overrideStart ?? window[1]);
      const clippedStart = Math.max(startMs, window[0]);
      if (clippedEnd > clippedStart) intervals.push([clippedStart, clippedEnd]);
    }
  }

  return intervals;
}

function scheduleIntervalForDay(dayStart, startMinutes, endMinutes) {
  const starts = new Date(dayStart);
  starts.setHours(Math.floor(startMinutes / 60), startMinutes % 60, 0, 0);

  const ends = new Date(dayStart);
  ends.setHours(Math.floor(endMinutes / 60), endMinutes % 60, 0, 0);
  if (startMinutes > endMinutes) ends.setDate(ends.getDate() + 1);
  if (ends <= starts) return null;
  return [starts.getTime(), ends.getTime()];
}

function scheduleOverrideStart(state, schedule, windowEndMs) {
  const override = (state.overrides || []).find((item) => (
    item.scheduleId === schedule.id
    && parseTime(item.until) >= windowEndMs
  ));
  if (!override) return null;
  const createdAt = parseTime(override.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function scheduleEnvironmentMatches(state, schedule) {
  const networks = normalizeList(schedule.wifiNetworks || []);
  if (!networks.length) return true;
  const current = normalizeList([state.environment?.wifiSsid || ""])[0];
  return Boolean(current && networks.includes(current));
}

function dayBounds(now) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

function parseTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : NaN;
}

function mergedIntervalMs(intervals) {
  if (!intervals.length) return 0;
  const sorted = intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [start, end] = sorted[0];

  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart <= end) {
      end = Math.max(end, nextEnd);
    } else {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    }
  }

  return total + end - start;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
