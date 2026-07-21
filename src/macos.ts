import { execFile, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BROWSERS } from "./defaults.js";
import type { UnknownRecord } from "./types.js";

const execFileAsync = promisify(execFile);
const RUNTIME_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const HUMAN_IDLE_HELPER = runtimeExecutablePath("bin/vigil-human-idle");
let wifiDevicePromise: Promise<string> | null = null;
let verifiedHumanIdleHelperDigest = "";
let humanActivityProcess: ChildProcessWithoutNullStreams | null = null;
let humanActivityProcessStarting: Promise<ChildProcessWithoutNullStreams> | null = null;
let humanActivityRestartTimer: ReturnType<typeof setTimeout> | null = null;
let humanActivityStabilityTimer: ReturnType<typeof setTimeout> | null = null;
let humanActivityRestartAttempt = 0;
let humanActivityOutput = "";
let humanActivityPending: {
  resolve: (sample: HumanActivitySample) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
let humanActivityQueryTail: Promise<void> = Promise.resolve();
let recentHumanActivity: { capturedAt: number; sample: HumanActivitySample } | null = null;
const browserActivityListeners = new Set<(signal: BrowserActivitySignal) => void>();
const HUMAN_ACTIVITY_CACHE_MS = 2500;
const HUMAN_ACTIVITY_STABILITY_MS = 5_000;
export const HUMAN_ACTIVITY_RESTART_DELAYS_MS = Object.freeze([25, 100, 250, 500, 1_000, 3_000]);
const CHROMIUM_BROWSERS = new Set([
  "Google Chrome",
  "Google Chrome Beta",
  "Google Chrome Dev",
  "Google Chrome Canary",
  "Microsoft Edge",
  "Microsoft Edge Beta",
  "Microsoft Edge Dev",
  "Microsoft Edge Canary",
  "Brave Browser",
  "Brave Browser Beta",
  "Brave Browser Nightly",
  "Arc",
  "Vivaldi",
  "Vivaldi Snapshot",
  "Opera",
  "Opera Beta",
  "Opera Developer",
  "Orion"
]);

interface HumanActivitySample {
  idleSeconds: number;
  app: string;
  bundleId: string;
}

export type BrowserActivityKind = "key" | "click";

export interface BrowserActivitySignal {
  kind: BrowserActivityKind;
  at: number;
}

export interface BrowserRedirectResult {
  [key: string]: unknown;
  ok: boolean;
  matched?: boolean;
  redirectedTabCount?: number;
  method?: string;
  error?: string;
}

export function subscribeBrowserActivity(listener: (signal: BrowserActivitySignal) => void): () => void {
  const wasEmpty = browserActivityListeners.size === 0;
  // A unique registration preserves normal subscription semantics even when a
  // caller intentionally subscribes the same callback more than once.
  const registration = (signal: BrowserActivitySignal) => listener(signal);
  browserActivityListeners.add(registration);
  if (wasEmpty) {
    requestBrowserActivityWatch(true);
    // Warm the helper immediately. The first scheduled tick can spend time in
    // integrity and hardening checks before it would otherwise make the helper's
    // first idle/frontmost query, leaving startup activity unwatched.
    requestHumanActivityProcessWarm();
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    browserActivityListeners.delete(registration);
    if (browserActivityListeners.size === 0) {
      cancelHumanActivityRestart();
      requestBrowserActivityWatch(false);
    }
  };
}

export function humanActivityHelperArguments(watchBrowserActivity: boolean): string[] {
  return watchBrowserActivity ? ["--watch-browser-activity"] : [];
}

function requestBrowserActivityWatch(enabled: boolean): void {
  const child = humanActivityProcess;
  if (!child) return;
  writeHumanActivityRequest(child, enabled ? "watch\n" : "unwatch\n");
}

function writeHumanActivityRequest(child: ChildProcessWithoutNullStreams, request: string): void {
  if (child.stdin.destroyed || !child.stdin.writable) {
    failHumanActivityProcess(child, new Error("Human activity helper input is unavailable."), true);
    return;
  }
  try {
    child.stdin.write(request, (error) => {
      if (error) failHumanActivityProcess(child, error, true);
    });
  } catch (error) {
    failHumanActivityProcess(
      child,
      error instanceof Error ? error : new Error(String(error || "Human activity helper input failed.")),
      true
    );
  }
}

function requestHumanActivityProcessWarm(): void {
  if (!browserActivityListeners.size || humanActivityProcess) return;
  void ensureHumanActivityProcess().catch(() => scheduleHumanActivityRestart());
}

function scheduleHumanActivityRestart(): void {
  if (!browserActivityListeners.size || humanActivityProcess || humanActivityRestartTimer) return;
  const index = Math.min(humanActivityRestartAttempt, HUMAN_ACTIVITY_RESTART_DELAYS_MS.length - 1);
  const delayMs = HUMAN_ACTIVITY_RESTART_DELAYS_MS[index]!;
  humanActivityRestartAttempt += 1;
  humanActivityRestartTimer = setTimeout(() => {
    humanActivityRestartTimer = null;
    requestHumanActivityProcessWarm();
  }, delayMs);
  humanActivityRestartTimer.unref?.();
}

function cancelHumanActivityRestart(): void {
  if (humanActivityRestartTimer) clearTimeout(humanActivityRestartTimer);
  humanActivityRestartTimer = null;
  humanActivityRestartAttempt = 0;
}

function resetHumanActivityRestart(): void {
  cancelHumanActivityRestart();
  if (humanActivityStabilityTimer) clearTimeout(humanActivityStabilityTimer);
  humanActivityStabilityTimer = null;
}

function armHumanActivityStabilityReset(child: ChildProcessWithoutNullStreams): void {
  if (humanActivityStabilityTimer) clearTimeout(humanActivityStabilityTimer);
  humanActivityStabilityTimer = setTimeout(() => {
    humanActivityStabilityTimer = null;
    if (humanActivityProcess === child) resetHumanActivityRestart();
  }, HUMAN_ACTIVITY_STABILITY_MS);
  humanActivityStabilityTimer.unref?.();
}

export async function runAppleScript(script: string, timeout = 2500): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    timeout,
    maxBuffer: 1024 * 64
  });
  return stdout.trim();
}

export async function getFrontmostApp(options: { fresh?: boolean } = {}) {
  const cached = recentHumanActivity;
  if (!options.fresh && cached && Date.now() - cached.capturedAt <= HUMAN_ACTIVITY_CACHE_MS) {
    return { ok: true, app: cached.sample.app };
  }
  try {
    const sample = await queryHumanActivity();
    return { ok: true, app: sample.app };
  } catch {
    return await getFrontmostAppViaAppleScript();
  }
}

async function getFrontmostAppViaAppleScript() {
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
    if (isSafariBrowser(appName)) {
      const url = await runAppleScript(safariCurrentTabUrlScript(app));
      return { ok: true, url };
    }

    if (isChromiumBrowser(appName)) {
      const url = await runAppleScript(`tell application "${app}" to if (count of windows) > 0 then get URL of active tab of front window`);
      return { ok: true, url };
    }

    return { ok: true, url: "" };
  } catch (error) {
    return { ok: false, url: "", error: simplifyError(error) };
  }
}

export async function redirectActiveBrowserTab(
  appName: string,
  url: string,
  options: { currentUrl?: string } = {}
): Promise<BrowserRedirectResult> {
  if (!BROWSERS.has(appName)) return { ok: false, matched: false, redirectedTabCount: 0, error: "Not a supported browser" };

  try {
    if (isSafariBrowser(appName)) {
      return await redirectSafariTab(appName, url, options);
    }

    if (isChromiumBrowser(appName)) {
      const output = await runAppleScript(chromiumRedirectScript(appName, url, options));
      const redirectedTabCount = parseBrowserRedirectCount(output);
      if (redirectedTabCount === null) throw new Error("Chromium returned an invalid redirect count");
      return { ok: true, matched: redirectedTabCount > 0, redirectedTabCount };
    }

    return { ok: false, matched: false, redirectedTabCount: 0, error: "Browser does not expose tab redirects" };
  } catch (error) {
    return { ok: false, matched: false, redirectedTabCount: 0, error: simplifyError(error) };
  }
}

async function redirectSafariTab(appName: string, url: string, options: { currentUrl?: string } = {}) {
  const method = await runAppleScript(safariRedirectScript(url, options, appName), 5000);
  const redirectedTabCount = parseBrowserRedirectCount(method);
  if (redirectedTabCount === null) throw new Error("Safari returned an invalid redirect count");
  return {
    ok: true,
    matched: redirectedTabCount > 0,
    redirectedTabCount,
    method: method || "safari-redirect"
  };
}

export function parseBrowserRedirectCount(output: unknown): number | null {
  const value = String(output || "").trim();
  const count = value.slice(value.lastIndexOf(":") + 1);
  if (!/^\d+$/u.test(count)) return null;
  const parsed = Number(count);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function isSafariBrowser(appName: string): boolean {
  return appName === "Safari" || appName === "Safari Technology Preview";
}

export function isChromiumBrowser(appName: string): boolean {
  return CHROMIUM_BROWSERS.has(appName);
}

export function chromiumRedirectScript(appName: string, url: string, options: { currentUrl?: string } = {}): string {
  const app = escapeAppleScript(appName);
  const target = escapeAppleScript(url);
  const current = escapeAppleScript(options.currentUrl || "");
  const atomicRedirect = escapeAppleScript(chromiumInterruptionScript(url, options));
  return [
    `set targetUrl to "${target}"`,
    `set previousUrl to "${current}"`,
    "set redirectMethod to \"missing-precondition\"",
    "set redirectedTabCount to 0",
    "set hasObservedTab to false",
    "set nativeFallbackAllowed to false",
    "set observedWindowId to \"\"",
    "set observedTabId to \"\"",
    "set observedTabIndex to 0",
    "considering case",
    `tell application "${app}"`,
    "  if previousUrl is not \"\" and previousUrl is not targetUrl then",
    "    if (count of windows) = 0 then",
    "      set redirectMethod to \"no-window\"",
    "    else",
    "      try",
    "        set observedWindow to front window",
    "        set observedActiveTab to active tab of observedWindow",
    "        set observedWindowId to id of observedWindow",
    "        set observedTabId to id of observedActiveTab",
    "        set observedTabIndex to active tab index of observedWindow",
    "        if (URL of observedActiveTab) is previousUrl then",
    "          set hasObservedTab to true",
    "          try",
    `            set javascriptResult to execute observedActiveTab javascript "${atomicRedirect}"`,
    "          on error",
    "            set javascriptResult to \"javascript-error\"",
    "          end try",
    "          if javascriptResult is \"redirected\" then",
    "            set redirectMethod to \"javascript-replace-unconfirmed\"",
          "          else if javascriptResult is \"url-mismatch\" then",
          "            set redirectMethod to \"url-mismatch\"",
          "          else",
          "            set redirectMethod to \"javascript-unconfirmed\"",
          "            set nativeFallbackAllowed to true",
    "          end if",
    "        else",
    "          set redirectMethod to \"url-mismatch\"",
    "        end if",
    "      on error",
    "        set redirectMethod to \"capture-error\"",
    "      end try",
    "    end if",
    "  end if",
    "end tell",
    chromiumNativeFallbackAppleScript(app),
    chromiumConfirmationAppleScript(app, "targetUrl", [
      "if targetStillCurrent and hasObservedTab then",
      "  if redirectMethod is \"javascript-replace-unconfirmed\" then",
      "    set redirectMethod to \"javascript-replace\"",
      "    set redirectedTabCount to 1",
      "  else if redirectMethod is \"native-set-url-unconfirmed\" then",
      "    set redirectMethod to \"native-set-url\"",
      "    set redirectedTabCount to 1",
      "  end if",
      "end if"
    ]),
    "end considering",
    "return redirectMethod & \":\" & (redirectedTabCount as text)"
  ].join("\n");
}

function chromiumNativeFallbackAppleScript(app: string): string {
  return [
    "set targetStillCurrent to false",
    "tell application \"System Events\"",
    "  try",
    `    set targetStillCurrent to frontmost of process "${app}"`,
    "  on error",
    "    set targetStillCurrent to false",
    "  end try",
    "end tell",
    "if targetStillCurrent and nativeFallbackAllowed and hasObservedTab then",
    `  tell application "${app}"`,
    "    try",
    "      if (count of windows) = 0 then error \"No browser windows\"",
    "      set currentWindow to front window",
    "      set currentTab to active tab of currentWindow",
    "      set targetStillCurrent to ((id of currentWindow) as text) is (observedWindowId as text)",
    "      if targetStillCurrent then set targetStillCurrent to ((id of currentTab) as text) is (observedTabId as text)",
    "      if targetStillCurrent then set targetStillCurrent to ((active tab index of currentWindow) as integer) is observedTabIndex",
    "      if targetStillCurrent then set targetStillCurrent to ((URL of currentTab) is previousUrl)",
    "      if targetStillCurrent then",
    "        set URL of observedActiveTab to targetUrl",
    "        set redirectMethod to \"native-set-url-unconfirmed\"",
    "      end if",
    "    on error",
    "      set redirectMethod to \"native-set-url-error\"",
    "    end try",
    "  end tell",
    "end if"
  ].join("\n");
}

function chromiumConfirmationAppleScript(app: string, expectedUrlVariable: string, continuation: string[]): string {
  return [
    "set targetStillCurrent to false",
    "tell application \"System Events\"",
    "  try",
    `    set targetStillCurrent to frontmost of process "${app}"`,
    "  on error",
    "    set targetStillCurrent to false",
    "  end try",
    "end tell",
    "if targetStillCurrent and hasObservedTab then",
    `  tell application "${app}"`,
    "    try",
    "      if (count of windows) = 0 then error \"No browser windows\"",
    "      set currentWindow to front window",
    "      set currentTab to active tab of currentWindow",
    "      set targetStillCurrent to ((id of currentWindow) as text) is (observedWindowId as text)",
    "      if targetStillCurrent then set targetStillCurrent to ((id of currentTab) as text) is (observedTabId as text)",
    "      if targetStillCurrent then set targetStillCurrent to ((active tab index of currentWindow) as integer) is observedTabIndex",
    `      if targetStillCurrent then set targetStillCurrent to ((URL of currentTab) is ${expectedUrlVariable})`,
    "    on error",
    "      set targetStillCurrent to false",
    "    end try",
    "  end tell",
    "end if",
    ...continuation
  ].join("\n");
}

export function chromiumInterruptionScript(url: string, options: { currentUrl?: string } = {}): string {
  const target = JSON.stringify(url);
  const current = JSON.stringify(options.currentUrl || "");
  return [
    "(() => {",
    `  const expectedUrl = ${current};`,
    `  const targetUrl = ${target};`,
    "  if (!expectedUrl || window.location.href !== expectedUrl) return 'url-mismatch';",
    "  try {",
    "    window.stop();",
    "    window.location.replace(targetUrl);",
    "    return 'redirected';",
    "  } catch (_) {",
    "    return 'redirect-error';",
    "  }",
    "})();"
  ].join("\n");
}

export function safariRedirectScript(url: string, options: { currentUrl?: string } = {}, appName = "Safari"): string {
  const target = escapeAppleScript(url);
  const current = escapeAppleScript(options.currentUrl || "");
  const app = escapeAppleScript(appName);
  return [
    `set targetUrl to "${target}"`,
    `set previousUrl to "${current}"`,
    "set mediaMode to \"unknown\"",
    "set redirectMethod to \"missing-precondition\"",
    "set redirectedTabCount to 0",
    "set hasBlockedTab to false",
    "set nativeFallbackAllowed to false",
    "set blockedWindowId to \"\"",
    "set blockedTabIndex to 0",
    "considering case",
    `tell application "${app}"`,
    "  if (count of windows) = 0 then error \"No Safari windows\"",
    "  set blockedWindow to front window",
    "  set candidateTab to current tab of blockedWindow",
    "  set candidateMatchesPreviousUrl to false",
    "  if previousUrl is not \"\" and previousUrl is not targetUrl then",
    "    try",
    "      set candidateMatchesPreviousUrl to ((URL of candidateTab) is previousUrl)",
    "    on error",
    "      set candidateMatchesPreviousUrl to false",
    "    end try",
    "  end if",
    "  if candidateMatchesPreviousUrl then",
    "    set blockedTab to candidateTab",
    "    set hasBlockedTab to true",
    "    set blockedWindowId to id of blockedWindow",
    "    set blockedTabIndex to index of blockedTab",
    "    try",
`      do JavaScript "${escapeAppleScript(safariInterruptionScript(url, options))}" in blockedTab`,
    "      set mediaMode to the result",
    "      if mediaMode is \"url-mismatch\" then",
    "        set redirectMethod to \"url-mismatch\"",
    "      else if mediaMode starts with \"redirected:\" then",
    "        set redirectMethod to \"javascript-replace-unconfirmed\"",
    "      else",
    "        set redirectMethod to \"javascript-unconfirmed\"",
    "        set nativeFallbackAllowed to true",
    "      end if",
    "    on error",
    "      set mediaMode to \"javascript-error\"",
    "      set redirectMethod to \"javascript-error\"",
    "      set nativeFallbackAllowed to true",
    "    end try",
    "  end if",
    "end tell",
    safariNativeFallbackAppleScript(app),
    safariTargetConfirmationAppleScript(app, "targetUrl", [
      "if targetStillCurrent and hasBlockedTab then",
      "  if redirectMethod is \"javascript-replace-unconfirmed\" then",
      "    set redirectMethod to \"javascript-replace\"",
      "    set redirectedTabCount to 1",
      "  else if redirectMethod is \"native-set-url-unconfirmed\" then",
      "    set redirectMethod to \"native-set-url\"",
      "    set redirectedTabCount to 1",
      "  end if",
      "end if"
    ]),
    "if redirectedTabCount > 0 and hasBlockedTab and (mediaMode contains \"media-fullscreen\" or mediaMode contains \"picture-in-picture\") then",
    "  set fullscreenEscapeCount to 0",
    safariFullscreenInterruptionAppleScript(appName),
    "  if fullscreenEscapeCount > 0 then",
    "    set redirectMethod to redirectMethod & \"+fullscreen-escape\"",
    "  else",
    "    set redirectMethod to redirectMethod & \"+fullscreen-skip-stale\"",
    "  end if",
    "end if",
    "end considering",
    "return redirectMethod & \":\" & mediaMode & \":\" & (redirectedTabCount as text)"
  ].join("\n");
}

function safariNativeFallbackAppleScript(app: string): string {
  return [
    "set targetStillCurrent to false",
    "tell application \"System Events\"",
    "  try",
    `    set targetStillCurrent to frontmost of process "${app}"`,
    "  on error",
    "    set targetStillCurrent to false",
    "  end try",
    "end tell",
    "if targetStillCurrent and nativeFallbackAllowed and hasBlockedTab then",
    `  tell application "${app}"`,
    "    try",
    "      if (count of windows) = 0 then error \"No Safari windows\"",
    "      set visibleWindow to front window",
    "      set visibleTab to current tab of visibleWindow",
    "      set targetStillCurrent to (visibleWindow is blockedWindow)",
    "      if targetStillCurrent then set targetStillCurrent to (visibleTab is blockedTab)",
    "      if targetStillCurrent then set targetStillCurrent to (((id of visibleWindow) as text) is (blockedWindowId as text))",
    "      if targetStillCurrent then set targetStillCurrent to ((index of visibleTab) as integer) is blockedTabIndex",
    "      if targetStillCurrent then set targetStillCurrent to ((URL of visibleTab) is previousUrl)",
    "      if targetStillCurrent then",
    "        set URL of blockedTab to targetUrl",
    "        set redirectMethod to \"native-set-url-unconfirmed\"",
    "      end if",
    "    on error",
    "      set redirectMethod to \"native-set-url-error\"",
    "    end try",
    "  end tell",
    "end if"
  ].join("\n");
}

function safariTargetConfirmationAppleScript(app: string, expectedUrlVariable: string, continuation: string[]): string {
  return [
    "set targetStillCurrent to false",
    "tell application \"System Events\"",
    "  try",
    `    set targetStillCurrent to frontmost of process "${app}"`,
    "  on error",
    "    set targetStillCurrent to false",
    "  end try",
    "end tell",
    "if targetStillCurrent and hasBlockedTab then",
    `  tell application "${app}"`,
    "    try",
    "      if (count of windows) = 0 then error \"No Safari windows\"",
    "      set visibleWindow to front window",
    "      set visibleTab to current tab of visibleWindow",
    "      set targetStillCurrent to (visibleWindow is blockedWindow)",
    "      if targetStillCurrent then set targetStillCurrent to (visibleTab is blockedTab)",
    "      if targetStillCurrent then set targetStillCurrent to (((id of visibleWindow) as text) is (blockedWindowId as text))",
    "      if targetStillCurrent then set targetStillCurrent to ((index of visibleTab) as integer) is blockedTabIndex",
    `      if targetStillCurrent then set targetStillCurrent to ((URL of visibleTab) is ${expectedUrlVariable})`,
    "    on error",
    "      set targetStillCurrent to false",
    "    end try",
    "  end tell",
    "end if",
    ...continuation
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

function safariFullscreenInterruptionAppleScript(appName = "Safari"): string {
  const app = escapeAppleScript(appName);
  return [
    "  repeat 4 times",
    "    set targetStillCurrent to false",
    "    tell application \"System Events\"",
    "      try",
    `        set targetStillCurrent to frontmost of process "${app}"`,
    "      on error",
    "        set targetStillCurrent to false",
    "      end try",
    "    end tell",
    "    if targetStillCurrent then",
    `      tell application "${app}"`,
    "        try",
    "          set visibleWindow to front window",
    "          set visibleTab to current tab of visibleWindow",
    "          set targetStillCurrent to (visibleWindow is blockedWindow)",
    "          if targetStillCurrent then set targetStillCurrent to (visibleTab is blockedTab)",
    "          if targetStillCurrent then set targetStillCurrent to (((id of visibleWindow) as text) is (blockedWindowId as text))",
    "          if targetStillCurrent then set targetStillCurrent to ((index of visibleTab) as integer) is blockedTabIndex",
    "          if targetStillCurrent then",
    "            set visibleSafariUrl to URL of visibleTab",
    "            set targetStillCurrent to (visibleSafariUrl is previousUrl or visibleSafariUrl is targetUrl)",
    "          end if",
    "        on error",
    "          set targetStillCurrent to false",
    "        end try",
    "      end tell",
    "    end if",
    "    if not targetStillCurrent then exit repeat",
    "    set escapeSent to false",
    "    tell application \"System Events\"",
    "      try",
    `        if frontmost of process "${app}" then`,
    "          key code 53",
    "          set escapeSent to true",
    "        end if",
    "      end try",
    "    end tell",
    "    if not escapeSent then exit repeat",
    "    set fullscreenEscapeCount to fullscreenEscapeCount + 1",
    "    delay 0.12",
    "  end repeat"
  ].join("\n");
}

export function safariInterruptionScript(url: string, options: { currentUrl?: string } = {}): string {
  const target = JSON.stringify(url);
  const current = JSON.stringify(options.currentUrl || "");
  return [
    "(() => {",
    `  const expectedUrl = ${current};`,
    "try {",
    "  if (!expectedUrl || window.location.href !== expectedUrl) return 'url-mismatch';",
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
    "  return `redirected:${status.length ? status.join(',') : 'standard'}`;",
    "} catch (_) {",
    "  try {",
    "    if (!expectedUrl || window.location.href !== expectedUrl) return 'url-mismatch';",
    `    window.location.replace(${target});`,
    "    return 'redirected:fallback';",
    "  } catch (_) {",
    "    return 'redirect-error';",
    "  }",
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
    const sample = await queryHumanActivity();
    return { ok: true, idleSeconds: sample.idleSeconds, source: "CGEventSource:HIDSystemState", error: "" };
  } catch (humanIdleError) {
    return getFallbackMacIdleTime(humanIdleError);
  }
}

function queryHumanActivity(): Promise<HumanActivitySample> {
  const queued = humanActivityQueryTail.then(queryHumanActivityOnce);
  humanActivityQueryTail = queued.then(() => {}, () => {});
  return queued;
}

async function queryHumanActivityOnce(): Promise<HumanActivitySample> {
  const child = await ensureHumanActivityProcess();
  if (humanActivityProcess !== child) throw new Error("Human activity helper restarted before the query began.");
  return await new Promise<HumanActivitySample>((resolve, reject) => {
    const timer = setTimeout(() => {
      failHumanActivityProcess(child, new Error("Human activity helper timed out."), true);
    }, 2500);
    humanActivityPending = { resolve, reject, timer };
    writeHumanActivityRequest(child, "\n");
  });
}

async function ensureHumanActivityProcess(): Promise<ChildProcessWithoutNullStreams> {
  if (humanActivityProcess) return humanActivityProcess;
  if (humanActivityProcessStarting) return await humanActivityProcessStarting;
  const starting = (async () => {
    await verifyHumanIdleHelperIntegrity();
    if (humanActivityProcess) return humanActivityProcess;
    const child = spawn(HUMAN_IDLE_HELPER, humanActivityHelperArguments(browserActivityListeners.size > 0), {
      stdio: ["pipe", "pipe", "pipe"]
    });
    humanActivityProcess = child;
    humanActivityOutput = "";
    child.unref();
    // Writable-stream failures are emitted separately from ChildProcess
    // failures, even when the write callback receives the same EPIPE. Keep a
    // listener installed so a helper closing stdin cannot crash Vigil.
    child.stdin.on("error", (error) => failHumanActivityProcess(child, error, true));
    unrefChildPipe(child.stdin);
    unrefChildPipe(child.stdout);
    unrefChildPipe(child.stderr);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => consumeHumanActivityOutput(child, chunk));
    child.stderr.resume();
    child.once("error", (error) => failHumanActivityProcess(child, error));
    child.once("exit", (code, signal) => {
      failHumanActivityProcess(child, new Error(`Human activity helper exited: ${signal || code || "unknown"}`));
    });
    // A successful spawn (or one valid frame) is not yet proof of sustained
    // health: a broken helper can emit once and then exit immediately. Reset
    // crash backoff only after the stability window, preventing an otherwise
    // unbounded 25ms emit-once/crash respawn loop.
    armHumanActivityStabilityReset(child);
    // A last subscriber can disappear while code-signature verification is in
    // flight. Correct the helper mode after spawn instead of leaving an unused
    // 25ms activity watch running.
    if (browserActivityListeners.size === 0) requestBrowserActivityWatch(false);
    return child;
  })();
  humanActivityProcessStarting = starting;
  try {
    return await starting;
  } finally {
    if (humanActivityProcessStarting === starting) humanActivityProcessStarting = null;
  }
}

function unrefChildPipe(pipe: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  (pipe as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
}

function consumeHumanActivityOutput(child: ChildProcessWithoutNullStreams, chunk: string): void {
  if (humanActivityProcess !== child) return;
  const framed = splitHumanActivityOutput(humanActivityOutput, chunk);
  humanActivityOutput = framed.remainder;
  for (const line of framed.lines) {
    const wake = parseBrowserActivityWake(line);
    if (wake) {
      recentHumanActivity = null;
      notifyBrowserActivity(wake);
      continue;
    }

    const pending = humanActivityPending;
    if (!pending) continue;
    humanActivityPending = null;
    clearTimeout(pending.timer);
    const sample = parseHumanActivitySample(line);
    if (!sample) {
      pending.reject(new Error("Human activity helper returned an invalid value."));
      continue;
    }
    recentHumanActivity = { capturedAt: Date.now(), sample };
    pending.resolve(sample);
  }
}

function notifyBrowserActivity(kind: BrowserActivityKind): void {
  const signal = { kind, at: Date.now() };
  for (const listener of browserActivityListeners) {
    try {
      listener(signal);
    } catch {
      // Browser-activity acceleration is advisory. The scheduled monitor remains
      // the fail-closed enforcement backstop when a subscriber misbehaves.
    }
  }
}

function failHumanActivityProcess(child: ChildProcessWithoutNullStreams, error: Error, kill = false): void {
  if (humanActivityProcess !== child) return;
  humanActivityProcess = null;
  if (humanActivityStabilityTimer) clearTimeout(humanActivityStabilityTimer);
  humanActivityStabilityTimer = null;
  humanActivityOutput = "";
  recentHumanActivity = null;
  const pending = humanActivityPending;
  humanActivityPending = null;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  if (kill && !child.killed) child.kill();
  scheduleHumanActivityRestart();
}

async function verifyHumanIdleHelperIntegrity(): Promise<void> {
  const appBundle = packagedAppBundleForExecutable(HUMAN_IDLE_HELPER);
  if (!appBundle) return;
  const helperDigest = createHash("sha256").update(await readFile(HUMAN_IDLE_HELPER)).digest("hex");
  if (helperDigest === verifiedHumanIdleHelperDigest) return;
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appBundle], {
    timeout: 2500,
    maxBuffer: 1024 * 16
  });
  verifiedHumanIdleHelperDigest = helperDigest;
}

export function packagedAppBundleForExecutable(path: string): string | null {
  const marker = "/Contents/Resources/app.asar.unpacked/";
  const markerIndex = path.indexOf(marker);
  if (markerIndex < 0) return null;
  const bundle = path.slice(0, markerIndex);
  return bundle.endsWith(".app") ? bundle : null;
}

async function getFallbackMacIdleTime(humanIdleError: unknown) {
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
    return {
      ok: false,
      idleSeconds: 0,
      source: "ioreg:HIDIdleTime",
      error: `${simplifyError(humanIdleError)}; ${simplifyError(error)}`
    };
  }
}

export function parseHumanIdleSeconds(output: unknown): number | null {
  const seconds = Number(String(output || "").trim());
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

export function parseHumanActivitySample(output: unknown): HumanActivitySample | null {
  const [idleText = "", name = "", bundleId = ""] = String(output || "").replace(/[\r\n]+$/u, "").split("\t");
  const idleSeconds = parseHumanIdleSeconds(idleText);
  if (idleSeconds === null) return null;
  return {
    idleSeconds,
    app: canonicalFrontmostAppName(name, bundleId),
    bundleId
  };
}

export function parseBrowserActivityWake(output: unknown): BrowserActivityKind | null {
  const frame = String(output || "").replace(/[\r\n]+$/u, "");
  if (frame === "wake\tkey") return "key";
  if (frame === "wake\tclick") return "click";
  return null;
}

export function splitHumanActivityOutput(buffer: string, chunk: string): { lines: string[]; remainder: string } {
  const parts = `${buffer}${chunk}`.split("\n");
  return {
    lines: parts.slice(0, -1),
    remainder: parts.at(-1) || ""
  };
}

export function parseHidIdleSeconds(output: unknown): number | null {
  const match = String(output || "").match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match?.[1]) return null;
  const idleNanoseconds = Number(match[1]);
  return Number.isFinite(idleNanoseconds) && idleNanoseconds >= 0
    ? idleNanoseconds / 1_000_000_000
    : null;
}

function runtimeExecutablePath(relativePath: string): string {
  const path = join(RUNTIME_ROOT, relativePath);
  return path.includes("app.asar") ? path.replace("app.asar", "app.asar.unpacked") : path;
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
  if (id === "com.openai.codex") return "Codex";
  if (id === "com.apple.safari") return "Safari";
  if (id === "com.apple.safaritechnologypreview") return "Safari Technology Preview";
  if (/^Safari (Web Content|Networking|Graphics and Media|Safe Browsing)$/i.test(app)) return "Safari";
  if (/^Safari Technology Preview (Web Content|Networking|Graphics and Media|Safe Browsing)$/i.test(app)) {
    return "Safari Technology Preview";
  }
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
