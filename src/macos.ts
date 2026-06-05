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
    const frontmost = await runAppleScript([
      'tell application "System Events"',
      "  set frontProcess to first application process whose frontmost is true",
      "  set processName to name of frontProcess",
      "  set processBundleId to \"\"",
      "  try",
      "    set processBundleId to bundle identifier of frontProcess",
      "  end try",
      "  return processName & linefeed & processBundleId",
      "end tell"
    ].join("\n"));
    const [name = "", bundleId = ""] = frontmost.split(/\r?\n/);
    const app = canonicalFrontmostAppName(name, bundleId);
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
      const url = await runAppleScript(safariCurrentTabUrlScript(app));
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

export async function redirectActiveBrowserTab(appName: string, url: string, options: { currentUrl?: string } = {}) {
  if (!BROWSERS.has(appName)) return { ok: false, error: "Not a supported browser" };

  try {
    const app = escapeAppleScript(appName);
    const target = escapeAppleScript(url);
    if (appName === "Safari") {
      return await redirectSafariTab(url, options);
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

async function redirectSafariTab(url: string, options: { currentUrl?: string } = {}) {
  const method = await runAppleScript(safariRedirectScript(url, options), 5000);
  return { ok: true, method: method || "safari-redirect" };
}

export function safariRedirectScript(url: string, options: { currentUrl?: string } = {}): string {
  const target = escapeAppleScript(url);
  const current = escapeAppleScript(options.currentUrl || "");
  return [
    `set targetUrl to "${target}"`,
    `set previousUrl to "${current}"`,
    "set mediaMode to \"unknown\"",
    "set redirectMethod to \"pending\"",
    "set redirectedTabCount to 0",
    "tell application \"Safari\"",
    "  if (count of windows) = 0 then error \"No Safari windows\"",
    "  try",
`    do JavaScript "${escapeAppleScript(safariInterruptionScript(url))}" in current tab of front window`,
    "    set mediaMode to the result",
    "    set redirectMethod to \"javascript-replace\"",
    "  on error",
    "    set mediaMode to \"javascript-error\"",
    "    set redirectMethod to \"javascript-error\"",
    "  end try",
    "  delay 0.15",
    redirectCurrentSafariTabAppleScript(),
    redirectMatchingSafariTabsAppleScript(),
    "end tell",
    "if mediaMode contains \"media-fullscreen\" or mediaMode contains \"picture-in-picture\" then",
    safariFullscreenInterruptionAppleScript(),
    "  tell application \"Safari\"",
    redirectCurrentSafariTabAppleScript(),
    redirectMatchingSafariTabsAppleScript(),
    "  end tell",
    "end if",
    "return redirectMethod & \":\" & mediaMode & \":\" & (redirectedTabCount as text)"
  ].join("\n");
}

function redirectCurrentSafariTabAppleScript(): string {
  return [
    "  try",
    "    set currentUrl to URL of current tab of front window",
    "    if currentUrl is not targetUrl then",
    "      set URL of current tab of front window to targetUrl",
    "      set redirectedTabCount to redirectedTabCount + 1",
    "      set redirectMethod to redirectMethod & \"+verified-set-url\"",
    "    end if",
    "  on error",
    "    set URL of current tab of front window to targetUrl",
    "    set redirectedTabCount to redirectedTabCount + 1",
    "    set redirectMethod to redirectMethod & \"+fallback-set-url\"",
    "  end try"
  ].join("\n");
}

function redirectMatchingSafariTabsAppleScript(): string {
  return [
    "  if previousUrl is not \"\" and previousUrl is not targetUrl then",
    "    repeat with safariWindow in windows",
    "      repeat with safariTab in tabs of safariWindow",
    "        try",
    "          if URL of safariTab is previousUrl then",
    "            set URL of safariTab to targetUrl",
    "            set redirectedTabCount to redirectedTabCount + 1",
    "            set redirectMethod to redirectMethod & \"+matching-tab\"",
    "          end if",
    "        end try",
    "      end repeat",
    "    end repeat",
    "  end if"
  ].join("\n");
}

function safariCurrentTabUrlScript(app: string): string {
  return [
    `tell application "${app}"`,
    "  if (count of windows) = 0 then return \"\"",
    "  set candidateUrl to \"\"",
    "  try",
    "    set candidateUrl to URL of current tab of front window",
    "  end try",
    "  if candidateUrl is not missing value and candidateUrl is not \"\" then return candidateUrl",
    "  repeat with safariWindow in windows",
    "    try",
    "      set candidateUrl to URL of current tab of safariWindow",
    "      if candidateUrl is not missing value and candidateUrl is not \"\" then return candidateUrl",
    "    end try",
    "  end repeat",
    "  return \"\"",
    "end tell"
  ].join("\n");
}

function safariFullscreenInterruptionAppleScript(): string {
  return [
    "tell application \"System Events\"",
    "  try",
    "    set frontmost of process \"Safari\" to true",
    "  end try",
    "  repeat 4 times",
    "    key code 53",
    "    delay 0.12",
    "  end repeat",
    "end tell"
  ].join("\n");
}

export function safariInterruptionScript(url: string): string {
  const target = JSON.stringify(url);
  return [
    "(() => {",
    "try {",
    "  const doc = document;",
    "  const media = Array.from(document.querySelectorAll('video,audio'));",
    "  const status = [];",
    "  if (doc.fullscreenElement || doc.webkitFullscreenElement) status.push('media-fullscreen');",
    "  if (document.pictureInPictureElement) status.push('picture-in-picture');",
    "  if (media.some((item) => !item.paused && !item.ended)) status.push('active-media');",
    "  if ((doc.fullscreenElement || doc.webkitFullscreenElement) && doc.exitFullscreen) doc.exitFullscreen();",
    "  if (doc.webkitFullscreenElement && doc.webkitExitFullscreen) doc.webkitExitFullscreen();",
    "  if (document.pictureInPictureElement && document.exitPictureInPicture) document.exitPictureInPicture();",
    "  window.stop();",
    "  media.forEach((item) => {",
    "    try { item.pause(); item.srcObject = null; item.removeAttribute('src'); item.load(); } catch (_) {}",
    "  });",
    "  document.documentElement.innerHTML = '';",
    `  window.location.replace(${target});`,
    "  return status.length ? status.join(',') : 'standard';",
    "} catch (_) {",
    `  window.location.replace(${target});`,
    "  return 'fallback';",
    "}",
    "})();"
  ].join("\n");
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

export async function getMacIdleTime() {
  try {
    const { stdout } = await execFileAsync("/usr/sbin/ioreg", ["-c", "IOHIDSystem", "-r", "-d", "1"], {
      timeout: 750,
      maxBuffer: 1024 * 32
    });
    const idleSeconds = parseHidIdleSeconds(stdout);
    if (idleSeconds === null) {
      return { ok: false, idleSeconds: 0, source: "ioreg:HIDIdleTime", error: "HIDIdleTime not found" };
    }
    return { ok: true, idleSeconds, source: "ioreg:HIDIdleTime", error: "" };
  } catch (error) {
    return { ok: false, idleSeconds: 0, source: "ioreg:HIDIdleTime", error: simplifyError(error) };
  }
}

export function parseHidIdleSeconds(output: unknown): number | null {
  const match = String(output || "").match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match?.[1]) return null;
  const idleNanoseconds = Number(match[1]);
  return Number.isFinite(idleNanoseconds) && idleNanoseconds >= 0
    ? idleNanoseconds / 1_000_000_000
    : null;
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

export function canonicalFrontmostAppName(value: unknown, bundleId: unknown = ""): string {
  const app = String(value || "").trim();
  const id = String(bundleId || "").trim().toLowerCase();
  if (id === "com.apple.safari") return "Safari";
  if (/^Safari (Web Content|Networking|Graphics and Media|Safe Browsing)$/i.test(app)) return "Safari";
  return app;
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
