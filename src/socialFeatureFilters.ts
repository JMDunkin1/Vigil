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

export interface FocusedSocialWebClip {
  id: string;
  label: string;
  displayName: string;
  url: string;
  iconPngBase64: string;
  targetApplicationBundleIdentifier: string;
}

interface FocusedSocialPlatformDefinition {
  id: FocusedSocialPlatformId;
  label: string;
  nativeBundleId: string;
  webClip: FocusedSocialWebClip;
  features: FocusedSocialFeatureDefinition[];
}

const FOCUSED_SOCIAL_WEB_CLIP_ICONS: Record<FocusedSocialPlatformId, string> = {
  instagram: "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAFHklEQVR42u3dv2qTURjH8dOXZOniDbjp5iodA4XegC5anEQcvAAnB+3g5AU4iHSS4OIVCIWO4urUdvMGXLqkUAdbTEvavH+T8+fznaQUJCff/PI85zzv6cbTR0fnAa35fOelRYiIyhKA0JDOhAYILZ1BaBAa0pnQAKGlMwgNEFo6ExogNEBo5QYIDRAahIZyg9AAoQFCKzdAaBAaIDRAaPUzCA0QGoQGCA0QGiA0QOhgy47QAKEBQgOEBggNQgOEBggNEBqEBggNEBogNEBolMnIEvxj+u3+7OpPDpJ7DafPt8eEJnE2bO4fzEqXe0TiPClV7hGRy5G7BLErMpcnNqHJTGolB5GVIBKazNKa0GQmdZZCk5nUTgrn2H18PE71wpkSdjCKErpLOi8SOSR67N1W7M39g1kOTeLG00dH56XKXFfk1K4F65LWqUs9KlHmHBJ5qNIj9aSu1MkIdjnSTOe2Mr/486moxjDlBrOSzJDQAKHXV270kc6plB2l72tL6IzwCFYBQqudCW1mI+Gyo8+UTrHsqKSz0kNCF0wqzeHp8+3xIrFv+nkwnARpLaGlNAgNKDlWkNK3jZXW2SGwb0zokNPpmqu7lBxR1tKb+wezPuaQPUZF6OxmHkhN6JDbiSWpCZ3d8TupCZ3dLAmpCZ3dYBSpCZ3dlB+pCZ3dNWOkDg5WQqTDQeSU0Mml821jmm1HOH0QJPTKOdx6fyHqTnj44Pug99FhQUK/+v01vPr91UoMwM9fOxZhXSUHqbuXG//TuZnUTcoPad6ghpbWV+lrLST1mmvoyzfy490ncaXlhy8X/3rb8PcXs/v6WW8iL0rnpk2k9B24KVyX2MtEHPr/OdwdDVJPL2sSsaJdjiHFXpW8TZhMzwZrEkkd0bbd/FdxW7ljFDisYeeD2JHtQzeRu3SJpXViByuL5C5N4smPN7NwsjduUn/PS60hjPCkcDI9C5NQdhrP19915JbUIb5Zjsn0bLBGau2c7NXfjrv3dtZmXZqks6fDB0zobCUeKLWH2A5ED0ITuUZKL0j262JPfrxRN69T6GJFPtkbXy8nOondUmTlRk9CS+QeEhtxNIVkbtEcBtfiRid01jsXiUl9uPV+bGIv1NoCraRy3FLPT/H9/LVjFPUGkS/XZUTkFTWJHWU2D1Jvzrwic6RJfbI3XvaelJrYt73uEZEjTOq5D0udQ5lSErvOh9fRVWxS35D8k+nZ0pPG+Tc8F7mbfgMRuk8Ju4hdo4SpI3UOcncpowg9VF1dR+4WdXgTqVOSu69egNAJNo1tpL4uziTTO0sIHdKd4It9em8dOzCEJnVWd4q4rDGjJ2RAaFITOhjdTFzqnB8sqOwgSOow0PVmhJbSg0ud+2NfamhJTejUrxcoVvQG6ZxiuSGhpbSEVkunKXUpVyZsnB+/Oy9K1BJ3SBquUarlRpklR2lJXdjrTT+hu7xpOad1yzVJOZ3zEXoFw/UlrEPqMucldB9frymL3fG15yBzCMZH7VcH23bBjEfI9M85E5rUZCY0qcmsKVQX9/qBz/WvCVSevvY0OqG9icmvQ67DSyO3G/lAE7qk241IrCnUPKYjcW7NoZNCdbamECA0gke1CA0QGoQGCA11NKEBQgOEBqEBQkNjSGiA0AChQWiA0AChAUIDhAahAUIDhAYIDRAahAYIjbTI5UowQkNCA4QGCA0QGgXfEU1oSGiA0AChoX4mNCQ0QGgoNwgNEBogNEorNwgNQkM6x8xfFLmB5cnOq3cAAAAASUVORK5CYII=",
  youtube: "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAADm0lEQVR42u3dUW7iShRF0aoSc8DzHx0eBf1FK4oIAhvbVcdr/T/1E945uk1IupaD3W63eyHGNE31yD+/CpikwOvREV+vV089yDzPh8Zd9w5ZwALfMuy6R8gi5lncW4RdhUxS2FXIJIVdvxmzkFkb9tqom5g52s921r6tW4VM0lo3MZO01k3MJEXdxExS1E3MJEXdlv4BsHfUXwn68ZUhZo6O+p2VbmImKermc8uM5lWbzd1M0j3dnBoknR7NS0SSZp1JWmkLTe5CW2dGX2kLTeZCW2cSVtpCk/0uBwwftHODlLPDQuPkAEHDDqr7mRL06w8sNE4OEDQIGgSNoEHQIGgQNAgaQYOgQdAgaBA0p3IZ9v+8Vk9va/e7oAUc5PdrPkDgFyHz8bPoOOyLkEkKu4mZpOd08QKRtNZNzCQ9v+bFIOk5Ni8CSc+ziZmk5+pb3xSf5bDOdPp8m5hJes5ODpwc1plen7eFxkJbZ3p97hYaCw2Chqig0+7nAX/e7gx3tIVeG7WwnRx+OhpBW2sELWxBI2xB474WtLVG0MJG0MIWNO5rQWOtBY2wBe0MQdDWWtAIW9AIW9C4rwVtrRG0sAWNsAWN+1rQWOtyyn8ameJXrVloMVtohCxohCxohOyGFjMWWsiCRsiCRshuaDFjoYWMoIXs5EDMFhohC1rICFrIbmjEbKERsqCFjKCFjBtazBYaIVvoct7fGyHmLp+/kwMLDYKGuKD9/jX3s4WGnoO20tbZQkPPQVtp6xy30KIWs5MDeg7aSlvnuIUWtZjjTg5Riznuhha1mEva56EfL4qPZgo56l0Oay3muJ9YsdZCjvwRLGELOfJnCn+/mAIXcNQPybqz8a1vBA2CBkGDoEHQCBoEDYIGQYOgETQIGgQNS4KepqmWUso8z14NhvRod5qmaqFxcoCgYa+g3dEk3M8WGicHDBG0s4PRzw0LTfbJYaUZeZ0tNPl/KbTSjLrOFppzvG1npRlxnd9aaFHTW8yLvrHy11cAHO1Vm+2d/9BK0/up8fbJIWpGifnjdzlETY9388dB//zKEDVHxPzu3+nakkNc1PQY88cnh6jpOeZF3ykUNb3GXEopq95rvt1u//8pquv16mlwWMhf+SyHtaanmFcv9LOlttYsfUvuG9+d/uq3t4XNUSFvErSwOSrkTYP+K2xxi3jrD77t8om6Z2EL/Hzfqt7jE5y7f0T0VdyUU33UMyJogQt4S/8AoFLHN31SLtQAAAAASUVORK5CYII=",
  snapchat: "iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAYAAAA9zQYyAAAE60lEQVR42u3da26bUBBAYYxYQi11/6uLRJYQyf3lKnUdA+Z1Z+Y7C4jhcnIYY4wvt6/ubG4dMnE588UHAmPn43vJKDSJCX6I3AORcYLcl2hCExmniD0QGZnEHoiMTGL3ZEbDV0gOF5rMaErqgcjINIL0ZEamWvdkRiapezIjk9Q9mZFJ6t46IRO9OiNTpXsyI5PUPZmRSWozNErM0OqMkJVWaKQvtDojbKUVGqkLrc4IXWmFRtpCqzPCV1qhUe5eDiCc0MYNpBg7FBpGDoDQwEFCm5+RZo5WaBg5AEIDhAYIDUIDhAYIDRAaIDQqMliC97j+/rX7a4wfnxZ6IZfbl3s5WhGY4IROLzG5CZ1aZGITOqXIxCb0pjKP47j/Nl2vpCb0fjIfIfFauatLXVroOSKfKfEauauKXVboKZlbFHmp2BWl7skcU+Y52xn5Ta5CbyBzFJGX1rpSqXsyx5d5avsrldrNSQlkzrYfhF5R52wS/LQ/VSrdk7nOGaeC1D2ZO1ITGiC0Oqs0oV0JsL+ELvopmfUpVuiq12kr7bc3hSC006l1IrTTrv0nNEBoEDr3XOgutJ/XIdscrdAgNEBogNAAoUFogNAAoQFCA4QGoQFCA4QGCA0QGoQGCA0QGiA0UEfoZ78nsvQHLLPybB2y/f6KQoPQAKED/Pqq/Sd0mDkaNdbJyAFCO+3ab0I7nVofQquV/fWwxskKVTnIP+3n93XxsMbGZR7H0RP8C69Xn/WxsfeDVLXSU3W+y2zkaLw2pF4uc6ZK99kf8F1N6qplTiX0q4M0pz5ZpJ7aj7XrROjGSv3q2mt0qV9t//jxmb7Mdy63r+6Wtc7PDvr94Gb5CbSpf8SlMt/XSKGTlDpSrbeW2QwdqM5LP/q9Xq/Nij1n296tbPRZeui6ej9tdj+tfn/nP6eCZ5Zu7j/X46eA1X7SLuwMvfZgPc6KS6t0hChLzxBbyhx1li5X6Gel/j5vRr3pp3qZQxd6ywP2rESRZshn277n2nhTGOjTxEj3Cz99XEPhMoct9F4HbeqZFS1Ue2p79lqXSJUeOrx9avetEoVuss5zb4Zv8UsMR1x5iVRp3/qekKG1N4hHy6zQiercWqnn/HNVr/TgSULz3vzNuQfkLJn/2f5GPtlU6APq/JPE78rTmswvvzC80fq1Xumhaonn3KXWQqnX/HNVLHfzhV5a58d5eI18k/dN7yj2nq/9+LeXrm/LlR6qVnhtqec+A2TrN31bvNZ/19QT1bvpQr+q814Sb3Hpbsn27Pm3Vz+o58Xat1rpQYnnSzRXvj2uXR+1v9Hn7mYL/fepPidJfKSs0a6BP956S+gFC9jqqa3yvRwtH5vw3/rOJrcbkggdWnACExro3G0HQgOEBggNEBogNAgNEBogNEBogNAgNEBogNAAoQFCg9AAoYHjhL5YBiThotAwcgCEBg4U2hyN8POzQsPIAUQR2tiB0OOGQiP9yKHSCFtnhUaJN4UqjZB1VmiUuWyn0ghXZ4VGqQ9WVBqh6jyn0KRGGJnnjhykRgiZzdAoe3OSSqP5Oi8tNKnRtMzvjBykRrMyvztDkxpNytx1XTesfCG/QosmRN7qKodaoxmZt7psR2o0IfOakcMIgqZE3lpoYqOJs/uw84YSG4eOqcNBG05sHPJ+azhhR8hN4vBCv9pBghN4M/4A/OeI6wItlBUAAAAASUVORK5CYII="
};

const SNAPCHAT_PRODUCTION_ICON_PNG_BASE64 = "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";

export const IOS_SOCIAL_COMPANION_BUNDLE_IDS: Record<FocusedSocialPlatformId, string> = {
  instagram: "tech.caseline.sentinel.instagram",
  youtube: "tech.caseline.sentinel.youtube",
  snapchat: "tech.caseline.sentinel.snapchat"
};

export const FOCUSED_SOCIAL_PLATFORMS: FocusedSocialPlatformDefinition[] = [
  {
    id: "instagram",
    label: "Instagram",
    nativeBundleId: "com.burbn.instagram",
    webClip: {
      id: "instagram",
      label: "Instagram",
      displayName: "Instagram",
      url: "https://www.instagram.com/direct/inbox/",
      iconPngBase64: FOCUSED_SOCIAL_WEB_CLIP_ICONS.instagram,
      targetApplicationBundleIdentifier: IOS_SOCIAL_COMPANION_BUNDLE_IDS.instagram
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
      label: "YouTube",
      displayName: "YouTube",
      url: "https://m.youtube.com/feed/subscriptions",
      iconPngBase64: FOCUSED_SOCIAL_WEB_CLIP_ICONS.youtube,
      targetApplicationBundleIdentifier: IOS_SOCIAL_COMPANION_BUNDLE_IDS.youtube
    },
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
      label: "Snapchat",
      displayName: "Snapchat",
      url: "https://web.snapchat.com/",
      iconPngBase64: SNAPCHAT_PRODUCTION_ICON_PNG_BASE64,
      targetApplicationBundleIdentifier: IOS_SOCIAL_COMPANION_BUNDLE_IDS.snapchat
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
  return FOCUSED_SOCIAL_PLATFORMS
    .filter((platform) => shouldUseManagedWebPath(settings, platform))
    .map((platform) => platform.nativeBundleId);
}

export function focusedSocialWebClips(value: unknown): FocusedSocialWebClip[] {
  const settings = normalizeFocusedSocialSettings(value);
  return FOCUSED_SOCIAL_PLATFORMS
    .filter((platform) => shouldUseManagedWebPath(settings, platform))
    .map((platform) => ({ ...platform.webClip }));
}

export function focusedSocialLauncherWebClips(): FocusedSocialWebClip[] {
  return FOCUSED_SOCIAL_PLATFORMS.map((platform) => ({ ...platform.webClip }));
}

function shouldUseManagedWebPath(settings: FocusedSocialSettings, platform: FocusedSocialPlatformDefinition): boolean {
  return Boolean(settings.enabled && settings.forceWebClips && settings[platform.id].enabled);
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
      webClip: publicWebClip(platform.webClip),
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

function publicWebClip(clip: FocusedSocialWebClip) {
  const { iconPngBase64, ...rest } = clip;
  void iconPngBase64;
  return rest;
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
