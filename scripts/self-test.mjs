import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRICK_MODE_PROFILE_ID, defaultState, PANIC_LOCK_PROFILE_ID, REQUIRED_EXTENSION_VERSION, SOFT_BLOCK_PROFILE_ID } from "../src/defaults.js";
import { accountStatusFromGroups } from "../src/account.js";
import { activeAppLockPolicy, confirmAppLockUnlock, requestAppLockUnlock } from "../src/appLocks.js";
import { contentFilterRuleEntries, matchContentFilterUrl } from "../src/contentFilters.js";
import { assertDistanceKey, distanceKeySummary, updateDistanceKeySettings } from "../src/distanceKey.js";
import { doctorRows, formatDoctorRows } from "../src/doctorReport.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { focusShortcutDetail, focusShortcutSummary, reconcileFocusShortcut } from "../src/focusHooks.js";
import { assertFoolproofReadyForStrict, extensionDynamicRulesReady, extensionVersionReady, foolproofBlockers } from "../src/foolproof.js";
import { buildFirewallBlock, buildPfConfBlock, extractManagedFirewallBlock, extractManagedPfConfBlock, firewallDomainSignature, firewallStatus, replaceManagedPfConfBlock } from "../src/firewall.js";
import { buildHostsBlock, extractHostsBlock, hostsBlockMatches, LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END, parseLaunchAgentPrint, replaceManagedHostsBlock } from "../src/hardening.js";
import { clearIntegrityTamper, clearTrustedSourceSealDrift, detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, integrityLockdownPolicy, integrityRuntimeSummary, recordRuntimeHeartbeat } from "../src/integrityLockdown.js";
import { assertIntentReason, intentReasonSummary } from "../src/intentReason.js";
import { emergencyDelaySeconds, interventionSummary, recentBlockAttempts } from "../src/intervention.js";
import { accountabilityDigest, confirmIntentionalPause, intentionalUseDecision, intentionalUseSummary, skipIntentionalPause } from "../src/intentionalUse.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, buildIosMdmPushRequest, handleIosMdmCheckIn, handleIosMdmConnect, iosMdmSummary, queueIosMdmPolicyRefresh } from "../src/iosMdm.js";
import { buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "../src/keyholder.js";
import { activeLimitPolicy } from "../src/limits.js";
import { parseProcessList } from "../src/macos.js";
import { appQuitEscalationDecision, shouldLockScreenForPolicy, sweepBlockedApps } from "../src/monitor.js";
import { parsePlist, plistData, toPlist } from "../src/plist.js";
import { activePolicy, activeSchedule, appMatchesAppTargets, clearSessionsById, emergencyUnlockAllowedForPolicy, expandAppTargets, expandSiteTargets, hostMatchesSiteTargets, isFullLockoutPolicy, matchBlockedUrlPattern, matchStrictBrowserControlUrl, panicLockProfile, profileById, sessionPhase, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";
import { distractionPresets } from "../src/presets.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, protectedEditBlockers, requestMaintenanceWindow } from "../src/protection.js";
import { focusReport } from "../src/reports.js";
import { applySealVerificationToState, markStateSealed, stateDigest, stateSealSummary, verifyStateTextSeal, writeStateTextSeal } from "../src/seal.js";
import { sourceManifestText, sourceSealStatus, writeSourceSeal } from "../src/sourceSeal.js";
import { sanitizeSoftBlockProfile } from "../src/store.js";
import { recordUsage, syncDeviceUsageSnapshot, usageSummary } from "../src/usage.js";

const now = new Date("2026-05-28T14:00:00-04:00");
const TEST_DAYS = [0, 1, 2, 3, 4, 5, 6];

function clockTime(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

{
  const state = defaultState();
  assert.equal(focusShortcutSummary(state).enabled, false);
  assert.match(focusShortcutDetail(focusShortcutSummary(state)), /disabled/);
  assert.equal((await reconcileFocusShortcut(state, null, now)).changed, false);
  state.focusShortcut.active = true;
  state.settings.focusShortcutOffName = "";
  const missingOff = await reconcileFocusShortcut(state, null, now);
  assert.equal(missingOff.ok, false);
  assert.match(missingOff.lastError, /Focus Off/);
}

{
  const state = defaultState();
  assert.equal(intentReasonSummary(state).enabled, true);
  assert.equal(state.settings.focusSoundEnabled, false);
  assert.equal(state.settings.focusSoundPreset, "brown-noise");
  assert.equal(state.settings.focusSoundVolume, 35);
  assert.throws(() => assertIntentReason(state, "too short", "Emergency unlock"), /at least 20/);
  assert.equal(
    assertIntentReason(state, "  I need to unblock this briefly for a real task.  ", "Emergency unlock"),
    "I need to unblock this briefly for a real task."
  );
  state.settings.intentReasonEnabled = false;
  assert.equal(assertIntentReason(state, "", "Emergency unlock"), "");
}

{
  const state = defaultState();
  const usage = {};
  state.settings.activeProfileId = SOFT_BLOCK_PROFILE_ID;
  const first = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/watch?v=abc",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(first.paused, true);
  assert.equal(first.blocked, false);
  assert.match(first.redirectUrl, /\/pause\?requestId=/);
  assert.equal(state.intentionalUse.pauses.length, 1);
  const pauseId = first.pause.id;
  state.intentionalUse.pauses[0].eligibleAt = now.toISOString();
  const continued = confirmIntentionalPause(state, pauseId, {
    intention: "Watch one specific tutorial",
    mood: "Focused"
  }, now);
  assert.equal(continued.grant.targetType, "site");
  const allowed = evaluateExtensionCheck(state, usage, {
    url: "https://youtube.com/watch?v=abc",
    previousUrl: "",
    event: "activated",
    seconds: 45,
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, new Date(now.getTime() + 1000));
  assert.equal(allowed.paused, false);
  assert.equal(allowed.blocked, false);
  assert.equal(intentionalUseSummary(state, usage, new Date(now.getTime() + 1000)).today.continued, 1);
  assert.equal(intentionalUseSummary(state, usage, new Date(now.getTime() + 1000)).today.seconds, 45);

  const manual = intentionalUseDecision(state, { app: "YouTube", hostname: "", url: "" }, { event: "mac-app" }, now);
  assert.equal(manual.shouldPause, false);

  const appState = defaultState();
  appState.intentionalUse.rules = [{
    id: "app-pause",
    name: "Game pause",
    enabled: true,
    frictionLevel: "gentle",
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
    apps: ["Chess"],
    sites: [],
    delaySeconds: 0,
    sessionMinutes: 5,
    dailyBudgetMinutes: 0
  }];
  const appPause = intentionalUseDecision(appState, { app: "Chess", hostname: "", url: "" }, { event: "mac-app" }, now);
  assert.equal(appPause.shouldPause, true);
  assert.equal(appPause.pause.targetType, "app");
  appState.intentionalUse.pauses[0].eligibleAt = now.toISOString();
  const appContinued = confirmIntentionalPause(appState, appPause.pause.id, { intention: "One puzzle" }, now);
  assert.equal(appContinued.grant.app, "Chess");
  assert.equal(appContinued.returnUrl, "");

  const second = evaluateExtensionCheck(state, usage, {
    url: "https://www.instagram.com/reels/123",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, new Date(now.getTime() + 16 * 60 * 1000));
  assert.equal(second.paused, true);
  skipIntentionalPause(state, second.pause.id, { replacement: "Open Notes instead" }, new Date(now.getTime() + 16 * 60 * 1000));
  const digest = accountabilityDigest(state, usage, now);
  assert.match(digest.text, /Intentional pauses:/);
  assert.equal(digest.skipped, 1);
}

{
  const state = defaultState();
  state.settings.foolproofModeEnabled = true;
  state.settings.strictBypassProtectionEnabled = true;
  const missing = foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now);
  assert.equal(missing.some((item) => item.id === "state-seal"), true);
  assert.equal(missing.some((item) => item.id === "source-seal"), true);
  assert.equal(missing.some((item) => item.id === "keyholder"), true);
  assert.equal(missing.some((item) => item.id === "distance-key"), true);
  assert.equal(missing.some((item) => item.id === "extension-rules"), true);
  assert.equal(missing.some((item) => item.id === "hosts"), true);
  state.settings.processSweepEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "process-sweep"), true);
  state.settings.processSweepEnabled = true;
  state.settings.browserNoiseBlockingEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "browser-noise"), true);
  state.settings.browserNoiseBlockingEnabled = true;
  state.settings.contentFilterEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "content-filter"), true);
  state.settings.contentFilterEnabled = true;
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "bypass-protection"), true);
  state.settings.strictBypassProtectionEnabled = true;
  state.settings.typingChallengeEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "typing-challenge"), true);
  state.settings.typingChallengeEnabled = true;
  state.settings.intentReasonEnabled = false;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "intent-reason"), true);
  state.settings.intentReasonEnabled = true;
  state.settings.intentReasonMinLength = 5;
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "intent-reason"), true);
  state.settings.intentReasonMinLength = 20;
  assert.throws(() => assertFoolproofReadyForStrict(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now), /Foolproof mode/);

  updateKeyholderSettings(state, { enabled: true, passcode: "anchor-passcode" }, now);
  const distance = updateDistanceKeySettings(state, { enabled: true, rotate: true }, now);
  assert.doesNotThrow(() => assertDistanceKey(state, distance.token, now));
  state.extension.lastSeenAt = now.toISOString();
  state.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const expectedRules = extensionRuleSnapshot(state, now);
  state.extension.dynamicRules = {
    syncedAt: now.toISOString(),
    count: expectedRules.dynamicRuleCount,
    expectedCount: expectedRules.dynamicRuleCount,
    signature: expectedRules.dynamicRuleSignature,
    expectedSignature: expectedRules.dynamicRuleSignature,
    fallbackRequired: false,
    status: "synced",
    ok: true
  };
  assert.equal(extensionVersionReady(state).ok, true);
  assert.equal(extensionDynamicRulesReady(state, now).ok, true);
  state.extension.dynamicRules.count = expectedRules.dynamicRuleCount + 1;
  assert.equal(extensionDynamicRulesReady(state, now).status, "mismatch");
  state.extension.dynamicRules.count = expectedRules.dynamicRuleCount;
  state.extension.dynamicRules.signature = "stale";
  assert.equal(extensionDynamicRulesReady(state, now).status, "mismatch");
  state.extension.dynamicRules.signature = expectedRules.dynamicRuleSignature;
  state.extension.dynamicRules.fallbackRequired = true;
  assert.equal(extensionDynamicRulesReady(state, now).ok, false);
  state.extension.dynamicRules.fallbackRequired = false;
  state.extension.lastVersion = "0.1.0";
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "browser-extension-version"), true);
  state.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const readyFirewall = { installed: true, partial: false, stale: false, installedEntries: 8 };
  const readyContext = {
    hosts: { installed: true, partial: false, stale: false },
    firewall: readyFirewall,
    agent: { loaded: true, running: true },
    account: accountStatusFromGroups("focus", "staff everyone"),
    monitor: { ok: true, accessibilityLikelyMissing: false },
    stateSeal: { ok: true, status: "sealed", detail: "State file matches its integrity seal." },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", fileCount: 42 }
  };
  assert.deepEqual(foolproofBlockers(state, readyContext, now), []);
  assert.doesNotThrow(() => assertFoolproofReadyForStrict(state, readyContext, now));
  assert.equal(foolproofBlockers(state, { ...readyContext, firewall: { installed: false, partial: false, stale: false } }, now).some((item) => item.id === "firewall"), true);
  assert.equal(foolproofBlockers(state, {
    ...readyContext,
    account: accountStatusFromGroups("daily", "staff admin everyone")
  }, now).some((item) => item.id === "standard-account"), true);

  assert.equal(foolproofBlockers(state, {
    ...readyContext,
    stateSeal: { ok: false, status: "mismatch", detail: "State file does not match its integrity seal." }
  }, now).some((item) => item.id === "state-seal"), true);
}

{
  const state = defaultState();
  state.settings.foolproofModeEnabled = true;
  state.settings.strictBypassProtectionEnabled = true;
  state.integrity.runtime.lastHeartbeatAt = now.toISOString();
  state.extension.lastSeenAt = now.toISOString();
  state.extension.lastVersion = REQUIRED_EXTENSION_VERSION;
  const expectedRules = extensionRuleSnapshot(state, now);
  state.extension.dynamicRules = {
    syncedAt: now.toISOString(),
    count: expectedRules.dynamicRuleCount,
    expectedCount: expectedRules.dynamicRuleCount,
    signature: expectedRules.dynamicRuleSignature,
    expectedSignature: expectedRules.dynamicRuleSignature,
    fallbackRequired: false,
    status: "synced",
    ok: true
  };
  updateKeyholderSettings(state, { enabled: true, passcode: "anchor-passcode" }, now);
  updateDistanceKeySettings(state, { enabled: true, rotate: true }, now);
  const rows = doctorRows(state, {
    seal: { ok: true, status: "sealed", detail: "State file matches its integrity seal.", lastSealedAt: now.toISOString() },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", sealedAt: now.toISOString(), fileCount: 42 },
    hosts: { installed: true, partial: false, stale: false, installedEntries: 20, expectedEntries: 20 },
    firewall: { installed: true, partial: false, stale: false, installedEntries: 8 },
    agent: { installed: true, loaded: true, running: true, pid: 12345 },
    account: accountStatusFromGroups("focus", "staff everyone")
  }, now);
  const byId = new Map(rows.map((item) => [item.id, item]));
  assert.equal(byId.get("foolproof").ok, true);
  assert.equal(byId.get("mac-account").ok, true);
  assert.equal(byId.get("extension-version").ok, true);
  assert.equal(byId.get("extension-rules").ok, true);
  assert.equal(byId.get("intent-reason").ok, true);
  assert.equal(byId.get("keyholder").ok, true);
  assert.match(formatDoctorRows(rows), /OK\s+Foolproof readiness/);

  state.extension.dynamicRules.syncedAt = new Date(now.getTime() - 3 * 60 * 1000).toISOString();
  const staleRows = doctorRows(state, {
    seal: { ok: true, status: "sealed", detail: "State file matches its integrity seal.", lastSealedAt: now.toISOString() },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", sealedAt: now.toISOString(), fileCount: 42 },
    hosts: { installed: true, partial: false, stale: false, installedEntries: 20, expectedEntries: 20 },
    firewall: { installed: true, partial: false, stale: false, installedEntries: 8 },
    agent: { installed: true, loaded: true, running: true, pid: 12345 },
    account: accountStatusFromGroups("focus", "staff everyone")
  }, now);
  assert.equal(staleRows.find((item) => item.id === "extension-rules").ok, false);
}

{
  const dir = await mkdtemp(join(tmpdir(), "vigil-source-seal-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "scripts"), { recursive: true });
    await writeFile(join(dir, "package.json"), "{\"type\":\"module\"}\n");
    await writeFile(join(dir, "src", "server.js"), "console.log('ok');\n");
    await writeFile(join(dir, "scripts", "tool.mjs"), "console.log('tool');\n");
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "source.seal.json");
    const initial = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(initial.ok, false);
    assert.equal(initial.status, "missing");
    const written = await writeSourceSeal({ root: dir, keyPath, sealPath, sealedAt: now.toISOString() });
    assert.equal(written.ok, true);
    const sealed = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(sealed.ok, true);
    const manifest = JSON.parse(await sourceManifestText({ root: dir }));
    assert.deepEqual(manifest.files.map((file) => file.path), ["package.json", "scripts/tool.mjs", "src/server.js"]);
    await writeFile(join(dir, "src", "server.js"), "console.log('changed');\n");
    const changed = await sourceSealStatus({ root: dir, keyPath, sealPath });
    assert.equal(changed.status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "vigil-seal-"));
  try {
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "state.seal.json");
    const text = "{\"settings\":{\"strictByDefault\":true}}\n";
    const seal = await writeStateTextSeal(text, { keyPath, sealPath }, now.toISOString());
    const key = (await readFile(keyPath, "utf8")).trim();

    assert.equal(seal.digest, stateDigest(text, key));
    assert.equal((await verifyStateTextSeal(text, { keyPath, sealPath })).status, "sealed");
    assert.equal((await verifyStateTextSeal(text.replace("true", "false"), { keyPath, sealPath })).status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const dir = await mkdtemp(join(tmpdir(), "vigil-protected-seal-"));
  try {
    const keyPath = join(dir, "state-seal.key");
    const sealPath = join(dir, "state.seal.json");
    const state = defaultState();
    const text = `${JSON.stringify(state, null, 2)}\n`;
    await writeStateTextSeal(text, { keyPath, sealPath, scope: "state" }, now.toISOString());

    const bookkeepingChange = structuredClone(state);
    bookkeepingChange.events.unshift({ id: "event", type: "note", detail: {}, at: now.toISOString() });
    bookkeepingChange.integrity.runtime.lastHeartbeatAt = new Date(now.getTime() + 1000).toISOString();
    const bookkeepingText = `${JSON.stringify(bookkeepingChange, null, 2)}\n`;
    const bookkeepingVerification = await verifyStateTextSeal(bookkeepingText, { keyPath, sealPath });
    assert.equal(bookkeepingVerification.ok, true);
    assert.equal(bookkeepingVerification.status, "bookkeeping-mismatch");

    const bypassChange = structuredClone(state);
    bypassChange.settings.siteRedirectEnabled = false;
    const bypassText = `${JSON.stringify(bypassChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(bypassText, { keyPath, sealPath })).status, "mismatch");

    const runtimeThresholdChange = structuredClone(state);
    runtimeThresholdChange.settings.runtimeGapLockdownSeconds = 999999;
    const runtimeThresholdText = `${JSON.stringify(runtimeThresholdChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(runtimeThresholdText, { keyPath, sealPath })).status, "mismatch");

    const clockThresholdChange = structuredClone(state);
    clockThresholdChange.settings.clockTamperLockdownSeconds = 999999;
    const clockThresholdText = `${JSON.stringify(clockThresholdChange, null, 2)}\n`;
    assert.equal((await verifyStateTextSeal(clockThresholdText, { keyPath, sealPath })).status, "mismatch");

    const legacyBrandingState = structuredClone(state);
    legacyBrandingState.settings.focusShortcutOnName = "Vigil Focus On";
    legacyBrandingState.settings.focusShortcutOffName = "Vigil Focus Off";
    const legacyBrandingText = `${JSON.stringify(legacyBrandingState, null, 2)}\n`;
    await writeStateTextSeal(legacyBrandingText, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const vigilBrandingState = structuredClone(legacyBrandingState);
    vigilBrandingState.settings.focusShortcutOnName = "Vigil Focus On";
    vigilBrandingState.settings.focusShortcutOffName = "Vigil Focus Off";
    const vigilBrandingVerification = await verifyStateTextSeal(`${JSON.stringify(vigilBrandingState, null, 2)}\n`, { keyPath, sealPath });
    assert.equal(vigilBrandingVerification.ok, true);
    assert.equal(vigilBrandingVerification.status, "trusted-migration");

    const preIntentionalUseState = structuredClone(state);
    delete preIntentionalUseState.intentionalUse;
    delete preIntentionalUseState.settings.intentionalUseEnabled;
    await writeStateTextSeal(`${JSON.stringify(preIntentionalUseState, null, 2)}\n`, { keyPath, sealPath, scope: "state" }, now.toISOString());
    const intentionalUseMigrationVerification = await verifyStateTextSeal(text, { keyPath, sealPath });
    assert.equal(intentionalUseMigrationVerification.ok, true);
    assert.equal(intentionalUseMigrationVerification.status, "trusted-migration");

    const mdmQueueState = structuredClone(state);
    mdmQueueState.deviceControls.ios.mdm.enabled = true;
    mdmQueueState.deviceControls.ios.mdm.devices = [{ udid: "iphone-udid-1", status: "enrolled" }];
    mdmQueueState.deviceControls.ios.mdm.commands = [{
      udid: "iphone-udid-1",
      requestType: "InstallProfile",
      status: "queued",
      policyHash: "policy-hash"
    }];
    mdmQueueState.deviceControls.ios.mdm.lastPolicyHash = "policy-hash";
    const mdmQueueText = `${JSON.stringify(mdmQueueState, null, 2)}\n`;
    await writeStateTextSeal(mdmQueueText, { keyPath, sealPath, scope: "state" }, now.toISOString());
    mdmQueueState.deviceControls.ios.mdm.commands = [];
    assert.equal((await verifyStateTextSeal(`${JSON.stringify(mdmQueueState, null, 2)}\n`, { keyPath, sealPath })).status, "mismatch");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const state = defaultState();
  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));

  const summary = stateSealSummary(state, {
    ok: true,
    status: "sealed",
    detail: "State file matches its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString()
  });
  assert.equal(summary.ok, false);
  assert.equal(summary.status, "tamper-detected");
}

{
  const state = defaultState();
  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));
  state.settings.siteRedirectEnabled = false;
  state.settings.appQuitEnabled = false;
  state.settings.processSweepEnabled = false;
  state.settings.strictBypassProtectionEnabled = false;
  state.settings.protectedEditsEnabled = false;

  assert.equal(integrityLockdownActive(state), true);
  assert.equal(integrityLockdownPolicy(state, now).kind, "integrity");
  assert.equal(activePolicy(state, now).kind, "integrity");
  assert.equal(shouldBlockSite(activePolicy(state, now).profile, "reddit.com"), true);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "App Store"), true);
  assert.equal(protectedEditBlockers(state, { kind: "settings" }, now).some((item) => item.kind === "integrity"), true);
  assert.equal(sweepBlockedApps(state, {}, ["App Store"], now).map((item) => item.app).includes("App Store"), true);
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityLockdownActive(state), false);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  state.activeSession = {
    id: "offline-strict",
    title: "Offline strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  recordRuntimeHeartbeat(state, now);
  const gap = detectRuntimeGap(state, new Date(now.getTime() + 3 * 60 * 1000));
  assert.equal(gap.overlap.kind, "manual");
  assert.equal(integrityRuntimeSummary(state).ok, false);
  assert.equal(activePolicy(state, now).kind, "integrity");
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = false;
  state.activeSession = {
    id: "clock-strict",
    title: "Clock strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const tamper = detectClockTamper(state, {
    previousWallMs: now.getTime(),
    currentWallMs: now.getTime() + 10 * 60 * 1000,
    previousMonotonicMs: 1000,
    currentMonotonicMs: 4000
  }, new Date(now.getTime() + 10 * 60 * 1000));
  assert.equal(tamper.direction, "forward");
  assert.equal(integrityRuntimeSummary(state).status, "clock-tamper");
  assert.equal(activePolicy(state, now).kind, "integrity");
  assert.equal(integrityLockdownPolicy(state, now).alarm.type, "clock-tamper");
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);

  const noLock = defaultState();
  assert.equal(detectClockTamper(noLock, {
    previousWallMs: now.getTime(),
    currentWallMs: now.getTime() + 10 * 60 * 1000,
    previousMonotonicMs: 1000,
    currentMonotonicMs: 4000
  }, new Date(now.getTime() + 10 * 60 * 1000)), null);
}

{
  const state = defaultState();
  state.events = [
    { id: "1", type: "blocked_site", detail: { site: "reddit.com" }, at: new Date(now.getTime() - 60 * 1000).toISOString() },
    { id: "2", type: "extension_blocked_site", detail: { site: "reddit.com" }, at: new Date(now.getTime() - 2 * 60 * 1000).toISOString() },
    { id: "3", type: "blocked_app", detail: { app: "Discord" }, at: new Date(now.getTime() - 3 * 60 * 1000).toISOString() },
    { id: "4", type: "blocked_site", detail: { site: "youtube.com" }, at: new Date(now.getTime() - 30 * 60 * 1000).toISOString() }
  ];
  const summary = interventionSummary(state, now);
  assert.equal(recentBlockAttempts(state, now).length, 3);
  assert.equal(summary.level, "elevated");
  assert.equal(summary.extraDelaySeconds, 45);
  assert.equal(emergencyDelaySeconds(state, now), state.settings.emergencyDelaySeconds + 45);
  assert.equal(summary.topTargets[0].label, "reddit.com");
  assert.equal(summary.topTargets[0].count, 2);
  state.settings.interventionEnabled = false;
  assert.equal(interventionSummary(state, now).extraDelaySeconds, 0);
}

{
  const state = defaultState();
  state.settings.foolproofModeEnabled = false;
  state.activeSession = {
    id: "drift-strict",
    title: "Drift strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const badHosts = { installed: false, partial: false, stale: false };
  const goodFirewall = { installed: true, partial: false, stale: false };
  const goodRules = { ok: true, status: "synced", detail: "Dynamic browser block rules synced (9 active).", count: 9 };
  assert.equal(detectHardeningDrift(state, { hosts: badHosts, firewall: goodFirewall, extensionRules: goodRules }, now), null);
  assert.equal(integrityLockdownActive(state), false);

  state.settings.foolproofModeEnabled = true;
  const goodSourceSeal = { ok: true, status: "sealed", detail: "Source files match integrity seal." };
  const drift = detectHardeningDrift(state, { hosts: badHosts, firewall: goodFirewall, extensionRules: goodRules, sourceSeal: goodSourceSeal }, now);
  assert.equal(drift.issues[0].id, "hosts");
  assert.equal(integrityRuntimeSummary(state).status, "hardening-drift");
  assert.equal(integrityLockdownPolicy(state, now).alarm.type, "hardening-drift");
  assert.equal(clearTrustedSourceSealDrift(state, now), false);
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);

  const staleRules = { ok: false, status: "stale", detail: "Browser companion dynamic block rules are stale.", count: 9 };
  const driftFirewall = detectHardeningDrift(state, { hosts: { installed: true, partial: false, stale: false }, firewall: { installed: false, partial: false, stale: false }, extensionRules: goodRules, sourceSeal: goodSourceSeal }, now);
  assert.equal(driftFirewall.issues[0].id, "firewall");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftRules = detectHardeningDrift(state, { hosts: { installed: true, partial: false, stale: false }, firewall: goodFirewall, extensionRules: staleRules, sourceSeal: goodSourceSeal }, now);
  assert.equal(driftRules.issues[0].id, "extension-rules");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftSource = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: { ok: false, status: "mismatch", detail: "Source files do not match the integrity seal." }
  }, now);
  assert.equal(driftSource.issues[0].id, "source-seal");
  assert.equal(clearTrustedSourceSealDrift(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);
  assert.equal(clearTrustedSourceSealDrift(state, now), false);

  const driftAgent = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: false, running: false }
  }, now);
  assert.equal(driftAgent.issues[0].id, "launch-agent");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftAccessibility = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: true, running: true },
    monitor: { ok: false, accessibilityLikelyMissing: true }
  }, now);
  assert.equal(driftAccessibility.issues[0].id, "accessibility");
}

{
  const state = defaultState();
  state.integrity.stateSeal.tamperDetectedAt = now.toISOString();
  state.integrity.stateSeal.tamperDetail = "State file does not match its integrity seal.";
  const policy = activePolicy(state, now);
  assert.equal(policy.kind, "integrity");
  assert.equal(shouldBlockAppForPolicy(state, policy, "Codex"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Codex Helper (Renderer)"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Activity Monitor"), true);
  assert.deepEqual(
    sweepBlockedApps(state, {}, ["Codex", "Codex Helper (Renderer)", "Terminal", "Activity Monitor", "Discord"], now).map((item) => item.app),
    ["Activity Monitor", "Discord"]
  );
}

{
  const state = defaultState();
  state.schedules = [{
    id: "offline-work",
    name: "Offline Work",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    days: TEST_DAYS,
    start: "00:00",
    end: "23:59",
    wifiNetworks: []
  }];
  recordRuntimeHeartbeat(state, new Date(2026, 4, 28, 12, 0, 0));
  const gap = detectRuntimeGap(state, new Date(2026, 4, 28, 16, 0, 0));
  assert.ok(gap);
  assert.equal(gap.overlap.kind, "schedule");
}

{
  const state = defaultState();
  recordRuntimeHeartbeat(state, now);
  assert.equal(detectRuntimeGap(state, new Date(now.getTime() + 10 * 60 * 1000)), null);
  assert.equal(integrityLockdownActive(state), false);
}

{
  const apps = parseProcessList(`/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
/Applications/Discord.app/Contents/MacOS/Discord
/usr/sbin/cfprefsd
`);
  assert.deepEqual(apps, ["Discord", "Finder"]);
}

{
  const state = defaultState();
  const usage = {};
  state.settings.strictBypassProtectionEnabled = true;
  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  assert.deepEqual(sweepBlockedApps(state, usage, ["Discord", "Finder"], now).map((item) => item.app), ["Discord"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Firefox", "Safari"], now).map((item) => item.app), ["Firefox"]);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Firefox"), true);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Slack", "Microsoft Teams", "Notion"], now).map((item) => item.app), ["Slack", "Microsoft Teams", "Notion"]);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Slack Helper (Renderer)"), true);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Discord Helper", "Steam Helper"], now).map((item) => item.app), ["Discord Helper", "Steam Helper"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Terminal", "Activity Monitor"], now).map((item) => item.app), ["Activity Monitor"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["App Store", "Installer", "Disk Utility"], now).map((item) => item.app), ["App Store", "Installer", "Disk Utility"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Tailscale", "Cloudflare WARP", "Proxyman", "Little Snitch Configuration"], now).map((item) => item.app), ["Tailscale", "Cloudflare WARP", "Proxyman", "Little Snitch Configuration"]);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "WireGuard Helper"), true);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Charles Proxy"), true);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "CleanMyMac"), true);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Jamf Self Service"), true);
  state.activeSession.profileSnapshot = {
    ...state.profiles[0],
    blockedSites: [],
    blockedUrlPatterns: []
  };
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Firefox"), false);
  assert.equal(shouldBlockAppForPolicy(state, activePolicy(state, now), "Slack"), false);
  state.activeSession.profileSnapshot = {
    ...state.profiles[0],
    mode: "allowlist",
    allowedApps: ["Finder", "Google Chrome"]
  };
  assert.deepEqual(sweepBlockedApps(state, usage, ["Discord", "Dock"], now).map((item) => item.app), ["Discord"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Google Chrome Helper"], now), []);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Terminal", "Dock"], now), []);
  state.activeSession.profileSnapshot = {
    ...state.profiles[0],
    blockedSites: [],
    blockedUrlPatterns: []
  };
  state.settings.strictBypassProtectionEnabled = false;
  assert.deepEqual(sweepBlockedApps(state, usage, ["Terminal", "App Store"], now), []);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  state.appLocks = [{
    id: "site-lock",
    name: "Site Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 2,
    unlockMinutes: 10,
    delaySeconds: 0
  }];
  assert.equal(activeAppLockPolicy(state, { app: "Firefox", hostname: "" }, now)?.appLock.id, "site-lock");
  assert.equal(activeAppLockPolicy(state, { app: "Slack Helper", hostname: "" }, now)?.appLock.id, "site-lock");
  assert.equal(activeAppLockPolicy(state, { app: "Safari", hostname: "" }, now), null);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(activeAppLockPolicy(state, { app: "Firefox", hostname: "" }, now), null);
  assert.equal(activeAppLockPolicy(state, { app: "Slack Helper", hostname: "" }, now), null);
}

{
  const state = defaultState();
  const usage = {};
  state.settings.strictBypassProtectionEnabled = true;
  state.limitBlocks = [{
    id: "site-limit-block",
    ruleId: "site-limit",
    ruleName: "Site Limit",
    type: "time",
    lockLevel: "deep",
    apps: [],
    sites: ["reddit.com"],
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    progress: {}
  }];
  assert.equal(activeLimitPolicy(state, usage, { app: "Firefox", hostname: "" }, now)?.limitBlock.id, "site-limit-block");
  assert.equal(activeLimitPolicy(state, usage, { app: "Microsoft Teams Helper", hostname: "" }, now)?.limitBlock.id, "site-limit-block");
  assert.equal(activeLimitPolicy(state, usage, { app: "Safari", hostname: "" }, now), null);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(activeLimitPolicy(state, usage, { app: "Firefox", hostname: "" }, now), null);
  assert.equal(activeLimitPolicy(state, usage, { app: "Microsoft Teams Helper", hostname: "" }, now), null);
}

{
  const state = defaultState();
  state.settings.appQuitEscalationSeconds = 10;
  const first = appQuitEscalationDecision(state, null, now.getTime());
  assert.equal(first.force, false);
  const second = appQuitEscalationDecision(state, first.record, now.getTime() + 9000);
  assert.equal(second.force, false);
  const third = appQuitEscalationDecision(state, second.record, now.getTime() + 11000);
  assert.equal(third.force, true);
  assert.equal(third.record.attempts, 3);
}

{
  const state = defaultState();
  const block = buildHostsBlock(state);
  const hosts = `127.0.0.1 localhost\n\n${block}\n\n255.255.255.255 broadcasthost\n`;
  assert.equal(hostsBlockMatches(extractHostsBlock(hosts), block), true);
  assert.match(block, /0\.0\.0\.0 pornhub\.com/);
  assert.doesNotMatch(block, /0\.0\.0\.0 youtube\.com/);
  assert.equal(hostsBlockMatches(extractHostsBlock(hosts).replace("pornhub.com", "example.com"), block), false);
  const legacyBlock = block
    .replace("# BEGIN VIGIL", LEGACY_HOSTS_BEGIN)
    .replace("# END VIGIL", LEGACY_HOSTS_END);
  const legacyHosts = `127.0.0.1 localhost\n\n${legacyBlock}\n\n255.255.255.255 broadcasthost\n`;
  assert.equal(extractHostsBlock(legacyHosts), legacyBlock);
  const migratedHosts = replaceManagedHostsBlock(legacyHosts, block);
  assert.equal(migratedHosts.includes(LEGACY_HOSTS_BEGIN), false);
  assert.equal(hostsBlockMatches(extractHostsBlock(migratedHosts), block), true);
  const duplicateHosts = replaceManagedHostsBlock(`${legacyHosts}\n${block}\n`, block);
  assert.equal((duplicateHosts.match(/# BEGIN VIGIL/g) || []).length, 1);
  assert.equal(duplicateHosts.includes(LEGACY_HOSTS_BEGIN), false);

  const launch = parseLaunchAgentPrint(`service = enabled
pid = 12345
last exit code = 0
`);
  assert.equal(launch.running, true);
  assert.equal(launch.pid, 12345);
  assert.equal(launch.lastExitStatus, 0);
}

{
  const domains = ["example.com", "news.example"];
  const entries = [
    { domain: "example.com", host: "example.com", address: "93.184.216.34" },
    { domain: "news.example", host: "www.news.example", address: "203.0.113.7" },
    { domain: "duplicate.example", host: "duplicate.example", address: "93.184.216.34" }
  ];
  const anchor = buildFirewallBlock(domains, entries, [{ host: "www.example.com", error: "ENOTFOUND" }]);
  assert.equal(extractManagedFirewallBlock(anchor), anchor);
  assert.match(anchor, /# Domain-Count: 2/);
  assert.match(anchor, /block return out quick to 93\.184\.216\.34/);
  assert.match(anchor, /block return out quick to 203\.0\.113\.7/);
  assert.equal((anchor.match(/block return out quick to 93\.184\.216\.34/g) || []).length, 1);
  assert.match(anchor, new RegExp(firewallDomainSignature(domains)));

  const pfConfBlock = buildPfConfBlock();
  const pfConf = replaceManagedPfConfBlock("anchor \"com.apple/*\"\n", pfConfBlock);
  assert.equal(extractManagedPfConfBlock(pfConf), pfConfBlock);
  const migratedPfConf = replaceManagedPfConfBlock(`${pfConf}\n${pfConfBlock}\n`, pfConfBlock);
  assert.equal((migratedPfConf.match(/# BEGIN VIGIL PF/g) || []).length, 1);

  const dir = await mkdtemp(join(tmpdir(), "vigil-firewall-"));
  const pfConfPath = join(dir, "pf.conf");
  const anchorPath = join(dir, "com.vigil.block");
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: ["example.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  await writeFile(pfConfPath, pfConf, "utf8");
  await writeFile(anchorPath, buildFirewallBlock(["example.com"], [entries[0]]), "utf8");
  const current = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(current.current, true);
  assert.equal(current.installedEntries, 1);
  await writeFile(anchorPath, buildFirewallBlock(["example.com"]), "utf8");
  const unresolved = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(unresolved.current, false);
  assert.equal(unresolved.stale, true);
  assert.equal(unresolved.installedEntries, 0);
  await writeFile(anchorPath, buildFirewallBlock(["example.com"], [entries[0]]), "utf8");
  state.profiles[0].blockedSites = ["changed.example"];
  const stale = await firewallStatus(state, now, { pfConfPath, anchorPath });
  assert.equal(stale.stale, true);
  await rm(dir, { recursive: true, force: true });
}

{
  const state = defaultState();
  state.activeSession = {
    id: "custom-pattern-session",
    title: "Pattern session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "blocklist",
      blockedSites: [],
      blockedUrlPatterns: [
        "example.com/games",
        "https://www.news.example/path?q=1",
        "/reels",
        "casino",
        "localhost/admin"
      ],
      allowedSites: []
    }
  };
  const block = buildHostsBlock(state, now);
  assert.match(block, /0\.0\.0\.0 example\.com/);
  assert.match(block, /0\.0\.0\.0 news\.example/);
  assert.doesNotMatch(block, /casino/);
  assert.doesNotMatch(block, /localhost/);
  assert.doesNotMatch(block, /\/reels/);
}

{
  const serverSource = await readFile(join(process.cwd(), "src", "server.js"), "utf8");
  const hardeningSummarySource = await readFile(join(process.cwd(), "src", "server", "hardeningSummary.js"), "utf8");
  const localScriptsSource = await readFile(join(process.cwd(), "src", "server", "localScripts.js"), "utf8");
  const statePayloadSource = await readFile(join(process.cwd(), "src", "server", "statePayload.js"), "utf8");
  assert.match(serverSource, /\/api\/hardening\/hosts\/apply/);
  assert.match(localScriptsSource, /with administrator privileges/);
  assert.match(hardeningSummarySource, /npm run seal:source/);
  assert.match(hardeningSummarySource, /extensionLoad/);
  assert.match(serverSource, /Brick Mode/);
  assert.match(serverSource, /\/api\/panic\/start/);
  assert.match(serverSource, /panicLockDurationMinutes/);
  assert.match(hardeningSummarySource, /browser control pages/);
  assert.match(statePayloadSource, /strictPreflightState/);
  assert.match(statePayloadSource, /profileSnapshot: snapshotProfile\(profile\)/);
  assert.match(serverSource, /\/api\/extension\/rules\/sync/);
  assert.match(statePayloadSource, /focusShortcutSummary/);
  assert.match(serverSource, /assertIntentReason/);
  assert.doesNotMatch(serverSource, /\/api\/devices\/android|Android|android_settings/);
  const indexSource = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.match(indexSource, /id="startNormalMode"/);
  assert.match(indexSource, /id="startSoftBlock"/);
  assert.match(indexSource, /id="startFullBrick"/);
  assert.match(indexSource, /data-device-target="computer"/);
  assert.match(indexSource, /data-device-target="phone"/);
  assert.match(indexSource, /Apple Companion Control/);
  assert.doesNotMatch(indexSource, /Android|ADB/);
  assert.match(indexSource, /id="startPanicLock"/);
  assert.match(indexSource, /id="panicLockDurationMinutes"/);
  assert.match(indexSource, /id="focusShortcutEnabled"/);
  assert.match(indexSource, /id="intentReasonEnabled"/);
  assert.match(indexSource, /id="focusSoundEnabled"/);
  const appSource = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(appSource, /BRICK_MODE_PROFILE_ID/);
  assert.match(appSource, /\/api\/panic\/start/);
  assert.match(appSource, /saveFocusShortcuts/);
  assert.doesNotMatch(appSource, /Android|android|ADB/);
  assert.match(appSource, /renderIntentReasonHints/);
  assert.match(appSource, /createDistanceKeyQrSvg/);
  assert.doesNotMatch(appSource, /innerHTML|insertAdjacentHTML|outerHTML|document\.write/);
  assert.match(appSource, /BarcodeDetector/);
  assert.match(appSource, /printDistanceKey/);
  const focusSoundSource = await readFile(join(process.cwd(), "public", "focus-sound.js"), "utf8");
  assert.match(focusSoundSource, /focusSoundPreset/);
  assert.match(focusSoundSource, /createNoiseSource/);
  const qrSource = await readFile(join(process.cwd(), "public", "distance-key-qr.js"), "utf8");
  assert.match(qrSource, /distanceKeyQrMatrix/);
  const extensionSource = await readFile(join(process.cwd(), "extension", "background.js"), "utf8");
  assert.match(extensionSource, /ALLOWLIST_RULE_START/);
  assert.match(extensionSource, /excludedRequestDomains/);
  assert.match(extensionSource, /reportRuleSync/);
  assert.match(extensionSource, /vigilLocalServer/);
  assert.match(extensionSource, /x-vigil-extension-token/);
  const extensionManifest = JSON.parse(await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8"));
  assert.equal(extensionManifest.version, REQUIRED_EXTENSION_VERSION);
  assert.equal(extensionManifest.options_page, "options.html");
  const monitorSource = await readFile(join(process.cwd(), "src", "monitor.js"), "utf8");
  assert.match(monitorSource, /blocked_browser_control/);
  const sealSource = await readFile(join(process.cwd(), "src", "seal.js"), "utf8");
  assert.match(sealSource, /rename\(tempPath, sealPath\)/);
  assert.equal(distractionPresets().some((preset) => preset.id === "rehab" && preset.sites.includes("youtube.com")), true);
}

{
  const state = defaultState();
  state.schedules = [{
    id: "work",
    name: "Work",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    commitmentLock: true,
    days: TEST_DAYS,
    start: "00:00",
    end: "23:59",
    wifiNetworks: ["Office"]
  }];
  state.environment.wifiSsid = "Office";
  const schedule = activeSchedule(state, now);
  assert.equal(schedule.schedule.id, "work");
  assert.equal(schedule.session.canEndEarly, false);
  assert.equal(schedule.session.emergencyUnlocksAllowed, false);
  assert.equal(emergencyUnlockAllowedForPolicy(activePolicy(state, now)), false);
  state.environment.wifiSsid = "Home";
  assert.equal(activeSchedule(state, now), null);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "commitment",
    title: "Commitment focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "manual"
  };
  assert.equal(emergencyUnlockAllowedForPolicy(activePolicy(state, now)), false);
}

{
  const state = defaultState();
  const summary = updateKeyholderSettings(state, { enabled: true, passcode: "anchor-passcode" }, now);
  assert.equal(summary.enabled, true);
  assert.equal(summary.hasPasscode, true);
  assert.throws(() => assertKeyholderPasscode(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertKeyholderPasscode(state, "anchor-passcode"));
  state.appLocks = [{
    id: "keyheld-lock",
    name: "Keyheld Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const request = requestAppLockUnlock(state, "keyheld-lock", "I need this app lock opened for a short necessary task.", now);
  assert.equal(Boolean(request.challenge?.text), true);
  assert.throws(() => {
    assertKeyholderPasscode(state, "wrong");
    confirmAppLockUnlock(state, request.id, now);
  }, /incorrect/);
  assert.doesNotThrow(() => {
    assertKeyholderPasscode(state, "anchor-passcode");
    confirmAppLockUnlock(state, request.id, { challengeText: request.challenge.text }, now);
  });

  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));
  state.keyholder.enabled = false;
  assert.throws(() => assertKeyholderPasscode(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertKeyholderPasscode(state, "anchor-passcode"));
}

{
  const state = defaultState();
  assert.throws(() => updateDistanceKeySettings(state, { enabled: true }, now), /Generate or enter/);
  const result = updateDistanceKeySettings(state, { enabled: true, rotate: true }, now);
  assert.match(result.token, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(distanceKeySummary(state).enabled, true);
  assert.throws(() => assertDistanceKey(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertDistanceKey(state, result.token.toLowerCase(), now));
  assert.equal(Boolean(state.distanceKey.lastVerifiedAt), true);

  state.distanceKey.enabled = false;
  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));
  assert.throws(() => assertDistanceKey(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertDistanceKey(state, result.token, now));
}

{
  const dir = await mkdtemp(join(tmpdir(), "vigil-distance-key-"));
  try {
    const state = defaultState();
    const keyPath = join(dir, "USB", "vigil.key");
    const result = updateDistanceKeySettings(state, {
      enabled: true,
      keyFilePath: keyPath,
      writeKeyFile: true
    }, now);
    assert.equal(result.keyFilePath, keyPath);
    assert.equal(distanceKeySummary(state).hasKeyFile, true);
    assert.match(await readFile(keyPath, "utf8"), /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}/);
    assert.doesNotThrow(() => assertDistanceKey(state, "", now));
    assert.equal(Boolean(state.distanceKey.lastFileVerifiedAt), true);
    await rm(keyPath, { force: true });
    assert.throws(() => assertDistanceKey(state, "", now), /incorrect/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const state = defaultState();
  const profile = state.profiles[0];
  assert.equal(shouldBlockSite(profile, "www.youtube.com"), true);
  assert.equal(shouldBlockSite(profile, "youtu.be"), true);
  assert.equal(shouldBlockSite(profile, "www.youtube-nocookie.com"), true);
  assert.equal(shouldBlockSite(profile, "redd.it"), true);
  assert.equal(shouldBlockSite(profile, "fb.com"), true);
  assert.equal(shouldBlockSite(profile, "docs.google.com"), false);
  assert.equal(expandSiteTargets(["youtube.com"]).includes("youtu.be"), true);
  assert.equal(hostMatchesSiteTargets("mobile.twitter.com", ["x.com"]), true);
  assert.equal(shouldBlockSite({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }, "youtu.be"), false);
  assert.equal(shouldBlockSite({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }, "reddit.com"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/shorts/abc"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/watch?v=abc"), false);
  assert.equal(shouldBlockUrl({ ...profile, blockedUrlPatterns: ["/reels", "casino"] }, "https://example.com/reels/latest"), true);
  assert.equal(matchBlockedUrlPattern({ ...profile, blockedUrlPatterns: ["casino"] }, "https://news.example/search?q=casino")?.pattern, "casino");
  assert.equal(expandAppTargets(["Steam"]).includes("steam helper"), true);
  assert.equal(appMatchesAppTargets("EpicWebHelper", ["Epic Games Launcher"]), true);
  assert.equal(appMatchesAppTargets("Discord Helper.app", ["Discord"]), true);
  assert.equal(appMatchesAppTargets("Slack Helper (Renderer)", ["Slack"]), true);
  assert.equal(appMatchesAppTargets("MSTeams", ["Microsoft Teams"]), true);
  assert.equal(appMatchesAppTargets("Cloudflare WARP", ["WARP"]), true);
  assert.equal(appMatchesAppTargets("Little Snitch Network Monitor", ["Little Snitch Configuration"]), true);
  assert.equal(appMatchesAppTargets("Charles Proxy", ["Charles"]), true);
}

{
  const state = defaultState();
  const usage = {};
  const explicit = evaluateExtensionCheck(state, usage, { url: "https://www.pornhub.com/", event: "navigation" }, now);
  assert.equal(explicit.blocked, true);
  assert.equal(explicit.policy.kind, "baseline");
  const baselineYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(baselineYoutube.blocked, false);

  const softProfile = profileById(state, SOFT_BLOCK_PROFILE_ID);
  const migratedSoftProfile = sanitizeSoftBlockProfile({
    ...softProfile,
    blockedApps: ["Instagram", "Discord"],
    blockedSites: ["instagram.com", "pornhub.com"],
    blockedUrlPatterns: ["instagram.com/explore", "instagram.com/reels"]
  });
  assert.deepEqual(migratedSoftProfile.blockedApps, ["Discord"]);
  assert.deepEqual(migratedSoftProfile.blockedSites, ["pornhub.com"]);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/explore"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/reel"), true);
  assert.equal(migratedSoftProfile.phoneAppBlocking, false);

  state.activeSessions.phone = {
    id: "phone-soft",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: softProfile
  };
  assert.equal(activePolicy(state, now), null);
  assert.equal(activePolicy(state, now, { device: "phone" }).profile.id, SOFT_BLOCK_PROFILE_ID);

  const computerSoft = {
    ...state.activeSessions.phone,
    id: "computer-soft",
    title: "Computer Soft Block",
    deviceTargets: ["computer"]
  };
  state.activeSessions.computer = computerSoft;
  state.activeSession = computerSoft;
  const shorts = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/shorts/abc", event: "navigation" }, now);
  assert.equal(shorts.blocked, true);
  const watch = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(watch.blocked, false);
  const instagramHome = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/", event: "navigation" }, now);
  assert.equal(instagramHome.blocked, false);
  const instagramDm = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/direct/inbox/", event: "navigation" }, now);
  assert.equal(instagramDm.blocked, false);
  const instagramStory = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/stories/example/12345/", event: "navigation" }, now);
  assert.equal(instagramStory.blocked, false);
  const instagramReel = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/reel/abc123/", event: "navigation" }, now);
  assert.equal(instagramReel.blocked, true);
  assert.equal(instagramReel.reason, "content-filter");
  assert.equal(instagramReel.contentFilter.id, "instagram-reels");
  const instagramReelsTab = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/reels/", event: "navigation" }, now);
  assert.equal(instagramReelsTab.blocked, true);
  const instagramExplore = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/explore/", event: "navigation" }, now);
  assert.equal(instagramExplore.blocked, false);
  const hosts = buildHostsBlock(state, now);
  assert.match(hosts, /0\.0\.0\.0 pornhub\.com/);
  assert.doesNotMatch(hosts, /0\.0\.0\.0 youtube\.com/);

  const bothDevices = {
    ...computerSoft,
    id: "both-devices",
    title: "Both devices",
    deviceTargets: ["computer", "phone"]
  };
  state.activeSessions.computer = bothDevices;
  state.activeSessions.phone = bothDevices;
  state.activeSession = bothDevices;
  assert.equal(activePolicy(state, now).session.id, "both-devices");
  assert.equal(activePolicy(state, now, { device: "phone" }).session.id, "both-devices");
  assert.deepEqual(clearSessionsById(state, "both-devices"), ["computer", "phone"]);
  assert.equal(state.activeSession, null);
  assert.equal(activePolicy(state, now), null);
  assert.equal(activePolicy(state, now, { device: "phone" }), null);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  const brick = profileById(state, BRICK_MODE_PROFILE_ID);
  assert.equal(brick.name, "Mac Brick");
  assert.equal(brick.mode, "allowlist");
  assert.equal(shouldBlockSite(brick, "docs.google.com"), false);
  assert.equal(shouldBlockSite(brick, "youtube.com"), true);
  state.activeSession = {
    id: "brick",
    title: "Brick Mode",
    mode: "brick",
    profileId: BRICK_MODE_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 90 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "manual"
  };
  const policy = activePolicy(state, now);
  assert.equal(policy.session.mode, "brick");
  assert.equal(shouldBlockAppForPolicy(state, policy, "Mail"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Discord"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
  assert.equal(emergencyUnlockAllowedForPolicy(policy), false);
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://extensions/")?.area, "extensions");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "edge://settings/privacy")?.area, "settings");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "brave://flags")?.area, "flags");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://newtab/"), null);
  assert.equal(matchStrictBrowserControlUrl(state, policy, "https://example.com"), null);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://extensions/"), null);
  state.settings.strictBypassProtectionEnabled = true;
  const snapshot = extensionRuleSnapshot(state, now);
  assert.equal(snapshot.fallbackRequired, false);
  assert.equal(snapshot.allowlistRules.length, 1);
  assert.equal(snapshot.dynamicRuleCount, extensionDynamicRuleCount(snapshot));
  assert.equal(snapshot.dynamicRuleCount, snapshot.rules.length + snapshot.contentRules.length + snapshot.allowlistRules.length);
  assert.equal(typeof snapshot.dynamicRuleSignature, "string");
  assert.equal(snapshot.dynamicRuleSignature.includes("allowlist"), true);
  assert.equal(snapshot.allowlistRules[0].kind, "allowlist");
  assert.equal(snapshot.allowlistRules[0].excludedDomains.includes("docs.google.com"), true);
  assert.equal(snapshot.allowlistRules[0].excludedDomains.includes("youtube.com"), false);
  assert.equal(new URL(snapshot.allowlistRules[0].redirectUrl).searchParams.get("kind"), "allowlist");
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  state.activeSession = {
    id: "snap",
    title: "Snapshot focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      blockedApps: [],
      blockedSites: ["reddit.com"],
      allowedSites: []
    }
  };
  state.profiles[0].blockedSites = [];
  const policy = activePolicy(state, now);
  assert.equal(shouldBlockSite(policy.profile, "reddit.com"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Activity Monitor Helper"), true);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "cycle",
    title: "Cycle focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    cycle: { enabled: true, workMinutes: 25, breakMinutes: 5, rounds: 2 }
  };
  assert.equal(sessionPhase(state.activeSession, now).kind, "work");
  assert.equal(activePolicy(state, now).phase.round, 1);

  const breakTime = new Date(now.getTime() + 26 * 60 * 1000);
  assert.equal(sessionPhase(state.activeSession, breakTime).kind, "break");
  assert.equal(activePolicy(state, breakTime), null);

  const secondWork = new Date(now.getTime() + 31 * 60 * 1000);
  assert.equal(activePolicy(state, secondWork).phase.round, 2);

  activePolicy(state, new Date(now.getTime() + 56 * 60 * 1000));
  assert.equal(state.activeSession, null);
}

{
  const state = defaultState();
  assert.equal(state.settings.panicLockDurationMinutes, 3);
  state.activeSession = {
    id: "underlying-focus",
    title: "Underlying focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  state.panicLock = {
    id: "panic-now",
    title: "Panic Lockout",
    mode: "panic",
    profileId: PANIC_LOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 3 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "panic",
    fullLockout: true,
    profileSnapshot: panicLockProfile()
  };
  const policy = activePolicy(state, now);
  assert.equal(policy.kind, "panic");
  assert.equal(isFullLockoutPolicy(policy), true);
  assert.equal(policy.profile.id, PANIC_LOCK_PROFILE_ID);
  assert.equal(policy.profile.mode, "allowlist");
  assert.equal(emergencyUnlockAllowedForPolicy(policy), false);
  assert.equal(shouldBlockSite(policy.profile, "reddit.com"), true);
  assert.equal(shouldBlockSite(policy.profile, "localhost"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Firefox"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Codex"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Vigil"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "loginwindow"), false);
  assert.equal(shouldLockScreenForPolicy(state, policy), true);
  const resumed = activePolicy(state, new Date(now.getTime() + 4 * 60 * 1000));
  assert.equal(state.panicLock, null);
  assert.equal(resumed.kind, "manual");
  assert.equal(resumed.session.id, "underlying-focus");
}

{
  const state = defaultState();
  state.activeSession = {
    id: "sleep-lock",
    title: "Sleep lock",
    mode: "sleep",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const policy = activePolicy(state, now);
  assert.equal(shouldLockScreenForPolicy(state, policy), false);
  state.settings.systemSleepLockEnabled = true;
  assert.equal(shouldLockScreenForPolicy(state, policy), true);
  state.activeSession.mode = "focus";
  assert.equal(shouldLockScreenForPolicy(state, activePolicy(state, now)), false);
  state.activeSession.mode = "sleep";
  state.activeSession.lockLevel = "light";
  assert.equal(shouldLockScreenForPolicy(state, activePolicy(state, now)), false);
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "social-time",
    name: "Social Time",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["youtube.com", "reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 5,
    blockMinutes: 30
  }];
  const usage = {
    "2026-05-28": {
      totalSeconds: 90,
      apps: {},
      sites: { "youtube.com": 61 },
      opens: { apps: {}, sites: {} }
    }
  };
  const policy = activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now);
  assert.equal(policy.kind, "limit");
  assert.equal(policy.profile.blockedSites.includes("reddit.com"), true);
  assert.equal(policy.profile.blockedSites.includes("youtu.be"), true);
  assert.equal(shouldBlockSite(policy.profile, "youtu.be"), true);

  const phoneUsage = {};
  syncDeviceUsageSnapshot(phoneUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 61,
    sites: { "youtube.com": 61 }
  }, now);
  assert.equal(activeLimitPolicy(state, phoneUsage, { app: "Safari", hostname: "reddit.com" }, now).kind, "limit");
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "social-open",
    name: "Social Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 30,
    unlocksAllowed: 2,
    blockMinutes: 0
  }];
  const usage = {
    "2026-05-28": {
      totalSeconds: 0,
      apps: {},
      sites: {},
      opens: { apps: {}, sites: { "reddit.com": 3 } }
    }
  };
  const policy = activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now);
  assert.equal(policy.kind, "limit");
  assert.equal(policy.session.mode, "open-limit");
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "steam-time",
    name: "Steam Time",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: ["Steam"],
    sites: [],
    limitMinutes: 1,
    unlocksAllowed: 5,
    blockMinutes: 30
  }];
  const usage = {
    "2026-05-28": {
      totalSeconds: 90,
      apps: { "Steam Helper": 61 },
      sites: {},
      opens: { apps: {}, sites: {} }
    }
  };
  const policy = activeLimitPolicy(state, usage, { app: "steamwebhelper", hostname: "" }, now);
  assert.equal(policy.kind, "limit");
  assert.equal(policy.profile.blockedApps.includes("steam helper"), true);
}

{
  const state = defaultState();
  state.appLocks = [{
    id: "lock-social",
    name: "Locked Social",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const locked = activeAppLockPolicy(state, { app: "Safari", hostname: "redd.it" }, now);
  assert.equal(locked.kind, "app-lock");
  state.appLocks[0].apps = ["Discord"];
  const appLocked = activeAppLockPolicy(state, { app: "Discord Helper", hostname: "" }, now);
  assert.equal(appLocked.kind, "app-lock");

  const request = requestAppLockUnlock(state, "lock-social", "I need a short intentional unlock for this task.", now);
  assert.throws(() => confirmAppLockUnlock(state, request.id, { challengeText: "wrong" }, now), /challenge/);
  const unlock = confirmAppLockUnlock(state, request.id, { challengeText: request.challenge.text }, now);
  assert.equal(unlock.lockId, "lock-social");
  const unlocked = activeAppLockPolicy(state, { app: "Safari", hostname: "reddit.com" }, now);
  assert.equal(unlocked, null);
  assert.throws(() => requestAppLockUnlock(state, "lock-social", "I need another short intentional unlock.", now), /No unlocks remain/);
}

{
  const state = defaultState();
  const usage = {};
  state.appLocks = [{
    id: "lock-social",
    name: "Locked Social",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const result = evaluateExtensionCheck(state, usage, { url: "https://redd.it/abc123", event: "navigation" }, now);
  const redirect = new URL(result.redirectUrl);
  assert.equal(result.reason, "app-lock");
  assert.equal(result.policy.lockId, "lock-social");
  assert.equal(result.browserNoiseBlockingEnabled, true);
  assert.equal(redirect.searchParams.get("kind"), "app-lock");
  assert.equal(redirect.searchParams.get("lockId"), "lock-social");
  assert.equal(redirect.searchParams.get("return"), "https://redd.it/abc123");
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-filter",
    title: "Content filter session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "allowlist",
      blockedSites: [],
      allowedSites: ["youtube.com", "instagram.com", "reddit.com"]
    }
  };
  const usage = {};
  const shorts = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/shorts/abc", event: "navigation" }, now);
  assert.equal(shorts.blocked, true);
  assert.equal(shorts.reason, "content-filter");
  assert.equal(shorts.contentFilter.id, "youtube-shorts");
  assert.equal(new URL(shorts.redirectUrl).searchParams.get("site"), "YouTube Shorts");
  const watch = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(watch.blocked, false);
  assert.equal(matchContentFilterUrl(state, "https://www.instagram.com/reels/xyz").id, "instagram-reels");
  assert.equal(matchContentFilterUrl(state, "https://www.instagram.com/reel/xyz").id, "instagram-reels");
  assert.equal(matchContentFilterUrl(state, "https://www.instagram.com/explore/"), null);
  state.settings.contentFilterEnabled = false;
  assert.equal(matchContentFilterUrl(state, "https://www.youtube.com/shorts/abc"), null);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "url-pattern",
    title: "URL pattern session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "blocklist",
      blockedSites: [],
      blockedUrlPatterns: ["example.com/games", "casino"],
      allowedSites: []
    }
  };
  const usage = {};
  const game = evaluateExtensionCheck(state, usage, { url: "https://www.example.com/games/play", event: "navigation" }, now);
  assert.equal(game.blocked, true);
  assert.equal(game.reason, "url-pattern");
  assert.equal(game.urlPattern.pattern, "example.com/games");
  assert.equal(new URL(game.redirectUrl).searchParams.get("site"), "URL pattern: example.com/games");
  const keyword = evaluateExtensionCheck(state, usage, { url: "https://search.example/?q=casino", event: "navigation" }, now);
  assert.equal(keyword.blocked, true);
  assert.equal(keyword.urlPattern.pattern, "casino");
  const normal = evaluateExtensionCheck(state, usage, { url: "https://www.example.com/news", event: "navigation" }, now);
  assert.equal(normal.blocked, false);
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.kind === "url-pattern" && rule.urlFilter === "||example.com/games"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  assert.throws(() => assertProtectedEditAllowed(state, { kind: "settings" }, now), /Protected edits/);
  const request = requestMaintenanceWindow(state, "I need to adjust a protected configuration setting.", now);
  assert.equal(Boolean(request.pending.challenge?.text), true);
  const window = confirmMaintenanceWindow(state, request.pending.id, { challengeText: request.pending.challenge.text }, new Date(now.getTime() + state.settings.protectedEditDelaySeconds * 1000));
  assert.equal(window.requestId, request.pending.id);
  assert.doesNotThrow(() => assertProtectedEditAllowed(state, { kind: "settings" }, new Date(now.getTime() + state.settings.protectedEditDelaySeconds * 1000)));
}

{
  const state = defaultState();
  state.settings.baselineDailyMinutes = 120;
  const usage = {
    "2026-05-25": {
      totalSeconds: 3600,
      apps: { Codex: 3000 },
      sites: { "reddit.com": 600 },
      opens: { apps: {}, sites: { "reddit.com": 2 } }
    },
    "2026-05-26": {
      totalSeconds: 5400,
      apps: { Codex: 5400 },
      sites: {},
      opens: { apps: {}, sites: {} }
    },
    "2026-05-20": {
      totalSeconds: 3600,
      apps: { Codex: 2400 },
      sites: { "reddit.com": 1200 },
      opens: { apps: {}, sites: { "reddit.com": 3 } }
    }
  };
  const report = focusReport(usage, state, new Date("2026-05-28T14:00:00-04:00"));
  assert.equal(report.currentWeek.totals.trackedDays, 2);
  assert.equal(report.topCulprits[0].name, "reddit.com");
  assert.equal(report.comparison.distractingPercentDelta, -50);
  assert.equal(report.milestones.some((item) => item.id === "clean-tracked-day" && item.achieved), true);
}

{
  const state = defaultState();
  state.profiles = [{
    id: "default",
    name: "Default focus",
    mode: "blocklist",
    blockedApps: ["Instagram"],
    blockedSites: ["reddit.com"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  }];
  state.settings.activeProfileId = "default";
  const usage = {
    "2026-05-28": {
      totalSeconds: 600,
      apps: { Codex: 600 },
      sites: {},
      opens: { apps: { Codex: 1 }, sites: {} }
    }
  };

  recordUsage(usage, { app: "Safari", hostname: "github.com" }, 120, now);
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 900,
    apps: { Instagram: 600 },
    sites: { "reddit.com": 300 },
    opens: { apps: { Instagram: 2 }, sites: { "reddit.com": 1 } }
  }, now);

  let summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 1620);
  assert.equal(summary.distractingSeconds, 900);
  assert.equal(summary.devices.computer.totalSeconds, 720);
  assert.equal(summary.devices.phone.totalSeconds, 900);
  assert.equal(summary.openPressure, 4);

  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 1200,
    apps: { Instagram: 600, Messages: 400 },
    sites: { "reddit.com": 200 },
    opens: { apps: { Instagram: 3 }, sites: { "reddit.com": 2 } }
  }, now);
  summary = usageSummary(usage, state, now);
  assert.equal(summary.totalSeconds, 1920);
  assert.equal(summary.distractingSeconds, 800);
  assert.equal(summary.devices.computer.totalSeconds, 720);
  assert.equal(summary.devices.phone.totalSeconds, 1200);

  assert.throws(() => syncDeviceUsageSnapshot(usage, {
    device: "iphone",
    date: "2026-05-28",
    totalSeconds: 100,
    apps: { Instagram: 100 }
  }, now), /Unsupported usage device/);
  assert.equal(usageSummary(usage, state, now).devices.computer.totalSeconds, 720);
  assert.throws(() => syncDeviceUsageSnapshot(usage, {
    device: "computer",
    date: "2026-05-28",
    totalSeconds: 100,
    apps: { Codex: 100 }
  }, now, { allowedDevices: ["phone"] }), (error) => error.status === 403 && /not allowed/.test(error.message));

  const report = focusReport(usage, state, now);
  assert.equal(report.currentWeek.totals.totalSeconds, 1920);
  assert.equal(report.currentWeek.totals.distractingSeconds, 800);
  assert.equal(report.topCulprits.some((item) => item.name === "Instagram" && item.seconds === 600), true);
}

{
  const state = defaultState();
  const emptySummary = usageSummary({}, state, now);
  assert.equal(emptySummary.protectedSeconds, 0);
  assert.equal(emptySummary.blockCount, 0);
  assert.equal(emptySummary.savedSeconds, 0);

  const scheduledState = defaultState();
  const scheduledStart = new Date(now.getTime() - 30 * 60 * 1000);
  const scheduledEnd = new Date(now.getTime() + 60 * 60 * 1000);
  scheduledState.schedules = [{
    id: "scheduled-dashboard-lock",
    name: "Scheduled dashboard lock",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    days: TEST_DAYS,
    start: clockTime(scheduledStart),
    end: clockTime(scheduledEnd),
    wifiNetworks: [],
    deviceTargets: ["computer"]
  }];
  const scheduledSummary = usageSummary({}, scheduledState, now);
  assert.equal(scheduledSummary.protectedSeconds, 30 * 60);

  const startedAt = new Date(now.getTime() - 45 * 60 * 1000).toISOString();
  const endedAt = new Date(now.getTime() - 15 * 60 * 1000).toISOString();
  const session = {
    id: "dashboard-session",
    title: "Dashboard session",
    mode: "focus",
    profileId: "default",
    lockLevel: "light",
    startedAt,
    endsAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual"
  };
  state.events = [
    { id: "block-url", type: "blocked_url", at: now.toISOString(), detail: { site: "instagram.com" } },
    { id: "old-block", type: "blocked_app", at: new Date(now.getTime() - 26 * 60 * 60 * 1000).toISOString(), detail: { app: "Discord" } },
    { id: "session-ended", type: "session_ended", at: endedAt, detail: session },
    { id: "block-site", type: "blocked_site", at: new Date(now.getTime() - 5 * 60 * 1000).toISOString(), detail: { site: "reddit.com" } },
    { id: "session-started", type: "session_started", at: startedAt, detail: session }
  ];
  const summary = usageSummary({}, state, now);
  assert.equal(summary.protectedSeconds, 30 * 60);
  assert.equal(summary.blockCount, 2);
  assert.equal(summary.savedSeconds, 0);
}

{
  const state = defaultState();
  const disabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(disabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(disabledProfile, /allowAppInstallation/);
  assert.doesNotMatch(disabledProfile, /PayloadRemovalDisallowed<\/key>\s*<true/);

  state.deviceControls.ios.enabled = true;
  const enabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(enabledProfile, /blockedAppBundleIDs/);
  assert.match(enabledProfile, /pornhub\.com/);
  assert.match(enabledProfile, /allowAppInstallation/);

  state.activeSessions.phone = {
    id: "phone-strict",
    title: "Phone strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"]
  };
  const activePhoneProfile = buildIosConfigurationProfile(state, now);
  assert.match(activePhoneProfile, /blockedAppBundleIDs/);
  assert.match(activePhoneProfile, /com\.google\.ios\.youtube/);

  state.activeSessions.phone = {
    id: "phone-soft-ios",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  const softPhoneProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(softPhoneProfile, /blockedAppBundleIDs/);
  assert.match(softPhoneProfile, /com\.apple\.webClip\.managed/);
  assert.match(softPhoneProfile, /Vigil Instagram/);
  assert.match(softPhoneProfile, /instagram\.com\/direct\/inbox/);
  assert.match(softPhoneProfile, /instagram\.com\/reel/);
  assert.doesNotMatch(softPhoneProfile, /instagram\.com\/explore/);
}

{
  const roundTrip = parsePlist(toPlist({
    MessageType: "TokenUpdate",
    Count: 2,
    Enabled: true,
    Token: plistData(Buffer.from("hello"))
  }));
  assert.equal(roundTrip.MessageType, "TokenUpdate");
  assert.equal(roundTrip.Count, 2);
  assert.equal(roundTrip.Enabled, true);
  assert.equal(roundTrip.Token.__plistData, Buffer.from("hello").toString("base64"));

  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.mdm = {
    ...state.deviceControls.ios.mdm,
    enabled: true,
    publicBaseUrl: "https://mdm.example.test",
    topic: "com.apple.mgmt.Example",
    identityCertificateUuid: "11111111-2222-3333-4444-555555555555",
    identityCertificatePayloadBase64: Buffer.from("identity").toString("base64")
  };
  const summary = iosMdmSummary(state, now);
  assert.equal(summary.enrollmentReady, true);
  assert.equal(summary.ready, false);
  assert.equal(summary.status, "queue-only");
  assert.match(summary.enrollmentUrl, /^https:\/\/mdm\.example\.test\/mdm\/enroll\.mobileconfig\?token=/);

  state.deviceControls.ios.mdm.pushCertificatePayloadBase64 = Buffer.from("push-cert").toString("base64");
  const pushReadySummary = iosMdmSummary(state, now);
  assert.equal(pushReadySummary.ready, true);
  assert.equal(pushReadySummary.pushSupported, true);

  const enrollment = buildIosMdmEnrollmentProfile(state, now);
  const profileToken = enrollment.match(/token=([^<]+)/)?.[1] || "";
  assert.equal(authorizeIosMdmRequest(state, new URL(`https://mdm.example.test/mdm/checkin?token=${profileToken}`)), true);
  assert.match(enrollment, /com\.apple\.mdm/);
  assert.match(enrollment, /https:\/\/mdm\.example\.test\/mdm\/connect/);
  assert.match(enrollment, /com\.apple\.mgmt\.Example/);

  const checkIn = handleIosMdmCheckIn(state, {
    MessageType: "TokenUpdate",
    UDID: "iphone-udid-1",
    Topic: "com.apple.mgmt.Example",
    PushMagic: "push-magic",
    Token: plistData(Buffer.from("push-token"))
  }, now);
  assert.equal(checkIn.messageType, "TokenUpdate");
  assert.equal(state.deviceControls.ios.mdm.devices.length, 1);
  assert.equal(state.deviceControls.ios.mdm.commands.some((command) => command.requestType === "InstallProfile"), true);
  assert.equal(state.deviceControls.ios.mdm.devices[0].tokenHex, Buffer.from("push-token").toString("hex"));
  const pushRequest = buildIosMdmPushRequest(state.deviceControls.ios.mdm, state.deviceControls.ios.mdm.devices[0]);
  assert.equal(pushRequest.endpoint, "https://api.push.apple.com");
  assert.equal(pushRequest.path, `/3/device/${Buffer.from("push-token").toString("hex")}`);
  assert.equal(pushRequest.headers["apns-topic"], "com.apple.mgmt.Example");
  assert.equal(pushRequest.headers["apns-push-type"], "mdm");
  assert.equal(pushRequest.payload, JSON.stringify({ mdm: "push-magic" }));

  const command = handleIosMdmConnect(state, { UDID: "iphone-udid-1", Status: "Idle" }, now);
  assert.equal(command.empty, false);
  assert.equal(command.body.Command.RequestType, "InstallProfile");
  const acknowledged = handleIosMdmConnect(state, {
    UDID: "iphone-udid-1",
    Status: "Acknowledged",
    CommandUUID: command.command.commandUuid
  }, now);
  assert.equal(state.deviceControls.ios.mdm.commands.find((item) => item.commandUuid === command.command.commandUuid).status, "acknowledged");
  assert.equal(acknowledged.empty, false);

  const duplicate = queueIosMdmPolicyRefresh(state, "test-refresh", now, { udids: ["iphone-udid-1"] });
  assert.equal(duplicate.queued >= 0, true);

  state.deviceControls.ios.enabled = false;
  const removePolicy = queueIosMdmPolicyRefresh(state, "disable-ios", now, { udids: ["iphone-udid-1"] });
  assert.equal(removePolicy.queued, 1);
  const removeCommand = handleIosMdmConnect(state, { UDID: "iphone-udid-1", Status: "Idle" }, now);
  assert.equal(removeCommand.body.Command.RequestType, "RemoveProfile");
  assert.equal(removeCommand.body.Command.Identifier, "tech.caseline.vigil.ios-lock");
}

{
  const state = defaultState();
  const usage = {};
  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const blocked = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/all", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  assert.match(blocked.redirectUrl, /\/blocked/);

  const allowed = evaluateExtensionCheck(state, usage, { url: "https://docs.google.com/document/u/0/", event: "navigation" }, now);
  assert.equal(allowed.blocked, false);

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.redirectUrl.includes("/blocked")), true);
  assert.equal(rules.rules.some((rule) => rule.domain === "youtu.be"), true);
}

{
  const state = defaultState();
  const usage = {};
  state.limitRules = [{
    id: "open-extension",
    name: "Extension Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 30,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const result = evaluateExtensionCheck(state, usage, { url: "https://reddit.com/", event: "navigation" }, now);
  assert.equal(result.blocked, true);
  assert.equal(state.limitBlocks.length, 1);
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.reason === "limit"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-rules",
    title: "Content rules",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/shorts"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/explore"), false);
  assert.equal(contentFilterRuleEntries(state, activePolicy(state, now)).some((rule) => rule.id === "reddit-popular"), true);
  state.settings.contentFilterEnabled = false;
  const disabledContentRules = extensionRuleSnapshot(state, now).contentRules;
  assert.equal(disabledContentRules.some((rule) => rule.id === "reddit-popular"), false);
  assert.equal(disabledContentRules.some((rule) => rule.kind === "url-pattern"), true);
}

{
  const state = defaultState();
  state.activeSession = null;
  state.appLocks = [{
    id: "extension-lock",
    name: "Extension Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const rules = extensionRuleSnapshot(state, now);
  const reddit = rules.rules.find((rule) => rule.domain === "reddit.com");
  assert.equal(reddit.reason, "app-lock");
  assert.equal(new URL(reddit.redirectUrl).searchParams.get("lockId"), "extension-lock");
}

{
  const serverSource = await readFile("src/server.js", "utf8");
  assert.match(serverSource, /scheduleImmediateSessionEnforcement/);
  assert.match(serverSource, /session_immediate_enforcement/);
  const monitorSource = await readFile("src/monitor.js", "utf8");
  assert.match(monitorSource, /enforceImmediately/);
  assert.match(monitorSource, /lastImmediateEnforcement/);
  assert.match(monitorSource, /enforceSystemSleepLock/);
  assert.match(monitorSource, /lastSystemSleepLock/);
  assert.match(monitorSource, /sweepBlockedProcesses\(now, \{ force: true \}\)/);
  const challengeSource = await readFile("src/challenge.js", "utf8");
  assert.match(challengeSource, /TypingChallengeError/);
  assert.match(challengeSource, /generateChallengeText/);
  const macosSource = await readFile("src/macos.js", "utf8");
  assert.match(macosSource, /CGSession/);
  assert.match(macosSource, /displaysleepnow/);
}

{
  const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
  assert.equal(manifest.permissions.includes("declarativeNetRequest"), true);
  const background = await readFile("extension/background.js", "utf8");
  assert.match(background, /NOISE_BLOCK_DOMAINS/);
  assert.match(background, /SITE_BLOCK_RULE_START/);
  assert.match(background, /CONTENT_BLOCK_RULE_START/);
  assert.match(background, /contentBlockRules/);
  assert.match(background, /syncSiteBlockingFromServer/);
  assert.match(background, /updateDynamicRules/);
  assert.match(background, /DEFAULT_LOCAL_SERVER/);
  const options = await readFile("extension/options.js", "utf8");
  assert.match(options, /vigilExtensionToken/);
  const content = await readFile("extension/content.js", "utf8");
  assert.match(content, /cleanupBrowserNoise/);
  const installer = await readFile("scripts/install-launch-agent.mjs", "utf8");
  assert.match(installer, /agent-runner\.mjs/);
}

console.log("Self-test passed");
