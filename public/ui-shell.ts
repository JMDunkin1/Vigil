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
  let saved;
  try {
    saved = localStorage.getItem("vigil-theme") || "";
  } catch {
    saved = "";
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  setTheme(saved || (prefersDark ? "dark" : "light"));
}

export function setTheme(theme: string): void {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("vigil-theme", next);
  } catch {
  }
}
