import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIosUrlFilterPrefilterMatchesExactIndex,
  decodeIosUrlFilterPrefilter,
  packageIosUrlFilterPrefilter,
  writeIosUrlFilterPrefilterAtomically
} from "../src/iosUrlFilterPrefilter.js";

const snapshotHash = "a".repeat(64);
const payloadSha256 = "b".repeat(64);
const input = {
  bitset: Uint8Array.from([0b1010_0101, 0b0000_0011]),
  tag: "snapshot-a-pir-42",
  snapshotHash,
  exactIndexPayloadSha256: payloadSha256,
  exactDomainCount: 650_000,
  pirDatabaseRevision: "pir-42",
  bitCount: 10,
  hashCount: 7,
  murmurSeed: 0x1234_5678,
  generatedAt: "2026-08-01T12:00:00.000Z"
};

const artifact = packageIosUrlFilterPrefilter(input);
const decoded = decodeIosUrlFilterPrefilter(artifact.bytes);
assert.deepEqual(decoded.bitset, Buffer.from(input.bitset));
assert.equal(decoded.metadata.exactDomainCount, 650_000);
assert.equal(decoded.metadata.hashCount, 7);
assert.equal(decoded.metadata.murmurSeed, 0x1234_5678);
assertIosUrlFilterPrefilterMatchesExactIndex(decoded.metadata, {
  snapshotHash,
  payloadSha256,
  domainCount: 650_000
});

assert.throws(() => assertIosUrlFilterPrefilterMatchesExactIndex(decoded.metadata, {
  snapshotHash,
  payloadSha256,
  domainCount: 649_999
}), /does not match/);

const tampered = Buffer.from(artifact.bytes);
tampered[tampered.length - 1] ^= 0x01;
assert.throws(() => decodeIosUrlFilterPrefilter(tampered), /integrity check failed/);
assert.throws(() => packageIosUrlFilterPrefilter({ ...input, bitCount: 9 }), /padding bits/);
assert.throws(() => packageIosUrlFilterPrefilter({ ...input, hashCount: 33 }), /exceeds 32/);
assert.throws(() => packageIosUrlFilterPrefilter({ ...input, snapshotHash: "short" }), /snapshot hash is invalid/);

const directory = await mkdtemp(join(tmpdir(), "vigil-ios-url-filter-"));
try {
  const path = join(directory, "url-filter-prefilter.vuf");
  await writeIosUrlFilterPrefilterAtomically(path, artifact);
  assert.deepEqual(await readFile(path), artifact.bytes);
  assert.deepEqual(await readdir(directory), ["url-filter-prefilter.vuf"]);
} finally {
  await rm(directory, { recursive: true, force: true });
}
