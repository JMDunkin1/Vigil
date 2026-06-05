import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.VIGIL_PORT || process.env.VIGIL_PORT || 8787);
const BASE_URL = `http://${HOST}:${PORT}`;
const TRAY_STATUS_CHECK_TIMEOUT_MS = 2000;
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAALElEQVR4nGNgGArgP5F4GBhESHwIGYSuCZ/YqEEUpCGqG4TPMJIB1QwaGAAA6A5plz/jasAAAAAASUVORK5CYII=";

interface VigilServerHandle {
  url: string;
  stop(): Promise<void>;
}

interface TrayStatus {
  label: string;
  detail: string;
}

let mainWindow: BrowserWindow | null = null;
let ownedServer: VigilServerHandle | null = null;
let tray: Tray | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("Vigil");

if (app.isPackaged && !process.env.VIGIL_DATA_DIR) {
  app.setPath("userData", join(app.getPath("appData"), "Vigil"));
  process.env.VIGIL_DATA_DIR = app.getPath("userData");
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

void app.whenReady().then(async () => {
  const appUrl = await ensureVigilServer();
  installMenu(appUrl);
  installMenuBarCompanion(appUrl);
  showVigilWindow(appUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showVigilWindow(appUrl);
  });
});

app.on("before-quit", async (event) => {
  if (!ownedServer) return;
  event.preventDefault();
  const server = ownedServer;
  ownedServer = null;
  await server.stop();
  app.quit();
});

function showVigilWindow(appUrl: string): void {
  if (!mainWindow) createWindow(appUrl);
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow(appUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 680,
    title: "Vigil",
    backgroundColor: "#f7f4ed",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  void mainWindow.loadURL(appUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function ensureVigilServer(): Promise<string> {
  if (await serverIsHealthy()) return BASE_URL;

  const { startVigilServer } = await import("../src/server.js");
  ownedServer = await startVigilServer({ host: HOST, port: PORT }) as VigilServerHandle;
  return ownedServer.url;
}

async function serverIsHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const health = await fetchVigilStateHealth(`${BASE_URL}/api/state`, {
      signal: controller.signal,
      expectedPort: PORT
    });
    return health.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function installMenu(appUrl: string): void {
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
        { role: "quit" }
      ]
    },
    {
      label: "View",
      submenu: [
        {
          label: "Reload Vigil",
          accelerator: "CommandOrControl+R",
          click: () => {
            void mainWindow?.loadURL(appUrl);
          }
        },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
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

function installMenuBarCompanion(appUrl: string): void {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Vigil");
  updateTrayMenu(appUrl, { label: "Status: Checking", detail: `Local server on port ${PORT}` });
  tray.on("click", () => {
    void refreshTrayStatus(appUrl);
  });
  tray.on("right-click", () => {
    void refreshTrayStatus(appUrl);
  });
  void refreshTrayStatus(appUrl);
}

function updateTrayMenu(appUrl: string, status: TrayStatus): void {
  if (!tray) return;
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
    {
      label: "Refresh Status",
      click: () => {
        void refreshTrayStatus(appUrl);
      }
    },
    { type: "separator" },
    {
      label: "Quit Vigil",
      click: () => {
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

async function refreshTrayStatus(appUrl: string): Promise<void> {
  updateTrayMenu(appUrl, { label: "Status: Checking", detail: `Local server on port ${PORT}` });
  updateTrayMenu(appUrl, await readTrayStatus());
}

async function readTrayStatus(): Promise<TrayStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRAY_STATUS_CHECK_TIMEOUT_MS);
  try {
    const health = await fetchVigilStateHealth(`${BASE_URL}/api/state`, {
      signal: controller.signal,
      expectedPort: PORT
    });
    if (!health.ok) {
      return { label: "Status: Offline", detail: `No trusted Vigil server on port ${PORT}` };
    }
    return summarizeTrayStatus(health.body);
  } catch {
    return { label: "Status: Offline", detail: `No trusted Vigil server on port ${PORT}` };
  } finally {
    clearTimeout(timeout);
  }
}

function summarizeTrayStatus(body: unknown): TrayStatus {
  const root = asRecord(body);
  const state = asRecord(root?.state);
  const policy = asRecord(state?.activePolicy);
  const session = asRecord(policy?.session) || asRecord(state?.activeSession);
  if (session) {
    return {
      label: `Status: Locked - ${shortTrayText(sessionTitle(session))}`,
      detail: sessionEndDetail(session) || "Active protection"
    };
  }

  if (policy) {
    return {
      label: `Status: Protected - ${shortTrayText(policyTitle(policy))}`,
      detail: `Local server online on port ${PORT}`
    };
  }

  return { label: "Status: Unlocked", detail: `Local server online on port ${PORT}` };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function sessionTitle(session: Record<string, unknown>): string {
  return nonEmptyString(session.title) || `${capitalize(nonEmptyString(session.mode) || "focus")} lock`;
}

function policyTitle(policy: Record<string, unknown>): string {
  return `${capitalize(nonEmptyString(policy.kind) || "active")} policy`;
}

function sessionEndDetail(session: Record<string, unknown>): string | null {
  const endsAt = nonEmptyString(session.endsAt);
  if (!endsAt) return null;
  const date = new Date(endsAt);
  if (!Number.isFinite(date.getTime())) return null;
  return `Ends at ${date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
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
