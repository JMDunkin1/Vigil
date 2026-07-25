import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  compareMacBuildVersions,
  parsePrebuiltReleaseManifest,
  releaseCodeIdentitiesExactlyMatch,
  releaseSignatureIdentitiesMatch,
  verifyAndStagePrebuiltRelease
} from "../src/prebuiltRelease.js";
import type {
  CodeSignatureIdentity,
  VigilPrebuiltReleaseManifest
} from "../src/prebuiltRelease.js";

const sourceRoot = existsSync(join(process.cwd(), "src", "prebuiltRelease.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");

const manifest: VigilPrebuiltReleaseManifest = {
  kind: "vigil-macos-release-v1",
  schemaVersion: 1,
  channel: "stable",
  version: "0.2.0",
  buildVersion: "42",
  commit: "a".repeat(40),
  artifact: "Vigil-0.2.0-universal.dmg",
  bytes: 123_456,
  sha256: "b".repeat(64),
  appIdentifier: "tech.caseline.vigil",
  teamIdentifier: "3RY7A22U4L"
};
assert.deepEqual(parsePrebuiltReleaseManifest(JSON.stringify(manifest)), manifest);

for (const invalid of [
  { ...manifest, kind: "checksum-sidecar" },
  { ...manifest, schemaVersion: 2 },
  { ...manifest, channel: "nightly" },
  { ...manifest, artifact: "../Vigil.dmg" },
  { ...manifest, artifact: "Other-0.2.0-universal.dmg" },
  { ...manifest, bytes: 0 },
  { ...manifest, sha256: "short" },
  { ...manifest, commit: "not-a-commit" },
  { ...manifest, appIdentifier: "com.example.other" },
  { ...manifest, teamIdentifier: "" }
]) {
  assert.throws(
    () => parsePrebuiltReleaseManifest(JSON.stringify(invalid)),
    /unsupported or malformed field/u
  );
}
assert.throws(() => parsePrebuiltReleaseManifest("{"), /not valid JSON/u);

assert.equal(compareMacBuildVersions("42", "41.99.99"), 1);
assert.equal(compareMacBuildVersions("42.1", "42.0.99"), 1);
assert.equal(compareMacBuildVersions("42.1", "42.1.0"), 0);
assert.equal(compareMacBuildVersions("42.0.1", "42.1"), -1);
assert.throws(() => compareMacBuildVersions("0", "1"), /malformed macOS build versions/u);

const installed: CodeSignatureIdentity = {
  authorities: [
    "Developer ID Application: Vigil Publisher (3RY7A22U4L)",
    "Developer ID Certification Authority",
    "Apple Root CA"
  ],
  cdHash: "c".repeat(40),
  designatedRequirement: "identifier tech.caseline.vigil and anchor apple generic and certificate leaf[subject.OU] = 3RY7A22U4L",
  identifier: "tech.caseline.vigil",
  teamIdentifier: "3RY7A22U4L"
};
const candidate: CodeSignatureIdentity = {
  ...installed,
  cdHash: "d".repeat(40)
};
assert.equal(releaseSignatureIdentitiesMatch(installed, candidate), true);
assert.equal(releaseCodeIdentitiesExactlyMatch(candidate, { ...candidate }), true);
for (const changed of [
  { ...candidate, cdHash: "e".repeat(40) },
  { ...candidate, identifier: "com.example.other" },
  { ...candidate, teamIdentifier: "AAAAAAAAAA" },
  { ...candidate, designatedRequirement: "different requirement" },
  { ...candidate, authorities: [...candidate.authorities].reverse() }
]) {
  assert.equal(releaseCodeIdentitiesExactlyMatch(candidate, changed), false);
}
for (const changed of [
  { ...candidate, identifier: "com.example.other" },
  { ...candidate, teamIdentifier: "AAAAAAAAAA" },
  { ...candidate, designatedRequirement: "different requirement" },
  { ...candidate, authorities: ["Developer ID Application: Impostor (3RY7A22U4L)"] }
]) {
  assert.equal(releaseSignatureIdentitiesMatch(installed, changed), false);
}
assert.equal(
  releaseSignatureIdentitiesMatch(
    { ...installed, authorities: ["Apple Development: Vigil"] },
    candidate
  ),
  false,
  "automatic prebuilt replacement must start from an already distribution-signed trust identity"
);

const cleanupTestRoot = await realpath(await mkdtemp(join(tmpdir(), "vigil-prebuilt-cleanup-test-")));
try {
  const installedAppPath = join(cleanupTestRoot, "installed", "Vigil.app");
  const stagingRoot = join(cleanupTestRoot, "staging");
  const artifactPath = join(cleanupTestRoot, manifest.artifact);
  const manifestPath = join(cleanupTestRoot, "release-checksums.json");
  const artifactBytes = Buffer.from("not-a-real-dmg");
  await Promise.all([
    mkdir(installedAppPath, { recursive: true }),
    mkdir(stagingRoot, { recursive: true }),
    writeFile(artifactPath, artifactBytes),
    writeFile(manifestPath, JSON.stringify({
      ...manifest,
      bytes: artifactBytes.length,
      sha256: "0".repeat(64)
    }))
  ]);
  await assert.rejects(
    verifyAndStagePrebuiltRelease({ artifactPath, installedAppPath, manifestPath, stagingRoot }),
    /DMG SHA-256 failed verification/u
  );
  assert.deepEqual(
    await readdir(stagingRoot),
    [],
    "a pre-tool verification failure must remove its private artifact snapshot"
  );
} finally {
  await rm(cleanupTestRoot, { recursive: true, force: true });
}

const verifierSource = await readFile(join(sourceRoot, "src", "prebuiltRelease.ts"), "utf8");
assert.match(verifierSource, /constants\.O_RDONLY \| constants\.O_NOFOLLOW/u);
assert.match(verifierSource, /while \(offset < before\.size\)[\s\S]*?handle\.read\(/u, "large DMGs must be hashed from a pinned file descriptor");
assert.match(verifierSource, /writeAll\(destination, chunk, offset, label\)/u, "the verified artifact snapshot must be copied from the pinned descriptor");
assert.match(verifierSource, /\[\s*"attach",\s*"-readonly",\s*"-nobrowse"/u);
assert.match(verifierSource, /\["--verify", "--deep", "--strict", "--verbose=2", appPath\]/u);
assert.match(verifierSource, /\["--assess", "--type", "execute", "--verbose=2", mountedAppPath\]/u);
assert.match(verifierSource, /\["stapler", "validate", mountedAppPath\]/u);
assert.match(verifierSource, /\["--assess", "--type", "execute", "--verbose=2", stagedAppPath\]/u);
assert.match(verifierSource, /\["stapler", "validate", stagedAppPath\]/u);
assert.match(verifierSource, /compareMacBuildVersions\(candidateBuild, installedBuild\) <= 0/u);
assert.match(
  verifierSource,
  /const \[candidateIdentifier, candidateVersion, candidateBuild, installedBuild, buildInfo\] = await Promise\.all\(\[\s*plistValue\([^]*?"CFBundleIdentifier"\),\s*plistValue\([^]*?"CFBundleShortVersionString"\),\s*plistValue\([^]*?"CFBundleVersion"\),\s*plistValue\(join\(installedAppPath,[^]*?"CFBundleVersion"\),\s*readPackagedBuildInfo\(candidateAppPath\)\s*\]\);/u,
  "release metadata must preserve the exact five-value identifier/version/build/installed-build/build-info order"
);
assert.ok(
  verifierSource.indexOf('"--type", "open"')
    < verifierSource.indexOf('"/usr/bin/hdiutil", [\n      "attach"'),
  "the DMG must pass Gatekeeper before hdiutil mounts it"
);
assert.ok(
  verifierSource.indexOf("assertReleaseSignerContinuity(installedIdentity, mountedIdentity, manifest)")
    < verifierSource.indexOf('run("/usr/bin/ditto"'),
  "the mounted app must pass signer continuity before it is copied into staging"
);
assert.ok(
  verifierSource.lastIndexOf("releaseCodeIdentitiesExactlyMatch(mountedIdentity, stagedIdentity)")
    > verifierSource.indexOf('run("/usr/bin/ditto"'),
  "the copied app must be an exact code-identity match after staging"
);
assert.match(verifierSource, /cleanupVerificationResources\(/u);
assert.match(verifierSource, /removeStage: primaryError !== undefined/u);
assert.match(verifierSource, /preservePrimaryError\(primaryError, cleanupErrors\)/u);

const releaseSource = await readFile(join(sourceRoot, "scripts", "release-mac.mjs"), "utf8");
assert.match(releaseSource, /kind: "vigil-macos-release-v1"/u);
assert.match(releaseSource, /schemaVersion: 1/u);
assert.match(releaseSource, /commit: releaseCommit/u);
assert.match(releaseSource, /teamIdentifier: releaseTeamIdentifier/u);
assert.match(releaseSource, /const outputDir = await realpath\(join\(process\.cwd\(\), "dist", "mac\.noindex"\)\)/u);
assert.match(releaseSource, /hashPinnedRegularFile\(dmgPath, "release DMG"\)/u);
assert.doesNotMatch(
  releaseSource,
  /createHash\("sha256"\)\.update\(await readFile\(dmgPath\)\)/u,
  "release DMGs must never be loaded wholesale for hashing"
);
assert.ok(
  releaseSource.indexOf('"--type", "open"')
    < releaseSource.indexOf('run("hdiutil", ["attach"'),
  "the producer must assess the DMG before mounting it"
);
assert.match(releaseSource, /verifyReleaseAppManifest\(appPath, releaseManifest\)/u);
for (const field of [
  "CFBundleIdentifier",
  "CFBundleShortVersionString",
  "CFBundleVersion",
  "signedIdentifier",
  "signedTeam",
  "buildInfo.commit",
  "buildInfo.dirty"
]) {
  assert.ok(releaseSource.includes(field), `the producer must verify ${field} against the manifest`);
}
assert.match(releaseSource, /cleanupReleaseMount\(\{ attachAttempted, mountRoot \}\)/u);
assert.match(releaseSource, /preservePrimaryError\(releaseVerificationError, releaseCleanupErrors\)/u);
