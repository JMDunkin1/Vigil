import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { UnknownRecord } from "./types.js";

export const CONTROL_INTENT_HEADER = "x-vigil-intent";
export const CONTROL_INTENT_VALUE = "vigil-app";
export const EXTENSION_TOKEN_HEADER = "x-vigil-extension-token";

const EXTENSION_API_PATHS = new Set([
  "/api/extension/check",
  "/api/extension/rules",
  "/api/extension/rules/sync",
  "/api/extension/pause/continue",
  "/api/extension/pause/skip"
]);

const DEVICE_SYNC_API_PATHS = new Set([
  "/api/devices/usage"
]);

type HeaderBag = IncomingHttpHeaders | Headers | UnknownRecord | null | undefined;

interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
}

interface GuardInput {
  method?: string;
  path?: string;
  headers?: HeaderBag;
}

interface DeviceUsageAuthorizationInput {
  headers?: HeaderBag;
  url?: URL | null;
  body?: UnknownRecord;
  enrollmentSecret?: string | null;
}

export function apiRequestGuard({ method = "GET", path = "", headers = {} }: GuardInput): GuardResult {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (EXTENSION_API_PATHS.has(path)) return extensionApiRequestGuard({ method: normalizedMethod, headers });
  if (DEVICE_SYNC_API_PATHS.has(path)) return allow();
  if (!isMutationMethod(normalizedMethod)) return allow();

  return localMutationGuard({ method: normalizedMethod, headers });
}

function extensionApiRequestGuard({ method = "GET", headers = {} }: GuardInput): GuardResult {
  const extensionGuard = extensionRequestGuard({ method, headers });
  if (extensionGuard.ok) return extensionGuard;

  if (!isMutationMethod(method)) return extensionGuard;
  return localMutationGuard({ method, headers });
}

function localMutationGuard({ method = "GET", headers = {} }: GuardInput): GuardResult {
  const origin = headerValue(headers, "origin");
  if (origin && !isLocalOrigin(origin)) {
    return deny("Cross-origin mutation blocked.");
  }

  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return deny("Cross-site mutation blocked.");
  }

  if (method === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
    return deny("Mutation requests must use application/json.");
  }

  if (headerValue(headers, CONTROL_INTENT_HEADER) !== CONTROL_INTENT_VALUE) {
    return deny("Missing local app intent header.");
  }

  return allow();
}

export function publicHostGuard({ path = "", headers = {} }: GuardInput): GuardResult {
  if (String(path || "").startsWith("/mdm/")) return allow();
  if (DEVICE_SYNC_API_PATHS.has(path)) return allow();
  if (isLocalHostHeader(headerValue(headers, "host"))) return allow();
  return deny("Public tunnel requests may only reach MDM endpoints.");
}

export function deviceUsageSyncAuthorization({
  headers = {},
  url = null,
  body = {},
  enrollmentSecret = ""
}: DeviceUsageAuthorizationInput = {}): GuardResult {
  if (
    headerValue(headers, CONTROL_INTENT_HEADER) === CONTROL_INTENT_VALUE
    && isLocalRequestHost(headers, url)
  ) {
    return { ok: true, kind: "local-intent" };
  }

  const token = String(enrollmentSecret || "");
  const supplied = String(
    headerValue(headers, "x-vigil-device-token")
    || url?.searchParams?.get("token")
    || body?.token
    || ""
  );
  if (token && supplied && token === supplied) return { ok: true, kind: "device-token" };

  return deny("Device usage sync requires a local app intent header or the iOS device token.");
}

export function controlIntentHeaders(): Record<string, string> {
  return { [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE };
}

export function extensionRequestGuard({ method = "GET", headers = {} }: GuardInput): GuardResult {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const origin = headerValue(headers, "origin");

  if (normalizedMethod === "OPTIONS") {
    if (!origin || !isExtensionOrigin(origin) || (!isTrustedExtensionOrigin(origin) && !configuredExtensionToken())) {
      return deny("Untrusted extension origin blocked.");
    }
    return allow();
  }

  const trustedOrigin = origin && isTrustedExtensionOrigin(origin);
  const trustedToken = extensionTokenMatches(headerValue(headers, EXTENSION_TOKEN_HEADER));
  if (!trustedOrigin && !trustedToken) {
    return deny("Untrusted extension origin blocked.");
  }

  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site" && origin && !trustedOrigin && !trustedToken) {
    return deny("Cross-site extension request blocked.");
  }

  if (normalizedMethod === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
    return deny("Extension POST requests must use application/json.");
  }

  return allow();
}

export function extensionCorsHeaders(headers: HeaderBag = {}): Record<string, string> {
  const origin = headerValue(headers, "origin");
  if (!origin || !isExtensionOrigin(origin) || (!isTrustedExtensionOrigin(origin) && !configuredExtensionToken())) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${EXTENSION_TOKEN_HEADER}`,
    "Vary": "Origin"
  };
}

export function isTrustedExtensionRequest(headers: HeaderBag = {}): boolean {
  return isTrustedExtensionOrigin(headerValue(headers, "origin"))
    || extensionTokenMatches(headerValue(headers, EXTENSION_TOKEN_HEADER));
}

function isMutationMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function isJsonContentType(value: unknown): boolean {
  return /^application\/json(?:\s*;|$)/i.test(String(value || ""));
}

function isLocalOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host) && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isLocalHostHeader(value: unknown): boolean {
  const raw = String(value || "").trim();
  if (!raw) return true;
  try {
    const url = new URL(`http://${raw}`);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return false;
  }
}

function isLocalRequestHost(headers: HeaderBag, url: URL | null): boolean {
  const host = headerValue(headers, "host");
  if (host) return isLocalHostHeader(host);
  const hostname = String(url?.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return ["127.0.0.1", "localhost", "::1"].includes(hostname);
}

function isExtensionOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isTrustedExtensionOrigin(value: string): boolean {
  if (!isExtensionOrigin(value)) return false;
  return configuredExtensionOrigins().has(normalizedOrigin(value));
}

function configuredExtensionOrigins(): Set<string> {
  const origins = [
    ...csvEnv("VIGIL_EXTENSION_ORIGINS"),
    ...csvEnv("VIGIL_EXTENSION_ORIGIN"),
    ...csvEnv("VIGIL_EXTENSION_ORIGINS"),
    ...csvEnv("VIGIL_EXTENSION_ORIGIN"),
    ...extensionIdOrigins(csvEnv("VIGIL_EXTENSION_IDS")),
    ...extensionIdOrigins(csvEnv("VIGIL_EXTENSION_ID")),
    ...extensionIdOrigins(csvEnv("VIGIL_EXTENSION_IDS")),
    ...extensionIdOrigins(csvEnv("VIGIL_EXTENSION_ID"))
  ];
  return new Set(origins.map(normalizedOrigin).filter(Boolean));
}

function extensionIdOrigins(ids: string[]): string[] {
  return ids.flatMap((id) => {
    const clean = id.trim();
    if (!clean) return [];
    return [
      `chrome-extension://${clean}`,
      `moz-extension://${clean}`,
      `safari-web-extension://${clean}`
    ];
  });
}

function configuredExtensionToken(): string {
  return String(process.env.VIGIL_EXTENSION_TOKEN || process.env.VIGIL_EXTENSION_TOKEN || "");
}

function extensionTokenMatches(value: unknown): boolean {
  const expected = configuredExtensionToken();
  const supplied = String(value || "");
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function csvEnv(name: string): string[] {
  return String(process.env[name] || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (isExtensionOrigin(value)) return `${url.protocol}//${url.hostname.toLowerCase()}`;
    return url.origin;
  } catch {
    return "";
  }
}

function headerValue(headers: HeaderBag, name: string): string {
  const lowerName = name.toLowerCase();
  if (!headers) return "";
  if (headers instanceof Headers) return String(headers.get(name) || "");
  const record = headers as Record<string, unknown>;
  const value = record[lowerName] ?? record[name];
  return Array.isArray(value) ? value.join(",") : String(value || "");
}

function allow(): GuardResult {
  return { ok: true };
}

function deny(error: string): GuardResult {
  return { ok: false, status: 403, error };
}
