type EditorMap = Record<string, string>;

const FORM_LABELS: EditorMap = {
  profileForm: "Block list details",
  scheduleForm: "Schedule details",
  limitForm: "Limit details",
  appLockForm: "App lock details",
  intentionalGoalForm: "Goal and replacements",
  accountabilityForm: "Accountability digest",
  intentionalRuleForm: "Pause rule details",
  journalSecurityForm: "Automatic locking",
  grayscaleSettingsForm: "Screen color behavior",
  grayscaleScheduleForm: "Grayscale schedule",
  iosForm: "iPhone policy",
  iosMdmForm: "Advanced delivery",
  keyholderForm: "Keyholder passcode",
  distanceKeyForm: "Distance key"
};

const NEW_EDITOR: EditorMap = {
  newSchedule: "scheduleForm",
  newLimit: "limitForm",
  newAppLock: "appLockForm",
  newIntentionalRule: "intentionalRuleForm",
  newGrayscaleSchedule: "grayscaleScheduleForm"
};

const LIST_EDITOR: EditorMap = {
  scheduleList: "scheduleForm",
  limitList: "limitForm",
  appLockList: "appLockForm",
  intentionalRuleList: "intentionalRuleForm",
  grayscaleScheduleList: "grayscaleScheduleForm"
};

const SECTION_COPY: Record<string, string> = {
  "Block Rules": "Choose what Vigil blocks",
  "Recurring Locks": "Scheduled focus and lock windows",
  "Time & Open Rules": "Daily time and opening limits",
  "Semi-Permanent Locks": "Apps that need an intentional unlock",
  "Goals & Replacements": "What you are moving toward",
  "Pause Rules": "A pause before distracting use",
  "Setup Checklist": "What is ready and what needs attention",
  "Local Protections": "Device and bypass protection",
  "Screen Color": "Grayscale behavior and schedules",
  "Journal security": "Touch ID and automatic locking",
  "Supervised profile": "Computer and iPhone policy"
};

export function enhanceSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;

  wrapSettingsPanels();
  wrapSettingsForms();
  bindCategoryAccordion();
  bindEditorActions();
  bindSettingsSearch();
}

export function resetSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;

  for (const disclosure of settingsRoot.querySelectorAll<HTMLDetailsElement>("details")) {
    disclosure.open = false;
    disclosure.hidden = false;
  }

  const search = settingsRoot.querySelector<HTMLInputElement>("#settingsSearch");
  if (search) search.value = "";
}

function wrapSettingsPanels(): void {
  const panels = [...document.querySelectorAll<HTMLElement>("[data-view~='settings'] .settings-disclosure-body .panel")];
  for (const panel of panels) {
    if (panel.closest(".settings-subsection")) continue;
    const header = panel.querySelector<HTMLElement>(":scope > .section-head");
    if (!header) continue;
    const title = header.querySelector<HTMLElement>("h2, strong")?.textContent?.trim() || "Settings";
    const eyebrow = header.querySelector<HTMLElement>(".eyebrow")?.textContent?.trim() || "";
    const details = document.createElement("details");
    details.className = "settings-subsection";
    details.dataset.settingsSearch = `${title} ${eyebrow} ${SECTION_COPY[title] || ""} ${panel.textContent || ""}`.toLowerCase();

    const summary = document.createElement("summary");
    const copy = document.createElement("span");
    copy.className = "settings-subsection-copy";
    const heading = document.createElement("strong");
    heading.textContent = title;
    const description = document.createElement("small");
    description.textContent = SECTION_COPY[title] || eyebrow;
    copy.append(heading, description);
    summary.append(copy);

    const actions = [...header.children].filter((child) => !child.matches("div"));
    if (actions.length) {
      const actionWrap = document.createElement("span");
      actionWrap.className = "settings-subsection-actions";
      for (const action of actions) {
        action.addEventListener("click", (event) => event.stopPropagation());
        actionWrap.append(action);
      }
      summary.append(actionWrap);
    }

    header.remove();
    panel.classList.remove("panel");
    panel.classList.add("settings-subsection-body");
    panel.before(details);
    details.append(summary, panel);
  }
}

function wrapSettingsForms(): void {
  const forms = [...document.querySelectorAll<HTMLFormElement>("[data-view~='settings'] .settings-disclosure-body form")];
  for (const form of forms) {
    if (form.closest(".settings-editor")) continue;
    const formId = form.getAttribute("id") || "";
    const editor = document.createElement("details");
    editor.className = "settings-editor";
    editor.dataset.editorFor = formId;
    const summary = document.createElement("summary");
    summary.textContent = FORM_LABELS[formId] || "Details";
    const body = document.createElement("div");
    body.className = "settings-editor-body";
    const done = document.createElement("button");
    done.className = "ghost compact settings-editor-done";
    done.type = "button";
    done.textContent = "Done";
    done.addEventListener("click", () => {
      editor.open = false;
      editor.scrollIntoView({ block: "nearest" });
    });
    form.before(editor);
    body.append(form, done);
    editor.append(summary, body);
  }

  for (const list of document.querySelectorAll<HTMLElement>("[data-view~='settings'] .settings-subsection-body > .list")) {
    const firstEditor = list.parentElement?.querySelector<HTMLElement>(":scope > .settings-editor");
    if (firstEditor) list.parentElement?.insertBefore(list, firstEditor);
  }
}

function bindCategoryAccordion(): void {
  for (const disclosure of document.querySelectorAll<HTMLDetailsElement>("[data-view~='settings'] > .settings-disclosure")) {
    disclosure.addEventListener("toggle", () => {
      if (!disclosure.open) return;
      if (document.querySelector<HTMLInputElement>("#settingsSearch")?.value.trim()) return;
      for (const sibling of document.querySelectorAll<HTMLDetailsElement>("[data-view~='settings'] > .settings-disclosure")) {
        if (sibling !== disclosure) sibling.open = false;
      }
    });
  }
}

function bindEditorActions(): void {
  for (const [buttonId, formId] of Object.entries(NEW_EDITOR)) {
    document.querySelector<HTMLElement>(`#${buttonId}`)?.addEventListener("click", () => queueMicrotask(() => openEditor(formId)));
  }
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (!button || button.textContent?.trim() !== "Edit") return;
    const list = button.closest<HTMLElement>(".list");
    if (list?.id && LIST_EDITOR[list.id]) queueMicrotask(() => openEditor(LIST_EDITOR[list.id]));
  });
}

function openEditor(formId: string): void {
  const editor = document.querySelector<HTMLDetailsElement>(`.settings-editor[data-editor-for='${formId}']`);
  if (!editor) return;
  const subsection = editor.closest<HTMLDetailsElement>(".settings-subsection");
  if (subsection) subsection.open = true;
  for (const sibling of editor.parentElement?.querySelectorAll<HTMLDetailsElement>(":scope > .settings-editor") || []) {
    if (sibling !== editor) sibling.open = false;
  }
  editor.open = true;
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.setTimeout(() => editor.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea")?.focus(), 160);
}

function bindSettingsSearch(): void {
  const input = document.querySelector<HTMLInputElement>("#settingsSearch");
  if (!input) return;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    const disclosures = [...document.querySelectorAll<HTMLDetailsElement>("[data-view~='settings'] > .settings-disclosure")];
    for (const disclosure of disclosures) {
      const subsections = [...disclosure.querySelectorAll<HTMLDetailsElement>(".settings-subsection")];
      for (const subsection of subsections) {
        subsection.hidden = Boolean(query) && !(subsection.dataset.settingsSearch || subsection.textContent || "").toLowerCase().includes(query);
      }
      const topText = disclosure.querySelector(":scope > summary")?.textContent?.toLowerCase() || "";
      const hasVisibleSection = subsections.some((subsection) => !subsection.hidden);
      const match = !query || topText.includes(query) || hasVisibleSection || (!subsections.length && disclosure.textContent?.toLowerCase().includes(query));
      disclosure.hidden = !match;
      if (query && match) disclosure.open = true;
    }
    if (!query) {
      let keptOpen = false;
      for (const disclosure of disclosures) {
        if (!disclosure.open) continue;
        if (keptOpen) disclosure.open = false;
        keptOpen = true;
      }
    }
  });
}
