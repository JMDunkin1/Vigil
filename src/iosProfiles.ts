import { createHash, randomBytes } from "node:crypto";
import {
  APP_NAME,
  BRICK_MODE_PROFILE_ID,
  DEFAULT_EXPLICIT_SEARCH_TERMS,
  DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS,
  DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
  SOFT_BLOCK_PROFILE_ID,
  defaultState
} from "./defaults.js";
import { parseBoolean } from "./booleans.js";
import { adultBlocklistPreloadDomains, adultBlocklistSummary } from "./adultBlocklist.js";
import { grayscaleDecision, IOS_GRAYSCALE_GUARD_BUNDLE_IDS } from "./grayscale.js";
import { activeLimitBlocks } from "./limits.js";
import { plistData, toPlist } from "./plist.js";
import { activePolicy, baselinePolicy, expandSiteTargets, hostMatchesSiteTargets, profileById } from "./policy.js";
import { IOS_SOCIAL_COMPANION_BUNDLE_IDS, focusedSocialBlockedBundleIds, focusedSocialDeniedUrls, focusedSocialLauncherWebClips, focusedSocialSummary, normalizeFocusedSocialSettings } from "./socialFeatureFilters.js";
import type { FocusedSocialWebClip } from "./socialFeatureFilters.js";
import type { IosSettings, VigilState, UnknownRecord } from "./types.js";

export const IOS_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-lock";
export const IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER = "tech.caseline.vigil.ios-social-launchers";
export const IOS_APP_STORE_BUNDLE_ID = "com.apple.AppStore";
export const IOS_MANAGED_HELPER_APP_BUNDLE_IDS = ["com.zohocorp.mdm"];
const MAX_DENY_URLS = 500;
const IOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const IOS_SOCIAL_COMPANION_ALLOWED_URLS = [
  "https://instagram.com/",
  "https://www.instagram.com/",
  "https://youtube.com/",
  "https://www.youtube.com/",
  "https://m.youtube.com/",
  "https://youtu.be/",
  "https://snapchat.com/",
  "https://web.snapchat.com/",
  "https://accounts.google.com/"
];
interface IosPolicyTargets {
  profileName: string;
  appMode: string;
  webMode: string;
  enforcementActive: boolean;
  protectionActive: boolean;
  focusedSocialEnforcementActive: boolean;
  appBundleIds: string[];
  deniedUrls: string[];
  allowedUrls: string[];
  webClips: FocusedSocialWebClip[];
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
    ]),
    allowedAppBundleIds: normalizeBundleIds(body.allowedAppBundleIds ?? body.allowedApps ?? current.allowedAppBundleIds ?? DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS),
    deniedUrls: normalizeUrlList(body.deniedUrls ?? current.deniedUrls ?? []),
    allowedUrls: normalizeUrlList(body.allowedUrls ?? current.allowedUrls ?? []),
    focusedSocial: normalizeFocusedSocialSettings(body.focusedSocial ?? current.focusedSocial, current.focusedSocial)
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
  const launcherClips = focusedSocialLauncherWebClips();
  const appListRestrictionEmitted = Boolean(active
    && (settings.blockApps || targets.grayscale.settingsGuarded)
    && targets.appBundleIds.length);
  const appStoreVisibleByAppList = !appListRestrictionEmitted
    || (targets.appMode === "allowlist"
      ? includesBundleId(targets.appBundleIds, IOS_APP_STORE_BUNDLE_ID)
      : !includesBundleId(targets.appBundleIds, IOS_APP_STORE_BUNDLE_ID));
  const appStoreInstallAllowed = Boolean(!active || !targets.enforcementActive || !settings.restrictInstallAndErase);
  const removalHardened = Boolean(active && settings.hardenRemoval && settings.removalPassword);
  const adultSites = adultBlocklistSummary(state);
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
      knownSitesBlocked: Boolean(active && settings.blockWeb && targets.deniedUrls.length),
      knownSiteDomainCount: adultSites.activeDomainCount,
      explicitSearchesBlocked: Boolean(active && settings.blockWeb),
      explicitSearchTermCount: DEFAULT_EXPLICIT_SEARCH_TERMS.length,
      safeSearchEnforced: Boolean(active && settings.blockWeb),
      sensitiveMediaFiltered: Boolean(active && settings.blockWeb),
      requiresManagedSafariExtension: true,
      appWorkaroundsClosed: Boolean(active && settings.blockApps && targets.appBundleIds.length),
      targetedAppBundleCount: targets.appBundleIds.length,
      allAppsHidden: false,
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
    launcherProfile: {
      identifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
      fileName: "vigil-social-launchers.mobileconfig",
      managedSeparately: true,
      durationUntilRemoval: false,
      webClipCount: launcherClips.length,
      labels: launcherClips.map((clip) => clip.label)
    },
    manageEngine: manageEngineHandoffSummary(active, targets)
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
  const autoRemoval = profileAutoRemoval(state, now, active);
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
      : "Always-on explicit-content protection that targets unfiltered browser and social escape routes without hiding every app.",
    PayloadDisplayName: "Vigil iPhone Lock",
    ...autoRemoval,
    PayloadIdentifier: IOS_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: Boolean(active && settings.hardenRemoval),
    PayloadType: "Configuration",
    PayloadUUID: stableIosPayloadUuid(IOS_PROFILE_IDENTIFIER),
    PayloadVersion: 1
  };

  return toPlist(profile);
}

export function buildIosSocialLauncherProfile(): string {
  const clips = focusedSocialLauncherWebClips();
  const profile = {
    PayloadContent: webClipPayloads(clips, IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER),
    PayloadDescription: "Stable social launchers managed separately from Vigil's time-limited iPhone enforcement policy.",
    PayloadDisplayName: "Vigil Social Launchers",
    PayloadIdentifier: IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: false,
    PayloadType: "Configuration",
    PayloadUUID: stableIosPayloadUuid(IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER),
    PayloadVersion: 1
  };
  return toPlist(profile);
}

function profileAutoRemoval(state: VigilState, now: Date, active: boolean): UnknownRecord {
  if (!active) return {};
  const policy = activePolicy(state, now, { device: "phone" });
  const endsAt = Date.parse(policy?.endsAt || policy?.session?.endsAt || "");
  if (!Number.isFinite(endsAt)) return {};
  const secondsRemaining = Math.ceil((endsAt - now.getTime()) / 1000);
  if (secondsRemaining <= 0) return {};
  return {
    DurationUntilRemoval: Math.max(60, secondsRemaining + 30)
  };
}

function manageEngineHandoffSummary(active: boolean, targets: IosPolicyTargets): UnknownRecord {
  return {
    preferred: true,
    deliveryProvider: "manageengine",
    status: active ? "export-ready" : "policy-disabled",
    policyPath: "data/manageengine/vigil-manageengine-policy.mobileconfig",
    summaryPath: "data/manageengine/vigil-manageengine-policy.summary.json",
    enrollmentWindowPath: "data/manageengine/vigil-manageengine-enrollment-window.mobileconfig",
    launcherProfilePath: "data/manageengine/vigil-social-launchers.mobileconfig",
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
  let appBundleIds = limitOnly ? [] : phoneAppBlocking
    ? appMode === "allowlist"
      ? settings.allowedAppBundleIds
      : settings.blockedAppBundleIds
    : [];
  if (!settings.blockApps && !settingsGuarded) appBundleIds = [];
  if (!enforcementActive && settings.blockApps) {
    appBundleIds = [...settings.blockedAppBundleIds];
  } else if (enforcementActive && settings.blockApps && appMode !== "allowlist") {
    appBundleIds = uniqueStrings([...settings.blockedAppBundleIds, ...appBundleIds]);
  }
  if (settingsGuarded) {
    appBundleIds = appMode === "allowlist"
      ? appBundleIds.filter((bundleId) => !IOS_GRAYSCALE_GUARD_BUNDLE_IDS.includes(bundleId))
      : uniqueStrings([...appBundleIds, ...IOS_GRAYSCALE_GUARD_BUNDLE_IDS]);
  }

  const profileSites = limitOnly
    ? []
    : webMode === "allowlist"
    ? profile?.allowedSites || []
    : profile?.blockedSites || [];
  const activeLimitBundleIds = uniqueStrings(activePhoneLimitBlocks.flatMap((block) => block.apps || []).filter(isLikelyIosBundleId));
  const activeLimitSites = uniqueStrings(activePhoneLimitBlocks.flatMap((block) => block.sites || []));
  const configuredProfilePatterns = !limitOnly && webMode !== "allowlist"
    ? profile?.blockedUrlPatterns || []
    : [];
  const profilePatterns = configuredProfilePatterns;
  const focusedSocialSettings = normalizeFocusedSocialSettings(settings.focusedSocial);
  const socialDeniedUrls = focusedSocialEnforcementActive
    ? focusedSocialDeniedUrls(focusedSocialSettings)
    : [];
  const includeFocusedSocialNativeApps = settings.blockApps
    && focusedSocialEnforcementActive
    && appMode !== "allowlist";
  const webClips = uniqueWebClips(focusedSocialLauncherWebClips());

  const deniedUrls = !settings.blockWeb
    ? []
    : enforcementActive && webMode === "allowlist"
    ? uniqueUrls(urlsFromPatterns(socialDeniedUrls)).slice(0, MAX_DENY_URLS)
    : uniqueUrls([
      ...urlsFromSiteTargets(profileSites),
      ...urlsFromSiteTargets(activeLimitSites),
      ...urlsFromPatterns(profilePatterns),
      ...urlsFromPatterns(socialDeniedUrls),
      ...(limitOnly ? [] : urlsFromSiteTargets(adultBlocklistPreloadDomains(state))),
      ...(limitOnly ? [] : settings.deniedUrls)
    ]).slice(0, MAX_DENY_URLS);
  let allowedUrls = !enforcementActive || !settings.blockWeb
    ? []
    : webMode === "allowlist"
    ? uniqueUrls([
      ...urlsFromSiteTargets(profileSites),
      ...settings.allowedUrls,
      ...IOS_SOCIAL_COMPANION_ALLOWED_URLS,
      ...webClips.map((clip) => clip.url)
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
    protectionActive,
    focusedSocialEnforcementActive,
    appBundleIds,
    deniedUrls,
    allowedUrls,
    webClips,
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
    protectionActive: false,
    focusedSocialEnforcementActive: false,
    appBundleIds: [],
    deniedUrls: [],
    allowedUrls: [],
    webClips: [],
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
  if ((settings.blockApps || targets.grayscale.settingsGuarded) && targets.appBundleIds.length) {
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
  if (!settings.blockWeb) return null;
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

function webClipPayloads(clips: readonly FocusedSocialWebClip[], identifierPrefix = IOS_PROFILE_IDENTIFIER): MobileConfigPayload[] {
  return (clips || []).map((clip) => commonPayload("com.apple.webClip.managed", clip.displayName || clip.label, `webclip.${clip.id}`, {
    URL: clip.url,
    Label: clip.label,
    FullScreen: true,
    IsRemovable: true,
    Precomposed: true,
    TargetApplicationBundleIdentifier: clip.targetApplicationBundleIdentifier,
    Icon: clip.iconPngBase64 ? plistData(clip.iconPngBase64) : undefined
  }, identifierPrefix));
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

function urlsFromPatterns(values: readonly unknown[]): string[] {
  return (values || []).flatMap(urlsFromInput);
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

function uniqueWebClips(values: ReadonlyArray<FocusedSocialWebClip>): FocusedSocialWebClip[] {
  const seen = new Set<string>();
  const output: FocusedSocialWebClip[] = [];
  for (const clip of values || []) {
    const key = String(clip.id || clip.url || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(clip);
  }
  return output;
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
