import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { focusReport } from "../src/reports.js";
import { weekKey } from "../src/time.js";
import type { IntentionalOutcome, UsageState } from "../src/types.js";

const now = new Date("2026-06-03T12:00:00");
const state = defaultState();
const usage: UsageState = {
  "2026-06-01": cleanFocusDay(),
  "2026-06-02": cleanFocusDay(),
  "2026-06-03": cleanFocusDay()
};

state.intentionalUse.outcomes = [0, 1, 2].map((index) => ({
  id: `outcome-${index}`,
  pauseId: `pause-${index}`,
  ruleId: "short-form-intent-template",
  ruleName: "Short-form pause",
  outcome: "skipped",
  targetType: "site",
  targetLabel: "youtube.com",
  app: "Safari",
  hostname: "youtube.com",
  intention: "",
  replacement: "Open Notes instead",
  mood: "",
  at: new Date(now.getTime() - index * 60 * 60 * 1000).toISOString(),
  dateKey: "2026-06-03",
  weekKey: weekKey(now)
})) as IntentionalOutcome[];

const report = focusReport(usage, state, now);

assert.equal(report.streak.days, 3);
assert.ok(report.progression.level >= 3);
assert.equal(report.progression.brainHealth, 100);
assert.equal(report.progression.replacementChoices, 3);
assert.equal(report.progression.badges.some((badge) => badge.id === "replacement-loop" && badge.earned), true);
assert.equal(report.milestones.some((milestone) => milestone.id === "level-three" && milestone.achieved), true);

function cleanFocusDay() {
  return {
    totalSeconds: 3600,
    apps: { Code: 3600 },
    sites: {},
    opens: { apps: { Code: 1 }, sites: {} },
    devices: {},
    updatedAt: now.toISOString()
  };
}
