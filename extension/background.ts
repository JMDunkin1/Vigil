const DEFAULT_LOCAL_SERVER = "http://127.0.0.1:8787";
const EXTENSION_TOKEN_HEADER = "x-sentinel-extension-token";
const CONNECTION_DEFAULTS = {
  sentinelLocalServer: DEFAULT_LOCAL_SERVER,
  sentinelExtensionToken: ""
};
const manifest = chrome.runtime.getManifest();
const tabMemory = new Map<number, string>();
const recentChecks = new Map<string, number>();
const NOISE_RULE_START = 9100;
const SITE_BLOCK_RULE_START = 10000;
const CONTENT_BLOCK_RULE_START = 11000;
const ALLOWLIST_RULE_START = 12000;
const SITE_BLOCK_RULE_LIMIT = 300;
const CONTENT_BLOCK_RULE_LIMIT = 200;
const ALLOWLIST_RULE_LIMIT = 20;
const NOISE_RESOURCE_TYPES = ["script", "image", "xmlhttprequest", "sub_frame", "stylesheet", "media", "font", "ping", "other"];
const SITE_BLOCK_RESOURCE_TYPES = ["main_frame"];
const NOISE_BLOCK_DOMAINS = [
  "doubleclick.net",
  "googlesyndication.com",
  "googletagmanager.com",
  "google-analytics.com",
  "analytics.google.com",
  "adservice.google.com",
  "facebook.net",
  "connect.facebook.net",
  "scorecardresearch.com",
  "quantserve.com",
  "outbrain.com",
  "taboola.com",
  "criteo.com",
  "adnxs.com",
  "adsrvr.org",
  "rubiconproject.com",
  "pubmatic.com",
  "openx.net",
  "moatads.com",
  "hotjar.com",
  "segment.io",
  "amplitude.com",
  "fullstory.com",
  "intercom.io",
  "onesignal.com"
];
const NOISE_RULE_IDS = NOISE_BLOCK_DOMAINS.map((_, index) => NOISE_RULE_START + index);
const SITE_BLOCK_RULE_IDS = Array.from({ length: SITE_BLOCK_RULE_LIMIT }, (_, index) => SITE_BLOCK_RULE_START + index);
const CONTENT_BLOCK_RULE_IDS = Array.from({ length: CONTENT_BLOCK_RULE_LIMIT }, (_, index) => CONTENT_BLOCK_RULE_START + index);
const ALLOWLIST_RULE_IDS = Array.from({ length: ALLOWLIST_RULE_LIMIT }, (_, index) => ALLOWLIST_RULE_START + index);
let noiseRulesEnabled: boolean | null = null;
let siteRulesSignature = "";
let lastRuleSyncAt = 0;
let sentinelConnection = {
  localServer: DEFAULT_LOCAL_SERVER,
  extensionToken: ""
};

interface ExtensionPulseMessage {
  type?: string;
  url?: string;
  reason?: string;
  seconds?: number;
  title?: string;
}

interface ExtensionCheckResult {
  ok?: boolean;
  blocked?: boolean;
  paused?: boolean;
  redirectUrl?: string;
  browserNoiseBlockingEnabled?: boolean;
  [key: string]: unknown;
}

interface SiteRuleEntry {
  domain: string;
  redirectUrl: string;
}

interface ContentRuleEntry {
  urlFilter: string;
  redirectUrl: string;
}

interface AllowlistRuleEntry {
  excludedDomains: string[];
  redirectUrl: string;
}

interface ServerRuleEntry {
  domain?: unknown;
  redirectUrl?: unknown;
  urlFilter?: unknown;
  excludedDomains?: unknown;
}

interface RuleSnapshot {
  browserNoiseBlockingEnabled?: boolean;
  rules?: ServerRuleEntry[];
  contentRules?: ServerRuleEntry[];
  allowlistRules?: ServerRuleEntry[];
  dynamicRuleSignature?: string;
}

interface RuleSyncResult {
  ok: boolean;
  count: number;
  signature: string;
  error?: string;
}

type StorageDefaults = Record<string, unknown>;
type StorageResult<T extends StorageDefaults> = T & Record<string, unknown>;

void loadSentinelConnection();
void loadNoisePreference();
void syncSiteBlockingFromServer();
setInterval(() => {
  void syncSiteBlockingFromServer();
}, 15000);

chrome.runtime.onInstalled.addListener(loadNoisePreference);
chrome.runtime.onInstalled.addListener(syncSiteBlockingFromServer);
chrome.runtime.onStartup.addListener(loadNoisePreference);
chrome.runtime.onStartup.addListener(syncSiteBlockingFromServer);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.sentinelLocalServer && !changes.sentinelExtensionToken)) return;
  void loadSentinelConnection().then(() => syncSiteBlockingFromServer());
});

chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  void checkUrl(details.tabId, details.url, "navigation");
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0) return;
  void checkUrl(details.tabId, details.url, "history");
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  void checkUrl(tabId, changeInfo.url, "navigation", 0, tab.title);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await getTab(tabId);
  if (tab?.url) void checkUrl(tabId, tab.url, "activated", 0, tab.title);
});

chrome.runtime.onMessage.addListener((message: ExtensionPulseMessage, sender, sendResponse: (response?: unknown) => void) => {
  if (message?.type !== "SENTINEL_PULSE") return false;
  checkUrl(sender.tab?.id, message.url || "", message.reason || "heartbeat", message.seconds, message.title)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMemory.delete(tabId);
});

async function checkUrl(tabId: number | undefined, url: string, event: string, seconds = 0, title = ""): Promise<ExtensionCheckResult> {
  if (!tabId || isSkippableUrl(url)) return { ok: true, skipped: true };
  if (isCoolingDown(tabId, url, event)) return { ok: true, skipped: true };

  const previousUrl = tabMemory.get(tabId) || "";
  tabMemory.set(tabId, url);

  const response = await fetchSentinel("/api/extension/check", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url,
      previousUrl,
      event,
      seconds,
      title,
      extensionVersion: manifest.version
    })
  });

  if (!response.ok) {
    await setBadge(tabId, "OFF", "#9b2f2f");
    return { ok: false, status: response.status };
  }

  const result = await response.json() as ExtensionCheckResult;
  if (typeof result.browserNoiseBlockingEnabled === "boolean") {
    await syncNoiseBlocking(result.browserNoiseBlockingEnabled);
  }
  if ((result.blocked || result.paused) && result.redirectUrl && url !== result.redirectUrl) {
    await setBadge(tabId, result.paused ? "WAIT" : "LOCK", result.paused ? "#b67618" : "#9b2f2f");
    await updateTab(tabId, { url: result.redirectUrl });
  } else {
    await setBadge(tabId, "", "#126a6f");
  }
  void maybeSyncSiteBlocking();
  return result;
}

function isSkippableUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return true;
    const localServer = new URL(sentinelConnection.localServer);
    return sameHost(url, localServer) && normalizedPort(url) === normalizedPort(localServer);
  } catch {
    return true;
  }
}

function isCoolingDown(tabId: number, url: string, event: string): boolean {
  const key = `${tabId}:${event}:${url}`;
  const now = Date.now();
  const until = recentChecks.get(key) || 0;
  if (until > now) return true;
  recentChecks.set(key, now + (event === "heartbeat" ? 3500 : 1000));
  for (const [item, expiry] of recentChecks) {
    if (expiry <= now) recentChecks.delete(item);
  }
  return false;
}

function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => resolve(chrome.runtime.lastError ? null : tab));
  });
}

function updateTab(tabId: number, change: chrome.tabs.UpdateProperties): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, change, () => resolve(!chrome.runtime.lastError));
  });
}

function setBadge(tabId: number, text: string, color: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.action.setBadgeBackgroundColor({ tabId, color }, () => {
      chrome.action.setBadgeText({ tabId, text }, () => resolve(!chrome.runtime.lastError));
    });
  });
}

async function loadNoisePreference() {
  const stored = await storageGet({ browserNoiseBlockingEnabled: false });
  await syncNoiseBlocking(Boolean(stored.browserNoiseBlockingEnabled));
}

async function syncNoiseBlocking(enabled: boolean): Promise<boolean> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return false;
  if (noiseRulesEnabled === enabled) return true;

  const addRules = enabled ? noiseRules() : [];
  const ok = await updateDynamicRules({
    removeRuleIds: NOISE_RULE_IDS,
    addRules
  });
  if (!ok) return false;

  noiseRulesEnabled = enabled;
  await storageSet({ browserNoiseBlockingEnabled: enabled });
  return true;
}

async function maybeSyncSiteBlocking() {
  if (Date.now() - lastRuleSyncAt < 10000) return;
  await syncSiteBlockingFromServer();
}

async function syncSiteBlockingFromServer() {
  lastRuleSyncAt = Date.now();
  try {
    const response = await fetchSentinel(`/api/extension/rules?version=${encodeURIComponent(manifest.version)}`);
    if (!response.ok) throw new Error(`rules ${response.status}`);
    const snapshot = await response.json() as RuleSnapshot;
    if (typeof snapshot.browserNoiseBlockingEnabled === "boolean") {
      await syncNoiseBlocking(snapshot.browserNoiseBlockingEnabled);
    }
    const result = await syncSiteBlocking(snapshot.rules || [], snapshot.contentRules || [], snapshot.allowlistRules || []);
    result.signature = snapshot.dynamicRuleSignature || result.signature;
    await reportRuleSync(result);
  } catch {
    await syncSiteBlocking([], [], []);
  }
}

async function syncSiteBlocking(entries: ServerRuleEntry[], contentEntries: ServerRuleEntry[] = [], allowlistEntries: ServerRuleEntry[] = []): Promise<RuleSyncResult> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return { ok: false, count: 0, signature: "", error: "Declarative Net Request is unavailable" };
  }
  const safeEntries = normalizeSiteRuleEntries(entries).slice(0, SITE_BLOCK_RULE_LIMIT);
  const safeContentEntries = normalizeContentRuleEntries(contentEntries).slice(0, CONTENT_BLOCK_RULE_LIMIT);
  const safeAllowlistEntries = normalizeAllowlistRuleEntries(allowlistEntries).slice(0, ALLOWLIST_RULE_LIMIT);
  const count = safeEntries.length + safeContentEntries.length + safeAllowlistEntries.length;
  const signature = JSON.stringify({ site: safeEntries, content: safeContentEntries, allowlist: safeAllowlistEntries });
  if (siteRulesSignature === signature) return { ok: true, count, signature };

  const ok = await updateDynamicRules({
    removeRuleIds: [...SITE_BLOCK_RULE_IDS, ...CONTENT_BLOCK_RULE_IDS, ...ALLOWLIST_RULE_IDS],
    addRules: [
      ...siteBlockRules(safeEntries),
      ...contentBlockRules(safeContentEntries),
      ...allowlistBlockRules(safeAllowlistEntries)
    ]
  });
  if (!ok) return { ok: false, count, signature, error: "Dynamic rule update failed" };

  siteRulesSignature = signature;
  await storageSet({ siteBlockRules: { count, syncedAt: new Date().toISOString() } });
  return { ok: true, count, signature };
}

async function reportRuleSync(result: RuleSyncResult): Promise<void> {
  try {
    await fetchSentinel("/api/extension/rules/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ok: Boolean(result?.ok),
        count: result?.count || 0,
        signature: result?.signature || "",
        error: result?.error || "",
        extensionVersion: manifest.version
      })
    });
  } catch {
    // The next rules poll or tab check will try again.
  }
}

function noiseRules(): chrome.declarativeNetRequest.Rule[] {
  return NOISE_BLOCK_DOMAINS.map((domain, index) => ({
    id: NOISE_RULE_START + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: NOISE_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function siteBlockRules(entries: SiteRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: SITE_BLOCK_RULE_START + index,
    priority: 100,
    action: {
      type: "redirect",
      redirect: { url: entry.redirectUrl }
    },
    condition: {
      urlFilter: `||${entry.domain}^`,
      resourceTypes: SITE_BLOCK_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function contentBlockRules(entries: ContentRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: CONTENT_BLOCK_RULE_START + index,
    priority: 90,
    action: {
      type: "redirect",
      redirect: { url: entry.redirectUrl }
    },
    condition: {
      urlFilter: entry.urlFilter,
      resourceTypes: SITE_BLOCK_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function allowlistBlockRules(entries: AllowlistRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: ALLOWLIST_RULE_START + index,
    priority: 80,
    action: {
      type: "redirect",
      redirect: { url: entry.redirectUrl }
    },
    condition: {
      regexFilter: "^https?://",
      excludedRequestDomains: entry.excludedDomains,
      resourceTypes: SITE_BLOCK_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function normalizeSiteRuleEntries(entries: ServerRuleEntry[]): SiteRuleEntry[] {
  const seen = new Set<string>();
  const output: SiteRuleEntry[] = [];
  for (const entry of entries || []) {
    const domain = normalizeDomain(entry.domain);
    const redirectUrl = safeLocalRedirect(entry.redirectUrl);
    if (!domain || !redirectUrl || seen.has(domain)) continue;
    seen.add(domain);
    output.push({ domain, redirectUrl });
  }
  return output.sort((a, b) => a.domain.localeCompare(b.domain));
}

function normalizeContentRuleEntries(entries: ServerRuleEntry[]): ContentRuleEntry[] {
  const seen = new Set<string>();
  const output: ContentRuleEntry[] = [];
  for (const entry of entries || []) {
    const urlFilter = safeUrlFilter(entry.urlFilter);
    const redirectUrl = safeLocalRedirect(entry.redirectUrl);
    if (!urlFilter || !redirectUrl || seen.has(urlFilter)) continue;
    seen.add(urlFilter);
    output.push({ urlFilter, redirectUrl });
  }
  return output.sort((a, b) => a.urlFilter.localeCompare(b.urlFilter));
}

function normalizeAllowlistRuleEntries(entries: ServerRuleEntry[]): AllowlistRuleEntry[] {
  const output: AllowlistRuleEntry[] = [];
  for (const entry of entries || []) {
    const redirectUrl = safeLocalRedirect(entry.redirectUrl);
    const rawExcludedDomains = Array.isArray(entry.excludedDomains) ? entry.excludedDomains : [];
    const excludedDomains = [...new Set(rawExcludedDomains
      .map(normalizeDomain)
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (!redirectUrl || !excludedDomains.length) continue;
    output.push({ excludedDomains, redirectUrl });
  }
  return output;
}

function normalizeDomain(value: unknown): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/[^a-z0-9.-]/g, "");
}

function safeLocalRedirect(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    const localServer = new URL(sentinelConnection.localServer);
    if (!sameHost(url, localServer) || normalizedPort(url) !== normalizedPort(localServer) || url.pathname !== "/blocked") return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function fetchSentinel(path: string, options: RequestInit = {}): Promise<Response> {
  const connection = await loadSentinelConnection();
  const headers: Record<string, string> = Object.fromEntries(new Headers(options.headers || {}).entries());
  if (connection.extensionToken) headers[EXTENSION_TOKEN_HEADER] = connection.extensionToken;
  return fetch(sentinelUrl(path, connection.localServer), {
    ...options,
    headers
  });
}

async function loadSentinelConnection(): Promise<typeof sentinelConnection> {
  const values = await storageGet(CONNECTION_DEFAULTS);
  const localServer = normalizeLocalServer(values.sentinelLocalServer);
  const extensionToken = String(values.sentinelExtensionToken || "").trim();
  sentinelConnection = { localServer, extensionToken };
  if (values.sentinelLocalServer !== localServer) {
    await storageSet({ sentinelLocalServer: localServer });
  }
  return sentinelConnection;
}

function sentinelUrl(path: string, localServer: string): string {
  return new URL(path, `${localServer}/`).toString();
}

function normalizeLocalServer(value: unknown): string {
  try {
    const raw = String(value || DEFAULT_LOCAL_SERVER).trim();
    const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
    const url = new URL(withScheme);
    if (!["http:", "https:"].includes(url.protocol)) return DEFAULT_LOCAL_SERVER;
    if (!isLocalHost(url.hostname)) return DEFAULT_LOCAL_SERVER;
    return url.origin;
  } catch {
    return DEFAULT_LOCAL_SERVER;
  }
}

function sameHost(left: URL, right: URL): boolean {
  return isLocalHost(left.hostname) && isLocalHost(right.hostname);
}

function isLocalHost(hostname: unknown): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase());
}

function normalizedPort(url: URL): string {
  return String(url.port || (url.protocol === "https:" ? "443" : "80"));
}

function safeUrlFilter(value: unknown): string {
  const filter = String(value || "").trim().toLowerCase();
  if (!filter.startsWith("||")) return "";
  if (!/^\|\|[a-z0-9.-]+(?:\/[a-z0-9._~!$&'()*+,;=:@%-]*)*$/.test(filter)) return "";
  return filter;
}

function updateDynamicRules(options: chrome.declarativeNetRequest.UpdateRuleOptions): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.declarativeNetRequest.updateDynamicRules(options, () => resolve(!chrome.runtime.lastError));
  });
}

function storageGet<T extends StorageDefaults>(defaults: T): Promise<StorageResult<T>> {
  return new Promise((resolve) => {
    chrome.storage.local.get(defaults, (value) => resolve((value || defaults) as StorageResult<T>));
  });
}

function storageSet(value: StorageDefaults): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.storage.local.set(value, () => resolve(!chrome.runtime.lastError));
  });
}
