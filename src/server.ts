import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeAdultBlocklistSnapshot, prepareAdultBlocklistRefresh } from "./adultBlocklist.js";
import type { AdultBlocklistRefreshPreparation } from "./adultBlocklist.js";
import { apiRequestGuard, publicHostGuard } from "./apiSecurity.js";
import { hostedAdminRequired, requireHostedAccount } from "./auth.js";
import { APP_NAME, PORT, defaultState } from "./defaults.js";
import { isDirectRun } from "./directRun.js";
import { DATA_DIR, addEvent, loadRuntimeOutbox, loadState, loadUsage, saveRuntimeSnapshot, saveState } from "./store.js";
import type { RuntimeOutboxEntry } from "./store.js";
import { launchAgentStatus } from "./hardening.js";
import { MONITOR_HEALTH_COMPONENTS, startMonitor } from "./monitor.js";
import { assertDistanceKey, updateDistanceKeySettings } from "./distanceKey.js";
import { authorizeIosMdmDeviceRequest, authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated } from "./iosProfiles.js";
import { exportManageEngineIosProfile } from "./manageEngineExport.js";
import { parsePlist } from "./plist.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "./protection.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "./keyholder.js";
import { discardRequestBody, errorStatus, readBody, readTextBody, sendDownload, sendEmpty, sendHtml, sendJson, sendMdmPlist, serializeError, serveStatic, mdmHeaders } from "./server/http.js";
import { createLocalScriptRunner } from "./server/localScripts.js";
import { blockedPage, companionPage, pausePage } from "./server/pages.js";
import { isExtensionApiPath, matchApiRoute } from "./server/apiRoutes.js";
import { handleAppUpdateApiRoute } from "./server/appUpdateRoutes.js";
import { handleAccountApiRoute } from "./server/accountRoutes.js";
import type { AppUpdateController } from "./server/appUpdateRoutes.js";
import { handleDiagnosticExportApiRoute } from "./server/diagnosticExportRoutes.js";
import { handleAdultBlocklistApiRoute } from "./server/adultBlocklistRoutes.js";
import { handleDeviceApiRoute } from "./server/deviceRoutes.js";
import type { IosMdmPushResult } from "./server/deviceRoutes.js";
import { handleExtensionApiRoute } from "./server/extensionApi.js";
import { handleHardeningApiRoute } from "./server/hardeningRoutes.js";
import { handleIntentionalUseApiRoute } from "./server/intentionalUseRoutes.js";
import { handlePolicyApiRoute } from "./server/policyRoutes.js";
import { handleRuleSimulatorApiRoute } from "./server/ruleSimulatorRoutes.js";
import { handleSettingsApiRoute } from "./server/settingsRoutes.js";
import { handleSessionApiRoute, sessionIsActive } from "./server/sessionRoutes.js";
import { buildStatePayload, invalidateStateDiagnostics, strictPreflightStatus } from "./server/statePayload.js";
import { runInAppRequest } from "./server/inAppTransport.js";
import { BufferedServerResponse, RuntimeMutationCoordinator } from "./server/mutationCoordinator.js";
import type { DurableEffectDescriptor } from "./server/mutationCoordinator.js";
import type { InAppRequest, InAppResponse, InAppTransport } from "./server/inAppTransport.js";
import { vigilAppInfo, vigilStateHeaders } from "./vigilHealth.js";
import { VIGIL_HEALTH_CHALLENGE_HEADER, VIGIL_HEALTH_SIGNATURE_HEADER } from "./vigilHealth.js";
import { getInstanceSecret, instanceChallengeSignature } from "./instanceIdentity.js";
import { resolvePublicAssets } from "./publicAssets.js";
import type {
  LockLevel,
  MonitorHandle,
  Profile,
  VigilState,
  UnknownRecord,
  UsageState
} from "./types.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PUBLIC_ASSETS = resolvePublicAssets(ROOT);
const DEFAULT_HOST = "127.0.0.1";
const localScripts = createLocalScriptRunner({ root: ROOT, launchAgentStatus });
const COMPANION_CONFIGURATION_ROUTES = new Set([
  "/api/settings",
  "/api/profile",
  "/api/schedule",
  "/api/limit",
  "/api/app-lock",
  "/api/intentional-use/goal",
  "/api/intentional-use/rule",
  "/api/intentional-use/accountability",
  "/api/grayscale/settings",
  "/api/grayscale/schedule",
  "/api/devices/ios/settings",
  "/api/devices/ios/mdm/settings",
  "/api/intentional-use/journal/security"
]);

let startedAt: string | null = null;
let state: VigilState = defaultState();
let usage: UsageState = {};
let monitor: MonitorHandle | null = null;
let server: Server | null = null;
let activeHost = DEFAULT_HOST;
let activePort = PORT;
let appUpdateController: AppUpdateController | null = null;
let instanceSecret = "";
let runtimeStarted = false;
let runtimeStopping = false;
let mutationCoordinator: RuntimeMutationCoordinator | null = null;
let shutdownPromise: Promise<void> | null = null;
const activeRequestTasks = new Set<Promise<void>>();
const activeSockets = new Set<Socket>();
const SHUTDOWN_GRACE_MS = 5_000;

interface ServerOptions {
  host?: string;
  port?: number | string;
  appUpdate?: AppUpdateController | null;
}

export interface VigilRuntimeHandle extends InAppTransport {}

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
}

interface PreparedMutationRequest {
  mdmBody?: UnknownRecord;
  adultBlocklistRefresh?: AdultBlocklistRefreshPreparation;
}

type AfterCommit = <TResult>(
  effect: () => TResult | Promise<TResult>,
  descriptor?: DurableEffectDescriptor,
  complete?: (result: TResult, state: VigilState, usage: UsageState) => void | Promise<void>,
  fail?: (error: Error, state: VigilState, usage: UsageState) => void | Promise<void>
) => void;

export async function startVigilServer(options: ServerOptions = {}) {
  return await startNetworkServer(options, requestHandler);
}

export async function startVigilCompanionServer(options: ServerOptions = {}) {
  return await startNetworkServer(options, companionRequestHandler);
}

async function startNetworkServer(
  options: ServerOptions,
  handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>
) {
  if (server?.listening) {
    return serverHandle();
  }

  await startVigilRuntime(options);
  activeHost = options.host || DEFAULT_HOST;
  activePort = Number(options.port ?? PORT);
  server = createServer((request, response) => {
    void trackRuntimeRequest(() => handler(request, response)).catch((error) => {
      if (!response.headersSent) sendJson(response, errorStatus(error), serializeError(error));
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  server.on("connection", (socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
  });

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

export async function startVigilRuntime(options: ServerOptions = {}): Promise<VigilRuntimeHandle> {
  if (runtimeStopping) throw Object.assign(new Error("Vigil is stopping."), { status: 503 });
  if (!runtimeStarted) {
    activeHost = options.host || DEFAULT_HOST;
    activePort = Number(options.port ?? PORT);
    appUpdateController = options.appUpdate || null;
    startedAt = new Date().toISOString();
    state = await loadState();
    usage = await loadUsage(state);
    instanceSecret = await getInstanceSecret(DATA_DIR);
    invalidateStateDiagnostics();
    mutationCoordinator = new RuntimeMutationCoordinator(state, usage, await loadRuntimeOutbox());
    monitor = startMonitor({
      state,
      usage,
      runtimeInstanceId: startedAt,
      mutate: async (operation) => await requireMutationCoordinator().run(({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit))
    }, { start: false }) as unknown as MonitorHandle;
    const effectMonitor = monitor;
    mutationCoordinator.setEffectObserver((entry, transition, error) => effectMonitor.observeDurableEffect(entry, transition, error));
    await mutationCoordinator.retryPending(reconcileDurableEffect, completeRecoveredDurableEffect, failRecoveredDurableEffect);
    monitor.start();
    runtimeStarted = true;
  } else if (options.appUpdate) {
    appUpdateController = options.appUpdate;
  }
  return runtimeHandle();
}

export async function dispatchVigilRequest(input: InAppRequest): Promise<InAppResponse> {
  if (!runtimeStarted || runtimeStopping) throw Object.assign(new Error("Vigil's in-app enforcement runtime is not accepting requests."), { status: 503 });
  return await trackRuntimeRequest(() => runInAppRequest(input, requestHandler));
}

export async function stopVigilRuntime(): Promise<void> {
  await shutdown({ exit: false });
}

export async function stopVigilServer(): Promise<void> {
  await shutdown({ exit: false });
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (runtimeStopping) {
    sendJson(response, 503, { error: "Vigil is stopping." });
    return;
  }
  const method = String(request.method || "GET").toUpperCase();
  const path = new URL(request.url || "/", `http://${request.headers.host || `${activeHost}:${activePort}`}`).pathname;
  const requestMutationCoordinator = mutationCoordinator;
  if (!requestRequiresMutation(method, path)) {
    await dispatchRequest(request, response, state, usage, (effect) => void effect(), {}, requestMutationCoordinator);
    return;
  }
  if (!await mutationBodyAdmissionAllowed(request, response, method, path)) return;
  const preparation = await prepareMutationRequest(request, response, method, path);
  if (preparation.handled) return;
  const buffered = new BufferedServerResponse(response);
  try {
    if (!requestMutationCoordinator) throw new Error("Vigil's mutation coordinator is not initialized.");
    await requestMutationCoordinator.run(async ({ state: draftState, usage: draftUsage, afterCommit }) => {
      await dispatchRequest(request, buffered.response, draftState, draftUsage, afterCommit, preparation.prepared);
      if (!buffered.successful() && !requestCommitsHandledFailure(method, path, buffered.status())) throw new RequestRejectedError();
    });
    buffered.flush();
  } catch (error) {
    if (error instanceof RequestRejectedError) buffered.flush();
    else sendJson(response, errorStatus(error), serializeError(error));
  }
}

async function mutationBodyAdmissionAllowed(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string
): Promise<boolean> {
  const hostGuard = publicHostGuard({ path, headers: request.headers, remoteAddress: request.socket.remoteAddress }) as GuardResult;
  if (!hostGuard.ok) {
    sendBodyAdmissionRejection(request, response, hostGuard.status || 403, hostGuard.error || "Forbidden");
    return false;
  }
  if (!path.startsWith("/api/")) return true;

  const apiGuard = apiRequestGuard({ method, path, headers: request.headers, remoteAddress: request.socket.remoteAddress }) as GuardResult;
  if (!apiGuard.ok) {
    sendBodyAdmissionRejection(request, response, apiGuard.status || 403, apiGuard.error || "Forbidden");
    return false;
  }
  if (isExtensionApiPath(path) || path === "/api/devices/usage") return true;

  try {
    await requireHostedAccount(request, { admin: hostedAdminRequired(method, path) });
    return true;
  } catch (error) {
    discardRequestBody(request);
    sendJson(response, errorStatus(error), serializeError(error), { "Cache-Control": "no-store" });
    return false;
  }
}

function sendBodyAdmissionRejection(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  error: string
): void {
  discardRequestBody(request);
  sendJson(response, status, { error });
}

async function prepareMutationRequest(
  request: IncomingMessage,
  response: ServerResponse,
  method: string,
  path: string
): Promise<{ handled: boolean; prepared: PreparedMutationRequest }> {
  if (["PUT", "POST"].includes(method) && ["/mdm/checkin", "/mdm/connect"].includes(path)) {
    try {
      return {
        handled: false,
        prepared: { mdmBody: parsePlist(await readTextBody(request)) as UnknownRecord }
      };
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
      return { handled: true, prepared: {} };
    }
  }

  if (["POST", "PUT", "PATCH"].includes(method)) {
    try {
      // Buffer request bytes before mutation admission. Route handlers parse
      // the cached text only after their normal authorization checks.
      await readTextBody(request);
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
      return { handled: true, prepared: {} };
    }
  }

  if (method === "POST" && path === "/api/adult-blocklist/refresh") {
    const hostGuard = publicHostGuard({ path, headers: request.headers, remoteAddress: request.socket.remoteAddress });
    const apiGuard = apiRequestGuard({ method, path, headers: request.headers, remoteAddress: request.socket.remoteAddress });
    if (hostGuard.ok && apiGuard.ok) {
      try {
        await requireHostedAccount(request, { admin: hostedAdminRequired(method, path) });
        assertProtectedEditAllowed(state, { kind: "settings" });
        return {
          handled: false,
          prepared: { adultBlocklistRefresh: await prepareAdultBlocklistRefresh(structuredClone(state)) }
        };
      } catch {
        // Dispatch normally so the authoritative transactional checks produce
        // the same rejection and failure-persistence behavior as before.
      }
    }
  }

  return { handled: false, prepared: {} };
}

async function dispatchRequest(
  request: IncomingMessage,
  response: ServerResponse,
  requestState: VigilState,
  requestUsage: UsageState,
  afterCommit: AfterCommit,
  prepared: PreparedMutationRequest = {},
  requestMutationCoordinator: RuntimeMutationCoordinator | null = mutationCoordinator
): Promise<void> {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${activeHost}:${activePort}`}`);
    const hostGuard = publicHostGuard({
      path: url.pathname,
      headers: request.headers,
      remoteAddress: request.socket.remoteAddress
    }) as GuardResult;
    if (!hostGuard.ok) {
      sendJson(response, hostGuard.status || 403, { error: hostGuard.error || "Forbidden" });
      return;
    }

    if (url.pathname.startsWith("/mdm/")) {
      await handleMdm(request, response, url, requestState, afterCommit, prepared.mdmBody);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url, requestState, requestUsage, afterCommit, prepared, requestMutationCoordinator);
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (url.pathname === "/blocked") {
      sendHtml(response, blockedPage({ url, state: requestState, port: activePort }));
      return;
    }

    if (url.pathname === "/pause") {
      sendHtml(response, pausePage({ url, state: requestState, port: activePort }));
      return;
    }

    await serveStatic(response, url.pathname, {
      publicDir: PUBLIC_ASSETS.directory,
      fallbackPublicDir: PUBLIC_ASSETS.fallbackDirectory,
      noCache: PUBLIC_ASSETS.live,
      typescriptSourceRoot: PUBLIC_ASSETS.sourceRoot
    });
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error));
  }
}

const READ_ONLY_API_ROUTES = new Set([
  "accountSession", "accountSignup", "accountLogin", "accountLogout",
  "health", "state", "ruleExplain", "diagnosticExport", "appUpdateStatus", "appUpdateStart", "extensionPairing",
  "launchAgentInstall", "hostsApply", "safariFilterApply"
]);

function requestRequiresMutation(method: string, path: string): boolean {
  if (method === "OPTIONS" || method === "HEAD") return false;
  if (path.startsWith("/mdm/")) return true;
  const route = matchApiRoute(method, path);
  return Boolean(route && !READ_ONLY_API_ROUTES.has(route.id));
}

function requestCommitsHandledFailure(method: string, path: string, status: number): boolean {
  return method === "POST" && (
    path === "/api/adult-blocklist/refresh"
    || (path === "/api/emergency/confirm" && status === 410)
  );
}

class RequestRejectedError extends Error {}

async function companionRequestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${activeHost}:${activePort}`}`);
    const method = String(request.method || "GET").toUpperCase();
    if (url.pathname === "/" && ["GET", "HEAD"].includes(method)) {
      sendHtml(response, companionPage());
      return;
    }
    if (!companionNetworkRouteAllowed(method, url.pathname)) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    await requestHandler(request, response);
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error));
  }
}

function companionNetworkRouteAllowed(method: string, path: string): boolean {
  if (path.startsWith("/mdm/")) return true;
  if (isExtensionApiPath(path)) return ["GET", "POST", "OPTIONS"].includes(method);
  if (path === "/api/devices/usage") return method === "POST";
  if (path === "/api/health") return method === "GET";
  if (path === "/api/state") return method === "GET";
  if (path === "/api/account/signup") return method === "POST";
  if (COMPANION_CONFIGURATION_ROUTES.has(path)) return method === "POST";
  if (path === "/api/devices/ios/usb-profile-apply") return method === "POST";
  if (path === "/api/devices/ios/profile.mobileconfig") return method === "GET";
  if (["/blocked", "/pause", "/favicon.ico"].includes(path)) return ["GET", "HEAD"].includes(method);
  if ([
    "/api/emergency/request",
    "/api/emergency/confirm",
    "/api/app-lock/unlock/request",
    "/api/app-lock/unlock/confirm"
  ].includes(path)) return method === "POST";
  if (["/api/intentional-use/pause/continue", "/api/intentional-use/pause/skip"].includes(path)) return method === "POST";
  return false;
}

function serverHandle() {
  return {
    host: activeHost,
    port: activePort,
    url: `http://${activeHost}:${activePort}`,
    server,
    monitor,
    request: dispatchVigilRequest,
    stop: stopVigilServer
  };
}

function runtimeHandle(): VigilRuntimeHandle {
  return {
    request: dispatchVigilRequest,
    stop: stopVigilRuntime
  };
}

async function shutdown({ exit = true }: { exit?: boolean } = {}): Promise<void> {
  if (shutdownPromise) return await shutdownPromise;
  shutdownPromise = performShutdown({ exit }).finally(() => { shutdownPromise = null; });
  return await shutdownPromise;
}

async function performShutdown({ exit = true }: { exit?: boolean } = {}): Promise<void> {
  if (!runtimeStarted && !server) {
    if (exit) process.exit(0);
    return;
  }
  const activeMonitor = monitor;
  const activeServer = server;
  const activeMutationCoordinator = mutationCoordinator;
  runtimeStopping = true;
  try {
    await drainActiveRequests(activeServer, activeMutationCoordinator);
    activeMutationCoordinator?.stopAdmission();
    await activeMonitor?.stop();
    await activeMutationCoordinator?.drain();
    await saveRuntimeSnapshot(state, usage, { outbox: activeMutationCoordinator?.pendingEffects() || [] });
  } catch (error) {
    await resumeListeningServer(activeServer);
    activeMutationCoordinator?.resumeAdmission();
    activeMonitor?.start();
    runtimeStopping = false;
    throw error;
  }
  await closeListeningServer(activeServer);
  server = null;
  monitor = null;
  state = defaultState();
  usage = {};
  runtimeStarted = false;
  startedAt = null;
  appUpdateController = null;
  instanceSecret = "";
  mutationCoordinator = null;
  runtimeStopping = false;
  if (exit) process.exit(0);
}

async function closeListeningServer(activeServer: Server | null, { force = false }: { force?: boolean } = {}): Promise<void> {
  if (!activeServer?.listening) return;
  await new Promise<void>((resolveClose) => {
    let settled = false;
    let forcedFinishTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedFinishTimer) clearTimeout(forcedFinishTimer);
      resolveClose();
    };
    activeServer.close(finish);
    activeServer.closeIdleConnections?.();
    const forceClose = () => {
      const closingSockets = [...activeSockets].map((socket) => new Promise<void>((resolveSocket) => {
        socket.once("close", resolveSocket);
      }));
      activeServer.closeAllConnections?.();
      for (const socket of activeSockets) socket.destroy();
      void Promise.all(closingSockets).then(finish);
      forcedFinishTimer = setTimeout(finish, 1_000);
      forcedFinishTimer.unref();
    };
    const timer = setTimeout(forceClose, force ? 0 : SHUTDOWN_GRACE_MS);
    timer.unref();
  });
}

async function resumeListeningServer(activeServer: Server | null): Promise<void> {
  if (!activeServer || activeServer.listening) return;
  const listeningServer = activeServer;
  await new Promise<void>((resolveListen, rejectListen) => {
    function onError(error: Error) {
      listeningServer.off("listening", onListening);
      rejectListen(error);
    }
    function onListening() {
      listeningServer.off("error", onError);
      resolveListen();
    }
    listeningServer.once("error", onError);
    listeningServer.once("listening", onListening);
    listeningServer.listen(activePort, activeHost);
  });
}

if (isDirectRun(import.meta.url)) {
  process.on("SIGINT", () => {
    void shutdown().catch((error) => {
      console.error("Vigil shutdown failed:", error);
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    void shutdown().catch((error) => {
      console.error("Vigil shutdown failed:", error);
      process.exit(1);
    });
  });
  await startVigilServer();
}

async function scheduleImmediateSessionEnforcement(sessionId: string): Promise<UnknownRecord> {
  if (!sessionIsActive(state, sessionId) && state.panicLock?.id !== sessionId) return { skipped: "inactive-session" };
  return await requireMonitor().reconcileDurableEffect("session-enforcement", { sessionId });
}

async function schedulePolicyEnforcement(reason: string): Promise<UnknownRecord> {
  return await requireMonitor().reconcileDurableEffect("policy-enforcement", { reason });
}

interface IosMdmPushEffect {
  effectState: VigilState;
  reason: string;
  result: IosMdmPushResult;
}

async function scheduleIosMdmPush(reason: string, options: UnknownRecord = {}): Promise<IosMdmPushEffect> {
  const effectState = structuredClone(state);
  const result = await pushIosMdmQueuedCommands(effectState, reason, new Date(), options) as IosMdmPushResult;
  const effect = { effectState, reason, result };
  if (result.failed) {
    throw Object.assign(new Error(`${result.failed} MDM push command(s) failed.`), { effect });
  }
  return effect;
}

async function handleMdm(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestState: VigilState,
  afterCommit: AfterCommit,
  preparedBody?: UnknownRecord
): Promise<void> {
  const method = request.method || "GET";
  const path = url.pathname;

  if ((method === "PUT" || method === "POST") && (path === "/mdm/checkin" || path === "/mdm/connect")) {
    const body = preparedBody || parsePlist(await readTextBody(request)) as UnknownRecord;
    if (!authorizeIosMdmDeviceRequest(requestState, url, body)) {
      sendEmpty(response, 403);
      return;
    }

    if (path === "/mdm/checkin") {
      const result = handleIosMdmCheckIn(requestState, body);
      addEvent(requestState, "ios_mdm_checkin", {
        messageType: result.messageType,
        udid: result.udid,
        ok: result.ok
      });
      await saveState(requestState);
      sendEmpty(response, 200, mdmHeaders());
      if (result.messageType === "TokenUpdate" && result.udid) {
        const payload = { reason: "checkin", force: true, udids: [result.udid] };
        afterCommit(
          () => scheduleIosMdmPush("checkin", payload),
          { ...durableEffect("mdm-push", payload), awaitAttempt: false },
          (effect, committedState) => completeIosMdmPush(effect, committedState),
          (error, committedState) => completeFailedIosMdmPush(error, committedState)
        );
      }
      return;
    }

    const result = handleIosMdmConnect(requestState, body);
    addEvent(requestState, "ios_mdm_connect", {
      status: result.status,
      udid: result.udid,
      command: result.command?.requestType || "none"
    });
    await saveState(requestState);
    if (result.empty) sendEmpty(response, 200, mdmHeaders());
    else sendMdmPlist(response, 200, result.body);
    return;
  }

  if (!authorizeIosMdmRequest(requestState, url)) {
    sendEmpty(response, 403);
    return;
  }

  if (method === "GET" && path === "/mdm/enroll.mobileconfig") {
    const profile = buildIosMdmEnrollmentProfile(requestState);
    markIosMdmEnrollmentGenerated(requestState);
    addEvent(requestState, "ios_mdm_enrollment_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(requestState);
    sendDownload(response, 200, profile, "vigil-iphone-mdm.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  if (method === "GET" && path === "/mdm/policy.mobileconfig") {
    ensureIosRemovalPassword(requestState);
    const profile = buildIosConfigurationProfile(requestState);
    markIosProfileGenerated(requestState);
    addEvent(requestState, "ios_public_profile_generated", { bytes: Buffer.byteLength(profile) });
    await saveState(requestState);
    sendDownload(response, 200, profile, "vigil-iphone-lock.mobileconfig", "application/x-apple-aspen-config");
    return;
  }

  sendEmpty(response, 404);
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  requestState: VigilState,
  requestUsage: UsageState,
  afterCommit: AfterCommit,
  prepared: PreparedMutationRequest = {},
  requestMutationCoordinator: RuntimeMutationCoordinator | null = mutationCoordinator
): Promise<void> {
  const method = request.method || "GET";
  const path = url.pathname;
  const guard = apiRequestGuard({
    method,
    path,
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress
  }) as GuardResult;
  if (!guard.ok) {
    sendJson(response, guard.status || 403, { error: guard.error || "Forbidden" });
    return;
  }

  if (await handleAccountApiRoute(request, response, path)) {
    return;
  }

  if (await handleExtensionApiRoute(request, response, url, { state: requestState, usage: requestUsage })) {
    return;
  }

  if (method === "GET" && path === "/api/health") {
    const monitorStatus = requireMonitor().status;
    const readiness = runtimeReadiness(monitorStatus, requestState, startedAt);
    const aggregateOk = readiness.ok;
    const monitorOk = monitorStatus.ok !== false;
    sendJson(response, 200, {
      app: vigilAppInfo({ port: activePort, startedAt }),
      liveness: { ok: true, status: "alive" },
      aggregate: { ok: aggregateOk, status: aggregateOk ? "healthy" : "degraded" },
      monitor: {
        status: monitorOk ? "healthy" : "degraded",
        components: MONITOR_HEALTH_COMPONENTS,
        componentErrors: monitorStatus.componentErrors || {},
        lastError: monitorStatus.lastError || "",
        freshness: readiness.freshness
      },
      readiness: {
        ok: readiness.ok,
        status: readiness.ok ? "ready" : "not-ready",
        blockers: readiness.blockers
      }
    }, {
      ...vigilStateHeaders(),
      ...healthSignatureHeaders(request)
    });
    return;
  }

  try {
    if (path !== "/api/devices/usage") {
      await requireHostedAccount(request, { admin: hostedAdminRequired(method, path) });
    }
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error), { "Cache-Control": "no-store" });
    return;
  }

  if (!matchApiRoute(method, path)) {
    sendJson(response, 404, { error: "Not found" });
    return;
  }

  if (method === "GET" && path === "/api/state") {
    const payload = await buildStatePayload({ state: requestState, usage: requestUsage, monitor: requireMonitor(), activePort, startedAt, localScripts });
    sendJson(response, 200, payload.body, { ...payload.headers, ...healthSignatureHeaders(request) });
    return;
  }

  if (await handleAppUpdateApiRoute(request, response, { controller: appUpdateController })) {
    return;
  }

  if (handleDiagnosticExportApiRoute(response, { method, path, state: requestState, usage: requestUsage, activePort, startedAt })) {
    return;
  }

  if (await handleRuleSimulatorApiRoute(request, response, url, { state: requestState, usage: requestUsage })) {
    return;
  }

  if (await handleSettingsApiRoute(request, response, { state: requestState })) {
    return;
  }

  if (await handleAdultBlocklistApiRoute(request, response, {
    state: requestState,
    afterCommit,
    preparedRefresh: prepared.adultBlocklistRefresh
  })) {
    return;
  }

  if (await handleSessionApiRoute(request, response, {
    state: requestState,
    recordIosMdmPolicyQueue: (reason) => recordIosMdmPolicyQueue(requestState, reason, afterCommit),
    scheduleImmediateSessionEnforcement: (sessionId) => afterCommit(
      () => scheduleImmediateSessionEnforcement(sessionId),
      durableEffect("session-enforcement", { sessionId }),
      (result, committedState) => addEvent(committedState, "session_immediate_enforcement", { sessionId, ok: true, result })
    ),
    assertStrictLockAllowed: (lockLevel, profile, options) => assertStrictLockAllowed(requestState, lockLevel, profile, options)
  })) {
    return;
  }

  if (method === "POST" && path === "/api/keyholder") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(requestState, { kind: "settings" });
      const keyholder = updateKeyholderSettings(requestState, body);
      addEvent(requestState, "keyholder_updated", { enabled: keyholder.enabled, hasPasscode: keyholder.hasPasscode });
      await saveState(requestState);
      sendJson(response, 200, { ok: true, keyholder });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  if (method === "POST" && path === "/api/distance-key") {
    try {
      const body = await readBody(request);
      assertProtectedEditAllowed(requestState, { kind: "settings" });
      const result = updateDistanceKeySettings(requestState, body);
      addEvent(requestState, "distance_key_updated", { enabled: result.summary.enabled, hasToken: result.summary.hasToken, rotated: Boolean(result.token) });
      await saveState(requestState);
      sendJson(response, 200, { ok: true, distanceKey: result.summary, token: result.token });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  if (await handleHardeningApiRoute(response, {
    method,
    path,
    state: requestState,
    localScripts,
    recordExternalResult: (type, detail) => recordExternalHardeningResult(type, detail, requestMutationCoordinator)
  })) {
    return;
  }

  if (await handleDeviceApiRoute(request, response, url, { state: requestState, usage: requestUsage, recordIosMdmPolicyQueue: (reason) => recordIosMdmPolicyQueue(requestState, reason, afterCommit) })) {
    return;
  }

  if (await handleIntentionalUseApiRoute(request, response, url, {
    state: requestState,
    recordIosMdmPolicyQueue: (reason) => recordIosMdmPolicyQueue(requestState, reason, afterCommit),
    schedulePolicyEnforcement: (reason) => afterCommit(
      () => schedulePolicyEnforcement(reason),
      durableEffect("policy-enforcement", { reason, eventId: requestState.events[0]?.id || "state" }),
      (result, committedState) => addEvent(committedState, "policy_immediate_enforcement", { reason, ok: true, result })
    )
  })) {
    return;
  }

  if (await handlePolicyApiRoute(request, response, { state: requestState, recordIosMdmPolicyQueue: (reason) => recordIosMdmPolicyQueue(requestState, reason, afterCommit) })) {
    return;
  }

  if (method === "POST" && path === "/api/protection/maintenance/request") {
    const body = await readBody(request);
    const result = requestMaintenanceWindow(requestState, body.reason);
    addEvent(requestState, "maintenance_requested", result.pending || result.activeWindow);
    await saveState(requestState);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === "POST" && path === "/api/protection/maintenance/confirm") {
    try {
      const body = await readBody(request);
      assertKeyholderPasscode(requestState, body.passcode);
      assertDistanceKey(requestState, body.distanceKey);
      const window = confirmMaintenanceWindow(requestState, String(body.requestId || ""), { challengeText: body.challengeText });
      addEvent(requestState, "maintenance_opened", window);
      await saveState(requestState);
      sendJson(response, 200, { ok: true, window });
    } catch (error) {
      sendJson(response, errorStatus(error), serializeError(error));
    }
    return;
  }

  sendJson(response, 404, { error: "Not found" });
}

async function recordExternalHardeningResult(
  type: string,
  detail: Record<string, unknown>,
  requestMutationCoordinator: RuntimeMutationCoordinator | null
): Promise<boolean> {
  try {
    if (!requestMutationCoordinator) return false;
    await requestMutationCoordinator.run(async ({ state: draftState }) => {
      addEvent(draftState, type, detail);
      await saveState(draftState);
    });
    return true;
  } catch (error) {
    console.error(`Vigil could not persist the ${type} external-effect result:`, error);
    return false;
  }
}

export function runtimeReadiness(monitorStatus: UnknownRecord, requestState: VigilState, expectedRuntimeInstance: string | null = String(monitorStatus.runtimeInstanceId || "") || null): {
  ok: boolean;
  blockers: string[];
  freshness: UnknownRecord;
} {
  const blockers: string[] = [];
  const runtimeInstanceId = String(monitorStatus.runtimeInstanceId || "");
  const runtimeStartedAt = String(monitorStatus.runtimeStartedAt || "");
  const successfulTickAt = String(monitorStatus.lastSuccessfulTickAt || "");
  const startedMs = Date.parse(runtimeStartedAt);
  const tickMs = Date.parse(successfulTickAt);
  if (!expectedRuntimeInstance || runtimeInstanceId !== expectedRuntimeInstance || runtimeStartedAt !== expectedRuntimeInstance) {
    blockers.push("monitor status belongs to a different runtime instance");
  }
  if (!Number.isFinite(tickMs) || !Number.isFinite(startedMs) || tickMs < startedMs) blockers.push("monitor has not completed a successful tick in this runtime");
  const componentErrors = monitorStatus.componentErrors && typeof monitorStatus.componentErrors === "object"
    ? monitorStatus.componentErrors as Record<string, unknown>
    : {};
  for (const [component, error] of Object.entries(componentErrors)) {
    if (String(error || "")) blockers.push(`${component}: ${String(error)}`);
  }
  const heartbeatAt = requestState.integrity.runtime.lastHeartbeatAt || null;
  const heartbeatAgeMs = heartbeatAt ? Date.now() - Date.parse(heartbeatAt) : Number.POSITIVE_INFINITY;
  const freshnessLimitMs = Math.max(15_000, Number(requestState.settings.pollIntervalMs || 3_000) * 4);
  if (!Number.isFinite(heartbeatAgeMs) || heartbeatAgeMs > freshnessLimitMs) blockers.push("monitor heartbeat is stale");
  if (Number.isFinite(tickMs) && Date.now() - tickMs > freshnessLimitMs) blockers.push("monitor successful tick is stale");
  const componentHealth = monitorStatus.componentHealth && typeof monitorStatus.componentHealth === "object"
    ? monitorStatus.componentHealth as Record<string, UnknownRecord>
    : {};
  for (const component of MONITOR_HEALTH_COMPONENTS) {
    const health = componentHealth[component];
    if (!health || typeof health !== "object") {
      blockers.push(`${component}: missing required health status`);
      continue;
    }
    const attemptedAt = Date.parse(String(health.lastAttemptAt || ""));
    const successAt = Date.parse(String(health.lastSuccessAt || ""));
    if (!Number.isFinite(attemptedAt) || attemptedAt < startedMs) blockers.push(`${component}: no current-runtime health attempt`);
    const applicable = health.applicable !== false;
    const explicitState = String(health.state || "");
    if (!applicable && explicitState !== "disabled") blockers.push(`${component}: non-applicable status is not explicitly disabled`);
    if (applicable && (!Number.isFinite(successAt) || successAt < startedMs)) blockers.push(`${component}: no current-runtime health success`);
    if (applicable && health.error) blockers.push(`${component}: ${String(health.error)}`);
  }
  if (requestState.integrity.stateSeal.tamperDetectedAt) blockers.push("state integrity seal reports tampering");
  const integrityRuntime = requestState.integrity.runtime;
  if (integrityRuntime.downtimeDetectedAt) blockers.push("runtime gap lockdown is active");
  if (integrityRuntime.clockTamperDetectedAt) blockers.push("clock tamper lockdown is active");
  if (integrityRuntime.hardeningDriftDetectedAt) blockers.push("required hardening has drifted");
  for (const field of ["stateSeal", "hardeningDrift", "runtimeGap", "clockTamper"] as const) {
    const status = monitorStatus[field];
    if (status && typeof status === "object" && (status as UnknownRecord).ok === false) blockers.push(`${field} check is degraded`);
  }
  return {
    ok: monitorStatus.ok !== false && blockers.length === 0,
    blockers: [...new Set(blockers)],
    freshness: { runtimeInstanceId, runtimeStartedAt, successfulTickAt: successfulTickAt || null, heartbeatAt, ageMs: Number.isFinite(heartbeatAgeMs) ? Math.max(0, heartbeatAgeMs) : null, limitMs: freshnessLimitMs, components: componentHealth }
  };
}

function healthSignatureHeaders(request: IncomingMessage): Record<string, string> {
  const challenge = String(request.headers[VIGIL_HEALTH_CHALLENGE_HEADER] || "");
  return challenge
    ? { [VIGIL_HEALTH_SIGNATURE_HEADER]: instanceChallengeSignature(instanceSecret, challenge) }
    : {};
}

function recordIosMdmPolicyQueue(
  requestState: VigilState,
  reason: string,
  afterCommit: AfterCommit
): IosMdmPushResult {
  // Reserve the credential in the mutation that originates the export. This
  // keeps concurrent profile downloads and the exported artifact on the same
  // password while the post-commit filesystem work is in flight.
  ensureIosRemovalPassword(requestState);
  const result = queueIosMdmPolicyRefresh(requestState, reason) as unknown as IosMdmPushResult;
  afterCommit(
    () => scheduleManageEnginePolicyExport(reason),
    durableEffect("manageengine-export", { reason, eventId: requestState.events[0]?.id || "state" }),
    (effect, committedState) => completeManageEnginePolicyExport(effect, committedState)
  );
  if (result.queued) {
    addEvent(requestState, "ios_mdm_policy_queued", { reason, ...result });
    afterCommit(
      () => scheduleIosMdmPush(reason),
      durableEffect("mdm-push", { reason, eventId: requestState.events[0]?.id || "state" }),
      (effect, committedState) => completeIosMdmPush(effect, committedState),
      (error, committedState) => completeFailedIosMdmPush(error, committedState)
    );
  }
  return result;
}

function durableEffect(kind: string, payload: UnknownRecord): DurableEffectDescriptor {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left.localeCompare(right))));
  return {
    kind,
    key: `${kind}:${createHash("sha256").update(canonical).digest("hex")}`,
    payload
  };
}

async function reconcileDurableEffect(entry: RuntimeOutboxEntry): Promise<unknown> {
  const reason = String(entry.payload.reason || "recovered-runtime-effect");
  if (entry.kind === "mdm-push") {
    return await scheduleIosMdmPush(reason, entry.payload);
  }
  if (entry.kind === "manageengine-export") {
    return scheduleManageEnginePolicyExport(reason);
  }
  if (entry.kind === "session-enforcement") {
    return await scheduleImmediateSessionEnforcement(String(entry.payload.sessionId || ""));
  }
  if (entry.kind === "policy-enforcement") {
    return await schedulePolicyEnforcement(reason);
  }
  if (entry.kind === "adult-blocklist-finalize") {
    await finalizeAdultBlocklistSnapshot(state);
    return { ok: true };
  }
  if (entry.kind === "monitor-os") {
    return await requireMonitor().reconcileDurableEffect(String(entry.payload.action || ""), { ...entry.payload, intentKey: entry.key });
  }
  throw new Error(`Unknown durable runtime effect kind: ${entry.kind}`);
}

type ManageEnginePolicyExportEffect = Awaited<ReturnType<typeof performManageEnginePolicyExport>>;

function scheduleManageEnginePolicyExport(reason: string): Promise<ManageEnginePolicyExportEffect> {
  return performManageEnginePolicyExport(reason);
}

async function performManageEnginePolicyExport(reason: string) {
  const paths = manageEnginePolicyOutputPaths();
  const exportState = structuredClone(state);
  const result = await exportManageEngineIosProfile(exportState, {
    currentState: true,
    outPath: paths.outPath,
    saveState: async () => {},
    summaryPath: paths.summaryPath
  });
  return { reason, result, removalPassword: exportState.deviceControls.ios.removalPassword || null };
}

function completeManageEnginePolicyExport(effect: ManageEnginePolicyExportEffect, committedState: VigilState): void {
  const committedPassword = committedState.deviceControls.ios.removalPassword;
  if (effect.removalPassword && committedPassword && committedPassword !== effect.removalPassword) {
    throw new Error("The iOS removal password changed while the ManageEngine profile was exported.");
  }
  if (effect.removalPassword && !committedPassword) committedState.deviceControls.ios.removalPassword = effect.removalPassword;
  addEvent(committedState, "ios_manageengine_policy_exported", {
    reasons: [effect.reason],
    bytes: effect.result.profileBytes,
    hash: effect.result.profileHash,
    launcherHash: effect.result.launcherProfileHash,
    launcherOutputPath: effect.result.launcherOutPath,
    launcherSummaryPath: effect.result.launcherSummaryPath,
    mirroredLauncherOutputPath: effect.result.mirroredLauncherOutPath,
    mirroredLauncherSummaryPath: effect.result.mirroredLauncherSummaryPath,
    mirroredOutputPath: effect.result.mirroredOutPath,
    mirroredSummaryPath: effect.result.mirroredSummaryPath,
    outputPath: effect.result.outPath,
    summaryPath: effect.result.summaryPath
  });
}

function completeIosMdmPush(effect: IosMdmPushEffect, committedState: VigilState): void {
  applyIosMdmPushState(committedState, effect.effectState);
  if (effect.result.pushed) addEvent(committedState, "ios_mdm_push", { reason: effect.reason, ...effect.result });
}

function completeFailedIosMdmPush(error: Error, committedState: VigilState): void {
  const effect = (error as Error & { effect?: IosMdmPushEffect }).effect;
  if (effect) completeIosMdmPush(effect, committedState);
}

function completeRecoveredDurableEffect(entry: RuntimeOutboxEntry, result: unknown, committedState: VigilState): void {
  if (entry.kind === "mdm-push") completeIosMdmPush(result as IosMdmPushEffect, committedState);
  else if (entry.kind === "manageengine-export") completeManageEnginePolicyExport(result as ManageEnginePolicyExportEffect, committedState);
  else if (entry.kind === "session-enforcement") addEvent(committedState, "session_immediate_enforcement", { sessionId: String(entry.payload.sessionId || ""), ok: true, result });
  else if (entry.kind === "policy-enforcement") addEvent(committedState, "policy_immediate_enforcement", { reason: String(entry.payload.reason || "recovered-runtime-effect"), ok: true, result });
  else if (entry.kind === "monitor-os") {
    const monitorResult = result as UnknownRecord;
    const effectState = monitorResult.effectState;
    if (entry.payload.action === "mdm-push" && effectState && typeof effectState === "object") {
      applyIosMdmPushState(committedState, effectState as VigilState);
    }
    if (entry.payload.action === "focus-shortcut" && effectState && typeof effectState === "object") {
      applyFocusShortcutState(committedState, effectState as VigilState);
    }
    const { effectState: _effectState, ...eventResult } = monitorResult;
    addEvent(committedState, "monitor_os_effect_completed", { kind: entry.payload.action, key: entry.key, payload: entry.payload, result: eventResult });
  }
}

function failRecoveredDurableEffect(entry: RuntimeOutboxEntry, error: Error, committedState: VigilState): void {
  if (entry.kind === "mdm-push") {
    completeFailedIosMdmPush(error, committedState);
  } else if (entry.kind === "monitor-os") {
    const effectState = (error as Error & { effectState?: VigilState }).effectState;
    if (entry.payload.action === "mdm-push" && effectState) applyIosMdmPushState(committedState, effectState);
    if (entry.payload.action === "focus-shortcut" && effectState) applyFocusShortcutState(committedState, effectState);
    addEvent(committedState, "monitor_os_effect_failed", { kind: entry.payload.action, key: entry.key, payload: entry.payload, error: error.message });
  }
}

function applyFocusShortcutState(targetState: VigilState, effectState: VigilState): void {
  targetState.focusShortcut = structuredClone(effectState.focusShortcut);
}

function applyIosMdmPushState(targetState: VigilState, effectState: VigilState): void {
  const target = targetState.deviceControls.ios.mdm;
  const effect = effectState.deviceControls.ios.mdm;
  target.lastPushAt = effect.lastPushAt;
  target.lastPushStatus = effect.lastPushStatus;
  target.lastPushError = effect.lastPushError;
  const effectDevices = new Map(effect.devices.map((device) => [String(device.udid || ""), device]));
  for (const device of target.devices) {
    const update = effectDevices.get(String(device.udid || ""));
    if (!update) continue;
    for (const field of ["lastPushAt", "lastPushStatus", "lastPushError"] as const) device[field] = update[field];
  }
  const effectCommands = new Map(effect.commands.map((command) => [String(command.id || ""), command]));
  for (const command of target.commands) {
    const update = effectCommands.get(String(command.id || ""));
    if (!update) continue;
    for (const field of ["lastPushAt", "lastPushStatus", "lastPushError"] as const) command[field] = update[field];
  }
}

async function trackRuntimeRequest<T>(operation: () => Promise<T>): Promise<T> {
  const task = operation();
  const tracked = task.then(() => {}, () => {});
  activeRequestTasks.add(tracked);
  void tracked.finally(() => activeRequestTasks.delete(tracked));
  return await task;
}

async function drainActiveRequests(
  activeServer: Server | null,
  activeMutationCoordinator: RuntimeMutationCoordinator | null
): Promise<void> {
  if (!activeRequestTasks.size) return;
  let graceExpired = false;
  let forcedClose: Promise<void> | null = null;
  let expireGrace = () => {};
  const deadline = new Promise<void>((resolve) => { expireGrace = resolve; });
  const timer = setTimeout(() => {
    graceExpired = true;
    activeMutationCoordinator?.stopAdmission();
    forcedClose = closeListeningServer(activeServer, { force: true });
    activeRequestTasks.clear();
    expireGrace();
  }, SHUTDOWN_GRACE_MS);
  timer.unref();
  try {
    while (activeRequestTasks.size && !graceExpired) {
      await Promise.race([Promise.all([...activeRequestTasks]), deadline]);
    }
  } finally {
    clearTimeout(timer);
  }
  await forcedClose;
}

function requireMutationCoordinator(): RuntimeMutationCoordinator {
  if (!mutationCoordinator) throw new Error("Vigil's mutation coordinator is not initialized.");
  return mutationCoordinator;
}

function manageEnginePolicyOutputPaths(): { outPath: string; summaryPath: string } {
  const dir = process.env.VIGIL_MANAGEENGINE_DIR || defaultManageEngineExportDir();
  return {
    outPath: join(dir, "vigil-manageengine-policy.mobileconfig"),
    summaryPath: join(dir, "vigil-manageengine-policy.summary.json")
  };
}

function defaultManageEngineExportDir(): string {
  const explicitRoot = process.env.VIGIL_REPO_ROOT || "";
  if (explicitRoot) return join(explicitRoot, "data", "manageengine");
  const repoRoot = repoRootFromRuntimePath(ROOT);
  return repoRoot ? join(repoRoot, "data", "manageengine") : join(DATA_DIR, "manageengine");
}

function repoRootFromRuntimePath(runtimeRoot: string): string {
  const marker = `${sep}dist${sep}mac${sep}`;
  const index = runtimeRoot.indexOf(marker);
  return index > 0 ? runtimeRoot.slice(0, index) : "";
}

async function assertStrictLockAllowed(currentState: VigilState, lockLevel: LockLevel, profile: Profile, options: { mode?: string } = {}): Promise<void> {
  if (lockLevel !== "deep" || !currentState.settings.foolproofModeEnabled) return;
  await strictPreflightStatus(currentState, profile, {
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
