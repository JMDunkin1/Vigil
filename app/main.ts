import { app, BrowserWindow, Menu, shell } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { fetchSentinelStateHealth } from "../src/sentinelHealth.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SENTINEL_PORT || process.env.SCREEN_TIME_PORT || 8787);
const BASE_URL = `http://${HOST}:${PORT}`;

interface SentinelServerHandle {
  url: string;
  stop(): Promise<void>;
}

let mainWindow: BrowserWindow | null = null;
let ownedServer: SentinelServerHandle | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.setName("Sentinel");

if (app.isPackaged && !process.env.SENTINEL_DATA_DIR) {
  app.setPath("userData", join(app.getPath("appData"), "Sentinel"));
  process.env.SENTINEL_DATA_DIR = app.getPath("userData");
}

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
});

void app.whenReady().then(async () => {
  const appUrl = await ensureSentinelServer();
  installMenu(appUrl);
  createWindow(appUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(appUrl);
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

function createWindow(appUrl: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 940,
    minHeight: 680,
    title: "Sentinel",
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

async function ensureSentinelServer(): Promise<string> {
  if (await serverIsHealthy()) return BASE_URL;

  const { startSentinelServer } = await import("../src/server.js");
  ownedServer = await startSentinelServer({ host: HOST, port: PORT }) as SentinelServerHandle;
  return ownedServer.url;
}

async function serverIsHealthy(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const health = await fetchSentinelStateHealth(`${BASE_URL}/api/state`, {
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
      label: "Sentinel",
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
          label: "Reload Sentinel",
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
