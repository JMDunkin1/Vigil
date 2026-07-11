import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import {
  accountabilityDigest,
  applyPornRecoverySetup,
  intentionalUseSummary,
  recordIntentionalRecoveryCheckIn,
  startIntentionalSosSession
} from "../src/intentionalUse.js";
import { focusReport } from "../src/reports.js";
import { weekKey } from "../src/time.js";
import type { UsageState } from "../src/types.js";

const now = new Date("2026-06-03T12:00:00");
const state = defaultState();

const setup = applyPornRecoverySetup(state, {
  statement: "Stay clear and present.",
  values: ["Sleep", "Marriage"],
  replacements: ["Walk outside", "Text Sam"]
}, now);

assert.equal(state.settings.intentionalUseEnabled, true);
assert.equal(state.settings.contentFilterEnabled, true);
assert.equal(state.settings.browserNoiseBlockingEnabled, true);
assert.equal(setup.rule.id, "porn-recovery-risk-pause");
assert.equal(setup.rule.frictionLevel, "strict");
assert.equal(setup.rule.enabled, true);
assert.ok(setup.rule.sites.includes("onlyfans.com"));
assert.equal(setup.rule.sites.includes("reddit.com"), false);
assert.ok((setup.rule.urlPatterns || []).includes("porn"));
assert.ok((setup.rule.urlPatterns || []).includes("reddit.com/r/gonewild"));
assert.equal(setup.behaviors.some((behavior) => behavior.id === "daily-recovery-check-in"), true);
assert.equal(setup.behaviors.some((behavior) => behavior.id === "urge-replacement-loop"), true);

const defaultSetup = applyPornRecoverySetup(defaultState(), {
  values: [],
  replacements: []
}, now);
assert.deepEqual(defaultSetup.goal.values, ["Self-respect", "Sleep", "Real relationships", "Deep work"]);
assert.deepEqual(defaultSetup.goal.replacements, [
  "Start the SOS reset",
  "Text or call the accountability partner",
  "Take a five-minute walk",
  "Open the journal and name the trigger",
  "Put the phone across the room"
]);

recordIntentionalRecoveryCheckIn(state, {
  status: "clean",
  trigger: "old week"
}, new Date("2026-05-20T12:00:00"));
recordIntentionalRecoveryCheckIn(state, {
  status: "victory",
  mood: "steady",
  urgeIntensity: 2,
  stress: 3,
  sleepHours: 7.5,
  exerciseMinutes: 30,
  trigger: "stress, late night",
  action: "walked",
  note: "Caught it early."
}, now);
recordIntentionalRecoveryCheckIn(state, {
  status: "setback",
  mood: "flat",
  urgeIntensity: 8,
  stress: 8,
  trigger: "stress",
  action: "journaled"
}, now);
const sos = startIntentionalSosSession(state, {
  intent: "sleep",
  trigger: "late night",
  urgeIntensity: 7,
  replacement: "Put the phone across the room"
}, now);

assert.equal(sos.session.intent, "sleep");
assert.ok(sos.session.plan.some((step) => step.includes("Stay clear and present")));
assert.equal(sos.checkIn.status, "urge");

const summary = intentionalUseSummary(state, {}, now);
assert.equal(summary.recovery.week.checkIns, 3);
assert.equal(summary.recovery.week.victories, 1);
assert.equal(summary.recovery.week.setbacks, 1);
assert.equal(summary.recovery.week.urges, 1);
assert.equal(summary.recovery.week.sos, 1);
assert.equal(summary.recovery.week.cleanDays, 0);
assert.equal(summary.lifeLog.stats.recoveryCheckInsThisWeek, 3);
assert.equal(summary.recovery.week.topTriggers.some((trigger) => trigger.label === "stress" && trigger.count === 2), true);
assert.equal(summary.recovery.week.topTriggers.some((trigger) => trigger.label === "late night" && trigger.count === 2), true);

const digest = accountabilityDigest(state, {}, now);
assert.match(digest.text, /Recovery check-ins: 3/);
assert.match(digest.text, /SOS starts: 1/);
assert.equal(digest.recovery.checkIns, 3);

const usage: UsageState = {
  "2026-06-03": {
    totalSeconds: 1800,
    apps: { Code: 1800 },
    sites: {},
    opens: { apps: { Code: 1 }, sites: {} },
    devices: {},
    updatedAt: now.toISOString()
  }
};
const report = focusReport(usage, state, now);
assert.equal(report.progression.recoveryCheckIns, 4);
assert.equal(report.progression.sosStarts, 1);
assert.equal(report.progression.setbacks, 1);
assert.equal(report.progression.badges.some((badge) => badge.id === "daily-check-in" && badge.earned), true);
assert.equal(state.intentionalUse.recoveryCheckIns.some((entry) => entry.weekKey !== weekKey(now)), true);
