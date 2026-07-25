import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deriveAppUpdateViewState } from "../public/app-update-state.js";

const sourceRoot = process.cwd().endsWith(join("dist", "runtime"))
  || process.cwd().endsWith(join("dist.nosync", "runtime"))
  ? resolve(process.cwd(), "..", "..")
  : process.cwd();
const [mainSource, panelSource] = await Promise.all([
  readFile(join(sourceRoot, "app", "main.ts"), "utf8"),
  readFile(join(sourceRoot, "public", "app-update.ts"), "utf8")
]);
assert.match(mainSource, /deriveAppUpdateViewState/u, "the native menu must consume the shared updater view state");
assert.match(panelSource, /deriveAppUpdateViewState/u, "Settings must consume the shared updater view state");
assert.match(
  mainSource,
  /const setupOnly = !appUpdateActionState\.maintenanceReady[\s\S]*?!appUpdateActionState\.candidateAvailable && !setupOnly/u,
  "native start must permit guardian-only migration while still rejecting an update without a verified candidate"
);
assert.match(
  panelSource,
  /const requestedAction = currentView\(\)\.actionKind[\s\S]*?requestedAction !== "update" && requestedAction !== "setup"/u,
  "Settings must not invoke setup/update start from its discovery action"
);

assert.deepEqual(deriveAppUpdateViewState(null), {
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
});

assert.equal(deriveAppUpdateViewState(null, { checking: true }).actionLabel, "Checking for Updates…");

const starting = deriveAppUpdateViewState(null, { checking: true, starting: true });
assert.deepEqual(starting, {
  actionKind: "none",
  actionLabel: "Starting Update…",
  actionEnabled: false,
  installable: false,
  setupRequired: false,
  running: true,
  shouldPoll: false,
  busy: true,
  showProgress: true,
  progressLabel: "Preparing your update…",
  statusMessage: "Preparing your update…",
  helpMessage: "Vigil keeps enforcing your rules while it prepares the new build."
}, "starting must remain a disabled operation state and take priority over a concurrent checking render");

const coordinatedStarting = deriveAppUpdateViewState({ operation: "starting", running: true, message: "Starting elsewhere" });
assert.equal(coordinatedStarting.actionLabel, starting.actionLabel);
assert.equal(coordinatedStarting.actionEnabled, false);
assert.equal(coordinatedStarting.shouldPoll, true, "a coordinated starting broadcast must rehydrate until its final state arrives");
assert.equal(
  deriveAppUpdateViewState({ operation: "checking", message: "Checking elsewhere" }).shouldPoll,
  true,
  "a coordinated remote check must rehydrate until the checking operation publishes its result"
);

const current = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: true,
  running: false,
  updateAvailable: false,
  message: "Vigil is current"
});
assert.equal(current.actionLabel, "Check for Updates");
assert.equal(current.actionEnabled, true);
assert.equal(current.statusMessage, "Vigil is current");

const remote = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: true,
  running: false,
  updateAvailable: true,
  localChanges: false,
  message: "2 remote commits ready"
});
assert.equal(remote.actionLabel, "Install Update");
assert.equal(remote.installable, true);

const local = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: true,
  running: false,
  updateAvailable: true,
  localChanges: true,
  message: "Local changes ready to run"
});
assert.equal(local.actionKind, "update");
assert.equal(local.actionLabel, "Run Latest Changes");
assert.equal(local.installable, true);

const setupAndUpdate = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: false,
  maintenanceSetupRequired: true,
  maintenanceSetupSupported: true,
  running: false,
  updateAvailable: true,
  updateCandidateAvailable: true,
  localChanges: true,
  message: "One-time setup is needed"
});
assert.equal(setupAndUpdate.actionKind, "setup");
assert.equal(setupAndUpdate.actionLabel, "Enable Fast Updates");
assert.equal(setupAndUpdate.actionEnabled, true);
assert.equal(setupAndUpdate.installable, false,
  "guardian migration must finish and pass postflight before the selected update becomes installable");
assert.equal(setupAndUpdate.setupRequired, true);
assert.equal(setupAndUpdate.statusMessage, "One-time setup is needed for fast updates.");

const legacyDiscovery = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: false,
  maintenanceSetupRequired: true,
  maintenanceSetupSupported: true,
  running: false,
  updateAvailable: false,
  updateCandidateAvailable: false,
  message: "One-time setup is available when an update is ready"
});
assert.equal(legacyDiscovery.actionKind, "setup");
assert.equal(legacyDiscovery.actionLabel, "Enable Fast Updates");
assert.equal(legacyDiscovery.actionEnabled, true,
  "guardian migration must remain available even when no update candidate exists");
assert.equal(legacyDiscovery.installable, false,
  "guardian-only setup is not itself an app installation");
assert.equal(legacyDiscovery.setupRequired, true);
assert.match(legacyDiscovery.helpMessage, /install and verify the compatible guardian/u);

const settingUp = deriveAppUpdateViewState({
  ...setupAndUpdate,
  operation: "setting-up"
});
assert.equal(settingUp.actionKind, "none");
assert.equal(settingUp.actionLabel, "Enabling Fast Updates…");
assert.equal(settingUp.actionEnabled, false);
assert.equal(settingUp.busy, true);
assert.equal(settingUp.showProgress, true);
assert.match(settingUp.statusMessage, /Approve the macOS prompt once/u);

const failedSetup = deriveAppUpdateViewState({
  ok: false,
  checkOk: true,
  supported: true,
  maintenanceReady: false,
  maintenanceSetupRequired: true,
  maintenanceSetupSupported: true,
  updateCandidateAvailable: true,
  localChanges: true,
  message: "The administrator approval was canceled."
});
assert.equal(failedSetup.actionKind, "setup");
assert.equal(failedSetup.actionLabel, "Retry Fast Update Setup");
assert.equal(failedSetup.actionEnabled, true);
assert.equal(failedSetup.statusMessage, "The administrator approval was canceled.");

const unsafeSetup = deriveAppUpdateViewState({
  ok: true,
  checkOk: true,
  supported: true,
  maintenanceReady: false,
  maintenanceSetupRequired: true,
  maintenanceSetupSupported: false,
  updateCandidateAvailable: true,
  message: "Vigil's system guardian directory is unsafe."
});
assert.equal(unsafeSetup.actionKind, "none");
assert.equal(unsafeSetup.actionLabel, "Update Setup Required");
assert.equal(unsafeSetup.actionEnabled, false, "an unsafe setup must never become a generic privileged repair action");

const running = deriveAppUpdateViewState({
  ok: true,
  checkOk: false,
  supported: false,
  maintenanceReady: false,
  running: true,
  phase: "building",
  message: "Building local Vigil changes"
});
assert.equal(running.actionLabel, "Building Update…");
assert.equal(running.actionEnabled, false);
assert.equal(running.shouldPoll, true, "a transient check/support failure must not stop active-attempt polling");
assert.equal(running.showProgress, true);
assert.match(running.statusMessage, /Vigil stays active/u);

const installing = deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: true,
  phase: "installing-app",
  localChanges: true
});
assert.equal(installing.actionLabel, "Installing Update…");
assert.equal(installing.statusMessage, "Build ready — switching to it…");

const verifying = deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: true,
  phase: "verifying"
});
assert.equal(verifying.actionLabel, "Reopening Vigil…");
assert.equal(verifying.statusMessage, "Reopening and checking the new build…");

assert.equal(deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: false,
  updateAvailable: false,
  phase: "complete",
  message: "Local Vigil update complete"
}).statusMessage, "Vigil is running the latest build.");

const recoveryPending = deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: false,
  updateAvailable: true,
  recoveryPending: true,
  message: "Restoring the verified Vigil recovery copy."
});
assert.deepEqual(recoveryPending, {
  actionKind: "none",
  actionLabel: "Recovering Vigil Update…",
  actionEnabled: false,
  installable: false,
  setupRequired: false,
  running: true,
  shouldPoll: true,
  busy: true,
  showProgress: true,
  progressLabel: "Restoring the verified Vigil recovery copy.",
  statusMessage: "Restoring the verified Vigil recovery copy.",
  helpMessage: "Vigil is safely finishing the previous update transaction."
}, "pending recovery must remain a disabled, polling state even without a live updater lock");

const recoveryBlocked = deriveAppUpdateViewState({
  ok: false,
  supported: true,
  maintenanceReady: false,
  running: false,
  updateAvailable: true,
  recoveryPending: true,
  recoveryBlocked: true,
  message: "The preserved recovery evidence needs manual attention."
});
assert.deepEqual(recoveryBlocked, {
  actionKind: "none",
  actionLabel: "Update Recovery Required",
  actionEnabled: false,
  installable: false,
  setupRequired: false,
  running: false,
  shouldPoll: false,
  busy: false,
  showProgress: false,
  progressLabel: "",
  statusMessage: "The preserved recovery evidence needs manual attention.",
  helpMessage: "Vigil preserved the last known-good build. Review the status before trying again."
}, "blocked recovery must outrank pending/setup states and preserve the updater's exact message");
assert.equal(deriveAppUpdateViewState({
  ...unsafeSetup,
  operation: "setting-up",
  recoveryBlocked: true,
  message: "Recovery evidence needs attention."
}).actionLabel, "Update Recovery Required", "recovery must outrank even an in-flight setup broadcast");

const finishingFailure = deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: true,
  phase: "failed",
  message: "Old unrelated failure"
});
assert.equal(finishingFailure.statusMessage, "Finishing protected recovery from the failed update…");

assert.equal(deriveAppUpdateViewState({
  ok: true,
  supported: false,
  running: false,
  message: "Packaged app required"
}).actionLabel, "Updates Unavailable");
assert.equal(deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: false,
  running: false,
  message: "Guardian setup required"
}).actionLabel, "Update Setup Required");
assert.equal(deriveAppUpdateViewState({
  ok: true,
  checkOk: false,
  supported: true,
  maintenanceReady: true,
  running: false,
  message: "Could not verify remote updates"
}).actionLabel, "Retry Update Check");
