import { BROWSERS, STRICT_UNSUPPORTED_BROWSERS } from "./defaults.js";

export const BROWSER_FILTER_REVISION = "2026-09-17.1";
export type ProtectedBrowser = "Safari" | "Google Chrome";
const HEALTH_TTL_MS = 8_000;
// A report may wait for the 1.5s content heartbeat and the native bridge's
// 4s request timeout. Keep recovery bounded, but do not race that transport.
export const BROWSER_HEALTH_RECOVERY_MS = 6_000;
const pageHealth = new Map<ProtectedBrowser, { url: string; seenAt: number }>();
// A late native reply from the previous tab must not overwrite evidence for
// the current page. Every entry retains the same short, URL-specific lifetime.
const recentPageHealth = new Map<ProtectedBrowser, Map<string, number>>();
const MAX_RECENT_PAGES = 32;
const unprotectedSince = new Map<ProtectedBrowser, { url: string; startedAt: number; elapsedMs: number; runningSince: number | null }>();
let observedForeground: ProtectedBrowser | null | undefined;
const protectionSuspensions = new Set<"system-suspend" | "screen-lock">();
export const BROWSER_NAVIGATION_PROOF_TTL_MS = 3_000;
interface NavigationProof { url: string; documentUrl: string; seenAt: number; expiresAt: number; tabId: number; windowId: number }
const navigationProofs = new Map<ProtectedBrowser, NavigationProof>();
const navigationSequences = new Map<ProtectedBrowser, { epoch: number; sequence: number }>();
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
  let recent = recentPageHealth.get(browser);
  if (!recent) { recent = new Map(); recentPageHealth.set(browser, recent); }
  for (const [page, seenAt] of recent) {
    if (now < seenAt || now - seenAt >= HEALTH_TTL_MS) recent.delete(page);
  }
  recent.delete(key);
  recent.set(key, now);
  while (recent.size > MAX_RECENT_PAGES) recent.delete(recent.keys().next().value!);
  if (unprotectedSince.get(browser)?.url === key) unprotectedSince.delete(browser);
  return true;
}

// Browser-owned navigation evidence is deliberately separate from a successful
// content-filter scan. It proves the requested URL has not replaced the old
// document yet, and never marks the destination as protected.
export function recordBrowserNavigationProof(browser: ProtectedBrowser, report: Record<string, unknown>, now = Date.now()): boolean {
  const { epoch, sequence, observedAt } = report;
  if (report.revision !== BROWSER_FILTER_REVISION || !Number.isSafeInteger(epoch) || !Number.isSafeInteger(sequence)
    || typeof epoch !== "number" || epoch <= 0 || epoch > now || typeof sequence !== "number" || sequence < 1
    || typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt > now
    || (report.phase !== "pending" && report.phase !== "clear")) return false;
  const previous = navigationSequences.get(browser);
  if (previous && (epoch < previous.epoch || (epoch === previous.epoch && sequence <= previous.sequence))) return false;
  if (report.phase === "pending" && now - observedAt >= BROWSER_NAVIGATION_PROOF_TTL_MS) return false;
  const key = pageKey(String(report.url || ""));
  // Safari exposes its native Start Page as a favorites:// tab with a real
  // top-frame identity but an explicitly empty frame URL. The companion only
  // emits this exact sentinel after validating that browser-owned combination.
  // No other empty/redacted URL or browser-internal page qualifies.
  const nativeDocument = report.documentUrl === "about:blank"
    || (browser === "Safari" && report.documentUrl === "favorites://");
  const documentUrl = nativeDocument ? String(report.documentUrl) : pageKey(String(report.documentUrl || ""));
  if (report.phase === "pending" && (!key || !documentUrl || key === documentUrl
    || !Number.isSafeInteger(report.tabId) || Number(report.tabId) < 0
    || !Number.isSafeInteger(report.windowId) || Number(report.windowId) < 0)) return false;
  advanceRecoveryClocks(now);
  navigationSequences.set(browser, { epoch, sequence });
  navigationProofs.delete(browser);
  if (report.phase === "clear") return true;
  const documentSeenAt = recentPageHealth.get(browser)?.get(documentUrl!);
  if (!nativeDocument && (documentSeenAt === undefined || now < documentSeenAt || now - documentSeenAt >= HEALTH_TTL_MS)) return false;
  navigationProofs.set(browser, {
    url: key!, documentUrl: documentUrl!, seenAt: now,
    expiresAt: Math.min(observedAt + BROWSER_NAVIGATION_PROOF_TTL_MS, nativeDocument ? Infinity : documentSeenAt! + HEALTH_TTL_MS),
    tabId: Number(report.tabId), windowId: Number(report.windowId)
  });
  return true;
}

function unprotectedElapsed(browser: ProtectedBrowser, pending: { url: string; runningSince: number | null }, now: number): number {
  if (pending.runningSince === null) return 0;
  if (now < pending.runningSince) return BROWSER_HEALTH_RECOVERY_MS;
  const proof = navigationProofs.get(browser);
  const protectedMs = proof?.url === pending.url
    ? Math.max(0, Math.min(now, proof.expiresAt) - Math.max(pending.runningSince, proof.seenAt)) : 0;
  return now - pending.runningSince - protectedMs;
}

export function browserNavigationDocument(name: string, value: string, now = Date.now()): string | null {
  const browser = protectedBrowser(name);
  const proof = browser ? navigationProofs.get(browser) : undefined;
  return proof && proof.url === pageKey(value) && pageKey(proof.documentUrl)
    && now >= proof.seenAt && now < proof.expiresAt ? proof.documentUrl : null;
}

// Only actual foreground observations may pause this clock. Policy evaluation
// also runs for background processes and delayed effect bookkeeping.
export function observeBrowserProtectionForeground(name: string, now = Date.now()): void {
  observedForeground = protectedBrowser(name);
  advanceRecoveryClocks(now);
}

// Called only from Electron's trusted native power events. A locked or sleeping
// Mac cannot consume a foreground browsing budget, and foreground probes during
// that interval must not resume it. Keep separate reasons: wake can precede unlock.
export function setBrowserProtectionSuspended(reason: "system-suspend" | "screen-lock", suspended: boolean, now = Date.now()): void {
  if (suspended) protectionSuspensions.add(reason);
  else protectionSuspensions.delete(reason);
  advanceRecoveryClocks(now);
}

function advanceRecoveryClocks(now: number): void {
  for (const [browser, pending] of unprotectedSince) {
    if (pending.runningSince !== null) {
      // A clock rollback cannot grant extra unprotected browsing time.
      pending.elapsedMs += unprotectedElapsed(browser, pending, now);
    }
    pending.runningSince = protectionSuspensions.size === 0 && (observedForeground === undefined || browser === observedForeground) ? now : null;
  }
}

export function browserPageNeedsProtection(name: string, value: string, now = Date.now(), options: { observe?: boolean } = {}): boolean {
  const browser = protectedBrowser(name);
  const url = pageKey(value);
  if (!browser || !url) return false;
  const seenAt = recentPageHealth.get(browser)?.get(url);
  if (seenAt !== undefined && now >= seenAt && now - seenAt < HEALTH_TTL_MS) {
    if (options.observe !== false) unprotectedSince.delete(browser);
    return false;
  }
  // One cumulative foreground budget per browser, not per URL. Switching apps
  // pauses the budget; returning or navigating cannot renew it. An inactive
  // browser may suspend the very content script whose report we are awaiting.
  const started = unprotectedSince.get(browser);
  if (started === undefined) {
    if (options.observe === false) return false;
    unprotectedSince.set(browser, { url, startedAt: now, elapsedMs: 0,
      runningSince: protectionSuspensions.size === 0 && (observedForeground === undefined || observedForeground === browser) ? now : null });
    return false;
  }
  if (options.observe !== false && started.url !== url) {
    // Settle the old target before switching: a proof for it cannot subsidize
    // time on a newly visible, unprotected document.
    advanceRecoveryClocks(now);
    started.url = url;
  }
  const proof = navigationProofs.get(browser);
  if (proof?.url === url && now >= proof.seenAt && now < proof.expiresAt) return false;
  const runningMs = unprotectedElapsed(browser, started, now);
  return now < started.startedAt || started.elapsedMs + runningMs >= BROWSER_HEALTH_RECOVERY_MS;
}

export function resetBrowserProtectionHealthForTest(): void {
  pageHealth.clear(); recentPageHealth.clear(); unprotectedSince.clear(); discoveredBrowsers.clear(); protectionSuspensions.clear(); navigationProofs.clear(); navigationSequences.clear(); observedForeground = undefined;
}

// Keep failure evidence useful without persisting sign-in tokens, query values,
// fragments, or form contents from the page URL.
export function browserProtectionDiagnostic(name: string, value: string, now = Date.now()) {
  const browser = protectedBrowser(name);
  const key = pageKey(value);
  const latest = browser ? pageHealth.get(browser) : undefined;
  const matchingAt = browser && key ? recentPageHealth.get(browser)?.get(key) : undefined;
  const pending = browser ? unprotectedSince.get(browser) : undefined;
  const navigation = browser ? navigationProofs.get(browser) : undefined;
  const navigationSequence = browser ? navigationSequences.get(browser) : undefined;
  const navigationSource = navigation && pageKey(navigation.documentUrl) ? new URL(navigation.documentUrl) : null;
  const expected = key ? new URL(key) : null;
  const reported = latest ? new URL(latest.url) : null;
  return {
    reason: matchingAt !== undefined
      ? now < matchingAt ? "clock-rollback" : now - matchingAt < HEALTH_TTL_MS ? "healthy" : "expired"
      : latest ? "different-page" : "no-report",
    reportAgeMs: matchingAt === undefined ? null : now - matchingAt,
    latestReportAgeMs: latest ? now - latest.seenAt : null,
    expectedHost: expected?.hostname ?? null,
    reportedHost: reported?.hostname ?? null,
    samePath: expected && reported ? expected.pathname === reported.pathname : null,
    sameQuery: expected && reported ? expected.search === reported.search : null,
    recoveryElapsedMs: pending && browser ? pending.elapsedMs + unprotectedElapsed(browser, pending, now) : 0,
    recoveryPaused: pending?.runningSince === null,
    navigation: {
      phase: navigation ? "pending" : navigationSequence ? "clear" : "absent",
      targetMatches: Boolean(navigation && navigation.url === key),
      sourceKind: navigationSource ? "web-document" : navigation?.documentUrl === "favorites://" ? "safari-start-page" : navigation?.documentUrl === "about:blank" ? "blank-document" : null,
      sourceHost: navigationSource?.hostname ?? null,
      ageMs: navigation ? now - navigation.seenAt : null,
      remainingMs: navigation ? Math.max(0, navigation.expiresAt - now) : 0,
      valid: Boolean(navigation && now >= navigation.seenAt && now < navigation.expiresAt),
      sequence: navigationSequence?.sequence ?? null
    }
  };
}

export function browserFilterHealthSummary(now = Date.now()) {
  return [...new Set([...pageHealth.keys(), ...navigationSequences.keys()])].map(browser => {
    const health = pageHealth.get(browser);
    const proof = navigationProofs.get(browser);
    return {
      browser, url: health?.url ?? null, ageMs: health ? now - health.seenAt : null,
      fresh: Boolean(health && now >= health.seenAt && now - health.seenAt < HEALTH_TTL_MS),
      awaitingUrl: unprotectedSince.get(browser)?.url ?? null,
      navigation: { ...navigationSequences.get(browser), phase: proof ? "pending" : "clear", url: proof?.url ?? null,
        documentUrl: proof?.documentUrl ?? null, ageMs: proof ? now - proof.seenAt : null,
        valid: Boolean(proof && now >= proof.seenAt && now < proof.expiresAt) }
    };
  });
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
