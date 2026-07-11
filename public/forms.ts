import type { ControlElement, DashboardItem, GrayscaleSchedule, Schedule } from "./app-model.js";

type QueryElement = (selector: string) => ControlElement;
type QueryElements = <T extends Element = ControlElement>(selector: string) => NodeListOf<T>;

interface FormControllerContext {
  $: QueryElement;
  $$: QueryElements;
  setView(view?: string): void;
}

export function createFormController({ $, $$, setView }: FormControllerContext) {
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
    setView("tracking");
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
    form.elements.body.value = entry.body || "";
    setView("journal");
    form.elements.title.focus();
  }

  function resetJournalForm(): void {
    const form = $("#journalEntryForm");
    form.reset();
    form.elements.id.value = "";
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
    loadLimit,
    resetLimitForm,
    resetScheduleForm,
    resetGrayscaleScheduleForm,
    fillSelect,
    renderMultiSelect,
    selectedValues,
    setSelectedOptions
  };
}

export type FormController = ReturnType<typeof createFormController>;
