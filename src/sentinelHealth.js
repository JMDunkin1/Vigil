import { APP_NAME } from "./defaults.js";

export const SENTINEL_APP_ID = "tech.caseline.sentinel";
export const SENTINEL_STATE_API_VERSION = 1;
export const SENTINEL_STATE_HEADER = "x-sentinel-app";
export const SENTINEL_STATE_HEADER_VALUE = `${SENTINEL_APP_ID}; state-api=${SENTINEL_STATE_API_VERSION}`;

export function sentinelAppInfo({ port = null, startedAt = null } = {}) {
  return {
    id: SENTINEL_APP_ID,
    name: APP_NAME,
    apiVersion: SENTINEL_STATE_API_VERSION,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    startedAt
  };
}

export function sentinelStateHeaders() {
  return { [SENTINEL_STATE_HEADER]: SENTINEL_STATE_HEADER_VALUE };
}

export async function fetchSentinelStateHealth(url, { signal = undefined, expectedPort = undefined } = {}) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" }
  });

  if (!response.ok) return { ok: false, status: response.status, reason: "http-status" };

  const signature = response.headers.get(SENTINEL_STATE_HEADER);
  if (signature !== SENTINEL_STATE_HEADER_VALUE) {
    return { ok: false, status: response.status, reason: "app-signature" };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: response.status, reason: "content-type" };
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: response.status, reason: "json" };
  }

  if (!isSentinelStateResponse(body, { expectedPort })) {
    return { ok: false, status: response.status, reason: "state-shape", body };
  }

  return { ok: true, status: response.status, reason: "ok", body };
}

export function isSentinelStateResponse(body, { expectedPort = undefined } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const app = body.app;
  if (!app || typeof app !== "object" || Array.isArray(app)) return false;
  if (app.id !== SENTINEL_APP_ID) return false;
  if (app.name !== APP_NAME) return false;
  if (app.apiVersion !== SENTINEL_STATE_API_VERSION) return false;
  if (expectedPort !== undefined && Number(app.port) !== Number(expectedPort)) return false;
  if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) return false;
  if (!body.monitor || typeof body.monitor !== "object" || Array.isArray(body.monitor)) return false;
  return true;
}
