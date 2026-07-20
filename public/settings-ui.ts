type EditorMap = Record<string, string>;

interface SettingsCategory {
  sourceTitle: string;
  id: string;
  label: string;
}

const CATEGORIES: SettingsCategory[] = [
  {
    sourceTitle: "Rules and limits",
    id: "agent",
    label: "Rules"
  },
  {
    sourceTitle: "Protection and hardening",
    id: "protection",
    label: "Protection"
  },
  {
    sourceTitle: "Devices and iPhone",
    id: "devices",
    label: "Devices"
  },
  {
    sourceTitle: "Journal access",
    id: "journal",
    label: "Journal"
  },
  {
    sourceTitle: "App icon",
    id: "appearance",
    label: "Appearance"
  }
];

const FORM_LABELS: EditorMap = {
  profileForm: "Edit block list",
  scheduleForm: "Add or edit schedule",
  limitForm: "Add or edit limit",
  appLockForm: "Add or edit app lock",
  intentionalGoalForm: "Edit intention",
  accountabilityForm: "Accountability digest",
  intentionalRuleForm: "Add or edit pause",
  journalSecurityForm: "Automatic locking",
  grayscaleSettingsForm: "Grayscale behavior",
  grayscaleScheduleForm: "Add or edit schedule",
  iosForm: "iPhone policy",
  iosMdmForm: "Advanced MDM",
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

const SECTION_TITLES: Record<string, string> = {
  "Block Rules": "Block list",
  "Recurring Locks": "Schedules",
  "Time & Open Rules": "Usage limits",
  "Semi-Permanent Locks": "App locks",
  "Goals & Replacements": "Intentions",
  "Pause Rules": "Pre-open pause",
  "Setup Checklist": "Agent health",
  "Local Protections": "Bypass protection",
  "Screen Color": "Grayscale",
  "Journal security": "Journal lock"
};

const SECTION_COPY: Record<string, string> = {
  "Block Rules": "Apps, sites, and URL patterns the agent blocks",
  "Recurring Locks": "Scheduled focus and lock windows",
  "Time & Open Rules": "Daily time and opening budgets",
  "Semi-Permanent Locks": "Apps that require an intentional unlock",
  "Goals & Replacements": "The intention behind your focus system",
  "Pause Rules": "A deliberate pause before distracting use",
  "Setup Checklist": "Readiness and items that need attention",
  "Local Protections": "Enforcement, keys, maintenance, and diagnostics",
  "Screen Color": "Grayscale behavior and schedules",
  "Journal security": "Touch ID and automatic locking"
};

let activeCategoryId = "agent";

export function enhanceSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot || settingsRoot.dataset.settingsEnhanced === "true") return;
  settingsRoot.dataset.settingsEnhanced = "true";

  wrapSettingsPanels();
  wrapSettingsForms();
  buildSettingsWorkspace(settingsRoot);
  bindSubsectionAccordion();
  bindEditorActions();
  bindSettingsSearch();
}

export function resetSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;

  for (const disclosure of settingsRoot.querySelectorAll<HTMLDetailsElement>("details")) {
    if (disclosure.classList.contains("settings-category")) continue;
    disclosure.open = false;
    disclosure.hidden = false;
  }
  clearSettingsSearch(settingsRoot);
  selectCategory(activeCategoryId, false);
}

function clearSettingsSearch(settingsRoot: HTMLElement): void {
  const search = settingsRoot.querySelector<HTMLInputElement>("#settingsSearch");
  if (search) search.value = "";
  settingsRoot.classList.remove("is-searching");
  for (const filtered of settingsRoot.querySelectorAll<HTMLElement>(".settings-category, .settings-subsection, .settings-nav-item")) {
    filtered.hidden = false;
  }
}

function bindSubsectionAccordion(): void {
  for (const disclosure of document.querySelectorAll<HTMLDetailsElement>(".settings-category .settings-subsection")) {
    if (disclosure.parentElement?.closest(".settings-subsection")) continue;
    disclosure.addEventListener("toggle", () => {
      if (!disclosure.open) return;
      const category = disclosure.closest<HTMLElement>(".settings-category");
      for (const sibling of category?.querySelectorAll<HTMLDetailsElement>(".settings-subsection") || []) {
        if (sibling.parentElement?.closest(".settings-subsection")) continue;
        if (sibling !== disclosure) sibling.open = false;
      }
    });
  }
}

function buildSettingsWorkspace(settingsRoot: HTMLElement): void {
  const titlebar = settingsRoot.querySelector<HTMLElement>(".settings-titlebar");
  const disclosures = [...document.querySelectorAll<HTMLDetailsElement>("[data-view~='settings'] > .settings-disclosure")];
  const categoryByTitle = new Map<string, HTMLDetailsElement>();
  for (const disclosure of disclosures) {
    const title = disclosure.querySelector<HTMLElement>(":scope > summary > span:first-child")?.textContent?.trim() || "";
    categoryByTitle.set(title, disclosure);
  }

  const layout = document.createElement("div");
  layout.className = "settings-layout";
  const nav = document.createElement("nav");
  nav.className = "settings-nav";
  nav.setAttribute("aria-label", "Settings categories");
  const content = document.createElement("div");
  content.className = "settings-content";

  for (const category of CATEGORIES) {
    const disclosure = categoryByTitle.get(category.sourceTitle);
    if (!disclosure) continue;
    disclosure.open = true;
    disclosure.classList.add("settings-category");
    disclosure.dataset.category = category.id;
    disclosure.dataset.settingsSearch = `${category.label} ${disclosure.textContent || ""}`.toLowerCase();

    const sourceSummary = disclosure.querySelector<HTMLElement>(":scope > summary");
    const status = sourceSummary?.querySelector<HTMLElement>(":scope > .pill, :scope > #iconThemeStatus");
    if (status) {
      status.classList.add("settings-category-status", "sr-only");
      sourceSummary?.after(status);
    }
    content.append(disclosure);

    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-nav-item";
    button.dataset.settingsCategory = category.id;
    button.setAttribute("aria-controls", `settings-category-${category.id}`);
    button.textContent = category.label;
    disclosure.id = `settings-category-${category.id}`;
    button.addEventListener("click", () => selectCategory(category.id));
    button.addEventListener("keydown", handleCategoryKeydown);
    nav.append(button);
  }

  layout.append(nav, content);
  titlebar?.after(layout);
  selectCategory(activeCategoryId, false);
}

function selectCategory(categoryId: string, focus = true): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;
  const available = settingsRoot.querySelector<HTMLElement>(`.settings-category[data-category='${categoryId}']`);
  if (!available) categoryId = "agent";
  activeCategoryId = categoryId;
  clearSettingsSearch(settingsRoot);

  for (const category of settingsRoot.querySelectorAll<HTMLElement>(".settings-category")) {
    category.classList.toggle("is-active", category.dataset.category === categoryId);
  }
  for (const button of settingsRoot.querySelectorAll<HTMLButtonElement>(".settings-nav-item")) {
    const active = button.dataset.settingsCategory === categoryId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus({ preventScroll: true });
  }
}

function handleCategoryKeydown(event: KeyboardEvent): void {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#view-rules .settings-nav-item:not([hidden])")];
  const current = buttons.indexOf(event.currentTarget as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  event.preventDefault();
  let next = current;
  if (event.key === "ArrowDown") next = (current + 1) % buttons.length;
  if (event.key === "ArrowUp") next = (current - 1 + buttons.length) % buttons.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = buttons.length - 1;
  const categoryId = buttons[next].dataset.settingsCategory;
  if (categoryId) selectCategory(categoryId);
}

function wrapSettingsPanels(): void {
  const panels = [...document.querySelectorAll<HTMLElement>("[data-view~='settings'] .settings-disclosure-body .panel")];
  for (const panel of panels) {
    if (panel.closest(".settings-subsection")) continue;
    const header = panel.querySelector<HTMLElement>(":scope > .section-head");
    if (!header) continue;
    const originalTitle = header.querySelector<HTMLElement>("h2, strong")?.textContent?.trim() || "Settings";
    const eyebrow = header.querySelector<HTMLElement>(".eyebrow")?.textContent?.trim() || "";
    const details = document.createElement("details");
    details.className = "settings-subsection";
    details.dataset.settingsSearch = `${originalTitle} ${eyebrow} ${SECTION_COPY[originalTitle] || ""} ${panel.textContent || ""}`.toLowerCase();

    const summary = document.createElement("summary");
    summary.append(settingsRowCopy(SECTION_TITLES[originalTitle] || originalTitle));

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
    const isTopLevel = !form.closest(".settings-subsection");
    const editor = document.createElement("details");
    editor.className = isTopLevel ? "settings-subsection settings-editor settings-form-section" : "settings-editor";
    editor.dataset.editorFor = formId;
    editor.dataset.settingsSearch = `${FORM_LABELS[formId] || "Settings"} ${form.textContent || ""}`.toLowerCase();
    const summary = document.createElement("summary");

    if (isTopLevel) {
      summary.append(settingsRowCopy(FORM_LABELS[formId] || "Settings"));
      const status = form.querySelector<HTMLElement>(":scope > .device-form-head .pill");
      if (status) {
        const actions = document.createElement("span");
        actions.className = "settings-subsection-actions";
        actions.append(status);
        summary.append(actions);
      }
    } else {
      summary.textContent = FORM_LABELS[formId] || "Edit details";
    }

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

function settingsRowCopy(title: string): HTMLElement {
  const copy = document.createElement("span");
  copy.className = "settings-subsection-copy";
  const heading = document.createElement("strong");
  heading.textContent = title;
  copy.append(heading);
  return copy;
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
  const subsection = editor.closest<HTMLDetailsElement>(".settings-subsection:not(.settings-form-section)");
  if (subsection) subsection.open = true;
  for (const sibling of editor.parentElement?.querySelectorAll<HTMLDetailsElement>(":scope > .settings-editor") || []) {
    if (sibling !== editor) sibling.open = false;
  }
  editor.open = true;
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.setTimeout(() => editor.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea")?.focus(), 160);
}

function bindSettingsSearch(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  const input = settingsRoot?.querySelector<HTMLInputElement>("#settingsSearch");
  if (!settingsRoot || !input) return;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    settingsRoot.classList.toggle("is-searching", Boolean(query));
    const categories = [...settingsRoot.querySelectorAll<HTMLElement>(".settings-category")];

    for (const category of categories) {
      const subsections = [...category.querySelectorAll<HTMLDetailsElement>(".settings-subsection")]
        .filter((section) => !section.parentElement?.closest(".settings-subsection"));
      for (const subsection of subsections) {
        subsection.hidden = Boolean(query) && !(subsection.dataset.settingsSearch || subsection.textContent || "").toLowerCase().includes(query);
      }
      const hasVisibleSection = subsections.some((subsection) => !subsection.hidden);
      const categoryMatch = (category.dataset.settingsSearch || category.textContent || "").toLowerCase().includes(query);
      category.hidden = Boolean(query) && !hasVisibleSection && !categoryMatch;
    }

    for (const button of settingsRoot.querySelectorAll<HTMLButtonElement>(".settings-nav-item")) {
      const category = settingsRoot.querySelector<HTMLElement>(`.settings-category[data-category='${button.dataset.settingsCategory}']`);
      button.hidden = Boolean(category?.hidden);
    }

    if (!query) selectCategory(activeCategoryId, false);
  });
}
