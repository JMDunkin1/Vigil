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

function renderDayCheckboxGroup(rootSelector: string, checked?: CheckedResolver): void {
  const root = $(rootSelector);
  root.replaceChildren();
  for (const [value, label] of days) {
    root.append(checked ? dayCheckbox(value, label, { checked: checked(value) }) : dayCheckbox(value, label));
  }
}
