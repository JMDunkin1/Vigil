import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequestGuard, publicHostGuard } from "./apiSecurity.js";
import { APP_NAME, PORT, defaultState } from "./defaults.js";
import { addEvent, loadState, loadUsage, saveState } from "./store.js";
import { launchAgentStatus } from "./hardening.js";
import { startMonitor } from "./monitor.js";
import { assertDistanceKey, updateDistanceKeySettings } from "./distanceKey.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated } from "./iosProfiles.js";
import { parsePlist } from "./plist.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "./protection.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "./keyholder.js";
import { errorMessage, errorStatus, readBody, readTextBody, sendDownload, sendEmpty, sendHtml, sendJson, sendMdmPlist, serializeError, serveStatic, mdmHeaders } from "./server/http.js";
import { createLocalScriptRunner } from "./server/localScripts.js";
import { blockedPage, pausePage } from "./server/pages.js";
import { matchApiRoute } from "./server/apiRoutes.js";
import { handleBackupApiRoute } from "./server/backupRoutes.js";
import { handleDeviceApiRoute } from "./server/deviceRoutes.js";
import type { IosMdmPushResult } from "./server/deviceRoutes.js";
import { handleExtensionApiRoute } from "./server/extensionApi.js";
import { handleHardeningApiRoute } from "./server/hardeningRoutes.js";
import { handleIntentionalUseApiRoute } from "./server/intentionalUseRoutes.js";
import { handlePolicyApiRoute } from "./server/policyRoutes.js";
import { handleRuleSimulatorApiRoute } from "./server/ruleSimulatorRoutes.js";
import { handleSettingsApiRoute } from "./server/settingsRoutes.js";
import { handleSessionApiRoute, sessionIsActive } from "./server/sessionRoutes.js";
import { buildStatePayload, strictPreflightStatus } from "./server/statePayload.js";
import type {
  LockLevel,
  MonitorHandle,
  Profile,
  VigilState,
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

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
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
    if (!sessionIsActive(state, sessionId) && state.panicLock?.id !== sessionId) return;

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

  if (handleBackupApiRoute(response, { method, path, state, usage, activePort, startedAt })) {
    return;
  }

  if (await handleRuleSimulatorApiRoute(request, response, url, { state, usage })) {
    return;
  }

  if (await handleSettingsApiRoute(request, response, { state })) {
    return;
  }

  if (await handleSessionApiRoute(request, response, {
    state,
    recordIosMdmPolicyQueue,
    scheduleImmediateSessionEnforcement,
    assertStrictLockAllowed
  })) {
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

  if (await handleIntentionalUseApiRoute(request, response, url, { state, recordIosMdmPolicyQueue, schedulePolicyEnforcement })) {
    return;
  }

  if (await handlePolicyApiRoute(request, response, { state, recordIosMdmPolicyQueue })) {
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

  sendJson(response, 404, { error: "Not found" });
}

function recordIosMdmPolicyQueue(reason: string): IosMdmPushResult {
  const result = queueIosMdmPolicyRefresh(state, reason) as unknown as IosMdmPushResult;
  if (result.queued) {
    addEvent(state, "ios_mdm_policy_queued", { reason, ...result });
    scheduleIosMdmPush(reason);
  }
  return result;
}

async function assertStrictLockAllowed(lockLevel: LockLevel, profile: Profile, options: { mode?: string } = {}): Promise<void> {
  if (lockLevel !== "deep" || !state.settings.foolproofModeEnabled) return;
  await strictPreflightStatus(state, profile, {
    mode: options.mode,
    lockLevel,
    monitorStatus: requireMonitor().status
  });
}

function requireServer(): Server {
  if (!server) throw new Error("Vigil server is not initialized.");
  return server;
}

function requireMonitor(): MonitorHandle {
  if (!monitor) throw new Error("Vigil monitor is not initialized.");
  return monitor;
}
