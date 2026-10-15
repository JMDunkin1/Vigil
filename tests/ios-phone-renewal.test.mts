import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FRESH_SIGNING_WINDOW_MS, RENEWAL_WINDOW_MS, freshSigningBuild, renewalDecision, renewalLaunchAgent, runPhoneRenewal, signingProfilesNeedingRefresh, verifiedLauncherState, withPhoneUpdateLock } from "../scripts/ios-phone-renewal.mjs";

const now = Date.parse("2026-10-09T21:05:43.465Z");
const old = { name: "Vigil", expiresAt: "2026-10-12T21:40:57.000Z" };
const fresh = { name: "Vigil", expiresAt: "2026-10-16T21:05:43.465Z" };
assert.deepEqual(signingProfilesNeedingRefresh([old, fresh], now), [old], "the October 9 build must reject the reused October 5 profile with only three days left");
assert.deepEqual(signingProfilesNeedingRefresh([{ name: "Extension", expiresAt: "invalid" }], now).length, 1);
assert.deepEqual(signingProfilesNeedingRefresh([fresh, old], now), [old], "a short-lived extension must force signing renewal even if the app's profile is fresh");
assert.equal(FRESH_SIGNING_WINDOW_MS, 5 * 24 * 60 * 60 * 1000);

const calls: string[] = [];
let builds = 0;
assert.deepEqual(await freshSigningBuild({
  build: async () => { calls.push("build"); builds += 1; },
  readProfiles: async () => { calls.push("inspect"); return builds === 1 ? [fresh, old] : [fresh, { ...fresh, name: "Extension" }]; },
  quarantine: async (profiles) => { calls.push("quarantine"); assert.deepEqual(profiles, [old]); },
  now: () => now
}), [fresh, { ...fresh, name: "Extension" }]);
assert.deepEqual(calls, ["build", "inspect", "quarantine", "build", "inspect"]);
let attempts = 0;
await assert.rejects(freshSigningBuild({ build: async () => { attempts += 1; }, readProfiles: async () => [old], quarantine: async () => {}, now: () => now }), /Refusing to install/);
assert.equal(attempts, 2, "stale Xcode profiles cannot cause an unbounded rebuild loop or a short-lived install");
await assert.rejects(freshSigningBuild({ build: async () => {}, readProfiles: async () => [], quarantine: async () => {}, now: () => now }), /Refusing to install/);

const receipt = { edition: "personal", socialContainer: true, policyFingerprint: "verified-policy", device: { udid: "phone-1" }, release: { sourceFingerprint: "verified-source" }, apps: [{ bundleId: "tech.caseline.vigil.instagram", launchVerifiedAt: "verified", signingProfile: old }] };
const expires = Date.parse(old.expiresAt);
const verifiedReceipt = { ...receipt, deployedAt: new Date(now).toISOString(), serviceLaunches: ["instagram", "youtube", "snapchat", "linkedin"].map((service) => ({ service, verifiedAt: "verified" })) };
assert.deepEqual(verifiedLauncherState(verifiedReceipt, now), { schemaVersion: 1, expiresAt: old.expiresAt, updatedAt: verifiedReceipt.deployedAt });
assert.throws(() => verifiedLauncherState(verifiedReceipt, expires), /current verified/);
assert.throws(() => verifiedLauncherState({ ...verifiedReceipt, serviceLaunches: [] }, now), /current verified/);
assert.throws(() => verifiedLauncherState({ ...verifiedReceipt, policyFingerprint: "" }, now), /current verified/);
const earlyExtension = { name: "Extension", expiresAt: "2026-10-11T00:00:00.000Z" };
assert.equal(verifiedLauncherState({ ...verifiedReceipt, apps: [{ ...receipt.apps[0], signingProfile: { ...old, profiles: [old, earlyExtension] } }] }, now).expiresAt, earlyExtension.expiresAt);
assert.equal(renewalDecision(receipt, "verified-source", expires - RENEWAL_WINDOW_MS - 1).status, "current");
assert.equal(renewalDecision(receipt, "verified-source", expires - RENEWAL_WINDOW_MS).status, "due");
assert.equal(renewalDecision(receipt, "verified-source", expires + 1).status, "due", "expired app remains repairable through the verified update path");
assert.equal(renewalDecision(receipt, "changed-source", expires).status, "sources-changed", "automatic renewal must not install unrelated local edits");
assert.equal(renewalDecision({ ...receipt, edition: "enhanced" }, "verified-source", expires).status, "unconfigured");
assert.equal(renewalDecision({ ...receipt, policyFingerprint: "" }, "verified-source", expires).status, "unverified");
assert.equal(renewalDecision({ ...receipt, apps: [] }, "verified-source", expires).status, "unverified");
let updates = 0;
const update = async (device: string) => { assert.equal(device, "phone-1"); updates += 1; };
assert.equal((await runPhoneRenewal({ receipt, fingerprint: "verified-source", now, update })).status, "current");
assert.equal((await runPhoneRenewal({ receipt, fingerprint: "changed-source", now: expires, update })).status, "sources-changed");
assert.equal(updates, 0);
assert.equal((await runPhoneRenewal({ receipt, fingerprint: "verified-source", now: expires, update })).status, "renewed");
assert.equal(updates, 1);
assert.equal((await runPhoneRenewal({ receipt, fingerprint: "verified-source", now: expires, update: async () => { throw new Error("Phone unavailable"); } })).status, "needs-connection");

const root = await mkdtemp(join(tmpdir(), "vigil-phone-renewal-test-"));
try {
  await withPhoneUpdateLock(root, async () => {
    await assert.rejects(withPhoneUpdateLock(root, async () => { throw new Error("Concurrent action ran"); }), /already running/);
  });
  await assert.rejects(withPhoneUpdateLock(root, async () => { throw new Error("Failed transaction"); }), /Failed transaction/);
  assert.equal(await withPhoneUpdateLock(root, async () => "released"), "released");
  const lock = join(root, "data", "ios-phone-update.lock");
  await mkdir(lock);
  // PID 2147483647 is outside macOS's PID range and cannot own an update.
  await writeFile(join(lock, "pid"), "2147483647");
  assert.equal(await withPhoneUpdateLock(root, async () => readFile(join(lock, "pid"), "utf8")), String(process.pid));
  const plist = renewalLaunchAgent({ root: "/Work/Vigil & Focus", home: "/Users/test", node: "/usr/local/bin/node", device: "phone-1", server: "http://127.0.0.1:8787" });
  assert.match(plist, /Vigil &amp; Focus/);
  assert.match(plist, /<key>StartInterval<\/key><integer>21600<\/integer>/);
  assert.match(plist, /ios-phone-renewal\.mjs/);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("iOS phone signing renewal tests passed.");
