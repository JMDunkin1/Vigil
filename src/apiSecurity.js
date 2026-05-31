export const CONTROL_INTENT_HEADER = "x-screen-time-intent";
export const CONTROL_INTENT_VALUE = "local-dashboard";

const EXTENSION_API_PATHS = new Set([
  "/api/extension/check",
  "/api/extension/rules",
  "/api/extension/rules/sync"
]);

export function apiRequestGuard({ method = "GET", path = "", headers = {} }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (EXTENSION_API_PATHS.has(path)) return allow();
  if (!isMutationMethod(normalizedMethod)) return allow();

  const origin = headerValue(headers, "origin");
  if (origin && !isLocalOrigin(origin)) {
    return deny("Cross-origin mutation blocked.");
  }

  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite && !["same-origin", "none"].includes(fetchSite)) {
    return deny("Cross-site mutation blocked.");
  }

  if (normalizedMethod === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
    return deny("Mutation requests must use application/json.");
  }

  if (headerValue(headers, CONTROL_INTENT_HEADER) !== CONTROL_INTENT_VALUE) {
    return deny("Missing local dashboard intent header.");
  }

  return allow();
}

export function publicHostGuard({ path = "", headers = {} }) {
  if (String(path || "").startsWith("/mdm/")) return allow();
  if (isLocalHostHeader(headerValue(headers, "host"))) return allow();
  return deny("Public tunnel requests may only reach MDM endpoints.");
}

export function controlIntentHeaders() {
  return { [CONTROL_INTENT_HEADER]: CONTROL_INTENT_VALUE };
}

export function extensionRequestGuard({ method = "GET", headers = {} }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const origin = headerValue(headers, "origin");
  if (origin && !isTrustedExtensionOrigin(origin) && !isLocalOrigin(origin)) {
    return deny("Untrusted extension origin blocked.");
  }

  const fetchSite = headerValue(headers, "sec-fetch-site").toLowerCase();
  if (fetchSite === "cross-site" && origin && !isTrustedExtensionOrigin(origin) && !isLocalOrigin(origin)) {
    return deny("Cross-site extension request blocked.");
  }

  if (normalizedMethod === "POST" && !isJsonContentType(headerValue(headers, "content-type"))) {
    return deny("Extension POST requests must use application/json.");
  }

  return allow();
}

export function extensionCorsHeaders(headers = {}) {
  const origin = headerValue(headers, "origin");
  if (!origin || (!isTrustedExtensionOrigin(origin) && !isLocalOrigin(origin))) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

export function isTrustedExtensionRequest(headers = {}) {
  return isTrustedExtensionOrigin(headerValue(headers, "origin"));
}

function isMutationMethod(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(method);
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;|$)/i.test(String(value || ""));
}

function isLocalOrigin(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ["127.0.0.1", "localhost", "::1"].includes(host) && ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function isLocalHostHeader(value) {
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

function isTrustedExtensionOrigin(value) {
  try {
    const url = new URL(value);
    return ["chrome-extension:", "moz-extension:", "safari-web-extension:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  const lowerName = name.toLowerCase();
  if (!headers) return "";
  if (typeof headers.get === "function") return String(headers.get(name) || "");
  return String(headers[lowerName] || headers[name] || "");
}

function allow() {
  return { ok: true };
}

function deny(error) {
  return { ok: false, status: 403, error };
}
