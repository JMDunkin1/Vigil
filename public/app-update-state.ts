export interface AppUpdateDisplayStatus {
  ok?: unknown;
  checkOk?: unknown;
  supported?: unknown;
  running?: unknown;
  updateAvailable?: unknown;
  localChanges?: unknown;
  maintenanceReady?: unknown;
  recoveryPending?: unknown;
  recoveryBlocked?: unknown;
  operation?: unknown;
  phase?: unknown;
  message?: unknown;
}

export interface AppUpdateViewState {
  actionLabel: string;
  actionEnabled: boolean;
  installable: boolean;
  running: boolean;
  shouldPoll: boolean;
  statusMessage: string;
}

export function deriveAppUpdateViewState(
  status: AppUpdateDisplayStatus | null,
  { checking = false, starting = false }: { checking?: boolean; starting?: boolean } = {}
): AppUpdateViewState {
  const coordinatedOperation = status?.operation === "checking" || status?.operation === "starting"
    ? status.operation
    : null;
  if (starting || coordinatedOperation === "starting") {
    return {
      actionLabel: "Starting Update...",
      actionEnabled: false,
      installable: false,
      running: true,
      shouldPoll: coordinatedOperation === "starting",
      statusMessage: "Starting update..."
    };
  }
  if (checking || coordinatedOperation === "checking") {
    return {
      actionLabel: "Checking for Updates...",
      actionEnabled: false,
      installable: false,
      running: false,
      shouldPoll: coordinatedOperation === "checking",
      statusMessage: "Checking for updates..."
    };
  }

  if (!status) {
    return {
      actionLabel: "Check for Updates",
      actionEnabled: true,
      installable: false,
      running: false,
      shouldPoll: false,
      statusMessage: "Not checked"
    };
  }

  const supported = status.supported !== false;
  const maintenanceReady = status.maintenanceReady !== false;
  const recoveryBlocked = status.recoveryBlocked === true;
  const recoveryPending = status.recoveryPending === true && !recoveryBlocked;
  const running = status.running === true;
  const installable = status.ok === true
    && status.checkOk !== false
    && supported
    && maintenanceReady
    && !recoveryPending
    && !recoveryBlocked
    && !running
    && status.updateAvailable === true;
  const phase = String(status.phase || "");
  const suppliedMessage = typeof status.message === "string" ? status.message.trim() : "";
  const exactRecoveryMessage = suppliedMessage && typeof status.message === "string" ? status.message : "";
  const statusMessage = recoveryBlocked || recoveryPending
    ? exactRecoveryMessage || (recoveryBlocked ? "Vigil update recovery requires attention." : "Recovering the interrupted Vigil update...")
    : running && phase === "complete"
    ? "Finishing the successful Vigil update..."
    : running && phase === "failed"
      ? "Finishing protected recovery from the failed update..."
      : suppliedMessage || (supported ? "Vigil is current" : "Updates are unavailable");

  let actionLabel = "Check for Updates";
  if (recoveryBlocked) actionLabel = "Update Recovery Required";
  else if (recoveryPending) actionLabel = "Recovering Vigil Update...";
  else if (running) actionLabel = "Updating Vigil...";
  else if (!supported) actionLabel = "Updates Unavailable";
  else if (!maintenanceReady) actionLabel = "Update Setup Required";
  else if (installable) actionLabel = status.localChanges === true ? "Run Local Changes" : "Install Update";
  else if (status.checkOk === false) actionLabel = "Retry Update Check";

  return {
    actionLabel,
    actionEnabled: supported && maintenanceReady && !recoveryPending && !recoveryBlocked && !running,
    installable,
    running: running || recoveryPending,
    shouldPoll: running || recoveryPending,
    statusMessage
  };
}
