import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { currentMacAccountStatus } from "./account.js";
import { apiRequestGuard, CONTROL_INTENT_HEADER, CONTROL_INTENT_VALUE, deviceUsageSyncAuthorization, extensionCorsHeaders, extensionRequestGuard, isTrustedExtensionRequest, publicHostGuard } from "./apiSecurity.js";
import { APP_NAME, DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID, PORT, SOFT_BLOCK_PROFILE_ID } from "./defaults.js";
import { addEvent, loadState, loadUsage, saveState, saveUsage, sanitizeSoftBlockProfile } from "./store.js";
import { assertTypingChallenge, attachTypingChallenge, TypingChallengeError } from "./challenge.js";
import { hostsStatus, buildHostsBlock, launchAgentPath, launchAgentStatus, managedBlockDomains, stateSealStatus } from "./hardening.js";
import { buildFirewallBlock, buildPfConfBlock, firewallStatus } from "./firewall.js";
import { startMonitor } from "./monitor.js";
import { activePolicy, activeProfile, activeSessionForDevice, clearSessionsById, emergencyUnlockAllowedForPolicy, listFromTextarea, normalizeDeviceTarget, normalizeDeviceTargets, panicLockProfile, profileById, sessionPhase, snapshotProfile } from "./policy.js";
import { AppLockError, appLockSummary, confirmAppLockUnlock, normalizeAppLock, requestAppLockUnlock } from "./appLocks.js";
import { deviceSummary } from "./devices.js";
import { assertDistanceKey, DistanceKeyError, distanceKeySummary, updateDistanceKeySettings } from "./distanceKey.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "./extensionPolicy.js";
import { focusShortcutDetail, focusShortcutSummary } from "./focusHooks.js";
import { assertFoolproofReadyForStrict, extensionDynamicRulesReady, extensionRecentlySeen as extensionRecentlySeenForState, extensionVersionReady, FoolproofError, foolproofSummary } from "./foolproof.js";
import { clearIntegrityTamper, integrityRuntimeSummary } from "./integrityLockdown.js";
import { assertIntentReason, IntentReasonError, intentReasonPolicy, intentReasonSummary } from "./intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "./intervention.js";
import { confirmIntentionalPause, IntentionalUseError, intentionalUseSummary, pausePageData, skipIntentionalPause, updateIntentionalUseAccountability, updateIntentionalUseGoal, upsertIntentionalUseRule } from "./intentionalUse.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, normalizeIosMdmSettings, publicIosMdmSettings, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated, normalizeIosSettings, publicIosSettings } from "./iosProfiles.js";
import { activeLimitBlocks, limitSummary, normalizeLimitRule } from "./limits.js";
import { openApp } from "./macos.js";
import { parsePlist, toPlist } from "./plist.js";
import { ProtectionError, assertProtectedEditAllowed, confirmMaintenanceWindow, protectionSummary, requestMaintenanceWindow } from "./protection.js";
import { distractionPresets } from "./presets.js";
import { focusReport } from "./reports.js";
import { assertKeyholderPasscode, KeyholderError, keyholderSummary, updateKeyholderSettings } from "./keyholder.js";
import { sentinelAppInfo, sentinelStateHeaders } from "./sentinelHealth.js";
import { sourceSealStatus } from "./sourceSeal.js";
import { clampNumber, weekKey } from "./time.js";
import { syncDeviceUsageSnapshot, usageSummary } from "./usage.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_HOST = "127.0.0.1";
const execFileAsync = promisify(execFile);

let startedAt = null;
let state = null;
let usage = null;
let monitor = null;
let server = null;
let activeHost = DEFAULT_HOST;
let activePort = PORT;

export async function startSentinelServer(options = {}) {
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

export async function stopSentinelServer() {
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
      sendHtml(response, blockedPage(url));
      return;
    }

    if (url.pathname === "/pause") {
      sendHtml(response, pausePage(url));
      return;
    }

    await serveStatic(response, url.pathname);
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
    stop: stopSentinelServer
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
  await startSentinelServer();
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

  if (method === "GET" && path === "/api/state") {
    const policy = activePolicy(state);
    const hosts = await hostsStatus(state);
    const firewall = await firewallStatus(state);
    const agent = await launchAgentStatus();
    const account = await currentMacAccountStatus();
    const stateSeal = await stateSealStatus(state);
    const sourceSeal = await sourceSealStatus();
    const protection = protectionSummary(state);
    const devices = await deviceSummary(state);
    const foolproof = foolproofSummary(state, { hosts, firewall, agent, account, monitor: monitor.status, stateSeal, sourceSeal });
    await saveState(state);
    sendJson(response, 200, {
      app: sentinelAppInfo({ port: activePort, startedAt }),
      state: publicState(state, policy),
      usage: usageSummary(usage, state),
      report: focusReport(usage, state),
      intentionalUse: intentionalUseSummary(state, usage),
      limits: limitSummary(state, usage),
      appLocks: appLockSummary(state),
      devices,
      protection,
      intervention: interventionSummary(state),
      monitor: monitor.status,
      presets: distractionPresets(),
      hardening: {
        hosts,
        firewall,
        launchAgent: agent,
        account,
        stateSeal,
        sourceSeal,
        launchAgentPath: launchAgentPath(),
        hostsBlock: await buildNetworkPreview(state),
        actions: hardeningActions(),
        foolproof,
        audit: hardeningAudit({ hosts, firewall, agent, account, protection, monitor: monitor.status, foolproof, stateSeal, sourceSeal })
      }
    }, sentinelStateHeaders());
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
    sendDownload(response, 200, profile, "sentinel-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
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
    sendDownload(response, 200, profile, "sentinel-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
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
    panicLock: current.panicLock || null,
    activeSessions: current.activeSessions || { computer: current.activeSession || null, phone: null },
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
    devicePolicies: publicDevicePolicies(current),
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
    enabled: Boolean(body.enabled),
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

function publicDevicePolicies(current) {
  return Object.fromEntries(DEVICE_TARGETS.map((target) => {
    const policy = activePolicy(current, new Date(), { device: target });
    return [target, policy ? {
      kind: policy.kind,
      session: policy.session,
      profile: policy.profile,
      schedule: policy.schedule || null,
      endsAt: policy.endsAt,
      phase: policy.phase || null
    } : null];
  }));
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

function commitmentLockError(policy) {
  if (policy?.kind === "integrity") {
    return "Integrity lockdown cannot be ended with an emergency unlock. Open a protected maintenance window after checking the alarm.";
  }
  if (policy?.kind === "panic") {
    return "Panic lockout cannot be ended early.";
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

function pausePage(url) {
  const requestId = url.searchParams.get("requestId") || "";
  const data = pausePageData(state, requestId);
  if (!data) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Pause expired</title>
  <style>${pausePageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Sentinel</p>
    <h1>Pause expired.</h1>
    <p>This intentional-use pause is no longer active. Open Sentinel or try the site again if you still mean it.</p>
    <a class="button" href="http://127.0.0.1:${PORT}">Open Sentinel</a>
  </main>
</body>
</html>`;
  }

  const pause = data.pause;
  const goal = data.goal || {};
  const budget = data.budget || {};
  const context = data.context || {};
  const replacements = (data.replacements || []).slice(0, 6);
  const budgetText = budget.budgetSeconds
    ? `${Math.round((budget.seconds || 0) / 60)} of ${Math.round(budget.budgetSeconds / 60)} min used today`
    : "No daily budget set";
  const buttons = replacements
    .map((item) => `<button class="choice" type="button" data-replacement="${escapeHtml(item)}">${escapeHtml(item)}</button>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Intentional Use</title>
  <style>${pausePageCss()}</style>
</head>
<body>
  <main>
    <p class="eyebrow">Intentional Use</p>
    <h1>Before ${escapeHtml(pause.targetLabel)}.</h1>
    <p class="lead">${escapeHtml(goal.statement || "Use screens on purpose, not by reflex.")}</p>
    <div class="timer">
      <strong id="countdown">${Math.max(0, data.waitSeconds || 0)}</strong>
      <span>slow seconds</span>
    </div>
    <div class="grid">
      <section>
        <h2>Use this for</h2>
        <input id="intention" type="text" autocomplete="off" placeholder="One clear reason">
        <select id="mood">
          <option value="">Current state</option>
          <option>Focused</option>
          <option>Bored</option>
          <option>Tired</option>
          <option>Anxious</option>
          <option>Avoiding something</option>
        </select>
      </section>
      <section>
        <h2>Or switch to</h2>
        <div class="choices">${buttons || '<button class="choice" type="button" data-replacement="Close this tab">Close this tab</button>'}</div>
      </section>
    </div>
    <div class="meta">
      <span>${escapeHtml(pause.ruleName)}</span>
      <span>${escapeHtml(budgetText)}</span>
      <span>${escapeHtml(context.message || "Normal pause")}</span>
    </div>
    <div class="actions">
      <button id="skip" class="secondary" type="button">Use replacement</button>
      <button id="continue" class="primary" type="button" disabled>Continue for ${Math.round(pause.sessionMinutes || 10)} min</button>
    </div>
    <p id="status" class="status">Breathe first. The continue button will unlock when the timer reaches zero.</p>
  </main>
  <script>
    const pageData = ${safeScriptJson({ requestId: pause.id, returnUrl: pause.returnUrl, waitSeconds: Math.max(0, data.waitSeconds || 0) })};
    const countdown = document.querySelector("#countdown");
    const continueButton = document.querySelector("#continue");
    const skipButton = document.querySelector("#skip");
    const status = document.querySelector("#status");
    const intention = document.querySelector("#intention");
    const mood = document.querySelector("#mood");
    let selectedReplacement = "";
    let remaining = pageData.waitSeconds || 0;

    document.querySelectorAll(".choice").forEach((button) => {
      button.addEventListener("click", () => {
        selectedReplacement = button.dataset.replacement || button.textContent;
        document.querySelectorAll(".choice").forEach((item) => item.classList.remove("selected"));
        button.classList.add("selected");
        status.textContent = "Replacement selected.";
      });
    });

    const timer = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      countdown.textContent = String(remaining);
      if (remaining <= 0) {
        clearInterval(timer);
        continueButton.disabled = false;
        status.textContent = "Ready. Continue only if this still matches the reason you wrote.";
      }
    }, 1000);
    if (remaining <= 0) continueButton.disabled = false;

    continueButton.addEventListener("click", async () => {
      continueButton.disabled = true;
      try {
        const result = await postJson("/api/intentional-use/pause/continue", {
          requestId: pageData.requestId,
          intention: intention.value,
          mood: mood.value
        });
        status.textContent = "Intentional window opened.";
        if (result.returnUrl) {
          setTimeout(() => { location.href = result.returnUrl; }, 350);
        } else if (result.launch?.ok) {
          status.textContent = "Intentional window opened in " + (result.pause?.app || result.pause?.targetLabel || "the app") + ".";
        } else {
          setTimeout(() => { location.href = "http://127.0.0.1:${PORT}"; }, 350);
        }
      } catch (error) {
        status.textContent = error.message;
        continueButton.disabled = false;
      }
    });

    skipButton.addEventListener("click", async () => {
      skipButton.disabled = true;
      try {
        await postJson("/api/intentional-use/pause/skip", {
          requestId: pageData.requestId,
          replacement: selectedReplacement || "Closed the loop",
          mood: mood.value
        });
        status.textContent = "Nice. Keep the replacement small and concrete.";
      } catch (error) {
        status.textContent = error.message;
        skipButton.disabled = false;
      }
    });

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "${CONTROL_INTENT_HEADER}": "${CONTROL_INTENT_VALUE}" },
        body: JSON.stringify(body)
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Request failed");
      return json;
    }
  </script>
</body>
</html>`;
}

function pausePageCss() {
  return `
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #15201c; background: #f5f1e8; }
    main { width: min(760px, calc(100vw - 32px)); padding: 44px 0; }
    h1 { margin: 0 0 12px; font-size: 3rem; line-height: .98; letter-spacing: 0; }
    h2 { margin: 0 0 10px; font-size: .95rem; letter-spacing: 0; }
    p { color: #53605b; line-height: 1.55; }
    .eyebrow { margin: 0 0 8px; color: #126a6f; font-weight: 900; text-transform: uppercase; letter-spacing: .12em; font-size: .72rem; }
    .lead { max-width: 620px; margin-bottom: 22px; }
    .timer { width: 156px; height: 156px; border-radius: 50%; border: 8px solid #126a6f; display: grid; place-items: center; margin: 16px 0 22px; background: #fffcf4; }
    .timer strong { display: block; font-size: 3rem; line-height: 1; text-align: center; }
    .timer span { display: block; color: #6a746f; font-weight: 800; font-size: .78rem; text-transform: uppercase; letter-spacing: .1em; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    section { border-top: 1px solid #d9d0bf; padding-top: 14px; }
    input, select { box-sizing: border-box; width: 100%; min-height: 46px; border: 1px solid #c8c0b2; border-radius: 6px; padding: 0 12px; background: #fffcf4; color: inherit; font: inherit; margin-bottom: 10px; }
    button, .button { min-height: 44px; border: 0; border-radius: 6px; padding: 0 15px; font: inherit; font-weight: 900; cursor: pointer; text-decoration: none; display: inline-grid; place-items: center; }
    button:disabled { opacity: .52; cursor: not-allowed; }
    .primary { color: #fffdf6; background: #126a6f; }
    .secondary, .choice, .button { color: #17201d; background: #ded7c9; }
    .choices { display: grid; gap: 8px; }
    .choice { justify-content: start; text-align: left; }
    .choice.selected { background: #d6eadc; outline: 2px solid #28734f; }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 18px; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
    .meta span { border: 1px solid #d5ccb9; border-radius: 999px; padding: 7px 10px; color: #53605b; background: #fffcf4; font-size: .88rem; }
    .status { min-height: 24px; margin-top: 14px; }
    @media (max-width: 680px) { h1 { font-size: 2.2rem; } .grid { grid-template-columns: 1fr; } .timer { width: 128px; height: 128px; } }
  `;
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

function hardeningAudit({ hosts, firewall, agent, account, protection, monitor, foolproof, stateSeal, sourceSeal }) {
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
      ok: hosts.installed && !hosts.partial && !hosts.stale,
      detail: hostsDetail(hosts)
    },
    {
      id: "firewall",
      label: "PF firewall",
      ok: firewall.installed && !firewall.partial && !firewall.stale,
      detail: firewallDetail(firewall)
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

async function buildNetworkPreview(state) {
  const domains = managedBlockDomains(state);
  return [
    buildHostsBlock(state),
    "",
    buildPfConfBlock(),
    "",
    buildFirewallBlock(domains)
  ].join("\n");
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
  const firewall = await firewallStatus(preflightState, now);
  const agent = await launchAgentStatus();
  const account = await currentMacAccountStatus();
  const stateSeal = await stateSealStatus(preflightState);
  const sourceSeal = await sourceSealStatus();
  assertFoolproofReadyForStrict(preflightState, { hosts, firewall, agent, account, monitor: monitor.status, stateSeal, sourceSeal }, now);
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
  if (hosts.partial) return "Hosts block markers are incomplete; re-apply the network block.";
  if (hosts.legacyInstalled) return "Legacy Local Screen Time hosts block is still installed; re-apply the network block to migrate it.";
  if (hosts.duplicate) return "Multiple managed hosts blocks are installed; re-apply the network block to consolidate them.";
  if (!hosts.installed) return "Hosts-file site block is not installed.";
  if (hosts.stale) return `Hosts block is stale (${hosts.installedEntries}/${hosts.expectedEntries} entries).`;
  return `Hosts-file site block is current (${hosts.installedEntries} entries).`;
}

function firewallDetail(firewall) {
  if (firewall.partial) return "PF firewall markers are incomplete; re-apply the network block.";
  if (!firewall.installed) return "PF firewall anchor is not installed.";
  if (firewall.stale) return `PF firewall block is stale (${firewall.installedEntries}/${firewall.expectedDomainCount} domain targets).`;
  return `PF firewall anchor is current (${firewall.installedEntries} address rules).`;
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
  const scriptPath = resourcePath("scripts", name);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath], {
      cwd: processCwd(),
      env: localScriptEnv(),
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
  const scriptPath = resourcePath("scripts", "apply-hosts.mjs");
  const command = `cd ${shellQuote(processCwd())} && ${localScriptShellEnvPrefix()}${shellQuote(process.execPath)} ${shellQuote(scriptPath)}`;
  const script = `do shell script ${appleScriptString(command)} with administrator privileges`;
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      cwd: processCwd(),
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

function isElectronRuntime() {
  return Boolean(process.versions.electron);
}

function localScriptCommand(name, options = {}) {
  if (!isElectronRuntime()) {
    const command = options.npmScript ? `npm run ${options.npmScript}` : `${shellQuote(process.execPath)} ${shellQuote(join(ROOT, "scripts", name))}`;
    return `cd ${shellQuote(ROOT)} && ${command}`;
  }

  const command = `${localScriptShellEnvPrefix()}${shellQuote(process.execPath)} ${shellQuote(resourcePath("scripts", name))}`;
  return `${options.privileged ? "sudo " : ""}${command}`;
}

function localScriptEnv() {
  return {
    ...process.env,
    ...localScriptEnvOverrides()
  };
}

function localScriptEnvOverrides() {
  const overrides = {};
  if (isElectronRuntime()) overrides.ELECTRON_RUN_AS_NODE = "1";
  if (process.env.SENTINEL_DATA_DIR) overrides.SENTINEL_DATA_DIR = process.env.SENTINEL_DATA_DIR;
  if (process.env.SENTINEL_PORT) overrides.SENTINEL_PORT = process.env.SENTINEL_PORT;
  if (process.env.SCREEN_TIME_PORT) overrides.SCREEN_TIME_PORT = process.env.SCREEN_TIME_PORT;
  return overrides;
}

function localScriptShellEnvPrefix() {
  const entries = Object.entries(localScriptEnvOverrides());
  return entries.length ? `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} ` : "";
}

function processCwd() {
  return ROOT.includes(".asar") ? dirname(ROOT) : ROOT;
}

function resourcePath(...parts) {
  const root = ROOT.includes(".asar")
    ? ROOT.replace(/\.asar(?=\/|$)/, ".asar.unpacked")
    : ROOT;
  return join(root, ...parts);
}
