import { randomBytes, randomUUID } from "node:crypto";
import {
  APP_NAME,
  DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS,
  DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
  SOFT_BLOCK_PROFILE_ID,
  defaultState
} from "./defaults.js";
import { parseBoolean } from "./booleans.js";
import { grayscaleDecision, IOS_GRAYSCALE_GUARD_BUNDLE_IDS } from "./grayscale.js";
import { toPlist } from "./plist.js";
import { activePolicy, baselinePolicy, expandSiteTargets, profileById } from "./policy.js";
import type { IosSettings, SentinelState, UnknownRecord } from "./types.js";

export const IOS_PROFILE_IDENTIFIER = "com.local-screen-time.ios-lock";
const MAX_DENY_URLS = 500;
const IOS_BUNDLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;
const SOFT_BLOCK_WEB_CLIPS = [
  {
    id: "instagram",
    label: "Sentinel Instagram",
    url: "https://www.instagram.com/direct/inbox/"
  }
];

interface IosPolicyTargets {
  profileName: string;
  appMode: string;
  webMode: string;
  appBundleIds: string[];
  deniedUrls: string[];
  allowedUrls: string[];
  webClips: Array<{ id: string; label: string; url: string }>;
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
    blockedAppBundleIds: normalizeBundleIds(body.blockedAppBundleIds ?? body.blockedApps ?? current.blockedAppBundleIds ?? DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS),
    allowedAppBundleIds: normalizeBundleIds(body.allowedAppBundleIds ?? body.allowedApps ?? current.allowedAppBundleIds ?? DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS),
    deniedUrls: normalizeUrlList(body.deniedUrls ?? current.deniedUrls ?? []),
    allowedUrls: normalizeUrlList(body.allowedUrls ?? current.allowedUrls ?? [])
  };

  if (next.hardenRemoval && !next.removalPassword) next.removalPassword = randomRemovalPassword();
  if (!next.blockedAppBundleIds.length) next.blockedAppBundleIds = [...DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS];
  if (!next.allowedAppBundleIds.length) next.allowedAppBundleIds = [...DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS];
  return next;
}

export function iosProfileSummary(state: SentinelState, now = new Date()) {
  const settings = currentIosSettings(state);
  const active = Boolean(settings.enabled);
  const targets = active ? iosPolicyTargets(state, now) : disabledPolicyTargets(settings);
  return {
    enabled: active,
    supported: true,
    status: active ? "supervised-policy-enabled" : "ready",
    note: active
      ? "Desktop-generated supervised iPhone profile is ready to install."
      : "Enable this to generate a supervised iPhone policy profile.",
    supervisedRequired: true,
    removalHardened: Boolean(active && settings.hardenRemoval && settings.removalPassword),
    restrictInstallAndErase: Boolean(settings.restrictInstallAndErase),
    mode: settings.mode,
    webMode: settings.webMode,
    blockApps: Boolean(settings.blockApps),
    blockWeb: Boolean(settings.blockWeb),
    blockedAppBundleIds: settings.blockedAppBundleIds,
    allowedAppBundleIds: settings.allowedAppBundleIds,
    deniedUrls: settings.deniedUrls,
    allowedUrls: settings.allowedUrls,
    profile: {
      identifier: IOS_PROFILE_IDENTIFIER,
      fileName: "sentinel-iphone-lock.mobileconfig",
      downloadPath: "/api/devices/ios/profile.mobileconfig",
      generatedFrom: targets.profileName,
      appBundleCount: targets.appBundleIds.length,
      deniedUrlCount: targets.deniedUrls.length,
      allowedUrlCount: targets.allowedUrls.length,
      webClipCount: targets.webClips.length,
      grayscale: targets.grayscale,
      lastGeneratedAt: settings.lastGeneratedAt || null
    }
  };
}

export function ensureIosRemovalPassword(state: SentinelState): boolean {
  if (state.deviceControls.ios.hardenRemoval === false) return false;
  if (state.deviceControls.ios.removalPassword) return false;
  state.deviceControls.ios.removalPassword = randomRemovalPassword();
  return true;
}

export function markIosProfileGenerated(state: SentinelState, at = new Date()): void {
  state.deviceControls.ios.lastGeneratedAt = at.toISOString();
}

export function publicIosSettings(ios: Partial<IosSettings> = {}) {
  const { removalPassword, ...rest } = ios || {};
  return {
    ...rest,
    removalPasswordSet: Boolean(removalPassword)
  };
}

export function buildIosConfigurationProfile(state: SentinelState, now = new Date()): string {
  const settings = currentIosSettings(state);
  const active = Boolean(settings.enabled);
  const targets = active ? iosPolicyTargets(state, now) : disabledPolicyTargets(settings);
  const payloads: MobileConfigPayload[] = [];

  const restrictions = restrictionsPayload(settings, targets);
  if (restrictions) payloads.push(restrictions);

  const webFilter = webContentFilterPayload(settings, targets);
  if (webFilter) payloads.push(webFilter);
  payloads.push(...webClipPayloads(settings, targets));

  if (active && settings.hardenRemoval && settings.removalPassword) {
    payloads.push(commonPayload("com.apple.profileRemovalPassword", "Profile Removal Password", "removal-password", {
      RemovalPassword: settings.removalPassword
    }));
  }

  const profile = {
    PayloadContent: payloads,
    PayloadDescription: active
      ? "Locks distracting iPhone apps and websites using supervised Apple device-management restrictions generated by Sentinel."
      : "Disabled Sentinel iPhone policy profile with no app or web restrictions.",
    PayloadDisplayName: "Sentinel iPhone Lock",
    PayloadIdentifier: IOS_PROFILE_IDENTIFIER,
    PayloadOrganization: APP_NAME,
    PayloadRemovalDisallowed: Boolean(active && settings.hardenRemoval),
    PayloadType: "Configuration",
    PayloadUUID: randomUUID(),
    PayloadVersion: 1
  };

  return toPlist(profile);
}

export function iosPolicyTargets(state: SentinelState, now = new Date()): IosPolicyTargets {
  const settings = currentIosSettings(state);
  const policy = activePolicy(state, now, { device: "phone" }) || baselinePolicy(state, now, { device: "phone" });
  const profile = policy?.profile
    || profileById(state, settings.profileId || state.settings.activeProfileId)
    || state.profiles?.[0]
    || null;

  const profileName = policy?.session?.title || profile?.name || "Saved iPhone policy";
  const appMode = profile?.mode === "allowlist" ? "allowlist" : settings.mode;
  const webMode = profile?.mode === "allowlist" ? "allowlist" : settings.webMode;
  let appBundleIds = profile?.phoneAppBlocking === false
    ? []
    : appMode === "allowlist"
    ? settings.allowedAppBundleIds
    : settings.blockedAppBundleIds;
  const grayscale = grayscaleDecision(state, now, { device: "phone" });
  const settingsGuarded = Boolean(grayscale.desired && state.grayscale?.preventManualChanges !== false);
  if (settingsGuarded) {
    appBundleIds = appMode === "allowlist"
      ? appBundleIds.filter((bundleId) => !IOS_GRAYSCALE_GUARD_BUNDLE_IDS.includes(bundleId))
      : uniqueStrings([...appBundleIds, ...IOS_GRAYSCALE_GUARD_BUNDLE_IDS]);
  }

  const profileSites = webMode === "allowlist"
    ? profile?.allowedSites || []
    : profile?.blockedSites || [];
  const profilePatterns = webMode === "allowlist"
    ? []
    : profile?.blockedUrlPatterns || [];

  const deniedUrls = webMode === "allowlist"
    ? []
    : uniqueUrls([
      ...urlsFromSiteTargets(profileSites),
      ...urlsFromPatterns(profilePatterns),
      ...settings.deniedUrls
    ]).slice(0, MAX_DENY_URLS);
  const allowedUrls = webMode === "allowlist"
    ? uniqueUrls([
      ...urlsFromSiteTargets(profileSites),
      ...settings.allowedUrls
    ])
    : uniqueUrls(settings.allowedUrls);

  return {
    profileName,
    appMode,
    webMode,
    appBundleIds,
    deniedUrls,
    allowedUrls,
    webClips: profile?.id === SOFT_BLOCK_PROFILE_ID ? SOFT_BLOCK_WEB_CLIPS : [],
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

export function normalizeUrlList(values: unknown): string[] {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  return uniqueUrls(source.flatMap(urlsFromInput));
}

function currentIosSettings(state: SentinelState): IosSettings {
  return normalizeIosSettings({
    enabled: state.deviceControls?.ios?.enabled,
    mode: state.deviceControls?.ios?.mode,
    webMode: state.deviceControls?.ios?.webMode,
    blockApps: state.deviceControls?.ios?.blockApps,
    blockWeb: state.deviceControls?.ios?.blockWeb,
    hardenRemoval: state.deviceControls?.ios?.hardenRemoval,
    restrictInstallAndErase: state.deviceControls?.ios?.restrictInstallAndErase,
    blockedAppBundleIds: state.deviceControls?.ios?.blockedAppBundleIds,
    allowedAppBundleIds: state.deviceControls?.ios?.allowedAppBundleIds,
    deniedUrls: state.deviceControls?.ios?.deniedUrls,
    allowedUrls: state.deviceControls?.ios?.allowedUrls
  }, state.deviceControls?.ios || {});
}

function disabledPolicyTargets(settings: IosSettings): IosPolicyTargets {
  return {
    profileName: "iPhone blocking disabled",
    appMode: settings.mode,
    webMode: settings.webMode,
    appBundleIds: [],
    deniedUrls: [],
    allowedUrls: [],
    webClips: [],
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
  const restrictions: UnknownRecord = {};
  if ((settings.blockApps || targets.grayscale.settingsGuarded) && targets.appBundleIds.length) {
    if (targets.appMode === "allowlist") restrictions.allowListedAppBundleIDs = targets.appBundleIds;
    else restrictions.blockedAppBundleIDs = targets.appBundleIds;
  }

  if (settings.restrictInstallAndErase) {
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
  const content: UnknownRecord & {
    AutoFilterEnabled: boolean;
    FilterType: string;
    AllowListBookmarks?: Array<{ Title: string; URL: string }>;
    DenyListURLs?: string[];
  } = {
    AutoFilterEnabled: true,
    FilterType: "BuiltIn"
  };

  if (targets.webMode === "allowlist") {
    content.AllowListBookmarks = targets.allowedUrls.map((url: string) => ({
      Title: bookmarkTitle(url),
      URL: url
    }));
  } else {
    content.DenyListURLs = targets.deniedUrls;
  }

  if (!content.DenyListURLs?.length && !content.AllowListBookmarks?.length) return null;
  return commonPayload("com.apple.webcontent-filter", "iPhone Web Filter", "web-filter", content);
}

function webClipPayloads(settings: IosSettings, targets: IosPolicyTargets): MobileConfigPayload[] {
  if (!settings.enabled) return [];
  if (!settings.blockWeb) return [];
  return (targets.webClips || []).map((clip) => commonPayload("com.apple.webClip.managed", clip.label, `webclip.${clip.id}`, {
    URL: clip.url,
    Label: clip.label,
    FullScreen: true,
    IsRemovable: true
  }));
}

function commonPayload(type: string, name: string, suffix: string, values: UnknownRecord = {}): MobileConfigPayload {
  return {
    ...values,
    PayloadDescription: `${name} generated by ${APP_NAME}.`,
    PayloadDisplayName: name,
    PayloadIdentifier: `${IOS_PROFILE_IDENTIFIER}.${suffix}`,
    PayloadType: type,
    PayloadUUID: randomUUID(),
    PayloadVersion: 1
  };
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
  const suffix = stripped.endsWith("/") ? stripped : stripped.includes("/") ? stripped : `${stripped}/`;
  return [`https://${suffix}`, `http://${suffix}`];
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
  return output.sort((a, b) => a.localeCompare(b));
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
