import assert from "node:assert/strict";

import { defaultState, NORMAL_PROFILE_ID } from "../src/defaults.js";
import { intentionalUseSummary, normalizeIntentionalUse, recordIntentionalBehaviorCheckIn } from "../src/intentionalUse.js";

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
