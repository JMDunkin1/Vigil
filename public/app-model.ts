import type { ActivePolicy, DeviceTargetInput, GrayscaleSchedule, IntentionalPlanBlock, IntentionalPlanItem, IntentionalPlanList, PolicyPhase, Profile, Schedule, VigilState, Session, StateEvent, UnknownRecord, UsageSample } from "../src/types.js";

export type { ActivePolicy, GrayscaleSchedule, IntentionalPlanBlock, IntentionalPlanItem, IntentionalPlanList, Schedule, StateEvent, UnknownRecord };

export type ControlElement = HTMLElement & {
  value: string;
  checked: boolean;
  disabled: boolean;
  hidden: boolean;
  placeholder: string;
  elements: NamedFormControls;
  reset(): void;
  submit(): void;
};

export type NamedFormControls = HTMLFormControlsCollection & Record<string, ControlElement>;
export type FormPayload = Record<string, unknown>;

export interface Preset {
  label: string;
  apps: string[];
  sites: string[];
  urlPatterns?: string[];
}

export interface BarEntry {
  label?: string;
  name?: string;
  seconds?: number;
  count?: number;
  value?: number;
}

export interface ProgressSummary extends UnknownRecord {
  seconds?: number;
  opens?: number;
  budget?: UnknownRecord & {
    budgetSeconds?: number;
    percent?: number;
  };
}

export interface ChallengeSummary {
  text?: string;
}

export interface DashboardItem extends UnknownRecord {
  id: string;
  name: string;
  title?: string;
  label?: string;
  detail?: string;
  description?: string;
  ok?: boolean;
  enabled?: boolean;
  type?: string;
  mode?: string;
  start?: string;
  end?: string;
  days?: number[];
  apps?: string[];
  sites?: string[];
  wifiNetworks?: string[];
  blockedApps?: string[];
  blockedSites?: string[];
  blockedUrlPatterns?: string[];
  urlPatterns?: string[];
  allowedApps?: string[];
  allowedSites?: string[];
  commitmentLock?: boolean;
  unlocksAllowed?: number;
  unlockMinutes?: number;
  delaySeconds?: number;
  lockLevel?: string;
  limitMinutes?: number;
  blockMinutes?: number;
  frictionLevel?: string;
  sessionMinutes?: number;
  dailyBudgetMinutes?: number;
  weeklyTarget?: number;
  weeklyValue?: number;
  weeklyCheckIns?: number;
  direction?: string;
  unit?: string;
  replacement?: string;
  active?: boolean;
  body?: string;
  mood?: string;
  energy?: number | null;
  tags?: string[];
  behaviorIds?: string[];
  ruleIds?: string[];
  behaviorId?: string;
  behaviorName?: string;
  value?: number;
  note?: string;
  at?: string;
  entryDate?: string;
  createdAt?: string;
  updatedAt?: string;
  activeBlock?: unknown;
  activeUnlock?: unknown;
  pendingRequest?: DashboardItem & {
    eligibleAt?: string;
    challenge?: ChallengeSummary | null;
  };
  remainingToday?: number;
  usedToday?: number;
  percent?: number;
  progress?: ProgressSummary;
  challenge?: ChallengeSummary | null;
}

export interface LimitBlockItem extends UnknownRecord {
  until: string;
}

export interface WeekDaySummary extends UnknownRecord {
  key?: string;
  label: string;
  tracked?: boolean;
  focusScore?: number;
  distractingSeconds?: number;
  totalSeconds?: number;
}

export interface HabitCalendarCheckIn extends DashboardItem {
  behaviorId?: string;
  behaviorName?: string;
  value?: number;
  note?: string;
  at?: string;
  dateKey?: string;
  weekKey?: string;
}

export interface JournalVaultSummary extends UnknownRecord {
  configured?: boolean;
  autoLockMinutes?: number;
  touchIdAvailable?: boolean;
  entries?: number;
  locked?: boolean;
  error?: string;
}

export interface InterventionSummary extends UnknownRecord {
  enabled?: boolean;
  level?: string;
  message?: string;
  resetsAt?: string;
  windowMinutes?: number;
  topTargets?: Array<{ label: string; count: number }>;
}

export interface ProtectionSummary extends UnknownRecord {
  enabled?: boolean;
  activeWindow?: { until: string };
  pending?: Array<DashboardItem & {
    eligibleAt: string;
    challenge?: ChallengeSummary | null;
  }>;
}

export interface FoolproofSummary extends UnknownRecord {
  ready?: boolean;
  enabled?: boolean;
  blockers?: DashboardItem[];
}

export interface IntentionalUseSummary extends UnknownRecord {
  goal?: {
    statement?: string;
    values?: string[];
    replacements?: string[];
  };
  today?: {
    pauses?: number;
  };
  accountability?: UnknownRecord & {
    enabled?: boolean;
    partnerName?: string;
    cadence?: string;
    digest?: { text?: string };
  };
  rules?: DashboardItem[];
  lifeLog?: {
    entriesLocked?: boolean;
    journalVault?: JournalVaultSummary;
    entries?: Array<DashboardItem & {
      title?: string;
      body?: string;
      mood?: string;
      energy?: number | null;
      tags?: string[];
      behaviorIds?: string[];
      ruleIds?: string[];
      entryDate?: string;
      createdAt?: string;
      updatedAt?: string;
    }>;
    behaviors?: Array<DashboardItem & {
      description?: string;
      direction?: string;
      unit?: string;
      weeklyTarget?: number;
      weeklyValue?: number;
      weeklyCheckIns?: number;
      percent?: number;
      ruleIds?: string[];
      replacement?: string;
      active?: boolean;
      lastCheckInAt?: string | null;
    }>;
    planner?: {
      lists?: IntentionalPlanList[];
      items?: IntentionalPlanItem[];
      recentItems?: IntentionalPlanItem[];
      blocks?: IntentionalPlanBlock[];
      todayBlocks?: IntentionalPlanBlock[];
      upcomingBlocks?: IntentionalPlanBlock[];
      activeBlocks?: IntentionalPlanBlock[];
      openItems?: number;
      completedItems?: number;
    };
    recentCheckIns?: HabitCalendarCheckIn[];
    habitCheckIns?: HabitCalendarCheckIn[];
    calendar?: {
      month?: string;
      checkIns?: HabitCalendarCheckIn[];
    };
    stats?: {
      weekKey?: string;
      entriesThisWeek?: number;
      totalEntries?: number;
      behaviorCheckInsThisWeek?: number;
      recoveryCheckInsThisWeek?: number;
      reflectionStreakDays?: number;
      activeBehaviors?: number;
      openPlanItems?: number;
      activePlanBlocks?: number;
    };
  };
  recovery?: {
    today?: {
      checkIns?: number;
      urges?: number;
      setbacks?: number;
      victories?: number;
      sos?: number;
      clean?: boolean;
    };
    week?: {
      checkIns?: number;
      urges?: number;
      setbacks?: number;
      victories?: number;
      sos?: number;
      cleanDays?: number;
      topTriggers?: Array<{ label: string; count: number }>;
      averageUrgeIntensity?: number;
      averageStress?: number;
    };
    recentCheckIns?: Array<DashboardItem & {
      kind?: string;
      status?: string;
      mood?: string;
      urgeIntensity?: number;
      stress?: number | null;
      sleepHours?: number | null;
      exerciseMinutes?: number | null;
      trigger?: string;
      action?: string;
      note?: string;
      at?: string;
    }>;
    recentSos?: Array<DashboardItem & {
      intent?: string;
      trigger?: string;
      urgeIntensity?: number;
      reasonWhy?: string;
      replacement?: string;
      plan?: string[];
      startedAt?: string;
    }>;
  };
}

export interface HardeningCheck extends UnknownRecord {
  detail?: string;
  current?: boolean;
  embedded?: boolean;
  enabled?: boolean;
  generated?: boolean;
  installed?: boolean;
  isAdmin?: boolean;
  loaded?: boolean;
  ok?: boolean;
  pathUrlCount?: number;
  partial?: boolean;
  required?: boolean;
  restartHardened?: boolean;
  running?: boolean;
  stale?: boolean;
  status?: string;
  tamperDetectedAt?: string;
  username?: string;
  urlCount?: number;
}

export interface FocusShortcutSummary {
  onShortcutName?: string;
  offShortcutName?: string;
  lastError?: string;
  active?: boolean;
  enabled?: boolean;
}

export interface KeyholderSummary {
  enabled?: boolean;
  hasPasscode?: boolean;
}

export interface DistanceKeySummary {
  enabled?: boolean;
  keyFilePath?: string;
  hasKeyFile?: boolean;
  hasToken?: boolean;
}

export interface IosDeviceSummary extends UnknownRecord {
  enabled?: boolean;
  mode?: string;
  webMode?: string;
  blockApps?: boolean;
  blockWeb?: boolean;
  removalHardened?: boolean;
  hardenRemoval?: boolean;
  restrictInstallAndErase?: boolean;
  allowSafariHistoryClearing?: boolean;
  blockedAppBundleIds?: string[];
  allowedAppBundleIds?: string[];
  deniedUrls?: string[];
  allowedUrls?: string[];
  focusedSocial?: UnknownRecord & {
    enabled?: boolean;
    companionAppsEnabled?: boolean;
    forceWebClips?: boolean;
    instagram?: UnknownRecord;
    youtube?: UnknownRecord;
    snapchat?: UnknownRecord;
  };
  note?: string;
  supervisedRequired?: boolean;
  protection?: UnknownRecord & {
    knownSitesBlocked?: boolean;
    knownSiteDomainCount?: number;
    explicitSearchesBlocked?: boolean;
    explicitSearchTermCount?: number;
    safeSearchEnforced?: boolean;
    sensitiveMediaFiltered?: boolean;
    requiresManagedSafariExtension?: boolean;
    systemWideManagedWebFilter?: boolean;
    appWorkaroundsClosed?: boolean;
    targetedAppBundleCount?: number;
    allAppsHidden?: boolean;
    removalLocked?: boolean;
  };
  profile?: {
    appBundleCount?: number;
    deniedUrlCount?: number;
    allowedUrlCount?: number;
    webClipCount?: number;
    generatedFrom?: string;
    focusedSocial?: UnknownRecord & {
      enabled?: boolean;
      companionAppsEnabled?: boolean;
      forceWebClips?: boolean;
      platformCount?: number;
      featureCount?: number;
      deniedUrlCount?: number;
      nativeAppBundleCount?: number;
      webClipCount?: number;
    };
    grayscale?: UnknownRecord & {
      desired?: boolean;
      label?: string;
      settingsGuarded?: boolean;
    };
  };
  launcherProfile?: UnknownRecord & {
    identifier?: string;
    retired?: boolean;
    managedSeparately?: boolean;
    webClipCount?: number;
    labels?: string[];
    bundleIds?: string[];
  };
  companionApps?: UnknownRecord & {
    appCount?: number;
    labels?: string[];
    bundleIds?: string[];
    apps?: Array<{ id?: string; label?: string; bundleId?: string }>;
  };
  manageEngine?: UnknownRecord & {
    preferred?: boolean;
    deliveryProvider?: string;
    status?: string;
    policyPath?: string;
    summaryPath?: string;
    enrollmentWindowPath?: string;
    exportCommand?: string;
    enrollmentWindowCommand?: string;
    generatedFrom?: string;
    appBundleCount?: number;
    deniedUrlCount?: number;
    allowedUrlCount?: number;
    currentGeneration?: boolean;
    generatedAt?: string | null;
    generation?: string | null;
    profileHash?: string | null;
    note?: string;
  };
  mdm?: UnknownRecord & {
    enabled?: boolean;
    ready?: boolean;
    enrollmentReady?: boolean;
    status?: "off" | "setup-needed" | "queue-only" | "ready";
    capabilityLevel?: "static-profile" | "setup-needed" | "command-queue" | "wireless-push";
    publicBaseUrl?: string;
    topic?: string;
    identityCertificateUuid?: string;
    identityCertificatePayloadSet?: boolean;
    identityCertificatePasswordSet?: boolean;
    pushCertificatePayloadSet?: boolean;
    pushCertificatePasswordSet?: boolean;
    signMessage?: boolean;
    useDevelopmentApns?: boolean;
    note?: string;
    enrollmentUrl?: string;
    localEnrollmentPath?: string;
    enrolledDeviceCount?: number;
    pendingCommandCount?: number;
    sentCommandCount?: number;
    lastPushAt?: string;
    lastPushStatus?: string;
    lastPushError?: string;
    lastSeenAt?: string;
    pushSupported?: boolean;
    blockers?: string[];
    setupBlockers?: string[];
    pushBlockers?: string[];
    grayscale?: UnknownRecord & {
      desired?: boolean;
      label?: string;
    };
    devices?: Array<{
      udid?: string;
      status?: string;
      productName?: string;
      osVersion?: string;
      lastStatus?: string;
    }>;
  };
}

export interface UsageSummary extends UnknownRecord {
  focusScore: number;
  distractingSeconds: number;
  protectedSeconds: number;
  totalSeconds?: number;
  topApps: BarEntry[];
  topSites: BarEntry[];
  devices?: Record<string, UnknownRecord & {
    totalSeconds?: number;
    distractingSeconds?: number;
    appOpenCount?: number;
    siteOpenCount?: number;
    topApps?: BarEntry[];
    topSites?: BarEntry[];
  }>;
}

export interface ReportSummary extends UnknownRecord {
  currentWeek: {
    startsAt: string;
    endsAt: string;
    days: WeekDaySummary[];
    totals: {
      averageFocusScore: number;
      distractingSeconds: number;
      averageDailyDistractionSeconds: number;
      trackedDays: number;
      averageDailyOpens?: number;
    };
  };
  comparison?: {
    distractingPercentDelta?: number;
    focusScoreDelta?: number;
    distractingSecondsDelta?: number;
  };
  streak: {
    label: string;
    goal: number;
    days?: number;
  };
  focusScoreGoal: number;
  insights: string[];
  milestones: DashboardItem[];
}

export interface MonitorSummary extends UnknownRecord {
  ok?: boolean;
  lastSample?: UsageSample;
  lastEnforcement?: UnknownRecord | null;
  lastProcessSweep?: UnknownRecord;
  lastSystemSleepLock?: UnknownRecord;
  lastGrayscale?: UnknownRecord & {
    desired?: boolean;
    active?: boolean;
    current?: boolean;
    label?: string;
    error?: string;
  };
  accessibilityLikelyMissing?: boolean;
  lastError?: string;
}

export interface DashboardState extends VigilState {
  activePolicy?: ActivePolicy | null;
  devicePolicies?: Partial<Record<DeviceTargetInput, ActivePolicy | null>>;
  activeProfile?: Profile | null;
  sessionPhase?: PolicyPhase | null;
  activeSessions: Partial<Record<DeviceTargetInput, Session | null>>;
  emergency: VigilState["emergency"] & {
    remaining?: number;
    pending: Array<VigilState["emergency"]["pending"][number] & {
      challenge?: ChallengeSummary | null;
      eligibleAt?: string;
    }>;
  };
}

export interface DashboardData extends UnknownRecord {
  state: DashboardState;
  usage: UsageSummary;
  report: ReportSummary;
  monitor: MonitorSummary;
  intervention: InterventionSummary;
  intentionalUse: IntentionalUseSummary;
  limits: {
    activeBlocks: LimitBlockItem[];
    rules: DashboardItem[];
  };
  appLocks: {
    rules: DashboardItem[];
  };
  devices: UnknownRecord & {
    ios?: IosDeviceSummary;
  };
  presets: Preset[];
  protection: ProtectionSummary;
  hardening: UnknownRecord & {
    hostsBlock?: string;
    hosts?: HardeningCheck;
    firewall?: HardeningCheck;
    safariFilter?: HardeningCheck;
    chromeSafeSearch?: HardeningCheck;
    externalNetworkBlock?: HardeningCheck & {
      targetDomains?: string[];
      targetDomainCount?: number;
      signature?: string;
      provider?: string;
    };
    adultBlocklist?: HardeningCheck & {
      selectedSourceId?: string;
      selectedSourceLabel?: string;
      selectedSourceUrl?: string;
      selectedSourceLicense?: string;
      sources?: Array<UnknownRecord & {
        id?: string;
        label?: string;
        url?: string;
        license?: string;
      }>;
      allowlist?: string[];
      allowlistCount?: number;
      domainCount?: number;
      activeDomainCount?: number;
      preloadLimit?: number;
      preloadedDomainCount?: number;
      shortHash?: string;
      snapshotPath?: string;
      lastRefreshAt?: string | null;
      lastAttemptAt?: string | null;
      lastError?: string;
    };
    launchAgent?: HardeningCheck;
    account?: HardeningCheck;
    stateSeal?: HardeningCheck;
    sourceSeal?: HardeningCheck;
    actions?: Record<string, { path?: string; command?: string }>;
    audit?: DashboardItem[];
    foolproof?: FoolproofSummary;
  };
}

export interface UiState {
  data: DashboardData | null;
  activeView: string;
  selectedProfileId: string | null;
  selectedScheduleId: string | null;
  selectedGrayscaleScheduleId: string | null;
  pendingEmergencyId: string | null;
  pendingMaintenanceId: string | null;
  timer: ReturnType<typeof setInterval> | null;
  distanceScanner: {
    stream: MediaStream | null;
    frame: number | null;
    target: ControlElement | null;
  };
}

export interface SessionStartResponse {
  session: {
    endsAt: string;
    title?: string;
  };
}

export interface SessionPreviewSummary {
  title?: string;
  mode?: string;
  profileName?: string;
  profileMode?: string;
  lockLevel?: string;
  durationMinutes?: number;
  endsAt?: string;
  deviceTargets?: string[];
  deviceLabel?: string;
  commitmentLock?: boolean;
  canEndEarly?: boolean;
  blockedApps?: string[];
  blockedSites?: string[];
  blockedUrlPatterns?: string[];
  allowedApps?: string[];
  allowedSites?: string[];
  protections?: string[];
  conflicts?: string[];
  phone?: {
    targeted?: boolean;
    ready?: boolean;
    status?: string;
    detail?: string;
    blockers?: string[];
    appCount?: number;
    siteCount?: number;
    mode?: string;
  };
}

export interface SessionPreviewResponse {
  preview: SessionPreviewSummary;
}

export interface SessionEndResponse {
  ended?: boolean;
}

export interface QueuePolicyResponse {
  result?: {
    queued?: number;
  };
}

export interface PendingResponse {
  pending?: {
    id?: string;
  };
  activeWindow?: boolean;
}

export interface DistanceKeyResponse {
  token?: string;
  keyFilePath?: string;
}
