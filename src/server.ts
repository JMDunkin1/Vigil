import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { apiRequestGuard, publicHostGuard } from "./apiSecurity.js";
import { hostedAdminRequired, requireHostedAccount } from "./auth.js";
import { APP_NAME, PORT, defaultState } from "./defaults.js";
import { isDirectRun } from "./directRun.js";
import { DATA_DIR, addEvent, loadState, loadUsage, saveState, saveUsage } from "./store.js";
import { launchAgentStatus } from "./hardening.js";
import { startMonitor } from "./monitor.js";
import { assertDistanceKey, updateDistanceKeySettings } from "./distanceKey.js";
import { authorizeIosMdmDeviceRequest, authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, handleIosMdmCheckIn, handleIosMdmConnect, markIosMdmEnrollmentGenerated, pushIosMdmQueuedCommands, queueIosMdmPolicyRefresh } from "./iosMdm.js";
import { buildIosConfigurationProfile, ensureIosRemovalPassword, markIosProfileGenerated } from "./iosProfiles.js";
import { exportManageEngineIosProfile } from "./manageEngineExport.js";
import { parsePlist } from "./plist.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "./protection.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "./keyholder.js";
import { errorMessage, errorStatus, readBody, readTextBody, sendDownload, sendEmpty, sendHtml, sendJson, sendMdmPlist, serializeError, serveStatic, mdmHeaders } from "./server/http.js";
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
let manageEngineExportScheduled = false;
let runtimeStarted = false;
const pendingManageEngineExportReasons = new Set<string>();

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
  server = createServer(handler);

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
  if (!runtimeStarted) {
    activeHost = options.host || DEFAULT_HOST;
    activePort = Number(options.port ?? PORT);
    appUpdateController = options.appUpdate || null;
    startedAt = new Date().toISOString();
    state = await loadState();
    usage = await loadUsage(state);
    instanceSecret = await getInstanceSecret(DATA_DIR);
    invalidateStateDiagnostics();
    monitor = startMonitor({ state, usage }) as unknown as MonitorHandle;
    runtimeStarted = true;
  } else if (options.appUpdate) {
    appUpdateController = options.appUpdate;
  }
  return runtimeHandle();
}

export async function dispatchVigilRequest(input: InAppRequest): Promise<InAppResponse> {
  if (!runtimeStarted) throw new Error("Vigil's in-app enforcement runtime is not initialized.");
  return await runInAppRequest(input, requestHandler);
}

export async function stopVigilRuntime(): Promise<void> {
  await shutdown({ exit: false });
}

export async function stopVigilServer(): Promise<void> {
  await shutdown({ exit: false });
}

async function requestHandler(request: IncomingMessage, response: ServerResponse): Promise<void> {
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
  if (!runtimeStarted && !server) {
    if (exit) process.exit(0);
    return;
  }
  const activeMonitor = monitor;
  const activeServer = server;

  // Persist before disabling enforcement. If a write fails, the caller can
  // leave this runtime in place instead of keeping a half-stopped process alive.
  await saveUsage(usage);
  await saveState(state);
  await activeMonitor?.stop();
  // A tick that was already in flight can update usage or record a failure
  // while stop() drains it, so persist the frozen runtime state once more.
  // The pre-stop writes above already established that persistence works. Do
  // not leave enforcement disabled if either best-effort final write fails.
  await saveUsage(usage).catch((error) => {
    console.error("Vigil could not persist its final usage during shutdown.", error);
  });
  await saveState(state).catch((error) => {
    console.error("Vigil could not persist its final state during shutdown.", error);
  });
  const serverClosed = closeListeningServer(activeServer);
  await serverClosed;
  server = null;
  monitor = null;
  state = defaultState();
  usage = {};
  runtimeStarted = false;
  startedAt = null;
  appUpdateController = null;
  instanceSecret = "";
  if (exit) process.exit(0);
}

async function closeListeningServer(activeServer: Server | null): Promise<void> {
  if (!activeServer?.listening) return;
  await new Promise<void>((resolveClose) => {
    activeServer.close(() => resolveClose());
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

  if ((method === "PUT" || method === "POST") && (path === "/mdm/checkin" || path === "/mdm/connect")) {
    const body = parsePlist(await readTextBody(request)) as UnknownRecord;
    if (!authorizeIosMdmDeviceRequest(state, url, body)) {
      sendEmpty(response, 403);
      return;
    }

    if (path === "/mdm/checkin") {
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

  sendEmpty(response, 404);
}

async function handleApi(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
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

  if (await handleExtensionApiRoute(request, response, url, { state, usage })) {
    return;
  }

  if (method === "GET" && path === "/api/health") {
    sendJson(response, 200, {
      app: vigilAppInfo({ port: activePort, startedAt }),
      state: {},
      monitor: { status: "healthy" }
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
    const payload = await buildStatePayload({ state, usage, monitor: requireMonitor(), activePort, startedAt, localScripts });
    sendJson(response, 200, payload.body, { ...payload.headers, ...healthSignatureHeaders(request) });
    return;
  }

  if (await handleAppUpdateApiRoute(request, response, { controller: appUpdateController })) {
    return;
  }

  if (handleDiagnosticExportApiRoute(response, { method, path, state, usage, activePort, startedAt })) {
    return;
  }

  if (await handleRuleSimulatorApiRoute(request, response, url, { state, usage })) {
    return;
  }

  if (await handleSettingsApiRoute(request, response, { state })) {
    return;
  }

  if (await handleAdultBlocklistApiRoute(request, response, { state, recordIosMdmPolicyQueue })) {
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

function healthSignatureHeaders(request: IncomingMessage): Record<string, string> {
  const challenge = String(request.headers[VIGIL_HEALTH_CHALLENGE_HEADER] || "");
  return challenge
    ? { [VIGIL_HEALTH_SIGNATURE_HEADER]: instanceChallengeSignature(instanceSecret, challenge) }
    : {};
}

function recordIosMdmPolicyQueue(reason: string): IosMdmPushResult {
  scheduleManageEnginePolicyExport(reason);
  const result = queueIosMdmPolicyRefresh(state, reason) as unknown as IosMdmPushResult;
  if (result.queued) {
    addEvent(state, "ios_mdm_policy_queued", { reason, ...result });
    scheduleIosMdmPush(reason);
  }
  return result;
}

function scheduleManageEnginePolicyExport(reason: string): void {
  pendingManageEngineExportReasons.add(reason);
  if (manageEngineExportScheduled) return;
  manageEngineExportScheduled = true;
  setImmediate(async () => {
    try {
      while (pendingManageEngineExportReasons.size) {
        const reasons = [...pendingManageEngineExportReasons];
        pendingManageEngineExportReasons.clear();
        const paths = manageEnginePolicyOutputPaths();
        try {
          const result = await exportManageEngineIosProfile(state, {
            currentState: true,
            outPath: paths.outPath,
            saveState,
            summaryPath: paths.summaryPath
          });
          addEvent(state, "ios_manageengine_policy_exported", {
            reasons,
            bytes: result.profileBytes,
            hash: result.profileHash,
            launcherHash: result.launcherProfileHash,
            launcherOutputPath: result.launcherOutPath,
            launcherSummaryPath: result.launcherSummaryPath,
            mirroredLauncherOutputPath: result.mirroredLauncherOutPath,
            mirroredLauncherSummaryPath: result.mirroredLauncherSummaryPath,
            mirroredOutputPath: result.mirroredOutPath,
            mirroredSummaryPath: result.mirroredSummaryPath,
            outputPath: result.outPath,
            summaryPath: result.summaryPath
          });
          await saveState(state);
        } catch (error) {
          addEvent(state, "ios_manageengine_policy_export_failed", {
            reasons,
            error: errorMessage(error),
            outputPath: paths.outPath,
            summaryPath: paths.summaryPath
          });
          try {
            await saveState(state);
          } catch (saveError) {
            console.error("ManageEngine iOS export failure save failed:", saveError);
          }
        }
      }
    } finally {
      manageEngineExportScheduled = false;
    }
  });
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
