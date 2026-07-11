import { currentMacAccountStatus } from "../account.js";
import { adultBlocklistSummary } from "../adultBlocklist.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { buildFirewallBlock, buildPfConfBlock, firewallStatus } from "../firewall.js";
import { focusShortcutSummary } from "../focusHooks.js";
import { externalNetworkBlockSummary } from "../externalNetworkBlock.js";
import { grayscaleSummary } from "../grayscale.js";
import { assertFoolproofReadyForStrict, foolproofSummary } from "../foolproof.js";
import { buildHostsBlock, hostsStatus, launchAgentPath, launchAgentStatus, managedBlockDomains, stateSealStatus } from "../hardening.js";
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
import { safariFilterStatus } from "../safariFilter.js";
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
}

interface StrictPreflightOptions {
  now?: Date;
  mode?: string;
  lockLevel?: LockLevel;
  monitorStatus?: UnknownRecord;
}

interface DiagnosticSnapshot {
  hosts: Awaited<ReturnType<typeof hostsStatus>>;
  firewall: Awaited<ReturnType<typeof firewallStatus>>;
  agent: Awaited<ReturnType<typeof launchAgentStatus>>;
  account: Awaited<ReturnType<typeof currentMacAccountStatus>>;
  stateSeal: Awaited<ReturnType<typeof stateSealStatus>>;
  sourceSeal: Awaited<ReturnType<typeof sourceSealStatus>>;
  safariFilter: Awaited<ReturnType<typeof safariFilterStatus>>;
  devices: Awaited<ReturnType<typeof deviceSummary>>;
  hostsBlock: string;
}

const DIAGNOSTIC_CACHE_MS = 30_000;
let diagnosticCache: { expiresAt: number; key: string; promise: Promise<DiagnosticSnapshot> } | null = null;

export function invalidateStateDiagnostics(): void {
  diagnosticCache = null;
}

export async function buildStatePayload({ state, usage, monitor, activePort, startedAt, localScripts }: BuildStatePayloadInput) {
  const currentState = structuredClone(state);
  const currentUsage = structuredClone(usage);
  const monitorStatus = structuredClone(monitor.status);
  const policy = activePolicy(currentState);
  const { hosts, firewall, agent, account, stateSeal, sourceSeal, safariFilter, devices, hostsBlock } = await stateDiagnostics(currentState);
  const externalNetworkBlock = externalNetworkBlockSummary(currentState);
  const adultBlocklist = adultBlocklistSummary(currentState);
  const protection = protectionSummary(currentState);
  const foolproof = foolproofSummary(currentState, { hosts, firewall, safariFilter, agent, account, monitor: monitorStatus, stateSeal, sourceSeal });

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
        audit: hardeningAudit({ state: currentState, hosts, firewall, safariFilter, externalNetworkBlock, agent, account, protection, monitor: monitorStatus, foolproof, stateSeal, sourceSeal })
      }
    },
    headers: vigilStateHeaders()
  };
}

async function stateDiagnostics(state: VigilState): Promise<DiagnosticSnapshot> {
  const now = Date.now();
  const key = diagnosticStateKey(state);
  if (diagnosticCache && diagnosticCache.key === key && diagnosticCache.expiresAt > now) return await diagnosticCache.promise;
  const promise = Promise.all([
    hostsStatus(state),
    firewallStatus(state),
    launchAgentStatus(),
    currentMacAccountStatus(),
    stateSealStatus(state),
    sourceSealStatus(),
    safariFilterStatus(state),
    deviceSummary(state),
    buildNetworkPreview(state)
  ]).then(([hosts, firewall, agent, account, stateSeal, sourceSeal, safariFilter, devices, hostsBlock]) => ({
    hosts,
    firewall,
    agent,
    account,
    stateSeal,
    sourceSeal,
    safariFilter,
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

function diagnosticStateKey(state: VigilState): string {
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
    buildHostsBlock(state),
    "",
    buildPfConfBlock(),
    "",
    buildFirewallBlock(domains)
  ].join("\n");
}

export async function strictPreflightStatus(state: VigilState, profile: Profile | null | undefined, options: StrictPreflightOptions = {}): Promise<void> {
  const now = options.now || new Date();
  const preflightState = profile ? strictPreflightState(state, profile, {
    mode: options.mode,
    lockLevel: options.lockLevel,
    now
  }) : state;
  const hosts = await hostsStatus(preflightState, now);
  const firewall = await firewallStatus(preflightState, now);
  const safariFilter = await safariFilterStatus(preflightState, now);
  const agent = await launchAgentStatus();
  const account = await currentMacAccountStatus();
  const stateSeal = await stateSealStatus(preflightState);
  const sourceSeal = await sourceSealStatus();
  assertFoolproofReadyForStrict(preflightState, { hosts, firewall, safariFilter, agent, account, monitor: options.monitorStatus, stateSeal, sourceSeal }, now);
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
