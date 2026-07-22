import type { IncomingMessage, ServerResponse } from "node:http";
import { apiRequestGuard, extensionCorsHeaders, extensionTrustSummary, isTrustedExtensionRequest } from "../apiSecurity.js";
import type { RequestTransportContext } from "../apiSecurity.js";
import { truthy } from "../booleans.js";
import { REQUIRED_EXTENSION_VERSION } from "../defaults.js";
import { compactExtensionRuleSignature, evaluateExtensionCheck, extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "../extensionPolicy.js";
import { confirmIntentionalPause, skipIntentionalPause } from "../intentionalUse.js";
import { addEvent, saveState, saveUsage } from "../store.js";
import { clampNumber } from "../time.js";
import type { VigilState, UsageState } from "../types.js";
import { isExtensionApiPath } from "./apiRoutes.js";
import { errorStatus, readBody, sendEmpty, sendJson, serializeError } from "./http.js";

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface ExtensionApiContext {
  state: VigilState;
  usage: UsageState;
  requestPersistence?: () => void;
}

interface ExtensionPersistenceTargets {
  state?: boolean;
  usage?: boolean;
}

export async function handleExtensionApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ExtensionApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = url.pathname;
  const { state } = context;

  if (method === "OPTIONS" && isExtensionApiPath(path)) {
    const extensionGuard = extensionRouteGuard(method, path, request);
    if (!extensionGuard.ok) sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" });
    else sendEmpty(response, 204, extensionResponseCorsHeaders(request));
    return true;
  }

  if ((method === "POST" || method === "GET") && path === "/api/extension/check") {
    await handleExtensionCheck(request, response, url, context);
    return true;
  }

  if (method === "GET" && path === "/api/extension/pairing") {
    handleExtensionPairing(request, response, url, state);
    return true;
  }

  if (method === "GET" && path === "/api/extension/rules") {
    await handleExtensionRules(request, response, url, context);
    return true;
  }

  if (method === "POST" && path === "/api/extension/rules/sync") {
    await handleExtensionRulesSync(request, response, context);
    return true;
  }

  if (method === "POST" && path === "/api/extension/pause/continue") {
    await handleExtensionPauseContinue(request, response, context);
    return true;
  }

  if (method === "POST" && path === "/api/extension/pause/skip") {
    await handleExtensionPauseSkip(request, response, context);
    return true;
  }

  return false;
}

async function handleExtensionCheck(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ExtensionApiContext
): Promise<void> {
  const { state, usage } = context;
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, url.pathname, request);
  if (!extensionGuard.ok) {
    sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionResponseCorsHeaders(request));
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
  const pauseIdsBefore = new Set((state.intentionalUse?.pauses || []).map((pause) => pause.id));
  const limitBlockIdsBefore = new Set((state.limitBlocks || []).map((block) => block.id));
  const extensionVersionBefore = state.extension?.lastVersion || null;
  const result = evaluateExtensionCheck(state, usage, body);
  if (trustedExtensionRequest(request)) {
    state.extension = {
      ...(state.extension || {}),
      lastSeenAt: new Date().toISOString(),
      lastVersion: String(body.extensionVersion || state.extension?.lastVersion || "").slice(0, 40) || null,
      lastEvent: String(result.event || body.event || "") || null,
      lastHost: String(result.hostname || state.extension?.lastHost || "") || null
    };
  }
  const blockEventAdded = result.blocked === true && result.event !== "heartbeat";
  if (blockEventAdded) {
    addEvent(state, "extension_blocked_site", {
      site: result.hostname,
      policy: result.policy?.title || result.reason
    });
  }
  const pauseEventAdded = result.paused === true && result.event !== "heartbeat";
  if (pauseEventAdded) {
    addEvent(state, "intentional_pause_requested", {
      site: result.hostname,
      ruleId: result.rule?.id,
      ruleName: result.rule?.name,
      pauseId: result.pause?.id
    });
  }
  const durableMutation = blockEventAdded
    || pauseEventAdded
    || (state.intentionalUse?.pauses || []).some((pause) => !pauseIdsBefore.has(pause.id))
    || (state.limitBlocks || []).some((block) => !limitBlockIdsBefore.has(block.id))
    || (state.extension?.lastVersion || null) !== extensionVersionBefore;
  await persistExtensionChanges(context, durableMutation, { state: true, usage: true });
  sendJson(response, 200, result, extensionResponseCorsHeaders(request));
}

function handleExtensionPairing(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  state: VigilState
): void {
  const trust = extensionRequestTrustSummary(request);
  sendJson(response, 200, {
    ok: true,
    serverUrl: url.origin,
    requiredExtensionVersion: REQUIRED_EXTENSION_VERSION,
    trust,
    status: trust.trusted ? publicExtensionStatus(state) : publicPairingStatus(state),
    setup: {
      tokenHeader: trust.tokenHeader,
      originEnv: trust.suggestedOriginEnv,
      idEnv: trust.suggestedIdEnv,
      tokenEnv: trust.suggestedTokenEnv,
      optionsStorageKeys: {
        localServer: "vigilLocalServer",
        token: "vigilExtensionToken"
      }
    }
  }, extensionResponseCorsHeaders(request));
}

async function handleExtensionRules(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  context: ExtensionApiContext
): Promise<void> {
  const { state } = context;
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, url.pathname, request);
  if (!extensionGuard.ok) {
    sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionResponseCorsHeaders(request));
    return;
  }
  const dynamicRulesBefore = dynamicRulesDurabilityFingerprint(state);
  const extensionVersionBefore = state.extension?.lastVersion || null;
  const snapshot = extensionRuleSnapshot(state);
  const expectedCount = extensionDynamicRuleCount(snapshot);
  const expectedSignature = extensionDynamicRuleSignature(snapshot);
  const compactExpectedSignature = compactExtensionRuleSignature(expectedSignature);
  if (trustedExtensionRequest(request)) {
    state.extension = {
      ...(state.extension || {}),
      lastSeenAt: new Date().toISOString(),
      lastVersion: String(url.searchParams.get("version") || state.extension?.lastVersion || "").slice(0, 40) || null,
      lastEvent: "rules",
      lastHost: state.extension?.lastHost || null,
      dynamicRules: {
        ...(state.extension?.dynamicRules || {}),
        expectedCount,
        expectedSignature: compactExpectedSignature,
        requestedAt: snapshot.generatedAt,
        fallbackRequired: snapshot.fallbackRequired
      }
    };
    const durableMutation = dynamicRulesDurabilityFingerprint(state) !== dynamicRulesBefore
      || (state.extension?.lastVersion || null) !== extensionVersionBefore;
    await persistExtensionChanges(context, durableMutation, { state: true });
  }
  sendJson(response, 200, snapshot, extensionResponseCorsHeaders(request));
}

async function handleExtensionRulesSync(
  request: IncomingMessage,
  response: ServerResponse,
  context: ExtensionApiContext
): Promise<void> {
  const { state } = context;
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, "/api/extension/rules/sync", request);
  if (!extensionGuard.ok) {
    sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionResponseCorsHeaders(request));
    return;
  }

  const body = await readBody(request);
  const dynamicRulesBefore = dynamicRulesDurabilityFingerprint(state);
  const extensionVersionBefore = state.extension?.lastVersion || null;
  const snapshot = extensionRuleSnapshot(state);
  const expectedCount = extensionDynamicRuleCount(snapshot);
  const expectedSignature = extensionDynamicRuleSignature(snapshot);
  const count = clampNumber(body.count, 0, 1000, 0);
  const signature = String(body.signature || "");
  const ok = truthy(body.ok) && count === expectedCount && signature === expectedSignature && !snapshot.fallbackRequired;
  if (trustedExtensionRequest(request)) {
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
        signature: compactExtensionRuleSignature(signature),
        expectedSignature: compactExtensionRuleSignature(expectedSignature),
        fallbackRequired: snapshot.fallbackRequired,
        status: ok ? "synced" : (truthy(body.ok) ? "mismatch" : "failed"),
        ok,
        error: String(body.error || "").slice(0, 200)
      }
    };
    const durableMutation = dynamicRulesDurabilityFingerprint(state) !== dynamicRulesBefore
      || (state.extension?.lastVersion || null) !== extensionVersionBefore;
    await persistExtensionChanges(context, durableMutation, { state: true });
  }
  sendJson(response, 200, { ok, count, expectedCount }, extensionResponseCorsHeaders(request));
}

async function handleExtensionPauseContinue(
  request: IncomingMessage,
  response: ServerResponse,
  context: ExtensionApiContext
): Promise<void> {
  const { state } = context;
  const extensionGuard = extensionRouteGuard(request.method || "POST", "/api/extension/pause/continue", request);
  if (!extensionGuard.ok) {
    sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionResponseCorsHeaders(request));
    return;
  }

  try {
    const body = await readBody(request);
    const result = confirmIntentionalPause(state, String(body.requestId || ""), body);
    addEvent(state, "intentional_pause_continued", {
      pauseId: result.pause.id,
      ruleId: result.pause.ruleId,
      target: result.pause.targetLabel,
      until: result.grant.until,
      source: "extension-overlay"
    });
    markExtensionActionSeen(request, state, "pause-continue");
    await persistExtensionChanges(context, true, { state: true });
    sendJson(response, 200, { ok: true, ...result }, extensionResponseCorsHeaders(request));
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error), extensionResponseCorsHeaders(request));
  }
}

async function handleExtensionPauseSkip(
  request: IncomingMessage,
  response: ServerResponse,
  context: ExtensionApiContext
): Promise<void> {
  const { state } = context;
  const extensionGuard = extensionRouteGuard(request.method || "POST", "/api/extension/pause/skip", request);
  if (!extensionGuard.ok) {
    sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" }, extensionResponseCorsHeaders(request));
    return;
  }

  try {
    const body = await readBody(request);
    const result = skipIntentionalPause(state, String(body.requestId || ""), body);
    addEvent(state, "intentional_pause_skipped", {
      pauseId: result.pause.id,
      ruleId: result.pause.ruleId,
      target: result.pause.targetLabel,
      replacement: result.pause.replacement,
      source: "extension-overlay"
    });
    markExtensionActionSeen(request, state, "pause-skip");
    await persistExtensionChanges(context, true, { state: true });
    sendJson(response, 200, { ok: true, ...result }, extensionResponseCorsHeaders(request));
  } catch (error) {
    sendJson(response, errorStatus(error), serializeError(error), extensionResponseCorsHeaders(request));
  }
}

async function persistExtensionChanges(
  context: ExtensionApiContext,
  durableMutation: boolean,
  targets: ExtensionPersistenceTargets
): Promise<void> {
  if (context.requestPersistence) {
    if (durableMutation) context.requestPersistence();
    return;
  }
  if (targets.usage) await saveUsage(context.usage);
  if (targets.state) await saveState(context.state);
}

function dynamicRulesDurabilityFingerprint(state: VigilState): string {
  const dynamicRules = state.extension?.dynamicRules || {};
  return JSON.stringify({
    count: normalizedRuleCount(dynamicRules.count),
    expectedCount: normalizedRuleCount(dynamicRules.expectedCount),
    signature: String(dynamicRules.signature || ""),
    expectedSignature: String(dynamicRules.expectedSignature || ""),
    fallbackRequired: dynamicRules.fallbackRequired === true,
    status: String(dynamicRules.status || "missing"),
    ok: dynamicRules.ok === true,
    error: String(dynamicRules.error || "")
  });
}

function normalizedRuleCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function markExtensionActionSeen(request: IncomingMessage, state: VigilState, event: string): void {
  if (!trustedExtensionRequest(request)) return;
  state.extension = {
    ...(state.extension || {}),
    lastSeenAt: new Date().toISOString(),
    lastVersion: state.extension?.lastVersion || null,
    lastEvent: event,
    lastHost: state.extension?.lastHost || null
  };
}

function publicExtensionStatus(state: VigilState) {
  const dynamicRules = state.extension?.dynamicRules || {};
  return {
    lastSeenAt: state.extension?.lastSeenAt || null,
    lastVersion: state.extension?.lastVersion || null,
    lastEvent: state.extension?.lastEvent || null,
    lastHost: state.extension?.lastHost || null,
    dynamicRules: {
      syncedAt: String(dynamicRules.syncedAt || "") || null,
      count: Number(dynamicRules.count || 0),
      expectedCount: Number(dynamicRules.expectedCount || 0),
      status: String(dynamicRules.status || "missing"),
      ok: Boolean(dynamicRules.ok),
      fallbackRequired: Boolean(dynamicRules.fallbackRequired),
      error: String(dynamicRules.error || "")
    }
  };
}

function publicPairingStatus(state: VigilState) {
  const dynamicRules = state.extension?.dynamicRules || {};
  return {
    lastSeenAt: state.extension?.lastSeenAt || null,
    lastVersion: state.extension?.lastVersion || null,
    dynamicRules: {
      status: String(dynamicRules.status || "missing"),
      ok: Boolean(dynamicRules.ok)
    }
  };
}

function extensionRouteGuard(method: string, path: string, request: IncomingMessage): GuardResult {
  return apiRequestGuard({
    method,
    path,
    headers: request.headers,
    remoteAddress: request.socket?.remoteAddress || null
  }) as GuardResult;
}

function requestTransport(request: IncomingMessage): RequestTransportContext {
  return { remoteAddress: request.socket?.remoteAddress || null };
}

function extensionResponseCorsHeaders(request: IncomingMessage): Record<string, string> {
  return extensionCorsHeaders(request.headers, requestTransport(request));
}

function trustedExtensionRequest(request: IncomingMessage): boolean {
  return isTrustedExtensionRequest(request.headers, requestTransport(request));
}

function extensionRequestTrustSummary(request: IncomingMessage) {
  return extensionTrustSummary(request.headers, requestTransport(request));
}
