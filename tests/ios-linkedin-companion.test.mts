import assert from "node:assert/strict";
import { buildArguments } from "../scripts/build-ios-social-app.mjs";
import { parseArguments, socialAppsNeedingUpdate } from "../scripts/ios-phone-suite.mjs";
import { defaultFocusedSocialSettings, focusedSocialBlockedBundleIds, normalizeFocusedSocialSettings } from "../src/socialFeatureFilters.js";
import { defaultState, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, DEFAULT_FILTER_BYPASS_BLOCKED_SITES } from "../src/defaults.js";
import { iosPolicyTargets } from "../src/iosProfiles.js";

const args = buildArguments(["linkedin", "--unsigned", "--destination", "generic/platform=iOS Simulator"]);
assert.equal(args[args.indexOf("-scheme") + 1], "VigilLinkedIn");
assert.ok(args.includes("VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.linkedin"));
assert.ok(args.includes("VIGIL_SERVICE=linkedin"));
assert.ok(args.includes("SOCIAL_APP_ICON_SET=LinkedInAppIcon"));
assert.equal(parseArguments(["update", "--app", "linkedin"]).options.app, "linkedin");

const release = { apps: {
  instagram: { version: "0.1.0", build: 1, sourceFingerprint: "instagram" },
  youtube: { version: "0.1.0", build: 1, sourceFingerprint: "youtube" },
  snapchat: { version: "0.1.0", build: 1, sourceFingerprint: "snapchat" },
  linkedin: { version: "0.1.0", build: 1, sourceFingerprint: "linkedin" }
} };
assert.deepEqual(socialAppsNeedingUpdate(release), ["instagram", "youtube", "snapchat"]);
assert.deepEqual(socialAppsNeedingUpdate(release, [], null, ["linkedin"]), ["linkedin"]);
assert.deepEqual(socialAppsNeedingUpdate(release, [], null, ["snapchat"]), ["snapchat"]);

const defaults = defaultFocusedSocialSettings();
assert.equal(defaults.linkedin.enabled, false, "Do not hide native LinkedIn before its replacement is installed");
assert.equal(focusedSocialBlockedBundleIds(defaults).includes("com.linkedin.LinkedIn"), false);
const enabled = normalizeFocusedSocialSettings({ linkedin: { enabled: true, shorts: false } });
assert.equal(enabled.linkedin.shorts, true, "The companion's immersive-video restriction is permanent");
assert.ok(focusedSocialBlockedBundleIds(enabled).includes("com.linkedin.LinkedIn"));
const state = defaultState();
state.deviceControls.ios.enabled = true;
state.settings.adultBlocklistEnabled = false;
const baseline = iosPolicyTargets(state, new Date("2026-07-10T12:00:00Z"));
state.deviceControls.ios.focusedSocial.linkedin.enabled = true;
const replacement = iosPolicyTargets(state, new Date("2026-07-10T12:00:00Z"));
assert.deepEqual(replacement.deniedUrls, baseline.deniedUrls, "LinkedIn must not evict existing system URL blocks");
for (const domain of [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
  assert.ok(replacement.deniedUrls.includes(`https://${domain}/`), domain);
}
console.log("LinkedIn independent build, update scope, and policy preservation passed.");

// Replacement is saved only after the installed companion passes its launch check.
const { activateLinkedInReplacement, linkedInReplacementSettings } = await import("../scripts/ios-phone-suite.mjs");
const { normalizeIosSettings } = await import("../src/iosProfiles.js");
const configured = defaultState();
configured.deviceControls.ios.enabled = true;
const originalIos = structuredClone(configured.deviceControls.ios);
const replacementPatch = linkedInReplacementSettings(originalIos);
assert.deepEqual(configured.deviceControls.ios, originalIos, "Preparing a replacement must not mutate live state");
assert.ok(replacementPatch.blockedAppBundleIds.includes("com.linkedin.LinkedIn"));
assert.ok(!replacementPatch.allowedAppBundleIds.includes("com.linkedin.LinkedIn"));
assert.ok(replacementPatch.allowedAppBundleIds.includes("tech.caseline.vigil.linkedin"));
for (const id of originalIos.blockedAppBundleIds) assert.ok(replacementPatch.blockedAppBundleIds.includes(id));
configured.deviceControls.ios = normalizeIosSettings(replacementPatch, originalIos) as typeof originalIos;
const normalReplacement = iosPolicyTargets(configured, new Date("2026-07-10T12:00:00Z"));
assert.ok(normalReplacement.appBundleIds.includes("com.linkedin.LinkedIn"));
assert.ok(!normalReplacement.appBundleIds.includes("tech.caseline.vigil.linkedin"));
// Subsequent unrelated settings updates retain the block.
configured.deviceControls.ios = normalizeIosSettings({}, configured.deviceControls.ios) as typeof originalIos;
assert.ok(configured.deviceControls.ios.blockedAppBundleIds.includes("com.linkedin.LinkedIn"));
assert.throws(() => linkedInReplacementSettings({ ...originalIos, blockApps: false }), /active iPhone app restrictions/);

const savedFetch = globalThis.fetch;
const calls: string[] = [];
let persisted = structuredClone(originalIos);
let rejectSettings = false;
try {
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (init?.method === "POST") {
      calls.push("save");
      if (rejectSettings) return new Response("Protected edit denied", { status: 409 });
      const patch = JSON.parse(String(init.body));
      persisted = normalizeIosSettings(patch, persisted) as typeof originalIos;
      return Response.json({ ok: true });
    }
    assert.ok(url.endsWith("/api/state"));
    calls.push("read");
    return Response.json({ state: { deviceControls: { ios: persisted } } });
  };
  await assert.rejects(activateLinkedInReplacement("http://localhost", async () => ({ ok: false, detail: "launch failed" })), /original app was not blocked/);
  assert.equal(calls.length, 0, "Failed launch must never save a restriction");
  await activateLinkedInReplacement("http://localhost", async () => { calls.push("launch"); return { ok: true }; });
  assert.deepEqual(calls, ["launch", "read", "save", "read"]);
  assert.ok(persisted.blockedAppBundleIds.includes("com.linkedin.LinkedIn"));
  rejectSettings = true;
  await assert.rejects(activateLinkedInReplacement("http://localhost", async () => ({ ok: true })), /transaction is incomplete/);
} finally {
  globalThis.fetch = savedFetch;
}

const { BRICK_MODE_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, PANIC_LOCK_PROFILE_ID } = await import("../src/defaults.js");
const { profileById, panicLockProfile } = await import("../src/policy.js");
const instant = new Date("2026-07-10T12:00:00Z");
for (const profileId of [SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]) {
  const locked = structuredClone(configured);
  locked.activeSessions.phone = {
    id: "linkedin-replacement-lock", title: "Phone Lock", mode: profileId === BRICK_MODE_PROFILE_ID ? "brick" : "focus",
    profileId, lockLevel: "deep", startedAt: instant.toISOString(), endsAt: new Date(instant.getTime() + 3600000).toISOString(),
    canEndEarly: false, source: "manual", deviceTargets: ["phone"], profileSnapshot: profileById(locked, profileId)
  };
  const target = iosPolicyTargets(locked, instant);
  assert.equal(target.appMode === "allowlist" ? !target.appBundleIds.includes("com.linkedin.LinkedIn") : target.appBundleIds.includes("com.linkedin.LinkedIn"), true);
  if (profileId === BRICK_MODE_PROFILE_ID) {
    assert.equal(target.appMode === "allowlist" ? !target.appBundleIds.includes("tech.caseline.vigil.linkedin") : target.appBundleIds.includes("tech.caseline.vigil.linkedin"), true, "Replacement must not bypass Full Brick");
  }
}
const panic = structuredClone(configured);
panic.panicLock = {
  id: "linkedin-panic", title: "Panic", mode: "panic", profileId: PANIC_LOCK_PROFILE_ID, lockLevel: "deep",
  startedAt: instant.toISOString(), endsAt: new Date(instant.getTime() + 180000).toISOString(),
  canEndEarly: false, commitmentLock: true, emergencyUnlocksAllowed: false, source: "panic", fullLockout: true, profileSnapshot: panicLockProfile()
};
const panicTarget = iosPolicyTargets(panic, instant);
assert.equal(panicTarget.appMode, "allowlist");
assert.ok(!panicTarget.appBundleIds.includes("com.linkedin.LinkedIn"));
assert.ok(!panicTarget.appBundleIds.includes("tech.caseline.vigil.linkedin"));
assert.throws(() => linkedInReplacementSettings({ ...originalIos, blockedAppBundleIds: ["tech.caseline.vigil.linkedin"] }), /will not remove that restriction/);
