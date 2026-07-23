type EditorMap = Record<string, string>;

interface SettingsCategory {
  sourceTitle: string;
  id: string;
  label: string;
}

const CATEGORIES: SettingsCategory[] = [
  {
    sourceTitle: "Rules and limits",
    id: "rules",
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
    sourceTitle: "App icon",
    id: "appearance",
    label: "Appearance"
  }
];

const FORM_LABELS: EditorMap = {
  scheduleForm: "Schedule",
  limitForm: "Usage limit",
  appLockForm: "App lock",
  intentionalRuleForm: "Pre-open pause",
  grayscaleScheduleForm: "Grayscale schedule",
  intentionalGoalForm: "Intention",
  accountabilityForm: "Accountability digest",
  journalSecurityForm: "Journal lock",
  grayscaleSettingsForm: "Grayscale behavior",
  iosForm: "iPhone policy",
  iosMdmForm: "Advanced device management",
  keyholderForm: "Keyholder passcode",
  distanceKeyForm: "Distance key"
};

const COLLECTION_EDITORS = new Set([
  "scheduleForm",
  "limitForm",
  "appLockForm",
  "intentionalRuleForm",
  "grayscaleScheduleForm"
]);

const INLINE_FORM_HEADINGS = new Set([
  "intentionalGoalForm",
  "accountabilityForm",
  "grayscaleSettingsForm"
]);

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
  "Journal security": "Journal lock",
  "Protection status": "Protection status",
  "Screen Color": "Grayscale",
  "Visual style": "Portrait style"
};

const SECTION_COPY: Record<string, string> = {
  "Block Rules": "See the ruleset Vigil actually uses without exposing partial raw lists.",
  "Recurring Locks": "Start a chosen protection ruleset automatically on selected days.",
  "Time & Open Rules": "Limit distracting apps and sites by minutes or number of opens.",
  "Semi-Permanent Locks": "Require an intentional, limited unlock for selected apps and sites.",
  "Goals & Replacements": "Keep the purpose and better alternatives behind your rules close at hand.",
  "Pause Rules": "Add a deliberate pause before selected distracting use.",
  "Journal security": "Choose when Touch ID-protected journal access locks again.",
  "Protection status": "See what is healthy and repair anything that needs attention.",
  "Browser & network": "Keep browser, content-filter, and network coverage aligned.",
  "Unsafe-content protection": "View and refresh Vigil's managed protection without editing raw domains.",
  "Unlock safeguards": "Require deliberate proof before protected changes or overrides.",
  "Background enforcement": "Keep rules active as apps and system state change.",
  "Notification Focus": "Run named macOS Focus shortcuts with protected sessions.",
  "App updates": "Check Vigil's signed update channel and review update status.",
  "Maintenance & diagnostics": "Use the authenticated repair path and export diagnostics when needed.",
  "Screen Color": "Apply grayscale during soft blocks or on a recurring schedule.",
  "App icon": "Choose the icon used by Vigil and its menu-bar companion.",
  "Visual style": "Choose one consistent portrait and typography treatment.",
  iosForm: "Configure Vigil's managed iPhone filtering and focused-social controls.",
  iosMdmForm: "Configure a self-hosted APNs-backed MDM only when you use that delivery path."
};

let activeCategoryId = "rules";
let activeDetailId: string | null = null;

export function enhanceSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot || settingsRoot.dataset.settingsEnhanced === "true") return;
  settingsRoot.dataset.settingsEnhanced = "true";

  wrapSettingsPanels();
  wrapStandaloneSettingsForms();
  wrapSettingsForms();
  buildSettingsWorkspace(settingsRoot);
  bindEditorActions();
  bindSettingsSearch();
  bindContextualFields();
}

export function resetSettingsUi(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;

  for (const editor of settingsRoot.querySelectorAll<HTMLElement>(".settings-editor")) closeEditor(editor);
  for (const category of settingsRoot.querySelectorAll<HTMLElement>(".settings-category")) closeCategoryDetail(category, false);
  clearSettingsSearch(settingsRoot);
  selectCategory(activeCategoryId, false);
}

export function revealAppUpdateSettings(): void {
  selectCategory("protection", false);
  const panel = document.querySelector<HTMLElement>(".app-update-panel");
  const detail = panel?.closest<HTMLElement>(".settings-detail");
  if (!panel || !detail) return;
  openSettingsDetail(detail, false);
  panel.scrollIntoView({ block: "center" });
  panel.querySelector<HTMLButtonElement>("#checkAppUpdate")?.focus({ preventScroll: true });
}

export function closeSettingsEditor(formId: string, restoreFocus = true): void {
  const editor = document.querySelector<HTMLElement>(`.settings-editor[data-editor-for='${formId}']`);
  if (editor) closeEditor(editor, restoreFocus);
}

function wrapSettingsPanels(): void {
  const panels = [...document.querySelectorAll<HTMLElement>("[data-view~='settings'] .settings-disclosure-body .panel")];
  for (const panel of panels) {
    const header = panel.querySelector<HTMLElement>(":scope > .section-head");
    if (!header) continue;
    const headingGroup = [...header.children].find((child) => child.querySelector("h2, strong")) as HTMLElement | undefined;
    const heading = headingGroup?.querySelector<HTMLElement>("h2, strong");
    const originalTitle = heading?.textContent?.trim() || "Settings";
    const title = SECTION_TITLES[originalTitle] || originalTitle;
    const eyebrow = headingGroup?.querySelector<HTMLElement>(".eyebrow")?.textContent?.trim() || "Settings";
    const copy = SECTION_COPY[originalTitle] || "Review and update this part of Vigil.";

    panel.classList.remove("panel");
    panel.classList.add("settings-detail");
    panel.id = uniqueDetailId(title);
    panel.dataset.settingsTitle = title;
    panel.dataset.settingsSearch = `${title} ${copy} ${panel.textContent || ""}`.toLowerCase();

    const actions = document.createElement("div");
    actions.className = "settings-row-actions-source";
    for (const child of [...header.children]) {
      if (child !== headingGroup) actions.append(child);
    }

    const detailHeader = settingsDetailHeader(title, copy, eyebrow, heading?.id || "");
    header.replaceWith(detailHeader);
    panel.prepend(actions);
  }
}

function wrapStandaloneSettingsForms(): void {
  const forms = [...document.querySelectorAll<HTMLFormElement>("[data-view~='settings'] .settings-disclosure-body form")];
  for (const form of forms) {
    if (form.closest(".settings-detail") || form.hidden) continue;
    const disclosureBody = form.closest<HTMLElement>(".settings-disclosure-body");
    if (!disclosureBody) continue;
    const formId = form.getAttribute("id") || "";
    const title = FORM_LABELS[formId] || "Settings";
    const detail = document.createElement("section");
    detail.className = "settings-detail settings-form-detail";
    detail.id = uniqueDetailId(title);
    detail.dataset.settingsTitle = title;
    detail.dataset.settingsSearch = `${title} ${form.textContent || ""}`.toLowerCase();
    detail.append(settingsDetailHeader(title, SECTION_COPY[formId] || "Review and update this device configuration.", "Devices"), form);
    disclosureBody.append(detail);
  }
}

function settingsDetailHeader(title: string, copy: string, eyebrow: string, headingId = ""): HTMLElement {
  const header = document.createElement("header");
  header.className = "settings-detail-header";

  const back = document.createElement("button");
  back.className = "settings-back-button";
  back.type = "button";
  back.setAttribute("aria-label", `Back from ${title}`);
  back.textContent = "‹";

  const titleWrap = document.createElement("div");
  const kicker = document.createElement("span");
  kicker.className = "settings-detail-eyebrow";
  kicker.textContent = eyebrow;
  const heading = document.createElement("h2");
  if (headingId) heading.id = headingId;
  heading.textContent = title;
  const description = document.createElement("p");
  description.textContent = copy;
  titleWrap.append(kicker, heading, description);
  header.append(back, titleWrap);
  return header;
}

function wrapSettingsForms(): void {
  const forms = [...document.querySelectorAll<HTMLFormElement>("[data-view~='settings'] .settings-detail form")];
  for (const form of forms) {
    if (form.hidden || form.classList.contains("settings-inline-form")) continue;
    const formId = form.getAttribute("id") || "";
    if (COLLECTION_EDITORS.has(formId)) {
      wrapCollectionEditor(form, formId);
      continue;
    }

    form.classList.add("settings-inline-form");
    if (!INLINE_FORM_HEADINGS.has(formId)) continue;
    const group = document.createElement("section");
    group.className = "settings-form-group";
    const heading = document.createElement("h3");
    heading.textContent = FORM_LABELS[formId] || "Settings";
    form.before(group);
    group.append(heading, form);
  }

  for (const list of document.querySelectorAll<HTMLElement>("[data-view~='settings'] .settings-detail > .list")) {
    const firstEditor = list.parentElement?.querySelector<HTMLElement>(":scope > .settings-editor");
    if (firstEditor) list.parentElement?.insertBefore(list, firstEditor);
  }
}

function wrapCollectionEditor(form: HTMLFormElement, formId: string): void {
  const editor = document.createElement("section");
  editor.className = "settings-editor";
  editor.dataset.editorFor = formId;
  editor.hidden = true;

  const header = document.createElement("header");
  const heading = document.createElement("h3");
  heading.textContent = `Add or edit ${FORM_LABELS[formId]?.toLowerCase() || "rule"}`;
  const close = document.createElement("button");
  close.className = "ghost compact settings-editor-close";
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => closeEditor(editor, true));
  header.append(heading, close);

  form.before(editor);
  editor.append(header, form);
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
  nav.setAttribute("role", "tablist");
  const content = document.createElement("div");
  content.className = "settings-content";

  for (const category of CATEGORIES) {
    const disclosure = categoryByTitle.get(category.sourceTitle);
    if (!disclosure) continue;
    disclosure.open = true;
    disclosure.classList.add("settings-category");
    disclosure.dataset.category = category.id;
    disclosure.dataset.categoryLabel = category.label;
    disclosure.id = `settings-category-${category.id}`;
    disclosure.setAttribute("role", "tabpanel");
    disclosure.setAttribute("aria-labelledby", `settings-tab-${category.id}`);

    const body = disclosure.querySelector<HTMLElement>(":scope > .settings-disclosure-body");
    if (!body) continue;
    const details = [...body.querySelectorAll<HTMLElement>(".settings-detail")]
      .filter((detail) => !detail.parentElement?.closest(".settings-detail"));
    const index = document.createElement("div");
    index.className = "settings-index";
    const categoryLabel = document.createElement("h2");
    categoryLabel.className = "settings-search-category-label";
    categoryLabel.textContent = category.label;
    index.append(categoryLabel);
    const detailStack = document.createElement("div");
    detailStack.className = "settings-detail-stack";

    for (const detail of details) {
      index.append(settingsIndexRow(detail));
      detail.hidden = true;
      detail.querySelector<HTMLButtonElement>(":scope > .settings-detail-header .settings-back-button")
        ?.addEventListener("click", () => closeCategoryDetail(disclosure, true));
      detailStack.append(detail);
    }

    disclosure.dataset.settingsSearch = `${category.label} ${details.map((detail) => detail.dataset.settingsSearch || "").join(" ")}`.toLowerCase();
    body.replaceChildren(index, detailStack);
    content.append(disclosure);

    const button = document.createElement("button");
    button.type = "button";
    button.id = `settings-tab-${category.id}`;
    button.className = "settings-nav-item";
    button.dataset.settingsCategory = category.id;
    button.setAttribute("aria-controls", disclosure.id);
    button.setAttribute("role", "tab");
    button.textContent = category.label;
    button.addEventListener("click", () => selectCategory(category.id));
    button.addEventListener("keydown", handleCategoryKeydown);
    nav.append(button);
  }

  const empty = document.createElement("p");
  empty.className = "settings-search-empty";
  empty.hidden = true;
  empty.textContent = "No settings match that search.";
  layout.append(nav, content, empty);
  titlebar?.after(layout);
  selectCategory(activeCategoryId, false);
}

function settingsIndexRow(detail: HTMLElement): HTMLElement {
  const title = detail.dataset.settingsTitle || "Settings";
  const row = document.createElement("div");
  row.className = "settings-index-item";
  row.dataset.settingsSearch = detail.dataset.settingsSearch || title.toLowerCase();

  const main = document.createElement("button");
  main.className = "settings-row-main";
  main.type = "button";
  main.setAttribute("aria-controls", detail.id);
  const label = document.createElement("strong");
  label.textContent = title;
  const arrow = document.createElement("span");
  arrow.className = "settings-row-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = "›";
  main.append(label, arrow);
  main.addEventListener("click", () => openSettingsDetail(detail));
  row.append(main);

  const source = detail.querySelector<HTMLElement>(":scope > .settings-row-actions-source");
  if (source?.children.length) {
    addDetailActionMirrors(detail, source);
    const actions = document.createElement("div");
    actions.className = "settings-row-actions";
    actions.addEventListener("click", (event) => event.stopPropagation());
    actions.append(...source.children);
    row.append(actions);
  }
  source?.remove();
  return row;
}

function addDetailActionMirrors(detail: HTMLElement, source: HTMLElement): void {
  const statusSources = [...source.querySelectorAll<HTMLElement>(".pill")];
  const buttonSources = [...source.querySelectorAll<HTMLButtonElement>("button")];
  if (!statusSources.length && !buttonSources.length) return;

  const actionbar = document.createElement("div");
  actionbar.className = "settings-detail-actionbar";

  for (const statusSource of statusSources) {
    const mirror = statusSource.cloneNode(true) as HTMLElement;
    stripElementIds(mirror);
    const sync = () => {
      mirror.className = statusSource.className;
      mirror.textContent = statusSource.textContent;
      mirror.hidden = statusSource.hidden;
    };
    sync();
    new MutationObserver(sync).observe(statusSource, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true
    });
    actionbar.append(mirror);
  }

  for (const buttonSource of buttonSources) {
    const proxy = document.createElement("button");
    proxy.className = buttonSource.className;
    proxy.type = "button";
    proxy.textContent = buttonSource.textContent;
    proxy.setAttribute("aria-label", buttonSource.getAttribute("aria-label") || buttonSource.textContent?.trim() || "Open");
    const editorId = NEW_EDITOR[buttonSource.id];
    if (editorId) proxy.dataset.editorTrigger = editorId;
    proxy.addEventListener("click", () => buttonSource.click());
    actionbar.append(proxy);
  }

  detail.querySelector<HTMLElement>(":scope > .settings-detail-header")?.append(actionbar);
}

function stripElementIds(element: HTMLElement): void {
  element.removeAttribute("id");
  for (const child of element.querySelectorAll<HTMLElement>("[id]")) child.removeAttribute("id");
}

function selectCategory(categoryId: string, focus = true): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  if (!settingsRoot) return;
  const available = settingsRoot.querySelector<HTMLElement>(`.settings-category[data-category='${categoryId}']`);
  if (!available) categoryId = "rules";
  activeCategoryId = categoryId;
  activeDetailId = null;
  clearSettingsSearch(settingsRoot);

  for (const category of settingsRoot.querySelectorAll<HTMLElement>(".settings-category")) {
    closeCategoryDetail(category, false);
    category.classList.toggle("is-active", category.dataset.category === categoryId);
  }
  for (const button of settingsRoot.querySelectorAll<HTMLButtonElement>(".settings-nav-item")) {
    const active = button.dataset.settingsCategory === categoryId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus({ preventScroll: true });
  }
}

function handleCategoryKeydown(event: KeyboardEvent): void {
  if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>("#view-rules .settings-nav-item:not([hidden])")];
  const current = buttons.indexOf(event.currentTarget as HTMLButtonElement);
  if (current < 0 || !buttons.length) return;
  event.preventDefault();
  let next = current;
  if (event.key === "ArrowRight") next = (current + 1) % buttons.length;
  if (event.key === "ArrowLeft") next = (current - 1 + buttons.length) % buttons.length;
  if (event.key === "Home") next = 0;
  if (event.key === "End") next = buttons.length - 1;
  const categoryId = buttons[next].dataset.settingsCategory;
  if (categoryId) selectCategory(categoryId);
}

function openSettingsDetail(detail: HTMLElement, focus = true): void {
  const category = detail.closest<HTMLElement>(".settings-category");
  if (!category) return;
  const categoryId = category.dataset.category || "rules";
  if (activeCategoryId !== categoryId) selectCategory(categoryId, false);
  clearSettingsSearch(document.querySelector<HTMLElement>("#view-rules") || category);

  const index = category.querySelector<HTMLElement>(":scope > .settings-disclosure-body > .settings-index");
  if (index) index.hidden = true;
  for (const sibling of category.querySelectorAll<HTMLElement>(":scope > .settings-disclosure-body > .settings-detail-stack > .settings-detail")) {
    sibling.hidden = sibling !== detail;
  }
  category.classList.add("is-detail-open");
  activeDetailId = detail.id;
  if (focus) detail.querySelector<HTMLButtonElement>(".settings-back-button")?.focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeCategoryDetail(category: HTMLElement, restoreFocus: boolean): void {
  const previousDetailId = activeDetailId;
  const index = category.querySelector<HTMLElement>(":scope > .settings-disclosure-body > .settings-index");
  if (index) index.hidden = false;
  for (const detail of category.querySelectorAll<HTMLElement>(":scope > .settings-disclosure-body > .settings-detail-stack > .settings-detail")) {
    detail.hidden = true;
  }
  category.classList.remove("is-detail-open");
  if (category.dataset.category === activeCategoryId) activeDetailId = null;
  if (restoreFocus && previousDetailId) {
    category.querySelector<HTMLButtonElement>(`.settings-row-main[aria-controls='${previousDetailId}']`)?.focus({ preventScroll: true });
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
  const editor = document.querySelector<HTMLElement>(`.settings-editor[data-editor-for='${formId}']`);
  if (!editor) return;
  const detail = editor.closest<HTMLElement>(".settings-detail");
  if (detail) openSettingsDetail(detail, false);
  for (const sibling of editor.parentElement?.querySelectorAll<HTMLElement>(":scope > .settings-editor") || []) {
    if (sibling !== editor) closeEditor(sibling);
  }
  editor.hidden = false;
  editor.classList.add("is-open");
  editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.setTimeout(() => editor.querySelector<HTMLElement>("input:not([type='hidden']), select, textarea")?.focus(), 160);
}

function closeEditor(editor: HTMLElement, restoreFocus = false): void {
  editor.hidden = true;
  editor.classList.remove("is-open");
  if (!restoreFocus) return;
  const formId = editor.dataset.editorFor;
  if (!formId) return;
  const detail = editor.closest<HTMLElement>(".settings-detail");
  const trigger = detail?.querySelector<HTMLButtonElement>(`.settings-detail-actionbar [data-editor-trigger='${formId}']`);
  (trigger || detail?.querySelector<HTMLButtonElement>(".settings-back-button"))?.focus({ preventScroll: true });
}

function bindContextualFields(): void {
  const type = document.querySelector<HTMLSelectElement>("#limitForm select[name='type']");
  if (!type) return;
  const sync = () => {
    for (const field of document.querySelectorAll<HTMLElement>("#limitForm [data-limit-field]")) {
      field.hidden = field.dataset.limitField !== type.value;
    }
  };
  type.addEventListener("change", sync);
  sync();
}

function bindSettingsSearch(): void {
  const settingsRoot = document.querySelector<HTMLElement>("#view-rules");
  const input = settingsRoot?.querySelector<HTMLInputElement>("#settingsSearch");
  if (!settingsRoot || !input) return;
  input.addEventListener("input", () => {
    const query = input.value.trim().toLowerCase();
    settingsRoot.classList.toggle("is-searching", Boolean(query));
    const nav = settingsRoot.querySelector<HTMLElement>(".settings-nav");
    if (nav) nav.hidden = Boolean(query);
    let matches = 0;

    for (const category of settingsRoot.querySelectorAll<HTMLElement>(".settings-category")) {
      closeCategoryDetail(category, false);
      const rows = [...category.querySelectorAll<HTMLElement>(".settings-index-item")];
      for (const row of rows) {
        row.hidden = Boolean(query) && !(row.dataset.settingsSearch || row.textContent || "").toLowerCase().includes(query);
        if (!row.hidden) matches += 1;
      }
      category.hidden = Boolean(query) && !rows.some((row) => !row.hidden);
      if (query) {
        category.setAttribute("role", "region");
        category.setAttribute("aria-label", `${category.dataset.categoryLabel || "Settings"} search results`);
        category.removeAttribute("aria-labelledby");
      } else {
        restoreCategoryTabSemantics(category);
      }
    }

    const empty = settingsRoot.querySelector<HTMLElement>(".settings-search-empty");
    if (empty) empty.hidden = !query || matches > 0;
    if (!query) selectCategory(activeCategoryId, false);
  });
}

function clearSettingsSearch(settingsRoot: HTMLElement): void {
  const search = settingsRoot.querySelector<HTMLInputElement>("#settingsSearch");
  if (search) search.value = "";
  settingsRoot.classList.remove("is-searching");
  const nav = settingsRoot.querySelector<HTMLElement>(".settings-nav");
  if (nav) nav.hidden = false;
  for (const filtered of settingsRoot.querySelectorAll<HTMLElement>(".settings-category, .settings-index-item, .settings-nav-item")) {
    filtered.hidden = false;
  }
  for (const category of settingsRoot.querySelectorAll<HTMLElement>(".settings-category")) restoreCategoryTabSemantics(category);
  const empty = settingsRoot.querySelector<HTMLElement>(".settings-search-empty");
  if (empty) empty.hidden = true;
}

function restoreCategoryTabSemantics(category: HTMLElement): void {
  category.setAttribute("role", "tabpanel");
  category.setAttribute("aria-labelledby", `settings-tab-${category.dataset.category || "rules"}`);
  category.removeAttribute("aria-label");
}

function uniqueDetailId(title: string): string {
  const base = `settings-detail-${title.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "settings"}`;
  let id = base;
  let suffix = 2;
  while (document.getElementById(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}
