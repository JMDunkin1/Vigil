import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { apiRequestGuard, deviceUsageSyncAuthorization, extensionCorsHeaders, extensionRequestGuard, isTrustedExtensionRequest, publicHostGuard } from "./apiSecurity.js";
import { parseBoolean, truthy } from "./booleans.js";
import { APP_NAME, DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID, PORT, SOFT_BLOCK_PROFILE_ID } from "./defaults.js";
import { addEvent, loadState, loadUsage, saveState, saveUsage, sanitizeSoftBlockProfile } from "./store.js";
import { assertTypingChallenge, attachTypingChallenge, TypingChallengeError } from "./challenge.js";
import { hostsStatus, launchAgentStatus } from "./hardening.js";
import { firewallStatus } from "./firewall.js";
import { startMonitor } from "./monitor.js";
import { activePolicy, activeSessionForDevice, clearSessionsById, emergencyUnlockAllowedForPolicy, listFromTextarea, normalizeDeviceTarget, normalizeDeviceTargets, panicLockProfile, profileById, snapshotProfile } from "./policy.js";
import { AppLockError, confirmAppLockUnlock, normalizeAppLock, requestAppLockUnlock } from "./appLocks.js";
import { assertDistanceKey, DistanceKeyError, updateDistanceKeySettings } from "./distanceKey.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "./extensionPolicy.js";
import { FoolproofError } from "./foolproof.js";
import { clearIntegrityTamper } from "./integrityLockdown.js";
import { assertIntentReason, IntentReasonError } from "./intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "./intervention.js";
import { confirmIntentionalPause, IntentionalUseError, skipIntentionalPause, updateIntentionalUseAccountability, updateIntentionalUseGoal, upsertIntentionalUseRule } from "./intentionalUse.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, normalizeIosMdmSettings, publicIosMdmSettings, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated, normalizeIosSettings } from "./iosProfiles.js";
import { activeLimitBlocks, normalizeLimitRule } from "./limits.js";
import { openApp } from "./macos.js";
import { parsePlist } from "./plist.js";
import { ProtectionError, assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "./protection.js";
import { assertKeyholderPasscode, KeyholderError, updateKeyholderSettings } from "./keyholder.js";
import { clampNumber, weekKey } from "./time.js";
import { syncDeviceUsageSnapshot, usageSummary } from "./usage.js";
import { readBody, readTextBody, sendDownload, sendEmpty, sendHtml, sendJson, sendMdmPlist, serveStatic, mdmHeaders } from "./server/http.js";
import { createLocalScriptRunner } from "./server/localScripts.js";
import { blockedPage, commitmentLockError, pausePage } from "./server/pages.js";
import { isExtensionApiPath, matchApiRoute } from "./server/apiRoutes.js";
import { buildStatePayload, publicIosState, strictPreflightStatus } from "./server/statePayload.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_HOST = "127.0.0.1";
const localScripts = createLocalScriptRunner({ root: ROOT, launchAgentStatus });

let startedAt = null;
let state = null;
let usage = null;
let monitor = null;
let server = null;
let activeHost = DEFAULT_HOST;
let activePort = PORT;

export async function startVigilServer(options = {}) {
  if (server?.listening) {
    return serverHandle();
  }

  activeHost = options.host || DEFAULT_HOST;
  activePort = Number(options.port ?? PORT);
  startedAt = new Date().toISOString();
  state = await loadState();
  usage = await loadUsage();
  monitor = startMonitor({ state, usage });
  server = createServer(requestHandler);

  await new Promise((resolveListen, rejectListen) => {
    function onError(error) {
      server.off("listening", onListening);
      rejectListen(error);
    }

    function onListening() {
      server.off("error", onError);
      const address = server.address();
      if (address && typeof address === "object") activePort = address.port;
      resolveListen();
    }

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(activePort, activeHost);
  });

  console.log(`${APP_NAME} running at http://${activeHost}:${activePort}`);
  return serverHandle();
}

export async function stopVigilServer() {
  await shutdown({ exit: false });
}

async function requestHandler(request, response) {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${activeHost}:${activePort}`}`);
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
      sendHtml(response, blockedPage({ url, state, port: activePort }));
      return;
    }

    if (url.pathname === "/pause") {
      sendHtml(response, pausePage({ url, state, port: activePort }));
      return;
    }

    await serveStatic(response, url.pathname, { publicDir: PUBLIC_DIR });
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error));
  }
}

function serverHandle() {
  return {
    host: activeHost,
    port: activePort,
    url: `http://${activeHost}:${activePort}`,
    server,
    monitor,
    stop: stopVigilServer
  };
}

async function shutdown({ exit = true } = {}) {
  monitor?.stop();
  if (state) await saveState(state);
  if (server?.listening) {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
  server = null;
  monitor = null;
  state = null;
  usage = null;
  if (exit) process.exit(0);
}

if (isDirectRun()) {
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  await startVigilServer();
}

function isDirectRun() {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
}

function scheduleImmediateSessionEnforcement(sessionId) {
  setImmediate(async () => {
    if (!sessionIsActive(sessionId) && state.panicLock?.id !== sessionId) return;

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

function scheduleIosMdmPush(reason, options = {}) {
  setImmediate(async () => {
    if (!state) return;
    let result;
    try {
      result = await pushIosMdmQueuedCommands(state, reason, new Date(), options);
      if (result.pushed || result.failed) {
        addEvent(state, "ios_mdm_push", { reason, ...result });
      }
      await saveState(state);
    } catch (error) {
      addEvent(state, "ios_mdm_push_failed", {
        reason,
        error: error.message || String(error)
      });
      try {
        await saveState(state);
      } catch (saveError) {
        console.error("MDM push failure save failed:", saveError);
      }
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
    sendDownload(response, 200, profile, "vigil-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "GET" && path === "/mdm/policy.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state);
    markIosProfileGenerated(state);
    addEvent(state, "ios_public_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "vigil-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
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
    if (result.messageType === "TokenUpdate" && result.udid) {
      scheduleIosMdmPush("checkin", { force: true, udids: [result.udid] });
    }
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

  if (!matchApiRoute(method, path)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (method === "GET" && path === "/api/state") {
    const payload = await buildStatePayload({ state, usage, monitor, activePort, startedAt, localScripts });
    await saveState(state);
    sendJson(response, 200, payload.body, payload.headers);
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
    if (result.paused && result.event !== "heartbeat") {
      addEvent(state, "intentional_pause_requested", {
        site: result.hostname,
        ruleId: result.rule?.id,
        ruleName: result.rule?.name,
        pauseId: result.pause?.id
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

  if (method === "POST" && path === "/api/panic/start") {
    activePolicy(state);
    const durationMinutes = panicLockDurationMinutes();
    const started = new Date();
    const ends = new Date(started.getTime() + durationMinutes * 60 * 1000);
    const profile = panicLockProfile();
    state.panicLock = {
      id: randomUUID(),
      title: "Panic Lockout",
      mode: "panic",
      profileId: PANIC_LOCK_PROFILE_ID,
      lockLevel: "deep",
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      canEndEarly: false,
      commitmentLock: true,
      emergencyUnlocksAllowed: false,
      source: "panic",
      fullLockout: true,
      profileSnapshot: snapshotProfile(profile)
    };
    addEvent(state, "panic_lock_started", { ...state.panicLock, durationMinutes });
    recordIosMdmPolicyQueue("panic-start");
    await saveState(state);
    scheduleImmediateSessionEnforcement(state.panicLock.id);
    sendJson(response, 200, { ok: true, session: state.panicLock });
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
      const result = await localScripts.runLocalScript("install-launch-agent.mjs");
      addEvent(state, "launch_agent_installed", { ok: true });
      await saveState(state);
      const launchAgent = await localScripts.waitForLaunchAgentRunning();
      sendJson(response, 200, { ok: true, result, launchAgent });
    } catch (error) {
      sendJson(response, 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/hardening/hosts/apply") {
    try {
      const result = await localScripts.runPrivilegedHostsApply();
      const hosts = await hostsStatus(state);
      const firewall = await firewallStatus(state);
      addEvent(state, "network_block_applied", {
        ok: hosts.installed && !hosts.stale && firewall.installed && !firewall.stale,
        hostsEntries: hosts.installedEntries || 0,
        firewallEntries: firewall.installedEntries || 0
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, result, hosts, firewall });
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
    sendDownload(response, 200, profile, "vigil-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "POST" && path === "/api/devices/ios/mdm/queue-policy") {
    const result = queueIosMdmPolicyRefresh(state, "app-refresh");
    const push = await pushIosMdmQueuedCommands(state, "app-refresh", new Date(), { force: true });
    addEvent(state, "ios_mdm_policy_queued", result);
    if (push.pushed || push.failed) addEvent(state, "ios_mdm_push", push);
    await saveState(state);
    sendJson(response, 200, { ok: Boolean(result.queued || push.pushed), result, push });
    return;
  }

  if (method === "GET" && path === "/api/devices/ios/profile.mobileconfig") {
    ensureIosRemovalPassword(state);
    const profile = buildIosConfigurationProfile(state);
    markIosProfileGenerated(state);
    addEvent(state, "ios_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(state);
    sendDownload(response, 200, profile, "vigil-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "POST" && path === "/api/devices/usage") {
    const body = await readBody(request);
    const authorization = deviceUsageSyncAuthorization({
      headers: request.headers,
      url,
      body,
      enrollmentSecret: state.deviceControls?.ios?.mdm?.enrollmentSecret
    });
    if (!authorization.ok) {
      sendJson(response, authorization.status || 403, { error: authorization.error || "Forbidden" });
      return;
    }

    const result = syncDeviceUsageSnapshot(usage, body, new Date(), {
      allowedDevices: authorization.kind === "device-token" ? ["phone"] : DEVICE_TARGETS
    });
    addEvent(state, "device_usage_synced", {
      device: result.device,
      dayKey: result.dayKey,
      totalSeconds: result.deviceTotalSeconds
    });
    await saveUsage(usage);
    await saveState(state);
    sendJson(response, 200, { ok: true, result, usage: usageSummary(usage, state) });
    return;
  }

  if (method === "POST" && path === "/api/intentional-use/goal") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const goal = updateIntentionalUseGoal(state, body);
      addEvent(state, "intentional_goal_saved", { values: goal.values?.length || 0, replacements: goal.replacements?.length || 0 });
      await saveState(state);
      sendJson(response, 200, { ok: true, goal });
    } catch (error) {
      sendJson(response, error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/intentional-use/accountability") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const accountability = updateIntentionalUseAccountability(state, body);
      addEvent(state, "intentional_accountability_saved", { enabled: accountability.enabled, cadence: accountability.cadence });
      await saveState(state);
      sendJson(response, 200, { ok: true, accountability });
    } catch (error) {
      sendJson(response, error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/intentional-use/rule") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(state, { kind: "settings" });
      const rule = upsertIntentionalUseRule(state, body);
      addEvent(state, "intentional_rule_saved", { ruleId: rule.id, name: rule.name, enabled: rule.enabled });
      await saveState(state);
      sendJson(response, 200, { ok: true, rule });
    } catch (error) {
      sendJson(response, error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/intentional-use/rule/")) {
    try {
      const id = decodeURIComponent(path.split("/").at(-1));
      assertProtectedEditAllowed(state, { kind: "settings" });
      state.intentionalUse ||= {};
      state.intentionalUse.rules = (state.intentionalUse.rules || []).filter((rule) => rule.id !== id);
      state.intentionalUse.pauses = (state.intentionalUse.pauses || []).filter((pause) => pause.ruleId !== id);
      state.intentionalUse.grants = (state.intentionalUse.grants || []).filter((grant) => grant.ruleId !== id);
      addEvent(state, "intentional_rule_deleted", { ruleId: id });
      await saveState(state);
      sendJson(response, 200, { ok: true });
    } catch (error) {
      sendJson(response, error instanceof ProtectionError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/intentional-use/pause/continue") {
    try {
      const body = await readBody(request);
      const result = confirmIntentionalPause(state, body.requestId, body);
      const launch = result.pause.targetType === "app" && result.pause.app
        ? await openApp(result.pause.app)
        : null;
      addEvent(state, "intentional_pause_continued", {
        pauseId: result.pause.id,
        ruleId: result.pause.ruleId,
        target: result.pause.targetLabel,
        until: result.grant.until,
        launch
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, ...result, launch });
    } catch (error) {
      sendJson(response, error instanceof IntentionalUseError ? error.status : 500, serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/intentional-use/pause/skip") {
    try {
      const body = await readBody(request);
      const result = skipIntentionalPause(state, body.requestId, body);
      addEvent(state, "intentional_pause_skipped", {
        pauseId: result.pause.id,
        ruleId: result.pause.ruleId,
        target: result.pause.targetLabel,
        replacement: result.pause.replacement
      });
      await saveState(state);
      sendJson(response, 200, { ok: true, ...result });
    } catch (error) {
      sendJson(response, error instanceof IntentionalUseError ? error.status : 500, serializeError(error));
    }
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
    const deviceTargets = normalizeSessionDeviceTargets(body);
    const conflicts = activeSessionConflicts(deviceTargets);
    if (conflicts.length) {
      sendJson(response, 409, { error: `A session is already active for ${deviceLabel(conflicts)}.`, active: conflicts.map((target) => state.activeSessions?.[target] || state.activeSession) });
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

    const session = {
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
      deviceTargets,
      profileSnapshot: snapshotProfile(profile)
    };
    startDeviceSession(deviceTargets, session);
    addEvent(state, "session_started", session);
    if (deviceTargets.includes("phone")) recordIosMdmPolicyQueue("session-start");
    await saveState(state);
    scheduleImmediateSessionEnforcement(session.id);
    sendJson(response, 200, { ok: true, session, activeSessions: state.activeSessions });
    return;
  }

  if (method === "POST" && path === "/api/session/end") {
    const body = await readBody(request);
    activePolicy(state);
    const deviceTargets = normalizeSessionDeviceTargets(body, ["computer"]);
    const ended = [];
    for (const target of deviceTargets) {
      const session = activeSessionForDevice(state, target);
      if (!session) continue;
      if (!session.canEndEarly) {
        sendJson(response, 423, { error: `The ${target} session is locked. Use an emergency unlock if you really need to end it.`, active: session });
        return;
      }

      clearDeviceSession(target);
      ended.push({ target, session });
      addEvent(state, "session_ended", { ...session, endedTarget: target });
    }

    if (ended.some((item) => item.target === "phone")) {
      recordIosMdmPolicyQueue("session-end");
    }

    await saveState(state);
    sendJson(response, 200, { ok: true, ended: Boolean(ended.length), endedTargets: ended.map((item) => item.target), activeSessions: state.activeSessions });
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

    if (pending.activeKind === "manual") {
      clearSessionsById(state, pending.sessionId);
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

function updateSettings(body) {
  const allowed = new Set([
    "pollIntervalMs",
    "strictByDefault",
    "emergencyTokensPerWeek",
    "emergencyDelaySeconds",
    "panicLockDurationMinutes",
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
    "intentionalUseEnabled",
    "baselineDailyMinutes",
    "focusScoreGoal",
    "activeProfileId",
    "baselineProfileId",
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
      state.settings[key] = parseBoolean(value, state.settings[key]);
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
  if (key === "panicLockDurationMinutes") return { min: 1, max: 1440 };
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
    allowedSites: normalizeArray(body.allowedSites ?? existing?.allowedSites),
    phoneAppBlocking: optionalDisabledFlag(body.phoneAppBlocking, existing?.phoneAppBlocking),
    hostsUrlPatternBlocking: optionalDisabledFlag(body.hostsUrlPatternBlocking, existing?.hostsUrlPatternBlocking)
  };
  const nextProfile = id === SOFT_BLOCK_PROFILE_ID ? sanitizeSoftBlockProfile(profile) : profile;

  if (existing) Object.assign(existing, nextProfile);
  else state.profiles.push(nextProfile);

  state.settings.activeProfileId = nextProfile.id;
  return nextProfile;
}

function upsertSchedule(body) {
  const id = body.id || randomUUID();
  const existing = state.schedules.find((item) => item.id === id);
  const schedule = {
    id,
    name: String(body.name || existing?.name || "Focus schedule").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    mode: body.mode || existing?.mode || "focus",
    profileId: body.profileId || existing?.profileId || state.settings.activeProfileId,
    lockLevel: body.lockLevel || existing?.lockLevel || "deep",
    commitmentLock: body.commitmentLock === undefined ? Boolean(existing?.commitmentLock) : truthy(body.commitmentLock),
    deviceTargets: normalizeDeviceTargets(body.deviceTargets ?? existing?.deviceTargets, DEVICE_TARGETS),
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

function panicLockDurationMinutes() {
  return clampNumber(state.settings?.panicLockDurationMinutes, 1, 1440, 3);
}

function normalizeSessionDeviceTargets(body, fallback = DEVICE_TARGETS) {
  if (Array.isArray(body?.deviceTargets) || typeof body?.deviceTargets === "string") {
    return normalizeDeviceTargets(body.deviceTargets, fallback);
  }

  const selected = [];
  if (truthy(body?.targetComputer) || truthy(body?.computer)) selected.push("computer");
  if (truthy(body?.targetPhone) || truthy(body?.phone)) selected.push("phone");
  return normalizeDeviceTargets(selected, fallback);
}

function optionalDisabledFlag(value, existing) {
  if (value === undefined) return existing === false ? false : undefined;
  return value === false || value === "false" ? false : undefined;
}

function activeSessionConflicts(targets) {
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  return targets.filter((target) => Boolean(activeSessionForDevice(state, target)));
}

function startDeviceSession(targets, session) {
  state.activeSessions ||= { computer: null, phone: null };
  for (const target of targets) {
    state.activeSessions[target] = session;
  }
  state.activeSession = state.activeSessions.computer || null;
}

function clearDeviceSession(target) {
  const device = normalizeDeviceTarget(target);
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  state.activeSessions[device] = null;
  state.activeSession = state.activeSessions.computer || null;
}

function sessionIsActive(sessionId) {
  if (!sessionId) return false;
  if (state.activeSession?.id === sessionId) return true;
  return DEVICE_TARGETS.some((target) => state.activeSessions?.[target]?.id === sessionId);
}

function deviceLabel(targets) {
  return targets.map((target) => target === "phone" ? "phone" : "computer").join(" and ");
}

function spendEmergencyToken() {
  const key = weekKey();
  state.emergency.tokensUsedByWeek[key] = (state.emergency.tokensUsedByWeek[key] || 0) + 1;
}

function recordIosMdmPolicyQueue(reason) {
  const result = queueIosMdmPolicyRefresh(state, reason);
  if (result.queued) {
    addEvent(state, "ios_mdm_policy_queued", { reason, ...result });
    scheduleIosMdmPush(reason);
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
    "intentionalUseEnabled",
    "foolproofModeEnabled",
    "strictByDefault",
    "activeProfileId",
    "baselineProfileId",
    "panicLockDurationMinutes",
    "protectedEditsEnabled",
    "protectedEditDelaySeconds",
    "protectedEditWindowMinutes"
  ]);
  return Object.keys(body || {}).some((key) => guarded.has(key));
}

async function assertStrictLockAllowed(lockLevel, profile, options = {}) {
  if (lockLevel !== "deep" || !state.settings.foolproofModeEnabled) return;
  await strictPreflightStatus(state, profile, {
    mode: options.mode,
    lockLevel,
    monitorStatus: monitor.status
  });
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
