import assert from "node:assert/strict";
import { defaultState, BRICK_MODE_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, DEFAULT_FILTER_BYPASS_BLOCKED_SITES } from "../src/defaults.js";
import { iosPolicyTargets, normalizeIosSettings } from "../src/iosProfiles.js";
import { profileById } from "../src/policy.js";
import { buildArguments } from "../scripts/build-ios-social-app.mjs";
import { parseArguments, socialContainerSettings, validateSocialMigrationLedger } from "../scripts/ios-phone-suite.mjs";

const instant = new Date("2026-09-17T12:00:00Z");
const state = defaultState();
state.settings.adultBlocklistEnabled = false;
state.deviceControls.ios.enabled = true;
const patch = socialContainerSettings(state.deviceControls.ios);
state.deviceControls.ios = normalizeIosSettings(patch, state.deviceControls.ios);
assert.equal(state.deviceControls.ios.socialContainer, true);
assert.equal(normalizeIosSettings({ socialContainer: false }, state.deviceControls.ios).socialContainer, true,
  "An unrelated settings edit must not revert to policies that ignore services in the container");
assert.throws(() => normalizeIosSettings({ blockWeb: false }, state.deviceControls.ios), /requires both/);
assert.ok(!iosPolicyTargets(state, instant).appBundleIds.includes("tech.caseline.vigil.instagram"));

for (const service of ["instagram", "youtube", "snapchat", "linkedin"]) {
  const limited = structuredClone(state);
  limited.limitBlocks = [{
    id: `limit-${service}`, ruleId: `rule-${service}`, ruleName: service, type: "time", lockLevel: "deep",
    apps: [`tech.caseline.vigil.${service}`], sites: [], deviceTargets: ["phone"],
    createdAt: instant.toISOString(), until: new Date(instant.getTime() + 3600000).toISOString()
  }];
  const policy = iosPolicyTargets(limited, instant);
  assert.ok(!policy.appBundleIds.includes("tech.caseline.vigil.instagram"), `${service} alone must not block the container`);
  assert.ok(policy.deniedUrls.includes(`https://${service}.com/`), `${service} must stay blocked inside the container`);
  assert.ok(policy.deniedUrls.length <= 500);
  for (const domain of [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
    assert.ok(policy.deniedUrls.includes(`https://${domain}/`), `${service}: retained priority ${domain}`);
  }
}

for (const profileId of [SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]) {
  const locked = structuredClone(state);
  locked.activeSessions.phone = {
    id: `lock-${profileId}`, title: profileId, mode: "focus", profileId, lockLevel: "deep",
    startedAt: instant.toISOString(), endsAt: new Date(instant.getTime() + 3600000).toISOString(),
    canEndEarly: false, source: "manual", deviceTargets: ["phone"], profileSnapshot: profileById(locked, profileId)
  };
  const policy = iosPolicyTargets(locked, instant);
  const blocked = policy.appMode === "allowlist"
    ? !policy.appBundleIds.includes("tech.caseline.vigil.instagram")
    : policy.appBundleIds.includes("tech.caseline.vigil.instagram");
  assert.equal(blocked, profileId === BRICK_MODE_PROFILE_ID);
}

const args = buildArguments(["all", "--unsigned"]);
for (const argument of ["VIGIL_SERVICE=all", "VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram", "SOCIAL_URL_SCHEME=vigilsocial", "SOCIAL_APP_NAME=Vigil Social", "SOCIAL_APP_ICON_SET=AppIcon"]) assert.ok(args.includes(argument), argument);
assert.equal(parseArguments(["update", "--app", "all"]).options.app, "instagram");
const ledger = { youtubeLimits: {
  day: "2026-09-17", timezone: "America/New_York", slots: [null, null, null, null],
  played: { abcdefghijk: 42000 }, usedMs: 42000, grace: { status: "unused", videoId: null, usedMs: 0 },
  feeds: {}, external: [], lease: null
} };
assert.deepEqual(validateSocialMigrationLedger(Buffer.from(JSON.stringify(ledger))), ledger);
assert.throws(() => validateSocialMigrationLedger(Buffer.from('{}')), /must not reset usage/);
assert.throws(() => validateSocialMigrationLedger(Buffer.from('{"youtubeLimits":{}}')), /must not reset usage/);
console.log("Combined service restrictions, full lock, signing identity, and migration guards passed.");
