import { distanceKeySummary } from "./distanceKey.js";
import { extensionDynamicRulesReady, extensionRecentlySeen, extensionVersionReady, foolproofSummary } from "./foolproof.js";
import { focusShortcutDetail, focusShortcutSummary } from "./focusHooks.js";
import { externalNetworkBlockSummary } from "./externalNetworkBlock.js";
import { integrityRuntimeSummary } from "./integrityLockdown.js";
import { intentReasonSummary } from "./intentReason.js";
import { keyholderSummary } from "./keyholder.js";
import { safariFilterPathDenyUrls } from "./safariFilter.js";
import { browserCompanionRequirement, networkBlockCurrent, systemNetworkBlockingEnabled } from "./systemNetworkBlock.js";
import type { VigilState, UnknownRecord } from "./types.js";

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
  pathUrlCount?: number;
  duplicate?: boolean;
  legacyInstalled?: boolean;
  loaded?: boolean;
  running?: boolean;
  pid?: number | null;
  error?: string;
  path?: string;
  legacyPath?: string;
  installedEntries?: number;
  expectedEntries?: number;
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
  lastIdleAccounting?: SummaryRecord | null;
}

interface DoctorContext {
  seal?: SummaryRecord;
  sourceSeal?: SummaryRecord;
  hosts?: SummaryRecord;
  firewall?: SummaryRecord;
  safariFilter?: SummaryRecord;
  externalNetworkBlock?: SummaryRecord;
  agent?: SummaryRecord;
  account?: SummaryRecord;
  monitor?: SummaryRecord;
}

export interface DoctorRow {
  id: string;
  label: string;
  ok: boolean;
  status: "OK" | "CHECK";
  detail: string;
}

export function doctorRows(state: VigilState, context: DoctorContext = {}, now = new Date()): DoctorRow[] {
  const settings = state.settings;
  const seal = context.seal || {};
  const sourceSeal = context.sourceSeal || {};
  const hosts = context.hosts || {};
  const firewall = context.firewall || {};
  const safariFilter = context.safariFilter || {};
  const externalNetworkBlock = context.externalNetworkBlock || externalNetworkBlockSummary(state);
  const agent = context.agent || {};
  const account = context.account || {};
  const monitor = context.monitor || monitorFromHeartbeat(state, now);
  const foolproof = foolproofSummary(state, { hosts, firewall, safariFilter, agent, account, monitor, stateSeal: seal, sourceSeal }, now);
  const runtime = integrityRuntimeSummary(state);
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const focusShortcut = focusShortcutSummary(state);
  const intentReason = intentReasonSummary(state);
  const extensionRules = extensionDynamicRulesReady(state, now);
  const extensionSeen = extensionRecentlySeen(state, now);
  const extensionVersion = extensionVersionReady(state);
  const networkCurrent = networkBlockCurrent(hosts, firewall);
  const networkEnabled = systemNetworkBlockingEnabled(state);
  const companionRequirement = browserCompanionRequirement(state, now);
  const safariRequired = safariFilter.required ?? (safariFilterPathDenyUrls(state, now).length > 0);

  return [
    row("state-seal", "State seal", Boolean(seal.ok), stateSealDetail(seal)),
    row("source-seal", "Source seal", Boolean(sourceSeal.ok), sourceSealDetail(sourceSeal)),
    row("runtime-watchdog", "Runtime watchdog", runtime.ok, runtime.detail),
    row("watcher-heartbeat", "Watcher heartbeat", monitor.ok, monitor.detail || "Watcher heartbeat is current."),
    row("idle-usage", "AFK-aware usage", idleUsageOk(settings, monitor), idleUsageDetail(settings, monitor)),
    row("launch-agent", "LaunchAgent", Boolean(agent.loaded && agent.running && !agent.legacyInstalled), launchAgentDetail(agent)),
    row("mac-account", "Mac account", Boolean(account.username && !account.isAdmin), accountDetail(account)),
    row("hosts", "Hosts block", Boolean(hosts.installed && !hosts.partial && !hosts.stale), hostsDetail(hosts)),
    row("firewall", "PF firewall", Boolean(firewall.installed && !firewall.partial && !firewall.stale), firewallDetail(firewall)),
    row("protected-edits", "Protected edits", settings.protectedEditsEnabled !== false, settings.protectedEditsEnabled !== false ? "Config changes require a maintenance window." : "Config changes can be made immediately."),
    row("intent-reason", "Intent reasons", intentReason.enabled && intentReason.minLength >= 12, intentReason.detail),
    row("keyholder", "Keyholder", keyholder.enabled && keyholder.hasPasscode, keyholder.enabled ? "Passcode is required for unlock confirmations." : "Unlock confirmations do not require a passcode."),
    row("typing-challenge", "Typing challenge", settings.typingChallengeEnabled !== false, settings.typingChallengeEnabled !== false ? "Unlock confirmations require a random typing challenge." : "Unlock confirmations do not require a typing challenge."),
    row("distance-key", "Distance key", distanceKey.enabled && distanceKey.hasToken, distanceKeyDetail(distanceKey)),
    row("notification-focus", "Notification Focus", focusShortcut.enabled && !focusShortcut.lastError, focusShortcutDetail(focusShortcut)),
    row("system-network-block", "System network block", networkEnabled && networkCurrent, networkEnabled ? (networkCurrent ? "Whole-site domain blocks are enforced across apps by hosts/PF." : "Apply the network block so hosts/PF are current.") : "System network blocking is disabled."),
    row("safari-url-filter", "Safari URL filter", !safariRequired || Boolean(safariFilter.current), safariFilterDetail(safariFilter, Boolean(safariRequired))),
    row("external-network-block", "Apple network DNS/router", !externalNetworkBlock.enabled || Boolean(externalNetworkBlock.ready), externalNetworkBlockDetail(externalNetworkBlock)),
    row("browser-redirect", "Browser redirect fallback", networkCurrent || Boolean(settings.siteRedirectEnabled), networkCurrent ? "Not required while the system network block is current." : (settings.siteRedirectEnabled ? "Fallback redirects blocked sites to the block screen." : "Disabled while the system network block is not current.")),
    row("browser-cleanup", "Browser cleanup", true, settings.browserNoiseBlockingEnabled !== false ? "Extension cleanup/noise rules are enabled." : "Browser cleanup/noise blocking is disabled."),
    row("app-quit", "App quit", Boolean(settings.appQuitEnabled), settings.appQuitEnabled ? "Blocked apps are quit automatically." : "Blocked apps are not quit automatically."),
    row("bypass-tools", "Bypass tools", settings.strictBypassProtectionEnabled !== false, settings.strictBypassProtectionEnabled !== false ? "Strict locks quit common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser apps, and browser control pages." : "Common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser app bypasses, and browser control pages are not protected."),
    row("background-sweep", "Background sweep", Boolean(settings.processSweepEnabled), settings.processSweepEnabled ? `Process sweep runs every ${settings.processSweepIntervalSeconds || 15}s.` : "Background process sweep is disabled."),
    row("sweep-interval", "Sweep interval", Number(settings.processSweepIntervalSeconds || 0) <= 30, `Process sweep interval is ${settings.processSweepIntervalSeconds || 15}s.`),
    row("app-escalation", "App escalation", Number(settings.appQuitEscalationSeconds || 0) <= 30, `Forced-kill escalation is ${settings.appQuitEscalationSeconds || 10}s.`),
    row("content-filter", "Content filter", true, settings.contentFilterEnabled !== false ? "Short-form feeds use precise browser companion checks during active locks." : "Content feature filters are disabled."),
    row("browser-extension", "Browser extension", !companionRequirement.required || extensionSeen, companionRequirement.required ? (extensionSeen ? `Companion extension checked in recently. ${companionRequirement.detail}` : `Companion extension has not checked in recently. ${companionRequirement.detail}`) : "Not required for current system-network site blocking."),
    row("extension-version", "Extension version", !companionRequirement.required || (extensionSeen && extensionVersion.ok), companionRequirement.required ? extensionVersion.detail : "Not required for current system-network site blocking."),
    row("extension-rules", "Extension rules", !companionRequirement.required || extensionRules.ok, companionRequirement.required ? extensionRules.detail : "Not required for current system-network site blocking."),
    row("foolproof", "Foolproof readiness", foolproof.enabled && foolproof.ready, foolproofDetail(foolproof))
  ];
}

function safariFilterDetail(safariFilter: SummaryRecord, required: boolean): string {
  if (safariFilter.enabled === false) return "Safari URL filtering is disabled.";
  if (!required) return "No path-specific Safari URL rules are active right now.";
  if (safariFilter.current) return `Safari path rules are current (${safariFilter.pathUrlCount || 0} path URLs).`;
  if (safariFilter.installed && safariFilter.stale) return "Safari URL filter profile is stale.";
  if (safariFilter.generated) return "Safari URL filter profile is generated but still needs approval in System Settings.";
  return "Safari URL filter profile is not installed.";
}

function externalNetworkBlockDetail(externalNetworkBlock: SummaryRecord): string {
  if (externalNetworkBlock.detail) return String(externalNetworkBlock.detail);
  if (!externalNetworkBlock.enabled) return "Optional DNS/router sync is disabled.";
  return `Manual DNS/router provider is ready with ${externalNetworkBlock.targetDomainCount || 0} domain targets to copy.`;
}

function accountDetail(account: SummaryRecord): string {
  if (!account.username) return account.detail || "Mac account type could not be checked.";
  return account.detail || (account.isAdmin ? `${account.username} is an admin account.` : `${account.username} is a standard account.`);
}

export function formatDoctorRows(rows: DoctorRow[]): string {
  return rows.map((item) => `${item.status.padEnd(5)} ${item.label}: ${item.detail}`).join("\n");
}

function row(id: string, label: string, ok: unknown, detail: unknown): DoctorRow {
  return {
    id,
    label,
    ok: Boolean(ok),
    status: ok ? "OK" : "CHECK",
    detail: String(detail || "")
  };
}

function monitorFromHeartbeat(state: VigilState, now: Date): SummaryRecord {
  const heartbeat = Date.parse(state.integrity?.runtime?.lastHeartbeatAt || "");
  const maxAgeMs = Math.max(30, Number(state.settings?.pollIntervalMs || 3000) / 1000 * 4) * 1000;
  if (!Number.isFinite(heartbeat)) {
    return {
      ok: false,
      accessibilityLikelyMissing: false,
      detail: "Watcher heartbeat has not been recorded yet."
    };
  }

  const ageMs = now.getTime() - heartbeat;
  return {
    ok: ageMs >= 0 && ageMs <= maxAgeMs,
    accessibilityLikelyMissing: false,
    detail: ageMs >= 0 && ageMs <= maxAgeMs
      ? `Watcher heartbeat is current (${new Date(heartbeat).toISOString()}).`
      : `Watcher heartbeat is stale (${new Date(heartbeat).toISOString()}).`
  };
}

function idleUsageOk(settings: VigilState["settings"], monitor: SummaryRecord): boolean {
  if (settings.idleUsageTrackingEnabled === false) return false;
  const idle = monitor.lastIdleAccounting;
  return !idle || idle.ok !== false;
}

function idleUsageDetail(settings: VigilState["settings"], monitor: SummaryRecord): string {
  const threshold = Number(settings.idleUsageThresholdSeconds || 120);
  if (settings.idleUsageTrackingEnabled === false) return "AFK-aware usage accounting is disabled.";
  const idle = monitor.lastIdleAccounting;
  if (!idle) return `Usage stops after ${threshold}s of Mac input idle time; waiting for the next sample.`;
  if (idle.ok === false) return `Idle lookup failed; usage is still recorded normally (${idle.error || "unknown error"}).`;
  if (Number(idle.skippedSeconds || 0) > 0) {
    return `Skipped ${idle.skippedSeconds}s after ${idle.thresholdSeconds || threshold}s idle threshold.`;
  }
  return `Usage stops after ${idle.thresholdSeconds || threshold}s of Mac input idle time.`;
}

function stateSealDetail(seal: SummaryRecord): string {
  if (seal.status === "bookkeeping-mismatch") return seal.detail || "State seal bookkeeping changed only in runtime fields.";
  if (seal.ok) return seal.lastSealedAt ? `sealed at ${seal.lastSealedAt}` : "sealed";
  if (seal.tamperDetectedAt) return `tampering detected at ${seal.tamperDetectedAt}: ${seal.detail}`;
  return `${seal.status || "unknown"}: ${seal.detail || "State seal could not be verified."}`;
}

function sourceSealDetail(sourceSeal: SummaryRecord): string {
  if (sourceSeal.ok) return sourceSeal.sealedAt ? `sealed at ${sourceSeal.sealedAt} (${sourceSeal.fileCount || 0} files)` : "sealed";
  return sourceSeal.detail || "Source integrity seal is missing. Run npm run seal:source after reviewing local code.";
}

function distanceKeyDetail(distanceKey: SummaryRecord): string {
  if (!distanceKey.enabled) return distanceKey.hasToken ? "Saved but not required." : "Away-from-desk token is disabled.";
  if (!distanceKey.hasToken) return "Distance key is enabled but no token has been generated.";
  if (distanceKey.hasKeyFile) return `Removable key file is required (${distanceKey.keyFilePath}).`;
  return "Away-from-desk token is required.";
}

function launchAgentDetail(agent: SummaryRecord): string {
  if (agent.legacyInstalled) return `legacy agent still installed (${agent.legacyPath || "old plist"})`;
  if (!agent.installed) return `not installed (${agent.path || "LaunchAgent plist missing"})`;
  if (agent.running) return `running${agent.pid ? ` as PID ${agent.pid}` : ""}`;
  if (agent.loaded) return "loaded but not currently running";
  return `plist exists but launchctl is not loading it${agent.error ? `: ${agent.error}` : ""}`;
}

function hostsDetail(hosts: SummaryRecord): string {
  if (hosts.partial) return "markers are incomplete; run npm run network:apply";
  if (hosts.legacyInstalled) return "legacy hosts block is still installed; run npm run network:apply";
  if (hosts.duplicate) return "multiple managed hosts blocks are installed; run npm run network:apply";
  if (!hosts.installed) return "not installed; run npm run network:apply";
  if (hosts.stale) return `stale (${hosts.installedEntries}/${hosts.expectedEntries} entries); run npm run network:apply`;
  return `current (${hosts.installedEntries} entries)`;
}

function firewallDetail(firewall: SummaryRecord): string {
  if (firewall.partial) return "markers are incomplete; run npm run network:apply";
  if (!firewall.installed) return "not installed; run npm run network:apply";
  if (firewall.stale) return `stale (${firewall.installedEntries || 0} address rules); run npm run network:apply`;
  return `current (${firewall.installedEntries || 0} address rules)`;
}

function foolproofDetail(foolproof: SummaryRecord): string {
  if (!foolproof.enabled) return "disabled; strict locks can start before hardening checks are ready.";
  if (foolproof.ready) return "enabled and ready.";
  const blockers = foolproof.blockers || [];
  return `${blockers.length} blocker${blockers.length === 1 ? "" : "s"}: ${blockers.map((item) => item.id).join(", ")}`;
}
