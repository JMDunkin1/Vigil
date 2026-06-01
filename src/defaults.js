export const APP_NAME = "Sentinel";
export const PORT = Number(process.env.SENTINEL_PORT || process.env.SCREEN_TIME_PORT || 8787);
export const REQUIRED_EXTENSION_VERSION = "0.3.0";

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
  "reddit.com",
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

export const DEFAULT_SHORT_FORM_URL_PATTERNS = [
  "youtube.com/shorts",
  "m.youtube.com/shorts",
  "instagram.com/reels",
  "instagram.com/explore",
  "facebook.com/reel",
  "facebook.com/watch/reel",
  "reddit.com/r/all",
  "reddit.com/r/popular",
  "x.com/explore",
  "twitter.com/explore",
  "snapchat.com/spotlight",
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

export const DEVICE_TARGETS = ["computer", "phone"];
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

export const DEFAULT_ANDROID_PACKAGES = [
  "com.google.android.youtube",
  "com.reddit.frontpage",
  "com.twitter.android",
  "com.instagram.android",
  "com.zhiliaoapp.musically",
  "com.facebook.katana",
  "com.discord",
  "com.snapchat.android",
  "com.pinterest"
];

export const DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS = [
  "com.google.ios.youtube",
  "com.reddit.Reddit",
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

export function defaultState() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    settings: {
      pollIntervalMs: 3000,
      strictByDefault: true,
      emergencyTokensPerWeek: 3,
      emergencyDelaySeconds: 45,
      panicLockDurationMinutes: 3,
      intentReasonEnabled: true,
      intentReasonMinLength: 20,
      focusSoundEnabled: false,
      focusSoundPreset: "brown-noise",
      focusSoundVolume: 35,
      typingChallengeEnabled: true,
      interventionEnabled: true,
      interventionWindowMinutes: 10,
      interventionThreshold: 3,
      interventionExtraDelaySeconds: 45,
      interventionMaxExtraDelaySeconds: 300,
      baselineDailyMinutes: 300,
      focusScoreGoal: 80,
      activeProfileId: "default",
      baselineProfileId: NORMAL_PROFILE_ID,
      foolproofModeEnabled: false,
      appQuitEscalationSeconds: 10,
      siteRedirectEnabled: true,
      contentFilterEnabled: true,
      browserNoiseBlockingEnabled: true,
      appQuitEnabled: true,
      strictBypassProtectionEnabled: false,
      processSweepEnabled: true,
      processSweepIntervalSeconds: 15,
      systemSleepLockEnabled: false,
      systemSleepLockIntervalSeconds: 60,
      focusShortcutEnabled: false,
      focusShortcutOnName: "Sentinel Focus On",
      focusShortcutOffName: "Sentinel Focus Off",
      hostsBlockingEnabled: false,
      protectedEditsEnabled: true,
      protectedEditDelaySeconds: 300,
      protectedEditWindowMinutes: 10
    },
    profiles: [
      {
        id: "default",
        name: "Default focus",
        mode: "blocklist",
        description: "Blocks social media apps and sites while keeping everything else usable.",
        blockedApps: DEFAULT_BLOCKED_APPS,
        blockedSites: DEFAULT_BLOCKED_SITES,
        blockedUrlPatterns: DEFAULT_SHORT_FORM_URL_PATTERNS,
        allowedApps: [...DEFAULT_ALLOWED_APPS],
        allowedSites: [...DEFAULT_ALLOWED_SITES]
      },
      {
        id: NORMAL_PROFILE_ID,
        name: "Normal",
        mode: "blocklist",
        description: "Baseline mode: no focus lock, but explicit sites stay blocked.",
        blockedApps: [],
        blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
        blockedUrlPatterns: [],
        allowedApps: [...DEFAULT_ALLOWED_APPS],
        allowedSites: [...DEFAULT_ALLOWED_SITES],
        phoneAppBlocking: false,
        hostsUrlPatternBlocking: false
      },
      {
        id: SOFT_BLOCK_PROFILE_ID,
        name: "Soft Block",
        mode: "blocklist",
        description: "Blocks the normal explicit baseline plus short-form feeds while leaving regular sites usable.",
        blockedApps: [],
        blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
        blockedUrlPatterns: DEFAULT_SHORT_FORM_URL_PATTERNS,
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
        id: "social-time-template",
        name: "Social time cap",
        enabled: false,
        type: "time",
        lockLevel: "deep",
        days: [0, 1, 2, 3, 4, 5, 6],
        apps: [],
        sites: DEFAULT_BLOCKED_SITES,
        limitMinutes: 45,
        unlocksAllowed: 5,
        blockMinutes: 0
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
        clockTamperDetectedAt: null,
        clockTamperDetail: "",
        clockTamperSeconds: 0,
        clockTamperDirection: "",
        clockTamperPreviousWallAt: null,
        clockTamperCurrentWallAt: null
      }
    },
    deviceControls: {
      android: {
        enabled: false,
        packages: DEFAULT_ANDROID_PACKAGES,
        lastAppliedAt: null,
        lastAction: null,
        lastResult: null
      },
      ios: {
        enabled: false,
        status: "supervised-profile-ready",
        mode: "denylist",
        webMode: "denylist",
        blockApps: true,
        blockWeb: true,
        hardenRemoval: true,
        restrictInstallAndErase: true,
        blockedAppBundleIds: DEFAULT_IOS_BLOCKED_APP_BUNDLE_IDS,
        allowedAppBundleIds: DEFAULT_IOS_ALLOWED_APP_BUNDLE_IDS,
        deniedUrls: [],
        allowedUrls: [],
        removalPassword: null,
        lastGeneratedAt: null,
        mdm: {
          enabled: false,
          publicBaseUrl: "",
          topic: "",
          identityCertificateUuid: "",
          identityCertificatePayloadBase64: "",
          identityCertificatePassword: "",
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
          lastPolicyHash: ""
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
