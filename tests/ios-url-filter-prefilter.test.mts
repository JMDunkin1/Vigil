import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIosUrlFilterPrefilterMatchesExactIndex,
  buildAppleUrlFilterBloom,
  buildIosUrlFilterDataset,
  decodeIosUrlFilterPrefilter,
  packageIosUrlFilterPrefilter,
  writeIosUrlFilterPrefilterAtomically
} from "../src/iosUrlFilterPrefilter.js";
import { buildPhoneBlocklistArtifact } from "../src/adultBlocklistPhoneArtifact.js";
import { defaultState } from "../src/defaults.js";
import { buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { configuredIosPhoneEdition, configuredIosPhoneProfileOptions, parseIosUrlFilterServiceConfiguration } from "../src/iosUrlFilterServiceConfiguration.js";
import { parsePlist } from "../src/plist.js";

const appleSampleDomains = [
  "example.com",
  "example2.com",
  "example3.com",
  "example4.com",
  "example5.com",
  "example6.com",
  "example7.com",
  "example8.com",
  "example9.com",
  "example10.com/resource?query=bugs"
];
const appleSampleIndex = buildPhoneBlocklistArtifact({
  domains: appleSampleDomains.slice(0, 9),
  snapshotHash: "1".repeat(64),
  generatedAt: "2026-02-04T21:21:21.000Z",
  source: { id: "apple-vector", label: "Apple vector", url: "", homepage: "", license: "sample" }
});
const appleCompatibleDataset = buildIosUrlFilterDataset({
  exactIndex: appleSampleIndex.bytes,
  murmurSeed: 624_656_550,
  falsePositiveTolerance: 0.001
});
assert.equal(appleCompatibleDataset.prefilter.metadata.bitCount, 130);
assert.equal(appleCompatibleDataset.prefilter.metadata.hashCount, 11);
assert.match(appleCompatibleDataset.pirDatabase.toString("utf8"), /keyword: "example\.com"/u);

const appleSampleBloom = buildAppleUrlFilterBloom({
  values: appleSampleDomains,
  murmurSeed: 624_656_550,
  falsePositiveTolerance: 0.001
});
assert.equal(appleSampleBloom.bitCount, 144);
assert.equal(appleSampleBloom.hashCount, 10);
assert.equal(
  appleSampleBloom.bitset.toString("hex"),
  "76b4df1fdadd4d4c61f0c33238c1dd8f4d26",
  "Vigil's generator must remain byte-compatible with Apple's published SwiftBloomFilter vector"
);

const service = parseIosUrlFilterServiceConfiguration({
  schemaVersion: 1,
  pirServerURL: "https://pir.example.test/",
  privacyPassIssuerURL: "https://issuer.example.test/",
  deploymentManifestURL: "https://pir.example.test/deployment.json",
  authenticationToken: "test-authentication-token-0001",
  hostBundleIdentifier: "tech.caseline.vigil.url-filter",
  controlProviderBundleIdentifier: "tech.caseline.vigil.url-filter.control",
  usecaseName: "tech.caseline.vigil.url-filter.url.filtering",
  prefilterFetchIntervalSeconds: 2700,
  prefilterTag: "apple-vector",
  pirDatabaseRevision: "pir-test",
  pirDatabaseSha256: "a".repeat(64),
  exactIndexSnapshotHash: "b".repeat(64)
});
const profileState = defaultState();
profileState.deviceControls.ios.enabled = true;
const profile = parsePlist(buildIosConfigurationProfile(profileState, new Date("2026-08-03T12:00:00.000Z"), { urlFilter: service })) as {
  PayloadContent?: Array<Record<string, unknown>>;
};
const plugin = profile.PayloadContent?.find((payload) => payload.FilterType === "Plugin");
assert.equal(plugin?.FilterURLs, true);
assert.equal(plugin?.PluginBundleID, "tech.caseline.vigil.url-filter");
assert.deepEqual({ ...(plugin?.URLFilterParameters as Record<string, unknown>) }, {
  PIRAuthenticationToken: "test-authentication-token-0001",
  PIRPrivacyPassIssuerURL: "https://issuer.example.test/",
  PIRServerURL: "https://pir.example.test/",
  URLFilterControlProviderBundleIdentifier: "tech.caseline.vigil.url-filter.control",
  URLFilterFailClosed: true,
  URLPrefilterFetchFrequency: 2700
});
assert.throws(() => parseIosUrlFilterServiceConfiguration({ ...service, prefilterFetchIntervalSeconds: 2699 }), /at least 2700/);

const editionDirectory = await mkdtemp(join(tmpdir(), "vigil-ios-phone-edition-"));
try {
  assert.equal(configuredIosPhoneEdition(editionDirectory), "personal");
  assert.deepEqual(configuredIosPhoneProfileOptions(editionDirectory), { edition: "personal" });
  await writeFile(join(editionDirectory, "ios-phone-edition.json"), JSON.stringify({ schemaVersion: 1, edition: "enhanced" }));
  assert.equal(configuredIosPhoneEdition(editionDirectory), "enhanced");
  assert.throws(() => configuredIosPhoneProfileOptions(editionDirectory), /required fail-closed iOS URL Filter/u);
  await mkdir(join(editionDirectory, "ios-url-filter"), { recursive: true });
  await writeFile(join(editionDirectory, "ios-url-filter", "service.json"), JSON.stringify(service));
  assert.equal(configuredIosPhoneProfileOptions(editionDirectory).urlFilter?.pirServerURL, "https://pir.example.test/");
} finally {
  await rm(editionDirectory, { recursive: true, force: true });
}

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
