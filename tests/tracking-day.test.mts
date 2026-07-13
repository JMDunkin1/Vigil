import assert from "node:assert/strict";

import { millisecondsUntilTrackingDayRollover, nextTrackingDayRollover, trackingDay } from "../public/tracking-day.js";

assert.equal(localDateKey(trackingDay(new Date(2026, 6, 13, 2, 59, 59))), "2026-07-12");
assert.equal(localDateKey(trackingDay(new Date(2026, 6, 13, 3, 0, 0))), "2026-07-13");
assert.equal(nextTrackingDayRollover(new Date(2026, 6, 13, 2, 59, 59)).getHours(), 3);
assert.equal(millisecondsUntilTrackingDayRollover(new Date(2026, 6, 13, 2, 59, 59)), 1_000);
assert.equal(localDateKey(nextTrackingDayRollover(new Date(2026, 6, 13, 3, 0, 0))), "2026-07-14");

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
