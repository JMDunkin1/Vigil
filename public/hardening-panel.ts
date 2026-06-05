import type { ControlElement, DashboardData, DashboardItem, DashboardState, DistanceKeySummary, FocusShortcutSummary, FoolproofSummary, KeyholderSummary, ProtectionSummary } from "./app-model.js";
import { textEl } from "./dom.js";
import { formatDuration } from "./format.js";

type QueryElement = (selector: string) => ControlElement;
type PostRequest = <T = unknown>(path: string, body: unknown) => Promise<T>;

interface HardeningPanelContext {
  $: QueryElement;
  post: PostRequest;
  toast(message: string): void;
  errorMessage(error: unknown): string;
  refresh(): Promise<void>;
  getData(): DashboardData | null;
  setPendingMaintenanceId(id: string | null): void;
}

export function createHardeningPanel(context: HardeningPanelContext) {
  return {
    bind() {
      bindHardeningActions(context);
      bindProtectedSettingControls(context);
    },
    render(data: DashboardData) {
      renderHardening(data, context);
    },
    renderMaintenance(protection: ProtectionSummary) {
      renderMaintenance(protection, context);
    },
    copyText(value: string, message: string) {
      return copyHardeningText(value, message, context);
    }
  };
}

function bindHardeningActions(context: HardeningPanelContext): void {
  const { $, post, toast, errorMessage, refresh, getData } = context;

  $("#installLaunchAgent").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    status.textContent = "Installing login agent...";
    $("#installLaunchAgent").disabled = true;
    try {
      await post("/api/hardening/launch-agent/install", {});
      status.textContent = "Login agent installed";
      toast("Login agent installed");
    } catch (error) {
      status.textContent = errorMessage(error);
      toast(errorMessage(error));
    } finally {
      $("#installLaunchAgent").disabled = false;
    }
    await refresh();
  });

  $("#applyHostsBlock").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    const action = getData()?.hardening.actions?.hostsApply || {};
    status.textContent = "Waiting for macOS password...";
    $("#applyHostsBlock").disabled = true;
    try {
      await post(action.path || "/api/hardening/hosts/apply", {});
      status.textContent = "Network block applied";
      toast("Network block applied");
    } catch (error) {
      status.textContent = errorMessage(error);
      toast(errorMessage(error));
    } finally {
      $("#applyHostsBlock").disabled = false;
    }
    await refresh();
  });

  $("#applySafariFilter").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    const action = getData()?.hardening.actions?.safariFilterApply || {};
    status.textContent = "Opening Safari filter profile...";
    $("#applySafariFilter").disabled = true;
    try {
      await post(action.path || "/api/hardening/safari-filter/apply", {});
      status.textContent = "Safari filter profile opened";
      toast("Approve Safari filter in System Settings");
    } catch (error) {
      status.textContent = errorMessage(error);
      toast(errorMessage(error));
    } finally {
      $("#applySafariFilter").disabled = false;
    }
    await refresh();
  });

  $("#clearTamperAlarm").addEventListener("click", async () => {
    const status = $("#hardeningActionStatus");
    const action = getData()?.hardening.actions?.tamperClear || {};
    status.textContent = "Clearing tamper alarm...";
    $("#clearTamperAlarm").disabled = true;
    try {
      await post(action.path || "/api/integrity/clear-tamper", {});
      status.textContent = "Tamper alarm cleared";
      toast("Tamper alarm cleared");
    } catch (error) {
      status.textContent = errorMessage(error);
      toast(errorMessage(error));
    } finally {
      $("#clearTamperAlarm").disabled = false;
    }
    await refresh();
  });

  $("#copyHostsCommand").addEventListener("click", async () => {
    const command = getData()?.hardening.actions?.hostsApply?.command || "npm run network:apply";
    await copyHardeningText(command, "Network command copied", context);
  });

  $("#copySourceSealCommand").addEventListener("click", async () => {
    const command = getData()?.hardening.actions?.sourceSeal?.command || "npm run seal:source";
    await copyHardeningText(command, "Source seal command copied", context);
  });

  $("#copyExtensionPath").addEventListener("click", async () => {
    const path = getData()?.hardening.actions?.extensionLoad?.path || "extension";
    await copyHardeningText(path, "Extension path copied", context);
  });

  $("#exportBackup").addEventListener("click", () => {
    const status = $("#hardeningActionStatus");
    status.textContent = "Preparing backup...";
    const link = document.createElement("a");
    link.href = "/api/backup/export";
    link.download = "";
    document.body.append(link);
    link.click();
    link.remove();
    status.textContent = "Backup download started";
    toast("Backup download started");
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
      toast(errorMessage(error));
    }
    await refresh();
  });
}

function bindProtectedSettingControls({ $, post, toast, errorMessage, refresh }: HardeningPanelContext): void {
  for (const id of ["systemNetworkBlockingEnabled", "safariUrlFilterEnabled", "externalNetworkBlockEnabled", "siteRedirectEnabled", "contentFilterEnabled", "browserNoiseBlockingEnabled", "typingChallengeEnabled", "intentReasonEnabled", "appQuitEnabled", "strictBypassProtectionEnabled", "processSweepEnabled", "systemSleepLockEnabled", "focusShortcutEnabled", "strictByDefault", "protectedEditsEnabled", "foolproofModeEnabled"]) {
    $(`#${id}`).addEventListener("change", async (event: Event) => {
      try {
        await post("/api/settings", { [id]: (event.target as ControlElement).checked });
        toast("Setting saved");
      } catch (error) {
        toast(errorMessage(error));
      }
      await refresh();
    });
  }

  for (const [id, message] of [
    ["appQuitEscalationSeconds", "Escalation saved"],
    ["processSweepIntervalSeconds", "Sweep interval saved"],
    ["systemSleepLockIntervalSeconds", "Sleep relock saved"],
    ["panicLockDurationMinutes", "Panic duration saved"],
    ["intentReasonMinLength", "Reason gate saved"]
  ] as const) {
    $(`#${id}`).addEventListener("change", async (event: Event) => {
      try {
        await post("/api/settings", { [id]: (event.target as ControlElement).value });
        toast(message);
      } catch (error) {
        toast(errorMessage(error));
      }
      await refresh();
    });
  }
}

function renderHardening(data: DashboardData, context: HardeningPanelContext): void {
  const { $ } = context;
  const settings = data.state.settings;
  $("#systemNetworkBlockingEnabled").checked = settings.systemNetworkBlockingEnabled !== false;
  $("#safariUrlFilterEnabled").checked = true;
  $("#safariUrlFilterEnabled").disabled = true;
  $("#externalNetworkBlockEnabled").checked = Boolean(settings.externalNetworkBlockEnabled);
  $("#siteRedirectEnabled").checked = Boolean(settings.siteRedirectEnabled);
  $("#contentFilterEnabled").checked = true;
  $("#contentFilterEnabled").disabled = true;
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
  $("#appQuitEscalationSeconds").value = String(settings.appQuitEscalationSeconds || 10);
  $("#processSweepIntervalSeconds").value = String(settings.processSweepIntervalSeconds || 15);
  $("#systemSleepLockIntervalSeconds").value = String(settings.systemSleepLockIntervalSeconds || 60);
  $("#panicLockDurationMinutes").value = String(settings.panicLockDurationMinutes || 3);
  $("#intentReasonMinLength").value = String(settings.intentReasonMinLength || 20);
  renderIntentReasonHints(settings, $);
  renderFocusShortcut(data.state.focusShortcut, $);
  $("#hostsBlock").textContent = data.hardening.hostsBlock || "";
  renderHardeningActions(data.hardening, $);
  const hosts = data.hardening.hosts || {};
  const firewall = data.hardening.firewall || {};
  const networkCurrent = hosts.installed && !hosts.partial && !hosts.stale && firewall.installed && !firewall.partial && !firewall.stale;
  const networkWarn = hosts.partial || hosts.stale || firewall.partial || firewall.stale || hosts.installed || firewall.installed;
  $("#hostsStatus").textContent = networkCurrent
    ? "Network current"
    : (networkWarn ? "Network stale" : "Network preview");
  $("#hostsStatus").className = networkCurrent ? "pill good" : (networkWarn ? "pill warn" : "pill neutral");
  renderKeyholder(data.state.keyholder, $);
  renderDistanceKey(data.state.distanceKey, $);
  renderMaintenance(data.protection, context);
  renderAudit(data.hardening.audit || [], $);
  renderFoolproofBlockers(data.hardening.foolproof, $);
}

function renderHardeningActions(hardening: DashboardData["hardening"], $: QueryElement): void {
  const agent = hardening.launchAgent || {};
  const hosts = hardening.hosts || {};
  const firewall = hardening.firewall || {};
  const safariFilter = hardening.safariFilter || {};
  const networkCurrent = hosts.installed && !hosts.partial && !hosts.stale && firewall.installed && !firewall.partial && !firewall.stale;
  const safariCurrent = safariFilter.installed && !safariFilter.stale;
  const tamperActive = Boolean(hardening.stateSeal?.tamperDetectedAt || hardening.stateSeal?.status === "tamper-detected");
  $("#installLaunchAgent").textContent = agent.installed ? "Reinstall Login Agent" : "Install Login Agent";
  $("#applyHostsBlock").textContent = networkCurrent ? "Reapply Network Block" : "Apply Network Block";
  $("#applySafariFilter").textContent = safariCurrent ? "Reapply Safari Filter" : "Apply Safari Filter";
  $("#clearTamperAlarm").hidden = !tamperActive;
  $("#clearTamperAlarm").disabled = !tamperActive;
  $("#copyHostsCommand").textContent = networkCurrent ? "Copy Network Reapply" : "Copy Network Command";
}

function renderFocusShortcut(focusShortcut: FocusShortcutSummary, $: QueryElement): void {
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

function renderIntentReasonHints(settings: DashboardState["settings"], $: QueryElement): void {
  const min = settings.intentReasonEnabled === false ? 0 : (settings.intentReasonMinLength || 20);
  const hint = min ? `Reason (${min}+ chars)` : "Reason";
  for (const id of ["emergencyReason", "maintenanceReason", "appLockReason"]) {
    const field = $(`#${id}`);
    if (field) field.placeholder = hint;
  }
}

function renderKeyholder(keyholder: KeyholderSummary, $: QueryElement): void {
  $("#keyholderEnabled").checked = Boolean(keyholder?.enabled);
  $("#keyholderStatus").textContent = keyholder?.enabled
    ? "Required"
    : (keyholder?.hasPasscode ? "Saved" : "Not set");
}

function renderDistanceKey(distanceKey: DistanceKeySummary, $: QueryElement): void {
  $("#distanceKeyEnabled").checked = Boolean(distanceKey?.enabled);
  const keyFile = $("#distanceKeyFilePath");
  if (document.activeElement !== keyFile) keyFile.value = distanceKey?.keyFilePath || "";
  $("#distanceKeyStatus").textContent = distanceKey?.enabled
    ? (distanceKey?.hasKeyFile ? "File required" : "Required")
    : (distanceKey?.hasToken ? (distanceKey?.hasKeyFile ? "Saved + file" : "Saved") : "Not set");
}

function renderMaintenance(protection: ProtectionSummary, { $, setPendingMaintenanceId }: HardeningPanelContext): void {
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
    setPendingMaintenanceId(pending.id);
    renderTypingChallenge($("#maintenanceChallenge"), $("#maintenanceChallengeInput"), pending.challenge || null);
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

function renderAudit(items: DashboardItem[], $: QueryElement): void {
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

function renderFoolproofBlockers(foolproof: FoolproofSummary | undefined, $: QueryElement): void {
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

async function copyHardeningText(value: string, message: string, { $, toast }: HardeningPanelContext): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    $("#hardeningActionStatus").textContent = message;
    toast(message);
  } catch {
    $("#hardeningActionStatus").textContent = value;
    toast("Shown below");
  }
}

function prettyBlockerId(value: unknown): string {
  return String(value || "")
    .split("-")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderTypingChallenge(output: ControlElement, input: ControlElement, challenge: { text?: string } | null): void {
  const text = challenge?.text || "";
  output.classList.toggle("hidden", !text);
  input.classList.toggle("hidden", !text);
  output.textContent = text ? `Type: ${text}` : "";
  if (!text && document.activeElement !== input) input.value = "";
}
