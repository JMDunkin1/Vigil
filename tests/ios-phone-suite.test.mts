import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  incrementVersion,
  iosSdkSupportsDevice,
  isLegacyPhoneBundleIdentifier,
  isPhoneImplementationFile,
  parseArguments,
  policyFreshnessProblems,
  preservedPolicyReceipt
} from "../scripts/ios-phone-suite.mjs";

const projectRoot = existsSync(join(process.cwd(), "scripts", "ios-phone-suite.mjs"))
  ? process.cwd()
  : resolve(process.cwd(), "..", "..");
const phoneSuiteSource = await readFile(join(projectRoot, "scripts", "ios-phone-suite.mjs"), "utf8");

assert.deepEqual(parseArguments([]), {
  command: "status",
  options: { bump: "patch", device: "", force: false, json: false, noPolicy: false, replaceLegacy: false, server: "http://127.0.0.1:8787" }
});
assert.deepEqual(parseArguments(["update", "--device", "phone-1", "--no-policy", "--replace-legacy"]), {
  command: "update",
  options: { bump: "patch", device: "phone-1", force: false, json: false, noPolicy: true, replaceLegacy: true, server: "http://127.0.0.1:8787" }
});
assert.equal(parseArguments(["bump", "minor"]).options.bump, "minor");
assert.throws(() => parseArguments(["update", "--wat"]), /Unknown option/);
assert.throws(() => parseArguments(["bump", "wat"]), /Unknown release bump/);

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
  /if \(selectedCommand === "audit"\) \{[\s\S]*?prepareAuditToolchain\(\)[\s\S]*?auditThreePolicies\(toolEnvironment\)/u,
  "standalone policy audits must select and use an Xcode tool environment"
);
assert.equal(
  (phoneSuiteSource.match(/await phoneStatus\(selectedOptions, device, toolEnvironment\)/gu) || []).length,
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

assert.equal(isPhoneImplementationFile("/repo/ios/VigilBrowser/VigilBrowser/BrowserStore.swift"), true);
assert.equal(isPhoneImplementationFile("/repo/ios/VigilBrowser/VigilBrowserTests/VigilBrowserTests.swift"), false);
assert.equal(isPhoneImplementationFile("/repo/ios/PHONE_MAINTENANCE.md"), false);
assert.equal(isPhoneImplementationFile("/repo/ios/phone-release.json"), false);

for (const bundleIdentifier of [
  "tech.caseline.sentinel.instagram",
  "tech.caseline.sentinel.youtube",
  "tech.caseline.vigil.instagram",
  "tech.caseline.vigil.youtube",
  "tech.caseline.vigil.snapchat"
]) {
  assert.equal(isLegacyPhoneBundleIdentifier(bundleIdentifier), true, `${bundleIdentifier} should be replaced by Vigil Social`);
}
assert.equal(isLegacyPhoneBundleIdentifier("tech.caseline.vigil.social"), false);
assert.equal(isLegacyPhoneBundleIdentifier("tech.caseline.vigil.browser"), false);

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
