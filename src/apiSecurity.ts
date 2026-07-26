import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { BUILT_IN_CHROME_EXTENSION_ID } from "./defaults.js";
import type { UnknownRecord } from "./types.js";

export const CONTROL_INTENT_HEADER = "x-vigil-intent";
export const CONTROL_INTENT_VALUE = "vigil-app";
export const EXTENSION_ID_HEADER = "x-vigil-extension-id";
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

export interface GuardResult {
  ok: boolean;
  status?: number;
  error?: string;
  kind?: string;
  deviceId?: string;
}

export interface RequestTransportContext {
  remoteAddress?: string | null;
  trustedLoopback?: boolean;
}

export interface GuardInput extends RequestTransportContext {
  method?: string;
  path?: string;
  headers?: HeaderBag;
}

export interface ExtensionTrustSummary {
  trusted: boolean;
  trustedBy: "origin" | "token" | "none";
  requestOrigin: string | null;
  normalizedOrigin: string | null;
  extensionId: string | null;
  tokenConfigured: boolean;
  tokenSupplied: boolean;
  tokenHeader: string;
  configuredOriginCount: number;
  suggestedOriginEnv: string | null;
  suggestedIdEnv: string | null;
  suggestedTokenEnv: string;
}

interface DeviceUsageAuthorizationInput extends RequestTransportContext {
  headers?: HeaderBag;
  url?: URL | null;
  body?: UnknownRecord;
  deviceTokens?: Record<string, string>;
}

export function apiRequestGuard({ method = "GET", path = "", headers = {}, remoteAddress = null, trustedLoopback = false }: GuardInput): GuardResult {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (EXTENSION_API_PATHS.has(path)) return extensionApiRequestGuard({ method: normalizedMethod, headers, remoteAddress, trustedLoopback });
  if (DEVICE_SYNC_API_PATHS.has(path)) return allow();
  if (!isMutationMethod(normalizedMethod)) return allow();
  if (hostedAccountsEnabled()) return hostedMutationGuard({ method: normalizedMethod, headers });

  return localMutationGuard({ method: normalizedMethod, headers, remoteAddress, trustedLoopback });
}

export function localControlRequestGuard({
  method = "POST",
  headers = {},
  remoteAddress = null,
  trustedLoopback = false
}: GuardInput): GuardResult {
  return localMutationGuard({ method, headers, remoteAddress, trustedLoopback });
}

function hostedMutationGuard({ method = "GET", headers = {} }: GuardInput): GuardResult {
  const origin = headerValue(headers, "origin");
  const host = headerValue(headers, "host").toLowerCase();
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== host) return deny("Cross-origin mutation blocked.");
    } catch {
      return deny("Cross-origin mutation blocked.");
    }
  }

  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) return deny("Cross-site mutation blocked.");
  if (method === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
    return deny("Mutation requests must use application/json.");
  }
  return allow();
}

function extensionApiRequestGuard({ method = "GET", headers = {}, remoteAddress = null, trustedLoopback = false }: GuardInput): GuardResult {
  const extensionGuard = extensionRequestGuard({ method, headers, remoteAddress, trustedLoopback });
  if (extensionGuard.ok) return extensionGuard;

  if (!isMutationMethod(method) || hostedAccountsEnabled()) return extensionGuard;
  return localMutationGuard({ method, headers, remoteAddress, trustedLoopback });
}

function localMutationGuard({ method = "GET", headers = {}, remoteAddress = null, trustedLoopback = false }: GuardInput): GuardResult {
  if (!isDirectLoopbackRequest(headers, { remoteAddress, trustedLoopback })) {
    return deny("Local mutations require a loopback connection.");
  }

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

export function publicHostGuard({ path = "", headers = {}, remoteAddress = null, trustedLoopback = false }: GuardInput): GuardResult {
  if (String(path || "").startsWith("/mdm/")) return allow();
  if (DEVICE_SYNC_API_PATHS.has(path)) return allow();
  if (isDirectLoopbackRequest(headers, { remoteAddress, trustedLoopback })) return allow();
  if (hostedAccountsEnabled() && configuredPublicHosts().has(normalizedHost(headerValue(headers, "host")))) return allow();
  return deny("Public tunnel requests may only reach MDM endpoints.");
}

export function deviceUsageSyncAuthorization({
  headers = {},
  url = null,
  body = {},
  deviceTokens = {},
  remoteAddress = null,
  trustedLoopback = false
}: DeviceUsageAuthorizationInput = {}): GuardResult {
  if (
    headerValue(headers, CONTROL_INTENT_HEADER) === CONTROL_INTENT_VALUE
    && isDirectLoopbackRequest(headers, { remoteAddress, trustedLoopback })
  ) {
    return { ok: true, kind: "local-intent" };
  }

  const deviceId = String(
    headerValue(headers, "x-vigil-device-id")
    || url?.searchParams?.get("deviceId")
    || body.deviceId
    || ""
  );
  const token = String(deviceTokens[deviceId] || "");
  const supplied = String(
    headerValue(headers, "x-vigil-device-token")
    || url?.searchParams?.get("token")
    || body?.token
    || ""
  );
  if (deviceId && secretMatches(token, supplied)) return { ok: true, kind: "device-token", deviceId };

  return deny("Device usage sync requires a local app intent header or the iOS device token.");
}

export function extensionRequestGuard({ method = "GET", headers = {}, remoteAddress = null, trustedLoopback = false }: GuardInput): GuardResult {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const origin = headerValue(headers, "origin");
  const localTransport = isDirectLoopbackRequest(headers, { remoteAddress, trustedLoopback });

  if (normalizedMethod === "OPTIONS") {
    const originTrustedLocally = localTransport && isTrustedExtensionOrigin(origin);
    if (!origin || !isExtensionOrigin(origin) || (!originTrustedLocally && !configuredExtensionToken())) {
      return deny("Untrusted extension origin blocked.");
    }
    return allow();
  }

  const trustedOrigin = Boolean(localTransport && origin && isTrustedExtensionOrigin(origin));
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

export function extensionCorsHeaders(headers: HeaderBag = {}, transport: RequestTransportContext = {}): Record<string, string> {
  const origin = headerValue(headers, "origin");
  const trustedLocalOrigin = isDirectLoopbackRequest(headers, transport) && isTrustedExtensionOrigin(origin);
  if (!origin || !isExtensionOrigin(origin) || (!trustedLocalOrigin && !configuredExtensionToken())) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${EXTENSION_ID_HEADER}, ${EXTENSION_TOKEN_HEADER}`,
    "Vary": "Origin"
  };
}

export function isTrustedExtensionRequest(headers: HeaderBag = {}, transport: RequestTransportContext = {}): boolean {
  return (isDirectLoopbackRequest(headers, transport) && isTrustedExtensionOrigin(headerValue(headers, "origin")))
    || extensionTokenMatches(headerValue(headers, EXTENSION_TOKEN_HEADER));
}

export function extensionTrustSummary(headers: HeaderBag = {}, transport: RequestTransportContext = {}): ExtensionTrustSummary {
  const requestOrigin = headerValue(headers, "origin");
  const normalized = requestOrigin ? normalizedOrigin(requestOrigin) : "";
  const trustedOrigin = Boolean(isDirectLoopbackRequest(headers, transport) && requestOrigin && isTrustedExtensionOrigin(requestOrigin));
  const suppliedExtensionId = headerValue(headers, EXTENSION_ID_HEADER).trim().toLowerCase();
  const trustedToken = extensionTokenMatches(headerValue(headers, EXTENSION_TOKEN_HEADER));
  const extensionId = extensionIdFromOrigin(requestOrigin) || suppliedExtensionId;
  return {
    trusted: trustedOrigin || trustedToken,
    trustedBy: trustedOrigin ? "origin" : (trustedToken ? "token" : "none"),
    requestOrigin: requestOrigin || null,
    normalizedOrigin: normalized || null,
    extensionId: extensionId || null,
    tokenConfigured: Boolean(configuredExtensionToken()),
    tokenSupplied: Boolean(headerValue(headers, EXTENSION_TOKEN_HEADER)),
    tokenHeader: EXTENSION_TOKEN_HEADER,
    configuredOriginCount: configuredExtensionOrigins().size,
    suggestedOriginEnv: normalized ? `VIGIL_EXTENSION_ORIGIN=${normalized}` : null,
    suggestedIdEnv: extensionId ? `VIGIL_EXTENSION_ID=${extensionId}` : null,
    suggestedTokenEnv: "VIGIL_EXTENSION_TOKEN=<shared-token>"
  };
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
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host) && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

export function isLoopbackHostHeader(value: unknown): boolean {
  const raw = String(value || "").trim();
  if (!raw) return false;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host);
  } catch {
    return false;
  }
}

export function isLoopbackRemoteAddress(value: unknown): boolean {
  const address = String(value || "").trim().toLowerCase();
  return address === "::1"
    || address === "127.0.0.1"
    || address === "::ffff:127.0.0.1";
}

function configuredPublicHosts(): Set<string> {
  return new Set(csvEnv("VIGIL_PUBLIC_HOSTS").map(normalizedHost).filter(Boolean));
}

function normalizedHost(value: unknown): string {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    return new URL(`http://${raw}`).host.toLowerCase();
  } catch {
    return "";
  }
}

function hostedAccountsEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(String(process.env.VIGIL_AUTH_ENABLED || "").trim().toLowerCase());
}

function isDirectLoopbackRequest(
  headers: HeaderBag,
  { remoteAddress = null, trustedLoopback = false }: RequestTransportContext
): boolean {
  if (trustedLoopback === true) return true;
  return isLoopbackRemoteAddress(remoteAddress)
    && isLoopbackHostHeader(headerValue(headers, "host"))
    && !hasForwardingHeaders(headers);
}

function hasForwardingHeaders(headers: HeaderBag): boolean {
  return [
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-forwarded-proto",
    "x-real-ip",
    "x-client-ip",
    "x-cluster-client-ip",
    "cf-connecting-ip",
    "true-client-ip",
    "fastly-client-ip",
    "fly-client-ip",
    "x-vercel-forwarded-for",
    "via"
  ].some((name) => Boolean(headerValue(headers, name)));
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
    ...extensionIdOrigins([BUILT_IN_CHROME_EXTENSION_ID]),
    ...csvEnv("VIGIL_EXTENSION_ORIGINS"),
    ...csvEnv("VIGIL_EXTENSION_ORIGIN"),
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
  return String(process.env.VIGIL_EXTENSION_TOKEN || "");
}

function extensionTokenMatches(value: unknown): boolean {
  return secretMatches(configuredExtensionToken(), String(value || ""));
}

function secretMatches(expected: string, supplied: string): boolean {
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

function extensionIdFromOrigin(value: string): string {
  try {
    const url = new URL(value);
    return isExtensionOrigin(value) ? url.hostname.toLowerCase() : "";
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
