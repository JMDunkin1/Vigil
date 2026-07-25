import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import {
  cleanupDownloadedPrebuiltRelease,
  cleanupOrphanedPrebuiltDownloads,
  configuredPrebuiltUpdateManifestUrl,
  downloadPrebuiltRelease
} from "../src/prebuiltReleaseDownload.js";
import type { VigilPrebuiltReleaseManifest } from "../src/prebuiltRelease.js";

const artifactBytes = Buffer.from("signed-release-dmg-fixture");
const selectedCommit = "a".repeat(40);
const manifest: VigilPrebuiltReleaseManifest = {
  kind: "vigil-macos-release-v1",
  schemaVersion: 1,
  channel: "stable",
  version: "0.2.0",
  buildVersion: "42",
  commit: selectedCommit,
  artifact: "Vigil-0.2.0-universal.dmg",
  bytes: artifactBytes.length,
  sha256: "b".repeat(64),
  appIdentifier: "tech.caseline.vigil",
  teamIdentifier: "3RY7A22U4L"
};

assert.equal(configuredPrebuiltUpdateManifestUrl({}), null);
assert.equal(
  configuredPrebuiltUpdateManifestUrl({
    VIGIL_PREBUILT_UPDATE_MANIFEST_URL: "https://updates.example.test/stable/release.json"
  }),
  "https://updates.example.test/stable/release.json"
);
for (const invalid of [
  "http://updates.example.test/release.json",
  "https://user:secret@updates.example.test/release.json",
  "https://updates.example.test/release.json#fragment"
]) {
  assert.throws(
    () => configuredPrebuiltUpdateManifestUrl({
      VIGIL_PREBUILT_UPDATE_MANIFEST_URL: invalid
    }),
    /credential-free HTTPS/u
  );
}

const storageRoot = await realpath(await mkdtemp(join(tmpdir(), "vigil-prebuilt-download-test-")));
try {
  const requested: string[] = [];
  const downloaded = await downloadPrebuiltRelease({
    manifestUrl: "https://updates.example.test/stable/release.json",
    selectedCommit,
    storageRoot,
    fetchImpl: async (input, init) => {
      const url = String(input);
      requested.push(url);
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "manual");
      if (url.endsWith("/release.json")) {
        const bytes = Buffer.from(JSON.stringify(manifest));
        return new Response(bytes, {
          status: 200,
          headers: { "content-length": String(bytes.length) }
        });
      }
      assert.equal(url, `https://updates.example.test/stable/${manifest.artifact}`);
      return new Response(artifactBytes, {
        status: 200,
        headers: { "content-length": String(artifactBytes.length) }
      });
    }
  });
  assert.deepEqual(requested, [
    "https://updates.example.test/stable/release.json",
    `https://updates.example.test/stable/${manifest.artifact}`
  ]);
  assert.deepEqual(JSON.parse(await readFile(downloaded.manifestPath, "utf8")), manifest);
  assert.deepEqual(await readFile(downloaded.artifactPath), artifactBytes);
  assert.equal((await lstat(downloaded.root)).mode & 0o777, 0o700);
  assert.equal((await lstat(downloaded.manifestPath)).mode & 0o777, 0o400);
  assert.equal((await lstat(downloaded.artifactPath)).mode & 0o777, 0o400);
  await cleanupDownloadedPrebuiltRelease(downloaded.root, storageRoot);
  assert.deepEqual(await readdir(storageRoot), []);

  await assert.rejects(
    downloadPrebuiltRelease({
      manifestUrl: "https://updates.example.test/stable/release.json",
      selectedCommit: "c".repeat(40),
      storageRoot,
      fetchImpl: async (input) => {
        const bytes = String(input).endsWith("/release.json")
          ? Buffer.from(JSON.stringify(manifest))
          : artifactBytes;
        return new Response(bytes, { status: 200 });
      }
    }),
    /not the selected upstream commit/u
  );
  assert.deepEqual(await readdir(storageRoot), [], "a rejected commit must remove its private download root");

  await assert.rejects(
    downloadPrebuiltRelease({
      manifestUrl: "https://updates.example.test/stable/release.json",
      selectedCommit,
      storageRoot,
      fetchImpl: async (input) => {
        if (String(input).endsWith("/release.json")) {
          return new Response(Buffer.from(JSON.stringify(manifest)), { status: 200 });
        }
        return new Response(Buffer.from("short"), { status: 200 });
      }
    }),
    /ended at 5 bytes; expected/u
  );
  assert.deepEqual(await readdir(storageRoot), [], "a truncated artifact must remove its private download root");

  await assert.rejects(
    downloadPrebuiltRelease({
      manifestUrl: "https://updates.example.test/stable/release.json",
      selectedCommit,
      storageRoot,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { location: "https://updates.example.test/other/release.json" }
      })
    }),
    /status 302/u
  );
  assert.deepEqual(await readdir(storageRoot), [], "a redirect must not leave private download residue");

  await assert.rejects(
    downloadPrebuiltRelease({
      manifestUrl: "https://updates.example.test/stable/release.json",
      selectedCommit,
      storageRoot,
      fetchImpl: async () => {
        const response = new Response(Buffer.from(JSON.stringify(manifest)), { status: 200 });
        Object.defineProperty(response, "url", {
          configurable: true,
          value: "https://other.example.test/stable/release.json"
        });
        return response;
      }
    }),
    /exact requested HTTPS URL/u
  );
  assert.deepEqual(await readdir(storageRoot), [], "a cross-origin response must not leave private download residue");

  await cleanupOrphanedPrebuiltDownloads(storageRoot);
} finally {
  await rm(storageRoot, { recursive: true, force: true });
}

const sourceRoot = existsSync(join(process.cwd(), "app", "updater.ts"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const [controllerSource, childSource] = await Promise.all([
  readFile(join(sourceRoot, "app", "updater.ts"), "utf8"),
  readFile(join(sourceRoot, "scripts", "update-packaged-app.mts"), "utf8")
]);
assert.ok(
  controllerSource.indexOf("await verifyAndStagePrebuiltRelease({")
    < controllerSource.indexOf('process.on("SIGUSR2", requestQuit)'),
  "the app must verify and stage the signed release before it can honor a quit request"
);
assert.match(
  controllerSource,
  /configuredPrebuiltUpdateManifestUrl\(\)[\s\S]*?if \(prebuiltManifestUrl\)[\s\S]*?downloadPrebuiltRelease\(/u,
  "a configured signed-release feed must be preferred while an absent URL preserves source rebuilding"
);
assert.match(
  controllerSource,
  /prebuiltRelease \? Promise\.resolve\(null\) : findExecutable\(repoRoot, "npm"/u,
  "a verified prebuilt release must not require npm"
);
assert.match(
  childSource,
  /if \(options\.prebuiltRelease\) \{[\s\S]*?preparePrebuiltRelease\(prebuiltCleanupRoot\)[\s\S]*?\} else \{[\s\S]*?buildInIsolatedWorktree\(\)/u,
  "the child must select the prebuilt candidate instead of invoking the source build"
);
assert.ok(
  childSource.indexOf("stagedBuild = await preparePrebuiltRelease(prebuiltCleanupRoot)")
    < childSource.indexOf('process.kill(options.parentPid, "SIGUSR2")'),
  "the detached updater must independently re-attest the staged candidate before shutdown"
);
assert.match(
  childSource,
  /async function preparePrebuiltRelease[\s\S]*?await reattestStagedPrebuiltRelease\(/u,
  "prebuilt preparation must repeat signed candidate attestation in the child"
);
assert.match(
  childSource,
  /"app\.asar\.unpacked",\s*"dist",\s*"runtime"[\s\S]*?builtRuntimePath: runtimeRealPath/u,
  "the durable runtime candidate must come from inside the verified signed app"
);
assert.match(
  childSource,
  /appPlan\.targetCdHash !== stagedBuild\.candidateCdHash/u,
  "durable staging must reproduce the exact parent-verified CodeDirectory hash"
);
