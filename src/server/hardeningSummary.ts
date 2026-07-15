import { distanceKeySummary } from "../distanceKey.js";
import { adultBlocklistSummary } from "../adultBlocklist.js";
import { extensionDynamicRulesReady, extensionRecentlySeen as extensionRecentlySeenForState, extensionVersionReady } from "../foolproof.js";
import { focusShortcutDetail, focusShortcutSummary } from "../focusHooks.js";
import { externalNetworkBlockSummary } from "../externalNetworkBlock.js";
import { integrityRuntimeSummary } from "../integrityLockdown.js";
import { intentReasonSummary } from "../intentReason.js";
import { keyholderSummary } from "../keyholder.js";
import { browserCompanionRequirement, networkBlockCurrent, systemNetworkBlockingEnabled } from "../systemNetworkBlock.js";
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
  current?: boolean;
  required?: boolean;
  generated?: boolean;
  effectiveCurrent?: boolean;
  appleCurrent?: boolean;
  appleContentFilter?: SummaryRecord;
  duplicate?: boolean;
  loaded?: boolean;
  running?: boolean;
  pid?: number | null;
  installedEntries?: number;
  expectedEntries?: number;
  expectedDomainCount?: number;
  expectedUrls?: number;
  pathUrlCount?: number;
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
  safariFilter: SummaryRecord;
  externalNetworkBlock?: SummaryRecord;
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

export function hardeningAudit({ state, hosts, firewall, safariFilter, externalNetworkBlock, agent, account, protection, monitor, foolproof, stateSeal, sourceSeal }: HardeningAuditInput): HardeningAuditRow[] {
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const focusShortcut = focusShortcutSummary(state);
  const intentReason = intentReasonSummary(state);
  const runtime = integrityRuntimeSummary(state);
  const dynamicRules = extensionDynamicRulesReady(state);
  const adultBlocklist = adultBlocklistSummary(state);
  const extensionVersion = extensionVersionReady(state);
  const extensionSeen = extensionRecentlySeenForState(state);
  const networkCurrent = networkBlockCurrent(hosts, firewall);
  const networkEnabled = systemNetworkBlockingEnabled(state);
  const externalNetwork = externalNetworkBlock || externalNetworkBlockSummary(state);
  const companionRequirement = browserCompanionRequirement(state);
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
      id: "system-network-block",
      label: "System network block",
      ok: Boolean(networkEnabled && networkCurrent),
      detail: systemNetworkBlockDetail(networkEnabled, networkCurrent)
    },
    {
      id: "safari-url-filter",
      label: "Safari web filter",
      ok: safariFilter.required ? safariWebFilterCurrent(safariFilter) : true,
      detail: safariFilterDetail(safariFilter)
    },
    {
      id: "external-network-block",
      label: "Apple network DNS/router",
      ok: !externalNetwork.enabled || Boolean(externalNetwork.ready),
      detail: externalNetworkBlockDetail(externalNetwork)
    },
    {
      id: "adult-blocklist",
      label: "Adult blocklist",
      ok: !adultBlocklist.enabled || Boolean(adultBlocklist.ready),
      detail: adultBlocklist.detail
    },
    {
      id: "browser-redirect",
      label: "Browser redirect fallback",
      ok: Boolean(networkCurrent || state.settings.siteRedirectEnabled),
      detail: browserRedirectFallbackDetail(Boolean(state.settings.siteRedirectEnabled), networkCurrent)
    },
    {
      id: "content-filter",
      label: "Apple Screen Time web filter",
      ok: appleContentFilterCurrent(safariFilter),
      detail: appleContentFilterDetail(safariFilter)
    },
    {
      id: "browser-noise",
      label: "Browser cleanup",
      ok: true,
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
      ok: Boolean(!companionRequirement.required || extensionSeen),
      detail: companionRequirement.required
        ? (extensionSeen ? `Companion extension checked in recently. ${companionRequirement.detail}` : `Companion extension has not checked in recently. ${companionRequirement.detail}`)
        : "Not required for current system-network site blocking."
    },
    {
      id: "extension-version",
      label: "Extension version",
      ok: Boolean(!companionRequirement.required || (extensionSeen && extensionVersion.ok)),
      detail: companionRequirement.required ? extensionVersion.detail : "Not required for current system-network site blocking."
    },
    {
      id: "extension-rules",
      label: "Extension rules",
      ok: Boolean(!companionRequirement.required || dynamicRules.ok),
      detail: companionRequirement.required ? dynamicRules.detail : "Not required for current system-network site blocking."
    },
    {
      id: "launch-agent",
      label: "LaunchAgent",
      ok: Boolean(agent.loaded && agent.running && (!agent.embedded || agent.restartHardened === true)),
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

function systemNetworkBlockDetail(enabled: boolean, current: boolean): string {
  if (!enabled) return "System network blocking is disabled.";
  if (current) return "Blocked site domains are denied across Safari and other apps without rewriting browser tabs.";
  return "Apply the network block so hosts and PF are current for across-app site enforcement.";
}

function browserRedirectFallbackDetail(enabled: boolean, networkCurrent: boolean): string {
  if (networkCurrent) return "Not needed for whole-site domain blocks while the system network block is current.";
  if (enabled) return "Blocked sites redirect to the block screen when the system network block is not current.";
  return "Disabled; site blocking depends on the system network block being current.";
}

function safariFilterDetail(safariFilter: SummaryRecord): string {
  if (!safariFilter.enabled) return "Safari URL filtering is disabled.";
  if (!safariFilter.required) return "Safari's Apple content-filter profile is not required right now.";
  if (appleContentFilterCurrent(safariFilter) && !safariFilter.current) return "Apple Screen Time web content filter is on; Vigil's separate Safari profile is optional.";
  if (safariFilter.current) return `Safari content-filter profile is current (${safariFilter.expectedUrls || 0} deny URLs, ${safariFilter.pathUrlCount || 0} path URLs).`;
  if (safariFilter.installed && safariFilter.stale) return "Safari content-filter profile is installed but stale; reapply it.";
  if (safariFilter.generated) return "Safari content-filter profile is generated; approve it in System Settings.";
  return "Apply the Safari content-filter profile for Apple built-in filtering and Safari deny-list blocking.";
}

function safariWebFilterCurrent(safariFilter: SummaryRecord): boolean {
  return Boolean(safariFilter.effectiveCurrent || safariFilter.current || appleContentFilterCurrent(safariFilter));
}

function appleContentFilterCurrent(safariFilter: SummaryRecord): boolean {
  const apple = safariFilter.appleContentFilter;
  if (apple && "current" in apple) return Boolean(apple.current);
  if ("appleCurrent" in safariFilter) return Boolean(safariFilter.appleCurrent);
  return false;
}

function appleContentFilterDetail(safariFilter: SummaryRecord): string {
  const apple = safariFilter.appleContentFilter;
  if (apple?.detail) return String(apple.detail);
  if (appleContentFilterCurrent(safariFilter)) return "Apple Screen Time Limit Adult Websites is on.";
  return "Apple Screen Time Limit Adult Websites and Content & Privacy Restrictions must stay on in System Settings.";
}

function externalNetworkBlockDetail(externalNetwork: SummaryRecord): string {
  if (externalNetwork.detail) return String(externalNetwork.detail);
  if (!externalNetwork.enabled) return "Optional DNS/router sync is disabled.";
  return `Manual DNS/router provider is ready with ${externalNetwork.targetDomainCount || 0} domain targets to copy.`;
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
    safariFilterApply: {
      label: "Apply Safari Filter",
      method: "POST",
      path: "/api/hardening/safari-filter/apply",
      command: localScriptCommand("apply-safari-filter.mjs", { npmScript: "safari:apply" })
    },
    adultBlocklistRefresh: {
      label: "Refresh Adult List",
      method: "POST",
      path: "/api/adult-blocklist/refresh",
      command: localScriptCommand("refresh-adult-blocklist.mjs", { npmScript: "adult:blocklist:refresh" })
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
  if (agent.embedded && agent.restartHardened !== true) {
    return "Vigil opens at login, but macOS does not restart it after a crash or Force Quit.";
  }
  if (!agent.installed) return "Login persistence is not installed.";
  if (agent.running) return `Login persistence is running${agent.pid ? ` as PID ${agent.pid}` : ""}.`;
  if (agent.loaded) return "Login persistence is loaded but not currently running.";
  return "Login persistence plist exists but launchctl is not loading it.";
}

export function hostsDetail(hosts: SummaryRecord): string {
  if (hosts.partial) return "Hosts block markers are incomplete; re-apply the network block.";
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
  if (stateSeal.ok) return withSealThreatModel(
    stateSeal.lastSealedAt ? `State file is sealed (${stateSeal.lastSealedAt}).` : "State file is sealed.",
    stateSeal
  );
  if (stateSeal.tamperDetectedAt) return `Tampering was detected at ${stateSeal.tamperDetectedAt}.`;
  return stateSeal.detail || "State file integrity could not be verified.";
}

export function sourceSealDetail(sourceSeal: SummaryRecord): string {
  if (sourceSeal.ok) return withSealThreatModel(
    sourceSeal.sealedAt ? `Source files are sealed (${sourceSeal.fileCount || 0} files, ${sourceSeal.sealedAt}).` : "Source files are sealed.",
    sourceSeal
  );
  return sourceSeal.detail || "Source integrity seal is missing. Run npm run seal:source after reviewing local code.";
}

function withSealThreatModel(detail: string, seal: SummaryRecord): string {
  return seal.threatModel ? `${detail} ${seal.threatModel}` : detail;
}

export function distanceKeyDetail(distanceKey: SummaryRecord): string {
  if (!distanceKey.enabled) return distanceKey.hasToken ? "Distance key is saved but not required." : "Physical-friction unlock token is disabled.";
  if (!distanceKey.hasToken) return "Distance key is enabled but no token has been generated.";
  if (distanceKey.hasKeyFile) return `Unlock confirms require the mounted key file (${distanceKey.keyFilePath}).`;
  return "Unlock confirms require the away-from-desk token.";
}
