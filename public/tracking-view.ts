import type { DashboardData, DashboardItem, HabitCalendarCheckIn } from "./app-model.js";
import { millisecondsUntilTrackingDayRollover, trackingDay } from "./tracking-day.js";

type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;

interface TrackingViewContext {
  post: PostRequest;
  refresh(): Promise<void>;
  toast(message: string): void;
}

export type HabitStatus = "success" | "missed" | "unreported";
export type HabitActivityMode = "daily" | "weekly" | "cumulative";

export interface HabitActivityCounts {
  done: number;
  missed: number;
  unreported: number;
  total: number;
}

interface HabitActivityPeriod {
  start: Date;
  end: Date;
  counts: HabitActivityCounts;
}

export interface ActivityFocusIdentity {
  kind: "day" | "week";
  value: string;
}

const ACTIVITY_WEEKS = 52;
const DAYS_PER_WEEK = 7;

export function createTrackingView({ post, refresh, toast }: TrackingViewContext) {
  const focusSection = required<HTMLElement>("#habitFocus");
  const focusRoot = required<HTMLElement>("#habitQuickCheckIn");
  const activityRoot = required<HTMLElement>("#habitActivityGrid");
  const activityMonths = required<HTMLElement>("#habitActivityMonths");
  const activityStatus = required<HTMLElement>("#habitActivityStatus");
  const dialog = required<HTMLDialogElement>("#habitManagerDialog");
  let selectedDate = trackingDay();
  let selectedBehaviorId: string | null = null;
  let editableCompletedDateKey: string | null = null;
  let activityMode: HabitActivityMode = "daily";
  let data: DashboardData | null = null;
  let saving = false;
  let focusOpen = true;

  function bind(): void {
    required<HTMLButtonElement>("#habitManage").addEventListener("click", () => dialog.showModal());
    required<HTMLButtonElement>("#habitManagerClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-activity-mode]").forEach((button) => {
      button.addEventListener("click", () => {
        const mode = activityModeFrom(button.dataset.activityMode);
        if (!mode || mode === activityMode) return;
        activityMode = mode;
        if (mode !== "daily") focusOpen = false;
        renderActivity();
      });
    });
    scheduleTrackingDayRollover();
  }

  function render(next: DashboardData): void {
    data = next;
    renderFocus();
    renderActivity();
  }

  function renderFocus(): void {
    const focusedControl = captureHabitFocusControl(focusRoot);
    const behaviors = activeBehaviors(data);
    const values = checkInMap(habitCheckIns(data));
    const dateKey = localDateKey(selectedDate);
    const effectiveToday = trackingDay();
    const today = isSameDay(selectedDate, effectiveToday);
    focusRoot.replaceChildren();

    if (!behaviors.length) {
      selectedBehaviorId = null;
      focusRoot.append(focusEmptyState());
      updateTodayStatus(behaviors, values, effectiveToday);
      restoreHabitFocusControl(focusRoot, focusedControl);
      return;
    }

    const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)));
    const complete = statuses.every((status) => status !== "unreported");
    const locked = complete && editableCompletedDateKey !== dateKey;

    if (locked) {
      selectedBehaviorId = null;
      focusRoot.append(completedDayView(behaviors, statuses, selectedDate, today, () => {
        editableCompletedDateKey = dateKey;
        selectedBehaviorId = behaviors[0].id;
        renderFocus();
        focusHabitHeading();
      }));
      updateTodayStatus(behaviors, values, effectiveToday);
      restoreHabitFocusControl(focusRoot, focusedControl);
      return;
    }

    if (!selectedBehaviorId || !behaviors.some((behavior) => behavior.id === selectedBehaviorId)) {
      selectedBehaviorId = behaviors.find((_, index) => statuses[index] === "unreported")?.id || behaviors[0].id;
    }

    const selectedIndex = Math.max(0, behaviors.findIndex((behavior) => behavior.id === selectedBehaviorId));
    const behavior = behaviors[selectedIndex];
    const status = statuses[selectedIndex];
    const content = document.createElement("div");
    content.className = "habit-focus-editor";

    const step = document.createElement("div");
    step.className = "habit-focus-step";
    const position = document.createElement("p");
    position.className = "habit-focus-position";
    position.textContent = today
      ? `Habit ${selectedIndex + 1} of ${behaviors.length}`
      : `Habit ${selectedIndex + 1} of ${behaviors.length} · ${selectedDate.toLocaleDateString([], { month: "short", day: "numeric" })}`;
    const dots = habitDots(behaviors, statuses, selectedIndex, (behaviorId) => {
      selectedBehaviorId = behaviorId;
      renderFocus();
      focusRoot.querySelector<HTMLElement>(".habit-focus-dot.is-current")?.focus({ preventScroll: true });
    }, saving);
    step.append(position, dots);

    const heading = document.createElement("h2");
    heading.id = "habitFocusTitle";
    heading.className = "habit-focus-title";
    heading.tabIndex = -1;
    heading.textContent = behavior.name || "Habit";
    const description = document.createElement("p");
    description.className = "habit-focus-description";
    description.textContent = behavior.description || behavior.replacement || "Take one honest moment and record today.";

    const actions = document.createElement("div");
    actions.className = "habit-focus-actions";
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", `${behavior.name || "Habit"} result`);
    actions.append(
      focusStatusButton("Done", "success", status, behavior.id, () => {
        void saveHabitStatus(
          behavior.id,
          dateKey,
          status === "success" ? "unreported" : "success",
          status !== "success"
        );
      }),
      focusStatusButton("Missed", "missed", status, behavior.id, () => {
        void saveHabitStatus(
          behavior.id,
          dateKey,
          status === "missed" ? "unreported" : "missed",
          status !== "missed"
        );
      })
    );

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "habit-focus-skip";
    skip.dataset.habitFocusControl = `habit:${behavior.id}:skip`;
    skip.textContent = "Skip for now";
    skip.disabled = saving || behaviors.length < 2;
    skip.addEventListener("click", () => {
      selectedBehaviorId = behaviors[(selectedIndex + 1) % behaviors.length].id;
      renderFocus();
      focusHabitHeading();
    });

    const helper = document.createElement("p");
    helper.className = "habit-focus-helper";
    helper.textContent = "Your choice advances to the next habit.";

    content.append(step, heading, description, actions, skip, helper);
    focusRoot.append(content);
    updateTodayStatus(behaviors, values, effectiveToday);
    restoreHabitFocusControl(focusRoot, focusedControl);
  }

  function renderActivity(): void {
    const focusedActivity = captureActivityFocus(activityRoot);
    const behaviors = allBehaviors(data);
    const checkIns = habitCheckIns(data);
    const values = checkInMap(checkIns);
    const effectiveToday = trackingDay();
    const dates = habitActivityDates(effectiveToday);
    const dailyCounts = dailyActivityCounts(dates, behaviors, checkIns, values, effectiveToday);
    activityRoot.replaceChildren();
    activityMonths.replaceChildren();
    activityRoot.dataset.mode = activityMode;
    activityRoot.dataset.focusOpen = String(focusOpen);

    document.querySelectorAll<HTMLButtonElement>("[data-activity-mode]").forEach((button) => {
      const selected = button.dataset.activityMode === activityMode;
      button.classList.toggle("is-selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    if (!behaviors.length) {
      focusOpen = false;
      focusSection.hidden = true;
      activityRoot.setAttribute("aria-label", "Habit activity");
      const empty = document.createElement("p");
      empty.className = "habit-activity-empty";
      empty.textContent = "Activity will appear here after you add a habit.";
      activityRoot.append(empty);
      activityStatus.textContent = "No habit activity yet.";
      return;
    }

    activityRoot.setAttribute(
      "aria-label",
      `${activityModeLabel(activityMode)} habit activity from ${formatFullDate(dates[0])} through ${formatFullDate(effectiveToday)}`
    );

    const selectedKey = localDateKey(selectedDate);
    const todayKey = localDateKey(effectiveToday);
    const focusIndex = Math.max(0, dates.findIndex((date) => localDateKey(date) === selectedKey));
    focusSection.dataset.anchorZone = activityAnchorZone(focusIndex);
    focusSection.hidden = !focusOpen;

    if (activityMode === "daily") {
      dates.forEach((date, index) => {
        const dateKey = localDateKey(date);
        const future = date.getTime() > effectiveToday.getTime();
        const counts = dailyCounts[index];
        const level = habitActivityLevel(counts);
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = [
          "habit-activity-cell",
          `level-${level}`,
          counts.total === 0 ? "is-void" : "",
          dateKey === todayKey ? "is-today" : "",
          dateKey === selectedKey ? "is-selected" : "",
          future ? "is-future" : ""
        ].filter(Boolean).join(" ");
        cell.dataset.activityIndex = String(index);
        cell.dataset.level = String(level);
        cell.disabled = future;
        cell.tabIndex = !future && index === focusIndex ? 0 : -1;
        cell.setAttribute("aria-label", activityAriaLabel(date, date, counts, activityMode));
        if (dateKey === selectedKey) {
          cell.setAttribute("aria-controls", "habitFocus");
          cell.setAttribute("aria-expanded", String(focusOpen));
        }
        cell.title = activityTitle(date, date, counts, activityMode);
        cell.addEventListener("click", () => selectDate(date, true));
        cell.addEventListener("keydown", (event) => moveActivityFocus(event, index, dates.length));
        activityRoot.append(cell);
      });
    } else {
      renderActivityBars(dates, dailyCounts, effectiveToday, focusIndex);
    }

    activityRoot.append(focusSection);
    renderMonthLabels(dates, effectiveToday);
    const selectedPeriod = habitActivityPeriod(dates, dailyCounts, focusIndex, activityMode, effectiveToday);
    activityStatus.textContent = activityAriaLabel(
      selectedPeriod.end,
      selectedPeriod.start,
      selectedPeriod.counts,
      activityMode
    );
    restoreActivityFocus(activityRoot, focusedActivity);
  }

  function renderActivityBars(
    dates: Date[],
    dailyCounts: HabitActivityCounts[],
    effectiveToday: Date,
    focusIndex: number
  ): void {
    const weeklyCounts = weeklyHabitActivity(dailyCounts);
    const barMode = activityMode === "weekly" ? "weekly" : "cumulative";
    const heights = habitActivityBarHeights(weeklyCounts, barMode);
    const selectedWeek = Math.floor(focusIndex / DAYS_PER_WEEK);
    const todayIndex = Math.max(0, dates.findIndex((date) => isSameDay(date, effectiveToday)));
    const currentWeek = Math.floor(todayIndex / DAYS_PER_WEEK);

    heights.forEach((height, weekIndex) => {
      const activityIndex = Math.min(dates.length - 1, (weekIndex * DAYS_PER_WEEK) + DAYS_PER_WEEK - 1);
      const period = habitActivityPeriod(dates, dailyCounts, activityIndex, barMode, effectiveToday);
      const bar = document.createElement("button");
      bar.type = "button";
      bar.className = [
        "habit-activity-bar",
        weekIndex === selectedWeek ? "is-selected" : "",
        weekIndex > currentWeek ? "is-future" : ""
      ].filter(Boolean).join(" ");
      bar.dataset.activityWeek = String(weekIndex);
      bar.disabled = weekIndex > currentWeek;
      bar.tabIndex = weekIndex === selectedWeek ? 0 : -1;
      bar.setAttribute("aria-label", activityAriaLabel(period.end, period.start, period.counts, barMode));
      if (weekIndex === selectedWeek) {
        bar.setAttribute("aria-controls", "habitFocus");
        bar.setAttribute("aria-expanded", String(focusOpen));
      }
      bar.title = activityTitle(period.end, period.start, period.counts, barMode);
      for (let row = DAYS_PER_WEEK; row >= 1; row -= 1) {
        const segment = document.createElement("span");
        segment.className = `habit-activity-bar-cell${row <= height ? " is-filled" : ""}`;
        segment.setAttribute("aria-hidden", "true");
        bar.append(segment);
      }
      bar.addEventListener("click", () => selectDate(period.end, true));
      bar.addEventListener("keydown", (event) => moveActivityBarFocus(event, weekIndex, currentWeek));
      activityRoot.append(bar);
    });
  }

  function renderMonthLabels(dates: Date[], effectiveToday: Date): void {
    let previousMonth = "";
    for (let index = 0; index < ACTIVITY_WEEKS; index += 1) {
      const date = dates[index * DAYS_PER_WEEK];
      const label = document.createElement("span");
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      if (monthKey !== previousMonth && date.getTime() <= effectiveToday.getTime()) {
        previousMonth = monthKey;
        label.textContent = date.toLocaleDateString([], { month: "short" });
      }
      activityMonths.append(label);
    }
  }

  function moveActivityFocus(event: KeyboardEvent, index: number, length: number): void {
    const todayIndex = habitActivityDates(trackingDay()).findIndex((date) => isSameDay(date, trackingDay()));
    const targetIndex = activityFocusTarget(index, event.key, length, todayIndex);
    if (targetIndex === index || targetIndex < 0 || targetIndex >= length) return;
    const target = activityRoot.querySelector<HTMLButtonElement>(`[data-activity-index="${targetIndex}"]`);
    if (!applyActivityRovingFocus(activityRoot, ".habit-activity-cell", target)) return;
    event.preventDefault();
  }

  function moveActivityBarFocus(event: KeyboardEvent, weekIndex: number, currentWeek: number): void {
    let targetWeek = weekIndex;
    if (event.key === "ArrowLeft") targetWeek = Math.max(0, weekIndex - 1);
    else if (event.key === "ArrowRight") targetWeek = Math.min(currentWeek, weekIndex + 1);
    else if (event.key === "Home") targetWeek = 0;
    else if (event.key === "End") targetWeek = currentWeek;
    else return;
    if (targetWeek === weekIndex) return;
    const target = activityRoot.querySelector<HTMLButtonElement>(`[data-activity-week="${targetWeek}"]`);
    if (!applyActivityRovingFocus(activityRoot, ".habit-activity-bar", target)) return;
    event.preventDefault();
  }

  function selectDate(date: Date, revealFocus = false): void {
    if (date.getTime() > trackingDay().getTime()) return;
    const togglingSelectedDate = isSameDay(selectedDate, date);
    if (togglingSelectedDate && revealFocus) {
      focusOpen = !focusOpen;
      renderActivity();
      activityRoot.querySelector<HTMLButtonElement>(".is-selected:is(.habit-activity-cell, .habit-activity-bar)")?.focus({ preventScroll: true });
      return;
    }
    selectedDate = dayStart(date);
    selectedBehaviorId = null;
    editableCompletedDateKey = null;
    focusOpen = true;
    renderFocus();
    renderActivity();
    if (revealFocus) {
      focusHabitHeading();
      focusSection.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  function focusStatusButton(
    label: string,
    value: Exclude<HabitStatus, "unreported">,
    current: HabitStatus,
    behaviorId: string,
    onClick: () => void
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `habit-focus-action ${value}${current === value ? " is-selected" : ""}`;
    button.dataset.habitFocusControl = `habit:${behaviorId}:status:${value}`;
    button.textContent = label;
    button.disabled = saving;
    button.setAttribute("aria-pressed", String(current === value));
    button.title = current === value ? `Clear ${label.toLowerCase()} result` : `Mark ${label.toLowerCase()}`;
    button.addEventListener("click", onClick);
    return button;
  }

  async function saveHabitStatus(
    behaviorId: string,
    dateKey: string,
    next: HabitStatus,
    advance = false
  ): Promise<void> {
    if (saving) return;
    const nextBehaviorId = advance ? behaviorAfterCheckIn(behaviorId, dateKey) : null;
    saving = true;
    renderFocus();
    try {
      await post("/api/intentional-use/behavior/check-in", {
        behaviorId,
        dateKey,
        ...(next === "unreported" ? { clear: true } : { value: next === "success" }),
        note: "Habit check-in"
      });
      editableCompletedDateKey = null;
      if (nextBehaviorId) selectedBehaviorId = nextBehaviorId;
      toast(next === "success" ? "Marked done" : next === "missed" ? "Marked missed" : "Check-in cleared");
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save habit check-in");
    } finally {
      saving = false;
      renderFocus();
      renderActivity();
      focusHabitHeading();
    }
  }

  function behaviorAfterCheckIn(behaviorId: string, dateKey: string): string | null {
    const behaviors = activeBehaviors(data);
    const currentIndex = behaviors.findIndex((behavior) => behavior.id === behaviorId);
    if (currentIndex < 0) return null;
    const values = checkInMap(habitCheckIns(data));
    const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)));
    const nextIndex = nextHabitIndex(statuses, currentIndex);
    return nextIndex < 0 ? null : behaviors[nextIndex].id;
  }

  function scheduleTrackingDayRollover(): void {
    const previousToday = trackingDay();
    window.setTimeout(() => {
      const wasShowingToday = isSameDay(selectedDate, previousToday);
      const nextToday = trackingDay();
      if (wasShowingToday) selectDate(nextToday);
      else {
        renderFocus();
        renderActivity();
      }
      scheduleTrackingDayRollover();
    }, millisecondsUntilTrackingDayRollover());
  }

  function focusHabitHeading(): void {
    focusRoot.querySelector<HTMLElement>(".habit-focus-title")?.focus({ preventScroll: true });
  }

  return { bind, render };
}

export function captureActivityFocus(root: HTMLElement): ActivityFocusIdentity | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
  if (active.classList.contains("habit-activity-cell") && active.dataset.activityIndex) {
    return { kind: "day", value: active.dataset.activityIndex };
  }
  if (active.classList.contains("habit-activity-bar") && active.dataset.activityWeek) {
    return { kind: "week", value: active.dataset.activityWeek };
  }
  return null;
}

export function restoreActivityFocus(root: HTMLElement, identity: ActivityFocusIdentity | null): void {
  if (!identity) return;
  const attribute = identity.kind === "day" ? "data-activity-index" : "data-activity-week";
  const target = root.querySelector<HTMLButtonElement>(`[${attribute}="${identity.value}"]`);
  const peerSelector = identity.kind === "day" ? ".habit-activity-cell" : ".habit-activity-bar";
  applyActivityRovingFocus(root, peerSelector, target, { preventScroll: true });
}

export function applyActivityRovingFocus(
  root: HTMLElement,
  peerSelector: ".habit-activity-cell" | ".habit-activity-bar",
  target: HTMLButtonElement | null,
  options?: FocusOptions
): boolean {
  if (!target || target.disabled) return false;
  root.querySelectorAll<HTMLButtonElement>(peerSelector).forEach((button) => {
    button.tabIndex = button === target ? 0 : -1;
  });
  if (options) target.focus(options);
  else target.focus();
  return true;
}

export function captureHabitFocusControl(
  root: HTMLElement,
  active: Element | null = document.activeElement
): string | null {
  if (!(active instanceof HTMLButtonElement) || !root.contains(active)) return null;
  return active.dataset.habitFocusControl || null;
}

export function restoreHabitFocusControl(root: HTMLElement, identity: string | null): void {
  if (!identity) return;
  const target = [...root.querySelectorAll<HTMLButtonElement>("[data-habit-focus-control]")]
    .find((button) => button.dataset.habitFocusControl === identity);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

export function nextHabitIndex(statuses: HabitStatus[], currentIndex: number): number {
  if (!statuses.length || currentIndex < 0 || currentIndex >= statuses.length) return -1;
  if (statuses.length === 1) return currentIndex;
  for (let offset = 1; offset < statuses.length; offset += 1) {
    const candidate = (currentIndex + offset) % statuses.length;
    if (statuses[candidate] === "unreported") return candidate;
  }
  return (currentIndex + 1) % statuses.length;
}

export function activityFocusTarget(
  index: number,
  key: string,
  length: number,
  todayIndex: number
): number {
  if (index < 0 || index >= length) return index;
  const row = index % DAYS_PER_WEEK;
  if (key === "ArrowUp") return row === 0 ? index : index - 1;
  if (key === "ArrowDown") return row === DAYS_PER_WEEK - 1 ? index : index + 1;
  if (key === "ArrowLeft") return index < DAYS_PER_WEEK ? index : index - DAYS_PER_WEEK;
  if (key === "ArrowRight") return index + DAYS_PER_WEEK >= length ? index : index + DAYS_PER_WEEK;
  if (key === "Home") return 0;
  if (key === "End") return Math.min(length - 1, Math.max(0, todayIndex));
  return index;
}

export function activityAnchorZone(index: number): "start" | "middle" | "end" {
  const week = Math.max(0, Math.min(ACTIVITY_WEEKS - 1, Math.floor(index / DAYS_PER_WEEK)));
  if (week < 18) return "start";
  if (week < 35) return "middle";
  return "end";
}

export function habitActivityDates(todayValue: Date): Date[] {
  const currentWeekStart = dayStart(todayValue);
  const mondayOffset = (currentWeekStart.getDay() + 6) % DAYS_PER_WEEK;
  currentWeekStart.setDate(currentWeekStart.getDate() - mondayOffset - ((ACTIVITY_WEEKS - 1) * DAYS_PER_WEEK));
  return Array.from({ length: ACTIVITY_WEEKS * DAYS_PER_WEEK }, (_, index) => {
    return new Date(
      currentWeekStart.getFullYear(),
      currentWeekStart.getMonth(),
      currentWeekStart.getDate() + index
    );
  });
}

export function aggregateHabitActivity(
  daily: HabitActivityCounts[],
  index: number,
  mode: HabitActivityMode
): HabitActivityCounts {
  if (!daily.length || index < 0 || index >= daily.length) return emptyActivityCounts();
  const start = mode === "daily" ? index : mode === "weekly" ? Math.max(0, index - 6) : 0;
  return daily.slice(start, index + 1).reduce((total, counts) => ({
    done: total.done + counts.done,
    missed: total.missed + counts.missed,
    unreported: total.unreported + counts.unreported,
    total: total.total + counts.total
  }), emptyActivityCounts());
}

export function weeklyHabitActivity(daily: HabitActivityCounts[]): HabitActivityCounts[] {
  const output: HabitActivityCounts[] = [];
  for (let index = 0; index < daily.length; index += DAYS_PER_WEEK) {
    output.push(daily.slice(index, index + DAYS_PER_WEEK).reduce(sumActivityCounts, emptyActivityCounts()));
  }
  return output;
}

export function habitActivityPeriod(
  dates: Date[],
  daily: HabitActivityCounts[],
  index: number,
  mode: HabitActivityMode,
  effectiveToday: Date
): HabitActivityPeriod {
  if (!dates.length) throw new Error("Habit activity dates are required.");
  const boundedIndex = Math.max(0, Math.min(dates.length - 1, index));
  const endIndex = mode === "daily"
    ? boundedIndex
    : Math.min(dates.length - 1, (Math.floor(boundedIndex / DAYS_PER_WEEK) * DAYS_PER_WEEK) + DAYS_PER_WEEK - 1);
  const startIndex = mode === "daily"
    ? endIndex
    : mode === "weekly"
      ? Math.floor(endIndex / DAYS_PER_WEEK) * DAYS_PER_WEEK
      : 0;
  return {
    start: dates[startIndex],
    end: earlierDate(dates[endIndex], effectiveToday),
    counts: aggregateHabitActivity(daily, endIndex, mode)
  };
}

export function habitActivityBarHeights(
  weekly: HabitActivityCounts[],
  mode: Exclude<HabitActivityMode, "daily">
): number[] {
  let runningDone = 0;
  const values = weekly.map((counts) => {
    if (mode === "weekly") return counts.done;
    runningDone += counts.done;
    return runningDone;
  });
  const maximum = Math.max(0, ...values);
  return values.map((value) => value <= 0 || maximum <= 0
    ? 0
    : Math.min(DAYS_PER_WEEK, Math.max(1, Math.ceil((value / maximum) * DAYS_PER_WEEK))));
}

export function habitActivityLevel(counts: HabitActivityCounts): number {
  if (counts.total <= 0 || counts.done <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((counts.done / counts.total) * 4)));
}

function dailyActivityCounts(
  dates: Date[],
  behaviors: DashboardItem[],
  checkIns: HabitCalendarCheckIn[],
  values: Map<string, HabitCalendarCheckIn>,
  effectiveToday: Date
): HabitActivityCounts[] {
  const firstDateKey = localDateKey(dates[0]);
  const todayKey = localDateKey(effectiveToday);
  const behaviorWindows = new Map(behaviors.map((behavior) => [
    behavior.id,
    behaviorActivityWindow(behavior, checkIns, firstDateKey, todayKey)
  ]));
  return dates.map((date) => {
    if (date.getTime() > effectiveToday.getTime()) return emptyActivityCounts();
    const dateKey = localDateKey(date);
    const counts = emptyActivityCounts();
    for (const behavior of behaviors) {
      const window = behaviorWindows.get(behavior.id) || { start: firstDateKey, end: todayKey };
      if (dateKey < window.start || dateKey > window.end) continue;
      counts.total += 1;
      const status = statusFor(values.get(`${behavior.id}:${dateKey}`));
      if (status === "success") counts.done += 1;
      else if (status === "missed") counts.missed += 1;
      else counts.unreported += 1;
    }
    return counts;
  });
}

function behaviorActivityWindow(
  behavior: DashboardItem,
  checkIns: HabitCalendarCheckIn[],
  fallback: string,
  todayKey: string
): { start: string; end: string } {
  const checkInDateKeys: string[] = [];
  const createdAt = dateKeyFromTimestamp(behavior.createdAt);
  for (const checkIn of checkIns) {
    if (String(checkIn.behaviorId || "") !== behavior.id) continue;
    const checkInDateKey = String(checkIn.dateKey || dateKeyFromTimestamp(checkIn.at));
    if (checkInDateKey) checkInDateKeys.push(checkInDateKey);
  }
  const earliest = [createdAt, ...checkInDateKeys].filter(Boolean).sort()[0] || fallback;
  const start = earliest < fallback ? fallback : earliest;
  if (behavior.active !== false) return { start, end: todayKey };
  const updatedAt = dateKeyFromTimestamp(behavior.updatedAt);
  const latest = [updatedAt, ...checkInDateKeys].filter(Boolean).sort().at(-1) || start;
  const end = latest < start ? start : latest > todayKey ? todayKey : latest;
  return { start, end };
}

function habitDots(
  behaviors: DashboardItem[],
  statuses: HabitStatus[],
  selectedIndex: number,
  select: (behaviorId: string) => void,
  disabled = false
): HTMLElement {
  const dots = document.createElement("div");
  dots.className = "habit-focus-dots";
  dots.setAttribute("role", "group");
  dots.setAttribute("aria-label", "Choose a habit");
  behaviors.forEach((behavior, index) => {
    const dot = document.createElement("button");
    dot.type = "button";
    dot.className = `habit-focus-dot ${statuses[index]}${index === selectedIndex ? " is-current" : ""}`;
    dot.dataset.habitFocusControl = `habit:${behavior.id}`;
    dot.disabled = disabled;
    dot.setAttribute("aria-label", `${behavior.name || `Habit ${index + 1}`}: ${statusLabelFor(statuses[index])}`);
    dot.setAttribute("aria-pressed", String(index === selectedIndex));
    dot.title = behavior.name || `Habit ${index + 1}`;
    dot.addEventListener("click", () => select(behavior.id));
    dots.append(dot);
  });
  return dots;
}

function completedDayView(
  behaviors: DashboardItem[],
  statuses: HabitStatus[],
  selectedDate: Date,
  today: boolean,
  edit: () => void
): HTMLElement {
  const content = document.createElement("div");
  content.className = "habit-focus-editor habit-focus-complete";
  content.setAttribute("role", "status");

  const step = document.createElement("div");
  step.className = "habit-focus-step";
  const position = document.createElement("p");
  position.className = "habit-focus-position";
  position.textContent = today
    ? `${behaviors.length} of ${behaviors.length} recorded`
    : `${behaviors.length} of ${behaviors.length} recorded · ${selectedDate.toLocaleDateString([], { month: "short", day: "numeric" })}`;
  const dots = habitDots(behaviors, statuses, -1, () => undefined, true);
  step.append(position, dots);

  const heading = document.createElement("h2");
  heading.id = "habitFocusTitle";
  heading.className = "habit-focus-title";
  heading.tabIndex = -1;
  heading.textContent = "All set.";
  const description = document.createElement("p");
  description.className = "habit-focus-description";
  description.textContent = today
    ? "You're done filling out your habits for today."
    : "You're done filling out your habits for this day.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "habit-focus-edit";
  button.dataset.habitFocusControl = `edit:${localDateKey(selectedDate)}`;
  button.textContent = today ? "Edit today's answers" : "Edit this day's answers";
  button.addEventListener("click", edit);

  content.append(step, heading, description, button);
  return content;
}

function focusEmptyState(): HTMLElement {
  const content = document.createElement("div");
  content.className = "habit-focus-editor habit-focus-empty";
  const heading = document.createElement("h2");
  heading.id = "habitFocusTitle";
  heading.className = "habit-focus-title";
  heading.tabIndex = -1;
  heading.textContent = "No habits yet.";
  const description = document.createElement("p");
  description.className = "habit-focus-description";
  description.textContent = "Use Manage habits to add the first one.";
  content.append(heading, description);
  return content;
}

function activeBehaviors(data: DashboardData | null): DashboardItem[] {
  return allBehaviors(data).filter((behavior) => behavior.active !== false);
}

function allBehaviors(data: DashboardData | null): DashboardItem[] {
  return data?.intentionalUse?.lifeLog?.behaviors || [];
}

function habitCheckIns(data: DashboardData | null): HabitCalendarCheckIn[] {
  const lifeLog = data?.intentionalUse?.lifeLog;
  return lifeLog?.calendar?.checkIns?.length
    ? lifeLog.calendar.checkIns
    : lifeLog?.habitCheckIns?.length
      ? lifeLog.habitCheckIns
      : (lifeLog?.recentCheckIns || []);
}

function updateTodayStatus(
  behaviors: DashboardItem[],
  values: Map<string, HabitCalendarCheckIn>,
  effectiveToday: Date
): void {
  const todayValues = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${localDateKey(effectiveToday)}`)));
  const todayRecorded = todayValues.filter((status) => status !== "unreported").length;
  const todayDone = todayValues.filter((status) => status === "success").length;
  const lifeLogStatus = required<HTMLElement>("#lifeLogStatus");
  lifeLogStatus.textContent = `${todayRecorded}/${behaviors.length} today`;
  lifeLogStatus.className = todayRecorded === behaviors.length ? "pill good" : todayDone ? "pill neutral" : "pill neutral";
}

function checkInMap(checkIns: HabitCalendarCheckIn[]): Map<string, HabitCalendarCheckIn> {
  const output = new Map<string, HabitCalendarCheckIn>();
  for (const checkIn of checkIns) {
    const behaviorId = String(checkIn.behaviorId || "");
    const dateKey = String(checkIn.dateKey || dateKeyFromTimestamp(checkIn.at));
    const key = `${behaviorId}:${dateKey}`;
    if (behaviorId && dateKey && !output.has(key)) output.set(key, checkIn);
  }
  return output;
}

function statusFor(checkIn: HabitCalendarCheckIn | undefined): HabitStatus {
  if (!checkIn) return "unreported";
  return Number(checkIn.value || 0) > 0 ? "success" : "missed";
}

function statusLabelFor(status: HabitStatus): string {
  return status === "success" ? "done" : status === "missed" ? "missed" : "not recorded";
}

function activityModeFrom(value: string | undefined): HabitActivityMode | null {
  return value === "daily" || value === "weekly" || value === "cumulative" ? value : null;
}

function activityModeLabel(mode: HabitActivityMode): string {
  return mode === "daily" ? "Daily" : mode === "weekly" ? "Seven-day" : "Cumulative";
}

function activityAriaLabel(
  periodEnd: Date,
  periodStart: Date,
  counts: HabitActivityCounts,
  mode: HabitActivityMode
): string {
  const countsLabel = `${counts.done} habits done, ${counts.missed} missed, ${counts.unreported} not recorded, ${counts.total} total`;
  if (mode === "daily") return `${formatFullDate(periodEnd)}: ${countsLabel}.`;
  const period = mode === "weekly" ? "Seven-day habit activity" : "Cumulative habit activity";
  return `${period} from ${formatFullDate(periodStart)} through ${formatFullDate(periodEnd)}: ${countsLabel}.`;
}

function activityTitle(
  periodEnd: Date,
  periodStart: Date,
  counts: HabitActivityCounts,
  mode: HabitActivityMode
): string {
  const countsLabel = `${counts.done} done · ${counts.missed} missed · ${counts.unreported} not recorded`;
  if (mode === "daily") return `${formatShortDate(periodEnd)} · ${countsLabel}`;
  return `${formatShortDate(periodStart)}–${formatShortDate(periodEnd)} · ${countsLabel}`;
}

function formatFullDate(value: Date): string {
  return value.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function formatShortDate(value: Date): string {
  return value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

function emptyActivityCounts(): HabitActivityCounts {
  return { done: 0, missed: 0, unreported: 0, total: 0 };
}

function sumActivityCounts(total: HabitActivityCounts, counts: HabitActivityCounts): HabitActivityCounts {
  total.done += counts.done;
  total.missed += counts.missed;
  total.unreported += counts.unreported;
  total.total += counts.total;
  return total;
}

function earlierDate(left: Date, right: Date): Date {
  return left.getTime() <= right.getTime() ? left : right;
}

function dayStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function isSameDay(left: Date, right: Date): boolean {
  return localDateKey(left) === localDateKey(right);
}

function localDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateKeyFromTimestamp(value: unknown): string {
  const date = value ? new Date(String(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? localDateKey(date) : "";
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing tracking element: ${selector}`);
  return element;
}
