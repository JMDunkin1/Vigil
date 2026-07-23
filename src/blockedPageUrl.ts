import { PORT } from "./defaults.js";

export const BLOCKED_PAGE_ESCAPE_FALLBACK = "about:blank";

export interface BlockedPageUrlOptions {
  site?: unknown;
  until?: unknown;
  mode?: unknown;
  kind?: unknown;
  policyId?: unknown;
  lockId?: unknown;
  backUrl?: unknown;
  port?: number;
}

export interface VigilLocalSiteAllowListItem {
  address: string;
  pageTitle: string;
}

export function buildBlockedPageUrl(options: BlockedPageUrlOptions = {}): string {
  const port = options.port || PORT;
  const target = new URL(`http://127.0.0.1:${port}/blocked`);
  target.searchParams.set("site", blockedPageDisplayLabel(options.site));
  setSafeMetadata(target, "until", options.until, /^[0-9TZ:.-]{1,40}$/u);
  setSafeMetadata(target, "mode", options.mode, /^[a-z0-9_-]{1,40}$/iu);
  setSafeMetadata(target, "kind", options.kind, /^[a-z0-9_-]{1,40}$/iu);
  setSafeMetadata(target, "policyId", options.policyId, /^[a-z0-9:_-]{1,160}$/iu);
  setSafeMetadata(target, "lockId", options.lockId, /^[a-z0-9:_-]{1,160}$/iu);
  const backUrl = safeExternalPageUrl(options.backUrl);
  if (backUrl) target.searchParams.set("back", backUrl);
  return target.toString();
}

export function blockedPageDisplayLabel(value: unknown): string {
  const label = String(value || "").replace(/\s+/gu, " ").trim().slice(0, 80);
  if (!label) return "This page";
  // Apple's managed web filter inspects the complete requested URL. Never put
  // a denied hostname or path into Vigil's own blocker URL just to display it.
  if (/[:/?#@%]/u.test(label) || /[a-z0-9-]+(?:\.[a-z0-9-]+)+/iu.test(label)) {
    return "This page";
  }
  return label;
}

export function safeExternalPageUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    if (
      !["http:", "https:"].includes(url.protocol)
      || isLoopbackHost(url.hostname)
      || url.username
      || url.password
    ) return "";
    return url.toString();
  } catch {
    return "";
  }
}

export function vigilLocalSiteAllowList(port = PORT): VigilLocalSiteAllowListItem[] {
  return ["127.0.0.1", "localhost"].map((host) => ({
    address: `http://${host}:${port}/`,
    pageTitle: "Vigil"
  }));
}

export function managedFilterAllowsVigilPages(value: unknown, port = PORT): boolean {
  if (!Array.isArray(value)) return false;
  const addresses = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return String((item as Record<string, unknown>).address || "");
    })
    .map(normalizedAllowAddress)
    .filter(Boolean);
  const requiredPages = ["127.0.0.1", "localhost"].flatMap((host) => ["blocked", "pause"].map((path) => (
    normalizedAllowAddress(`http://${host}:${port}/${path}`)
  )));
  return requiredPages.every((required) => addresses.some((address) => required.startsWith(address)));
}

function normalizedAllowAddress(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    if (
      url.protocol !== "http:"
      || !isLoopbackHost(url.hostname)
      || url.username
      || url.password
      || url.href.includes("?")
      || url.href.includes("#")
    ) return "";
    return `${url.protocol}//${url.hostname.toLowerCase()}:${url.port || "80"}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}`;
  } catch {
    return "";
  }
}

function setSafeMetadata(target: URL, key: string, value: unknown, pattern: RegExp): void {
  const text = String(value || "").trim();
  if (pattern.test(text)) target.searchParams.set(key, text);
}

function isLoopbackHost(value: unknown): boolean {
  const host = String(value || "")
    .replace(/^\[|\]$/gu, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "::" || host === "::1") return true;
  const ipv4 = host.match(/^(\d{1,3})(?:\.(\d{1,3})){3}$/u);
  if (ipv4 && [0, 127].includes(Number(ipv4[1]))) return true;
  const mapped = host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u);
  if (!mapped) return false;
  const high = Number.parseInt(mapped[1] || "", 16);
  const low = Number.parseInt(mapped[2] || "", 16);
  return Number.isFinite(high) && Number.isFinite(low) && [0, 127].includes(high >>> 8);
}
