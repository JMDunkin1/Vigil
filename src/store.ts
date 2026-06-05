import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SHORT_FORM_URL_PATTERNS, SOFT_BLOCK_PROFILE_ID, defaultState } from "./defaults.js";
import { normalizeIntentionalUse } from "./intentionalUse.js";
import { applySealVerificationToState, markStateSealed, verifyStateTextSeal, writeStateTextSeal } from "./seal.js";
import type { AppSettings, GrayscaleSchedule, GrayscaleState, Profile, Schedule, SentinelState, Session, UsageState } from "./types.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = process.env.SENTINEL_DATA_DIR || resolveDefaultDataDir(ROOT);
export const STATE_PATH = join(DATA_DIR, "state.json");
export const STATE_SEAL_PATH = join(DATA_DIR, "state.seal.json");
export const STATE_SEAL_KEY_PATH = join(DATA_DIR, "state-seal.key");
export const SOURCE_SEAL_PATH = join(DATA_DIR, "source.seal.json");
export const USAGE_PATH = join(DATA_DIR, "usage.json");

type RawState = Partial<SentinelState> & Record<string, unknown>;
let stateSaveQueue: Promise<void> = Promise.resolve();

export function resolveDefaultDataDir(runtimeRoot: string): string {
  const parent = dirname(runtimeRoot);
  const projectRoot = basename(runtimeRoot) === "runtime" && basename(parent) === "dist" && !runtimeRoot.includes(".asar")
    ? dirname(parent)
    : runtimeRoot;
  return join(projectRoot, "data");
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) return fallback;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(temp, text);
  await rename(temp, path);
  return text;
}

export async function loadState(): Promise<SentinelState> {
  await mkdir(DATA_DIR, { recursive: true });
  let raw: string;
  try {
    raw = await readFile(STATE_PATH, "utf8");
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
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
  const state = migrateState(JSON.parse(raw) as RawState);
  applySealVerificationToState(state, verification);
  return state;
}

export function saveState(state: SentinelState): Promise<void> {
  const sealedAt = new Date().toISOString();
  markStateSealed(state, sealedAt);
  const snapshot = jsonClone(state);
  const save = stateSaveQueue.then(
    () => writeStateAndSeal(snapshot, sealedAt),
    () => writeStateAndSeal(snapshot, sealedAt)
  );
  stateSaveQueue = save.catch(() => {});
  return save;
}

export async function loadUsage(): Promise<UsageState> {
  await mkdir(DATA_DIR, { recursive: true });
  return readJson<UsageState>(USAGE_PATH, {});
}

export async function saveUsage(usage: UsageState): Promise<void> {
  await writeJson(USAGE_PATH, usage);
}

export function addEvent(state: SentinelState, type: string, detail: object = {}): void {
  state.events.unshift({
    id: randomUUID(),
    type,
    detail: detail as Record<string, unknown>,
    at: new Date().toISOString()
  });
  state.events = state.events.slice(0, 250);
}

function migrateState(state: RawState): SentinelState {
  const fresh = defaultState();
  const rawProfiles = Array.isArray(state.profiles) && state.profiles.length ? state.profiles : fresh.profiles;
  const profiles = normalizeProfiles(migrateBuiltinProfiles(mergeBuiltinProfiles(rawProfiles, fresh.profiles)));
  const settings = migrateSettings({ ...fresh.settings, ...(state.settings || {}) });
  const activeSessions = migrateActiveSessions(state, fresh, profiles);
  return {
    ...fresh,
    ...state,
    settings,
    profiles,
    schedules: normalizeSchedules(Array.isArray(state.schedules) ? state.schedules : fresh.schedules),
    limitRules: Array.isArray(state.limitRules) ? state.limitRules : fresh.limitRules,
    limitBlocks: Array.isArray(state.limitBlocks) ? state.limitBlocks : [],
    appLocks: Array.isArray(state.appLocks) ? state.appLocks : fresh.appLocks,
    appLockUnlocks: Array.isArray(state.appLockUnlocks) ? state.appLockUnlocks : [],
    appLockRequests: Array.isArray(state.appLockRequests) ? state.appLockRequests : [],
    appLockLedger: state.appLockLedger || {},
    intentionalUse: normalizeIntentionalUse(state.intentionalUse || {}, fresh.intentionalUse || {}),
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
    grayscale: normalizeGrayscaleState(state.grayscale, fresh.grayscale),
    deviceControls: {
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
    activeSessions,
    activeSession: activeSessions.computer || null,
    panicLock: state.panicLock || null,
    emergency: {
      ...fresh.emergency,
      ...(state.emergency || {}),
      pending: Array.isArray(state.emergency?.pending) ? state.emergency.pending : []
    },
    overrides: Array.isArray(state.overrides) ? state.overrides : [],
    events: Array.isArray(state.events) ? state.events : []
  };
}

function migrateSettings(settings: AppSettings): AppSettings {
  const next = { ...settings };
  const legacyName = ["Local", "Screen", "Time"].join(" ");
  if (next.focusShortcutOnName === `${legacyName} Focus On`) {
    next.focusShortcutOnName = "Sentinel Focus On";
  }
  if (next.focusShortcutOffName === `${legacyName} Focus Off`) {
    next.focusShortcutOffName = "Sentinel Focus Off";
  }
  if (next.externalNetworkBlockProvider !== "manual") {
    next.externalNetworkBlockProvider = "manual";
  }
  next.contentFilterEnabled = true;
  next.safariUrlFilterEnabled = true;
  return next;
}

function mergeBuiltinProfiles(profiles: Profile[], builtinProfiles: Profile[]): Profile[] {
  const existing = new Set(profiles.map((profile) => profile.id).filter(Boolean));
  const missing = builtinProfiles.filter((profile) => profile.id && !existing.has(profile.id));
  return [...profiles, ...missing.map(cloneProfile)];
}

function migrateBuiltinProfiles(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => {
    if (profile.id !== SOFT_BLOCK_PROFILE_ID) return profile;
    return sanitizeSoftBlockProfile(profile);
  });
}

export function sanitizeSoftBlockProfile(profile: Profile): Profile {
  const blockedUrlPatterns = uniqueList([
    ...(profile.blockedUrlPatterns || []).filter((pattern) => !isInstagramExplorePattern(pattern)),
    ...DEFAULT_SHORT_FORM_URL_PATTERNS.filter(isInstagramReelsPattern)
  ]);
  return {
    ...profile,
    description: profile.description || "Blocks the normal explicit baseline plus short-form feeds while leaving regular sites usable.",
    blockedApps: (profile.blockedApps || []).filter((app) => !isInstagramAppTarget(app)),
    blockedSites: (profile.blockedSites || []).filter((site) => !isInstagramSiteTarget(site)),
    blockedUrlPatterns,
    phoneAppBlocking: false,
    hostsUrlPatternBlocking: false
  };
}

function cloneProfile(profile: Profile): Profile {
  return {
    ...profile,
    blockedApps: [...(profile.blockedApps || [])],
    blockedSites: [...(profile.blockedSites || [])],
    blockedUrlPatterns: [...(profile.blockedUrlPatterns || [])],
    allowedApps: [...(profile.allowedApps || [])],
    allowedSites: [...(profile.allowedSites || [])],
    phoneAppBlocking: profile.phoneAppBlocking === false ? false : undefined,
    hostsUrlPatternBlocking: profile.hostsUrlPatternBlocking === false ? false : undefined
  };
}

function uniqueList(values: unknown[] = []): string[] {
  return [...new Set((values || []).map((item) => String(item).trim()).filter(Boolean))];
}

async function writeStateAndSeal(state: SentinelState, sealedAt: string): Promise<void> {
  const text = await writeJson(STATE_PATH, state);
  await writeStateTextSeal(text, { keyPath: STATE_SEAL_KEY_PATH, sealPath: STATE_SEAL_PATH, scope: "state" }, sealedAt);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isInstagramAppTarget(value: unknown): boolean {
  const app = String(value || "")
    .trim()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return ["instagram", "instagram helper", "com.burbn.instagram"].includes(app);
}

function isInstagramSiteTarget(value: unknown): boolean {
  return ["instagram.com", "cdninstagram.com"].includes(normalizeHostTarget(value));
}

function isInstagramExplorePattern(value: unknown): boolean {
  const pattern = normalizePatternTarget(value);
  return pattern === "instagram.com/explore" || pattern.startsWith("instagram.com/explore/");
}

function isInstagramReelsPattern(value: unknown): boolean {
  const pattern = normalizePatternTarget(value);
  return pattern === "instagram.com/reel"
    || pattern === "instagram.com/reels"
    || pattern.startsWith("instagram.com/reel/")
    || pattern.startsWith("instagram.com/reels/");
}

function normalizeHostTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
}

function normalizePatternTarget(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\s+/g, "")
    .replace(/^\/+$/, "");
}

function normalizeSchedules(schedules: Schedule[]): Schedule[] {
  return schedules.map((schedule) => ({
    ...schedule,
    wifiNetworks: Array.isArray(schedule.wifiNetworks) ? schedule.wifiNetworks : [],
    commitmentLock: Boolean(schedule.commitmentLock)
  }));
}

function normalizeGrayscaleState(value: unknown, fallback: GrayscaleState): GrayscaleState {
  const raw = value && typeof value === "object" ? value as Partial<GrayscaleState> : {};
  return {
    softBlockEnabled: Boolean(raw.softBlockEnabled),
    preventManualChanges: raw.preventManualChanges === false ? false : fallback.preventManualChanges,
    schedules: Array.isArray(raw.schedules)
      ? raw.schedules.map(normalizeGrayscaleSchedule).filter((schedule) => schedule.name)
      : []
  };
}

function normalizeGrayscaleSchedule(schedule: Partial<GrayscaleSchedule>): GrayscaleSchedule {
  return {
    id: String(schedule.id || randomUUID()),
    name: String(schedule.name || "Grayscale schedule").slice(0, 80),
    enabled: Boolean(schedule.enabled),
    days: normalizeDays(schedule.days),
    start: normalizeClock(schedule.start, "22:00"),
    end: normalizeClock(schedule.end, "07:00"),
    deviceTargets: normalizeDeviceTargetList(schedule.deviceTargets)
  };
}

function normalizeDays(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [];
  const days = [...new Set(values.map((day) => Number(day)).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
  return days.length ? days : [0, 1, 2, 3, 4, 5, 6];
}

function normalizeClock(value: unknown, fallback: string): string {
  const text = String(value || "");
  return /^\d{2}:\d{2}$/.test(text) ? text : fallback;
}

function normalizeDeviceTargetList(value: unknown): Array<"computer" | "phone"> {
  const source = Array.isArray(value) ? value : [];
  const targets = [...new Set(source.map((item) => String(item || "").trim().toLowerCase()).filter((item) => item === "computer" || item === "phone"))];
  return targets.length ? targets as Array<"computer" | "phone"> : ["computer", "phone"];
}

function normalizeProfiles(profiles: Profile[]): Profile[] {
  return profiles.map((profile) => ({
    ...profile,
    blockedApps: Array.isArray(profile.blockedApps) ? profile.blockedApps : [],
    blockedSites: Array.isArray(profile.blockedSites) ? profile.blockedSites : [],
    blockedUrlPatterns: Array.isArray(profile.blockedUrlPatterns) ? profile.blockedUrlPatterns : [],
    allowedApps: Array.isArray(profile.allowedApps) ? profile.allowedApps : [],
    allowedSites: Array.isArray(profile.allowedSites) ? profile.allowedSites : [],
    phoneAppBlocking: profile.phoneAppBlocking === false ? false : undefined,
    hostsUrlPatternBlocking: profile.hostsUrlPatternBlocking === false ? false : undefined
  }));
}

function migrateActiveSessions(
  state: RawState,
  fresh: SentinelState,
  profiles: Profile[]
): Partial<Record<"computer" | "phone", Session | null>> {
  const existing = state.activeSessions && typeof state.activeSessions === "object"
    ? state.activeSessions
    : null;
  const legacy = state.activeSession || null;
  return {
    ...fresh.activeSessions,
    computer: migrateSessionProfileSnapshot(existing?.computer || legacy || null, profiles),
    phone: migrateSessionProfileSnapshot(existing?.phone || (!existing && legacy ? legacy : null), profiles)
  };
}

function migrateSessionProfileSnapshot(session: Session | null, profiles: Profile[]): Session | null {
  if (!session) return null;
  const profileId = session.profileSnapshot?.id || session.profileId;
  if (profileId !== SOFT_BLOCK_PROFILE_ID) return session;
  const fallback = profiles.find((profile) => profile.id === SOFT_BLOCK_PROFILE_ID);
  const profileSnapshot = session.profileSnapshot || fallback;
  if (!profileSnapshot) return session;
  return {
    ...session,
    profileSnapshot: sanitizeSoftBlockProfile(profileSnapshot)
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNodeErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
