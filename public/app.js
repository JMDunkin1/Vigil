import { get, post, del } from "./api-client.js";
import { createDeviceTargetController } from "./device-targets.js";
import { dayCheckbox, detailBlock, el, progressBlock, textEl } from "./dom.js";
import { createDistanceKeyQrSvg } from "./distance-key-qr.js";
import { createFocusSoundController } from "./focus-sound.js";
import { days, daysText, daysWithDataText, enforcementText, eventLabel, formatDuration, lines, phaseText, phaseTitle, progressText, shortDate, shortDateTime, signedDuration, signedNumber, signedPercent, sweepText, systemSleepLockText } from "./format.js";

const state = {
  data: null,
  activeView: "home",
  selectedProfileId: null,
  selectedScheduleId: null,
  pendingEmergencyId: null,
  pendingMaintenanceId: null,
  timer: null,
  distanceScanner: {
    stream: null,
    frame: null,
    target: null
  }
};

const $ = (selector) => document.querySelector(selector);
const BRICK_MODE_PROFILE_ID = "brick-mode";
const SOFT_BLOCK_PROFILE_ID = "soft-block";
const deviceTargets = createDeviceTargetController({
  onChange: () => renderDeviceTargetControls(state.data?.state || {})
});
const focusSound = createFocusSoundController({ $, post, toast });

boot();

function boot() {
  initTheme();
  renderScheduleDays();
  renderLimitDays();
  renderAppLockDays();
  renderIntentionalDays();
  bindViewNavigation();
  bindEvents();
  refresh();
  setInterval(refresh, 3000);
  state.timer = setInterval(renderCountdowns, 1000);
}

function initTheme() {
  let saved;
  try {
    saved = localStorage.getItem("sentinel-theme") || "";
  } catch {
    saved = "";
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  setTheme(saved || (prefersDark ? "dark" : "light"));
}

function setTheme(theme) {
  const next = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem("sentinel-theme", next);
  } catch {
  }
  const button = $("#themeToggle");
  if (!button) return;
  button.textContent = next === "dark" ? "Light" : "Dark";
  button.setAttribute("aria-pressed", String(next === "dark"));
}

function bindViewNavigation() {
  for (const button of document.querySelectorAll("[data-view-target]")) {
    button.addEventListener("click", () => setView(button.dataset.viewTarget));
  }
}

function setView(view) {
  state.activeView = view || "home";
  for (const panel of document.querySelectorAll("[data-view]")) {
    const active = panel.dataset.view === state.activeView;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  }
  for (const button of document.querySelectorAll("[data-view-target]")) {
    const active = button.dataset.viewTarget === state.activeView;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

function selectedDeviceTargets() {
  return deviceTargets.selectedTargets();
}

function selectedDeviceLabel() {
  return deviceTargets.selectedLabel();
}

function bindEvents() {
  $("#themeToggle").addEventListener("click", () => {
    setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });

  deviceTargets.bind();

  document.querySelectorAll("[data-scan-distance-key]").forEach((button) => {
    button.addEventListener("click", () => openDistanceScanner(button.dataset.scanDistanceKey));
  });
  $("#closeDistanceScanner").addEventListener("click", closeDistanceScanner);

  $("#startSessionForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
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
      toast(error.message);
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
      const response = await post("/api/panic/start", {});
      status.textContent = `Locked until ${shortDateTime(response.session.endsAt)}`;
      toast("Panic lock started");
    } catch (error) {
      status.textContent = error.message;
      toast(error.message);
    }
    await refresh();
  });

  $("#focusSoundEnabled").addEventListener("change", async (event) => {
    try {
      if (event.target.checked) await focusSound.prime();
      await focusSound.saveSettings();
      toast("Focus sound saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#focusSoundPreset").addEventListener("change", async () => {
    try {
      await focusSound.saveSettings();
      toast("Focus sound saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#focusSoundVolume").addEventListener("input", () => {
    focusSound.setVolume(Number($("#focusSoundVolume").value || 0));
  });

  $("#focusSoundVolume").addEventListener("change", async () => {
    try {
      await focusSound.saveSettings();
      toast("Focus sound saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#profileSelect").addEventListener("change", async (event) => {
    state.selectedProfileId = event.target.value;
    await post("/api/settings", { activeProfileId: state.selectedProfileId });
    await refresh();
  });

  $("#profileForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.blockedApps = lines(body.blockedApps);
    body.blockedSites = lines(body.blockedSites);
    body.blockedUrlPatterns = lines(body.blockedUrlPatterns);
    body.allowedApps = lines(body.allowedApps);
    body.allowedSites = lines(body.allowedSites);
    await post("/api/profile", body);
    toast("Profile saved");
    await refresh();
  });

  $("#scheduleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.enabled = form.has("enabled");
    body.commitmentLock = form.has("commitmentLock");
    body.days = [...document.querySelectorAll("#scheduleDays input:checked")].map((input) => Number(input.value));
    body.wifiNetworks = lines(body.wifiNetworks);
    body.profileId = state.data.state.settings.activeProfileId;
    body.lockLevel = "deep";
    await post("/api/schedule", body);
    toast("Schedule saved");
    resetScheduleForm();
    await refresh();
  });

  $("#newSchedule").addEventListener("click", resetScheduleForm);
  $("#newLimit").addEventListener("click", resetLimitForm);
  $("#newAppLock").addEventListener("click", resetAppLockForm);
  $("#newIntentionalRule").addEventListener("click", resetIntentionalRuleForm);

  $("#limitForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.enabled = form.has("enabled");
    body.days = [...document.querySelectorAll("#limitDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    await post("/api/limit", body);
    toast("Limit saved");
    resetLimitForm();
    await refresh();
  });

  $("#appLockForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.enabled = form.has("enabled");
    body.days = [...document.querySelectorAll("#appLockDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    await post("/api/app-lock", body);
    toast("App lock saved");
    resetAppLockForm();
    await refresh();
  });

  $("#intentionalGoalForm").addEventListener("submit", async (event) => {
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
      toast(error.message);
    }
    await refresh();
  });

  $("#intentionalRuleForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = Object.fromEntries(form.entries());
    body.enabled = form.has("enabled");
    body.days = [...document.querySelectorAll("#intentionalDays input:checked")].map((input) => Number(input.value));
    body.apps = lines(body.apps);
    body.sites = lines(body.sites);
    try {
      await post("/api/intentional-use/rule", body);
      toast("Pause rule saved");
      resetIntentionalRuleForm();
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#accountabilityForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await post("/api/intentional-use/accountability", {
        enabled: $("#accountabilityEnabled").checked,
        partnerName: $("#accountabilityPartner").value,
        cadence: $("#accountabilityCadence").value
      });
      toast("Digest settings saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#copyAccountabilityDigest").addEventListener("click", async () => {
    await copyHardeningText($("#accountabilityDigest").textContent || "", "Digest copied");
  });

  $("#iosForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await post("/api/devices/ios/settings", {
        enabled: $("#iosEnabled").checked,
        mode: $("#iosMode").value,
        webMode: $("#iosWebMode").value,
        blockApps: $("#iosBlockApps").checked,
        blockWeb: $("#iosBlockWeb").checked,
        hardenRemoval: $("#iosHardenRemoval").checked,
        restrictInstallAndErase: $("#iosRestrictInstallErase").checked,
        blockedAppBundleIds: lines($("#iosBlockedBundles").value),
        allowedAppBundleIds: lines($("#iosAllowedBundles").value),
        deniedUrls: lines($("#iosDeniedUrls").value),
        allowedUrls: lines($("#iosAllowedUrls").value)
      });
      toast("iPhone policy saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#iosDownloadProfile").addEventListener("click", () => {
    window.location.href = "/api/devices/ios/profile.mobileconfig";
  });

  $("#iosMdmForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const payload = {
        enabled: $("#iosMdmEnabled").checked,
        publicBaseUrl: $("#iosMdmPublicBaseUrl").value,
        topic: $("#iosMdmTopic").value,
        identityCertificateUuid: $("#iosMdmIdentityUuid").value,
        signMessage: $("#iosMdmSignMessage").checked,
        useDevelopmentApns: $("#iosMdmDevApns").checked
      };
      const identityPayload = $("#iosMdmIdentityPayload").value.trim();
      const identityPassword = $("#iosMdmIdentityPassword").value;
      const pushPayload = $("#iosMdmPushPayload").value.trim();
      const pushPassword = $("#iosMdmPushPassword").value;
      if (identityPayload) payload.identityCertificatePayloadBase64 = identityPayload;
      if (identityPassword) payload.identityCertificatePassword = identityPassword;
      if (pushPayload) payload.pushCertificatePayloadBase64 = pushPayload;
      if (pushPassword) payload.pushCertificatePassword = pushPassword;
      await post("/api/devices/ios/mdm/settings", payload);
      $("#iosMdmIdentityPayload").value = "";
      $("#iosMdmIdentityPassword").value = "";
      $("#iosMdmPushPayload").value = "";
      $("#iosMdmPushPassword").value = "";
      toast("iPhone MDM setup saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#iosMdmDownloadEnrollment").addEventListener("click", () => {
    window.location.href = "/api/devices/ios/mdm/enrollment.mobileconfig";
  });

  $("#iosMdmQueuePolicy").addEventListener("click", async () => {
    try {
      const response = await post("/api/devices/ios/mdm/queue-policy", {});
      toast(response.result?.queued ? `Queued ${response.result.queued} iPhone update(s)` : "No enrolled iPhones to update");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#requestEmergency").addEventListener("click", async () => {
    try {
      const reason = $("#emergencyReason").value.trim();
      const response = await post("/api/emergency/request", { reason });
      state.pendingEmergencyId = response.pending.id;
      toast("Emergency cooldown started");
    } catch (error) {
      toast(error.message);
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
      toast(error.message);
    }
    await refresh();
  });

  $("#requestMaintenance").addEventListener("click", async () => {
    try {
      const reason = $("#maintenanceReason").value.trim();
      const response = await post("/api/protection/maintenance/request", { reason });
      state.pendingMaintenanceId = response.pending?.id || null;
      toast(response.activeWindow ? "Maintenance already open" : "Maintenance cooldown started");
    } catch (error) {
      toast(error.message);
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
      toast(error.message);
    }
    await refresh();
  });

  $("#keyholderForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await post("/api/keyholder", {
        enabled: $("#keyholderEnabled").checked,
        passcode: $("#keyholderPasscode").value
      });
      $("#keyholderPasscode").value = "";
      toast("Keyholder saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#distanceKeyForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const result = await post("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        token: $("#distanceKeyTokenInput").value,
        keyFilePath: $("#distanceKeyFilePath").value
      });
      $("#distanceKeyTokenInput").value = "";
      hideDistanceToken();
      if (result.token) showDistanceToken(result.token);
      toast("Distance key saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#rotateDistanceKey").addEventListener("click", async () => {
    try {
      const result = await post("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        keyFilePath: $("#distanceKeyFilePath").value,
        rotate: true
      });
      showDistanceToken(result.token);
      toast("Distance key generated");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#writeDistanceKeyFile").addEventListener("click", async () => {
    try {
      const result = await post("/api/distance-key", {
        enabled: $("#distanceKeyEnabled").checked,
        keyFilePath: $("#distanceKeyFilePath").value,
        writeKeyFile: true
      });
      hideDistanceToken();
      toast(result.keyFilePath ? "Distance key file written" : "Distance key saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#printDistanceKey").addEventListener("click", printDistanceKey);

  $("#installLaunchAgent").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    status.textContent = "Installing login agent...";
    $("#installLaunchAgent").disabled = true;
    try {
      await post("/api/hardening/launch-agent/install", {});
      status.textContent = "Login agent installed";
      toast("Login agent installed");
    } catch (error) {
      status.textContent = error.message;
      toast(error.message);
    } finally {
      $("#installLaunchAgent").disabled = false;
    }
    await refresh();
  });

  $("#applyHostsBlock").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    const action = state.data?.hardening.actions?.hostsApply || {};
    status.textContent = "Waiting for macOS password...";
    $("#applyHostsBlock").disabled = true;
    try {
      await post(action.path || "/api/hardening/hosts/apply", {});
      status.textContent = "Network block applied";
      toast("Network block applied");
    } catch (error) {
      status.textContent = error.message;
      toast(error.message);
    } finally {
      $("#applyHostsBlock").disabled = false;
    }
    await refresh();
  });

  $("#clearTamperAlarm").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    const action = state.data?.hardening.actions?.tamperClear || {};
    status.textContent = "Clearing tamper alarm...";
    $("#clearTamperAlarm").disabled = true;
    try {
      await post(action.path || "/api/integrity/clear-tamper", {});
      status.textContent = "Tamper alarm cleared";
      toast("Tamper alarm cleared");
    } catch (error) {
      status.textContent = error.message;
      toast(error.message);
    } finally {
      $("#clearTamperAlarm").disabled = false;
    }
    await refresh();
  });

  $("#copyHostsCommand").addEventListener("click", async () => {
    const command = state.data?.hardening.actions?.hostsApply?.command || "npm run network:apply";
    await copyHardeningText(command, "Network command copied");
  });

  $("#copySourceSealCommand").addEventListener("click", async () => {
    const command = state.data?.hardening.actions?.sourceSeal?.command || "npm run seal:source";
    await copyHardeningText(command, "Source seal command copied");
  });

  $("#copyExtensionPath").addEventListener("click", async () => {
    const path = state.data?.hardening.actions?.extensionLoad?.path || "extension";
    await copyHardeningText(path, "Extension path copied");
  });

  $("#saveFocusShortcuts").addEventListener("click", async () => {
    try {
      await post("/api/settings", {
        focusShortcutEnabled: $("#focusShortcutEnabled").checked,
        focusShortcutOnName: $("#focusShortcutOnName").value,
        focusShortcutOffName: $("#focusShortcutOffName").value
      });
      toast("Focus hooks saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  for (const id of ["siteRedirectEnabled", "contentFilterEnabled", "browserNoiseBlockingEnabled", "typingChallengeEnabled", "intentReasonEnabled", "appQuitEnabled", "strictBypassProtectionEnabled", "processSweepEnabled", "systemSleepLockEnabled", "focusShortcutEnabled", "strictByDefault", "protectedEditsEnabled", "foolproofModeEnabled"]) {
    $(`#${id}`).addEventListener("change", async (event) => {
      try {
        await post("/api/settings", { [id]: event.target.checked });
        toast("Setting saved");
      } catch (error) {
        toast(error.message);
      }
      await refresh();
    });
  }

  $("#appQuitEscalationSeconds").addEventListener("change", async (event) => {
    try {
      await post("/api/settings", { appQuitEscalationSeconds: event.target.value });
      toast("Escalation saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#processSweepIntervalSeconds").addEventListener("change", async (event) => {
    try {
      await post("/api/settings", { processSweepIntervalSeconds: event.target.value });
      toast("Sweep interval saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#systemSleepLockIntervalSeconds").addEventListener("change", async (event) => {
    try {
      await post("/api/settings", { systemSleepLockIntervalSeconds: event.target.value });
      toast("Sleep relock saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#panicLockDurationMinutes").addEventListener("change", async (event) => {
    try {
      await post("/api/settings", { panicLockDurationMinutes: event.target.value });
      toast("Panic duration saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });

  $("#intentReasonMinLength").addEventListener("change", async (event) => {
    try {
      await post("/api/settings", { intentReasonMinLength: event.target.value });
      toast("Reason gate saved");
    } catch (error) {
      toast(error.message);
    }
    await refresh();
  });
}

async function startNormalMode() {
  const targets = selectedDeviceTargets();
  const status = $("#brickStatus");
  status.textContent = "Returning to Normal...";
  try {
    const response = await post("/api/session/end", { deviceTargets: targets });
    status.textContent = response.ended ? "Normal active" : "Normal already active";
    toast(`${selectedDeviceLabel()} set to Normal`);
  } catch (error) {
    status.textContent = error.message;
    toast(error.message);
  }
  await refresh();
}

async function startPresetSession(kind) {
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
    status.textContent = error.message;
    toast(error.message);
  }
  await refresh();
}

async function refresh() {
  try {
    state.data = await get("/api/state");
    render();
  } catch (error) {
    $("#watcherStatus").textContent = error.message;
    $("#watcherStatus").className = "tiny-status";
  }
}

function render() {
  const data = state.data;
  renderPresetButtons(data.presets || []);
  renderHeader(data.state, data.monitor, data.limits.activeBlocks);
  focusSound.render(data);
  renderMetrics(data.usage, data.report);
  renderWatcher(data.monitor);
  renderIntervention(data.intervention);
  renderIntentionalUse(data.intentionalUse);
  renderHardening(data);
  renderProfiles(data.state);
  renderSchedules(data.state.schedules);
  renderLimits(data.limits.rules);
  renderAppLocks(data.appLocks.rules);
  renderBars("#appBars", data.usage.topApps);
  renderBars("#siteBars", data.usage.topSites);
  renderReport(data.report);
  renderDevices(data.devices);
  renderEvents(data.state.events);
  renderEmergency(data.state);
  renderCountdowns();
}

function renderPresetButtons(presets) {
  for (const strip of document.querySelectorAll(".preset-strip")) {
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
      button.addEventListener("click", () => applyPreset(strip, preset));
      strip.append(button);
    }
  }
}

function applyPreset(strip, preset) {
  const form = document.forms[strip.dataset.form];
  if (!form) return;
  appendLines(form.elements[strip.dataset.appField], preset.apps);
  appendLines(form.elements[strip.dataset.siteField], preset.sites);
  toast(`${preset.label} preset added`);
}

function appendLines(field, values = []) {
  if (!field) return;
  const next = [...new Set([...lines(field.value), ...values].map((item) => String(item).trim()).filter(Boolean))];
  field.value = next.join("\n");
}

function renderDeviceTargetControls(appState = {}) {
  deviceTargets.render(appState);
}

function renderHeader(appState, monitor, activeBlocks = []) {
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

function renderOrbState(orbState) {
  const orb = $("#sentinelOrb");
  if (!orb) return;
  orb.className = `sentinel-orb ${orbState}`;
  document.body.dataset.lockState = orbState;
}

function renderMetrics(usage, report) {
  $("#focusScore").textContent = `${usage.focusScore}`;
  $("#distractingToday").textContent = formatDuration(usage.distractingSeconds);
  $("#lockedToday").textContent = formatDuration(usage.protectedSeconds);
  $("#distractionTrend").textContent = signedPercent(report?.comparison?.distractingPercentDelta);
}

function renderWatcher(monitor) {
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

function renderIntervention(intervention) {
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
  message.textContent = intervention.message;
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

function renderHardening(data) {
  const settings = data.state.settings;
  $("#siteRedirectEnabled").checked = Boolean(settings.siteRedirectEnabled);
  $("#contentFilterEnabled").checked = settings.contentFilterEnabled !== false;
  $("#browserNoiseBlockingEnabled").checked = settings.browserNoiseBlockingEnabled !== false;
  $("#typingChallengeEnabled").checked = settings.typingChallengeEnabled !== false;
  $("#intentReasonEnabled").checked = settings.intentReasonEnabled !== false;
  $("#appQuitEnabled").checked = Boolean(settings.appQuitEnabled);
  $("#strictBypassProtectionEnabled").checked = settings.strictBypassProtectionEnabled !== false;
  $("#processSweepEnabled").checked = Boolean(settings.processSweepEnabled);
  $("#systemSleepLockEnabled").checked = Boolean(settings.systemSleepLockEnabled);
  $("#focusShortcutEnabled").checked = Boolean(settings.focusShortcutEnabled);
  $("#strictByDefault").checked = Boolean(settings.strictByDefault);
  $("#protectedEditsEnabled").checked = Boolean(settings.protectedEditsEnabled);
  $("#foolproofModeEnabled").checked = Boolean(settings.foolproofModeEnabled);
  $("#appQuitEscalationSeconds").value = settings.appQuitEscalationSeconds || 10;
  $("#processSweepIntervalSeconds").value = settings.processSweepIntervalSeconds || 15;
  $("#systemSleepLockIntervalSeconds").value = settings.systemSleepLockIntervalSeconds || 60;
  $("#panicLockDurationMinutes").value = settings.panicLockDurationMinutes || 3;
  $("#intentReasonMinLength").value = settings.intentReasonMinLength || 20;
  renderIntentReasonHints(settings);
  renderFocusShortcut(data.state.focusShortcut);
  $("#hostsBlock").textContent = data.hardening.hostsBlock;
  renderHardeningActions(data.hardening);
  const hosts = data.hardening.hosts || {};
  const firewall = data.hardening.firewall || {};
  const networkCurrent = hosts.installed && !hosts.partial && !hosts.stale && firewall.installed && !firewall.partial && !firewall.stale;
  const networkWarn = hosts.partial || hosts.stale || firewall.partial || firewall.stale || hosts.installed || firewall.installed;
  $("#hostsStatus").textContent = networkCurrent
    ? "Network current"
    : (networkWarn ? "Network stale" : "Network preview");
  $("#hostsStatus").className = networkCurrent ? "pill good" : (networkWarn ? "pill warn" : "pill neutral");
  renderKeyholder(data.state.keyholder);
  renderDistanceKey(data.state.distanceKey);
  renderMaintenance(data.protection);
  renderAudit(data.hardening.audit || []);
  renderFoolproofBlockers(data.hardening.foolproof);
}

function renderHardeningActions(hardening) {
  const agent = hardening.launchAgent || {};
  const hosts = hardening.hosts || {};
  const firewall = hardening.firewall || {};
  const networkCurrent = hosts.installed && !hosts.partial && !hosts.stale && firewall.installed && !firewall.partial && !firewall.stale;
  const tamperActive = Boolean(hardening.stateSeal?.tamperDetectedAt || hardening.stateSeal?.status === "tamper-detected");
  $("#installLaunchAgent").textContent = agent.installed ? "Reinstall Login Agent" : "Install Login Agent";
  $("#applyHostsBlock").textContent = networkCurrent ? "Reapply Network Block" : "Apply Network Block";
  $("#clearTamperAlarm").hidden = !tamperActive;
  $("#clearTamperAlarm").disabled = !tamperActive;
  $("#copyHostsCommand").textContent = networkCurrent ? "Copy Network Reapply" : "Copy Network Command";
}

function renderFocusShortcut(focusShortcut) {
  const onName = $("#focusShortcutOnName");
  const offName = $("#focusShortcutOffName");
  if (document.activeElement !== onName) onName.value = focusShortcut?.onShortcutName || "";
  if (document.activeElement !== offName) offName.value = focusShortcut?.offShortcutName || "";
  const status = $("#focusShortcutStatus");
  if (focusShortcut?.lastError) {
    status.textContent = focusShortcut.lastError;
  } else if (focusShortcut?.active) {
    status.textContent = "Active";
  } else if (focusShortcut?.enabled) {
    status.textContent = "Ready";
  } else {
    status.textContent = "Disabled";
  }
}

function renderIntentReasonHints(settings) {
  const min = settings.intentReasonEnabled === false ? 0 : (settings.intentReasonMinLength || 20);
  const hint = min ? `Reason (${min}+ chars)` : "Reason";
  for (const id of ["emergencyReason", "maintenanceReason", "appLockReason"]) {
    const field = $(`#${id}`);
    if (field) field.placeholder = hint;
  }
}

function renderKeyholder(keyholder) {
  $("#keyholderEnabled").checked = Boolean(keyholder?.enabled);
  $("#keyholderStatus").textContent = keyholder?.enabled
    ? "Required"
    : (keyholder?.hasPasscode ? "Saved" : "Not set");
}

function renderDistanceKey(distanceKey) {
  $("#distanceKeyEnabled").checked = Boolean(distanceKey?.enabled);
  const keyFile = $("#distanceKeyFilePath");
  if (document.activeElement !== keyFile) keyFile.value = distanceKey?.keyFilePath || "";
  $("#distanceKeyStatus").textContent = distanceKey?.enabled
    ? (distanceKey?.hasKeyFile ? "File required" : "Required")
    : (distanceKey?.hasToken ? (distanceKey?.hasKeyFile ? "Saved + file" : "Saved") : "Not set");
}

function renderMaintenance(protection) {
  const active = protection.activeWindow;
  const pending = protection.pending?.[0] || null;
  const status = $("#maintenanceStatus");
  const confirm = $("#confirmMaintenance");
  if (active) {
    renderTypingChallenge($("#maintenanceChallenge"), $("#maintenanceChallengeInput"), null);
    status.textContent = `Open for ${formatDuration((new Date(active.until).getTime() - Date.now()) / 1000)}`;
    confirm.disabled = true;
    return;
  }
  if (pending) {
    state.pendingMaintenanceId = pending.id;
    renderTypingChallenge($("#maintenanceChallenge"), $("#maintenanceChallengeInput"), pending.challenge);
    const seconds = Math.ceil((new Date(pending.eligibleAt).getTime() - Date.now()) / 1000);
    if (seconds > 0) {
      status.textContent = `Confirm in ${seconds}s`;
      confirm.disabled = true;
    } else {
      status.textContent = "Ready to confirm";
      confirm.disabled = false;
    }
    return;
  }
  renderTypingChallenge($("#maintenanceChallenge"), $("#maintenanceChallengeInput"), null);
  status.textContent = protection.enabled ? "Closed" : "Off";
  confirm.disabled = true;
}

function renderAudit(items) {
  const root = $("#hardeningAudit");
  root.replaceChildren();
  for (const item of items) {
    const row = document.createElement("div");
    row.className = item.ok ? "audit-item good" : "audit-item warn";
    row.append(
      textEl("span", item.ok ? "OK" : "Check"),
      textEl("strong", item.label),
      textEl("em", item.detail)
    );
    root.append(row);
  }
}

function renderFoolproofBlockers(foolproof) {
  const root = $("#foolproofBlockers");
  root.replaceChildren();
  if (!foolproof) return;
  if (foolproof.ready) {
    const row = document.createElement("div");
    row.className = "blocker-item good";
    row.textContent = foolproof.enabled ? "Foolproof ready." : "Foolproof checklist ready.";
    root.append(row);
    return;
  }
  for (const item of foolproof.blockers || []) {
    const row = document.createElement("div");
    row.className = "blocker-item";
    row.append(textEl("strong", prettyBlockerId(item.id)), textEl("span", item.detail));
    root.append(row);
  }
}

async function copyHardeningText(value, message) {
  try {
    await navigator.clipboard.writeText(value);
    $("#hardeningActionStatus").textContent = message;
    toast(message);
  } catch {
    $("#hardeningActionStatus").textContent = value;
    toast("Shown below");
  }
}

function prettyBlockerId(value) {
  return String(value || "")
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderProfiles(appState) {
  const profiles = appState.profiles;
  const activeId = appState.settings.activeProfileId;
  state.selectedProfileId ||= activeId;

  fillSelect($("#profileSelect"), profiles, state.selectedProfileId);
  fillSelect($("#sessionProfile"), profiles, activeId);

  const profile = profiles.find((item) => item.id === state.selectedProfileId) || appState.activeProfile;
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

function renderSchedules(schedules) {
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

function renderLimits(rules) {
  const list = $("#limitList");
  list.replaceChildren();
  if (!rules.length) {
    list.append(empty("No limits saved"));
    return;
  }

  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "list-item limit-item";
    const used = rule.type === "open" ? rule.progress.opens : rule.progress.seconds;
    const cap = rule.type === "open" ? rule.unlocksAllowed : rule.limitMinutes * 60;
    const label = progressBlock(
      rule.name,
      `${rule.type} | ${progressText(rule, used, cap)} | ${daysText(rule.days)} | ${rule.enabled ? "on" : "off"}${rule.activeBlock ? " | locked" : ""}`,
      rule.percent
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

function renderAppLocks(rules) {
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
      `${used}/${allowed} unlocks | ${rule.unlockMinutes}m window | ${daysText(rule.days)} | ${rule.enabled ? "on" : "off"}${rule.activeUnlock ? " | unlocked now" : ""}`,
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

function configureAppLockUnlockButton(button, rule) {
  if (rule.activeUnlock) {
    button.textContent = "Unlocked";
    button.disabled = true;
    return;
  }

  if (rule.remainingToday <= 0) {
    button.textContent = "No unlocks";
    button.disabled = true;
    return;
  }

  if (rule.pendingRequest) {
    const ms = new Date(rule.pendingRequest.eligibleAt).getTime() - Date.now();
    if (ms > 0) {
      button.textContent = `${Math.ceil(ms / 1000)}s`;
      button.disabled = true;
      return;
    }
    button.textContent = "Confirm";
    button.addEventListener("click", async () => {
      try {
        await post("/api/app-lock/unlock/confirm", {
          requestId: rule.pendingRequest.id,
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
        toast(error.message);
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
      toast(error.message);
    }
    await refresh();
  });
}

function renderIntentionalUse(intentionalUse) {
  if (!intentionalUse) return;
  const goal = intentionalUse.goal || {};
  const settings = state.data?.state.settings || {};
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

function renderIntentionalRuleList(rules) {
  const list = $("#intentionalRuleList");
  list.replaceChildren();
  if (!rules.length) {
    list.append(empty("No pause rules saved"));
    return;
  }

  for (const rule of rules) {
    const row = document.createElement("div");
    row.className = "list-item limit-item";
    const progress = rule.progress || {};
    const budget = progress.budget || {};
    const percent = budget.budgetSeconds ? Math.min(100, budget.percent || 0) : 0;
    const label = progressBlock(
      rule.name,
      `${rule.frictionLevel} | ${rule.delaySeconds}s pause | ${rule.sessionMinutes}m window | ${formatDuration(progress.seconds || 0)} today | ${rule.enabled ? "on" : "off"}`,
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

function renderBars(selector, entries) {
  const root = $(selector);
  root.replaceChildren();
  if (!entries.length) {
    root.append(empty("No activity yet"));
    return;
  }

  const max = Math.max(...entries.map((item) => item.seconds), 1);
  for (const item of entries) {
    const fill = el("div", { className: "bar-fill" });
    fill.style.width = `${Math.max(4, Math.round((item.seconds / max) * 100))}%`;
    const row = el(
      "div",
      { className: "bar-row" },
      textEl("div", item.name, { className: "bar-name" }),
      el("div", { className: "bar-track" }, fill),
      textEl("div", formatDuration(item.seconds), { className: "bar-time" })
    );
    root.append(row);
  }
}

function renderReport(report) {
  if (!report) return;
  $("#reportRange").textContent = `${shortDate(report.currentWeek.startsAt)} - ${shortDate(report.currentWeek.endsAt)}`;
  $("#weekFocusScore").textContent = report.currentWeek.totals.averageFocusScore;
  $("#weekScoreDelta").textContent = signedNumber(report.comparison.focusScoreDelta, " pts");
  $("#weekSaved").textContent = formatDuration(report.currentWeek.totals.distractingSeconds);
  $("#weekSavedDelta").textContent = signedDuration(report.comparison.distractingSecondsDelta);
  $("#focusStreak").textContent = report.streak.label;
  $("#streakGoal").textContent = `${report.streak.goal}+ score goal`;
  $("#yearPace").textContent = formatDuration(report.currentWeek.totals.averageDailyDistractionSeconds);
  $("#decadePace").textContent = daysWithDataText(report.currentWeek.totals.trackedDays);
  $("#openPressure").textContent = report.currentWeek.totals.averageDailyOpens || 0;
  $("#openPressureMeta").textContent = "avg opens / day";
  renderWeekStrip(report.currentWeek.days, report.focusScoreGoal);
  renderInsights(report.insights);
  renderMilestones(report.milestones);
}

function renderDevices(devices) {
  if (!devices) return;
  const ios = devices.ios || {};
  $("#iosEnabled").checked = Boolean(ios.enabled);
  $("#iosMode").value = ios.mode || "denylist";
  $("#iosWebMode").value = ios.webMode || "denylist";
  $("#iosBlockApps").checked = ios.blockApps !== false;
  $("#iosBlockWeb").checked = ios.blockWeb !== false;
  $("#iosHardenRemoval").checked = ios.removalHardened || ios.hardenRemoval !== false;
  $("#iosRestrictInstallErase").checked = ios.restrictInstallAndErase !== false;
  $("#iosBlockedBundles").value = (ios.blockedAppBundleIds || []).join("\n");
  $("#iosAllowedBundles").value = (ios.allowedAppBundleIds || []).join("\n");
  $("#iosDeniedUrls").value = (ios.deniedUrls || []).join("\n");
  $("#iosAllowedUrls").value = (ios.allowedUrls || []).join("\n");

  $("#iosStatus").textContent = ios.enabled ? "Enabled" : "Ready";
  $("#iosStatus").className = ios.enabled ? "pill good" : "pill neutral";
  $("#iosStatusTitle").textContent = ios.enabled ? "Supervised policy enabled" : "Supervised profile ready";
  $("#iosStatusText").textContent = ios.note || "Apple-only iPhone blocking needs a supervised device policy.";

  const iosSummary = $("#iosSummary");
  iosSummary.replaceChildren();
  const profile = ios.profile || {};
  [
    ["Integration", "Apple devices only"],
    ["Setup", ios.supervisedRequired ? "supervised iPhone required" : "standard"],
    ["Apps", ios.blockApps ? `${profile.appBundleCount || 0} bundle IDs` : "off"],
    ["Web", ios.blockWeb ? `${profile.deniedUrlCount || 0} denied / ${profile.allowedUrlCount || 0} allowed` : "off"],
    ["Web clips", profile.webClipCount ? `${profile.webClipCount} managed` : "none"],
    ["Native Reels", "not available through public iOS APIs"],
    ["Removal", ios.removalHardened ? "passcode protected" : "device removable"],
    ["Profile", profile.generatedFrom || "saved policy"]
  ].forEach(([label, value]) => iosSummary.append(deviceRow(label, value)));

  const mdm = ios.mdm || {};
  $("#iosMdmEnabled").checked = Boolean(mdm.enabled);
  $("#iosMdmPublicBaseUrl").value = mdm.publicBaseUrl || "";
  $("#iosMdmTopic").value = mdm.topic || "";
  $("#iosMdmIdentityUuid").value = mdm.identityCertificateUuid || "";
  $("#iosMdmIdentityPayload").placeholder = mdm.identityCertificatePayloadSet ? "Saved payload is set" : "Base64 payload";
  $("#iosMdmIdentityPassword").placeholder = mdm.identityCertificatePasswordSet ? "Saved password is set" : "Leave blank to keep saved password";
  $("#iosMdmPushPayload").placeholder = mdm.pushCertificatePayloadSet ? "Saved APNs push certificate is set" : "Base64 APNs push PKCS#12";
  $("#iosMdmPushPassword").placeholder = mdm.pushCertificatePasswordSet ? "Saved password is set" : "Leave blank to keep saved password";
  $("#iosMdmSignMessage").checked = Boolean(mdm.signMessage);
  $("#iosMdmDevApns").checked = Boolean(mdm.useDevelopmentApns);
  $("#iosMdmStatus").textContent = mdm.enabled ? (mdm.ready ? "Ready" : (mdm.enrollmentReady ? "Queue" : "Setup")) : "Off";
  $("#iosMdmStatus").className = mdm.enabled ? (mdm.ready ? "pill good" : "pill warn") : "pill neutral";
  $("#iosMdmTitle").textContent = mdm.ready ? "MDM ready" : (mdm.enabled ? (mdm.enrollmentReady ? "Command queue ready" : "Setup needed") : "Server setup");
  $("#iosMdmText").textContent = mdm.note || "Enroll a supervised iPhone so policy changes come from this computer.";

  const mdmSummary = $("#iosMdmSummary");
  mdmSummary.replaceChildren();
  [
    ["Public URL", mdm.publicBaseUrl || "not set"],
    ["Identity", mdm.identityCertificatePayloadSet ? "payload set" : "missing payload"],
    ["APNs Push", mdm.pushCertificatePayloadSet ? "certificate set" : "missing certificate"],
    ["Enroll", mdm.enrollmentUrl || mdm.localEnrollmentPath || "not ready"],
    ["Devices", `${mdm.enrolledDeviceCount || 0} enrolled`],
    ["Commands", `${mdm.pendingCommandCount || 0} queued / ${mdm.sentCommandCount || 0} sent`],
    ["Last push", mdm.lastPushAt ? `${shortDateTime(mdm.lastPushAt)} ${mdm.lastPushStatus || ""}`.trim() : "never"],
    ["Push error", mdm.lastPushError || "none"],
    ["Last seen", mdm.lastSeenAt ? shortDateTime(mdm.lastSeenAt) : "never"],
    ["Wireless", mdm.pushSupported ? "APNs ready" : "APNs sender pending"]
  ].forEach(([label, value]) => mdmSummary.append(deviceRow(label, value)));
  for (const blocker of mdm.blockers || []) {
    mdmSummary.append(deviceRow("Need", blocker));
  }
  for (const device of (mdm.devices || []).slice(0, 3)) {
    const details = [device.status, device.productName, device.osVersion].filter(Boolean).join(" / ");
    mdmSummary.append(deviceRow(device.udid || "iPhone", details || device.lastStatus || "seen"));
  }
}

function deviceRow(label, value) {
  const row = detailBlock(label, value || "--");
  row.className = "device-row";
  return row;
}

function renderWeekStrip(days, goal) {
  const root = $("#weekStrip");
  root.replaceChildren();
  for (const day of days) {
    const item = document.createElement("div");
    item.className = `week-day ${day.tracked ? "tracked" : ""} ${day.focusScore >= goal && day.tracked ? "hit" : ""}`;
    item.append(
      textEl("span", day.label),
      textEl("strong", day.tracked ? day.focusScore : "--"),
      textEl("em", day.tracked ? formatDuration(day.distractingSeconds) : "no data")
    );
    root.append(item);
  }
}

function renderInsights(items) {
  const root = $("#reportInsights");
  root.replaceChildren();
  for (const item of items || []) {
    const row = document.createElement("div");
    row.className = "insight";
    row.textContent = item;
    root.append(row);
  }
}

function renderMilestones(items) {
  const root = $("#milestones");
  root.replaceChildren();
  for (const item of items || []) {
    const row = document.createElement("div");
    row.className = item.achieved ? "milestone achieved" : "milestone";
    row.append(textEl("span", item.achieved ? "Done" : "Next"), textEl("strong", item.label));
    root.append(row);
  }
}

function renderEvents(events) {
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

function renderEmergency(appState) {
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

  renderTypingChallenge($("#emergencyChallenge"), $("#emergencyChallengeInput"), pending.challenge);
  const ms = new Date(pending.eligibleAt).getTime() - Date.now();
  if (ms > 0) {
    copy.textContent = `Confirm available in ${Math.ceil(ms / 1000)} seconds.`;
    confirm.disabled = true;
  } else {
    copy.textContent = "Cooldown complete.";
    confirm.disabled = false;
  }
}

function renderCountdowns() {
  const appState = state.data?.state;
  const active = appState?.activePolicy;
  const phase = active?.phase || appState?.sessionPhase;
  const activeLimitBlocks = (state.data?.limits.activeBlocks || []).filter((block) => new Date(block.until) > new Date());
  if (state.data?.protection) renderMaintenance(state.data.protection);
  if (phase) {
    const seconds = Math.max(0, Math.round((new Date(phase.endsAt).getTime() - Date.now()) / 1000));
    $("#sessionCountdown").textContent = formatDuration(seconds);
    renderEmergency(appState);
    return;
  }
  if (!active) {
    if (activeLimitBlocks.length) {
      const latest = activeLimitBlocks.map((block) => new Date(block.until).getTime()).sort((a, b) => b - a)[0];
      const seconds = Math.max(0, Math.round((latest - Date.now()) / 1000));
      $("#sessionCountdown").textContent = formatDuration(seconds);
      renderEmergency(state.data.state);
      return;
    }
    $("#sessionCountdown").textContent = "--";
    return;
  }
  const seconds = Math.max(0, Math.round((new Date(active.endsAt).getTime() - Date.now()) / 1000));
  $("#sessionCountdown").textContent = formatDuration(seconds);
  renderEmergency(appState);
}

function renderScheduleDays() {
  const root = $("#scheduleDays");
  root.replaceChildren();
  for (const [value, label] of days) {
    root.append(dayCheckbox(value, label, { checked: !["0", "6"].includes(value) }));
  }
}

function renderLimitDays() {
  const root = $("#limitDays");
  root.replaceChildren();
  for (const [value, label] of days) {
    root.append(dayCheckbox(value, label));
  }
}

function renderAppLockDays() {
  const root = $("#appLockDays");
  root.replaceChildren();
  for (const [value, label] of days) {
    root.append(dayCheckbox(value, label));
  }
}

function renderIntentionalDays() {
  const root = $("#intentionalDays");
  root.replaceChildren();
  for (const [value, label] of days) {
    root.append(dayCheckbox(value, label));
  }
}

function loadSchedule(schedule) {
  const form = $("#scheduleForm");
  form.elements.id.value = schedule.id;
  form.elements.name.value = schedule.name;
  form.elements.mode.value = schedule.mode;
  form.elements.start.value = schedule.start;
  form.elements.end.value = schedule.end;
  form.elements.wifiNetworks.value = (schedule.wifiNetworks || []).join("\n");
  form.elements.enabled.checked = Boolean(schedule.enabled);
  form.elements.commitmentLock.checked = Boolean(schedule.commitmentLock);
  for (const input of document.querySelectorAll("#scheduleDays input")) {
    input.checked = schedule.days.includes(Number(input.value));
  }
}

function loadAppLock(rule) {
  const form = $("#appLockForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.unlocksAllowed.value = rule.unlocksAllowed;
  form.elements.unlockMinutes.value = rule.unlockMinutes;
  form.elements.delaySeconds.value = rule.delaySeconds;
  form.elements.lockLevel.value = rule.lockLevel;
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of document.querySelectorAll("#appLockDays input")) {
    input.checked = rule.days.includes(Number(input.value));
  }
}

function resetAppLockForm() {
  const form = $("#appLockForm");
  form.reset();
  form.elements.id.value = "";
  form.elements.name.value = "Locked socials";
  form.elements.unlocksAllowed.value = "2";
  form.elements.unlockMinutes.value = "10";
  form.elements.delaySeconds.value = "30";
  form.elements.lockLevel.value = "deep";
  form.elements.enabled.checked = false;
  for (const input of document.querySelectorAll("#appLockDays input")) {
    input.checked = true;
  }
}

function loadIntentionalRule(rule) {
  const form = $("#intentionalRuleForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.frictionLevel.value = rule.frictionLevel || "standard";
  form.elements.delaySeconds.value = rule.delaySeconds || 12;
  form.elements.sessionMinutes.value = rule.sessionMinutes || 10;
  form.elements.dailyBudgetMinutes.value = rule.dailyBudgetMinutes || 30;
  form.elements.start.value = rule.start || "00:00";
  form.elements.end.value = rule.end || "23:59";
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of document.querySelectorAll("#intentionalDays input")) {
    input.checked = (rule.days || []).includes(Number(input.value));
  }
}

function resetIntentionalRuleForm() {
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
  for (const input of document.querySelectorAll("#intentionalDays input")) {
    input.checked = true;
  }
}

function loadLimit(rule) {
  const form = $("#limitForm");
  form.elements.id.value = rule.id;
  form.elements.name.value = rule.name;
  form.elements.type.value = rule.type;
  form.elements.lockLevel.value = rule.lockLevel;
  form.elements.limitMinutes.value = rule.limitMinutes;
  form.elements.unlocksAllowed.value = rule.unlocksAllowed;
  form.elements.blockMinutes.value = rule.blockMinutes;
  form.elements.apps.value = (rule.apps || []).join("\n");
  form.elements.sites.value = (rule.sites || []).join("\n");
  form.elements.enabled.checked = Boolean(rule.enabled);
  for (const input of document.querySelectorAll("#limitDays input")) {
    input.checked = rule.days.includes(Number(input.value));
  }
}

function resetLimitForm() {
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
  for (const input of document.querySelectorAll("#limitDays input")) {
    input.checked = true;
  }
}

function resetScheduleForm() {
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
  for (const input of document.querySelectorAll("#scheduleDays input")) {
    input.checked = !["0", "6"].includes(input.value);
  }
}

function fillSelect(select, items, selectedId) {
  const current = select.value || selectedId;
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name;
    select.append(option);
  }
  select.value = items.some((item) => item.id === current) ? current : selectedId;
}

function renderTypingChallenge(output, input, challenge) {
  const text = challenge?.text || "";
  output.classList.toggle("hidden", !text);
  input.classList.toggle("hidden", !text);
  output.textContent = text ? `Type: ${text}` : "";
  if (!text && document.activeElement !== input) input.value = "";
}

function empty(text) {
  const node = document.createElement("div");
  node.className = "empty";
  node.textContent = text;
  return node;
}

function showDistanceToken(token) {
  const node = $("#distanceKeyToken");
  node.textContent = token || "";
  node.classList.toggle("hidden", !token);
  const panel = $("#distanceKeyQr");
  const qr = $("#distanceKeyQrImage");
  if (!token) {
    panel.classList.add("hidden");
    qr.replaceChildren();
    return;
  }
  qr.replaceChildren(createDistanceKeyQrSvg(token));
  panel.classList.remove("hidden");
}

function hideDistanceToken() {
  showDistanceToken("");
}

async function openDistanceScanner(targetSelector) {
  const target = $(targetSelector);
  if (!target) return;
  if (!("BarcodeDetector" in window)) {
    toast("QR scanning is not available in this browser");
    return;
  }

  closeDistanceScanner();
  state.distanceScanner.target = target;
  $("#distanceScanner").classList.remove("hidden");
  $("#distanceScannerStatus").textContent = "Camera starting";

  try {
    const video = $("#distanceScannerVideo");
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" },
      audio: false
    });
    state.distanceScanner.stream = stream;
    video.srcObject = stream;
    await video.play();
    const detector = new BarcodeDetector({ formats: ["qr_code"] });
    $("#distanceScannerStatus").textContent = "Point the camera at the printed distance key";

    const tick = async () => {
      if (!state.distanceScanner.stream) return;
      try {
        const codes = await detector.detect(video);
        const value = normalizeDistanceKeyScan(codes[0]?.rawValue || "");
        if (value) {
          target.value = value;
          closeDistanceScanner();
          toast("Distance key scanned");
          return;
        }
      } catch {
        $("#distanceScannerStatus").textContent = "Scanning paused; adjust camera permission or type the key";
      }
      state.distanceScanner.frame = requestAnimationFrame(tick);
    };
    state.distanceScanner.frame = requestAnimationFrame(tick);
  } catch (error) {
    closeDistanceScanner();
    toast(error.message || "Camera unavailable");
  }
}

function closeDistanceScanner() {
  if (state.distanceScanner.frame) cancelAnimationFrame(state.distanceScanner.frame);
  if (state.distanceScanner.stream) {
    for (const track of state.distanceScanner.stream.getTracks()) track.stop();
  }
  state.distanceScanner = { stream: null, frame: null, target: null };
  const video = $("#distanceScannerVideo");
  if (video) video.srcObject = null;
  const scanner = $("#distanceScanner");
  if (scanner) scanner.classList.add("hidden");
}

function normalizeDistanceKeyScan(value) {
  const text = String(value || "").trim();
  const match = text.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
  return match ? match[0].toUpperCase() : "";
}

function printDistanceKey() {
  const token = $("#distanceKeyToken").textContent.trim();
  if (!token) {
    toast("Generate a distance key first");
    return;
  }
  const page = window.open("", "distance-key-print");
  if (!page) {
    toast("Print window was blocked");
    return;
  }
  const doc = page.document;
  doc.title = "Distance Key";
  const style = doc.createElement("style");
  style.textContent = `
    body { font-family: system-ui, sans-serif; margin: 32px; color: #16201d; }
    main { width: min(420px, 100%); }
    h1 { font-size: 24px; margin: 0 0 12px; }
    p { color: #53605b; line-height: 1.4; }
    code { display: block; margin-top: 12px; font-size: 22px; font-weight: 800; letter-spacing: 2px; }
    svg { width: 260px; height: 260px; margin-top: 18px; border: 1px solid #d9d2c4; }
  `;
  const main = doc.createElement("main");
  const title = doc.createElement("h1");
  title.textContent = "Sentinel Distance Key";
  const note = doc.createElement("p");
  note.textContent = "Keep this away from the desk. Scan it or type the code when a protected unlock needs the physical key.";
  const code = doc.createElement("code");
  code.textContent = token;
  main.append(title, note, createDistanceKeyQrSvg(token, 10, doc), code);
  doc.head.replaceChildren(style);
  doc.body.replaceChildren(main);
  page.focus();
  page.print();
}

function toast(message) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => node.classList.add("hidden"), 2600);
}
