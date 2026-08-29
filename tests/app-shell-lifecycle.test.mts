import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = await sourceRoot();
const mainSource = await readFile(join(root, "app", "main.ts"), "utf8");
const packageSource = await readFile(join(root, "package.json"), "utf8");
const serverSource = await readFile(join(root, "src", "server.ts"), "utf8");
const beforeQuitStart = mainSource.indexOf('app.on("before-quit"');
const beforeQuitEnd = mainSource.indexOf('\n});', beforeQuitStart);
assert.notEqual(beforeQuitStart, -1, "the app must retain a before-quit cleanup hook");
assert.notEqual(beforeQuitEnd, -1, "the before-quit cleanup hook must be complete");
const beforeQuitSource = mainSource.slice(beforeQuitStart, beforeQuitEnd + 4);

assert.match(mainSource, /backgroundThrottling:\s*true/, "Electron must throttle renderer work when Vigil's window is hidden");
assert.match(mainSource, /const MENU_BAR_COMPANION_ENABLED = false;/,
  "the high-wakeup Electron tray must remain retired while Spotlight and singleton activation provide the UI entrypoint");
assert.match(mainSource, /if \(MENU_BAR_COMPANION_ENABLED\) installMenuBarCompanion\(appUrl\);/,
  "startup must not instantiate Electron's continuously repainting macOS status item");
assert.match(mainSource, /powerMonitor\.on\("resume", \(\) => reconcile\("system-resume"\)\)/,
  "waking from sleep must trigger one explicit runtime reconciliation without a permanent poll");
assert.match(mainSource, /vigil:window-activity/, "Electron must send authoritative native focus state to the renderer");
assert.match(mainSource, /vigilWindow\.on\("blur", syncRendererActivity\)/, "losing native window focus must immediately stop renderer animation work");
assert.match(mainSource, /app\.commandLine\.appendSwitch\("autoplay-policy", "no-user-gesture-required"\)/, "saved Focus Sound playback must resume after a packaged-app relaunch");

const appIdentityIndex = mainSource.indexOf('app.setName("Vigil")');
const canonicalUserDataIndex = mainSource.indexOf('app.setPath("userData", join(app.getPath("appData"), "Vigil"))');
const singleInstanceLockIndex = mainSource.indexOf("app.requestSingleInstanceLock()");
const protocolRegistrationIndex = mainSource.indexOf("protocol.registerSchemesAsPrivileged");
assert.ok(
  appIdentityIndex >= 0
    && canonicalUserDataIndex > appIdentityIndex
    && singleInstanceLockIndex > canonicalUserDataIndex
    && protocolRegistrationIndex > singleInstanceLockIndex,
  "every Vigil launcher must use one canonical profile and take the singleton lock before registering app UI infrastructure"
);
assert.match(
  mainSource,
  /if \(!app\.requestSingleInstanceLock\(\)\) app\.exit\(0\);/,
  "a rejected secondary Vigil process must exit immediately before it can appear as another Dock app"
);

assert.match(
  mainSource,
  /app\.on\("activate", \(\) => \{[\s\S]*?if \(shouldStayResident\(\) && app\.dock && !app\.dock\.isVisible\(\)\) return;\s*revealVigilWindow\(\);\s*\}\);/,
  "AppKit activation must recreate an intentionally opened Vigil window without reopening its presentation while the Dock tile is hiding"
);
assert.match(
  mainSource,
  /app\.on\("second-instance", \(_event, argv\) => \{[\s\S]*?argv\.includes\(BACKGROUND_LAUNCH_ARG\)[\s\S]*?startupComplete && !quitForUpdate && argv\.includes\(SAFETY_BOUNDARY_ARG\)[\s\S]*?requestEmbeddedSupervisorRepair\(\)[\s\S]*?return;[\s\S]*?revealVigilWindow\(\);\s*\}\);/,
  "manual singleton launches must reveal Vigil without letting supervisor retries open its window or undo update suspension"
);
assert.match(
  mainSource,
  /function requestEmbeddedSupervisorRepair[\s\S]*?supervisorRepairInFlight[\s\S]*?repairEmbeddedRuntimeSupervisor\(\)[\s\S]*?finally/,
  "an admin-protected system guardian launch must repair a missing user supervisor without revealing Vigil"
);
assert.match(
  mainSource,
  /function shouldShowWindowOnLaunch\(\): boolean \{\s*if \(process\.argv\.includes\(BACKGROUND_LAUNCH_ARG\)\) return false;\s*if \(!shouldStayResident\(\)\) return true;\s*const loginItem = app\.getLoginItemSettings\(\);\s*return !loginItem\.wasOpenedAtLogin && !loginItem\.wasOpenedAsHidden;\s*\}/,
  "manual launches must open visually while login and updater launches remain windowless"
);
assert.match(
  mainSource,
  /label: "Open Vigil",\s*click: \(\) => \{\s*showVigilWindow\(appUrl\);\s*\}/,
  "the dormant tray implementation must preserve its safe explicit reveal action if a future Electron release fixes the wakeup regression"
);
assert.match(
  mainSource,
  /function showVigilWindow\(appUrl: string\): void \{\s*const dockReady = showVigilDock\(\);\s*if \(!mainWindow\) createWindow\(appUrl\);[\s\S]*?const reveal = \(\): void => \{[\s\S]*?if \(mainWindow !== window \|\| window\.isDestroyed\(\)\) return;[\s\S]*?window\.show\(\);[\s\S]*?window\.focus\(\);[\s\S]*?dockReady\.then\(reveal\)/,
  "opening a resident window must present it again after asynchronous Dock restoration without reviving a window hidden during that wait"
);
assert.match(
  mainSource,
  /app\.on\("window-all-closed", \(\) => \{\s*if \(!shouldStayResident\(\)\) app\.quit\(\);/,
  "closing the last window must leave packaged background enforcement running"
);
assert.match(
  beforeQuitSource,
  /shouldStayResident\(\)[\s\S]*?!quitForUpdate[\s\S]*?event\.preventDefault\(\)[\s\S]*?hideVigilWindow\(\)/,
  "normal quit attempts must hide the window and leave packaged background enforcement running"
);
assert.match(
  mainSource,
  /function hideVigilWindow\(\): void \{[\s\S]*?if \(window && !window\.isDestroyed\(\)\) window\.destroy\(\);\s*hideVigilDock\(\);\s*\}/,
  "hiding Vigil must release its Chromium window and remove its Dock tile while enforcement remains resident"
);
assert.match(
  mainSource,
  /function showVigilDock\(\): Promise<void> \| null \{\s*if \(!shouldStayResident\(\) \|\| !app\.dock \|\| app\.dock\.isVisible\(\)\) return null;\s*return app\.dock\.show\(\);\s*\}/,
  "revealing packaged Vigil must expose asynchronous Dock restoration to the window presentation lifecycle"
);
assert.match(
  mainSource,
  /function hideVigilDock\(\): void \{\s*if \(!shouldStayResident\(\)\) return;\s*app\.dock\?\.hide\(\);\s*\}/,
  "hidden packaged Vigil must remove its Dock tile without changing its resident lifecycle"
);
assert.match(
  mainSource,
  /function configureMenuBarResidency\(\): void \{\s*if \(!shouldStayResident\(\)\) return;[\s\S]*?hideVigilDock\(\);[\s\S]*?app\.setLoginItemSettings/,
  "background Vigil launches must start without a Dock tile"
);
assert.match(
  mainSource,
  /vigilWindow\.on\("closed", \(\) => \{[\s\S]*?mainWindow = null;\s*hideVigilDock\(\);/,
  "closing Vigil's last native window must remove its Dock tile"
);
assert.doesNotMatch(
  packageSource,
  /"LSUIElement"\s*:\s*true/,
  "Vigil must retain a normal application identity so opening its window can restore the Dock tile"
);
assert.match(
  mainSource,
  /label: "Hide Vigil Window",\s*accelerator: "CommandOrControl\+Q"/,
  "Command-Q must hide the Vigil window without terminating its background companion"
);
assert.doesNotMatch(mainSource, /label: "Quit Vigil"/, "the menu-bar menu must not offer a misleading true-quit action");
assert.match(
  mainSource,
  /quitForUpdate: async \(\) => \{\s*try \{\s*await assertEmbeddedRuntimeSupervisorArmedForUpdate\(\);\s*\} catch \(error\) \{[\s\S]*?throw error;\s*\}\s*quitForUpdate = true;\s*app\.quit\(\);\s*\}/,
  "an app update must stay running and reject quit authorization unless its maintenance-aware recovery supervisor is armed"
);
assert.match(
  mainSource,
  /relaunchApp: async \(\) => \{\s*await scheduleProtectedAppRelaunch\(\);\s*\}/,
  "the update controller must expose the supervisor-verified relaunch capability to trusted UI and agent surfaces"
);
assert.match(
  mainSource,
  /async function scheduleProtectedAppRelaunch\(\): Promise<void> \{[\s\S]*?await assertEmbeddedRuntimeSupervisorArmedForUpdate\(\);[\s\S]*?if \(!app\.isPackaged\) app\.relaunch\(\);[\s\S]*?quitForUpdate = true;[\s\S]*?app\.quit\(\);/,
  "an installed-app relaunch must rely on the armed supervisor while development relaunch remains explicitly Electron-managed"
);
assert.match(
  mainSource,
  /async function assertEmbeddedRuntimeSupervisorArmedForUpdate\(\): Promise<void> \{[\s\S]*?lstatSync\(markerPath\)[\s\S]*?marker\.isSymbolicLink\(\)[\s\S]*?readFileSync\(markerPath, "utf8"\) !== "enabled\\n"[\s\S]*?waitForLaunchctlServiceRunning\(uid, EMBEDDED_SUPERVISOR_LABEL\)/,
  "the update quit path must verify the private recovery marker and a stably running supervisor"
);
assert.match(
  beforeQuitSource,
  /if \(!ownedRuntime\) return;\s*event\.preventDefault\(\);\s*let runtimeStopped = false;\s*try \{\s*await stopOwnedRuntime\(\);\s*runtimeStopped = true;\s*await clearRuntimeReady\(appDataDir\(\)\);\s*app\.quit\(\);/,
  "the quit lifecycle must wait for the embedded runtime and readiness marker to flush before exiting"
);
assert.match(
  beforeQuitSource,
  /catch \(error\) \{\s*if \(quitForUpdate\) \{\s*resumeEmbeddedRuntimeSupervisor\(\);\s*if \(runtimeStopped\) \{[\s\S]*?app\.exit\(1\);\s*return;\s*\}\s*quitForUpdate = false;\s*appRelaunchScheduled = false;\s*\}/,
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
  /const temporaryPath = `\$\{path\}\.\$\{process\.pid\}\.tmp`;[\s\S]*?writeFileSync\(temporaryPath[\s\S]*?renameSync\(temporaryPath, path\);[\s\S]*?rmSync\(temporaryPath, \{ force: true \}\);/,
  "concurrent supervised launches must use process-private data-location temporary files and clean failed writes"
);
assert.match(
  mainSource,
  /function embeddedRuntimeSupervisorPlist[\s\S]*?<key>KeepAlive<\/key>[\s\S]*?<key>PathState<\/key>[\s\S]*?<true\/>/,
  "the embedded app supervisor must ask launchd to restart Vigil while its supervision marker exists"
);
assert.match(
  mainSource,
  /AGENT-NOTICE-DO-NOT-TERMINATE\.md[\s\S]*?mode: 0o644/,
  "the agent warning must remain owner-writable so Vigil can refresh it on every supervised startup"
);
assert.match(
  mainSource,
  /import \{[^}]*buildRuntimeSupervisorScript[^}]*\} from "\.\.\/src\/runtimeReady\.js";/,
  "the packaged app must use the shared, validated runtime-supervisor protocol"
);
assert.match(
  mainSource,
  /function embeddedRuntimeSupervisorScript\(markerPath: string\): string \{[\s\S]*?return buildRuntimeSupervisorScript\(\{[\s\S]*?markerPath,[\s\S]*?dataDir: appDataDir\(\),[\s\S]*?executablePath: process\.execPath,[\s\S]*?backgroundLaunchArg: BACKGROUND_LAUNCH_ARG,[\s\S]*?safetyBoundaryArg: SAFETY_BOUNDARY_ARG[\s\S]*?\}\);/,
  "the installed and integrity-expected supervisors must be generated from identical inputs"
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
const admissionStopIndex = shutdownSource.indexOf("activeMutationCoordinator?.stopAdmission()");
const coordinatorDrainIndex = shutdownSource.indexOf("activeMutationCoordinator?.drain()");
const requestDrainIndex = shutdownSource.indexOf("drainActiveRequests(");
const requestAdmissionStopIndex = shutdownSource.indexOf("activeRequestAdmission.accepting = false");
const finalSnapshotIndex = shutdownSource.indexOf("await saveRuntimeSnapshot(state, usage,");
assert.ok(
  requestDrainIndex >= 0
    && requestAdmissionStopIndex > requestDrainIndex
    && monitorStopIndex > requestDrainIndex
    && monitorStopIndex > requestAdmissionStopIndex
    && admissionStopIndex > monitorStopIndex
    && coordinatorDrainIndex > monitorStopIndex
    && coordinatorDrainIndex > admissionStopIndex
    && finalSnapshotIndex > coordinatorDrainIndex
    && listenerStopIndex > finalSnapshotIndex,
  "shutdown must drain admitted work, freeze enforcement, durably snapshot it, and only then close the listener"
);
assert.match(
  serverSource,
  /function recordIosMdmPolicyQueue[\s\S]*?ensureIosRemovalPassword\(requestState\);[\s\S]*?afterCommit\(/,
  "a policy export must reserve its removal password in the originating transaction"
);
assert.match(
  serverSource,
  /effect\.removalPassword && committedPassword && committedPassword !== effect\.removalPassword[\s\S]*?throw new Error/,
  "a stale export completion must not overwrite a newer removal password"
);
assert.match(
  shutdownSource,
  /catch \(error\) \{\s*await resumeListeningServer\(activeServer\);\s*activeMutationCoordinator\?\.resumeAdmission\(\);[\s\S]*?requestMutationAdmission = \{ accepting: true \};\s*activeMonitor\?\.start\(\);\s*runtimeStopping = false;\s*throw error;/,
  "a failed frozen snapshot must restore the listener before reopening mutation admission and restarting enforcement"
);
assert.match(
  serverSource,
  /function drainActiveRequests[\s\S]*?setTimeout\(\(\) => \{[\s\S]*?activeRequestAdmission\.accepting = false;[\s\S]*?forcedClose = closeListeningServer\(activeServer, \{ force: true \}\);[\s\S]*?Promise\.race[\s\S]*?await forcedClose/,
  "the request drain deadline must freeze request-scoped mutation admission and close the listener before proceeding"
);
const requestDrainStart = serverSource.indexOf("async function drainActiveRequests");
const requestDrainEnd = serverSource.indexOf("\n}", requestDrainStart);
const requestDrainSource = serverSource.slice(requestDrainStart, requestDrainEnd + 2);
assert.doesNotMatch(requestDrainSource, /stopAdmission\(\)/,
  "request grace expiry must not close global admission before browser enforcement drains");
assert.match(
  serverSource,
  /const requestAdmission = requestMutationAdmission;[\s\S]*?requestMutationCoordinator\.run\([\s\S]*?admission: requestAdmission,[\s\S]*?requestDefersRoutinePersistence\(method, path\)[\s\S]*?persist: false/,
  "each request mutation must retain its admission generation while routine extension telemetry may explicitly defer persistence"
);
assert.match(
  serverSource,
  /recordExternalResult: \(type, detail\) => recordExternalHardeningResult\([\s\S]*?requestMutationCoordinator,[\s\S]*?requestAdmission[\s\S]*?async function recordExternalHardeningResult[\s\S]*?requestMutationCoordinator\.run\([\s\S]*?\}, \{ admission: requestAdmission \}\);/,
  "request-triggered hardening result mutations must retain the request admission generation"
);
assert.equal(
  serverSource.match(/requestMutationCoordinator\.run\(/gu)?.length || 0,
  serverSource.match(/\badmission:\s*requestAdmission\b/gu)?.length || 0,
  "every request-originated coordinator mutation must use the captured request admission scope"
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
  /supervisorWasLoaded\s*\)\s*\{\s*return;/,
  "a merely loaded supervisor must not bypass integrity, runtime, and configuration checks"
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
const embeddedSupervisorEnsureStart = mainSource.indexOf("async function ensureEmbeddedRuntimeSupervisor");
const embeddedSupervisorEnsureEnd = mainSource.indexOf("\nfunction embeddedSupervisorFileMatches", embeddedSupervisorEnsureStart);
const embeddedSupervisorEnsureSource = mainSource.slice(embeddedSupervisorEnsureStart, embeddedSupervisorEnsureEnd);
const supervisorCurrentCheckIndex = embeddedSupervisorEnsureSource.indexOf("embeddedSupervisorFileMatches(plistPath, expectedPlist, 0o644, retirement.uid)");
const supervisorNoOpReturnIndex = embeddedSupervisorEnsureSource.indexOf("return;", supervisorCurrentCheckIndex);
const supervisorPlistWriteIndex = embeddedSupervisorEnsureSource.indexOf("writeFileSync(temporaryPath, expectedPlist", supervisorNoOpReturnIndex);
const currentSupervisorBootoutIndex = embeddedSupervisorEnsureSource.indexOf('["bootout", `gui/${retirement.uid}/${EMBEDDED_SUPERVISOR_LABEL}`]', supervisorPlistWriteIndex);
assert.ok(
  supervisorCurrentCheckIndex >= 0
    && supervisorNoOpReturnIndex > supervisorCurrentCheckIndex
    && supervisorPlistWriteIndex > supervisorNoOpReturnIndex
    && currentSupervisorBootoutIndex > supervisorPlistWriteIndex,
  "an exact running supervisor must remain untouched instead of being rewritten and re-registered on every app launch"
);
assert.match(
  embeddedSupervisorEnsureSource,
  /launchctlServiceRunningPid\(retirement\.uid, EMBEDDED_SUPERVISOR_LABEL\) !== null[\s\S]*?embeddedSupervisorFileMatches\(markerPath, "enabled\\n", 0o600, retirement\.uid\)[\s\S]*?embeddedSupervisorFileMatches\(scriptPath, expectedScript, 0o700, retirement\.uid\)[\s\S]*?embeddedSupervisorFileMatches\(plistPath, expectedPlist, 0o644, retirement\.uid\)/,
  "the startup no-op must require a running service and exact owned supervisor files with hardened permissions"
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
  /function embeddedRuntimeSupervisorScriptPath\(\): string \{\s*return join\(app\.getPath\("userData"\), "supervisor", "vigil"\);\s*\}/,
  "the background-item executable must have the concise user-facing name vigil"
);
const startupCompleteAssignmentIndex = mainSource.indexOf("startupComplete = true");
const retiredSupervisorCleanupIndex = mainSource.indexOf("cleanupRetiredEmbeddedSupervisorScripts()", startupCompleteAssignmentIndex);
assert.ok(
  startupCompleteAssignmentIndex >= 0 && retiredSupervisorCleanupIndex > startupCompleteAssignmentIndex,
  "the retired long-named supervisor must only be removed after the replacement app completes startup"
);
assert.match(
  mainSource,
  /function cleanupRetiredEmbeddedSupervisorScripts[\s\S]*?vigil-supervisor-DO-NOT-TERMINATE-OR-BOOTOUT\.zsh[\s\S]*?retiredPath === currentPath[\s\S]*?rmSync\(retiredPath, \{ force: true \}\)/,
  "supervisor cleanup must target only the known retired executable and preserve the current executable"
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
const interruptionReadIndex = mainSource.indexOf("await readRuntimeInterruption(appDataDir())", runtimeStartIndex);
const invalidInterruptionPreservationIndex = mainSource.indexOf('runtimeInterruption.status === "invalid"', interruptionReadIndex);
const interruptionAcknowledgementIndex = mainSource.indexOf('runtimeInterruption.status === "valid"', invalidInterruptionPreservationIndex);
const protocolInstallIndex = mainSource.indexOf("installInAppProtocol()", interruptionAcknowledgementIndex);
const menuInstallIndex = mainSource.indexOf("installMenu(appUrl)", protocolInstallIndex);
const trayInstallIndex = mainSource.indexOf("installMenuBarCompanion(appUrl)", menuInstallIndex);
const windowInitializationIndex = mainSource.indexOf("showVigilWindow(appUrl)", trayInstallIndex);
const runtimeReadyIndex = mainSource.indexOf("await markRuntimeReady(appDataDir(), process.execPath)", windowInitializationIndex);
const candidateAttestationIndex = mainSource.indexOf("await attestUpdateCandidateAfterSustainedHealth(runtimeReady)", runtimeReadyIndex);
const startupCompleteIndex = mainSource.indexOf("startupComplete = true", candidateAttestationIndex);
const interruptionClearIndex = mainSource.indexOf("await clearRuntimeInterruption(appDataDir(), acknowledgedRuntimeInterruption.id)", startupCompleteIndex);
assert.ok(
  runtimeStartIndex >= 0
    && interruptionReadIndex > runtimeStartIndex
    && invalidInterruptionPreservationIndex > interruptionReadIndex
    && interruptionAcknowledgementIndex > invalidInterruptionPreservationIndex
    && protocolInstallIndex > interruptionAcknowledgementIndex
    && menuInstallIndex > protocolInstallIndex
    && trayInstallIndex > menuInstallIndex
    && windowInitializationIndex > trayInstallIndex
    && runtimeReadyIndex > windowInitializationIndex
    && candidateAttestationIndex > runtimeReadyIndex
    && startupCompleteIndex > candidateAttestationIndex
    && interruptionClearIndex > startupCompleteIndex,
  "runtime readiness and sustained candidate attestation must follow initialization before startup clears acknowledged interruption evidence"
);
const candidateAttestationStart = mainSource.indexOf("async function attestUpdateCandidateAfterSustainedHealth");
const candidateAttestationEnd = mainSource.indexOf("\nasync function companionServerIsHealthy", candidateAttestationStart);
assert.ok(candidateAttestationStart >= 0 && candidateAttestationEnd > candidateAttestationStart, "candidate attestation must be implemented as a bounded startup step");
const candidateAttestationSource = mainSource.slice(candidateAttestationStart, candidateAttestationEnd);
assert.match(
  mainSource,
  /const UPDATE_CANDIDATE_SUSTAINED_HEALTH_MS = 1_500;/u,
  "candidate self-attestation must retain a meaningful 1.5-second sustained-health window"
);
assert.match(
  candidateAttestationSource,
  /setTimeout\(resolve, UPDATE_CANDIDATE_SUSTAINED_HEALTH_MS\)[\s\S]*?attestUpdateCandidateOnce\(expected, null\)[\s\S]*?liveRuntimeReady\(appDataDir\(\), Date\.parse\(expected\.startedAt\)\)[\s\S]*?companionServerIsHealthy\(\)/u,
  "candidate attestation must retain the sustained-health window before rechecking exact live readiness and signed companion health"
);
for (const exactField of ["pid", "appPath", "startedAt"]) {
  assert.match(
    candidateAttestationSource,
    new RegExp(`liveReady\\.${exactField} !== expected\\.${exactField}`, "u"),
    `candidate attestation must bind the live readiness ${exactField} to the marker this process wrote`
  );
}
assert.match(
  candidateAttestationSource,
  /updateRecoveryPaths\(join\(app\.getPath\("userData"\), "updater"\)\)[\s\S]*?recoveryManifestEntryExists\(recoveryPaths\.manifestPath\)[\s\S]*?readUpdateRecoveryPolicyFile\(recoveryPaths\.policyPath\)[\s\S]*?readUpdateRecoveryManifest\(loadedPolicy\.policy\)[\s\S]*?if \(!manifest\) return;[\s\S]*?observedAttemptId \|\|= manifest\.attemptId[\s\S]*?manifest\.attemptId !== observedAttemptId[\s\S]*?recoveryDependenciesForStableHelper\(loadedPolicy\.policy, manifest\)[\s\S]*?markUpdateRecoveryCommitIntent\(loadedPolicy\.policy, observedAttemptId, recoveryDependencies\)/u,
  "a live candidate must load the private recovery policy, bind lock release to its stable helper, and attest only the exact manifest attempt"
);
assert.match(
  candidateAttestationSource,
  /catch \(error\) \{[\s\S]*?console\.error\("Vigil could not attest the sustained health of its update candidate; it will retry\."[\s\S]*?scheduleUpdateCandidateAttestationRetry\(expected, observedAttemptId\)/u,
  "candidate attestation failure must be logged without discarding recovery evidence or taking down the healthy runtime"
);
assert.match(
  mainSource,
  /const UPDATE_CANDIDATE_ATTESTATION_RETRY_MS = 2_000;[\s\S]*?if \(quitForUpdate \|\| updateCandidateAttestationRetryTimer\) return;[\s\S]*?attestUpdateCandidateOnce\(expected, pinnedAttemptId\)/u,
  "a transient candidate-attestation failure must retry the pinned attempt instead of wedging a healthy pending replacement"
);
assert.match(
  mainSource,
  /catch \(error\) \{[\s\S]*?await clearRuntimeReady\(appDataDir\(\)\);[\s\S]*?await stopOwnedRuntime\(\);[\s\S]*?await rollbackEmbeddedRuntimeSupervisor\(legacyAgent\);[\s\S]*?await restoreLegacyLoopbackAgent\(legacyAgent\);/,
  "failed embedded startup must clear readiness, stop partial runtime state, roll back a new supervisor, and restore the legacy service"
);
assert.match(
  mainSource,
  /titleBarStyle:\s*"hiddenInset"/,
  "Vigil must integrate native window controls without a separate gray title bar"
);
assert.match(
  mainSource,
  /trafficLightPosition:\s*\{\s*x:\s*18,\s*y:\s*19\s*\}/,
  "Vigil's integrated traffic lights must retain their intended position"
);
assert.doesNotMatch(
  mainSource,
  /setWindowButtonPosition|setWindowButtonVisibility/,
  "Vigil must not rewrite native controls while AppKit is transitioning the window"
);
assert.doesNotMatch(
  mainSource,
  /acceptFirstMouse|fullscreenable|alwaysOnTop|setAlwaysOnTop|setVisibleOnAllWorkspaces/,
  "Vigil must leave ordinary window, fullscreen, focus, and workspace behavior at Electron defaults"
);
assert.doesNotMatch(
  mainSource,
  /vigilWindow\.on\("(?:enter|leave)-full-screen"/,
  "Vigil must not rewrite its window while AppKit is transitioning native fullscreen"
);
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
