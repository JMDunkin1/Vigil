import { APP_NAME } from "./defaults.js";

export const VIGIL_APP_ID = "tech.caseline.vigil";
export const VIGIL_STATE_API_VERSION = 1;
export const VIGIL_STATE_HEADER = "x-vigil-app";
export const VIGIL_STATE_HEADER_VALUE = `${VIGIL_APP_ID}; state-api=${VIGIL_STATE_API_VERSION}`;

export function vigilAppInfo({ port = null, startedAt = null } = {}) {
  return {
    id: VIGIL_APP_ID,
    name: APP_NAME,
    apiVersion: VIGIL_STATE_API_VERSION,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    startedAt
  };
}

export function vigilStateHeaders() {
  return { [VIGIL_STATE_HEADER]: VIGIL_STATE_HEADER_VALUE };
}

export async function fetchVigilStateHealth(url, { signal = undefined, expectedPort = undefined } = {}) {
  const response = await fetch(url, {
    signal,
    headers: { Accept: "application/json" }
  });

  if (!response.ok) return { ok: false, status: response.status, reason: "http-status" };

  const signature = response.headers.get(VIGIL_STATE_HEADER);
  if (signature !== VIGIL_STATE_HEADER_VALUE) {
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

  if (!isVigilStateResponse(body, { expectedPort })) {
    return { ok: false, status: response.status, reason: "state-shape", body };
  }

  return { ok: true, status: response.status, reason: "ok", body };
}

export function isVigilStateResponse(body, { expectedPort = undefined } = {}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const app = body.app;
  if (!app || typeof app !== "object" || Array.isArray(app)) return false;
  if (app.id !== VIGIL_APP_ID) return false;
  if (app.name !== APP_NAME) return false;
  if (app.apiVersion !== VIGIL_STATE_API_VERSION) return false;
  if (expectedPort !== undefined && Number(app.port) !== Number(expectedPort)) return false;
  if (!body.state || typeof body.state !== "object" || Array.isArray(body.state)) return false;
  if (!body.monitor || typeof body.monitor !== "object" || Array.isArray(body.monitor)) return false;
  return true;
}
