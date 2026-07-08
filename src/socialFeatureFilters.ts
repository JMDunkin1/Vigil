import { parseBoolean } from "./booleans.js";
import type { FocusedSocialPlatformId, FocusedSocialSettings, UnknownRecord } from "./types.js";

export type FocusedSocialFeatureKey =
  | "reels"
  | "explore"
  | "suggested"
  | "shopping"
  | "shorts"
  | "spotlight"
  | "stories"
  | "home"
  | "ads";

interface FocusedSocialFeatureDefinition {
  key: FocusedSocialFeatureKey;
  label: string;
  deniedUrls: string[];
  permanent?: boolean;
}

interface FocusedSocialPlatformDefinition {
  id: FocusedSocialPlatformId;
  label: string;
  nativeBundleId: string;
  webClip: {
    id: string;
    label: string;
    url: string;
  };
  features: FocusedSocialFeatureDefinition[];
}

export const FOCUSED_SOCIAL_PLATFORMS: FocusedSocialPlatformDefinition[] = [
  {
    id: "instagram",
    label: "Instagram",
    nativeBundleId: "com.burbn.instagram",
    webClip: {
      id: "instagram",
      label: "Sentinel Instagram",
      url: "https://www.instagram.com/direct/inbox/"
    },
    features: [
      {
        key: "reels",
        label: "Reels",
        deniedUrls: [
          "instagram.com/reel",
          "instagram.com/reels"
        ]
      },
      {
        key: "explore",
        label: "Explore",
        deniedUrls: [
          "instagram.com/explore"
        ]
      },
      {
        key: "suggested",
        label: "Suggested posts",
        deniedUrls: [
          "instagram.com/explore/people/suggested"
        ]
      },
      {
        key: "shopping",
        label: "Shopping and live",
        deniedUrls: [
          "instagram.com/shop",
          "instagram.com/shopping",
          "instagram.com/live"
        ]
      },
      {
        key: "ads",
        label: "Ads and sponsored posts",
        deniedUrls: []
      }
    ]
  },
  {
    id: "youtube",
    label: "YouTube",
    nativeBundleId: "com.google.ios.youtube",
    webClip: {
      id: "youtube",
      label: "Sentinel YouTube",
      url: "https://m.youtube.com/feed/subscriptions"
    },
    features: [
      {
        key: "shorts",
        label: "Shorts",
        permanent: true,
        deniedUrls: [
          "youtube.com/shorts",
          "m.youtube.com/shorts"
        ]
      },
      {
        key: "home",
        label: "Home recommendations",
        deniedUrls: [
          "youtube.com/feed/recommended",
          "m.youtube.com/feed/recommended"
        ]
      },
      {
        key: "explore",
        label: "Explore and trending",
        deniedUrls: [
          "youtube.com/feed/explore",
          "m.youtube.com/feed/explore",
          "youtube.com/feed/trending",
          "m.youtube.com/feed/trending"
        ]
      },
      {
        key: "suggested",
        label: "Suggested next",
        deniedUrls: [
          "youtube.com/results?search_query=shorts",
          "m.youtube.com/results?search_query=shorts"
        ]
      },
      {
        key: "ads",
        label: "Ads and sponsored posts",
        deniedUrls: []
      }
    ]
  },
  {
    id: "snapchat",
    label: "Snapchat",
    nativeBundleId: "com.toyopagroup.picaboo",
    webClip: {
      id: "snapchat",
      label: "Sentinel Snapchat",
      url: "https://web.snapchat.com/"
    },
    features: [
      {
        key: "spotlight",
        label: "Spotlight",
        permanent: true,
        deniedUrls: [
          "snapchat.com/spotlight",
          "web.snapchat.com/spotlight"
        ]
      },
      {
        key: "stories",
        label: "Stories",
        permanent: true,
        deniedUrls: [
          "snapchat.com/stories",
          "story.snapchat.com"
        ]
      }
    ]
  }
];

export const FOCUSED_SOCIAL_URL_PATTERNS = FOCUSED_SOCIAL_PLATFORMS.flatMap((platform) => (
  platform.features.flatMap((feature) => feature.deniedUrls)
));
const FOCUSED_SOCIAL_URL_PATTERN_KEYS = new Set(FOCUSED_SOCIAL_URL_PATTERNS.map(normalizePatternKey));

export const PERMANENT_SOCIAL_URL_PATTERNS = FOCUSED_SOCIAL_PLATFORMS.flatMap((platform) => (
  platform.features.flatMap((feature) => feature.permanent ? feature.deniedUrls : [])
));

export function defaultFocusedSocialSettings(): FocusedSocialSettings {
  return {
    enabled: true,
    forceWebClips: true,
    instagram: {
      enabled: true,
      reels: true,
      explore: true,
      suggested: true,
      shopping: true,
      ads: true
    },
    youtube: {
      enabled: true,
      shorts: true,
      home: true,
      explore: true,
      suggested: true,
      ads: true
    },
    snapchat: {
      enabled: true,
      spotlight: true,
      stories: true,
      explore: true,
      suggested: true,
      ads: true
    }
  };
}

export function normalizeFocusedSocialSettings(value: unknown = {}, existing: Partial<FocusedSocialSettings> = {}): FocusedSocialSettings {
  const defaults = defaultFocusedSocialSettings();
  const current = mergeFocusedSocialSettings(defaults, existing);
  const body = recordValue(value);
  return {
    enabled: body.enabled === undefined ? current.enabled !== false : parseBoolean(body.enabled, true),
    forceWebClips: body.forceWebClips === undefined ? current.forceWebClips !== false : parseBoolean(body.forceWebClips, true),
    instagram: normalizeInstagramSettings(recordValue(body.instagram), current.instagram, defaults.instagram),
    youtube: normalizeYoutubeSettings(recordValue(body.youtube), current.youtube, defaults.youtube),
    snapchat: normalizeSnapchatSettings(recordValue(body.snapchat), current.snapchat, defaults.snapchat)
  };
}

export function focusedSocialDeniedUrls(value: unknown): string[] {
  const settings = normalizeFocusedSocialSettings(value);
  const permanent = alwaysBannedSocialDeniedUrls();
  if (!settings.enabled) return permanent;
  return uniqueStrings(FOCUSED_SOCIAL_PLATFORMS.flatMap((platform) => {
    const platformSettings = settings[platform.id];
    if (!platformSettings.enabled) {
      return platform.features.flatMap((feature) => feature.permanent ? feature.deniedUrls : []);
    }
    return platform.features.flatMap((feature) => platformSettings[feature.key] === false ? [] : feature.deniedUrls);
  }).concat(permanent));
}

export function alwaysBannedSocialDeniedUrls(): string[] {
  return uniqueStrings(PERMANENT_SOCIAL_URL_PATTERNS);
}

export function withoutFocusedSocialDeniedUrls(values: readonly unknown[]): string[] {
  return (values || []).filter((value) => {
    const key = normalizePatternKey(value);
    return Boolean(key && !FOCUSED_SOCIAL_URL_PATTERN_KEYS.has(key));
  }).map((value) => String(value).trim());
}

export function focusedSocialBrowserCleanupEnabled(value: unknown): boolean {
  const settings = normalizeFocusedSocialSettings(value);
  return Boolean(settings.enabled && (settings.instagram.enabled || settings.youtube.enabled || settings.snapchat.enabled));
}

export function focusedSocialBrowserCleanupSettings(value: unknown): FocusedSocialSettings {
  return normalizeFocusedSocialSettings(value);
}

export function focusedSocialBlockedBundleIds(value: unknown): string[] {
  const settings = normalizeFocusedSocialSettings(value);
  if (!settings.enabled || !settings.forceWebClips) return [];
  return FOCUSED_SOCIAL_PLATFORMS
    .filter((platform) => settings[platform.id].enabled)
    .map((platform) => platform.nativeBundleId);
}

export function focusedSocialWebClips(value: unknown): Array<{ id: string; label: string; url: string }> {
  const settings = normalizeFocusedSocialSettings(value);
  if (!settings.enabled || !settings.forceWebClips) return [];
  return FOCUSED_SOCIAL_PLATFORMS
    .filter((platform) => settings[platform.id].enabled)
    .map((platform) => ({ ...platform.webClip }));
}

export function focusedSocialSummary(
  value: unknown,
  options: {
    includeDeniedUrls?: boolean;
    includeNativeApps?: boolean;
    includeWebClips?: boolean;
  } = {}
) {
  const settings = normalizeFocusedSocialSettings(value);
  const includeDeniedUrls = options.includeDeniedUrls !== false;
  const includeNativeApps = options.includeNativeApps !== false;
  const includeWebClips = options.includeWebClips !== false;
  const platforms = FOCUSED_SOCIAL_PLATFORMS.map((platform) => {
    const platformSettings = settings[platform.id];
    const features = platform.features.filter((feature) => platformSettings[feature.key] !== false);
    return {
      id: platform.id,
      label: platform.label,
      enabled: Boolean(platformSettings.enabled),
      nativeBundleId: platform.nativeBundleId,
      webClip: platform.webClip,
      features: platformSettings.enabled ? features.map((feature) => feature.label) : [],
      deniedUrlCount: platformSettings.enabled && includeDeniedUrls ? features.reduce((total, feature) => total + feature.deniedUrls.length, 0) : 0
    };
  });
  const enabledPlatforms = platforms.filter((platform) => platform.enabled);
  return {
    enabled: settings.enabled,
    forceWebClips: settings.forceWebClips,
    deniedUrlCount: includeDeniedUrls ? focusedSocialDeniedUrls(settings).length : 0,
    nativeAppBundleCount: includeNativeApps ? focusedSocialBlockedBundleIds(settings).length : 0,
    webClipCount: includeWebClips ? focusedSocialWebClips(settings).length : 0,
    platforms,
    platformCount: enabledPlatforms.length,
    featureCount: enabledPlatforms.reduce((total, platform) => total + platform.features.length, 0)
  };
}

function mergeFocusedSocialSettings(defaults: FocusedSocialSettings, existing: Partial<FocusedSocialSettings>): FocusedSocialSettings {
  return {
    enabled: existing.enabled === undefined ? defaults.enabled : Boolean(existing.enabled),
    forceWebClips: existing.forceWebClips === undefined ? defaults.forceWebClips : Boolean(existing.forceWebClips),
    instagram: {
      ...defaults.instagram,
      ...(recordValue(existing.instagram) as Partial<FocusedSocialSettings["instagram"]>)
    },
    youtube: {
      ...defaults.youtube,
      ...(recordValue(existing.youtube) as Partial<FocusedSocialSettings["youtube"]>)
    },
    snapchat: {
      ...defaults.snapchat,
      ...(recordValue(existing.snapchat) as Partial<FocusedSocialSettings["snapchat"]>)
    }
  };
}

function normalizeInstagramSettings(
  body: UnknownRecord,
  current: FocusedSocialSettings["instagram"],
  defaults: FocusedSocialSettings["instagram"]
): FocusedSocialSettings["instagram"] {
  return {
    enabled: body.enabled === undefined ? current.enabled !== false : parseBoolean(body.enabled, defaults.enabled),
    reels: body.reels === undefined ? current.reels !== false : parseBoolean(body.reels, defaults.reels),
    explore: body.explore === undefined ? current.explore !== false : parseBoolean(body.explore, defaults.explore),
    suggested: body.suggested === undefined ? current.suggested !== false : parseBoolean(body.suggested, defaults.suggested),
    shopping: body.shopping === undefined ? current.shopping !== false : parseBoolean(body.shopping, defaults.shopping),
    ads: body.ads === undefined ? current.ads !== false : parseBoolean(body.ads, defaults.ads)
  };
}

function normalizeYoutubeSettings(
  body: UnknownRecord,
  current: FocusedSocialSettings["youtube"],
  defaults: FocusedSocialSettings["youtube"]
): FocusedSocialSettings["youtube"] {
  return {
    enabled: body.enabled === undefined ? current.enabled !== false : parseBoolean(body.enabled, defaults.enabled),
    shorts: true,
    home: body.home === undefined ? current.home !== false : parseBoolean(body.home, defaults.home),
    explore: body.explore === undefined ? current.explore !== false : parseBoolean(body.explore, defaults.explore),
    suggested: body.suggested === undefined ? current.suggested !== false : parseBoolean(body.suggested, defaults.suggested),
    ads: body.ads === undefined ? current.ads !== false : parseBoolean(body.ads, defaults.ads)
  };
}

function normalizeSnapchatSettings(
  body: UnknownRecord,
  current: FocusedSocialSettings["snapchat"],
  defaults: FocusedSocialSettings["snapchat"]
): FocusedSocialSettings["snapchat"] {
  return {
    enabled: body.enabled === undefined ? current.enabled !== false : parseBoolean(body.enabled, defaults.enabled),
    spotlight: true,
    stories: true,
    explore: body.explore === undefined ? current.explore !== false : parseBoolean(body.explore, defaults.explore),
    suggested: body.suggested === undefined ? current.suggested !== false : parseBoolean(body.suggested, defaults.suggested),
    ads: body.ads === undefined ? current.ads !== false : parseBoolean(body.ads, defaults.ads)
  };
}

function recordValue(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {};
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
  return output;
}

function normalizePatternKey(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}
