import { createHash, randomBytes } from "node:crypto";
import {
  APP_NAME,
  BRICK_MODE_PROFILE_ID,
  DEFAULT_ALWAYS_BANNED_URL_PATTERNS,
  DEFAULT_EXPLICIT_SEARCH_TERMS,
  DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS,
  DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
  IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_IDS,
  SOFT_BLOCK_PROFILE_ID,
  defaultState
} from "./defaults.js";
import { parseBoolean } from "./booleans.js";
import { adultBlocklistPreloadDomains } from "./adultBlocklist.js";
import { grayscaleDecision, IOS_GRAYSCALE_GUARD_BUNDLE_IDS } from "./grayscale.js";
import { activeLimitBlocks } from "./limits.js";
import { toPlist } from "./plist.js";
import { activePolicy, baselinePolicy, expandSiteTargets, hostMatchesSiteTargets, isFullLockoutPolicy, profileById } from "./policy.js";
import { IOS_SOCIAL_COMPANION_APPS, IOS_SOCIAL_COMPANION_BUNDLE_IDS, focusedSocialBlockedBundleIds, focusedSocialDeniedUrls, focusedSocialSummary, normalizeFocusedSocialSettings } from "./socialFeatureFilters.js";
import type { IosManageEngineGeneration, IosSettings, VigilState, UnknownRecord } from "./types.js";

export const IOS_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
export const IOS_RETIRED_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-social-launchers";
/** @deprecated The Web Clip launcher profile is retired; retain this alias only for removal and compatibility. */
export const IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER = IOS_RETIRED_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER;
export const IOS_APP_STORE_BUNDLE_ID = "com.apple.AppStore";
export const IOS_MANAGED_HELPER_APP_BUNDLE_IDS = ["com.zohocorp.mdm"];
export const IOS_PANIC_ALLOWED_APP_BUNDLE_IDS = [
  "com.apple.MobileSMS",
  "com.apple.mobilephone"
];
const MAX_DENY_URLS = 500;
const IOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_ID_KEYS = new Set(IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_IDS.map((value) => value.toLowerCase()));
const IOS_EXPLICIT_SEARCH_TERM_KEYS = new Set(DEFAULT_EXPLICIT_SEARCH_TERMS.map(normalizedExplicitSearchTerm));
const IOS_EXPLICIT_SEARCH_URL_PREFIXES = [
  "https://www.google.com/search?q=",
  "https://www.bing.com/search?q=",
  "https://duckduckgo.com/?q=",
  "https://search.yahoo.com/search?p=",
  "https://search.brave.com/search?q=",
  "https://www.ecosia.org/search?q=",
  "https://www.youtube.com/results?search_query="
];
const IOS_SOCIAL_COMPANION_ALLOWED_URLS = [
  "https://instagram.com/",
  "https://www.instagram.com/",
  "https://youtube.com/",
  "https://www.youtube.com/",
  "https://m.youtube.com/",
  "https://youtu.be/",
  "https://accounts.google.com/"
];
const IOS_PANIC_ALLOWED_URLS = [
  "http://127.0.0.1/",
  "http://localhost/",
  "https://127.0.0.1/",
  "https://localhost/"
];
interface IosPolicyTargets {
  profileName: string;
  appMode: string;
  webMode: string;
  enforcementActive: boolean;
  fullLockoutActive: boolean;
  protectionActive: boolean;
  focusedSocialEnforcementActive: boolean;
  appBundleIds: string[];
  deniedUrls: string[];
  allowedUrls: string[];
  managedHelperAppBundleIds: string[];
  focusedSocial: ReturnType<typeof focusedSocialSummary>;
  grayscale: {
    desired: boolean;
    reason: string;
    label: string;
    source: string;
    settingsGuarded: boolean;
  };
}

type MobileConfigPayload = UnknownRecord & {
  PayloadDescription: string;
  PayloadDisplayName: string;
  PayloadIdentifier: string;
  PayloadType: string;
  PayloadUUID: string;
  PayloadVersion: number;
};

export function normalizeIosSettings(body: UnknownRecord = {}, existing: Partial<IosSettings> = {}): IosSettings {
  const current = { ...defaultState().deviceControls.ios, ...existing };
  const next = {
    ...current,
    enabled: body.enabled === undefined ? Boolean(current.enabled) : parseBoolean(body.enabled, false),
    status: "supervised-profile-ready",
    mode: normalizeChoice(body.mode, ["denylist", "allowlist"], current.mode || "denylist"),
    webMode: normalizeChoice(body.webMode, ["denylist", "allowlist"], current.webMode || "denylist"),
    blockApps: body.blockApps === undefined ? current.blockApps !== false : parseBoolean(body.blockApps, true),
    blockWeb: body.blockWeb === undefined ? current.blockWeb !== false : parseBoolean(body.blockWeb, true),
    hardenRemoval: body.hardenRemoval === undefined ? current.hardenRemoval !== false : parseBoolean(body.hardenRemoval, true),
    restrictInstallAndErase: body.restrictInstallAndErase === undefined ? current.restrictInstallAndErase !== false : parseBoolean(body.restrictInstallAndErase, true),
    allowSafariHistoryClearing: body.allowSafariHistoryClearing === undefined ? current.allowSafariHistoryClearing !== false : parseBoolean(body.allowSafariHistoryClearing, true),
    blockedAppBundleIds: normalizeBundleIds([
      ...DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
      ...normalizeBundleIds(body.blockedAppBundleIds ?? body.blockedApps ?? current.blockedAppBundleIds ?? [])
    ]).filter((bundleId) => !IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_ID_KEYS.has(bundleId.toLowerCase())),
    allowedAppBundleIds: normalizeBundleIds(body.allowedAppBundleIds ?? body.allowedApps ?? current.allowedAppBundleIds ?? DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS),
    deniedUrls: normalizeUrlList(body.deniedUrls ?? current.deniedUrls ?? []),
    allowedUrls: normalizeUrlList(body.allowedUrls ?? current.allowedUrls ?? []),
    focusedSocial: normalizeFocusedSocialSettings(body.focusedSocial ?? current.focusedSocial, current.focusedSocial),
    // Export-generation evidence is runtime-owned. Settings requests may
    // preserve it, but they cannot claim an artifact was published.
    manageEngineGeneration: normalizeIosManageEngineGeneration(current.manageEngineGeneration)
  };

  if (next.hardenRemoval && !next.removalPassword) next.removalPassword = randomRemovalPassword();
  if (!next.blockedAppBundleIds.length) next.blockedAppBundleIds = [...DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS];
  if (!next.allowedAppBundleIds.length) next.allowedAppBundleIds = [...DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS];
  return next;
}

export function iosProfileSummary(state: VigilState, now = new Date()) {
  const settings = currentIosSettings(state);
  const active = Boolean(settings.enabled);
  const targets = active ? iosPolicyTargets(state, now) : disabledPolicyTargets(settings);
  const companionApps = IOS_SOCIAL_COMPANION_APPS.map((app) => ({ ...app }));
  const companionLabels = companionApps.map((app) => app.label);
  const companionBundleIds = companionApps.map((app) => app.bundleId);
  const appListRestrictionEmitted = Boolean(active
    && (settings.blockApps || targets.grayscale.settingsGuarded || targets.fullLockoutActive)
    && targets.appBundleIds.length);
  const appStoreVisibleByAppList = !appListRestrictionEmitted
    || (targets.appMode === "allowlist"
      ? includesBundleId(targets.appBundleIds, IOS_APP_STORE_BUNDLE_ID)
      : !includesBundleId(targets.appBundleIds, IOS_APP_STORE_BUNDLE_ID));
  const appStoreInstallAllowed = Boolean(!active || !targets.enforcementActive || !settings.restrictInstallAndErase);
  const removalHardened = Boolean(active && settings.hardenRemoval && settings.removalPassword);
  const deliveredAdultDomains = deliveredAdultBlocklistDomainCount(state, targets.deniedUrls);
  return {
    enabled: active,
    supported: true,
    status: active ? "supervised-protection-configured" : "ready",
    note: active
      ? targets.enforcementActive
        ? "Always-on content protection plus the current timed iPhone policy are ready for managed delivery."
        : "Always-on explicit-content protection is ready for managed delivery; ordinary apps and the App Store remain available."
      : "Enable this to generate a supervised iPhone policy profile.",
    supervisedRequired: true,
    removalHardened,
    restrictInstallAndErase: Boolean(settings.restrictInstallAndErase),
    appStoreAllowedByThisProfile: Boolean(appStoreVisibleByAppList && appStoreInstallAllowed),
    appStoreVisibleByAppList,
    appStoreInstallAllowed,
    appStoreRestrictionKeysEmitted: Boolean(active && targets.enforcementActive && settings.restrictInstallAndErase),
    allowSafariHistoryClearing: settings.allowSafariHistoryClearing !== false,
    mode: settings.mode,
    webMode: settings.webMode,
    blockApps: Boolean(settings.blockApps),
    blockWeb: Boolean(settings.blockWeb),
    blockedAppBundleIds: settings.blockedAppBundleIds,
    allowedAppBundleIds: settings.allowedAppBundleIds,
    deniedUrls: settings.deniedUrls,
    allowedUrls: settings.allowedUrls,
    focusedSocial: settings.focusedSocial,
    protection: {
      knownSitesBlocked: Boolean(active && ((settings.blockWeb && targets.deniedUrls.length) || targets.fullLockoutActive)),
      knownSiteDomainCount: deliveredAdultDomains,
      explicitSearchesBlocked: Boolean(active && (targets.fullLockoutActive || hasExplicitSearchProtection(targets.deniedUrls))),
      explicitSearchTermCount: DEFAULT_EXPLICIT_SEARCH_TERMS.length,
      safeSearchEnforced: false,
      sensitiveMediaFiltered: false,
      requiresManagedSafariExtension: false,
      systemWideManagedWebFilter: Boolean(active && settings.blockWeb),
      appWorkaroundsClosed: Boolean(active && (settings.blockApps || targets.fullLockoutActive) && targets.appBundleIds.length),
      targetedAppBundleCount: targets.appBundleIds.length,
      allAppsHidden: Boolean(targets.fullLockoutActive),
      removalLocked: removalHardened
    },
    profile: {
      identifier: IOS_PROFILE_IDENTIFIER,
      fileName: "vigil-iphone-lock.mobileconfig",
      downloadPath: "/api/devices/ios/profile.mobileconfig",
      generatedFrom: targets.profileName,
      appBundleCount: targets.appBundleIds.length,
      deniedUrlCount: targets.deniedUrls.length,
      allowedUrlCount: targets.allowedUrls.length,
      webClipCount: 0,
      enforcementActive: targets.enforcementActive,
      protectionActive: targets.protectionActive,
      focusedSocialEnforcementActive: targets.focusedSocialEnforcementActive,
      managedHelperAppBundleIds: targets.managedHelperAppBundleIds,
      focusedSocial: targets.focusedSocial,
      grayscale: targets.grayscale,
      lastGeneratedAt: settings.lastGeneratedAt || null
    },
    companionApps: {
      appCount: companionApps.length,
      labels: companionLabels,
      bundleIds: companionBundleIds,
      apps: companionApps
    },
    launcherProfile: {
      identifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
      retired: true,
      managedSeparately: false,
      webClipCount: 0,
      labels: companionLabels,
      bundleIds: companionBundleIds
    },
    manageEngine: manageEngineHandoffSummary(state, settings, active, targets, now)
  };
}

export function ensureIosRemovalPassword(state: VigilState): boolean {
  if (state.deviceControls.ios.hardenRemoval === false) return false;
  if (state.deviceControls.ios.removalPassword) return false;
  state.deviceControls.ios.removalPassword = randomRemovalPassword();
  return true;
}

export function markIosProfileGenerated(state: VigilState, at = new Date()): void {
  state.deviceControls.ios.lastGeneratedAt = at.toISOString();
}

export function publicIosSettings(ios: Partial<IosSettings> = {}) {
  const { removalPassword, ...rest } = ios || {};
  return {
    ...rest,
    removalPasswordSet: Boolean(removalPassword)
  };
}

export function buildIosConfigurationProfile(state: VigilState, now = new Date()): string {
  const settings = currentIosSettings(state);
  const active = Boolean(settings.enabled);
  const targets = active ? iosPolicyTargets(state, now) : disabledPolicyTargets(settings);
  const enforcementActive = Boolean(active && targets.enforcementActive);
  const payloads: MobileConfigPayload[] = [];

  const restrictions = restrictionsPayload(settings, targets);
  if (restrictions) payloads.push(restrictions);

  const webFilter = webContentFilterPayload(settings, targets);
  if (webFilter) payloads.push(webFilter);

  if (active && settings.hardenRemoval && settings.removalPassword) {
    payloads.push(commonPayload("com.apple.profileRemovalPassword", "Profile Removal Password", "removal-password", {
      RemovalPassword: settings.removalPassword
    }));
  }

  const profile = {
    PayloadContent: payloads,
    PayloadDescription: enforcementActive
      ? "Always-on explicit-content protection plus timed app and website restrictions generated by Vigil."
      : "Always-on managed web filtering across phone browsers plus targeted native social-app restrictions.",
    PayloadDisplayName: "Vigil iPhone Lock",
    PayloadIdentifier: IOS_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: Boolean(active && settings.hardenRemoval),
    PayloadType: "Configuration",
    PayloadUUID: stableIosPayloadUuid(IOS_PROFILE_IDENTIFIER),
    PayloadVersion: 1
  };

  return toPlist(profile);
}

function manageEngineHandoffSummary(
  state: VigilState,
  settings: IosSettings,
  active: boolean,
  targets: IosPolicyTargets,
  now: Date
): UnknownRecord {
  const generation = normalizeIosManageEngineGeneration(settings.manageEngineGeneration);
  const expectedProfileHash = createHash("sha256")
    .update(buildIosConfigurationProfile(state, now))
    .digest("hex");
  const currentGeneration = Boolean(active && generation?.profileHash === expectedProfileHash);
  return {
    preferred: true,
    deliveryProvider: "manageengine",
    status: active ? "export-ready" : "policy-disabled",
    currentGeneration,
    generatedAt: generation?.generatedAt || null,
    generation: generation?.generation || null,
    profileHash: generation?.profileHash || null,
    policyPath: "data/manageengine/vigil-manageengine-policy.mobileconfig",
    summaryPath: "data/manageengine/vigil-manageengine-policy.summary.json",
    enrollmentWindowPath: "data/manageengine/vigil-manageengine-enrollment-window.mobileconfig",
    companionApps: IOS_SOCIAL_COMPANION_APPS.map((app) => ({ ...app })),
    exportCommand: "npm run ios:manageengine:export",
    enrollmentWindowCommand: "npm run ios:manageengine:apply-enrollment-window",
    generatedFrom: targets.profileName,
    appBundleCount: targets.appBundleIds.length,
    deniedUrlCount: targets.deniedUrls.length,
    allowedUrlCount: targets.allowedUrls.length,
    enforcementActive: targets.enforcementActive,
    focusedSocialEnforcementActive: targets.focusedSocialEnforcementActive,
    managedHelperAppBundleIds: targets.managedHelperAppBundleIds,
    note: active
      ? "Normal free iPhone delivery path: Vigil exports this profile and ManageEngine owns enrollment, APNs wakeups, assignment, and removal."
      : "Enable the Vigil iPhone policy before exporting a ManageEngine custom profile."
  };
}

export function iosPolicyTargets(state: VigilState, now = new Date()): IosPolicyTargets {
  const settings = currentIosSettings(state);
  const activePhonePolicy = activePolicy(state, now, { device: "phone" });
  const activePhoneLimitBlocks = activeLimitBlocks(state, now, { device: "phone" });
  const limitOnly = !activePhonePolicy && activePhoneLimitBlocks.length > 0;
  const policy = activePhonePolicy || baselinePolicy(state, now, { device: "phone" });
  const profile = policy?.profile
    || profileById(state, settings.profileId || state.settings.activeProfileId)
    || state.profiles?.[0]
    || null;
  const focusedSocialEnforcementActive = Boolean(activePhonePolicy && profile?.id === SOFT_BLOCK_PROFILE_ID);
  const fullBrickActive = Boolean(activePhonePolicy && profile?.id === BRICK_MODE_PROFILE_ID);
  const fullLockoutActive = isFullLockoutPolicy(activePhonePolicy);

  const profileName = limitOnly
    ? activePhoneLimitBlocks.map((block) => block.ruleName).join(" + ")
    : policy?.session?.title || profile?.name || "Saved iPhone policy";
  const appMode = limitOnly ? "denylist" : profile?.mode === "allowlist" ? "allowlist" : settings.mode;
  const webMode = limitOnly ? "denylist" : profile?.mode === "allowlist" ? "allowlist" : settings.webMode;
  const grayscale = grayscaleDecision(state, now, { device: "phone" });
  const enforcementActive = Boolean(activePhonePolicy || limitOnly);
  const protectionActive = Boolean(settings.enabled && (settings.blockApps || settings.blockWeb));
  const settingsGuarded = Boolean(enforcementActive && grayscale.desired && state.grayscale?.preventManualChanges !== false);
  const phoneAppBlocking = profile?.phoneAppBlocking !== false;
  let appBundleIds = fullLockoutActive
    ? [...IOS_PANIC_ALLOWED_APP_BUNDLE_IDS]
    : limitOnly ? [] : phoneAppBlocking
    ? appMode === "allowlist"
      ? settings.allowedAppBundleIds
      : settings.blockedAppBundleIds
    : [];
  if (!settings.blockApps && !settingsGuarded && !fullLockoutActive) appBundleIds = [];
  if (!fullLockoutActive && !enforcementActive && settings.blockApps) {
    appBundleIds = [...settings.blockedAppBundleIds];
  } else if (!fullLockoutActive && enforcementActive && settings.blockApps && appMode !== "allowlist") {
    appBundleIds = uniqueStrings([...settings.blockedAppBundleIds, ...appBundleIds]);
  }
  if (settingsGuarded) {
    appBundleIds = appMode === "allowlist"
      ? appBundleIds.filter((bundleId) => !IOS_GRAYSCALE_GUARD_BUNDLE_IDS.includes(bundleId))
      : uniqueStrings([...appBundleIds, ...IOS_GRAYSCALE_GUARD_BUNDLE_IDS]);
  }

  const profileAllowedSites = limitOnly
    ? []
    : profile?.allowedSites || [];
  const profileBlockedSites = limitOnly
    ? []
    : profile?.blockedSites || [];
  const activeLimitBundleIds = uniqueStrings(activePhoneLimitBlocks.flatMap((block) => block.apps || []).filter(isLikelyIosBundleId));
  const activeLimitSites = uniqueStrings(activePhoneLimitBlocks.flatMap((block) => block.sites || []));
  const profilePatterns = limitOnly
    ? []
    : profile?.blockedUrlPatterns || [];
  const focusedSocialSettings = normalizeFocusedSocialSettings(settings.focusedSocial);
  const socialDeniedUrls = focusedSocialEnforcementActive
    ? focusedSocialDeniedUrls(focusedSocialSettings)
    : [];
  const includeFocusedSocialNativeApps = settings.blockApps
    && focusedSocialEnforcementActive
    && appMode !== "allowlist";
  const permanentDeniedUrls = urlsFromPatterns([
    ...DEFAULT_EXPLICIT_SEARCH_TERMS,
    ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS
  ]);
  const policyDeniedUrls = webMode === "allowlist"
    ? uniqueUrls([
      ...urlsFromSiteTargets(activeLimitSites),
      ...urlsFromSiteTargets(profileBlockedSites),
      ...urlsFromPatterns(profilePatterns),
      ...urlsFromPatterns(socialDeniedUrls)
    ])
    : uniqueUrls([
      ...urlsFromSiteTargets(activeLimitSites),
      ...urlsFromSiteTargets(profileBlockedSites),
      ...urlsFromPatterns(profilePatterns),
      ...urlsFromPatterns(socialDeniedUrls)
    ]);
  const adultDeniedUrls = urlsFromSiteTargets(adultBlocklistPreloadDomains(state));
  const deniedUrls = !settings.blockWeb && !fullLockoutActive
    ? []
    : fullLockoutActive
    ? []
    : enforcementActive && webMode === "allowlist"
    ? prioritizedDenyUrls(permanentDeniedUrls, policyDeniedUrls)
    : prioritizedDenyUrls(
      permanentDeniedUrls,
      policyDeniedUrls,
      settings.deniedUrls,
      adultDeniedUrls
    );
  let allowedUrls = !enforcementActive || (!settings.blockWeb && !fullLockoutActive)
    ? []
    : fullLockoutActive
    ? [...IOS_PANIC_ALLOWED_URLS]
    : webMode === "allowlist"
    ? uniqueUrls([
      ...urlsFromSiteTargets(profileAllowedSites),
      ...settings.allowedUrls,
      ...IOS_SOCIAL_COMPANION_ALLOWED_URLS
    ])
    : limitOnly ? [] : uniqueUrls(settings.allowedUrls);
  if (includeFocusedSocialNativeApps) {
    appBundleIds = uniqueStrings([
      ...appBundleIds,
      ...focusedSocialBlockedBundleIds(focusedSocialSettings)
    ]);
  }
  if (settings.blockApps && fullBrickActive && appMode !== "allowlist") {
    appBundleIds = uniqueStrings([
      ...appBundleIds,
      ...Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS)
    ]);
  }
  if (settings.blockApps && focusedSocialEnforcementActive && appMode === "allowlist") {
    appBundleIds = uniqueStrings([
      ...appBundleIds,
      IOS_APP_STORE_BUNDLE_ID,
      ...Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS)
    ]);
  }
  if (enforcementActive && appMode === "allowlist" && activeLimitBundleIds.length) {
    appBundleIds = withoutBundleIds(appBundleIds, activeLimitBundleIds);
  }
  if (enforcementActive && webMode === "allowlist" && activeLimitSites.length) {
    allowedUrls = withoutSiteTargets(allowedUrls, activeLimitSites);
  }
  if (enforcementActive && settings.blockApps && appMode !== "allowlist" && activeLimitBundleIds.length) {
    appBundleIds = uniqueStrings([
      ...appBundleIds,
      ...activeLimitBundleIds
    ]);
  }
  const managedHelperAppBundleIds = settings.blockApps && focusedSocialEnforcementActive
    ? [...IOS_MANAGED_HELPER_APP_BUNDLE_IDS]
    : [];
  if (managedHelperAppBundleIds.length) {
    appBundleIds = appMode === "allowlist"
      ? withoutBundleIds(appBundleIds, managedHelperAppBundleIds)
      : uniqueStrings([...appBundleIds, ...managedHelperAppBundleIds]);
  }

  return {
    profileName,
    appMode,
    webMode,
    enforcementActive,
    fullLockoutActive,
    protectionActive,
    focusedSocialEnforcementActive,
    appBundleIds,
    deniedUrls,
    allowedUrls,
    managedHelperAppBundleIds,
    focusedSocial: focusedSocialSummary(focusedSocialSettings, {
      includeDeniedUrls: focusedSocialEnforcementActive && settings.blockWeb && webMode !== "allowlist",
      includeNativeApps: includeFocusedSocialNativeApps,
      includeWebClips: false
    }),
    grayscale: {
      desired: grayscale.desired,
      reason: grayscale.reason,
      label: grayscale.label,
      source: grayscale.source,
      settingsGuarded
    }
  };
}

export function normalizeBundleIds(values: unknown): string[] {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of source) {
    const value = String(raw || "").trim();
    if (!value || !IOS_BUNDLE_ID_PATTERN.test(value)) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output.sort((a, b) => a.localeCompare(b));
}

function isLikelyIosBundleId(value: unknown): value is string {
  const text = String(value || "").trim();
  return text.includes(".") && IOS_BUNDLE_ID_PATTERN.test(text);
}

export function normalizeUrlList(values: unknown): string[] {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  return uniqueUrls(source.flatMap(urlsFromInput));
}

function currentIosSettings(state: VigilState): IosSettings {
  const normalized = normalizeIosSettings({
    enabled: state.deviceControls?.ios?.enabled,
    mode: state.deviceControls?.ios?.mode,
    webMode: state.deviceControls?.ios?.webMode,
    blockApps: state.deviceControls?.ios?.blockApps,
    blockWeb: state.deviceControls?.ios?.blockWeb,
    hardenRemoval: state.deviceControls?.ios?.hardenRemoval,
    restrictInstallAndErase: state.deviceControls?.ios?.restrictInstallAndErase,
    allowSafariHistoryClearing: state.deviceControls?.ios?.allowSafariHistoryClearing,
    blockedAppBundleIds: state.deviceControls?.ios?.blockedAppBundleIds,
    allowedAppBundleIds: state.deviceControls?.ios?.allowedAppBundleIds,
    deniedUrls: state.deviceControls?.ios?.deniedUrls,
    allowedUrls: state.deviceControls?.ios?.allowedUrls,
    focusedSocial: state.deviceControls?.ios?.focusedSocial
  }, state.deviceControls?.ios || {});
  return {
    ...normalized,
    removalPassword: state.deviceControls?.ios?.removalPassword || null
  };
}

function disabledPolicyTargets(settings: IosSettings): IosPolicyTargets {
  return {
    profileName: "iPhone blocking disabled",
    appMode: settings.mode,
    webMode: settings.webMode,
    enforcementActive: false,
    fullLockoutActive: false,
    protectionActive: false,
    focusedSocialEnforcementActive: false,
    appBundleIds: [],
    deniedUrls: [],
    allowedUrls: [],
    managedHelperAppBundleIds: [],
    focusedSocial: focusedSocialSummary(settings.focusedSocial, {
      includeDeniedUrls: false,
      includeNativeApps: false,
      includeWebClips: false
    }),
    grayscale: {
      desired: false,
      reason: "ios-policy-disabled",
      label: "iPhone policy off",
      source: "normal",
      settingsGuarded: false
    }
  };
}

function restrictionsPayload(settings: IosSettings, targets: IosPolicyTargets): MobileConfigPayload | null {
  if (!settings.enabled) return null;
  if (!targets.enforcementActive) {
    return commonPayload("com.apple.applicationaccess", "Always-on Content Protection", "restrictions", {
      allowAppInstallation: true,
      allowAppRemoval: true,
      allowEraseContentAndSettings: true,
      allowHostPairing: true,
      allowSafariHistoryClearing: true,
      allowUIAppInstallation: true,
      allowUIConfigurationProfileInstallation: false,
      allowVPNCreation: false,
      allowWebDistributionAppInstallation: true,
      blockedAppBundleIDs: settings.blockApps ? targets.appBundleIds : undefined,
      forceAutomaticDateAndTime: false
    });
  }
  const restrictions: UnknownRecord = {
    allowSafariHistoryClearing: settings.allowSafariHistoryClearing !== false
  };
  if ((settings.blockApps || targets.grayscale.settingsGuarded || targets.fullLockoutActive) && targets.appBundleIds.length) {
    if (targets.appMode === "allowlist") restrictions.allowListedAppBundleIDs = targets.appBundleIds;
    else restrictions.blockedAppBundleIDs = targets.appBundleIds;
  }

  if (targets.enforcementActive && settings.restrictInstallAndErase) {
    restrictions.allowAppInstallation = false;
    restrictions.allowAppRemoval = false;
    restrictions.allowEraseContentAndSettings = false;
    restrictions.allowHostPairing = false;
    restrictions.allowUIAppInstallation = false;
    restrictions.allowUIConfigurationProfileInstallation = false;
    restrictions.allowVPNCreation = false;
    restrictions.allowWebDistributionAppInstallation = false;
    restrictions.forceAutomaticDateAndTime = true;
  }

  if (!Object.keys(restrictions).length) return null;
  return commonPayload("com.apple.applicationaccess", "iPhone Restrictions", "restrictions", restrictions);
}

function webContentFilterPayload(settings: IosSettings, targets: IosPolicyTargets): MobileConfigPayload | null {
  if (!settings.enabled) return null;
  if (!settings.blockWeb && !targets.fullLockoutActive) return null;
  if (!targets.enforcementActive && !targets.deniedUrls.length) return null;
  const content: UnknownRecord & {
    AutoFilterEnabled: boolean;
    FilterType: string;
    AllowListBookmarks?: Array<{ Title: string; URL: string }>;
    DenyListURLs?: string[];
    SafariHistoryRetentionEnabled: boolean;
  } = {
    AutoFilterEnabled: true,
    FilterType: "BuiltIn",
    SafariHistoryRetentionEnabled: settings.allowSafariHistoryClearing === false
  };

  if (targets.webMode === "allowlist") {
    content.AllowListBookmarks = targets.allowedUrls.map((url: string) => ({
      Title: bookmarkTitle(url),
      URL: url
    }));
  }
  if (targets.deniedUrls.length) {
    content.DenyListURLs = targets.deniedUrls;
  }

  if (!content.DenyListURLs?.length && !content.AllowListBookmarks?.length) return null;
  return commonPayload("com.apple.webcontent-filter", "iPhone Web Filter", "web-filter", content);
}

function commonPayload(type: string, name: string, suffix: string, values: UnknownRecord = {}, identifierPrefix = IOS_PROFILE_IDENTIFIER): MobileConfigPayload {
  return {
    ...values,
    PayloadDescription: `${name} generated by ${APP_NAME}.`,
    PayloadDisplayName: name,
    PayloadIdentifier: `${identifierPrefix}.${suffix}`,
    PayloadType: type,
    PayloadUUID: stableIosPayloadUuid(`${identifierPrefix}.${suffix}`),
    PayloadVersion: 1
  };
}

export function stableIosPayloadUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-").toUpperCase();
}

function urlsFromSiteTargets(values: readonly unknown[]): string[] {
  return expandSiteTargets(values).flatMap(urlsFromInput);
}

function deliveredAdultBlocklistDomainCount(state: VigilState, deniedUrls: readonly string[]): number {
  const deliveredUrls = new Set(deniedUrls.map((url) => url.toLowerCase()));
  return adultBlocklistPreloadDomains(state).filter((domain) =>
    urlsFromSiteTargets([domain]).some((url) => deliveredUrls.has(url.toLowerCase()))
  ).length;
}

function urlsFromPatterns(values: readonly unknown[]): string[] {
  return (values || []).flatMap((value) => {
    const explicitSearchUrls = urlsForExplicitSearchTerm(value);
    return explicitSearchUrls.length ? explicitSearchUrls : urlsFromInput(value);
  });
}

function urlsForExplicitSearchTerm(value: unknown): string[] {
  const term = normalizedExplicitSearchTerm(value);
  if (!term || !IOS_EXPLICIT_SEARCH_TERM_KEYS.has(term)) return [];
  const encoded = encodeURIComponent(term);
  return IOS_EXPLICIT_SEARCH_URL_PREFIXES.map((prefix) => `${prefix}${encoded}`);
}

function normalizedExplicitSearchTerm(value: unknown): string {
  const term = String(value || "").trim().toLowerCase();
  if (!term) return "";
  try {
    return decodeURIComponent(term).trim().toLowerCase();
  } catch {
    return term;
  }
}

function hasExplicitSearchProtection(deniedUrls: readonly string[]): boolean {
  return deniedUrls.some((url) => IOS_EXPLICIT_SEARCH_URL_PREFIXES.some((prefix) => url.startsWith(prefix)));
}

function urlsFromInput(value: unknown): string[] {
  const input = String(value || "").trim().toLowerCase();
  if (!input || input.startsWith("/") || !/[a-z0-9]/i.test(input)) return [];
  try {
    const parsed = input.includes("://") ? new URL(input) : null;
    if (parsed && ["http:", "https:"].includes(parsed.protocol)) {
      return [parsed.toString()];
    }
  } catch {
    // Fall through to host/path handling.
  }

  const stripped = input.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\s+/g, "");
  if (!stripped || stripped.startsWith("/") || !stripped.includes(".")) return [];
  const slashIndex = stripped.indexOf("/");
  const host = slashIndex === -1 ? stripped.replace(/\/+$/, "") : stripped.slice(0, slashIndex);
  const path = slashIndex === -1 ? "/" : stripped.slice(slashIndex) || "/";
  return iosUrlHostVariants(host).flatMap((variant) => [`https://${variant}${path}`, `http://${variant}${path}`]);
}

function uniqueUrls(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output;
}

/**
 * Apple's built-in web filter accepts at most 500 deny-list URLs. Keep the
 * small, intentional protections ahead of the bulk adult-domain preload so a
 * large source cannot evict permanent, active-policy, or user-configured URLs.
 */
function prioritizedDenyUrls(...priorityGroups: ReadonlyArray<readonly unknown[]>): string[] {
  return uniqueUrls(priorityGroups.flat()).slice(0, MAX_DENY_URLS);
}

function iosUrlHostVariants(host: string): string[] {
  const normalized = String(host || "").trim().toLowerCase();
  if (!normalized) return [];
  const variants = [normalized];
  const labels = normalized.split(".").filter(Boolean);
  if (!normalized.startsWith("www.") && labels.length === 2) variants.push(`www.${normalized}`);
  return [...new Set(variants)];
}

function uniqueStrings(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
  }
  return output.sort((a, b) => a.localeCompare(b));
}

function withoutBundleIds(values: readonly string[], bundleIdsToRemove: readonly string[]): string[] {
  const blocked = new Set(bundleIdsToRemove.map((value) => value.toLowerCase()));
  return values.filter((value) => !blocked.has(value.toLowerCase()));
}

function withoutSiteTargets(values: readonly string[], siteTargetsToRemove: readonly string[]): string[] {
  return values.filter((value) => {
    try {
      return !hostMatchesSiteTargets(new URL(value).hostname, siteTargetsToRemove);
    } catch {
      return true;
    }
  });
}

function includesBundleId(values: readonly string[], bundleId: string): boolean {
  const expected = bundleId.toLowerCase();
  return values.some((value) => value.toLowerCase() === expected);
}

function bookmarkTitle(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return String(value || "Allowed Site").slice(0, 48);
  }
}

function randomRemovalPassword(): string {
  return randomBytes(18).toString("base64url");
}

function normalizeChoice(value: unknown, allowed: string[], fallback: string): string {
  const text = String(value || "");
  return allowed.includes(text) ? text : fallback;
}

export function normalizeIosManageEngineGeneration(value: unknown): IosManageEngineGeneration | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as UnknownRecord;
  const generatedAt = String(record.generatedAt || "").trim();
  const generation = String(record.generation || "").trim();
  const profileHash = String(record.profileHash || "").trim().toLowerCase();
  if (Number(record.version) !== 1) return null;
  if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) return null;
  if (!generation || generation.length > 200) return null;
  if (!/^[a-f0-9]{64}$/u.test(profileHash)) return null;
  return { version: 1, generatedAt, generation, profileHash };
}
