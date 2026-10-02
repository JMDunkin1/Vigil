import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import type { VigilState } from "./types.js";

export interface SketchySiteEvidence {
  domain: string;
  hostname: string;
  observedAt: string;
  signal: "safari-content-blocker-error";
  registeredAt: string | null;
  checkedAt: string | null;
  lookupStatus: "pending" | "verified" | "unavailable";
  lookupError: string;
}

const DAY = 86_400_000;
const suffixes = new Set<string>();
const exceptions = new Set<string>();
for (const line of readFileSync(new URL("../public/sketchy-site-public-suffixes.dat", import.meta.url), "utf8").split("\n")) {
  if (line.includes("BEGIN PRIVATE DOMAINS")) break;
  const rule = line.trim();
  if (!rule || rule.startsWith("//")) continue;
  const ascii = domainToASCII(rule.replace(/^!|^\*\./u, ""));
  if (rule.startsWith("!")) exceptions.add(ascii);
  else suffixes.add(rule.startsWith("*.") ? `*.${ascii}` : ascii);
}
const bootstrap = JSON.parse(readFileSync(new URL("../public/sketchy-site-rdap-bootstrap.json", import.meta.url), "utf8")) as { services: [string[], string[]][] };
const requests = new Map<string, Promise<RegistrationLookup>>();

// ICANN suffixes, including wildcard and exception rules. Private hosting
// subdomains are not new registrations: the registry owns only the base name.
export function registeredDomain(input: string): string {
  let host = "";
  try { host = new URL(input.includes("://") ? input : `https://${input}`).hostname; } catch { return ""; }
  host = domainToASCII(host.toLowerCase().replace(/\.$/u, ""));
  if (!host || isIP(host) || host.includes(":")) return "";
  const labels = host.split(".");
  if (labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return "";
  let suffixLength = 0;
  for (let index = 0; index < labels.length; index++) {
    const suffix = labels.slice(index).join(".");
    if (exceptions.has(suffix)) { suffixLength = labels.length - index - 1; break; }
    if (suffixes.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - index);
    if (index > 0 && suffixes.has(`*.${suffix}`)) suffixLength = Math.max(suffixLength, labels.length - index + 1);
  }
  // Unknown TLDs are not guessed to be registrable domains.
  return suffixLength && labels.length > suffixLength ? labels.slice(-suffixLength - 1).join(".") : "";
}

function sketchySiteDomainKey(input: string): string {
  try {
    const url = new URL(input.includes("://") ? input : `https://${input}`);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    if (!["http:", "https:"].includes(url.protocol) || ["localhost", "127.0.0.1", "[::1]"].includes(host)) return "";
    // Unsupported suffixes and public IP destinations have no registry age.
    // Hold that exact host rather than guessing a shared registrable parent.
    return registeredDomain(url.href) || host;
  } catch { return ""; }
}

export function normalizeSketchySiteEvidence(input: unknown): SketchySiteEvidence[] {
  if (!Array.isArray(input)) return [];
  return input.filter((value): value is SketchySiteEvidence => Boolean(value
    && value.signal === "safari-content-blocker-error"
    && typeof value.domain === "string" && sketchySiteDomainKey(value.domain) === value.domain
    && typeof value.hostname === "string" && sketchySiteDomainKey(value.hostname) === value.domain
    && Number.isFinite(Date.parse(value.observedAt))
    && ["pending", "verified", "unavailable"].includes(value.lookupStatus)
    && (value.registeredAt === null || Number.isFinite(Date.parse(value.registeredAt)))
    && (value.checkedAt === null || Number.isFinite(Date.parse(value.checkedAt)))
    && typeof value.lookupError === "string"));
}

export function observeSafariContentBlockerError(state: VigilState, url: string, now = new Date()): SketchySiteEvidence | null {
  const domain = sketchySiteDomainKey(url);
  if (!domain) return null;
  const previous = state.sketchySites.find(entry => entry.domain === domain);
  if (previous) return previous;
  const evidence: SketchySiteEvidence = { domain, hostname: new URL(url).hostname,
    observedAt: now.toISOString(), signal: "safari-content-blocker-error",
    registeredAt: null, checkedAt: null, lookupStatus: "pending", lookupError: "" };
  state.sketchySites.push(evidence);
  return evidence;
}

export function matchSketchySite(state: VigilState, url: string, now = new Date()) {
  const domain = sketchySiteDomainKey(url);
  const entry = state.sketchySites.find(value => value.domain === domain);
  if (!entry) return null;
  const threshold = state.settings.sketchySiteMaxAgeDays;
  const age = entry.registeredAt ? now.getTime() - Date.parse(entry.registeredAt) : NaN;
  if (entry.lookupStatus === "verified" && age >= 0 && age < threshold * DAY) {
    return { area: "sketchy-site", label: `Content-blocked domain registered less than ${threshold} days ago`, url, domain };
  }
  if (entry.lookupStatus !== "verified") {
    return { area: "sketchy-site", label: entry.lookupStatus === "pending"
      ? "Content-blocked site: checking registration age"
      : "Content-blocked site: registration age unavailable", url, domain };
  }
  return null;
}

export interface RegistrationLookup {
  registeredAt: string | null;
  checkedAt: string;
  lookupStatus: "verified" | "unavailable";
  lookupError: string;
}

export function completeSketchySiteLookup(state: VigilState, domain: string, result: RegistrationLookup): void {
  const entry = state.sketchySites.find(value => value.domain === domain);
  if (entry) Object.assign(entry, result);
}

export function registrationDateFromRdap(body: unknown, domain: string, now = new Date()): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { objectClassName?: string; ldhName?: string; events?: { eventAction?: string; eventDate?: string }[] };
  if (value.objectClassName !== "domain" || value.ldhName?.toLowerCase() !== domain || !Array.isArray(value.events)) return null;
  const dates = value.events.filter(event => event.eventAction === "registration").map(event => event.eventDate || "");
  if (!dates.length || dates.some(date => !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(date)
    || !Number.isFinite(Date.parse(date)) || Date.parse(date) > now.getTime())) return null;
  return new Date(Math.min(...dates.map(Date.parse))).toISOString();
}

export function lookupDomainRegistration(domain: string, fetcher: typeof fetch = fetch): Promise<RegistrationLookup> {
  const previous = requests.get(domain);
  if (previous) return previous;
  const request = performLookup(domain, fetcher).finally(() => requests.delete(domain));
  requests.set(domain, request);
  return request;
}

async function performLookup(domain: string, fetcher: typeof fetch): Promise<RegistrationLookup> {
  const checkedAt = new Date().toISOString();
  try {
    if (registeredDomain(domain) !== domain) throw new Error("No registrable domain");
    const tld = domain.split(".").at(-1)!;
    const endpoint = bootstrap.services.find(([tlds]) => tlds.includes(tld))?.[1].find(value => value.startsWith("https://"));
    if (!endpoint) throw new Error("Registry has no supported secure RDAP endpoint");
    // Only a bundled IANA registry endpoint is contacted. Never visit the
    // suspect site, follow referrals, or transmit its path/query or tab history.
    const response = await fetcher(new URL(`domain/${encodeURIComponent(domain)}`, endpoint), {
      redirect: "error", signal: AbortSignal.timeout(8_000), headers: { Accept: "application/rdap+json, application/json" }
    });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}`);
    if (!response.body) throw new Error("Registry returned no response body");
    const reader = response.body.getReader();
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 512 * 1024) throw new Error("Registry response too large");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const registeredAt = registrationDateFromRdap(JSON.parse(Buffer.concat(chunks).toString("utf8")), domain);
    if (!registeredAt) throw new Error("Registry did not provide a valid domain registration date");
    return { registeredAt, checkedAt, lookupStatus: "verified", lookupError: "" };
  } catch (error) {
    return { registeredAt: null, checkedAt, lookupStatus: "unavailable", lookupError: error instanceof Error ? error.message.slice(0, 200) : "Registration lookup failed" };
  }
}
