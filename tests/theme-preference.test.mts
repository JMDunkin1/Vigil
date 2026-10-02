import assert from "node:assert/strict";
import { initTheme, setTheme, themePreference } from "../public/ui-shell.js";

let saved: string | null = null;
let dark = true;
let changed: (() => void) | undefined;
const dataset: Record<string, string> = {};
Object.assign(globalThis, {
  document: { documentElement: { dataset } },
  localStorage: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } },
  window: { matchMedia: () => ({ matches: dark, addEventListener: (_type: string, callback: () => void) => { changed = callback; } }) }
});
initTheme();
assert.equal(dataset.theme, "dark");
assert.equal(saved, null, "initialization must not freeze the system appearance into a saved explicit choice");
dark = false;
changed?.();
assert.equal(dataset.theme, "light");
setTheme("dark");
assert.equal(themePreference(), "dark");
changed?.();
assert.equal(dataset.theme, "dark", "system changes must not override an explicit preference");
setTheme("system");
assert.equal(saved, "system");
assert.equal(dataset.theme, "light");
saved = "light";
dark = true;
initTheme();
assert.equal(dataset.theme, "light", "existing saved preferences must be preserved");
