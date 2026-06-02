export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type UnknownRecord = Record<string, unknown>;

export type DeviceTarget = "computer" | "phone";
export type DeviceTargetInput = DeviceTarget | string;
export type LockLevel = "light" | "deep" | string;
export type ProfileMode = "blocklist" | "allowlist" | string;

export interface Profile {
  id: string;
  name: string;
  mode: ProfileMode;
  description?: string;
  blockedApps: string[];
  blockedSites: string[];
  blockedUrlPatterns: string[];
  allowedApps: string[];
  allowedSites: string[];
  phoneAppBlocking?: boolean;
  hostsUrlPatternBlocking?: boolean;
  [key: string]: unknown;
}

export interface SessionCycle {
  enabled?: boolean;
  workMinutes?: number;
  breakMinutes?: number;
  rounds?: number;
  cycles?: number;
}

export interface Session {
  id: string;
  title: string;
  mode: string;
  profileId: string;
  lockLevel: LockLevel;
  startedAt: string;
  endsAt: string;
  endedAt?: string;
  canEndEarly?: boolean;
  commitmentLock?: boolean;
  emergencyUnlocksAllowed?: boolean;
  fullLockout?: boolean;
  source?: string;
  deviceTargets?: DeviceTargetInput[];
  profileSnapshot?: Profile;
  cycle?: SessionCycle;
  active?: boolean;
  [key: string]: unknown;
}

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
  profileId: string;
  lockLevel: LockLevel;
  days: number[];
  start: string;
  end: string;
  wifiNetworks: string[];
  commitmentLock?: boolean;
  deviceTargets?: DeviceTargetInput[];
  [key: string]: unknown;
}

export interface PolicyPhase {
  kind: string;
  label: string;
  blocking: boolean;
  round: number;
  rounds: number;
  startsAt: string;
  endsAt: string;
}

export interface ActivePolicy {
  kind: string;
  session: Session;
  profile: Profile;
  schedule?: Schedule;
  endsAt: string;
  phase?: PolicyPhase | null;
  [key: string]: unknown;
}

export interface AppSettings {
  pollIntervalMs: number;
  strictByDefault: boolean;
  emergencyTokensPerWeek: number;
  emergencyDelaySeconds: number;
  panicLockDurationMinutes: number;
  intentReasonEnabled: boolean;
  intentReasonMinLength: number;
  focusSoundEnabled: boolean;
  focusSoundPreset: string;
  focusSoundVolume: number;
  typingChallengeEnabled: boolean;
  interventionEnabled: boolean;
  interventionWindowMinutes: number;
  interventionThreshold: number;
  interventionExtraDelaySeconds: number;
  interventionMaxExtraDelaySeconds: number;
  intentionalUseEnabled: boolean;
  baselineDailyMinutes: number;
  focusScoreGoal: number;
  activeProfileId: string;
  baselineProfileId: string;
  foolproofModeEnabled: boolean;
  appQuitEscalationSeconds: number;
  siteRedirectEnabled: boolean;
  contentFilterEnabled: boolean;
  browserNoiseBlockingEnabled: boolean;
  appQuitEnabled: boolean;
  strictBypassProtectionEnabled: boolean;
  processSweepEnabled: boolean;
  processSweepIntervalSeconds: number;
  systemSleepLockEnabled: boolean;
  systemSleepLockIntervalSeconds: number;
  focusShortcutEnabled: boolean;
  focusShortcutOnName: string;
  focusShortcutOffName: string;
  hostsBlockingEnabled: boolean;
  protectedEditsEnabled: boolean;
  protectedEditDelaySeconds: number;
  protectedEditWindowMinutes: number;
  runtimeGapLockdownSeconds: number;
  clockTamperLockdownSeconds: number;
  [key: string]: unknown;
}

export interface StateEvent {
  id: string;
  type: string;
  detail: Record<string, unknown>;
  at: string;
}

export interface LimitProgress {
  seconds?: number;
  opens?: number;
}

export interface LimitRule {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  lockLevel: LockLevel;
  days: number[];
  apps: string[];
  sites: string[];
  limitMinutes: number;
  unlocksAllowed: number;
  blockMinutes: number;
  [key: string]: unknown;
}

export interface LimitBlock {
  id: string;
  ruleId: string;
  ruleName: string;
  type: string;
  lockLevel: LockLevel;
  apps: string[];
  sites: string[];
  createdAt: string;
  until: string;
  progress?: LimitProgress;
  [key: string]: unknown;
}

export interface AppLockRule {
  id: string;
  name: string;
  enabled: boolean;
  lockLevel: LockLevel;
  days: number[];
  apps: string[];
  sites: string[];
  unlocksAllowed: number;
  unlockMinutes: number;
  delaySeconds: number;
  [key: string]: unknown;
}

export interface AppLockUnlock {
  id: string;
  lockId: string;
  lockName?: string;
  createdAt: string;
  until: string;
  reason?: string;
  [key: string]: unknown;
}

export interface AppLockRequest {
  id: string;
  lockId: string;
  status: string;
  reason: string;
  requestedAt: string;
  eligibleAt: string;
  expiresAt: string;
  challenge?: TypingChallenge;
  [key: string]: unknown;
}

export interface TypingChallenge {
  kind: string;
  text: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface OverrideRecord {
  scheduleId: string;
  until: string;
  createdAt?: string;
  [key: string]: unknown;
}

export interface EmergencyRequest {
  id: string;
  status: string;
  reason?: string;
  requestedAt?: string;
  eligibleAt?: string;
  expiresAt: string;
  activeKind?: string;
  sessionId?: string | null;
  scheduleId?: string | null;
  limitBlockIds?: string[];
  until?: string;
  [key: string]: unknown;
}

export interface IntentionalUseGoal {
  statement: string;
  values: string[];
  replacements: string[];
  updatedAt: string | null;
}

export interface IntentionalUseRule {
  id: string;
  name: string;
  enabled: boolean;
  frictionLevel: "gentle" | "standard" | "strict";
  days: number[];
  start: string;
  end: string;
  apps: string[];
  sites: string[];
  delaySeconds: number;
  sessionMinutes: number;
  dailyBudgetMinutes: number;
  budgetWarningPercent?: number;
  askMood?: boolean;
  [key: string]: unknown;
}

export interface IntentionalPause {
  id: string;
  ruleId: string;
  ruleName: string;
  status: string;
  requestedAt: string;
  eligibleAt: string;
  expiresAt: string;
  frictionLevel: string;
  delaySeconds: number;
  sessionMinutes: number;
  targetType: string;
  targetLabel: string;
  app: string;
  hostname: string;
  returnUrl: string;
  event: string;
  completedAt?: string;
  intention?: string;
  replacement?: string;
  mood?: string;
  [key: string]: unknown;
}

export interface IntentionalGrant {
  id: string;
  pauseId: string;
  ruleId: string;
  status: string;
  targetType: string;
  targetLabel: string;
  app: string;
  hostname: string;
  createdAt: string;
  until: string;
  intention: string;
  mood: string;
  usedSeconds: number;
  lastSeenAt?: string;
}

export interface IntentionalOutcome {
  id: string;
  pauseId: string;
  ruleId: string;
  ruleName: string;
  outcome: string;
  targetType: string;
  targetLabel: string;
  app: string;
  hostname: string;
  intention: string;
  replacement: string;
  mood: string;
  at: string;
  dateKey: string;
  weekKey: string;
}

export interface IntentionalRuleLedger {
  seconds: number;
  pauses: number;
  continued: number;
  skipped: number;
  targets: Record<string, number>;
  [key: string]: number | Record<string, number>;
}

export interface IntentionalDayLedger {
  weekKey: string;
  rules: Record<string, IntentionalRuleLedger>;
}

export interface IntentionalUseState {
  goal: IntentionalUseGoal;
  rules: IntentionalUseRule[];
  pauses: IntentionalPause[];
  grants: IntentionalGrant[];
  ledger: Record<string, IntentionalDayLedger>;
  outcomes: IntentionalOutcome[];
  accountability: {
    enabled?: boolean;
    partnerName?: string;
    cadence?: string;
    [key: string]: unknown;
  };
}

export interface StateSealState {
  lastCheckedAt?: string | null;
  lastSealedAt?: string | null;
  lastStatus?: string;
  lastDetail?: string;
  tamperDetectedAt?: string | null;
  tamperDetail?: string;
  [key: string]: unknown;
}

export interface HardeningIssue {
  id: string;
  detail: string;
  [key: string]: unknown;
}

export interface IntegrityRuntimeState {
  lastHeartbeatAt?: string | null;
  downtimeDetectedAt?: string | null;
  downtimeDetail?: string;
  lastGapSeconds?: number;
  lastGapStartedAt?: string | null;
  lastGapEndedAt?: string | null;
  hardeningDriftDetectedAt?: string | null;
  hardeningDriftDetail?: string;
  hardeningDriftIssues?: HardeningIssue[];
  lastSourceSealTrustedAt?: string | null;
  clockTamperDetectedAt?: string | null;
  clockTamperDetail?: string;
  clockTamperSeconds?: number;
  clockTamperDirection?: string;
  clockTamperPreviousWallAt?: string | null;
  clockTamperCurrentWallAt?: string | null;
  [key: string]: unknown;
}

export interface MaintenanceRequest {
  id: string;
  status: string;
  reason: string;
  requestedAt: string;
  eligibleAt: string;
  expiresAt: string;
  challenge?: TypingChallenge;
  [key: string]: unknown;
}

export interface MaintenanceWindow {
  id: string;
  requestId: string;
  reason: string;
  createdAt: string;
  until: string;
  [key: string]: unknown;
}

export interface KeyholderState {
  enabled: boolean;
  salt: string | null;
  hash: string | null;
  updatedAt: string | null;
  [key: string]: unknown;
}

export interface DistanceKeyState {
  enabled: boolean;
  salt: string | null;
  hash: string | null;
  keyFilePath: string;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
  lastFileVerifiedAt: string | null;
  [key: string]: unknown;
}

export interface FocusShortcutState {
  active: boolean;
  desiredActive: boolean;
  lastAction: string;
  lastShortcutName: string;
  lastAppliedAt: string | null;
  lastCheckedAt: string | null;
  lastError: string;
  lastPolicy: string;
  [key: string]: unknown;
}

export interface IosMdmSettings {
  enabled: boolean;
  publicBaseUrl: string;
  topic: string;
  identityCertificateUuid: string;
  identityCertificatePayloadBase64: string;
  identityCertificatePassword: string;
  pushCertificatePayloadBase64: string;
  pushCertificatePassword: string;
  accessRights: number;
  signMessage: boolean;
  useDevelopmentApns: boolean;
  checkOutWhenRemoved: boolean;
  enrollmentSecret: string | null;
  devices: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  lastEnrollmentProfileGeneratedAt: string | null;
  lastCheckInAt: string | null;
  lastCommandQueuedAt: string | null;
  lastPushAt: string | null;
  lastPushStatus: string;
  lastPushError: string;
  lastPolicyHash: string;
  [key: string]: unknown;
}

export interface IosSettings {
  enabled: boolean;
  status: string;
  mode: string;
  webMode: string;
  blockApps: boolean;
  blockWeb: boolean;
  hardenRemoval: boolean;
  restrictInstallAndErase: boolean;
  blockedAppBundleIds: string[];
  allowedAppBundleIds: string[];
  deniedUrls: string[];
  allowedUrls: string[];
  removalPassword: string | null;
  lastGeneratedAt: string | null;
  profileId?: string;
  mdm: IosMdmSettings;
  [key: string]: unknown;
}

export interface SentinelState {
  version: number;
  createdAt: string;
  settings: AppSettings;
  profiles: Profile[];
  schedules: Schedule[];
  limitRules: LimitRule[];
  limitBlocks: LimitBlock[];
  appLocks: AppLockRule[];
  appLockUnlocks: AppLockUnlock[];
  appLockRequests: AppLockRequest[];
  appLockLedger: Record<string, Record<string, number>>;
  intentionalUse: IntentionalUseState;
  extension: {
    dynamicRules: Record<string, unknown>;
    [key: string]: unknown;
  };
  focusShortcut: FocusShortcutState;
  environment: {
    wifiSsid: string;
    wifiCheckedAt: string | null;
    wifiError: string;
    [key: string]: unknown;
  };
  keyholder: KeyholderState;
  distanceKey: DistanceKeyState;
  integrity: {
    stateSeal: StateSealState;
    runtime: IntegrityRuntimeState;
    [key: string]: unknown;
  };
  deviceControls: {
    ios: IosSettings;
    [key: string]: unknown;
  };
  maintenance: {
    pending: MaintenanceRequest[];
    windows: MaintenanceWindow[];
  };
  activeSessions: Partial<Record<DeviceTarget, Session | null>>;
  panicLock: Session | null;
  activeSession: Session | null;
  emergency: {
    tokensUsedByWeek: Record<string, number>;
    pending: EmergencyRequest[];
  };
  overrides: OverrideRecord[];
  events: StateEvent[];
  [key: string]: unknown;
}

export interface UsageSample {
  app?: string;
  hostname?: string;
  url?: string;
  device?: string;
  [key: string]: unknown;
}

export interface UsageBucket {
  totalSeconds: number;
  apps: Record<string, number>;
  sites: Record<string, number>;
  opens: {
    apps: Record<string, number>;
    sites: Record<string, number>;
  };
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface UsageDay extends UsageBucket {
  devices: Record<string, UsageBucket>;
  deviceTotalsMode?: string;
}

export type UsageState = Record<string, UsageDay>;

export interface MonitorHandle {
  status: UnknownRecord;
  stop(): void;
  enforceImmediately(reason?: string): Promise<UnknownRecord>;
}

export interface WithStatusError extends Error {
  status: number;
}
