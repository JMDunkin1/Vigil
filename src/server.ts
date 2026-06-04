import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { apiRequestGuard, publicHostGuard } from "./apiSecurity.js";
import { parseBoolean, truthy } from "./booleans.js";
import { APP_NAME, DEVICE_TARGETS, PANIC_LOCK_PROFILE_ID, PORT, SOFT_BLOCK_PROFILE_ID, defaultState } from "./defaults.js";
import { addEvent, loadState, loadUsage, saveState, sanitizeSoftBlockProfile } from "./store.js";
import { assertTypingChallenge, attachTypingChallenge } from "./challenge.js";
import { launchAgentStatus } from "./hardening.js";
import { normalizeGrayscaleSchedule, normalizeGrayscaleState } from "./grayscale.js";
import { startMonitor } from "./monitor.js";
import { activePolicy, activeSessionForDevice, clearSessionsById, emergencyUnlockAllowedForPolicy, listFromTextarea, normalizeDeviceTarget, normalizeDeviceTargets, normalizeLockLevel, panicLockProfile, profileById, snapshotProfile } from "./policy.js";
import { confirmAppLockUnlock, normalizeAppLock, requestAppLockUnlock } from "./appLocks.js";
import { assertDistanceKey, updateDistanceKeySettings } from "./distanceKey.js";
import { assertIntentReason } from "./intentReason.js";
import { emergencyDelaySeconds, interventionSummary } from "./intervention.js";
import { completeIntentionalPlanBlock } from "./intentionalUse.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated } from "./iosProfiles.js";
import { activeLimitBlocks, normalizeLimitRule } from "./limits.js";
import { parsePlist } from "./plist.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "./protection.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "./keyholder.js";
import { clampNumber, weekKey } from "./time.js";
import { readBody, readTextBody, sendDownload, sendEmpty, sendHtml, sendJson, sendMdmPlist, serveStatic, mdmHeaders } from "./server/http.js";
import { createLocalScriptRunner } from "./server/localScripts.js";
import { blockedPage, commitmentLockError, pausePage } from "./server/pages.js";
import { matchApiRoute } from "./server/apiRoutes.js";
import { handleDeviceApiRoute } from "./server/deviceRoutes.js";
import type { IosMdmPushResult } from "./server/deviceRoutes.js";
import { handleExtensionApiRoute } from "./server/extensionApi.js";
import { handleHardeningApiRoute } from "./server/hardeningRoutes.js";
import { handleIntentionalUseApiRoute } from "./server/intentionalUseRoutes.js";
import { buildStatePayload, strictPreflightStatus } from "./server/statePayload.js";
import type {
  AppLockRule,
  DeviceTarget,
  GrayscaleSchedule,
  LimitRule,
  LockLevel,
  MonitorHandle,
  Profile,
  ProfileMode,
  Schedule,
  VigilState,
  Session,
  SessionCycle,
  UnknownRecord,
  UsageState
} from "./types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const DEFAULT_HOST = "127.0.0.1";
const localScripts = createLocalScriptRunner({ root: ROOT, launchAgentStatus });

let startedAt: string | null = null;
let state: VigilState = defaultState();
let usage: UsageState = {};
let monitor: MonitorHandle | null = null;
let server: Server | null = null;
let activeHost = DEFAULT_HOST;
let activePort = PORT;

interface ServerOptions {
  host?: string;
  port?: number | string;
}

type RequestBody = UnknownRecord;

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
}

interface LimitBlockSummary {
  id: string;
  until: string;
}

export async function startVigilServer(options: ServerOptions = {}) {
  if (server?.listening) {
    return serverHandle();
  }

  activeHost = options.host || DEFAULT_HOST;
  activePort = Number(options.port ?? PORT);
  startedAt = new Date().toISOString();
  state = await loadState();
  usage = await loadUsage();
  monitor = startMonitor({ state, usage }) as unknown as MonitorHandle;
  server = createServer(requestHandler);

  await new Promise<void>((resolveListen, rejectListen) => {
    const currentServer = requireServer();
    function onError(error: Error) {
      currentServer.off("listening", onListening);
      rejectListen(error);
    }

    function onListening() {
      currentServer.off("error", onError);
      const address = currentServer.address();
      if (address && typeof address === "object") activePort = address.port;
      resolveListen();
    }

    currentServer.once("error", onError);
    currentServer.once("listening", onListening);
    currentServer.listen(activePort, activeHost);
  });

  console.log(`${APP_NAME} running at http://${activeHost}:${activePort}`);
  return serverHandle();
}

export async function stopVigilServer(): Promise<void> {
  await shutdown({ exit: false });
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${activeHost}:${activePort}`}`);
    const hostGuard = publicHostGuard({ path: url.pathname, headers: request.headers }) as GuardResult;
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

async function shutdown({ exit = true }: { exit?: boolean } = {}): Promise<void> {
  monitor?.stop();
  await saveState(state);
  if (server?.listening) {
    const currentServer = server;
    await new Promise<void>((resolveClose) => {
      currentServer.close(() => resolveClose());
    });
  }
  server = null;
  monitor = null;
  state = defaultState();
  usage = {};
  if (exit) process.exit(0);
}

if (isDirectRun()) {
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  await startVigilServer();
}

function isDirectRun(): boolean {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));
}

function scheduleImmediateSessionEnforcement(sessionId: string): void {
  setImmediate(async () => {
    if (!sessionIsActive(sessionId) && state.panicLock?.id !== sessionId) return;

    let event: UnknownRecord;
    try {
      const result = await requireMonitor().enforceImmediately("session-start");
      event = { sessionId, ok: true, result };
    } catch (error) {
      event = { sessionId, ok: false, error: errorMessage(error) };
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

function schedulePolicyEnforcement(reason: string): void {
  setImmediate(async () => {
    let event: UnknownRecord;
    try {
      const result = await requireMonitor().enforceImmediately(reason);
      event = { reason, ok: true, result };
    } catch (error) {
      event = { reason, ok: false, error: errorMessage(error) };
      console.error("Immediate policy enforcement failed:", error);
    }

    addEvent(state, "policy_immediate_enforcement", event);
    try {
      await saveState(state);
    } catch (error) {
      console.error("Immediate policy enforcement event save failed:", error);
    }
  });
}

function scheduleIosMdmPush(reason: string, options: UnknownRecord = {}): void {
  setImmediate(async () => {
    if (!state) return;
    let result: IosMdmPushResult;
    try {
      result = await pushIosMdmQueuedCommands(state, reason, new Date(), options) as IosMdmPushResult;
      if (result.pushed || result.failed) {
        addEvent(state, "ios_mdm_push", { reason, ...result });
      }
      await saveState(state);
    } catch (error) {
      addEvent(state, "ios_mdm_push_failed", {
        reason,
        error: errorMessage(error)
      });
      try {
        await saveState(state);
      } catch (saveError) {
        console.error("MDM push failure save failed:", saveError);
      }
    }
  });
}

async function handleMdm(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
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
    const body = parsePlist(await readTextBody(request)) as UnknownRecord;
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
    const body = parsePlist(await readTextBody(request)) as UnknownRecord;
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

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  const method = request.method || "GET";
  const path = url.pathname;
  const guard = apiRequestGuard({ method, path, headers: request.headers }) as GuardResult;
  if (!guard.ok) {
    sendJson(response, guard.status || 403, { error: guard.error || "Forbidden" });
    return;
  }

  if (await handleExtensionApiRoute(request, response, url, { state, usage })) {
    return;
  }

  if (!matchApiRoute(method, path)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (method === "GET" && path === "/api/state") {
    const payload = await buildStatePayload({ state, usage, monitor: requireMonitor(), activePort, startedAt, localScripts });
    await saveState(state);
    sendJson(response, 200, payload.body, payload.headers);
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
      sendJson(response, errorStatus(error), serializeError(error));
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
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  if (await handleHardeningApiRoute(response, { method, path, state, localScripts })) {
    return;
  }

  if (await handleDeviceApiRoute(request, response, url, { state, usage, recordIosMdmPolicyQueue })) {
    return;
  }

  if (method === "POST" && path === "/api/grayscale/settings") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "settings" });
    state.grayscale = normalizeGrayscaleState(body, state.grayscale);
    addEvent(state, "grayscale_settings_updated", {
      softBlockEnabled: state.grayscale.softBlockEnabled,
      preventManualChanges: state.grayscale.preventManualChanges
    });
    recordIosMdmPolicyQueue("grayscale-settings");
    await saveState(state);
    sendJson(response, 200, { ok: true, grayscale: state.grayscale });
    return;
  }

  if (method === "POST" && path === "/api/grayscale/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
    const schedule = upsertGrayscaleSchedule(body);
    addEvent(state, "grayscale_schedule_saved", {
      scheduleId: schedule.id,
      name: schedule.name,
      enabled: schedule.enabled,
      deviceTargets: schedule.deviceTargets
    });
    recordIosMdmPolicyQueue("grayscale-schedule");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return;
  }

  if (await handleIntentionalUseApiRoute(request, response, url, { state, recordIosMdmPolicyQueue, schedulePolicyEnforcement })) {
    return;
  }

  if (method === "POST" && path === "/api/profile") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "profile", id: typeof body.id === "string" ? body.id : undefined });
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
    const lockLevel = normalizeLockLevel(body.lockLevel, state.settings.strictByDefault ? "deep" : "light");
    const mode = stringValue(body.mode, "focus");
    const profile = profileById(state, stringValue(body.profileId, state.settings.activeProfileId));
    await assertStrictLockAllowed(lockLevel, profile, { mode });
    const commitmentLock = lockLevel === "deep" && truthy(body.commitmentLock);

    const session: Session = {
      id: randomUUID(),
      title: stringValue(body.title, sessionTitle(mode)),
      mode,
      profileId: profile.id,
      lockLevel,
      startedAt: started.toISOString(),
      endsAt: ends.toISOString(),
      canEndEarly: lockLevel === "light",
      commitmentLock,
      emergencyUnlocksAllowed: !commitmentLock,
      source: "manual",
      deviceTargets,
      profileSnapshot: snapshotProfile(profile),
      ...(cycle ? { cycle } : {})
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
    const ended: Array<{ target: DeviceTarget; session: Session }> = [];
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
    const activeLimits = activeLimitBlocks(state) as LimitBlockSummary[];
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
      plannerBlockId: active?.plannerBlock?.id || null,
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

    if (new Date(pending.eligibleAt || "") > new Date()) {
      sendJson(response, 425, { error: "Emergency unlock cooldown is still running.", pending });
      return;
    }

    try {
      assertTypingChallenge(state, pending, body.challengeText);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
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
        until: pending.until || "",
        reason: pending.reason,
        createdAt: new Date().toISOString()
      });
    } else if (pending.activeKind === "planner" && pending.plannerBlockId) {
      completeIntentionalPlanBlock(state, String(pending.plannerBlockId));
    } else if (pending.activeKind === "limit") {
      const ids = new Set(pending.limitBlockIds || []);
      state.limitBlocks = (state.limitBlocks || []).filter((block) => !ids.has(String(block.id || "")));
    }

    addEvent(state, "emergency_used", pending);
    recordIosMdmPolicyQueue("emergency-unlock");
    await saveState(state);
    sendJson(response, 200, { ok: true, remaining: emergencyRemaining() });
    return;
  }

  if (method === "POST" && path === "/api/schedule") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "schedule", id: typeof body.id === "string" ? body.id : undefined });
    const schedule = upsertSchedule(body);
    addEvent(state, "schedule_saved", { scheduleId: schedule.id, name: schedule.name });
    recordIosMdmPolicyQueue("schedule-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, schedule });
    return;
  }

  if (method === "POST" && path === "/api/limit") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "limit", id: typeof body.id === "string" ? body.id : undefined });
    const rule = upsertLimitRule(body);
    addEvent(state, "limit_rule_saved", { ruleId: rule.id, name: rule.name, type: rule.type });
    recordIosMdmPolicyQueue("limit-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, rule });
    return;
  }

  if (method === "POST" && path === "/api/app-lock") {
    const body = await readBody(request);
    assertProtectedEditAllowed(state, { kind: "app-lock", id: typeof body.id === "string" ? body.id : undefined });
    const lock = upsertAppLock(body);
    addEvent(state, "app_lock_saved", { lockId: lock.id, name: lock.name });
    recordIosMdmPolicyQueue("app-lock-saved");
    await saveState(state);
    sendJson(response, 200, { ok: true, lock });
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/app-lock/")) {
    const id = decodeURIComponent(path.split("/").at(-1) || "");
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
      const unlockRequest = requestAppLockUnlock(state, String(body.lockId || ""), String(body.reason || ""));
      addEvent(state, "app_lock_unlock_requested", { lockId: unlockRequest.lockId, requestId: unlockRequest.id });
      await saveState(state);
      sendJson(response, 200, { ok: true, request: unlockRequest });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/app-lock/unlock/confirm") {
    try {
      const body = await readBody(request);
      assertKeyholderPasscode(state, body.passcode);
      assertDistanceKey(state, body.distanceKey);
      const unlock = confirmAppLockUnlock(state, String(body.requestId || ""), { challengeText: String(body.challengeText || "") });
      addEvent(state, "app_lock_unlocked", { lockId: unlock.lockId, unlockId: unlock.id, until: unlock.until });
      await saveState(state);
      sendJson(response, 200, { ok: true, unlock });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
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
      const window = confirmMaintenanceWindow(state, String(body.requestId || ""), { challengeText: body.challengeText });
      addEvent(state, "maintenance_opened", window);
      await saveState(state);
      sendJson(response, 200, { ok: true, window });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/limit/")) {
    const id = decodeURIComponent(path.split("/").at(-1) || "");
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
    const id = decodeURIComponent(path.split("/").at(-1) || "");
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.schedules = state.schedules.filter((schedule) => schedule.id !== id);
    addEvent(state, "schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  if (method === "DELETE" && path.startsWith("/api/grayscale/schedule/")) {
    const id = decodeURIComponent(path.split("/").at(-1) || "");
    assertProtectedEditAllowed(state, { kind: "schedule", id });
    state.grayscale.schedules = (state.grayscale.schedules || []).filter((schedule) => schedule.id !== id);
    addEvent(state, "grayscale_schedule_deleted", { scheduleId: id });
    recordIosMdmPolicyQueue("grayscale-schedule-deleted");
    await saveState(state);
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

function updateSettings(body: RequestBody): void {
  const allowed = new Set([
    "pollIntervalMs",
    "strictByDefault",
    "emergencyTokensPerWeek",
    "emergencyDelaySeconds",
    "panicLockDurationMinutes",
    "intentReasonEnabled",
    "intentReasonMinLength",
    "focusSoundEnabled",
    "focusSoundMode",
    "focusSoundActivity",
    "focusSoundPreset",
    "focusSoundIntensity",
    "focusSoundTimerMode",
    "focusSoundTimerMinutes",
    "focusSoundBreakMinutes",
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
    "systemNetworkBlockingEnabled",
    "safariUrlFilterEnabled",
    "hostsBlockingEnabled",
    "protectedEditsEnabled",
    "protectedEditDelaySeconds",
    "protectedEditWindowMinutes"
  ]);

  for (const [key, value] of Object.entries(body || {})) {
    if (!allowed.has(key)) continue;
    const mutableSettings = state.settings as unknown as Record<string, string | number | boolean>;
    const current = mutableSettings[key];
    if (typeof current === "boolean") {
      mutableSettings[key] = parseBoolean(value, current);
    } else if (typeof current === "number") {
      const bounds = settingsNumberBounds(key);
      mutableSettings[key] = clampNumber(value, bounds.min, bounds.max, current);
    } else if (key.startsWith("focusSound")) {
      mutableSettings[key] = focusSoundSetting(key, value);
    } else {
      mutableSettings[key] = String(value);
    }
  }
}

function settingsNumberBounds(key: string): { min: number; max: number } {
  if (key === "focusSoundVolume") return { min: 0, max: 100 };
  if (key === "focusSoundTimerMinutes") return { min: 1, max: 480 };
  if (key === "focusSoundBreakMinutes") return { min: 1, max: 120 };
  if (key === "intentReasonMinLength") return { min: 1, max: 280 };
  if (key === "panicLockDurationMinutes") return { min: 1, max: 1440 };
  return { min: 1, max: 100000 };
}

function focusSoundSetting(key: string, value: unknown): string {
  const text = String(value || "");
  const allowed: Record<string, string[]> = {
    focusSoundMode: ["focus", "relax", "sleep", "meditate"],
    focusSoundActivity: [
      "deep-work",
      "creative-flow",
      "learning",
      "light-work",
      "motivation",
      "recharge",
      "destress",
      "wind-down",
      "power-nap",
      "guided",
      "unguided"
    ],
    focusSoundPreset: ["brown-noise", "pink-noise", "white-noise", "rain", "ocean", "storm", "stream"],
    focusSoundIntensity: ["low", "medium", "high"],
    focusSoundTimerMode: ["infinite", "timer", "interval"]
  };
  return allowed[key]?.includes(text) ? text : allowed[key]?.[0] || "";
}

function profileModeValue(value: unknown): ProfileMode {
  return value === "allowlist" ? "allowlist" : "blocklist";
}

function upsertProfile(body: RequestBody): Profile {
  const id = stringValue(body.id, randomUUID());
  const existing = state.profiles.find((item) => item.id === id);
  const profile: Profile = {
    id,
    name: String(body.name || existing?.name || "Focus profile").slice(0, 80),
    mode: profileModeValue(body.mode),
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

function upsertSchedule(body: RequestBody): Schedule {
  const id = stringValue(body.id, randomUUID());
  const existing = state.schedules.find((item) => item.id === id);
  const schedule: Schedule = {
    id,
    name: String(body.name || existing?.name || "Focus schedule").slice(0, 80),
    enabled: body.enabled === undefined ? Boolean(existing?.enabled) : parseBoolean(body.enabled, false),
    mode: stringValue(body.mode, existing?.mode || "focus"),
    profileId: stringValue(body.profileId, existing?.profileId || state.settings.activeProfileId),
    lockLevel: normalizeLockLevel(body.lockLevel, existing?.lockLevel || "deep"),
    commitmentLock: body.commitmentLock === undefined ? Boolean(existing?.commitmentLock) : truthy(body.commitmentLock),
    deviceTargets: normalizeDeviceTargets(body.deviceTargets ?? existing?.deviceTargets, DEVICE_TARGETS),
    days: normalizeDays(body.days ?? existing?.days ?? [1, 2, 3, 4, 5]),
    start: normalizeClock(body.start ?? existing?.start ?? "09:00"),
    end: normalizeClock(body.end ?? existing?.end ?? "17:00"),
    wifiNetworks: normalizeArray(body.wifiNetworks ?? existing?.wifiNetworks)
  };

  if (existing) Object.assign(existing, schedule);
  else state.schedules.push(schedule);

  return schedule;
}

function upsertGrayscaleSchedule(body: RequestBody): GrayscaleSchedule {
  state.grayscale ||= {
    softBlockEnabled: false,
    preventManualChanges: true,
    schedules: []
  };
  const id = stringValue(body.id, randomUUID());
  const existing = (state.grayscale.schedules || []).find((item) => item.id === id);
  const schedule = normalizeGrayscaleSchedule({ ...body, id }, existing);

  state.grayscale.schedules ||= [];
  if (existing) Object.assign(existing, schedule);
  else state.grayscale.schedules.push(schedule);

  return schedule;
}

function upsertLimitRule(body: RequestBody): LimitRule {
  const id = stringValue(body.id, randomUUID());
  const existing = (state.limitRules || []).find((item) => item.id === id);
  const rule = normalizeLimitRule(body, existing, id);

  state.limitRules ||= [];
  if (existing) Object.assign(existing, rule);
  else state.limitRules.push(rule);

  return rule;
}

function upsertAppLock(body: RequestBody): AppLockRule {
  const id = stringValue(body.id, randomUUID());
  const existing = (state.appLocks || []).find((item) => item.id === id);
  const lock = normalizeAppLock(body, existing, id);

  state.appLocks ||= [];
  if (existing) Object.assign(existing, lock);
  else state.appLocks.push(lock);

  return lock;
}

function normalizeSessionCycle(body: RequestBody): (SessionCycle & { enabled: true; workMinutes: number; breakMinutes: number; rounds: number }) | null {
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

function cycleDurationMinutes(cycle: SessionCycle & { workMinutes: number; breakMinutes: number; rounds: number }): number {
  return cycle.workMinutes * cycle.rounds + cycle.breakMinutes * Math.max(0, cycle.rounds - 1);
}

function emergencyRemaining(): number {
  const used = state.emergency.tokensUsedByWeek[weekKey()] || 0;
  return Math.max(0, state.settings.emergencyTokensPerWeek - used);
}

function panicLockDurationMinutes(): number {
  return clampNumber(state.settings?.panicLockDurationMinutes, 1, 1440, 3);
}

function normalizeSessionDeviceTargets(body: RequestBody, fallback: readonly DeviceTarget[] = DEVICE_TARGETS): DeviceTarget[] {
  if (Array.isArray(body?.deviceTargets) || typeof body?.deviceTargets === "string") {
    return normalizeDeviceTargets(body.deviceTargets, fallback);
  }

  const selected: DeviceTarget[] = [];
  if (truthy(body?.targetComputer) || truthy(body?.computer)) selected.push("computer");
  if (truthy(body?.targetPhone) || truthy(body?.phone)) selected.push("phone");
  return normalizeDeviceTargets(selected, fallback);
}

function optionalDisabledFlag(value: unknown, existing: unknown): boolean | undefined {
  if (value === undefined) return existing === false ? false : undefined;
  return value === false || value === "false" ? false : undefined;
}

function activeSessionConflicts(targets: DeviceTarget[]): DeviceTarget[] {
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  return targets.filter((target) => Boolean(activeSessionForDevice(state, target)));
}

function startDeviceSession(targets: DeviceTarget[], session: Session): void {
  state.activeSessions ||= { computer: null, phone: null };
  for (const target of targets) {
    state.activeSessions[target] = session;
  }
  state.activeSession = state.activeSessions.computer || null;
}

function clearDeviceSession(target: unknown): void {
  const device = normalizeDeviceTarget(target);
  state.activeSessions ||= { computer: state.activeSession || null, phone: null };
  state.activeSessions[device] = null;
  state.activeSession = state.activeSessions.computer || null;
}

function sessionIsActive(sessionId: unknown): boolean {
  if (!sessionId) return false;
  if (state.activeSession?.id === sessionId) return true;
  return DEVICE_TARGETS.some((target) => state.activeSessions?.[target]?.id === sessionId);
}

function deviceLabel(targets: DeviceTarget[]): string {
  return targets.map((target) => target === "phone" ? "phone" : "computer").join(" and ");
}

function spendEmergencyToken(): void {
  const key = weekKey();
  state.emergency.tokensUsedByWeek[key] = (state.emergency.tokensUsedByWeek[key] || 0) + 1;
}

function recordIosMdmPolicyQueue(reason: string): IosMdmPushResult {
  const result = queueIosMdmPolicyRefresh(state, reason) as unknown as IosMdmPushResult;
  if (result.queued) {
    addEvent(state, "ios_mdm_policy_queued", { reason, ...result });
    scheduleIosMdmPush(reason);
  }
  return result;
}

function normalizeArray(value: unknown): string[] {
  if (Array.isArray(value)) return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return listFromTextarea(value);
}

function normalizeDays(value: unknown): number[] {
  const source = Array.isArray(value) ? value : [];
  return [...new Set(source.map(Number).filter((day) => day >= 0 && day <= 6))].sort();
}

function normalizeClock(value: unknown): string {
  const text = String(value || "");
  return /^\d{2}:\d{2}$/.test(text) ? text : "09:00";
}

function sessionTitle(mode: unknown): string {
  if (mode === "sleep") return "Sleep lock";
  if (mode === "rehab") return "Rehab lock";
  if (mode === "brick") return "Brick Mode";
  return "Focus lock";
}

function isProtectedSettingsMutation(body: RequestBody): boolean {
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
    "systemNetworkBlockingEnabled",
    "safariUrlFilterEnabled",
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

async function assertStrictLockAllowed(lockLevel: LockLevel, profile: Profile, options: { mode?: string } = {}): Promise<void> {
  if (lockLevel !== "deep" || !state.settings.foolproofModeEnabled) return;
  await strictPreflightStatus(state, profile, {
    mode: options.mode,
    lockLevel,
    monitorStatus: requireMonitor().status
  });
}

function serializeError(error: unknown): { error: string; blockers?: unknown } {
  return {
    error: errorMessage(error),
    blockers: objectValue(error, "blockers")
  };
}

function errorStatus(error: unknown): number {
  const status = Number(objectValue(error, "status"));
  return Number.isInteger(status) ? status : 500;
}

function requireServer(): Server {
  if (!server) throw new Error("Vigil server is not initialized.");
  return server;
}

function requireMonitor(): MonitorHandle {
  if (!monitor) throw new Error("Vigil monitor is not initialized.");
  return monitor;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as UnknownRecord)[key]
    : undefined;
}

function stringValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}
