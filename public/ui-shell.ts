import type { ControlElement } from "./app-model.js";

export const $ = (selector: string): ControlElement => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element as ControlElement;
};

export const $$ = <T extends Element = ControlElement>(selector: string): NodeListOf<T> => document.querySelectorAll<T>(selector);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Request failed");
}

export function initTheme(): void {
  applyTheme(themePreference());
  window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener("change", () => {
    if (themePreference() === "system") applyTheme("system");
  });
}

export function setTheme(theme: string): void {
  const next = theme === "dark" || theme === "light" ? theme : "system";
  applyTheme(next);
  try {
    localStorage.setItem("vigil-theme", next);
  } catch {
  }
}

export function themePreference(): string {
  try {
    const saved = localStorage.getItem("vigil-theme");
    return saved === "dark" || saved === "light" ? saved : "system";
  } catch {
    return "system";
  }
}

function applyTheme(theme: string): void {
  const dark = theme === "dark" || (theme === "system" && window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}
