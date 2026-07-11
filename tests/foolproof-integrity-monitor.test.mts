import assert from "node:assert/strict";
import { accountStatusFromGroups } from "../src/account.js";
import { activeAppLockPolicy } from "../src/appLocks.js";
import { BRICK_MODE_PROFILE_ID, defaultState, REQUIRED_EXTENSION_VERSION, SOFT_BLOCK_PROFILE_ID } from "../src/defaults.js";
import { assertDistanceKey, updateDistanceKeySettings } from "../src/distanceKey.js";
import { doctorRows, formatDoctorRows } from "../src/doctorReport.js";
import { extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { assertFoolproofReadyForStrict, extensionDynamicRulesReady, extensionVersionReady, foolproofBlockers } from "../src/foolproof.js";
import { clearIntegrityTamper, clearTrustedSourceSealDrift, detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, integrityLockdownPolicy, integrityRuntimeSummary, recordRuntimeHeartbeat, syncAppleContentFilterLockdown } from "../src/integrityLockdown.js";
import { emergencyDelaySeconds, interventionSummary, recentBlockAttempts } from "../src/intervention.js";
import { updateKeyholderSettings } from "../src/keyholder.js";
import { activeLimitPolicy } from "../src/limits.js";
import { parseProcessList } from "../src/macos.js";
import { appQuitEscalationDecision, shouldQuitAppForPolicy, shouldRedirectActiveBlockedBrowserTab, sweepBlockedApps } from "../src/monitor.js";
import { activePolicy, profileById, shouldBlockAppForPolicy, shouldBlockSite } from "../src/policy.js";
import { protectedEditBlockers } from "../src/protection.js";
import { applySealVerificationToState, markStateSealed, stateSealSummary } from "../src/seal.js";
import { browserCompanionRequirement, networkBlockCurrent } from "../src/systemNetworkBlock.js";
import { must, mustPolicy, now, recordValue, TEST_DAYS } from "./test-helpers.mjs";

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
  assert.equal(foolproofBlockers(state, { hosts: {}, agent: {}, monitor: { ok: false } }, now).some((item) => item.id === "browser-noise"), false);
  state.settings.browserNoiseBlockingEnabled = true;
  state.settings.contentFilterEnabled = false;
  assert.equal(browserCompanionRequirement(state, now).required, true);
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
    safariFilter: { required: true, installed: true, current: true, stale: false, appleContentFilter: { current: true, detail: "Apple Screen Time Limit Adult Websites is on." } },
    agent: { loaded: true, running: true },
    account: accountStatusFromGroups("focus", "staff everyone"),
    monitor: { ok: true, accessibilityLikelyMissing: false },
    stateSeal: { ok: true, status: "sealed", detail: "State file matches its integrity seal." },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", fileCount: 42 }
  };
  assert.deepEqual(foolproofBlockers(state, readyContext, now), []);
  assert.deepEqual(foolproofBlockers(state, {
    ...readyContext,
    safariFilter: {
      required: true,
      installed: false,
      current: false,
      stale: false,
      appleContentFilter: { current: true, detail: "Apple Screen Time Limit Adult Websites is on." }
    }
  }, now), []);
  assert.equal(foolproofBlockers(state, {
    ...readyContext,
    safariFilter: {
      required: true,
      installed: false,
      current: false,
      stale: false,
      appleContentFilter: { current: false, detail: "Apple Screen Time Limit Adult Websites is off." }
    }
  }, now).some((item) => item.id === "apple-content-filter"), true);
  assert.doesNotThrow(() => assertFoolproofReadyForStrict(state, readyContext, now));
  assert.equal(networkBlockCurrent(readyContext.hosts, readyContext.firewall), true);
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
  state.settings.siteRedirectEnabled = false;
  state.settings.browserNoiseBlockingEnabled = false;
  state.settings.contentFilterEnabled = false;
  state.extension.lastSeenAt = "";
  state.extension.lastVersion = "";
  state.extension.dynamicRules = {};
  updateKeyholderSettings(state, { enabled: true, passcode: "anchor-passcode" }, now);
  updateDistanceKeySettings(state, { enabled: true, rotate: true }, now);
  const readyContext = {
    hosts: { installed: true, partial: false, stale: false },
    firewall: { installed: true, partial: false, stale: false, installedEntries: 8 },
    safariFilter: { required: true, installed: true, current: true, stale: false, appleContentFilter: { current: true, detail: "Apple Screen Time Limit Adult Websites is on." } },
    agent: { loaded: true, running: true },
    account: accountStatusFromGroups("focus", "staff everyone"),
    monitor: { ok: true, accessibilityLikelyMissing: false },
    stateSeal: { ok: true, status: "sealed", detail: "State file matches its integrity seal." },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", fileCount: 42 }
  };
  assert.equal(browserCompanionRequirement(state, now).required, true);
  const blockers = foolproofBlockers(state, readyContext, now);
  assert.equal(blockers.some((item) => item.id === "browser-redirect"), false);
  assert.equal(blockers.some((item) => item.id === "browser-extension"), true);
  assert.equal(blockers.some((item) => item.id === "extension-rules"), true);

  const patternState = defaultState();
  patternState.settings.browserNoiseBlockingEnabled = false;
  patternState.settings.contentFilterEnabled = false;
  patternState.profiles.unshift({
    id: "pattern-only",
    name: "Pattern only",
    mode: "blocklist",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: ["casino", "/reels"],
    allowedApps: [],
    allowedSites: []
  });
  patternState.settings.baselineProfileId = "pattern-only";
  assert.equal(browserCompanionRequirement(patternState, now).required, true);
  assert.equal(shouldRedirectActiveBlockedBrowserTab({
    redirectEnabled: false,
    networkBlocked: true,
    app: "Safari",
    url: "https://reddit.com"
  }), true);
  assert.equal(shouldRedirectActiveBlockedBrowserTab({
    redirectEnabled: false,
    networkBlocked: true,
    app: "Discord",
    url: ""
  }), false);
  assert.equal(shouldRedirectActiveBlockedBrowserTab({
    redirectEnabled: true,
    networkBlocked: false,
    app: "Discord",
    url: ""
  }), true);

  state.settings.systemNetworkBlockingEnabled = false;
  assert.equal(foolproofBlockers(state, readyContext, now).some((item) => item.id === "system-network-block"), true);
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
    safariFilter: { required: true, installed: true, current: true, stale: false, appleContentFilter: { current: true, detail: "Apple Screen Time Limit Adult Websites is on." } },
    agent: { installed: true, loaded: true, running: true, pid: 12345 },
    account: accountStatusFromGroups("focus", "staff everyone")
  }, now);
  const byId = new Map(rows.map((item) => [item.id, item]));
  assert.equal(must(byId.get("external-network-block"), "external-network-block row").ok, true);
  assert.equal(must(byId.get("foolproof"), "foolproof row").ok, true);
  assert.equal(must(byId.get("mac-account"), "mac-account row").ok, true);
  assert.equal(must(byId.get("extension-version"), "extension-version row").ok, true);
  assert.equal(must(byId.get("extension-rules"), "extension-rules row").ok, true);
  assert.equal(must(byId.get("intent-reason"), "intent-reason row").ok, true);
  assert.equal(must(byId.get("keyholder"), "keyholder row").ok, true);
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
  assert.equal(must(staleRows.find((item) => item.id === "extension-rules"), "stale extension-rules row").ok, false);
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
  const lockdownPolicy = mustPolicy(integrityLockdownPolicy(state, now));
  const currentPolicy = mustPolicy(activePolicy(state, now));
  assert.equal(lockdownPolicy.kind, "integrity");
  assert.equal(currentPolicy.kind, "integrity");
  assert.equal(shouldBlockSite(currentPolicy.profile, "youtube.com"), true);
  assert.equal(shouldBlockAppForPolicy(state, currentPolicy, "App Store"), true);
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
  const gap = must(detectRuntimeGap(state, new Date(now.getTime() + 3 * 60 * 1000)), "runtime gap");
  assert.equal(gap.overlap.kind, "manual");
  assert.equal(integrityRuntimeSummary(state).ok, false);
  assert.equal(mustPolicy(activePolicy(state, now)).kind, "integrity");
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "future-heartbeat-strict",
    title: "Future heartbeat strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  recordRuntimeHeartbeat(state, new Date(now.getTime() + 10 * 60 * 1000));
  const gap = must(detectRuntimeGap(state, now), "future heartbeat tamper");
  assert.equal(gap.futureHeartbeat, true);
  assert.equal(gap.gapSeconds, 10 * 60);
  assert.match(gap.detail, /heartbeat was 600s in the future/);
  assert.equal(integrityRuntimeSummary(state).status, "downtime-detected");
}

{
  const state = defaultState();
  state.activeSessions.phone = {
    id: "phone-offline-strict",
    title: "Phone offline strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"]
  };
  recordRuntimeHeartbeat(state, now);
  const gap = must(detectRuntimeGap(state, new Date(now.getTime() + 3 * 60 * 1000)), "phone runtime gap");
  assert.equal(gap.overlap.kind, "manual");
  assert.equal(gap.overlap.id, "phone-offline-strict");
  assert.equal(recordValue(mustPolicy(integrityLockdownPolicy(state, now)).alarm, "phone runtime gap alarm").type, "runtime-downtime");
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
  const tamper = must(detectClockTamper(state, {
    previousWallMs: now.getTime(),
    currentWallMs: now.getTime() + 10 * 60 * 1000,
    previousMonotonicMs: 1000,
    currentMonotonicMs: 4000
  }, new Date(now.getTime() + 10 * 60 * 1000)), "clock tamper");
  assert.equal(tamper.direction, "forward");
  assert.equal(integrityRuntimeSummary(state).status, "clock-tamper");
  assert.equal(mustPolicy(activePolicy(state, now)).kind, "integrity");
  assert.equal(recordValue(mustPolicy(integrityLockdownPolicy(state, now)).alarm, "clock tamper alarm").type, "clock-tamper");
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
  state.activeSessions.phone = {
    id: "phone-clock-strict",
    title: "Phone clock strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"]
  };
  const tamper = must(detectClockTamper(state, {
    previousWallMs: now.getTime(),
    currentWallMs: now.getTime() + 10 * 60 * 1000,
    previousMonotonicMs: 1000,
    currentMonotonicMs: 4000
  }, new Date(now.getTime() + 10 * 60 * 1000)), "phone clock tamper");
  assert.equal(tamper.overlap.id, "phone-clock-strict");
  assert.equal(recordValue(mustPolicy(integrityLockdownPolicy(state, now)).alarm, "phone clock tamper alarm").type, "clock-tamper");
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);
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
  const drift = must(detectHardeningDrift(state, { hosts: badHosts, firewall: goodFirewall, extensionRules: goodRules, sourceSeal: goodSourceSeal }, now), "host drift");
  assert.equal(drift.issues[0].id, "hosts");
  assert.equal(integrityRuntimeSummary(state).status, "hardening-drift");
  assert.equal(recordValue(mustPolicy(integrityLockdownPolicy(state, now)).alarm, "hardening drift alarm").type, "hardening-drift");
  assert.equal(clearTrustedSourceSealDrift(state, now), false);
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);

  const staleRules = { ok: false, status: "stale", detail: "Browser companion dynamic block rules are stale.", count: 9 };
  const driftFirewall = must(detectHardeningDrift(state, { hosts: { installed: true, partial: false, stale: false }, firewall: { installed: false, partial: false, stale: false }, extensionRules: goodRules, sourceSeal: goodSourceSeal }, now), "firewall drift");
  assert.equal(driftFirewall.issues[0].id, "firewall");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftRules = must(detectHardeningDrift(state, { hosts: { installed: true, partial: false, stale: false }, firewall: goodFirewall, extensionRules: staleRules, sourceSeal: goodSourceSeal }, now), "extension rules drift");
  assert.equal(driftRules.issues[0].id, "extension-rules");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftSource = must(detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: { ok: false, status: "mismatch", detail: "Source files do not match the integrity seal." }
  }, now), "source drift");
  assert.equal(driftSource.issues[0].id, "source-seal");
  assert.equal(clearTrustedSourceSealDrift(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);
  assert.equal(clearTrustedSourceSealDrift(state, now), false);

  const driftAgent = must(detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: false, running: false }
  }, now), "agent drift");
  assert.equal(driftAgent.issues[0].id, "launch-agent");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftAccessibility = must(detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: true, running: true },
    monitor: { ok: false, accessibilityLikelyMissing: true }
  }, now), "accessibility drift");
  assert.equal(driftAccessibility.issues[0].id, "accessibility");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftAppleContentFilter = must(detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    safariFilter: { required: true, current: false, appleContentFilter: { current: false } },
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: true, running: true },
    monitor: { ok: true, accessibilityLikelyMissing: false }
  }, now), "Apple Screen Time content filter drift");
  assert.equal(driftAppleContentFilter.issues[0].id, "apple-content-filter");
  assert.equal(clearIntegrityTamper(state, now), true);

  const maskedAppleContentFilter = must(detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    firewall: goodFirewall,
    safariFilter: {
      required: true,
      current: true,
      effectiveCurrent: true,
      appleCurrent: false,
      appleContentFilter: { current: false }
    },
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: true, running: true },
    monitor: { ok: true, accessibilityLikelyMissing: false }
  }, now), "Apple Screen Time content filter drift masked by installed profile");
  assert.equal(maskedAppleContentFilter.issues[0].id, "apple-content-filter");

  const upgradedDrift = must(detectHardeningDrift(state, {
    hosts: badHosts,
    firewall: goodFirewall,
    safariFilter: { required: true, current: false, appleContentFilter: { current: false } },
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: true, running: true },
    monitor: { ok: true, accessibilityLikelyMissing: false }
  }, now), "combined hardening drift");
  assert.deepEqual(upgradedDrift.issues.map((issue) => issue.id), ["hosts", "apple-content-filter"]);
  const upgradedPolicy = mustPolicy(integrityLockdownPolicy(state, now));
  assert.equal(upgradedPolicy.session.title, "Integrity lockdown");
  assert.equal(upgradedPolicy.profile.mode, "blocklist");
  assert.equal(shouldBlockAppForPolicy(state, upgradedPolicy, "System Settings"), true);
}

{
  const state = defaultState();
  state.integrity.stateSeal.tamperDetectedAt = now.toISOString();
  state.integrity.stateSeal.tamperDetail = "State file does not match its integrity seal.";
  const policy = mustPolicy(activePolicy(state, now));
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
  state.settings.foolproofModeEnabled = false;
  const maskedByInstalledProfile = syncAppleContentFilterLockdown(state, {
    required: state.settings.foolproofModeEnabled,
    current: true,
    effectiveCurrent: true,
    appleCurrent: false,
    appleContentFilter: { current: false }
  }, now);
  assert.equal(maskedByInstalledProfile.started, false);
  assert.equal(integrityLockdownActive(state), false);
  assert.equal(activePolicy(state, now), null);
}

{
  const state = defaultState();
  state.settings.foolproofModeEnabled = true;
  const started = syncAppleContentFilterLockdown(state, {
    required: true,
    current: false,
    effectiveCurrent: false,
    appleContentFilter: { current: false }
  }, now);
  assert.equal(started.started, true);
  assert.equal(integrityLockdownActive(state), true);
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(policy.kind, "integrity");
  assert.equal(policy.session.title, "Apple content filter recovery");
  assert.equal(policy.endsAt, "until Apple Screen Time Limit Adult Websites and Content & Privacy Restrictions are turned back on");
  assert.equal(policy.profile.mode, "allowlist");
  assert.equal(shouldBlockAppForPolicy(state, policy, "System Settings"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Sentinel"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Safari"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), true);
  assert.equal(shouldBlockSite(policy.profile, "apple.com"), true);
  assert.equal(shouldQuitAppForPolicy(state, policy, "ChatGPT"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "Codex (Renderer)"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "LM Studio Helper (GPU)"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "SystemUIServer"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "Siri AI"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "WiFiAgent"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "IMTransferAgent"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "XProtect"), false);
  assert.equal(shouldQuitAppForPolicy(state, policy, "Instagram"), true);
  assert.equal(shouldQuitAppForPolicy(state, policy, "Discord Helper"), true);
  assert.deepEqual(
    sweepBlockedApps(state, {}, ["ChatGPT", "Codex (Renderer)", "LM Studio", "Dock", "ControlCenter", "NotificationCenter", "SystemUIServer", "Siri", "Siri AI", "WiFiAgent", "WindowManager", "UniversalControl", "AirPlayUIAgent", "IMTransferAgent", "identityservicesd", "XProtect", "Instagram", "Discord", "YouTube"], now).map((item) => item.app),
    ["Instagram", "Discord", "YouTube"]
  );

  const repeated = syncAppleContentFilterLockdown(state, {
    required: true,
    current: false,
    effectiveCurrent: false,
    appleContentFilter: { current: false }
  }, new Date(now.getTime() + 1000));
  assert.equal(repeated.started, false);
  assert.equal(integrityLockdownActive(state), true);

  const cleared = syncAppleContentFilterLockdown(state, {
    required: true,
    current: false,
    effectiveCurrent: true,
    appleContentFilter: { current: true }
  }, new Date(now.getTime() + 2000));
  assert.equal(cleared.cleared, true);
  assert.equal(integrityLockdownActive(state), false);
  assert.equal(activePolicy(state, now), null);
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
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Firefox"), true);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Slack", "Microsoft Teams", "Notion"], now).map((item) => item.app), ["Slack", "Microsoft Teams", "Notion"]);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Slack Helper (Renderer)"), true);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Discord Helper", "Steam Helper"], now).map((item) => item.app), ["Discord Helper", "Steam Helper"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Terminal", "Activity Monitor"], now).map((item) => item.app), ["Activity Monitor"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["App Store", "Installer", "Disk Utility"], now).map((item) => item.app), ["App Store", "Installer", "Disk Utility"]);
  assert.deepEqual(sweepBlockedApps(state, usage, ["Tailscale", "Cloudflare WARP", "Proxyman", "Little Snitch Configuration"], now).map((item) => item.app), ["Tailscale", "Cloudflare WARP", "Proxyman", "Little Snitch Configuration"]);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "WireGuard Helper"), true);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Charles Proxy"), true);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "CleanMyMac"), true);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Jamf Self Service"), true);
  state.activeSession.profileSnapshot = {
    ...state.profiles[0],
    blockedSites: [],
    blockedUrlPatterns: []
  };
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Firefox"), false);
  assert.equal(shouldBlockAppForPolicy(state, mustPolicy(activePolicy(state, now)), "Slack"), false);
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
  const usage = {};
  const softSession = {
    id: "level-2",
    title: "Soft Lock",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep" as const,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    source: "protection-level",
    deviceTargets: ["computer" as const],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  state.activeSession = softSession;
  state.activeSessions.computer = softSession;
  assert.deepEqual(
    sweepBlockedApps(state, usage, ["ChatGPT", "Codex (Renderer)", "Sentinel", "Slack", "System Settings", "Discord"], now),
    [],
    "Level 2 must enforce content without quitting unrelated apps"
  );

  const brickSession = {
    ...softSession,
    id: "level-3",
    title: "Full Brick",
    mode: "brick",
    profileId: BRICK_MODE_PROFILE_ID,
    canEndEarly: true,
    commitmentLock: false,
    profileSnapshot: profileById(state, BRICK_MODE_PROFILE_ID)
  };
  state.activeSession = brickSession;
  state.activeSessions.computer = brickSession;
  assert.deepEqual(
    sweepBlockedApps(state, usage, ["ChatGPT", "Codex (Renderer)", "Sentinel", "Siri", "MenuBarAgent", "Instagram", "Discord", "YouTube"], now).map((item) => item.app),
    ["Instagram", "Discord", "YouTube"],
    "Level 3 must quit only targeted social apps"
  );
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
  assert.equal(recordValue(mustPolicy(activeAppLockPolicy(state, { app: "Firefox", hostname: "" }, now)).appLock, "site lock").id, "site-lock");
  assert.equal(recordValue(mustPolicy(activeAppLockPolicy(state, { app: "Slack Helper", hostname: "" }, now)).appLock, "site lock").id, "site-lock");
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
  assert.equal(recordValue(mustPolicy(activeLimitPolicy(state, usage, { app: "Firefox", hostname: "" }, now)).limitBlock, "site limit block").id, "site-limit-block");
  assert.equal(recordValue(mustPolicy(activeLimitPolicy(state, usage, { app: "Microsoft Teams Helper", hostname: "" }, now)).limitBlock, "site limit block").id, "site-limit-block");
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
