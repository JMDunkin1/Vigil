import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { activeAppLockPolicy } from "./appLocks.js";
import { iosMdmSummary } from "./iosMdm.js";
import { iosProfileSummary } from "./iosProfiles.js";
import { activeLimitBlocks } from "./limits.js";
import { activePolicy } from "./policy.js";

const execFileAsync = promisify(execFile);
const CACHE_MS = 10000;
const APPLY_COOLDOWN_MS = 30000;
let adbPathCache = null;
let deviceCache = { at: 0, value: null };

export async function deviceSummary(state) {
  const adbPath = await findAdb();
  const android = {
    enabled: Boolean(state.deviceControls?.android?.enabled),
    adbInstalled: Boolean(adbPath),
    adbPath,
    packages: state.deviceControls?.android?.packages || [],
    devices: [],
    lastAppliedAt: state.deviceControls?.android?.lastAppliedAt || null,
    lastAction: state.deviceControls?.android?.lastAction || null,
    lastResult: state.deviceControls?.android?.lastResult || null,
    shouldBlockNow: shouldApplyAndroidBlock(state)
  };

  if (adbPath) {
    android.devices = await cachedAndroidDevices(adbPath);
  }

  return {
    android,
    ios: {
      ...iosProfileSummary(state),
      mdm: iosMdmSummary(state)
    }
  };
}

export async function maybeApplyAndroidPolicy(state) {
  const android = state.deviceControls?.android;
  if (!android?.enabled) return null;
  const now = Date.now();
  const last = android.lastAppliedAt ? new Date(android.lastAppliedAt).getTime() : 0;
  const action = shouldApplyAndroidBlock(state) ? "block" : "unblock";
  if (android.lastAction === action && now - last < APPLY_COOLDOWN_MS) return android.lastResult || null;
  return applyAndroidAction(state, action);
}

export async function applyAndroidAction(state, action) {
  const adbPath = await findAdb();
  if (!adbPath) {
    const result = { ok: false, error: "adb is not installed", devices: [] };
    rememberAndroidResult(state, action, result);
    return result;
  }

  const devices = await listAndroidDevices(adbPath);
  const packages = normalizePackages(state.deviceControls?.android?.packages);
  const result = {
    ok: true,
    action,
    devices: [],
    packages
  };

  for (const device of devices.filter((item) => item.state === "device")) {
    const deviceResult = { serial: device.serial, ok: true, commands: [] };
    for (const packageName of packages) {
      const command = action === "block"
        ? await blockAndroidPackage(adbPath, device.serial, packageName)
        : await unblockAndroidPackage(adbPath, device.serial, packageName);
      deviceResult.commands.push({ packageName, ...command });
      if (!command.ok) deviceResult.ok = false;
    }
    result.devices.push(deviceResult);
    if (!deviceResult.ok) result.ok = false;
  }

  if (!result.devices.length) {
    result.ok = false;
    result.error = "No authorized Android devices connected";
  }

  rememberAndroidResult(state, action, result);
  return result;
}

export async function listAndroidPackages(serial) {
  const adbPath = await findAdb();
  if (!adbPath) return { ok: false, error: "adb is not installed", packages: [] };
  try {
    const { stdout } = await execFileAsync(adbPath, ["-s", serial, "shell", "pm", "list", "packages", "-3"], {
      timeout: 8000,
      maxBuffer: 1024 * 1024
    });
    return { ok: true, packages: parseAndroidPackages(stdout) };
  } catch (error) {
    return { ok: false, error: simplifyError(error), packages: [] };
  }
}

export function normalizeAndroidSettings(body, existing) {
  return {
    ...existing,
    enabled: Boolean(body.enabled),
    packages: normalizePackages(body.packages)
  };
}

export function shouldApplyAndroidBlock(state, now = new Date()) {
  if (activePolicy(state, now)) return true;
  if (activeLimitBlocks(state, now).length) return true;
  return (state.appLocks || []).some((lock) => {
    if (!lock.enabled) return false;
    const days = new Set(lock.days || []);
    if (days.size && !days.has(now.getDay())) return false;
    return lock.lockLevel === "deep";
  });
}

export function parseAdbDevices(output) {
  return String(output || "")
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [serial, state, ...details] = line.split(/\s+/);
      return { serial, state, details: details.join(" ") };
    });
}

export function parseAndroidPackages(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^package:/, ""))
    .filter(Boolean)
    .sort();
}

async function cachedAndroidDevices(adbPath) {
  if (deviceCache.value && Date.now() - deviceCache.at < CACHE_MS) return deviceCache.value;
  const devices = await listAndroidDevices(adbPath);
  deviceCache = { at: Date.now(), value: devices };
  return devices;
}

async function listAndroidDevices(adbPath) {
  try {
    const { stdout } = await execFileAsync(adbPath, ["devices", "-l"], { timeout: 5000 });
    return parseAdbDevices(stdout);
  } catch {
    return [];
  }
}

async function blockAndroidPackage(adbPath, serial, packageName) {
  const commands = [];
  const suspend = await runAdb(adbPath, ["-s", serial, "shell", "cmd", "package", "suspend", "--user", "0", packageName]);
  commands.push({ name: "suspend", ...suspend });
  const stop = await runAdb(adbPath, ["-s", serial, "shell", "am", "force-stop", packageName]);
  commands.push({ name: "force-stop", ...stop });
  return {
    ok: commands.some((command) => command.ok),
    commands
  };
}

async function unblockAndroidPackage(adbPath, serial, packageName) {
  const unsuspend = await runAdb(adbPath, ["-s", serial, "shell", "cmd", "package", "unsuspend", "--user", "0", packageName]);
  return {
    ok: unsuspend.ok,
    commands: [{ name: "unsuspend", ...unsuspend }]
  };
}

async function runAdb(adbPath, args) {
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, { timeout: 8000, maxBuffer: 1024 * 256 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return { ok: false, error: simplifyError(error) };
  }
}

async function findAdb() {
  if (adbPathCache !== null) return adbPathCache;
  const candidates = [
    process.env.ADB,
    "/opt/homebrew/bin/adb",
    "/usr/local/bin/adb",
    `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["version"], { timeout: 1500 });
      adbPathCache = candidate;
      return adbPathCache;
    } catch {
      // Try the next candidate.
    }
  }

  try {
    const { stdout } = await execFileAsync("/usr/bin/which", ["adb"], { timeout: 1500 });
    const path = stdout.trim();
    if (path) {
      adbPathCache = path;
      return adbPathCache;
    }
  } catch {
    // Not installed.
  }

  adbPathCache = "";
  return adbPathCache;
}

function rememberAndroidResult(state, action, result) {
  state.deviceControls ||= {};
  state.deviceControls.android ||= {};
  state.deviceControls.android.lastAppliedAt = new Date().toISOString();
  state.deviceControls.android.lastAction = action;
  state.deviceControls.android.lastResult = result;
}

function normalizePackages(values) {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  return [...new Set(source.map((item) => String(item).trim()).filter(Boolean))].sort();
}

function simplifyError(error) {
  return String(error?.stderr || error?.message || error || "").trim().split("\n").at(-1);
}
