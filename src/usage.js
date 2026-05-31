import { dateKey } from "./time.js";
import { appMatchesAppTargets, hostMatchesSiteTargets } from "./policy.js";

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

export function usageSummary(usage, state) {
  const todayKey = dateKey();
  const today = ensureDay(usage, todayKey);
  const topApps = topEntries(today.apps);
  const topSites = topEntries(today.sites);
  const distractingSeconds = sumBlockedSeconds(today, state);
  const totalSeconds = today.totalSeconds || 0;
  const focusScore = totalSeconds ? Math.max(0, Math.round(100 - (distractingSeconds / totalSeconds) * 100)) : 100;
  const baseline = (state.settings.baselineDailyMinutes || 300) * 60;
  const savedSeconds = Math.max(0, baseline - distractingSeconds);

  return {
    todayKey,
    totalSeconds,
    distractingSeconds,
    savedSeconds,
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

function round(value) {
  return Math.round(value * 10) / 10;
}
