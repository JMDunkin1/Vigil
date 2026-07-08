import type { ControlElement, DashboardData, DashboardItem, GrayscaleSchedule, IntentionalPlanBlock, IntentionalPlanItem, Schedule } from "./app-model.js";

type QueryElement = (selector: string) => ControlElement;
type QueryElements = <T extends Element = ControlElement>(selector: string) => NodeListOf<T>;

interface FormControllerContext {
  $: QueryElement;
  $$: QueryElements;
  getData(): DashboardData | null;
  setView(view?: string): void;
  defaultPlanBlockProfileId: string;
}

export function createFormController({ $, $$, getData, setView, defaultPlanBlockProfileId }: FormControllerContext) {
  function loadSchedule(schedule: Schedule): void {
    const form = $("#scheduleForm");
    form.elements.id.value = schedule.id;
    form.elements.name.value = schedule.name;
    form.elements.mode.value = schedule.mode;
    form.elements.start.value = schedule.start;
    form.elements.end.value = schedule.end;
    form.elements.wifiNetworks.value = (schedule.wifiNetworks || []).join("\n");
    form.elements.enabled.checked = Boolean(schedule.enabled);
    form.elements.commitmentLock.checked = Boolean(schedule.commitmentLock);
    for (const input of $$("#scheduleDays input")) {
      input.checked = schedule.days.includes(Number(input.value));
    }
  }

  function loadGrayscaleSchedule(schedule: GrayscaleSchedule): void {
    const form = $("#grayscaleScheduleForm");
    form.elements.id.value = schedule.id;
    form.elements.name.value = schedule.name;
    form.elements.start.value = schedule.start;
    form.elements.end.value = schedule.end;
    form.elements.enabled.checked = Boolean(schedule.enabled);
    for (const input of $$("#grayscaleScheduleDays input")) {
      input.checked = schedule.days.includes(Number(input.value));
    }
    const targets = new Set(schedule.deviceTargets || ["computer", "phone"]);
    for (const input of $$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']")) {
      input.checked = targets.has(input.value as "computer" | "phone");
    }
  }

  function loadAppLock(rule: DashboardItem): void {
    const form = $("#appLockForm");
    form.elements.id.value = rule.id;
    form.elements.name.value = rule.name;
    form.elements.unlocksAllowed.value = String(rule.unlocksAllowed || 0);
    form.elements.unlockMinutes.value = String(rule.unlockMinutes || 0);
    form.elements.delaySeconds.value = String(rule.delaySeconds || 0);
    form.elements.lockLevel.value = rule.lockLevel || "deep";
    form.elements.apps.value = (rule.apps || []).join("\n");
    form.elements.sites.value = (rule.sites || []).join("\n");
    form.elements.enabled.checked = Boolean(rule.enabled);
    for (const input of $$("#appLockDays input")) {
      input.checked = (rule.days || []).includes(Number(input.value));
    }
  }

  function resetAppLockForm(): void {
    const form = $("#appLockForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Locked socials";
    form.elements.unlocksAllowed.value = "2";
    form.elements.unlockMinutes.value = "10";
    form.elements.delaySeconds.value = "30";
    form.elements.lockLevel.value = "deep";
    form.elements.enabled.checked = false;
    for (const input of $$("#appLockDays input")) {
      input.checked = true;
    }
  }

  function loadIntentionalRule(rule: DashboardItem): void {
    const form = $("#intentionalRuleForm");
    form.elements.id.value = rule.id;
    form.elements.name.value = rule.name;
    form.elements.frictionLevel.value = rule.frictionLevel || "standard";
    form.elements.delaySeconds.value = String(rule.delaySeconds || 12);
    form.elements.sessionMinutes.value = String(rule.sessionMinutes || 10);
    form.elements.dailyBudgetMinutes.value = String(rule.dailyBudgetMinutes || 30);
    form.elements.start.value = rule.start || "00:00";
    form.elements.end.value = rule.end || "23:59";
    form.elements.apps.value = (rule.apps || []).join("\n");
    form.elements.sites.value = (rule.sites || []).join("\n");
    form.elements.urlPatterns.value = (rule.urlPatterns || []).join("\n");
    form.elements.enabled.checked = Boolean(rule.enabled);
    for (const input of $$("#intentionalDays input")) {
      input.checked = (rule.days || []).includes(Number(input.value));
    }
  }

  function resetIntentionalRuleForm(): void {
    const form = $("#intentionalRuleForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Short-form pause";
    form.elements.frictionLevel.value = "standard";
    form.elements.delaySeconds.value = "12";
    form.elements.sessionMinutes.value = "10";
    form.elements.dailyBudgetMinutes.value = "30";
    form.elements.start.value = "00:00";
    form.elements.end.value = "23:59";
    form.elements.enabled.checked = true;
    form.elements.urlPatterns.value = "youtube.com/shorts\nm.youtube.com/shorts";
    for (const input of $$("#intentionalDays input")) {
      input.checked = true;
    }
  }

  function loadBehavior(behavior: DashboardItem): void {
    const form = $("#behaviorForm");
    form.elements.id.value = behavior.id;
    form.elements.name.value = behavior.name;
    form.elements.description.value = behavior.description || "";
    form.elements.direction.value = behavior.direction || "build";
    form.elements.unit.value = behavior.unit || "count";
    form.elements.weeklyTarget.value = String(behavior.weeklyTarget || 0);
    form.elements.replacement.value = behavior.replacement || "";
    form.elements.active.checked = behavior.active !== false;
    setSelectedOptions($("#behaviorRuleIds"), behavior.ruleIds || []);
    setView("journal");
  }

  function resetBehaviorForm(): void {
    const form = $("#behaviorForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Evening phone shutdown";
    form.elements.description.value = "";
    form.elements.direction.value = "build";
    form.elements.unit.value = "count";
    form.elements.weeklyTarget.value = "5";
    form.elements.replacement.value = "";
    form.elements.active.checked = true;
    setSelectedOptions($("#behaviorRuleIds"), []);
  }

  function loadJournalEntry(entry: DashboardItem): void {
    const form = $("#journalEntryForm");
    form.elements.id.value = entry.id;
    form.elements.title.value = entry.title || "";
    form.elements.mood.value = entry.mood || "";
    form.elements.body.value = entry.body || "";
    form.elements.energy.value = entry.energy ? String(entry.energy) : "";
    form.elements.tags.value = (entry.tags || []).join(", ");
    form.elements.entryDate.value = toDateTimeLocal(entry.entryDate || entry.createdAt);
    setSelectedOptions($("#journalBehaviorIds"), entry.behaviorIds || []);
    setSelectedOptions($("#journalRuleIds"), entry.ruleIds || []);
    setView("journal");
  }

  function resetJournalForm(): void {
    const form = $("#journalEntryForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.entryDate.value = toDateTimeLocal(new Date().toISOString());
    setSelectedOptions($("#journalBehaviorIds"), []);
    setSelectedOptions($("#journalRuleIds"), []);
  }

  function loadPlanItem(item: IntentionalPlanItem): void {
    const form = $("#planItemForm");
    form.elements.id.value = item.id;
    form.elements.listId.value = item.listId;
    form.elements.status.value = item.status;
    form.elements.title.value = item.title;
    form.elements.notes.value = item.notes || "";
    form.elements.dueAt.value = item.dueAt ? toDateTimeLocal(item.dueAt) : "";
    form.elements.tags.value = (item.tags || []).join(", ");
    setView("journal");
  }

  function resetPlanItemForm(): void {
    const form = $("#planItemForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.title.value = "Homework";
    form.elements.status.value = "open";
    form.elements.notes.value = "";
    form.elements.dueAt.value = "";
    form.elements.tags.value = "";
    const firstList = (getData()?.intentionalUse?.lifeLog?.planner?.lists || []).find((list) => list.active !== false);
    form.elements.listId.value = firstList?.id || "todo";
  }

  function resetPlanListForm(): void {
    const form = $("#planListForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "To Do";
    form.elements.kind.value = "todo";
    form.elements.active.checked = true;
  }

  function loadPlanBlockFromItem(item: IntentionalPlanItem): void {
    resetPlanBlockForm();
    const form = $("#planBlockForm");
    form.elements.title.value = item.title;
    form.elements.itemId.value = item.id;
    form.elements.notes.value = item.notes || "";
    form.elements.mode.value = item.listId === "watchlist" ? "watch" : "focus";
    setView("journal");
  }

  function loadPlanBlock(block: IntentionalPlanBlock): void {
    const form = $("#planBlockForm");
    form.elements.id.value = block.id;
    form.elements.title.value = block.title;
    form.elements.itemId.value = block.itemId || "";
    form.elements.startsAt.value = toDateTimeLocal(block.startsAt);
    form.elements.endsAt.value = toDateTimeLocal(block.endsAt);
    form.elements.mode.value = block.mode || "focus";
    form.elements.profileId.value = block.profileId || getData()?.state.settings.activeProfileId || "";
    form.elements.lockLevel.value = block.lockLevel || "deep";
    form.elements.enabled.checked = block.enabled !== false;
    form.elements.commitmentLock.checked = Boolean(block.commitmentLock);
    form.elements.notes.value = block.notes || "";
    const targets = new Set(block.deviceTargets || ["computer", "phone"]);
    for (const input of $$<HTMLInputElement>("#planBlockForm input[name='deviceTargets']")) {
      input.checked = targets.has(input.value as "computer" | "phone");
    }
    setView("journal");
  }

  function resetPlanBlockForm(): void {
    const form = $("#planBlockForm");
    const start = nextQuarterHour();
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    form.reset();
    form.elements.id.value = "";
    form.elements.title.value = "Homework";
    form.elements.itemId.value = "";
    form.elements.startsAt.value = toDateTimeLocal(start.toISOString());
    form.elements.endsAt.value = toDateTimeLocal(end.toISOString());
    form.elements.mode.value = "focus";
    form.elements.profileId.value = defaultPlanBlockProfileId;
    form.elements.lockLevel.value = "deep";
    form.elements.enabled.checked = true;
    form.elements.commitmentLock.checked = false;
    form.elements.notes.value = "";
    for (const input of $$<HTMLInputElement>("#planBlockForm input[name='deviceTargets']")) {
      input.checked = true;
    }
  }

  function loadLimit(rule: DashboardItem): void {
    const form = $("#limitForm");
    form.elements.id.value = rule.id;
    form.elements.name.value = rule.name;
    form.elements.type.value = rule.type || "time";
    form.elements.lockLevel.value = rule.lockLevel || "deep";
    form.elements.limitMinutes.value = String(rule.limitMinutes || 0);
    form.elements.unlocksAllowed.value = String(rule.unlocksAllowed || 0);
    form.elements.blockMinutes.value = String(rule.blockMinutes || 0);
    form.elements.apps.value = (rule.apps || []).join("\n");
    form.elements.sites.value = (rule.sites || []).join("\n");
    form.elements.enabled.checked = Boolean(rule.enabled);
    for (const input of $$("#limitDays input")) {
      input.checked = (rule.days || []).includes(Number(input.value));
    }
  }

  function resetLimitForm(): void {
    const form = $("#limitForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Instagram 20/20";
    form.elements.type.value = "time";
    form.elements.lockLevel.value = "deep";
    form.elements.limitMinutes.value = "20";
    form.elements.unlocksAllowed.value = "0";
    form.elements.blockMinutes.value = "20";
    form.elements.apps.value = "Instagram\ncom.burbn.instagram";
    form.elements.sites.value = "instagram.com";
    form.elements.enabled.checked = true;
    for (const input of $$("#limitDays input")) {
      input.checked = true;
    }
  }

  function resetScheduleForm(): void {
    const form = $("#scheduleForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Focus block";
    form.elements.mode.value = "focus";
    form.elements.start.value = "09:00";
    form.elements.end.value = "17:00";
    form.elements.wifiNetworks.value = "";
    form.elements.enabled.checked = false;
    form.elements.commitmentLock.checked = false;
    for (const input of $$("#scheduleDays input")) {
      input.checked = !["0", "6"].includes(input.value);
    }
  }

  function resetGrayscaleScheduleForm(): void {
    const form = $("#grayscaleScheduleForm");
    form.reset();
    form.elements.id.value = "";
    form.elements.name.value = "Night grayscale";
    form.elements.start.value = "22:00";
    form.elements.end.value = "07:00";
    form.elements.enabled.checked = false;
    for (const input of $$("#grayscaleScheduleDays input")) {
      input.checked = true;
    }
    for (const input of $$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']")) {
      input.checked = true;
    }
  }

  function fillSelect(select: ControlElement, items: Array<{ id: string; name: string }>, selectedId: string | null): void {
    const current = select.value || selectedId || "";
    select.replaceChildren();
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name;
      select.append(option);
    }
    select.value = items.some((item) => item.id === current) ? current : (selectedId || "");
  }

  function renderMultiSelect(select: ControlElement, items: Array<{ id: string; name?: string; label?: string }>): void {
    const current = selectedValues(select);
    select.replaceChildren();
    for (const item of items) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.name || item.label || item.id;
      option.selected = current.includes(item.id);
      select.append(option);
    }
  }

  function renderBehaviorCheckInSelect(behaviors: Array<{ id: string; name?: string }>): void {
    const select = $("#behaviorCheckInId");
    const current = select.value;
    select.replaceChildren();
    if (!behaviors.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No behaviors saved";
      select.append(option);
      return;
    }
    for (const behavior of behaviors) {
      const option = document.createElement("option");
      option.value = behavior.id;
      option.textContent = behavior.name || behavior.id;
      select.append(option);
    }
    select.value = behaviors.some((behavior) => behavior.id === current) ? current : behaviors[0].id;
  }

  function selectedValues(target: string | ControlElement): string[] {
    const select = typeof target === "string" ? $(target) : target;
    return Array.from((select as unknown as HTMLSelectElement).selectedOptions || [])
      .map((option) => option.value)
      .filter(Boolean);
  }

  function setSelectedOptions(select: ControlElement, values: string[]): void {
    const selected = new Set(values || []);
    for (const option of Array.from((select as unknown as HTMLSelectElement).options || [])) {
      option.selected = selected.has(option.value);
    }
  }

  function tagList(value: unknown): string[] {
    return String(value || "")
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function toDateTimeLocal(value: unknown): string {
    const date = value ? new Date(String(value)) : new Date();
    if (Number.isNaN(date.getTime())) return "";
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
    return local.toISOString().slice(0, 16);
  }

  function nextQuarterHour(): Date {
    const date = new Date();
    date.setSeconds(0, 0);
    const minutes = date.getMinutes();
    date.setMinutes(minutes + (15 - (minutes % 15 || 15)));
    return date;
  }

  function selectedPlanItemListId(itemId: string): string {
    if (!itemId) return "";
    return getData()?.intentionalUse?.lifeLog?.planner?.items?.find((item) => item.id === itemId)?.listId || "";
  }

  return {
    loadSchedule,
    loadGrayscaleSchedule,
    loadAppLock,
    resetAppLockForm,
    loadIntentionalRule,
    resetIntentionalRuleForm,
    loadBehavior,
    resetBehaviorForm,
    loadJournalEntry,
    resetJournalForm,
    loadPlanItem,
    resetPlanItemForm,
    resetPlanListForm,
    loadPlanBlockFromItem,
    loadPlanBlock,
    resetPlanBlockForm,
    loadLimit,
    resetLimitForm,
    resetScheduleForm,
    resetGrayscaleScheduleForm,
    fillSelect,
    renderMultiSelect,
    renderBehaviorCheckInSelect,
    selectedValues,
    setSelectedOptions,
    tagList,
    toDateTimeLocal,
    selectedPlanItemListId
  };
}

export type FormController = ReturnType<typeof createFormController>;
