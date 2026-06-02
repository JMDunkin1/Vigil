import type { ActivePolicy, DeviceTargetInput, PolicyPhase, Profile, Schedule, SentinelState, Session, StateEvent, UnknownRecord, UsageSample } from "../src/types.js";

export type { Schedule, StateEvent, UnknownRecord };

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
  label?: string;
  detail?: string;
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
  label: string;
  tracked?: boolean;
  focusScore?: number;
  distractingSeconds?: number;
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
}

export interface HardeningCheck extends UnknownRecord {
  installed?: boolean;
  partial?: boolean;
  stale?: boolean;
  status?: string;
  tamperDetectedAt?: string;
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
  blockedAppBundleIds?: string[];
  allowedAppBundleIds?: string[];
  deniedUrls?: string[];
  allowedUrls?: string[];
  note?: string;
  supervisedRequired?: boolean;
  profile?: {
    appBundleCount?: number;
    deniedUrlCount?: number;
    allowedUrlCount?: number;
    webClipCount?: number;
    generatedFrom?: string;
  };
  mdm?: UnknownRecord & {
    enabled?: boolean;
    ready?: boolean;
    enrollmentReady?: boolean;
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
  topApps: BarEntry[];
  topSites: BarEntry[];
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
  accessibilityLikelyMissing?: boolean;
  lastError?: string;
}

export interface DashboardState extends SentinelState {
  activePolicy?: ActivePolicy | null;
  activeProfile?: Profile | null;
  sessionPhase?: PolicyPhase | null;
  activeSessions: Partial<Record<DeviceTargetInput, Session | null>>;
  emergency: SentinelState["emergency"] & {
    remaining?: number;
    pending: Array<SentinelState["emergency"]["pending"][number] & {
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
    launchAgent?: HardeningCheck;
    stateSeal?: HardeningCheck;
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
  };
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
