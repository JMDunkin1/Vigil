import { dayCheckbox } from "./dom.js";
import { days } from "./format.js";
import { $ } from "./ui-shell.js";

type CheckedResolver = (value: string) => boolean;

export function renderScheduleDays(): void {
  renderDayCheckboxGroup("#scheduleDays", (value) => !["0", "6"].includes(value));
}

export function renderGrayscaleScheduleDays(): void {
  renderDayCheckboxGroup("#grayscaleScheduleDays", () => true);
}

export function renderLimitDays(): void {
  renderDayCheckboxGroup("#limitDays");
}

export function renderAppLockDays(): void {
  renderDayCheckboxGroup("#appLockDays");
}

export function renderIntentionalDays(): void {
  renderDayCheckboxGroup("#intentionalDays");
}

export function syncDayControl(rootSelector: string): void {
  const root = $(rootSelector);
  const select = root.querySelector<HTMLSelectElement>("select[data-day-preset]");
  const custom = root.querySelector<HTMLElement>(".day-custom-grid");
  if (!select || !custom) return;
  const selected = [...root.querySelectorAll<HTMLInputElement>("input[type='checkbox']:checked")]
    .map((input) => input.value)
    .sort()
    .join(",");
  select.value = selected === "0,1,2,3,4,5,6"
    ? "every-day"
    : selected === "1,2,3,4,5"
      ? "weekdays"
      : selected === "0,6"
        ? "weekends"
        : "custom";
  custom.hidden = select.value !== "custom";
}

function renderDayCheckboxGroup(rootSelector: string, checked?: CheckedResolver): void {
  const root = $(rootSelector);
  root.replaceChildren();
  root.classList.add("day-control");

  const preset = document.createElement("label");
  preset.className = "day-preset";
  const label = document.createElement("span");
  label.textContent = "Days";
  const select = document.createElement("select");
  select.dataset.dayPreset = "true";
  select.setAttribute("aria-label", "Days this rule applies");
  for (const [value, text] of [
    ["every-day", "Every day"],
    ["weekdays", "Weekdays"],
    ["weekends", "Weekends"],
    ["custom", "Custom days"]
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  preset.append(label, select);

  const custom = document.createElement("div");
  custom.className = "day-custom-grid";
  for (const [value, label] of days) {
    custom.append(checked ? dayCheckbox(value, label, { checked: checked(value) }) : dayCheckbox(value, label));
  }
  root.append(preset, custom);

  select.addEventListener("change", () => {
    const selected = select.value === "every-day"
      ? new Set(["0", "1", "2", "3", "4", "5", "6"])
      : select.value === "weekdays"
        ? new Set(["1", "2", "3", "4", "5"])
        : select.value === "weekends"
          ? new Set(["0", "6"])
          : null;
    if (selected) {
      for (const input of custom.querySelectorAll<HTMLInputElement>("input")) input.checked = selected.has(input.value);
    }
    syncDayControl(rootSelector);
  });
  custom.addEventListener("change", () => syncDayControl(rootSelector));
  syncDayControl(rootSelector);
}
