export interface AppUpdateDisplayStatus {
  ok?: unknown;
  checkOk?: unknown;
  supported?: unknown;
  running?: unknown;
  updateAvailable?: unknown;
  updateCandidateAvailable?: unknown;
  localChanges?: unknown;
  maintenanceReady?: unknown;
  maintenanceSetupRequired?: unknown;
  maintenanceSetupSupported?: unknown;
  recoveryPending?: unknown;
  recoveryBlocked?: unknown;
  operation?: unknown;
  phase?: unknown;
  message?: unknown;
}

export type AppUpdateActionKind = "check" | "update" | "setup-update" | "none";

export interface AppUpdateViewState {
  actionKind: AppUpdateActionKind;
  actionLabel: string;
  actionEnabled: boolean;
  installable: boolean;
  setupRequired: boolean;
  running: boolean;
  shouldPoll: boolean;
  busy: boolean;
  showProgress: boolean;
  progressLabel: string;
  statusMessage: string;
  helpMessage: string;
}

export function deriveAppUpdateViewState(
  status: AppUpdateDisplayStatus | null,
  {
    checking = false,
    starting = false,
    settingUp = false
  }: { checking?: boolean; starting?: boolean; settingUp?: boolean } = {}
): AppUpdateViewState {
  const operation = String(status?.operation || "");
  const coordinatedOperation = ["checking", "starting", "setup", "setting-up"].includes(operation)
    ? operation
    : null;
  const recoveryBlocked = status?.recoveryBlocked === true;
  const recoveryPending = status?.recoveryPending === true && !recoveryBlocked;
  const setupRequired = status?.maintenanceSetupRequired === true
    || (status?.maintenanceReady === false && status?.maintenanceSetupSupported === true);
  const setupInProgress = !recoveryPending && !recoveryBlocked && (
    settingUp
    || coordinatedOperation === "setup"
    || coordinatedOperation === "setting-up"
    || ((starting || coordinatedOperation === "starting") && setupRequired)
  );

  if (setupInProgress) {
    const statusMessage = "Approve the macOS prompt once. Your update will continue automatically.";
    return busyState({
      actionLabel: "Enabling Fast Updates…",
      helpMessage: "This is a one-time setup. Vigil stays active while macOS approves it.",
      setupRequired: true,
      shouldPoll: coordinatedOperation !== null,
      statusMessage
    });
  }

  if (!recoveryPending && !recoveryBlocked && (starting || coordinatedOperation === "starting")) {
    const statusMessage = "Preparing your update…";
    return busyState({
      actionLabel: "Starting Update…",
      helpMessage: "Vigil keeps enforcing your rules while it prepares the new build.",
      setupRequired: false,
      shouldPoll: coordinatedOperation === "starting",
      statusMessage
    });
  }

  if (!recoveryPending && !recoveryBlocked && (checking || coordinatedOperation === "checking")) {
    const statusMessage = "Checking for local changes and verified updates…";
    return {
      actionKind: "none",
      actionLabel: "Checking for Updates…",
      actionEnabled: false,
      installable: false,
      setupRequired: false,
      running: false,
      shouldPoll: coordinatedOperation === "checking",
      busy: true,
      showProgress: true,
      progressLabel: statusMessage,
      statusMessage,
      helpMessage: "Vigil is comparing the running app with this checkout and its signed update channel."
    };
  }

  if (!status) {
    return {
      actionKind: "check",
      actionLabel: "Check for Updates",
      actionEnabled: true,
      installable: false,
      setupRequired: false,
      running: false,
      shouldPoll: false,
      busy: false,
      showProgress: false,
      progressLabel: "",
      statusMessage: "Not checked",
      helpMessage: "Build and switch to your latest local changes without leaving Vigil."
    };
  }

  const supported = status.supported !== false;
  const maintenanceReady = status.maintenanceReady !== false;
  const setupSupported = status.maintenanceSetupSupported === true;
  const running = status.running === true;
  const candidateAvailable = status.updateCandidateAvailable === true || status.updateAvailable === true;
  const setupCanContinue = setupRequired && setupSupported;
  const setupActionAvailable = setupCanContinue && candidateAvailable;
  const installable = status.ok === true
    && status.checkOk !== false
    && supported
    && (maintenanceReady || setupCanContinue)
    && !recoveryPending
    && !recoveryBlocked
    && !running
    && candidateAvailable;
  const phase = String(status.phase || "");
  const suppliedMessage = typeof status.message === "string" ? status.message.trim() : "";
  const exactRecoveryMessage = suppliedMessage && typeof status.message === "string" ? status.message : "";
  const statusMessage = recoveryBlocked || recoveryPending
    ? exactRecoveryMessage || (recoveryBlocked ? "Vigil update recovery requires attention." : "Recovering the interrupted Vigil update…")
    : running && phase === "complete"
      ? "Finishing the successful Vigil update…"
      : running && phase === "failed"
        ? "Finishing protected recovery from the failed update…"
        : running
          ? runningStatusMessage(phase, status.localChanges === true, suppliedMessage)
          : setupActionAvailable
            ? status.ok === false
              ? suppliedMessage || "Fast update setup did not finish."
              : "One-time setup is needed for fast updates."
            : phase === "complete" && !candidateAvailable
              ? "Vigil is running the latest build."
              : candidateAvailable && status.localChanges === true
                ? "Your latest local changes are ready."
                : suppliedMessage || (supported ? "Vigil is current" : "Updates are unavailable");

  let actionKind: AppUpdateActionKind = "check";
  let actionLabel = "Check for Updates";
  if (recoveryBlocked) {
    actionKind = "none";
    actionLabel = "Update Recovery Required";
  } else if (recoveryPending) {
    actionKind = "none";
    actionLabel = "Recovering Vigil Update…";
  } else if (running) {
    actionKind = "none";
    actionLabel = runningActionLabel(phase);
  } else if (!supported) {
    actionKind = "none";
    actionLabel = "Updates Unavailable";
  } else if (setupActionAvailable) {
    actionKind = "setup-update";
    actionLabel = status.ok === false ? "Retry Setup & Update" : "Enable & Run Latest";
  } else if ((!maintenanceReady || setupRequired) && !setupCanContinue) {
    actionKind = "none";
    actionLabel = "Update Setup Required";
  } else if (installable) {
    actionKind = "update";
    actionLabel = status.localChanges === true ? "Run Latest Changes" : "Install Update";
  } else if (status.checkOk === false) {
    actionLabel = "Retry Update Check";
  }

  const busy = running || recoveryPending;
  return {
    actionKind,
    actionLabel,
    actionEnabled: actionKind !== "none",
    installable,
    setupRequired,
    running: running || recoveryPending,
    shouldPoll: running || recoveryPending,
    busy,
    showProgress: busy,
    progressLabel: busy ? statusMessage : "",
    statusMessage,
    helpMessage: helpMessage({
      candidateAvailable,
      localChanges: status.localChanges === true,
      maintenanceReady,
      recoveryBlocked,
      recoveryPending,
      running,
      setupCanContinue,
      supported
    })
  };
}

function busyState({
  actionLabel,
  helpMessage,
  setupRequired,
  shouldPoll,
  statusMessage
}: {
  actionLabel: string;
  helpMessage: string;
  setupRequired: boolean;
  shouldPoll: boolean;
  statusMessage: string;
}): AppUpdateViewState {
  return {
    actionKind: "none",
    actionLabel,
    actionEnabled: false,
    installable: false,
    setupRequired,
    running: true,
    shouldPoll,
    busy: true,
    showProgress: true,
    progressLabel: statusMessage,
    statusMessage,
    helpMessage
  };
}

function runningActionLabel(phase: string): string {
  if (["selecting", "staging", "installing", "building", "packaging"].includes(phase)) return "Building Update…";
  if (["waiting", "installing-runtime", "installing-app", "updating-source"].includes(phase)) return "Installing Update…";
  if (phase === "verifying") return "Reopening Vigil…";
  return "Updating Vigil…";
}

function runningStatusMessage(phase: string, localChanges: boolean, suppliedMessage: string): string {
  if (["selecting", "staging", "installing", "building", "packaging"].includes(phase)) {
    return localChanges
      ? "Building latest changes in the background. Vigil stays active."
      : "Building the verified update in the background. Vigil stays active.";
  }
  if (["waiting", "installing-runtime", "installing-app", "updating-source"].includes(phase)) {
    return "Build ready — switching to it…";
  }
  if (phase === "verifying") return "Reopening and checking the new build…";
  return suppliedMessage || "Updating Vigil…";
}

function helpMessage({
  candidateAvailable,
  localChanges,
  maintenanceReady,
  recoveryBlocked,
  recoveryPending,
  running,
  setupCanContinue,
  supported
}: {
  candidateAvailable: boolean;
  localChanges: boolean;
  maintenanceReady: boolean;
  recoveryBlocked: boolean;
  recoveryPending: boolean;
  running: boolean;
  setupCanContinue: boolean;
  supported: boolean;
}): string {
  if (recoveryBlocked) return "Vigil preserved the last known-good build. Review the status before trying again.";
  if (recoveryPending) return "Vigil is safely finishing the previous update transaction.";
  if (running) return "The current app keeps enforcing your rules until the replacement is ready.";
  if (!supported) return "This build does not include the protected updater.";
  if (setupCanContinue && candidateAvailable) {
    return "Approve one macOS password prompt. Vigil will enable fast updates and continue automatically.";
  }
  if (setupCanContinue) {
    return "Check for Updates first. Vigil starts one-time setup only after it finds a verified update.";
  }
  if (!maintenanceReady) return "Protected update setup must be repaired before Vigil can replace the app.";
  if (candidateAvailable && localChanges) return "Vigil will build in the background, switch versions, and reopen automatically.";
  if (candidateAvailable) return "Vigil will verify, install, and reopen automatically.";
  return "Local changes appear automatically; Check for Updates also checks the signed update channel.";
}
