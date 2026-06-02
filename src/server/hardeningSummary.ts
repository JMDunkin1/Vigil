import { distanceKeySummary } from "../distanceKey.js";
import { extensionDynamicRulesReady, extensionRecentlySeen as extensionRecentlySeenForState, extensionVersionReady } from "../foolproof.js";
import { focusShortcutDetail, focusShortcutSummary } from "../focusHooks.js";
import { integrityRuntimeSummary } from "../integrityLockdown.js";
import { intentReasonSummary } from "../intentReason.js";
import { keyholderSummary } from "../keyholder.js";
import type { VigilState, UnknownRecord } from "../types.js";

interface SummaryRecord extends UnknownRecord {
  ok?: boolean;
  detail?: string;
  status?: string;
  enabled?: boolean;
  ready?: boolean;
  blockers?: Array<{ id: string }>;
  username?: string;
  isAdmin?: boolean;
  installed?: boolean;
  partial?: boolean;
  stale?: boolean;
  duplicate?: boolean;
  legacyInstalled?: boolean;
  loaded?: boolean;
  running?: boolean;
  pid?: number | null;
  installedEntries?: number;
  expectedEntries?: number;
  expectedDomainCount?: number;
  lastSealedAt?: string | null;
  sealedAt?: string | null;
  tamperDetectedAt?: string | null;
  fileCount?: number;
  hasToken?: boolean;
  hasKeyFile?: boolean;
  keyFilePath?: string;
  lastError?: string;
  minLength?: number;
  accessibilityLikelyMissing?: boolean;
}

interface HardeningAuditInput {
  state: VigilState;
  hosts: SummaryRecord;
  firewall: SummaryRecord;
  agent: SummaryRecord;
  account: SummaryRecord;
  protection: SummaryRecord;
  monitor: SummaryRecord;
  foolproof: SummaryRecord;
  stateSeal: SummaryRecord;
  sourceSeal: SummaryRecord;
}

export interface HardeningAuditRow {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

interface HardeningActionsInput {
  localScriptCommand: (scriptName: string, options?: UnknownRecord) => unknown;
  resourcePath: (resourceName: string) => string;
}

export function hardeningAudit({ state, hosts, firewall, agent, account, protection, monitor, foolproof, stateSeal, sourceSeal }: HardeningAuditInput): HardeningAuditRow[] {
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const focusShortcut = focusShortcutSummary(state);
  const intentReason = intentReasonSummary(state);
  const runtime = integrityRuntimeSummary(state);
  const dynamicRules = extensionDynamicRulesReady(state);
  const extensionVersion = extensionVersionReady(state);
  const extensionSeen = extensionRecentlySeenForState(state);
  return [
    {
      id: "foolproof",
      label: "Foolproof mode",
      ok: Boolean(foolproof.enabled && foolproof.ready),
      detail: foolproofDetail(foolproof)
    },
    {
      id: "state-seal",
      label: "State seal",
      ok: Boolean(stateSeal.ok),
      detail: stateSealDetail(stateSeal)
    },
    {
      id: "source-seal",
      label: "Source seal",
      ok: Boolean(sourceSeal.ok),
      detail: sourceSealDetail(sourceSeal)
    },
    {
      id: "runtime-watchdog",
      label: "Runtime watchdog",
      ok: runtime.ok,
      detail: runtime.detail
    },
    {
      id: "protected-edits",
      label: "Protected edits",
      ok: Boolean(protection.enabled),
      detail: protection.enabled ? "Config changes have a cooldown gate." : "Config can be changed immediately."
    },
    {
      id: "intent-reason",
      label: "Intent reasons",
      ok: intentReason.enabled && intentReason.minLength >= 12,
      detail: intentReason.detail
    },
    {
      id: "keyholder",
      label: "Keyholder",
      ok: keyholder.enabled && keyholder.hasPasscode,
      detail: keyholder.enabled ? "Unlock and maintenance confirms require a passcode." : "Unlock and maintenance confirms do not require a passcode."
    },
    {
      id: "typing-challenge",
      label: "Typing challenge",
      ok: state.settings.typingChallengeEnabled !== false,
      detail: state.settings.typingChallengeEnabled !== false ? "Unlock and maintenance confirms require typing a random phrase." : "Unlock and maintenance confirms do not require a typing challenge."
    },
    {
      id: "distance-key",
      label: "Distance key",
      ok: distanceKey.enabled && distanceKey.hasToken,
      detail: distanceKeyDetail(distanceKey)
    },
    {
      id: "notification-focus",
      label: "Notification Focus",
      ok: focusShortcut.enabled && !focusShortcut.lastError,
      detail: focusShortcutDetail(focusShortcut)
    },
    {
      id: "browser-redirect",
      label: "Browser redirect",
      ok: state.settings.siteRedirectEnabled,
      detail: state.settings.siteRedirectEnabled ? "Blocked sites redirect to the block screen." : "Blocked site redirect is disabled."
    },
    {
      id: "content-filter",
      label: "Content filter",
      ok: state.settings.contentFilterEnabled !== false,
      detail: state.settings.contentFilterEnabled !== false ? "Short-form feeds such as Shorts, Reels, Popular, and For You are blocked during locks." : "Content feature filters are disabled."
    },
    {
      id: "browser-noise",
      label: "Browser cleanup",
      ok: state.settings.browserNoiseBlockingEnabled,
      detail: state.settings.browserNoiseBlockingEnabled ? "Companion extension removes common ads, trackers, cookie prompts, and social widgets." : "Browser cleanup is disabled."
    },
    {
      id: "app-quit",
      label: "App quit",
      ok: state.settings.appQuitEnabled,
      detail: state.settings.appQuitEnabled ? "Blocked apps are quit automatically." : "Blocked app quitting is disabled."
    },
    {
      id: "bypass-protection",
      label: "Bypass tools",
      ok: state.settings.strictBypassProtectionEnabled,
      detail: state.settings.strictBypassProtectionEnabled ? "Strict locks also quit common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser apps, and browser control pages." : "Strict locks leave common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser apps, and browser control pages available."
    },
    {
      id: "process-sweep",
      label: "Background sweep",
      ok: state.settings.processSweepEnabled,
      detail: state.settings.processSweepEnabled ? `Blocked app processes are swept every ${state.settings.processSweepIntervalSeconds || 15}s.` : "Background blocked-app sweeping is disabled."
    },
    {
      id: "sleep-screen-lock",
      label: "Sleep screen lock",
      ok: state.settings.systemSleepLockEnabled,
      detail: state.settings.systemSleepLockEnabled ? `Sleep sessions re-lock the Mac every ${state.settings.systemSleepLockIntervalSeconds || 60}s.` : "Sleep sessions do not lock the whole Mac screen."
    },
    {
      id: "accessibility",
      label: "Accessibility",
      ok: Boolean(monitor.ok && !monitor.accessibilityLikelyMissing),
      detail: monitor.ok ? "Foreground app detection is working." : "macOS permission may be missing."
    },
    {
      id: "browser-extension",
      label: "Browser extension",
      ok: extensionSeen,
      detail: extensionSeen ? "Companion extension checked in recently." : "Optional extension has not checked in recently."
    },
    {
      id: "extension-version",
      label: "Extension version",
      ok: Boolean(extensionSeen && extensionVersion.ok),
      detail: extensionVersion.detail
    },
    {
      id: "extension-rules",
      label: "Extension rules",
      ok: dynamicRules.ok,
      detail: dynamicRules.detail
    },
    {
      id: "launch-agent",
      label: "LaunchAgent",
      ok: Boolean(agent.loaded && agent.running && !agent.legacyInstalled),
      detail: launchAgentDetail(agent)
    },
    {
      id: "mac-account",
      label: "Mac account",
      ok: Boolean(account?.username && !account.isAdmin),
      detail: accountDetail(account)
    },
    {
      id: "hosts",
      label: "Hosts block",
      ok: Boolean(hosts.installed && !hosts.partial && !hosts.stale),
      detail: hostsDetail(hosts)
    },
    {
      id: "firewall",
      label: "PF firewall",
      ok: Boolean(firewall.installed && !firewall.partial && !firewall.stale),
      detail: firewallDetail(firewall)
    }
  ];
}

export function hardeningActions({ localScriptCommand, resourcePath }: HardeningActionsInput) {
  return {
    launchAgentInstall: {
      label: "Install Login Agent",
      method: "POST",
      path: "/api/hardening/launch-agent/install"
    },
    hostsApply: {
      label: "Apply Network Block",
      method: "POST",
      path: "/api/hardening/hosts/apply",
      command: localScriptCommand("apply-hosts.mjs", { privileged: true, npmScript: "network:apply" })
    },
    sourceSeal: {
      label: "Seal Source",
      command: localScriptCommand("seal-source.mjs", { npmScript: "seal:source" })
    },
    tamperClear: {
      label: "Clear Tamper Alarm",
      method: "POST",
      path: "/api/integrity/clear-tamper"
    },
    extensionLoad: {
      label: "Extension Folder",
      path: resourcePath("extension")
    }
  };
}

export function foolproofDetail(foolproof: SummaryRecord): string {
  if (!foolproof.enabled) return "Strict locks can start before all hardening checks are ready.";
  if (foolproof.ready) return "Strict locks require all hardening checks and the checklist is ready.";
  const blockers = foolproof.blockers || [];
  return `${blockers.length} hardening check${blockers.length === 1 ? "" : "s"} must be fixed before strict locks can start.`;
}

export function launchAgentDetail(agent: SummaryRecord): string {
  if (agent.legacyInstalled) return "Legacy Vigil login agent is still installed; reinstall the login agent to clean it up.";
  if (!agent.installed) return "Login persistence is not installed.";
  if (agent.running) return `Login persistence is running${agent.pid ? ` as PID ${agent.pid}` : ""}.`;
  if (agent.loaded) return "Login persistence is loaded but not currently running.";
  return "Login persistence plist exists but launchctl is not loading it.";
}

export function hostsDetail(hosts: SummaryRecord): string {
  if (hosts.partial) return "Hosts block markers are incomplete; re-apply the network block.";
  if (hosts.legacyInstalled) return "Legacy Vigil hosts block is still installed; re-apply the network block to migrate it.";
  if (hosts.duplicate) return "Multiple managed hosts blocks are installed; re-apply the network block to consolidate them.";
  if (!hosts.installed) return "Hosts-file site block is not installed.";
  if (hosts.stale) return `Hosts block is stale (${hosts.installedEntries}/${hosts.expectedEntries} entries).`;
  return `Hosts-file site block is current (${hosts.installedEntries} entries).`;
}

export function firewallDetail(firewall: SummaryRecord): string {
  if (firewall.partial) return "PF firewall markers are incomplete; re-apply the network block.";
  if (!firewall.installed) return "PF firewall anchor is not installed.";
  if (firewall.stale) return `PF firewall block is stale (${firewall.installedEntries}/${firewall.expectedDomainCount} domain targets).`;
  return `PF firewall anchor is current (${firewall.installedEntries} address rules).`;
}

export function accountDetail(account: SummaryRecord | null | undefined): string {
  if (!account?.username) return account?.detail || "Mac account type could not be checked.";
  return account.detail || (account.isAdmin ? `${account.username} is an admin account.` : `${account.username} is a standard account.`);
}

export function stateSealDetail(stateSeal: SummaryRecord): string {
  if (stateSeal.status === "bookkeeping-mismatch") return stateSeal.detail || "State seal bookkeeping changed only in runtime fields.";
  if (stateSeal.ok) return stateSeal.lastSealedAt ? `State file is sealed (${stateSeal.lastSealedAt}).` : "State file is sealed.";
  if (stateSeal.tamperDetectedAt) return `Tampering was detected at ${stateSeal.tamperDetectedAt}.`;
  return stateSeal.detail || "State file integrity could not be verified.";
}

export function sourceSealDetail(sourceSeal: SummaryRecord): string {
  if (sourceSeal.ok) return sourceSeal.sealedAt ? `Source files are sealed (${sourceSeal.fileCount || 0} files, ${sourceSeal.sealedAt}).` : "Source files are sealed.";
  return sourceSeal.detail || "Source integrity seal is missing. Run npm run seal:source after reviewing local code.";
}

export function distanceKeyDetail(distanceKey: SummaryRecord): string {
  if (!distanceKey.enabled) return distanceKey.hasToken ? "Distance key is saved but not required." : "Physical-friction unlock token is disabled.";
  if (!distanceKey.hasToken) return "Distance key is enabled but no token has been generated.";
  if (distanceKey.hasKeyFile) return `Unlock confirms require the mounted key file (${distanceKey.keyFilePath}).`;
  return "Unlock confirms require the away-from-desk token.";
}
