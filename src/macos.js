import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { BROWSERS } from "./defaults.js";

const execFileAsync = promisify(execFile);
let wifiDevicePromise = null;
const CHROMIUM_BROWSERS = new Set([
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Arc",
  "Vivaldi",
  "Opera",
  "Orion"
]);

export async function runAppleScript(script, timeout = 2500) {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    timeout,
    maxBuffer: 1024 * 64
  });
  return stdout.trim();
}

export async function getFrontmostApp() {
  try {
    const app = await runAppleScript('tell application "System Events" to get name of first application process whose frontmost is true');
    return { ok: true, app };
  } catch (error) {
    return {
      ok: false,
      app: "",
      error: simplifyError(error)
    };
  }
}

export async function listRunningAppNames() {
  try {
    const { stdout } = await execFileAsync("/bin/ps", ["-axo", "comm="], {
      timeout: 2500,
      maxBuffer: 1024 * 512
    });
    return { ok: true, apps: parseProcessList(stdout) };
  } catch (error) {
    return { ok: false, apps: [], error: simplifyError(error) };
  }
}

export function parseProcessList(output = "") {
  return [...new Set(String(output)
    .split(/\r?\n/)
    .map((line) => processDisplayName(line))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export async function getActiveBrowserUrl(appName) {
  if (!BROWSERS.has(appName)) return { ok: true, url: "" };

  try {
    const app = escapeAppleScript(appName);
    if (appName === "Safari") {
      const url = await runAppleScript(`tell application "${app}" to if (count of windows) > 0 then get URL of current tab of front window`);
      return { ok: true, url };
    }

    if (CHROMIUM_BROWSERS.has(appName)) {
      const url = await runAppleScript(`tell application "${app}" to if (count of windows) > 0 then get URL of active tab of front window`);
      return { ok: true, url };
    }

    return { ok: true, url: "" };
  } catch (error) {
    return { ok: false, url: "", error: simplifyError(error) };
  }
}

export async function redirectActiveBrowserTab(appName, url) {
  if (!BROWSERS.has(appName)) return { ok: false, error: "Not a supported browser" };

  try {
    const app = escapeAppleScript(appName);
    const target = escapeAppleScript(url);
    if (appName === "Safari") {
      await runAppleScript(`tell application "${app}" to if (count of windows) > 0 then set URL of current tab of front window to "${target}"`);
      return { ok: true };
    }

    if (CHROMIUM_BROWSERS.has(appName)) {
      await runAppleScript(`tell application "${app}" to if (count of windows) > 0 then set URL of active tab of front window to "${target}"`);
      return { ok: true };
    }

    return { ok: false, error: "Browser does not expose tab redirects" };
  } catch (error) {
    return { ok: false, error: simplifyError(error) };
  }
}

export async function quitApp(appName, options = {}) {
  if (!appName) return { ok: false, error: "Missing app name" };
  if (options.force) return forceKillApp(appName);

  try {
    await runAppleScript(`ignoring application responses
      tell application "${escapeAppleScript(appName)}" to quit
    end ignoring`, 1500);
    return { ok: true, method: "quit" };
  } catch (error) {
    try {
      await execFileAsync("/usr/bin/pkill", ["-x", appName], { timeout: 1500 });
      return { ok: true, method: "pkill" };
    } catch (killError) {
      return { ok: false, error: `${simplifyError(error)}; ${simplifyError(killError)}` };
    }
  }
}

export async function lockScreen() {
  const cgSession = "/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession";
  try {
    await execFileAsync(cgSession, ["-suspend"], { timeout: 1500 });
    return { ok: true, method: "CGSession -suspend" };
  } catch (error) {
    try {
      await execFileAsync("/usr/bin/pmset", ["displaysleepnow"], { timeout: 1500 });
      return {
        ok: true,
        method: "pmset displaysleepnow",
        warning: simplifyError(error)
      };
    } catch (fallbackError) {
      return {
        ok: false,
        method: "lock screen",
        error: `${simplifyError(error)}; ${simplifyError(fallbackError)}`
      };
    }
  }
}

async function forceKillApp(appName) {
  try {
    await execFileAsync("/usr/bin/pkill", ["-9", "-x", appName], { timeout: 1500 });
    return { ok: true, method: "pkill -9" };
  } catch (error) {
    return { ok: false, method: "pkill -9", error: simplifyError(error) };
  }
}

export async function notify(title, message) {
  try {
    await runAppleScript(`display notification "${escapeAppleScript(message)}" with title "${escapeAppleScript(title)}"`, 1500);
    return true;
  } catch {
    return false;
  }
}

export async function getCurrentWifiNetwork() {
  try {
    const device = await wifiDevice();
    const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-getairportnetwork", device], {
      timeout: 2500,
      maxBuffer: 1024 * 16
    });
    const output = stdout.trim();
    const match = output.match(/Current Wi-Fi Network: (.+)$/);
    return { ok: true, ssid: match ? match[1].trim() : "" };
  } catch (error) {
    return { ok: false, ssid: "", error: simplifyError(error) };
  }
}

export function appCanReportUrls(appName) {
  return BROWSERS.has(appName);
}

export function urlHostname(url) {
  try {
    if (!url) return "";
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function escapeAppleScript(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function processDisplayName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const appBundle = raw.match(/([^/]+)\.app\/Contents\/MacOS\//i);
  if (!appBundle) return "";
  const name = basename(`${appBundle[1]}.app`).replace(/\.app$/i, "");
  return name || "";
}

async function wifiDevice() {
  wifiDevicePromise ||= findWifiDevice();
  return wifiDevicePromise;
}

async function findWifiDevice() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallhardwareports"], {
      timeout: 2500,
      maxBuffer: 1024 * 32
    });
    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      if (!/Hardware Port: (Wi-Fi|AirPort)/i.test(block)) continue;
      const match = block.match(/Device: (.+)/);
      if (match) return match[1].trim();
    }
  } catch {
  }
  return "en0";
}

function simplifyError(error) {
  return String(error?.stderr || error?.message || error || "").trim().split("\n").at(-1);
}
