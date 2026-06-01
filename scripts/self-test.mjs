import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRICK_MODE_PROFILE_ID, defaultState, REQUIRED_EXTENSION_VERSION } from "../src/defaults.js";
import { accountStatusFromGroups, parseGroups } from "../src/account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, extensionCorsHeaders, extensionRequestGuard, isTrustedExtensionRequest, publicHostGuard } from "../src/apiSecurity.js";
import { activeAppLockPolicy, confirmAppLockUnlock, requestAppLockUnlock } from "../src/appLocks.js";
import { contentFilterRuleEntries, matchContentFilterUrl } from "../src/contentFilters.js";
import { parseAdbDevices, parseAndroidPackages, shouldApplyAndroidBlock } from "../src/devices.js";
import { assertDistanceKey, distanceKeySummary, updateDistanceKeySettings } from "../src/distanceKey.js";
import { doctorRows, formatDoctorRows } from "../src/doctorReport.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { focusShortcutDetail, focusShortcutSummary, reconcileFocusShortcut } from "../src/focusHooks.js";
import { assertFoolproofReadyForStrict, extensionDynamicRulesReady, extensionVersionReady, foolproofBlockers } from "../src/foolproof.js";
import { buildHostsBlock, extractHostsBlock, hostsBlockMatches, LEGACY_HOSTS_BEGIN, LEGACY_HOSTS_END, parseLaunchAgentPrint, replaceManagedHostsBlock } from "../src/hardening.js";
import { clearIntegrityTamper, detectClockTamper, detectHardeningDrift, detectRuntimeGap, integrityLockdownActive, integrityLockdownPolicy, integrityRuntimeSummary, recordRuntimeHeartbeat } from "../src/integrityLockdown.js";
import { assertIntentReason, intentReasonSummary } from "../src/intentReason.js";
import { emergencyDelaySeconds, interventionSummary, recentBlockAttempts } from "../src/intervention.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, iosMdmSummary, queueIosMdmPolicyRefresh } from "../src/iosMdm.js";
import { buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "../src/keyholder.js";
import { activeLimitPolicy } from "../src/limits.js";
import { parseProcessList } from "../src/macos.js";
import { appQuitEscalationDecision, shouldLockScreenForPolicy, sweepBlockedApps } from "../src/monitor.js";
import { parsePlist, plistData, toPlist } from "../src/plist.js";
import { activePolicy, activeSchedule, appMatchesAppTargets, emergencyUnlockAllowedForPolicy, expandAppTargets, expandSiteTargets, hostMatchesSiteTargets, matchBlockedUrlPattern, matchStrictBrowserControlUrl, profileById, sessionPhase, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";
import { distractionPresets } from "../src/presets.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, protectedEditBlockers, requestMaintenanceWindow } from "../src/protection.js";
import { focusReport } from "../src/reports.js";
import { applySealVerificationToState, markStateSealed, stateDigest, stateSealSummary, verifyStateTextSeal, writeStateTextSeal } from "../src/seal.js";
import { sourceManifestText, sourceSealStatus, writeSourceSeal } from "../src/sourceSeal.js";

const now = new Date("2026-05-28T14:00:00-04:00");

{
  assert.deepEqual(parseGroups("staff admin everyone staff"), ["admin", "everyone", "staff"]);
  const admin = accountStatusFromGroups("daily", "staff admin everyone");
  assert.equal(admin.ok, false);
  assert.equal(admin.isAdmin, true);
  const standard = accountStatusFromGroups("focus", "staff everyone");
  assert.equal(standard.ok, true);
  assert.equal(standard.isAdmin, false);
}

{
  assert.equal(apiRequestGuard({ method: "GET", path: "/api/state", headers: {} }).ok, true);
  assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/check", headers: {} }).ok, true);
  assert.equal(apiRequestGuard({ method: "POST", path: "/api/extension/rules/sync", headers: { "content-type": "application/json" } }).ok, true);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    headers: {
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }
  }).ok, true);
  assert.equal(apiRequestGuard({
    method: "DELETE",
    path: "/api/schedule/test",
    headers: {
      origin: "http://localhost:8787",
      "sec-fetch-site": "same-origin",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }
  }).ok, true);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    headers: {
      origin: "https://example.com",
      "content-type": "application/json",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }
  }).ok, false);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    headers: {
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }
  }).ok, false);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    headers: {
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
      [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE
    }
  }).ok, false);
  assert.equal(apiRequestGuard({
    method: "POST",
    path: "/api/settings",
    headers: {
      origin: "http://127.0.0.1:8787",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "application/json"
    }
  }).ok, true);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "https://example.com",
      "content-type": "application/json"
    }
  }).ok, false);
  assert.equal(extensionRequestGuard({
    method: "POST",
    headers: {
      origin: "chrome-extension://abc",
      "content-type": "text/plain"
    }
  }).ok, false);
  assert.equal(isTrustedExtensionRequest({ origin: "chrome-extension://abc" }), true);
  assert.equal(isTrustedExtensionRequest({ origin: "http://127.0.0.1:8787" }), false);
  assert.equal(extensionCorsHeaders({ origin: "chrome-extension://abc" })["Access-Control-Allow-Origin"], "chrome-extension://abc");
  assert.equal(extensionCorsHeaders({ origin: "https://example.com" })["Access-Control-Allow-Origin"], undefined);
  assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "127.0.0.1:8787" } }).ok, true);
  assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "localhost:8787" } }).ok, true);
  assert.equal(publicHostGuard({ path: "/api/state", headers: { host: "vigil.example.test" } }).ok, false);
  assert.equal(publicHostGuard({ path: "/mdm/checkin", headers: { host: "vigil.example.test" } }).ok, true);
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
  const readyContext = {
    hosts: { installed: true, partial: false, stale: false },
    agent: { loaded: true, running: true },
    account: accountStatusFromGroups("focus", "staff everyone"),
    monitor: { ok: true, accessibilityLikelyMissing: false },
    stateSeal: { ok: true, status: "sealed", detail: "State file matches its integrity seal." },
    sourceSeal: { ok: true, status: "sealed", detail: "Source files match integrity seal.", fileCount: 42 }
  };
  assert.deepEqual(foolproofBlockers(state, readyContext, now), []);
  assert.doesNotThrow(() => assertFoolproofReadyForStrict(state, readyContext, now));
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
  const goodRules = { ok: true, status: "synced", detail: "Dynamic browser block rules synced (9 active).", count: 9 };
  assert.equal(detectHardeningDrift(state, { hosts: badHosts, extensionRules: goodRules }, now), null);
  assert.equal(integrityLockdownActive(state), false);

  state.settings.foolproofModeEnabled = true;
  const goodSourceSeal = { ok: true, status: "sealed", detail: "Source files match integrity seal." };
  const drift = detectHardeningDrift(state, { hosts: badHosts, extensionRules: goodRules, sourceSeal: goodSourceSeal }, now);
  assert.equal(drift.issues[0].id, "hosts");
  assert.equal(integrityRuntimeSummary(state).status, "hardening-drift");
  assert.equal(integrityLockdownPolicy(state, now).alarm.type, "hardening-drift");
  assert.equal(clearIntegrityTamper(state, now), true);
  assert.equal(integrityRuntimeSummary(state).ok, true);

  const staleRules = { ok: false, status: "stale", detail: "Browser companion dynamic block rules are stale.", count: 9 };
  const driftRules = detectHardeningDrift(state, { hosts: { installed: true, partial: false, stale: false }, extensionRules: staleRules, sourceSeal: goodSourceSeal }, now);
  assert.equal(driftRules.issues[0].id, "extension-rules");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftSource = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    extensionRules: goodRules,
    sourceSeal: { ok: false, status: "mismatch", detail: "Source files do not match the integrity seal." }
  }, now);
  assert.equal(driftSource.issues[0].id, "source-seal");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftAgent = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
    extensionRules: goodRules,
    sourceSeal: goodSourceSeal,
    agent: { installed: true, loaded: false, running: false }
  }, now);
  assert.equal(driftAgent.issues[0].id, "launch-agent");
  assert.equal(clearIntegrityTamper(state, now), true);

  const driftAccessibility = detectHardeningDrift(state, {
    hosts: { installed: true, partial: false, stale: false },
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
    days: [now.getDay()],
    start: "13:00",
    end: "15:00",
    wifiNetworks: []
  }];
  recordRuntimeHeartbeat(state, new Date("2026-05-28T12:00:00-04:00"));
  const gap = detectRuntimeGap(state, new Date("2026-05-28T16:00:00-04:00"));
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
    days: [now.getDay()],
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
  assert.match(block, /0\.0\.0\.0 youtu\.be/);
  assert.match(block, /0\.0\.0\.0 youtube-nocookie\.com/);
  assert.equal(hostsBlockMatches(extractHostsBlock(hosts).replace("reddit.com", "example.com"), block), false);
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
  assert.match(serverSource, /\/api\/hardening\/hosts\/apply/);
  assert.match(serverSource, /with administrator privileges/);
  assert.match(serverSource, /npm run seal:source/);
  assert.match(serverSource, /extensionLoad/);
  assert.match(serverSource, /Brick Mode/);
  assert.match(serverSource, /browser control pages/);
  assert.match(serverSource, /strictPreflightState/);
  assert.match(serverSource, /profileSnapshot: snapshotProfile\(profile\)/);
  assert.match(serverSource, /\/api\/extension\/rules\/sync/);
  assert.match(serverSource, /focusShortcutSummary/);
  assert.match(serverSource, /assertIntentReason/);
  assert.match(serverSource, /focusSoundPreset/);
  const indexSource = await readFile(join(process.cwd(), "public", "index.html"), "utf8");
  assert.match(indexSource, /id="startBrickMode"/);
  assert.match(indexSource, /id="focusShortcutEnabled"/);
  assert.match(indexSource, /id="intentReasonEnabled"/);
  assert.match(indexSource, /id="focusSoundEnabled"/);
  const appSource = await readFile(join(process.cwd(), "public", "app.js"), "utf8");
  assert.match(appSource, /BRICK_MODE_PROFILE_ID/);
  assert.match(appSource, /saveFocusShortcuts/);
  assert.match(appSource, /renderIntentReasonHints/);
  assert.match(appSource, /createNoiseSource/);
  assert.match(appSource, /distanceKeyQrSvg/);
  assert.match(appSource, /BarcodeDetector/);
  assert.match(appSource, /printDistanceKey/);
  const extensionSource = await readFile(join(process.cwd(), "extension", "background.js"), "utf8");
  assert.match(extensionSource, /ALLOWLIST_RULE_START/);
  assert.match(extensionSource, /excludedRequestDomains/);
  assert.match(extensionSource, /reportRuleSync/);
  const extensionManifest = JSON.parse(await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8"));
  assert.equal(extensionManifest.version, REQUIRED_EXTENSION_VERSION);
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
    days: [now.getDay()],
    start: "13:00",
    end: "15:00",
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
    days: [now.getDay()],
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
    days: [now.getDay()],
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
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "social-open",
    name: "Social Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: [now.getDay()],
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
    days: [now.getDay()],
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
    days: [now.getDay()],
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
    days: [now.getDay()],
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
    }
  };
  const report = focusReport(usage, state, new Date("2026-05-28T14:00:00-04:00"));
  assert.equal(report.currentWeek.totals.trackedDays, 2);
  assert.equal(report.topCulprits[0].name, "reddit.com");
  assert.equal(report.milestones.some((item) => item.id === "one-hour-saved"), true);
}

{
  const devices = parseAdbDevices(`List of devices attached
abc123 device product:test model:Pixel
offline1 offline
`);
  assert.equal(devices.length, 2);
  assert.equal(devices[0].serial, "abc123");

  const packages = parseAndroidPackages("package:com.reddit.frontpage\npackage:com.google.android.youtube\n");
  assert.deepEqual(packages, ["com.google.android.youtube", "com.reddit.frontpage"]);

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
  assert.equal(shouldApplyAndroidBlock(state, now), true);
}

{
  const state = defaultState();
  const disabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(disabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(disabledProfile, /allowAppInstallation/);
  assert.doesNotMatch(disabledProfile, /PayloadRemovalDisallowed<\/key>\s*<true/);

  state.deviceControls.ios.enabled = true;
  const enabledProfile = buildIosConfigurationProfile(state, now);
  assert.match(enabledProfile, /blockedAppBundleIDs/);
  assert.match(enabledProfile, /com\.google\.ios\.youtube/);
  assert.match(enabledProfile, /allowAppInstallation/);
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
    days: [now.getDay()],
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
    days: [now.getDay()],
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
  const content = await readFile("extension/content.js", "utf8");
  assert.match(content, /cleanupBrowserNoise/);
  const installer = await readFile("scripts/install-launch-agent.mjs", "utf8");
  assert.match(installer, /agent-runner\.mjs/);
}

console.log("Self-test passed");
