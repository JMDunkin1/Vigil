import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";
import { createAppUpdatePanel } from "../public/app-update.js";
import type { ControlElement, UnknownRecord } from "../public/app-model.js";
import { atomicInstallBuiltApp } from "../scripts/update-packaged-app.mjs";

interface Bridge {
  status(options?: { checkRemote?: boolean; instanceSecret?: string }): Promise<unknown>;
  start(): Promise<unknown>;
  relaunch(): Promise<unknown>;
  subscribe?(listener: (status: unknown) => void): () => void;
  subscribeDetails?(listener: () => void): () => void;
}

interface Invocation {
  channel: string;
  args: unknown[];
}

interface AppearanceBridge {
  getIconTheme(): Promise<unknown>;
  setIconTheme(theme: string): Promise<unknown>;
}

interface ApiBridge {
  request(path: string, options?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<unknown>;
}

interface SetupBridge {
  open(destination: string): Promise<unknown>;
}

const sourceRoot = existsSync(join(process.cwd(), "app", "main.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const preloadSource = await readFile(join(sourceRoot, "app", "preload.cjs"), "utf8");
const mainSource = await readFile(join(sourceRoot, "app", "main.ts"), "utf8");
const updaterSource = await readFile(join(sourceRoot, "app", "updater.ts"), "utf8");
const updateScriptSource = await readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8");
const exposed = new Map<string, unknown>();
const invocations: Invocation[] = [];
type IpcListener = (...args: unknown[]) => void;
const ipcListeners = new Map<string, Set<IpcListener>>();

vm.runInNewContext(preloadSource, {
  require(specifier: string) {
    assert.equal(specifier, "electron");
    return {
      contextBridge: {
        exposeInMainWorld(name: string, value: unknown) {
          exposed.set(name, value);
        }
      },
      ipcRenderer: {
        send() {},
        on(channel: string, listener: IpcListener) {
          const listeners = ipcListeners.get(channel) || new Set<IpcListener>();
          listeners.add(listener);
          ipcListeners.set(channel, listeners);
        },
        removeListener(channel: string, listener: IpcListener) {
          ipcListeners.get(channel)?.delete(listener);
        },
        async invoke(channel: string, ...args: unknown[]) {
          invocations.push({ channel, args });
          return { ok: true };
        }
      }
    };
  },
  window: {
    addEventListener(_name: string, listener: () => void) {
      listener();
    }
  },
  document: {
    documentElement: {
      classList: { add() {} }
    }
  }
});

const preloadBridge = exposed.get("vigilAppUpdate") as Bridge | undefined;
assert.ok(preloadBridge, "preload should expose the app update bridge");
await preloadBridge.status({ checkRemote: true, instanceSecret: "must-not-cross-the-bridge" });
await preloadBridge.start();
await preloadBridge.relaunch();
assert.equal(invocations[0]?.channel, "vigil:app-update-status");
assert.deepEqual(Object.keys(invocations[0]?.args[0] as object), ["checkRemote"]);
assert.equal((invocations[0]?.args[0] as { checkRemote?: unknown }).checkRemote, true);
assert.equal(invocations[1]?.channel, "vigil:app-update-start");
assert.equal(invocations[1]?.args.length, 0);
assert.equal(invocations[2]?.channel, "vigil:app-relaunch");
assert.equal(invocations[2]?.args.length, 0);
let publishedBridgeStatus: unknown = null;
const unsubscribeFromUpdateState = preloadBridge.subscribe?.((status) => {
  publishedBridgeStatus = status;
});
assert.ok(unsubscribeFromUpdateState, "the update bridge should expose a removable state subscription");
const publishedStatus = { running: true, operation: "starting", updateStateRevision: 4 };
for (const listener of ipcListeners.get("vigil:app-update-state") || []) listener({}, publishedStatus);
assert.equal(publishedBridgeStatus, publishedStatus);
unsubscribeFromUpdateState();
assert.equal(ipcListeners.get("vigil:app-update-state")?.size, 0, "unsubscribing must remove the exact IPC listener");
let updateDetailsRequested = false;
const unsubscribeFromUpdateDetails = preloadBridge.subscribeDetails?.(() => {
  updateDetailsRequested = true;
});
assert.ok(unsubscribeFromUpdateDetails, "the update bridge should expose navigation for native update details");
for (const listener of ipcListeners.get("vigil:show-app-update-details") || []) listener({});
assert.equal(updateDetailsRequested, true);
unsubscribeFromUpdateDetails();
assert.equal(ipcListeners.get("vigil:show-app-update-details")?.size, 0, "unsubscribing must remove the exact details listener");
const appearanceBridge = exposed.get("vigilAppearance") as AppearanceBridge | undefined;
assert.ok(appearanceBridge, "preload should expose the icon appearance bridge");
await appearanceBridge.getIconTheme();
await appearanceBridge.setIconTheme("sacred-heart");
assert.equal(invocations[3]?.channel, "vigil:icon-theme-get");
assert.equal(invocations[4]?.channel, "vigil:icon-theme-set");
assert.deepEqual(invocations[4]?.args, ["sacred-heart"]);
const apiBridge = exposed.get("vigilApi") as ApiBridge | undefined;
assert.ok(apiBridge, "preload should expose the private API bridge");
await apiBridge.request("/api/state", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
assert.equal(invocations[5]?.channel, "vigil:api-request");
assert.equal(JSON.stringify(invocations[5]?.args), JSON.stringify([{
  path: "/api/state",
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
}]));
const setupBridge = exposed.get("vigilSetup") as SetupBridge | undefined;
assert.ok(setupBridge, "preload should expose the restricted setup bridge");
await setupBridge.open("accessibility");
assert.equal(invocations[6]?.channel, "vigil:setup-open");
assert.deepEqual(invocations[6]?.args, ["accessibility"]);
assert.match(mainSource, /ipcMain\.handle\("vigil:api-request", handlePrivateApiRequest\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:setup-open", handleSetupOpen\)/u);
assert.match(mainSource, /destination === "accessibility"[\s\S]*?isTrustedAccessibilityClient\(true\)[\s\S]*?Privacy_Accessibility/u);
assert.match(mainSource, /destination === "extension"[\s\S]*?chromewebstore\.google\.com\/detail\/[\s\S]*?join\(RUNTIME_ROOT, "extension", "manifest\.json"\)[\s\S]*?showItemInFolder/u);
assert.match(mainSource, /value\.extensionId !== BUILT_IN_CHROME_EXTENSION_ID/u, "a packaged store shortcut must use only Vigil's trusted extension ID");
assert.doesNotMatch(mainSource, /handleSetupOpen[\s\S]*?shell\.openExternal\(String\(value/u, "renderer input must never become an arbitrary external URL");
assert.match(mainSource, /APP_URL = `\$\{APP_SCHEME\}:\/\/\$\{APP_HOST\}\//u);
assert.match(
  mainSource,
  /startVigilCompanionServer\(\{ appUpdate, port: companionServerPort\(\) \}\)/u,
  "the packaged app must preserve the restricted companion and MDM listener on the migrated port"
);
assert.doesNotMatch(mainSource, /startVigilServer\(/u, "the packaged app must not expose the full app server");
assert.match(mainSource, /!app\.isPackaged && await companionServerIsHealthy\(\)/u, "development may reuse only a verified existing companion listener");
assert.match(mainSource, /maxAgeSeconds <= 0 \? 1 : Math\.floor\(Date\.now\(\) \/ 1000\) \+ maxAgeSeconds/u, "positive Max-Age cookies must survive an app restart");
assert.match(
  mainSource,
  /Object\.entries\(response\.headers\)\.filter\(\(\[name\]\) => name\.toLowerCase\(\) !== "set-cookie"\)/u,
  "the private API bridge must not expose session cookies to the renderer"
);
assert.match(mainSource, /ipcMain\.handle\("vigil:app-update-status", handleAppUpdateStatus\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:app-update-start", handleAppUpdateStart\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:app-relaunch", handleAppRelaunch\)/u);
assert.match(
  mainSource,
  /async function scheduleProtectedAppRelaunch[\s\S]*?assertEmbeddedRuntimeSupervisorArmedForUpdate\(\)[\s\S]*?quitForUpdate = true;[\s\S]*?app\.quit\(\)/u,
  "manual relaunch must use the same verified restart-supervision boundary as an app update"
);
assert.match(mainSource, /handleAppUpdateStart[\s\S]*?return await startAppUpdate\(appUrl\)/u, "renderer starts must use the native app-wide coordinator");
assert.match(mainSource, /handleAppUpdateStatus[\s\S]*?checkAppUpdate\(appUrl\)[\s\S]*?refreshRunningAppUpdate\(appUrl\)/u, "renderer status reads must use the native app-wide coordinator");
assert.match(
  mainSource,
  /async function startAppUpdate[\s\S]*?responseBase = result \|\| \{\};\s*applyAppUpdateStatus\(responseBase\)/u,
  "a raced start rejection must preserve authoritative recovery and maintenance fields from the updater"
);
assert.doesNotMatch(
  mainSource,
  /result\?\.ok !== true && result\?\.running !== true[\s\S]*?throw new Error/u,
  "the coordinator must not flatten a structured updater rejection into a generic failure"
);
assert.match(mainSource, /webContents\.send\(APP_UPDATE_STATE_CHANNEL, status\)/u, "coordinator state changes must be broadcast to Settings");
assert.match(mainSource, /label: "App Update Details…"[\s\S]*?showAppUpdateDetails\(appUrl\)/u, "a blocked tray update action must open its explanation in Vigil");
assert.match(mainSource, /webContents\.send\(APP_UPDATE_DETAILS_CHANNEL\)/u, "the native details action must route the open app to update settings");
assert.doesNotMatch(mainSource, /function appUpdateActionDetail/u, "the tray must not render verbose updater diagnostics as native menu rows");
assert.match(mainSource, /label: shortTrayDetail\(status\.label\)[\s\S]*?label: shortTrayDetail\(status\.detail\)/u, "dynamic status rows must stay compact enough for macOS to anchor the menu to its icon");
assert.match(mainSource, /function shortTrayDetail[\s\S]*?value\.length <= 42/u, "tray diagnostics must have a bounded native-menu width");
assert.match(mainSource, /recoveryPending: appUpdateActionState\.recoveryPending/u, "the coordinator must broadcast pending recovery state");
assert.match(mainSource, /recoveryBlocked: appUpdateActionState\.recoveryBlocked/u, "the coordinator must broadcast blocked recovery state");
assert.match(mainSource, /!appUpdateActionState\.running && !appUpdateActionState\.recoveryPending/u, "pending recovery must keep the coordinator polling");
assert.match(
  mainSource,
  /preserveRemoteCheckFailure = appUpdateActionState\.checked[\s\S]*?!appUpdateActionState\.recoveryPending[\s\S]*?!appUpdateActionState\.recoveryBlocked[\s\S]*?status\?\.recoveryPending !== true[\s\S]*?status\?\.recoveryBlocked !== true/u,
  "a completed recovery must clear the old failure instead of leaving every standard update action disabled"
);
assert.match(mainSource, /ipcMain\.handle\("vigil:icon-theme-get", handleIconThemeGet\)/u);
assert.match(mainSource, /ipcMain\.handle\("vigil:icon-theme-set", handleIconThemeSet\)/u);
assert.doesNotMatch(mainSource, /cursorAuraWindow|CURSOR_AURA_MARGIN|vigil:cursor-aura-update/u, "the cursor glow must not create an oversized native window around Vigil");
assert.equal(exposed.has("vigilCursorAura"), false, "the preload must not expose a bridge for a removed native aura window");
assert.match(mainSource, /ICON_THEMES = \["jerusalem-cross", "sacred-heart", "saint-michael"\]/u);
assert.match(mainSource, /!event\.senderFrame \|\| !isTrustedAppUrl\(event\.senderFrame\.url\)/u);
assert.doesNotMatch(mainSource, /\/api\/app-update\/(?:status|start)/u);
assert.match(updaterSource, /launchAgentRepoRoot\(app\)/u);
assert.match(updateScriptSource, /-c\.directories\.output=dist\/update-mac\.noindex/u);
assert.doesNotMatch(updateScriptSource, /"build:mac"/u);

const installRoot = await mkdtemp(join(tmpdir(), "vigil-app-update-install-"));
try {
  const stageRoot = join(installRoot, "dist", "update-mac.noindex");
  const builtApp = join(stageRoot, "mac-arm64", "Vigil.app");
  const installedApp = join(installRoot, "dist", "mac.noindex", "mac-arm64", "Vigil.app");
  await mkdir(builtApp, { recursive: true });
  await mkdir(installedApp, { recursive: true });
  await writeFile(join(builtApp, "version.txt"), "new");
  await writeFile(join(installedApp, "version.txt"), "old");

  const rolledBack = await atomicInstallBuiltApp(builtApp, installedApp, stageRoot);
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "new");
  assert.equal(await readFile(join(`${installedApp}.vigil-previous`, "version.txt"), "utf8"), "old");
  await rolledBack.rollback();
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "old");
  assert.equal(existsSync(stageRoot), false);

  await mkdir(builtApp, { recursive: true });
  await writeFile(join(builtApp, "version.txt"), "newer");
  const finalized = await atomicInstallBuiltApp(builtApp, installedApp, stageRoot);
  await finalized.markVerified();
  await finalized.finalize();
  assert.equal(await readFile(join(installedApp, "version.txt"), "utf8"), "newer");
  assert.equal(existsSync(`${installedApp}.vigil-previous`), false);
  assert.equal(existsSync(stageRoot), false);
} finally {
  await rm(installRoot, { recursive: true, force: true });
}

const originalWindow = globalThis.window;
const controls = new Map<string, ControlElement>();
let buttonClick: (() => void) | null = null;
let relaunchButtonClick: (() => void) | null = null;
let getCalls = 0;
let postCalls = 0;
let statusCalls = 0;
let startCalls = 0;
let relaunchCalls = 0;
const updateToasts: string[] = [];
let checkedRemote: boolean | undefined;
let nextRendererStatus: Promise<UnknownRecord> | null = null;
let nextRendererStartResult: Promise<UnknownRecord> | null = null;
let nextRendererRelaunchResult: Promise<UnknownRecord> | null = null;
let rendererStateListener: ((status: unknown) => void) | null = null;
let rendererStatus: UnknownRecord = {
  ok: true,
  supported: true,
  updateAvailable: true,
  appBundleOutdated: true,
  dirty: false,
  behind: 0,
  message: "Installed app is behind this checkout"
};
let rendererStartResult: UnknownRecord = {
  ok: true,
  supported: true,
  phase: "starting",
  message: "Vigil will reopen"
};
const rendererBridge = {
  async status(options: { checkRemote?: boolean } = {}) {
    statusCalls += 1;
    checkedRemote = options.checkRemote;
    if (nextRendererStatus) {
      const result = nextRendererStatus;
      nextRendererStatus = null;
      return await result;
    }
    return rendererStatus;
  },
  async start() {
    startCalls += 1;
    if (nextRendererStartResult) {
      const result = nextRendererStartResult;
      nextRendererStartResult = null;
      return await result;
    }
    return rendererStartResult;
  },
  async relaunch() {
    relaunchCalls += 1;
    if (nextRendererRelaunchResult) {
      const result = nextRendererRelaunchResult;
      nextRendererRelaunchResult = null;
      return await result;
    }
    return { ok: true, relaunching: true, message: "Vigil is relaunching." };
  },
  subscribe(listener: (status: unknown) => void) {
    rendererStateListener = listener;
    return () => {
      if (rendererStateListener === listener) rendererStateListener = null;
    };
  }
};

Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { vigilAppUpdate: rendererBridge }
});

try {
  for (const id of [
    "checkAppUpdate",
    "relaunchVigil",
    "appUpdateStatus",
    "appUpdateMeta",
    "appUpdatePanel",
    "appUpdateHelp",
    "appUpdateProgress"
  ]) {
    controls.set(`#${id}`, fakeControl(
      id === "checkAppUpdate"
        ? (listener) => {
            buttonClick = listener;
          }
        : id === "relaunchVigil"
          ? (listener) => {
              relaunchButtonClick = listener;
            }
          : undefined
    ));
  }
  const panel = createAppUpdatePanel({
    $: (selector) => {
      const control = controls.get(selector);
      assert.ok(control, `missing fake control ${selector}`);
      return control;
    },
    get: async <T = unknown,>(_path: string) => {
      getCalls += 1;
      return {} as T;
    },
    post: async <T = unknown,>(_path: string, _body: unknown) => {
      postCalls += 1;
      return {} as T;
    },
    toast(message) {
      updateToasts.push(message);
    },
    errorMessage: (error) => error instanceof Error ? error.message : String(error)
  });
  panel.bind();
  await panel.refreshStatus(true);
  assert.equal(statusCalls, 1);
  assert.equal(checkedRemote, true);
  assert.equal(getCalls, 0);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Install Update");

  const pendingCheckResult = deferred<UnknownRecord>();
  nextRendererStatus = pendingCheckResult.promise;
  const pendingCheck = panel.refreshStatus(true);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Checking for Updates…");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(controls.get("#appUpdatePanel")?.getAttribute("aria-busy"), "true");
  assert.equal(controls.get("#appUpdateProgress")?.hidden, false);
  panel.render();
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Checking for Updates…", "a dashboard render must not restore the cached action during a pending check");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  pendingCheckResult.resolve(rendererStatus);
  await pendingCheck;
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Install Update");

  const staleStatusResult = deferred<UnknownRecord>();
  nextRendererStatus = staleStatusResult.promise;
  const staleStatusRequest = panel.refreshStatus(false);
  publishRendererUpdate({
    ok: true,
    running: true,
    updateAvailable: false,
    operation: "starting",
    phase: "starting",
    message: "Vigil will quit, update, and reopen",
    updateStateRevision: 10
  });
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Starting Update…", "a native start must immediately update Settings through the coordinator broadcast");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  staleStatusResult.resolve({ ...rendererStatus, updateStateRevision: 9 });
  await staleStatusRequest;
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Starting Update…", "a status response captured before the native start must not overwrite its running state");
  publishRendererUpdate({ ...rendererStatus, running: false, operation: null, updateStateRevision: 9 });
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Starting Update…", "an older coordinator event must not overwrite the active revision");
  publishRendererUpdate({ ...rendererStatus, running: false, operation: null, updateStateRevision: 11 });
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Install Update");

  publishRendererUpdate({
    ...rendererStatus,
    running: false,
    updateAvailable: true,
    recoveryPending: true,
    recoveryBlocked: false,
    message: "Restoring the verified Vigil recovery copy.",
    updateStateRevision: 12
  });
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Recovering Vigil Update…");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(controls.get("#appUpdateStatus")?.textContent, "Restoring the verified Vigil recovery copy.");

  publishRendererUpdate({
    ...rendererStatus,
    ok: false,
    running: false,
    updateAvailable: true,
    maintenanceReady: false,
    recoveryPending: false,
    recoveryBlocked: true,
    error: "A generic status failure must not replace recovery guidance.",
    message: "The preserved recovery evidence needs manual attention.",
    updateStateRevision: 13
  });
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Update Recovery Required");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(controls.get("#appUpdateStatus")?.textContent, "The preserved recovery evidence needs manual attention.");

  const click = buttonClick as (() => void) | null;
  assert.ok(click);
  rendererStatus = {
    ...rendererStatus,
    ok: true,
    checkOk: true,
    updateAvailable: false,
    updateCandidateAvailable: false,
    localChanges: false,
    maintenanceReady: false,
    maintenanceSetupRequired: true,
    maintenanceSetupSupported: true,
    recoveryPending: false,
    recoveryBlocked: false,
    message: "One-time setup is available when an update is ready"
  };
  await panel.refreshStatus(false);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Enable Fast Updates");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false,
    "guardian migration must remain available without an app update candidate");
  const statusCallsBeforeLegacyDiscovery = statusCalls;
  const startCallsBeforeLegacyDiscovery = startCalls;
  const noCandidateSetupResult = deferred<UnknownRecord>();
  nextRendererStartResult = noCandidateSetupResult.promise;
  click();
  click();
  assert.equal(startCalls, startCallsBeforeLegacyDiscovery + 1,
    "repeat clicks must not duplicate guardian-only setup");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Enabling Fast Updates…");
  noCandidateSetupResult.resolve({
    ...rendererStatus,
    ok: true,
    maintenanceReady: true,
    maintenanceSetupRequired: false,
    updateAvailable: false,
    updateCandidateAvailable: false,
    message: "Fast protected updates are ready."
  });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(statusCalls, statusCallsBeforeLegacyDiscovery,
    "guardian-only setup must not manufacture a remote update check");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Check for Updates");

  rendererStatus = {
    ...rendererStatus,
    ok: true,
    checkOk: true,
    updateAvailable: true,
    updateCandidateAvailable: true,
    localChanges: true,
    maintenanceReady: false,
    maintenanceSetupRequired: true,
    maintenanceSetupSupported: true,
    recoveryPending: false,
    recoveryBlocked: false,
    message: "One-time setup is needed"
  };
  await panel.refreshStatus(false);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Enable Fast Updates");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false, "a repairable legacy guardian must offer its migration action");
  assert.match(String(controls.get("#appUpdateHelp")?.textContent), /one macOS password prompt/u);

  const failedSetupResult = deferred<UnknownRecord>();
  nextRendererStartResult = failedSetupResult.promise;
  const startCallsBeforeSetup = startCalls;
  click();
  click();
  assert.equal(startCalls, startCallsBeforeSetup + 1, "repeat clicks must not start a second administrator prompt");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Enabling Fast Updates…");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(controls.get("#appUpdatePanel")?.getAttribute("aria-busy"), "true");
  assert.equal(controls.get("#appUpdateProgress")?.hidden, false);
  assert.match(String(controls.get("#appUpdateProgress")?.getAttribute("aria-valuetext")), /Approve the macOS prompt once/u);
  panel.render();
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Enabling Fast Updates…", "a dashboard render must not interrupt the one-time setup state");
  failedSetupResult.resolve({
    ...rendererStatus,
    ok: false,
    message: "The administrator approval was canceled."
  });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Retry Fast Update Setup");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false);
  assert.equal(controls.get("#appUpdateStatus")?.textContent, "The administrator approval was canceled.");

  const successfulSetupResult = deferred<UnknownRecord>();
  nextRendererStartResult = successfulSetupResult.promise;
  click();
  click();
  assert.equal(startCalls, startCallsBeforeSetup + 2, "retrying setup must still remain one transaction per click cycle");
  successfulSetupResult.resolve({
    ...rendererStatus,
    ok: true,
    maintenanceReady: true,
    maintenanceSetupRequired: false,
    running: false,
    updateAvailable: true,
    updateCandidateAvailable: true,
    phase: "",
    message: "Fast protected updates are ready."
  });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Run Latest Changes",
    "successful setup must expose the selected update without another password");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false);

  rendererStatus = {
    ...rendererStatus,
    ok: true,
    updateAvailable: true,
    updateCandidateAvailable: true,
    maintenanceReady: true,
    maintenanceSetupRequired: false,
    maintenanceSetupSupported: true,
    running: false
  };
  await panel.refreshStatus(false);

  const pendingStartResult = deferred<UnknownRecord>();
  nextRendererStartResult = pendingStartResult.promise;
  const startCallsBeforeRegularUpdate = startCalls;
  click();
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Starting Update…");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  panel.render();
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Starting Update…", "a dashboard render must not restore the cached action during a pending start");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  pendingStartResult.resolve(rendererStartResult);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, startCallsBeforeRegularUpdate + 1);
  assert.equal(postCalls, 0);
  const startCallsAfterRegularUpdate = startCalls;

  rendererStatus = {
    ok: true,
    supported: true,
    updateAvailable: false,
    appBundleOutdated: false,
    dirty: true,
    localChanges: false,
    behind: 1,
    remoteCheckOk: true,
    message: "Local changes are running"
  };
  await panel.refreshStatus(true);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Check for Updates");
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, startCallsAfterRegularUpdate, "a dirty checkout already represented by the app must not offer a rejected remote update");

  rendererStatus = {
    ok: true,
    supported: true,
    updateAvailable: true,
    dirty: true,
    localChanges: true,
    behind: 0,
    message: "Local changes ready to run"
  };
  await panel.refreshStatus(false);
  rendererStartResult = {
    ...rendererStatus,
    running: true,
    updateAvailable: false,
    phase: "building",
    message: "Building local changes"
  };
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, startCallsAfterRegularUpdate + 1);
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_100));
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false, "a completed or failed local build must refresh the cached running state");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Run Latest Changes");

  rendererStartResult = {
    ok: false,
    running: true,
    updateAvailable: false,
    phase: "starting",
    message: "A Vigil update is already starting."
  };
  const statusCallsBeforeActivePoll = statusCalls;
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(startCalls, startCallsAfterRegularUpdate + 2);
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Updating Vigil…", "an already-running start result must preserve the active transaction state");
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 1_100));
  assert.ok(statusCalls > statusCallsBeforeActivePoll, "an already-running start result must continue polling updater status");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, false);
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Run Latest Changes");
  rendererStartResult = {
    ok: true,
    noUpdate: true,
    running: false,
    updateAvailable: false,
    phase: "",
    message: "No newer Vigil update is available."
  };
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(updateToasts.at(-1), "No newer Vigil update is available.", "a revalidation no-op must not claim that an update started");
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Check for Updates");

  rendererStatus = {
    ok: true,
    checkOk: true,
    supported: true,
    maintenanceReady: true,
    running: false,
    updateAvailable: true,
    localChanges: false,
    message: "Update available"
  };
  await panel.refreshStatus(false);
  rendererStartResult = {
    ok: false,
    checkOk: false,
    supported: true,
    maintenanceReady: false,
    running: false,
    updateAvailable: false,
    recoveryPending: false,
    recoveryBlocked: true,
    phase: "failed",
    message: "The preserved recovery evidence needs manual attention.",
    error: "The preserved recovery evidence needs manual attention."
  };
  click();
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(controls.get("#checkAppUpdate")?.textContent, "Update Recovery Required");
  assert.equal(controls.get("#checkAppUpdate")?.disabled, true);
  assert.equal(
    controls.get("#appUpdateStatus")?.textContent,
    "The preserved recovery evidence needs manual attention.",
    "a structured start rejection must retain exact recovery guidance instead of becoming a retryable generic error"
  );

  rendererStatus = {
    ok: true,
    supported: true,
    running: false,
    recoveryPending: false,
    recoveryBlocked: false,
    updateAvailable: true,
    message: "Installed app is behind this checkout"
  };
  await panel.refreshStatus(false);
  const relaunchResult = deferred<UnknownRecord>();
  nextRendererRelaunchResult = relaunchResult.promise;
  const relaunchClick = relaunchButtonClick as (() => void) | null;
  assert.ok(relaunchClick);
  relaunchClick();
  relaunchClick();
  assert.equal(relaunchCalls, 1, "repeat clicks must not schedule duplicate protected relaunches");
  assert.equal(controls.get("#relaunchVigil")?.textContent, "Relaunching Vigil…");
  assert.equal(controls.get("#relaunchVigil")?.disabled, true);
  relaunchResult.resolve({ ok: true, relaunching: true, message: "Vigil is relaunching under its restart supervisor." });
  await new Promise<void>((resolveWait) => setTimeout(resolveWait, 0));
  assert.equal(updateToasts.at(-1), "Vigil is relaunching under its restart supervisor.");
  panel.dispose();
  assert.equal(rendererStateListener, null, "disposing the panel must unsubscribe from coordinator state");
} finally {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow
  });
}

function fakeControl(onClick?: (listener: () => void) => void): ControlElement {
  const classes = new Set<string>();
  const attributes = new Map<string, string>();
  return {
    textContent: "",
    disabled: false,
    hidden: false,
    classList: {
      add: (...tokens: string[]) => tokens.forEach((token) => classes.add(token)),
      remove: (...tokens: string[]) => tokens.forEach((token) => classes.delete(token)),
      toggle: (token: string, force?: boolean) => {
        const enabled = force ?? !classes.has(token);
        if (enabled) classes.add(token);
        else classes.delete(token);
        return enabled;
      }
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    getAttribute(name: string) {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name: string) {
      attributes.delete(name);
    },
    addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
      if (type !== "click" || !onClick) return;
      onClick(() => {
        if (typeof listener === "function") listener(new Event("click"));
        else listener.handleEvent(new Event("click"));
      });
    }
  } as unknown as ControlElement;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolveDeferred) => {
    resolvePromise = resolveDeferred;
  });
  return { promise, resolve: resolvePromise };
}

function publishRendererUpdate(status: UnknownRecord): void {
  const listener = rendererStateListener;
  assert.ok(listener, "the Settings panel should subscribe to coordinator state");
  listener(status);
}
