import type { DashboardData, DashboardItem, HabitCalendarCheckIn } from "./app-model.js";

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
  let selectedMonth = monthStart(new Date());
  let selectedDate = dayStart(new Date());
  let data: DashboardData | null = null;
  let saving = false;

  function bind(): void {
    required<HTMLButtonElement>("#habitPreviousMonth").addEventListener("click", () => changeMonth(-1));
    required<HTMLButtonElement>("#habitNextMonth").addEventListener("click", () => changeMonth(1));
    required<HTMLButtonElement>("#habitCurrentMonth").addEventListener("click", () => {
      selectedMonth = monthStart(new Date());
      renderCalendar();
    });
    required<HTMLButtonElement>("#habitSelectedPrevious").addEventListener("click", () => changeSelectedDay(-1));
    required<HTMLButtonElement>("#habitSelectedNext").addEventListener("click", () => changeSelectedDay(1));
    required<HTMLButtonElement>("#habitSelectedToday").addEventListener("click", () => selectDate(dayStart(new Date())));
    dateInput.max = localDateKey(new Date());
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
  }

  function render(next: DashboardData): void {
    data = next;
    renderCalendar();
    renderQuickCheckIn();
  }

  function changeMonth(amount: number): void {
    selectedMonth = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + amount, 1);
    renderCalendar();
  }

  function renderCalendar(): void {
    monthLabel.textContent = selectedMonth.toLocaleDateString([], { month: "long", year: "numeric" });
    root.replaceChildren();
    const pulseRoot = required<HTMLElement>("#habitMonthPulse");
    const monthRate = required<HTMLElement>("#habitMonthRate");
    const monthSummary = required<HTMLElement>("#habitMonthSummary");
    pulseRoot.replaceChildren();
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
      statusLabel.textContent = "Create a habit to begin tracking.";
      return;
    }

    const dates = datesInMonth(selectedMonth);
    const values = checkInMap(checkIns);
    renderMonthPulse(pulseRoot, dates, behaviors, values);
    const today = dayStart(new Date()).getTime();
    const visibleDates = dates.filter((date) => date.getTime() <= today);
    const monthStatuses = visibleDates.flatMap((date) => behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${localDateKey(date)}`))));
    const reported = monthStatuses.filter((status) => status !== "unreported");
    const completed = reported.filter((status) => status === "success").length;
    monthRate.textContent = reported.length ? `${Math.round((completed / reported.length) * 100)}%` : "—";
    monthSummary.textContent = reported.length
      ? `${completed} of ${reported.length} check-ins completed`
      : "Your rhythm will appear here";
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
      heading.className = isSameDay(date, new Date()) ? "is-today" : "";
      heading.textContent = String(date.getDate());
      heading.title = date.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
      headRow.append(heading);
    }
    head.append(headRow);
    table.append(head);

    const body = document.createElement("tbody");
    for (const behavior of behaviors) body.append(habitRow(behavior, dates, values));
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
    const today = dayStart(new Date()).getTime();
    for (const date of dates) {
      const key = localDateKey(date);
      const statuses = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${key}`)));
      const reported = statuses.filter((status) => status !== "unreported").length;
      const done = statuses.filter((status) => status === "success").length;
      const future = date.getTime() > today;
      const button = document.createElement("button");
      button.type = "button";
      button.className = `habit-pulse-day${isSameDay(date, new Date()) ? " is-today" : ""}${future ? " is-future" : ""}${reported ? " has-data" : ""}`;
      button.disabled = future;
      button.style.setProperty("--reported", String(reported / behaviors.length));
      button.style.setProperty("--completed", String(reported ? done / reported : 0));
      button.setAttribute("aria-label", `${date.toLocaleDateString([], { month: "long", day: "numeric" })}: ${done} done, ${reported - done} missed, ${behaviors.length - reported} not recorded`);
      button.title = future ? "Future date" : `${done} done · ${reported - done} missed`;
      const bar = document.createElement("i");
      bar.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = String(date.getDate());
      button.append(bar, label);
      button.addEventListener("click", () => selectDate(date));
      pulseRoot.append(button);
    }
  }

  function habitRow(behavior: DashboardItem, dates: Date[], values: Map<string, HabitCalendarCheckIn>): HTMLTableRowElement {
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
      const today = isSameDay(date, new Date());
      const future = date.getTime() > dayStart(new Date()).getTime();
      button.type = "button";
      button.className = `habit-day ${habitStatus}${today ? " is-today" : ""}${future ? " is-future" : ""}`;
      button.dataset.behaviorId = behavior.id;
      button.dataset.dateKey = dateKey;
      button.dataset.status = habitStatus;
      button.textContent = habitStatus === "success" ? "✓" : habitStatus === "missed" ? "×" : "";
      button.disabled = future || saving;
      button.setAttribute("aria-label", `${behavior.name || "Habit"}, ${date.toLocaleDateString()}, ${statusLabelFor(habitStatus)}${future ? ". Future dates cannot be recorded." : ". Select to change this result."}`);
      button.title = future ? "Future date" : "Change this result";
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
    const today = isSameDay(selectedDate, new Date());
    const title = required<HTMLElement>("#dailyCheckInTitle");
    const progress = required<HTMLElement>("#dailyCheckInProgress");
    const next = required<HTMLButtonElement>("#habitSelectedNext");
    const finish = required<HTMLButtonElement>("#habitMarkRemainingDone");
    const clear = required<HTMLButtonElement>("#habitClearSelectedDay");
    const meter = required<HTMLElement>("#dailyCheckInMeterBar");

    title.textContent = today
      ? "Today"
      : selectedDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    dateInput.value = dateKey;
    next.disabled = today || saving;
    quickRoot.replaceChildren();

    if (!behaviors.length) {
      progress.textContent = "No active habits";
      meter.style.width = "0%";
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
    meter.style.width = `${Math.round((recorded / behaviors.length) * 100)}%`;
    meter.parentElement?.classList.toggle("is-complete", recorded === behaviors.length);
    progress.textContent = recorded === behaviors.length
      ? `${done} done · ${behaviors.length - done} missed · complete`
      : `${recorded} of ${behaviors.length} recorded`;
    finish.disabled = saving || recorded === behaviors.length;
    clear.disabled = saving || recorded === 0;

    behaviors.forEach((behavior, index) => {
      const status = statuses[index];
      const row = document.createElement("div");
      row.className = `habit-quick-row ${status}`;
      const name = document.createElement("span");
      name.className = "habit-quick-name";
      name.textContent = behavior.name || "Habit";
      const controls = document.createElement("div");
      controls.className = "habit-status-control";
      controls.setAttribute("role", "group");
      controls.setAttribute("aria-label", `${behavior.name || "Habit"} result`);
      controls.append(
        statusButton("Done", "success", status, () => saveHabitStatus(behavior.id, dateKey, status === "success" ? "unreported" : "success")),
        statusButton("Missed", "missed", status, () => saveHabitStatus(behavior.id, dateKey, status === "missed" ? "unreported" : "missed"))
      );
      row.append(name, controls);
      quickRoot.append(row);
    });

    const todayValues = behaviors.map((behavior) => statusFor(values.get(`${behavior.id}:${localDateKey(new Date())}`)));
    const todayRecorded = todayValues.filter((status) => status !== "unreported").length;
    const todayDone = todayValues.filter((status) => status === "success").length;
    const lifeLogStatus = required<HTMLElement>("#lifeLogStatus");
    lifeLogStatus.textContent = `${todayRecorded}/${behaviors.length} today`;
    lifeLogStatus.className = todayRecorded === behaviors.length ? "pill good" : todayDone ? "pill neutral" : "pill neutral";
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

  async function saveHabitStatus(behaviorId: string, dateKey: string, next: HabitStatus): Promise<void> {
    if (saving) return;
    saving = true;
    renderQuickCheckIn();
    try {
      await post("/api/intentional-use/behavior/check-in", {
        behaviorId,
        dateKey,
        ...(next === "unreported" ? { clear: true } : { value: next === "success" }),
        note: "Habit calendar"
      });
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
    if (next.getTime() > dayStart(new Date()).getTime()) return;
    selectDate(next);
  }

  function selectDate(date: Date): void {
    selectedDate = dayStart(date);
    selectedMonth = monthStart(date);
    renderCalendar();
    renderQuickCheckIn();
  }

  return { bind, render };
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
