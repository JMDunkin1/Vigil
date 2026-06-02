import type { IncomingMessage, ServerResponse } from "node:http";
import { apiRequestGuard, extensionCorsHeaders, isTrustedExtensionRequest } from "../apiSecurity.js";
import { truthy } from "../booleans.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionDynamicRuleSignature, extensionRuleSnapshot } from "../extensionPolicy.js";
import { addEvent, saveState, saveUsage } from "../store.js";
import { clampNumber } from "../time.js";
import type { VigilState, UsageState } from "../types.js";
import { isExtensionApiPath } from "./apiRoutes.js";
import { readBody, sendEmpty, sendJson } from "./http.js";

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
}

interface ExtensionApiContext {
  state: VigilState;
  usage: UsageState;
}

export async function handleExtensionApiRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { state, usage }: ExtensionApiContext
): Promise<boolean> {
  const method = request.method || "GET";
  const path = url.pathname;

  if (method === "OPTIONS" && isExtensionApiPath(path)) {
    const extensionGuard = extensionRouteGuard(method, path, request);
    if (!extensionGuard.ok) sendJson(response, extensionGuard.status || 403, { error: extensionGuard.error || "Forbidden" });
    else sendEmpty(response, 204, extensionCorsHeaders(request.headers));
    return true;
  }

  if ((method === "POST" || method === "GET") && path === "/api/extension/check") {
    await handleExtensionCheck(request, response, url, { state, usage });
    return true;
  }

  if (method === "GET" && path === "/api/extension/rules") {
    await handleExtensionRules(request, response, url, state);
    return true;
  }

  if (method === "POST" && path === "/api/extension/rules/sync") {
    await handleExtensionRulesSync(request, response, state);
    return true;
  }

  return false;
}

async function handleExtensionCheck(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  { state, usage }: ExtensionApiContext
): Promise<void> {
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, url.pathname, request);
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
      lastEvent: String(result.event || body.event || "") || null,
      lastHost: String(result.hostname || state.extension?.lastHost || "") || null
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
}

async function handleExtensionRules(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  state: VigilState
): Promise<void> {
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, url.pathname, request);
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
}

async function handleExtensionRulesSync(
  request: IncomingMessage,
  response: ServerResponse,
  state: VigilState
): Promise<void> {
  const method = request.method || "GET";
  const extensionGuard = extensionRouteGuard(method, "/api/extension/rules/sync", request);
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
}

function extensionRouteGuard(method: string, path: string, request: IncomingMessage): GuardResult {
  return apiRequestGuard({ method, path, headers: request.headers }) as GuardResult;
}
