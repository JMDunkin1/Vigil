import type { ControlElement, FormPayload } from "./app-model.js";

export const $ = (selector: string): ControlElement => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing UI element: ${selector}`);
  return element as ControlElement;
};

export const $$ = <T extends Element = ControlElement>(selector: string): NodeListOf<T> => document.querySelectorAll<T>(selector);

export function formPayload(form: FormData): FormPayload {
  return Object.fromEntries(form.entries()) as FormPayload;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || "Request failed");
}

export function eventTarget(event: Event): ControlElement {
  return event.target as ControlElement;
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

export function bindViewNavigation(onNavigate: (view?: string) => void): void {
  for (const button of $$("[data-view-target]")) {
    button.addEventListener("click", () => onNavigate(button.dataset.viewTarget));
  }
}

export function bindSidebarToggle(): void {
  const button = $("#sidebarToggle");
  const setCollapsed = (collapsed: boolean) => {
    document.body.classList.toggle("sidebar-collapsed", collapsed);
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? "Show sidebar" : "Hide sidebar");
    button.setAttribute("title", collapsed ? "Show sidebar" : "Hide sidebar");
  };
  let collapsed = false;
  try {
    collapsed = localStorage.getItem("vigil-sidebar-collapsed") === "true";
  } catch {
  }
  setCollapsed(collapsed);
  button.addEventListener("click", () => {
    const next = !document.body.classList.contains("sidebar-collapsed");
    setCollapsed(next);
    try {
      localStorage.setItem("vigil-sidebar-collapsed", String(next));
    } catch {
    }
  });
}

export function renderActiveView(activeView: string): void {
  document.body.dataset.activeView = activeView;
  for (const panel of $$("[data-view]")) {
    const active = (panel.dataset.view || "").split(/\s+/).includes(activeView);
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  for (const button of $$("[data-view-target]")) {
    const active = button.dataset.viewTarget === activeView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    if (button.classList.contains("settings-gear")) {
      button.setAttribute("aria-label", active ? "Close settings" : "Open settings");
      button.setAttribute("title", active ? "Close settings" : "Settings");
    }
  }
  window.scrollTo(0, 0);
}
