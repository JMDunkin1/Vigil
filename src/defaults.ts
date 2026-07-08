import type { DeviceTarget, VigilState } from "./types.js";
import { PERMANENT_SOCIAL_URL_PATTERNS, defaultFocusedSocialSettings } from "./socialFeatureFilters.js";

export const APP_NAME = "Vigil";
export const PORT = Number(process.env.VIGIL_PORT || process.env.VIGIL_PORT || 8787);
export const REQUIRED_EXTENSION_VERSION = "0.3.2";
export const DEFAULT_ADULT_BLOCKLIST_SOURCE_ID = "hagezi-nsfw";
export const DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT = 100;

export const BROWSERS = new Set([
  "Safari",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Arc",
  "Vivaldi",
  "Opera",
  "Orion"
]);

export const ALWAYS_ALLOWED_APPS = [
  "Finder",
  "System Settings",
  "System Preferences",
  "Activity Monitor",
  "Terminal",
  "iTerm2",
  "Codex",
  "Code",
  "Visual Studio Code",
  "Cursor",
  "loginwindow"
];

export const PROCESS_SWEEP_EXEMPT_APPS = [
  ...ALWAYS_ALLOWED_APPS,
  "AccessibilityUIServer",
  "AirPlayUIAgent",
  "BackgroundTaskManagementAgent",
  "CharacterPalette",
  "Codex Helper",
  "Codex Helper (GPU)",
  "Codex Helper (Plugin)",
  "Codex Helper (Renderer)",
  "ControlCenter",
  "ControlStrip",
  "CoreLocationAgent",
  "CoreServicesUIAgent",
  "Dock",
  "FolderActionsDispatcher",
  "Google Chrome Helper",
  "Google Chrome Helper (GPU)",
  "Google Chrome Helper (Renderer)",
  "identityservicesd",
  "imagent",
  "IMAutomaticHistoryDeletionAgent",
  "IMTransferAgent",
  "Keychain Circle Notification",
  "LinkedNotesUIService",
  "MobileDeviceUpdater",
  "NotificationCenter",
  "NowPlayingTouchUI",
  "PowerChime",
  "screencaptureui",
  "SkyComputerUseClient",
  "sociallayerd",
  "Spotlight",
  "System Events",
  "SystemUIServer",
  "TextInputMenuAgent",
  "TextInputSwitcher",
  "UIKitSystem",
  "universalAccessAuthWarn",
  "UniversalControl",
  "UserNotificationCenter",
  "WallpaperAgent",
  "WiFiAgent",
  "WindowManager"
];

export const STRICT_BYPASS_APPS = [
  "Activity Monitor",
  "System Settings",
  "System Preferences",
  "Script Editor",
  "Automator",
  "Shortcuts",
  "Console",
  "App Store",
  "Installer",
  "InstallAssistant",
  "Software Update",
  "SoftwareUpdateLauncher",
  "System Information",
  "Disk Utility",
  "Migration Assistant",
  "Boot Camp Assistant",
  "Apple Configurator",
  "Configurator",
  "Profile Manager",
  "Self Service",
  "Managed Software Center",
  "Setapp",
  "CleanMyMac X",
  "AppCleaner",
  "AppZapper",
  "LaunchControl",
  "Lingon X"
];

export const STRICT_NETWORK_BYPASS_APPS = [
  "Proxyman",
  "Charles",
  "HTTP Toolkit",
  "Wireshark",
  "Burp Suite",
  "mitmproxy",
  "Little Snitch Configuration",
  "Little Snitch Network Monitor",
  "LuLu",
  "Radio Silence",
  "TripMode",
  "AdGuard",
  "AdGuard VPN",
  "NextDNS",
  "DNSCrypt-Proxy",
  "Tailscale",
  "Cloudflare WARP",
  "WARP",
  "1.1.1.1",
  "WireGuard",
  "OpenVPN Connect",
  "Viscosity",
  "NordVPN",
  "ExpressVPN",
  "Surfshark",
  "Proton VPN",
  "Mullvad VPN",
  "TunnelBear",
  "Private Internet Access",
  "Windscribe",
  "CyberGhost VPN",
  "Outline Client",
  "Outline Manager",
  "ClashX",
  "Clash Verge",
  "ShadowsocksX-NG",
  "Surge",
  "Privoxy"
];

export const STRICT_UNSUPPORTED_BROWSERS = [
  "Firefox",
  "Firefox Developer Edition",
  "Firefox Nightly",
  "LibreWolf",
  "Waterfox",
  "Tor Browser",
  "Mullvad Browser",
  "DuckDuckGo",
  "DuckDuckGo Browser",
  "Zen",
  "Zen Browser",
  "Floorp",
  "Chromium",
  "Ungoogled Chromium",
  "Min",
  "SigmaOS",
  "Dia"
];

export const STRICT_EMBEDDED_BROWSER_APPS = [
  "Discord",
  "Steam",
  "Epic Games Launcher",
  "Battle.net",
  "Roblox",
  "Roblox Studio",
  "Telegram",
  "WhatsApp",
  "Slack",
  "Microsoft Teams",
  "Teams",
  "MSTeams",
  "Notion",
  "Figma",
  "Obsidian",
  "Spotify",
  "Electron"
];

export const DEFAULT_BLOCKED_APPS = [
  "Discord"
];

export const DEFAULT_BLOCKED_SITES = [
  "youtube.com",
  "x.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "facebook.com",
  "threads.net",
  "snapchat.com",
  "pinterest.com",
  "discord.com"
];

export const DEFAULT_EXPLICIT_BLOCKED_SITES = [
  "pornhub.com",
  "xvideos.com",
  "xnxx.com",
  "xhamster.com",
  "redtube.com",
  "youporn.com",
  "spankbang.com",
  "onlyfans.com",
  "fansly.com",
  "chaturbate.com",
  "stripchat.com",
  "cam4.com",
  "adultfriendfinder.com",
  "brazzers.com"
];

const DEFAULT_EXPLICIT_SEARCH_TERMS = [
  "porn",
  "porno",
  "xxx",
  "nsfw",
  "hentai",
  "rule34",
  "gonewild",
  "onlyfans",
  "fansly",
  "chaturbate",
  "stripchat",
  "cam4",
  "redtube",
  "youporn",
  "spankbang",
  "xvideos",
  "xnxx",
  "xhamster",
  "18+",
  "18%2b",
  "18plus",
  "18-plus"
];

const DEFAULT_EXPLICIT_COMIC_SITE_TERMS = [
  "honeytoon",
  "honeytoons",
  "hooneytoon",
  "hooneytoons",
  "mawha"
];

const DEFAULT_EXPLICIT_COMIC_TERMS = [
  "manhwa",
  "mawha",
  "manhua",
  "webtoon",
  "webtoons"
];

const DEFAULT_EXPLICIT_COMIC_RISK_MARKERS = [
  "18",
  "18plus",
  "adult",
  "nsfw",
  "porn",
  "hentai",
  "lewd",
  "mature",
  "uncensored"
];

function combinedExplicitTerms(terms: readonly string[], markers: readonly string[]): string[] {
  return terms.flatMap((term) => markers.flatMap((marker) => [`${marker}${term}`, `${term}${marker}`]));
}

export const DEFAULT_EXPLICIT_URL_PATTERNS = [
  ...DEFAULT_EXPLICIT_SEARCH_TERMS,
  ...DEFAULT_EXPLICIT_COMIC_SITE_TERMS,
  ...combinedExplicitTerms(DEFAULT_EXPLICIT_COMIC_TERMS, DEFAULT_EXPLICIT_COMIC_RISK_MARKERS),
  "reddit.com/r/gonewild",
  "reddit.com/r/nsfw",
  "reddit.com/r/porn",
  "reddit.com/r/onlyfans",
  "reddit.com/r/fansly",
  "reddit.com/search?q=gonewild",
  "reddit.com/search/?q=gonewild",
  "reddit.com/search?q=nsfw",
  "reddit.com/search/?q=nsfw",
  "reddit.com/search?q=porn",
  "reddit.com/search/?q=porn",
  "reddit.com/search?q=onlyfans",
  "reddit.com/search/?q=onlyfans",
  "reddit.com/search?q=fansly",
  "reddit.com/search/?q=fansly"
];

export const DEFAULT_ALWAYS_BANNED_URL_PATTERNS = [
  ...PERMANENT_SOCIAL_URL_PATTERNS
];

export const DEFAULT_SHORT_FORM_URL_PATTERNS = [
  "facebook.com/reel",
  "facebook.com/watch/reel",
  "reddit.com/r/all",
  "reddit.com/r/popular",
  "x.com/explore",
  "twitter.com/explore",
  "snapchat.com/spotlight",
  "snapchat.com/stories",
  "story.snapchat.com",
  "tiktok.com"
];

export const DEFAULT_ALLOWED_APPS = [
  ...ALWAYS_ALLOWED_APPS,
  "Mail",
  "Calendar",
  "Notes",
  "Reminders",
  "Messages",
  "Safari",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Arc"
];

export const DEFAULT_ALLOWED_SITES = [
  "localhost",
  "127.0.0.1",
  "google.com",
  "docs.google.com",
  "drive.google.com",
  "github.com",
  "stackoverflow.com"
];

export const DEVICE_TARGETS: DeviceTarget[] = ["computer", "phone"];
export const NORMAL_PROFILE_ID = "normal";
export const SOFT_BLOCK_PROFILE_ID = "soft-block";
export const BRICK_MODE_PROFILE_ID = "brick-mode";
export const PANIC_LOCK_PROFILE_ID = "panic-lockout";

export const BRICK_ALLOWED_APPS = [
  ...ALWAYS_ALLOWED_APPS,
  "Mail",
  "Calendar",
  "Notes",
  "Reminders",
  "Messages",
  "FaceTime",
  "Contacts",
  "Maps",
  "Preview",
  "Calculator",
  "Dictionary",
  "Safari",
  "Google Chrome",
  "Microsoft Edge",
  "Brave Browser",
  "Arc"
];

export const BRICK_ALLOWED_SITES = [
  "localhost",
  "127.0.0.1",
  "icloud.com",
  "apple.com",
  "google.com",
  "docs.google.com",
  "drive.google.com",
  "github.com",
  "stackoverflow.com"
];

export const DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS = [
  "com.google.ios.youtube",
  "com.atebits.Tweetie2",
  "com.burbn.instagram",
  "com.zhiliaoapp.musically",
  "com.facebook.Facebook",
  "com.facebook.Messenger",
  "com.burbn.barcelona",
  "com.toyopagroup.picaboo",
  "com.hammerandchisel.discord",
  "com.pinterest"
];

export const DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS = [
  "com.apple.Preferences",
  "com.apple.mobilephone",
  "com.apple.MobileSMS",
  "com.apple.facetime",
  "com.apple.mobilemail",
  "com.apple.mobilesafari",
  "com.apple.camera",
  "com.apple.Maps",
  "com.apple.mobilenotes",
  "com.apple.reminders",
  "com.apple.mobilecal",
  "com.apple.Health",
  "com.apple.Passbook",
  "com.apple.shortcuts",
  "com.apple.DocumentsApp",
  "com.apple.weather",
  "com.apple.calculator",
  "com.apple.webapp"
];

export function defaultState(): VigilState {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: {
      pollIntervalMs: 3000,
      idleUsageTrackingEnabled: true,
      idleUsageThresholdSeconds: 120,
      strictByDefault: true,
      emergencyTokensPerWeek: 3,
      emergencyDelaySeconds: 45,
      panicLockDurationMinutes: 3,
      intentReasonEnabled: true,
      intentReasonMinLength: 20,
      focusSoundEnabled: false,
      focusSoundMode: "focus",
      focusSoundActivity: "deep-work",
      focusSoundPreset: "brown-noise",
      focusSoundIntensity: "medium",
      focusSoundTimerMode: "infinite",
      focusSoundTimerMinutes: 50,
      focusSoundBreakMinutes: 5,
      focusSoundVolume: 35,
      typingChallengeEnabled: true,
      interventionEnabled: true,
      interventionWindowMinutes: 10,
      interventionThreshold: 3,
      interventionExtraDelaySeconds: 45,
      interventionMaxExtraDelaySeconds: 300,
      intentionalUseEnabled: true,
      baselineDailyMinutes: 300,
      focusScoreGoal: 80,
      activeProfileId: "default",
      baselineProfileId: NORMAL_PROFILE_ID,
      foolproofModeEnabled: false,
      appQuitEscalationSeconds: 10,
      siteRedirectEnabled: true,
      contentFilterEnabled: true,
      adultBlocklistEnabled: true,
      adultBlocklistSourceId: DEFAULT_ADULT_BLOCKLIST_SOURCE_ID,
      adultBlocklistCustomUrl: "",
      adultBlocklistPreloadLimit: DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT,
      browserNoiseBlockingEnabled: true,
      appQuitEnabled: true,
      strictBypassProtectionEnabled: true,
      processSweepEnabled: true,
      processSweepIntervalSeconds: 15,
      systemSleepLockEnabled: false,
      systemSleepLockIntervalSeconds: 60,
      focusShortcutEnabled: false,
      focusShortcutOnName: "Vigil Focus On",
      focusShortcutOffName: "Vigil Focus Off",
      systemNetworkBlockingEnabled: true,
      safariUrlFilterEnabled: true,
      externalNetworkBlockEnabled: false,
      externalNetworkBlockProvider: "manual",
      hostsBlockingEnabled: false,
      protectedEditsEnabled: true,
      protectedEditDelaySeconds: 300,
      protectedEditWindowMinutes: 10,
      runtimeGapLockdownSeconds: 120,
      clockTamperLockdownSeconds: 90
    },
    adultBlocklist: {
      allowlist: [],
      domainCount: 0,
      activeDomainCount: 0,
      hash: "",
      snapshotPath: "",
      lastAttemptAt: null,
      lastRefreshAt: null,
      lastError: "",
      source: null
    },
    profiles: [
      {
        id: "default",
        name: "Default focus",
        mode: "blocklist",
        description: "Blocks social media apps and sites while keeping everything else usable.",
        blockedApps: DEFAULT_BLOCKED_APPS,
        blockedSites: DEFAULT_BLOCKED_SITES,
        blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS, ...DEFAULT_SHORT_FORM_URL_PATTERNS],
        allowedApps: [...DEFAULT_ALLOWED_APPS],
        allowedSites: [...DEFAULT_ALLOWED_SITES],
        hostsUrlPatternBlocking: false
      },
      {
        id: NORMAL_PROFILE_ID,
        name: "Normal",
        mode: "blocklist",
        description: "Baseline mode: no focus lock, but explicit sites and permanent short-form bans stay blocked.",
        blockedApps: [],
        blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
        blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS],
        allowedApps: [...DEFAULT_ALLOWED_APPS],
        allowedSites: [...DEFAULT_ALLOWED_SITES],
        phoneAppBlocking: false,
        hostsUrlPatternBlocking: false
      },
      {
        id: SOFT_BLOCK_PROFILE_ID,
        name: "Soft Lock",
        mode: "blocklist",
        description: "Blocks explicit sites and non-social short-form surfaces while leaving regular apps usable.",
        blockedApps: [],
        blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
        blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS, ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS, ...DEFAULT_SHORT_FORM_URL_PATTERNS],
        allowedApps: [...DEFAULT_ALLOWED_APPS],
        allowedSites: [...DEFAULT_ALLOWED_SITES],
        phoneAppBlocking: false,
        hostsUrlPatternBlocking: false
      },
      {
        id: BRICK_MODE_PROFILE_ID,
        name: "Mac Brick",
        mode: "allowlist",
        description: "Only essential apps and approved work sites remain available.",
        blockedApps: [],
        blockedSites: [],
        blockedUrlPatterns: [],
        allowedApps: [...BRICK_ALLOWED_APPS],
        allowedSites: [...BRICK_ALLOWED_SITES]
      }
    ],
    schedules: [
      {
        id: "sleep-template",
        name: "Sleep wind-down",
        enabled: false,
        mode: "sleep",
        profileId: "default",
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "22:30",
        end: "07:00",
        wifiNetworks: []
      }
    ],
    limitRules: [
      {
        id: "instagram-20-20-template",
        name: "Instagram 20/20",
        enabled: true,
        type: "time",
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        apps: ["Instagram", "com.burbn.instagram"],
        sites: ["instagram.com"],
        limitMinutes: 20,
        unlocksAllowed: 0,
        blockMinutes: 20,
        excludedProfileIds: [SOFT_BLOCK_PROFILE_ID]
      },
      {
        id: "soft-lock-youtube-20-20-template",
        name: "Soft Lock YouTube 20/20",
        enabled: true,
        type: "time",
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        apps: ["YouTube", "com.google.ios.youtube"],
        sites: ["youtube.com"],
        limitMinutes: 20,
        unlocksAllowed: 0,
        blockMinutes: 20,
        requiredProfileId: SOFT_BLOCK_PROFILE_ID
      },
      {
        id: "social-open-template",
        name: "Social open limit",
        enabled: false,
        type: "open",
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        apps: [],
        sites: DEFAULT_BLOCKED_SITES,
        limitMinutes: 45,
        unlocksAllowed: 5,
        blockMinutes: 0
      }
    ],
    limitBlocks: [],
    appLocks: [
      {
        id: "social-app-lock-template",
        name: "Locked socials",
        enabled: false,
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        apps: [],
        sites: DEFAULT_BLOCKED_SITES,
        unlocksAllowed: 2,
        unlockMinutes: 10,
        delaySeconds: 30
      }
    ],
    appLockUnlocks: [],
    appLockRequests: [],
    appLockLedger: {},
    intentionalUse: {
      goal: {
        statement: "Use screens on purpose, not by reflex.",
        values: ["Deep work", "Sleep", "Real relationships"],
        replacements: [
          "Write the next tiny task",
          "Take ten slow breaths",
          "Stand up and get water",
          "Open Notes instead"
        ],
        updatedAt: null
      },
      rules: [
        {
          id: "short-form-intent-template",
          name: "Short-form pause",
          enabled: true,
          frictionLevel: "standard",
          days: [0, 1, 2, 3, 4, 5, 6],
          start: "00:00",
          end: "23:59",
          apps: [],
          sites: [
            "instagram.com",
            "tiktok.com",
            "x.com",
            "twitter.com"
          ],
          urlPatterns: [
            "reddit.com/r/all",
            "reddit.com/r/popular",
            "youtube.com/shorts",
            "m.youtube.com/shorts"
          ],
          delaySeconds: 12,
          sessionMinutes: 10,
          dailyBudgetMinutes: 30,
          budgetWarningPercent: 50,
          askMood: true
        }
      ],
      pauses: [],
      grants: [],
      ledger: {},
      outcomes: [],
      behaviors: [],
      behaviorCheckIns: [],
      journalEntries: [],
      planLists: [
        {
          id: "todo",
          name: "To Do",
          kind: "todo",
          description: "Tasks and commitments to do soon.",
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        {
          id: "watchlist",
          name: "Watchlist",
          kind: "watch",
          description: "Movies and shows to watch later.",
          active: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ],
      planItems: [],
      planBlocks: [],
      recoveryCheckIns: [],
      sosSessions: [],
      accountability: {
        enabled: false,
        partnerName: "",
        cadence: "weekly"
      }
    },
    extension: {
      lastSeenAt: null,
      lastVersion: null,
      lastEvent: null,
      lastHost: null,
      dynamicRules: {
        syncedAt: null,
        count: 0,
        expectedCount: 0,
        signature: "",
        expectedSignature: "",
        status: "missing",
        ok: false,
        fallbackRequired: false
      }
    },
    focusShortcut: {
      active: false,
      desiredActive: false,
      lastAction: "",
      lastShortcutName: "",
      lastAppliedAt: null,
      lastCheckedAt: null,
      lastError: "",
      lastPolicy: ""
    },
    environment: {
      wifiSsid: "",
      wifiCheckedAt: null,
      wifiError: ""
    },
    keyholder: {
      enabled: false,
      salt: null,
      hash: null,
      updatedAt: null
    },
    distanceKey: {
      enabled: false,
      salt: null,
      hash: null,
      keyFilePath: "",
      updatedAt: null,
      lastVerifiedAt: null,
      lastFileVerifiedAt: null
    },
    integrity: {
      stateSeal: {
        lastStatus: "unknown",
        lastDetail: "",
        lastCheckedAt: null,
        lastSealedAt: null,
        tamperDetectedAt: null,
        tamperDetail: ""
      },
      runtime: {
        lastHeartbeatAt: null,
        downtimeDetectedAt: null,
        downtimeDetail: "",
        lastGapSeconds: 0,
        lastGapStartedAt: null,
        lastGapEndedAt: null,
        hardeningDriftDetectedAt: null,
        hardeningDriftDetail: "",
        hardeningDriftIssues: [],
        lastSourceSealTrustedAt: null,
        clockTamperDetectedAt: null,
        clockTamperDetail: "",
        clockTamperSeconds: 0,
        clockTamperDirection: "",
        clockTamperPreviousWallAt: null,
        clockTamperCurrentWallAt: null
      }
    },
    grayscale: {
      softBlockEnabled: false,
      preventManualChanges: true,
      schedules: []
    },
    deviceControls: {
      ios: {
        enabled: false,
        status: "supervised-profile-ready",
        mode: "denylist",
        webMode: "denylist",
        blockApps: true,
        blockWeb: true,
        hardenRemoval: true,
        restrictInstallAndErase: true,
        allowSafariHistoryClearing: true,
        blockedAppBundleIds: DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
        allowedAppBundleIds: DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS,
        deniedUrls: [],
        allowedUrls: [],
        focusedSocial: defaultFocusedSocialSettings(),
        removalPassword: null,
        lastGeneratedAt: null,
        mdm: {
          enabled: false,
          publicBaseUrl: "",
          topic: "",
          identityCertificateUuid: "",
          identityCertificatePayloadBase64: "",
          identityCertificatePassword: "",
          pushCertificatePayloadBase64: "",
          pushCertificatePassword: "",
          accessRights: 8179,
          signMessage: false,
          useDevelopmentApns: false,
          checkOutWhenRemoved: true,
          enrollmentSecret: null,
          devices: [],
          commands: [],
          lastEnrollmentProfileGeneratedAt: null,
          lastCheckInAt: null,
          lastCommandQueuedAt: null,
          lastPushAt: null,
          lastPushStatus: "",
          lastPushError: "",
          lastPolicyHash: "",
          lastGrayscaleHash: "",
          lastGrayscaleCommandQueuedAt: null
        }
      }
    },
    maintenance: {
      pending: [],
      windows: []
    },
    activeSessions: {
      computer: null,
      phone: null
    },
    panicLock: null,
    activeSession: null,
    emergency: {
      tokensUsedByWeek: {},
      pending: []
    },
    overrides: [],
    events: []
  };
}
