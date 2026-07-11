export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type UnknownRecord = Record<string, unknown>;

export type DeviceTarget = "computer" | "phone";
export type DeviceTargetInput = DeviceTarget | string;
export type LockLevel = "light" | "deep";
export type ProfileMode = "blocklist" | "allowlist";
export type PolicyPhaseKind = "work" | "break";
export type ActivePolicyKind = "baseline" | "manual" | "schedule" | "planner" | "panic" | "integrity" | "app-lock" | "limit" | "browser-control" | "content-filter" | "adult-blocklist" | "url-pattern" | "allowlist";
export type LimitRuleType = "time" | "open";

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
  deviceTargets?: DeviceTarget[];
  profileSnapshot?: Profile;
  cycle?: SessionCycle;
  active?: boolean;
  lockId?: string;
  ruleId?: string;
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
  deviceTargets?: DeviceTarget[];
}

export interface GrayscaleSchedule {
  id: string;
  name: string;
  enabled: boolean;
  days: number[];
  start: string;
  end: string;
  deviceTargets?: DeviceTarget[];
}

export interface PolicyPhase {
  kind: PolicyPhaseKind;
  label: string;
  blocking: boolean;
  round: number;
  rounds: number;
  startsAt: string;
  endsAt: string;
}

export interface ActivePolicyContributor {
  kind: ActivePolicyKind;
  sessionId: string;
  profileId: string;
  endsAt: string;
  scheduleId?: string;
  plannerBlockId?: string;
  emergencyUnlocksAllowed?: boolean;
}

export interface ActivePolicy {
  kind: ActivePolicyKind;
  session: Session;
  profile: Profile;
  schedule?: Schedule;
  plannerBlock?: IntentionalPlanBlock;
  endsAt: string;
  phase?: PolicyPhase | null;
  appLock?: AppLockRule;
  limitBlock?: LimitBlock;
  browserControl?: { area: string; label: string; url: string };
  contentFilter?: UnknownRecord & { id?: string; label: string };
  urlPattern?: { pattern: string; label: string };
  alarm?: unknown;
  contributors?: ActivePolicyContributor[];
}

export interface AppSettings {
  pollIntervalMs: number;
  idleUsageTrackingEnabled: boolean;
  idleUsageThresholdSeconds: number;
  strictByDefault: boolean;
  emergencyTokensPerWeek: number;
  emergencyDelaySeconds: number;
  panicLockDurationMinutes: number;
  intentReasonEnabled: boolean;
  intentReasonMinLength: number;
  focusSoundEnabled: boolean;
  focusSoundMode: string;
  focusSoundActivity: string;
  focusSoundPreset: string;
  focusSoundIntensity: string;
  focusSoundTimerMode: string;
  focusSoundTimerMinutes: number;
  focusSoundBreakMinutes: number;
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
  adultBlocklistEnabled: boolean;
  adultBlocklistSourceId: string;
  adultBlocklistCustomUrl: string;
  adultBlocklistPreloadLimit: number;
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
  systemNetworkBlockingEnabled: boolean;
  safariUrlFilterEnabled: boolean;
  externalNetworkBlockEnabled: boolean;
  externalNetworkBlockProvider: string;
  hostsBlockingEnabled: boolean;
  protectedEditsEnabled: boolean;
  protectedEditDelaySeconds: number;
  protectedEditWindowMinutes: number;
  runtimeGapLockdownSeconds: number;
  clockTamperLockdownSeconds: number;
}

export interface AdultBlocklistSourceSnapshot {
  id: string;
  label: string;
  url: string;
  homepage: string;
  license: string;
}

export interface AdultBlocklistState {
  allowlist: string[];
  domainCount: number;
  activeDomainCount: number;
  hash: string;
  snapshotPath: string;
  lastAttemptAt: string | null;
  lastRefreshAt: string | null;
  lastError: string;
  source: AdultBlocklistSourceSnapshot | null;
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
  type: LimitRuleType;
  lockLevel: LockLevel;
  days: number[];
  apps: string[];
  sites: string[];
  limitMinutes: number;
  unlocksAllowed: number;
  blockMinutes: number;
  requiredProfileId?: string;
  excludedProfileIds?: string[];
  cycleAnchorDateKey?: string;
  cycleAnchorSeconds?: number;
  cycleAnchorOpens?: number;
}

export interface LimitBlock {
  id: string;
  ruleId: string;
  ruleName: string;
  type: LimitRuleType;
  lockLevel: LockLevel;
  apps: string[];
  sites: string[];
  createdAt: string;
  until: string;
  progress?: LimitProgress;
  requiredProfileId?: string;
  excludedProfileIds?: string[];
  deviceTargets?: DeviceTarget[];
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
}

export interface AppLockUnlock {
  id: string;
  lockId: string;
  lockName?: string;
  createdAt: string;
  until: string;
  reason?: string;
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
}

export interface TypingChallenge {
  kind: string;
  text: string;
  createdAt: string;
}

export interface OverrideRecord {
  id?: string;
  scheduleId?: string;
  limitRuleId?: string;
  until: string;
  createdAt?: string;
  reason?: string;
}

export interface EmergencyPolicyContributor {
  kind: "manual" | "schedule" | "planner";
  sessionId: string;
  profileId: string;
  endsAt: string;
  scheduleId?: string;
  plannerBlockId?: string;
  emergencyUnlocksAllowed?: boolean;
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
  plannerBlockId?: string | null;
  policyContributors?: EmergencyPolicyContributor[];
  limitBlockIds?: string[];
  limitRuleIds?: string[];
  until?: string;
  delaySeconds?: number;
  intervention?: UnknownRecord;
  challenge?: TypingChallenge;
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
  urlPatterns?: string[];
  delaySeconds: number;
  sessionMinutes: number;
  dailyBudgetMinutes: number;
  budgetWarningPercent?: number;
  askMood?: boolean;
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
  budget?: UnknownRecord | null;
  context?: UnknownRecord | null;
  completedAt?: string;
  intention?: string;
  replacement?: string;
  mood?: string;
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

export interface IntentionalBehavior {
  id: string;
  name: string;
  description: string;
  direction: "build" | "reduce" | "notice";
  unit: "count" | "minutes" | "yes-no";
  weeklyTarget: number;
  ruleIds: string[];
  replacement: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentionalBehaviorCheckIn {
  id: string;
  behaviorId: string;
  behaviorName: string;
  value: number;
  note: string;
  at: string;
  dateKey: string;
  weekKey: string;
  journalEntryId?: string;
}

export interface IntentionalJournalEntry {
  id: string;
  title: string;
  body: string;
  mood: string;
  energy: number | null;
  tags: string[];
  behaviorIds: string[];
  ruleIds: string[];
  createdAt: string;
  updatedAt: string;
  entryDate: string;
}

export interface JournalVaultState {
  passwordSalt: string;
  passwordHash: string;
  passwordSetAt: string | null;
  autoLockMinutes: number;
}

export type IntentionalPlanListKind = "todo" | "watch" | "read" | "custom";
export type IntentionalPlanItemStatus = "open" | "done" | "archived";

export interface IntentionalPlanList {
  id: string;
  name: string;
  kind: IntentionalPlanListKind;
  description: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntentionalPlanItem {
  id: string;
  listId: string;
  title: string;
  notes: string;
  status: IntentionalPlanItemStatus;
  dueAt: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface IntentionalPlanBlock {
  id: string;
  title: string;
  notes: string;
  listId: string;
  itemId: string;
  startsAt: string;
  endsAt: string;
  enabled: boolean;
  completed: boolean;
  mode: string;
  profileId: string;
  lockLevel: LockLevel;
  commitmentLock: boolean;
  deviceTargets: DeviceTarget[];
  createdAt: string;
  updatedAt: string;
}

export type IntentionalRecoveryStatus = "clean" | "urge" | "setback" | "victory";
export type IntentionalRecoveryKind = "daily" | "sos" | "manual";

export interface IntentionalRecoveryCheckIn {
  id: string;
  kind: IntentionalRecoveryKind;
  status: IntentionalRecoveryStatus;
  mood: string;
  urgeIntensity: number;
  stress: number | null;
  sleepHours: number | null;
  exerciseMinutes: number | null;
  trigger: string;
  action: string;
  note: string;
  at: string;
  dateKey: string;
  weekKey: string;
}

export interface IntentionalSosSession {
  id: string;
  intent: string;
  trigger: string;
  urgeIntensity: number;
  reasonWhy: string;
  replacement: string;
  plan: string[];
  startedAt: string;
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

export interface IntentionalAccountabilityState {
  enabled?: boolean;
  partnerName?: string;
  cadence?: string;
  digest?: {
    text?: string;
    generatedAt?: string;
  };
}

export interface IntentionalUseState {
  goal: IntentionalUseGoal;
  rules: IntentionalUseRule[];
  pauses: IntentionalPause[];
  grants: IntentionalGrant[];
  ledger: Record<string, IntentionalDayLedger>;
  outcomes: IntentionalOutcome[];
  behaviors: IntentionalBehavior[];
  behaviorCheckIns: IntentionalBehaviorCheckIn[];
  journalEntries: IntentionalJournalEntry[];
  journalVault: JournalVaultState;
  planLists: IntentionalPlanList[];
  planItems: IntentionalPlanItem[];
  planBlocks: IntentionalPlanBlock[];
  recoveryCheckIns: IntentionalRecoveryCheckIn[];
  sosSessions: IntentionalSosSession[];
  accountability: IntentionalAccountabilityState;
}

export interface StateSealState {
  lastCheckedAt?: string | null;
  lastSealedAt?: string | null;
  lastStatus?: string;
  lastDetail?: string;
  tamperDetectedAt?: string | null;
  tamperDetail?: string;
}

export interface UsageSealState {
  required: boolean;
  migrationVersion: number;
  migratedAt: string | null;
}

export interface HardeningIssue {
  id: string;
  detail: string;
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
}

export interface MaintenanceRequest {
  id: string;
  status: string;
  reason: string;
  requestedAt: string;
  eligibleAt: string;
  expiresAt: string;
  challenge?: TypingChallenge;
}

export interface MaintenanceWindow {
  id: string;
  requestId: string;
  reason: string;
  createdAt: string;
  until: string;
}

export interface KeyholderState {
  enabled: boolean;
  salt: string | null;
  hash: string | null;
  updatedAt: string | null;
}

export interface DistanceKeyState {
  enabled: boolean;
  salt: string | null;
  hash: string | null;
  keyFilePath: string;
  updatedAt: string | null;
  lastVerifiedAt: string | null;
  lastFileVerifiedAt: string | null;
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
}

export interface GrayscaleState {
  softBlockEnabled: boolean;
  preventManualChanges: boolean;
  schedules: GrayscaleSchedule[];
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
  enrollmentTokens: Record<string, unknown>[];
  devices: Record<string, unknown>[];
  commands: Record<string, unknown>[];
  lastEnrollmentProfileGeneratedAt: string | null;
  lastCheckInAt: string | null;
  lastCommandQueuedAt: string | null;
  lastPushAt: string | null;
  lastPushStatus: string;
  lastPushError: string;
  lastPolicyHash: string;
  lastGrayscaleHash: string;
  lastGrayscaleCommandQueuedAt: string | null;
}

export type FocusedSocialPlatformId = "instagram" | "youtube" | "snapchat";

export interface FocusedSocialPlatformSettings {
  enabled: boolean;
  reels?: boolean;
  shorts?: boolean;
  spotlight?: boolean;
  stories?: boolean;
  home?: boolean;
  explore: boolean;
  suggested: boolean;
  shopping?: boolean;
  ads: boolean;
}

export interface FocusedSocialSettings {
  enabled: boolean;
  forceWebClips: boolean;
  instagram: FocusedSocialPlatformSettings & {
    reels: boolean;
    shopping: boolean;
  };
  youtube: FocusedSocialPlatformSettings & {
    shorts: boolean;
    home: boolean;
  };
  snapchat: FocusedSocialPlatformSettings & {
    spotlight: boolean;
    stories: boolean;
  };
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
  allowSafariHistoryClearing: boolean;
  blockedAppBundleIds: string[];
  allowedAppBundleIds: string[];
  deniedUrls: string[];
  allowedUrls: string[];
  focusedSocial: FocusedSocialSettings;
  removalPassword: string | null;
  lastGeneratedAt: string | null;
  profileId?: string;
  mdm: IosMdmSettings;
}

export interface ExtensionState {
  lastSeenAt?: string | null;
  lastVersion?: string | null;
  lastEvent?: string | null;
  lastHost?: string | null;
  dynamicRules: Record<string, unknown>;
}

export interface EnvironmentState {
  wifiSsid: string;
  wifiCheckedAt: string | null;
  wifiError: string;
}

export interface IntegrityState {
  stateSeal: StateSealState;
  usageSeal: UsageSealState;
  runtime: IntegrityRuntimeState;
}

export interface DeviceControlsState {
  ios: IosSettings;
}

export interface VigilState {
  version: number;
  createdAt: string;
  settings: AppSettings;
  adultBlocklist: AdultBlocklistState;
  profiles: Profile[];
  schedules: Schedule[];
  limitRules: LimitRule[];
  limitBlocks: LimitBlock[];
  appLocks: AppLockRule[];
  appLockUnlocks: AppLockUnlock[];
  appLockRequests: AppLockRequest[];
  appLockLedger: Record<string, Record<string, number>>;
  intentionalUse: IntentionalUseState;
  extension: ExtensionState;
  focusShortcut: FocusShortcutState;
  environment: EnvironmentState;
  keyholder: KeyholderState;
  distanceKey: DistanceKeyState;
  integrity: IntegrityState;
  grayscale: GrayscaleState;
  deviceControls: DeviceControlsState;
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
}

export interface UsageSample {
  app?: string;
  hostname?: string;
  url?: string;
  device?: string;
}

export interface UsageBucket {
  totalSeconds: number;
  apps: Record<string, number>;
  sites: Record<string, number>;
  contexts?: Record<string, number>;
  openContexts?: Record<string, number>;
  contextVersion?: 1;
  openContextVersion?: 1;
  legacyTargetAggregation?: "max" | "sum";
  opens: {
    apps: Record<string, number>;
    sites: Record<string, number>;
  };
  updatedAt?: string | null;
}

export interface UsageDay extends UsageBucket {
  devices: Record<string, UsageBucket>;
  deviceTotalsMode?: string;
}

export type UsageState = Record<string, UsageDay>;

export interface MonitorHandle {
  status: UnknownRecord;
  stop(): Promise<void>;
  enforceImmediately(reason?: string): Promise<UnknownRecord>;
}
