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
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage: UsageState = usageFixture({
    "2026-05-26": {
      totalSeconds: 30 * 60,
      apps: { Instagram: 30 * 60 },
      sites: {},
      opens: { apps: { Instagram: 2 }, sites: {} },
      devices: {
        phone: {
          totalSeconds: 30 * 60,
          apps: { Instagram: 30 * 60 },
          sites: {},
          opens: { apps: { Instagram: 2 }, sites: {} }
        }
      },
      deviceTotalsMode: "by-device"
    },
    "2026-05-27": {
      totalSeconds: 10 * 60 * 60,
      apps: { Codex: 10 * 60 * 60 },
      sites: {},
      opens: { apps: {}, sites: {} }
    }
  });
  recordUsage(usage, { app: "Codex" }, 5 * 60 * 60, new Date("2026-05-28T12:00:00-04:00"));
  recordOpen(usage, { app: "Codex" }, null, new Date("2026-05-28T12:00:00-04:00"));
  recordUsage(usage, { app: "Codex" }, 60 * 60, new Date("2026-05-28T14:00:00-04:00"), {
    segment: {
      startedAt: new Date("2026-05-28T13:00:00-04:00"),
      endedAt: new Date("2026-05-28T14:00:00-04:00")
    }
  });
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T14:00:00-04:00",
    totalSeconds: 30 * 60,
    apps: { Instagram: 30 * 60 },
    opens: { apps: { Instagram: 2 }, sites: {} },
    segments: [{
      startedAt: "2026-05-28T13:30:00-04:00",
      endedAt: "2026-05-28T14:00:00-04:00",
      app: "Instagram"
    }]
  }, now);

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 60 * 60, "background history must be hidden and overlapping devices must count once");
  assert.equal(summary.distractingSeconds, 30 * 60, "the foreground phone activity should own the overlap");
  assert.equal(summary.focusScore, 50, "background Codex time must not inflate the focus score denominator");
  assert.deepEqual(summary.topApps, [
    { name: "Codex", seconds: 30 * 60 },
    { name: "Instagram", seconds: 30 * 60 }
  ]);
  assert.equal(summary.devices.computer.totalSeconds, 60 * 60, "only active Codex use remains Mac screen time");
  assert.equal(summary.devices.phone.totalSeconds, 30 * 60);
  assert.equal(summary.devices.computer.appOpenCount, 1, "timed device summaries must retain recorded opens");
  assert.equal(summary.devices.phone.appOpenCount, 2);
  assert.equal(summary.openPressure, 3, "timed days must retain open pressure from trusted and legacy counters");
  const report = focusReport(usage, state, now);
  assert.equal(report.currentWeek.days.find((day) => day.key === "2026-05-28")?.openCount, 3);
  assert.equal(report.currentWeek.totals.averageDailyOpens, 3);
  const phoneOnlyDay = report.currentWeek.days.find((day) => day.key === "2026-05-26");
  assert.equal(phoneOnlyDay?.tracked, true, "trusted Mac timelines must not erase segmentless phone-only days");
  assert.equal(phoneOnlyDay?.totalSeconds, 30 * 60);
  assert.equal(phoneOnlyDay?.devices.computerSeconds, null);
  assert.equal(phoneOnlyDay?.devices.phoneSeconds, 30 * 60);
  assert.equal(report.currentWeek.days.find((day) => day.key === "2026-05-27")?.tracked, false, "legacy background-contaminated days must not remain visible after trusted tracking starts");
}

{
  const state = defaultState();
  const segmentStart = new Date("2026-05-28T09:00:00-04:00").getTime();
  const segments = Array.from({ length: 5_000 }, (_, index) => ({
    startedAt: new Date(segmentStart + index * 3_000).toISOString(),
    endedAt: new Date(segmentStart + (index + 1) * 3_000).toISOString(),
    app: index % 2 ? "Safari" : "Codex"
  }));
  const usage: UsageState = usageFixture({
    "2026-05-28": {
      totalSeconds: 15_000,
      apps: { Codex: 7_500, Safari: 7_500 },
      sites: {},
      opens: { apps: {}, sites: {} },
      devices: {
        computer: {
          totalSeconds: 15_000,
          apps: { Codex: 7_500, Safari: 7_500 },
          sites: {},
          opens: { apps: {}, sites: {} },
          segments,
          segmentTimelineComplete: true
        }
      },
      deviceTotalsMode: "by-device"
    }
  });

  recordUsage(usage, { app: "Codex" }, 3, new Date(segmentStart + 15_003_000), {
    segment: {
      startedAt: new Date(segmentStart + 15_000_000),
      endedAt: new Date(segmentStart + 15_003_000)
    }
  });
  assert.equal(usageSummary(usage, state, new Date(segmentStart + 15_003_000)).totalSeconds, 15_003, "trimming a timeline prefix must fall back to complete counters");
  assert.equal(usage["2026-05-28"].devices.computer.segmentTimelineComplete, undefined);

  recordUsage(usage, { app: "Safari" }, 3, new Date(segmentStart + 15_006_000), {
    segment: {
      startedAt: new Date(segmentStart + 15_003_000),
      endedAt: new Date(segmentStart + 15_006_000)
    }
  });
  assert.equal(usageSummary(usage, state, new Date(segmentStart + 15_006_000)).totalSeconds, 15_006, "later segments must not restore completeness after a prefix was trimmed");
}

{
  const state = defaultState();
  const segmentStart = new Date("2026-05-28T00:00:00-04:00").getTime();
  const segments = Array.from({ length: 5_001 }, (_, index) => ({
    startedAt: new Date(segmentStart + index * 1_000).toISOString(),
    endedAt: new Date(segmentStart + (index + 1) * 1_000).toISOString(),
    app: "Codex"
  }));
  const usage: UsageState = {};
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T02:00:00-04:00",
    totalSeconds: 8_600,
    apps: { Codex: 8_600 },
    segments,
    segmentTimelineComplete: true
  }, now);
  assert.equal(usage["2026-05-28"].devices.phone.segmentTimelineComplete, undefined);
  assert.equal(usageSummary(usage, state, now).devices.phone.totalSeconds, 8_600, "a first truncated sync must use complete counters");

  const filteredUsage: UsageState = {};
  syncDeviceUsageSnapshot(filteredUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 120,
    apps: { Codex: 120 },
    segments: [segments[0], { startedAt: "invalid", endedAt: "invalid", app: "Codex" }],
    segmentTimelineComplete: true
  }, now);
  assert.equal(filteredUsage["2026-05-28"].devices.phone.segmentTimelineComplete, undefined, "filtering an invalid segment must clear completeness");

  const clippedUsage: UsageState = {};
  syncDeviceUsageSnapshot(clippedUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 120,
    apps: { Codex: 120 },
    segments: [{
      startedAt: "2026-05-27T23:59:00-04:00",
      endedAt: "2026-05-28T00:01:00-04:00",
      app: "Codex"
    }],
    segmentTimelineComplete: true
  }, now);
  assert.equal(clippedUsage["2026-05-28"].devices.phone.segmentTimelineComplete, undefined, "day clipping must clear completeness");
}

{
  const state = defaultState();
  const segmentStart = new Date("2026-05-28T09:00:00-04:00").getTime();
  const segments = Array.from({ length: 5_002 }, (_, index) => ({
    startedAt: new Date(segmentStart + index * 3_000).toISOString(),
    endedAt: new Date(segmentStart + (index + 1) * 3_000).toISOString(),
    app: index % 2 ? "Safari" : "Codex"
  }));
  const usage: UsageState = {};
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: new Date(segmentStart + 15_000_000).toISOString(),
    totalSeconds: 15_000,
    apps: { Codex: 7_500, Safari: 7_500 },
    segments: segments.slice(0, 5_000),
    segmentTimelineComplete: true
  }, now);

  const firstRollover = syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: new Date(segmentStart + 15_003_000).toISOString(),
    totalSeconds: 15_003,
    apps: { Codex: 7_503, Safari: 7_500 },
    segments: segments.slice(0, 5_001),
    segmentTimelineComplete: true
  }, now);
  assert.equal(firstRollover.stale, false, "the first capped phone timeline rollover must remain monotonic");
  assert.equal(firstRollover.deviceTotalSeconds, 15_003);
  assert.equal(usage["2026-05-28"].devices.phone.segments?.length, 5_000);
  assert.equal(usage["2026-05-28"].devices.phone.segmentTimelineComplete, undefined, "a trimmed timeline must fall back to complete counters");
  assert.equal(usageSummary(usage, state, now).devices.phone.totalSeconds, 15_003);

  const nextRollover = syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: new Date(segmentStart + 15_006_000).toISOString(),
    totalSeconds: 15_006,
    apps: { Codex: 7_503, Safari: 7_503 },
    segments,
    segmentTimelineComplete: true
  }, now);
  assert.equal(nextRollover.stale, false, "subsequent capped phone snapshots must continue advancing");
  assert.equal(nextRollover.deviceTotalSeconds, 15_006);
  assert.equal(usageSummary(usage, state, now).devices.phone.totalSeconds, 15_006);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Instagram"],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage: UsageState = {};
  recordUsage(usage, { app: "Codex" }, 2 * 60 * 60, now);
  recordUsage(usage, { app: "Codex" }, 60 * 60, now, {
    segment: {
      startedAt: new Date("2026-05-28T13:00:00-04:00"),
      endedAt: new Date("2026-05-28T14:00:00-04:00")
    }
  });
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 30 * 60,
    apps: { Instagram: 30 * 60 },
    opens: { apps: { Instagram: 2 }, sites: {} }
  }, now);

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 90 * 60, "snapshot-only phone time must remain alongside timed Mac use");
  assert.equal(summary.distractingSeconds, 30 * 60);
  assert.equal(summary.devices.computer.totalSeconds, 60 * 60);
  assert.equal(summary.devices.phone.totalSeconds, 30 * 60);
  assert.deepEqual(summary.topApps, [
    { name: "Codex", seconds: 60 * 60 },
    { name: "Instagram", seconds: 30 * 60 }
  ]);
  const reportDay = focusReport(usage, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(reportDay?.devices.computerSeconds, 60 * 60);
  assert.equal(reportDay?.devices.phoneSeconds, 30 * 60);
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
  const usage: UsageState = {};
  recordUsage(usage, { app: "Codex" }, 5 * 60, now, {
    segment: {
      startedAt: new Date("2026-05-28T13:55:00-04:00"),
      endedAt: new Date("2026-05-28T14:00:00-04:00")
    }
  });
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 5 * 60,
    apps: { Safari: 5 * 60 },
    sites: { "reddit.com": 5 * 60 },
    opens: { apps: {}, sites: {} }
  }, now);

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 10 * 60);
  assert.equal(summary.distractingSeconds, 5 * 60, "segmentless device attribution must not consume allowed time from another device");
  assert.equal(summary.focusScore, 50);
  assert.equal(summary.devices.computer.distractingSeconds, 0);
  assert.equal(summary.devices.phone.distractingSeconds, 5 * 60);
  const reportDay = focusReport(usage, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(reportDay?.distractingSeconds, 5 * 60);
  assert.equal(reportDay?.focusScore, 50);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage: UsageState = {};
  recordUsage(usage, { app: "Browser Extension", hostname: "reddit.com" }, 60, now);
  recordUsage(usage, { app: "Google Chrome" }, 60, now, {
    segment: {
      startedAt: new Date("2026-05-28T13:59:00-04:00"),
      endedAt: new Date("2026-05-28T14:00:00-04:00")
    }
  });

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 60, "extension heartbeats must not double-count trusted browser duration");
  assert.deepEqual(summary.topApps, [{ name: "Google Chrome", seconds: 60 }]);
  assert.deepEqual(summary.topSites, [{ name: "reddit.com", seconds: 60 }], "extension hostnames must enrich trusted browser segments");
  assert.equal(summary.distractingSeconds, 60);
  assert.equal(summary.focusScore, 0);
}

{
  const state = defaultState();
  const usage: UsageState = usageFixture({
    "2026-05-27": {
      totalSeconds: 60 * 60,
      apps: { Codex: 60 * 60 },
      sites: {},
      opens: { apps: { Codex: 1 }, sites: {} }
    }
  });
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 5 * 60,
    apps: { Messages: 5 * 60 },
    segments: [{
      startedAt: "2026-05-28T13:55:00-04:00",
      endedAt: "2026-05-28T14:00:00-04:00",
      app: "Messages"
    }]
  }, now);

  const report = focusReport(usage, state, now);
  const historicalMacDay = report.currentWeek.days.find((day) => day.key === "2026-05-27");
  assert.equal(historicalMacDay?.tracked, true, "phone timelines must not hide historical Mac-only reports");
  assert.equal(historicalMacDay?.totalSeconds, 60 * 60);
}

{
  const state = defaultState();
  const usage: UsageState = usageFixture({
    "2026-05-27": {
      totalSeconds: 10 * 60 * 60 + 30 * 60,
      apps: { Codex: 10 * 60 * 60, Messages: 30 * 60 },
      sites: {},
      opens: { apps: {}, sites: {} },
      devices: {
        computer: {
          totalSeconds: 10 * 60 * 60,
          apps: { Codex: 10 * 60 * 60 },
          sites: {},
          opens: { apps: {}, sites: {} }
        },
        phone: {
          totalSeconds: 30 * 60,
          apps: { Messages: 30 * 60 },
          sites: {},
          opens: { apps: {}, sites: {} },
          segments: [{
            startedAt: "2026-05-27T13:30:00-04:00",
            endedAt: "2026-05-27T14:00:00-04:00",
            app: "Messages"
          }]
        }
      },
      deviceTotalsMode: "by-device"
    },
    "2026-05-28": {
      totalSeconds: 5 * 60,
      apps: { Codex: 5 * 60 },
      sites: {},
      opens: { apps: {}, sites: {} },
      devices: {
        computer: {
          totalSeconds: 5 * 60,
          apps: { Codex: 5 * 60 },
          sites: {},
          opens: { apps: {}, sites: {} },
          segments: [{
            startedAt: "2026-05-28T13:55:00-04:00",
            endedAt: "2026-05-28T14:00:00-04:00",
            app: "Codex"
          }]
        }
      },
      deviceTotalsMode: "by-device"
    }
  });

  const historicalDay = focusReport(usage, state, now).currentWeek.days.find((day) => day.key === "2026-05-27");
  assert.equal(historicalDay?.totalSeconds, 30 * 60, "phone segments must not preserve legacy background-inflated Mac totals");
  assert.equal(historicalDay?.devices.computerSeconds, null);
  assert.equal(historicalDay?.devices.phoneSeconds, 30 * 60);
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
  const usage: UsageState = {};
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 10 * 60,
    apps: { Safari: 5 * 60, Codex: 5 * 60 },
    sites: { "reddit.com": 5 * 60 },
    opens: { apps: {}, sites: {} },
    segments: [{
      startedAt: "2026-05-28T13:50:00-04:00",
      endedAt: "2026-05-28T13:55:00-04:00",
      app: "Safari",
      hostname: "reddit.com"
    }, {
      startedAt: "2026-05-28T13:55:00-04:00",
      endedAt: "2026-05-28T14:00:00-04:00",
      app: "Codex"
    }]
  }, now);

  const summary = usageSummary(usage, state, now);
  assert.equal(summary.distractingSeconds, 5 * 60, "segment contexts must prevent blocked app and site overlap from counting twice");
  const reportDay = focusReport(usage, state, now).currentWeek.days.find((day) => day.key === "2026-05-28");
  assert.equal(reportDay?.distractingSeconds, 5 * 60);
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

  const segmentedUsage: UsageState = {};
  syncDeviceUsageSnapshot(segmentedUsage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T12:05:00-04:00",
    totalSeconds: 300,
    apps: { Messages: 300 },
    segments: [{
      startedAt: "2026-05-28T12:00:00-04:00",
      endedAt: "2026-05-28T12:05:00-04:00",
      app: "Messages"
    }]
  }, now);
  const incompleteTimeline = syncDeviceUsageSnapshot(segmentedUsage, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T12:10:00-04:00",
    totalSeconds: 600,
    apps: { Messages: 300, Safari: 300 },
    segments: [{
      startedAt: "2026-05-28T12:05:00-04:00",
      endedAt: "2026-05-28T12:10:00-04:00",
      app: "Safari"
    }]
  }, now);
  assert.equal(incompleteTimeline.stale, true, "a newer snapshot must not replace earlier timeline coverage with only its latest segment");
  assert.equal(incompleteTimeline.deviceTotalSeconds, 300, "the sync response must reflect the retained complete timeline");
  assert.equal(usageSummary(segmentedUsage, state, now).devices.phone.totalSeconds, 300, "rejecting incomplete segment coverage must keep recorded screen time stable");

  const firstPartialTimeline: UsageState = {};
  syncDeviceUsageSnapshot(firstPartialTimeline, {
    device: "phone",
    date: "2026-05-28",
    updatedAt: "2026-05-28T13:00:00-04:00",
    totalSeconds: 60 * 60,
    apps: { Messages: 60 * 60 },
    segments: [{
      startedAt: "2026-05-28T12:59:00-04:00",
      endedAt: "2026-05-28T13:00:00-04:00",
      app: "Messages"
    }]
  }, now);
  assert.equal(
    usageSummary(firstPartialTimeline, state, now).devices.phone.totalSeconds,
    60 * 60,
    "a first snapshot's partial timeline must not replace its complete counters"
  );

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
