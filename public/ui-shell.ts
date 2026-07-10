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

export function bindSidebar(): void {
  const toggle = document.querySelector<HTMLButtonElement>("#sidebarToggle");
  const navigation = document.querySelector<HTMLElement>("#primaryNavigation");
  if (!toggle || !navigation) return;

  const setOpen = (open: boolean): void => {
    document.body.dataset.sidebarOpen = String(open);
    toggle.setAttribute("aria-expanded", String(open));
  };

  toggle.addEventListener("click", () => {
    setOpen(document.body.dataset.sidebarOpen !== "true");
  });
  navigation.addEventListener("click", (event) => {
    if (!(event.target as Element | null)?.closest("[data-view-target]")) return;
    if (window.matchMedia("(max-width: 900px)").matches) setOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
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
  }
}
