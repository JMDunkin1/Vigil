import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFileSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildPhoneBlocklistArtifact,
  writePhoneBlocklistArtifactAtomically,
  type PhoneBlocklistMetadata
} from "./adultBlocklistPhoneArtifact.js";
import {
  DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT,
  DEFAULT_ADULT_BLOCKLIST_SOURCE_ID,
  DEFAULT_EXPLICIT_BLOCKED_SITES,
  MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS
} from "./defaults.js";
import { DATA_DIR } from "./store.js";
import { writeFileAtomically } from "./snapshotFiles.js";
import type { AdultBlocklistSourceSnapshot, VigilState, UnknownRecord } from "./types.js";

export const ADULT_BLOCKLIST_SNAPSHOT_PATH = join(DATA_DIR, "adult-blocklist.json");
export const ADULT_BLOCKLIST_PREVIOUS_SNAPSHOT_PATH = join(DATA_DIR, "adult-blocklist.previous.json");
export const ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH = join(DATA_DIR, "adult-blocklist.sdi");
const VERSIONED_SNAPSHOT_PATTERN = /^adult-blocklist\.([a-f0-9]{64})\.json$/;
export const ADULT_BLOCKLIST_CUSTOM_SOURCE_ID = "custom";
export const ADULT_BLOCKLIST_BROWSER_SITE_RULE_LIMIT = 300;
const SNAPSHOT_VERSION = 1;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_FETCH_BYTES = 32 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MIN_REFRESH_DOMAINS = 1000;
const BUILT_IN_EXPLICIT_SOURCE_ID = "vigil-explicit";
const BUILT_IN_EXPLICIT_SOURCE_LABEL = "Vigil built-in explicit sites";
const BUILT_IN_EXPLICIT_DOMAIN_SET = new Set(
  DEFAULT_EXPLICIT_BLOCKED_SITES.map(normalizeAdultDomain).filter(Boolean)
);

export interface AdultBlocklistSource extends AdultBlocklistSourceSnapshot {
  format: "domains" | "hosts";
}

interface AdultBlocklistSnapshot {
  version: number;
  generatedAt: string;
  domainCount: number;
  hash: string;
  source: AdultBlocklistSourceSnapshot;
  domains: string[];
}

export interface AdultBlocklistResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface AdultBlocklistPinnedResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: AsyncIterable<unknown>;
  destroy: () => void;
}

export interface AdultBlocklistFetchTestHooks {
  resolve?: (hostname: string) => Promise<AdultBlocklistResolvedAddress[]>;
  request?: (
    url: URL,
    address: AdultBlocklistResolvedAddress,
    signal: AbortSignal
  ) => Promise<AdultBlocklistPinnedResponse>;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  buildPhoneArtifact?: typeof buildPhoneBlocklistArtifact;
}

export interface AdultBlocklistMatch extends UnknownRecord {
  id: "adult-blocklist";
  label: string;
  hostname: string;
  domain: string;
  sourceId: string;
  sourceLabel: string;
}

export const ADULT_BLOCKLIST_SOURCES: AdultBlocklistSource[] = [
  {
    id: "blocklistproject-porn",
    label: "Vigil 600K+ adult sites",
    url: "https://blocklistproject.github.io/Lists/porn.txt",
    homepage: "https://github.com/blocklistproject/Lists",
    license: "Unlicense",
    format: "hosts"
  },
  {
    id: "hagezi-nsfw",
    label: "HaGeZi NSFW",
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/wildcard/nsfw-onlydomains.txt",
    homepage: "https://github.com/hagezi/dns-blocklists",
    license: "GPL-3.0",
    format: "domains"
  },
  {
    id: "stevenblack-porn",
    label: "StevenBlack porn hosts",
    url: "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts",
    homepage: "https://github.com/StevenBlack/hosts",
    license: "MIT",
    format: "hosts"
  },
  {
    id: "shadowwhisperer-adult",
    label: "ShadowWhisperer Adult",
    url: "https://raw.githubusercontent.com/ShadowWhisperer/BlockLists/master/Lists/Adult",
    homepage: "https://github.com/ShadowWhisperer/BlockLists",
    license: "Unlicense",
    format: "domains"
  }
];

let runtimeSnapshot: AdultBlocklistSnapshot | null = null;
let runtimeSnapshotPath: string | null = null;
let runtimeDomainSet: Set<string> | null = null;
const diskSnapshotCache = new Map<string, AdultBlocklistSnapshot | null>();

export function adultBlocklistEnabled(state: VigilState): boolean {
  return state.settings?.adultBlocklistEnabled !== false;
}

export function adultBlocklistSource(state: VigilState): AdultBlocklistSource {
  const requested = String(state.settings?.adultBlocklistSourceId || DEFAULT_ADULT_BLOCKLIST_SOURCE_ID).trim();
  if (requested === ADULT_BLOCKLIST_CUSTOM_SOURCE_ID) {
    return {
      id: ADULT_BLOCKLIST_CUSTOM_SOURCE_ID,
      label: "Custom adult blocklist",
      url: String(state.settings.adultBlocklistCustomUrl || "").trim(),
      homepage: "",
      license: "Custom",
      format: "domains"
    };
  }
  return ADULT_BLOCKLIST_SOURCES.find((source) => source.id === requested)
    || ADULT_BLOCKLIST_SOURCES.find((source) => source.id === DEFAULT_ADULT_BLOCKLIST_SOURCE_ID)
    || ADULT_BLOCKLIST_SOURCES[0];
}

export function invalidateAdultBlocklistIfSourceChanged(state: VigilState, previousSource: AdultBlocklistSourceSnapshot | null): boolean {
  if (adultBlocklistSourceMatches(previousSource, adultBlocklistSource(state))) return false;
  clearAdultBlocklistSnapshotState(state);
  return true;
}

export function clearAdultBlocklistSnapshotState(state: VigilState): void {
  clearAdultBlocklistCache();
  state.adultBlocklist.domainCount = 0;
  state.adultBlocklist.activeDomainCount = 0;
  state.adultBlocklist.hash = "";
  state.adultBlocklist.snapshotPath = "";
  state.adultBlocklist.lastAttemptAt = null;
  state.adultBlocklist.lastRefreshAt = null;
  state.adultBlocklist.lastError = "";
  state.adultBlocklist.source = null;
}

export async function refreshAdultBlocklist(
  state: VigilState,
  now = new Date(),
  hooks: AdultBlocklistFetchTestHooks = {}
) {
  const source = adultBlocklistSource(state);
  const attemptedAt = now.toISOString();
  state.adultBlocklist.lastAttemptAt = attemptedAt;
  state.adultBlocklist.lastError = "";
  try {
    const text = await fetchSourceText(source.url, hooks);
    const domains = parseAdultBlocklistDomains(text);
    const minimumDomains = source.id === DEFAULT_ADULT_BLOCKLIST_SOURCE_ID
      ? MINIMUM_DEFAULT_ADULT_BLOCKLIST_DOMAINS
      : MIN_REFRESH_DOMAINS;
    if (domains.length < minimumDomains) {
      throw new Error(`Adult blocklist refresh returned only ${domains.length} usable domains; ${minimumDomains} are required for ${source.label}.`);
    }
    const hash = domainHash(domains);
    const snapshot = {
      version: SNAPSHOT_VERSION,
      generatedAt: attemptedAt,
      domainCount: domains.length,
      hash,
      source: sourceSnapshot(source),
      domains
    };
    const snapshotPath = adultBlocklistSnapshotPath(snapshot);
    (hooks.buildPhoneArtifact || buildPhoneBlocklistArtifact)({
      domains: activeAdultBlocklistDomains(state, snapshot.domains),
      snapshotHash: snapshot.hash,
      generatedAt: snapshot.generatedAt,
      source: snapshot.source
    });
    await writeAdultBlocklistSnapshot(snapshot, snapshotPath);
    setRuntimeSnapshot(snapshot, snapshotPath);
    state.adultBlocklist.domainCount = domains.length;
    state.adultBlocklist.activeDomainCount = activeDomainCount(state, domains);
    state.adultBlocklist.hash = hash;
    state.adultBlocklist.snapshotPath = snapshotPath;
    state.adultBlocklist.lastRefreshAt = attemptedAt;
    state.adultBlocklist.source = sourceSnapshot(source);
    return adultBlocklistSummary(state);
  } catch (error) {
    state.adultBlocklist.lastError = simplifyError(error);
    throw error;
  }
}

export function parseAdultBlocklistDomains(text: unknown): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const domain = normalizeAdultDomain(rawLine);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    output.push(domain);
  }
  return output.sort((a, b) => a.localeCompare(b));
}

export function normalizeAdultDomain(value: unknown): string {
  let text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\r/g, "");
  if (!text || text.startsWith("#") || text.startsWith("!") || text.startsWith("[")) return "";
  text = text.replace(/\s+#.*$/, "").replace(/\s+!.*$/, "");
  const first = text.split(/\s+/).find((part) => part && !isHostsSink(part)) || "";
  text = first
    .replace(/^address=\//, "")
    .replace(/^server=\//, "")
    .replace(/^local=\//, "")
    .replace(/^domain:/, "")
    .replace(/^full:/, "")
    .replace(/^regexp:/, "")
    .replace(/^include:/, "")
    .replace(/^\|\|/, "")
    .replace(/^\*\./, "")
    .replace(/^@@\|\|/, "")
    .replace(/\^$/, "")
    .replace(/\/$/, "");
  if (!text || text.includes("*") || text.includes("$") || text.includes("[") || text.includes("]")) return "";
  try {
    const parsed = text.includes("://") ? new URL(text) : null;
    if (parsed) text = parsed.hostname;
  } catch {
    // Fall through to host/path stripping.
  }
  text = text
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/\.$/, "");
  if (!isPublicDomain(text)) return "";
  return text;
}

export function normalizeAdultDomainList(values: unknown): string[] {
  const source = Array.isArray(values) ? values : String(values || "").split(/\r?\n|,/);
  return [...new Set(source.map(normalizeAdultDomain).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

export function matchAdultBlocklistHost(state: VigilState, value: unknown): AdultBlocklistMatch | null {
  if (!adultBlocklistEnabled(state)) return null;
  const hostname = normalizeAdultDomain(value);
  if (!hostname || adultBlocklistAllowsHost(state, hostname)) return null;
  const builtInDomain = matchingDomain(hostname, BUILT_IN_EXPLICIT_DOMAIN_SET);
  if (builtInDomain) {
    return {
      id: "adult-blocklist",
      label: "Adult blocklist",
      hostname,
      domain: builtInDomain,
      sourceId: BUILT_IN_EXPLICIT_SOURCE_ID,
      sourceLabel: BUILT_IN_EXPLICIT_SOURCE_LABEL
    };
  }
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  if (!snapshot || !runtimeDomainSet?.size) return null;
  const domain = matchingDomain(hostname, runtimeDomainSet);
  if (!domain) return null;
  return {
    id: "adult-blocklist",
    label: "Adult blocklist",
    hostname,
    domain,
    sourceId: snapshot.source.id,
    sourceLabel: snapshot.source.label
  };
}

export function adultBlocklistPreloadDomains(state: VigilState, options: { limit?: number } = {}): string[] {
  if (!adultBlocklistEnabled(state)) return [];
  const limit = adultBlocklistPreloadLimit(state, options.limit);
  if (limit <= 0) return [];
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  const representative = [...new Set(DEFAULT_EXPLICIT_BLOCKED_SITES.map(normalizeAdultDomain).filter(Boolean))];
  const representativeSet = new Set(representative);
  const candidates = [
    ...representative,
    ...(snapshot?.domains || []).filter((domain) => !representativeSet.has(domain))
  ];
  return candidates
    .filter((domain) => !adultBlocklistAllowsHost(state, domain))
    .slice(0, limit);
}

export function adultBlocklistSummary(state: VigilState) {
  const selected = adultBlocklistSource(state);
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  const availableSnapshots = availableAdultBlocklistSnapshotsSync(state);
  const storedSourceMatches = adultBlocklistSourceMatches(state.adultBlocklist?.source, selected);
  const stored = storedSourceMatches ? state.adultBlocklist : null;
  const domains = snapshot?.domains || [];
  const domainCount = snapshot?.domainCount || stored?.domainCount || 0;
  const activeCount = snapshot ? activeDomainCount(state, domains) : stored?.activeDomainCount || 0;
  const hash = snapshot?.hash || stored?.hash || "";
  const current = Boolean(snapshot && stored?.hash && snapshot.hash === stored.hash);
  const selectedSourceSnapshots = availableSnapshots.filter((item) => adultBlocklistSourceMatches(item.source, selected));
  const sourceMismatch = Boolean(
    (state.adultBlocklist?.source && !storedSourceMatches)
    || (!snapshot && selectedSourceSnapshots.length && state.adultBlocklist?.hash)
    || (!selectedSourceSnapshots.length && availableSnapshots.length)
  );
  return {
    enabled: adultBlocklistEnabled(state),
    ready: adultBlocklistEnabled(state) && Boolean(snapshot) && activeCount > 0,
    current,
    stale: adultBlocklistEnabled(state) && sourceMismatch,
    selectedSourceId: selected.id,
    selectedSourceLabel: selected.label,
    selectedSourceUrl: selected.url,
    selectedSourceLicense: selected.license,
    sources: [
      ...ADULT_BLOCKLIST_SOURCES,
      {
        id: ADULT_BLOCKLIST_CUSTOM_SOURCE_ID,
        label: "Custom URL",
        url: state.settings?.adultBlocklistCustomUrl || "",
        homepage: "",
        license: "Custom",
        format: "domains"
      }
    ],
    allowlist: normalizeAdultDomainList(state.adultBlocklist?.allowlist || []),
    allowlistCount: normalizeAdultDomainList(state.adultBlocklist?.allowlist || []).length,
    domainCount,
    activeDomainCount: activeCount,
    preloadLimit: adultBlocklistPreloadLimit(state),
    preloadedDomainCount: adultBlocklistPreloadDomains(state).length,
    hash,
    shortHash: hash ? hash.slice(0, 16) : "",
    snapshotPath: snapshot ? (runtimeSnapshotPath || stored?.snapshotPath || ADULT_BLOCKLIST_SNAPSHOT_PATH) : stored?.snapshotPath || "",
    lastAttemptAt: stored?.lastAttemptAt || null,
    lastRefreshAt: snapshot?.generatedAt || stored?.lastRefreshAt || null,
    lastError: state.adultBlocklist?.lastError || "",
    source: snapshot?.source || stored?.source || null,
    detail: adultBlocklistDetail({
      hasSnapshot: Boolean(snapshot),
      enabled: adultBlocklistEnabled(state),
      activeCount,
      error: state.adultBlocklist?.lastError || "",
      current,
      sourceMismatch
    })
  };
}

export function setAdultBlocklistDomainsForTest(domains: string[], source: Partial<AdultBlocklistSourceSnapshot> = {}): void {
  clearAdultBlocklistCache();
  setRuntimeSnapshot(testSnapshot(domains, source, "2026-01-01T00:00:00.000Z"));
}

export function setAdultBlocklistSnapshotCandidatesForTest(
  currentDomains: string[],
  previousDomains: string[],
  source: Partial<AdultBlocklistSourceSnapshot> = {}
): { currentHash: string; currentPath: string; previousHash: string; previousPath: string } {
  clearAdultBlocklistCache();
  const current = testSnapshot(currentDomains, source, "2026-01-02T00:00:00.000Z");
  const previous = testSnapshot(previousDomains, source, "2026-01-01T00:00:00.000Z");
  const currentPath = adultBlocklistSnapshotPath(current);
  const previousPath = adultBlocklistSnapshotPath(previous);
  diskSnapshotCache.set(currentPath, current);
  diskSnapshotCache.set(previousPath, previous);
  return { currentHash: current.hash, currentPath, previousHash: previous.hash, previousPath };
}

export function clearAdultBlocklistCacheForTest(): void {
  clearAdultBlocklistCache();
}

export async function finalizeAdultBlocklistSnapshot(state: VigilState): Promise<void> {
  const selectedPath = trustedAdultBlocklistSnapshotPath(state.adultBlocklist?.snapshotPath || "");
  if (!selectedPath || !VERSIONED_SNAPSHOT_PATTERN.test(basename(selectedPath))) return;
  let names: string[];
  try {
    names = await readdir(DATA_DIR);
  } catch {
    return;
  }

  const stale = await Promise.all(names
    .filter((name) => VERSIONED_SNAPSHOT_PATTERN.test(name))
    .map(async (name) => {
      const path = join(DATA_DIR, name);
      if (resolve(path) === resolve(selectedPath)) return null;
      try {
        return { path, modifiedAt: (await stat(path)).mtimeMs };
      } catch {
        return null;
      }
    }));
  const removable = stale
    .filter((item): item is { path: string; modifiedAt: number } => Boolean(item))
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(1);
  await Promise.all(removable.map(async (item) => {
    await rm(item.path, { force: true }).catch(() => {});
    diskSnapshotCache.delete(item.path);
  }));
}

export async function writeAdultBlocklistPhoneArtifact(
  state: VigilState,
  path = ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH
): Promise<PhoneBlocklistMetadata> {
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  if (!snapshot) throw new Error("A current adult blocklist snapshot is required before generating the phone artifact.");
  const artifact = buildPhoneBlocklistArtifact({
    domains: activeAdultBlocklistDomains(state, snapshot.domains),
    snapshotHash: snapshot.hash,
    generatedAt: snapshot.generatedAt,
    source: snapshot.source
  });
  await writePhoneBlocklistArtifactAtomically(path, artifact);
  return artifact.metadata;
}

export async function syncAdultBlocklistPhoneArtifact(
  state: VigilState,
  path = ADULT_BLOCKLIST_PHONE_ARTIFACT_PATH
): Promise<PhoneBlocklistMetadata | null> {
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  if (!snapshot || !activeAdultBlocklistDomains(state, snapshot.domains).length) {
    await rm(path, { force: true });
    return null;
  }
  return await writeAdultBlocklistPhoneArtifact(state, path);
}

function clearAdultBlocklistCache(): void {
  runtimeSnapshot = null;
  runtimeSnapshotPath = null;
  runtimeDomainSet = null;
  diskSnapshotCache.clear();
}

function loadSelectedAdultBlocklistSnapshotSync(state: VigilState): AdultBlocklistSnapshot | null {
  const selectedSource = adultBlocklistSource(state);
  const expectedHash = state.adultBlocklist?.hash || "";
  if (adultBlocklistSnapshotMatches(runtimeSnapshot, selectedSource, expectedHash)) return runtimeSnapshot;

  for (const path of adultBlocklistSnapshotCandidatePaths(state)) {
    const snapshot = loadAdultBlocklistSnapshotSync(path);
    if (!adultBlocklistSnapshotMatches(snapshot, selectedSource, expectedHash)) continue;
    setRuntimeSnapshot(snapshot, path);
    return snapshot;
  }
  return null;
}

function adultBlocklistPreloadLimit(state: VigilState, override?: number): number {
  const value = override ?? state.settings?.adultBlocklistPreloadLimit ?? DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT;
  if (!Number.isFinite(Number(value))) return DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT;
  return Math.max(0, Math.min(250, Math.trunc(Number(value))));
}

function activeDomainCount(state: VigilState, domains: string[]): number {
  return activeAdultBlocklistDomains(state, domains).length;
}

function activeAdultBlocklistDomains(state: VigilState, domains: string[]): string[] {
  return domains.filter((domain) => !adultBlocklistAllowsHost(state, domain));
}

function adultBlocklistAllowsHost(state: VigilState, hostname: string): boolean {
  return normalizeAdultDomainList(state.adultBlocklist?.allowlist || []).some((domain) => hostMatchesDomain(hostname, domain));
}

function matchingDomain(hostname: string, domains: Set<string>): string {
  const labels = hostname.split(".");
  for (let index = 0; index < labels.length - 1; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (domains.has(candidate)) return candidate;
  }
  return "";
}

function hostMatchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

async function fetchSourceText(url: string, hooks: AdultBlocklistFetchTestHooks = {}): Promise<string> {
  if (!String(url || "").trim()) throw new Error("Adult blocklist source URL is empty.");
  const timeoutMs = positiveInteger(hooks.timeoutMs, FETCH_TIMEOUT_MS);
  const maxBytes = positiveInteger(hooks.maxBytes, MAX_FETCH_BYTES);
  const maxRedirects = nonNegativeInteger(hooks.maxRedirects, MAX_REDIRECTS);
  const resolveAddresses = hooks.resolve || resolveAdultBlocklistAddresses;
  const requestHop = hooks.request || requestPinnedAdultBlocklistHop;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Adult blocklist refresh timed out.")), timeoutMs);
  try {
    let currentUrl = new URL(url);
    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
      const addresses = await safeAdultBlocklistAddresses(currentUrl, resolveAddresses, controller.signal);
      const response = await requestPinnedAddress(currentUrl, addresses, controller.signal, requestHop);
      if (response.statusCode >= 300 && response.statusCode < 400) {
        const location = firstHeaderValue(response.headers.location);
        response.destroy();
        if (!location || redirectCount === maxRedirects) {
          throw new Error("Adult blocklist refresh exceeded the redirect limit.");
        }
        currentUrl = new URL(location, currentUrl);
        continue;
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.destroy();
        throw new Error(`Adult blocklist refresh failed (${response.statusCode}).`);
      }
      return await pinnedResponseTextWithLimit(response, maxBytes);
    }
    throw new Error("Adult blocklist refresh exceeded the redirect limit.");
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchAdultBlocklistSourceTextForTest(
  url: string,
  hooks: AdultBlocklistFetchTestHooks
): Promise<string> {
  return await fetchSourceText(url, hooks);
}

export async function assertSafeAdultBlocklistUrl(url: URL): Promise<void> {
  await safeAdultBlocklistAddresses(url, resolveAdultBlocklistAddresses);
}

async function safeAdultBlocklistAddresses(
  url: URL,
  resolveAddresses: (hostname: string) => Promise<AdultBlocklistResolvedAddress[]>,
  signal?: AbortSignal
): Promise<AdultBlocklistResolvedAddress[]> {
  if (url.protocol !== "https:") throw new Error("Adult blocklist sources must use HTTPS.");
  const hostname = normalizedUrlHostname(url);
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new Error("Adult blocklist sources cannot use local network hosts.");
  }
  const literalFamily = isIP(hostname);
  const resolved = literalFamily
    ? [{ address: hostname, family: literalFamily as 4 | 6 }]
    : await abortable(resolveAddresses(hostname), signal);
  const addresses = uniqueResolvedAddresses(resolved);
  if (!addresses.length || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("Adult blocklist sources cannot resolve to private network addresses.");
  }
  return addresses;
}

async function resolveAdultBlocklistAddresses(hostname: string): Promise<AdultBlocklistResolvedAddress[]> {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map(({ address, family }) => ({
    address,
    family: family === 6 ? 6 : 4
  }));
}

async function requestPinnedAddress(
  url: URL,
  addresses: AdultBlocklistResolvedAddress[],
  signal: AbortSignal,
  requestHop: (
    url: URL,
    address: AdultBlocklistResolvedAddress,
    signal: AbortSignal
  ) => Promise<AdultBlocklistPinnedResponse>
): Promise<AdultBlocklistPinnedResponse> {
  let lastError: unknown = null;
  for (const address of addresses) {
    try {
      return await requestHop(url, address, signal);
    } catch (error) {
      if (signal.aborted) throw abortReason(signal);
      lastError = error;
    }
  }
  throw lastError || new Error("Adult blocklist source did not provide a reachable public address.");
}

async function requestPinnedAdultBlocklistHop(
  url: URL,
  address: AdultBlocklistResolvedAddress,
  signal: AbortSignal
): Promise<AdultBlocklistPinnedResponse> {
  const hostname = normalizedUrlHostname(url);
  return await new Promise<AdultBlocklistPinnedResponse>((resolve, reject) => {
    const request = httpsRequest(url, {
      method: "GET",
      signal,
      lookup: pinnedLookup(address),
      rejectUnauthorized: true,
      servername: isIP(hostname) ? undefined : hostname,
      headers: {
        accept: "text/plain,*/*;q=0.1",
        "user-agent": "Vigil adult-blocklist-refresh"
      }
    }, (response) => {
      resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: response,
        destroy: () => response.destroy()
      });
    });
    request.once("error", reject);
    request.end();
  });
}

function pinnedLookup(address: AdultBlocklistResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [address]);
      return;
    }
    callback(null, address.address, address.family);
  };
}

function uniqueResolvedAddresses(values: AdultBlocklistResolvedAddress[]): AdultBlocklistResolvedAddress[] {
  const unique = new Map<string, AdultBlocklistResolvedAddress>();
  for (const value of values || []) {
    const address = String(value?.address || "").trim().toLowerCase();
    const family = isIP(address);
    if (!family) return [];
    unique.set(`${family}:${address}`, { address, family: family as 4 | 6 });
  }
  return [...unique.values()];
}

function normalizedUrlHostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/u, "");
}

function isPrivateNetworkAddress(value: string): boolean {
  const address = value.toLowerCase();
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    if (["::", "::1"].includes(address)) return true;
    if (/^(?:fc|fd)/u.test(address) || /^fe[89ab]/u.test(address) || /^ff/u.test(address)) return true;
    const mapped = address.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    if (mapped) return isPrivateNetworkAddress(mapped);
    const firstHextet = Number.parseInt(address.split(":", 1)[0] || "", 16);
    if (!Number.isFinite(firstHextet) || firstHextet < 0x2000 || firstHextet > 0x3fff) return true;
    return /^2001:(?:2|10|20|db8):/u.test(address);
  }
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [first, second] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 2 || second === 168))
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 224;
}

async function pinnedResponseTextWithLimit(response: AdultBlocklistPinnedResponse, limit: number): Promise<string> {
  const declaredLength = Number(firstHeaderValue(response.headers["content-length"]) || 0);
  if (declaredLength > limit) {
    response.destroy();
    throw new Error("Adult blocklist source is too large.");
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for await (const chunk of response.body) {
    const value = responseChunk(chunk);
    received += value.byteLength;
    if (received > limit) {
      response.destroy();
      throw new Error("Adult blocklist source is too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function responseChunk(value: unknown): Uint8Array {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("Adult blocklist source returned an unsupported response chunk.");
}

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function nonNegativeInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await promise;
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Adult blocklist refresh was aborted.");
}

async function writeAdultBlocklistSnapshot(snapshot: AdultBlocklistSnapshot, path: string): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(snapshot)}\n`);
  diskSnapshotCache.set(path, snapshot);
}

function loadAdultBlocklistSnapshotSync(path: string): AdultBlocklistSnapshot | null {
  if (diskSnapshotCache.has(path)) return diskSnapshotCache.get(path) || null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AdultBlocklistSnapshot>;
    const domains = uniqueDomains((parsed.domains || []).map(normalizeAdultDomain).filter(Boolean));
    if (!domains.length) {
      diskSnapshotCache.set(path, null);
      return null;
    }
    const actualHash = domainHash(domains);
    if (parsed.hash && parsed.hash !== actualHash) {
      diskSnapshotCache.set(path, null);
      return null;
    }
    const snapshot = {
      version: SNAPSHOT_VERSION,
      generatedAt: String(parsed.generatedAt || ""),
      domainCount: domains.length,
      hash: actualHash,
      source: {
        id: String(parsed.source?.id || "unknown"),
        label: String(parsed.source?.label || "Adult blocklist"),
        url: String(parsed.source?.url || ""),
        homepage: String(parsed.source?.homepage || ""),
        license: String(parsed.source?.license || "")
      },
      domains
    };
    diskSnapshotCache.set(path, snapshot);
    return snapshot;
  } catch {
    diskSnapshotCache.set(path, null);
    return null;
  }
}

function setRuntimeSnapshot(snapshot: AdultBlocklistSnapshot, path: string | null = null): void {
  runtimeSnapshot = snapshot;
  runtimeSnapshotPath = path;
  runtimeDomainSet = new Set(snapshot.domains);
}

function availableAdultBlocklistSnapshotsSync(state: VigilState): AdultBlocklistSnapshot[] {
  const candidates = [
    runtimeSnapshot,
    ...adultBlocklistSnapshotCandidatePaths(state).map(loadAdultBlocklistSnapshotSync)
  ].filter((item): item is AdultBlocklistSnapshot => Boolean(item));
  const seen = new Set<string>();
  return candidates.filter((snapshot) => {
    const key = `${snapshot.source.id}\n${snapshot.source.url}\n${snapshot.hash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function adultBlocklistSnapshotCandidatePaths(state: VigilState): string[] {
  const storedPath = trustedAdultBlocklistSnapshotPath(state.adultBlocklist?.snapshotPath || "");
  return [...new Set([
    storedPath,
    ADULT_BLOCKLIST_SNAPSHOT_PATH,
    ADULT_BLOCKLIST_PREVIOUS_SNAPSHOT_PATH
  ].filter(Boolean))];
}

function trustedAdultBlocklistSnapshotPath(value: string): string {
  if (!value) return "";
  const path = resolve(value);
  if (dirname(path) !== resolve(DATA_DIR)) return "";
  const name = basename(path);
  return name === basename(ADULT_BLOCKLIST_SNAPSHOT_PATH)
    || name === basename(ADULT_BLOCKLIST_PREVIOUS_SNAPSHOT_PATH)
    || VERSIONED_SNAPSHOT_PATTERN.test(name)
    ? path
    : "";
}

function adultBlocklistSnapshotPath(snapshot: AdultBlocklistSnapshot): string {
  const fileHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return join(DATA_DIR, `adult-blocklist.${fileHash}.json`);
}

function adultBlocklistSnapshotMatches(
  snapshot: AdultBlocklistSnapshot | null,
  selectedSource: AdultBlocklistSourceSnapshot,
  expectedHash: string
): snapshot is AdultBlocklistSnapshot {
  return Boolean(
    snapshot
    && adultBlocklistSourceMatches(snapshot.source, selectedSource)
    && (!expectedHash || snapshot.hash === expectedHash)
  );
}

function testSnapshot(
  domains: string[],
  source: Partial<AdultBlocklistSourceSnapshot>,
  generatedAt: string
): AdultBlocklistSnapshot {
  const normalized = uniqueDomains(domains.map(normalizeAdultDomain).filter(Boolean));
  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date(generatedAt).toISOString(),
    domainCount: normalized.length,
    hash: domainHash(normalized),
    source: {
      id: source.id || "test",
      label: source.label || "Test adult blocklist",
      url: source.url || "memory://adult-blocklist",
      homepage: source.homepage || "",
      license: source.license || "Test"
    },
    domains: normalized
  };
}

function sourceSnapshot(source: AdultBlocklistSource): AdultBlocklistSourceSnapshot {
  return {
    id: source.id,
    label: source.label,
    url: source.url,
    homepage: source.homepage,
    license: source.license
  };
}

function adultBlocklistSourceMatches(
  snapshotSource: AdultBlocklistSourceSnapshot | null | undefined,
  selectedSource: AdultBlocklistSourceSnapshot | null | undefined
): boolean {
  return Boolean(
    snapshotSource
    && selectedSource
    && snapshotSource.id === selectedSource.id
    && normalizeSourceUrl(snapshotSource.url) === normalizeSourceUrl(selectedSource.url)
  );
}

function normalizeSourceUrl(value: unknown): string {
  return String(value || "").trim();
}

function domainHash(domains: string[]): string {
  return createHash("sha256").update(domains.join("\n")).digest("hex");
}

function uniqueDomains(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function isHostsSink(value: string): boolean {
  return ["0.0.0.0", "127.0.0.1", "::1", "255.255.255.255"].includes(value);
}

function isPublicDomain(value: string): boolean {
  if (!value || value.length > 253 || !value.includes(".")) return false;
  if (!/^[a-z0-9.-]+$/.test(value)) return false;
  if (value.startsWith(".") || value.endsWith(".") || value.includes("..")) return false;
  if (["localhost", "local"].includes(value)) return false;
  return value.split(".").every((label) => label && label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"));
}

function adultBlocklistDetail({
  hasSnapshot,
  enabled,
  activeCount,
  error,
  current,
  sourceMismatch
}: {
  hasSnapshot: boolean;
  enabled: boolean;
  activeCount: number;
  error: string;
  current: boolean;
  sourceMismatch: boolean;
}): string {
  if (!enabled) return "Adult blocklist is disabled.";
  if (error) return `Adult blocklist refresh needs attention: ${error}`;
  if (sourceMismatch) return "Adult blocklist source changed; refresh it to load the selected source.";
  if (!hasSnapshot) return "Adult blocklist is enabled; refresh it to load the large domain snapshot.";
  if (!current) return "Adult blocklist snapshot is loaded; refresh it to mark the selected source current.";
  return `Adult blocklist loaded with ${activeCount.toLocaleString()} active domain target${activeCount === 1 ? "" : "s"}.`;
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as { message?: unknown } : {};
  return String(record.message || error || "").trim();
}
