import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AdultBlocklistSourceSnapshot } from "./types.js";

const MAGIC = Buffer.from("SNTLIDX1", "ascii");
const HEADER_BYTES = MAGIC.byteLength + 4;
const MAX_DOMAIN_COUNT = 2_000_000;
export const PHONE_BLOCKLIST_BLOCK_SIZE = 64;
export const MAX_PHONE_BLOCKLIST_BYTES = 32 * 1024 * 1024;
export const PHONE_BLOCKLIST_FORMAT_VERSION = 1;

export interface PhoneBlocklistMetadata {
  formatVersion: number;
  encoding: "blocked-reversed-domain-front-coding-v1";
  blockSize: number;
  domainCount: number;
  snapshotHash: string;
  payloadSha256: string;
  payloadBytes: number;
  generatedAt: string;
  source: AdultBlocklistSourceSnapshot;
}

export interface PhoneBlocklistArtifact {
  bytes: Buffer;
  metadata: PhoneBlocklistMetadata;
}

export interface DecodedPhoneBlocklist {
  metadata: PhoneBlocklistMetadata;
  reversedDomains: string[];
}

/**
 * Builds the exact on-phone domain index. Domains are label-reversed before
 * sorting (example.com -> com.example), then front-coded against the previous
 * row. This keeps suffix lookup exact while removing repeated TLD/domain bytes.
 */
export function buildPhoneBlocklistArtifact(input: {
  domains: string[];
  snapshotHash: string;
  generatedAt: string;
  source: AdultBlocklistSourceSnapshot;
}): PhoneBlocklistArtifact {
  const domains = normalizedArtifactDomains(input.domains);
  if (!domains.length) throw new Error("Phone blocklist cannot be generated from an empty domain list.");
  if (domains.length > MAX_DOMAIN_COUNT) throw new Error(`Phone blocklist exceeds ${MAX_DOMAIN_COUNT} domains.`);

  const reversedDomains = domains.map(reverseDomainLabels).sort(compareAscii);
  const payload = encodeFrontCodedDomains(reversedDomains);
  const metadata: PhoneBlocklistMetadata = {
    formatVersion: PHONE_BLOCKLIST_FORMAT_VERSION,
    encoding: "blocked-reversed-domain-front-coding-v1",
    blockSize: PHONE_BLOCKLIST_BLOCK_SIZE,
    domainCount: reversedDomains.length,
    snapshotHash: requiredSha256(input.snapshotHash, "snapshot hash"),
    payloadSha256: sha256(payload),
    payloadBytes: payload.byteLength,
    generatedAt: normalizedIsoDate(input.generatedAt),
    source: normalizedSource(input.source)
  };
  const metadataBytes = Buffer.from(JSON.stringify(metadata), "utf8");
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(metadataBytes.byteLength, MAGIC.byteLength);
  const bytes = Buffer.concat([header, metadataBytes, payload]);
  if (bytes.byteLength > MAX_PHONE_BLOCKLIST_BYTES) {
    throw new Error(`Phone blocklist artifact exceeds ${MAX_PHONE_BLOCKLIST_BYTES} bytes.`);
  }
  return { bytes, metadata };
}

export function decodePhoneBlocklistArtifact(value: Uint8Array): DecodedPhoneBlocklist {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength > MAX_PHONE_BLOCKLIST_BYTES) throw new Error("Phone blocklist exceeds the safe size limit.");
  if (bytes.byteLength < HEADER_BYTES || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error("Phone blocklist has an invalid format signature.");
  }
  const metadataLength = bytes.readUInt32LE(MAGIC.byteLength);
  const payloadOffset = HEADER_BYTES + metadataLength;
  if (metadataLength <= 0 || payloadOffset > bytes.byteLength) throw new Error("Phone blocklist metadata is truncated.");
  let metadata: PhoneBlocklistMetadata;
  try {
    metadata = JSON.parse(bytes.subarray(HEADER_BYTES, payloadOffset).toString("utf8")) as PhoneBlocklistMetadata;
  } catch {
    throw new Error("Phone blocklist metadata is invalid.");
  }
  validateMetadata(metadata, bytes.byteLength - payloadOffset);
  const payload = bytes.subarray(payloadOffset);
  if (sha256(payload) !== metadata.payloadSha256) throw new Error("Phone blocklist payload integrity check failed.");
  const reversedDomains = decodeFrontCodedDomains(payload, metadata.domainCount);
  return { metadata, reversedDomains };
}

export function phoneBlocklistMatchesHost(index: DecodedPhoneBlocklist, value: string): string {
  const hostname = normalizeLookupHost(value);
  if (!hostname) return "";
  const labels = hostname.split(".");
  for (let offset = 0; offset < labels.length - 1; offset += 1) {
    const candidate = labels.slice(offset).join(".");
    if (binarySearch(index.reversedDomains, reverseDomainLabels(candidate))) return candidate;
  }
  return "";
}

export async function writePhoneBlocklistArtifactAtomically(path: string, artifact: PhoneBlocklistArtifact): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, artifact.bytes, { mode: 0o600 });
    await chmod(temporaryPath, 0o600).catch(() => {});
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => {});
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function encodeFrontCodedDomains(domains: string[]): Buffer {
  const chunks: Buffer[] = [];
  let previous = "";
  for (let index = 0; index < domains.length; index += 1) {
    const domain = domains[index];
    const prefixBytes = index % PHONE_BLOCKLIST_BLOCK_SIZE === 0 ? 0 : commonAsciiPrefix(previous, domain);
    const suffix = Buffer.from(domain.slice(prefixBytes), "ascii");
    if (prefixBytes > 255 || suffix.byteLength > 255) throw new Error("Phone blocklist domain is too long to encode.");
    chunks.push(Buffer.from([prefixBytes, suffix.byteLength]), suffix);
    previous = domain;
  }
  return Buffer.concat(chunks);
}

function decodeFrontCodedDomains(payload: Buffer, expectedCount: number): string[] {
  const output: string[] = [];
  let previous = "";
  let offset = 0;
  while (offset < payload.byteLength) {
    if (offset + 2 > payload.byteLength) throw new Error("Phone blocklist payload is truncated.");
    const prefixLength = payload[offset];
    const suffixLength = payload[offset + 1];
    offset += 2;
    if ((output.length % PHONE_BLOCKLIST_BLOCK_SIZE === 0 && prefixLength !== 0)
      || prefixLength > previous.length
      || offset + suffixLength > payload.byteLength) {
      throw new Error("Phone blocklist payload contains an invalid front-coded row.");
    }
    const domain = previous.slice(0, prefixLength) + payload.subarray(offset, offset + suffixLength).toString("ascii");
    if (!domain || (output.length && compareAscii(previous, domain) >= 0)) {
      throw new Error("Phone blocklist payload is not strictly sorted.");
    }
    output.push(domain);
    previous = domain;
    offset += suffixLength;
  }
  if (output.length !== expectedCount) throw new Error("Phone blocklist domain count does not match its metadata.");
  return output;
}

function normalizedArtifactDomains(values: string[]): string[] {
  const output = new Set<string>();
  for (const raw of values) {
    const domain = normalizeLookupHost(raw);
    if (!domain) throw new Error(`Invalid phone blocklist domain: ${raw}`);
    output.add(domain);
  }
  return [...output].sort(compareAscii);
}

function normalizeLookupHost(value: string): string {
  const domain = String(value || "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!domain || domain.length > 253 || !domain.includes(".") || !/^[a-z0-9.-]+$/.test(domain)) return "";
  if (domain.startsWith(".") || domain.endsWith(".") || domain.includes("..")) return "";
  if (!domain.split(".").every((label) => label.length <= 63 && !label.startsWith("-") && !label.endsWith("-"))) return "";
  return domain;
}

function reverseDomainLabels(domain: string): string {
  return domain.split(".").reverse().join(".");
}

function commonAsciiPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

function binarySearch(values: string[], target: string): boolean {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2);
    const order = compareAscii(values[middle], target);
    if (order === 0) return true;
    if (order < 0) low = middle + 1;
    else high = middle - 1;
  }
  return false;
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredSha256(value: string, label: string): string {
  const normalized = String(value || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`Phone blocklist ${label} is invalid.`);
  return normalized;
}

function normalizedIsoDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Phone blocklist generation date is invalid.");
  return parsed.toISOString();
}

function normalizedSource(source: AdultBlocklistSourceSnapshot): AdultBlocklistSourceSnapshot {
  const normalized = {
    id: String(source?.id || "").trim(),
    label: String(source?.label || "").trim(),
    url: String(source?.url || "").trim(),
    homepage: String(source?.homepage || "").trim(),
    license: String(source?.license || "").trim()
  };
  if (!normalized.id || !normalized.label || !normalized.license) throw new Error("Phone blocklist source attribution is incomplete.");
  return normalized;
}

function validateMetadata(metadata: PhoneBlocklistMetadata, actualPayloadBytes: number): void {
  if (metadata.formatVersion !== PHONE_BLOCKLIST_FORMAT_VERSION
    || metadata.encoding !== "blocked-reversed-domain-front-coding-v1"
    || metadata.blockSize !== PHONE_BLOCKLIST_BLOCK_SIZE) {
    throw new Error("Phone blocklist format version is unsupported.");
  }
  if (!Number.isInteger(metadata.domainCount) || metadata.domainCount <= 0 || metadata.domainCount > MAX_DOMAIN_COUNT) {
    throw new Error("Phone blocklist domain count is invalid.");
  }
  if (!Number.isInteger(metadata.payloadBytes) || metadata.payloadBytes < 1 || metadata.payloadBytes !== actualPayloadBytes) {
    throw new Error("Phone blocklist payload size does not match its metadata.");
  }
  requiredSha256(metadata.snapshotHash, "snapshot hash");
  requiredSha256(metadata.payloadSha256, "payload hash");
  normalizedIsoDate(metadata.generatedAt);
  normalizedSource(metadata.source);
}
