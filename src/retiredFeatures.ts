import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AppLockRule, LimitRule, UnknownRecord, VigilState } from "./types.js";

export const SETTINGS_CLEANUP_VERSION = 1;
export const RETIRED_SETTING_KEYS = new Set([
  "focusSoundEnabled", "focusSoundMode", "focusSoundActivity", "focusSoundPreset",
  "focusSoundIntensity", "focusSoundTimerMode", "focusSoundTimerMinutes", "focusSoundBreakMinutes", "focusSoundVolume",
  "hostsBlockingEnabled", "externalNetworkBlockEnabled", "externalNetworkBlockProvider",
  "intentionalUseEnabled", "baselineDailyMinutes", "focusScoreGoal",
  "systemSleepLockEnabled", "systemSleepLockIntervalSeconds",
  "focusShortcutEnabled", "focusShortcutOnName", "focusShortcutOffName"
]);

// Frozen historical configurations: a template ID alone does not prove that
// the user left its restrictions unchanged.
const LEGACY_SOCIAL_SITES = ["youtube.com", "x.com", "twitter.com", "instagram.com", "tiktok.com", "facebook.com", "threads.net", "snapchat.com", "pinterest.com", "discord.com"];
const LEGACY_LIMIT_TEMPLATES: LimitRule[] = [
  { id: "instagram-20-20-template", name: "Instagram 20/20", enabled: true, type: "time", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: ["Instagram", "com.burbn.instagram", "tech.caseline.vigil.instagram"], sites: ["instagram.com"], limitMinutes: 20, unlocksAllowed: 0, blockMinutes: 20, excludedProfileIds: ["soft-block"] },
  { id: "soft-lock-youtube-20-20-template", name: "Soft Lock YouTube 20/20", enabled: true, type: "time", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: ["YouTube", "com.google.ios.youtube", "tech.caseline.vigil.youtube"], sites: ["youtube.com"], limitMinutes: 20, unlocksAllowed: 0, blockMinutes: 20, requiredProfileId: "soft-block" },
  { id: "social-open-template", name: "Social open limit", enabled: false, type: "open", lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: [], sites: LEGACY_SOCIAL_SITES, limitMinutes: 45, unlocksAllowed: 5, blockMinutes: 0 }
];
const LEGACY_APP_LOCK_TEMPLATE: AppLockRule = { id: "social-app-lock-template", name: "Locked socials", enabled: false, lockLevel: "deep", days: [0,1,2,3,4,5,6], apps: [], sites: LEGACY_SOCIAL_SITES, unlocksAllowed: 2, unlockMinutes: 10, delaySeconds: 30 };

function isUnchangedLegacyLimit(rule: LimitRule): boolean {
  const configuration = { ...rule };
  // Cycle anchors track usage, rather than user-configured restrictions. Active
  // blocks keep their original deadline even when their template is retired.
  delete configuration.cycleAnchorDateKey;
  delete configuration.cycleAnchorSeconds;
  delete configuration.cycleAnchorOpens;
  return LEGACY_LIMIT_TEMPLATES.some(template => isDeepStrictEqual(configuration, template));
}

/** Retired endpoints remain recognizable so old clients cannot recreate their state. */
export function retiredFeaturePath(path: string): boolean {
  return path === "/pause" || path.startsWith("/mdm/")
    || path.startsWith("/api/intentional-use/")
    || path.startsWith("/api/extension/pause/")
    || path.startsWith("/api/grayscale/")
    || path === "/api/devices/ios/app-removal"
    || path.startsWith("/api/devices/ios/mdm/")
    || path === "/api/profile" || path.startsWith("/api/profile/")
    || path === "/api/limit" || path.startsWith("/api/limit/")
    || path === "/api/app-lock" || path.startsWith("/api/app-lock/");
}

/** Archive ciphertext and the original configuration before changing any legacy state. */
export async function archiveRetiredFeatureState(raw: string, dataDir: string): Promise<string> {
  const directory = join(dataDir, "retired-features");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const path = join(directory, `settings-v1-${createHash("sha256").update(raw).digest("hex")}.json`);
  try {
    const file = await open(path, "wx", 0o600);
    try { await file.writeFile(raw, "utf8"); await file.sync(); } finally { await file.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (await readFile(path, "utf8") !== raw) throw new Error("The retirement archive is incomplete; configuration was retained.");
  }
  return path;
}

export function retireUnusedFeatures(state: VigilState): void {
  const settings = state.settings as unknown as UnknownRecord;
  for (const key of [...RETIRED_SETTING_KEYS].filter(key => key.startsWith("focusSound"))) delete settings[key];
  // Required protections replace their old optional switches. Migration may
  // strengthen protection, but cannot leave a hidden, disabled enforcement path.
  for (const key of ["strictByDefault", "intentReasonEnabled", "typingChallengeEnabled", "siteRedirectEnabled",
    "contentFilterEnabled", "protectedBrowsersOnly", "safariUrlFilterEnabled", "adultBlocklistEnabled", "browserNoiseBlockingEnabled",
    "appQuitEnabled", "strictBypassProtectionEnabled", "processSweepEnabled", "systemNetworkBlockingEnabled", "protectedEditsEnabled"]) {
    settings[key] = true;
  }
  // These legacy fields remain readable for state-seal and recovery compatibility.
  state.settings.intentionalUseEnabled = false;
  state.settings.focusShortcutEnabled = false;
  state.settings.systemSleepLockEnabled = false;
  state.settings.externalNetworkBlockEnabled = false;
  state.settings.hostsBlockingEnabled = false;
  state.grayscale = { softBlockEnabled: false, preventManualChanges: true, schedules: [] };
  state.deviceControls.ios.mdm.enabled = false;
  state.limitRules = state.limitRules.filter(rule => !isUnchangedLegacyLimit(rule));
  // Existing timed blocks finish normally; retirement never mints fresh usage credit.
  // Retain every customized lock, including locks with permitted unlocks.
  state.appLocks = state.appLocks.filter(lock => !isDeepStrictEqual(lock, LEGACY_APP_LOCK_TEMPLATE));
  state.intentionalUse.rules = [];
  state.intentionalUse.pauses = [];
  state.intentionalUse.grants = [];
  state.intentionalUse.ledger = {};
  state.intentionalUse.outcomes = [];
  state.intentionalUse.behaviors = [];
  state.intentionalUse.behaviorCheckIns = [];
  state.intentionalUse.journalEntries = [];
  state.intentionalUse.planLists = [];
  state.intentionalUse.planItems = [];
  // Persisted planner commitments keep their original enforcement until completion.
  state.intentionalUse.recoveryCheckIns = [];
  state.intentionalUse.sosSessions = [];
  state.intentionalUse.accountability = {};
  state.settingsCleanupVersion = SETTINGS_CLEANUP_VERSION;
}
