import { dateKey, parseClock } from "./time.js";
import { DEVICE_TARGETS } from "./defaults.js";
import { appMatchesAppTargets, hostMatchesSiteTargets, normalizeList } from "./policy.js";

const BLOCK_EVENT_TYPES = new Set([
  "blocked_app",
  "blocked_browser_control",
  "blocked_content",
  "blocked_site",
  "blocked_url",
  "extension_blocked_site"
]);

const USAGE_TOTALS_MODE = "by-device";

export class UsageSnapshotError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "UsageSnapshotError";
    this.status = status;
  }
}

export function recordUsage(usage, sample, seconds, now = new Date(), options = {}) {
  if (!sample?.app || !seconds || seconds < 0.25) return;
  const day = ensureDay(usage, dateKey(now));
  const device = ensureDeviceDay(day, normalizeUsageDevice(options.device || sample.device));
  incrementUsage(device, sample, seconds);
  recomputeDayTotals(day);
}

export function recordOpen(usage, sample, previousSample, now = new Date(), options = {}) {
  if (!sample?.app) return;
  const day = ensureDay(usage, dateKey(now));
  const device = ensureDeviceDay(day, normalizeUsageDevice(options.device || sample.device));
  recordOpenForBucket(device, sample, previousSample);
  recomputeDayTotals(day);
}

export function syncDeviceUsageSnapshot(usage, input = {}, now = new Date(), options = {}) {
  input = input && typeof input === "object" ? input : {};
  const device = normalizeUsageSyncDevice(input.device ?? input.deviceTarget, options.allowedDevices);
  const dayKey = usageSnapshotDayKey(input, now);
  const day = ensureDay(usage, dayKey);
  ensureDeviceDay(day, device);
  day.devices[device] = normalizeUsageBucket(input, now);
  recomputeDayTotals(day);

  const aggregate = normalizeUsageDay(day);
  return {
    ok: true,
    device,
    dayKey,
    totalSeconds: aggregate.totalSeconds,
    distractingSeconds: null,
    deviceTotalSeconds: aggregate.devices[device]?.totalSeconds || 0,
    devices: Object.fromEntries(Object.entries(aggregate.devices).map(([key, value]) => [key, {
      totalSeconds: value.totalSeconds || 0,
      appCount: Object.keys(value.apps || {}).length,
      siteCount: Object.keys(value.sites || {}).length,
      openPressure: sumValues(value.opens?.apps) + sumValues(value.opens?.sites)
    }]))
  };
}

export function normalizeUsageDay(day = {}) {
  const devices = normalizeDeviceBuckets(day.devices);
  if ((day.deviceTotalsMode === USAGE_TOTALS_MODE || !hasUsageData(day)) && Object.keys(devices).length) {
    return {
      ...aggregateBuckets(Object.values(devices)),
      devices,
      updatedAt: day.updatedAt || null
    };
  }

  return {
    totalSeconds: day.totalSeconds || 0,
    apps: day.apps || {},
    sites: day.sites || {},
    opens: {
      apps: day.opens?.apps || {},
      sites: day.opens?.sites || {}
    },
    devices,
    updatedAt: day.updatedAt || null
  };
}

export function normalizeUsageDevice(value = "computer") {
  const normalized = String(value || "computer").trim().toLowerCase();
  return DEVICE_TARGETS.includes(normalized) ? normalized : "computer";
}

function normalizeUsageSyncDevice(value, allowedDevices = DEVICE_TARGETS) {
  const device = String(value || "phone").trim().toLowerCase();
  if (!DEVICE_TARGETS.includes(device)) {
    throw new UsageSnapshotError(`Unsupported usage device: ${value}.`);
  }

  const allowed = normalizeAllowedUsageDevices(allowedDevices);
  if (!allowed.includes(device)) {
    throw new UsageSnapshotError(`Device usage sync is not allowed for ${device}.`, 403);
  }

  return device;
}

function normalizeAllowedUsageDevices(value = DEVICE_TARGETS) {
  const source = Array.isArray(value) ? value : DEVICE_TARGETS;
  const devices = [...new Set(source
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => DEVICE_TARGETS.includes(item)))];
  return devices.length ? devices : DEVICE_TARGETS;
}

function incrementUsage(bucket, sample, seconds) {
  bucket.apps[sample.app] = round((bucket.apps[sample.app] || 0) + seconds);

  if (sample.hostname) {
    bucket.sites[sample.hostname] = round((bucket.sites[sample.hostname] || 0) + seconds);
  }

  bucket.totalSeconds = round((bucket.totalSeconds || 0) + seconds);
  bucket.updatedAt = new Date().toISOString();
}

function recordOpenForBucket(bucket, sample, previousSample) {
  if (sample.app !== previousSample?.app) {
    bucket.opens.apps[sample.app] = (bucket.opens.apps[sample.app] || 0) + 1;
  }
  if (sample.hostname && sample.hostname !== previousSample?.hostname) {
    bucket.opens.sites[sample.hostname] = (bucket.opens.sites[sample.hostname] || 0) + 1;
  }

  bucket.updatedAt = new Date().toISOString();
}

export function usageSummary(usage, state, now = new Date()) {
  const todayKey = dateKey(now);
  const today = normalizeUsageDay(ensureDay(usage, todayKey));
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
    devices: deviceSummaries(today.devices, state),
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
  usage[key].devices ||= {};
  return usage[key];
}

function ensureDeviceDay(day, device) {
  if (day.deviceTotalsMode !== USAGE_TOTALS_MODE) {
    const legacy = normalizeUsageDay(day);
    day.devices = Object.keys(day.devices || {}).length ? normalizeDeviceBuckets(day.devices) : {};
    if (!Object.keys(day.devices).length && hasUsageData(legacy)) {
      day.devices.computer = normalizeUsageBucket(legacy);
    }
    day.deviceTotalsMode = USAGE_TOTALS_MODE;
  }

  day.devices ||= {};
  day.devices[device] = normalizeUsageBucket(day.devices[device] || {});
  return day.devices[device];
}

function recomputeDayTotals(day) {
  const aggregate = aggregateBuckets(Object.values(normalizeDeviceBuckets(day.devices)));
  day.totalSeconds = aggregate.totalSeconds;
  day.apps = aggregate.apps;
  day.sites = aggregate.sites;
  day.opens = aggregate.opens;
  day.deviceTotalsMode = USAGE_TOTALS_MODE;
  day.updatedAt = new Date().toISOString();
}

function normalizeDeviceBuckets(devices = {}) {
  return Object.fromEntries(Object.entries(devices || {})
    .map(([device, bucket]) => [normalizeUsageDevice(device), normalizeUsageBucket(bucket)])
    .filter(([, bucket]) => hasUsageData(bucket)));
}

function normalizeUsageBucket(bucket = {}, now = new Date()) {
  const apps = secondsMap(bucket.apps);
  const sites = secondsMap(bucket.sites);
  const opens = {
    apps: countMap(bucket.opens?.apps ?? bucket.appOpens),
    sites: countMap(bucket.opens?.sites ?? bucket.siteOpens)
  };
  const explicitTotal = finiteSeconds(bucket.totalSeconds ?? bucket.seconds ?? bucket.durationSeconds);
  const inferredTotal = Math.max(sumValues(apps), sumValues(sites));

  return {
    totalSeconds: explicitTotal ?? round(inferredTotal),
    apps,
    sites,
    opens,
    updatedAt: bucket.updatedAt || bucket.recordedAt || now.toISOString()
  };
}

function aggregateBuckets(buckets) {
  const aggregate = { totalSeconds: 0, apps: {}, sites: {}, opens: { apps: {}, sites: {} } };

  for (const bucket of buckets) {
    aggregate.totalSeconds = round(aggregate.totalSeconds + Number(bucket.totalSeconds || 0));
    mergeNumberMap(aggregate.apps, bucket.apps);
    mergeNumberMap(aggregate.sites, bucket.sites);
    mergeNumberMap(aggregate.opens.apps, bucket.opens?.apps);
    mergeNumberMap(aggregate.opens.sites, bucket.opens?.sites);
  }

  return aggregate;
}

function secondsMap(value) {
  return numberMap(value, ["name", "app", "site", "host", "hostname"], ["seconds", "totalSeconds", "durationSeconds"]);
}

function countMap(value) {
  return numberMap(value, ["name", "app", "site", "host", "hostname"], ["count", "opens"], { integer: true });
}

function numberMap(value, keyFields, valueFields, options = {}) {
  const output = {};
  const entries = Array.isArray(value)
    ? value.map((item) => [firstField(item, keyFields), firstField(item, valueFields)])
    : Object.entries(value || {});

  for (const [rawName, rawValue] of entries) {
    const name = String(rawName || "").trim();
    const number = Number(rawValue);
    if (!name || !Number.isFinite(number) || number <= 0) continue;
    output[name] = options.integer
      ? Math.round((output[name] || 0) + number)
      : round((output[name] || 0) + number);
  }

  return output;
}

function firstField(item, fields) {
  if (!item || typeof item !== "object") return "";
  for (const field of fields) {
    if (item[field] !== undefined) return item[field];
  }
  return "";
}

function finiteSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? round(number) : null;
}

function mergeNumberMap(target, values = {}) {
  for (const [name, value] of Object.entries(values || {})) {
    target[name] = round((target[name] || 0) + Number(value || 0));
  }
}

function usageSnapshotDayKey(input, now) {
  const day = String(input.dayKey || input.date || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const parsed = new Date(input.recordedAt || input.updatedAt || now);
  return dateKey(Number.isNaN(parsed.getTime()) ? now : parsed);
}

function hasUsageData(bucket = {}) {
  return Boolean(
    Number(bucket.totalSeconds || 0) > 0 ||
    Object.keys(bucket.apps || {}).length ||
    Object.keys(bucket.sites || {}).length ||
    Object.keys(bucket.opens?.apps || {}).length ||
    Object.keys(bucket.opens?.sites || {}).length
  );
}

function deviceSummaries(devices = {}, state = {}) {
  return Object.fromEntries(Object.entries(devices || {}).map(([device, bucket]) => [device, {
    totalSeconds: Math.round(bucket.totalSeconds || 0),
    distractingSeconds: sumBlockedSeconds(bucket, state),
    appOpenCount: sumValues(bucket.opens?.apps),
    siteOpenCount: sumValues(bucket.opens?.sites),
    topApps: topEntries(bucket.apps),
    topSites: topEntries(bucket.sites)
  }]));
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
