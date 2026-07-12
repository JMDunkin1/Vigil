import { clearJournalSession, del, get, journalSessionActive, post, storeJournalSession } from "./api-client.js";
import { createAccountUi } from "./account-ui.js";
import { createAppUpdatePanel } from "./app-update.js";
import { renderAppLockDays, renderGrayscaleScheduleDays, renderIntentionalDays, renderLimitDays, renderScheduleDays } from "./day-controls.js";
import { createDevicePanel } from "./device-panel.js";
import { bindAppEvents } from "./app-events.js";
import { createDistanceKeyUi } from "./distance-key-ui.js";
import { detailBlock, progressBlock } from "./dom.js";
import { createFocusSoundController } from "./focus-sound.js";
import { daysText, formatDuration, lines, phaseTitle, progressText } from "./format.js";
import { formHasUnsavedChanges, markFormSaved } from "./form-state.js";
import { createFormController } from "./forms.js";
import { createHardeningPanel } from "./hardening-panel.js";
import { createLifeLogView } from "./life-log-view.js";
import { createRankingView } from "./ranking-view.js";
import { createSaintStage } from "./saint-stage.js";
import { renderSetupWizard } from "./setup-wizard.js";
import { renderPresetButtons } from "./preset-buttons.js";
import { createTrackingView } from "./tracking-view.js";
import { $, $$, bindViewNavigation, errorMessage, initTheme, renderActiveView } from "./ui-shell.js";
import type { ActivePolicy, ChallengeSummary, ControlElement, DashboardData, DashboardItem, DashboardState, GrayscaleSchedule, IntentionalUseSummary, JournalVaultSummary, ProgressSummary, Schedule, SessionStartResponse, UiState, UnknownRecord } from "./app-model.js";

interface JournalUnlockResponse extends UnknownRecord {
  ok?: boolean;
  error?: string;
  session?: {
    token?: string;
    expiresAt?: string;
    method?: string;
  };
}

interface VigilJournalWindow extends Window {
  vigilJournal?: {
    promptTouchId(): Promise<unknown>;
  };
}

interface VigilAppearanceBridge {
  getIconTheme(): Promise<unknown>;
  setIconTheme(theme: string): Promise<unknown>;
}

interface VigilAppearanceWindow extends Window {
  vigilAppearance?: VigilAppearanceBridge;
}

type JournalEntryItem = NonNullable<NonNullable<IntentionalUseSummary["lifeLog"]>["entries"]>[number];

interface JournalEntriesResponse extends UnknownRecord {
  ok?: boolean;
  entries?: JournalEntryItem[];
}

const state: UiState = {
  data: null,
  activeView: "home",
  selectedProfileId: null,
  selectedScheduleId: null,
  selectedGrayscaleScheduleId: null,
  pendingEmergencyId: null,
  pendingMaintenanceId: null,
  timer: null,
  distanceScanner: {
    stream: null,
    frame: null,
    target: null
  }
};

let viewBeforeSettings = "home";

const BRICK_MODE_PROFILE_ID = "brick-mode";
const SOFT_BLOCK_PROFILE_ID = "soft-block";
const SESSION_DEVICE_TARGETS = ["computer", "phone"] as const;
const BUILT_IN_PROFILE_IDS = new Set(["default", "normal", SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]);
let protectionLevelRequestInFlight = false;
let refreshCycle: Promise<void> | null = null;
let refreshRequested = false;
const forms = createFormController({
  $,
  $$,
  setView
});
const focusSound = createFocusSoundController({ $, post });
const appUpdatePanel = createAppUpdatePanel({ $, get, post, toast, errorMessage });
const distanceKeyUi = createDistanceKeyUi({ $, toast, errorMessage, scanner: state.distanceScanner });
const devicePanel = createDevicePanel({ $, post, lines, toast, errorMessage, refresh });
const lifeLogView = createLifeLogView({
  $,
  del,
  toast,
  refresh,
  forms,
  empty
});
const hardeningPanel = createHardeningPanel({
  $,
  post,
  toast,
  errorMessage,
  refresh,
  getData: () => state.data,
  setPendingMaintenanceId: (id) => {
    state.pendingMaintenanceId = id;
  }
});
const saintStage = createSaintStage();
const rankingView = createRankingView();
const trackingView = createTrackingView({ post, refresh, toast });
const accountUi = createAccountUi();

boot();

function boot() {
  initTheme();
  renderScheduleDays();
  renderGrayscaleScheduleDays();
  renderLimitDays();
  renderAppLockDays();
  renderIntentionalDays();
  bindViewNavigation(setView);
  renderActiveView(state.activeView);
  saintStage.bind();
  trackingView.bind();
  accountUi.bind();
  bindJournalUnlockGate();
  bindJournalSecuritySettings();
  bindIconThemeSettings();
  appUpdatePanel.bind();
  bindAppEvents({
    state,
    devicePanel,
    hardeningPanel,
    distanceKeyUi,
    focusSound,
    forms,
    post,
    refresh,
    toast,
    setProtectionLevel
  });
  void pollState();
  state.timer = setInterval(renderCountdowns, 1000);
}

function bindIconThemeSettings(): void {
  const bridge = (window as VigilAppearanceWindow).vigilAppearance;
  const status = $("#iconThemeStatus");
  if (!bridge) {
    status.textContent = "Available in the Vigil Mac app";
    for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) input.disabled = true;
    return;
  }
  void loadIconTheme(bridge, status);
  for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) {
    input.addEventListener("change", () => {
      if (!input.checked) return;
      status.textContent = "Applying icon…";
      void saveIconTheme(bridge, input.value, status);
    });
  }
}

async function loadIconTheme(bridge: VigilAppearanceBridge, status: HTMLElement): Promise<void> {
  try {
    const response = await bridge.getIconTheme();
    const value = response as { ok?: boolean; theme?: string; error?: string };
    if (!value.ok || !value.theme) throw new Error(value.error || "Icon choice is unavailable.");
    selectIconTheme(value.theme);
    status.textContent = "Changes apply immediately";
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

async function saveIconTheme(bridge: VigilAppearanceBridge, theme: string, status: HTMLElement): Promise<void> {
  try {
    const response = await bridge.setIconTheme(theme);
    const value = response as { ok?: boolean; theme?: string; error?: string };
    if (!value.ok || !value.theme) throw new Error(value.error || "Icon choice was not saved.");
    selectIconTheme(value.theme);
    status.textContent = "Changes apply immediately";
    toast(`${iconThemeLabel(value.theme)} icon selected`);
  } catch (error) {
    status.textContent = errorMessage(error);
  }
}

function selectIconTheme(theme: string): void {
  for (const input of $$<HTMLInputElement>('input[name="appIconTheme"]')) input.checked = input.value === theme;
}

function iconThemeLabel(theme: string): string {
  if (theme === "sacred-heart") return "Sacred Heart";
  if (theme === "saint-michael") return "Saint Michael";
  return "Jerusalem Cross";
}

async function pollState(): Promise<void> {
  await refresh();
  window.setTimeout(() => {
    void pollState();
  }, 3000);
}

function setView(view?: string) {
  const nextView = view || "home";
  if (nextView === "settings") {
    if (state.activeView === "settings") {
      state.activeView = viewBeforeSettings;
    } else {
      viewBeforeSettings = state.activeView;
      state.activeView = "settings";
    }
  } else {
    state.activeView = nextView;
    viewBeforeSettings = nextView;
  }
  renderActiveView(state.activeView);
}

function bindJournalUnlockGate(): void {
  const password = document.querySelector<HTMLInputElement>("#journalPassword");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-journal-unlock-method]")) {
    button.addEventListener("click", () => {
      void unlockJournal(button.dataset.journalUnlockMethod || "password", password?.value || "");
    });
  }
  password?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("#journalPasswordUnlock").click();
  });
}

function bindJournalSecuritySettings(): void {
  $("#journalSecurityForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveJournalSecurity();
  });
  $("#lockJournalNow").addEventListener("click", () => {
    void lockJournalNow();
  });
}

async function unlockJournal(method: string, password: string): Promise<void> {
  const status = $("#journalUnlockStatus");
  const passwordButton = $("#journalPasswordUnlock");
  const touchIdButton = $("#journalTouchIdUnlock");
  passwordButton.disabled = true;
  touchIdButton.disabled = true;
  status.textContent = method === "biometric" ? "Waiting for Touch ID…" : "Checking password…";
  try {
    const vault = journalVault(state.data);
    if (!vault.configured && method === "password") {
      status.textContent = "Protecting the journal…";
      await post("/api/intentional-use/journal/password", {
        password,
        autoLockMinutes: Number(vault.autoLockMinutes || 15)
      });
    }

    let response: JournalUnlockResponse;
    if (method === "biometric") {
      const bridge = (window as VigilJournalWindow).vigilJournal;
      if (!bridge?.promptTouchId) throw new Error("Touch ID is available in the Vigil Mac app.");
      response = normalizeJournalUnlockResponse(await bridge.promptTouchId());
    } else {
      response = await post<JournalUnlockResponse>("/api/intentional-use/journal/unlock", { password });
    }
    if (response.ok === false || !response.session?.token) {
      throw new Error(response.error || "Journal authentication was not accepted.");
    }
    storeJournalSession(response.session);
    $("#journalPassword").value = "";
    status.textContent = response.session.expiresAt
      ? `Unlocked until ${new Date(response.session.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "Unlocked";
    toast("Journal unlocked");
    await refresh();
  } catch (error) {
    clearJournalSession();
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
  } finally {
    passwordButton.disabled = false;
    touchIdButton.disabled = false;
  }
}

async function saveJournalSecurity(): Promise<void> {
  const save = $("#saveJournalSecurity");
  const status = $("#journalSecurityHelp");
  save.disabled = true;
  status.textContent = "Saving journal security…";
  try {
    await post("/api/intentional-use/journal/password", {
      currentPassword: $("#journalCurrentPassword").value,
      password: $("#journalNewPassword").value,
      autoLockMinutes: Number($("#journalAutoLockMinutes").value || 15)
    });
    $("#journalCurrentPassword").value = "";
    $("#journalNewPassword").value = "";
    status.textContent = "Saved. Unlock the journal again to continue.";
    toast("Journal security saved");
    await refresh();
  } catch (error) {
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
  } finally {
    save.disabled = false;
  }
}

async function lockJournalNow(): Promise<void> {
  const status = $("#journalSecurityHelp");
  status.textContent = "Locking journal…";
  try {
    if (journalSessionActive()) await post("/api/intentional-use/journal/lock", {});
    clearJournalSession();
    status.textContent = "Journal locked for this app session.";
    toast("Journal locked");
    await refresh();
  } catch (error) {
    clearJournalSession();
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
    await refresh();
  }
}

function renderJournalGate(data: DashboardData): void {
  const vault = journalVault(data);
  const locked = !vault.configured || !journalSessionActive();
  const gate = $("#journalUnlockGate");
  gate.hidden = !locked;
  $("#journalUnlockTitle").textContent = vault.configured ? "Journal locked." : "Set journal access.";
  $("#journalUnlockCopy").textContent = vault.configured
    ? "Enter your password to continue."
    : "Create a password before writing your first entry. Entries stay on this Mac and are not encrypted.";
  const password = $("#journalPassword");
  password.placeholder = vault.configured ? "Journal password" : "Create a journal password";
  password.setAttribute("autocomplete", vault.configured ? "current-password" : "new-password");
  $("#journalPasswordUnlock").textContent = vault.configured ? "Unlock" : "Set password";
  const bridgeAvailable = Boolean((window as VigilJournalWindow).vigilJournal?.promptTouchId);
  $("#journalTouchIdUnlock").hidden = !vault.configured || vault.touchIdAvailable === false || !bridgeAvailable;
  $("#journalUnlockStatus").textContent = vault.error || (vault.configured ? "Authentication required" : "A protected settings window may be required for setup");
  if (locked) forms.resetJournalForm();
  for (const content of $$<HTMLElement>("[data-journal-content]")) {
    content.hidden = locked;
    content.inert = locked;
  }
}

function renderJournalSecurity(data: DashboardData): void {
  const vault = journalVault(data);
  $("#journalCurrentPasswordField").hidden = !vault.configured;
  $("#journalNewPasswordLabel").textContent = vault.configured ? "New password" : "Journal password";
  $("#saveJournalSecurity").textContent = vault.configured ? "Change password" : "Set journal password";
  $("#journalSecurityStatus").textContent = vault.configured
    ? (journalSessionActive() ? "Unlocked" : "Locked")
    : "Not configured";
  $("#journalSecurityStatus").className = vault.configured && journalSessionActive() ? "pill good" : "pill neutral";
  $("#lockJournalNow").disabled = !journalSessionActive();
  if (document.activeElement !== $("#journalAutoLockMinutes")) {
    $("#journalAutoLockMinutes").value = String(vault.autoLockMinutes || 15);
  }
}

function journalVault(data: DashboardData | null): JournalVaultSummary {
  return data?.intentionalUse?.lifeLog?.journalVault || {};
}

function normalizeJournalUnlockResponse(value: unknown): JournalUnlockResponse {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JournalUnlockResponse : {};
}

function selectedDeviceTargets() {
  return [...SESSION_DEVICE_TARGETS];
}

function deviceTargetsText(targets: readonly string[] = []): string {
  const normalized = [...new Set((targets || []).map((target) => String(target).toLowerCase()))];
  if (normalized.includes("computer") && normalized.includes("phone")) return "Computer + iPhone";
  if (normalized.includes("phone")) return "iPhone";
  return "Computer";
}

async function setProtectionLevel(requestedLevel: number): Promise<void> {
  if (protectionLevelRequestInFlight) return;
  const level = Math.max(1, Math.min(4, Math.round(requestedLevel || 1)));
  const input = $("#protectionLevel");
  protectionLevelRequestInFlight = true;
  input.disabled = true;
  $("#protectionLevelStatus").textContent = level === 4 ? "Locking..." : "Applying...";
  try {
    if (level === 4) {
      await post<SessionStartResponse>("/api/panic/start", { durationMinutes: 3 });
    } else {
      await post("/api/protection/level", {
        level,
        deviceTargets: selectedDeviceTargets()
      });
    }
  } catch (error) {
    toast(errorMessage(error));
  } finally {
    await refresh();
    protectionLevelRequestInFlight = false;
    renderProtectionLevel(state.data?.state);
  }
}

async function hydrateJournalEntries(data: DashboardData): Promise<void> {
  const lifeLog = data.intentionalUse?.lifeLog;
  if (!lifeLog) return;
  const vault = journalVault(data);
  if (!vault.configured || !journalSessionActive()) {
    lifeLog.entries = [];
    lifeLog.entriesLocked = true;
    return;
  }
  try {
    const response = await get<JournalEntriesResponse>("/api/intentional-use/journal/entries");
    lifeLog.entries = response.entries || [];
    lifeLog.entriesLocked = false;
    delete vault.error;
  } catch (error) {
    clearJournalSession();
    lifeLog.entries = [];
    lifeLog.entriesLocked = true;
    vault.error = errorMessage(error);
  }
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
        const data = await get<DashboardData>("/api/state");
        await hydrateJournalEntries(data);
        state.data = data;
        render();
      } catch (error) {
        toast(errorMessage(error));
      }
    }
  } finally {
    refreshCycle = null;
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  renderPresetButtons(data.presets || [], toast);
  renderHeader(data.state, data.limits.activeBlocks);
  focusSound.render(data);
  rankingView.render(data);
  renderJournalGate(data);
  renderJournalSecurity(data);
  renderIntentionalUse(data.intentionalUse);
  lifeLogView.renderLifeLog(data.intentionalUse);
  trackingView.render(data);
  renderSetupWizard(data);
  appUpdatePanel.render();
  hardeningPanel.render(data);
  renderProfiles(data.state);
  renderSchedules(data.state.schedules);
  renderGrayscale(data);
  renderLimits(data.limits.rules);
  renderAppLocks(data.appLocks.rules);
  devicePanel.render(data.devices);
  renderEmergency(data.state);
  renderCountdowns();
}

function renderHeader(appState: DashboardState, activeBlocks: UnknownRecord[] = []): void {
  const active = appState.activePolicy;
  const session = appState.activeSession;
  const phase = active?.phase || appState.sessionPhase;
  const hasRuntimeStatus = Boolean(active || session || activeBlocks.length);
  $("#homeRuntimeStatus").classList.toggle("hidden", active?.kind === "integrity" || !hasRuntimeStatus);
  let orbState = "idle";
  if (active?.kind === "integrity") {
    $("#sessionTitle").textContent = active.session.title;
    orbState = "integrity";
  } else if (active) {
    $("#sessionTitle").textContent = phaseTitle(active.session, phase);
    orbState = "locked";
  } else if (session && phase?.kind === "break") {
    $("#sessionTitle").textContent = phaseTitle(session, phase);
    orbState = "break";
  } else if (session) {
    $("#sessionTitle").textContent = session.title || "Session running";
    orbState = "session";
  } else if (activeBlocks.length) {
    $("#sessionTitle").textContent = "Limit lock";
    orbState = "limit";
  } else {
    $("#sessionTitle").textContent = "Ready";
  }
  renderOrbState(orbState);
  renderProtectionLevel(appState);
}

function renderProtectionLevel(appState: DashboardState | null | undefined): void {
  if (!appState) return;
  const active = appState.activePolicy;
  const sessions = Object.values(appState.activeSessions || {}).filter(Boolean);
  const profileIds = new Set([
    active?.session?.profileId,
    active?.profile?.id,
    ...sessions.map((session) => session?.profileId)
  ].filter(Boolean));
  const level = active?.kind === "panic"
    ? 4
    : profileIds.has(BRICK_MODE_PROFILE_ID)
      ? 3
      : profileIds.has(SOFT_BLOCK_PROFILE_ID)
        ? 2
        : 1;
  const input = $("#protectionLevel");
  const label = level === 4 ? "Panic" : `Level ${level}`;
  const userAdjusting = document.activeElement === input;
  if (!userAdjusting) input.value = String(level);
  input.disabled = protectionLevelRequestInFlight || level === 4;
  input.setAttribute("aria-valuetext", level === 4 ? "Panic, locked for three minutes" : label);
  if (!userAdjusting) {
    $("#protectionLevelControl").dataset.level = String(level);
    $("#protectionLevelLabel").textContent = label;
  }
  for (const choice of $$<HTMLButtonElement>("[data-protection-level-choice]")) {
    const selected = Number(choice.dataset.protectionLevelChoice) === level;
    choice.classList.toggle("is-selected", selected);
    choice.setAttribute("aria-pressed", String(selected));
  }
  if (level === 4 && active) {
    const seconds = Math.max(0, Math.ceil((new Date(active.endsAt).getTime() - Date.now()) / 1000));
    $("#protectionLevelStatus").textContent = `${formatDuration(seconds)} locked`;
  } else {
    $("#protectionLevelStatus").textContent = level === 1 ? "Normal" : level === 2 ? "Soft Lock" : "Full Brick";
  }
}

function renderOrbState(orbState: string): void {
  const orb = $("#vigilOrb");
  if (!orb) return;
  orb.className = `vigil-orb ${orbState}`;
  document.body.dataset.lockState = orbState;
}

function renderProfiles(appState: DashboardState): void {
  const profiles = appState.profiles;
  const activeId = appState.settings.activeProfileId;
  state.selectedProfileId ||= activeId;

  forms.fillSelect($("#profileSelect"), profiles, state.selectedProfileId);

  const profile = profiles.find((item) => item.id === state.selectedProfileId) || appState.activeProfile;
  if (!profile) return;
  const form = $("#profileForm");
  const trackedForm = form as unknown as HTMLFormElement;
  if (!formHasUnsavedChanges(trackedForm)) {
    form.elements.id.value = profile.id;
    form.elements.name.value = profile.name;
    form.elements.mode.value = profile.mode;
    form.elements.blockedApps.value = (profile.blockedApps || []).join("\n");
    form.elements.blockedSites.value = (profile.blockedSites || []).join("\n");
    form.elements.blockedUrlPatterns.value = (profile.blockedUrlPatterns || []).join("\n");
    form.elements.allowedApps.value = (profile.allowedApps || []).join("\n");
    form.elements.allowedSites.value = (profile.allowedSites || []).join("\n");
  }

  const deleteButton = $("#deleteProfile");
  const canDelete = !BUILT_IN_PROFILE_IDS.has(profile.id) && profiles.length > 1;
  deleteButton.hidden = !canDelete;
  deleteButton.onclick = canDelete ? async () => {
    try {
      await del(`/api/profile/${encodeURIComponent(profile.id)}`);
      toast("Profile deleted");
      state.selectedProfileId = null;
      markFormSaved(trackedForm);
      await refresh();
    } catch (error) {
      toast(errorMessage(error));
    }
  } : null;
}

function renderSchedules(schedules: Schedule[]): void {
  const list = $("#scheduleList");
  list.replaceChildren();
  if (!schedules.length) {
    list.append(empty("No schedules saved"));
    return;
  }

  for (const schedule of schedules) {
    const row = document.createElement("div");
    row.className = "list-item";
    const wifi = schedule.wifiNetworks?.length ? ` | Wi-Fi: ${schedule.wifiNetworks.join(", ")}` : "";
    const commitment = schedule.commitmentLock ? " | commitment" : "";
    const label = detailBlock(
      schedule.name,
      `${schedule.start} to ${schedule.end} | ${daysText(schedule.days)}${wifi}${commitment} | ${schedule.enabled ? "on" : "off"}`
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => forms.loadSchedule(schedule));

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/schedule/${encodeURIComponent(schedule.id)}`);
      toast("Schedule deleted");
      await refresh();
    });

    row.append(label, edit, remove);
    list.append(row);
  }
}

function renderGrayscale(data: DashboardData): void {
  const grayscale = (data.state.grayscale || {}) as UnknownRecord & {
    schedules?: GrayscaleSchedule[];
    softBlockEnabled?: boolean;
    preventManualChanges?: boolean;
    devices?: Record<string, UnknownRecord & { desired?: boolean; label?: string; source?: string }>;
  };
  $("#grayscaleSoftBlockEnabled").checked = Boolean(grayscale.softBlockEnabled);
  $("#grayscalePreventManualChanges").checked = grayscale.preventManualChanges !== false;

  const mac = data.monitor.lastGrayscale || {};
  const computerText = mac.desired
    ? (mac.current ? `On: ${mac.label || "active"}` : `Applying: ${mac.label || "active"}`)
    : (mac.active ? "Turning off" : "Normal");
  $("#grayscaleComputerStatus").textContent = mac.error ? String(mac.error) : computerText;

  const phone = grayscale.devices?.phone || {};
  const ios = data.devices?.ios || {};
  const mdmGrayscale = ios.mdm?.grayscale || {};
  const phoneDesired = Boolean(phone.desired || mdmGrayscale.desired);
  const phoneLabel = String(phone.label || mdmGrayscale.label || "active");
  const guarded = ios.profile?.grayscale?.settingsGuarded ? " + guarded" : "";
  $("#grayscalePhoneStatus").textContent = phoneDesired ? `On: ${phoneLabel}${guarded}` : "Normal";
  renderGrayscaleSchedules(grayscale.schedules || []);
}

function renderGrayscaleSchedules(schedules: GrayscaleSchedule[]): void {
  const list = $("#grayscaleScheduleList");
  list.replaceChildren();
  if (!schedules.length) {
    list.append(empty("No grayscale schedules saved"));
    return;
  }

  for (const schedule of schedules) {
    const row = document.createElement("div");
    row.className = "list-item";
    const targets = deviceTargetsText(schedule.deviceTargets || []);
    const label = detailBlock(
      schedule.name,
      `${schedule.start} to ${schedule.end} | ${daysText(schedule.days)} | ${targets} | ${schedule.enabled ? "on" : "off"}`
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => forms.loadGrayscaleSchedule(schedule));

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/grayscale/schedule/${encodeURIComponent(schedule.id)}`);
      toast("Grayscale schedule deleted");
      await refresh();
    });

    row.append(label, edit, remove);
    list.append(row);
  }
}

function renderLimits(rules: DashboardItem[]): void {
  const list = $("#limitList");
  list.replaceChildren();
  if (!rules.length) {
    list.append(empty("No limits saved"));
    return;
  }

  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "list-item limit-item";
    const progress = rule.progress || {};
    const used = rule.type === "open" ? (progress.opens || 0) : (progress.seconds || 0);
    const cap = rule.type === "open" ? (rule.unlocksAllowed || 0) : (rule.limitMinutes || 0) * 60;
    const scope = limitScopeText(rule);
    const label = progressBlock(
      rule.name,
      `${rule.type} | ${progressText(rule, used, cap)} | ${daysText(rule.days || [])}${scope ? ` | ${scope}` : ""} | ${rule.enabled ? "on" : "off"}${rule.activeBlock ? " | locked" : ""}`,
      rule.percent || 0
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => forms.loadLimit(rule));

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/limit/${encodeURIComponent(rule.id)}`);
      toast("Limit deleted");
      await refresh();
    });

    row.append(label, edit, remove);
    list.append(row);
  }
}

function limitScopeText(rule: DashboardItem): string {
  if (Array.isArray(rule.excludedProfileIds) && rule.excludedProfileIds.includes("soft-block")) return "Off during Soft Lock";
  return rule.requiredProfileId === "soft-block" ? "Soft Lock only" : "";
}

function renderAppLocks(rules: DashboardItem[]): void {
  const list = $("#appLockList");
  list.replaceChildren();
  let pendingChallenge = null;
  if (!rules.length) {
    list.append(empty("No app locks saved"));
    renderTypingChallenge($("#appLockChallenge"), $("#appLockChallengeInput"), null);
    return;
  }

  for (const rule of rules) {
    if (!pendingChallenge && rule.pendingRequest?.challenge) pendingChallenge = rule.pendingRequest.challenge;
    const row = document.createElement("div");
    row.className = "list-item limit-item";
    const used = rule.usedToday || 0;
    const allowed = rule.unlocksAllowed || 0;
    const percent = allowed ? Math.min(100, Math.round((used / allowed) * 100)) : 100;
    const label = progressBlock(
      rule.name,
      `${used}/${allowed} unlocks | ${rule.unlockMinutes || 0}m window | ${daysText(rule.days || [])} | ${rule.enabled ? "on" : "off"}${rule.activeUnlock ? " | unlocked now" : ""}`,
      percent
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => forms.loadAppLock(rule));

    const unlock = document.createElement("button");
    unlock.className = rule.pendingRequest ? "danger ghost" : "secondary";
    unlock.type = "button";
    configureAppLockUnlockButton(unlock, rule);

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/app-lock/${encodeURIComponent(rule.id)}`);
      toast("App lock deleted");
      await refresh();
    });

    row.append(label, edit, unlock, remove);
    list.append(row);
  }
  renderTypingChallenge($("#appLockChallenge"), $("#appLockChallengeInput"), pendingChallenge);
}

function configureAppLockUnlockButton(button: HTMLButtonElement, rule: DashboardItem): void {
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

  if (rule.pendingRequest) {
    const pendingRequest = rule.pendingRequest;
    const ms = new Date(pendingRequest.eligibleAt || "").getTime() - Date.now();
    if (ms > 0) {
      button.textContent = `${Math.ceil(ms / 1000)}s`;
      button.disabled = true;
      return;
    }
    button.textContent = "Confirm";
    button.addEventListener("click", async () => {
      try {
        await post("/api/app-lock/unlock/confirm", {
          requestId: pendingRequest.id,
          passcode: $("#appLockPasscode").value,
          distanceKey: $("#appLockDistanceKey").value,
          challengeText: $("#appLockChallengeInput").value
        });
        $("#appLockPasscode").value = "";
        $("#appLockDistanceKey").value = "";
        $("#appLockChallengeInput").value = "";
        $("#appLockReason").value = "";
        toast("App lock unlocked");
      } catch (error) {
        toast(errorMessage(error));
      }
      await refresh();
    });
    return;
  }

  button.textContent = "Unlock";
  button.addEventListener("click", async () => {
    try {
      await post("/api/app-lock/unlock/request", { lockId: rule.id, reason: $("#appLockReason").value.trim() });
      toast("Unlock cooldown started");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });
}

function renderIntentionalUse(intentionalUse: IntentionalUseSummary): void {
  if (!intentionalUse) return;
  const goal = intentionalUse.goal || {};
  const settings = state.data?.state.settings;
  if (!settings) return;
  $("#intentionalUseEnabled").checked = settings.intentionalUseEnabled !== false;
  $("#intentionalUseStatus").textContent = settings.intentionalUseEnabled === false ? "Off" : `${intentionalUse.today?.pauses || 0} pauses today`;
  $("#intentionalUseStatus").className = settings.intentionalUseEnabled === false ? "pill neutral" : "pill good";
  if (document.activeElement !== $("#intentionalGoalStatement")) $("#intentionalGoalStatement").value = goal.statement || "";
  if (document.activeElement !== $("#intentionalGoalValues")) $("#intentionalGoalValues").value = (goal.values || []).join("\n");
  if (document.activeElement !== $("#intentionalGoalReplacements")) $("#intentionalGoalReplacements").value = (goal.replacements || []).join("\n");

  const accountability = intentionalUse.accountability || {};
  $("#accountabilityEnabled").checked = Boolean(accountability.enabled);
  if (document.activeElement !== $("#accountabilityPartner")) $("#accountabilityPartner").value = accountability.partnerName || "";
  $("#accountabilityCadence").value = accountability.cadence || "weekly";
  $("#accountabilityDigest").textContent = accountability.digest?.text || "";
  renderIntentionalRuleList(intentionalUse.rules || []);
}

function renderIntentionalRuleList(rules: DashboardItem[]): void {
  const list = $("#intentionalRuleList");
  list.replaceChildren();
  if (!rules.length) {
    list.append(empty("No pause rules saved"));
    return;
  }

  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "list-item limit-item";
    const progress: ProgressSummary = rule.progress || {};
    const budget = progress.budget || {};
    const percent = budget.budgetSeconds ? Math.min(100, budget.percent || 0) : 0;
    const label = progressBlock(
      rule.name,
      `${rule.frictionLevel} | ${rule.delaySeconds}s pause | ${rule.sessionMinutes}m window | ${targetCount(rule)} targets | ${formatDuration(progress.seconds || 0)} today | ${rule.enabled ? "on" : "off"}`,
      Math.max(4, percent)
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => forms.loadIntentionalRule(rule));

    const remove = document.createElement("button");
    remove.className = "ghost";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/intentional-use/rule/${encodeURIComponent(rule.id)}`);
      toast("Pause rule deleted");
      await refresh();
    });

    row.append(label, edit, remove);
    list.append(row);
  }
}

function renderEmergency(appState: DashboardState): void {
  const panel = $("#emergencyPanel");
  const controls = $("#emergencyControls");
  const explanation = $("#emergencyExplanation");
  const active = emergencyPolicy(appState);
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if ((!active || active.session.canEndEarly) && !activeLimitBlocks.length) {
    panel.classList.add("hidden");
    panel.removeAttribute("open");
    state.pendingEmergencyId = null;
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    return;
  }

  panel.classList.remove("hidden");
  if (active && !emergencyUnlockAllowedForPolicy(active)) {
    const integrity = active.kind === "integrity";
    const copy = $("#emergencyCopy");
    panel.classList.add("is-not-unlockable");
    controls.classList.add("hidden");
    explanation.classList.remove("hidden");
    $("#emergencyTitle").textContent = integrity ? "Integrity lockdown" : "Lock cannot end early";
    copy.classList.toggle("hidden", integrity);
    copy.textContent = integrity ? "" : "Emergency unlock unavailable";
    explanation.textContent = integrity
      ? "This protected state can only be reviewed and cleared through protected maintenance."
      : active.kind === "panic"
        ? "Panic lockout cannot be ended early."
        : "This commitment lock has emergency unlocks disabled. Use protected maintenance if it was started by mistake.";
    $("#requestEmergency").disabled = true;
    $("#confirmEmergency").disabled = true;
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    return;
  }
  panel.classList.remove("is-not-unlockable");
  controls.classList.remove("hidden");
  explanation.classList.add("hidden");
  explanation.textContent = "";
  $("#emergencyCopy").classList.remove("hidden");
  $("#emergencyTitle").textContent = "Emergency unlock";
  $("#requestEmergency").disabled = false;
  const pending = appState.emergency.pending.find((item) => item.status === "pending");
  if (pending) state.pendingEmergencyId = pending.id;

  const copy = $("#emergencyCopy");
  const confirm = $("#confirmEmergency");
  if (!pending) {
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    copy.textContent = `${appState.emergency.remaining} emergency unlocks remain this week.`;
    confirm.disabled = true;
    return;
  }

  renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), (pending.challenge as ChallengeSummary | null) || null);
  const ms = new Date(pending.eligibleAt || "").getTime() - Date.now();
  if (ms > 0) {
    copy.textContent = `Confirm available in ${Math.ceil(ms / 1000)} seconds.`;
    confirm.disabled = true;
  } else {
    copy.textContent = "Cooldown complete.";
    confirm.disabled = false;
  }
}

function emergencyPolicy(appState: DashboardState): ActivePolicy | null {
  const policies = [
    appState.activePolicy || null,
    appState.devicePolicies?.computer || null,
    appState.devicePolicies?.phone || null
  ].filter((policy): policy is ActivePolicy => Boolean(policy));
  const uniquePolicies = policies.filter((policy, index) => (
    policies.findIndex((item) => item.kind === policy.kind && item.session.id === policy.session.id) === index
  ));
  return uniquePolicies.find((policy) => !emergencyUnlockAllowedForPolicy(policy))
    || uniquePolicies.find((policy) => !policy.session.canEndEarly)
    || uniquePolicies[0]
    || null;
}

function emergencyUnlockAllowedForPolicy(policy: ActivePolicy | null | undefined): boolean {
  if (!policy) return true;
  if (policy.kind === "integrity") return false;
  return policy.session?.emergencyUnlocksAllowed !== false;
}

function renderCountdowns(): void {
  const appState = state.data?.state;
  renderProtectionLevel(appState);
  const active = appState?.activePolicy;
  const phase = active?.phase || appState?.sessionPhase;
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if (state.data?.protection) hardeningPanel.renderMaintenance(state.data.protection);
  if (active?.kind === "integrity") {
    $("#sessionCountdown").textContent = "Until cleared";
    if (appState) renderEmergency(appState);
    return;
  }
  if (active?.session?.source === "protection-level") {
    $("#sessionCountdown").textContent = "Until changed";
    if (appState) renderEmergency(appState);
    return;
  }
  if (phase) {
    const seconds = Math.max(0, Math.round((new Date(phase.endsAt).getTime() - Date.now()) / 1000));
    $("#sessionCountdown").textContent = formatDuration(seconds);
    if (appState) renderEmergency(appState);
    return;
  }
  if (!active) {
    if (activeLimitBlocks.length) {
      const latest = activeLimitBlocks.map((block) => new Date(block.until).getTime()).sort((a, b) => b - a)[0];
      const seconds = Math.max(0, Math.round(((latest || Date.now()) - Date.now()) / 1000));
      $("#sessionCountdown").textContent = formatDuration(seconds);
      if (state.data) renderEmergency(state.data.state);
      return;
    }
    $("#sessionCountdown").textContent = "--";
    return;
  }
  const seconds = Math.max(0, Math.round((new Date(active.endsAt).getTime() - Date.now()) / 1000));
  $("#sessionCountdown").textContent = formatDuration(seconds);
  renderEmergency(appState);
}

function targetCount(rule: DashboardItem): number {
  return (rule.apps || []).length + (rule.sites || []).length + (rule.urlPatterns || []).length;
}

function renderTypingChallenge(output: ControlElement, input: ControlElement, challenge: ChallengeSummary | null): void {
  const text = challenge?.text || "";
  output.classList.toggle("hidden", !text);
  input.classList.toggle("hidden", !text);
  output.textContent = text ? `Type: ${text}` : "";
  if (!text && document.activeElement !== input) input.value = "";
}

function empty(text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

let toastTimeout: ReturnType<typeof setTimeout> | null = null;

function toast(message: string): void {
  const node = $("#toast");
  node.textContent = message;
  node.classList.remove("hidden");
  if (toastTimeout) clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => node.classList.add("hidden"), 2600);
}
