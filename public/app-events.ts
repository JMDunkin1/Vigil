import type { DistanceKeyResponse, PendingResponse, UiState } from "./app-model.js";
import { lines } from "./format.js";
import { formRevision, markFormSaved, markFormSavedAtRevision, trackFormChanges } from "./form-state.js";
import type { FormController } from "./forms.js";
import { $, $$, errorMessage, eventTarget, formPayload } from "./ui-shell.js";

type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;

type BasicPanelController = {
  bind(): void;
};

type HardeningEventPanel = BasicPanelController & {
  copyText(value: string, message: string): Promise<void>;
};

type DistanceKeyUiController = {
  openScanner(targetSelector?: string): Promise<void>;
  closeScanner(): void;
  hideToken(): void;
  showToken(token: string): void;
  print(): void;
};

type FocusSoundController = {
  prime(): Promise<unknown>;
  saveSettings(): Promise<void>;
  setVolume(value: number): void;
};

interface AppEventsContext {
  state: UiState;
  devicePanel: BasicPanelController;
  hardeningPanel: HardeningEventPanel;
  distanceKeyUi: DistanceKeyUiController;
  focusSound: FocusSoundController;
  forms: FormController;
  post: PostRequest;
  refresh(): Promise<void>;
  toast(message: string): void;
  setProtectionLevel(level: number): Promise<void>;
}

export function bindAppEvents(context: AppEventsContext) {
  const { state, devicePanel, hardeningPanel, distanceKeyUi, focusSound, forms, post, refresh, toast, setProtectionLevel } = context;

  devicePanel.bind();
  hardeningPanel.bind();
  const profileForm = $("#profileForm") as unknown as HTMLFormElement;
  trackFormChanges(profileForm);

  $$("[data-scan-distance-key]").forEach((button) => {
    button.addEventListener("click", () => distanceKeyUi.openScanner(button.dataset.scanDistanceKey));
  });
  $("#closeDistanceScanner").addEventListener("click", distanceKeyUi.closeScanner);

  const protectionLevel = $("#protectionLevel");
  protectionLevel.addEventListener("input", () => {
    const level = Math.max(1, Math.min(4, Number(protectionLevel.value || 1)));
    $("#protectionLevelControl").dataset.level = String(level);
    $("#protectionLevelLabel").textContent = level === 4 ? "Panic" : `Level ${level}`;
    $("#protectionLevelStatus").textContent = level === 4 ? "3 min lock" : "Release to apply";
  });
  protectionLevel.addEventListener("change", () => {
    void setProtectionLevel(Number(protectionLevel.value || 1));
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
    const value = Number($("#focusSoundVolume").value || 0);
    focusSound.setVolume(value);
    const output = document.querySelector<HTMLOutputElement>("#focusSoundVolumeValue");
    if (output) output.value = String(value);
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

  $("#focusSoundPlayButton").addEventListener("click", async () => {
    const enabled = !$("#focusSoundEnabled").checked;
    $("#focusSoundEnabled").checked = enabled;
    await persistFocusSound(enabled ? "Sound on" : "Sound paused", enabled);
  });

  $("#audioSoundLibrary").addEventListener("click", async (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-focus-preset]");
    if (!button?.dataset.focusPreset) return;
    $("#focusSoundPreset").value = button.dataset.focusPreset;
    $("#focusSoundEnabled").checked = true;
    await persistFocusSound(`Playing ${button.querySelector("strong")?.textContent || "sound"}`, true);
  });

  for (const button of $$<HTMLButtonElement>("[data-focus-mode]")) {
    button.addEventListener("click", async () => {
      $("#focusSoundMode").value = button.dataset.focusMode || "focus";
      $("#focusSoundActivity").value = button.dataset.focusActivityDefault || "deep-work";
      await persistFocusSound("Purpose changed");
    });
  }

  $("#focusSoundActivityButtons").addEventListener("click", async (event: Event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("[data-focus-activity]");
    if (!button?.dataset.focusActivity) return;
    $("#focusSoundActivity").value = button.dataset.focusActivity;
    await persistFocusSound("Activity changed");
  });

  for (const button of $$<HTMLButtonElement>("[data-focus-intensity]")) {
    button.addEventListener("click", async () => {
      $("#focusSoundIntensity").value = button.dataset.focusIntensity || "medium";
      await persistFocusSound("Intensity changed");
    });
  }

  for (const button of $$<HTMLButtonElement>("[data-focus-timer-mode]")) {
    button.addEventListener("click", async () => {
      $("#focusSoundTimerMode").value = button.dataset.focusTimerMode || "infinite";
      if (button.dataset.focusTimerMinutes) $("#focusSoundTimerMinutes").value = button.dataset.focusTimerMinutes;
      if (button.dataset.focusBreakMinutes) $("#focusSoundBreakMinutes").value = button.dataset.focusBreakMinutes;
      await persistFocusSound("Timer changed");
    });
  }

  async function persistFocusSound(message: string, prime = false): Promise<void> {
    try {
      if (prime) {
        void focusSound.prime().catch((error) => toast(errorMessage(error)));
      }
      await focusSound.saveSettings();
      toast(message);
    } catch (error) {
      toast(errorMessage(error));
    }
    await refresh();
  }

  $("#profileSelect").addEventListener("change", async (event: Event) => {
    state.selectedProfileId = eventTarget(event).value;
    markFormSaved(profileForm);
    await post("/api/settings", { activeProfileId: state.selectedProfileId });
    await refresh();
  });

  $("#profileForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const submittedRevision = formRevision(profileForm);
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.blockedApps = lines(body.blockedApps);
    body.blockedSites = lines(body.blockedSites);
    body.blockedUrlPatterns = lines(body.blockedUrlPatterns);
    body.allowedApps = lines(body.allowedApps);
    body.allowedSites = lines(body.allowedSites);
    await post("/api/profile", body);
    markFormSavedAtRevision(profileForm, submittedRevision);
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
    forms.resetScheduleForm();
    await refresh();
  });

  $("#newSchedule").addEventListener("click", forms.resetScheduleForm);
  type GrayscaleSettingsPayload = {
    softBlockEnabled: boolean;
    preventManualChanges: boolean;
  };
  let pendingGrayscaleSettings: GrayscaleSettingsPayload | null = null;
  let grayscaleSettingsSavePromise: Promise<void> | null = null;
  const readGrayscaleSettings = (): GrayscaleSettingsPayload => ({
    softBlockEnabled: $("#grayscaleSoftBlockEnabled").checked,
    preventManualChanges: $("#grayscalePreventManualChanges").checked
  });
  const saveGrayscaleSettings = async () => {
    pendingGrayscaleSettings = readGrayscaleSettings();
    if (!grayscaleSettingsSavePromise) {
      grayscaleSettingsSavePromise = (async () => {
        try {
          while (pendingGrayscaleSettings) {
            const body = pendingGrayscaleSettings;
            pendingGrayscaleSettings = null;
            try {
              await post("/api/grayscale/settings", body);
              toast("Grayscale saved");
            } catch (error) {
              toast(errorMessage(error));
            }
            await refresh();
          }
        } finally {
          grayscaleSettingsSavePromise = null;
        }
      })();
    }
    await grayscaleSettingsSavePromise;
  };

  $("#grayscaleSettingsForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    await saveGrayscaleSettings();
  });

  for (const id of ["grayscaleSoftBlockEnabled", "grayscalePreventManualChanges"]) {
    $(`#${id}`).addEventListener("change", saveGrayscaleSettings);
  }

  $("#grayscaleScheduleForm").addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const body = formPayload(form);
    body.enabled = form.has("enabled");
    body.days = [...$$("#grayscaleScheduleDays input:checked")].map((input) => Number(input.value));
    body.deviceTargets = [...$$<HTMLInputElement>("#grayscaleScheduleForm input[name='deviceTargets']:checked")].map((input) => input.value);
    await post("/api/grayscale/schedule", body);
    toast("Grayscale schedule saved");
    forms.resetGrayscaleScheduleForm();
    await refresh();
  });

  $("#newGrayscaleSchedule").addEventListener("click", forms.resetGrayscaleScheduleForm);
  $("#newLimit").addEventListener("click", forms.resetLimitForm);
  $("#newAppLock").addEventListener("click", forms.resetAppLockForm);
  $("#newIntentionalRule").addEventListener("click", forms.resetIntentionalRuleForm);
  $("#newBehavior").addEventListener("click", forms.resetBehaviorForm);

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
    forms.resetLimitForm();
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
    forms.resetAppLockForm();
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
      forms.resetIntentionalRuleForm();
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
    try {
      await post("/api/intentional-use/journal", body);
      toast("Entry saved");
      forms.resetJournalForm();
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
    body.ruleIds = forms.selectedValues("#behaviorRuleIds");
    try {
      await post("/api/intentional-use/behavior", body);
      toast("Behavior saved");
      forms.resetBehaviorForm();
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
