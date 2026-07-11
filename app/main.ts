import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, systemPreferences, Tray } from "electron";
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from "electron";
import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../src/apiSecurity.js";
import { resolveDefaultDataDir } from "../src/dataPaths.js";
import { plistStringForKey } from "../src/plist.js";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";
import { getTouchIdSecret } from "../src/touchIdAuth.js";
import { getInstanceSecret } from "../src/instanceIdentity.js";
import { createVigilAppUpdateController } from "./updater.js";
import type { VigilAppUpdateController } from "./updater.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.VIGIL_PORT || process.env.VIGIL_PORT || 8787);
const BASE_URL = `http://${HOST}:${PORT}`;
const RUNTIME_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TRAY_STATUS_CHECK_TIMEOUT_MS = 2000;
const TRAY_ACTION_TIMEOUT_MS = 5000;
const TRAY_STATUS_POLL_INTERVAL_MS = 30_000;
const BACKGROUND_LAUNCH_ARG = "--vigil-background";
const DEFAULT_WINDOW_SIZE = 680;
const MIN_WINDOW_SIZE = 680;
const WINDOW_ASPECT_RATIO = 1;
const ICON_THEMES = ["jerusalem-cross", "sacred-heart"] as const;
type IconTheme = typeof ICON_THEMES[number];
const DEFAULT_ICON_THEME: IconTheme = "jerusalem-cross";

interface VigilServerHandle {
  url: string;
  stop(): Promise<void>;
}

interface TrayStatus {
  label: string;
  detail: string;
  panicActionLabel: string;
  canStartPanicLock: boolean;
}

interface AppUpdateActionState {
  checked: boolean;
  checking: boolean;
  running: boolean;
  installable: boolean;
  message: string;
}

let mainWindow: BrowserWindow | null = null;
let ownedServer: VigilServerHandle | null = null;
let tray: Tray | null = null;
let lastTrayStatus: TrayStatus | null = null;
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null;
let currentAppUrl: string | null = null;
let instanceSecretPromise: Promise<string> | null = null;
let appUpdateController: VigilAppUpdateController | null = null;
let quitForUpdate = false;
let selectedIconTheme: IconTheme = DEFAULT_ICON_THEME;
let appUpdateActionState: AppUpdateActionState = {
  checked: false,
  checking: false,
  running: false,
  installable: false,
  message: ""
};

ipcMain.handle("vigil:journal-touch-id", handleJournalTouchId);
ipcMain.handle("vigil:app-update-status", handleAppUpdateStatus);
ipcMain.handle("vigil:app-update-start", handleAppUpdateStart);
ipcMain.handle("vigil:icon-theme-get", handleIconThemeGet);
ipcMain.handle("vigil:icon-theme-set", handleIconThemeSet);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("Vigil");

if (app.isPackaged && !process.env.VIGIL_DATA_DIR) {
  app.setPath("userData", join(app.getPath("appData"), "Vigil"));
  process.env.VIGIL_DATA_DIR = configuredLaunchAgentDataDir() || app.getPath("userData");
}

app.on("second-instance", (_event, commandLine) => {
  if (commandLine.includes(BACKGROUND_LAUNCH_ARG)) return;
  if (!mainWindow && currentAppUrl) {
    showVigilWindow(currentAppUrl);
    return;
  }
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

void app.whenReady().then(async () => {
  selectedIconTheme = loadIconThemePreference();
  configureMenuBarResidency();
  configureLiveDevelopmentSource();
  appUpdateController = createVigilAppUpdateController({
    app,
    quitForUpdate: () => {
      quitForUpdate = true;
      app.quit();
    }
  });
  const appUrl = await ensureVigilServer(appUpdateController);
  currentAppUrl = appUrl;
  installMenu(appUrl);
  installMenuBarCompanion(appUrl);
  applyIconTheme(selectedIconTheme);
  if (shouldShowWindowOnLaunch()) showVigilWindow(appUrl);

});

app.on("before-quit", async (event) => {
  if (shouldStayResident() && !quitForUpdate) {
    event.preventDefault();
    hideVigilWindow();
    return;
  }
  stopTrayRefresh();
  if (!ownedServer) return;
  event.preventDefault();
  const server = ownedServer;
  ownedServer = null;
  await server.stop();
  app.quit();
});

app.on("window-all-closed", () => {
  if (!shouldStayResident()) app.quit();
});

function showVigilWindow(appUrl: string): void {
  if (!mainWindow) createWindow(appUrl);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function hideVigilWindow(): void {
  if (!mainWindow) return;
  mainWindow.hide();
}

function createWindow(appUrl: string): void {
  mainWindow = new BrowserWindow({
    width: DEFAULT_WINDOW_SIZE,
    height: DEFAULT_WINDOW_SIZE,
    minWidth: MIN_WINDOW_SIZE,
    minHeight: MIN_WINDOW_SIZE,
    center: true,
    title: "Vigil",
    icon: iconAssetPath(`${selectedIconTheme}.png`),
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 19 },
    backgroundColor: "#14191c",
    alwaysOnTop: false,
    fullscreenable: true,
    webPreferences: {
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      sandbox: true,
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs")
    }
  });

  mainWindow.setAspectRatio(WINDOW_ASPECT_RATIO);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);

  void mainWindow.loadURL(appUrl);
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedAppUrl(url)) event.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function handleJournalTouchId(event: IpcMainInvokeEvent): Promise<unknown> {
  if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) {
    return { ok: false, error: "Touch ID request origin was rejected." };
  }
  if (process.platform !== "darwin" || !systemPreferences.canPromptTouchID()) {
    return { ok: false, error: "Touch ID is not available on this Mac." };
  }
  try {
    await systemPreferences.promptTouchID("Unlock your Vigil journal");
    const touchIdSecret = await getTouchIdSecret(
      process.env.VIGIL_DATA_DIR || resolveDefaultDataDir(RUNTIME_ROOT)
    );
    const appUrl = currentAppUrl || BASE_URL;
    const sessionCookies = await event.sender.session.cookies.get({ url: appUrl });
    const cookieHeader = sessionCookies
      .filter((cookie) => cookie.name === "vigil_session")
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
    const response = await fetch(`${appUrl}/api/intentional-use/journal/unlock-touch-id`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE,
        "X-Vigil-Touch-ID-Secret": touchIdSecret,
        ...(cookieHeader ? { Cookie: cookieHeader } : {})
      },
      body: "{}"
    });
    return await response.json() as unknown;
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Touch ID was not accepted." };
  }
}

async function handleAppUpdateStatus(event: IpcMainInvokeEvent, options: unknown): Promise<unknown> {
  const controller = trustedAppUpdateController(event);
  if (!controller) return rejectedAppUpdateRequest();
  const input = asRecord(options);
  return await controller.status({ checkRemote: input?.checkRemote === true });
}

async function handleAppUpdateStart(event: IpcMainInvokeEvent): Promise<unknown> {
  const controller = trustedAppUpdateController(event);
  if (!controller) return rejectedAppUpdateRequest();
  return await controller.start();
}

function handleIconThemeGet(event: IpcMainInvokeEvent): Record<string, unknown> {
  if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return rejectedIconThemeRequest();
  return { ok: true, theme: selectedIconTheme };
}

function handleIconThemeSet(event: IpcMainInvokeEvent, value: unknown): Record<string, unknown> {
  if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return rejectedIconThemeRequest();
  const theme = normalizeIconTheme(value);
  if (!theme) return { ok: false, theme: selectedIconTheme, error: "Unknown Vigil icon." };
  try {
    saveIconThemePreference(theme);
    selectedIconTheme = theme;
    applyIconTheme(theme);
    return { ok: true, theme };
  } catch (error) {
    return {
      ok: false,
      theme: selectedIconTheme,
      error: error instanceof Error ? error.message : "Icon choice could not be saved."
    };
  }
}

function rejectedIconThemeRequest(): Record<string, unknown> {
  return { ok: false, theme: selectedIconTheme, error: "Icon request origin was rejected." };
}

function trustedAppUpdateController(event: IpcMainInvokeEvent): VigilAppUpdateController | null {
  if (!event.senderFrame || !isTrustedAppUrl(event.senderFrame.url)) return null;
  return appUpdateController;
}

function rejectedAppUpdateRequest(): Record<string, unknown> {
  return {
    ok: false,
    supported: false,
    running: false,
    error: "App update request origin was rejected."
  };
}

function configureMenuBarResidency(): void {
  if (!shouldStayResident()) return;
  app.dock?.hide();
  app.setLoginItemSettings({
    openAtLogin: true,
    openAsHidden: true
  });
}

function shouldShowWindowOnLaunch(): boolean {
  if (process.argv.includes(BACKGROUND_LAUNCH_ARG)) return false;
  if (!shouldStayResident()) return true;
  return !app.getLoginItemSettings().wasOpenedAtLogin;
}

function shouldStayResident(): boolean {
  return process.platform === "darwin" && app.isPackaged;
}

function configuredLaunchAgentDataDir(): string {
  try {
    const plistPath = join(app.getPath("home"), "Library", "LaunchAgents", "com.vigil.agent.plist");
    const xml = readFileSync(plistPath, "utf8");
    const explicit = plistStringForKey(xml, "VIGIL_DATA_DIR");
    if (explicit) return explicit;
    const workingDirectory = plistStringForKey(xml, "WorkingDirectory");
    return workingDirectory ? resolveDefaultDataDir(workingDirectory) : "";
  } catch {
    return "";
  }
}

function configureLiveDevelopmentSource(): void {
  try {
    const plistPath = join(app.getPath("home"), "Library", "LaunchAgents", "com.vigil.agent.plist");
    const xml = readFileSync(plistPath, "utf8");
    if (plistStringForKey(xml, "VIGIL_LIVE_SOURCE") !== "1") return;
    const sourceRoot = plistStringForKey(xml, "VIGIL_SOURCE_ROOT");
    if (!sourceRoot) return;
    process.env.VIGIL_LIVE_SOURCE = "1";
    process.env.VIGIL_SOURCE_ROOT = sourceRoot;
  } catch {
    // A self-contained app continues to use its packaged frontend.
  }
}

async function ensureVigilServer(appUpdate: VigilAppUpdateController): Promise<string> {
  if (await serverIsHealthy()) return BASE_URL;

  const { startVigilServer } = await import("../src/server.js");
  ownedServer = await startVigilServer({ host: HOST, port: PORT, appUpdate }) as VigilServerHandle;
  return ownedServer.url;
}

async function serverIsHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const health = await fetchVigilStateHealth(`${BASE_URL}/api/health`, {
      signal: controller.signal,
      expectedPort: PORT,
      instanceSecret: await appInstanceSecret()
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function installMenu(appUrl: string): void {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Reload Vigil",
      accelerator: "CommandOrControl+R",
      click: () => {
        void mainWindow?.loadURL(appUrl);
      }
    }
  ];
  if (!app.isPackaged) viewSubmenu.push({ role: "toggleDevTools" });
  viewSubmenu.push(
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" }
  );

  const template: MenuItemConstructorOptions[] = [
    {
      label: "Vigil",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        {
          label: appUpdateActionLabel(),
          enabled: canUseAppUpdateAction(),
          click: () => {
            void handleAppUpdateAction(appUrl);
          }
        },
        { type: "separator" },
        {
          label: "Hide Vigil Window",
          accelerator: "CommandOrControl+Q",
          click: hideVigilWindow
        }
      ]
    },
    {
      label: "File",
      submenu: [{ role: "close" }]
    },
    {
      label: "View",
      submenu: viewSubmenu
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        { type: "separator" },
        { role: "front" }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isTrustedAppUrl(value: string): boolean {
  try {
    return new URL(value).origin === BASE_URL;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(value: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function installMenuBarCompanion(appUrl: string): void {
  if (tray) return;
  const icon = trayIconForTheme(selectedIconTheme);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Vigil");
  updateTrayMenu(appUrl, checkingTrayStatus(appUrl));
  tray.on("click", () => {
    void refreshTrayStatus(appUrl);
  });
  tray.on("right-click", () => {
    void refreshTrayStatus(appUrl);
  });
  trayRefreshTimer = setInterval(() => {
    void refreshTrayStatus(appUrl);
  }, TRAY_STATUS_POLL_INTERVAL_MS);
  void refreshTrayStatus(appUrl);
}

function normalizeIconTheme(value: unknown): IconTheme | null {
  return typeof value === "string" && ICON_THEMES.includes(value as IconTheme) ? value as IconTheme : null;
}

function loadIconThemePreference(): IconTheme {
  try {
    const value = JSON.parse(readFileSync(iconThemePreferencePath(), "utf8")) as { theme?: unknown };
    return normalizeIconTheme(value.theme) || DEFAULT_ICON_THEME;
  } catch {
    return DEFAULT_ICON_THEME;
  }
}

function saveIconThemePreference(theme: IconTheme): void {
  const path = iconThemePreferencePath();
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporaryPath, `${JSON.stringify({ theme }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function iconThemePreferencePath(): string {
  return join(app.getPath("userData"), "appearance.json");
}

function applyIconTheme(theme: IconTheme): void {
  const appIcon = nativeImage.createFromPath(iconAssetPath(`${theme}.png`));
  if (!appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
    mainWindow?.setIcon(appIcon);
  }
  const trayIcon = trayIconForTheme(theme);
  trayIcon.setTemplateImage(true);
  tray?.setImage(trayIcon);
}

function trayIconForTheme(theme: IconTheme): Electron.NativeImage {
  return nativeImage.createFromPath(iconAssetPath(`tray-${theme}Template.png`));
}

function iconAssetPath(filename: string): string {
  return join(RUNTIME_ROOT, "public", "app-icons", filename);
}

function stopTrayRefresh(): void {
  if (!trayRefreshTimer) return;
  clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
}

function updateTrayMenu(appUrl: string, status: TrayStatus): void {
  lastTrayStatus = status;
  if (!tray) return;
  const updateDetail = appUpdateActionDetail();
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Open Vigil",
      click: () => {
        showVigilWindow(appUrl);
      }
    },
    { type: "separator" },
    { label: status.label, enabled: false },
    { label: status.detail, enabled: false },
    { type: "separator" },
    {
      label: status.panicActionLabel,
      enabled: status.canStartPanicLock,
      click: () => {
        void startPanicLock(appUrl);
      }
    },
    {
      label: appUpdateActionLabel(),
      enabled: canUseAppUpdateAction(),
      click: () => {
        void handleAppUpdateAction(appUrl);
      }
    },
    ...(updateDetail ? [{ label: updateDetail, enabled: false } satisfies MenuItemConstructorOptions] : []),
    {
      label: "Reload Vigil",
      click: () => {
        if (mainWindow) {
          void mainWindow.loadURL(appUrl);
        } else {
          showVigilWindow(appUrl);
        }
        void refreshTrayStatus(appUrl);
      }
    },
    { type: "separator" },
    {
      label: "Hide Vigil Window",
      click: hideVigilWindow
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function refreshUpdateMenus(appUrl: string): void {
  installMenu(appUrl);
  if (lastTrayStatus) updateTrayMenu(appUrl, lastTrayStatus);
}

function appUpdateActionLabel(): string {
  if (appUpdateActionState.checking) return "Checking for Updates...";
  if (appUpdateActionState.running) return "Updating Vigil...";
  if (appUpdateActionState.installable) return "Install Update";
  return "Check for Updates";
}

function appUpdateActionDetail(): string {
  if (appUpdateActionState.checking) return "Updates: checking...";
  if (!appUpdateActionState.checked && !appUpdateActionState.running) return "";
  return appUpdateActionState.message ? `Updates: ${shortTrayDetail(appUpdateActionState.message)}` : "";
}

function canUseAppUpdateAction(): boolean {
  return !appUpdateActionState.checking && !appUpdateActionState.running;
}

async function handleAppUpdateAction(appUrl: string): Promise<void> {
  if (appUpdateActionState.installable) {
    await startAppUpdate(appUrl);
    return;
  }
  await checkAppUpdate(appUrl);
}

async function refreshTrayStatus(appUrl: string): Promise<void> {
  updateTrayMenu(appUrl, checkingTrayStatus(appUrl));
  updateTrayMenu(appUrl, await readTrayStatus(appUrl));
}

async function readTrayStatus(appUrl: string): Promise<TrayStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRAY_STATUS_CHECK_TIMEOUT_MS);
  const port = portFromUrl(appUrl);
  try {
    const health = await fetchVigilStateHealth(apiUrl(appUrl, "/api/state"), {
      signal: controller.signal,
      expectedPort: port,
      instanceSecret: await appInstanceSecret()
    });
    if (!health.ok) {
      return offlineTrayStatus(appUrl);
    }
    return summarizeTrayStatus(health.body, port);
  } catch {
    return offlineTrayStatus(appUrl);
  } finally {
    clearTimeout(timeout);
  }
}

function appInstanceSecret(): Promise<string> {
  instanceSecretPromise ||= getInstanceSecret(
    process.env.VIGIL_DATA_DIR || resolveDefaultDataDir(RUNTIME_ROOT)
  );
  return instanceSecretPromise;
}

async function startPanicLock(appUrl: string): Promise<void> {
  updateTrayMenu(appUrl, {
    label: "Status: Starting Panic Lock",
    detail: "Requesting local Vigil lockout...",
    panicActionLabel: "Starting Panic Lock...",
    canStartPanicLock: false
  });
  try {
    const body = await requestPanicLock(appUrl);
    const session = asRecord(asRecord(body)?.session);
    updateTrayMenu(appUrl, {
      label: "Status: Panic Lock - Panic Lockout",
      detail: session ? sessionEndDetail(session) || "Panic lock started" : "Panic lock started",
      panicActionLabel: "Panic Lock Active",
      canStartPanicLock: false
    });
    await refreshTrayStatus(appUrl);
  } catch (error) {
    updateTrayMenu(appUrl, {
      label: "Status: Panic Lock Failed",
      detail: shortTrayDetail(errorMessage(error)),
      panicActionLabel: "Start Panic Lock",
      canStartPanicLock: true
    });
  }
}

async function checkAppUpdate(appUrl: string): Promise<void> {
  appUpdateActionState = {
    checked: appUpdateActionState.checked,
    checking: true,
    running: false,
    installable: false,
    message: "Checking for updates"
  };
  refreshUpdateMenus(appUrl);
  try {
    const status = asRecord(await requestAppUpdateStatus({ checkRemote: true }));
    const running = Boolean(status?.running);
    const installable = isInstallableAppUpdate(status);
    appUpdateActionState = {
      checked: true,
      checking: false,
      running,
      installable,
      message: nonEmptyString(status?.message) || (installable ? "Update available" : "Vigil is current")
    };
  } catch (error) {
    appUpdateActionState = {
      checked: true,
      checking: false,
      running: false,
      installable: false,
      message: errorMessage(error)
    };
  }
  refreshUpdateMenus(appUrl);
}

async function startAppUpdate(appUrl: string): Promise<void> {
  appUpdateActionState = {
    checked: true,
    checking: false,
    running: true,
    installable: false,
    message: "Vigil will quit, update, and reopen"
  };
  refreshUpdateMenus(appUrl);
  try {
    await requestAppUpdate();
  } catch (error) {
    appUpdateActionState = {
      checked: true,
      checking: false,
      running: false,
      installable: false,
      message: errorMessage(error)
    };
    refreshUpdateMenus(appUrl);
  }
}

async function requestPanicLock(appUrl: string): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRAY_ACTION_TIMEOUT_MS);
  try {
    const response = await fetch(apiUrl(appUrl, "/api/panic/start"), {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
      },
      body: "{}"
    });
    const body = await responseJson(response);
    const record = asRecord(body);
    if (!response.ok || record?.ok !== true) {
      throw new Error(nonEmptyString(record?.error) || `Panic lock failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAppUpdate(): Promise<unknown> {
  const controller = appUpdateController;
  if (!controller) throw new Error("The Vigil app updater is not ready.");
  const result = await controller.start();
  const record = asRecord(result);
  if (record?.ok !== true) {
    throw new Error(nonEmptyString(record?.error) || nonEmptyString(record?.message) || "Update could not start.");
  }
  return result;
}

async function requestAppUpdateStatus({ checkRemote = false }: { checkRemote?: boolean } = {}): Promise<unknown> {
  const controller = appUpdateController;
  if (!controller) throw new Error("The Vigil app updater is not ready.");
  const result = await controller.status({ checkRemote });
  const record = asRecord(result);
  if (record?.ok !== true) {
    throw new Error(nonEmptyString(record?.error) || nonEmptyString(record?.message) || "Update check failed.");
  }
  return result;
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function summarizeTrayStatus(body: unknown, port: number): TrayStatus {
  const root = asRecord(body);
  const state = asRecord(root?.state);
  const policy = asRecord(state?.activePolicy);
  const session = asRecord(policy?.session) || asRecord(state?.panicLock) || asRecord(state?.activeSession);
  const phase = asRecord(policy?.phase) || asRecord(state?.sessionPhase);
  if (policy || session) {
    const kind = nonEmptyString(policy?.kind);
    return {
      label: `Status: ${policyStatus(kind)} - ${shortTrayText(session ? sessionTitle(session) : policyTitle(policy || {}))}`,
      detail: policyDetail(policy, session, phase) || `Local server online on port ${port}`,
      panicActionLabel: kind === "panic" ? "Panic Lock Active" : "Start Panic Lock",
      canStartPanicLock: kind !== "panic"
    };
  }

  return {
    label: "Status: Unlocked",
    detail: `Local server online on port ${port}`,
    panicActionLabel: "Start Panic Lock",
    canStartPanicLock: true
  };
}

function checkingTrayStatus(appUrl: string): TrayStatus {
  return {
    label: "Status: Checking",
    detail: `Local server on port ${portFromUrl(appUrl)}`,
    panicActionLabel: "Start Panic Lock",
    canStartPanicLock: false
  };
}

function offlineTrayStatus(appUrl: string): TrayStatus {
  return {
    label: "Status: Offline",
    detail: `No trusted Vigil server on port ${portFromUrl(appUrl)}`,
    panicActionLabel: "Start Panic Lock",
    canStartPanicLock: false
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isInstallableAppUpdate(status: Record<string, unknown> | null): boolean {
  if (!status || status.ok !== true || status.supported === false || status.running || status.dirty || status.remoteCheckOk === false) return false;
  return Boolean(status.updateAvailable || status.appBundleOutdated || Number(status.behind || 0) > 0);
}

function sessionTitle(session: Record<string, unknown>): string {
  return nonEmptyString(session.title) || `${capitalize(nonEmptyString(session.mode) || "focus")} lock`;
}

function policyTitle(policy: Record<string, unknown>): string {
  return `${capitalize(nonEmptyString(policy.kind) || "active")} policy`;
}

function sessionEndDetail(session: Record<string, unknown>): string | null {
  return remainingDetail(nonEmptyString(session.endsAt));
}

function policyStatus(kind: string | null): string {
  if (kind === "panic") return "Panic Lock";
  if (kind === "manual" || kind === "schedule" || kind === "planner" || kind === "integrity") return "Locked";
  return "Protected";
}

function policyDetail(policy: Record<string, unknown> | null, session: Record<string, unknown> | null, phase: Record<string, unknown> | null): string | null {
  const phaseDetail = phase ? phaseEndDetail(phase) : null;
  if (phaseDetail) return phaseDetail;
  return remainingDetail(nonEmptyString(policy?.endsAt) || nonEmptyString(session?.endsAt));
}

function phaseEndDetail(phase: Record<string, unknown>): string | null {
  const detail = remainingDetail(nonEmptyString(phase.endsAt));
  if (!detail) return null;
  const label = nonEmptyString(phase.label) || capitalize(nonEmptyString(phase.kind) || "focus");
  const round = Number(phase.round);
  const rounds = Number(phase.rounds);
  const roundText = Number.isFinite(round) && Number.isFinite(rounds) && rounds > 1
    ? ` ${round}/${rounds}`
    : "";
  const next = nextPhaseText(phase);
  return next ? `${label}${roundText}: ${detail}; ${next}` : `${label}${roundText}: ${detail}`;
}

function nextPhaseText(phase: Record<string, unknown>): string | null {
  const kind = nonEmptyString(phase.kind);
  const round = Number(phase.round);
  const rounds = Number(phase.rounds);
  if (!Number.isFinite(round) || !Number.isFinite(rounds) || rounds <= 1) return null;
  if (kind === "work" && round < rounds) return "next Break";
  if (kind === "break") return `next Focus ${round + 1}/${rounds}`;
  return null;
}

function remainingDetail(endsAt: string | null): string | null {
  if (!endsAt) return null;
  const date = new Date(endsAt);
  const remainingMs = date.getTime() - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return null;
  return `Remaining ${formatRemaining(remainingMs)} (until ${formatEndTime(date)})`;
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
}

function formatEndTime(date: Date): string {
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return date.toDateString() === now.toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function shortTrayText(value: string): string {
  return value.length <= 48 ? value : `${value.slice(0, 45)}...`;
}

function shortTrayDetail(value: string): string {
  return value.length <= 72 ? value : `${value.slice(0, 69)}...`;
}

function apiUrl(appUrl: string, path: string): string {
  return new URL(path, appUrl).toString();
}

function portFromUrl(appUrl: string): number {
  try {
    return Number(new URL(appUrl).port) || PORT;
  } catch {
    return PORT;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
