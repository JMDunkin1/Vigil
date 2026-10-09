import { del, get, post } from "./api-client.js";
import { createAccountUi } from "./account-ui.js";
import { applyProtectionLevelPresentation, normalizedProtectionLevel } from "./protection-level.js";
import { createAppUpdatePanel } from "./app-update.js";
import { startDashboardRefresh } from "./dashboard-refresh.js";
import { formHasUnsavedChanges, formRevision, markFormSavedAtRevision, trackFormChanges } from "./form-state.js";
import { daysText, formatDuration, lines } from "./format.js";
import { nextSchedule, nextScheduleLabel, protectionStatus } from "./home-state.js";
import { $, $$, errorMessage, initTheme, setTheme, themePreference } from "./ui-shell.js";
import { bindWindowResizeHandles } from "./window-resize.js";
import type {
  ActivePolicy,
  ChallengeSummary,
  DashboardData,
  DashboardItem,
  DashboardState,
  Schedule,
  SessionStartResponse,
  UnknownRecord
} from "./app-model.js";

type Profile = DashboardState["profiles"][number];
type ScheduleKind = "lock";

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
}

interface PendingResponse extends UnknownRecord {
  pending?: { id?: string };
  activeWindow?: UnknownRecord;
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

const ACTIVE_STATE_POLL_MS = 3_000;

const ui = {
  data: null as DashboardData | null,
  activeView: "home",
  pendingEmergencyId: null as string | null,
  pendingMaintenanceId: null as string | null
};

let refreshCycle: Promise<void> | null = null;
let refreshRequested = false;
let protectionRequestInFlight = false;
let resumeScheduleAfterMaintenance = false;
let toastTimer: number | null = null;

const appUpdatePanel = createAppUpdatePanel({ $, get, post, toast, errorMessage });
const accountUi = createAccountUi();

boot();

function boot(): void {
  initTheme();
  $("#appearanceTheme").value = themePreference();
  $("#appearanceTheme").addEventListener("change", () => setTheme($("#appearanceTheme").value));
  if ("vigilWindowResize" in window) document.documentElement.classList.add("electron-shell");
  bindWindowResizeHandles();
  bindNavigation();
  bindConfigurationNavigation();
  bindProtectionActions();
  bindScheduleActions();
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
  startDashboardRefresh({
    document, timers: window, refresh, renderCountdowns, renderOnResume: render,
    onError: (error) => toast(errorMessage(error)), pollMs: ACTIVE_STATE_POLL_MS
  });
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
  if (document.hidden) return;
  const data = ui.data;
  if (!data) return;
  renderSchedules(data);
  renderSocialProtection(data);
  renderSettings(data);
  renderDevice(data);
  renderHealth(data);
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
  for (const choice of choices) {
    choice.addEventListener("click", () => {
      if (input.disabled) return;
      const requested = Number(choice.dataset.protectionLevelChoice || 1);
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
      toast(level === 1 ? "Focus applied" : "Brick applied");
    }
  } catch (error) {
    handleMutationError(error);
  } finally {
    await refresh();
    protectionRequestInFlight = false;
    setProtectionButtonsDisabled(activeProtectionLevel(ui.data?.state || {} as DashboardState) === 3);
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
    $("#protectionLevelLabel").textContent = level === 3 ? "Panic" : level === 1 ? "Focus" : "Brick";
  }
  input.disabled = protectionRequestInFlight || level === 3;
  input.setAttribute("aria-valuetext", level === 3 ? "Panic, locked for three minutes" : level === 1 ? "Focus" : "Brick");
  for (const button of $$<HTMLButtonElement>("[data-protection-level-choice]")) {
    const selected = Number(button.dataset.protectionLevelChoice) === level;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = protectionRequestInFlight || level === 3;
  }
  if (level === 3 && active) {
    const seconds = Math.max(0, Math.ceil((new Date(active.endsAt).getTime() - Date.now()) / 1_000));
    $("#protectionLevelStatus").textContent = `${formatDuration(seconds)} locked`;
  } else if (!userAdjusting) {
    $("#protectionLevelStatus").textContent = level === 1 ? "Focus" : "Brick";
  }

  const status = protectionStatus({
    policyKind: active?.kind,
    monitorOk: data.monitor.ok,
    monitorError: data.monitor.lastError,
    phaseKind: active?.phase?.kind || data.state.sessionPhase?.kind,
    maintenanceUntil: data.protection.activeWindow?.until
  });
  $("#protectionStateLabel").textContent = status.label;
  $("#vigilOrb").dataset.tone = status.tone;
  const upcoming = nextSchedule(allScheduleEntries(data));
  $("#nextScheduleLabel").textContent = upcoming ? nextScheduleLabel(upcoming.startsAt) : "None";
  $("#nextScheduleLabel").title = upcoming?.name || "No enabled schedules";

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
  if (document.hidden) return;
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
  scheduleField<HTMLInputElement>("name").value = "Social pause";
  scheduleField<HTMLSelectElement>("mode").value = "brick";
  scheduleField<HTMLInputElement>("start").value = "09:00";
  scheduleField<HTMLInputElement>("end").value = "17:00";
  scheduleField<HTMLInputElement>("enabled").checked = false;
  scheduleField<HTMLInputElement>("commitmentLock").checked = false;
  setScheduleDays([1, 2, 3, 4, 5]);
  setScheduleDevices(["computer", "phone"]);
  scheduleField<HTMLTextAreaElement>("wifiNetworks").value = "";
  fillScheduleProfileOptions(ui.data?.state, "");
  const baseline = "brick-mode";
  if (baseline) $("#scheduleProfileId").value = baseline;
  $("#scheduleEditorTitle").textContent = "New protection schedule";
  $("#scheduleValidation").hidden = true;
  syncScheduleKindFields();
  document.querySelector<HTMLDialogElement>("#scheduleEditor")?.showModal();
}

function openScheduleTemplate(template: string): void {
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
    await post("/api/schedule", {
        ...shared,
        mode: scheduleField<HTMLSelectElement>("mode").value,
        profileId: $("#scheduleProfileId").value,
        lockLevel: scheduleField<HTMLInputElement>("id").dataset.lockLevel || "deep",
        commitmentLock: scheduleField<HTMLInputElement>("commitmentLock").checked,
        wifiNetworks: lines(scheduleField<HTMLTextAreaElement>("wifiNetworks").value)
    });
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
    empty.textContent = "No schedules yet.";
    list.append(empty);
    return;
  }
  for (const entry of entries.sort(compareScheduleEntries)) list.append(scheduleRow(entry));
}

function allScheduleEntries(data: DashboardData): ScheduleEntry[] {
  return data.state.schedules.map((schedule) => ({
    kind: "lock", id: schedule.id, name: schedule.name, enabled: Boolean(schedule.enabled),
    days: schedule.days || [], start: schedule.start, end: schedule.end,
    deviceTargets: schedule.deviceTargets || ["computer", "phone"], lock: schedule
  }));
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
  type.textContent = scheduleModeLabel(entry.lock?.mode || "focus");
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
    fillScheduleProfileOptions(ui.data?.state, entry.lock.profileId);
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
    toast(entry.enabled ? "Schedule turned off" : "Schedule turned on");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function deleteSchedule(entry: ScheduleEntry): Promise<void> {
  if (!window.confirm(`Delete “${entry.name}”?`)) return;
  try {
    const path = "/api/schedule/";
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

function fillScheduleProfileOptions(appState: DashboardState | null | undefined, retainedProfileId?: string): void {
  if (!appState) return;
  const select = $("#scheduleProfileId") as unknown as HTMLSelectElement;
  if (retainedProfileId !== undefined) select.dataset.retainedProfileId = retainedProfileId;
  const current = select.value;
  const profiles = appState.profiles.filter(profile => ["normal", "brick-mode"].includes(profile.id)
    || profile.id === select.dataset.retainedProfileId);
  const signature = profiles.map((profile) => `${profile.id}:${profile.name}`).join("|");
  if (select.dataset.signature !== signature) {
    select.replaceChildren(...profiles.map(profileOption));
    select.dataset.signature = signature;
  }
  const baseline = baselineProfileId(appState);
  const fallback = profiles.some((profile) => profile.id === baseline) ? baseline : profiles[0]?.id || "";
  select.value = profiles.some((profile) => profile.id === current) ? current : fallback;
}

function profileOption(profile: Profile): HTMLOptionElement {
  const option = document.createElement("option");
  option.value = profile.id;
  option.textContent = profile.id === "brick-mode" ? "Brick" : profile.name;
  return option;
}

function baselineProfileId(appState: DashboardState | null | undefined): string {
  if (!appState) return "";
  const configured = appState.settings.baselineProfileId || appState.settings.activeProfileId;
  return appState.profiles.some((profile) => profile.id === configured) ? configured : appState.profiles[0]?.id || "";
}

function profileName(profileId: string): string {
  return profileId === "brick-mode" ? "Brick" : ui.data?.state.profiles.find((profile) => profile.id === profileId)?.name || "Missing ruleset";
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

function renderSocialProtection(data: DashboardData): void {
  $("#rulesConfigStatus").textContent = "Always on";
  const list = $("#permanentLockList");
  list.replaceChildren();
  const locks = data.appLocks.rules.filter(rule => rule.enabled && Number(rule.unlocksAllowed) === 0);
  for (const lock of locks) list.append(deviceSummaryItem(String(lock.name || "Permanent block"), "Locked"));
  if (!locks.length) list.textContent = "Permanent content and short-form restrictions are active.";
}

function bindSettingActions(): void {
  for (const id of ["sketchySiteForm", "accessTimingForm", "keyholderForm"]) {
    trackFormChanges($("#" + id) as unknown as HTMLFormElement);
  }
  $("#sketchySiteForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveSettings({ sketchySiteMaxAgeDays: Number($("#sketchySiteMaxAgeDays").value) }, "Registration age limit saved", "#sketchySiteForm");
  });
  $("#accessTimingForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveSettings({ panicLockDurationMinutes: Number($("#panicLockDurationMinutes").value) }, "Panic duration saved", "#accessTimingForm");
  });
  $("#keyholderForm").addEventListener("submit", (event: Event) => {
    event.preventDefault();
    void saveKeyholder();
  });
}

async function saveSettings(body: UnknownRecord, success: string, formSelector: string): Promise<void> {
  const form = $(formSelector) as unknown as HTMLFormElement;
  const submittedRevision = formRevision(form);
  try {
    await post("/api/settings", body);
    markFormSavedAtRevision(form, submittedRevision);
    toast(success);
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

async function saveKeyholder(): Promise<void> {
  const form = $("#keyholderForm") as unknown as HTMLFormElement;
  const submittedRevision = formRevision(form);
  try {
    await post("/api/keyholder", {
      enabled: $("#keyholderEnabled").checked,
      passcode: $("#keyholderPasscode").value
    });
    if (markFormSavedAtRevision(form, submittedRevision)) $("#keyholderPasscode").value = "";
    toast("Keyholder saved");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderSettings(data: DashboardData): void {
  const settings = data.state.settings;
  setInputValue("#sketchySiteMaxAgeDays", settings.sketchySiteMaxAgeDays);
  setInputValue("#panicLockDurationMinutes", settings.panicLockDurationMinutes);
  const sketchySites = data.state.sketchySites || [];
  $("#sketchySiteStatus").textContent = `${sketchySites.length} domains observed; ${sketchySites.filter(entry => entry.lookupStatus !== "verified").length} without a verified registration age.`;
  const keyholder = data.state.keyholder as unknown as UnknownRecord;
  if (!formHasUnsavedChanges($("#keyholderForm") as unknown as HTMLFormElement)) $("#keyholderEnabled").checked = Boolean(keyholder.enabled);
  $("#keyholderStatus").textContent = keyholder.hasPasscode ? "Passcode set" : "Optional";
  $("#keyholderStatus").className = `count-pill${keyholder.hasPasscode ? " good" : ""}`;
  $("#accessConfigStatus").textContent = "Protected";
  $("#accessConfigStatus").className = "config-status good";
  const required = (data.hardening.audit || []).filter(check => ["runtime-watchdog", "protected-edits", "adult-blocklist", "content-filter", "app-quit", "process-sweep", "launch-agent"].includes(String(check.id)));
  const healthy = required.length > 0 && required.every(check => check.ok === true);
  $("#protectionConfigStatus").textContent = healthy ? "Active" : "Review health";
  $("#protectionConfigStatus").className = `config-status ${healthy ? "good" : "warn"}`;
}

function setInputValue(selector: string, value: unknown): void {
  const input = $(selector);
  const form = input.closest("form");
  if (form && formHasUnsavedChanges(form)) return;
  if (document.activeElement !== input) input.value = String(value ?? "");
}

function bindDeviceActions(): void {
  const form = $("#iosForm") as unknown as HTMLFormElement;
  trackFormChanges(form);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveIosSettings();
  });
}

async function saveIosSettings(): Promise<void> {
  const form = $("#iosForm") as unknown as HTMLFormElement;
  const revision = formRevision(form);
  try {
    await post("/api/devices/ios/settings", {
      restrictInstallAndErase: $("#iosRestrictInstallErase").checked,
      allowSafariHistoryClearing: $("#iosAllowSafariHistoryClearing").checked
    });
    markFormSavedAtRevision(form, revision);
    toast("Desired policy saved; a verified phone update is required");
    await refresh();
  } catch (error) {
    handleMutationError(error);
  }
}

function renderDevice(data: DashboardData): void {
  const ios = data.devices.ios || {};
  if (!formHasUnsavedChanges($("#iosForm") as unknown as HTMLFormElement)) {
    $("#iosRestrictInstallErase").checked = ios.restrictInstallAndErase !== false;
    $("#iosAllowSafariHistoryClearing").checked = ios.allowSafariHistoryClearing !== false;
  }
  $("#iosStatusTitle").textContent = "iPhone content filter";
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
  const optional = new Set(["foolproof", "keyholder", "distance-key", "notification-focus", "sleep-screen-lock", "external-network-block", "mac-account"]);
  const required = audit.filter((item) => item.required !== false && !optional.has(String(item.id)));
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
