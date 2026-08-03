import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPhoneBlocklistArtifact,
  decodePhoneBlocklistArtifact,
  MAX_PHONE_BLOCKLIST_BYTES,
  phoneBlocklistMatchesHost,
  writePhoneBlocklistArtifactAtomically
} from "../src/adultBlocklistPhoneArtifact.js";

const source = {
  id: "test-source",
  label: "Test source",
  url: "https://example.test/adult-domains.txt",
  homepage: "https://example.test/",
  license: "GPL-3.0"
};
const snapshotHash = "a".repeat(64);
const input = {
  domains: [
    "example.com",
    "nested.example.com",
    "explicit.example.net",
    ...Array.from({ length: 140 }, (_, index) => `media-${String(index).padStart(3, "0")}.example.org`)
  ],
  sourceDomainCount: 200,
  snapshotHash,
  generatedAt: "2026-07-12T12:00:00.000Z",
  source
};

const first = buildPhoneBlocklistArtifact(input);
const second = buildPhoneBlocklistArtifact({ ...input, domains: [...input.domains].reverse() });
assert.deepEqual(first.bytes, second.bytes, "artifact generation must be reproducible regardless of input order");
assert.equal(first.bytes.byteLength < Buffer.byteLength(input.domains.join("\n")), true, "front coding should compact representative lists");
assert.equal(first.bytes.byteLength < MAX_PHONE_BLOCKLIST_BYTES, true);
assert.equal(first.metadata.source.license, "GPL-3.0");
assert.equal(first.metadata.source.homepage, source.homepage);
assert.equal(first.metadata.snapshotHash, snapshotHash);
assert.equal(first.metadata.blockSize, 64);
assert.equal(first.metadata.formatVersion, 2);
assert.equal(first.metadata.encoding, "blocked-reversed-domain-front-coding-v2");
assert.equal(first.metadata.sourceDomainCount, 200);
assert.equal(first.metadata.indexBytes, Math.ceil(input.domains.length / 64) * 4);

const decoded = decodePhoneBlocklistArtifact(first.bytes);
assert.equal(decoded.reversedDomains.length, input.domains.length);
assert.equal(phoneBlocklistMatchesHost(decoded, "example.com"), "example.com");
assert.equal(phoneBlocklistMatchesHost(decoded, "cdn.example.com"), "example.com");
assert.equal(phoneBlocklistMatchesHost(decoded, "child.nested.example.com"), "nested.example.com");
assert.equal(phoneBlocklistMatchesHost(decoded, "allowed.example.edu"), "");
assert.equal(phoneBlocklistMatchesHost(decoded, "notexample.com"), "");

const tampered = Buffer.from(first.bytes);
tampered[tampered.length - 1] ^= 0xff;
assert.throws(() => decodePhoneBlocklistArtifact(tampered), /integrity check failed/);
const metadataLength = first.bytes.readUInt32LE(8);
const indexOffset = 12 + metadataLength;
const tamperedIndex = Buffer.from(first.bytes);
tamperedIndex[indexOffset] ^= 0xff;
assert.throws(() => decodePhoneBlocklistArtifact(tamperedIndex), /sparse index integrity check failed/);

const v2Metadata = JSON.parse(first.bytes.subarray(12, indexOffset).toString("utf8")) as Record<string, unknown>;
const payloadOffset = indexOffset + Number(v2Metadata.indexBytes);
const v1Metadata: Record<string, unknown> = {
  ...v2Metadata,
  formatVersion: 1,
  encoding: "blocked-reversed-domain-front-coding-v1"
};
delete v1Metadata.indexBytes;
delete v1Metadata.indexSha256;
const v1MetadataBytes = Buffer.from(JSON.stringify(v1Metadata), "utf8");
const v1Header = Buffer.alloc(12);
first.bytes.subarray(0, 8).copy(v1Header);
v1Header.writeUInt32LE(v1MetadataBytes.byteLength, 8);
const v1Artifact = Buffer.concat([v1Header, v1MetadataBytes, first.bytes.subarray(payloadOffset)]);
assert.equal(decodePhoneBlocklistArtifact(v1Artifact).metadata.formatVersion, 1, "v1 artifacts remain readable during rollout");
assert.throws(() => buildPhoneBlocklistArtifact({ ...input, snapshotHash: "short" }), /snapshot hash is invalid/);
assert.throws(() => buildPhoneBlocklistArtifact({ ...input, sourceDomainCount: input.domains.length - 1 }), /source domain count is invalid/);
assert.throws(() => buildPhoneBlocklistArtifact({ ...input, source: { ...source, license: "" } }), /attribution is incomplete/);

const directory = await mkdtemp(join(tmpdir(), "vigil-phone-blocklist-"));
try {
  const path = join(directory, "adult-blocklist.sdi");
  await writePhoneBlocklistArtifactAtomically(path, first);
  assert.deepEqual(await readFile(path), first.bytes);
  assert.deepEqual(await readdir(directory), ["adult-blocklist.sdi"], "atomic generation must not leave temporary files");
} finally {
  await rm(directory, { recursive: true, force: true });
}
