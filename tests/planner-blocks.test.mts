import assert from "node:assert/strict";
import { defaultState, SOFT_BLOCK_PROFILE_ID } from "../src/defaults.js";
import { addEvent } from "../src/store.js";
import { completeIntentionalPlanBlock, intentionalUseSummary, upsertIntentionalPlanBlock, upsertIntentionalPlanItem, upsertIntentionalPlanList } from "../src/intentionalUse.js";
import { activePolicy } from "../src/policy.js";
import { protectedEditBlockers } from "../src/protection.js";
import { usageSummary } from "../src/usage.js";

const now = new Date("2026-06-04T15:30:00.000Z");
const state = defaultState();

const list = upsertIntentionalPlanList(state, {
  id: "school",
  name: "School",
  kind: "todo"
}, now);
const item = upsertIntentionalPlanItem(state, {
  id: "math-homework",
  listId: list.id,
  title: "Math homework",
  tags: ["school"]
}, now);
const block = upsertIntentionalPlanBlock(state, {
  id: "homework-block",
  title: "Homework",
  itemId: item.id,
  listId: list.id,
  startsAt: "2026-06-04T15:00:00.000Z",
  endsAt: "2026-06-04T17:00:00.000Z",
  mode: "homework",
  profileId: SOFT_BLOCK_PROFILE_ID,
  lockLevel: "deep",
  enabled: true,
  deviceTargets: ["computer"]
}, now);

const policy = activePolicy(state, now, { device: "computer" });
assert.equal(policy?.kind, "planner");
assert.equal(policy?.profile.id, SOFT_BLOCK_PROFILE_ID);
assert.equal(policy?.session.title, "Homework");
assert.equal(policy?.session.source, "planner");
assert.equal(policy?.plannerBlock?.id, block.id);
assert.equal(activePolicy(state, now, { device: "phone" }), null);
assert.equal(activePolicy(state, new Date("2026-06-04T17:01:00.000Z"), { device: "computer" }), null);

const summary = intentionalUseSummary(state, {}, now);
assert.equal(summary.lifeLog.planner.openItems, 1);
assert.equal(summary.lifeLog.planner.activeBlocks[0]?.id, block.id);
assert.equal(summary.lifeLog.planner.todayBlocks[0]?.title, "Homework");

addEvent(state, "planner_test_marker", {});
const usage = usageSummary({}, state, now);
assert.equal(usage.protectedSeconds, 30 * 60);

assert.equal(completeIntentionalPlanBlock(state, block.id, now)?.completed, true);
assert.equal(activePolicy(state, now, { device: "computer" }), null);

const clearedItem = upsertIntentionalPlanItem(state, {
  id: item.id,
  dueAt: null,
  notes: "",
  tags: []
}, now);
assert.equal(clearedItem.dueAt, null);
assert.equal(clearedItem.notes, "");
assert.deepEqual(clearedItem.tags, []);

const clearedBlock = upsertIntentionalPlanBlock(state, {
  id: block.id,
  itemId: "",
  listId: "",
  notes: "",
  startsAt: block.startsAt,
  endsAt: block.endsAt
}, now);
assert.equal(clearedBlock.itemId, "");
assert.equal(clearedBlock.listId, "");
assert.equal(clearedBlock.notes, "");

const overlapState = defaultState();
overlapState.settings.protectedEditsEnabled = true;
overlapState.schedules = [{
  id: "deep-schedule",
  name: "Deep schedule",
  enabled: true,
  mode: "focus",
  profileId: "default",
  lockLevel: "deep",
  days: [now.getDay()],
  start: "00:00",
  end: "23:59",
  wifiNetworks: [],
  deviceTargets: ["computer"]
}];
upsertIntentionalPlanBlock(overlapState, {
  id: "light-planner",
  title: "Light planner",
  startsAt: "2026-06-04T15:00:00.000Z",
  endsAt: "2026-06-04T17:00:00.000Z",
  profileId: SOFT_BLOCK_PROFILE_ID,
  lockLevel: "light",
  enabled: true,
  deviceTargets: ["computer"]
}, now);
const overlapPolicy = activePolicy(overlapState, now, { device: "computer" });
assert.equal(overlapPolicy?.kind, "schedule");
assert.equal(overlapPolicy?.session.lockLevel, "deep");
assert.equal(protectedEditBlockers(overlapState, { kind: "settings" }, now)[0]?.kind, "schedule");
