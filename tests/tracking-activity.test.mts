import assert from "node:assert/strict";

import {
  activityFocusTarget,
  aggregateHabitActivity,
  habitActivityDates,
  habitActivityLevel,
  nextHabitIndex,
  type HabitActivityCounts,
  type HabitStatus
} from "../public/tracking-view.js";

const dates = habitActivityDates(new Date(2026, 6, 28, 12));
assert.equal(dates.length, 52 * 7);
assert.equal(localDateKey(dates[0]), "2025-08-04");
assert.equal(localDateKey(dates.at(-1) as Date), "2026-08-02");
assert.equal(dates[0].getDay(), 1, "the activity range must begin on Monday");
assert.equal(dates.at(-1)?.getDay(), 0, "the activity range must end on Sunday");
for (let index = 1; index < dates.length; index += 1) {
  const expected = new Date(dates[index - 1]);
  expected.setDate(expected.getDate() + 1);
  assert.equal(localDateKey(dates[index]), localDateKey(expected), "activity dates must advance by local calendar day across DST");
}

const leapDates = habitActivityDates(new Date(2024, 2, 2, 12));
assert.equal(leapDates.some((date) => localDateKey(date) === "2024-02-29"), true, "leap day must remain in the daily grid");

const daily: HabitActivityCounts[] = [
  { done: 0, missed: 0, unreported: 4, total: 4 },
  { done: 1, missed: 1, unreported: 2, total: 4 },
  { done: 4, missed: 0, unreported: 0, total: 4 }
];
assert.deepEqual(aggregateHabitActivity(daily, 1, "daily"), daily[1]);
assert.deepEqual(aggregateHabitActivity(daily, 2, "weekly"), {
  done: 5,
  missed: 1,
  unreported: 6,
  total: 12
});
assert.deepEqual(aggregateHabitActivity(daily, 2, "cumulative"), {
  done: 5,
  missed: 1,
  unreported: 6,
  total: 12
});

assert.equal(habitActivityLevel({ done: 0, missed: 4, unreported: 0, total: 4 }), 0);
assert.equal(habitActivityLevel({ done: 1, missed: 0, unreported: 3, total: 4 }), 1);
assert.equal(habitActivityLevel({ done: 2, missed: 0, unreported: 2, total: 4 }), 2);
assert.equal(habitActivityLevel({ done: 3, missed: 0, unreported: 1, total: 4 }), 3);
assert.equal(habitActivityLevel({ done: 4, missed: 0, unreported: 0, total: 4 }), 4);
assert.equal(habitActivityLevel({ done: 0, missed: 0, unreported: 0, total: 0 }), 0);

const mixed: HabitStatus[] = ["success", "missed", "unreported", "unreported"];
assert.equal(nextHabitIndex(mixed, 0), 2, "auto-advance must prefer the next unreported habit");
assert.equal(nextHabitIndex(mixed, 2), 3, "auto-advance must preserve forward ordering");
assert.equal(nextHabitIndex(["success", "missed", "success", "missed"], 1), 2, "a fully reported editable day must advance sequentially");
assert.equal(nextHabitIndex(["unreported"], 0), 0);
assert.equal(nextHabitIndex([], 0), -1);

assert.equal(activityFocusTarget(0, "ArrowUp", 364, 359), 0, "Monday must not wrap to the prior Sunday");
assert.equal(activityFocusTarget(6, "ArrowDown", 364, 359), 6, "Sunday must not wrap to the next Monday");
assert.equal(activityFocusTarget(5, "ArrowLeft", 364, 359), 5, "the first column must not wrap left");
assert.equal(activityFocusTarget(357, "ArrowRight", 364, 359), 357, "the last column must not wrap right");
assert.equal(activityFocusTarget(8, "ArrowUp", 364, 359), 7);
assert.equal(activityFocusTarget(8, "ArrowDown", 364, 359), 9);
assert.equal(activityFocusTarget(8, "ArrowLeft", 364, 359), 1);
assert.equal(activityFocusTarget(8, "ArrowRight", 364, 359), 15);
assert.equal(activityFocusTarget(8, "Home", 364, 359), 0);
assert.equal(activityFocusTarget(8, "End", 364, 359), 359);

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
