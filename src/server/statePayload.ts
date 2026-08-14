import { createHash } from "node:crypto";
import { currentMacAccountStatus } from "../account.js";
import { adultBlocklistSummary } from "../adultBlocklist.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { buildFirewallBlock, buildPfConfBlock, firewallStatus } from "../firewall.js";
import { focusShortcutSummary } from "../focusHooks.js";
import { externalNetworkBlockSummary } from "../externalNetworkBlock.js";
import { grayscaleSummary } from "../grayscale.js";
import { assertFoolproofReadyForStrict, foolproofSummary } from "../foolproof.js";
import { buildResolvedHostsBlock, hostsStatus, launchAgentPath, launchAgentStatus, managedBlockDomains, stateSealStatus } from "../hardening.js";
import { appLockSummary } from "../appLocks.js";
import { limitSummary } from "../limits.js";
import { activePolicy, activeProfile, sessionPhase, snapshotProfile } from "../policy.js";
import { distanceKeySummary } from "../distanceKey.js";
import { deviceSummary } from "../devices.js";
import { interventionSummary } from "../intervention.js";
import { intentionalUseSummary } from "../intentionalUse.js";
import { keyholderSummary } from "../keyholder.js";
import { protectionSummary } from "../protection.js";
import { distractionPresets } from "../presets.js";
import { focusReport } from "../reports.js";
import { vigilAppInfo, vigilStateHeaders } from "../vigilHealth.js";
import { safariFilterPolicySignature, safariFilterStatus } from "../safariFilter.js";
import { attestChromeSafeSearchStatus, chromeSafeSearchStatus } from "../chromeSafeSearch.js";
import { sourceSealStatus } from "../sourceSeal.js";
import { weekKey } from "../time.js";
import { usageSummary } from "../usage.js";
import { publicIosMdmSettings } from "../iosMdm.js";
import { publicIosSettings } from "../iosProfiles.js";
import { hardeningActions, hardeningAudit } from "./hardeningSummary.js";
import type { ActivePolicy, IosSettings, LockLevel, MonitorHandle, Profile, VigilState, UnknownRecord, UsageState } from "../types.js";

interface LocalScriptsSummary {
  localScriptCommand: (scriptName: string, options?: UnknownRecord) => unknown;
  resourcePath: (resourceName: string) => string;
}

interface BuildStatePayloadInput {
  state: VigilState;
  usage: UsageState;
  monitor: MonitorHandle;
  activePort: number;
  startedAt: string | null;
  localScripts: LocalScriptsSummary;
  manageEngineOutputDirectory: string;
}

export interface StrictPreflightOptions {
  now?: Date;
  mode?: string;
  lockLevel?: LockLevel;
  monitorStatus?: UnknownRecord;
  evidence?: StrictPreflightEvidence;
}

export const STRICT_PREFLIGHT_EVIDENCE_MAX_AGE_MS = 30_000;

export interface StrictPreflightEvidence {
  evaluatedAt: string;
  collectedAt: string;
  relevanceFingerprint: string;
  hosts: Awaited<ReturnType<typeof hostsStatus>>;
  firewall: Awaited<ReturnType<typeof firewallStatus>>;
  safariFilter: Awaited<ReturnType<typeof safariFilterStatus>>;
  chromeSafeSearch: Awaited<ReturnType<typeof attestChromeSafeSearchStatus>>;
  agent: Awaited<ReturnType<typeof launchAgentStatus>>;
  account: Awaited<ReturnType<typeof currentMacAccountStatus>>;
  stateSeal: Awaited<ReturnType<typeof stateSealStatus>>;
  sourceSeal: Awaited<ReturnType<typeof sourceSealStatus>>;
}

export class StrictPreflightEvidenceStaleError extends Error {
  readonly status = 409;

  constructor(detail = "Strict-lock hardening evidence became stale while the request was waiting. Please try again.") {
    super(detail);
    this.name = "StrictPreflightEvidenceStaleError";
  }
}

export interface StrictPreflightEvidenceCollectors {
  hostsStatus: typeof hostsStatus;
  firewallStatus: typeof firewallStatus;
  safariFilterStatus: typeof safariFilterStatus;
  attestChromeSafeSearchStatus: typeof attestChromeSafeSearchStatus;
  launchAgentStatus: typeof launchAgentStatus;
  currentMacAccountStatus: typeof currentMacAccountStatus;
  stateSealStatus: typeof stateSealStatus;
  sourceSealStatus: typeof sourceSealStatus;
}

interface DiagnosticSnapshot {
  hosts: Awaited<ReturnType<typeof hostsStatus>>;
  firewall: Awaited<ReturnType<typeof firewallStatus>>;
  agent: Awaited<ReturnType<typeof launchAgentStatus>>;
  account: Awaited<ReturnType<typeof currentMacAccountStatus>>;
  stateSeal: Awaited<ReturnType<typeof stateSealStatus>>;
  sourceSeal: Awaited<ReturnType<typeof sourceSealStatus>>;
  safariFilter: Awaited<ReturnType<typeof safariFilterStatus>>;
  chromeSafeSearch: Awaited<ReturnType<typeof chromeSafeSearchStatus>>;
  devices: Awaited<ReturnType<typeof deviceSummary>>;
  hostsBlock: string;
}

const DIAGNOSTIC_CACHE_MS = 30_000;
let diagnosticCache: { expiresAt: number; key: string; promise: Promise<DiagnosticSnapshot> } | null = null;

export function invalidateStateDiagnostics(): void {
  diagnosticCache = null;
}

export async function buildStatePayload({ state, usage, monitor, activePort, startedAt, localScripts, manageEngineOutputDirectory }: BuildStatePayloadInput) {
  const currentState = structuredClone(state);
  const currentUsage = structuredClone(usage);
  const monitorStatus = structuredClone(monitor.status);
  const policy = activePolicy(currentState);
  const { hosts, firewall, agent, account, stateSeal, sourceSeal, safariFilter, chromeSafeSearch, devices, hostsBlock } = await stateDiagnostics(currentState, manageEngineOutputDirectory);
  const externalNetworkBlock = externalNetworkBlockSummary(currentState);
  const adultBlocklist = adultBlocklistSummary(currentState);
  const protection = protectionSummary(currentState);
  const foolproof = foolproofSummary(currentState, { hosts, firewall, safariFilter, chromeSafeSearch, agent, account, monitor: monitorStatus, stateSeal, sourceSeal });

  return {
    body: {
      app: vigilAppInfo({ port: activePort, startedAt }),
      state: publicState(currentState, policy),
      usage: usageSummary(currentUsage, currentState),
      report: focusReport(currentUsage, currentState),
      intentionalUse: intentionalUseSummary(currentState, currentUsage),
      limits: limitSummary(currentState, currentUsage),
      appLocks: appLockSummary(currentState),
      devices,
      protection,
      intervention: interventionSummary(currentState),
      monitor: monitorStatus,
      presets: distractionPresets(),
      hardening: {
        hosts,
        firewall,
        safariFilter,
        chromeSafeSearch,
        externalNetworkBlock,
        adultBlocklist,
        launchAgent: agent,
        account,
        stateSeal,
        sourceSeal,
        launchAgentPath: launchAgentPath(),
        hostsBlock,
        actions: hardeningActions(localScripts),
        foolproof,
        audit: hardeningAudit({ state: currentState, hosts, firewall, safariFilter, chromeSafeSearch, externalNetworkBlock, agent, account, protection, monitor: monitorStatus, foolproof, stateSeal, sourceSeal })
      }
    },
    headers: vigilStateHeaders()
  };
}

async function stateDiagnostics(state: VigilState, manageEngineOutputDirectory: string): Promise<DiagnosticSnapshot> {
  const now = Date.now();
  const key = diagnosticStateKey(state, manageEngineOutputDirectory);
  if (diagnosticCache && diagnosticCache.key === key && diagnosticCache.expiresAt > now) return await diagnosticCache.promise;
  const promise = Promise.all([
    hostsStatus(state),
    firewallStatus(state),
    launchAgentStatus(),
    currentMacAccountStatus(),
    stateSealStatus(state),
    sourceSealStatus(),
    safariFilterStatus(state),
    chromeSafeSearchStatus(),
    deviceSummary(state, { manageEngineOutputDirectory }),
    buildNetworkPreview(state)
  ]).then(([hosts, firewall, agent, account, stateSeal, sourceSeal, safariFilter, chromeSafeSearch, devices, hostsBlock]) => ({
    hosts,
    firewall,
    agent,
    account,
    stateSeal,
    sourceSeal,
    safariFilter,
    chromeSafeSearch,
    devices,
    hostsBlock
  }));
  diagnosticCache = { expiresAt: now + DIAGNOSTIC_CACHE_MS, key, promise };
  try {
    return await promise;
  } catch (error) {
    if (diagnosticCache?.promise === promise) diagnosticCache = null;
    throw error;
  }
}

function diagnosticStateKey(state: VigilState, manageEngineOutputDirectory: string): string {
  return JSON.stringify({
    settings: state.settings,
    profiles: state.profiles,
    schedules: state.schedules,
    activeSessions: state.activeSessions,
    activeSession: state.activeSession,
    panicLock: state.panicLock,
    limitBlocks: state.limitBlocks,
    appLocks: state.appLocks,
    appLockUnlocks: state.appLockUnlocks,
    deviceControls: diagnosticDeviceControls(state),
    manageEngineOutputDirectory,
    adultBlocklist: state.adultBlocklist,
    intentionalUse: {
      pauses: state.intentionalUse?.pauses,
      grants: state.intentionalUse?.grants,
      planBlocks: state.intentionalUse?.planBlocks
    },
    overrides: state.overrides,
    environment: {
      wifiSsid: state.environment?.wifiSsid
    },
    grayscale: state.grayscale,
    stateSeal: {
      tamperDetectedAt: state.integrity?.stateSeal?.tamperDetectedAt,
      tamperDetail: state.integrity?.stateSeal?.tamperDetail
    }
  });
}

function diagnosticDeviceControls(state: VigilState): UnknownRecord {
  const ios = state.deviceControls?.ios || {};
  const mdm = ios.mdm || {};
  return {
    ios: {
      enabled: ios.enabled,
      status: ios.status,
      mode: ios.mode,
      webMode: ios.webMode,
      blockApps: ios.blockApps,
      blockWeb: ios.blockWeb,
      hardenRemoval: ios.hardenRemoval,
      restrictInstallAndErase: ios.restrictInstallAndErase,
      allowSafariHistoryClearing: ios.allowSafariHistoryClearing,
      blockedAppBundleIds: ios.blockedAppBundleIds,
      allowedAppBundleIds: ios.allowedAppBundleIds,
      deniedUrls: ios.deniedUrls,
      allowedUrls: ios.allowedUrls,
      focusedSocial: ios.focusedSocial,
      manageEngineGeneration: ios.manageEngineGeneration ? {
        version: ios.manageEngineGeneration.version,
        generatedAt: ios.manageEngineGeneration.generatedAt,
        generation: ios.manageEngineGeneration.generation,
        profileHash: ios.manageEngineGeneration.profileHash
      } : null,
      mdm: {
        enabled: mdm.enabled,
        publicBaseUrl: mdm.publicBaseUrl,
        topic: mdm.topic,
        identityCertificateUuid: mdm.identityCertificateUuid,
        hasIdentityCertificate: Boolean(mdm.identityCertificatePayloadBase64),
        hasPushCertificate: Boolean(mdm.pushCertificatePayloadBase64),
        accessRights: mdm.accessRights,
        signMessage: mdm.signMessage,
        useDevelopmentApns: mdm.useDevelopmentApns,
        checkOutWhenRemoved: mdm.checkOutWhenRemoved,
        deviceCount: mdm.devices?.length || 0,
        pendingCommandCount: mdm.commands?.filter((command) => ["queued", "sent"].includes(String(command.status))).length || 0
      }
    }
  };
}

export function publicState(current: VigilState, policy: ActivePolicy | null) {
  return {
    settings: current.settings,
    adultBlocklist: current.adultBlocklist,
    profiles: current.profiles,
    schedules: current.schedules,
    limitRules: current.limitRules || [],
    limitBlocks: current.limitBlocks || [],
    appLocks: current.appLocks || [],
    appLockUnlocks: current.appLockUnlocks || [],
    appLockRequests: current.appLockRequests || [],
    extension: current.extension || {},
    focusShortcut: focusShortcutSummary(current),
    grayscale: grayscaleSummary(current),
    deviceControls: {
      ...(current.deviceControls || {}),
      ios: publicIosState(current.deviceControls?.ios || {})
    },
    environment: current.environment || {},
    keyholder: keyholderSummary(current),
    distanceKey: distanceKeySummary(current),
    panicLock: current.panicLock || null,
    activeSessions: current.activeSessions || { computer: current.activeSession || null, phone: null },
    activeSession: current.activeSession,
    sessionPhase: sessionPhase(current.activeSession),
    activePolicy: publicPolicy(policy),
    devicePolicies: publicDevicePolicies(current),
    emergency: {
      remaining: emergencyRemaining(current),
      usedThisWeek: current.emergency.tokensUsedByWeek[weekKey()] || 0,
      pending: current.emergency.pending
    },
    overrides: current.overrides,
    events: current.events.slice(0, 50),
    activeProfile: activeProfile(current)
  };
}

export function publicIosState(ios: Partial<IosSettings> = {}) {
  return {
    ...publicIosSettings(ios),
    mdm: publicIosMdmSettings(ios.mdm || {})
  };
}

export function publicDevicePolicies(current: VigilState) {
  return Object.fromEntries(DEVICE_TARGETS.map((target) => {
    const policy = activePolicy(current, new Date(), { device: target });
    return [target, publicPolicy(policy)];
  }));
}

export async function buildNetworkPreview(state: VigilState): Promise<string> {
  const domains = managedBlockDomains(state);
  return [
    await buildResolvedHostsBlock(state),
    "",
    buildPfConfBlock(),
    "",
    buildFirewallBlock(domains)
  ].join("\n");
}

export async function collectStrictPreflightEvidence(
  state: VigilState,
  profile: Profile | null | undefined,
  options: Omit<StrictPreflightOptions, "evidence" | "monitorStatus"> = {},
  collectorOverrides: Partial<StrictPreflightEvidenceCollectors> = {}
): Promise<StrictPreflightEvidence> {
  // This instant is both the policy evaluation time and the beginning of the
  // external collection window. Do not stamp freshness after Promise.all:
  // one fast attestor can otherwise wait behind a slow peer and be presented
  // as newly collected when the batch finally resolves.
  const evaluatedAt = options.now || new Date();
  const collectedAt = evaluatedAt;
  const normalizedState = normalizedStrictPreflightState(state, evaluatedAt);
  const collectors: StrictPreflightEvidenceCollectors = {
    hostsStatus,
    firewallStatus,
    safariFilterStatus,
    attestChromeSafeSearchStatus,
    launchAgentStatus,
    currentMacAccountStatus,
    stateSealStatus,
    sourceSealStatus,
    ...collectorOverrides
  };
  const preflightState = () => profile ? strictPreflightState(structuredClone(normalizedState), profile, {
    mode: options.mode,
    lockLevel: options.lockLevel,
    now: evaluatedAt
  }) : structuredClone(normalizedState);
  const [hosts, firewall, safariFilter, chromeSafeSearch, agent, account, stateSeal, sourceSeal] = await Promise.all([
    collectors.hostsStatus(preflightState(), evaluatedAt),
    collectors.firewallStatus(preflightState(), evaluatedAt),
    collectors.safariFilterStatus(preflightState(), evaluatedAt),
    collectors.attestChromeSafeSearchStatus(),
    collectors.launchAgentStatus(),
    collectors.currentMacAccountStatus(),
    collectors.stateSealStatus(preflightState()),
    collectors.sourceSealStatus()
  ]);
  return {
    evaluatedAt: evaluatedAt.toISOString(),
    collectedAt: collectedAt.toISOString(),
    relevanceFingerprint: strictPreflightRelevanceFingerprint(normalizedState, profile, options, evaluatedAt),
    hosts,
    firewall,
    safariFilter,
    chromeSafeSearch,
    agent,
    account,
    stateSeal,
    sourceSeal
  };
}

export function strictPreflightEvidenceIssue(
  state: VigilState,
  profile: Profile | null | undefined,
  evidence: StrictPreflightEvidence | null | undefined,
  options: Omit<StrictPreflightOptions, "evidence" | "monitorStatus"> = {}
): string | null {
  if (!evidence) return "Strict-lock hardening evidence was not collected before mutation admission.";
  const now = options.now || new Date();
  const collectedAt = Date.parse(evidence.collectedAt);
  const evaluatedAtMs = Date.parse(evidence.evaluatedAt);
  if (!Number.isFinite(collectedAt) || !Number.isFinite(evaluatedAtMs)) {
    return "Strict-lock hardening evidence has no valid evaluation time.";
  }
  const oldestEvidenceAt = Math.min(collectedAt, evaluatedAtMs);
  const newestEvidenceAt = Math.max(collectedAt, evaluatedAtMs);
  if (newestEvidenceAt > now.getTime() + 5_000
    || now.getTime() - oldestEvidenceAt > STRICT_PREFLIGHT_EVIDENCE_MAX_AGE_MS) {
    return "Strict-lock hardening evidence is no longer fresh.";
  }
  const normalizedState = normalizedStrictPreflightState(state, now);
  const expected = strictPreflightRelevanceFingerprint(normalizedState, profile, options, now);
  if (expected !== evidence.relevanceFingerprint) {
    return "Strict-lock hardening inputs changed while evidence was being collected.";
  }
  return null;
}

export async function strictPreflightStatus(state: VigilState, profile: Profile | null | undefined, options: StrictPreflightOptions = {}): Promise<void> {
  const now = options.now || new Date();
  const issue = strictPreflightEvidenceIssue(state, profile, options.evidence, {
    mode: options.mode,
    lockLevel: options.lockLevel,
    now
  });
  if (issue) throw new StrictPreflightEvidenceStaleError(issue);
  const evidence = options.evidence as StrictPreflightEvidence;
  const normalizedState = normalizedStrictPreflightState(state, now);
  const preflightState = profile ? strictPreflightState(normalizedState, profile, {
    mode: options.mode,
    lockLevel: options.lockLevel,
    now
  }) : normalizedState;
  assertFoolproofReadyForStrict(preflightState, {
    hosts: evidence.hosts,
    firewall: evidence.firewall,
    safariFilter: evidence.safariFilter,
    chromeSafeSearch: evidence.chromeSafeSearch,
    agent: evidence.agent,
    account: evidence.account,
    monitor: options.monitorStatus,
    stateSeal: evidence.stateSeal,
    sourceSeal: evidence.sourceSeal
  }, now);
}

function publicPolicy(policy: ActivePolicy | null) {
  return policy ? {
    kind: policy.kind,
    session: policy.session,
    profile: policy.profile,
    schedule: policy.schedule || null,
    plannerBlock: policy.plannerBlock || null,
    contributors: policy.contributors || [],
    endsAt: policy.endsAt,
    phase: policy.phase || null,
    alarm: policy.alarm || null
  } : null;
}

function emergencyRemaining(current: VigilState): number {
  const used = current.emergency.tokensUsedByWeek[weekKey()] || 0;
  return Math.max(0, current.settings.emergencyTokensPerWeek - used);
}

function strictPreflightState(state: VigilState, profile: Profile, options: StrictPreflightOptions = {}): VigilState {
  const now = options.now || new Date();
  return {
    ...state,
    activeSession: {
      id: "strict-preflight",
      title: profile.name || "Strict lock preflight",
      mode: options.mode || "focus",
      profileId: profile.id,
      lockLevel: options.lockLevel || "deep",
      startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60 * 1000).toISOString(),
      canEndEarly: false,
      source: "preflight",
      profileSnapshot: snapshotProfile(profile)
    }
  };
}

function normalizedStrictPreflightState(state: VigilState, now: Date): VigilState {
  const normalized = structuredClone(state);
  // Session routes normalize expired policy records before invoking their
  // strict check. Do the same outside mutation admission so expiry cleanup is
  // not mistaken for an unrelated state generation.
  activePolicy(normalized, now);
  return normalized;
}

function strictPreflightRelevanceFingerprint(
  normalizedState: VigilState,
  profile: Profile | null | undefined,
  options: Omit<StrictPreflightOptions, "evidence" | "monitorStatus">,
  now: Date
): string {
  const preflightState = profile ? strictPreflightState(structuredClone(normalizedState), profile, {
    mode: options.mode,
    lockLevel: options.lockLevel,
    now
  }) : structuredClone(normalizedState);
  const stateSeal = normalizedState.integrity?.stateSeal;
  const extension = normalizedState.extension || {};
  const dynamicRules = extension.dynamicRules || {};
  return createHash("sha256").update(JSON.stringify({
    settings: normalizedState.settings,
    // Volatile extension telemetry is intentionally omitted. It is evaluated
    // against the live draft inside strictPreflightStatus, so routine extension
    // check-ins must not invalidate unrelated system evidence. Version and the
    // fields that determine dynamic-rule readiness still form part of the
    // admission generation.
    extension: {
      lastVersion: extension.lastVersion || null,
      dynamicRules: {
        syncedAt: dynamicRules.syncedAt || null,
        count: dynamicRules.count ?? 0,
        signature: dynamicRules.signature || "",
        status: dynamicRules.status || "",
        ok: typeof dynamicRules.ok === "boolean" ? dynamicRules.ok : null,
        fallbackRequired: dynamicRules.fallbackRequired === true,
        error: dynamicRules.error || ""
      }
    },
    keyholder: {
      enabled: normalizedState.keyholder?.enabled,
      salt: normalizedState.keyholder?.salt,
      hash: normalizedState.keyholder?.hash
    },
    distanceKey: {
      enabled: normalizedState.distanceKey?.enabled,
      salt: normalizedState.distanceKey?.salt,
      hash: normalizedState.distanceKey?.hash,
      keyFilePath: normalizedState.distanceKey?.keyFilePath
    },
    stateSeal: {
      lastSealedAt: stateSeal?.lastSealedAt,
      tamperDetectedAt: stateSeal?.tamperDetectedAt,
      tamperDetail: stateSeal?.tamperDetail
    },
    requestedProfile: profile ? snapshotProfile(profile) : null,
    mode: options.mode || "focus",
    lockLevel: options.lockLevel || "deep",
    networkDomains: managedBlockDomains(preflightState, now),
    safariPolicySignature: safariFilterPolicySignature(preflightState, now)
  })).digest("hex");
}
