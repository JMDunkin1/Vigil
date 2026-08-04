import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  incrementVersion,
  inspectPhoneBlocklistBytes,
  blocklistReadinessProblems,
  deployedBlocklistProblems,
  iosSdkSupportsDevice,
  isLegacyPhoneBundleIdentifier,
  isPhoneImplementationFile,
  parseArguments,
  policyFreshnessProblems,
  preservedPolicyReceipt,
  receiptPhoneEdition,
  removalPasswordFromProfile,
  safariExtensionUpdateProblems
} from "../scripts/ios-phone-suite.mjs";
import { buildPhoneBlocklistArtifact } from "../src/adultBlocklistPhoneArtifact.js";

const projectRoot = existsSync(join(process.cwd(), "scripts", "ios-phone-suite.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const phoneSuiteSource = await readFile(join(projectRoot, "scripts", "ios-phone-suite.mjs"), "utf8");

assert.deepEqual(parseArguments([]), {
  command: "status",
  options: { allowEditionDowngrade: false, bump: "patch", device: "", edition: "", force: false, json: false, noPolicy: false, replaceLegacy: false, server: "http://127.0.0.1:8787" }
});
assert.deepEqual(parseArguments(["update", "--device", "phone-1", "--no-policy", "--replace-legacy"]), {
  command: "update",
  options: { allowEditionDowngrade: false, bump: "patch", device: "phone-1", edition: "", force: false, json: false, noPolicy: true, replaceLegacy: true, server: "http://127.0.0.1:8787" }
});
assert.equal(parseArguments(["update", "--edition", "personal"]).options.edition, "personal");
assert.equal(parseArguments(["update", "--edition=enhanced"]).options.edition, "enhanced");
assert.equal(parseArguments(["update", "--allow-edition-downgrade"]).options.allowEditionDowngrade, true);
assert.equal(parseArguments(["develop"]).command, "develop");
assert.equal(parseArguments(["bump", "minor"]).options.bump, "minor");
assert.throws(() => parseArguments(["update", "--wat"]), /Unknown option/);
assert.throws(() => parseArguments(["bump", "wat"]), /Unknown release bump/);
assert.throws(() => parseArguments(["update", "--edition", "enterprise"]), /Unknown phone edition/);

assert.equal(incrementVersion("1.2.3", "patch"), "1.2.4");
assert.equal(incrementVersion("1.2.3", "minor"), "1.3.0");
assert.equal(incrementVersion("1.2.3", "major"), "2.0.0");

assert.equal(iosSdkSupportsDevice(18.5, "18.6.2"), true);
assert.equal(iosSdkSupportsDevice(17.5, "18.0"), false);
assert.equal(iosSdkSupportsDevice(18, "unknown"), true);

const phoneSourceFilesStart = phoneSuiteSource.indexOf("const PHONE_SOURCE_FILES = [");
const phoneSourceFilesEnd = phoneSuiteSource.indexOf("];", phoneSourceFilesStart);
assert.match(
  phoneSuiteSource.slice(phoneSourceFilesStart, phoneSourceFilesEnd),
  /"scripts\/ios-phone-suite\.mjs"/u,
  "the phone suite must fingerprint its own deployment behavior"
);
assert.match(
  phoneSuiteSource.slice(phoneSourceFilesStart, phoneSourceFilesEnd),
  /"src\/iosProfiles\.ts"/u,
  "the phone suite must fingerprint the profile generator it deploys and audits"
);
assert.match(phoneSuiteSource.slice(phoneSourceFilesStart, phoneSourceFilesEnd), /"scripts\/generate-ios-content-policy\.mts"/u);
assert.match(phoneSuiteSource.slice(phoneSourceFilesStart, phoneSourceFilesEnd), /"src\/explicitContentPolicy\.ts"/u);

const preparePhoneStart = phoneSuiteSource.indexOf("async function preparePhoneToolchain(requested)");
const preparePhoneEnd = phoneSuiteSource.indexOf("export function iosSdkSupportsDevice", preparePhoneStart);
const preparePhoneSource = phoneSuiteSource.slice(preparePhoneStart, preparePhoneEnd);
const selectionIndex = preparePhoneSource.indexOf("await selectDeveloperDirectory()");
const environmentIndex = preparePhoneSource.indexOf("DEVELOPER_DIR: selected.developerDir");
const discoveryIndex = preparePhoneSource.indexOf("await resolveDevice(requested, toolEnvironment)");
const compatibilityIndex = preparePhoneSource.indexOf("iosSdkSupportsDevice(selected.iosSdk, device.osVersion)");
assert.ok(
  selectionIndex >= 0
    && selectionIndex < environmentIndex
    && environmentIndex < discoveryIndex
    && discoveryIndex < compatibilityIndex,
  "the newest usable Xcode must be selected and applied before device discovery, then checked against the discovered iOS version"
);
assert.match(
  phoneSuiteSource,
  /if \(selectedCommand === "audit"\) \{[\s\S]*?edition === "enhanced"[\s\S]*?requireReadyIosUrlFilter[\s\S]*?prepareAuditToolchain\(\)[\s\S]*?auditFourPolicies\(toolEnvironment, edition === "enhanced" \? urlFilter\.service : null\)/u,
  "standalone four-level policy audits must select and use an Xcode tool environment"
);
assert.match(phoneSuiteSource, /PANIC_LOCK_PROFILE_ID[\s\S]*?title: "Panic"/u, "the phone audit must include Panic");
assert.match(phoneSuiteSource, /console\.log\(`\$\{editionLabel\(edition\)\} four-level policy audit:`\)/u);
assert.equal(
  (phoneSuiteSource.match(/await phoneStatus\(selectedOptions, device, toolEnvironment, edition\)/gu) || []).length,
  2,
  "initial and post-update status must reuse the selected Xcode tool environment"
);
const deviceControlCalls = phoneSuiteSource
  .split("\n")
  .filter((line) => line.includes("devicectlJson(["));
assert.ok(deviceControlCalls.length >= 4);
for (const call of deviceControlCalls) {
  assert.match(call, /, toolEnvironment\)[,;]?$/u, `devicectl JSON call must receive DEVELOPER_DIR: ${call.trim()}`);
}
const streamedXcrunCalls = phoneSuiteSource
  .split("\n")
  .filter((line) => /(?:run|runQuiet)\("xcrun"/u.test(line));
assert.ok(streamedXcrunCalls.length >= 5);
for (const call of streamedXcrunCalls) {
  assert.match(call, /\{ env: toolEnvironment \}\);$/u, `xcrun call must receive DEVELOPER_DIR: ${call.trim()}`);
}
assert.match(
  phoneSuiteSource,
  /execFileAsync\("xcrun", \["devicectl", \.\.\.args, "--json-output", "-"\], \{\s*env: toolEnvironment,/u,
  "captured devicectl calls must receive the selected Xcode environment"
);

assert.equal(isPhoneImplementationFile("/repo/ios/VigilBrowser/VigilBrowser/BrowserStore.swift"), false);
assert.equal(isPhoneImplementationFile("/repo/ios/VigilSocial/VigilSocial/SocialWebViewStore.swift"), true);
assert.equal(isPhoneImplementationFile("/repo/ios/VigilBrowser/VigilBrowserTests/VigilBrowserTests.swift"), false);
assert.equal(isPhoneImplementationFile("/repo/ios/PHONE_MAINTENANCE.md"), false);
assert.equal(isPhoneImplementationFile("/repo/ios/phone-release.json"), false);

for (const bundleIdentifier of [
  "tech.caseline.sentinel.instagram",
  "tech.caseline.sentinel.youtube",
  "tech.caseline.vigil.browser",
  "tech.caseline.vigil.social",
  "tech.caseline.vigil.snapchat",
  "tech.caseline.vigil.youtube"
]) {
  assert.equal(isLegacyPhoneBundleIdentifier(bundleIdentifier), true, `${bundleIdentifier} should be treated as obsolete`);
}
assert.equal(isLegacyPhoneBundleIdentifier("tech.caseline.vigil.instagram"), false);

const requiredAppsStart = phoneSuiteSource.indexOf("const REQUIRED_SOCIAL_APPS = [");
const requiredAppsEnd = phoneSuiteSource.indexOf("];", requiredAppsStart);
const requiredAppsSource = phoneSuiteSource.slice(requiredAppsStart, requiredAppsEnd);
assert.match(requiredAppsSource, /tech\.caseline\.vigil\.instagram/u);
assert.match(requiredAppsSource, /service: "instagram"[\s\S]*?appIconSet: "InstagramAppIcon"/u);
assert.doesNotMatch(requiredAppsSource, /tech\.caseline\.vigil\.(?:browser|social|snapchat|youtube)/u);
assert.match(phoneSuiteSource, /const appsForEdition = \(edition\) => edition === "enhanced"[\s\S]*?REQUIRED_SOCIAL_APPS, URL_FILTER_APP/u);
assert.match(phoneSuiteSource, /bundleId: "tech\.caseline\.vigil\.url-filter"/u);

const buildPhoneAppsStart = phoneSuiteSource.indexOf("async function buildPhoneApps");
const buildPhoneAppsEnd = phoneSuiteSource.indexOf("async function hashAppBundle", buildPhoneAppsStart);
const buildPhoneAppsSource = phoneSuiteSource.slice(buildPhoneAppsStart, buildPhoneAppsEnd);
assert.match(buildPhoneAppsSource, /for \(const social of REQUIRED_SOCIAL_APPS\)/u);
assert.match(buildPhoneAppsSource, /"-scheme", social\.buildScheme/u);
assert.match(buildPhoneAppsSource, /VIGIL_APP_BUNDLE_IDENTIFIER=\$\{social\.bundleId\}/u);
assert.match(buildPhoneAppsSource, /VIGIL_SERVICE=\$\{social\.service\}/u);
assert.match(buildPhoneAppsSource, /SOCIAL_APP_ICON_SET=\$\{social\.appIconSet\}/u);
assert.doesNotMatch(buildPhoneAppsSource, /VigilBrowser|browserDerived|VIGIL_SERVICE=combined/u);
assert.match(buildPhoneAppsSource, /VigilURLFilter\/VigilURLFilter\.xcodeproj[\s\S]*?VigilURLFilterHost/u);
assert.match(buildPhoneAppsSource, /if \(edition === "enhanced"\)/u);
assert.match(buildPhoneAppsSource, /signedUrlFilterCapabilities[\s\S]*?urlFilterProvider/u);
assert.match(
  buildPhoneAppsSource,
  /CODE_SIGN_ENTITLEMENTS=\$\{personalTeamEntitlements\}[\s\S]*?VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified/u,
  "Personal Team fallback builds must explicitly reveal media that SCA cannot classify"
);
assert.match(
  buildPhoneAppsSource,
  /verifyBundledPhoneBlocklist\(path, blocklist\)[\s\S]*?verifyBundledExplicitContentPolicy\(path, explicitContentPolicy\)/u,
  "Release builds must verify both generated enforcement artifacts inside every app bundle"
);
assert.match(phoneSuiteSource, /app\.blocklist\.artifactSha256/u);
assert.match(phoneSuiteSource, /app\.explicitContentPolicy\?\.sha256/u);
assert.match(
  phoneSuiteSource,
  /if \(\(obsoleteBeforeUpdate\.length \|\| obsoleteLauncherBeforeUpdate\) && !selectedOptions\.replaceLegacy\)[\s\S]*?Re-run with --replace-legacy/u,
  "obsolete bundles and launcher configuration must require the explicit replacement flag before removal"
);
assert.match(
  phoneSuiteSource,
  /configurationProfileStatus\(device\.identifier, toolEnvironment\)[\s\S]*?Configuration-profile verification is unavailable/u,
  "read-only status must report unsupported configuration-profile inspection instead of crashing"
);
assert.match(
  phoneSuiteSource,
  /configuration profile management[\s\S]*not supported/iu,
  "only CoreDevice's unsupported profile-management capability should be downgraded"
);
assert.match(phoneSuiteSource, /com\\\.apple\\\.coredevice\\\.feature\\\.configurationprofiles/u);
assert.doesNotMatch(phoneSuiteSource, /stable Vigil social-launcher profile is not installed/u);
assert.doesNotMatch(phoneSuiteSource, /buildIosSocialLauncherProfile|buildStampedLauncherProfile/u);
assert.match(
  phoneSuiteSource,
  /if \(selectedOptions\.replaceLegacy\) \{\s*await removeObsoleteLauncherProfile\(device\.identifier, toolEnvironment\);\s*\}/u,
  "explicit legacy replacement must remove the retired launcher profile"
);
assert.match(
  phoneSuiteSource,
  /"devicectl", "device", "profile", "remove",[\s\S]*?LAUNCHER_PROFILE_IDENTIFIER,[\s\S]*?"--type", "configuration",[\s\S]*?"--force-removal"/u
);
assert.match(phoneSuiteSource, /isMissingConfigurationProfileError\(detail\)/u);
assert.match(phoneSuiteSource, /isUnsupportedConfigurationProfileError\(detail\)/u);
assert.match(
  phoneSuiteSource,
  /installConfigurationProfileWhenUnlocked\(device, preparedPolicy\.lockPath, toolEnvironment\)/u
);
assert.match(
  phoneSuiteSource,
  /async function installConfigurationProfileWhenUnlocked[\s\S]*?APPLY_USB_PROFILE_SCRIPT[\s\S]*?ProfileError: invalid response \\\{'Status': 'NotNow'\\\}[\s\S]*?setTimeout\(resolveWait, 1_000\)/u,
  "a locked phone should pause at the protected profile boundary without rebuilding or downgrading"
);
assert.match(
  phoneSuiteSource,
  /paired over USB but is not supervised[\s\S]*?iOS will transfer the profile for confirmation in Settings/u,
  "an unsupervised personal phone may fall back to Apple's user-confirmed profile transfer"
);
assert.match(
  phoneSuiteSource,
  /existingSupervisorKeybagPath\(\)[\s\S]*?VIGIL_SUPERVISOR_KEYBAG[\s\S]*?join\(ROOT, "data", "vigil-supervisor\.keybag"\)/u,
  "a supervised update must locate the persistent key independently of the live-state directory"
);
assert.match(
  phoneSuiteSource,
  /buildCurrentPolicyFromLiveState\(server,[\s\S]*?urlFilterService \? \{ urlFilter: urlFilterService \} : \{\}/u,
  "updates must generate edition-matched policy bytes with the freshly built profile code and current live state"
);
assert.match(phoneSuiteSource, /--no-policy is incompatible with the Enhanced edition's fail-closed iOS URL Filter/u);
assert.match(phoneSuiteSource, /Refusing to replace an Enhanced phone deployment with Personal edition/u);
assert.match(phoneSuiteSource, /await persistPhoneEdition\(edition\)/u);
assert.doesNotMatch(phoneSuiteSource, /fetchLivePolicyFingerprint/u, "policy freshness must not fall back to potentially stale server bytes");
assert.match(
  phoneSuiteSource,
  /const runningProfile = await downloadPolicy\(server, signal\)[\s\S]*?removalPasswordFromProfile/u,
  "fresh generation may reuse only the hidden removal password from the running profile"
);
assert.match(
  phoneSuiteSource,
  /async function stampProfile[\s\S]*?writeFile\(path, profile, \{ mode: 0o600 \}\)[\s\S]*?finally \{\s*await rm\(dir, \{ recursive: true, force: true \}\);/u,
  "an unsigned stamped profile may contain the removal password and must remain owner-only and be deleted"
);
assert.match(
  phoneSuiteSource,
  /async function signProfile[\s\S]*?await chmod\(temporaryOutput, 0o600\)[\s\S]*?await rename\(temporaryOutput, outputPath\)[\s\S]*?finally \{\s*await rm\(temporaryOutput, \{ force: true \}\);\s*await rm\(dir, \{ recursive: true, force: true \}\);/u,
  "profile signing must atomically publish an owner-only output and remove all temporary material"
);
assert.doesNotMatch(
  phoneSuiteSource,
  /if \(!selectedOptions\.noPolicy\) \{\s*const profile = await downloadPolicy/u,
  "the updater must never install the running server's potentially stale profile bytes"
);

assert.equal(removalPasswordFromProfile({
  PayloadContent: [
    { PayloadType: "com.apple.webcontent-filter", DenyListURLs: ["https://example.test/"] },
    { PayloadType: "com.apple.profileRemovalPassword", RemovalPassword: "preserved-secret" }
  ]
}), "preserved-secret");
assert.equal(removalPasswordFromProfile({ PayloadContent: [] }), "");
assert.equal(removalPasswordFromProfile(null), "");

assert.deepEqual(policyFreshnessProblems({
  installedProfileName: "Vigil iPhone Lock • 1.2.3 (4) • aaaaaaaaaaaa",
  receiptFingerprint: "a".repeat(64),
  livePolicyFingerprint: "b".repeat(64)
}), [
  "The last deployment receipt does not match the currently generated live policy.",
  "The installed policy profile does not match the currently generated live policy."
]);
assert.deepEqual(policyFreshnessProblems({
  installedProfileName: "Vigil iPhone Lock • 1.2.3 (4) • aaaaaaaaaaaa",
  receiptFingerprint: "a".repeat(64),
  livePolicyFingerprint: "a".repeat(64)
}), []);
assert.deepEqual(policyFreshnessProblems({
  installedProfileName: "Vigil iPhone Lock • 1.2.3 (4) • aaaaaaaaaaaa",
  receiptFingerprint: "",
  livePolicyFingerprint: ""
}), []);

assert.deepEqual(preservedPolicyReceipt({
  policyFingerprint: "prior-policy",
  policyArtifactHash: "prior-artifact"
}), {
  policyFingerprint: "prior-policy",
  policyArtifactHash: "prior-artifact"
});
assert.deepEqual(preservedPolicyReceipt(null), { policyFingerprint: "", policyArtifactHash: "" });
assert.equal(receiptPhoneEdition(null), "personal");
assert.equal(receiptPhoneEdition({ edition: "personal" }), "personal");
assert.equal(receiptPhoneEdition({ edition: "enhanced" }), "enhanced");
assert.equal(receiptPhoneEdition({ apps: [{ bundleId: "tech.caseline.vigil.url-filter" }] }), "enhanced");

const youtubeExtension = {
  bundleIdentifier: "tech.caseline.vigil.instagram.youtube-controls",
  sha256: "new-extension-bytes",
  manifestVersion: 3,
  hostPermissions: ["https://youtube.com/*", "https://www.youtube.com/*", "https://m.youtube.com/*"],
  contentScriptMatches: ["https://youtube.com/*", "https://www.youtube.com/*", "https://m.youtube.com/*"],
  permissions: []
};
const nextInstagramApps = [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtension: youtubeExtension }];
assert.match(safariExtensionUpdateProblems(null, nextInstagramApps).join("\n"), /adds Vigil YouTube Controls/u);
assert.deepEqual(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtensionSha256: "new-extension-bytes" }]
}, nextInstagramApps), []);
assert.match(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtensionSha256: "old-extension-bytes" }]
}, nextInstagramApps).join("\n"), /cannot be proven safe/u);
assert.deepEqual(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtension: { ...youtubeExtension, sha256: "old-extension-bytes" } }]
}, nextInstagramApps), []);
assert.match(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtension: youtubeExtension }]
}, [{
  bundleId: "tech.caseline.vigil.instagram",
  youtubeInteractionExtension: { ...youtubeExtension, hostPermissions: [...youtubeExtension.hostPermissions, "https://accounts.google.com/*"] }
}]).join("\n"), /host permissions changed/u);
assert.match(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtension: youtubeExtension }]
}, [{
  bundleId: "tech.caseline.vigil.instagram",
  youtubeInteractionExtension: { ...youtubeExtension, bundleIdentifier: "tech.caseline.vigil.instagram.youtube-controls-v2" }
}]).join("\n"), /bundle identifier changed/u);
assert.match(safariExtensionUpdateProblems({
  apps: [{ bundleId: "tech.caseline.vigil.instagram", youtubeInteractionExtension: youtubeExtension }]
}, [{
  bundleId: "tech.caseline.vigil.instagram",
  youtubeInteractionExtension: { ...youtubeExtension, permissions: ["tabs"] }
}]).join("\n"), /extension permissions changed/u);

const testSource = {
  id: "custom-test",
  label: "Custom test source",
  url: "https://example.test/list.txt",
  homepage: "https://example.test/",
  license: "test-only"
};
const testBlocklist = buildPhoneBlocklistArtifact({
  domains: Array.from({ length: 1_000 }, (_, index) => `blocked-${index}.example.test`),
  snapshotHash: "c".repeat(64),
  generatedAt: "2026-08-01T00:00:00.000Z",
  source: testSource
});
const readyBlocklist = inspectPhoneBlocklistBytes(testBlocklist.bytes, "/tmp/adult-blocklist.sdi");
assert.equal(readyBlocklist.ready, true);
assert.equal(readyBlocklist.domainCount, 1_000);
assert.equal(readyBlocklist.snapshotHash, "c".repeat(64));
assert.equal(readyBlocklist.source?.id, "custom-test");
const tamperedSparseIndex = Buffer.from(testBlocklist.bytes);
const sparseIndexOffset = 12 + tamperedSparseIndex.readUInt32LE(8);
tamperedSparseIndex[sparseIndexOffset] ^= 0xff;
assert.equal(inspectPhoneBlocklistBytes(tamperedSparseIndex).ready, false);

const undersizedDefaultBlocklist = buildPhoneBlocklistArtifact({
  domains: ["blocked.example.test"],
  snapshotHash: "d".repeat(64),
  generatedAt: "2026-08-01T00:00:00.000Z",
  source: { ...testSource, id: "blocklistproject-porn" }
});
const undersizedDefaultReadiness = inspectPhoneBlocklistBytes(undersizedDefaultBlocklist.bytes);
assert.equal(undersizedDefaultReadiness.ready, false);
assert.match(undersizedDefaultReadiness.error, /600000 domains are required/u);
assert.equal(inspectPhoneBlocklistBytes(Buffer.from("not-an-index")).ready, false);

const matchingLiveState = {
  state: {
    settings: { adultBlocklistEnabled: true, adultBlocklistSourceId: "custom-test" },
    adultBlocklist: {
      activeDomainCount: 1_000,
      hash: "c".repeat(64),
      source: testSource
    }
  }
};
assert.deepEqual(blocklistReadinessProblems(readyBlocklist, matchingLiveState), []);
assert.match(
  blocklistReadinessProblems(readyBlocklist, {
    state: { settings: { adultBlocklistEnabled: true }, adultBlocklist: { activeDomainCount: 0, hash: "", source: null } }
  }).join("\n"),
  /zero verified active domains/u
);
assert.deepEqual(deployedBlocklistProblems(null, readyBlocklist, ["app.one"]), [
  "No deployment receipt proves that the installed phone apps contain the verified adult blocklist."
]);
assert.deepEqual(deployedBlocklistProblems({
  blocklist: {
    artifactSha256: readyBlocklist.artifactSha256,
    snapshotHash: readyBlocklist.snapshotHash,
    domainCount: readyBlocklist.domainCount
  },
  apps: [{
    bundleId: "app.one",
    blocklistArtifactSha256: readyBlocklist.artifactSha256,
    blocklistDomainCount: readyBlocklist.domainCount
  }]
}, readyBlocklist, ["app.one"]), []);
