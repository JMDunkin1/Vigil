import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultState } from "./defaults.js";
import { applySealVerificationToState, markStateSealed, verifyStateTextSeal, writeStateTextSeal } from "./seal.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = join(ROOT, "data");
export const STATE_PATH = join(DATA_DIR, "state.json");
export const STATE_SEAL_PATH = join(DATA_DIR, "state.seal.json");
export const STATE_SEAL_KEY_PATH = join(DATA_DIR, "state-seal.key");
export const SOURCE_SEAL_PATH = join(DATA_DIR, "source.seal.json");
export const USAGE_PATH = join(DATA_DIR, "usage.json");

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, text);
  await rename(temp, path);
  return text;
}

export async function loadState() {
  await mkdir(DATA_DIR, { recursive: true });
  let raw = "";
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const fresh = defaultState();
    await saveState(fresh);
    return fresh;
  }

  let verification = await verifyStateTextSeal(raw, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
  if (verification.status === "mismatch") {
    await sleep(300);
    const retryRaw = await readFile(STATE_PATH, "utf8");
    const retryVerification = await verifyStateTextSeal(retryRaw, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH });
    if (retryVerification.ok) {
      raw = retryRaw;
      verification = retryVerification;
    }
  }
  const state = migrateState(JSON.parse(raw));
  applySealVerificationToState(state, verification);
  return state;
}

export async function saveState(state) {
  const sealedAt = new Date().toISOString();
  markStateSealed(state, sealedAt);
  const text = await writeJson(STATE_PATH, state);
  await writeStateTextSeal(text, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH, scope: "state" }, sealedAt);
}

export async function loadUsage() {
  await mkdir(DATA_DIR, { recursive: true });
  return readJson(USAGE_PATH, {});
}

export async function saveUsage(usage) {
  await writeJson(USAGE_PATH, usage);
}

export function addEvent(state, type, detail = {}) {
  state.events.unshift({
    id: crypto.randomUUID(),
    type,
    detail,
    at: new Date().toISOString()
  });
  state.events = state.events.slice(0, 250);
}

function migrateState(state) {
  const fresh = defaultState();
  const profiles = Array.isArray(state.profiles) && state.profiles.length ? state.profiles : fresh.profiles;
  const settings = migrateSettings({ ...fresh.settings, ...(state.settings || {}) });
  return {
    ...fresh,
    ...state,
    settings,
    profiles: normalizeProfiles(mergeBuiltinProfiles(profiles, fresh.profiles)),
    schedules: normalizeSchedules(Array.isArray(state.schedules) ? state.schedules : fresh.schedules),
    limitRules: Array.isArray(state.limitRules) ? state.limitRules : fresh.limitRules,
    limitBlocks: Array.isArray(state.limitBlocks) ? state.limitBlocks : [],
    appLocks: Array.isArray(state.appLocks) ? state.appLocks : fresh.appLocks,
    appLockUnlocks: Array.isArray(state.appLockUnlocks) ? state.appLockUnlocks : [],
    appLockRequests: Array.isArray(state.appLockRequests) ? state.appLockRequests : [],
    appLockLedger: state.appLockLedger || {},
    extension: {
      ...fresh.extension,
      ...(state.extension || {}),
      dynamicRules: {
        ...fresh.extension.dynamicRules,
        ...(state.extension?.dynamicRules || {})
      }
    },
    focusShortcut: {
      ...fresh.focusShortcut,
      ...(state.focusShortcut || {})
    },
    environment: {
      ...fresh.environment,
      ...(state.environment || {})
    },
    keyholder: {
      ...fresh.keyholder,
      ...(state.keyholder || {})
    },
    distanceKey: {
      ...fresh.distanceKey,
      ...(state.distanceKey || {})
    },
    integrity: {
      stateSeal: {
        ...fresh.integrity.stateSeal,
        ...(state.integrity?.stateSeal || {})
      },
      runtime: {
        ...fresh.integrity.runtime,
        ...(state.integrity?.runtime || {})
      }
    },
    deviceControls: {
      android: {
        ...fresh.deviceControls.android,
        ...(state.deviceControls?.android || {}),
        packages: Array.isArray(state.deviceControls?.android?.packages)
          ? state.deviceControls.android.packages
          : fresh.deviceControls.android.packages
      },
      ios: {
        ...fresh.deviceControls.ios,
        ...(state.deviceControls?.ios || {}),
        blockedAppBundleIds: Array.isArray(state.deviceControls?.ios?.blockedAppBundleIds)
          ? state.deviceControls.ios.blockedAppBundleIds
          : fresh.deviceControls.ios.blockedAppBundleIds,
        allowedAppBundleIds: Array.isArray(state.deviceControls?.ios?.allowedAppBundleIds)
          ? state.deviceControls.ios.allowedAppBundleIds
          : fresh.deviceControls.ios.allowedAppBundleIds,
        deniedUrls: Array.isArray(state.deviceControls?.ios?.deniedUrls)
          ? state.deviceControls.ios.deniedUrls
          : fresh.deviceControls.ios.deniedUrls,
        allowedUrls: Array.isArray(state.deviceControls?.ios?.allowedUrls)
          ? state.deviceControls.ios.allowedUrls
          : fresh.deviceControls.ios.allowedUrls,
        mdm: {
          ...fresh.deviceControls.ios.mdm,
          ...(state.deviceControls?.ios?.mdm || {}),
          devices: Array.isArray(state.deviceControls?.ios?.mdm?.devices)
            ? state.deviceControls.ios.mdm.devices
            : fresh.deviceControls.ios.mdm.devices,
          commands: Array.isArray(state.deviceControls?.ios?.mdm?.commands)
            ? state.deviceControls.ios.mdm.commands
            : fresh.deviceControls.ios.mdm.commands
        }
      }
    },
    maintenance: {
      pending: Array.isArray(state.maintenance?.pending) ? state.maintenance.pending : [],
      windows: Array.isArray(state.maintenance?.windows) ? state.maintenance.windows : []
    },
    emergency: {
      ...fresh.emergency,
      ...(state.emergency || {}),
      pending: Array.isArray(state.emergency?.pending) ? state.emergency.pending : []
    },
    overrides: Array.isArray(state.overrides) ? state.overrides : [],
    events: Array.isArray(state.events) ? state.events : []
  };
}

function migrateSettings(settings) {
  const next = { ...settings };
  const legacyName = ["Local", "Screen", "Time"].join(" ");
  if (next.focusShortcutOnName === `${legacyName} Focus On`) {
    next.focusShortcutOnName = "Vigil Focus On";
  }
  if (next.focusShortcutOffName === `${legacyName} Focus Off`) {
    next.focusShortcutOffName = "Vigil Focus Off";
  }
  return next;
}

function mergeBuiltinProfiles(profiles, builtinProfiles) {
  const existing = new Set(profiles.map((profile) => profile.id).filter(Boolean));
  const missing = builtinProfiles.filter((profile) => profile.id && !existing.has(profile.id));
  return [...profiles, ...missing.map(cloneProfile)];
}

function cloneProfile(profile) {
  return {
    ...profile,
    blockedApps: [...(profile.blockedApps || [])],
    blockedSites: [...(profile.blockedSites || [])],
    blockedUrlPatterns: [...(profile.blockedUrlPatterns || [])],
    allowedApps: [...(profile.allowedApps || [])],
    allowedSites: [...(profile.allowedSites || [])]
  };
}

function normalizeSchedules(schedules) {
  return schedules.map((schedule) => ({
    ...schedule,
    wifiNetworks: Array.isArray(schedule.wifiNetworks) ? schedule.wifiNetworks : [],
    commitmentLock: Boolean(schedule.commitmentLock)
  }));
}

function normalizeProfiles(profiles) {
  return profiles.map((profile) => ({
    ...profile,
    blockedApps: Array.isArray(profile.blockedApps) ? profile.blockedApps : [],
    blockedSites: Array.isArray(profile.blockedSites) ? profile.blockedSites : [],
    blockedUrlPatterns: Array.isArray(profile.blockedUrlPatterns) ? profile.blockedUrlPatterns : [],
    allowedApps: Array.isArray(profile.allowedApps) ? profile.allowedApps : [],
    allowedSites: Array.isArray(profile.allowedSites) ? profile.allowedSites : []
  }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
