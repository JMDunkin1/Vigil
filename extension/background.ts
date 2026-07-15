const DEFAULT_LOCAL_SERVER = "http://127.0.0.1:8787";
const EXTENSION_ID_HEADER = "x-vigil-extension-id";
const EXTENSION_TOKEN_HEADER = "x-vigil-extension-token";
const CONNECTION_DEFAULTS = {
  vigilLocalServer: DEFAULT_LOCAL_SERVER,
  vigilExtensionToken: ""
};
const manifest = chrome.runtime.getManifest();
const tabMemory = new Map<number, string>();
const tabRequestGenerations = new Map<number, number>();
const inFlightChecks = new Map<string, Promise<ExtensionCheckResult>>();
const recentCheckResults = new Map<string, { expiresAt: number; result: ExtensionCheckResult }>();
const NOISE_RULE_START = 9100;
const SITE_BLOCK_RULE_START = 10000;
const CONTENT_BLOCK_RULE_START = 11000;
const ALLOWLIST_RULE_START = 12000;
const LOCAL_SERVER_ALLOW_RULE_ID = ALLOWLIST_RULE_START - 1;
const SITE_EMBEDDED_BLOCK_RULE_START = 13000;
const CONTENT_EMBEDDED_BLOCK_RULE_START = 14000;
const ALLOWLIST_EMBEDDED_BLOCK_RULE_START = 15000;
const SITE_BLOCK_RULE_LIMIT = 300;
const CONTENT_BLOCK_RULE_LIMIT = 200;
const ALLOWLIST_RULE_LIMIT = 20;
const VIGIL_REQUEST_TIMEOUT_MS = 2500;
const PERSISTENT_RULE_UNTIL = "until the tamper alarm is cleared";
const NOISE_RESOURCE_TYPES = ["script", "image", "xmlhttprequest", "sub_frame", "stylesheet", "media", "font", "ping", "other"];
const TOP_LEVEL_RESOURCE_TYPES = ["main_frame"];
const EMBEDDED_SITE_RESOURCE_TYPES = [
  "sub_frame",
  "script",
  "image",
  "stylesheet",
  "object",
  "xmlhttprequest",
  "ping",
  "csp_report",
  "media",
  "font",
  "websocket",
  "webtransport",
  "webbundle",
  "other"
];
const EMBEDDED_FRAME_RESOURCE_TYPES = ["sub_frame"];
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
const YOUTUBE_AUTOFILL_REQUEST_DOMAINS = [
  "suggestqueries.google.com",
  "suggestqueries-clients6.youtube.com",
  "clients1.google.com"
];
const YOUTUBE_AUTOFILL_RULE_ID = NOISE_RULE_START + NOISE_BLOCK_DOMAINS.length;
const NOISE_RULE_IDS = [
  ...NOISE_BLOCK_DOMAINS.map((_, index) => NOISE_RULE_START + index),
  YOUTUBE_AUTOFILL_RULE_ID
];
const SITE_BLOCK_RULE_IDS = Array.from({ length: SITE_BLOCK_RULE_LIMIT }, (_, index) => SITE_BLOCK_RULE_START + index);
const CONTENT_BLOCK_RULE_IDS = Array.from({ length: CONTENT_BLOCK_RULE_LIMIT }, (_, index) => CONTENT_BLOCK_RULE_START + index);
const ALLOWLIST_RULE_IDS = Array.from({ length: ALLOWLIST_RULE_LIMIT }, (_, index) => ALLOWLIST_RULE_START + index);
const SITE_EMBEDDED_BLOCK_RULE_IDS = Array.from({ length: SITE_BLOCK_RULE_LIMIT }, (_, index) => SITE_EMBEDDED_BLOCK_RULE_START + index);
const CONTENT_EMBEDDED_BLOCK_RULE_IDS = Array.from({ length: CONTENT_BLOCK_RULE_LIMIT }, (_, index) => CONTENT_EMBEDDED_BLOCK_RULE_START + index);
const ALLOWLIST_EMBEDDED_BLOCK_RULE_IDS = Array.from({ length: ALLOWLIST_RULE_LIMIT }, (_, index) => ALLOWLIST_EMBEDDED_BLOCK_RULE_START + index);
let noiseRulesEnabled: boolean | null = null;
let siteRulesSignature = "";
let siteRuleCount = 0;
let lastRuleSyncAt = 0;
let cachedPulseFlags: PulseFlagSnapshot = {};
const pulseFlagsReady = loadPulseFlags();
const RULE_SYNC_ALARM = "vigil-rule-sync";
const RULE_EXPIRY_ALARM = "vigil-rule-expiry";
let vigilConnection = {
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

interface ExtensionPauseActionMessage {
  type?: string;
  action?: unknown;
  requestId?: unknown;
  intention?: unknown;
  mood?: unknown;
  replacement?: unknown;
}

interface ExtensionMessage extends ExtensionPulseMessage, ExtensionPauseActionMessage {}

interface ExtensionCheckResult {
  ok?: boolean;
  skipped?: boolean;
  blocked?: boolean;
  paused?: boolean;
  redirectUrl?: string;
  browserNoiseBlockingEnabled?: boolean;
  focusedSocialCleanupEnabled?: boolean;
  focusedSocialCleanupSettings?: unknown;
  offline?: boolean;
  [key: string]: unknown;
}

interface CheckUrlOptions {
  deferTabAction?: boolean;
}

interface PulseFlagSnapshot {
  browserNoiseBlockingEnabled?: boolean;
  focusedSocialCleanupEnabled?: boolean;
  focusedSocialCleanupSettings?: unknown;
}

interface SiteRuleEntry {
  domain: string;
  redirectUrl: string;
  until: string;
}

interface ContentRuleEntry {
  urlFilter: string;
  redirectUrl: string;
  until: string;
}

interface AllowlistRuleEntry {
  excludedDomains: string[];
  redirectUrl: string;
  until: string;
}

interface ServerRuleEntry {
  domain?: unknown;
  redirectUrl?: unknown;
  urlFilter?: unknown;
  excludedDomains?: unknown;
  until?: unknown;
}

interface RuleSnapshot {
  browserNoiseBlockingEnabled?: boolean;
  focusedSocialCleanupEnabled?: boolean;
  focusedSocialCleanupSettings?: unknown;
  rules?: ServerRuleEntry[];
  contentRules?: ServerRuleEntry[];
  allowlistRules?: ServerRuleEntry[];
  dynamicRuleCount?: number;
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

void loadVigilConnection();
void loadNoisePreference();
void pulseFlagsReady;
void initializeSiteBlocking();
chrome.alarms.create(RULE_SYNC_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RULE_SYNC_ALARM || alarm.name === RULE_EXPIRY_ALARM) {
    void syncSiteBlockingFromServer();
  }
});

chrome.runtime.onInstalled.addListener(loadNoisePreference);
chrome.runtime.onInstalled.addListener(syncSiteBlockingFromServer);
chrome.runtime.onStartup.addListener(loadNoisePreference);
chrome.runtime.onStartup.addListener(syncSiteBlockingFromServer);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || (!changes.vigilLocalServer && !changes.vigilExtensionToken)) return;
  void loadVigilConnection().then(() => syncSiteBlockingFromServer());
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

chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse: (response?: unknown) => void) => {
  if (message?.type === "VIGIL_PULSE") {
    void checkUrl(sender.tab?.id, message.url || "", message.reason || "heartbeat", message.seconds, message.title, { deferTabAction: true })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "VIGIL_PAUSE_ACTION") {
    void handlePauseAction(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === "VIGIL_CLOSE_TAB") {
    void closeSenderTab(sender).then((result) => sendResponse(result));
    return true;
  }
  return false;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabMemory.delete(tabId);
  tabRequestGenerations.delete(tabId);
  for (const key of inFlightChecks.keys()) {
    if (key.startsWith(`${tabId}:`)) inFlightChecks.delete(key);
  }
  for (const key of recentCheckResults.keys()) {
    if (key.startsWith(`${tabId}:`)) recentCheckResults.delete(key);
  }
});

async function checkUrl(
  tabId: number | undefined,
  url: string,
  event: string,
  seconds = 0,
  title = "",
  options: CheckUrlOptions = {}
): Promise<ExtensionCheckResult> {
  if (!tabId || isSkippableUrl(url)) return skippedCheckResult();
  const key = duplicateCheckKey(tabId, url, event, seconds, options);
  if (key) {
    const running = inFlightChecks.get(key);
    if (running) return await running;
    const recent = recentCheckResults.get(key);
    if (recent && recent.expiresAt > Date.now()) {
      return { ...recent.result, skipped: true };
    }
  }

  const request = performCheckUrl(tabId, url, event, seconds, title, options);
  if (key) inFlightChecks.set(key, request);
  try {
    const result = await request;
    if (key) recentCheckResults.set(key, { expiresAt: Date.now() + 1_000, result });
    return result;
  } finally {
    if (key && inFlightChecks.get(key) === request) inFlightChecks.delete(key);
    const now = Date.now();
    for (const [item, value] of recentCheckResults) {
      if (value.expiresAt <= now) recentCheckResults.delete(item);
    }
  }
}

function duplicateCheckKey(
  tabId: number,
  url: string,
  event: string,
  seconds: number,
  options: CheckUrlOptions
): string | null {
  if (Number(seconds) > 0 || event === "heartbeat") return null;
  return `${tabId}:${event}:${options.deferTabAction ? "defer" : "direct"}:${url}`;
}

async function performCheckUrl(
  tabId: number,
  url: string,
  event: string,
  seconds: number,
  title: string,
  options: CheckUrlOptions
): Promise<ExtensionCheckResult> {
  const generation = (tabRequestGenerations.get(tabId) || 0) + 1;
  tabRequestGenerations.set(tabId, generation);

  const previousUrl = tabMemory.get(tabId) || "";
  tabMemory.set(tabId, url);

  let response: Response;
  try {
    response = await fetchVigil("/api/extension/check", {
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
  } catch {
    await pulseFlagsReady;
    if (await isCurrentTabRequest(tabId, generation, url)) await setBadge(tabId, "OFF", "#9b2f2f");
    return offlineCheckResult();
  }

  if (!await isCurrentTabRequest(tabId, generation, url)) {
    return skippedCheckResult();
  }
  if (!response.ok) {
    await pulseFlagsReady;
    await setBadge(tabId, "OFF", "#9b2f2f");
    return { ...offlineCheckResult(), status: response.status };
  }

  let result: ExtensionCheckResult;
  try {
    result = await response.json() as ExtensionCheckResult;
  } catch {
    await pulseFlagsReady;
    await setBadge(tabId, "OFF", "#9b2f2f");
    return offlineCheckResult();
  }
  await rememberPulseFlags(result);
  if (typeof result.browserNoiseBlockingEnabled === "boolean") {
    await syncNoiseBlocking(result.browserNoiseBlockingEnabled);
  }
  if (!await isCurrentTabRequest(tabId, generation, url)) return skippedCheckResult();
  if (result.blocked && result.redirectUrl && url !== result.redirectUrl) {
    await setBadge(tabId, "LOCK", "#9b2f2f");
    if (!options.deferTabAction) await updateTab(tabId, { url: result.redirectUrl });
  } else if (result.paused && result.redirectUrl && url !== result.redirectUrl) {
    await setBadge(tabId, "WAIT", "#b67618");
    if (!options.deferTabAction) {
      const overlayShown = await showPauseOverlay(tabId, result);
      if (!overlayShown) await updateTab(tabId, { url: result.redirectUrl });
    }
  } else {
    await setBadge(tabId, "", "#126a6f");
  }
  void maybeSyncSiteBlocking();
  return result;
}

async function isCurrentTabRequest(tabId: number, generation: number, url: string): Promise<boolean> {
  if (tabRequestGenerations.get(tabId) !== generation) return false;
  const currentTab = await getTab(tabId);
  return tabRequestGenerations.get(tabId) === generation && currentTab?.url === url;
}

function skippedCheckResult(): ExtensionCheckResult {
  return { ok: true, skipped: true, ...cachedPulseFlags };
}

function offlineCheckResult(): ExtensionCheckResult {
  return { ok: false, offline: true, ...cachedPulseFlags };
}

async function rememberPulseFlags(value: unknown): Promise<void> {
  if (!isRecord(value)) return;
  const next: PulseFlagSnapshot = {};
  if (typeof value.browserNoiseBlockingEnabled === "boolean") {
    next.browserNoiseBlockingEnabled = value.browserNoiseBlockingEnabled;
  }
  if (typeof value.focusedSocialCleanupEnabled === "boolean") {
    next.focusedSocialCleanupEnabled = value.focusedSocialCleanupEnabled;
  }
  if (Object.hasOwn(value, "focusedSocialCleanupSettings")) {
    next.focusedSocialCleanupSettings = value.focusedSocialCleanupSettings;
  }
  if (!Object.keys(next).length) return;
  const merged = { ...cachedPulseFlags, ...next };
  if (JSON.stringify(merged) === JSON.stringify(cachedPulseFlags)) return;
  cachedPulseFlags = merged;
  await storageSet({ vigilPulseFlags: cachedPulseFlags });
}

async function loadPulseFlags(): Promise<void> {
  const stored = await storageGet({ vigilPulseFlags: {} });
  if (!isRecord(stored.vigilPulseFlags)) return;
  const flags = stored.vigilPulseFlags;
  if (typeof flags.browserNoiseBlockingEnabled === "boolean") {
    cachedPulseFlags.browserNoiseBlockingEnabled = flags.browserNoiseBlockingEnabled;
  }
  if (typeof flags.focusedSocialCleanupEnabled === "boolean") {
    cachedPulseFlags.focusedSocialCleanupEnabled = flags.focusedSocialCleanupEnabled;
  }
  if (Object.hasOwn(flags, "focusedSocialCleanupSettings")) {
    cachedPulseFlags.focusedSocialCleanupSettings = flags.focusedSocialCleanupSettings;
  }
}

function isSkippableUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return true;
    const localServer = new URL(vigilConnection.localServer);
    return sameHost(url, localServer) && normalizedPort(url) === normalizedPort(localServer);
  } catch {
    return true;
  }
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

async function showPauseOverlay(tabId: number, result: ExtensionCheckResult): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ok = await sendTabMessage(tabId, {
      type: "VIGIL_SHOW_PAUSE",
      result
    });
    if (ok) return true;
    await delay(125);
  }
  return false;
}

function sendTabMessage(tabId: number, message: Record<string, unknown>): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: unknown) => {
      void chrome.runtime.lastError;
      resolve(isRecord(response) && response.ok === true);
    });
  });
}

async function handlePauseAction(message: ExtensionPauseActionMessage): Promise<Record<string, unknown>> {
  const action = String(message.action || "") === "skip" ? "skip" : "continue";
  const body: Record<string, unknown> = {
    requestId: String(message.requestId || "")
  };
  if (action === "skip") {
    body.replacement = String(message.replacement || "").slice(0, 120);
    body.mood = String(message.mood || "").slice(0, 80);
  } else {
    body.intention = String(message.intention || "").slice(0, 240);
    body.mood = String(message.mood || "").slice(0, 80);
  }

  const response = await fetchVigil(action === "skip" ? "/api/extension/pause/skip" : "/api/extension/pause/continue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const json = await response.json() as unknown;
  if (!response.ok) {
    return { ok: false, error: responseError(json, response.status) };
  }
  return isRecord(json) ? json : { ok: false, error: "Invalid Vigil response." };
}

function closeSenderTab(sender: chrome.runtime.MessageSender): Promise<Record<string, unknown>> {
  const tabId = sender.tab?.id;
  if (!tabId) return Promise.resolve({ ok: false, error: "No sender tab." });
  return new Promise((resolve) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError?.message;
      resolve(error ? { ok: false, error } : { ok: true });
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function initializeSiteBlocking(): Promise<void> {
  await Promise.all([loadVigilConnection(), pulseFlagsReady]);
  await pruneStoredSiteBlocking();
  await syncSiteBlockingFromServer();
}

async function syncSiteBlockingFromServer() {
  lastRuleSyncAt = Date.now();
  try {
    const response = await fetchVigil(`/api/extension/rules?version=${encodeURIComponent(manifest.version)}`);
    if (!response.ok) throw new Error(`rules ${response.status}`);
    const snapshot = await response.json() as RuleSnapshot;
    await rememberPulseFlags(snapshot);
    if (typeof snapshot.browserNoiseBlockingEnabled === "boolean") {
      await syncNoiseBlocking(snapshot.browserNoiseBlockingEnabled);
    }
    const result = await syncSiteBlocking(snapshot.rules || [], snapshot.contentRules || [], snapshot.allowlistRules || []);
    if (Number.isFinite(Number(snapshot.dynamicRuleCount)) && Number(snapshot.dynamicRuleCount) !== result.count) {
      result.ok = false;
      result.error = `Rule count mismatch: installed ${result.count}, expected ${Number(snapshot.dynamicRuleCount)}.`;
    }
    if (snapshot.dynamicRuleSignature && snapshot.dynamicRuleSignature !== result.signature) {
      result.ok = false;
      result.error = "Rule signature mismatch after client normalization.";
    }
    await reportRuleSync(result);
  } catch (error) {
    await pruneStoredSiteBlocking();
    await storageSet({
      siteBlockRules: {
        count: siteRuleCount,
        staleAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error)
      }
    });
  }
}

async function syncSiteBlocking(entries: ServerRuleEntry[], contentEntries: ServerRuleEntry[] = [], allowlistEntries: ServerRuleEntry[] = []): Promise<RuleSyncResult> {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) {
    return { ok: false, count: 0, signature: "", error: "Declarative Net Request is unavailable" };
  }
  const safeEntries = normalizeSiteRuleEntries(entries).slice(0, SITE_BLOCK_RULE_LIMIT);
  const safeContentEntries = normalizeContentRuleEntries(contentEntries).slice(0, CONTENT_BLOCK_RULE_LIMIT);
  const safeAllowlistEntries = normalizeAllowlistRuleEntries(allowlistEntries).slice(0, ALLOWLIST_RULE_LIMIT);
  const hasLocalServerAllowRule = safeAllowlistEntries.length > 0;
  const count = safeEntries.length + safeContentEntries.length + safeAllowlistEntries.length + (hasLocalServerAllowRule ? 1 : 0);
  const signature = JSON.stringify({
    site: safeEntries,
    content: safeContentEntries,
    allowlist: safeAllowlistEntries,
    localServerAllow: hasLocalServerAllowRule
  });
  await storageSet({
    siteBlockRuleSnapshot: {
      rules: safeEntries,
      contentRules: safeContentEntries,
      allowlistRules: safeAllowlistEntries
    }
  });
  scheduleRuleExpiry([...safeEntries, ...safeContentEntries, ...safeAllowlistEntries]);
  if (siteRulesSignature === signature) return { ok: true, count, signature };

  const ok = await updateDynamicRules({
    removeRuleIds: [
      ...SITE_BLOCK_RULE_IDS,
      ...CONTENT_BLOCK_RULE_IDS,
      LOCAL_SERVER_ALLOW_RULE_ID,
      ...ALLOWLIST_RULE_IDS,
      ...SITE_EMBEDDED_BLOCK_RULE_IDS,
      ...CONTENT_EMBEDDED_BLOCK_RULE_IDS,
      ...ALLOWLIST_EMBEDDED_BLOCK_RULE_IDS
    ],
    addRules: [
      ...siteBlockRules(safeEntries),
      ...siteEmbeddedBlockRules(safeEntries),
      ...contentBlockRules(safeContentEntries),
      ...contentEmbeddedBlockRules(safeContentEntries),
      ...allowlistBlockRules(safeAllowlistEntries),
      ...allowlistEmbeddedBlockRules(safeAllowlistEntries)
    ]
  });
  if (!ok) return { ok: false, count, signature, error: "Dynamic rule update failed" };

  siteRulesSignature = signature;
  siteRuleCount = count;
  await storageSet({ siteBlockRules: { count, syncedAt: new Date().toISOString() } });
  return { ok: true, count, signature };
}

async function pruneStoredSiteBlocking(): Promise<void> {
  const stored = await storageGet({ siteBlockRuleSnapshot: null });
  const snapshot: Record<string, unknown> = isRecord(stored.siteBlockRuleSnapshot) ? stored.siteBlockRuleSnapshot : {};
  const rules = Array.isArray(snapshot.rules) ? snapshot.rules as ServerRuleEntry[] : [];
  const contentRules = Array.isArray(snapshot.contentRules) ? snapshot.contentRules as ServerRuleEntry[] : [];
  const allowlistRules = Array.isArray(snapshot.allowlistRules) ? snapshot.allowlistRules as ServerRuleEntry[] : [];
  await syncSiteBlocking(rules, contentRules, allowlistRules);
}

function scheduleRuleExpiry(entries: Array<SiteRuleEntry | ContentRuleEntry | AllowlistRuleEntry>): void {
  const expirations = entries
    .map((entry) => Date.parse(entry.until))
    .filter((value) => Number.isFinite(value) && value > Date.now());
  chrome.alarms.clear(RULE_EXPIRY_ALARM, () => {
    if (!expirations.length) return;
    chrome.alarms.create(RULE_EXPIRY_ALARM, { when: Math.max(Date.now() + 1_000, Math.min(...expirations) + 250) });
  });
}

async function reportRuleSync(result: RuleSyncResult): Promise<void> {
  try {
    await fetchVigil("/api/extension/rules/sync", {
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
  const domainRules = NOISE_BLOCK_DOMAINS.map((domain, index) => ({
    id: NOISE_RULE_START + index,
    priority: 1,
    action: { type: "block" },
    condition: {
      urlFilter: `||${domain}^`,
      resourceTypes: NOISE_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
  return [...domainRules, youtubeAutofillRule()];
}

function youtubeAutofillRule(): chrome.declarativeNetRequest.Rule {
  return {
    id: YOUTUBE_AUTOFILL_RULE_ID,
    priority: 2,
    action: { type: "block" },
    condition: {
      urlFilter: "/complete/search",
      initiatorDomains: ["youtube.com"],
      requestDomains: YOUTUBE_AUTOFILL_REQUEST_DOMAINS,
      resourceTypes: ["script", "xmlhttprequest"]
    }
  } as chrome.declarativeNetRequest.Rule;
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
      resourceTypes: TOP_LEVEL_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function siteEmbeddedBlockRules(entries: SiteRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: SITE_EMBEDDED_BLOCK_RULE_START + index,
    priority: 100,
    action: { type: "block" },
    condition: {
      urlFilter: `||${entry.domain}^`,
      resourceTypes: EMBEDDED_SITE_RESOURCE_TYPES
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
      resourceTypes: TOP_LEVEL_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function contentEmbeddedBlockRules(entries: ContentRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: CONTENT_EMBEDDED_BLOCK_RULE_START + index,
    priority: 90,
    action: { type: "block" },
    condition: {
      urlFilter: entry.urlFilter,
      resourceTypes: EMBEDDED_FRAME_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function allowlistBlockRules(entries: AllowlistRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  if (!entries.length) return [];
  return [localServerAllowRule(), ...entries.map((entry, index) => ({
    id: ALLOWLIST_RULE_START + index,
    priority: 80,
    action: {
      type: "redirect",
      redirect: { url: entry.redirectUrl }
    },
    condition: {
      regexFilter: "^https?://",
      excludedRequestDomains: entry.excludedDomains,
      resourceTypes: TOP_LEVEL_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule))];
}

function allowlistEmbeddedBlockRules(entries: AllowlistRuleEntry[]): chrome.declarativeNetRequest.Rule[] {
  return entries.map((entry, index) => ({
    id: ALLOWLIST_EMBEDDED_BLOCK_RULE_START + index,
    priority: 80,
    action: { type: "block" },
    condition: {
      regexFilter: "^https?://",
      excludedRequestDomains: entry.excludedDomains,
      resourceTypes: EMBEDDED_FRAME_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule));
}

function localServerAllowRule(): chrome.declarativeNetRequest.Rule {
  const origin = new URL(vigilConnection.localServer).origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    id: LOCAL_SERVER_ALLOW_RULE_ID,
    priority: 1_000,
    action: { type: "allow" },
    condition: {
      regexFilter: `^${origin}(?:/|$)`,
      resourceTypes: TOP_LEVEL_RESOURCE_TYPES
    }
  } as chrome.declarativeNetRequest.Rule;
}

function normalizeSiteRuleEntries(entries: ServerRuleEntry[]): SiteRuleEntry[] {
  const seen = new Set<string>();
  const output: SiteRuleEntry[] = [];
  for (const entry of entries || []) {
    const domain = normalizeDomain(entry.domain);
    const redirectUrl = safeLocalRedirect(entry.redirectUrl);
    const until = normalizedRuleUntil(entry.until);
    if (!domain || !redirectUrl || until === null || seen.has(domain)) continue;
    seen.add(domain);
    output.push({ domain, redirectUrl, until });
  }
  return output.sort((a, b) => a.domain.localeCompare(b.domain));
}

function normalizeContentRuleEntries(entries: ServerRuleEntry[]): ContentRuleEntry[] {
  const seen = new Set<string>();
  const output: ContentRuleEntry[] = [];
  for (const entry of entries || []) {
    const urlFilter = safeUrlFilter(entry.urlFilter);
    const redirectUrl = safeContentRedirect(entry.redirectUrl);
    const until = normalizedRuleUntil(entry.until);
    if (!urlFilter || !redirectUrl || until === null || seen.has(urlFilter)) continue;
    seen.add(urlFilter);
    output.push({ urlFilter, redirectUrl, until });
  }
  return output.sort((a, b) => a.urlFilter.localeCompare(b.urlFilter));
}

function normalizeAllowlistRuleEntries(entries: ServerRuleEntry[]): AllowlistRuleEntry[] {
  const output: AllowlistRuleEntry[] = [];
  for (const entry of entries || []) {
    const redirectUrl = safeLocalRedirect(entry.redirectUrl);
    const until = normalizedRuleUntil(entry.until);
    const rawExcludedDomains = Array.isArray(entry.excludedDomains) ? entry.excludedDomains : [];
    const excludedDomains = [...new Set(rawExcludedDomains
      .map(normalizeDomain)
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    if (!redirectUrl || until === null || !excludedDomains.length) continue;
    output.push({ excludedDomains, redirectUrl, until });
  }
  return output;
}

function normalizedRuleUntil(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw === PERSISTENT_RULE_UNTIL) return raw;
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || time <= Date.now()) return null;
  return new Date(time).toISOString();
}

function normalizeDomain(value: unknown): string {
  const raw = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "");
  if (["::1", "[::1]"].includes(raw)) return "::1";
  return raw
    .split("/")[0]
    .split(":")[0]
    .replace(/[^a-z0-9.-]/g, "");
}

function safeLocalRedirect(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    const localServer = new URL(vigilConnection.localServer);
    if (!sameHost(url, localServer) || normalizedPort(url) !== normalizedPort(localServer) || url.pathname !== "/blocked") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function safeContentRedirect(value: unknown): string {
  const local = safeLocalRedirect(value);
  if (local) return local;
  try {
    const url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol) || isLocalHost(url.hostname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

async function fetchVigil(path: string, options: RequestInit = {}): Promise<Response> {
  const connection = await loadVigilConnection();
  const headers: Record<string, string> = Object.fromEntries(new Headers(options.headers || {}).entries());
  headers[EXTENSION_ID_HEADER] = chrome.runtime.id;
  if (connection.extensionToken) headers[EXTENSION_TOKEN_HEADER] = connection.extensionToken;
  const controller = new AbortController();
  const sourceSignal = options.signal;
  const abortFromSource = () => controller.abort(sourceSignal?.reason);
  if (sourceSignal?.aborted) abortFromSource();
  else sourceSignal?.addEventListener("abort", abortFromSource, { once: true });
  const timeout = setTimeout(() => controller.abort(), VIGIL_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(vigilUrl(path, connection.localServer), {
      ...options,
      headers,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
    sourceSignal?.removeEventListener("abort", abortFromSource);
  }
}

async function loadVigilConnection(): Promise<typeof vigilConnection> {
  const values = await storageGet(CONNECTION_DEFAULTS);
  const localServer = normalizeLocalServer(values.vigilLocalServer);
  const extensionToken = String(values.vigilExtensionToken || "").trim();
  vigilConnection = { localServer, extensionToken };
  if (values.vigilLocalServer !== localServer) {
    await storageSet({ vigilLocalServer: localServer });
  }
  return vigilConnection;
}

function vigilUrl(path: string, localServer: string): string {
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
  if (!/^\|\|[a-z0-9.-]+(?:\/[a-z0-9._~!$&'()*+,;=:@?%-]*)*$/.test(filter)) return "";
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

function responseError(value: unknown, status: number): string {
  if (isRecord(value) && typeof value.error === "string") return value.error;
  return `Vigil request failed (${status}).`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
