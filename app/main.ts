import { app, BrowserWindow, Menu, nativeImage, shell, Tray } from "electron";
import type { MenuItemConstructorOptions } from "electron";
import { join } from "node:path";
import { CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE } from "../src/apiSecurity.js";
import { fetchSentinelStateHealth } from "../src/sentinelHealth.js";

const HOST = "127.0.0.1";
const PORT = Number(process.env.SENTINEL_PORT || process.env.SCREEN_TIME_PORT || 8787);
const BASE_URL = `http://${HOST}:${PORT}`;
const TRAY_STATUS_CHECK_TIMEOUT_MS = 2000;
const TRAY_ACTION_TIMEOUT_MS = 5000;
const TRAY_STATUS_POLL_INTERVAL_MS = 30_000;
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAAALElEQVR4nGNgGArgP5F4GBhESHwIGYSuCZ/YqEEUpCGqG4TPMJIB1QwaGAAA6A5plz/jasAAAAAASUVORK5CYII=";

interface SentinelServerHandle {
  url: string;
  stop(): Promise<void>;
}

interface TrayStatus {
  label: string;
  detail: string;
  panicActionLabel: string;
  canStartPanicLock: boolean;
}

let mainWindow: BrowserWindow | null = null;
let ownedServer: SentinelServerHandle | null = null;
let tray: Tray | null = null;
let trayRefreshTimer: ReturnType<typeof setInterval> | null = null;

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
  installMenuBarCompanion(appUrl);
  showSentinelWindow(appUrl);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) showSentinelWindow(appUrl);
  });
});

app.on("before-quit", async (event) => {
  stopTrayRefresh();
  if (!ownedServer) return;
  event.preventDefault();
  const server = ownedServer;
  ownedServer = null;
  await server.stop();
  app.quit();
});

function showSentinelWindow(appUrl: string): void {
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

function installMenuBarCompanion(appUrl: string): void {
  if (tray) return;
  const icon = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip("Sentinel");
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

function stopTrayRefresh(): void {
  if (!trayRefreshTimer) return;
  clearInterval(trayRefreshTimer);
  trayRefreshTimer = null;
}

function updateTrayMenu(appUrl: string, status: TrayStatus): void {
  if (!tray) return;
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Open Sentinel",
      click: () => {
        showSentinelWindow(appUrl);
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
      label: "Reload Sentinel",
      click: () => {
        if (mainWindow) {
          void mainWindow.loadURL(appUrl);
        } else {
          showSentinelWindow(appUrl);
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
      label: "Quit Sentinel",
      click: () => {
        app.quit();
      }
    }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
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
    const health = await fetchSentinelStateHealth(apiUrl(appUrl, "/api/state"), {
      signal: controller.signal,
      expectedPort: port
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

async function startPanicLock(appUrl: string): Promise<void> {
  updateTrayMenu(appUrl, {
    label: "Status: Starting Panic Lock",
    detail: "Requesting local Sentinel lockout...",
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

  return { label: "Status: Unlocked", detail: `Local server online on port ${port}`, panicActionLabel: "Start Panic Lock", canStartPanicLock: true };
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
    detail: `No trusted Sentinel server on port ${portFromUrl(appUrl)}`,
    panicActionLabel: "Start Panic Lock",
    canStartPanicLock: false
  };
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
