import { del, get, post } from "./api-client.js";
import { createAccountUi } from "./account-ui.js";
import { applyProtectionLevelPresentation, normalizedProtectionLevel } from "./app-events.js";
import { createAppUpdatePanel } from "./app-update.js";
import { daysText, formatDuration, lines } from "./format.js";
import { createSaintStage } from "./saint-stage.js";
import { $, $$, errorMessage, initTheme } from "./ui-shell.js";
import { bindWindowResizeHandles } from "./window-resize.js";
import type {
  ActivePolicy,
  ChallengeSummary,
  DashboardData,
  DashboardItem,
  DashboardState,
  GrayscaleSchedule,
  Schedule,
  SessionStartResponse,
  UnknownRecord
} from "./app-model.js";

type Profile = DashboardState["profiles"][number];
type ScheduleKind = "lock" | "grayscale";

interface ScheduleEntry {
  kind: ScheduleKind;
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
  deviceTargets: string[];
  lock?: Schedule;
  grayscale?: GrayscaleSchedule;
}

interface PendingResponse extends UnknownRecord {
  pending?: { id?: string };
  activeWindow?: UnknownRecord;
}

interface ProfileSaveResponse extends UnknownRecord {
  profile?: Profile;
}

interface VigilAppearanceBridge {
  getIconTheme(): Promise<unknown>;
  setIconTheme(theme: string): Promise<unknown>;
}

interface VigilAppearanceWindow extends Window {
  vigilAppearance?: VigilAppearanceBridge;
}

interface VigilAppUpdateNavigationWindow extends Window {
  vigilAppUpdate?: {
    subscribeDetails?(listener: () => void): () => void;
  };
}

const BUILT_IN_PROFILE_IDS = new Set(["default", "normal", "soft-block", "brick-mode"]);
const ACTIVE_STATE_POLL_MS = 3_000;
const INACTIVE_STATE_POLL_MS = 30_000;

const ui = {
  data: null as DashboardData | null,
  activeView: "home",
  selectedProfileId: null as string | null,
  pendingEmergencyId: null as string | null,
  pendingMaintenanceId: null as string | null
};

let refreshCycle: Promise<void> | null = null;
let refreshRequested = false;
let protectionRequestInFlight = false;
let profileFormDirty = false;
let iosFormDirty = false;
let resumeScheduleAfterMaintenance = false;
let selectedAppLockRequestId: string | null = null;
let toastTimer: number | null = null;

const appUpdatePanel = createAppUpdatePanel({ $, get, post, toast, errorMessage });
const accountUi = createAccountUi();
const saintStage = createSaintStage();

boot();

function boot(): void {
  initTheme();
  if ("vigilWindowResize" in window) document.documentElement.classList.add("electron-shell");
  bindWindowResizeHandles();
  bindNavigation();
  bindConfigurationNavigation();
  bindProtectionActions();
  saintStage.bind();
  bindScheduleActions();
  bindProfileActions();
  bindLimitActions();
  bindSettingActions();
  bindDeviceActions();
  bindMaintenanceActions();
  bindHardeningActions();
  bindIconThemeSettings();
  bindAppUpdateDetailsNavigation();
  appUpdatePanel.bind();
  accountUi.bind();
  appUpdatePanel.render();
  void appUpdatePanel.refreshStatus(false);
  window.setInterval(renderCountdowns, 1_000);
  void pollState();
}

function bindNavigation(): void {
  for (const button of $$<HTMLButtonElement>("[data-view-target]")) {
    button.addEventListener("click", () => setView(button.dataset.viewTarget || "home"));
  }
}

function setView(view: string): void {
  const next = ["home", "schedules", "configuration"].includes(view) ? view : "home";
  ui.activeView = next;
  document.body.dataset.activeView = next;
  for (const panel of $$<HTMLElement>("[data-view]")) {
    const active = panel.dataset.view === next;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  for (const button of $$<HTMLButtonElement>("#primaryNavigation [data-view-target]")) {
    const active = button.dataset.viewTarget === next;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
  if (next !== "configuration") closeConfigurationDetail(false);
  window.scrollTo(0, 0);
}

function bindConfigurationNavigation(): void {
  for (const button of $$<HTMLButtonElement>("[data-config-target]")) {
    button.addEventListener("click", () => openConfigurationPanel(button.dataset.configTarget || "rules"));
  }
  for (const button of $$<HTMLButtonElement>("[data-config-link]")) {
    button.addEventListener("click", () => openConfigurationPanel(button.dataset.configLink || "maintenance"));
  }
  for (const button of $$<HTMLButtonElement>("[data-config-back]")) {
    button.addEventListener("click", () => closeConfigurationDetail(true));
  }
  $("#configurationSearch").addEventListener("input", filterConfigurationCards);
}

function openConfigurationPanel(panelName: string): void {
  setView("configuration");
  $("#configurationIndex").hidden = true;
  $("#configurationDetails").hidden = false;
  for (const panel of $$<HTMLElement>("[data-config-panel]")) {
    panel.hidden = panel.dataset.configPanel !== panelName;
  }
  $("#configurationSearch").value = "";
  filterConfigurationCards();
  window.scrollTo(0, 0);
}

function closeConfigurationDetail(focusSearch: boolean): void {
  const details = $("#configurationDetails");
  if (details.hidden) return;
  details.hidden = true;
  $("#configurationIndex").hidden = false;
  for (const panel of $$<HTMLElement>("[data-config-panel]")) panel.hidden = true;
  if (focusSearch) $("#configurationSearch").focus();
}

function filterConfigurationCards(): void {
  const query = $("#configurationSearch").value.trim().toLowerCase();
  let visible = 0;
  for (const card of $$<HTMLButtonElement>(".config-card")) {
    const haystack = `${card.dataset.configSearch || ""} ${card.textContent || ""}`.toLowerCase();
    card.hidden = Boolean(query) && !haystack.includes(query);
    if (!card.hidden) visible += 1;
  }
  $("#configurationEmpty").hidden = visible > 0;
}

function bindAppUpdateDetailsNavigation(): void {
  const bridge = (window as VigilAppUpdateNavigationWindow).vigilAppUpdate;
  bridge?.subscribeDetails?.(() => openConfigurationPanel("maintenance"));
}

async function pollState(): Promise<void> {
  if (!document.hidden) await refresh();
  window.setTimeout(() => void pollState(), document.hidden ? INACTIVE_STATE_POLL_MS : ACTIVE_STATE_POLL_MS);
}

function refresh(): Promise<void> {
  refreshRequested = true;
  refreshCycle ||= runRefreshLoop();
  return refreshCycle;
}

async function runRefreshLoop(): Promise<void> {
  try {
    while (refreshRequested) {
      refreshRequested = false;
      try {
        ui.data = await get<DashboardData>("/api/state");
        render();
      } catch (error) {
        toast(errorMessage(error));
      }
    }
  } finally {
    refreshCycle = null;
  }
}

function render(): void {
  const data = ui.data;
  if (!data) return;
  renderHome(data);
  renderSchedules(data);
  renderProfiles(data.state);
  renderLimits(data.limits.rules);
  renderAppLocks(data.appLocks.rules);
  renderSettings(data);
  renderDevice(data);
  renderHealth(data);
  renderEmergency(data.state);
  renderMaintenance(data);
  renderCountdowns();
  appUpdatePanel.render();
}

function bindProtectionActions(): void {
  const input = $("#protectionLevel") as unknown as HTMLInputElement;
  const control = $("#protectionLevelControl");
  const label = $("#protectionLevelLabel");
  const status = $("#protectionLevelStatus");
  const choices = $$<HTMLButtonElement>("[data-protection-level-choice]");
  let appliedLevel = normalizedProtectionLevel(Number(input.value || 1));

  const setOpen = (open: boolean) => {
    control.classList.toggle("is-open", open);
    control.setAttribute("aria-expanded", String(open));
    for (const choice of choices) choice.tabIndex = open ? 0 : -1;
  };
  const preview = (level: number) => applyProtectionLevelPresentation(level, true, { input, control, label, status });
  const apply = (level: number) => {
    const normalized = normalizedProtectionLevel(level);
    if (normalized === 3 && !window.confirm("Start Panic mode for three minutes? It cannot be ended early.")) {
      applyProtectionLevelPresentation(appliedLevel, false, { input, control, label, status });
      void refresh();
      return;
    }
    appliedLevel = normalized;
    control.classList.add("is-settling");
    window.setTimeout(() => control.classList.remove("is-settling"), 954);
    void setProtectionLevel(normalized);
  };

  input.addEventListener("focus", () => {
    appliedLevel = normalizedProtectionLevel(Number(input.value || 1));
  });
  input.addEventListener("input", () => preview(Number(input.value || 1)));
  input.addEventListener("change", () => apply(Number(input.value || 1)));
  control.addEventListener("pointerleave", () => control.classList.remove("is-settling"));
  control.addEventListener("keydown", (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
      input.focus();
    }
  });
  document.addEventListener("pointerdown", (event) => {
    if (!control.contains(event.target as Node)) setOpen(false);
  });
  for (const choice of choices) {
    choice.addEventListener("click", () => {
      if (input.disabled) return;
      if (!control.classList.contains("is-open")) {
        setOpen(true);
        return;
      }
      const requested = Number(choice.dataset.protectionLevelChoice || 1);
      setOpen(false);
      if (requested === Number(input.value || 1)) return;
      apply(preview(requested));
    });
  }
}

async function setProtectionLevel(levelValue: number): Promise<void> {
  if (protectionRequestInFlight) return;
  const level = normalizedProtectionLevel(levelValue);
  protectionRequestInFlight = true;
  setProtectionButtonsDisabled(true);
  try {
    if (level === 3) {
      const durationMinutes = Number(ui.data?.state.settings.panicLockDurationMinutes || 3);
      await post<SessionStartResponse>("/api/panic/start", { durationMinutes });
      toast(`Panic lock started for ${durationMinutes} minute${durationMinutes === 1 ? "" : "s"}`);
    } else {
      await post("/api/protection/level", { level, deviceTargets: ["computer", "phone"] });
      toast(level === 1 ? "Filtered social restored" : "Full Brick applied");
    }
  } catch (error) {
    handleMutationError(error);
  } finally {
    await refresh();
    protectionRequestInFlight = false;
    setProtectionButtonsDisabled(false);
  }
}

function setProtectionButtonsDisabled(disabled: boolean): void {
  $("#protectionLevel").disabled = disabled;
  for (const button of $$<HTMLButtonElement>("[data-protection-level-choice]")) button.disabled = disabled;
}

function renderHome(data: DashboardData): void {
  const level = activeProtectionLevel(data.state);
  const input = $("#protectionLevel") as unknown as HTMLInputElement;
  const active = data.state.activePolicy;
  const userAdjusting = document.activeElement === input;
  if (!userAdjusting) {
    input.value = String(level);
    $("#protectionLevelControl").dataset.level = String(level);
    $("#protectionLevelLabel").textContent = level === 3 ? "Panic" : `Level ${level}`;
  }
  input.disabled = protectionRequestInFlight || level === 3;
  input.setAttribute("aria-valuetext", level === 3 ? "Panic, locked for three minutes" : `Level ${level}`);
  for (const button of $$<HTMLButtonElement>("[data-protection-level-choice]")) {
    const selected = Number(button.dataset.protectionLevelChoice) === level;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  if (level === 3 && active) {
    const seconds = Math.max(0, Math.ceil((new Date(active.endsAt).getTime() - Date.now()) / 1_000));
    $("#protectionLevelStatus").textContent = `${formatDuration(seconds)} locked`;
  } else if (!userAdjusting) {
    $("#protectionLevelStatus").textContent = level === 1 ? "Filtered Social" : "Full Brick";
  }

  const phase = active?.phase || data.state.sessionPhase;
  const activeBlocks = data.limits.activeBlocks.filter((block) => new Date(block.until).getTime() > Date.now());
  const persistentLevel = active?.session?.source === "protection-level" || data.state.activeSession?.source === "protection-level";
  const hasRuntimeStatus = Boolean(active || data.state.activeSession || activeBlocks.length) && !persistentLevel;
  $("#homeRuntimeStatus").classList.toggle("hidden", active?.kind === "integrity" || !hasRuntimeStatus);
  const orbState = active?.kind === "integrity"
    ? "integrity"
    : active
      ? "locked"
      : data.state.activeSession && phase?.kind === "break"
        ? "break"
        : data.state.activeSession
          ? "session"
          : activeBlocks.length
            ? "limit"
            : "idle";
  $("#vigilOrb").className = `vigil-orb ${orbState}`;
  document.body.dataset.lockState = orbState;
}

function activeProtectionLevel(appState: DashboardState): number {
  if (appState.activePolicy?.kind === "panic" || appState.panicLock) return 3;
  const profileIds = new Set([
    appState.activePolicy?.profile?.id,
    appState.activePolicy?.session?.profileId,
    ...Object.values(appState.activeSessions || {}).map((session) => session?.profileId)
  ].filter((value): value is string => Boolean(value)));
  if (profileIds.has("brick-mode")) return 2;
  return 1;
}

function renderCountdowns(): void {
  const data = ui.data;
  if (!data) return;
  renderHome(data);
  const appState = data.state;
  const active = appState.activePolicy;
  const phase = active?.phase || appState.sessionPhase;
  const activeBlocks = data.limits.activeBlocks.filter((block) => new Date(block.until).getTime() > Date.now());
  if (active?.kind === "integrity") {
    $("#sessionTitle").textContent = "Integrity lockdown";
    $("#sessionCountdown").textContent = "Until cleared through maintenance";
  } else if (active?.session?.source === "protection-level") {
    $("#sessionTitle").textContent = active.session.title || "Protection active";
    $("#sessionCountdown").textContent = "Until you choose another level";
  } else if (phase) {
    $("#sessionTitle").textContent = active?.session?.title || appState.activeSession?.title || "Session running";
    $("#sessionCountdown").textContent = `${phase.label} · ${countdownText(phase.endsAt)}`;
  } else if (active) {
    $("#sessionTitle").textContent = active.session.title || "Session running";
    $("#sessionCountdown").textContent = countdownText(active.endsAt);
  } else if (activeBlocks.length) {
    const latest = Math.max(...activeBlocks.map((block) => new Date(block.until).getTime()));
    $("#sessionTitle").textContent = "Usage limit lock";
    $("#sessionCountdown").textContent = countdownText(new Date(latest).toISOString());
  } else {
    $("#sessionTitle").textContent = "Ready";
    $("#sessionCountdown").textContent = "No timed lock is active";
  }
  renderEmergency(appState);
  renderMaintenance(data);
}

function countdownText(endsAt: string): string {
  const seconds = Math.max(0, Math.ceil((new Date(endsAt).getTime() - Date.now()) / 1_000));
  return seconds < 60 ? `${seconds}s remaining` : `${formatDuration(seconds)} remaining`;
}

function bindScheduleActions(): void {
  $("#newSchedule").addEventListener("click", () => openNewSchedule("lock"));
  $("#closeScheduleEditor").addEventListener("click", closeScheduleEditor);
  $("#cancelScheduleEditor").addEventListener("click", closeScheduleEditor);
  $("#scheduleKind").addEventListener("change", syncScheduleKindFields);
  for (const button of $$<HTMLButtonElement>("[data-schedule-template]")) {
    button.addEventListener("click", () => openScheduleTemplate(button.dataset.scheduleTemplate || "workday"));
  }
  const dialog = document.querySelector<HTMLDialogElement>("#scheduleEditor");
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) closeScheduleEditor();
  });
  scheduleForm().addEventListener("submit", (event) => {
    event.preventDefault();
    void saveSchedule();
  });
}

function scheduleForm(): HTMLFormElement {
  return $("#scheduleForm") as unknown as HTMLFormElement;
}

function scheduleField<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(name: string): T {
  const control = scheduleForm().elements.namedItem(name);
  if (!(control instanceof HTMLElement)) throw new Error(`Missing schedule field: ${name}`);
  return control as T;
}

function openNewSchedule(kind: ScheduleKind): void {
  const form = scheduleForm();
  form.reset();
  scheduleField<HTMLInputElement>("id").value = "";
  scheduleField<HTMLInputElement>("id").dataset.lockLevel = "deep";
  scheduleField<HTMLSelectElement>("kind").value = kind;
  scheduleField<HTMLInputElement>("name").value = kind === "lock" ? "Focus block" : "Night grayscale";
  scheduleField<HTMLSelectElement>("mode").value = "focus";
  scheduleField<HTMLInputElement>("start").value = kind === "lock" ? "09:00" : "21:00";
  scheduleField<HTMLInputElement>("end").value = kind === "lock" ? "17:00" : "07:00";
  scheduleField<HTMLInputElement>("enabled").checked = false;
  scheduleField<HTMLInputElement>("commitmentLock").checked = false;
  setScheduleDays(kind === "lock" ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]);
  setScheduleDevices(["computer", "phone"]);
  scheduleField<HTMLTextAreaElement>("wifiNetworks").value = "";
  fillScheduleProfileOptions(ui.data?.state);
  const baseline = baselineProfileId(ui.data?.state);
  if (baseline) $("#scheduleProfileId").value = baseline;
  $("#scheduleEditorTitle").textContent = kind === "lock" ? "New protection schedule" : "New grayscale routine";
  $("#scheduleValidation").hidden = true;
  syncScheduleKindFields();
  document.querySelector<HTMLDialogElement>("#scheduleEditor")?.showModal();
}

function openScheduleTemplate(template: string): void {
  if (template === "grayscale") {
    openNewSchedule("grayscale");
    scheduleField<HTMLInputElement>("name").value = "Night grayscale";
    scheduleField<HTMLInputElement>("start").value = "21:00";
    scheduleField<HTMLInputElement>("end").value = "07:00";
    scheduleField<HTMLInputElement>("enabled").checked = true;
    return;
  }
  openNewSchedule("lock");
  scheduleField<HTMLInputElement>("enabled").checked = true;
  if (template === "evening") {
    scheduleField<HTMLInputElement>("name").value = "Evening wind-down";
    scheduleField<HTMLSelectElement>("mode").value = "sleep";
    scheduleField<HTMLInputElement>("start").value = "21:00";
    scheduleField<HTMLInputElement>("end").value = "07:00";
    setScheduleDays([0, 1, 2, 3, 4, 5, 6]);
  } else {
    scheduleField<HTMLInputElement>("name").value = "Workday focus";
  }
}

function closeScheduleEditor(): void {
  document.querySelector<HTMLDialogElement>("#scheduleEditor")?.close();
}

function syncScheduleKindFields(): void {
  const kind = scheduleField<HTMLSelectElement>("kind").value as ScheduleKind;
  for (const element of $$<HTMLElement>("[data-schedule-kind-field]")) {
    element.hidden = element.dataset.scheduleKindField !== kind;
  }
}

function setScheduleDays(days: number[]): void {
  const selected = new Set(days);
  for (const input of $$<HTMLInputElement>("#scheduleDays input")) input.checked = selected.has(Number(input.value));
}

function setScheduleDevices(devices: readonly string[]): void {
  const selected = new Set(devices);
  for (const input of $$<HTMLInputElement>("#scheduleForm input[name='deviceTargets']")) input.checked = selected.has(input.value);
}

function selectedScheduleDays(): number[] {
  return [...$$<HTMLInputElement>("#scheduleDays input:checked")].map((input) => Number(input.value));
}

function selectedScheduleDevices(): string[] {
  return [...$$<HTMLInputElement>("#scheduleForm input[name='deviceTargets']:checked")].map((input) => input.value);
}

async function saveSchedule(): Promise<void> {
  const kind = scheduleField<HTMLSelectElement>("kind").value as ScheduleKind;
  const validation = validateScheduleForm(kind);
  if (validation) {
    $("#scheduleValidation").textContent = validation;
    $("#scheduleValidation").hidden = false;
    return;
  }
  $("#scheduleValidation").hidden = true;
  const id = scheduleField<HTMLInputElement>("id").value;
  const shared = {
    ...(id ? { id } : {}),
    name: scheduleField<HTMLInputElement>("name").value.trim(),
    start: scheduleField<HTMLInputElement>("start").value,
    end: scheduleField<HTMLInputElement>("end").value,
    days: selectedScheduleDays(),
    deviceTargets: selectedScheduleDevices(),
    enabled: scheduleField<HTMLInputElement>("enabled").checked
  };
  try {
    if (kind === "grayscale") {
      await post("/api/grayscale/schedule", shared);
    } else {
      await post("/api/schedule", {
        ...shared,
        mode: scheduleField<HTMLSelectElement>("mode").value,
        profileId: $("#scheduleProfileId").value,
        lockLevel: scheduleField<HTMLInputElement>("id").dataset.lockLevel || "deep",
        commitmentLock: scheduleField<HTMLInputElement>("commitmentLock").checked,
        wifiNetworks: lines(scheduleField<HTMLTextAreaElement>("wifiNetworks").value)
      });
    }
    toast("Schedule saved");
    closeScheduleEditor();
    await refresh();
  } catch (error) {
    handleMutationError(error, { resumeSchedule: true });
  }
}

function validateScheduleForm(kind: ScheduleKind): string {
  if (!scheduleField<HTMLInputElement>("name").value.trim()) return "Give this schedule a name.";
  if (scheduleField<HTMLInputElement>("start").value === scheduleField<HTMLInputElement>("end").value) {
    return "Start and end times must be different.";
  }
  if (!selectedScheduleDays().length) return "Choose at least one day.";
  if (!selectedScheduleDevices().length) return "Choose at least one device.";
  if (kind === "lock" && !$("#scheduleProfileId").value) return "Choose a ruleset.";
  return "";
}

function renderSchedules(data: DashboardData): void {
  fillScheduleProfileOptions(data.state);
  const entries = allScheduleEntries(data);
  $("#scheduleCount").textContent = `${entries.length} schedule${entries.length === 1 ? "" : "s"}`;
  const list = $("#scheduleList");
  list.replaceChildren();
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No schedules yet. Choose a quick start above or create your own.";
    list.append(empty);
    return;
  }
  for (const entry of entries.sort(compareScheduleEntries)) list.append(scheduleRow(entry));
}

function allScheduleEntries(data: DashboardData): ScheduleEntry[] {
  const locks = data.state.schedules.map((schedule) => ({
    kind: "lock" as const,
    id: schedule.id,
    name: schedule.name,
    enabled: Boolean(schedule.enabled),
    days: schedule.days || [],
    start: schedule.start,
    end: schedule.end,
    deviceTargets: schedule.deviceTargets || ["computer", "phone"],
    lock: schedule
  }));
  const grayscale = (data.state.grayscale?.schedules || []).map((schedule) => ({
    kind: "grayscale" as const,
    id: schedule.id,
    name: schedule.name,
    enabled: Boolean(schedule.enabled),
    days: schedule.days || [],
    start: schedule.start,
    end: schedule.end,
    deviceTargets: schedule.deviceTargets || ["computer", "phone"],
    grayscale: schedule
  }));
  return [...locks, ...grayscale];
}

function compareScheduleEntries(left: ScheduleEntry, right: ScheduleEntry): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  return left.start.localeCompare(right.start) || left.name.localeCompare(right.name);
}

function scheduleRow(entry: ScheduleEntry): HTMLElement {
  const row = document.createElement("article");
  row.className = "schedule-item";

  const time = document.createElement("div");
  time.className = "schedule-time";
  const start = document.createElement("strong");
  start.textContent = clockLabel(entry.start);
  const end = document.createElement("small");
  end.textContent = `to ${clockLabel(entry.end)}`;
  time.append(start, end);

  const copy = document.createElement("div");
  copy.className = "schedule-copy";
  const titleRow = document.createElement("div");
  const dot = document.createElement("span");
  dot.className = `schedule-enabled-dot${entry.enabled ? " on" : ""}`;
  const title = document.createElement("strong");
  title.textContent = entry.name;
  const type = document.createElement("span");
  type.className = "schedule-type";
  type.textContent = entry.kind === "grayscale" ? "Color" : scheduleModeLabel(entry.lock?.mode || "focus");
  titleRow.append(dot, title, type);
  const detail = document.createElement("small");
  const profile = entry.lock ? profileName(entry.lock.profileId) : "Grayscale";
  detail.textContent = `${daysText(entry.days)} · ${profile} · ${deviceTargetsLabel(entry.deviceTargets)}${entry.lock?.commitmentLock ? " · commitment" : ""}`;
  copy.append(titleRow, detail);

  const actions = document.createElement("div");
  actions.className = "schedule-actions";
  const toggle = scheduleActionButton(entry.enabled ? "Turn off" : "Turn on", "toggle", () => void toggleSchedule(entry));
  const edit = scheduleActionButton("Edit", "edit", () => editSchedule(entry));
  const remove = scheduleActionButton("Delete", "delete", () => void deleteSchedule(entry));
  actions.append(toggle, edit, remove);
  row.append(time, copy, actions);
  return row;
}

function scheduleActionButton(label: string, action: string, listener: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.action = action;
  button.textContent = label;
  button.addEventListener("click", listener);
  return button;
}

function editSchedule(entry: ScheduleEntry): void {
  openNewSchedule(entry.kind);
  scheduleField<HTMLInputElement>("id").value = entry.id;
  scheduleField<HTMLInputElement>("name").value = entry.name;
  scheduleField<HTMLInputElement>("start").value = entry.start;
  scheduleField<HTMLInputElement>("end").value = entry.end;
  scheduleField<HTMLInputElement>("enabled").checked = entry.enabled;
  setScheduleDays(entry.days);
  setScheduleDevices(entry.deviceTargets);
  if (entry.lock) {
    scheduleField<HTMLSelectElement>("mode").value = entry.lock.mode;
    $("#scheduleProfileId").value = entry.lock.profileId;
    scheduleField<HTMLInputElement>("commitmentLock").checked = Boolean(entry.lock.commitmentLock);
    scheduleField<HTMLTextAreaElement>("wifiNetworks").value = (entry.lock.wifiNetworks || []).join("\n");
    scheduleField<HTMLInputElement>("id").dataset.lockLevel = entry.lock.lockLevel || "deep";
  }
  $("#scheduleEditorTitle").textContent = `Edit ${entry.name}`;
}

async function toggleSchedule(entry: ScheduleEntry): Promise<void> {
  try {
    if (entry.lock) await post("/api/schedule", lockSchedulePayload(entry.lock, !entry.enabled));
    if (entry.grayscale) await post("/api/grayscale/schedule", grayscaleSchedulePayload(entry.grayscale, !entry.enabled));
    toast(entry.enabled ? "Schedule turned off" : "Schedule turned on");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function deleteSchedule(entry: ScheduleEntry): Promise<void> {
  if (!window.confirm(`Delete “${entry.name}”?`)) return;
  try {
    const path = entry.kind === "grayscale" ? "/api/grayscale/schedule/" : "/api/schedule/";
    await del(`${path}${encodeURIComponent(entry.id)}`);
    toast("Schedule deleted");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function lockSchedulePayload(schedule: Schedule, enabled: boolean): UnknownRecord {
  return {
    id: schedule.id,
    name: schedule.name,
    enabled,
    mode: schedule.mode,
    profileId: schedule.profileId,
    lockLevel: schedule.lockLevel,
    commitmentLock: Boolean(schedule.commitmentLock),
    deviceTargets: schedule.deviceTargets || ["computer", "phone"],
    days: schedule.days,
    start: schedule.start,
    end: schedule.end,
    wifiNetworks: schedule.wifiNetworks || []
  };
}

function grayscaleSchedulePayload(schedule: GrayscaleSchedule, enabled: boolean): UnknownRecord {
  return {
    id: schedule.id,
    name: schedule.name,
    enabled,
    deviceTargets: schedule.deviceTargets || ["computer", "phone"],
    days: schedule.days,
    start: schedule.start,
    end: schedule.end
  };
}

function fillScheduleProfileOptions(appState: DashboardState | null | undefined): void {
  if (!appState) return;
  const select = $("#scheduleProfileId") as unknown as HTMLSelectElement;
  const current = select.value;
  const signature = appState.profiles.map((profile) => `${profile.id}:${profile.name}`).join("|");
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...appState.profiles.map(profileOption));
    select.dataset.signature = signature;
  }
  const fallback = baselineProfileId(appState);
  select.value = appState.profiles.some((profile) => profile.id === current) ? current : fallback;
}

function profileOption(profile: Profile): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = profile.id;
  option.textContent = profile.name;
  return option;
}

function baselineProfileId(appState: DashboardState | null | undefined): string {
  if (!appState) return "";
  const configured = appState.settings.baselineProfileId || appState.settings.activeProfileId;
  return appState.profiles.some((profile) => profile.id === configured) ? configured : appState.profiles[0]?.id || "";
}

function profileName(profileId: string): string {
  return ui.data?.state.profiles.find((profile) => profile.id === profileId)?.name || "Missing ruleset";
}

function scheduleModeLabel(mode: string): string {
  if (mode === "brick") return "Full lock";
  if (mode === "sleep") return "Sleep";
  if (mode === "rehab") return "Recovery";
  return "Focus";
}

function deviceTargetsLabel(targets: readonly string[]): string {
  const selected = new Set(targets);
  if (selected.has("computer") && selected.has("phone")) return "Mac + iPhone";
  return selected.has("phone") ? "iPhone" : "Mac";
}

function clockLabel(value: string): string {
  const [hourText, minuteText] = value.split(":");
  const date = new Date();
  date.setHours(Number(hourText), Number(minuteText), 0, 0);
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function bindProfileActions(): void {
  const form = $("#profileForm") as unknown as HTMLFormElement;
  form.addEventListener("input", () => { profileFormDirty = true; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveProfile();
  });
  $("#profileSelect").addEventListener("change", () => void selectBaselineProfile());
  $("#newProfile").addEventListener("click", openNewProfile);
  $("#editProfile").addEventListener("click", openSelectedProfile);
  $("#cancelProfileEdit").addEventListener("click", closeProfileEditor);
  $("#deleteProfile").addEventListener("click", () => void deleteSelectedProfile());
}

function renderProfiles(appState: DashboardState): void {
  const select = $("#profileSelect") as unknown as HTMLSelectElement;
  const signature = appState.profiles.map((profile) => `${profile.id}:${profile.name}`).join("|");
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...appState.profiles.map(profileOption));
    select.dataset.signature = signature;
  }
  const baseline = baselineProfileId(appState);
  if (!ui.selectedProfileId || !appState.profiles.some((profile) => profile.id === ui.selectedProfileId)) {
    ui.selectedProfileId = baseline;
  }
  if (document.activeElement !== select) select.value = baseline;
  const profile = appState.profiles.find((item) => item.id === ui.selectedProfileId) || appState.profiles.find((item) => item.id === baseline);
  if (!profile) return;
  ui.selectedProfileId = profile.id;
  const custom = !BUILT_IN_PROFILE_IDS.has(profile.id);
  $("#editProfile").disabled = !custom;
  $("#editProfile").textContent = custom ? "Edit custom profile" : "Built-in profile";
  $("#rulesConfigStatus").textContent = profile.name;
  $("#managedBlocklistSummary").textContent = custom
    ? `${profile.name} blocks ${(profile.blockedApps || []).length} app targets and ${(profile.blockedSites || []).length} site targets. Managed unsafe-content rules remain layered on top.`
    : `${profile.name} is a protected built-in ruleset. Its effective rules and permanent managed protections are not exposed as a partial editable list.`;
  const form = $("#profileForm") as unknown as HTMLFormElement;
  if (!form.hidden && !profileFormDirty && formInput(form, "id").value === profile.id) fillProfileForm(profile);
}

async function selectBaselineProfile(): Promise<void> {
  const id = $("#profileSelect").value;
  try {
    await post("/api/settings", { baselineProfileId: id });
    ui.selectedProfileId = id;
    closeProfileEditor();
    toast("Baseline ruleset changed");
    await refresh();
  } catch (error) {
    handleMutationError(error);
    await refresh();
  }
}

function openNewProfile(): void {
  const form = $("#profileForm") as unknown as HTMLFormElement;
  form.hidden = false;
  form.reset();
  formInput(form, "id").value = "";
  formInput(form, "name").value = "Custom focus";
  formInput(form, "mode").value = "blocklist";
  $("#deleteProfile").hidden = true;
  profileFormDirty = false;
  formInput(form, "name").focus();
}

function openSelectedProfile(): void {
  const profile = selectedProfile();
  if (!profile || BUILT_IN_PROFILE_IDS.has(profile.id)) {
    toast("Built-in rules stay protected. Create a custom profile to edit targets.");
    return;
  }
  const form = $("#profileForm") as unknown as HTMLFormElement;
  form.hidden = false;
  fillProfileForm(profile);
  profileFormDirty = false;
  $("#deleteProfile").hidden = false;
  formInput(form, "name").focus();
}

function fillProfileForm(profile: Profile): void {
  const form = $("#profileForm") as unknown as HTMLFormElement;
  formInput(form, "id").value = profile.id;
  formInput(form, "name").value = profile.name;
  formInput(form, "mode").value = profile.mode;
  formInput(form, "blockedApps").value = (profile.blockedApps || []).join("\n");
  formInput(form, "blockedSites").value = (profile.blockedSites || []).join("\n");
  formInput(form, "blockedUrlPatterns").value = (profile.blockedUrlPatterns || []).join("\n");
  formInput(form, "allowedApps").value = (profile.allowedApps || []).join("\n");
  formInput(form, "allowedSites").value = (profile.allowedSites || []).join("\n");
}

function formInput(form: HTMLFormElement, name: string): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLElement)) throw new Error(`Missing profile field: ${name}`);
  return control as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
}

function closeProfileEditor(): void {
  $("#profileForm").hidden = true;
  profileFormDirty = false;
}

function selectedProfile(): Profile | null {
  return ui.data?.state.profiles.find((profile) => profile.id === ui.selectedProfileId) || null;
}

async function saveProfile(): Promise<void> {
  const form = $("#profileForm") as unknown as HTMLFormElement;
  const id = formInput(form, "id").value;
  try {
    const result = await post<ProfileSaveResponse>("/api/profile", {
      ...(id ? { id } : {}),
      name: formInput(form, "name").value.trim(),
      mode: formInput(form, "mode").value,
      blockedApps: lines(formInput(form, "blockedApps").value),
      blockedSites: lines(formInput(form, "blockedSites").value),
      blockedUrlPatterns: lines(formInput(form, "blockedUrlPatterns").value),
      allowedApps: lines(formInput(form, "allowedApps").value),
      allowedSites: lines(formInput(form, "allowedSites").value)
    });
    const savedId = result.profile?.id || id;
    if (savedId) {
      await post("/api/settings", { baselineProfileId: savedId });
      ui.selectedProfileId = savedId;
    }
    profileFormDirty = false;
    closeProfileEditor();
    toast("Profile saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function deleteSelectedProfile(): Promise<void> {
  const profile = selectedProfile();
  if (!profile || BUILT_IN_PROFILE_IDS.has(profile.id)) return;
  if (!window.confirm(`Delete “${profile.name}”?`)) return;
  try {
    await del(`/api/profile/${encodeURIComponent(profile.id)}`);
    ui.selectedProfileId = null;
    closeProfileEditor();
    toast("Profile deleted");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function bindLimitActions(): void {
  const limitForm = $("#limitForm") as unknown as HTMLFormElement;
  const appLockForm = $("#appLockForm") as unknown as HTMLFormElement;
  $("#newLimit").addEventListener("click", openNewLimit);
  $("#cancelLimitEdit").addEventListener("click", () => { limitForm.hidden = true; });
  $("#newAppLock").addEventListener("click", openNewAppLock);
  $("#cancelAppLockEdit").addEventListener("click", () => { appLockForm.hidden = true; });
  ruleField<HTMLSelectElement>(limitForm, "type").addEventListener("change", syncLimitTypeFields);
  limitForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveLimit();
  });
  appLockForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveAppLock();
  });
}

function ruleField<T extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(form: HTMLFormElement, name: string): T {
  const control = form.elements.namedItem(name);
  if (!(control instanceof HTMLElement)) throw new Error(`Missing rule field: ${name}`);
  return control as T;
}

function selectedRuleDays(rootSelector: string): number[] {
  return [...$$<HTMLInputElement>(`${rootSelector} input:checked`)].map((input) => Number(input.value));
}

function setRuleDays(rootSelector: string, days: readonly number[]): void {
  const selected = new Set(days);
  for (const input of $$<HTMLInputElement>(`${rootSelector} input`)) input.checked = selected.has(Number(input.value));
}

function openNewLimit(): void {
  const form = $("#limitForm") as unknown as HTMLFormElement;
  form.hidden = false;
  form.reset();
  ruleField<HTMLInputElement>(form, "id").value = "";
  ruleField<HTMLInputElement>(form, "name").value = "Daily boundary";
  ruleField<HTMLSelectElement>(form, "type").value = "time";
  ruleField<HTMLInputElement>(form, "limitMinutes").value = "20";
  ruleField<HTMLInputElement>(form, "unlocksAllowed").value = "5";
  ruleField<HTMLInputElement>(form, "blockMinutes").value = "20";
  ruleField<HTMLSelectElement>(form, "lockLevel").value = "deep";
  ruleField<HTMLInputElement>(form, "enabled").checked = true;
  setRuleDays("#limitDays", [0, 1, 2, 3, 4, 5, 6]);
  syncLimitTypeFields();
  ruleField<HTMLInputElement>(form, "name").focus();
}

function editLimit(rule: DashboardItem): void {
  openNewLimit();
  const form = $("#limitForm") as unknown as HTMLFormElement;
  ruleField<HTMLInputElement>(form, "id").value = rule.id;
  ruleField<HTMLInputElement>(form, "name").value = rule.name;
  ruleField<HTMLSelectElement>(form, "type").value = rule.type || "time";
  ruleField<HTMLInputElement>(form, "limitMinutes").value = String(rule.limitMinutes || 20);
  ruleField<HTMLInputElement>(form, "unlocksAllowed").value = String(rule.unlocksAllowed ?? 5);
  ruleField<HTMLInputElement>(form, "blockMinutes").value = String(rule.blockMinutes ?? 20);
  ruleField<HTMLSelectElement>(form, "lockLevel").value = rule.lockLevel || "deep";
  ruleField<HTMLTextAreaElement>(form, "apps").value = (rule.apps || []).join("\n");
  ruleField<HTMLTextAreaElement>(form, "sites").value = (rule.sites || []).join("\n");
  ruleField<HTMLInputElement>(form, "enabled").checked = Boolean(rule.enabled);
  setRuleDays("#limitDays", rule.days || []);
  syncLimitTypeFields();
}

function syncLimitTypeFields(): void {
  const form = $("#limitForm") as unknown as HTMLFormElement;
  const type = ruleField<HTMLSelectElement>(form, "type").value;
  for (const field of $$<HTMLElement>("#limitForm [data-limit-field]")) field.hidden = field.dataset.limitField !== type;
}

async function saveLimit(): Promise<void> {
  const form = $("#limitForm") as unknown as HTMLFormElement;
  const days = selectedRuleDays("#limitDays");
  if (!days.length) {
    toast("Choose at least one day for this limit.");
    return;
  }
  try {
    await post("/api/limit", {
      id: ruleField<HTMLInputElement>(form, "id").value,
      name: ruleField<HTMLInputElement>(form, "name").value.trim(),
      type: ruleField<HTMLSelectElement>(form, "type").value,
      lockLevel: ruleField<HTMLSelectElement>(form, "lockLevel").value,
      limitMinutes: Number(ruleField<HTMLInputElement>(form, "limitMinutes").value),
      unlocksAllowed: Number(ruleField<HTMLInputElement>(form, "unlocksAllowed").value),
      blockMinutes: Number(ruleField<HTMLInputElement>(form, "blockMinutes").value),
      apps: lines(ruleField<HTMLTextAreaElement>(form, "apps").value),
      sites: lines(ruleField<HTMLTextAreaElement>(form, "sites").value),
      enabled: ruleField<HTMLInputElement>(form, "enabled").checked,
      days
    });
    form.hidden = true;
    toast("Limit saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function deleteLimit(rule: DashboardItem): Promise<void> {
  if (!window.confirm(`Delete “${rule.name}”?`)) return;
  try {
    await del(`/api/limit/${encodeURIComponent(rule.id)}`);
    toast("Limit deleted");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderLimits(rules: DashboardItem[]): void {
  const list = $("#limitList");
  list.replaceChildren();
  if (!rules.length) {
    list.append(ruleEmptyState("No daily limits configured."));
  } else {
    for (const rule of rules) {
      const used = rule.type === "open" ? Number(rule.progress?.opens || 0) : Number(rule.progress?.seconds || 0);
      const cap = rule.type === "open" ? Number(rule.unlocksAllowed || 0) : Number(rule.limitMinutes || 0) * 60;
      const progress = rule.type === "open" ? `${used}/${cap} opens` : `${formatDuration(used)} of ${rule.limitMinutes || 0}m`;
      const detail = `${progress} · ${daysText(rule.days || [])} · ${rule.enabled ? "on" : "off"}${rule.activeBlock ? " · locked now" : ""}`;
      list.append(ruleRow(rule.name, detail, [
        ruleAction("Edit", () => editLimit(rule)),
        ruleAction("Delete", () => void deleteLimit(rule), true)
      ]));
    }
  }
  renderLimitsConfigurationStatus(rules, ui.data?.appLocks.rules || []);
}

function openNewAppLock(): void {
  const form = $("#appLockForm") as unknown as HTMLFormElement;
  form.hidden = false;
  form.reset();
  ruleField<HTMLInputElement>(form, "id").value = "";
  ruleField<HTMLInputElement>(form, "name").value = "Locked socials";
  ruleField<HTMLSelectElement>(form, "lockLevel").value = "deep";
  ruleField<HTMLInputElement>(form, "unlocksAllowed").value = "2";
  ruleField<HTMLInputElement>(form, "unlockMinutes").value = "10";
  ruleField<HTMLInputElement>(form, "delaySeconds").value = "30";
  ruleField<HTMLInputElement>(form, "enabled").checked = false;
  setRuleDays("#appLockDays", [0, 1, 2, 3, 4, 5, 6]);
  ruleField<HTMLInputElement>(form, "name").focus();
}

function editAppLock(rule: DashboardItem): void {
  openNewAppLock();
  const form = $("#appLockForm") as unknown as HTMLFormElement;
  ruleField<HTMLInputElement>(form, "id").value = rule.id;
  ruleField<HTMLInputElement>(form, "name").value = rule.name;
  ruleField<HTMLSelectElement>(form, "lockLevel").value = rule.lockLevel || "deep";
  ruleField<HTMLInputElement>(form, "unlocksAllowed").value = String(rule.unlocksAllowed ?? 2);
  ruleField<HTMLInputElement>(form, "unlockMinutes").value = String(rule.unlockMinutes ?? 10);
  ruleField<HTMLInputElement>(form, "delaySeconds").value = String(rule.delaySeconds ?? 30);
  ruleField<HTMLTextAreaElement>(form, "apps").value = (rule.apps || []).join("\n");
  ruleField<HTMLTextAreaElement>(form, "sites").value = (rule.sites || []).join("\n");
  ruleField<HTMLInputElement>(form, "enabled").checked = Boolean(rule.enabled);
  setRuleDays("#appLockDays", rule.days || []);
}

async function saveAppLock(): Promise<void> {
  const form = $("#appLockForm") as unknown as HTMLFormElement;
  const days = selectedRuleDays("#appLockDays");
  if (!days.length) {
    toast("Choose at least one day for this app lock.");
    return;
  }
  try {
    await post("/api/app-lock", {
      id: ruleField<HTMLInputElement>(form, "id").value,
      name: ruleField<HTMLInputElement>(form, "name").value.trim(),
      lockLevel: ruleField<HTMLSelectElement>(form, "lockLevel").value,
      unlocksAllowed: Number(ruleField<HTMLInputElement>(form, "unlocksAllowed").value),
      unlockMinutes: Number(ruleField<HTMLInputElement>(form, "unlockMinutes").value),
      delaySeconds: Number(ruleField<HTMLInputElement>(form, "delaySeconds").value),
      apps: lines(ruleField<HTMLTextAreaElement>(form, "apps").value),
      sites: lines(ruleField<HTMLTextAreaElement>(form, "sites").value),
      enabled: ruleField<HTMLInputElement>(form, "enabled").checked,
      days
    });
    form.hidden = true;
    toast("App lock saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function deleteAppLock(rule: DashboardItem): Promise<void> {
  if (!window.confirm(`Delete “${rule.name}”?`)) return;
  try {
    await del(`/api/app-lock/${encodeURIComponent(rule.id)}`);
    if (rule.pendingRequest?.id === selectedAppLockRequestId) selectedAppLockRequestId = null;
    toast("App lock deleted");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderAppLocks(rules: DashboardItem[]): void {
  const list = $("#appLockList");
  list.replaceChildren();
  const pendingRules = rules.filter((rule) => Boolean(rule.pendingRequest?.id));
  const selectedRule = pendingRules.find((rule) => rule.pendingRequest?.id === selectedAppLockRequestId) || pendingRules[0] || null;
  const nextRequestId = selectedRule?.pendingRequest?.id ? String(selectedRule.pendingRequest.id) : null;
  const selectionChanged = nextRequestId !== selectedAppLockRequestId;
  selectedAppLockRequestId = nextRequestId;
  if (selectionChanged) $("#appLockChallengeInput").value = "";
  const selectedChallenge = selectedRule?.pendingRequest?.challenge as ChallengeSummary | null;
  renderTypingChallenge("#appLockChallenge", "#appLockChallengeInput", selectedChallenge);
  if (selectedChallenge?.text) $("#appLockChallenge").textContent = `${selectedRule?.name || "App lock"} — type: ${selectedChallenge.text}`;
  $("#appLockUnlockPanel").hidden = !rules.some((rule) => rule.enabled);
  $("#appLockUnlockTitle").textContent = selectedRule ? selectedRule.name : "Request a deliberate unlock from a lock below";

  if (!rules.length) {
    list.append(ruleEmptyState("No app locks configured."));
  } else {
    for (const rule of rules) {
      const detail = `${rule.usedToday || 0}/${rule.unlocksAllowed || 0} unlocks used · ${rule.unlockMinutes || 0}m each · ${daysText(rule.days || [])} · ${rule.enabled ? "on" : "off"}`;
      const edit = ruleAction("Edit", () => editAppLock(rule));
      const unlock = ruleAction("Unlock", () => {});
      configureAppLockUnlockButton(unlock, rule, {
        selected: rule.pendingRequest?.id === selectedAppLockRequestId,
        select: () => {
          selectedAppLockRequestId = rule.pendingRequest?.id ? String(rule.pendingRequest.id) : null;
          $("#appLockChallengeInput").value = "";
          renderAppLocks(rules);
          if (rule.pendingRequest?.challenge?.text) $("#appLockChallengeInput").focus();
        }
      });
      list.append(ruleRow(rule.name, detail, [
        edit,
        unlock,
        ruleAction("Delete", () => void deleteAppLock(rule), true)
      ]));
    }
  }
  renderLimitsConfigurationStatus(ui.data?.limits.rules || [], rules);
}

function configureAppLockUnlockButton(
  button: HTMLButtonElement,
  rule: DashboardItem,
  confirmation: { selected: boolean; select(): void }
): void {
  if (!rule.enabled) {
    button.textContent = "Off";
    button.disabled = true;
    return;
  }
  if (rule.activeUnlock) {
    button.textContent = "Unlocked";
    button.disabled = true;
    return;
  }
  if ((rule.remainingToday || 0) <= 0) {
    button.textContent = "No unlocks";
    button.disabled = true;
    return;
  }
  const pendingRequest = rule.pendingRequest;
  if (pendingRequest) {
    const milliseconds = new Date(pendingRequest.eligibleAt || "").getTime() - Date.now();
    if (!confirmation.selected) {
      button.textContent = milliseconds > 0 ? `Review · ${Math.ceil(milliseconds / 1_000)}s` : "Review";
      button.addEventListener("click", confirmation.select);
      return;
    }
    if (milliseconds > 0) {
      button.textContent = `${Math.ceil(milliseconds / 1_000)}s`;
      button.disabled = true;
      return;
    }
    button.textContent = "Confirm";
    button.addEventListener("click", () => void confirmAppLockUnlock(rule, pendingRequest));
    return;
  }
  button.textContent = "Unlock";
  button.addEventListener("click", () => void requestAppLockUnlock(rule));
}

async function requestAppLockUnlock(rule: DashboardItem): Promise<void> {
  try {
    const response = await post<{ request?: { id?: string } }>("/api/app-lock/unlock/request", {
      lockId: rule.id,
      reason: $("#appLockReason").value.trim()
    });
    selectedAppLockRequestId = response.request?.id || null;
    toast("Unlock cooldown started");
    await refresh();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function confirmAppLockUnlock(rule: DashboardItem, pendingRequest: DashboardItem): Promise<void> {
  try {
    await post("/api/app-lock/unlock/confirm", {
      requestId: pendingRequest.id,
      passcode: $("#appLockPasscode").value,
      distanceKey: $("#appLockDistanceKey").value,
      challengeText: $("#appLockChallengeInput").value
    });
    selectedAppLockRequestId = null;
    clearInputs(["appLockReason", "appLockPasscode", "appLockDistanceKey", "appLockChallengeInput"]);
    toast(`${rule.name} unlocked`);
    await refresh();
  } catch (error) {
    toast(errorMessage(error));
  }
}

function ruleRow(name: string, detailText: string, actions: HTMLButtonElement[]): HTMLElement {
  const row = document.createElement("article");
  row.className = "rule-item";
  const copy = document.createElement("div");
  copy.className = "rule-item-copy";
  const titleLine = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = name;
  titleLine.append(title);
  const detail = document.createElement("small");
  detail.textContent = detailText;
  copy.append(titleLine, detail);
  const actionGroup = document.createElement("div");
  actionGroup.className = "rule-item-actions";
  actionGroup.append(...actions);
  row.append(copy, actionGroup);
  return row;
}

function ruleAction(label: string, listener: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.classList.toggle("danger-text", danger);
  button.addEventListener("click", listener);
  return button;
}

function ruleEmptyState(message: string): HTMLElement {
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = message;
  return empty;
}

function renderLimitsConfigurationStatus(limits: DashboardItem[], appLocks: DashboardItem[]): void {
  const active = [...limits, ...appLocks].filter((rule) => rule.enabled).length;
  const total = limits.length + appLocks.length;
  $("#limitsConfigStatus").textContent = total ? `${active}/${total} on` : "No rules";
  $("#limitsConfigStatus").className = `config-status${active ? " good" : ""}`;
}

function bindSettingActions(): void {
  for (const input of $$<HTMLInputElement>("[data-setting]")) {
    input.addEventListener("change", () => void saveBooleanSetting(input));
  }
  $("#enforcementTimingForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveSettings({
      appQuitEscalationSeconds: Number($("#appQuitEscalationSeconds").value),
      processSweepIntervalSeconds: Number($("#processSweepIntervalSeconds").value),
      systemSleepLockIntervalSeconds: Number($("#systemSleepLockIntervalSeconds").value)
    }, "Enforcement timing saved");
  });
  $("#accessTimingForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveSettings({
      intentReasonMinLength: Number($("#intentReasonMinLength").value),
      panicLockDurationMinutes: Number($("#panicLockDurationMinutes").value)
    }, "Unlock safeguards saved");
  });
  $("#focusShortcutForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveSettings({
      focusShortcutEnabled: $("#focusShortcutEnabled").checked,
      focusShortcutOnName: $("#focusShortcutOnName").value,
      focusShortcutOffName: $("#focusShortcutOffName").value
    }, "Focus shortcuts saved");
  });
  for (const id of ["grayscaleSoftBlockEnabled", "grayscalePreventManualChanges"]) {
    $(`#${id}`).addEventListener("change", () => void saveGrayscaleSettings());
  }
  $("#keyholderForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveKeyholder();
  });
}

async function saveBooleanSetting(input: HTMLInputElement): Promise<void> {
  const key = input.dataset.setting;
  if (!key) return;
  input.disabled = true;
  try {
    await post("/api/settings", { [key]: input.checked });
    toast("Setting saved");
  } catch (error) {
    handleMutationError(error);
  } finally {
    input.disabled = false;
    await refresh();
  }
}

async function saveSettings(body: UnknownRecord, success: string): Promise<void> {
  try {
    await post("/api/settings", body);
    toast(success);
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function saveGrayscaleSettings(): Promise<void> {
  try {
    await post("/api/grayscale/settings", {
      softBlockEnabled: $("#grayscaleSoftBlockEnabled").checked,
      preventManualChanges: $("#grayscalePreventManualChanges").checked
    });
    toast("Screen color settings saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function saveKeyholder(): Promise<void> {
  try {
    await post("/api/keyholder", {
      enabled: $("#keyholderEnabled").checked,
      passcode: $("#keyholderPasscode").value
    });
    $("#keyholderPasscode").value = "";
    toast("Keyholder saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderSettings(data: DashboardData): void {
  const settings = data.state.settings as unknown as UnknownRecord;
  for (const input of $$<HTMLInputElement>("[data-setting]")) {
    if (document.activeElement !== input) input.checked = settings[input.dataset.setting || ""] !== false;
  }
  setInputValue("#appQuitEscalationSeconds", settings.appQuitEscalationSeconds);
  setInputValue("#processSweepIntervalSeconds", settings.processSweepIntervalSeconds);
  setInputValue("#systemSleepLockIntervalSeconds", settings.systemSleepLockIntervalSeconds);
  setInputValue("#intentReasonMinLength", settings.intentReasonMinLength);
  setInputValue("#panicLockDurationMinutes", settings.panicLockDurationMinutes);
  setInputValue("#focusShortcutOnName", settings.focusShortcutOnName);
  setInputValue("#focusShortcutOffName", settings.focusShortcutOffName);
  $("#grayscaleSoftBlockEnabled").checked = Boolean(data.state.grayscale?.softBlockEnabled);
  $("#grayscalePreventManualChanges").checked = data.state.grayscale?.preventManualChanges !== false;
  const keyholder = data.state.keyholder as unknown as UnknownRecord;
  $("#keyholderEnabled").checked = Boolean(keyholder.enabled);
  $("#keyholderStatus").textContent = keyholder.hasPasscode ? "Passcode set" : "Not set";
  $("#keyholderStatus").className = `count-pill${keyholder.hasPasscode ? " good" : ""}`;
  const protectedCount = [
    settings.systemNetworkBlockingEnabled,
    settings.contentFilterEnabled,
    settings.safariUrlFilterEnabled,
    settings.appQuitEnabled,
    settings.processSweepEnabled,
    settings.systemSleepLockEnabled
  ].filter((value) => value !== false).length;
  $("#protectionConfigStatus").textContent = `${protectedCount}/6 on`;
  $("#protectionConfigStatus").className = `config-status ${protectedCount >= 5 ? "good" : "warn"}`;
  $("#accessConfigStatus").textContent = settings.protectedEditsEnabled === false ? "Review" : "Protected";
  $("#accessConfigStatus").className = `config-status ${settings.protectedEditsEnabled === false ? "warn" : "good"}`;
}

function setInputValue(selector: string, value: unknown): void {
  const input = $(selector);
  if (document.activeElement !== input) input.value = String(value ?? "");
}

function bindDeviceActions(): void {
  const form = $("#iosForm") as unknown as HTMLFormElement;
  form.addEventListener("change", () => { iosFormDirty = true; });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveIosSettings();
  });
  $("#iosDownloadProfile").addEventListener("click", () => {
    window.location.href = "/api/devices/ios/profile.mobileconfig";
  });
}

async function saveIosSettings(): Promise<void> {
  try {
    await post("/api/devices/ios/settings", {
      enabled: $("#iosEnabled").checked,
      blockWeb: $("#iosBlockWeb").checked,
      blockApps: $("#iosBlockApps").checked,
      hardenRemoval: $("#iosHardenRemoval").checked,
      restrictInstallAndErase: $("#iosRestrictInstallErase").checked,
      allowSafariHistoryClearing: $("#iosAllowSafariHistoryClearing").checked
    });
    iosFormDirty = false;
    toast("iPhone policy saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderDevice(data: DashboardData): void {
  const ios = data.devices.ios || {};
  if (!iosFormDirty) {
    $("#iosEnabled").checked = Boolean(ios.enabled);
    $("#iosBlockWeb").checked = ios.blockWeb !== false;
    $("#iosBlockApps").checked = ios.blockApps !== false;
    $("#iosHardenRemoval").checked = ios.removalHardened || ios.hardenRemoval !== false;
    $("#iosRestrictInstallErase").checked = ios.restrictInstallAndErase !== false;
    $("#iosAllowSafariHistoryClearing").checked = ios.allowSafariHistoryClearing !== false;
  }
  $("#iosStatusTitle").textContent = ios.enabled ? "Vigil content filter configured" : "Vigil content filter ready";
  $("#iosStatusText").textContent = ios.note || "A supervised iPhone is required for the managed restriction policy.";
  $("#iosStatus").textContent = ios.enabled ? "Configured" : "Ready";
  $("#iosStatus").className = `count-pill${ios.enabled ? " good" : ""}`;
  $("#deviceConfigStatus").textContent = ios.enabled ? "Configured" : "Ready";
  $("#deviceConfigStatus").className = `config-status${ios.enabled ? " good" : ""}`;
  const summary = $("#iosSummary");
  summary.replaceChildren(
    deviceSummaryItem("Browser filtering", ios.protection?.systemWideManagedWebFilter ? "Managed across browsers" : "Off"),
    deviceSummaryItem("Unsafe sites", ios.protection?.knownSitesBlocked ? `${Number(ios.protection.knownSiteDomainCount || 0).toLocaleString()} domains` : "Off"),
    deviceSummaryItem("Native apps", ios.protection?.appWorkaroundsClosed ? `${ios.protection.targetedAppBundleCount || 0} targeted` : "Off"),
    deviceSummaryItem("Profile removal", ios.removalHardened ? "Locked" : "Not locked"),
    deviceSummaryItem("Companions", `${ios.companionApps?.appCount || 0} configured`),
    deviceSummaryItem("Delivery", ios.manageEngine?.deliveryProvider === "manageengine" ? "ManageEngine" : "Local profile")
  );
}

function deviceSummaryItem(label: string, value: string): HTMLElement {
  const item = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = label;
  const detail = document.createElement("span");
  detail.textContent = value;
  item.append(title, detail);
  return item;
}

function bindMaintenanceActions(): void {
  $("#requestEmergency").addEventListener("click", () => void requestEmergencyUnlock());
  $("#confirmEmergency").addEventListener("click", () => void confirmEmergencyUnlock());
  $("#requestMaintenance").addEventListener("click", () => void requestMaintenance());
  $("#confirmMaintenance").addEventListener("click", () => void confirmMaintenance());
}

async function requestEmergencyUnlock(): Promise<void> {
  try {
    const response = await post<PendingResponse>("/api/emergency/request", { reason: $("#emergencyReason").value.trim() });
    ui.pendingEmergencyId = response.pending?.id || null;
    toast("Emergency cooldown started");
    await refresh();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function confirmEmergencyUnlock(): Promise<void> {
  if (!ui.pendingEmergencyId) return;
  try {
    await post("/api/emergency/confirm", {
      requestId: ui.pendingEmergencyId,
      passcode: $("#emergencyPasscode").value,
      distanceKey: $("#emergencyDistanceKey").value,
      challengeText: $("#emergencyChallengeInput").value
    });
    ui.pendingEmergencyId = null;
    clearInputs(["emergencyReason", "emergencyPasscode", "emergencyDistanceKey", "emergencyChallengeInput"]);
    toast("Emergency unlock used");
    await refresh();
  } catch (error) {
    toast(errorMessage(error));
  }
}

function renderEmergency(appState: DashboardState): void {
  const panel = $("#emergencyPanel");
  const policy = emergencyPolicy(appState);
  const activeLimitBlocks = (ui.data?.limits.activeBlocks || []).filter((block) => new Date(block.until).getTime() > Date.now());
  if ((!policy || policy.session.canEndEarly) && !activeLimitBlocks.length) {
    panel.hidden = true;
    panel.removeAttribute("open");
    ui.pendingEmergencyId = null;
    return;
  }
  panel.hidden = false;
  const unlockable = emergencyUnlockAllowed(policy);
  $("#emergencyControls").hidden = !unlockable;
  $("#emergencyExplanation").hidden = unlockable;
  if (!unlockable) {
    $("#emergencyTitle").textContent = policy?.kind === "integrity" ? "Integrity lockdown" : "Lock cannot end early";
    $("#emergencyCopy").textContent = policy?.kind === "panic" ? "Panic remains locked for its full duration" : "Authenticated maintenance is required";
    $("#emergencyExplanation").textContent = policy?.kind === "integrity"
      ? "This protected state can only be reviewed and cleared through authenticated maintenance."
      : "Commitment and Panic locks intentionally do not allow an ordinary emergency exit.";
    return;
  }
  $("#emergencyTitle").textContent = "Emergency unlock";
  const pending = appState.emergency.pending.find((item) => item.status === "pending");
  if (pending) ui.pendingEmergencyId = pending.id;
  renderTypingChallenge("#emergencyChallenge", "#emergencyChallengeInput", pending?.challenge as ChallengeSummary | null);
  if (!pending) {
    $("#emergencyCopy").textContent = `${appState.emergency.remaining || 0} unlocks remain this week`;
    $("#confirmEmergency").disabled = true;
    return;
  }
  const milliseconds = new Date(pending.eligibleAt || "").getTime() - Date.now();
  $("#emergencyCopy").textContent = milliseconds > 0 ? `Confirm available in ${Math.ceil(milliseconds / 1_000)} seconds` : "Cooldown complete";
  $("#confirmEmergency").disabled = milliseconds > 0;
}

function emergencyPolicy(appState: DashboardState): ActivePolicy | null {
  const policies = [
    appState.activePolicy || null,
    appState.devicePolicies?.computer || null,
    appState.devicePolicies?.phone || null
  ].filter((value): value is ActivePolicy => Boolean(value));
  return policies.find((policy) => !emergencyUnlockAllowed(policy))
    || policies.find((policy) => !policy.session.canEndEarly)
    || policies[0]
    || null;
}

function emergencyUnlockAllowed(policy: ActivePolicy | null | undefined): boolean {
  if (!policy) return true;
  if (policy.kind === "integrity" || policy.kind === "panic") return false;
  return policy.session.emergencyUnlocksAllowed !== false;
}

async function requestMaintenance(): Promise<void> {
  try {
    const response = await post<PendingResponse>("/api/protection/maintenance/request", { reason: $("#maintenanceReason").value.trim() });
    ui.pendingMaintenanceId = response.pending?.id || null;
    toast(response.activeWindow ? "Maintenance is already open" : "Maintenance cooldown started");
    await refresh();
  } catch (error) {
    toast(errorMessage(error));
  }
}

async function confirmMaintenance(): Promise<void> {
  if (!ui.pendingMaintenanceId) return;
  try {
    await post("/api/protection/maintenance/confirm", {
      requestId: ui.pendingMaintenanceId,
      passcode: $("#maintenancePasscode").value,
      distanceKey: $("#maintenanceDistanceKey").value,
      challengeText: $("#maintenanceChallengeInput").value
    });
    ui.pendingMaintenanceId = null;
    clearInputs(["maintenanceReason", "maintenancePasscode", "maintenanceDistanceKey", "maintenanceChallengeInput"]);
    toast("Maintenance window opened");
    await refresh();
    if (resumeScheduleAfterMaintenance) {
      resumeScheduleAfterMaintenance = false;
      setView("schedules");
      document.querySelector<HTMLDialogElement>("#scheduleEditor")?.showModal();
    }
  } catch (error) {
    toast(errorMessage(error));
  }
}

function renderMaintenance(data: DashboardData): void {
  const protection = data.protection || {};
  const activeWindow = protection.activeWindow;
  const active = activeWindow && new Date(activeWindow.until).getTime() > Date.now();
  const pending = (protection.pending || []).find((item) => item.status === "pending");
  if (pending?.id) ui.pendingMaintenanceId = pending.id;
  $("#maintenanceStatus").textContent = active ? "Open" : pending ? "Pending" : "Closed";
  $("#maintenanceStatus").className = `count-pill${active ? " good" : pending ? " warn" : ""}`;
  $("#maintenanceHelp").textContent = active
    ? `Maintenance is open for ${countdownText(String(activeWindow?.until || ""))}. Background enforcement remains online.`
    : pending
      ? maintenancePendingText(pending)
      : "No maintenance request is pending.";
  renderTypingChallenge("#maintenanceChallenge", "#maintenanceChallengeInput", pending?.challenge as ChallengeSummary | null);
  const eligible = pending ? new Date(pending.eligibleAt || "").getTime() <= Date.now() : false;
  $("#confirmMaintenance").disabled = !pending || !eligible;
}

function maintenancePendingText(pending: DashboardItem): string {
  const milliseconds = new Date(String(pending.eligibleAt || "")).getTime() - Date.now();
  return milliseconds > 0 ? `Confirm available in ${Math.ceil(milliseconds / 1_000)} seconds.` : "Cooldown complete. Confirm the maintenance window.";
}

function renderTypingChallenge(outputSelector: string, inputSelector: string, challenge: ChallengeSummary | null | undefined): void {
  const output = $(outputSelector);
  const input = $(inputSelector);
  const text = challenge?.text || "";
  output.hidden = !text;
  input.hidden = !text;
  output.textContent = text ? `Type: ${text}` : "";
  if (!text && document.activeElement !== input) input.value = "";
}

function clearInputs(ids: string[]): void {
  for (const id of ids) $(`#${id}`).value = "";
}

function bindHardeningActions(): void {
  $("#installLaunchAgent").addEventListener("click", () => void runHardeningAction("installLaunchAgent", "launchAgentInstall", "/api/hardening/launch-agent/install", "Repairing restart protection…", "Restart protection repaired"));
  $("#applyHostsBlock").addEventListener("click", () => void runHardeningAction("applyHostsBlock", "hostsApply", "/api/hardening/hosts/apply", "Applying network protection…", "Network protection applied"));
  $("#applySafariFilter").addEventListener("click", () => void runHardeningAction("applySafariFilter", "safariFilterApply", "/api/hardening/safari-filter/apply", "Opening Safari protection…", "Safari protection opened"));
  $("#exportDiagnosticSnapshot").addEventListener("click", () => {
    const link = document.createElement("a");
    link.href = "/api/diagnostic/export";
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
    $("#hardeningActionStatus").textContent = "Diagnostic snapshot download started";
    toast("Diagnostic snapshot download started");
  });
}

async function runHardeningAction(buttonId: string, actionId: string, fallbackPath: string, working: string, success: string): Promise<void> {
  const button = $(`#${buttonId}`);
  button.disabled = true;
  $("#hardeningActionStatus").textContent = working;
  try {
    const action = ui.data?.hardening.actions?.[actionId];
    await post(action?.path || fallbackPath, {});
    $("#hardeningActionStatus").textContent = success;
    toast(success);
  } catch (error) {
    $("#hardeningActionStatus").textContent = errorMessage(error);
    toast(errorMessage(error));
  } finally {
    button.disabled = false;
    await refresh();
  }
}

function renderHealth(data: DashboardData): void {
  const audit = data.hardening.audit || [];
  const required = audit.filter((item) => item.required !== false);
  const healthy = required.filter((item) => item.ok !== false).length;
  const degraded = Math.max(0, required.length - healthy);
  const allHealthy = degraded === 0 && required.length > 0;
  const summary = required.length ? `${healthy}/${required.length} healthy` : "Checking";
  $("#healthSummary").textContent = summary;
  $("#healthSummary").className = `count-pill ${allHealthy ? "good" : degraded ? "warn" : ""}`;
  $("#maintenanceConfigStatus").textContent = allHealthy ? "Healthy" : degraded ? `${degraded} to review` : "Checking";
  $("#maintenanceConfigStatus").className = `config-status ${allHealthy ? "good" : degraded ? "warn" : ""}`;
  const list = $("#hardeningAudit");
  list.replaceChildren();
  const visible = [...required].sort((left, right) => Number(left.ok) - Number(right.ok)).slice(0, 8);
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "field-note";
    empty.textContent = "Protection checks are loading…";
    list.append(empty);
  } else {
    for (const check of visible) list.append(healthRow(check));
  }

  const agent = data.hardening.launchAgent || {};
  $("#installLaunchAgent").textContent = agent.embedded ? "Restart protection embedded" : agent.running ? "Login protection running" : "Repair login protection";
  $("#installLaunchAgent").disabled = Boolean(agent.embedded || agent.running);
}

function healthRow(check: DashboardItem): HTMLElement {
  const row = document.createElement("div");
  row.className = `health-row${check.ok === false ? " bad" : ""}`;
  const mark = document.createElement("span");
  mark.textContent = check.ok === false ? "!" : "✓";
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = check.label || check.name || "Protection check";
  const detail = document.createElement("small");
  detail.textContent = check.detail || (check.ok === false ? "Needs review" : "Healthy");
  copy.append(title, detail);
  row.append(mark, copy);
  return row;
}

function bindIconThemeSettings(): void {
  const bridge = (window as VigilAppearanceWindow).vigilAppearance;
  if (!bridge) {
    $("#iconThemeStatus").textContent = "Available in the Vigil Mac app";
    for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) input.disabled = true;
    return;
  }
  void loadIconTheme(bridge);
  for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) {
    input.addEventListener("change", () => {
      if (input.checked) void saveIconTheme(bridge, input.value);
    });
  }
}

async function loadIconTheme(bridge: VigilAppearanceBridge): Promise<void> {
  try {
    const response = await bridge.getIconTheme() as UnknownRecord;
    if (response.ok === false || !response.theme) throw new Error(String(response.error || "Icon choice is unavailable."));
    selectIconTheme(String(response.theme));
    $("#iconThemeStatus").textContent = "Changes apply immediately";
  } catch (error) {
    $("#iconThemeStatus").textContent = errorMessage(error);
  }
}

async function saveIconTheme(bridge: VigilAppearanceBridge, theme: string): Promise<void> {
  $("#iconThemeStatus").textContent = "Applying icon…";
  try {
    const response = await bridge.setIconTheme(theme) as UnknownRecord;
    if (response.ok === false || !response.theme) throw new Error(String(response.error || "Icon choice was not saved."));
    selectIconTheme(String(response.theme));
    $("#iconThemeStatus").textContent = "Changes apply immediately";
    toast("App icon updated");
  } catch (error) {
    $("#iconThemeStatus").textContent = errorMessage(error);
  }
}

function selectIconTheme(theme: string): void {
  for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) input.checked = input.value === theme;
}

function handleMutationError(error: unknown, options: { resumeSchedule?: boolean } = {}): void {
  const message = errorMessage(error);
  const protectedEdit = /maintenance|protected|locked|cannot be changed|commitment/i.test(message);
  if (!protectedEdit) {
    toast(message);
    return;
  }
  if (options.resumeSchedule) {
    resumeScheduleAfterMaintenance = true;
    closeScheduleEditor();
  }
  openConfigurationPanel("maintenance");
  toast(`${message} Open a maintenance window to continue.`);
}

function toast(message: string): void {
  const node = $("#toast");
  node.textContent = message;
  node.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => { node.hidden = true; }, 3_000);
}
