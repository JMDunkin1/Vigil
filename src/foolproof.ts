import { keyholderSummary } from "./keyholder.js";
import { distanceKeySummary } from "./distanceKey.js";
import { stateSealSummary } from "./seal.js";
import { REQUIRED_EXTENSION_VERSION } from "./defaults.js";
import { extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "./extensionPolicy.js";
import { intentReasonPolicy } from "./intentReason.js";
import { safariFilterPathDenyUrls, safariUrlFilterEnabled } from "./safariFilter.js";
import { browserCompanionRequirement, networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import type { SentinelState, UnknownRecord } from "./types.js";

const EXTENSION_FRESH_MS = 5 * 60 * 1000;
const EXTENSION_RULES_FRESH_MS = 2 * 60 * 1000;

export class FoolproofError extends Error {
  status: number;
  blockers: FoolproofBlocker[];

  constructor(message: string, blockers: FoolproofBlocker[] = []) {
    super(message);
    this.status = 423;
    this.blockers = blockers;
  }
}

export interface FoolproofBlocker {
  id: string;
  detail: string;
}

interface FoolproofContext {
  hosts?: SummaryRecord;
  firewall?: SummaryRecord;
  safariFilter?: SummaryRecord;
  agent?: SummaryRecord;
  monitor?: SummaryRecord;
  stateSeal?: SummaryRecord;
  sourceSeal?: SummaryRecord;
  account?: SummaryRecord;
}

interface SummaryRecord extends UnknownRecord {
  ok?: boolean;
  detail?: string;
  username?: string;
  isAdmin?: boolean;
  installed?: boolean;
  partial?: boolean;
  stale?: boolean;
  current?: boolean;
  required?: boolean;
  pathUrlCount?: number;
  loaded?: boolean;
  running?: boolean;
  legacyInstalled?: boolean;
  accessibilityLikelyMissing?: boolean;
}

interface DynamicRulesState extends UnknownRecord {
  count?: number;
  syncedAt?: string;
  status?: string;
  ok?: boolean;
  error?: string;
  fallbackRequired?: boolean;
  signature?: string;
}

export function foolproofSummary(state: SentinelState, context: FoolproofContext = {}, now = new Date()) {
  const blockers = foolproofBlockers(state, context, now);
  return {
    enabled: Boolean(state.settings?.foolproofModeEnabled),
    ready: blockers.length === 0,
    blockers
  };
}

export function assertFoolproofReadyForStrict(state: SentinelState, context: FoolproofContext = {}, now = new Date()): void {
  if (!state.settings?.foolproofModeEnabled) return;
  const blockers = foolproofBlockers(state, context, now);
  if (blockers.length) {
    throw new FoolproofError("Foolproof mode is enabled. Finish the hardening checklist before starting a strict lock.", blockers);
  }
}

export function foolproofBlockers(state: SentinelState, context: FoolproofContext = {}, now = new Date()): FoolproofBlocker[] {
  const settings = state.settings;
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const hosts = context.hosts || {};
  const firewall = context.firewall || {};
  const safariFilter = context.safariFilter || {};
  const agent = context.agent || {};
  const monitor = context.monitor || {};
  const stateSeal = context.stateSeal || stateSealSummary(state);
  const sourceSeal = context.sourceSeal || {};
  const account = context.account || {};
  const dynamicRules = extensionDynamicRulesReady(state, now);
  const extensionSeen = extensionRecentlySeen(state, now);
  const extensionVersion = extensionVersionReady(state);
  const reasonPolicy = intentReasonPolicy(state);
  const networkCurrent = networkBlockCurrent(hosts, firewall);
  const companionRequirement = browserCompanionRequirement(state, now);
  const safariFilterRequired = safariUrlFilterEnabled(state) && safariFilterPathDenyUrls(state, now).length > 0;
  const blockers: FoolproofBlocker[] = [];

  if (!account.username) blockers.push(blocker("standard-account", "Mac account hardening status must be checked."));
  else if (account.isAdmin) blockers.push(blocker("standard-account", account.detail || "Use a standard daily macOS account for Foolproof mode."));
  if (!stateSeal.ok) blockers.push(blocker("state-seal", `State integrity seal must be healthy. ${stateSeal.detail}`));
  if (!sourceSeal.ok) blockers.push(blocker("source-seal", sourceSeal.detail || "Source integrity seal must be healthy."));
  if (!settings.protectedEditsEnabled) blockers.push(blocker("protected-edits", "Protected edits must be enabled."));
  if (!reasonPolicy.enabled) blockers.push(blocker("intent-reason", "Intentional breaks must require a written reason."));
  else if (reasonPolicy.minLength < 12) blockers.push(blocker("intent-reason", "Intentional break reasons must be at least 12 characters."));
  if (!keyholder.enabled || !keyholder.hasPasscode) blockers.push(blocker("keyholder", "Keyholder passcode must be enabled."));
  if (settings.typingChallengeEnabled === false) blockers.push(blocker("typing-challenge", "Unlock confirmations must require a random typing challenge."));
  if (!distanceKey.enabled || !distanceKey.hasToken) blockers.push(blocker("distance-key", "Distance key must be enabled and placed away from the computer, preferably as a removable key file."));
  if (!systemNetworkBlockingEnabled(state)) blockers.push(blocker("system-network-block", "System network blocking must be enabled for across-app site enforcement."));
  if (safariFilterRequired && !safariFilter.current) blockers.push(blocker("safari-url-filter", "Safari URL filter profile must be installed and current for Safari path-specific blocks."));
  if (!networkCurrent && !settings.siteRedirectEnabled) blockers.push(blocker("browser-redirect", "Browser redirect fallback must stay enabled until the system network block is current."));
  if (!settings.appQuitEnabled) blockers.push(blocker("app-quit", "App quit must be enabled."));
  if (!settings.strictBypassProtectionEnabled) blockers.push(blocker("bypass-protection", "Strict-lock bypass protection must be enabled."));
  if (!settings.processSweepEnabled) blockers.push(blocker("process-sweep", "Background process sweep must be enabled."));
  if (Number(settings.processSweepIntervalSeconds || 0) > 30) blockers.push(blocker("process-sweep-interval", "Background process sweep must run every 30 seconds or less."));
  if (Number(settings.appQuitEscalationSeconds || 0) > 30) blockers.push(blocker("app-escalation", "Forced-kill escalation must be 30 seconds or less."));
  if (!monitor.ok || monitor.accessibilityLikelyMissing) blockers.push(blocker("accessibility", "Foreground app detection must be working."));
  if (companionRequirement.required) {
    if (!extensionSeen) blockers.push(blocker("browser-extension", `Browser companion extension must check in recently. ${companionRequirement.detail}`));
    else if (!extensionVersion.ok) blockers.push(blocker("browser-extension-version", extensionVersion.detail));
    if (!dynamicRules.ok) blockers.push(blocker("extension-rules", dynamicRules.detail));
  }
  if (!agent.loaded || !agent.running) blockers.push(blocker("launch-agent", "LaunchAgent must be loaded and running."));
  else if (agent.legacyInstalled) blockers.push(blocker("launch-agent", "Legacy Local Screen Time LaunchAgent must be removed."));
  if (!hosts.installed || hosts.partial || hosts.stale) blockers.push(blocker("hosts", "Hosts block must be installed and current."));
  if (!firewall.installed || firewall.partial || firewall.stale) blockers.push(blocker("firewall", "PF firewall block must be installed and current."));

  return blockers;
}

export function extensionVersionReady(state: SentinelState) {
  const currentVersion = String(state.extension?.lastVersion || "").trim();
  if (currentVersion === REQUIRED_EXTENSION_VERSION) {
    return {
      ok: true,
      currentVersion,
      requiredVersion: REQUIRED_EXTENSION_VERSION,
      detail: `Companion extension is current (${currentVersion}).`
    };
  }
  return {
    ok: false,
    currentVersion: currentVersion || null,
    requiredVersion: REQUIRED_EXTENSION_VERSION,
    detail: currentVersion
      ? `Companion extension is ${currentVersion}; reload ${REQUIRED_EXTENSION_VERSION}.`
      : `Companion extension version has not checked in; reload ${REQUIRED_EXTENSION_VERSION}.`
  };
}

export function extensionRecentlySeen(state: SentinelState, now = new Date()): boolean {
  const lastSeen = Date.parse(String(state.extension?.lastSeenAt || ""));
  return Number.isFinite(lastSeen) && now.getTime() - lastSeen < EXTENSION_FRESH_MS;
}

export function extensionDynamicRulesReady(state: SentinelState, now = new Date()) {
  const dynamicRules = (state.extension?.dynamicRules || {}) as DynamicRulesState;
  const expectedSnapshot = extensionRuleSnapshot(state, now);
  const expectedCount = extensionDynamicRuleCount(expectedSnapshot);
  const expectedSignature = extensionDynamicRuleSignature(expectedSnapshot);
  const count = Number(dynamicRules.count || 0);
  const syncedAtText = String(dynamicRules.syncedAt || "");
  const syncedAt = Date.parse(syncedAtText);
  if (!Number.isFinite(syncedAt)) {
    return {
      ok: false,
      status: "missing",
      count,
      expectedCount,
      expectedSignature,
      detail: "Browser companion must sync dynamic block rules."
    };
  }

  const ageMs = now.getTime() - syncedAt;
  if (ageMs >= EXTENSION_RULES_FRESH_MS) {
    return {
      ok: false,
      status: "stale",
      syncedAt: syncedAtText,
      count,
      expectedCount,
      expectedSignature,
      detail: "Browser companion dynamic block rules are stale."
    };
  }

  if (dynamicRules.status === "failed" || dynamicRules.ok === false) {
    return {
      ok: false,
      status: "failed",
      syncedAt: syncedAtText,
      count,
      expectedCount,
      expectedSignature,
      detail: dynamicRules.error || "Browser companion could not install dynamic block rules."
    };
  }

  if (dynamicRules.fallbackRequired) {
    return {
      ok: false,
      status: "fallback",
      syncedAt: syncedAtText,
      count,
      expectedCount,
      expectedSignature,
      detail: "Browser companion needs fallback tab checks for the current allowlist policy."
    };
  }

  if (count !== expectedCount || dynamicRules.signature !== expectedSignature) {
    return {
      ok: false,
      status: "mismatch",
      syncedAt: syncedAtText,
      count,
      expectedCount,
      expectedSignature,
      detail: `Browser companion dynamic block rules are out of sync (${count}/${expectedCount} active).`
    };
  }

  return {
    ok: true,
    status: "synced",
    syncedAt: dynamicRules.syncedAt,
    count,
    expectedCount,
    expectedSignature,
    detail: `Dynamic browser block rules synced (${count}/${expectedCount} active).`
  };
}

function blocker(id: string, detail: string): FoolproofBlocker {
  return { id, detail };
}
