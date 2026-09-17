import assert from "node:assert/strict";
import { normalizeUsageDay, syncDeviceUsageSnapshot } from "../src/usage.js";
import type { UsageSegment, UsageState } from "../src/types.js";

const now = new Date(2026, 8, 17, 12);
const dayKey = "2026-09-17";
const start = new Date(2026, 8, 17).getTime();
const segment = (from: number, to: number, app = "Phone"): UsageSegment => ({
  startedAt: new Date(start + from * 1_000).toISOString(),
  endedAt: new Date(start + to * 1_000).toISOString(),
  app
});

// An independent pointwise oracle covers overlapping, nested, adjacent and
// missing ranges, including earlier long ranges containing later short ones.
let seed = 19;
function random(max: number): number {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
}
for (let trial = 0; trial < 200; trial += 1) {
  const ranges = () => Array.from({ length: 12 }, () => {
    const from = random(100);
    return { from, to: from + 1 + random(40) };
  });
  const previous = ranges();
  const incoming = trial % 3 === 0 ? [...ranges(), ...previous] : ranges();
  const expectedStale = previous.some(({ from, to }) => {
    for (let second = from; second < to; second += 1) {
      if (!incoming.some((range) => range.from <= second && range.to > second)) return true;
    }
    return false;
  });
  const usage: UsageState = {};
  const snapshot = (values: typeof previous) => ({
    device: "phone", dayKey, updatedAt: now.toISOString(), totalSeconds: 1_000,
    apps: { Phone: 1_000 }, segments: values.map(({ from, to }) => segment(from, to))
  });
  syncDeviceUsageSnapshot(usage, snapshot(previous), now);
  assert.equal(syncDeviceUsageSnapshot(usage, snapshot(incoming), now).stale, expectedStale,
    `coverage regression must preserve every previous interval (trial ${trial})`);
}

{
  const normalized = normalizeUsageDay({ devices: {
    computer: {
      totalSeconds: 100, apps: { Mac: 100 }, sites: {}, opens: { apps: {}, sites: {} }, segmentTimelineComplete: true,
      segments: [segment(0, 100, "Mac"), segment(10, 20, "Later Mac")]
    },
    phone: {
      totalSeconds: 50, apps: { "First Phone": 50 }, sites: {}, opens: { apps: {}, sites: {} }, segmentTimelineComplete: true,
      segments: [segment(20, 40, "First Phone"), segment(20, 70, "Second Phone")]
    }
  } });
  assert.equal(normalized.totalSeconds, 100, "overlapping devices must count wall time only once");
  assert.deepEqual(normalized.apps, { Mac: 50, "First Phone": 20, "Second Phone": 30 },
    "phone priority and stable insertion order must survive overlap and removal of the first winner");
}

console.log("Usage timeline efficiency regressions passed.");
