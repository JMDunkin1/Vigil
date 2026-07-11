import type { ControlElement, NamedFormControls, Preset } from "./app-model.js";
import { markFormDirty } from "./form-state.js";
import { lines } from "./format.js";
import { $$ } from "./ui-shell.js";

type ToastHandler = (message: string) => void;

const PRESET_SHORT_FORM_PATTERNS: Record<string, string[]> = {
  "youtube.com": ["youtube.com/shorts", "m.youtube.com/shorts"]
};

export function renderPresetButtons(presets: Preset[], toast: ToastHandler): void {
  for (const strip of $$(".preset-strip")) {
    strip.replaceChildren();
    if (!presets.length) continue;
    const label = document.createElement("span");
    label.textContent = "Add preset";
    strip.append(label);
    for (const preset of presets) {
      const button = document.createElement("button");
      button.className = "secondary compact";
      button.type = "button";
      button.textContent = preset.label;
      button.addEventListener("click", () => applyPreset(strip, preset, toast));
      strip.append(button);
    }
  }
}

function applyPreset(strip: ControlElement, preset: Preset, toast: ToastHandler): void {
  const formName = strip.dataset.form || "";
  const form = document.forms.namedItem(formName);
  if (!form) return;
  const elements = form.elements as NamedFormControls;
  const siteValues = [...(preset.sites || [])];
  const urlPatternValues = [...(preset.urlPatterns || [])];
  const urlPatternField = strip.dataset.urlPatternField || "";
  if (urlPatternField) {
    for (const site of [...siteValues]) {
      const patterns = PRESET_SHORT_FORM_PATTERNS[site];
      if (!patterns) continue;
      siteValues.splice(siteValues.indexOf(site), 1);
      urlPatternValues.push(...patterns);
    }
  }
  appendLines(elements[strip.dataset.appField || ""], preset.apps);
  appendLines(elements[strip.dataset.siteField || ""], siteValues);
  appendLines(elements[urlPatternField], urlPatternValues);
  markFormDirty(form);
  toast(`${preset.label} preset added`);
}

function appendLines(field: ControlElement | undefined, values: string[] = []): void {
  if (!field) return;
  const next = [...new Set([...lines(field.value), ...values].map((item) => String(item).trim()).filter(Boolean))];
  field.value = next.join("\n");
}
