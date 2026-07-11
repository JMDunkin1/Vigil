import { APP_NAME } from "./defaults.js";
import { randomBytes } from "node:crypto";
import { verifyInstanceChallenge } from "./instanceIdentity.js";
import type { UnknownRecord } from "./types.js";

export const VIGIL_APP_ID = "tech.caseline.vigil";
export const VIGIL_STATE_API_VERSION = 1;
export const VIGIL_STATE_HEADER = "x-vigil-app";
export const VIGIL_STATE_HEADER_VALUE = `${VIGIL_APP_ID}; state-api=${VIGIL_STATE_API_VERSION}`;
export const VIGIL_HEALTH_CHALLENGE_HEADER = "x-vigil-health-challenge";
export const VIGIL_HEALTH_SIGNATURE_HEADER = "x-vigil-health-signature";

export function vigilAppInfo({ port = null, startedAt = null }: { port?: number | null; startedAt?: string | null } = {}) {
  return {
    id: VIGIL_APP_ID,
    name: APP_NAME,
    apiVersion: VIGIL_STATE_API_VERSION,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    startedAt
  };
}

export function vigilStateHeaders(): Record<string, string> {
  return { [VIGIL_STATE_HEADER]: VIGIL_STATE_HEADER_VALUE };
}

export async function fetchVigilStateHealth(
  url: string | URL,
  { signal = undefined, expectedPort = undefined, instanceSecret = "" }: {
    signal?: AbortSignal;
    expectedPort?: number;
    instanceSecret?: string;
  } = {}
) {
  const challenge = instanceSecret ? randomBytes(24).toString("base64url") : "";
  const response = await fetch(url, {
    signal,
    headers: {
      Accept: "application/json",
      ...(challenge ? { [VIGIL_HEALTH_CHALLENGE_HEADER]: challenge } : {})
    }
  });

  if (!response.ok) return { ok: false, status: response.status, reason: "http-status" };

  const signature = response.headers.get(VIGIL_STATE_HEADER);
  if (signature !== VIGIL_STATE_HEADER_VALUE) {
    return { ok: false, status: response.status, reason: "app-signature" };
  }
  if (instanceSecret && !verifyInstanceChallenge(
    instanceSecret,
    challenge,
    response.headers.get(VIGIL_HEALTH_SIGNATURE_HEADER) || ""
  )) {
    return { ok: false, status: response.status, reason: "instance-signature" };
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { ok: false, status: response.status, reason: "content-type" };
  }

  let body: unknown;
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

export function isVigilStateResponse(body: unknown, { expectedPort = undefined }: { expectedPort?: number } = {}): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as UnknownRecord;
  const app = record.app as UnknownRecord | undefined;
  if (!app || typeof app !== "object" || Array.isArray(app)) return false;
  if (app.id !== VIGIL_APP_ID) return false;
  if (app.name !== APP_NAME) return false;
  if (app.apiVersion !== VIGIL_STATE_API_VERSION) return false;
  if (expectedPort !== undefined && Number(app.port) !== Number(expectedPort)) return false;
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) return false;
  if (!record.monitor || typeof record.monitor !== "object" || Array.isArray(record.monitor)) return false;
  return true;
}
