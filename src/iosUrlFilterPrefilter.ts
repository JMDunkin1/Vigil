import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodePhoneBlocklistArtifact } from "./adultBlocklistPhoneArtifact.js";

const MAGIC = Buffer.from("VIGILUF1", "ascii");
const HEADER_BYTES = MAGIC.byteLength + 4;
const MAX_METADATA_BYTES = 64 * 1024;
export const IOS_URL_FILTER_PREFILTER_FORMAT_VERSION = 1;
export const MAX_IOS_URL_FILTER_PREFILTER_BYTES = 32 * 1024 * 1024;

export interface IosUrlFilterPrefilterMetadata {
  formatVersion: 1;
  encoding: "apple-neurlfilter-prefilter-bloom-v1";
  tag: string;
  snapshotHash: string;
  exactIndexPayloadSha256: string;
  exactDomainCount: number;
  pirDatabaseRevision: string;
  bitCount: number;
  hashCount: number;
  murmurSeed: number;
  bitsetSha256: string;
  bitsetBytes: number;
  generatedAt: string;
}

export interface IosUrlFilterPrefilterArtifact {
  bytes: Buffer;
  metadata: IosUrlFilterPrefilterMetadata;
}

export interface DecodedIosUrlFilterPrefilter {
  metadata: IosUrlFilterPrefilterMetadata;
  bitset: Buffer;
}

export interface IosUrlFilterDataset {
  prefilter: IosUrlFilterPrefilterArtifact;
  pirDatabase: Buffer;
  domainCount: number;
  pirDatabaseSha256: string;
}

export const IOS_URL_FILTER_DEFAULT_FALSE_POSITIVE_TOLERANCE = 0.001;

export function buildAppleUrlFilterBloom(input: {
  values: readonly string[];
  falsePositiveTolerance?: number;
  murmurSeed: number;
}): { bitset: Buffer; bitCount: number; hashCount: number; murmurSeed: number } {
  if (!input.values.length) throw new Error("iOS URL Filter Bloom input cannot be empty.");
  const tolerance = input.falsePositiveTolerance ?? IOS_URL_FILTER_DEFAULT_FALSE_POSITIVE_TOLERANCE;
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance >= 1) {
    throw new Error("iOS URL Filter false-positive tolerance must be greater than zero and less than one.");
  }
  const bitCount = Math.ceil(-(input.values.length * Math.log(tolerance)) / Math.pow(Math.LN2, 2));
  if (!Number.isSafeInteger(bitCount) || bitCount < 1 || bitCount > 0xffff_ffff) {
    throw new Error("iOS URL Filter Bloom bit count is outside Apple's UInt32 format.");
  }
  const hashCount = Math.ceil((bitCount / input.values.length) * Math.LN2);
  if (!Number.isSafeInteger(hashCount) || hashCount < 1 || hashCount > 32) {
    throw new Error("iOS URL Filter Bloom hash count is outside the supported range.");
  }
  const murmurSeed = requiredUInt32(input.murmurSeed, "Murmur seed");
  const bitset = Buffer.alloc(Math.ceil(bitCount / 8));
  for (const item of input.values) {
    const value = Buffer.from(item, "utf8");
    const fnv = fnv1a32(value);
    const murmur = murmur3a32(value, murmurSeed);
    for (let index = 0; index < hashCount; index += 1) {
      const bit = ((fnv + Math.imul(index, murmur)) >>> 0) % bitCount;
      bitset[bit >>> 3] |= 1 << (bit & 7);
    }
  }
  return { bitset, bitCount, hashCount, murmurSeed };
}

/**
 * Generates Apple's URL Filter Bloom prefilter and PIR text-protobuf database
 * from the same integrity-checked exact phone index.
 *
 * The hashing and sizing rules intentionally match Apple's published
 * SwiftBloomFilter sample. Generating both outputs in one operation prevents a
 * stale PIR database from being paired with a newer on-device prefilter.
 */
export function buildIosUrlFilterDataset(input: {
  exactIndex: Uint8Array;
  falsePositiveTolerance?: number;
  murmurSeed?: number;
  generatedAt?: string;
}): IosUrlFilterDataset {
  const exactIndex = decodePhoneBlocklistArtifact(input.exactIndex);
  const domains = exactIndex.reversedDomains.map(reverseDomainLabels);
  const murmurSeed = input.murmurSeed ?? Number.parseInt(exactIndex.metadata.snapshotHash.slice(0, 8), 16);
  const bloom = buildAppleUrlFilterBloom({
    values: domains,
    falsePositiveTolerance: input.falsePositiveTolerance,
    murmurSeed
  });
  const pirRows: string[] = [];
  pirRows.length = domains.length;

  for (let row = 0; row < domains.length; row += 1) {
    const domain = domains[row];
    pirRows[row] = `rows {\n  keyword: ${JSON.stringify(domain)}\n  value: "1"\n}\n`;
  }

  const pirDatabase = Buffer.from(pirRows.join(""), "utf8");
  const pirDatabaseSha256 = sha256(pirDatabase);
  const revision = `vigil-${exactIndex.metadata.snapshotHash.slice(0, 16)}`;
  const prefilter = packageIosUrlFilterPrefilter({
    bitset: bloom.bitset,
    tag: `${revision}-${pirDatabaseSha256.slice(0, 16)}`,
    snapshotHash: exactIndex.metadata.snapshotHash,
    exactIndexPayloadSha256: exactIndex.metadata.payloadSha256,
    exactDomainCount: exactIndex.metadata.domainCount,
    pirDatabaseRevision: revision,
    bitCount: bloom.bitCount,
    hashCount: bloom.hashCount,
    murmurSeed: bloom.murmurSeed,
    generatedAt: input.generatedAt ?? exactIndex.metadata.generatedAt
  });
  return { prefilter, pirDatabase, domainCount: domains.length, pirDatabaseSha256 };
}

/**
 * Packages an Apple-compatible Bloom bitset with the metadata Vigil needs to
 * prove that it matches the exact phone index and PIR database revision.
 */
export function packageIosUrlFilterPrefilter(input: {
  bitset: Uint8Array;
  tag: string;
  snapshotHash: string;
  exactIndexPayloadSha256: string;
  exactDomainCount: number;
  pirDatabaseRevision: string;
  bitCount: number;
  hashCount: number;
  murmurSeed: number;
  generatedAt: string;
}): IosUrlFilterPrefilterArtifact {
  const bitset = Buffer.from(input.bitset.buffer, input.bitset.byteOffset, input.bitset.byteLength);
  const metadata: IosUrlFilterPrefilterMetadata = {
    formatVersion: IOS_URL_FILTER_PREFILTER_FORMAT_VERSION,
    encoding: "apple-neurlfilter-prefilter-bloom-v1",
    tag: normalizedIdentifier(input.tag, "tag"),
    snapshotHash: requiredSha256(input.snapshotHash, "snapshot hash"),
    exactIndexPayloadSha256: requiredSha256(input.exactIndexPayloadSha256, "exact-index payload hash"),
    exactDomainCount: requiredPositiveInteger(input.exactDomainCount, "exact domain count"),
    pirDatabaseRevision: normalizedIdentifier(input.pirDatabaseRevision, "PIR database revision"),
    bitCount: requiredPositiveInteger(input.bitCount, "bit count"),
    hashCount: requiredPositiveInteger(input.hashCount, "hash count"),
    murmurSeed: requiredUInt32(input.murmurSeed, "Murmur seed"),
    bitsetSha256: sha256(bitset),
    bitsetBytes: bitset.byteLength,
    generatedAt: normalizedIsoDate(input.generatedAt)
  };
  validateMetadata(metadata, bitset.byteLength);
  validatePaddingBits(bitset, metadata.bitCount);

  const metadataBytes = Buffer.from(JSON.stringify(metadata), "utf8");
  if (metadataBytes.byteLength > MAX_METADATA_BYTES) throw new Error("iOS URL Filter prefilter metadata is too large.");
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header.writeUInt32LE(metadataBytes.byteLength, MAGIC.byteLength);
  const bytes = Buffer.concat([header, metadataBytes, bitset]);
  if (bytes.byteLength > MAX_IOS_URL_FILTER_PREFILTER_BYTES) {
    throw new Error(`iOS URL Filter prefilter exceeds ${MAX_IOS_URL_FILTER_PREFILTER_BYTES} bytes.`);
  }
  return { bytes, metadata };
}

export function decodeIosUrlFilterPrefilter(value: Uint8Array): DecodedIosUrlFilterPrefilter {
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength > MAX_IOS_URL_FILTER_PREFILTER_BYTES) {
    throw new Error("iOS URL Filter prefilter exceeds the safe size limit.");
  }
  if (bytes.byteLength < HEADER_BYTES || !bytes.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
    throw new Error("iOS URL Filter prefilter has an invalid format signature.");
  }
  const metadataLength = bytes.readUInt32LE(MAGIC.byteLength);
  const bitsetOffset = HEADER_BYTES + metadataLength;
  if (metadataLength < 1 || metadataLength > MAX_METADATA_BYTES || bitsetOffset > bytes.byteLength) {
    throw new Error("iOS URL Filter prefilter metadata is truncated.");
  }
  let metadata: IosUrlFilterPrefilterMetadata;
  try {
    metadata = JSON.parse(bytes.subarray(HEADER_BYTES, bitsetOffset).toString("utf8")) as IosUrlFilterPrefilterMetadata;
  } catch {
    throw new Error("iOS URL Filter prefilter metadata is invalid.");
  }
  const bitset = bytes.subarray(bitsetOffset);
  validateMetadata(metadata, bitset.byteLength);
  if (sha256(bitset) !== metadata.bitsetSha256) {
    throw new Error("iOS URL Filter prefilter bitset integrity check failed.");
  }
  validatePaddingBits(bitset, metadata.bitCount);
  return { metadata, bitset };
}

export function assertIosUrlFilterPrefilterMatchesExactIndex(
  prefilter: IosUrlFilterPrefilterMetadata,
  exactIndex: { snapshotHash: string; payloadSha256: string; domainCount: number }
): void {
  if (prefilter.snapshotHash !== exactIndex.snapshotHash.toLowerCase()
    || prefilter.exactIndexPayloadSha256 !== exactIndex.payloadSha256.toLowerCase()
    || prefilter.exactDomainCount !== exactIndex.domainCount) {
    throw new Error("iOS URL Filter prefilter does not match the exact phone blocklist artifact.");
  }
}

export async function writeIosUrlFilterPrefilterAtomically(
  path: string,
  artifact: IosUrlFilterPrefilterArtifact
): Promise<void> {
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

function validateMetadata(metadata: IosUrlFilterPrefilterMetadata, actualBitsetBytes: number): void {
  if (metadata.formatVersion !== IOS_URL_FILTER_PREFILTER_FORMAT_VERSION
    || metadata.encoding !== "apple-neurlfilter-prefilter-bloom-v1") {
    throw new Error("iOS URL Filter prefilter format version is unsupported.");
  }
  normalizedIdentifier(metadata.tag, "tag");
  requiredSha256(metadata.snapshotHash, "snapshot hash");
  requiredSha256(metadata.exactIndexPayloadSha256, "exact-index payload hash");
  requiredPositiveInteger(metadata.exactDomainCount, "exact domain count");
  normalizedIdentifier(metadata.pirDatabaseRevision, "PIR database revision");
  const bitCount = requiredPositiveInteger(metadata.bitCount, "bit count");
  const hashCount = requiredPositiveInteger(metadata.hashCount, "hash count");
  if (hashCount > 32) throw new Error("iOS URL Filter prefilter hash count exceeds 32.");
  requiredUInt32(metadata.murmurSeed, "Murmur seed");
  requiredSha256(metadata.bitsetSha256, "bitset hash");
  if (!Number.isInteger(metadata.bitsetBytes)
    || metadata.bitsetBytes !== actualBitsetBytes
    || metadata.bitsetBytes !== Math.ceil(bitCount / 8)) {
    throw new Error("iOS URL Filter prefilter bitset size does not match its metadata.");
  }
  normalizedIsoDate(metadata.generatedAt);
}

function validatePaddingBits(bitset: Uint8Array, bitCount: number): void {
  const usedBits = bitCount % 8;
  if (!usedBits || !bitset.length) return;
  const unusedMask = 0xff << usedBits;
  if ((bitset[bitset.length - 1] & unusedMask) !== 0) {
    throw new Error("iOS URL Filter prefilter has non-zero padding bits.");
  }
}

function normalizedIdentifier(value: string, label: string): string {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    throw new Error(`iOS URL Filter prefilter ${label} is invalid.`);
  }
  return normalized;
}

function requiredSha256(value: string, label: string): string {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`iOS URL Filter prefilter ${label} is invalid.`);
  }
  return normalized;
}

function requiredPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`iOS URL Filter prefilter ${label} is invalid.`);
  }
  return value;
}

function requiredUInt32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`iOS URL Filter prefilter ${label} is invalid.`);
  }
  return value;
}

function normalizedIsoDate(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("iOS URL Filter prefilter generation date is invalid.");
  return parsed.toISOString();
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function reverseDomainLabels(value: string): string {
  return value.split(".").reverse().join(".");
}

function fnv1a32(value: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of value) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash;
}

function murmur3a32(value: Uint8Array, seed: number): number {
  let hash = seed >>> 0;
  const blockBytes = value.byteLength - (value.byteLength % 4);
  for (let offset = 0; offset < blockBytes; offset += 4) {
    let block = (value[offset]
      | (value[offset + 1] << 8)
      | (value[offset + 2] << 16)
      | (value[offset + 3] << 24)) >>> 0;
    block = Math.imul(block, 0xcc9e2d51) >>> 0;
    block = rotateLeft32(block, 15);
    block = Math.imul(block, 0x1b873593) >>> 0;
    hash ^= block;
    hash = rotateLeft32(hash, 13);
    hash = (Math.imul(hash, 5) + 0xe6546b64) >>> 0;
  }

  let tail = 0;
  const remainingBytes = value.byteLength - blockBytes;
  if (remainingBytes >= 3) tail ^= value[blockBytes + 2] << 16;
  if (remainingBytes >= 2) tail ^= value[blockBytes + 1] << 8;
  if (remainingBytes >= 1) {
    tail ^= value[blockBytes];
    tail = Math.imul(tail, 0xcc9e2d51) >>> 0;
    tail = rotateLeft32(tail, 15);
    tail = Math.imul(tail, 0x1b873593) >>> 0;
    hash ^= tail;
  }

  hash ^= value.byteLength;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}
