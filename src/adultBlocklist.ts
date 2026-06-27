import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT,
  DEFAULT_ADULT_BLOCKLIST_SOURCE_ID,
  DEFAULT_EXPLICIT_BLOCKED_SITES
} from "./defaults.js";
import { DATA_DIR } from "./store.js";
import type { AdultBlocklistSourceSnapshot, SentinelState, UnknownRecord } from "./types.js";

export const ADULT_BLOCKLIST_SNAPSHOT_PATH = join(DATA_DIR, "adult-blocklist.json");
export const ADULT_BLOCKLIST_CUSTOM_SOURCE_ID = "custom";
export const ADULT_BLOCKLIST_BROWSER_SITE_RULE_LIMIT = 300;
const SNAPSHOT_VERSION = 1;
const FETCH_TIMEOUT_MS = 45_000;
const MIN_REFRESH_DOMAINS = 1000;

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
    id: DEFAULT_ADULT_BLOCKLIST_SOURCE_ID,
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
    id: "blocklistproject-porn",
    label: "Block List Project porn",
    url: "https://blocklistproject.github.io/Lists/porn.txt",
    homepage: "https://github.com/blocklistproject/Lists",
    license: "Unlicense",
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
let runtimeDomainSet: Set<string> | null = null;

export function adultBlocklistEnabled(state: SentinelState): boolean {
  return state.settings?.adultBlocklistEnabled !== false;
}

export function adultBlocklistSource(state: SentinelState): AdultBlocklistSource {
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

export function invalidateAdultBlocklistIfSourceChanged(state: SentinelState, previousSource: AdultBlocklistSourceSnapshot | null): boolean {
  if (adultBlocklistSourceMatches(previousSource, adultBlocklistSource(state))) return false;
  clearAdultBlocklistSnapshotState(state);
  return true;
}

export function clearAdultBlocklistSnapshotState(state: SentinelState): void {
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

export async function refreshAdultBlocklist(state: SentinelState, now = new Date()) {
  const source = adultBlocklistSource(state);
  const attemptedAt = now.toISOString();
  state.adultBlocklist.lastAttemptAt = attemptedAt;
  state.adultBlocklist.lastError = "";
  try {
    const text = await fetchSourceText(source.url);
    const domains = parseAdultBlocklistDomains(text);
    if (domains.length < MIN_REFRESH_DOMAINS) {
      throw new Error(`Adult blocklist refresh returned only ${domains.length} usable domains.`);
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
    await writeAdultBlocklistSnapshot(snapshot);
    setRuntimeSnapshot(snapshot);
    state.adultBlocklist.domainCount = domains.length;
    state.adultBlocklist.activeDomainCount = activeDomainCount(state, domains);
    state.adultBlocklist.hash = hash;
    state.adultBlocklist.snapshotPath = ADULT_BLOCKLIST_SNAPSHOT_PATH;
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

export function matchAdultBlocklistHost(state: SentinelState, value: unknown): AdultBlocklistMatch | null {
  if (!adultBlocklistEnabled(state)) return null;
  const hostname = normalizeAdultDomain(value);
  if (!hostname || adultBlocklistAllowsHost(state, hostname)) return null;
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

export function adultBlocklistPreloadDomains(state: SentinelState, options: { limit?: number } = {}): string[] {
  if (!adultBlocklistEnabled(state)) return [];
  const limit = adultBlocklistPreloadLimit(state, options.limit);
  if (limit <= 0) return [];
  const snapshot = loadSelectedAdultBlocklistSnapshotSync(state);
  const candidates = uniqueDomains([
    ...DEFAULT_EXPLICIT_BLOCKED_SITES,
    ...(snapshot?.domains || [])
  ]);
  return candidates
    .filter((domain) => !adultBlocklistAllowsHost(state, domain))
    .slice(0, limit);
}

export function adultBlocklistSummary(state: SentinelState) {
  const selected = adultBlocklistSource(state);
  const loadedSnapshot = loadAdultBlocklistSnapshotSync();
  const snapshotSourceMatches = adultBlocklistSourceMatches(loadedSnapshot?.source, selected);
  const storedSourceMatches = adultBlocklistSourceMatches(state.adultBlocklist?.source, selected);
  const snapshot = snapshotSourceMatches ? loadedSnapshot : null;
  const stored = storedSourceMatches ? state.adultBlocklist : null;
  const domains = snapshot?.domains || [];
  const domainCount = snapshot?.domainCount || stored?.domainCount || 0;
  const activeCount = snapshot ? activeDomainCount(state, domains) : stored?.activeDomainCount || 0;
  const hash = snapshot?.hash || stored?.hash || "";
  const current = Boolean(snapshot && stored?.hash && snapshot.hash === stored.hash);
  const sourceMismatch = Boolean((loadedSnapshot && !snapshotSourceMatches) || (state.adultBlocklist?.source && !storedSourceMatches));
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
    snapshotPath: snapshot ? ADULT_BLOCKLIST_SNAPSHOT_PATH : stored?.snapshotPath || "",
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
  const normalized = uniqueDomains(domains.map(normalizeAdultDomain).filter(Boolean));
  setRuntimeSnapshot({
    version: SNAPSHOT_VERSION,
    generatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
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
  });
}

export function clearAdultBlocklistCacheForTest(): void {
  clearAdultBlocklistCache();
}

function clearAdultBlocklistCache(): void {
  runtimeSnapshot = null;
  runtimeDomainSet = null;
}

function loadSelectedAdultBlocklistSnapshotSync(state: SentinelState): AdultBlocklistSnapshot | null {
  const snapshot = loadAdultBlocklistSnapshotSync();
  if (!adultBlocklistSourceMatches(snapshot?.source, adultBlocklistSource(state))) return null;
  return snapshot;
}

function adultBlocklistPreloadLimit(state: SentinelState, override?: number): number {
  const value = override ?? state.settings?.adultBlocklistPreloadLimit ?? DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT;
  if (!Number.isFinite(Number(value))) return DEFAULT_ADULT_BLOCKLIST_PRELOAD_LIMIT;
  return Math.max(0, Math.min(250, Math.trunc(Number(value))));
}

function activeDomainCount(state: SentinelState, domains: string[]): number {
  return domains.filter((domain) => !adultBlocklistAllowsHost(state, domain)).length;
}

function adultBlocklistAllowsHost(state: SentinelState, hostname: string): boolean {
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

async function fetchSourceText(url: string): Promise<string> {
  if (!String(url || "").trim()) throw new Error("Adult blocklist source URL is empty.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Sentinel adult-blocklist-refresh"
      }
    });
    if (!response.ok) throw new Error(`Adult blocklist refresh failed (${response.status}).`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function writeAdultBlocklistSnapshot(snapshot: AdultBlocklistSnapshot): Promise<void> {
  await mkdir(dirname(ADULT_BLOCKLIST_SNAPSHOT_PATH), { recursive: true });
  const temp = `${ADULT_BLOCKLIST_SNAPSHOT_PATH}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(snapshot)}\n`, "utf8");
  await rename(temp, ADULT_BLOCKLIST_SNAPSHOT_PATH);
}

function loadAdultBlocklistSnapshotSync(): AdultBlocklistSnapshot | null {
  if (runtimeSnapshot) return runtimeSnapshot;
  try {
    const parsed = JSON.parse(readFileSync(ADULT_BLOCKLIST_SNAPSHOT_PATH, "utf8")) as Partial<AdultBlocklistSnapshot>;
    const domains = uniqueDomains((parsed.domains || []).map(normalizeAdultDomain).filter(Boolean));
    if (!domains.length) return null;
    setRuntimeSnapshot({
      version: SNAPSHOT_VERSION,
      generatedAt: String(parsed.generatedAt || ""),
      domainCount: domains.length,
      hash: String(parsed.hash || domainHash(domains)),
      source: {
        id: String(parsed.source?.id || "unknown"),
        label: String(parsed.source?.label || "Adult blocklist"),
        url: String(parsed.source?.url || ""),
        homepage: String(parsed.source?.homepage || ""),
        license: String(parsed.source?.license || "")
      },
      domains
    });
    return runtimeSnapshot;
  } catch {
    return null;
  }
}

function setRuntimeSnapshot(snapshot: AdultBlocklistSnapshot): void {
  runtimeSnapshot = snapshot;
  runtimeDomainSet = new Set(snapshot.domains);
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
