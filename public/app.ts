import { get, post, del } from "./api-client.js";
import { renderAppLockDays, renderGrayscaleScheduleDays, renderIntentionalDays, renderLimitDays, renderScheduleDays } from "./day-controls.js";
import { createDevicePanel } from "./device-panel.js";
import { createDistanceKeyUi } from "./distance-key-ui.js";
import { createDeviceTargetController } from "./device-targets.js";
import { detailBlock, el, progressBlock, textEl } from "./dom.js";
import { createFocusSoundController } from "./focus-sound.js";
import { daysText, daysWithDataText, enforcementText, eventLabel, formatDuration, lines, phaseText, phaseTitle, progressText, shortDate, shortDateTime, signedDuration, signedNumber, signedPercent, sweepText, systemSleepLockText } from "./format.js";
import { createHardeningPanel } from "./hardening-panel.js";
import { renderPresetButtons } from "./preset-buttons.js";
import { $, $$, bindViewNavigation, errorMessage, eventTarget, formPayload, initTheme, renderActiveView, toggleTheme } from "./ui-shell.js";
import type { BarEntry, ChallengeSummary, ControlElement, DashboardData, DashboardItem, DashboardState, DistanceKeyResponse, GrayscaleSchedule, IntentionalPlanBlock, IntentionalPlanItem, IntentionalPlanList, IntentionalUseSummary, InterventionSummary, MonitorSummary, PendingResponse, ProgressSummary, ReportSummary, Schedule, SessionEndResponse, SessionStartResponse, StateEvent, UiState, UnknownRecord, UsageSummary, WeekDaySummary } from "./app-model.js";

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
const deviceTargets = createDeviceTargetController({
  onChange: () => renderDeviceTargetControls(state.data?.state || {})
});
const focusSound = createFocusSoundController({ $, post });
const distanceKeyUi = createDistanceKeyUi({ $, toast, errorMessage, scanner: state.distanceScanner });
const devicePanel = createDevicePanel({ $, post, lines, toast, errorMessage, refresh });
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
  bindEvents();
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

function bindEvents() {
  $("#themeToggle").addEventListener("click", toggleTheme);

  deviceTargets.bind();
  devicePanel.bind();
  hardeningPanel.bind();

  $$("[data-scan-distance-key]").forEach((button) => {
    button.addEventListener("click", () => distanceKeyUi.openScanner(button.dataset.scanDistanceKey));
  });
  $("#closeDistanceScanner").addEventListener("click", distanceKeyUi.closeScanner);

  $("#startSessionForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.cycleEnabled = form.has("cycleEnabled");
    body.commitmentLock = form.has("commitmentLock");
    body.deviceTargets = selectedDeviceTargets();
    await post("/api/session/start", body);
    toast("Lock started");
    await refresh();
  });

  $("#endSession").addEventListener("click", async () => {
    try {
      await post("/api/session/end", { deviceTargets: selectedDeviceTargets() });
      toast("Selected soft lock ended");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#startNormalMode").addEventListener("click", () => startNormalMode());
  $("#startSoftBlock").addEventListener("click", () => startPresetSession("soft"));
  $("#startFullBrick").addEventListener("click", () => startPresetSession("brick"));

  $("#startPanicLock").addEventListener("click", async () => {
    const status = $("#panicStatus");
    $("#startPanicLock").disabled = true;
    status.textContent = "Locking...";
    try {
      const response = await post<SessionStartResponse>("/api/panic/start", {});
      status.textContent = `Locked until ${shortDateTime(response.session.endsAt)}`;
      toast("Panic lock started");
    } catch (error) {
      status.textContent = errorMessage(error);
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#focusSoundEnabled").addEventListener("change", async (event: Event) => {
    try {
      if (eventTarget(event).checked) await focusSound.prime();
      await focusSound.saveSettings();
      toast("Focus sound saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  for (const id of ["focusSoundMode", "focusSoundActivity", "focusSoundPreset", "focusSoundIntensity", "focusSoundTimerMode", "focusSoundTimerMinutes", "focusSoundBreakMinutes"]) {
    $(`#${id}`).addEventListener("change", async () => {
      try {
        await focusSound.saveSettings();
        toast("Focus sound saved");
      } catch (error) {
        toast(errorMessage(error));
      }
      await refresh();
    });
  }

  $("#focusSoundVolume").addEventListener("input", () => {
    focusSound.setVolume(Number($("#focusSoundVolume").value || 0));
  });

  $("#focusSoundVolume").addEventListener("change", async () => {
    try {
      await focusSound.saveSettings();
      toast("Focus sound saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#profileSelect").addEventListener("change", async (event: Event) => {
    state.selectedProfileId = eventTarget(event).value;
    await post("/api/settings", { activeProfileId: state.selectedProfileId });
    await refresh();
  });

  $("#profileForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.blockedApps = lines(body.blockedApps);
    body.blockedSites = lines(body.blockedSites);
    body.blockedUrlPatterns = lines(body.blockedUrlPatterns);
    body.allowedApps = lines(body.allowedApps);
    body.allowedSites = lines(body.allowedSites);
    await post("/api/profile", body);
    toast("Profile saved");
    await refresh();
  });

  $("#scheduleForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.commitmentLock = form.has("commitmentLock");
    body.days = [...$$("#scheduleDays input:checked")].map((input) => Number(input.value));
    body.wifiNetworks = lines(body.wifiNetworks);
    body.profileId = state.data?.state.settings.activeProfileId || "";
    body.lockLevel = "deep";
    await post("/api/schedule", body);
    toast("Schedule saved");
    resetScheduleForm();
    await refresh();
  });

  $("#newSchedule").addEventListener("click", resetScheduleForm);
  $("#grayscaleSettingsForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      await post("/api/grayscale/settings", {
        softBlockEnabled: $("#grayscaleSoftBlockEnabled").checked,
        preventManualChanges: $("#grayscalePreventManualChanges").checked
      });
      toast("Grayscale saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#grayscaleScheduleForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.days = [...$$("#grayscaleScheduleDays input:checked")].map((input) => Number(input.value));
    body.deviceTargets = [...$$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']:checked")].map((input) => input.value);
    await post("/api/grayscale/schedule", body);
    toast("Grayscale schedule saved");
    resetGrayscaleScheduleForm();
    await refresh();
  });

  $("#newGrayscaleSchedule").addEventListener("click", resetGrayscaleScheduleForm);
  $("#newLimit").addEventListener("click", resetLimitForm);
  $("#newAppLock").addEventListener("click", resetAppLockForm);
  $("#newIntentionalRule").addEventListener("click", resetIntentionalRuleForm);
  $("#newBehavior").addEventListener("click", resetBehaviorForm);
  $("#newPlanItem").addEventListener("click", resetPlanItemForm);
  $("#newPlanBlock").addEventListener("click", resetPlanBlockForm);

  $("#planListForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    body.active = new FormData(form).has("active");
    try {
      await post("/api/intentional-use/plan/list", body);
      toast("List saved");
      resetPlanListForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#planItemForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    body.tags = tagList(body.tags);
    body.dueAt = body.dueAt ? new Date(String(body.dueAt)).toISOString() : null;
    try {
      await post("/api/intentional-use/plan/item", body);
      toast("Item saved");
      resetPlanItemForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#planBlockForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    body.enabled = new FormData(form).has("enabled");
    body.commitmentLock = new FormData(form).has("commitmentLock");
    body.deviceTargets = [...$$<HTMLInputElement>("#planBlockForm input[name='deviceTargets']:checked")].map((input) => input.value);
    body.startsAt = body.startsAt ? new Date(String(body.startsAt)).toISOString() : new Date().toISOString();
    body.endsAt = body.endsAt ? new Date(String(body.endsAt)).toISOString() : new Date(Date.now() + 60 * 60 * 1000).toISOString();
    body.listId = selectedPlanItemListId(String(body.itemId || ""));
    try {
      await post("/api/intentional-use/plan/block", body);
      toast("Block saved");
      resetPlanBlockForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#limitForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.days = [...$$("#limitDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    await post("/api/limit", body);
    toast("Limit saved");
    resetLimitForm();
    await refresh();
  });

  $("#appLockForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.days = [...$$("#appLockDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    await post("/api/app-lock", body);
    toast("App lock saved");
    resetAppLockForm();
    await refresh();
  });

  $("#intentionalGoalForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      await post("/api/settings", { intentionalUseEnabled: $("#intentionalUseEnabled").checked });
      await post("/api/intentional-use/goal", {
        statement: $("#intentionalGoalStatement").value,
        values: lines($("#intentionalGoalValues").value),
        replacements: lines($("#intentionalGoalReplacements").value)
      });
      toast("Intentional goal saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#intentionalRuleForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.days = [...$$("#intentionalDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    body.urlPatterns = lines(body.urlPatterns);
    try {
      await post("/api/intentional-use/rule", body);
      toast("Pause rule saved");
      resetIntentionalRuleForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#accountabilityForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      await post("/api/intentional-use/accountability", {
        enabled: $("#accountabilityEnabled").checked,
        partnerName: $("#accountabilityPartner").value,
        cadence: $("#accountabilityCadence").value
      });
      toast("Digest settings saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#applyRecoverySetup").addEventListener("click", async () => {
    try {
      await post("/api/intentional-use/recovery/setup", {
        statement: $("#intentionalGoalStatement").value,
        values: lines($("#intentionalGoalValues").value),
        replacements: lines($("#intentionalGoalReplacements").value)
      });
      toast("Recovery setup applied");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#journalEntryForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    body.tags = tagList(body.tags);
    body.behaviorIds = selectedValues("#journalBehaviorIds");
    body.ruleIds = selectedValues("#journalRuleIds");
    body.entryDate = body.entryDate ? new Date(String(body.entryDate)).toISOString() : new Date().toISOString();
    try {
      await post("/api/intentional-use/journal", body);
      toast("Reflection saved");
      resetJournalForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#recoveryCheckInForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    try {
      await post("/api/intentional-use/recovery/check-in", body);
      toast("Recovery check-in added");
      form.reset();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#sosForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    try {
      const response = await post<{ session?: DashboardItem & { plan?: string[] } }>("/api/intentional-use/recovery/sos", body);
      toast("SOS reset started");
      renderSosPlan(response.session || null);
      form.reset();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#behaviorForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    body.active = new FormData(form).has("active");
    body.ruleIds = selectedValues("#behaviorRuleIds");
    try {
      await post("/api/intentional-use/behavior", body);
      toast("Behavior saved");
      resetBehaviorForm();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#behaviorCheckInForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const body = formPayload(new FormData(form));
    if (!body.behaviorId) {
      toast("Save a behavior first");
      return;
    }
    try {
      await post("/api/intentional-use/behavior/check-in", body);
      toast("Check-in added");
      form.reset();
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#copyAccountabilityDigest").addEventListener("click", async () => {
    await hardeningPanel.copyText($("#accountabilityDigest").textContent || "", "Digest copied");
  });

  $("#requestEmergency").addEventListener("click", async () => {
    try {
      const reason = $("#emergencyReason").value.trim();
      const response = await post<PendingResponse>("/api/emergency/request", { reason });
      state.pendingEmergencyId = response.pending?.id || null;
      toast("Emergency cooldown started");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#confirmEmergency").addEventListener("click", async () => {
    if (!state.pendingEmergencyId) return;
    try {
      await post("/api/emergency/confirm", {
        requestId: state.pendingEmergencyId,
        passcode: $("#emergencyPasscode").value,
        distanceKey: $("#emergencyDistanceKey").value,
        challengeText: $("#emergencyChallengeInput").value
      });
      state.pendingEmergencyId = null;
      $("#emergencyReason").value = "";
      $("#emergencyPasscode").value = "";
      $("#emergencyDistanceKey").value = "";
      $("#emergencyChallengeInput").value = "";
      toast("Emergency unlock used");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#requestMaintenance").addEventListener("click", async () => {
    try {
      const reason = $("#maintenanceReason").value.trim();
      const response = await post<PendingResponse>("/api/protection/maintenance/request", { reason });
      state.pendingMaintenanceId = response.pending?.id || null;
      toast(response.activeWindow ? "Maintenance already open" : "Maintenance cooldown started");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#confirmMaintenance").addEventListener("click", async () => {
    if (!state.pendingMaintenanceId) return;
    try {
      await post("/api/protection/maintenance/confirm", {
        requestId: state.pendingMaintenanceId,
        passcode: $("#maintenancePasscode").value,
        distanceKey: $("#maintenanceDistanceKey").value,
        challengeText: $("#maintenanceChallengeInput").value
      });
      state.pendingMaintenanceId = null;
      $("#maintenanceReason").value = "";
      $("#maintenancePasscode").value = "";
      $("#maintenanceDistanceKey").value = "";
      $("#maintenanceChallengeInput").value = "";
      toast("Maintenance opened");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#keyholderForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      await post("/api/keyholder", {
        enabled: $("#keyholderEnabled").checked,
        passcode: $("#keyholderPasscode").value
      });
      $("#keyholderPasscode").value = "";
      toast("Keyholder saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#distanceKeyForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    try {
      const result = await post<DistanceKeyResponse>("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        token: $("#distanceKeyTokenInput").value,
        keyFilePath: $("#distanceKeyFilePath").value
      });
      $("#distanceKeyTokenInput").value = "";
      distanceKeyUi.hideToken();
      if (result.token) distanceKeyUi.showToken(result.token);
      toast("Distance key saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#rotateDistanceKey").addEventListener("click", async () => {
    try {
      const result = await post<DistanceKeyResponse>("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        keyFilePath: $("#distanceKeyFilePath").value,
        rotate: true
      });
      distanceKeyUi.showToken(result.token || "");
      toast("Distance key generated");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#writeDistanceKeyFile").addEventListener("click", async () => {
    try {
      const result = await post<DistanceKeyResponse>("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        keyFilePath: $("#distanceKeyFilePath").value,
        writeKeyFile: true
      });
      distanceKeyUi.hideToken();
      toast(result.keyFilePath ? "Distance key file written" : "Distance key saved");
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  });

  $("#printDistanceKey").addEventListener("click", distanceKeyUi.print);
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
    toast(kind === "brick" ? "Full Brick profile is unavailable" : "Soft Block profile is unavailable");
    return;
  }

  const button = kind === "brick" ? $("#startFullBrick") : $("#startSoftBlock");
  const status = $("#brickStatus");
  button.disabled = true;
  status.textContent = "Starting...";
  try {
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
          title: "Soft Block",
          mode: "focus",
          profileId: SOFT_BLOCK_PROFILE_ID,
          durationMinutes: $("#brickDuration").value,
          lockLevel: "light",
          commitmentLock: false,
          deviceTargets: selectedDeviceTargets()
        };
    await post("/api/session/start", body);
    status.textContent = kind === "brick" ? "Full Brick active" : "Soft Block active";
    toast(`${kind === "brick" ? "Full Brick" : "Soft Block"} started for ${selectedDeviceLabel()}`);
  } catch (error) {
    status.textContent = errorMessage(error);
    toast(errorMessage(error));
  }
  await refresh();
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
  renderLifeLog(data.intentionalUse);
  hardeningPanel.render(data);
  renderProfiles(data.state);
  renderSchedules(data.state.schedules);
  renderGrayscale(data);
  renderLimits(data.limits.rules);
  renderAppLocks(data.appLocks.rules);
  renderBars("#appBars", data.usage.topApps);
  renderBars("#siteBars", data.usage.topSites);
  renderReport(data.report);
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
    if (!selectedActive && ["Full Brick active", "Soft Block active"].includes($("#brickStatus").textContent)) $("#brickStatus").textContent = "Normal baseline";
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
  const orb = $("#sentinelOrb");
  if (!orb) return;
  orb.className = `sentinel-orb ${orbState}`;
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

  fillSelect($("#profileSelect"), profiles, state.selectedProfileId);
  fillSelect($("#sessionProfile"), profiles, activeId);
  fillSelect($("#planBlockProfileId"), profiles, SOFT_BLOCK_PROFILE_ID);

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
    edit.addEventListener("click", () => loadSchedule(schedule));

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
    edit.addEventListener("click", () => loadGrayscaleSchedule(schedule));

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
    const label = progressBlock(
      rule.name,
      `${rule.type} | ${progressText(rule, used, cap)} | ${daysText(rule.days || [])} | ${rule.enabled ? "on" : "off"}${rule.activeBlock ? " | locked" : ""}`,
      rule.percent || 0
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => loadLimit(rule));

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
    edit.addEventListener("click", () => loadAppLock(rule));

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
    edit.addEventListener("click", () => loadIntentionalRule(rule));

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

function renderLifeLog(intentionalUse: IntentionalUseSummary): void {
  const lifeLog = intentionalUse?.lifeLog || {};
  const stats = lifeLog.stats || {};
  const recovery = intentionalUse?.recovery || {};
  const recoveryWeek = recovery.week || {};
  const behaviors = lifeLog.behaviors || [];
  const planner = lifeLog.planner || {};
  const activeBehaviors = behaviors.filter((behavior) => behavior.active !== false);
  const rules = intentionalUse?.rules || [];

  $("#lifeLogStatus").textContent = `${stats.entriesThisWeek || 0} reflections | ${stats.activeBehaviors || 0} behaviors | ${planner.openItems || 0} items | ${(planner.activeBlocks || []).length} blocks`;
  $("#lifeLogStatus").className = (stats.entriesThisWeek || stats.behaviorCheckInsThisWeek || recoveryWeek.checkIns || planner.openItems || (planner.activeBlocks || []).length) ? "pill good" : "pill neutral";
  $("#journalWeekCount").textContent = String(stats.entriesThisWeek || 0);
  $("#behaviorWeekCount").textContent = String(stats.behaviorCheckInsThisWeek || 0);
  $("#reflectionStreak").textContent = `${stats.reflectionStreakDays || 0}d`;
  $("#recoveryWeekCount").textContent = String(recoveryWeek.checkIns || 0);
  $("#recoverySetbacks").textContent = String(recoveryWeek.setbacks || 0);
  $("#recoverySosCount").textContent = String(recoveryWeek.sos || 0);

  renderMultiSelect($("#journalBehaviorIds"), activeBehaviors);
  renderMultiSelect($("#journalRuleIds"), rules);
  renderMultiSelect($("#behaviorRuleIds"), rules);
  renderBehaviorCheckInSelect(activeBehaviors);
  renderBehaviorList(behaviors);
  renderBehaviorCheckIns(lifeLog.recentCheckIns || []);
  renderPlanner(planner);
  renderRecoveryCheckIns(recovery.recentCheckIns || []);
  renderSosPlan((recovery.recentSos || [])[0] || null);
  renderSosSessions(recovery.recentSos || []);
  renderJournalEntries(lifeLog.entries || [], behaviors, rules);
}

function renderBehaviorList(behaviors: DashboardItem[]): void {
  const list = $("#behaviorList");
  list.replaceChildren();
  if (!behaviors.length) {
    list.append(empty("No behaviors saved"));
    return;
  }

  for (const behavior of behaviors) {
    const row = document.createElement("div");
    row.className = behavior.active === false ? "list-item limit-item muted-item" : "list-item limit-item";
    const percent = Math.max(4, Math.min(100, Number(behavior.percent || 0)));
    const target = behavior.weeklyTarget ? `${behavior.weeklyValue || 0}/${behavior.weeklyTarget} ${behavior.unit || "count"}` : `${behavior.weeklyCheckIns || 0} check-ins`;
    const label = progressBlock(
      behavior.name,
      `${behavior.direction || "build"} | ${target} this week | ${behavior.active === false ? "archived" : "active"}`,
      percent
    );

    const edit = document.createElement("button");
    edit.className = "secondary";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => loadBehavior(behavior));

    const archive = document.createElement("button");
    archive.className = "ghost";
    archive.type = "button";
    archive.textContent = behavior.active === false ? "Archived" : "Archive";
    archive.disabled = behavior.active === false;
    archive.addEventListener("click", async () => {
      await del(`/api/intentional-use/behavior/${encodeURIComponent(behavior.id)}`);
      toast("Behavior archived");
      await refresh();
    });

    row.append(label, edit, archive);
    list.append(row);
  }
}

function renderBehaviorCheckIns(checkIns: DashboardItem[]): void {
  const list = $("#behaviorCheckInList");
  list.replaceChildren();
  if (!checkIns.length) {
    list.append(empty("No check-ins yet"));
    return;
  }

  for (const checkIn of checkIns.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "list-item compact-list-item";
    row.append(
      detailBlock(
        checkIn.behaviorName || checkIn.name || "Behavior",
        `${checkIn.value || 0} | ${checkIn.at ? shortDateTime(checkIn.at) : "--"}${checkIn.note ? ` | ${checkIn.note}` : ""}`
      )
    );
    list.append(row);
  }
}

function renderPlanner(planner: NonNullable<NonNullable<IntentionalUseSummary["lifeLog"]>["planner"]> = {}): void {
  const lists = planner.lists || [];
  const items = planner.items || [];
  const activeLists = lists.filter((list) => list.active !== false);
  renderPlanSelects(activeLists, items);
  renderPlanItems(planner.recentItems || items.filter((item) => item.status === "open"), activeLists);
  renderPlannerAgenda(planner.todayBlocks || [], planner.activeBlocks || []);
}

function renderPlanSelects(lists: IntentionalPlanList[], items: IntentionalPlanItem[]): void {
  const safeLists = lists.length ? lists : [{ id: "todo", name: "To Do" } as IntentionalPlanList];
  fillSelect($("#planItemListId"), safeLists, safeLists[0]?.id || "");
  renderPlanBlockItemSelect(items.filter((item) => item.status !== "archived"));
}

function renderPlanBlockItemSelect(items: IntentionalPlanItem[]): void {
  const select = $("#planBlockItemId");
  const current = select.value;
  select.replaceChildren();
  const emptyOption = document.createElement("option");
  emptyOption.value = "";
  emptyOption.textContent = "No linked item";
  select.append(emptyOption);
  for (const item of items.slice(0, 80)) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.title;
    select.append(option);
  }
  select.value = items.some((item) => item.id === current) ? current : "";
}

function renderPlanItems(items: IntentionalPlanItem[], lists: IntentionalPlanList[]): void {
  const root = $("#planItemList");
  root.replaceChildren();
  if (!items.length) {
    root.append(empty("No items saved"));
    return;
  }

  const listNames = new Map(lists.map((list) => [list.id, list.name]));
  for (const item of items.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = item.status === "done" ? "list-item limit-item muted-item" : "list-item limit-item";
    const meta = [
      listNames.get(item.listId) || item.listId || "List",
      item.status,
      item.dueAt ? `due ${shortDateTime(item.dueAt)}` : "",
      ...(item.tags || []).slice(0, 3)
    ].filter(Boolean).join(" | ");
    const label = detailBlock(item.title, meta || "--");

    const schedule = compactButton("Schedule", () => loadPlanBlockFromItem(item));
    const done = compactButton(item.status === "done" ? "Open" : "Done", async () => {
      await savePlanItem(item, { status: item.status === "done" ? "open" : "done" });
      toast(item.status === "done" ? "Item reopened" : "Item completed");
      await refresh();
    });
    const edit = compactButton("Edit", () => loadPlanItem(item), "secondary");
    const archive = compactButton("Archive", async () => {
      await del(`/api/intentional-use/plan/item/${encodeURIComponent(item.id)}`);
      toast("Item archived");
      await refresh();
    }, "ghost");

    row.append(label, schedule, done, edit, archive);
    root.append(row);
  }
}

function renderPlannerAgenda(blocks: IntentionalPlanBlock[], activeBlocks: IntentionalPlanBlock[]): void {
  const root = $("#plannerAgenda");
  root.replaceChildren();
  if (!blocks.length) {
    root.append(empty("No blocks today"));
    return;
  }

  const activeIds = new Set(activeBlocks.map((block) => block.id));
  for (const block of blocks.slice(0, 12)) {
    const row = document.createElement("div");
    row.className = activeIds.has(block.id) ? "planner-block active" : "planner-block";
    const profile = profileName(block.profileId);
    const time = `${shortDateTime(block.startsAt)} - ${shortTime(block.endsAt)}`;
    const meta = [
      time,
      profile,
      deviceTargetsText(block.deviceTargets || []),
      block.enabled === false ? "off" : "on",
      block.completed ? "done" : ""
    ].filter(Boolean).join(" | ");

    const label = detailBlock(block.title, meta);
    const actions = el("div", { className: "planner-actions" },
      compactButton("Earlier", () => adjustPlanBlock(block, { shiftMinutes: -15 }), "ghost"),
      compactButton("Later", () => adjustPlanBlock(block, { shiftMinutes: 15 }), "ghost"),
      compactButton("Shorter", () => adjustPlanBlock(block, { durationMinutes: -15 }), "ghost"),
      compactButton("Longer", () => adjustPlanBlock(block, { durationMinutes: 15 }), "ghost"),
      compactButton("Edit", () => loadPlanBlock(block), "secondary"),
      compactButton(block.completed ? "Open" : "Done", () => adjustPlanBlock(block, { completed: !block.completed }), "secondary"),
      compactButton("Delete", async () => {
        await del(`/api/intentional-use/plan/block/${encodeURIComponent(block.id)}`);
        toast("Block deleted");
        await refresh();
      }, "ghost")
    );

    row.append(label, actions);
    root.append(row);
  }
}

function compactButton(text: string, onClick: () => void | Promise<void>, className = "secondary"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `${className} compact`;
  button.textContent = text;
  button.addEventListener("click", () => {
    void onClick();
  });
  return button;
}

async function savePlanItem(item: IntentionalPlanItem, overrides: Partial<IntentionalPlanItem> = {}): Promise<void> {
  await post("/api/intentional-use/plan/item", { ...item, ...overrides });
}

async function adjustPlanBlock(block: IntentionalPlanBlock, options: { shiftMinutes?: number; durationMinutes?: number; completed?: boolean }): Promise<void> {
  const startsAt = new Date(block.startsAt);
  const endsAt = new Date(block.endsAt);
  const shiftMs = Number(options.shiftMinutes || 0) * 60 * 1000;
  startsAt.setTime(startsAt.getTime() + shiftMs);
  endsAt.setTime(endsAt.getTime() + shiftMs + Number(options.durationMinutes || 0) * 60 * 1000);
  if (endsAt.getTime() <= startsAt.getTime() + 15 * 60 * 1000) {
    endsAt.setTime(startsAt.getTime() + 15 * 60 * 1000);
  }
  await post("/api/intentional-use/plan/block", {
    ...block,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    completed: options.completed ?? block.completed
  });
  toast("Block updated");
  await refresh();
}

function renderRecoveryCheckIns(checkIns: NonNullable<IntentionalUseSummary["recovery"]>["recentCheckIns"] = []): void {
  const list = $("#recoveryCheckInList");
  list.replaceChildren();
  if (!checkIns.length) {
    list.append(empty("No recovery check-ins yet"));
    return;
  }

  for (const checkIn of checkIns.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "list-item compact-list-item";
    const meta = [
      checkIn.at ? shortDateTime(checkIn.at) : "",
      checkIn.urgeIntensity !== undefined ? `urge ${checkIn.urgeIntensity}/10` : "",
      checkIn.stress !== null && checkIn.stress !== undefined ? `stress ${checkIn.stress}/10` : "",
      checkIn.trigger ? `trigger: ${checkIn.trigger}` : "",
      checkIn.action ? `action: ${checkIn.action}` : ""
    ].filter(Boolean).join(" | ");
    row.append(detailBlock(recoveryLabel(checkIn.status), `${meta || "--"}${checkIn.note ? ` | ${checkIn.note}` : ""}`));
    list.append(row);
  }
}

function renderSosPlan(session: (DashboardItem & { plan?: string[] }) | null): void {
  const list = $("#sosPlan");
  list.replaceChildren();
  const plan = Array.isArray(session?.plan) ? session.plan : [];
  if (!plan.length) {
    list.append(empty("No SOS plan started"));
    return;
  }

  for (const step of plan.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "list-item compact-list-item";
    row.append(detailBlock("Reset step", step));
    list.append(row);
  }
}

function renderSosSessions(sessions: NonNullable<IntentionalUseSummary["recovery"]>["recentSos"] = []): void {
  const list = $("#sosSessionList");
  list.replaceChildren();
  if (!sessions.length) {
    list.append(empty("No SOS starts yet"));
    return;
  }

  for (const session of sessions.slice(0, 5)) {
    const row = document.createElement("div");
    row.className = "list-item compact-list-item";
    const meta = [
      session.startedAt ? shortDateTime(session.startedAt) : "",
      session.urgeIntensity !== undefined ? `urge ${session.urgeIntensity}/10` : "",
      session.trigger ? `trigger: ${session.trigger}` : "",
      session.replacement ? `replacement: ${session.replacement}` : ""
    ].filter(Boolean).join(" | ");
    row.append(detailBlock(recoveryLabel(session.intent || "SOS"), meta || "--"));
    list.append(row);
  }
}

function recoveryLabel(value: unknown): string {
  return String(value || "recovery")
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function renderJournalEntries(entries: DashboardItem[], behaviors: DashboardItem[], rules: DashboardItem[]): void {
  const list = $("#journalEntryList");
  list.replaceChildren();
  if (!entries.length) {
    list.append(empty("No reflections saved"));
    return;
  }

  const behaviorNames = new Map(behaviors.map((behavior) => [behavior.id, behavior.name]));
  const ruleNames = new Map(rules.map((rule) => [rule.id, rule.name]));
  for (const entry of entries.slice(0, 12)) {
    const article = document.createElement("article");
    article.className = "journal-entry";
    const metaParts = [
      entry.entryDate ? shortDateTime(entry.entryDate) : "",
      entry.mood,
      entry.energy ? `energy ${entry.energy}/10` : ""
    ].filter(Boolean);
    const linked = [
      ...(entry.behaviorIds || []).map((id) => behaviorNames.get(id) || id),
      ...(entry.ruleIds || []).map((id) => ruleNames.get(id) || id)
    ].filter(Boolean);
    const tagLine = [...(entry.tags || []), ...linked].slice(0, 8);

    const head = el(
      "div",
      { className: "journal-entry-head" },
      textEl("strong", entry.title || "Reflection"),
      textEl("span", metaParts.join(" | ") || "--")
    );
    const body = textEl("p", entry.body || "", { className: "journal-entry-body" });
    const tags = el("div", { className: "tag-row" }, tagLine.map((tag) => textEl("span", tag)));
    const actions = el("div", { className: "journal-entry-actions" });

    const edit = document.createElement("button");
    edit.className = "secondary compact";
    edit.type = "button";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => loadJournalEntry(entry));

    const remove = document.createElement("button");
    remove.className = "ghost compact";
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await del(`/api/intentional-use/journal/${encodeURIComponent(entry.id)}`);
      toast("Reflection deleted");
      await refresh();
    });

    actions.append(edit, remove);
    article.append(head, body);
    if (tagLine.length) article.append(tags);
    article.append(actions);
    list.append(article);
  }
}

function renderBars(selector: string, entries: BarEntry[]): void {
  const root = $(selector);
  root.replaceChildren();
  if (!entries.length) {
    root.append(empty("No activity yet"));
    return;
  }

  const max = Math.max(...entries.map((item) => item.seconds || 0), 1);
  for (const item of entries) {
    const seconds = item.seconds || 0;
    const fill = el("div", { className: "bar-fill" });
    fill.style.width = `${Math.max(4, Math.round((seconds / max) * 100))}%`;
    const row = el(
      "div",
      { className: "bar-row" },
      textEl("div", item.name || item.label || "", { className: "bar-name" }),
      el("div", { className: "bar-track" }, fill),
      textEl("div", formatDuration(seconds), { className: "bar-time" })
    );
    root.append(row);
  }
}

function renderReport(report: ReportSummary): void {
  if (!report) return;
  $("#reportRange").textContent = `${shortDate(report.currentWeek.startsAt)} - ${shortDate(report.currentWeek.endsAt)}`;
  $("#weekFocusScore").textContent = String(report.currentWeek.totals.averageFocusScore);
  $("#weekScoreDelta").textContent = signedNumber(report.comparison?.focusScoreDelta, " pts");
  $("#weekSaved").textContent = formatDuration(report.currentWeek.totals.distractingSeconds);
  $("#weekSavedDelta").textContent = signedDuration(report.comparison?.distractingSecondsDelta);
  $("#focusStreak").textContent = report.streak.label;
  $("#streakGoal").textContent = `${report.streak.goal}+ score goal`;
  const progression = report.progression;
  $("#progressLevelReport").textContent = progression ? `${progression.level}` : "--";
  $("#xpProgress").textContent = progression ? `${progression.title} | ${progression.currentLevelXp}/${progression.nextLevelXp} XP` : "--";
  $("#levelProgressFill").style.width = `${progression?.levelProgressPercent || 0}%`;
  $("#yearPace").textContent = formatDuration(report.currentWeek.totals.averageDailyDistractionSeconds);
  $("#decadePace").textContent = daysWithDataText(report.currentWeek.totals.trackedDays);
  $("#openPressure").textContent = String(report.currentWeek.totals.averageDailyOpens || 0);
  $("#openPressureMeta").textContent = progression ? `${progression.brainState} brain health` : "avg opens / day";
  $("#reportJournalEntries").textContent = String(progression?.journalEntries || 0);
  $("#reportReflectionStreak").textContent = progression ? `${progression.reflectionStreakDays || 0} day streak` : "--";
  $("#reportBehaviorCheckIns").textContent = String(progression?.behaviorCheckIns || 0);
  $("#reportNextUnlock").textContent = progression?.nextUnlock || "--";
  $("#reportRecoveryCheckIns").textContent = String(progression?.recoveryCheckIns || 0);
  $("#reportRecoveryMeta").textContent = progression ? `${progression.sosStarts || 0} SOS | ${progression.setbacks || 0} setbacks` : "--";
  renderWeekStrip(report.currentWeek.days, report.focusScoreGoal);
  renderInsights(report.insights);
  renderMilestones(report.milestones);
}

function renderWeekStrip(days: WeekDaySummary[], goal: number): void {
  const root = $("#weekStrip");
  root.replaceChildren();
  for (const day of days) {
    const item = document.createElement("div");
    item.className = `week-day ${day.tracked ? "tracked" : ""} ${(day.focusScore || 0) >= goal && day.tracked ? "hit" : ""}`;
    item.append(
      textEl("span", day.label),
      textEl("strong", day.tracked ? String(day.focusScore || 0) : "--"),
      textEl("em", day.tracked ? formatDuration(Number(day.distractingSeconds || 0)) : "no data")
    );
    root.append(item);
  }
}

function renderInsights(items: string[]): void {
  const root = $("#reportInsights");
  root.replaceChildren();
  for (const item of items || []) {
    const row = document.createElement("div");
    row.className = "insight";
    row.textContent = item;
    root.append(row);
  }
}

function renderMilestones(items: DashboardItem[]): void {
  const root = $("#milestones");
  root.replaceChildren();
  const badges = state.data?.report?.progression?.badges || [];
  for (const badge of badges) {
    const row = document.createElement("div");
    row.className = badge.earned ? "milestone achieved" : "milestone";
    row.append(textEl("span", badge.earned ? "Earned" : "Next"), textEl("strong", badge.label));
    root.append(row);
  }
  for (const item of items || []) {
    const row = document.createElement("div");
    row.className = item.achieved ? "milestone achieved" : "milestone";
    row.append(textEl("span", item.achieved ? "Done" : "Next"), textEl("strong", item.label));
    root.append(row);
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
  const active = appState.activePolicy;
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if ((!active || active.session.canEndEarly) && !activeLimitBlocks.length) {
    panel.classList.add("hidden");
    state.pendingEmergencyId = null;
    renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), null);
    return;
  }

  panel.classList.remove("hidden");
  if (active && active.session?.emergencyUnlocksAllowed === false) {
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

function loadSchedule(schedule: Schedule): void {
  const form = $("#scheduleForm");
  form.elements.id.value = schedule.id;
  form.elements.name.value = schedule.name;
  form.elements.mode.value = schedule.mode;
  form.elements.start.value = schedule.start;
  form.elements.end.value = schedule.end;
  form.elements.wifiNetworks.value = (schedule.wifiNetworks || []).join("\n");
  form.elements.enabled.checked = Boolean(schedule.enabled);
  form.elements.commitmentLock.checked = Boolean(schedule.commitmentLock);
  for (const input of $$("#scheduleDays input")) {
    input.checked = schedule.days.includes(Number(input.value));
  }
}

function loadGrayscaleSchedule(schedule: GrayscaleSchedule): void {
  const form = $("#grayscaleScheduleForm");
  form.elements.id.value = schedule.id;
  form.elements.name.value = schedule.name;
  form.elements.start.value = schedule.start;
  form.elements.end.value = schedule.end;
  form.elements.enabled.checked = Boolean(schedule.enabled);
  for (const input of $$("#grayscaleScheduleDays input")) {
    input.checked = schedule.days.includes(Number(input.value));
  }
  const targets = new Set(schedule.deviceTargets || ["computer", "phone"]);
  for (const input of $$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']")) {
    input.checked = targets.has(input.value as "computer" | "phone");
  }
}

function loadAppLock(rule: DashboardItem): void {
  const form = $("#appLockForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.unlocksAllowed.value = String(rule.unlocksAllowed || 0);
  form.elements.unlockMinutes.value = String(rule.unlockMinutes || 0);
  form.elements.delaySeconds.value = String(rule.delaySeconds || 0);
  form.elements.lockLevel.value = rule.lockLevel || "deep";
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of $$("#appLockDays input")) {
    input.checked = (rule.days || []).includes(Number(input.value));
  }
}

function resetAppLockForm(): void {
  const form = $("#appLockForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Locked socials";
  form.elements.unlocksAllowed.value = "2";
  form.elements.unlockMinutes.value = "10";
  form.elements.delaySeconds.value = "30";
  form.elements.lockLevel.value = "deep";
  form.elements.enabled.checked = false;
  for (const input of $$("#appLockDays input")) {
    input.checked = true;
  }
}

function loadIntentionalRule(rule: DashboardItem): void {
  const form = $("#intentionalRuleForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.frictionLevel.value = rule.frictionLevel || "standard";
  form.elements.delaySeconds.value = String(rule.delaySeconds || 12);
  form.elements.sessionMinutes.value = String(rule.sessionMinutes || 10);
  form.elements.dailyBudgetMinutes.value = String(rule.dailyBudgetMinutes || 30);
  form.elements.start.value = rule.start || "00:00";
  form.elements.end.value = rule.end || "23:59";
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.urlPatterns.value = (rule.urlPatterns || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of $$("#intentionalDays input")) {
    input.checked = (rule.days || []).includes(Number(input.value));
  }
}

function resetIntentionalRuleForm(): void {
  const form = $("#intentionalRuleForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Short-form pause";
  form.elements.frictionLevel.value = "standard";
  form.elements.delaySeconds.value = "12";
  form.elements.sessionMinutes.value = "10";
  form.elements.dailyBudgetMinutes.value = "30";
  form.elements.start.value = "00:00";
  form.elements.end.value = "23:59";
  form.elements.enabled.checked = true;
  form.elements.urlPatterns.value = "youtube.com/shorts\nm.youtube.com/shorts";
  for (const input of $$("#intentionalDays input")) {
    input.checked = true;
  }
}

function loadBehavior(behavior: DashboardItem): void {
  const form = $("#behaviorForm");
  form.elements.id.value = behavior.id;
  form.elements.name.value = behavior.name;
  form.elements.description.value = behavior.description || "";
  form.elements.direction.value = behavior.direction || "build";
  form.elements.unit.value = behavior.unit || "count";
  form.elements.weeklyTarget.value = String(behavior.weeklyTarget || 0);
  form.elements.replacement.value = behavior.replacement || "";
  form.elements.active.checked = behavior.active !== false;
  setSelectedOptions($("#behaviorRuleIds"), behavior.ruleIds || []);
  setView("journal");
}

function resetBehaviorForm(): void {
  const form = $("#behaviorForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Evening phone shutdown";
  form.elements.description.value = "";
  form.elements.direction.value = "build";
  form.elements.unit.value = "count";
  form.elements.weeklyTarget.value = "5";
  form.elements.replacement.value = "";
  form.elements.active.checked = true;
  setSelectedOptions($("#behaviorRuleIds"), []);
}

function loadJournalEntry(entry: DashboardItem): void {
  const form = $("#journalEntryForm");
  form.elements.id.value = entry.id;
  form.elements.title.value = entry.title || "";
  form.elements.mood.value = entry.mood || "";
  form.elements.body.value = entry.body || "";
  form.elements.energy.value = entry.energy ? String(entry.energy) : "";
  form.elements.tags.value = (entry.tags || []).join(", ");
  form.elements.entryDate.value = toDateTimeLocal(entry.entryDate || entry.createdAt);
  setSelectedOptions($("#journalBehaviorIds"), entry.behaviorIds || []);
  setSelectedOptions($("#journalRuleIds"), entry.ruleIds || []);
  setView("journal");
}

function resetJournalForm(): void {
  const form = $("#journalEntryForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.entryDate.value = toDateTimeLocal(new Date().toISOString());
  setSelectedOptions($("#journalBehaviorIds"), []);
  setSelectedOptions($("#journalRuleIds"), []);
}

function loadPlanItem(item: IntentionalPlanItem): void {
  const form = $("#planItemForm");
  form.elements.id.value = item.id;
  form.elements.listId.value = item.listId;
  form.elements.status.value = item.status;
  form.elements.title.value = item.title;
  form.elements.notes.value = item.notes || "";
  form.elements.dueAt.value = item.dueAt ? toDateTimeLocal(item.dueAt) : "";
  form.elements.tags.value = (item.tags || []).join(", ");
  setView("journal");
}

function resetPlanItemForm(): void {
  const form = $("#planItemForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.title.value = "Homework";
  form.elements.status.value = "open";
  form.elements.notes.value = "";
  form.elements.dueAt.value = "";
  form.elements.tags.value = "";
  const firstList = (state.data?.intentionalUse?.lifeLog?.planner?.lists || []).find((list) => list.active !== false);
  form.elements.listId.value = firstList?.id || "todo";
}

function resetPlanListForm(): void {
  const form = $("#planListForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "To Do";
  form.elements.kind.value = "todo";
  form.elements.active.checked = true;
}

function loadPlanBlockFromItem(item: IntentionalPlanItem): void {
  resetPlanBlockForm();
  const form = $("#planBlockForm");
  form.elements.title.value = item.title;
  form.elements.itemId.value = item.id;
  form.elements.notes.value = item.notes || "";
  form.elements.mode.value = item.listId === "watchlist" ? "watch" : "focus";
  setView("journal");
}

function loadPlanBlock(block: IntentionalPlanBlock): void {
  const form = $("#planBlockForm");
  form.elements.id.value = block.id;
  form.elements.title.value = block.title;
  form.elements.itemId.value = block.itemId || "";
  form.elements.startsAt.value = toDateTimeLocal(block.startsAt);
  form.elements.endsAt.value = toDateTimeLocal(block.endsAt);
  form.elements.mode.value = block.mode || "focus";
  form.elements.profileId.value = block.profileId || state.data?.state.settings.activeProfileId || "";
  form.elements.lockLevel.value = block.lockLevel || "deep";
  form.elements.enabled.checked = block.enabled !== false;
  form.elements.commitmentLock.checked = Boolean(block.commitmentLock);
  form.elements.notes.value = block.notes || "";
  const targets = new Set(block.deviceTargets || ["computer", "phone"]);
  for (const input of $$<HTMLInputElement>("#planBlockForm input[name='deviceTargets']")) {
    input.checked = targets.has(input.value as "computer" | "phone");
  }
  setView("journal");
}

function resetPlanBlockForm(): void {
  const form = $("#planBlockForm");
  const start = nextQuarterHour();
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  form.reset();
  form.elements.id.value = "";
  form.elements.title.value = "Homework";
  form.elements.itemId.value = "";
  form.elements.startsAt.value = toDateTimeLocal(start.toISOString());
  form.elements.endsAt.value = toDateTimeLocal(end.toISOString());
  form.elements.mode.value = "focus";
  form.elements.profileId.value = SOFT_BLOCK_PROFILE_ID;
  form.elements.lockLevel.value = "deep";
  form.elements.enabled.checked = true;
  form.elements.commitmentLock.checked = false;
  form.elements.notes.value = "";
  for (const input of $$<HTMLInputElement>("#planBlockForm input[name='deviceTargets']")) {
    input.checked = true;
  }
}

function targetCount(rule: DashboardItem): number {
  return (rule.apps || []).length + (rule.sites || []).length + (rule.urlPatterns || []).length;
}

function loadLimit(rule: DashboardItem): void {
  const form = $("#limitForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.type.value = rule.type || "time";
  form.elements.lockLevel.value = rule.lockLevel || "deep";
  form.elements.limitMinutes.value = String(rule.limitMinutes || 0);
  form.elements.unlocksAllowed.value = String(rule.unlocksAllowed || 0);
  form.elements.blockMinutes.value = String(rule.blockMinutes || 0);
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of $$("#limitDays input")) {
    input.checked = (rule.days || []).includes(Number(input.value));
  }
}

function resetLimitForm(): void {
  const form = $("#limitForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Social cap";
  form.elements.type.value = "time";
  form.elements.lockLevel.value = "deep";
  form.elements.limitMinutes.value = "45";
  form.elements.unlocksAllowed.value = "5";
  form.elements.blockMinutes.value = "0";
  form.elements.enabled.checked = false;
  for (const input of $$("#limitDays input")) {
    input.checked = true;
  }
}

function resetScheduleForm(): void {
  const form = $("#scheduleForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Focus block";
  form.elements.mode.value = "focus";
  form.elements.start.value = "09:00";
  form.elements.end.value = "17:00";
  form.elements.wifiNetworks.value = "";
  form.elements.enabled.checked = false;
  form.elements.commitmentLock.checked = false;
  for (const input of $$("#scheduleDays input")) {
    input.checked = !["0", "6"].includes(input.value);
  }
}

function resetGrayscaleScheduleForm(): void {
  const form = $("#grayscaleScheduleForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Night grayscale";
  form.elements.start.value = "22:00";
  form.elements.end.value = "07:00";
  form.elements.enabled.checked = false;
  for (const input of $$("#grayscaleScheduleDays input")) {
    input.checked = true;
  }
  for (const input of $$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']")) {
    input.checked = true;
  }
}

function fillSelect(select: ControlElement, items: Array<{ id: string; name: string }>, selectedId: string | null): void {
  const current = select.value || selectedId || "";
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    select.append(option);
  }
  select.value = items.some((item) => item.id === current) ? current : (selectedId || "");
}

function renderMultiSelect(select: ControlElement, items: Array<{ id: string; name?: string; label?: string }>): void {
  const current = selectedValues(select);
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name || item.label || item.id;
    option.selected = current.includes(item.id);
    select.append(option);
  }
}

function renderBehaviorCheckInSelect(behaviors: Array<{ id: string; name?: string }>): void {
  const select = $("#behaviorCheckInId");
  const current = select.value;
  select.replaceChildren();
  if (!behaviors.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No behaviors saved";
    select.append(option);
    return;
  }
  for (const behavior of behaviors) {
    const option = document.createElement("option");
    option.value = behavior.id;
    option.textContent = behavior.name || behavior.id;
    select.append(option);
  }
  select.value = behaviors.some((behavior) => behavior.id === current) ? current : behaviors[0].id;
}

function selectedValues(target: string | ControlElement): string[] {
  const select = typeof target === "string" ? $(target) : target;
  return Array.from((select as unknown as HTMLSelectElement).selectedOptions || [])
    .map((option) => option.value)
    .filter(Boolean);
}

function setSelectedOptions(select: ControlElement, values: string[]): void {
  const selected = new Set(values || []);
  for (const option of Array.from((select as unknown as HTMLSelectElement).options || [])) {
    option.selected = selected.has(option.value);
  }
}

function tagList(value: unknown): string[] {
  return String(value || "")
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toDateTimeLocal(value: unknown): string {
  const date = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function shortTime(value: unknown): string {
  const date = value ? new Date(String(value)) : null;
  if (!date || Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function nextQuarterHour(): Date {
  const date = new Date();
  date.setSeconds(0, 0);
  const minutes = date.getMinutes();
  date.setMinutes(minutes + (15 - (minutes % 15 || 15)));
  return date;
}

function profileName(profileId: string): string {
  return state.data?.state.profiles.find((profile) => profile.id === profileId)?.name || profileId || "Profile";
}

function selectedPlanItemListId(itemId: string): string {
  if (!itemId) return "";
  return state.data?.intentionalUse?.lifeLog?.planner?.items?.find((item) => item.id === itemId)?.listId || "";
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
