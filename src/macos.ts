import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import { BROWSERS } from "./defaults.js";
import type { UnknownRecord } from "./types.js";

const execFileAsync = promisify(execFile);
let wifiDevicePromise: Promise<string> | null = null;
const CHROMIUM_BROWSERS = new Set([
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Arc",
  "Vivaldi",
  "Opera",
  "Orion"
]);

export async function runAppleScript(script: string, timeout = 2500): Promise<string> {
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

export function parseProcessList(output = ""): string[] {
  return [...new Set(String(output)
    .split(/\r?\n/)
    .map((line) => processDisplayName(line))
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export async function getActiveBrowserUrl(appName: string) {
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

export async function redirectActiveBrowserTab(appName: string, url: string) {
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

export async function quitApp(appName: string, options: { force?: boolean } = {}) {
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

export async function readMacGrayscaleState() {
  const [universalAccess, coreGraphics] = await Promise.all([
    readBooleanDefault("com.apple.universalaccess", "grayscale"),
    readBooleanDefault("com.apple.CoreGraphics", "DisplayUseForcedGray")
  ]);
  const errors = [universalAccess.error, coreGraphics.error].filter(Boolean);
  return {
    ok: !errors.length,
    active: Boolean(universalAccess.value || coreGraphics.value),
    universalAccess: Boolean(universalAccess.value),
    coreGraphics: Boolean(coreGraphics.value),
    error: errors.join("; ")
  };
}

export async function setMacGrayscaleEnabled(enabled: boolean) {
  const before = await readMacGrayscaleState();
  const desired = Boolean(enabled);
  const alreadyCurrent = before.ok && before.universalAccess === desired && before.coreGraphics === desired;
  if (alreadyCurrent) {
    return {
      ok: true,
      desired,
      changed: false,
      before,
      after: before
    };
  }

  try {
    await execFileAsync("/usr/bin/defaults", ["write", "com.apple.universalaccess", "grayscale", "-bool", desired ? "true" : "false"], { timeout: 1500 });
    await execFileAsync("/usr/bin/defaults", ["write", "com.apple.CoreGraphics", "DisplayUseForcedGray", "-bool", desired ? "true" : "false"], { timeout: 1500 });
    await refreshAccessibilityPreferences();
    const after = await readMacGrayscaleState();
    return {
      ok: after.ok,
      desired,
      changed: true,
      before,
      after,
      error: after.error
    };
  } catch (error) {
    return {
      ok: false,
      desired,
      changed: false,
      before,
      after: before,
      error: simplifyError(error)
    };
  }
}

async function forceKillApp(appName: string) {
  try {
    await execFileAsync("/usr/bin/pkill", ["-9", "-x", appName], { timeout: 1500 });
    return { ok: true, method: "pkill -9" };
  } catch (error) {
    return { ok: false, method: "pkill -9", error: simplifyError(error) };
  }
}

async function readBooleanDefault(domain: string, key: string): Promise<{ value: boolean; error: string }> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/defaults", ["read", domain, key], { timeout: 1000 });
    const text = stdout.trim().toLowerCase();
    return { value: ["1", "true", "yes"].includes(text), error: "" };
  } catch (error) {
    const message = simplifyError(error);
    if (/does not exist|domain .* does not exist|not exist/i.test(message)) return { value: false, error: "" };
    return { value: false, error: message };
  }
}

async function refreshAccessibilityPreferences(): Promise<void> {
  await Promise.all([
    killProcessIfRunning("cfprefsd"),
    killProcessIfRunning("SystemUIServer"),
    killProcessIfRunning("universalaccessd")
  ]);
}

async function killProcessIfRunning(name: string): Promise<void> {
  try {
    await execFileAsync("/usr/bin/killall", [name], { timeout: 1000 });
  } catch {
    // These daemons may not be running; macOS restarts them as needed.
  }
}

export async function openUrl(url: unknown) {
  try {
    await execFileAsync("/usr/bin/open", [String(url || "")], { timeout: 1500 });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: simplifyError(error) };
  }
}

export async function openApp(appName: unknown) {
  const app = String(appName || "").trim();
  if (!app) return { ok: false, error: "Missing app name" };
  try {
    await execFileAsync("/usr/bin/open", ["-a", app], { timeout: 1500 });
    return { ok: true, method: "open -a" };
  } catch (error) {
    return { ok: false, method: "open -a", error: simplifyError(error) };
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
    return { ok: true, ssid: match?.[1]?.trim() || "" };
  } catch (error) {
    return { ok: false, ssid: "", error: simplifyError(error) };
  }
}

export function appCanReportUrls(appName: string): boolean {
  return BROWSERS.has(appName);
}

export function urlHostname(url: unknown): string {
  try {
    if (!url) return "";
    const parsed = new URL(String(url));
    return parsed.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function escapeAppleScript(value: unknown): string {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function processDisplayName(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const appBundle = raw.match(/([^/]+)\.app\/Contents\/MacOS\//i);
  if (!appBundle) return "";
  const matchedName = appBundle[1];
  if (!matchedName) return "";
  const name = basename(`${matchedName}.app`).replace(/\.app$/i, "");
  return name || "";
}

async function wifiDevice(): Promise<string> {
  wifiDevicePromise ||= findWifiDevice();
  return wifiDevicePromise;
}

async function findWifiDevice(): Promise<string> {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/networksetup", ["-listallhardwareports"], {
      timeout: 2500,
      maxBuffer: 1024 * 32
    });
    const blocks = stdout.split(/\n\n+/);
    for (const block of blocks) {
      if (!/Hardware Port: (Wi-Fi|AirPort)/i.test(block)) continue;
      const match = block.match(/Device: (.+)/);
      if (match?.[1]) return match[1].trim();
    }
  } catch {
  }
  return "en0";
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as UnknownRecord : {};
  return String(record.stderr || record.message || error || "").trim().split("\n").at(-1) || "";
}
