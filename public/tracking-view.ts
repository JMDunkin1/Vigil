import type { DashboardData, DashboardItem, HabitCalendarCheckIn } from "./app-model.js";
import { millisecondsUntilTrackingDayRollover, trackingDay } from "./tracking-day.js";

type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;

interface TrackingViewContext {
  post: PostRequest;
  refresh(): Promise<void>;
  toast(message: string): void;
}

type HabitStatus = "success" | "missed" | "unreported";

export function createTrackingView({ post, refresh, toast }: TrackingViewContext) {
  const root = required<HTMLElement>("#habitCalendar");
  const quickRoot = required<HTMLElement>("#habitQuickCheckIn");
  const monthLabel = required<HTMLElement>("#habitCalendarMonth");
  const statusLabel = required<HTMLElement>("#habitCalendarStatus");
  const dateInput = required<HTMLInputElement>("#habitSelectedDate");
  const dialog = required<HTMLDialogElement>("#habitManagerDialog");
  let selectedMonth = monthStart(trackingDay());
  let selectedDate = trackingDay();
  let selectedBehaviorId: string | null = null;
  let editableCompletedDateKey: string | null = null;
  let data: DashboardData | null = null;
  let saving = false;

  function bind(): void {
    required<HTMLButtonElement>("#habitPreviousMonth").addEventListener("click", () => changeMonth(-1));
    required<HTMLButtonElement>("#habitNextMonth").addEventListener("click", () => changeMonth(1));
    required<HTMLButtonElement>("#habitCurrentMonth").addEventListener("click", () => {
      selectedMonth = monthStart(trackingDay());
      renderCalendar();
      renderQuickCheckIn();
    });
    required<HTMLButtonElement>("#habitSelectedPrevious").addEventListener("click", () => changeSelectedDay(-1));
    required<HTMLButtonElement>("#habitSelectedNext").addEventListener("click", () => changeSelectedDay(1));
    required<HTMLButtonElement>("#habitSelectedToday").addEventListener("click", () => selectDate(trackingDay()));
    dateInput.max = localDateKey(trackingDay());
    dateInput.addEventListener("change", () => {
      const date = dateFromKey(dateInput.value);
      if (date) selectDate(date);
    });
    required<HTMLButtonElement>("#habitMarkRemainingDone").addEventListener("click", () => {
      void saveSelectedDay("remaining-done");
    });
    required<HTMLButtonElement>("#habitClearSelectedDay").addEventListener("click", () => {
      void saveSelectedDay("clear");
    });
    required<HTMLButtonElement>("#habitManage").addEventListener("click", () => dialog.showModal());
    required<HTMLButtonElement>("#habitManagerClose").addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    scheduleTrackingDayRollover();
  }

  function render(next: DashboardData): void {
    data = next;
    renderCalendar();
    renderQuickCheckIn();
  }

  function changeMonth(amount: number): void {
    selectedMonth = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + amount, 1);
    renderCalendar();
    renderQuickCheckIn();
  }

  function renderCalendar(): void {
    monthLabel.textContent = selectedMonth.toLocaleDateString([], { month: "long", year: "numeric" });
    root.replaceChildren();
    const pulseRoot = required<HTMLElement>("#habitMonthPulse");
    const monthRate = required<HTMLElement>("#habitMonthRate");
    const monthSummary = required<HTMLElement>("#habitMonthSummary");
    const monthCompleted = required<HTMLElement>("#habitMonthCompleted");
    const monthRecorded = required<HTMLElement>("#habitMonthRecorded");
    const monthDayCount = required<HTMLElement>("#habitMonthDayCount");
    const monthTrend = required<SVGSVGElement>("#habitMonthTrend");
    pulseRoot.replaceChildren();
    monthTrend.replaceChildren();
    const dates = datesInMonth(selectedMonth);
    monthDayCount.textContent = `${dates.length} days`;
    const lifeLog = data?.intentionalUse?.lifeLog;
    const behaviors = (lifeLog?.behaviors || []).filter((behavior) => behavior.active !== false);
    const checkIns = lifeLog?.calendar?.checkIns?.length
      ? lifeLog.calendar.checkIns
      : lifeLog?.habitCheckIns?.length
        ? lifeLog.habitCheckIns
        : (lifeLog?.recentCheckIns || []);

    if (!behaviors.length) {
      const empty = document.createElement("div");
      empty.className = "habit-calendar-empty";
      empty.append(
        textNode("strong", "No habits yet"),
        textNode("p", "Create a behavior below, then use this calendar to keep the chain visible.")
      );
      root.append(empty);
      monthRate.textContent = "—";
      monthSummary.textContent = "Add a habit to begin your rhythm";
      monthCompleted.textContent = "—";
      monthRecorded.textContent = "No active habits";
      statusLabel.textContent = "Create a habit to begin tracking.";
      return;
    }

    const values = checkInMap(checkIns);
    renderMonthPulse(pulseRoot, dates, behaviors, values);
    const effectiveToday = trackingDay();
    const today = effectiveToday.getTime();
    const visibleDates = dates.filter((date) => date.getTime() <= today);
    const monthStatuses = visibleDates.flatMap((date) => behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${localDateKey(date)}`))));
    const reported = monthStatuses.filter((status) => status !== "unreported");
    const completed = reported.filter((status) => status === "success").length;
    monthRate.textContent = reported.length ? `${Math.round((completed / reported.length) * 100)}%` : "—";
    monthSummary.textContent = reported.length
      ? `${completed} of ${reported.length} check-ins completed`
      : "";
    monthCompleted.textContent = String(completed);
    monthRecorded.textContent = reported.length
      ? `${reported.length} check-in${reported.length === 1 ? "" : "s"} recorded`
      : "No check-ins yet";
    renderTrend(monthTrend, visibleDates, behaviors, values);
    const table = document.createElement("table");
    table.className = "habit-calendar-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const habitHeading = document.createElement("th");
    habitHeading.scope = "col";
    habitHeading.textContent = "Habit";
    headRow.append(habitHeading);
    for (const date of dates) {
      const heading = document.createElement("th");
      heading.scope = "col";
      heading.className = isSameDay(date, effectiveToday) ? "is-today" : "";
      heading.textContent = String(date.getDate());
      heading.title = date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
      headRow.append(heading);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    for (const behavior of behaviors) body.append(habitRow(behavior, dates, behaviors, values));
    table.append(body);
    root.append(table);

    const hasCalendar = Boolean(lifeLog?.calendar?.checkIns || lifeLog?.habitCheckIns);
    statusLabel.textContent = hasCalendar
      ? "Click a day to mark it done or missed."
      : "Recent check-ins are shown. Click a day to add a result.";
  }

  function renderMonthPulse(
    pulseRoot: HTMLElement,
    dates: Date[],
    behaviors: DashboardItem[],
    values: Map<string, HabitCalendarCheckIn>
  ): void {
    const effectiveToday = trackingDay();
    const today = effectiveToday.getTime();
    for (const date of dates) {
      const key = localDateKey(date);
      const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${key}`)));
      const reported = statuses.filter((status) => status !== "unreported").length;
      const done = statuses.filter((status) => status === "success").length;
      const future = date.getTime() > today;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `habit-pulse-day${isSameDay(date, effectiveToday) ? " is-today" : ""}${future ? " is-future" : ""}${reported ? " has-data" : ""}`;
      button.disabled = future;
      button.dataset.reported = reported ? "true" : "false";
      button.setAttribute("aria-label", `${date.toLocaleDateString([], { month: "long", day: "numeric" })}: ${done} done, ${reported - done} missed, ${behaviors.length - reported} not recorded`);
      button.title = future ? "Future date" : `${done} done · ${reported - done} missed`;
      const bar = document.createElement("progress");
      bar.max = behaviors.length;
      bar.value = reported;
      bar.dataset.completed = String(done);
      bar.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = String(date.getDate());
      button.append(bar, label);
      button.addEventListener("click", () => selectDate(date));
      pulseRoot.append(button);
    }
  }

  function renderTrend(
    svg: SVGSVGElement,
    dates: Date[],
    behaviors: DashboardItem[],
    values: Map<string, HabitCalendarCheckIn>
  ): void {
    const width = 420;
    const baseline = 91;
    const points = dates.map((date, index) => {
      const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${localDateKey(date)}`)));
      const reported = statuses.filter((status) => status !== "unreported");
      const completion = reported.length ? reported.filter((status) => status === "success").length / reported.length : 0;
      const x = dates.length <= 1 ? 0 : (index / (dates.length - 1)) * width;
      const y = baseline - completion * 72;
      return { x, y };
    });
    if (!points.length) return;
    const line = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
    const area = `${line} L${points.at(-1)?.x.toFixed(1)},${baseline} L0,${baseline} Z`;
    svg.append(
      svgNode("path", { class: "tracking-trend-area", d: area }),
      svgNode("path", { class: "tracking-trend-line", d: line })
    );
    const last = points.at(-1);
    if (last) svg.append(svgNode("circle", { class: "tracking-trend-point", cx: last.x, cy: last.y, r: 5 }));
  }

  function habitRow(
    behavior: DashboardItem,
    dates: Date[],
    behaviors: DashboardItem[],
    values: Map<string, HabitCalendarCheckIn>
  ): HTMLTableRowElement {
    const row = document.createElement("tr");
    const label = document.createElement("th");
    label.scope = "row";
    label.textContent = behavior.name || "Habit";
    label.title = behavior.description || behavior.replacement || behavior.name || "Habit";
    row.append(label);

    for (const date of dates) {
      const dateKey = localDateKey(date);
      const checkIn = values.get(`${behavior.id}:${dateKey}`);
      const habitStatus = statusFor(checkIn);
      const cell = document.createElement("td");
      const button = document.createElement("button");
      const effectiveToday = trackingDay();
      const today = isSameDay(date, effectiveToday);
      const future = date.getTime() > effectiveToday.getTime();
      const locked = dateIsComplete(dateKey, behaviors, values) && editableCompletedDateKey !== dateKey;
      button.type = "button";
      button.className = `habit-day ${habitStatus}${today ? " is-today" : ""}${future ? " is-future" : ""}${locked ? " is-locked" : ""}`;
      button.dataset.behaviorId = behavior.id;
      button.dataset.dateKey = dateKey;
      button.dataset.status = habitStatus;
      button.textContent = habitStatus === "success" ? "✓" : habitStatus === "missed" ? "×" : "";
      button.disabled = future || saving || locked;
      button.setAttribute("aria-label", `${behavior.name || "Habit"}, ${date.toLocaleDateString()}, ${statusLabelFor(habitStatus)}${future ? ". Future dates cannot be recorded." : locked ? ". This completed day is locked against accidental changes." : ". Select to change this result."}`);
      button.title = future ? "Future date" : locked ? "Completed day locked" : "Change this result";
      button.addEventListener("click", () => {
        selectedDate = dayStart(date);
        void recordDate(behavior.id, dateKey, habitStatus);
      });
      cell.append(button);
      row.append(cell);
    }
    return row;
  }

  async function recordDate(behaviorId: string, dateKey: string, current: HabitStatus): Promise<void> {
    await saveHabitStatus(behaviorId, dateKey, current === "success" ? "missed" : "success");
  }

  function renderQuickCheckIn(): void {
    const lifeLog = data?.intentionalUse?.lifeLog;
    const behaviors = (lifeLog?.behaviors || []).filter((behavior) => behavior.active !== false);
    const values = checkInMap(lifeLog?.calendar?.checkIns?.length
      ? lifeLog.calendar.checkIns
      : lifeLog?.habitCheckIns?.length
        ? lifeLog.habitCheckIns
        : (lifeLog?.recentCheckIns || []));
    const dateKey = localDateKey(selectedDate);
    const effectiveToday = trackingDay();
    const today = isSameDay(selectedDate, effectiveToday);
    const title = required<HTMLElement>("#dailyCheckInTitle");
    const progress = required<HTMLElement>("#dailyCheckInProgress");
    const next = required<HTMLButtonElement>("#habitSelectedNext");
    const finish = required<HTMLButtonElement>("#habitMarkRemainingDone");
    const clear = required<HTMLButtonElement>("#habitClearSelectedDay");
    const toolbar = required<HTMLElement>("#dailyCheckInToolbar");
    const meter = required<HTMLProgressElement>("#dailyCheckInMeterBar");

    title.textContent = today
      ? "Today"
      : selectedDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    dateInput.value = dateKey;
    next.disabled = today || saving;
    quickRoot.replaceChildren();
    toolbar.hidden = false;

    if (!behaviors.length) {
      progress.textContent = "No active habits";
      meter.value = 0;
      finish.disabled = true;
      clear.disabled = true;
      const empty = document.createElement("p");
      empty.className = "habit-quick-empty";
      empty.textContent = "Add a habit to begin.";
      quickRoot.append(empty);
      return;
    }

    const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)));
    const recorded = statuses.filter((status) => status !== "unreported").length;
    const done = statuses.filter((status) => status === "success").length;
    const complete = recorded === behaviors.length;
    const locked = complete && editableCompletedDateKey !== dateKey;
    meter.value = Math.round((recorded / behaviors.length) * 100);
    meter.parentElement?.classList.toggle("is-complete", complete);
    progress.textContent = complete
      ? `${done} done · ${behaviors.length - done} missed · complete`
      : `${recorded} of ${behaviors.length} recorded`;
    finish.disabled = saving || complete;
    clear.disabled = saving || recorded === 0;

    if (locked) {
      toolbar.hidden = true;
      selectedBehaviorId = null;
      quickRoot.append(completedDayCard(today, () => {
        editableCompletedDateKey = dateKey;
        renderCalendar();
        renderQuickCheckIn();
      }));
      updateTodayStatus(behaviors, values, effectiveToday);
      return;
    }

    if (!selectedBehaviorId || !behaviors.some((behavior) => behavior.id === selectedBehaviorId)) {
      selectedBehaviorId = behaviors.find((_, index) => statuses[index] === "unreported")?.id || behaviors[0].id;
    }
    const selectedIndex = Math.max(0, behaviors.findIndex((behavior) => behavior.id === selectedBehaviorId));
    const behavior = behaviors[selectedIndex];
    const status = statuses[selectedIndex];
    const pickerSelect = document.createElement("select");
    pickerSelect.className = "habit-quick-select";
    pickerSelect.setAttribute("aria-label", "Choose a habit to check in");
    pickerSelect.disabled = saving;
    behaviors.forEach((optionBehavior, index) => {
      const option = document.createElement("option");
      const optionStatus = statuses[index];
      option.value = optionBehavior.id;
      option.textContent = `${optionStatus === "success" ? "✓" : optionStatus === "missed" ? "×" : "○"} ${optionBehavior.name || "Habit"}`;
      option.selected = optionBehavior.id === behavior.id;
      pickerSelect.append(option);
    });
    pickerSelect.addEventListener("change", () => {
      selectedBehaviorId = pickerSelect.value;
      renderQuickCheckIn();
    });

    const monthDates = datesInMonth(selectedMonth).filter((date) => date.getTime() <= effectiveToday.getTime());
    const weekDates = datesInWeek(selectedDate);
    const row = document.createElement("div");
    row.className = `habit-quick-row habit-visual-card ${status}`;
    const heading = document.createElement("div");
    heading.className = "habit-card-heading";
    heading.append(pickerSelect);

    const behaviorStatuses = monthDates.map((date) => statusFor(values.get(`${behavior.id}:${localDateKey(date)}`)));
    const behaviorDone = behaviorStatuses.filter((value) => value === "success").length;
    const behaviorRate = monthDates.length ? Math.round((behaviorDone / monthDates.length) * 100) : 0;
    const metric = document.createElement("div");
    metric.className = "habit-card-metric";
    const metricTotal = document.createElement("strong");
    metricTotal.textContent = String(behaviorDone);
    const metricDays = document.createElement("small");
    metricDays.textContent = ` / ${monthDates.length}`;
    metricTotal.append(metricDays);
    const metricRate = document.createElement("span");
    metricRate.textContent = `${behaviorRate}%`;
    metric.append(metricTotal, metricRate);

    const week = document.createElement("div");
    week.className = "habit-week-grid";
    for (const date of weekDates) {
      const dayStatus = statusFor(values.get(`${behavior.id}:${localDateKey(date)}`));
      const future = date.getTime() > effectiveToday.getTime();
      const day = document.createElement("button");
      day.type = "button";
      day.className = `habit-week-day ${dayStatus}${isSameDay(date, selectedDate) ? " is-selected" : ""}`;
      day.disabled = future || saving;
      day.setAttribute("aria-label", `${behavior.name || "Habit"}, ${date.toLocaleDateString()}, ${statusLabelFor(dayStatus)}`);
      day.title = future ? "Future date" : "Select this day";
      const letter = document.createElement("span");
      letter.textContent = date.toLocaleDateString([], { weekday: "narrow" });
      const mark = document.createElement("i");
      mark.textContent = dayStatus === "success" ? "✓" : dayStatus === "missed" ? "×" : "";
      day.append(letter, mark);
      day.addEventListener("click", () => selectDate(date));
      week.append(day);
    }

    const controls = document.createElement("div");
    controls.className = "habit-status-control";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `${behavior.name || "Habit"} result`);
    controls.append(
      statusButton("Done", "success", status, () => saveHabitStatus(behavior.id, dateKey, status === "success" ? "unreported" : "success", status !== "success")),
      statusButton("Missed", "missed", status, () => saveHabitStatus(behavior.id, dateKey, status === "missed" ? "unreported" : "missed", status !== "missed"))
    );
    row.append(heading, metric, week, controls);
    quickRoot.append(row);

    updateTodayStatus(behaviors, values, effectiveToday);
  }

  function statusButton(label: string, value: HabitStatus, current: HabitStatus, onClick: () => Promise<void>): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `habit-status-option ${value}${current === value ? " is-selected" : ""}`;
    const mark = document.createElement("span");
    mark.className = "habit-status-mark";
    mark.textContent = value === "success" ? "✓" : "×";
    const text = document.createElement("span");
    text.textContent = label;
    button.append(mark, text);
    button.disabled = saving;
    button.setAttribute("aria-pressed", String(current === value));
    button.title = current === value ? `Clear ${label.toLowerCase()} result` : `Mark ${label.toLowerCase()}`;
    button.addEventListener("click", () => void onClick());
    return button;
  }

  async function saveHabitStatus(behaviorId: string, dateKey: string, next: HabitStatus, advance = false): Promise<void> {
    if (saving) return;
    const nextBehaviorId = advance ? behaviorAfterCheckIn(behaviorId, dateKey) : null;
    saving = true;
    renderQuickCheckIn();
    try {
      await post("/api/intentional-use/behavior/check-in", {
        behaviorId,
        dateKey,
        ...(next === "unreported" ? { clear: true } : { value: next === "success" }),
        note: "Habit calendar"
      });
      editableCompletedDateKey = null;
      if (nextBehaviorId) selectedBehaviorId = nextBehaviorId;
      toast(next === "success" ? "Marked done" : next === "missed" ? "Marked missed" : "Check-in cleared");
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not save habit check-in");
    } finally {
      saving = false;
      renderCalendar();
      renderQuickCheckIn();
    }
  }

  async function saveSelectedDay(action: "remaining-done" | "clear"): Promise<void> {
    if (saving) return;
    const lifeLog = data?.intentionalUse?.lifeLog;
    const behaviors = (lifeLog?.behaviors || []).filter((behavior) => behavior.active !== false);
    const checkIns = lifeLog?.calendar?.checkIns?.length
      ? lifeLog.calendar.checkIns
      : lifeLog?.habitCheckIns?.length
        ? lifeLog.habitCheckIns
        : (lifeLog?.recentCheckIns || []);
    const values = checkInMap(checkIns);
    const dateKey = localDateKey(selectedDate);
    const targets = action === "clear"
      ? behaviors.filter((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)) !== "unreported")
      : behaviors.filter((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)) === "unreported");
    if (!targets.length) return;

    saving = true;
    renderQuickCheckIn();
    try {
      for (const behavior of targets) {
        await post("/api/intentional-use/behavior/check-in", {
          behaviorId: behavior.id,
          dateKey,
          ...(action === "clear" ? { clear: true } : { value: true }),
          note: "Habit calendar quick entry"
        });
      }
      toast(action === "clear" ? "Day cleared" : "Remaining habits marked done");
      await refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not update the day");
      await refresh();
    } finally {
      saving = false;
      renderCalendar();
      renderQuickCheckIn();
    }
  }

  function changeSelectedDay(amount: number): void {
    const next = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate() + amount);
    if (next.getTime() > trackingDay().getTime()) return;
    selectDate(next);
  }

  function selectDate(date: Date): void {
    selectedDate = dayStart(date);
    selectedMonth = monthStart(date);
    selectedBehaviorId = null;
    editableCompletedDateKey = null;
    renderCalendar();
    renderQuickCheckIn();
  }

  function scheduleTrackingDayRollover(): void {
    const previousToday = trackingDay();
    window.setTimeout(() => {
      const wasShowingToday = isSameDay(selectedDate, previousToday);
      const nextToday = trackingDay();
      dateInput.max = localDateKey(nextToday);
      if (wasShowingToday) selectDate(nextToday);
      else {
        renderCalendar();
        renderQuickCheckIn();
      }
      scheduleTrackingDayRollover();
    }, millisecondsUntilTrackingDayRollover());
  }

  function behaviorAfterCheckIn(behaviorId: string, dateKey: string): string | null {
    const lifeLog = data?.intentionalUse?.lifeLog;
    const behaviors = (lifeLog?.behaviors || []).filter((behavior) => behavior.active !== false);
    const currentIndex = behaviors.findIndex((behavior) => behavior.id === behaviorId);
    if (currentIndex < 0 || behaviors.length < 2) return behaviorId;
    const values = checkInMap(lifeLog?.calendar?.checkIns?.length
      ? lifeLog.calendar.checkIns
      : lifeLog?.habitCheckIns?.length
        ? lifeLog.habitCheckIns
        : (lifeLog?.recentCheckIns || []));
    for (let offset = 1; offset < behaviors.length; offset += 1) {
      const candidate = behaviors[(currentIndex + offset) % behaviors.length];
      if (statusFor(values.get(`${candidate.id}:${dateKey}`)) === "unreported") return candidate.id;
    }
    return behaviors[(currentIndex + 1) % behaviors.length].id;
  }

  return { bind, render };
}

function completedDayCard(
  today: boolean,
  edit: () => void
): HTMLElement {
  const card = document.createElement("section");
  card.className = "habit-checkin-complete";
  card.setAttribute("role", "status");

  const heading = document.createElement("strong");
  heading.textContent = today
    ? "You're done filling out your info for today."
    : "You're done filling out your info for this day.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "habit-text-action compact";
  button.textContent = today ? "Edit today's answers" : "Edit this day's answers";
  button.addEventListener("click", edit);

  card.append(heading, button);
  return card;
}

function dateIsComplete(
  dateKey: string,
  behaviors: DashboardItem[],
  values: Map<string, HabitCalendarCheckIn>
): boolean {
  return behaviors.length > 0
    && behaviors.every((behavior) => statusFor(values.get(`${behavior.id}:${dateKey}`)) !== "unreported");
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
  return status === "success" ? "successful" : status === "missed" ? "missed" : "not recorded";
}

function datesInMonth(value: Date): Date[] {
  const year = value.getFullYear();
  const month = value.getMonth();
  const count = new Date(year, month + 1, 0).getDate();
  return Array.from({ length: count }, (_, index) => new Date(year, month, index + 1));
}

function datesInWeek(value: Date): Date[] {
  const start = dayStart(value);
  const mondayOffset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - mondayOffset);
  return Array.from({ length: 7 }, (_, index) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + index));
}

function svgNode(tag: string, attributes: Record<string, string | number>): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function monthStart(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), 1);
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

function dateFromKey(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateKey(date) === value ? date : null;
}

function dateKeyFromTimestamp(value: unknown): string {
  const date = value ? new Date(String(value)) : null;
  return date && !Number.isNaN(date.getTime()) ? localDateKey(date) : "";
}

function textNode(tag: "p" | "span" | "strong", text: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  return node;
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing tracking element: ${selector}`);
  return element;
}
