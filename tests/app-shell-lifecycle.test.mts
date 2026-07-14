import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");
const serverSource = await readFile(join(root, "src", "server.ts"), "utf8");
const beforeQuitStart = mainSource.indexOf('app.on("before-quit"');
const beforeQuitEnd = mainSource.indexOf('\n});', beforeQuitStart);
assert.notEqual(beforeQuitStart, -1, "the app must retain a before-quit cleanup hook");
assert.notEqual(beforeQuitEnd, -1, "the before-quit cleanup hook must be complete");
const beforeQuitSource = mainSource.slice(beforeQuitStart, beforeQuitEnd + 4);

assert.match(
  mainSource,
  /app\.on\("activate", \(\) => \{\s*revealVigilWindow\(\);\s*\}\);/,
  "activating Vigil from Finder or Spotlight must reveal its visual window"
);
assert.match(
  mainSource,
  /app\.on\("second-instance", \(_event, argv\) => \{\s*if \(argv\.includes\(BACKGROUND_LAUNCH_ARG\)\) return;\s*revealVigilWindow\(\);\s*\}\);/,
  "manual singleton launches must reveal Vigil without letting supervisor retries open its window"
);
assert.match(
  mainSource,
  /function shouldShowWindowOnLaunch\(\): boolean \{\s*if \(process\.argv\.includes\(BACKGROUND_LAUNCH_ARG\)\) return false;\s*if \(!shouldStayResident\(\)\) return true;\s*const loginItem = app\.getLoginItemSettings\(\);\s*return !loginItem\.wasOpenedAtLogin && !loginItem\.wasOpenedAsHidden;\s*\}/,
  "manual launches must open visually while login and updater launches remain windowless"
);
assert.match(
  mainSource,
  /label: "Open Vigil",\s*click: \(\) => \{\s*showVigilWindow\(appUrl\);\s*\}/,
  "the menu-bar Open Vigil action must remain the explicit way to reveal the window"
);
assert.match(
  mainSource,
  /function showVigilWindow\(appUrl: string\): void \{[\s\S]*?if \(shouldStayResident\(\)\) \{[\s\S]*?app\.setActivationPolicy\("regular"\);[\s\S]*?app\.show\(\);[\s\S]*?if \(!mainWindow\) createWindow\(appUrl\);[\s\S]*?mainWindow\.show\(\);/,
  "an open resident window must enter regular macOS presentation before its native window is created or shown"
);
const showWindowStart = mainSource.indexOf("function showVigilWindow");
const showWindowEnd = mainSource.indexOf("\n}", showWindowStart);
const showWindowSource = mainSource.slice(showWindowStart, showWindowEnd + 2);
assert.doesNotMatch(showWindowSource, /app\.dock\?\.hide\(\)/, "opening Vigil must not demote the regular app back to accessory presentation");
assert.ok(
  showWindowSource.indexOf('app.setActivationPolicy("regular")') < showWindowSource.indexOf("createWindow(appUrl)"),
  "Vigil must never create native window chrome while the packaged app is still using accessory presentation"
);
assert.match(
  mainSource,
  /app\.on\("window-all-closed", \(\) => \{\s*if \(!shouldStayResident\(\)\) app\.quit\(\);/,
  "closing the last window must leave the packaged menu-bar companion running"
);
assert.match(
  beforeQuitSource,
  /shouldStayResident\(\)[\s\S]*?!quitForUpdate[\s\S]*?event\.preventDefault\(\)[\s\S]*?hideVigilWindow\(\)/,
  "normal quit attempts must hide the window and leave the packaged menu-bar companion running"
);
assert.match(
  mainSource,
  /function hideVigilWindow\(\): void \{\s*mainWindow\?\.hide\(\);\s*if \(shouldStayResident\(\)\) \{\s*app\.hide\(\);\s*enforceMenuBarOnlyPresentation\(\);\s*\}\s*\}/,
  "hiding Vigil must hide the visual app and restore its menu-bar-only presentation"
);
assert.match(
  mainSource,
  /function enforceMenuBarOnlyPresentation\(\): void \{\s*app\.setActivationPolicy\("accessory"\);\s*app\.dock\?\.hide\(\);\s*\}/,
  "the resident macOS app must use accessory activation policy and remain absent from the Dock"
);
assert.match(
  mainSource,
  /label: "Hide Vigil Window",\s*accelerator: "CommandOrControl\+Q"/,
  "Command-Q must hide the Vigil window without terminating its background companion"
);
assert.doesNotMatch(mainSource, /label: "Quit Vigil"/, "the menu-bar menu must not offer a misleading true-quit action");
assert.match(
  mainSource,
  /quitForUpdate: \(\) => \{\s*try \{\s*suspendEmbeddedRuntimeSupervisor\(\);\s*\} catch \(error\) \{[\s\S]*?return;\s*\}\s*quitForUpdate = true;\s*app\.quit\(\);\s*\}/,
  "an app update must stay running when restart supervision cannot be suspended and only quit after suspension succeeds"
);
assert.match(
  mainSource,
  /function suspendEmbeddedRuntimeSupervisor\(\): void \{\s*if \(!app\.isPackaged\) return;\s*const markerPath = embeddedRuntimeSupervisorMarkerPath\(\);\s*rmSync\(markerPath, \{ force: true \}\);\s*if \(existsSync\(markerPath\)\) \{\s*throw new Error\("Vigil could not verify that restart supervision was suspended\."\);\s*\}\s*\}/,
  "restart supervision suspension must surface marker-removal failures and verify the reopen marker is gone"
);
assert.match(
  beforeQuitSource,
  /if \(!ownedRuntime\) return;\s*event\.preventDefault\(\);\s*let runtimeStopped = false;\s*try \{\s*await stopOwnedRuntime\(\);\s*runtimeStopped = true;\s*await clearRuntimeReady\(appDataDir\(\)\);\s*app\.quit\(\);/,
  "the quit lifecycle must wait for the embedded runtime and readiness marker to flush before exiting"
);
assert.match(
  beforeQuitSource,
  /catch \(error\) \{\s*if \(quitForUpdate\) \{\s*resumeEmbeddedRuntimeSupervisor\(\);\s*if \(runtimeStopped\) \{[\s\S]*?app\.exit\(1\);\s*return;\s*\}\s*quitForUpdate = false;\s*\}/,
  "a failed update shutdown must exit under restored supervision if its embedded runtime has already stopped"
);
const dataDirectorySelectionIndex = mainSource.indexOf("configuredLaunchAgentDataDir() || persistedAppDataDir() || app.getPath(\"userData\")");
const networkPortMigrationIndex = mainSource.indexOf("configuredLaunchAgentPort() || persistedAppPort()", dataDirectorySelectionIndex);
const dataDirectoryPersistenceIndex = mainSource.indexOf("persistAppDataDir(process.env.VIGIL_DATA_DIR)");
const embeddedSupervisorIndex = mainSource.indexOf("await ensureEmbeddedRuntimeSupervisor(legacyAgent)");
const legacyAgentRetirementCallIndex = mainSource.indexOf("await retireLegacyLoopbackAgent(legacyAgent)");
assert.ok(
  dataDirectorySelectionIndex >= 0
    && networkPortMigrationIndex > dataDirectorySelectionIndex
    && dataDirectoryPersistenceIndex > networkPortMigrationIndex
    && embeddedSupervisorIndex > dataDirectoryPersistenceIndex
    && legacyAgentRetirementCallIndex > embeddedSupervisorIndex,
  "the packaged app must preserve legacy settings and load restart supervision before retiring the old LaunchAgent"
);
assert.match(
  mainSource,
  /function embeddedRuntimeSupervisorPlist[\s\S]*?<key>KeepAlive<\/key>[\s\S]*?<key>PathState<\/key>[\s\S]*?<true\/>/,
  "the embedded app supervisor must ask launchd to restart Vigil while its supervision marker exists"
);
assert.match(
  mainSource,
  /function embeddedRuntimeSupervisorScript[\s\S]*?runtime-ready\.json[\s\S]*?kill -0 "\$pid"[\s\S]*?\/usr\/bin\/open -g "\$app_path" --args \$\{BACKGROUND_LAUNCH_ARG\}/,
  "the launchd supervisor must watch the embedded runtime PID and reopen the packaged app in the background after a crash"
);
assert.match(
  mainSource,
  /function embeddedRuntimeSupervisorScript[\s\S]*?\/bin\/ps -p "\$pid" -o command=[\s\S]*?"\$command" != "\$executable_path"[\s\S]*?\/bin\/rm -f "\$ready"[\s\S]*?\/usr\/bin\/open -g/,
  "the launchd supervisor must reject reused PIDs that do not belong to Vigil and clear their stale readiness record"
);
assert.match(
  mainSource,
  /\/bin\/rm -f "\$ready"\s*if \[\[ ! -e "\$marker" \]\]; then\s*break\s*fi\s*\/usr\/bin\/open -g/,
  "the launchd supervisor must recheck its marker immediately before reopening Vigil"
);
const stopOwnedRuntimeStart = mainSource.indexOf("async function stopOwnedRuntime");
const stopOwnedRuntimeEnd = mainSource.indexOf("\n}", stopOwnedRuntimeStart);
const stopOwnedRuntimeSource = mainSource.slice(stopOwnedRuntimeStart, stopOwnedRuntimeEnd + 2);
const runtimeStopIndex = stopOwnedRuntimeSource.indexOf("await runtime.stop()");
const runtimeClearIndex = stopOwnedRuntimeSource.indexOf("ownedRuntime = null");
assert.ok(
  runtimeStopIndex >= 0
    && runtimeClearIndex > runtimeStopIndex,
  "a failed embedded-runtime stop must retain the live runtime handle"
);
const shutdownStart = serverSource.indexOf("async function performShutdown");
const shutdownEnd = serverSource.indexOf("\n}", shutdownStart);
const shutdownSource = serverSource.slice(shutdownStart, shutdownEnd + 2);
const monitorStopIndex = shutdownSource.indexOf("await activeMonitor?.stop()");
const listenerStopIndex = shutdownSource.indexOf("closeListeningServer(activeServer)");
const admissionStopIndex = shutdownSource.indexOf("mutationCoordinator?.stopAdmission()");
const coordinatorDrainIndex = shutdownSource.indexOf("mutationCoordinator?.drain()");
const requestDrainIndex = shutdownSource.indexOf("drainActiveRequests()");
const finalSnapshotIndex = shutdownSource.indexOf("await saveRuntimeSnapshot(state, usage,");
assert.ok(
  admissionStopIndex >= 0
    && requestDrainIndex > admissionStopIndex
    && monitorStopIndex > requestDrainIndex
    && coordinatorDrainIndex > monitorStopIndex
    && finalSnapshotIndex > coordinatorDrainIndex
    && listenerStopIndex > finalSnapshotIndex,
  "shutdown must drain admitted work, freeze enforcement, durably snapshot it, and only then close the listener"
);
assert.match(
  shutdownSource,
  /catch \(error\) \{\s*mutationCoordinator\?\.resumeAdmission\(\);\s*activeMonitor\?\.start\(\);\s*runtimeStopping = false;\s*throw error;/,
  "a failed frozen snapshot must reopen mutation admission and restart enforcement"
);
assert.match(
  mainSource,
  /async function ensureEmbeddedRuntimeSupervisor[\s\S]*?\["bootstrap", `gui\/\$\{retirement\.uid\}`, plistPath\][\s\S]*?waitForLaunchctlServiceRunning\(retirement\.uid, EMBEDDED_SUPERVISOR_LABEL\)/,
  "the replacement supervisor must be bootstrapped and verified running before startup continues"
);
assert.match(
  mainSource,
  /async function waitForLaunchctlServiceRunning[\s\S]*?observedPid[\s\S]*?pid !== null && pid === observedPid[\s\S]*?SUPERVISOR_POLL_INTERVAL_MS[\s\S]*?restart supervisor has a running process/,
  "startup must wait for launchd to report the same running supervisor process on consecutive polls"
);
assert.match(
  mainSource,
  /async function launchctlServiceRunningPid[\s\S]*?state = running[\s\S]*?pid = \(\[0-9\]\+\)[\s\S]*?pid > 0/,
  "a merely loaded launchd job must not count as active restart protection"
);
const supervisorInstallerStart = mainSource.indexOf("async function ensureEmbeddedRuntimeSupervisor");
const supervisorInstallerEnd = mainSource.indexOf("\nfunction embeddedRuntimeSupervisorPlist", supervisorInstallerStart);
const supervisorInstallerSource = mainSource.slice(supervisorInstallerStart, supervisorInstallerEnd);
assert.match(
  supervisorInstallerSource,
  /supervisorWasLoaded = await launchctlServiceLoaded[\s\S]*?supervisorMarkerBackup = backupEmbeddedSupervisorFile\(markerPath\)[\s\S]*?supervisorRefreshAttempted = true/,
  "refreshing the embedded supervisor must snapshot its prior marker and loaded state before changing it"
);
const supervisorPlistRewriteIndex = supervisorInstallerSource.indexOf("renameSync(temporaryPath, plistPath)");
const supervisorBootoutIndex = supervisorInstallerSource.indexOf('["bootout", `gui/${retirement.uid}/${EMBEDDED_SUPERVISOR_LABEL}`]');
const supervisorBootstrapIndex = supervisorInstallerSource.indexOf('["bootstrap", `gui/${retirement.uid}`, plistPath]');
assert.ok(
  supervisorPlistRewriteIndex >= 0
    && supervisorBootoutIndex > supervisorPlistRewriteIndex
    && supervisorBootstrapIndex > supervisorBootoutIndex,
  "an already-loaded supervisor must be booted out and bootstrapped again after its script and plist are refreshed"
);
assert.doesNotMatch(
  supervisorInstallerSource,
  /launchctlServiceLoaded[\s\S]*?\breturn;/,
  "a loaded supervisor must not keep its stale loop or launchd environment after an app update"
);
const supervisorRollbackStart = mainSource.indexOf("async function rollbackEmbeddedRuntimeSupervisor");
const supervisorRollbackEnd = mainSource.indexOf("\nasync function launchctlServiceLoaded", supervisorRollbackStart);
const supervisorRollbackSource = mainSource.slice(supervisorRollbackStart, supervisorRollbackEnd);
assert.match(
  supervisorRollbackSource,
  /supervisorRefreshAttempted[\s\S]*?rmSync\(embeddedRuntimeSupervisorMarkerPath\(\), \{ force: true \}\)[\s\S]*?\["bootout", `gui\/\$\{retirement\.uid\}\/\$\{EMBEDDED_SUPERVISOR_LABEL\}`\]/,
  "failed startup must suspend and boot out every refreshed supervisor, including one that was already loaded"
);
assert.match(
  supervisorRollbackSource,
  /restoreEmbeddedSupervisorFile\(embeddedRuntimeSupervisorScriptPath\(\), retirement\.supervisorScriptBackup\)[\s\S]*?restoreEmbeddedSupervisorFile\(embeddedRuntimeSupervisorPlistPath\(\), retirement\.supervisorPlistBackup\)/,
  "failed startup must restore supervisor files that existed before they were refreshed"
);
const supervisorMarkerRestoreIndex = supervisorRollbackSource.indexOf(
  "restoreEmbeddedSupervisorFile(embeddedRuntimeSupervisorMarkerPath(), retirement.supervisorMarkerBackup)"
);
const previousSupervisorLoadedCheckIndex = supervisorRollbackSource.indexOf("if (!retirement.supervisorWasLoaded) return");
const previousSupervisorBootstrapIndex = supervisorRollbackSource.indexOf(
  '["bootstrap", `gui/${retirement.uid}`, embeddedRuntimeSupervisorPlistPath()]'
);
const previousSupervisorVerificationIndex = supervisorRollbackSource.indexOf(
  "waitForLaunchctlServiceRunning(retirement.uid, EMBEDDED_SUPERVISOR_LABEL)",
  previousSupervisorBootstrapIndex
);
assert.ok(
  supervisorMarkerRestoreIndex >= 0
    && previousSupervisorLoadedCheckIndex > supervisorMarkerRestoreIndex
    && previousSupervisorBootstrapIndex > previousSupervisorLoadedCheckIndex
    && previousSupervisorVerificationIndex > previousSupervisorBootstrapIndex,
  "failed startup must restore the previous marker and re-bootstrap and verify a supervisor that was loaded before refresh"
);
assert.match(
  mainSource,
  /function appDataDirPreferencePath\(\): string \{\s*return join\(app\.getPath\("userData"\), "data-location\.json"\);\s*\}/,
  "the migrated data-directory pointer must live outside a custom data directory"
);
const legacyAgentRetirementStart = mainSource.indexOf("async function retireLegacyLoopbackAgent");
const legacyAgentRetirementEnd = mainSource.indexOf("\nasync function restoreLegacyLoopbackAgent", legacyAgentRetirementStart);
assert.notEqual(legacyAgentRetirementStart, -1, "the packaged app must retire the legacy loopback LaunchAgent");
assert.notEqual(legacyAgentRetirementEnd, -1, "the legacy LaunchAgent retirement function must be complete");
const legacyAgentRetirementSource = mainSource.slice(legacyAgentRetirementStart, legacyAgentRetirementEnd);
const legacyAgentVerificationIndex = legacyAgentRetirementSource.indexOf("await assertLaunchAgentStopped(uid, label)");
assert.ok(legacyAgentVerificationIndex >= 0, "retiring the legacy loopback LaunchAgent must verify it is absent");
const legacyAgentPreparationStart = mainSource.indexOf("function prepareLegacyLoopbackAgentRetirement");
const legacyAgentPreparationEnd = mainSource.indexOf("\nasync function ensureEmbeddedRuntimeSupervisor", legacyAgentPreparationStart);
const legacyAgentPreparationSource = mainSource.slice(legacyAgentPreparationStart, legacyAgentPreparationEnd);
assert.doesNotMatch(
  legacyAgentPreparationSource,
  /VIGIL_KEEP_LEGACY_SERVER[^\n]*return null/,
  "keeping the legacy plist must not leave its listener running when the embedded runtime binds the same port"
);
assert.match(
  legacyAgentRetirementSource,
  /Keep the unloaded plist at its original path[\s\S]*?older packaged copy[\s\S]*?external replacement verification fails/,
  "the replacement app must preserve rollback recovery for the older packaged launcher"
);
assert.doesNotMatch(mainSource, /rm\(retirement\.plistPath/, "app startup must not delete recovery state before its external launcher confirms success");
assert.doesNotMatch(
  legacyAgentRetirementSource,
  /\["disable",/,
  "retiring the legacy loopback LaunchAgent must not persist a disabled service that updater recovery may need to bootstrap"
);
const legacyAgentRestoreStart = mainSource.indexOf("async function restoreLegacyLoopbackAgent");
const legacyAgentRestoreEnd = mainSource.indexOf("\nasync function assertLaunchAgentStopped", legacyAgentRestoreStart);
const legacyAgentRestoreSource = mainSource.slice(legacyAgentRestoreStart, legacyAgentRestoreEnd);
assert.match(
  legacyAgentRestoreSource,
  /launchctlServiceLoaded\(retirement\.uid, retirement\.label\)[\s\S]*?\["bootstrap", `gui\/\$\{retirement\.uid\}`, retirement\.plistPath\][\s\S]*?waitForLegacyLoopbackAgentRecovery\(retirement\)/,
  "legacy recovery must verify a loaded or newly bootstrapped service before startup rollback is declared successful"
);
assert.match(
  legacyAgentRestoreSource,
  /async function waitForLegacyLoopbackAgentRecovery[\s\S]*?LEGACY_RECOVERY_TIMEOUT_MS[\s\S]*?launchctlServiceRunningPid\(retirement\.uid, retirement\.label\)[\s\S]*?pid !== null && pid === observedPid && await companionServerIsHealthy\(\)[\s\S]*?LEGACY_RECOVERY_POLL_INTERVAL_MS[\s\S]*?stable running process and a signed health response/,
  "legacy recovery must require a stable launchd process and the instance-signed health response"
);
assert.match(
  mainSource,
  /async function companionServerIsHealthy[\s\S]*?fetchVigilStateHealth[\s\S]*?expectedPort: port[\s\S]*?instanceSecret: await getInstanceSecret\(appDataDir\(\)\)/,
  "legacy recovery health checks must authenticate the restored runtime with Vigil's instance secret"
);
assert.match(
  mainSource,
  /request\.method === "POST"[\s\S]*?request\.path === "\/api\/hardening\/launch-agent\/install"[\s\S]*?request\.headers\?\.\[CONTROL_INTENT_HEADER\] === CONTROL_INTENT_VALUE[\s\S]*?await repairEmbeddedRuntimeSupervisor\(\)[\s\S]*?restartProtection: true/,
  "the in-app hardening request must run the packaged supervisor repair instead of reaching the unavailable legacy-agent installer"
);
assert.match(
  mainSource,
  /async function repairEmbeddedRuntimeSupervisor[\s\S]*?await ensureEmbeddedRuntimeSupervisor\(repair\)[\s\S]*?invalidateStateDiagnostics\(\)[\s\S]*?catch \(error\)[\s\S]*?await rollbackEmbeddedRuntimeSupervisor\(repair\)/,
  "repairing restart protection must rewrite and verify the packaged supervisor, refresh diagnostics, and restore its prior files on failure"
);
assert.match(
  mainSource,
  /async function assertLaunchAgentStopped[\s\S]*?\["print", `gui\/\$\{uid\}\/\$\{label\}`\][\s\S]*?launchctlServiceMissing\(error\)[\s\S]*?legacy Vigil LaunchAgent is still loaded/,
  "legacy-agent retirement must fail closed unless launchctl confirms that the old service is absent"
);
assert.match(
  mainSource,
  /async function ensureVigilRuntime[\s\S]*?!app\.isPackaged && await companionServerIsHealthy\(\)[\s\S]*?createLoopbackRuntimeProxy\(companionServerPort\(\)\)[\s\S]*?startVigilCompanionServer\(\{ appUpdate, port: companionServerPort\(\) \}\)[\s\S]*?EADDRINUSE[\s\S]*?companionServerIsHealthy\(\)[\s\S]*?await stopVigilServer\(\)[\s\S]*?createLoopbackRuntimeProxy\(companionServerPort\(\)\)/,
  "the app must use the migrated companion port and clean up a partial runtime before reusing a verified development server"
);
const ensureRuntimeStart = mainSource.indexOf("async function ensureVigilRuntime");
const ensureRuntimeEnd = mainSource.indexOf("\nasync function companionServerIsHealthy", ensureRuntimeStart);
assert.doesNotMatch(
  mainSource.slice(ensureRuntimeStart, ensureRuntimeEnd),
  /startVigilRuntime/,
  "reusing a development server must not create a second in-memory enforcement runtime"
);
const runtimeStartIndex = mainSource.indexOf("await ensureVigilRuntime(appUpdateController)");
const protocolInstallIndex = mainSource.indexOf("installInAppProtocol()", runtimeStartIndex);
const menuInstallIndex = mainSource.indexOf("installMenu(appUrl)", protocolInstallIndex);
const trayInstallIndex = mainSource.indexOf("installMenuBarCompanion(appUrl)", menuInstallIndex);
const windowInitializationIndex = mainSource.indexOf("showVigilWindow(appUrl)", trayInstallIndex);
const runtimeReadyIndex = mainSource.indexOf("await markRuntimeReady(appDataDir(), process.execPath)", windowInitializationIndex);
assert.ok(
  runtimeStartIndex >= 0
    && protocolInstallIndex > runtimeStartIndex
    && menuInstallIndex > protocolInstallIndex
    && trayInstallIndex > menuInstallIndex
    && windowInitializationIndex > trayInstallIndex
    && runtimeReadyIndex > windowInitializationIndex,
  "runtime readiness must follow protocol, menu, tray, and optional window initialization"
);
assert.match(
  mainSource,
  /catch \(error\) \{[\s\S]*?await clearRuntimeReady\(appDataDir\(\)\);[\s\S]*?await stopOwnedRuntime\(\);[\s\S]*?await rollbackEmbeddedRuntimeSupervisor\(legacyAgent\);[\s\S]*?await restoreLegacyLoopbackAgent\(legacyAgent\);/,
  "failed embedded startup must clear readiness, stop partial runtime state, roll back a new supervisor, and restore the legacy service"
);
assert.match(mainSource, /fullscreenable:\s*true/, "Vigil must support true native macOS fullscreen");
assert.match(mainSource, /titleBarStyle:\s*"hiddenInset"/, "Vigil must use the stable inset macOS title bar with native traffic lights");
assert.match(mainSource, /trafficLightPosition:\s*\{ x:\s*18, y:\s*19 \}/, "integrated traffic lights must retain their intended position");
assert.match(mainSource, /acceptFirstMouse:\s*true/, "the first click after Mission Control must reach Vigil's controls");
assert.match(
  mainSource,
  /function restoreNativeWindowControls\(window: BrowserWindow\): void \{[\s\S]*?window\.setWindowButtonPosition\(\{ x: 18, y: 19 \}\);[\s\S]*?window\.setWindowButtonVisibility\(true\);/,
  "showing Vigil must restore its native traffic-light controls"
);
assert.match(
  showWindowSource,
  /mainWindow\.show\(\);[\s\S]*?restoreNativeWindowControls\(mainWindow\);[\s\S]*?mainWindow\.focus\(\);/,
  "native controls must be restored after the formerly hidden window becomes visible"
);
for (const event of ["ready-to-show", "show", "enter-full-screen", "leave-full-screen"]) {
  assert.match(
    mainSource,
    new RegExp(`vigilWindow\\.on\\("${event}",[\\s\\S]*?restoreNativeWindowControls\\(vigilWindow\\)`),
    `${event} must restore Vigil's native traffic lights`
  );
}
assert.doesNotMatch(mainSource, /vigilWindow\.on\("(?:focus|maximize|unmaximize)"/, "ordinary native transitions must not rewrite the window while AppKit is animating it");
assert.doesNotMatch(mainSource, /setFullScreenable\(false\)|setFullScreen\(false\)/, "Vigil must never replace true fullscreen with macOS Zoom");
assert.doesNotMatch(mainSource, /vigil:window-action|maximizedWindowControls/, "Vigil must not imitate native window controls in web content");
assert.match(mainSource, /role:\s*"togglefullscreen"/, "the View menu must expose true native macOS fullscreen");

async function sourceRoot(): Promise<string> {
  for (const candidate of [process.cwd(), resolve(process.cwd(), "..", "..")]) {
    try {
      await access(join(candidate, "tsconfig.json"));
      return candidate;
    } catch {
      // Try the next known build layout.
    }
  }
  throw new Error("Could not locate the Vigil source root.");
}
