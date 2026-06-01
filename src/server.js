import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { currentMacAccountStatus } from "./account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, extensionCorsHeaders, extensionRequestGuard, isTrustedExtensionRequest, publicHostGuard } from "./apiSecurity.js";
import { APP_NAME, PORT } from "./defaults.js";
import { addEvent, loadState, loadUsage, saveState, saveUsage } from "./store.js";
import { assertTypingChallenge, attachTypingChallenge, TypingChallengeError } from "./challenge.js";
import { hostsStatus, buildHostsBlock, launchAgentPath, launchAgentStatus, stateSealStatus } from "./hardening.js";
import { startMonitor } from "./monitor.js";
import { activePolicy, activeProfile, emergencyUnlockAllowedForPolicy, listFromTextarea, profileById, sessionPhase, snapshotProfile } from "./policy.js";
import { AppLockError, appLockSummary, confirmAppLockUnlock, normalizeAppLock, requestAppLockUnlock } from "./appLocks.js";
import { applyAndroidAction, deviceSummary, listAndroidPackages, normalizeAndroidSettings } from "./devices.js";
import { assertDistanceKey, DistanceKeyError, distanceKeySummary, updateDistanceKeySettings } from "./distanceKey.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "./extensionPolicy.js";
import { focusShortcutDetail, focusShortcutSummary } from "./focusHooks.js";
import { assertFoolproofReadyForStrict, extensionDynamicRulesReady, extensionRecentlySeen as extensionRecentlySeenForState, extensionVersionReady, FoolproofError, foolproofSummary } from "./foolproof.js";
import { clearIntegrityTamper, integrityRuntimeSummary } from "./integrityLockdown.js";
import { assertIntentReason, IntentReasonError, intentReasonPolicy, intentReasonSummary } from "./intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "./intervention.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, normalizeIosMdmSettings, publicIosMdmSettings, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated, normalizeIosSettings, publicIosSettings } from "./iosProfiles.js";
import { activeLimitBlocks, limitSummary, normalizeLimitRule } from "./limits.js";
import { parsePlist, toPlist } from "./plist.js";
import { ProtectionError, assertProtectedEditAllowed, confirmMaintenanceWindow, protectionSummary, requestMaintenanceWindow } from "./protection.js";
import { distractionPresets } from "./presets.js";
import { focusReport } from "./reports.js";
import { assertKeyholderPasscode, KeyholderError, keyholderSummary, updateKeyholderSettings } from "./keyholder.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { clampNumber, weekKey } from "./time.js";
import { usageSummary } from "./usage.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const startedAt = new Date().toISOString();
const execFileAsync = promisify(execFile);

const state = await loadState();
const usage = await loadUsage();
const monitor = startMonitor({ state, usage });
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${PORT}`}`);
    const hostGuard = publicHostGuard({ path: url.pathname, headers: request.headers });
    if (!hostGuard.ok) {
      sendJson(response, hostGuard.status || 403, { error: hostGuard.error || "Forbidden" });
      return;
    }

    if (url.pathname.startsWith("/mdm/")) {
      await handleMdm(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/blocked") {
      sendHtml(response, blockedPage(url));
      return;
    }

    await serveStatic(response, url.pathname);
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`${APP_NAME} running at http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  monitor.stop();
  await saveState(state);
  server.close(() => process.exit(0));
}

function scheduleImmediateSessionEnforcement(sessionId) {
  setImmediate(async () => {
    if (state.activeSession?.id !== sessionId) return;

    let event;
    try {
      const result = await monitor.enforceImmediately("session-start");
      event = { sessionId, ok: true, result };
    } catch (error) {
      event = { sessionId, ok: false, error: error.message || String(error) };
      console.error("Immediate session enforcement failed:", error);
    }

    addEvent(state, "session_immediate_enforcement", event);
    try {
      await saveState(state);
    } catch (error) {
      console.error("Immediate enforcement event save failed:", error);
    }
  });
}

async function handleMdm(request, response, url) {
  const method = request.method || "GET";
  const path = url.pathname;
  if (!authorizeIosMdmRequest(state, url)) {
    sendEmpty(response, 403);
    return;
  }

  if (method === "GET" && path === "/mdm/enroll.mobileconfig") {
    const profile = buildIosMdmEnrollmentProfile(state);
    markIosMdmEnrollmentGenerated(state);
    addEvent(state, "ios_mdm_enrollment_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "GET" && path === "/mdm/policy.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state);
    markIosProfileGenerated(state);
    addEvent(state, "ios_public_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if ((method === "PUT" || method === "POST") && path === "/mdm/checkin") {
    const body = parsePlist(await readTextBody(request));
    const result = handleIosMdmCheckIn(state, body);
    addEvent(state, "ios_mdm_checkin", {
      messageType: result.messageType,
      udid: result.udid,
      ok: result.ok
    });
    await saveState(state);
    sendEmpty(response, 200, mdmHeaders());
    return;
  }

  if ((method === "PUT" || method === "POST") && path === "/mdm/connect") {
    const body = parsePlist(await readTextBody(request));
    const result = handleIosMdmConnect(state, body);
    addEvent(state, "ios_mdm_connect", {
      status: result.status,
      udid: result.udid,
      command: result.command?.requestType || "none"
    });
    await saveState(state);
    if (result.empty) sendEmpty(response, 200, mdmHeaders());
    else sendMdmPlist(response, 200, result.body);
    return;
  }

  sendEmpty(response, 404);
}

async function handleApi(request, response, url) {
  const method = request.method || "GET";
  const path = url.pathname;
  const guard = apiRequestGuard({ method, path, headers: request.headers });
  if (!guard.ok) {
    sendJson(response, guard.status || 403, { error: guard.error || "Forbidden" });
    return;
  }

  if (method === "OPTIONS" && isExtensionApiPath(path)) {
    const extensionGuard = extensionRequestGuard({ method, headers: request.headers });
    if (!extensionGuard.ok) sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" });
    else sendEmpty(response, 204, extensionCorsHeaders(request.headers));
    return;
  }

  if (method === "GET" && path === "/api/state") {
    const policy = activePolicy(state);
    const hosts = await hostsStatus(state);
    const agent = await launchAgentStatus();
    const account = await currentMacAccountStatus();
    const stateSeal = await stateSealStatus(state);
    const sourceSeal = await sourceSealStatus();
    const protection = protectionSummary(state);
    const devices = await deviceSummary(state);
    const foolproof = foolproofSummary(state, { hosts, agent, account, monitor: monitor.status, stateSeal, sourceSeal });
    await saveState(state);
    sendJson(response, 200, {
      app: { name: APP_NAME, port: PORT, startedAt },
      state: publicState(state, policy),
      usage: usageSummary(usage, state),
      report: focusReport(usage, state),
      limits: limitSummary(state, usage),
      appLocks: appLockSummary(state),
      devices,
      protection,
      intervention: interventionSummary(state),
      monitor: monitor.status,
      presets: distractionPresets(),
      hardening: {
        hosts,
        launchAgent: agent,
        account,
        stateSeal,
        sourceSeal,
        launchAgentPath: launchAgentPath(),
        hostsBlock: buildHostsBlock(state),
        actions: hardeningActions(),
        foolproof,
        audit: hardeningAudit({ hosts, agent, account, protection, monitor: monitor.status, foolproof, stateSeal, sourceSeal })
      }
    });
    return;
  }

  if ((method === "POST" || method === "GET") && path === "/api/extension/check") {
    const extensionGuard = extensionRequestGuard({ method, headers: request.headers });
    if (!extensionGuard.ok) {
      sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionCorsHeaders(request.headers));
      return;
    }
    const body = method === "POST"
      ? await readBody(request)
      : {
          url: url.searchParams.get("url"),
          previousUrl: url.searchParams.get("previousUrl"),
          event: url.searchParams.get("event"),
          seconds: url.searchParams.get("seconds")
        };
    const result = evaluateExtensionCheck(state, usage, body);
    if (isTrustedExtensionRequest(request.headers)) {
      state.extension = {
        ...(state.extension || {}),
        lastSeenAt: new Date().toISOString(),
        lastVersion: String(body.extensionVersion || state.extension?.lastVersion || "").slice(0, 40) || null,
        lastEvent: result.event || body.event || null,
        lastHost: result.hostname || state.extension?.lastHost || null
      };
    }
    if (result.blocked && result.event !== "heartbeat") {
      addEvent(state, "extension_blocked_site", {
        site: result.hostname,
        policy: result.policy?.title || result.reason
      });
    }
    await saveUsage(usage);
    await saveState(state);
    sendJson(response, 200, result, extensionCorsHeaders(request.headers));
    return;
  }

  if (method === "GET" && path === "/api/extension/rules") {
    const extensionGuard = extensionRequestGuard({ method, headers: request.headers });
    if (!extensionGuard.ok) {
      sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionCorsHeaders(request.headers));
      return;
    }
    const snapshot = extensionRuleSnapshot(state);
    const expectedCount = extensionDynamicRuleCount(snapshot);
    const expectedSignature = extensionDynamicRuleSignature(snapshot);
    if (isTrustedExtensionRequest(request.headers)) {
      state.extension = {
        ...(state.extension || {}),
        lastSeenAt: new Date().toISOString(),
        lastVersion: String(url.searchParams.get("version") || state.extension?.lastVersion || "").slice(0, 40) || null,
        lastEvent: "rules",
        lastHost: state.extension?.lastHost || null,
        dynamicRules: {
          ...(state.extension?.dynamicRules || {}),
          expectedCount,
          expectedSignature,
          requestedAt: snapshot.generatedAt,
          fallbackRequired: snapshot.fallbackRequired
        }
      };
      await saveState(state);
    }
    sendJson(response, 200, snapshot, extensionCorsHeaders(request.headers));
    return;
  }

  if (method === "POST" && path === "/api/extension/rules/sync") {
    const extensionGuard = extensionRequestGuard({ method, headers: request.headers });
    if (!extensionGuard.ok) {
      sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionCorsHeaders(request.headers));
      return;
    }

    const body = await readBody(request);
    const snapshot = extensionRuleSnapshot(state);
    const expectedCount = extensionDynamicRuleCount(snapshot);
    const expectedSignature = extensionDynamicRuleSignature(snapshot);
    const count = clampNumber(body.count, 0, 1000, 0);
    const signature = String(body.signature || "");
    const ok = truthy(body.ok) && count === expectedCount && signature === expectedSignature && !snapshot.fallbackRequired;
    if (isTrustedExtensionRequest(request.headers)) {
      state.extension = {
        ...(state.extension || {}),
        lastSeenAt: new Date().toISOString(),
        lastVersion: String(body.extensionVersion || state.extension?.lastVersion || "").slice(0, 40) || null,
        lastEvent: "rules-sync",
        lastHost: state.extension?.lastHost || null,
        dynamicRules: {
          syncedAt: new Date().toISOString(),
          count,
          expectedCount,
          signature,
          expectedSignature,
          fallbackRequired: snapshot.fallbackRequired,
          status: ok ? "synced" : (truthy(body.ok) ? "mismatch" : "failed"),
          ok,
          error: String(body.error || "").slice(0, 200)
        }
      };
      await saveState(state);
    }
    sendJson(response, 200, { ok, count, expectedCount }, extensionCorsHeaders(request.headers));
    return;
  }

  if (method === "POST" && path === "/api/settings") {
    const body = await readBody(request);
    if (isProtectedSettingsMutation(body)) assertProtectedEditAllowed(state, { kind: "settings" });
    updateSettings(body);
    addEvent(state, "settings_updated", { keys: Object.keys(body) });
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/api/keyholder") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const keyholder = updateKeyholderSettings(state, body);
      addEvent(state, "keyholder_updated", { enabled: keyholder.enabled, hasPasscode: keyholder.hasPasscode });
      await saveState(state);
      sendJson(response, 200, { ok: true, keyholder });
    } catch (error) {
      sendJson(response, error instanceof KeyholderError || error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/distance-key") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const result = updateDistanceKeySettings(state, body);
      addEvent(state, "distance_key_updated", { enabled: result.summary.enabled, hasToken: result.summary.hasToken, rotated: Boolean(result.token) });
      await saveState(state);
      sendJson(response, 200, { ok: true, distanceKey: result.summary, token: result.token });
    } catch (error) {
      sendJson(response, error instanceof DistanceKeyError || error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/hardening/launch-agent/install") {
    try {
      const result = await runLocalScript("install-launch-agent.mjs");
      addEvent(state, "launch_agent_installed", { ok: true });
      await saveState(state);
      const launchAgent = await waitForLaunchAgentRunning();
      sendJson(response, 200, { ok: true, result, launchAgent });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/hardening/hosts/apply") {
    try {
      const result = await runPrivilegedHostsApply();
      const hosts = await hostsStatus(state);
      addEvent(state, "hosts_block_applied", {
        ok: hosts.installed && !hosts.stale,
        entries: hosts.installedEntries || 0
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, result, hosts });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/integrity/clear-tamper") {
    try {
      assertProtectedEditAllowed(state, { kind: "settings" });
      const cleared = clearIntegrityTamper(state);
      addEvent(state, "state_tamper_cleared", { cleared });
      await saveState(state);
      sendJson(response, 200, { ok: true, cleared });
    } catch (error) {
      sendJson(response, error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/devices/android/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls ||= {};
    state.deviceControls.android = normalizeAndroidSettings(body, state.deviceControls.android || {});
    addEvent(state, "android_settings_updated", { enabled: state.deviceControls.android.enabled, packages: state.deviceControls.android.packages.length });
    await saveState(state);
    sendJson(response, 200, { ok: true, android: state.deviceControls.android });
    return;
  }

  if (method === "POST" && path === "/api/devices/ios/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls ||= {};
    state.deviceControls.ios = normalizeIosSettings(body, state.deviceControls.ios || {});
    addEvent(state, "ios_settings_updated", {
      enabled: state.deviceControls.ios.enabled,
      mode: state.deviceControls.ios.mode,
      webMode: state.deviceControls.ios.webMode,
      blockedApps: state.deviceControls.ios.blockedAppBundleIds.length,
      allowedApps: state.deviceControls.ios.allowedAppBundleIds.length
    });
    recordIosMdmPolicyQueue("ios-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, ios: publicIosState(state.deviceControls.ios) });
    return;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.deviceControls ||= {};
    state.deviceControls.ios ||= {};
    state.deviceControls.ios.mdm = normalizeIosMdmSettings(body, state.deviceControls.ios.mdm || {});
    addEvent(state, "ios_mdm_settings_updated", {
      enabled: state.deviceControls.ios.mdm.enabled,
      hasPublicBaseUrl: Boolean(state.deviceControls.ios.mdm.publicBaseUrl),
      hasTopic: Boolean(state.deviceControls.ios.mdm.topic)
    });
    recordIosMdmPolicyQueue("ios-mdm-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, mdm: publicIosMdmSettings(state.deviceControls.ios.mdm) });
    return;
  }

  if (method === "GET" && path === "/api/devices/ios/mdm/enrollment.mobileconfig") {
    const profile = buildIosMdmEnrollmentProfile(state);
    markIosMdmEnrollmentGenerated(state);
    addEvent(state, "ios_mdm_enrollment_generated", { bytes: Buffer.byteLength(profile), source: "app" });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/queue-policy") {
    const result = queueIosMdmPolicyRefresh(state, "app-refresh");
    addEvent(state, "ios_mdm_policy_queued", result);
    await saveState(state);
    sendJson(response, 200, { ok: Boolean(result.queued), result });
    return;
  }

  if (method === "GET" && path === "/api/devices/ios/profile.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state);
    markIosProfileGenerated(state);
    addEvent(state, "ios_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "sentinel-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "POST" && path === "/api/devices/android/apply") {
    const body = await readBody(request);
    const action = body.action === "unblock" ? "unblock" : "block";
    if (action === "unblock") assertProtectedEditAllowed(state, { kind: "settings" });
    const result = await applyAndroidAction(state, action);
    addEvent(state, "android_apply", { action, ok: result.ok, devices: result.devices?.length || 0 });
    await saveState(state);
    sendJson(response, result.ok ? 200 : 409, { ok: result.ok, result });
    return;
  }

  if (method === "GET" && path === "/api/devices/android/packages") {
    const serial = url.searchParams.get("serial");
    if (!serial) {
      sendJson(response, 400, { error: "Missing serial" });
      return;
    }
    const result = await listAndroidPackages(serial);
    sendJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (method === "POST" && path === "/api/profile") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "profile", id: body.id || null });
    const profile = upsertProfile(body);
    addEvent(state, "profile_saved", { profileId: profile.id, name: profile.name });
    recordIosMdmPolicyQueue("profile-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, profile });
    return;
  }

  if (method === "POST" && path === "/api/session/start") {
    const body = await readBody(request);
    activePolicy(state);
    if (state.activeSession) {
      sendJson(response, 409, { error: "A session is already active.", active: state.activeSession });
      return;
    }

    const cycle = normalizeSessionCycle(body);
    const durationMinutes = cycle ? cycleDurationMinutes(cycle) : clampNumber(body.durationMinutes, 1, 60 * 24 * 45, 25);
    const started = new Date();
    const ends = new Date(started.getTime() + durationMinutes * 60 * 1000);
    const lockLevel = body.lockLevel || (state.settings.strictByDefault ? "deep" : "light");
    const mode = body.mode || "focus";
    const profile = profileById(state, body.profileId);
    await assertStrictLockAllowed(lockLevel, profile, { mode });
    const commitmentLock = lockLevel === "deep" && truthy(body.commitmentLock);

    state.activeSession = {
      id: randomUUID(),
      title: body.title || sessionTitle(mode),
      mode,
      profileId: profile.id,
      lockLevel,
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      canEndEarly: lockLevel === "light",
      commitmentLock,
      emergencyUnlocksAllowed: !commitmentLock,
      source: "manual",
      cycle,
      profileSnapshot: snapshotProfile(profile)
    };
    addEvent(state, "session_started", state.activeSession);
    recordIosMdmPolicyQueue("session-start");
    await saveState(state);
    scheduleImmediateSessionEnforcement(state.activeSession.id);
    sendJson(response, 200, { ok: true, session: state.activeSession });
    return;
  }

  if (method === "POST" && path === "/api/session/end") {
    if (state.activeSession) {
      if (!state.activeSession.canEndEarly) {
        sendJson(response, 423, { error: "This session is locked. Use an emergency unlock if you really need to end it.", active: state.activeSession });
        return;
      }

      addEvent(state, "session_ended", state.activeSession);
      state.activeSession = null;
      recordIosMdmPolicyQueue("session-end");
      await saveState(state);
      sendJson(response, 200, { ok: true, ended: true });
      return;
    }

    const active = activePolicy(state);
    if (!active) {
      sendJson(response, 200, { ok: true, ended: false });
      return;
    }

    if (!active.session.canEndEarly) {
      sendJson(response, 423, { error: "This session is locked. Use an emergency unlock if you really need to end it.", active: active.session });
      return;
    }

    addEvent(state, "session_ended", active.session);
    state.activeSession = null;
    recordIosMdmPolicyQueue("session-end");
    await saveState(state);
    sendJson(response, 200, { ok: true, ended: true });
    return;
  }

  if (method === "POST" && path === "/api/emergency/request") {
    const body = await readBody(request);
    const active = activePolicy(state);
    const activeLimits = activeLimitBlocks(state);
    if (active && !emergencyUnlockAllowedForPolicy(active)) {
      sendJson(response, 423, { error: commitmentLockError(active), active: active.session });
      return;
    }
    if (!active) {
      if (!activeLimits.length) {
        sendJson(response, 409, { error: "There is no active locked session." });
        return;
      }
    }
    const remaining = emergencyRemaining();
    if (remaining <= 0) {
      sendJson(response, 429, { error: "No emergency unlocks remain this week." });
      return;
    }

    const now = Date.now();
    const delaySeconds = emergencyDelaySeconds(state, new Date(now));
    const pending = {
      id: randomUUID(),
      status: "pending",
      reason: assertIntentReason(state, body.reason, "Emergency unlock"),
      requestedAt: new Date(now).toISOString(),
      eligibleAt: new Date(now + delaySeconds * 1000).toISOString(),
      expiresAt: new Date(now + 15 * 60 * 1000).toISOString(),
      delaySeconds,
      intervention: interventionSummary(state, new Date(now)),
      activeKind: active?.kind || "limit",
      sessionId: active?.session.id || null,
      scheduleId: active?.schedule?.id || null,
      limitBlockIds: active ? [] : activeLimits.map((block) => block.id),
      until: active?.endsAt || activeLimits.map((block) => block.until).sort().at(-1)
    };
    attachTypingChallenge(state, pending, "emergency", new Date(now));
    state.emergency.pending.push(pending);
    addEvent(state, "emergency_requested", pending);
    await saveState(state);
    sendJson(response, 200, { ok: true, pending, remaining });
    return;
  }

  if (method === "POST" && path === "/api/emergency/confirm") {
    const body = await readBody(request);
    const pending = state.emergency.pending.find((item) => item.id === body.requestId && item.status === "pending");
    if (!pending) {
      sendJson(response, 404, { error: "Emergency request not found or expired." });
      return;
    }

    if (new Date(pending.eligibleAt) > new Date()) {
      sendJson(response, 425, { error: "Emergency unlock cooldown is still running.", pending });
      return;
    }

    try {
      assertTypingChallenge(state, pending, body.challengeText);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
    } catch (error) {
      sendJson(response, error instanceof KeyholderError || error instanceof DistanceKeyError || error instanceof TypingChallengeError ? error.status : 500, serializeError(error));
      return;
    }

    const remaining = emergencyRemaining();
    if (remaining <= 0) {
      sendJson(response, 429, { error: "No emergency unlocks remain this week." });
      return;
    }

    spendEmergencyToken();
    pending.status = "used";

    if (pending.activeKind === "manual" && state.activeSession?.id === pending.sessionId) {
      state.activeSession = null;
    } else if (pending.scheduleId) {
      state.overrides.push({
        id: randomUUID(),
        scheduleId: pending.scheduleId,
        until: pending.until,
        reason: pending.reason,
        createdAt: new Date().toISOString()
      });
    } else if (pending.activeKind === "limit") {
      const ids = new Set(pending.limitBlockIds || []);
      state.limitBlocks = (state.limitBlocks || []).filter((block) => !ids.has(block.id));
    }

    addEvent(state, "emergency_used", pending);
    recordIosMdmPolicyQueue("emergency-unlock");
    await saveState(state);
    sendJson(response, 200, { ok: true, remaining: emergencyRemaining() });
    return;
  }

  if (method === "POST" && path === "/api/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: body.id || null });
    const schedule = upsertSchedule(body);
    addEvent(state, "schedule_saved", { scheduleId: schedule.id, name: schedule.name });
    recordIosMdmPolicyQueue("schedule-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return;
  }

  if (method === "POST" && path === "/api/limit") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "limit", id: body.id || null });
    const rule = upsertLimitRule(body);
    addEvent(state, "limit_rule_saved", { ruleId: rule.id, name: rule.name, type: rule.type });
    recordIosMdmPolicyQueue("limit-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, rule });
    return;
  }

  if (method === "POST" && path === "/api/app-lock") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "app-lock", id: body.id || null });
    const lock = upsertAppLock(body);
    addEvent(state, "app_lock_saved", { lockId: lock.id, name: lock.name });
    recordIosMdmPolicyQueue("app-lock-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, lock });
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/app-lock/")) {
    const id = decodeURIComponent(path.split("/").at(-1));
    assertProtectedEditAllowed(state, { kind: "app-lock", id });
    state.appLocks = (state.appLocks || []).filter((lock) => lock.id !== id);
    state.appLockUnlocks = (state.appLockUnlocks || []).filter((unlock) => unlock.lockId !== id);
    state.appLockRequests = (state.appLockRequests || []).filter((request) => request.lockId !== id);
    addEvent(state, "app_lock_deleted", { lockId: id });
    recordIosMdmPolicyQueue("app-lock-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "POST" && path === "/api/app-lock/unlock/request") {
    try {
      const body = await readBody(request);
      const unlockRequest = requestAppLockUnlock(state, body.lockId, body.reason);
      addEvent(state, "app_lock_unlock_requested", { lockId: unlockRequest.lockId, requestId: unlockRequest.id });
      await saveState(state);
      sendJson(response, 200, { ok: true, request: unlockRequest });
    } catch (error) {
      sendJson(response, error instanceof AppLockError || error instanceof IntentReasonError ? error.status : 500, { error: error.message || String(error) });
    }
    return;
  }

  if (method === "POST" && path === "/api/app-lock/unlock/confirm") {
    try {
      const body = await readBody(request);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
      const unlock = confirmAppLockUnlock(state, body.requestId, { challengeText: body.challengeText });
      addEvent(state, "app_lock_unlocked", { lockId: unlock.lockId, unlockId: unlock.id, until: unlock.until });
      await saveState(state);
      sendJson(response, 200, { ok: true, unlock });
    } catch (error) {
      sendJson(response, error instanceof AppLockError || error instanceof KeyholderError || error instanceof DistanceKeyError || error instanceof TypingChallengeError ? error.status : 500, { error: error.message || String(error) });
    }
    return;
  }

  if (method === "POST" && path === "/api/protection/maintenance/request") {
    const body = await readBody(request);
    const result = requestMaintenanceWindow(state, body.reason);
    addEvent(state, "maintenance_requested", result.pending || result.activeWindow);
    await saveState(state);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === "POST" && path === "/api/protection/maintenance/confirm") {
    try {
      const body = await readBody(request);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
      const window = confirmMaintenanceWindow(state, body.requestId, { challengeText: body.challengeText });
      addEvent(state, "maintenance_opened", window);
      await saveState(state);
      sendJson(response, 200, { ok: true, window });
    } catch (error) {
      sendJson(response, error instanceof KeyholderError || error instanceof DistanceKeyError || error instanceof ProtectionError || error instanceof TypingChallengeError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/limit/")) {
    const id = decodeURIComponent(path.split("/").at(-1));
    assertProtectedEditAllowed(state, { kind: "limit", id });
    state.limitRules = (state.limitRules || []).filter((rule) => rule.id !== id);
    state.limitBlocks = (state.limitBlocks || []).filter((block) => block.ruleId !== id);
    addEvent(state, "limit_rule_deleted", { ruleId: id });
    recordIosMdmPolicyQueue("limit-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/schedule/")) {
    const id = decodeURIComponent(path.split("/").at(-1));
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.schedules = state.schedules.filter((schedule) => schedule.id !== id);
    addEvent(state, "schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function publicState(current, policy) {
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
    activeSession: current.activeSession,
    sessionPhase: sessionPhase(current.activeSession),
    activePolicy: policy ? {
      kind: policy.kind,
      session: policy.session,
      profile: policy.profile,
      schedule: policy.schedule || null,
      endsAt: policy.endsAt,
      phase: policy.phase || null
    } : null,
    emergency: {
      remaining: emergencyRemaining(),
      usedThisWeek: state.emergency.tokensUsedByWeek[weekKey()] || 0,
      pending: state.emergency.pending
    },
    overrides: current.overrides,
    events: current.events.slice(0, 50),
    activeProfile: activeProfile(current)
  };
}

function publicIosState(ios = {}) {
  return {
    ...publicIosSettings(ios),
    mdm: publicIosMdmSettings(ios.mdm || {})
  };
}

function updateSettings(body) {
  const allowed = new Set([
    "pollIntervalMs",
    "strictByDefault",
    "emergencyTokensPerWeek",
    "emergencyDelaySeconds",
    "intentReasonEnabled",
    "intentReasonMinLength",
    "focusSoundEnabled",
    "focusSoundPreset",
    "focusSoundVolume",
    "typingChallengeEnabled",
    "interventionEnabled",
    "interventionWindowMinutes",
    "interventionThreshold",
    "interventionExtraDelaySeconds",
    "interventionMaxExtraDelaySeconds",
    "baselineDailyMinutes",
    "focusScoreGoal",
    "activeProfileId",
    "foolproofModeEnabled",
    "appQuitEscalationSeconds",
    "siteRedirectEnabled",
    "contentFilterEnabled",
    "browserNoiseBlockingEnabled",
    "appQuitEnabled",
    "strictBypassProtectionEnabled",
    "processSweepEnabled",
    "processSweepIntervalSeconds",
    "systemSleepLockEnabled",
    "systemSleepLockIntervalSeconds",
    "focusShortcutEnabled",
    "focusShortcutOnName",
    "focusShortcutOffName",
    "hostsBlockingEnabled",
    "protectedEditsEnabled",
    "protectedEditDelaySeconds",
    "protectedEditWindowMinutes"
  ]);

  for (const [key, value] of Object.entries(body || {})) {
    if (!allowed.has(key)) continue;
    if (typeof state.settings[key] === "boolean") {
      state.settings[key] = Boolean(value);
    } else if (typeof state.settings[key] === "number") {
      const bounds = settingsNumberBounds(key);
      state.settings[key] = clampNumber(value, bounds.min, bounds.max, state.settings[key]);
    } else if (key === "focusSoundPreset") {
      const preset = String(value);
      state.settings[key] = ["brown-noise", "rain", "ocean"].includes(preset) ? preset : "brown-noise";
    } else {
      state.settings[key] = String(value);
    }
  }
}

function settingsNumberBounds(key) {
  if (key === "focusSoundVolume") return { min: 0, max: 100 };
  if (key === "intentReasonMinLength") return { min: 1, max: 280 };
  return { min: 1, max: 100000 };
}

function upsertProfile(body) {
  const id = body.id || randomUUID();
  const existing = state.profiles.find((item) => item.id === id);
  const profile = {
    id,
    name: String(body.name || existing?.name || "Focus profile").slice(0, 80),
    mode: body.mode === "allowlist" ? "allowlist" : "blocklist",
    description: String(body.description || existing?.description || "").slice(0, 240),
    blockedApps: normalizeArray(body.blockedApps ?? existing?.blockedApps),
    blockedSites: normalizeArray(body.blockedSites ?? existing?.blockedSites),
    blockedUrlPatterns: normalizeArray(body.blockedUrlPatterns ?? existing?.blockedUrlPatterns),
    allowedApps: normalizeArray(body.allowedApps ?? existing?.allowedApps),
    allowedSites: normalizeArray(body.allowedSites ?? existing?.allowedSites)
  };

  if (existing) Object.assign(existing, profile);
  else state.profiles.push(profile);

  state.settings.activeProfileId = profile.id;
  return profile;
}

function upsertSchedule(body) {
  const id = body.id || randomUUID();
  const existing = state.schedules.find((item) => item.id === id);
  const schedule = {
    id,
    name: String(body.name || existing?.name || "Focus schedule").slice(0, 80),
    enabled: Boolean(body.enabled),
    mode: body.mode || existing?.mode || "focus",
    profileId: body.profileId || existing?.profileId || state.settings.activeProfileId,
    lockLevel: body.lockLevel || existing?.lockLevel || "deep",
    commitmentLock: body.commitmentLock === undefined ? Boolean(existing?.commitmentLock) : truthy(body.commitmentLock),
    days: normalizeDays(body.days ?? existing?.days ?? [1, 2, 3, 4, 5]),
    start: normalizeClock(body.start || existing?.start || "09:00"),
    end: normalizeClock(body.end || existing?.end || "17:00"),
    wifiNetworks: normalizeArray(body.wifiNetworks ?? existing?.wifiNetworks)
  };

  if (existing) Object.assign(existing, schedule);
  else state.schedules.push(schedule);

  return schedule;
}

function upsertLimitRule(body) {
  const id = body.id || randomUUID();
  const existing = (state.limitRules || []).find((item) => item.id === id);
  const rule = normalizeLimitRule(body, existing, id);

  state.limitRules ||= [];
  if (existing) Object.assign(existing, rule);
  else state.limitRules.push(rule);

  return rule;
}

function upsertAppLock(body) {
  const id = body.id || randomUUID();
  const existing = (state.appLocks || []).find((item) => item.id === id);
  const lock = normalizeAppLock(body, existing, id);

  state.appLocks ||= [];
  if (existing) Object.assign(existing, lock);
  else state.appLocks.push(lock);

  return lock;
}

function normalizeSessionCycle(body) {
  if (!truthy(body.cycleEnabled)) return null;
  const workMinutes = clampNumber(body.cycleWorkMinutes, 1, 240, 25);
  const breakMinutes = clampNumber(body.cycleBreakMinutes, 1, 120, 5);
  const rounds = clampNumber(body.cycleRounds, 1, 24, 4);
  return {
    enabled: true,
    workMinutes,
    breakMinutes,
    rounds
  };
}

function cycleDurationMinutes(cycle) {
  return cycle.workMinutes * cycle.rounds + cycle.breakMinutes * Math.max(0, cycle.rounds - 1);
}

function emergencyRemaining() {
  const used = state.emergency.tokensUsedByWeek[weekKey()] || 0;
  return Math.max(0, state.settings.emergencyTokensPerWeek - used);
}

function spendEmergencyToken() {
  const key = weekKey();
  state.emergency.tokensUsedByWeek[key] = (state.emergency.tokensUsedByWeek[key] || 0) + 1;
}

function recordIosMdmPolicyQueue(reason) {
  const result = queueIosMdmPolicyRefresh(state, reason);
  if (result.queued) {
    addEvent(state, "ios_mdm_policy_queued", { reason, ...result });
  }
  return result;
}

function normalizeArray(value) {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return listFromTextarea(value);
}

function normalizeDays(value) {
  return [...new Set((value || []).map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function normalizeClock(value) {
  return /^\d{2}:\d{2}$/.test(value) ? value : "09:00";
}

function sessionTitle(mode) {
  if (mode === "sleep") return "Sleep lock";
  if (mode === "rehab") return "Rehab lock";
  if (mode === "brick") return "Brick Mode";
  return "Focus lock";
}

function commitmentLockError(policy) {
  if (policy?.kind === "integrity") {
    return "Integrity lockdown cannot be ended with an emergency unlock. Open a protected maintenance window after checking the alarm.";
  }
  return "This commitment lock does not allow emergency unlocks. Open a protected maintenance window if this was a mistake.";
}

function truthy(value) {
  return value === true || value === "true" || value === "on" || value === "1" || value === 1;
}

function isExtensionApiPath(path) {
  return ["/api/extension/check", "/api/extension/rules", "/api/extension/rules/sync"].includes(path);
}

async function readBody(request) {
  const raw = await readTextBody(request);
  return raw ? JSON.parse(raw) : {};
}

async function readTextBody(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1024 * 1024) throw new Error("Request body too large");
  }
  return raw;
}

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, "");
  const fullPath = join(PUBLIC_DIR, safe);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    sendJson(response, 403, { error: "Forbidden" });
    return;
  }

  try {
    const data = await readFile(fullPath);
    response.writeHead(200, { ...securityHeaders(), "Content-Type": contentType(fullPath) });
    response.end(data);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), "Content-Type": "application/json; charset=utf-8", ...headers });
  response.end(`${JSON.stringify(body)}\n`);
}

function sendDownload(response, status, body, filename, contentType) {
  response.writeHead(status, {
    ...securityHeaders(),
    "Content-Type": `${contentType}; charset=utf-8`,
    "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`
  });
  response.end(body);
}

function sendMdmPlist(response, status, body) {
  response.writeHead(status, { ...mdmHeaders(), "Content-Type": "application/x-apple-aspen-mdm; charset=utf-8" });
  response.end(toPlist(body));
}

function sendEmpty(response, status, headers = {}) {
  response.writeHead(status, { ...securityHeaders(), ...headers });
  response.end();
}

function mdmHeaders() {
  return {
    ...securityHeaders(),
    "Cache-Control": "no-store"
  };
}

function sendHtml(response, body) {
  response.writeHead(200, { ...securityHeaders(), "Content-Type": "text/html; charset=utf-8" });
  response.end(body);
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY"
  };
}

function contentType(path) {
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extname(path)] || "application/octet-stream";
}

function blockedPage(url) {
  const site = escapeHtml(url.searchParams.get("site") || "This target");
  const mode = escapeHtml(url.searchParams.get("mode") || "focus");
  const until = escapeHtml(url.searchParams.get("until") || "");
  const emergencyAllowed = emergencyUnlockAllowedForPolicy(activePolicy(state));
  const reasonPolicy = intentReasonPolicy(state);
  const breakStatus = emergencyAllowed ? "" : commitmentLockError(activePolicy(state));
  const reasonStatus = reasonPolicy.enabled ? `Enter a reason of at least ${reasonPolicy.minLength} characters.` : "";
  const initialStatus = breakStatus || reasonStatus;
  const breakDisabled = emergencyAllowed && !reasonPolicy.enabled ? "" : " disabled";
  const intervention = interventionSummary(state);
  const interventionClass = escapeHtml(intervention.level);
  const interventionCopy = escapeHtml(intervention.message);
  const interventionTargets = escapeHtml(intervention.topTargets.map((target) => `${target.label} x${target.count}`).join(" | ") || "No recent targets");
  const pageData = {
    site: url.searchParams.get("site") || "",
    kind: url.searchParams.get("kind") || "manual",
    lockId: url.searchParams.get("lockId") || "",
    returnUrl: url.searchParams.get("return") || "",
    emergencyAllowed,
    reasonGate: reasonPolicy
  };
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17201d; background: #f4f2ec; }
    main { width: min(560px, calc(100vw - 32px)); }
    h1 { font-size: 3.5rem; line-height: .94; margin: 0 0 18px; letter-spacing: 0; }
    p { font-size: 1.05rem; line-height: 1.55; color: #4b5753; margin: 0 0 14px; }
    a { color: #126a6f; font-weight: 700; }
    .meta { margin-top: 24px; padding-top: 18px; border-top: 1px solid #d8d3c6; color: #6c746f; }
    .break-panel { margin-top: 28px; padding-top: 22px; border-top: 1px solid #d8d3c6; display: grid; gap: 12px; }
    .break-panel h2 { margin: 0; font-size: 1.05rem; letter-spacing: 0; }
    .break-panel input { box-sizing: border-box; width: 100%; min-height: 44px; border: 1px solid #c9c2b5; border-radius: 6px; padding: 0 12px; background: #fffcf4; color: #17201d; font: inherit; }
    .challenge { display: none; border: 1px dashed #b69a5b; border-radius: 6px; background: #fff4d2; color: #4a3510; padding: 10px 12px; font-weight: 900; overflow-wrap: anywhere; }
    .break-actions, .distance-row { display: flex; gap: 10px; flex-wrap: wrap; }
    .distance-row input { flex: 1 1 220px; }
    button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 16px; font: inherit; font-weight: 800; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: .52; }
    .primary { color: #fffdf6; background: #126a6f; }
    .secondary { color: #17201d; background: #ded8ca; }
    .status { min-height: 22px; color: #5c6762; font-size: .94rem; }
    .intervention { margin-top: 18px; border: 1px solid #d8d3c6; border-radius: 8px; background: #fffcf4; padding: 12px; }
    .intervention strong { display: block; margin-bottom: 5px; }
    .intervention span { display: block; color: #5c6762; font-size: .94rem; overflow-wrap: anywhere; }
    .intervention.elevated { border-color: #d7a63b; background: #fff5d7; }
    .intervention.high { border-color: #c7472f; background: #f9ddd7; }
    @media (max-width: 620px) { h1 { font-size: 2.3rem; } }
  </style>
</head>
<body>
  <main>
    <h1>${site} is blocked.</h1>
    <p>The ${mode} lock is active. The useful move is to close this tab and go back to the thing you chose before impulse got loud.</p>
    <div class="intervention ${interventionClass}">
      <strong>Adaptive friction</strong>
      <span>${interventionCopy}</span>
      <span>${interventionTargets}</span>
    </div>
    <section class="break-panel">
      <h2>Intentional break</h2>
      <input id="breakReason" type="text" autocomplete="off" placeholder="${reasonPolicy.enabled ? `Reason (${reasonPolicy.minLength}+ chars)` : "Reason"}">
      <input id="breakPasscode" type="password" autocomplete="current-password" placeholder="Keyholder passcode">
      <div class="distance-row">
        <input id="breakDistanceKey" type="password" autocomplete="off" placeholder="Distance key">
        <button id="scanBreakDistanceKey" class="secondary" type="button">Scan</button>
      </div>
      <code id="breakChallenge" class="challenge"></code>
      <input id="breakChallengeInput" type="text" autocomplete="off" placeholder="Typing challenge" style="display:none">
      <div class="break-actions">
        <button id="requestBreak" class="primary" type="button"${breakDisabled}>Request Break</button>
        <button id="confirmBreak" class="secondary" type="button" disabled>Confirm</button>
      </div>
      <div id="breakStatus" class="status">${escapeHtml(initialStatus)}</div>
    </section>
    <p class="meta">Locked until ${until || "the session ends"}. Sentinel: <a href="http://127.0.0.1:${PORT}">open app</a></p>
  </main>
  <script>
    const pageData = ${safeScriptJson(pageData)};
    let pending = null;
    let timer = null;
    const reason = document.querySelector("#breakReason");
    const passcode = document.querySelector("#breakPasscode");
    const distanceKey = document.querySelector("#breakDistanceKey");
    const challenge = document.querySelector("#breakChallenge");
    const challengeInput = document.querySelector("#breakChallengeInput");
    const requestButton = document.querySelector("#requestBreak");
    const confirmButton = document.querySelector("#confirmBreak");
    const scanButton = document.querySelector("#scanBreakDistanceKey");
    const status = document.querySelector("#breakStatus");
    let scanStream = null;

    reason.addEventListener("input", syncRequestButton);
    syncRequestButton();

    requestButton.addEventListener("click", async () => {
      if (!reasonReady()) {
        status.textContent = "Enter a reason of at least " + pageData.reasonGate.minLength + " characters.";
        syncRequestButton();
        return;
      }
      requestButton.disabled = true;
      try {
        const isAppLock = pageData.kind === "app-lock" && pageData.lockId;
        const body = isAppLock
          ? { lockId: pageData.lockId, reason: reason.value.trim() }
          : { reason: reason.value.trim() };
        const result = await postJson(isAppLock ? "/api/app-lock/unlock/request" : "/api/emergency/request", body);
        pending = result.request || result.pending;
        tick();
        timer = setInterval(tick, 500);
      } catch (error) {
        status.textContent = error.message;
        requestButton.disabled = false;
      }
    });

    confirmButton.addEventListener("click", async () => {
      if (!pending) return;
      confirmButton.disabled = true;
      try {
        const isAppLock = pageData.kind === "app-lock" && pageData.lockId;
        await postJson(isAppLock ? "/api/app-lock/unlock/confirm" : "/api/emergency/confirm", {
          requestId: pending.id,
          passcode: passcode.value,
          distanceKey: distanceKey.value,
          challengeText: challengeInput.value
        });
        status.textContent = "Break opened.";
        if (pageData.returnUrl) setTimeout(() => { location.href = pageData.returnUrl; }, 650);
      } catch (error) {
        status.textContent = error.message;
        tick();
      }
    });

    scanButton.addEventListener("click", async () => {
      if (!("BarcodeDetector" in window)) {
        status.textContent = "QR scanning is not available in this browser.";
        return;
      }
      scanButton.disabled = true;
      status.textContent = "Camera starting.";
      try {
        scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        const video = document.createElement("video");
        video.playsInline = true;
        video.muted = true;
        video.srcObject = scanStream;
        video.style.width = "100%";
        video.style.borderRadius = "8px";
        document.querySelector(".break-panel").append(video);
        await video.play();
        const detector = new BarcodeDetector({ formats: ["qr_code"] });
        const started = Date.now();
        const loop = async () => {
          const codes = await detector.detect(video).catch(() => []);
          const match = String(codes[0]?.rawValue || "").match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i);
          if (match) {
            distanceKey.value = match[0].toUpperCase();
            stopScanner(video);
            status.textContent = "Distance key scanned.";
            return;
          }
          if (Date.now() - started > 30000) {
            stopScanner(video);
            status.textContent = "No QR code found. Type the key instead.";
            return;
          }
          requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      } catch (error) {
        status.textContent = error.message || "Camera unavailable.";
        scanButton.disabled = false;
      }
    });

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "${CONTROL_INTENT_HEADER}": "${CONTROL_INTENT_VALUE}"
        },
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Request failed.");
      return result;
    }

    function stopScanner(video) {
      if (scanStream) {
        for (const track of scanStream.getTracks()) track.stop();
      }
      scanStream = null;
      scanButton.disabled = false;
      if (video) video.remove();
    }

    function tick() {
      if (!pending) return;
      renderChallenge();
      const seconds = Math.ceil((new Date(pending.eligibleAt).getTime() - Date.now()) / 1000);
      if (seconds > 0) {
        status.textContent = "Confirm in " + seconds + "s.";
        confirmButton.disabled = true;
      } else {
        status.textContent = "Ready to confirm.";
        confirmButton.disabled = false;
        clearInterval(timer);
      }
    }

    function reasonReady() {
      if (!pageData.reasonGate || !pageData.reasonGate.enabled) return true;
      return reason.value.replace(/\\s+/g, " ").trim().length >= pageData.reasonGate.minLength;
    }

    function syncRequestButton() {
      if (!requestButton || pending) return;
      requestButton.disabled = !pageData.emergencyAllowed || !reasonReady();
    }

    function renderChallenge() {
      if (pending && pending.challenge && pending.challenge.text) {
        challenge.style.display = "block";
        challengeInput.style.display = "block";
        challenge.textContent = "Type: " + pending.challenge.text;
      } else {
        challenge.style.display = "none";
        challengeInput.style.display = "none";
        challenge.textContent = "";
      }
    }
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function safeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026"
  })[char]);
}

function isProtectedSettingsMutation(body) {
  const guarded = new Set([
    "siteRedirectEnabled",
    "contentFilterEnabled",
    "browserNoiseBlockingEnabled",
    "appQuitEnabled",
    "strictBypassProtectionEnabled",
    "processSweepEnabled",
    "processSweepIntervalSeconds",
    "systemSleepLockEnabled",
    "systemSleepLockIntervalSeconds",
    "focusShortcutEnabled",
    "focusShortcutOnName",
    "focusShortcutOffName",
    "intentReasonEnabled",
    "intentReasonMinLength",
    "appQuitEscalationSeconds",
    "typingChallengeEnabled",
    "interventionEnabled",
    "interventionWindowMinutes",
    "interventionThreshold",
    "interventionExtraDelaySeconds",
    "interventionMaxExtraDelaySeconds",
    "foolproofModeEnabled",
    "strictByDefault",
    "activeProfileId",
    "protectedEditsEnabled",
    "protectedEditDelaySeconds",
    "protectedEditWindowMinutes"
  ]);
  return Object.keys(body || {}).some((key) => guarded.has(key));
}

function hardeningAudit({ hosts, agent, account, protection, monitor, foolproof, stateSeal, sourceSeal }) {
  const keyholder = keyholderSummary(state);
  const distanceKey = distanceKeySummary(state);
  const focusShortcut = focusShortcutSummary(state);
  const intentReason = intentReasonSummary(state);
  const runtime = integrityRuntimeSummary(state);
  const dynamicRules = extensionDynamicRulesReady(state);
  const extensionVersion = extensionVersionReady(state);
  const extensionSeen = extensionRecentlySeen();
  return [
    {
      id: "foolproof",
      label: "Foolproof mode",
      ok: foolproof.enabled && foolproof.ready,
      detail: foolproofDetail(foolproof)
    },
    {
      id: "state-seal",
      label: "State seal",
      ok: stateSeal.ok,
      detail: stateSealDetail(stateSeal)
    },
    {
      id: "source-seal",
      label: "Source seal",
      ok: sourceSeal.ok,
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
      ok: protection.enabled,
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
      detail: state.settings.contentFilterEnabled !== false ? "Short-form feeds such as Shorts, Reels, Explore, and Popular are blocked during locks." : "Content feature filters are disabled."
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
      ok: monitor.ok && !monitor.accessibilityLikelyMissing,
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
      ok: extensionSeen && extensionVersion.ok,
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
      ok: agent.loaded && agent.running && !agent.legacyInstalled,
      detail: launchAgentDetail(agent)
    },
    {
      id: "mac-account",
      label: "Mac account",
      ok: account?.username && !account.isAdmin,
      detail: accountDetail(account)
    },
    {
      id: "hosts",
      label: "Hosts block",
      ok: hosts.installed && !hosts.stale,
      detail: hostsDetail(hosts)
    }
  ];
}

function hardeningActions() {
  return {
    launchAgentInstall: {
      label: "Install Login Agent",
      method: "POST",
      path: "/api/hardening/launch-agent/install"
    },
    hostsApply: {
      label: "Apply Hosts Block",
      method: "POST",
      path: "/api/hardening/hosts/apply",
      command: `cd ${shellQuote(ROOT)} && npm run hosts:apply`
    },
    sourceSeal: {
      label: "Seal Source",
      command: `cd ${shellQuote(ROOT)} && npm run seal:source`
    },
    tamperClear: {
      label: "Clear Tamper Alarm",
      method: "POST",
      path: "/api/integrity/clear-tamper"
    },
    extensionLoad: {
      label: "Extension Folder",
      path: join(ROOT, "extension")
    }
  };
}

async function assertStrictLockAllowed(lockLevel, profile, options = {}) {
  if (lockLevel !== "deep" || !state.settings.foolproofModeEnabled) return;
  const now = new Date();
  const preflightState = profile ? strictPreflightState(profile, {
    mode: options.mode,
    lockLevel,
    now
  }) : state;
  const hosts = await hostsStatus(preflightState, now);
  const agent = await launchAgentStatus();
  const account = await currentMacAccountStatus();
  const stateSeal = await stateSealStatus(preflightState);
  const sourceSeal = await sourceSealStatus();
  assertFoolproofReadyForStrict(preflightState, { hosts, agent, account, monitor: monitor.status, stateSeal, sourceSeal }, now);
}

function strictPreflightState(profile, options = {}) {
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

function foolproofDetail(foolproof) {
  if (!foolproof.enabled) return "Strict locks can start before all hardening checks are ready.";
  if (foolproof.ready) return "Strict locks require all hardening checks and the checklist is ready.";
  return `${foolproof.blockers.length} hardening check${foolproof.blockers.length === 1 ? "" : "s"} must be fixed before strict locks can start.`;
}

function launchAgentDetail(agent) {
  if (agent.legacyInstalled) return "Legacy Local Screen Time login agent is still installed; reinstall the login agent to clean it up.";
  if (!agent.installed) return "Login persistence is not installed.";
  if (agent.running) return `Login persistence is running${agent.pid ? ` as PID ${agent.pid}` : ""}.`;
  if (agent.loaded) return "Login persistence is loaded but not currently running.";
  return "Login persistence plist exists but launchctl is not loading it.";
}

function hostsDetail(hosts) {
  if (hosts.partial) return "Hosts block markers are incomplete; re-apply hosts.";
  if (hosts.legacyInstalled) return "Legacy Local Screen Time hosts block is still installed; re-apply hosts to migrate it.";
  if (hosts.duplicate) return "Multiple managed hosts blocks are installed; re-apply hosts to consolidate them.";
  if (!hosts.installed) return "Hosts-file site block is not installed.";
  if (hosts.stale) return `Hosts block is stale (${hosts.installedEntries}/${hosts.expectedEntries} entries).`;
  return `Hosts-file site block is current (${hosts.installedEntries} entries).`;
}

function accountDetail(account) {
  if (!account?.username) return account?.detail || "Mac account type could not be checked.";
  return account.detail || (account.isAdmin ? `${account.username} is an admin account.` : `${account.username} is a standard account.`);
}

function stateSealDetail(stateSeal) {
  if (stateSeal.status === "bookkeeping-mismatch") return stateSeal.detail;
  if (stateSeal.ok) return stateSeal.lastSealedAt ? `State file is sealed (${stateSeal.lastSealedAt}).` : "State file is sealed.";
  if (stateSeal.tamperDetectedAt) return `Tampering was detected at ${stateSeal.tamperDetectedAt}.`;
  return stateSeal.detail || "State file integrity could not be verified.";
}

function sourceSealDetail(sourceSeal) {
  if (sourceSeal.ok) return sourceSeal.sealedAt ? `Source files are sealed (${sourceSeal.fileCount || 0} files, ${sourceSeal.sealedAt}).` : "Source files are sealed.";
  return sourceSeal.detail || "Source integrity seal is missing. Run npm run seal:source after reviewing local code.";
}

function distanceKeyDetail(distanceKey) {
  if (!distanceKey.enabled) return distanceKey.hasToken ? "Distance key is saved but not required." : "Physical-friction unlock token is disabled.";
  if (!distanceKey.hasToken) return "Distance key is enabled but no token has been generated.";
  if (distanceKey.hasKeyFile) return `Unlock confirms require the mounted key file (${distanceKey.keyFilePath}).`;
  return "Unlock confirms require the away-from-desk token.";
}

function extensionRecentlySeen() {
  return extensionRecentlySeenForState(state);
}

function serializeError(error) {
  return {
    error: error.message || String(error),
    blockers: error.blockers || undefined
  };
}

function errorStatus(error) {
  if (error instanceof ProtectionError || error instanceof FoolproofError || error instanceof IntentReasonError) {
    return error.status;
  }
  return Number.isInteger(error?.status) ? error.status : 500;
}

async function runLocalScript(name) {
  const scriptPath = join(ROOT, "scripts", name);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: ROOT,
      timeout: 15_000,
      maxBuffer: 1024 * 256
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    error.message = String(error.stderr || error.message || error).trim();
    throw error;
  }
}

async function runPrivilegedHostsApply() {
  const scriptPath = join(ROOT, "scripts", "apply-hosts.mjs");
  const command = `cd ${shellQuote(ROOT)} && ${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      cwd: ROOT,
      timeout: 120_000,
      maxBuffer: 1024 * 256
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    error.message = String(error.stderr || error.message || error).trim();
    throw error;
  }
}

async function waitForLaunchAgentRunning() {
  let latest = await launchAgentStatus();
  for (let attempt = 0; attempt < 10 && !latest.running; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    latest = await launchAgentStatus();
  }
  return latest;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
