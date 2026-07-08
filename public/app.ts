import { get, post, del } from "./api-client.js";
import { renderAppLockDays, renderGrayscaleScheduleDays, renderIntentionalDays, renderLimitDays, renderScheduleDays } from "./day-controls.js";
import { createDevicePanel } from "./device-panel.js";
import { bindAppEvents } from "./app-events.js";
import { createDistanceKeyUi } from "./distance-key-ui.js";
import { createDeviceTargetController } from "./device-targets.js";
import { detailBlock, progressBlock } from "./dom.js";
import { createFocusSoundController } from "./focus-sound.js";
import { daysText, enforcementText, eventLabel, formatDuration, lines, phaseText, phaseTitle, progressText, shortDateTime, signedPercent, sweepText, systemSleepLockText } from "./format.js";
import { createFormController } from "./forms.js";
import { createHardeningPanel } from "./hardening-panel.js";
import { createLifeLogView } from "./life-log-view.js";
import { createReportView } from "./report-view.js";
import { renderSetupWizard } from "./setup-wizard.js";
import { renderPresetButtons } from "./preset-buttons.js";
import { $, $$, bindViewNavigation, errorMessage, initTheme, renderActiveView } from "./ui-shell.js";
import type { ActivePolicy, ChallengeSummary, ControlElement, DashboardData, DashboardItem, DashboardState, GrayscaleSchedule, IntentionalUseSummary, InterventionSummary, MonitorSummary, ProgressSummary, ReportSummary, Schedule, SessionEndResponse, SessionPreviewResponse, SessionPreviewSummary, SessionStartResponse, StateEvent, UiState, UnknownRecord, UsageSummary } from "./app-model.js";

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

const BRICK_MODE_PROFILE_ID = "brick-mode";
const SOFT_BLOCK_PROFILE_ID = "soft-block";
const BUILT_IN_PROFILE_IDS = new Set(["default", "normal", SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]);
let pendingLockStart: UnknownRecord | null = null;
const deviceTargets = createDeviceTargetController({
  onChange: () => {
    renderDeviceTargetControls(state.data?.state || {});
    hideLockPreview();
  }
});
const forms = createFormController({
  $,
  $$,
  getData: () => state.data,
  setView,
  defaultPlanBlockProfileId: SOFT_BLOCK_PROFILE_ID
});
const focusSound = createFocusSoundController({ $, post });
const distanceKeyUi = createDistanceKeyUi({ $, toast, errorMessage, scanner: state.distanceScanner });
const devicePanel = createDevicePanel({ $, post, lines, toast, errorMessage, refresh });
const lifeLogView = createLifeLogView({
  $,
  post,
  del,
  toast,
  refresh,
  forms,
  deviceTargetsText,
  profileName,
  empty
});
const reportView = createReportView({ $, empty });
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

boot();

function boot() {
  initTheme();
  renderScheduleDays();
  renderGrayscaleScheduleDays();
  renderLimitDays();
  renderAppLockDays();
  renderIntentionalDays();
  bindViewNavigation(setView);
  bindAppEvents({
    state,
    deviceTargets,
    devicePanel,
    hardeningPanel,
    distanceKeyUi,
    focusSound,
    forms,
    post,
    refresh,
    toast,
    selectedDeviceTargets,
    previewSessionStart,
    startNormalMode,
    startPresetSession,
    renderSosPlan: lifeLogView.renderSosPlan
  });
  bindLockPreview();
  void refresh();
  setInterval(() => {
    void refresh();
  }, 3000);
  state.timer = setInterval(renderCountdowns, 1000);
}

function setView(view?: string) {
  state.activeView = view || "home";
  renderActiveView(state.activeView);
}

function selectedDeviceTargets() {
  return deviceTargets.selectedTargets() as Array<"computer" | "phone">;
}

function selectedDeviceLabel() {
  return deviceTargets.selectedLabel();
}

function deviceTargetsText(targets: readonly string[] = []): string {
  const normalized = [...new Set((targets || []).map((target) => String(target).toLowerCase()))];
  if (normalized.includes("computer") && normalized.includes("phone")) return "Computer + iPhone";
  if (normalized.includes("phone")) return "iPhone";
  return "Computer";
}

function modeLabel(value: unknown): string {
  const mode = String(value || "focus");
  if (mode === "brick") return "Brick";
  if (mode === "sleep") return "Sleep";
  if (mode === "rehab") return "Rehab";
  return "Focus";
}

function lockLevelLabel(value: unknown): string {
  return value === "light" ? "Soft" : "Strict";
}

function previewItem(title: string, detail: string): HTMLDivElement {
  const item = document.createElement("div");
  item.className = "lock-preview-item";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const text = document.createElement("span");
  text.textContent = detail;
  item.append(heading, text);
  return item;
}

function listPreview(values: readonly unknown[] = [], emptyText: string): string {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (!items.length) return emptyText;
  const visible = items.slice(0, 5);
  const suffix = items.length > visible.length ? ` +${items.length - visible.length} more` : "";
  return `${visible.join(", ")}${suffix}`;
}

function allowlistText(values: readonly unknown[] = [], label: string): string {
  const items = values.map((value) => String(value || "").trim()).filter(Boolean);
  if (!items.length) return `Allowlist mode: blocks anything outside the saved ${label}.`;
  return `Allowlist mode: ${listPreview(items, "")}; everything else blocked.`;
}

function phonePreviewText(phone: SessionPreviewSummary["phone"]): string {
  if (!phone?.targeted) return phone?.detail || "Not targeted.";
  const counts = `${phone.appCount || 0} app bundle${phone.appCount === 1 ? "" : "s"} / ${phone.siteCount || 0} ${phone.mode === "allowlist" ? "allowed URL" : "blocked URL"}${phone.siteCount === 1 ? "" : "s"}`;
  const blockers = phone.blockers?.length ? ` Need: ${listPreview(phone.blockers, "")}` : "";
  return `${phone.status || "iPhone"}: ${counts}. ${phone.detail || ""}${blockers}`.trim();
}

async function startNormalMode() {
  const targets = selectedDeviceTargets();
  const status = $("#brickStatus");
  status.textContent = "Returning to Normal...";
  try {
    const response = await post<SessionEndResponse>("/api/session/end", { deviceTargets: targets });
    status.textContent = response.ended ? "Normal active" : "Normal already active";
    toast(`${selectedDeviceLabel()} set to Normal`);
  } catch (error) {
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
  }
  await refresh();
}

async function startPresetSession(kind: "soft" | "brick") {
  const profileId = kind === "brick" ? BRICK_MODE_PROFILE_ID : SOFT_BLOCK_PROFILE_ID;
  const profile = state.data?.state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    toast(kind === "brick" ? "Full Brick profile is unavailable" : "Soft Lock profile is unavailable");
    return;
  }

  const status = $("#brickStatus");
  status.textContent = "Reviewing...";
  const body = kind === "brick"
    ? {
        title: "Full Brick",
        mode: "brick",
        profileId: BRICK_MODE_PROFILE_ID,
        durationMinutes: $("#brickDuration").value,
        lockLevel: "deep",
        commitmentLock: true,
        deviceTargets: selectedDeviceTargets()
      }
    : {
        title: "Soft Lock",
        mode: "focus",
        profileId: SOFT_BLOCK_PROFILE_ID,
        durationMinutes: $("#brickDuration").value,
        lockLevel: "deep",
        commitmentLock: true,
        deviceTargets: selectedDeviceTargets()
      };
  await previewSessionStart(body);
}

function bindLockPreview(): void {
  $("#confirmLockPreview").addEventListener("click", () => {
    void confirmLockPreview();
  });
  $("#cancelLockPreview").addEventListener("click", () => hideLockPreview());
}

async function previewSessionStart(body: UnknownRecord): Promise<void> {
  pendingLockStart = null;
  const panel = $("#lockPreview");
  const status = $("#lockPreviewStatus");
  const confirm = $("#confirmLockPreview");
  panel.classList.remove("hidden");
  status.textContent = "Preparing preview...";
  confirm.disabled = true;
  try {
    const response = await post<SessionPreviewResponse>("/api/session/preview", body);
    pendingLockStart = { ...body };
    renderLockPreview(response.preview);
    $("#brickStatus").textContent = "Preview ready";
  } catch (error) {
    hideLockPreview(false);
    $("#brickStatus").textContent = errorMessage(error);
    toast(errorMessage(error));
  }
}

function renderLockPreview(preview: SessionPreviewSummary): void {
  $("#lockPreviewTitle").textContent = preview.title || "Manual Lock";
  $("#lockPreviewMeta").textContent = [
    modeLabel(preview.mode),
    preview.profileName || "Profile",
    lockLevelLabel(preview.lockLevel),
    preview.deviceLabel || deviceTargetsText(preview.deviceTargets || []),
    formatDuration(Number(preview.durationMinutes || 0) * 60)
  ].filter(Boolean).join(" | ");

  const grid = $("#lockPreviewGrid");
  grid.replaceChildren();
  const profileMode = preview.profileMode === "allowlist" ? "Allowlist" : "Blocklist";
  grid.append(
    previewItem("Apps", profileMode === "Allowlist"
      ? allowlistText(preview.allowedApps, "allowed apps")
      : listPreview(preview.blockedApps, "No app blocks in this profile")),
    previewItem("Sites", profileMode === "Allowlist"
      ? allowlistText(preview.allowedSites, "allowed sites")
      : listPreview(preview.blockedSites, "No site blocks in this profile")),
    previewItem("URL/path patterns", listPreview(preview.blockedUrlPatterns, "No URL/path patterns")),
    previewItem("Browser/control", listPreview(preview.protections, "No extra browser controls inferred")),
    previewItem("iPhone", phonePreviewText(preview.phone))
  );

  if (preview.commitmentLock) {
    grid.append(previewItem("Commitment", "Emergency unlocks disabled for this lock."));
  } else if (preview.canEndEarly) {
    grid.append(previewItem("End early", "Soft lock can be ended from this screen."));
  }

  if (preview.conflicts?.length) {
    grid.append(previewItem("Already active", `${deviceTargetsText(preview.conflicts)} already has a session.`));
  }

  const blocked = Boolean(preview.conflicts?.length);
  $("#confirmLockPreview").disabled = blocked;
  $("#lockPreviewStatus").textContent = blocked ? "Resolve the active target before starting." : "Review before starting.";
}

async function confirmLockPreview(): Promise<void> {
  if (!pendingLockStart) return;
  const confirm = $("#confirmLockPreview");
  const status = $("#lockPreviewStatus");
  confirm.disabled = true;
  status.textContent = "Starting...";
  try {
    const response = await post<SessionStartResponse>("/api/session/start", pendingLockStart);
    const title = response.session?.title || String(pendingLockStart.title || "Lock");
    toast(`${title} started for ${selectedDeviceLabel()}`);
    $("#brickStatus").textContent = `${title} active`;
    hideLockPreview(false);
    await refresh();
  } catch (error) {
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
    confirm.disabled = false;
  }
}

function hideLockPreview(clearPending = true): void {
  const panel = document.querySelector("#lockPreview");
  if (!panel) return;
  panel.classList.add("hidden");
  $("#lockPreviewGrid").replaceChildren();
  $("#lockPreviewStatus").textContent = "Review before starting";
  $("#confirmLockPreview").disabled = true;
  if (clearPending) pendingLockStart = null;
}

async function refresh() {
  try {
    state.data = await get<DashboardData>("/api/state");
    render();
  } catch (error) {
    $("#watcherStatus").textContent = errorMessage(error);
    $("#watcherStatus").className = "tiny-status";
  }
}

function render() {
  const data = state.data;
  if (!data) return;
  renderPresetButtons(data.presets || [], toast);
  renderHeader(data.state, data.monitor, data.limits.activeBlocks);
  focusSound.render(data);
  renderMetrics(data.usage, data.report);
  renderWatcher(data.monitor);
  renderIntervention(data.intervention);
  renderIntentionalUse(data.intentionalUse);
  lifeLogView.renderLifeLog(data.intentionalUse);
  renderSetupWizard(data);
  hardeningPanel.render(data);
  renderProfiles(data.state);
  renderSchedules(data.state.schedules);
  renderGrayscale(data);
  renderLimits(data.limits.rules);
  renderAppLocks(data.appLocks.rules);
  reportView.renderBars("#appBars", data.usage.topApps);
  reportView.renderBars("#siteBars", data.usage.topSites);
  reportView.renderReport(data.report);
  devicePanel.render(data.devices);
  renderEvents(data.state.events);
  renderEmergency(data.state);
  renderCountdowns();
}

function renderDeviceTargetControls(appState: Partial<DashboardState> = {}): void {
  deviceTargets.render(appState);
}

function renderHeader(appState: DashboardState, monitor: MonitorSummary, activeBlocks: UnknownRecord[] = []): void {
  const active = appState.activePolicy;
  const session = appState.activeSession;
  const phase = active?.phase || appState.sessionPhase;
  const softButton = $("#startSoftBlock");
  const brickButton = $("#startFullBrick");
  const normalButton = $("#startNormalMode");
  const panicButton = $("#startPanicLock");
  const panicStatus = $("#panicStatus");
  const lock = $("#lockStatus");
  let orbState = "idle";
  if (active?.kind === "integrity") {
    lock.textContent = "Integrity lockdown";
    lock.className = "pill bad";
    $("#sessionTitle").textContent = active.session.title;
    orbState = "integrity";
  } else if (active) {
    lock.textContent = `${phaseText(phase, active.session.mode)} locked`;
    lock.className = "pill bad";
    $("#sessionTitle").textContent = phaseTitle(active.session, phase);
    orbState = "locked";
  } else if (session && phase?.kind === "break") {
    lock.textContent = "Break";
    lock.className = "pill good";
    $("#sessionTitle").textContent = phaseTitle(session, phase);
    orbState = "break";
  } else if (session) {
    lock.textContent = "Session";
    lock.className = "pill warn";
    $("#sessionTitle").textContent = session.title || "Session running";
    orbState = "session";
  } else if (activeBlocks.length) {
    lock.textContent = "Limits active";
    lock.className = "pill bad";
    $("#sessionTitle").textContent = "Limit lock";
    orbState = "limit";
  } else {
    lock.textContent = "Unlocked";
    lock.className = "pill good";
    $("#sessionTitle").textContent = "Ready";
  }
  renderOrbState(orbState);
  renderDeviceTargetControls(appState);

  if (brickButton) {
    const selectedActive = selectedDeviceTargets().some((target) => Boolean(appState.activeSessions?.[target]));
    brickButton.disabled = selectedActive;
    if (softButton) softButton.disabled = selectedActive;
    if (normalButton) normalButton.disabled = false;
    if (!selectedActive && ["Full Brick active", "Soft Lock active"].includes($("#brickStatus").textContent)) $("#brickStatus").textContent = "Normal baseline";
  }
  if (panicButton && panicStatus) {
    const panicActive = active?.kind === "panic";
    const duration = Number(appState.settings?.panicLockDurationMinutes || 3);
    panicButton.disabled = panicActive;
    panicStatus.textContent = panicActive
      ? `All screens locked until ${shortDateTime(active.endsAt)}`
      : `${duration} min full lockout`;
  }
  $("#watcherStatus").textContent = monitor.ok ? "Watcher online" : "Watcher needs permission";
}

function renderOrbState(orbState: string): void {
  const orb = $("#vigilOrb");
  if (!orb) return;
  orb.className = `vigil-orb ${orbState}`;
  document.body.dataset.lockState = orbState;
}

function renderMetrics(usage: UsageSummary, report: ReportSummary): void {
  const progression = report?.progression;
  $("#focusScore").textContent = `${usage.focusScore}`;
  $("#progressLevel").textContent = progression ? String(progression.level) : "--";
  $("#brainHealth").textContent = progression ? `${progression.brainHealth}` : "--";
  $("#homeFocusStreak").textContent = report?.streak?.label || "--";
  $("#distractingToday").textContent = formatDuration(usage.distractingSeconds);
  $("#lockedToday").textContent = formatDuration(usage.protectedSeconds);
  $("#distractionTrend").textContent = signedPercent(report?.comparison?.distractingPercentDelta);
}

function renderWatcher(monitor: MonitorSummary): void {
  const sample = monitor.lastSample || {};
  $("#activeApp").textContent = sample.app || "No sample";
  $("#watchApp").textContent = sample.app || "--";
  $("#watchSite").textContent = sample.hostname || "--";
  $("#lastBlock").textContent = monitor.lastEnforcement ? enforcementText(monitor.lastEnforcement) : "--";
  $("#watchWifi").textContent = state.data?.state.environment?.wifiSsid || "--";
  $("#watchSweep").textContent = sweepText(monitor.lastProcessSweep);
  $("#watchSystemLock").textContent = systemSleepLockText(monitor.lastSystemSleepLock);

  const warning = $("#permissionWarning");
  if (monitor.accessibilityLikelyMissing) {
    warning.textContent = "Accessibility permission is required for live app detection.";
    warning.classList.remove("hidden");
  } else if (monitor.lastError) {
    warning.textContent = monitor.lastError;
    warning.classList.remove("hidden");
  } else {
    warning.classList.add("hidden");
  }
}

function renderIntervention(intervention: InterventionSummary): void {
  const root = $("#interventionPanel");
  root.replaceChildren();
  if (!intervention?.enabled) {
    root.className = "intervention-panel muted";
    root.textContent = "Adaptive friction off";
    return;
  }

  root.className = `intervention-panel ${intervention.level || "calm"}`;
  const label = document.createElement("strong");
  label.textContent = "Adaptive Friction";
  const message = document.createElement("span");
  message.textContent = intervention.message || "";
  const meta = document.createElement("em");
  meta.textContent = intervention.resetsAt
    ? `Window resets ${new Date(intervention.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
    : `${intervention.windowMinutes}m rolling window`;
  root.append(label, message, meta);

  if (intervention.topTargets?.length) {
    const targets = document.createElement("div");
    targets.className = "intervention-targets";
    for (const target of intervention.topTargets) {
      const chip = document.createElement("span");
      chip.textContent = `${target.label} x${target.count}`;
      targets.append(chip);
    }
    root.append(targets);
  }
}

function renderProfiles(appState: DashboardState): void {
  const profiles = appState.profiles;
  const activeId = appState.settings.activeProfileId;
  state.selectedProfileId ||= activeId;

  forms.fillSelect($("#profileSelect"), profiles, state.selectedProfileId);
  forms.fillSelect($("#sessionProfile"), profiles, activeId);
  forms.fillSelect($("#planBlockProfileId"), profiles, SOFT_BLOCK_PROFILE_ID);

  const profile = profiles.find((item) => item.id === state.selectedProfileId) || appState.activeProfile;
  if (!profile) return;
  const form = $("#profileForm");
  form.elements.id.value = profile.id;
  form.elements.name.value = profile.name;
  form.elements.mode.value = profile.mode;
  form.elements.blockedApps.value = (profile.blockedApps || []).join("\n");
  form.elements.blockedSites.value = (profile.blockedSites || []).join("\n");
  form.elements.blockedUrlPatterns.value = (profile.blockedUrlPatterns || []).join("\n");
  form.elements.allowedApps.value = (profile.allowedApps || []).join("\n");
  form.elements.allowedSites.value = (profile.allowedSites || []).join("\n");

  const deleteButton = $("#deleteProfile");
  const canDelete = !BUILT_IN_PROFILE_IDS.has(profile.id) && profiles.length > 1;
  deleteButton.hidden = !canDelete;
  deleteButton.onclick = canDelete ? async () => {
    try {
      await del(`/api/profile/${encodeURIComponent(profile.id)}`);
      toast("Profile deleted");
      state.selectedProfileId = null;
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

function renderEvents(events: StateEvent[]): void {
  const root = $("#eventsList");
  root.replaceChildren();
  if (!events.length) {
    root.append(empty("No events yet"));
    return;
  }

  for (const event of events.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = "event";
    const title = document.createElement("strong");
    title.textContent = eventLabel(event);
    const meta = document.createElement("span");
    meta.textContent = new Date(event.at).toLocaleString();
    row.append(title, meta);
    root.append(row);
  }
}

function renderEmergency(appState: DashboardState): void {
  const panel = $("#emergencyPanel");
  const active = emergencyPolicy(appState);
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if ((!active || active.session.canEndEarly) && !activeLimitBlocks.length) {
    panel.classList.add("hidden");
    state.pendingEmergencyId = null;
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    return;
  }

  panel.classList.remove("hidden");
  if (active && !emergencyUnlockAllowedForPolicy(active)) {
    $("#emergencyCopy").textContent = active.kind === "integrity"
      ? "Integrity lockdown uses protected maintenance instead of emergency unlocks."
      : active.kind === "panic"
        ? "Panic lockout cannot be ended early."
      : "Commitment lock: emergency unlocks are disabled. Use protected maintenance if this was a mistake.";
    $("#requestEmergency").disabled = true;
    $("#confirmEmergency").disabled = true;
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    return;
  }
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
  const active = appState?.activePolicy;
  const phase = active?.phase || appState?.sessionPhase;
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if (state.data?.protection) hardeningPanel.renderMaintenance(state.data.protection);
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

function profileName(profileId: string): string {
  return state.data?.state.profiles.find((profile) => profile.id === profileId)?.name || profileId || "Profile";
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
