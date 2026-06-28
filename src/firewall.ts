import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { managedBlockDomains } from "./hardening.js";
import { removeCompleteManagedBlocks, removePartialManagedBlockFragments } from "./managedBlock.js";
import type { VigilState, UnknownRecord } from "./types.js";

export const PF_CONF_PATH = "/etc/pf.conf";
export const PF_ANCHOR_PATH = "/etc/pf.anchors/com.vigil.block";
export const PF_ANCHOR_NAME = "com.vigil.block";
export const PF_CONF_BEGIN = "# BEGIN VIGIL PF";
export const PF_CONF_END = "# END VIGIL PF";
export const PF_ANCHOR_BEGIN = "# BEGIN VIGIL PF ANCHOR";
export const PF_ANCHOR_END = "# END VIGIL PF ANCHOR";

const execFileAsync = promisify(execFile);
const ADDRESS_RE = /^[0-9a-f:.]+$/i;

interface FirewallEntry {
  domain: string;
  host: string;
  address: string;
}

interface FirewallResolveError {
  host: string;
  error: string;
}

interface FirewallFileOptions {
  pfConfText: string;
  anchorText: string;
  pfConfPath?: string;
  anchorPath?: string;
}

export function buildPfConfBlock(anchorPath = PF_ANCHOR_PATH): string {
  return [
    PF_CONF_BEGIN,
    `anchor "${PF_ANCHOR_NAME}"`,
    `load anchor "${PF_ANCHOR_NAME}" from "${anchorPath}"`,
    PF_CONF_END
  ].join("\n");
}

export function replaceManagedPfConfBlock(currentPfConf: unknown, blockText = buildPfConfBlock()): string {
  let next = removeCompleteManagedBlocks(String(currentPfConf || ""), PF_CONF_BEGIN, PF_CONF_END);
  next = removePartialManagedBlockFragments(next, PF_CONF_BEGIN, PF_CONF_END);
  const prefix = next.trimEnd();
  return `${prefix}${prefix ? "\n\n" : ""}${blockText}\n`;
}

export async function buildResolvedFirewallBlock(state: VigilState, now = new Date()) {
  const domains = managedBlockDomains(state, now);
  const resolution = await resolveFirewallTargets(domains);
  return {
    block: buildFirewallBlock(domains, resolution.entries, resolution.errors),
    domains,
    ...resolution
  };
}

export function buildFirewallBlock(domains: unknown[] = [], entries: FirewallEntry[] = [], errors: FirewallResolveError[] = []): string {
  const cleanDomains = normalizeDomains(domains);
  const cleanEntries = normalizeEntries(entries);
  const lines = [
    PF_ANCHOR_BEGIN,
    "# Managed by Vigil. Edit profile site blocklists or host/path URL patterns, then re-run npm run network:apply.",
    `# Domain-Signature: ${firewallDomainSignature(cleanDomains)}`,
    `# Domain-Count: ${cleanDomains.length}`,
    `# Address-Count: ${cleanEntries.length}`
  ];

  if (!cleanDomains.length) {
    lines.push("# No hostname-based block targets are active for the current policy.");
  } else if (!cleanEntries.length) {
    lines.push("# No resolved IP addresses are available for the current Vigil domain targets.");
  } else {
    for (const entry of cleanEntries) {
      lines.push(`# ${entry.domain} via ${entry.host}`);
      lines.push(`block return out quick to ${entry.address}`);
    }
  }

  for (const error of errors || []) {
    if (!error?.host) continue;
    lines.push(`# Resolve error for ${error.host}: ${safeComment(error.error)}`);
  }

  lines.push(PF_ANCHOR_END);
  return lines.join("\n");
}

export async function resolveFirewallTargets(domains: unknown[] = []): Promise<{ entries: FirewallEntry[]; errors: FirewallResolveError[] }> {
  const entries: FirewallEntry[] = [];
  const errors: FirewallResolveError[] = [];
  for (const domain of firewallResolutionHosts(domains)) {
    try {
      const addresses = await lookup(domain, { all: true, verbatim: true });
      for (const item of addresses || []) {
        if (!isSafePfAddress(item.address)) continue;
        entries.push({
          domain: baseDomainForResolvedHost(domain),
          host: domain,
          address: item.address
        });
      }
    } catch (error) {
      errors.push({
        host: domain,
        error: simplifyError(error)
      });
    }
  }

  return {
    entries: normalizeEntries(entries),
    errors
  };
}

export async function firewallStatus(
  state: VigilState | null = null,
  now = new Date(),
  paths: { pfConfPath?: string; anchorPath?: string } = {}
) {
  const pfConfPath = paths.pfConfPath || PF_CONF_PATH;
  const anchorPath = paths.anchorPath || PF_ANCHOR_PATH;
  const expectedDomains: string[] = state ? managedBlockDomains(state, now) : [];
  const expectedSignature = firewallDomainSignature(expectedDomains);
  let pfConf = "";
  let anchor = "";
  let pfConfError = "";
  let anchorError = "";

  try {
    pfConf = await readFile(pfConfPath, "utf8");
  } catch (error) {
    pfConfError = simplifyError(error);
  }

  try {
    anchor = await readFile(anchorPath, "utf8");
  } catch (error) {
    anchorError = simplifyError(error);
  }

  const confBlock = extractManagedPfConfBlock(pfConf);
  const anchorBlock = extractManagedFirewallBlock(anchor);
  const confInstalled = Boolean(confBlock);
  const anchorInstalled = Boolean(anchorBlock);
  const partial = hasPartialPfConfBlock(pfConf) || hasPartialFirewallAnchor(anchor) || confInstalled !== anchorInstalled;
  const installed = confInstalled && anchorInstalled;
  const installedEntries = countFirewallRules(anchorBlock);
  const unresolvedTargets = expectedDomains.length > 0 && installedEntries === 0;
  const stale = Boolean(state && installed && (
    normalizeBlock(confBlock) !== normalizeBlock(buildPfConfBlock(anchorPath)) ||
    firewallAnchorSignature(anchorBlock) !== expectedSignature ||
    unresolvedTargets
  ));

  return {
    installed,
    partial,
    stale,
    current: Boolean(installed && !partial && !stale),
    pfConfInstalled: confInstalled,
    anchorInstalled,
    pfConfPath,
    anchorPath,
    anchorName: PF_ANCHOR_NAME,
    expectedDomainCount: expectedDomains.length,
    expectedSignature,
    installedSignature: firewallAnchorSignature(anchorBlock),
    installedEntries,
    pfConfError,
    anchorError
  };
}

export async function writeFirewallFiles({ pfConfText, anchorText, pfConfPath = PF_CONF_PATH, anchorPath = PF_ANCHOR_PATH }: FirewallFileOptions): Promise<void> {
  await mkdir(dirname(anchorPath), { recursive: true });
  await writeFile(anchorPath, anchorText.endsWith("\n") ? anchorText : `${anchorText}\n`, "utf8");
  await writeFile(pfConfPath, pfConfText.endsWith("\n") ? pfConfText : `${pfConfText}\n`, "utf8");
}

export async function validateAndLoadPf(pfConfPath = PF_CONF_PATH): Promise<void> {
  await execFileAsync("/sbin/pfctl", ["-n", "-f", pfConfPath], { timeout: 5000, maxBuffer: 1024 * 64 });
  await execFileAsync("/sbin/pfctl", ["-f", pfConfPath, "-F", "states"], { timeout: 5000, maxBuffer: 1024 * 64 });
  try {
    await execFileAsync("/sbin/pfctl", ["-e"], { timeout: 5000, maxBuffer: 1024 * 64 });
  } catch (error) {
    const text = simplifyError(error);
    if (!/already enabled/i.test(text)) throw error;
  }
}

export function extractManagedPfConfBlock(pfConf: unknown): string {
  const start = String(pfConf || "").indexOf(PF_CONF_BEGIN);
  const end = String(pfConf || "").indexOf(PF_CONF_END);
  if (start >= 0 && end > start) return String(pfConf).slice(start, end + PF_CONF_END.length).trim();
  return "";
}

export function extractManagedFirewallBlock(anchor: unknown): string {
  const start = String(anchor || "").indexOf(PF_ANCHOR_BEGIN);
  const end = String(anchor || "").indexOf(PF_ANCHOR_END);
  if (start >= 0 && end > start) return String(anchor).slice(start, end + PF_ANCHOR_END.length).trim();
  return "";
}

export function firewallDomainSignature(domains: unknown[] = []): string {
  return createHash("sha256").update(JSON.stringify(normalizeDomains(domains))).digest("hex");
}

function firewallResolutionHosts(domains: unknown[] = []): string[] {
  const hosts: string[] = [];
  for (const domain of normalizeDomains(domains)) {
    hosts.push(domain);
    if (!domain.startsWith("www.")) hosts.push(`www.${domain}`);
  }
  return [...new Set(hosts)];
}

function baseDomainForResolvedHost(host: unknown): string {
  return String(host || "").replace(/^www\./, "");
}

function normalizeDomains(domains: unknown[] = []): string[] {
  return [...new Set((domains || []).map((domain) => String(domain || "").trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeEntries(entries: Array<Partial<FirewallEntry>> = []): FirewallEntry[] {
  const seen = new Set<string>();
  const clean: FirewallEntry[] = [];
  for (const entry of entries || []) {
    const address = String(entry.address || "").trim();
    if (!isSafePfAddress(address) || seen.has(address)) continue;
    seen.add(address);
    clean.push({
      domain: String(entry.domain || entry.host || "").trim().toLowerCase(),
      host: String(entry.host || entry.domain || "").trim().toLowerCase(),
      address
    });
  }
  return clean.sort((a, b) => a.address.localeCompare(b.address) || a.host.localeCompare(b.host));
}

function isSafePfAddress(address: string): boolean {
  const clean = String(address || "").trim();
  if (!clean || !ADDRESS_RE.test(clean) || clean.includes("..")) return false;
  const family = isIP(clean);
  if (family === 4) return isSafePublicIpv4Address(clean);
  if (family === 6) return isSafePublicIpv6Address(clean);
  return false;
}

function isSafePublicIpv4Address(address: string): boolean {
  const octets = address.split(".").map((part) => Number(part));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c, d] = octets;
  if (a === undefined || b === undefined || c === undefined || d === undefined) return false;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a >= 224) return false;
  return true;
}

function isSafePublicIpv6Address(address: string): boolean {
  const clean = address.toLowerCase();
  const segments = parseIpv6Segments(clean);
  if (!segments) return false;
  if (segments.every((segment) => segment === 0)) return false;
  if (segments.slice(0, 7).every((segment) => segment === 0) && segments[7] === 1) return false;

  const mappedIpv4 = mappedIpv4Address(segments);
  if (mappedIpv4) return isSafePublicIpv4Address(mappedIpv4);
  if (segments.slice(0, 6).every((segment) => segment === 0)) return false;

  const first = segments[0] || 0;
  if ((first & 0xffc0) === 0xfe80) return false;
  if ((first & 0xfe00) === 0xfc00) return false;
  if ((first & 0xff00) === 0xff00) return false;
  return true;
}

function parseIpv6Segments(address: string): number[] | null {
  let normalized = address;
  const ipv4Tail = normalized.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Tail) {
    const octets = ipv4Tail[2]?.split(".").map((part) => Number(part)) || [];
    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return null;
    normalized = `${ipv4Tail[1]}${((octets[0] || 0) << 8 | (octets[1] || 0)).toString(16)}:${((octets[2] || 0) << 8 | (octets[3] || 0)).toString(16)}`;
  } else if (normalized.includes(".")) {
    return null;
  }

  const compressed = normalized.split("::");
  if (compressed.length > 2) return null;
  const left = parseIpv6Side(compressed[0] || "");
  const right = compressed.length === 2 ? parseIpv6Side(compressed[1] || "") : [];
  if (!left || !right) return null;
  if (compressed.length === 1) return left.length === 8 ? left : null;
  const missing = 8 - left.length - right.length;
  if (missing < 1) return null;
  return [...left, ...Array(missing).fill(0), ...right];
}

function parseIpv6Side(value: string): number[] | null {
  if (!value) return [];
  const parts = value.split(":");
  const segments = parts.map((part) => Number.parseInt(part, 16));
  if (
    parts.some((part) => !part || !/^[0-9a-f]{1,4}$/i.test(part)) ||
    segments.some((segment) => !Number.isInteger(segment) || segment < 0 || segment > 0xffff)
  ) return null;
  return segments;
}

function mappedIpv4Address(segments: number[]): string {
  if (segments.length !== 8) return "";
  if (!segments.slice(0, 5).every((segment) => segment === 0) || segments[5] !== 0xffff) return "";
  const high = segments[6] || 0;
  const low = segments[7] || 0;
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function hasPartialPfConfBlock(pfConf: unknown): boolean {
  const text = String(pfConf || "");
  return text.includes(PF_CONF_BEGIN) !== text.includes(PF_CONF_END);
}

function hasPartialFirewallAnchor(anchor: unknown): boolean {
  const text = String(anchor || "");
  return text.includes(PF_ANCHOR_BEGIN) !== text.includes(PF_ANCHOR_END);
}

function normalizeBlock(value: unknown): string {
  return String(value || "").trim().replace(/\r\n/g, "\n");
}

function firewallAnchorSignature(anchor: unknown): string {
  return String(anchor || "").match(/^# Domain-Signature: ([a-f0-9]+)$/m)?.[1] || "";
}

function countFirewallRules(anchor: unknown): number {
  return String(anchor || "").split(/\r?\n/).filter((line: string) => /^block return out quick to /i.test(line.trim())).length;
}

function safeComment(value: unknown): string {
  return String(value || "").replace(/[\r\n#]/g, " ").trim().slice(0, 160);
}

function simplifyError(error: unknown): string {
  const record = typeof error === "object" && error !== null ? error as UnknownRecord : {};
  return String(record.stderr || record.message || error || "").trim().split("\n").at(-1) || "";
}
