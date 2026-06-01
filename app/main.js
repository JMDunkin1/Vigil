import { app, BrowserWindow, Menu, shell } from "electron";
import { join } from "node:path";
import { fetchVigilStateHealth } from "../src/vigilHealth.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.VIGIL_PORT || process.env.VIGIL_PORT || 8787);
const BASE_URL = `http://${HOST}:${PORT}`;

let mainWindow = null;
let ownedServer = null;

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

app.whenReady().then(async () => {
  const appUrl = await ensureVigilServer();
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

function createWindow(appUrl) {
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

  mainWindow.loadURL(appUrl);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function ensureVigilServer() {
  if (await serverIsHealthy()) return BASE_URL;

  const { startVigilServer } = await import("../src/server.js");
  ownedServer = await startVigilServer({ host: HOST, port: PORT });
  return ownedServer.url;
}

async function serverIsHealthy() {
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

function installMenu(appUrl) {
  const template = [
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
          click: () => mainWindow?.loadURL(appUrl)
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
