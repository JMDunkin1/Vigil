import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { parsePlist } from "../src/plist.js";
import { CHATGPT_POLICY_DOMAIN, CHROME_WEB_STORE_UPDATE_URL, compareExtensionVersions, managedChatgptProfile, prepareExtensionRecovery, prepareExtensionRelease, verifyExtensionRelease } from "../src/managedChatgptExtension.js";
import type { ManagedClientRehearsal } from "../src/managedChatgptExtension.js";

interface PolicyProfile {
  PayloadRemovalDisallowed: boolean;
  PayloadContent: [{ PayloadContent: Record<string, { Forced: [{ mcx_preference_settings: {
    ExtensionSettings: Record<string, {
      installation_mode: string; update_url: string; override_update_url: boolean; minimum_version_required?: string;
    }>;
  } }] }> }];
}

const root = await mkdtemp(join(tmpdir(), "vigil-managed-companion-"));
try {
  const source = join(root, "source");
  await mkdir(source);
  const original = JSON.parse(await readFile(join(process.cwd(), "extension", "manifest.json"), "utf8"));
  const manifest = { manifest_version: 3, name: "Vigil Companion", version: "0.3.14", key: original.key,
    background: { service_worker: "background.js" }, content_scripts: [{ matches: ["http://*/*", "https://*/*"], js: ["content.js"] }],
    declarative_net_request: { rule_resources: [{ id: "permanent", enabled: true, path: "rules.json" }] } };
  await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(source, "background.js"), "// Working worker\n");
  await writeFile(join(source, "content.js"), "// Working filter\n");
  await writeFile(join(source, "rules.json"), "[]\n");
  await mkdir(join(source, "_metadata"));
  await writeFile(join(source, "_metadata", "ignored.json"), "{}\n");
  const baselineDirectory = join(root, "baseline");
  const baseline = await prepareExtensionRelease(source, baselineDirectory);
  assert.equal(baseline.kind, "unsigned-store-upload", "a ZIP must never claim to be a signed installable CRX");
  assert.deepEqual(await verifyExtensionRelease(baselineDirectory), baseline);
  assert.equal(baseline.files.some(file => file.path.includes("_metadata")), false);
  await assert.rejects(prepareExtensionRelease(source, baselineDirectory), /already exists/);
  await assert.rejects(prepareExtensionRelease(source, join(source, "nested")), /outside/);
  const recovery = await prepareExtensionRecovery(baselineDirectory, join(root, "repair"), "0.3.16", "0.3.15");
  assert.equal(recovery.extensionId, baseline.extensionId);
  assert.equal(recovery.recoveryOf, baseline.payloadSha256);
  assert.equal(recovery.contentSha256, baseline.contentSha256, "repair must preserve code and manifest permissions");
  assert.notEqual(recovery.payloadSha256, baseline.payloadSha256, "the repair carries a new version");
  await assert.rejects(prepareExtensionRecovery(baselineDirectory, join(root, "downgrade"), "0.3.15", "0.3.15"), /higher than every deployed/);
  for (const version of ["0", "0.0.0", "01.2", "1.65536", "1.2.3.4.5", "1.2-beta"]) {
    assert.throws(() => compareExtensionVersions(version, "1"), /Invalid Chromium/);
  }
  assert.equal(compareExtensionVersions("1.2", "1.2.0.0"), 0);
  assert.equal(compareExtensionVersions("0.3.100", "0.3.99"), 1);
  const publication = { extensionId: BUILT_IN_CHROME_EXTENSION_ID, published: true, publishedVersion: baseline.version };
  assert.throws(() => managedChatgptProfile(baseline, { ...publication, published: false }, { locked: false }), /not recorded as published/);
  assert.throws(() => managedChatgptProfile(baseline, { ...publication, publishedVersion: "0.3.13" }, { locked: false }), /not recorded as published/);
  const trial = parsePlist(managedChatgptProfile(baseline, publication, { locked: false })) as unknown as PolicyProfile;
  const trialSettings = trial.PayloadContent[0].PayloadContent[CHATGPT_POLICY_DOMAIN].Forced[0].mcx_preference_settings.ExtensionSettings;
  assert.deepEqual(Object.keys(trialSettings), [BUILT_IN_CHROME_EXTENSION_ID], "no global extension or browser restrictions");
  assert.equal(trialSettings[BUILT_IN_CHROME_EXTENSION_ID].installation_mode, "normal_installed");
  assert.equal(trialSettings[BUILT_IN_CHROME_EXTENSION_ID].update_url, CHROME_WEB_STORE_UPDATE_URL);
  assert.equal(trialSettings[BUILT_IN_CHROME_EXTENSION_ID].override_update_url, true);
  assert.equal(trialSettings[BUILT_IN_CHROME_EXTENSION_ID].minimum_version_required, undefined, "version floors must not obstruct recovery");
  assert.equal(trial.PayloadRemovalDisallowed, false);
  assert.throws(() => managedChatgptProfile(baseline, publication, { locked: true }), /actual ChatGPT update and recovery/);
  const now = new Date("2026-10-08T21:15:00Z");
  const rehearsal: ManagedClientRehearsal = {
    clientBundleId: CHATGPT_POLICY_DOMAIN, clientVersion: "test-client", nativeRequiredExtensionVersion: "0.3.15", testedAt: now.toISOString(), extensionId: baseline.extensionId,
    update: { fromVersion: baseline.version, toVersion: baseline.version, payloadSha256: baseline.payloadSha256, passed: true },
    recovery: { fromVersion: baseline.version, fromContentSha256: baseline.contentSha256,
      restoredContentSha256: baseline.contentSha256, deliveredVersion: "0.3.16", passed: true }
  };
  // A real update must change versions, so use a separately packaged candidate.
  const candidate = await prepareExtensionRelease(source, join(root, "candidate"), { version: "0.3.15" });
  rehearsal.update.toVersion = candidate.version;
  rehearsal.update.payloadSha256 = candidate.payloadSha256;
  rehearsal.recovery.fromVersion = candidate.version;
  rehearsal.recovery.fromContentSha256 = candidate.contentSha256;
  const candidatePublication = { ...publication, publishedVersion: candidate.version };
  const options = { locked: true, workingRelease: baseline, rehearsal, currentClientVersion: "test-client", currentNativeRequiredExtensionVersion: "0.3.15", now };
  const locked = parsePlist(managedChatgptProfile(candidate, candidatePublication, options)) as unknown as PolicyProfile;
  assert.equal(locked.PayloadRemovalDisallowed, true);
  assert.equal(locked.PayloadContent[0].PayloadContent[CHATGPT_POLICY_DOMAIN].Forced[0].mcx_preference_settings.ExtensionSettings[baseline.extensionId].installation_mode, "force_installed");
  for (const broken of [
    { ...rehearsal, clientVersion: "old-client" },
    { ...rehearsal, nativeRequiredExtensionVersion: "0.3.13" },
    { ...rehearsal, testedAt: "2026-10-06T21:15:00Z" },
    { ...rehearsal, testedAt: "2026-10-09T21:15:00Z" },
    { ...rehearsal, update: { ...rehearsal.update, passed: false } },
    { ...rehearsal, update: { ...rehearsal.update, payloadSha256: "0".repeat(64) } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, passed: false } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, fromVersion: baseline.version } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, fromVersion: baseline.version, deliveredVersion: candidate.version } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, restoredContentSha256: "0".repeat(64) } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, deliveredVersion: candidate.version } },
    { ...rehearsal, recovery: { ...rehearsal.recovery, deliveredVersion: baseline.version } }
  ]) assert.throws(() => managedChatgptProfile(candidate, candidatePublication, { ...options, rehearsal: broken }), /actual ChatGPT update and recovery/);
  await writeFile(join(baselineDirectory, "payload", "content.js"), "// Tampered\n");
  await assert.rejects(verifyExtensionRelease(baselineDirectory), /integrity check failed/);
  await assert.rejects(prepareExtensionRecovery(baselineDirectory, join(root, "bad-repair"), "0.3.17", "0.3.16"), /integrity check failed/);
  await writeFile(join(source, "secret.key"), "do not publish");
  await assert.rejects(prepareExtensionRelease(source, join(root, "leak")), /Unexpected extension package entry/);
  await rm(join(source, "secret.key"));
  await rm(join(source, "content.js"));
  await symlink(join(root, "candidate", "payload", "content.js"), join(source, "content.js"));
  await assert.rejects(prepareExtensionRelease(source, join(root, "symlink")), /Unsafe extension file/);
  await rm(join(source, "content.js"));
  await writeFile(join(source, "content.js"), "// Working filter\n");
  await writeFile(join(source, "manifest.json"), JSON.stringify({ ...manifest, key: "bad" }));
  await assert.rejects(prepareExtensionRelease(source, join(root, "wrong-id")));
  console.log("Managed companion snapshots, identity, repair versions, integrity, publication, and client-rehearsal gates passed.");
} finally {
  await rm(root, { recursive: true, force: true });
}
