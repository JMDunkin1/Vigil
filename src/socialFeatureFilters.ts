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
  /**
   * A harmless, same-origin URL used by the fixed iOS companion to determine
   * whether this individual feature is active in the managed web filter. The
   * service page never navigates here; it only issues a credentialed HEAD
   * request. Query-specific probes let DOM cleanup mirror each toggle instead
   * of collapsing every option into one platform-wide "soft" state.
   */
  probeUrls?: string[];
  permanent?: boolean;
}

interface FocusedSocialPlatformDefinition {
  id: FocusedSocialPlatformId;
  label: string;
  nativeBundleId: string;
  features: FocusedSocialFeatureDefinition[];
}

export const IOS_SOCIAL_COMPANION_BUNDLE_IDS = {
  instagram: "tech.caseline.vigil.instagram",
  youtube: "tech.caseline.vigil.youtube"
} as const satisfies Partial<Record<FocusedSocialPlatformId, string>>;

export const IOS_SOCIAL_COMPANION_APPS = [
  { id: "instagram", label: "Instagram", bundleId: IOS_SOCIAL_COMPANION_BUNDLE_IDS.instagram },
  { id: "youtube", label: "YouTube", bundleId: IOS_SOCIAL_COMPANION_BUNDLE_IDS.youtube }
] as const;

export const FOCUSED_SOCIAL_PLATFORMS: FocusedSocialPlatformDefinition[] = [
  {
    id: "instagram",
    label: "Instagram",
    nativeBundleId: "com.burbn.instagram",
    features: [
      {
        key: "reels",
        label: "Reels",
        permanent: true,
        probeUrls: ["https://www.instagram.com/?__vigil_feature=reels"],
        // Permanently remove Instagram's unbounded Reels destination while
        // retaining singular /reel/{id} links shared in Direct messages.
        deniedUrls: [
          "instagram.com/reels"
        ]
      },
      {
        key: "explore",
        label: "Search discovery media",
        probeUrls: ["https://www.instagram.com/?__vigil_feature=explore"],
        // Instagram serves both account search and its unbounded discovery
        // grid from /explore. Keep the route reachable so the companion can
        // preserve account lookup while its DOM policy removes posts, Reels,
        // tags, audio, and places. The probe still tells the companion when
        // Focused filtering can be active without denying the shared search route itself.
        deniedUrls: []
      },
      {
        key: "suggested",
        label: "Suggested posts",
        probeUrls: ["https://www.instagram.com/?__vigil_feature=suggested"],
        deniedUrls: [
          "instagram.com/explore/people/suggested"
        ]
      },
      {
        key: "shopping",
        label: "Shopping and live",
        probeUrls: ["https://www.instagram.com/?__vigil_feature=shopping"],
        deniedUrls: [
          "instagram.com/shop",
          "instagram.com/shopping",
          "instagram.com/live"
        ]
      },
      {
        key: "ads",
        label: "Ads and sponsored posts",
        probeUrls: ["https://www.instagram.com/?__vigil_feature=ads"],
        deniedUrls: []
      }
    ]
  },
  {
    id: "youtube",
    label: "YouTube",
    nativeBundleId: "com.google.ios.youtube",
    features: [
      {
        key: "shorts",
        label: "Shorts",
        permanent: true,
        deniedUrls: [
          "youtube.com/shorts",
          "youtube.com/shorts/",
          "m.youtube.com/shorts",
          "m.youtube.com/shorts/"
        ]
      },
      {
        key: "home",
        label: "Home recommendations",
        probeUrls: [
          "https://www.youtube.com/?__vigil_feature=home",
          "https://m.youtube.com/?__vigil_feature=home"
        ],
        deniedUrls: [
          "youtube.com/feed/recommended",
          "m.youtube.com/feed/recommended"
        ]
      },
      {
        key: "explore",
        label: "Explore and trending",
        probeUrls: [
          "https://www.youtube.com/?__vigil_feature=explore",
          "https://m.youtube.com/?__vigil_feature=explore"
        ],
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
        probeUrls: [
          "https://www.youtube.com/?__vigil_feature=suggested",
          "https://m.youtube.com/?__vigil_feature=suggested"
        ],
        deniedUrls: [
          "youtube.com/results?search_query=shorts",
          "m.youtube.com/results?search_query=shorts"
        ]
      },
      {
        key: "ads",
        label: "Ads and sponsored posts",
        probeUrls: [
          "https://www.youtube.com/?__vigil_feature=ads",
          "https://m.youtube.com/?__vigil_feature=ads"
        ],
        deniedUrls: []
      }
    ]
  },
  {
    id: "snapchat",
    label: "Snapchat",
    nativeBundleId: "com.toyopagroup.picaboo",
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
  platform.features.flatMap(featureUrls)
));
const FOCUSED_SOCIAL_URL_PATTERN_KEYS = new Set([
  ...FOCUSED_SOCIAL_URL_PATTERNS.map(normalizePatternKey),
  // Retain the former whole-Explore rule as a migration cleanup key. New
  // profiles do not deny it because /explore is also Instagram's account
  // search route, but an older persisted copy must not survive normalization.
  normalizePatternKey("instagram.com/explore"),
  // Earlier releases denied singular Reel permalinks. Remove that legacy rule
  // so Direct-message shares can open while the plural destination stays off.
  normalizePatternKey("instagram.com/reel")
]);

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
    return platform.features.flatMap((feature) => platformSettings[feature.key] === false ? [] : featureUrls(feature));
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
  return FOCUSED_SOCIAL_PLATFORMS
    .filter((platform) => shouldUseManagedCompanionPath(settings, platform))
    .map((platform) => platform.nativeBundleId);
}

function shouldUseManagedCompanionPath(settings: FocusedSocialSettings, platform: FocusedSocialPlatformDefinition): boolean {
  return Boolean(
    settings.enabled
    && settings.forceWebClips
    && settings[platform.id].enabled
    && IOS_SOCIAL_COMPANION_BUNDLE_IDS[platform.id as keyof typeof IOS_SOCIAL_COMPANION_BUNDLE_IDS]
  );
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
  const platforms = FOCUSED_SOCIAL_PLATFORMS.map((platform) => {
    const platformSettings = settings[platform.id];
    const features = platform.features.filter((feature) => platformSettings[feature.key] !== false);
    return {
      id: platform.id,
      label: platform.label,
      enabled: Boolean(platformSettings.enabled),
      nativeBundleId: platform.nativeBundleId,
      companionBundleId: IOS_SOCIAL_COMPANION_BUNDLE_IDS[platform.id as keyof typeof IOS_SOCIAL_COMPANION_BUNDLE_IDS] || null,
      webClip: null,
      features: platformSettings.enabled ? features.map((feature) => feature.label) : [],
      deniedUrlCount: platformSettings.enabled && includeDeniedUrls ? features.reduce((total, feature) => total + featureUrls(feature).length, 0) : 0
    };
  });
  const enabledPlatforms = platforms.filter((platform) => platform.enabled);
  return {
    enabled: settings.enabled,
    companionAppsEnabled: settings.forceWebClips,
    /** @deprecated Compatibility alias for clients and states created before native companions replaced Web Clips. */
    forceWebClips: settings.forceWebClips,
    deniedUrlCount: includeDeniedUrls ? focusedSocialDeniedUrls(settings).length : 0,
    nativeAppBundleCount: includeNativeApps ? focusedSocialBlockedBundleIds(settings).length : 0,
    webClipCount: 0,
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

function featureUrls(feature: FocusedSocialFeatureDefinition): string[] {
  return feature.probeUrls?.length ? [...feature.deniedUrls, ...feature.probeUrls] : feature.deniedUrls;
}
