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
  const responseKind = vigilResponseKind(url);
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

  const validBody = responseKind === "health"
    ? isVigilHealthResponse(body, { expectedPort })
    : isVigilStateResponse(body, { expectedPort });
  if (!validBody) {
    return { ok: false, status: response.status, reason: `${responseKind}-shape`, body };
  }

  return { ok: true, status: response.status, reason: "ok", body };
}

export function isVigilStateResponse(body: unknown, { expectedPort = undefined }: { expectedPort?: number } = {}): boolean {
  const record = vigilResponseRecord(body, expectedPort);
  if (!record) return false;
  if (!record.state || typeof record.state !== "object" || Array.isArray(record.state)) return false;
  if (!record.monitor || typeof record.monitor !== "object" || Array.isArray(record.monitor)) return false;
  return true;
}

export function isVigilHealthResponse(body: unknown, { expectedPort = undefined }: { expectedPort?: number } = {}): boolean {
  const record = vigilResponseRecord(body, expectedPort);
  if (!record) return false;

  const liveness = objectRecord(record.liveness);
  const aggregate = objectRecord(record.aggregate);
  const monitor = objectRecord(record.monitor);
  const readiness = objectRecord(record.readiness);
  if (!liveness || !aggregate || !monitor || !readiness) return false;
  if (liveness.ok !== true || liveness.status !== "alive") return false;
  if (!validBooleanStatus(aggregate, "healthy", "degraded")) return false;
  if (monitor.status !== "healthy" && monitor.status !== "degraded") return false;
  if (!validBooleanStatus(readiness, "ready", "not-ready")) return false;
  if (!Array.isArray(readiness.blockers) || !readiness.blockers.every((blocker) => typeof blocker === "string")) return false;
  return true;
}

function vigilResponseKind(url: string | URL): "health" | "state" {
  return new URL(url).pathname === "/api/health" ? "health" : "state";
}

function vigilResponseRecord(body: unknown, expectedPort: number | undefined): UnknownRecord | null {
  const record = objectRecord(body);
  if (!record) return null;
  const app = objectRecord(record.app);
  if (!app) return null;
  if (app.id !== VIGIL_APP_ID) return null;
  if (app.name !== APP_NAME) return null;
  if (app.apiVersion !== VIGIL_STATE_API_VERSION) return null;
  if (expectedPort !== undefined && Number(app.port) !== Number(expectedPort)) return null;
  return record;
}

function objectRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : null;
}

function validBooleanStatus(record: UnknownRecord, trueStatus: string, falseStatus: string): boolean {
  return typeof record.ok === "boolean"
    && record.status === (record.ok ? trueStatus : falseStatus);
}
