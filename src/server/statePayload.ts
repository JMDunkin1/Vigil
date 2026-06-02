import { currentMacAccountStatus } from "../account.js";
import { DEVICE_TARGETS } from "../defaults.js";
import { buildFirewallBlock, buildPfConfBlock, firewallStatus } from "../firewall.js";
import { focusShortcutSummary } from "../focusHooks.js";
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

export async function buildStatePayload({ state, usage, monitor, activePort, startedAt, localScripts }: BuildStatePayloadInput) {
  const policy = activePolicy(state);
  const hosts = await hostsStatus(state);
  const firewall = await firewallStatus(state);
  const agent = await launchAgentStatus();
  const account = await currentMacAccountStatus();
  const stateSeal = await stateSealStatus(state);
  const sourceSeal = await sourceSealStatus();
  const protection = protectionSummary(state);
  const devices = await deviceSummary(state);
  const foolproof = foolproofSummary(state, { hosts, firewall, agent, account, monitor: monitor.status, stateSeal, sourceSeal });

  return {
    body: {
      app: vigilAppInfo({ port: activePort, startedAt }),
      state: publicState(state, policy),
      usage: usageSummary(usage, state),
      report: focusReport(usage, state),
      intentionalUse: intentionalUseSummary(state, usage),
      limits: limitSummary(state, usage),
      appLocks: appLockSummary(state),
      devices,
      protection,
      intervention: interventionSummary(state),
      monitor: monitor.status,
      presets: distractionPresets(),
      hardening: {
        hosts,
        firewall,
        launchAgent: agent,
        account,
        stateSeal,
        sourceSeal,
        launchAgentPath: launchAgentPath(),
        hostsBlock: await buildNetworkPreview(state),
        actions: hardeningActions(localScripts),
        foolproof,
        audit: hardeningAudit({ state, hosts, firewall, agent, account, protection, monitor: monitor.status, foolproof, stateSeal, sourceSeal })
      }
    },
    headers: vigilStateHeaders()
  };
}

export function publicState(current: VigilState, policy: ActivePolicy | null) {
  return {
    settings: current.settings,
    profiles: current.profiles,
    schedules: current.schedules,
    limitRules: current.limitRules || [],
    limitBlocks: current.limitBlocks || [],
    appLocks: current.appLocks || [],
    appLockUnlocks: current.appLockUnlocks || [],
    appLockRequests: current.appLockRequests || [],
    extension: current.extension || {},
    focusShortcut: focusShortcutSummary(current),
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
  const agent = await launchAgentStatus();
  const account = await currentMacAccountStatus();
  const stateSeal = await stateSealStatus(preflightState);
  const sourceSeal = await sourceSealStatus();
  assertFoolproofReadyForStrict(preflightState, { hosts, firewall, agent, account, monitor: options.monitorStatus, stateSeal, sourceSeal }, now);
}

function publicPolicy(policy: ActivePolicy | null) {
  return policy ? {
    kind: policy.kind,
    session: policy.session,
    profile: policy.profile,
    schedule: policy.schedule || null,
    endsAt: policy.endsAt,
    phase: policy.phase || null
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
