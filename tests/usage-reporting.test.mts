import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { focusReport } from "../src/reports.js";
import { recordOpen, recordUsage, syncDeviceUsageSnapshot, usageSummary } from "../src/usage.js";
import type { UsageState } from "../src/types.js";
import { clockTime, hasStatusError, now, TEST_DAYS, usageFixture } from "./test-helpers.mjs";

{
  const state = defaultState();
  state.settings.baselineDailyMinutes = 120;
  const usage = usageFixture({
    "2026-05-25": {
      totalSeconds: 3600,
      apps: { Codex: 3000 },
      sites: { "youtube.com": 600 },
      opens: { apps: {}, sites: { "youtube.com": 2 } }
    },
    "2026-05-26": {
      totalSeconds: 5400,
      apps: { Codex: 5400 },
      sites: {},
      opens: { apps: {}, sites: {} }
    },
    "2026-05-20": {
      totalSeconds: 3600,
      apps: { Codex: 2400 },
      sites: { "youtube.com": 1200 },
      opens: { apps: {}, sites: { "youtube.com": 3 } }
    }
  });
  const report = focusReport(usage, state, new Date("2026-05-28T14:00:00-04:00"));
  assert.equal(report.currentWeek.totals.trackedDays, 2);
  assert.equal(report.topCulprits[0].name, "youtube.com");
  assert.equal(report.comparison.distractingPercentDelta, -50);
  assert.equal(report.milestones.some((item) => item.id === "clean-tracked-day" && item.achieved), true);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Instagram"],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 600,
      apps: { Codex: 600 },
      sites: {},
      opens: { apps: { Codex: 1 }, sites: {} }
    }
  });

  recordUsage(usage, { app: "Safari", hostname: "github.com" }, 120, now);
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 900,
    apps: { Instagram: 600 },
    sites: { "reddit.com": 300 },
    opens: { apps: { Instagram: 2 }, sites: { "reddit.com": 1 } }
  }, now);

  let summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 1620);
  assert.equal(summary.distractingSeconds, 900);
  assert.equal(summary.devices.computer.totalSeconds, 720);
  assert.equal(summary.devices.phone.totalSeconds, 900);
  assert.equal(summary.openPressure, 4);

  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 1200,
    apps: { Instagram: 600, Messages: 400 },
    sites: { "reddit.com": 300 },
    opens: { apps: { Instagram: 3 }, sites: { "reddit.com": 2 } }
  }, now);
  summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 1920);
  assert.equal(summary.distractingSeconds, 900);
  assert.equal(summary.devices.computer.totalSeconds, 720);
  assert.equal(summary.devices.phone.totalSeconds, 1200);

  const targetedCounterRegression = syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T14:01:00-04:00",
    totalSeconds: 1201,
    apps: { Instagram: 599, Messages: 402 },
    sites: { "reddit.com": 300 },
    opens: { apps: { Instagram: 3 }, sites: { "reddit.com": 2 } }
  }, now);
  assert.equal(targetedCounterRegression.stale, true);
  assert.equal(usageSummary(usage, state, now).devices.phone.totalSeconds, 1200);

  const regressive = syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T11:00:00-04:00",
    totalSeconds: 60,
    apps: { Instagram: 60 }
  }, now);
  assert.equal(regressive.stale, true);
  assert.equal(usageSummary(usage, state, now).devices.phone.totalSeconds, 1200);

  const boundedUsage: UsageState = {};
  syncDeviceUsageSnapshot(boundedUsage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T13:00:00-04:00",
    totalSeconds: 999_999,
    apps: { Instagram: 999_999 }
  }, now);
  assert.equal(usageSummary(boundedUsage, state, now).devices.phone.totalSeconds, 86_400);

  assert.throws(() => syncDeviceUsageSnapshot(usage, {
    device: "iphone",
    date: "2026-05-28",
    totalSeconds: 100,
    apps: { Instagram: 100 }
  }, now), /Unsupported usage device/);
  assert.equal(usageSummary(usage, state, now).devices.computer.totalSeconds, 720);
  assert.throws(() => syncDeviceUsageSnapshot(usage, {
    device: "computer",
    date: "2026-05-28",
    totalSeconds: 100,
    apps: { Codex: 100 }
  }, now, { allowedDevices: ["phone"] }), (error) => hasStatusError(error) && error.status === 403 && /not allowed/.test(error.message));
  for (const date of ["2026-99-99", "2026-05-20", "2026-05-30"]) {
    assert.throws(() => syncDeviceUsageSnapshot({}, {
      device: "phone",
      date,
      totalSeconds: 1,
      apps: { Instagram: 1 }
    }, now), /Usage snapshot/);
  }
  assert.throws(() => syncDeviceUsageSnapshot({}, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T14:10:01-04:00",
    totalSeconds: 1,
    apps: { Instagram: 1 }
  }, now), /too far in the future/);

  const report = focusReport(usage, state, now);
  assert.equal(report.currentWeek.totals.totalSeconds, 1920);
  assert.equal(report.currentWeek.totals.distractingSeconds, 900);
  assert.equal(report.topCulprits.some((item) => item.name === "Instagram" && item.seconds === 600), true);
}

{
  const state = defaultState();
  const emptySummary = usageSummary({}, state, now);
  assert.equal(emptySummary.protectedSeconds, 0);
  assert.equal(emptySummary.blockCount, 0);
  assert.equal(emptySummary.savedSeconds, null);

  const scheduledState = defaultState();
  const scheduledStart = new Date(now.getTime() - 30 * 60 * 1000);
  const scheduledEnd = new Date(now.getTime() + 60 * 60 * 1000);
  scheduledState.schedules = [{
    id: "scheduled-dashboard-lock",
    name: "Scheduled dashboard lock",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    days: TEST_DAYS,
    start: clockTime(scheduledStart),
    end: clockTime(scheduledEnd),
    wifiNetworks: [],
    deviceTargets: ["computer"]
  }];
  const scheduledSummary = usageSummary({}, scheduledState, now);
  assert.equal(scheduledSummary.protectedSeconds, 30 * 60);

  const startedAt = new Date(now.getTime() - 45 * 60 * 1000).toISOString();
  const endedAt = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const session = {
    id: "dashboard-session",
    title: "Dashboard session",
    mode: "focus",
    profileId: "default",
    lockLevel: "light",
    startedAt,
    endsAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual"
  };
  state.events = [
    { id: "block-url", type: "blocked_url", at: now.toISOString(), detail: { site: "instagram.com" } },
    { id: "old-block", type: "blocked_app", at: new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString(), detail: { app: "Discord" } },
    { id: "session-ended", type: "session_ended", at: endedAt, detail: session },
    { id: "block-site", type: "blocked_site", at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(), detail: { site: "reddit.com" } },
    { id: "session-started", type: "session_started", at: startedAt, detail: session }
  ];
  const summary = usageSummary({}, state, now);
  assert.equal(summary.protectedSeconds, 30 * 60);
  assert.equal(summary.blockCount, 2);
  assert.equal(summary.savedSeconds, null);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Safari"],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 600,
      apps: { Safari: 600 },
      sites: { "reddit.com": 600 },
      opens: { apps: { Safari: 1 }, sites: { "reddit.com": 1 } }
    }
  });

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 600);
  assert.equal(summary.distractingSeconds, 600);

  const report = focusReport(usage, state, now);
  assert.equal(report.currentWeek.days.find((day) => day.key === "2026-05-28")?.distractingSeconds, 600);
  assert.equal(report.currentWeek.totals.distractingSeconds, 600);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Safari", "Instagram"],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";

  const overlappingSample = { app: "Safari", hostname: "reddit.com" };
  const overlapping: UsageState = {};
  recordUsage(overlapping, overlappingSample, 300, now);
  recordUsage(overlapping, { app: "Codex", hostname: "github.com" }, 700, now);
  recordOpen(overlapping, overlappingSample, null, now);
  const overlappingSummary = usageSummary(overlapping, state, now);
  const overlappingDay = focusReport(overlapping, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(overlappingSummary.distractingSeconds, 300);
  assert.equal(overlappingSummary.openPressure, 1);
  assert.equal(overlappingDay?.distractingSeconds, 300);
  assert.equal(overlappingDay?.openCount, 1);

  const disjoint: UsageState = {};
  recordUsage(disjoint, { app: "Instagram" }, 300, now);
  recordUsage(disjoint, { app: "Firefox", hostname: "reddit.com" }, 200, now);
  recordUsage(disjoint, { app: "Codex", hostname: "github.com" }, 500, now);
  recordOpen(disjoint, { app: "Instagram" }, null, now);
  recordOpen(disjoint, { app: "Firefox", hostname: "reddit.com" }, { app: "Instagram" }, now);
  const disjointSummary = usageSummary(disjoint, state, now);
  const disjointDay = focusReport(disjoint, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(disjointSummary.distractingSeconds, 500);
  assert.equal(disjointSummary.openPressure, 2);
  assert.equal(disjointDay?.distractingSeconds, 500);
  assert.equal(disjointDay?.openCount, 2);

  const mixedDevices: UsageState = {};
  recordUsage(mixedDevices, overlappingSample, 300, now);
  recordUsage(mixedDevices, { app: "Codex", hostname: "github.com" }, 700, now);
  recordOpen(mixedDevices, overlappingSample, null, now);
  syncDeviceUsageSnapshot(mixedDevices, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 500,
    apps: { Instagram: 300, Firefox: 200 },
    sites: { "reddit.com": 200 },
    opens: { apps: { Instagram: 1 }, sites: { "reddit.com": 1 } }
  }, now);
  const mixedSummary = usageSummary(mixedDevices, state, now);
  const mixedDay = focusReport(mixedDevices, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(mixedSummary.distractingSeconds, 800);
  assert.equal(mixedSummary.openPressure, 3);
  assert.equal(mixedDay?.distractingSeconds, 800);
  assert.equal(mixedDay?.openCount, 3);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Instagram"],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 6000,
      apps: { Codex: 5000, Instagram: 300 },
      sites: { "docs.google.com": 4200, "reddit.com": 200 },
      opens: { apps: {}, sites: {} }
    }
  });

  const report = focusReport(usage, state, now);
  assert.deepEqual(report.topCulprits.map((item) => item.name), ["Instagram", "reddit.com"]);
  assert.equal(report.topCulprits.some((item) => item.name === "Codex" || item.name === "docs.google.com"), false);
  assert.equal(report.projections.weeklySavedSeconds, null);
  assert.equal(report.projections.yearlySavedSeconds, null);
  assert.equal(report.projections.yearsReclaimedAtCurrentPace, null);
}
