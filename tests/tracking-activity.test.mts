import assert from "node:assert/strict";

import {
  activityAnchorZone,
  activityFocusTarget,
  aggregateHabitActivity,
  captureActivityFocus,
  captureHabitFocusControl,
  habitActivityBarHeights,
  habitActivityDates,
  habitActivityLevel,
  habitActivityPeriodStart,
  nextHabitIndex,
  restoreActivityFocus,
  restoreHabitFocusControl,
  weeklyHabitActivity,
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

const partialWeekDates = habitActivityDates(new Date(2026, 6, 29, 12));
const partialTodayIndex = partialWeekDates.findIndex((date) => localDateKey(date) === "2026-07-29");
assert.equal(
  localDateKey(habitActivityPeriodStart(partialWeekDates, partialTodayIndex, "weekly")),
  "2026-07-27",
  "the current partial week's announced range must begin on its Monday"
);
assert.equal(
  localDateKey(habitActivityPeriodStart(partialWeekDates, 6, "weekly")),
  localDateKey(partialWeekDates[0]),
  "a completed historical week must retain its full Monday-through-Sunday range"
);
assert.equal(
  localDateKey(habitActivityPeriodStart(partialWeekDates, partialTodayIndex, "cumulative")),
  localDateKey(partialWeekDates[0])
);

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

const weeklyBars = weeklyHabitActivity([
  ...daily,
  { done: 2, missed: 1, unreported: 1, total: 4 },
  { done: 0, missed: 2, unreported: 2, total: 4 },
  { done: 3, missed: 0, unreported: 1, total: 4 },
  { done: 1, missed: 1, unreported: 2, total: 4 },
  { done: 0, missed: 0, unreported: 4, total: 4 }
]);
assert.deepEqual(weeklyBars, [
  { done: 11, missed: 5, unreported: 12, total: 28 },
  { done: 0, missed: 0, unreported: 4, total: 4 }
]);
assert.deepEqual(habitActivityBarHeights(weeklyBars, "weekly"), [7, 0]);
assert.deepEqual(habitActivityBarHeights(weeklyBars, "cumulative"), [7, 7]);
assert.deepEqual(habitActivityBarHeights([
  { done: 0, missed: 0, unreported: 7, total: 7 },
  { done: 2, missed: 0, unreported: 5, total: 7 },
  { done: 4, missed: 0, unreported: 3, total: 7 }
], "weekly"), [0, 4, 7]);
assert.deepEqual(habitActivityBarHeights([
  { done: 1, missed: 0, unreported: 6, total: 7 },
  { done: 1, missed: 0, unreported: 6, total: 7 },
  { done: 2, missed: 0, unreported: 5, total: 7 }
], "cumulative"), [2, 4, 7]);

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

assert.equal(activityAnchorZone(0), "start");
assert.equal(activityAnchorZone(17 * 7), "start");
assert.equal(activityAnchorZone(18 * 7), "middle");
assert.equal(activityAnchorZone(34 * 7), "middle");
assert.equal(activityAnchorZone(35 * 7), "end");
assert.equal(activityAnchorZone(51 * 7 + 6), "end");

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalElementConstructor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
try {
  class FakeActivityButton {
    dataset: Record<string, string> = {};
    disabled = false;
    focusCalls: FocusOptions[] = [];
    tabIndex: number;
    readonly classList: { contains: (name: string) => boolean };

    constructor(kind: "day" | "week", value: number, tabIndex = -1) {
      this.tabIndex = tabIndex;
      if (kind === "day") this.dataset.activityIndex = String(value);
      else this.dataset.activityWeek = String(value);
      const className = kind === "day" ? "habit-activity-cell" : "habit-activity-bar";
      this.classList = { contains: (name) => name === className };
    }

    focus(options?: FocusOptions): void {
      this.focusCalls.push(options || {});
    }
  }

  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeActivityButton,
    writable: true
  });

  const arrowedDayIndex = activityFocusTarget(8, "ArrowRight", 364, 359);
  const oldArrowedDay = new FakeActivityButton("day", arrowedDayIndex, 0);
  const activityControls: FakeActivityButton[] = [oldArrowedDay];
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { activeElement: oldArrowedDay },
    writable: true
  });
  const activityRoot = {
    contains: (value: unknown) => activityControls.includes(value as FakeActivityButton),
    querySelector: (selector: string) => {
      const value = selector.match(/="([^"]+)"\]/)?.[1];
      const key = selector.includes("data-activity-index") ? "activityIndex" : "activityWeek";
      return activityControls.find((button) => button.dataset[key] === value) || null;
    },
    querySelectorAll: (selector: string) => activityControls.filter((button) =>
      button.classList.contains(selector.slice(1)))
  } as unknown as HTMLElement;

  const dayIdentity = captureActivityFocus(activityRoot);
  assert.deepEqual(dayIdentity, { kind: "day", value: String(arrowedDayIndex) });
  const selectedDayAfterRender = new FakeActivityButton("day", 8, 0);
  const arrowedDayAfterRender = new FakeActivityButton("day", arrowedDayIndex);
  const dayPeerAfterRender = new FakeActivityButton("day", 22);
  activityControls.splice(0, activityControls.length, selectedDayAfterRender, arrowedDayAfterRender, dayPeerAfterRender);
  restoreActivityFocus(activityRoot, dayIdentity);
  assert.deepEqual(
    activityControls.map((button) => button.tabIndex),
    [-1, 0, -1],
    "a rerender must preserve the arrowed daily cell as the sole roving tab stop"
  );
  assert.deepEqual(arrowedDayAfterRender.focusCalls, [{ preventScroll: true }]);

  const oldArrowedWeek = new FakeActivityButton("week", 12, 0);
  activityControls.splice(0, activityControls.length, oldArrowedWeek);
  (document as unknown as { activeElement: unknown }).activeElement = oldArrowedWeek;
  const weekIdentity = captureActivityFocus(activityRoot);
  const selectedWeekAfterRender = new FakeActivityButton("week", 10, 0);
  const arrowedWeekAfterRender = new FakeActivityButton("week", 12);
  const weekPeerAfterRender = new FakeActivityButton("week", 13);
  activityControls.splice(0, activityControls.length, selectedWeekAfterRender, arrowedWeekAfterRender, weekPeerAfterRender);
  restoreActivityFocus(activityRoot, weekIdentity);
  assert.deepEqual(
    activityControls.map((button) => button.tabIndex),
    [-1, 0, -1],
    "a rerender must preserve the focused aggregate bar as the sole roving tab stop"
  );
  assert.deepEqual(arrowedWeekAfterRender.focusCalls, [{ preventScroll: true }]);
} finally {
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else delete (globalThis as unknown as Record<string, unknown>).document;
  if (originalElementConstructor) Object.defineProperty(globalThis, "HTMLElement", originalElementConstructor);
  else delete (globalThis as unknown as Record<string, unknown>).HTMLElement;
}

const originalButtonConstructor = Object.getOwnPropertyDescriptor(globalThis, "HTMLButtonElement");
try {
  class FakeButton {
    dataset: Record<string, string> = {};
    disabled = false;
    focusCalls: FocusOptions[] = [];

    constructor(identity = "") {
      if (identity) this.dataset.habitFocusControl = identity;
    }

    focus(options?: FocusOptions): void {
      this.focusCalls.push(options || {});
    }
  }
  Object.defineProperty(globalThis, "HTMLButtonElement", {
    configurable: true,
    value: FakeButton,
    writable: true
  });

  const done = new FakeButton("habit:first:status:success");
  const missed = new FakeButton("habit:first:status:missed");
  const outside = new FakeButton("habit:first:skip");
  const controls = [done, missed];
  const focusRoot = {
    contains: (value: unknown) => controls.includes(value as FakeButton),
    querySelectorAll: () => controls
  } as unknown as HTMLElement;

  const identity = captureHabitFocusControl(focusRoot, done as unknown as Element);
  assert.equal(identity, "habit:first:status:success");
  restoreHabitFocusControl(focusRoot, identity);
  assert.deepEqual(done.focusCalls, [{ preventScroll: true }], "an equivalent surviving action must regain focus");
  assert.equal(missed.focusCalls.length, 0);
  assert.equal(captureHabitFocusControl(focusRoot, outside as unknown as Element), null,
    "polling must not capture or move focus that was outside the check-in");

  controls.splice(controls.indexOf(done), 1);
  const replacementHabitDone = new FakeButton("habit:second:status:success");
  controls.push(replacementHabitDone);
  restoreHabitFocusControl(focusRoot, identity);
  assert.equal(done.focusCalls.length, 1, "a removed action must not receive synthetic focus");
  assert.equal(replacementHabitDone.focusCalls.length, 0, "the same action for a different habit must not inherit focus");

  missed.disabled = true;
  restoreHabitFocusControl(focusRoot, "habit:first:status:missed");
  assert.equal(missed.focusCalls.length, 0, "a disabled replacement action must not receive focus");
} finally {
  if (originalButtonConstructor) Object.defineProperty(globalThis, "HTMLButtonElement", originalButtonConstructor);
  else delete (globalThis as unknown as Record<string, unknown>).HTMLButtonElement;
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
