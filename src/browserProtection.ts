import { BROWSERS, STRICT_UNSUPPORTED_BROWSERS } from "./defaults.js";

export const BROWSER_FILTER_REVISION = "2026-09-17.1";
export type ProtectedBrowser = "Safari" | "Google Chrome";
const HEALTH_TTL_MS = 8_000;
const LOAD_WINDOW_MS = 1_500;
const pageHealth = new Map<ProtectedBrowser, { url: string; seenAt: number }>();
const unprotectedSince = new Map<ProtectedBrowser, number>();
const discoveredBrowsers = new Map<string, string>();

export function registerBrowserApplication(name: string, bundleId: string, handlesWebURLs: boolean): void {
  // Codex registers HTTP URLs for its development preview, but is not a
  // general-purpose browser. Preserve the intentional development boundary.
  if (["com.openai.codex", "com.openai.chat", "com.apple.finder"].includes(bundleId)) { discoveredBrowsers.delete(name); return; }
  if (handlesWebURLs || knownBrowser(name)) discoveredBrowsers.set(name, bundleId);
}

export function knownBrowser(name: string): boolean {
  return BROWSERS.has(name) || STRICT_UNSUPPORTED_BROWSERS.some(value => value.toLowerCase() === name.toLowerCase()) || discoveredBrowsers.has(name);
}

export function protectedBrowser(name: string): ProtectedBrowser | null {
  if (name !== "Safari" && name !== "Google Chrome") return null;
  const identity = discoveredBrowsers.get(name);
  if (identity && identity !== (name === "Safari" ? "com.apple.Safari" : "com.google.Chrome")) return null;
  return name;
}

export function unsupportedBrowser(name: string): boolean {
  return knownBrowser(name) && !protectedBrowser(name);
}

function pageKey(value: string): string | null {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

export function recordBrowserFilterHealth(browser: ProtectedBrowser, url: string, revision: unknown, now = Date.now()): boolean {
  const key = pageKey(url);
  if (!key || revision !== BROWSER_FILTER_REVISION) return false;
  pageHealth.set(browser, { url: key, seenAt: now });
  unprotectedSince.delete(browser);
  return true;
}

export function browserPageNeedsProtection(name: string, value: string, now = Date.now()): boolean {
  const browser = protectedBrowser(name);
  const url = pageKey(value);
  if (!browser || !url) return false;
  const health = pageHealth.get(browser);
  if (health?.url === url && now >= health.seenAt && now - health.seenAt < HEALTH_TTL_MS) {
    return false;
  }
  // One bounded loading window per browser, not per URL: navigating repeatedly
  // cannot continually renew an unprotected browser's grace period.
  const started = unprotectedSince.get(browser);
  if (started === undefined) { unprotectedSince.set(browser, now); return false; }
  return now < started || now - started >= LOAD_WINDOW_MS;
}

export function resetBrowserProtectionHealthForTest(): void {
  pageHealth.clear(); unprotectedSince.clear(); discoveredBrowsers.clear();
}

export function browserFilterHealthSummary(now = Date.now()) {
  return [...pageHealth].map(([browser, health]) => ({ browser, ageMs: now - health.seenAt, fresh: now >= health.seenAt && now - health.seenAt < HEALTH_TTL_MS }));
}

export function bundleDeclaresWebBrowser(info: {
  CFBundleURLTypes?: Array<{ CFBundleURLSchemes?: string[] }>;
  CFBundleDocumentTypes?: Array<{ CFBundleTypeRole?: string; LSItemContentTypes?: string[]; CFBundleTypeExtensions?: string[]; CFBundleTypeMIMETypes?: string[] }>;
}): boolean {
  const schemes = new Set((info.CFBundleURLTypes || []).flatMap(type => type.CFBundleURLSchemes || []).map(value => value.toLowerCase()));
  const viewsHTML = (info.CFBundleDocumentTypes || []).some(type =>
    type.CFBundleTypeRole === "Viewer" && (
      (type.LSItemContentTypes || []).some(value => ["public.html", "public.xhtml"].includes(value)) ||
      (type.CFBundleTypeExtensions || []).some(value => ["html", "htm", "xhtml"].includes(value.toLowerCase())) ||
      (type.CFBundleTypeMIMETypes || []).includes("text/html")
    ));
  return schemes.has("http") && schemes.has("https") && viewsHTML;
}
