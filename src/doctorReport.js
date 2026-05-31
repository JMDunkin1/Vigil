import { distanceKeySummary } from "./distanceKey.js";
import { extensionDynamicRulesReady, extensionRecentlySeen, extensionVersionReady, foolproofSummary } from "./foolproof.js";
import { focusShortcutDetail, focusShortcutSummary } from "./focusHooks.js";
import { integrityRuntimeSummary } from "./integrityLockdown.js";
import { intentReasonSummary } from "./intentReason.js";
import { keyholderSummary } from "./keyholder.js";

export function doctorRows(state, context = {}, now = new Date()) {
  const settings = state.settings || {};
  const seal = context.seal || {};
  const sourceSeal = context.sourceSeal || {};
  const hosts = context.hosts || {};
  const agent = context.agent || {};
  const account = context.account || {};
  const monitor = context.monitor || monitorFromHeartbeat(state, now);
  const foolproof = foolproofSummary(state, { hosts, agent, account, monitor, stateSeal: seal, sourceSeal }, now);
  const runtime = integrityRuntimeSummary(state, now);
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const focusShortcut = focusShortcutSummary(state);
  const intentReason = intentReasonSummary(state);
  const extensionRules = extensionDynamicRulesReady(state, now);
  const extensionSeen = extensionRecentlySeen(state, now);
  const extensionVersion = extensionVersionReady(state);

  return [
    row("state-seal", "State seal", Boolean(seal.ok), stateSealDetail(seal)),
    row("source-seal", "Source seal", Boolean(sourceSeal.ok), sourceSealDetail(sourceSeal)),
    row("runtime-watchdog", "Runtime watchdog", runtime.ok, runtime.detail),
    row("watcher-heartbeat", "Watcher heartbeat", monitor.ok, monitor.detail || "Watcher heartbeat is current."),
    row("launch-agent", "LaunchAgent", Boolean(agent.loaded && agent.running), launchAgentDetail(agent)),
    row("mac-account", "Mac account", Boolean(account.username && !account.isAdmin), accountDetail(account)),
    row("hosts", "Hosts block", Boolean(hosts.installed && !hosts.partial && !hosts.stale), hostsDetail(hosts)),
    row("protected-edits", "Protected edits", settings.protectedEditsEnabled !== false, settings.protectedEditsEnabled !== false ? "Config changes require a maintenance window." : "Config changes can be made immediately."),
    row("intent-reason", "Intent reasons", intentReason.enabled && intentReason.minLength >= 12, intentReason.detail),
    row("keyholder", "Keyholder", keyholder.enabled && keyholder.hasPasscode, keyholder.enabled ? "Passcode is required for unlock confirmations." : "Unlock confirmations do not require a passcode."),
    row("typing-challenge", "Typing challenge", settings.typingChallengeEnabled !== false, settings.typingChallengeEnabled !== false ? "Unlock confirmations require a random typing challenge." : "Unlock confirmations do not require a typing challenge."),
    row("distance-key", "Distance key", distanceKey.enabled && distanceKey.hasToken, distanceKeyDetail(distanceKey)),
    row("notification-focus", "Notification Focus", focusShortcut.enabled && !focusShortcut.lastError, focusShortcutDetail(focusShortcut)),
    row("browser-redirect", "Browser redirect", Boolean(settings.siteRedirectEnabled), settings.siteRedirectEnabled ? "Blocked sites redirect to the block screen." : "Blocked site redirects are disabled."),
    row("browser-cleanup", "Browser cleanup", settings.browserNoiseBlockingEnabled !== false, settings.browserNoiseBlockingEnabled !== false ? "Extension cleanup/noise rules are enabled." : "Browser cleanup/noise blocking is disabled."),
    row("app-quit", "App quit", Boolean(settings.appQuitEnabled), settings.appQuitEnabled ? "Blocked apps are quit automatically." : "Blocked apps are not quit automatically."),
    row("bypass-tools", "Bypass tools", settings.strictBypassProtectionEnabled !== false, settings.strictBypassProtectionEnabled !== false ? "Strict locks quit common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser apps, and browser control pages." : "Common bypass tools, network/proxy/VPN tools, unsupported browsers, embedded-browser app bypasses, and browser control pages are not protected."),
    row("background-sweep", "Background sweep", Boolean(settings.processSweepEnabled), settings.processSweepEnabled ? `Process sweep runs every ${settings.processSweepIntervalSeconds || 15}s.` : "Background process sweep is disabled."),
    row("sweep-interval", "Sweep interval", Number(settings.processSweepIntervalSeconds || 0) <= 30, `Process sweep interval is ${settings.processSweepIntervalSeconds || 15}s.`),
    row("app-escalation", "App escalation", Number(settings.appQuitEscalationSeconds || 0) <= 30, `Forced-kill escalation is ${settings.appQuitEscalationSeconds || 10}s.`),
    row("content-filter", "Content filter", settings.contentFilterEnabled !== false, settings.contentFilterEnabled !== false ? "Short-form feeds are blocked during active locks." : "Content feature filters are disabled."),
    row("browser-extension", "Browser extension", extensionSeen, extensionSeen ? "Companion extension checked in recently." : "Companion extension has not checked in recently."),
    row("extension-version", "Extension version", extensionSeen && extensionVersion.ok, extensionSeen ? extensionVersion.detail : extensionVersion.detail),
    row("extension-rules", "Extension rules", extensionRules.ok, extensionRules.detail),
    row("foolproof", "Foolproof readiness", foolproof.enabled && foolproof.ready, foolproofDetail(foolproof))
  ];
}

function accountDetail(account) {
  if (!account.username) return account.detail || "Mac account type could not be checked.";
  return account.detail || (account.isAdmin ? `${account.username} is an admin account.` : `${account.username} is a standard account.`);
}

export function formatDoctorRows(rows) {
  return rows.map((item) => `${item.status.padEnd(5)} ${item.label}: ${item.detail}`).join("\n");
}

function row(id, label, ok, detail) {
  return {
    id,
    label,
    ok: Boolean(ok),
    status: ok ? "OK" : "CHECK",
    detail
  };
}

function monitorFromHeartbeat(state, now) {
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

function stateSealDetail(seal) {
  if (seal.ok) return seal.lastSealedAt ? `sealed at ${seal.lastSealedAt}` : "sealed";
  if (seal.tamperDetectedAt) return `tampering detected at ${seal.tamperDetectedAt}: ${seal.detail}`;
  return `${seal.status || "unknown"}: ${seal.detail || "State seal could not be verified."}`;
}

function sourceSealDetail(sourceSeal) {
  if (sourceSeal.ok) return sourceSeal.sealedAt ? `sealed at ${sourceSeal.sealedAt} (${sourceSeal.fileCount || 0} files)` : "sealed";
  return sourceSeal.detail || "Source integrity seal is missing. Run npm run seal:source after reviewing local code.";
}

function distanceKeyDetail(distanceKey) {
  if (!distanceKey.enabled) return distanceKey.hasToken ? "Saved but not required." : "Away-from-desk token is disabled.";
  if (!distanceKey.hasToken) return "Distance key is enabled but no token has been generated.";
  if (distanceKey.hasKeyFile) return `Removable key file is required (${distanceKey.keyFilePath}).`;
  return "Away-from-desk token is required.";
}

function launchAgentDetail(agent) {
  if (!agent.installed) return `not installed (${agent.path || "LaunchAgent plist missing"})`;
  if (agent.running) return `running${agent.pid ? ` as PID ${agent.pid}` : ""}`;
  if (agent.loaded) return "loaded but not currently running";
  return `plist exists but launchctl is not loading it${agent.error ? `: ${agent.error}` : ""}`;
}

function hostsDetail(hosts) {
  if (hosts.partial) return "markers are incomplete; run npm run hosts:apply";
  if (!hosts.installed) return "not installed; run npm run hosts:apply";
  if (hosts.stale) return `stale (${hosts.installedEntries}/${hosts.expectedEntries} entries); run npm run hosts:apply`;
  return `current (${hosts.installedEntries} entries)`;
}

function foolproofDetail(foolproof) {
  if (!foolproof.enabled) return "disabled; strict locks can start before hardening checks are ready.";
  if (foolproof.ready) return "enabled and ready.";
  return `${foolproof.blockers.length} blocker${foolproof.blockers.length === 1 ? "" : "s"}: ${foolproof.blockers.map((item) => item.id).join(", ")}`;
}
