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
assert.throws(() => buildPhoneBlocklistArtifact({ ...input, snapshotHash: "short" }), /snapshot hash is invalid/);
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
