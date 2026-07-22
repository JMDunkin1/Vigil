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

assert.deepEqual(deriveAppUpdateViewState(null), {
  actionLabel: "Check for Updates",
  actionEnabled: true,
  installable: false,
  running: false,
  shouldPoll: false,
  statusMessage: "Not checked"
});

assert.equal(deriveAppUpdateViewState(null, { checking: true }).actionLabel, "Checking for Updates...");

const starting = deriveAppUpdateViewState(null, { checking: true, starting: true });
assert.deepEqual(starting, {
  actionLabel: "Starting Update...",
  actionEnabled: false,
  installable: false,
  running: true,
  shouldPoll: false,
  statusMessage: "Starting update..."
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
assert.equal(local.actionLabel, "Run Local Changes");
assert.equal(local.installable, true);

const running = deriveAppUpdateViewState({
  ok: true,
  checkOk: false,
  supported: false,
  maintenanceReady: false,
  running: true,
  phase: "building",
  message: "Building local Vigil changes"
});
assert.equal(running.actionLabel, "Updating Vigil...");
assert.equal(running.actionEnabled, false);
assert.equal(running.shouldPoll, true, "a transient check/support failure must not stop active-attempt polling");

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
  actionLabel: "Recovering Vigil Update...",
  actionEnabled: false,
  installable: false,
  running: true,
  shouldPoll: true,
  statusMessage: "Restoring the verified Vigil recovery copy."
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
  actionLabel: "Update Recovery Required",
  actionEnabled: false,
  installable: false,
  running: false,
  shouldPoll: false,
  statusMessage: "The preserved recovery evidence needs manual attention."
}, "blocked recovery must outrank pending/setup states and preserve the updater's exact message");

const finishingFailure = deriveAppUpdateViewState({
  ok: true,
  supported: true,
  maintenanceReady: true,
  running: true,
  phase: "failed",
  message: "Old unrelated failure"
});
assert.equal(finishingFailure.statusMessage, "Finishing protected recovery from the failed update...");

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
