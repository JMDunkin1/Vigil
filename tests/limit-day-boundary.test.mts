import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { activeLimitPolicy, overrideLimitRules } from "../src/limits.js";
import { dateKey, endOfToday } from "../src/time.js";
import { recordUsage } from "../src/usage.js";
import type { UsageState } from "../src/types.js";

// Evaluate fixed past and future dates, including both sides of local midnight.
// Policy expiry must use the observation's day, never the host's current day.
for (const now of [new Date(2001, 0, 2, 0, 0, 1), new Date(2041, 6, 9, 23, 59, 50)]) {
  const originalTime = now.getTime();
  const expectedEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  assert.equal(endOfToday(now).getTime(), expectedEnd.getTime());
  assert.equal(now.getTime(), originalTime, "computing expiry must not mutate the observation");
  const state = defaultState();
  state.limitRules = [{ id: "daily", name: "Daily limit", enabled: true, type: "time", lockLevel: "deep", days: [], apps: ["Example App"], sites: [], limitMinutes: 1, unlocksAllowed: 0, blockMinutes: 0 }];
  const usage: UsageState = {};
  recordUsage(usage, { app: "Example App" }, 60, now);
  assert.ok(usage[dateKey(now)]);
  const policy = activeLimitPolicy(state, usage, { app: "Example App" }, now);
  assert.equal(policy?.endsAt, expectedEnd.toISOString());
  assert.equal(activeLimitPolicy(state, usage, { app: "Example App" }, now)?.limitBlock?.id, policy?.limitBlock?.id, "the daily block must remain active for the observation's day");
  overrideLimitRules(state, ["daily"], "", "test", now);
  assert.equal(state.overrides[0].until, expectedEnd.toISOString());
  assert.equal(activeLimitPolicy(state, usage, { app: "Example App" }, now), null);
}
console.log("Limit observation-day expiry checks passed.");
