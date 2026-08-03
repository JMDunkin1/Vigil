import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { appleContentFilterStatus } from "./appleContentFilter.js";
import { adultBlocklistPreloadDomains } from "./adultBlocklist.js";
import { vigilLocalSiteAllowList } from "./blockedPageUrl.js";
import { CONTENT_FILTER_RULES, contentFilterEnabled } from "./contentFilters.js";
import { DATA_DIR } from "./store.js";
import { toPlist } from "./plist.js";
import { activePolicy, baselinePolicy, expandSiteTargets, normalizeHost, normalizeUrlPattern } from "./policy.js";
import { DEFAULT_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES } from "./priorityBlockedDomains.js";
import type { ActivePolicy, VigilState } from "./types.js";

export const SAFARI_FILTER_PROFILE_ID = "tech.caseline.vigil.safari-url-filter";
export const SAFARI_FILTER_PAYLOAD_ID = `${SAFARI_FILTER_PROFILE_ID}.payload`;
const SAFARI_HISTORY_RESTRICTIONS_PAYLOAD_ID = `${SAFARI_FILTER_PROFILE_ID}.history-clearing`;
export const SAFARI_FILTER_PROFILE_PATH = join(DATA_DIR, "vigil-safari-url-filter.mobileconfig");

const execFileAsync = promisify(execFile);
const URL_LIMIT = 500;
const SAFARI_FILTER_SIGNATURE_VERSION = 4;
const PRIORITY_BLOCKED_SITE_KEYS = new Set([
  ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES,
  ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES
].map(normalizeHost));
const HTTP_PRIORITY_BLOCKED_SITE_KEYS = new Set(DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES.map(normalizeHost));

export interface SafariFilterUrlTarget {
  url: string;
  source: string;
  pathSpecific: boolean;
}

interface SafariProfileOptions {
  profilePath?: string;
}

interface ProfileListResult {
  installed: boolean;
  signature: string;
  raw: string;
}

interface SafariFilterPolicyData {
  denyUrls: string[];
  pathDenyUrls: string[];
  siteAllowList: ReturnType<typeof vigilLocalSiteAllowList>;
  signature: string;
}

export function safariUrlFilterEnabled(state: VigilState): boolean {
  return contentFilterEnabled(state) || state.settings?.safariUrlFilterEnabled !== false;
}

export function safariFilterDenyUrls(state: VigilState, now = new Date()): string[] {
  return safariFilterPolicyData(state, now).denyUrls;
}

export function safariFilterPathDenyUrls(state: VigilState, now = new Date()): string[] {
  return safariFilterPolicyData(state, now).pathDenyUrls;
}

export function safariFilterDenyMatch(state: VigilState, value: unknown, now = new Date()): string {
  let url: URL;
  try {
    url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return "";
  } catch {
    return "";
  }
  const candidates = managedFilterMatchCandidates(url);
  return safariFilterTargets(state, now).find((target) => {
    const pattern = target.url.toLowerCase();
    return candidates.some((candidate) => candidate.includes(pattern));
  })?.url || "";
}

function managedFilterMatchCandidates(url: URL): string[] {
  const candidates: string[] = [];
  const seeds = [url.toString(), ...url.searchParams.values()];
  for (const seed of seeds) {
    let decoded = seed.toLowerCase();
    candidates.push(decoded, normalizeAppleWww(decoded));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const next = decodePercentRuns(decoded).toLowerCase();
      if (next === decoded) break;
      candidates.push(next, normalizeAppleWww(next));
      decoded = next;
    }
  }
  return [...new Set(candidates)];
}

function normalizeAppleWww(value: string): string {
  return value.replace(/(https?:\/\/)www\./giu, "$1");
}

function decodePercentRuns(value: string): string {
  return value.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => (
        String.fromCharCode(Number.parseInt(hex, 16))
      ));
    }
  });
}

export function safariFilterTargets(state: VigilState, now = new Date()): SafariFilterUrlTarget[] {
  if (!safariUrlFilterEnabled(state)) return [];
  const targets: SafariFilterUrlTarget[] = [];
  const policy = activePolicy(state, now);
  const policies = safariFilterPolicies(state, now);

  for (const item of policies) {
    for (const site of item.profile?.blockedSites || []) {
      if (PRIORITY_BLOCKED_SITE_KEYS.has(normalizeHost(site))) continue;
      targets.push(...siteTargetUrls(site, `${item.kind}:site`));
    }
    for (const pattern of item.profile?.blockedUrlPatterns || []) {
      targets.push(...urlPatternTargetUrls(pattern, `${item.kind}:url-pattern`));
    }
  }

  if (policy && contentFilterEnabled(state)) {
    for (const rule of CONTENT_FILTER_RULES) {
      for (const filter of rule.urlFilters) {
        targets.push(...contentFilterTargetUrls(filter, `content-filter:${rule.id}`));
      }
    }
  }

  for (const site of [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
    const host = normalizeHost(site);
    if (!isPublicHost(host)) continue;
    targets.push({
      url: `https://${host}/`,
      source: "priority-domain",
      pathSpecific: false
    });
    if (HTTP_PRIORITY_BLOCKED_SITE_KEYS.has(host)) {
      targets.push({
        url: `http://${host}/`,
        source: "priority-domain",
        pathSpecific: false
      });
    }
  }

  for (const site of adultBlocklistPreloadDomains(state)) {
    targets.push(...siteTargetUrls(site, "adult-blocklist:preload"));
  }

  return uniqueTargets(targets).slice(0, URL_LIMIT);
}

export function safariFilterPolicySignature(state: VigilState, now = new Date()): string {
  return safariFilterPolicyData(state, now).signature;
}

function safariFilterPolicyData(state: VigilState, now: Date): SafariFilterPolicyData {
  const targets = safariFilterTargets(state, now);
  const denyUrls = targets.map((target) => target.url).slice(0, URL_LIMIT);
  const pathDenyUrls = targets
    .filter((target) => target.pathSpecific)
    .map((target) => target.url)
    .slice(0, URL_LIMIT);
  const siteAllowList = vigilLocalSiteAllowList();
  const signature = safariFilterPolicySignatureForUrls(denyUrls, siteAllowList);
  return { denyUrls, pathDenyUrls, siteAllowList, signature };
}

function safariFilterPolicySignatureForUrls(
  denyUrls: string[],
  siteAllowList: ReturnType<typeof vigilLocalSiteAllowList>
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      version: SAFARI_FILTER_SIGNATURE_VERSION,
      appleBuiltInContentFilter: true,
      removalDisallowed: true,
      allowSafariHistoryClearing: true,
      siteAllowList,
      denyUrls
    }))
    .digest("hex");
}

export function buildSafariFilterProfile(state: VigilState, now = new Date()): string {
  return buildSafariFilterProfileFromData(safariFilterPolicyData(state, now));
}

function buildSafariFilterProfileFromData(data: SafariFilterPolicyData): string {
  return toPlist({
    PayloadContent: [
      {
        allowListEnabled: false,
        filterDenyList: data.denyUrls,
        restrictWeb: true,
        siteAllowList: data.siteAllowList,
        useContentFilter: true,
        PayloadDescription: "Enforces Apple's built-in web content filter plus Vigil deny URLs in Safari without rewriting browser tabs.",
        PayloadDisplayName: "Vigil Safari URL Filter",
        PayloadIdentifier: SAFARI_FILTER_PAYLOAD_ID,
        PayloadType: "com.apple.familycontrols.contentfilter",
        PayloadUUID: deterministicUuid(SAFARI_FILTER_PAYLOAD_ID),
        PayloadVersion: 1
      },
      {
        allowSafariHistoryClearing: true,
        PayloadDescription: "Allows Safari history clearing while Vigil's Safari URL filter is installed.",
        PayloadDisplayName: "Vigil Safari History Clearing",
        PayloadIdentifier: SAFARI_HISTORY_RESTRICTIONS_PAYLOAD_ID,
        PayloadType: "com.apple.applicationaccess",
        PayloadUUID: deterministicUuid(SAFARI_HISTORY_RESTRICTIONS_PAYLOAD_ID),
        PayloadVersion: 1
      }
    ],
    PayloadDescription: `Vigil Safari URL filter. VigilPolicySignature:${data.signature}`,
    PayloadDisplayName: "Vigil Safari URL Filter",
    PayloadIdentifier: SAFARI_FILTER_PROFILE_ID,
    PayloadOrganization: "Vigil",
    PayloadRemovalDisallowed: true,
    PayloadType: "Configuration",
    PayloadUUID: deterministicUuid(SAFARI_FILTER_PROFILE_ID),
    PayloadVersion: 1
  });
}

export async function writeSafariFilterProfile(state: VigilState, now = new Date(), options: SafariProfileOptions = {}) {
  const profilePath = options.profilePath || SAFARI_FILTER_PROFILE_PATH;
  const data = safariFilterPolicyData(state, now);
  const text = buildSafariFilterProfileFromData(data);
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, text, "utf8");
  return {
    path: profilePath,
    signature: data.signature,
    urlCount: data.denyUrls.length,
    pathUrlCount: data.pathDenyUrls.length
  };
}

export async function safariFilterStatus(state: VigilState, now = new Date(), options: SafariProfileOptions = {}) {
  const profilePath = options.profilePath || SAFARI_FILTER_PROFILE_PATH;
  const data = safariFilterPolicyData(state, now);
  const generated = await generatedProfileMatches(profilePath, data.signature);
  const installed = await installedSafariProfile();
  const appleContentFilter = await appleContentFilterStatus();
  const required = safariUrlFilterEnabled(state) && contentFilterEnabled(state);
  const stale = Boolean(installed.installed && installed.signature !== data.signature);
  const profileCurrent = Boolean(installed.installed && installed.signature === data.signature);
  return {
    enabled: safariUrlFilterEnabled(state),
    required,
    appleContentFilter,
    appleCurrent: appleContentFilter.current,
    vigilPagesReachable: appleContentFilter.vigilPagesReachable,
    // Safari's "Reload Without Content Blockers" can disable extension-level
    // blockers for a page. Only count the filter as effective when Apple's
    // system web-content policy is actually active; an installed profile record
    // by itself is not a fail-closed enforcement signal.
    effectiveCurrent: appleContentFilter.current,
    installed: installed.installed,
    current: profileCurrent,
    stale,
    generated,
    path: profilePath,
    signature: data.signature,
    installedSignature: installed.signature || null,
    urlCount: data.denyUrls.length,
    pathUrlCount: data.pathDenyUrls.length,
    expectedUrls: data.denyUrls.length
  };
}

function safariFilterPolicies(state: VigilState, now: Date): ActivePolicy[] {
  const policies: ActivePolicy[] = [];
  const baseline = baselinePolicy(state, now, { device: "computer" });
  const active = activePolicy(state, now);
  if (baseline) policies.push(baseline);
  if (active && !policies.some((policy) => policy.kind === active.kind && policy.session?.id === active.session?.id)) {
    policies.push(active);
  }
  return policies;
}

function siteTargetUrls(site: unknown, source: string): SafariFilterUrlTarget[] {
  return expandSiteTargets([site]).flatMap((host) => {
    if (!isPublicHost(host)) return [];
    return hostVariants(host).flatMap((variant) => protocolUrls(variant, "/", source, false));
  });
}

function contentFilterTargetUrls(filter: unknown, source: string): SafariFilterUrlTarget[] {
  const normalized = normalizeUrlPattern(String(filter || "").replace(/^\|\|/, ""));
  if (!normalized) return [];
  if (!normalized.includes("/")) return siteTargetUrls(normalized, source);
  return urlPatternTargetUrls(normalized, source);
}

function urlPatternTargetUrls(pattern: unknown, source: string): SafariFilterUrlTarget[] {
  const normalized = normalizeUrlPattern(pattern);
  if (!normalized || normalized.startsWith("/") || !normalized.includes("/")) return [];
  const slash = normalized.indexOf("/");
  const host = normalizeHost(normalized.slice(0, slash));
  const path = normalizePath(normalized.slice(slash));
  if (!isPublicHost(host) || path === "/") return [];
  return hostVariants(host).flatMap((variant) => protocolUrls(variant, path, source, true));
}

function protocolUrls(host: string, path: string, source: string, pathSpecific: boolean): SafariFilterUrlTarget[] {
  return ["https", "http"].map((scheme) => ({
    url: `${scheme}://${host}${path}`,
    source,
    pathSpecific
  }));
}

function hostVariants(host: string): string[] {
  const variants = [host];
  if (!host.startsWith("www.")) variants.push(`www.${host}`);
  return [...new Set(variants)];
}

function normalizePath(value: string): string {
  const path = `/${String(value || "").replace(/^\/+/, "")}`;
  return path.replace(/\/+$/, "") || "/";
}

function uniqueTargets(targets: SafariFilterUrlTarget[]): SafariFilterUrlTarget[] {
  const byUrl = new Map<string, SafariFilterUrlTarget>();
  for (const target of targets) {
    if (!target.url || byUrl.has(target.url)) continue;
    byUrl.set(target.url, target);
  }
  return [...byUrl.values()];
}

function isPublicHost(host: string): boolean {
  return Boolean(
    host &&
    host.includes(".") &&
    /^[a-z0-9.-]+$/.test(host) &&
    !host.startsWith(".") &&
    !host.endsWith(".") &&
    !host.includes("..") &&
    !["localhost", "127.0.0.1", "::1"].includes(host)
  );
}

async function generatedProfileMatches(profilePath: string, signature: string): Promise<boolean> {
  try {
    const text = await readFile(profilePath, "utf8");
    return text.includes(`VigilPolicySignature:${signature}`);
  } catch {
    return false;
  }
}

async function installedSafariProfile(): Promise<ProfileListResult> {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/profiles", ["show", "-type", "configuration", "-identifier", SAFARI_FILTER_PROFILE_ID], {
      timeout: 5000,
      maxBuffer: 1024 * 512
    });
    const raw = `${stdout}\n${stderr}`.trim();
    return {
      installed: raw.includes(SAFARI_FILTER_PROFILE_ID),
      signature: signatureFromProfileOutput(raw),
      raw
    };
  } catch (error) {
    return {
      installed: false,
      signature: "",
      raw: simplifyError(error)
    };
  }
}

function signatureFromProfileOutput(output: string): string {
  const match = output.match(/VigilPolicySignature:([a-f0-9]{64})/i);
  return match?.[1]?.toLowerCase() || "";
}

function deterministicUuid(seed: string): string {
  const hex = createHash("sha1").update(seed).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  const variant = Number.parseInt(hex[16] || "0", 16);
  hex[16] = ((variant & 0x3) | 0x8).toString(16);
  const text = hex.join("");
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`.toUpperCase();
}

function simplifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}
