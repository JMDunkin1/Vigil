import assert from "node:assert/strict";

import { defaultState, NORMAL_PROFILE_ID } from "../src/defaults.js";
import { intentionalUseSummary, normalizeIntentionalUse, recordIntentionalBehaviorCheckIn } from "../src/intentionalUse.js";
import { trackingDateKey } from "../src/time.js";

const now = new Date("2026-07-10T12:00:00-04:00");
const state = defaultState();
const seededIds = state.intentionalUse.behaviors.map((behavior) => behavior.id);

assert.deepEqual(seededIds, [
  "habit-chastity",
  "habit-rosary",
  "habit-reading",
  "habit-exercise"
]);
assert.equal(state.intentionalUse.behaviors.every((behavior) => behavior.unit === "yes-no"), true);

const migrated = normalizeIntentionalUse({ behaviors: [] }, state.intentionalUse);
assert.equal(migrated.behaviors.some((behavior) => behavior.id === "habit-rosary"), true);

const normal = state.profiles.find((profile) => profile.id === NORMAL_PROFILE_ID);
assert.ok(normal);
assert.deepEqual(normal.blockedApps, []);
assert.ok(normal.blockedSites.includes("pornhub.com"));
assert.ok(normal.blockedUrlPatterns.includes("manhwa"));
assert.ok(normal.blockedUrlPatterns.includes("toongod"));
assert.ok(normal.blockedUrlPatterns.includes("youtube.com/shorts"));
assert.ok(normal.blockedUrlPatterns.includes("snapchat.com/spotlight"));

const success = recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-07-08",
  value: true
}, now);
assert.ok(success);
assert.equal(success.value, 1);
assert.equal(success.dateKey, "2026-07-08");

const missed = recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-07-08",
  value: false
}, now);
assert.ok(missed);
assert.equal(missed.id, success.id);
assert.equal(missed.value, 0);
assert.equal(state.intentionalUse.behaviorCheckIns.length, 1);

recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-07-09",
  value: true
}, now);
assert.equal(state.intentionalUse.behaviorCheckIns.length, 2);

const cleared = recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-07-08",
  clear: true
}, now);
assert.equal(cleared, null);
assert.equal(state.intentionalUse.behaviorCheckIns.length, 1);

assert.throws(() => recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-07-11",
  value: true
}, now), /Future behavior check-ins/);
assert.throws(() => recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2025-01-01",
  value: true
}, now), /400 days/);
assert.throws(() => recordIntentionalBehaviorCheckIn(state, {
  behaviorId: "habit-rosary",
  dateKey: "2026-02-30",
  value: true
}, now), /invalid/);

const afterMidnight = new Date(2026, 6, 13, 1, 42, 0);
const afterMidnightState = defaultState();
const lateNight = recordIntentionalBehaviorCheckIn(afterMidnightState, {
  behaviorId: "habit-reading",
  value: true
}, afterMidnight);
assert.ok(lateNight);
assert.equal(lateNight.dateKey, "2026-07-12");
assert.equal(lateNight.weekKey, "2026-W28");
assert.throws(() => recordIntentionalBehaviorCheckIn(afterMidnightState, {
  behaviorId: "habit-reading",
  dateKey: "2026-07-13",
  value: true
}, afterMidnight), /Future behavior check-ins/);

const summary = intentionalUseSummary(state, {}, now);
assert.equal(summary.lifeLog.habitCheckIns.length, 1);
assert.equal(summary.lifeLog.habitCheckIns[0].dateKey, "2026-07-09");
assert.deepEqual(summary.lifeLog.entries, []);
assert.equal(summary.lifeLog.entriesLocked, true);

const annualNow = new Date(2026, 6, 28, 12);
const annualState = defaultState();
const annualBehaviorIds = annualState.intentionalUse.behaviors.map((behavior) => behavior.id);
for (let offset = 0; offset <= 400; offset += 1) {
  const date = new Date(annualNow.getFullYear(), annualNow.getMonth(), annualNow.getDate() - offset, 12);
  const dateKey = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  for (const behaviorId of annualBehaviorIds) {
    recordIntentionalBehaviorCheckIn(annualState, { behaviorId, dateKey, value: true }, annualNow);
  }
}
annualState.intentionalUse.behaviorCheckIns.push({
  id: "outside-backdating-window",
  behaviorId: "habit-reading",
  behaviorName: "Reading",
  value: 1,
  note: "",
  at: "2025-06-22T16:00:00.000Z",
  dateKey: "2025-06-22",
  weekKey: "2025-W25"
});
const annualSummary = intentionalUseSummary(annualState, {}, annualNow);
assert.equal(annualSummary.lifeLog.habitCheckIns.length, 4 * 401, "the complete 400-day backdating window must retain every daily habit result");
assert.equal(
  annualSummary.lifeLog.habitCheckIns.some((checkIn) => checkIn.id === "outside-backdating-window"),
  false,
  "summary cleanup must prune check-ins outside the supported backdating window"
);
assert.equal(
  annualSummary.lifeLog.habitCheckIns.some((checkIn) => checkIn.dateKey === "2025-06-23"),
  true,
  "the oldest valid backdated check-in must survive normalization and summary cleanup"
);

const retentionNow = new Date();
const retentionDateKey = trackingDateKey(retentionNow);
const bounded = normalizeIntentionalUse({
  behaviorCheckIns: Array.from({ length: 10_001 }, (_, index) => ({
    id: `bounded-${index}`,
    behaviorId: "habit-reading",
    behaviorName: "Reading",
    value: 1,
    note: "",
    at: retentionNow.toISOString(),
    dateKey: retentionDateKey,
    weekKey: "current"
  }))
});
assert.equal(bounded.behaviorCheckIns.length, 10_000, "age-based retention must retain an absolute storage safety ceiling");
