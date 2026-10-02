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

for (const service of ["instagram", "youtube", "snapchat", "linkedin", "facebook", "x", "tiktok", "reddit"]) {
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
    assert.ok([...policy.deniedUrls, ...policy.supplementalDeniedUrls].includes(`https://${domain}/`), `${service}: retained priority ${domain}`);
  }
}

for (const [service, aliases] of [["facebook", ["messenger.com"]], ["x", ["twitter.com"]]] as const) {
  const limited = structuredClone(state);
  limited.limitBlocks = [{
    id: `alias-${service}`, ruleId: `rule-${service}`, ruleName: service, type: "time", lockLevel: "deep",
    apps: [`tech.caseline.vigil.${service}`], sites: [], deviceTargets: ["phone"],
    createdAt: instant.toISOString(), until: new Date(instant.getTime() + 3600000).toISOString()
  }];
  const policy = iosPolicyTargets(limited, instant);
  for (const domain of aliases) assert.ok(policy.deniedUrls.includes(`https://${domain}/`), `${service} aliases share restrictions`);
}

assert.deepEqual(state.deviceControls.ios.focusedSocial.instagram, defaultState().deviceControls.ios.focusedSocial.instagram,
  "Expanding services must preserve every Instagram setting");
for (const service of ["facebook", "x", "tiktok", "reddit"] as const) {
  assert.equal(state.deviceControls.ios.focusedSocial[service].enabled, true);
  const blocked = structuredClone(state.deviceControls.ios);
  blocked.blockedAppBundleIds.push(`tech.caseline.vigil.${service}`);
  assert.throws(() => socialContainerSettings(blocked), /explicitly blocked/,
    "An update must not remove a saved independent service block");
  const attempted = normalizeIosSettings({ focusedSocial: { [service]: { shorts: false, explore: false, suggested: false, ads: false } } }, state.deviceControls.ios);
  for (const feature of ["shorts", "explore", "suggested", "ads"] as const) assert.equal(attempted.focusedSocial[service][feature], true);
}

const expandedServiceDomains = ["facebook.com", "messenger.com", "x.com", "twitter.com", "tiktok.com", "reddit.com"];
function expandedDomainsInAllowlist(urls: readonly string[]): string[] {
  return urls.map((url) => new URL(url).hostname.replace(/^(?:www|m|old)\./u, ""))
    .filter((host) => expandedServiceDomains.includes(host));
}

function allowlistState(combined: boolean, services: readonly string[] = [], focused = false) {
  const allowlisted = defaultState();
  allowlisted.settings.adultBlocklistEnabled = false;
  allowlisted.deviceControls.ios.enabled = true;
  allowlisted.deviceControls.ios.socialContainer = combined;
  allowlisted.deviceControls.ios.mode = "allowlist";
  allowlisted.deviceControls.ios.webMode = "allowlist";
  allowlisted.deviceControls.ios.allowedAppBundleIds = [
    "com.apple.mobilesafari", "tech.caseline.vigil.instagram", ...services.map((service) => `tech.caseline.vigil.${service}`)
  ];
  const profile = {
    ...allowlisted.profiles[0], id: focused ? SOFT_BLOCK_PROFILE_ID : "test-example-only-allowlist",
    mode: "allowlist" as const, allowedSites: ["example.com"], blockedSites: [], blockedUrlPatterns: []
  };
  allowlisted.activeSessions.phone = {
    id: "test-example-only", title: "Example only", mode: "focus", profileId: profile.id, lockLevel: "deep",
    startedAt: instant.toISOString(), endsAt: new Date(instant.getTime() + 3600000).toISOString(),
    canEndEarly: false, source: "manual", deviceTargets: ["phone"], profileSnapshot: profile
  };
  return allowlisted;
}

const beforeMigration = iosPolicyTargets(allowlistState(false), instant);
assert.equal(beforeMigration.webMode, "allowlist");
assert.ok(beforeMigration.allowedUrls.includes("https://example.com/"));
assert.deepEqual(expandedDomainsInAllowlist(beforeMigration.allowedUrls), [],
  "Adding services must not silently widen an existing non-container web allowlist");

const unselectedServices = iosPolicyTargets(allowlistState(true), instant);
assert.deepEqual(expandedDomainsInAllowlist(unselectedServices.allowedUrls), [],
  "Container installation alone must not grant an unlisted service access under an app allowlist");
for (const domain of expandedServiceDomains) {
  assert.ok(unselectedServices.deniedUrls.includes(`https://${domain}/`), `${domain} remains unavailable when its companion is unlisted`);
}

const facebookAllowed = iosPolicyTargets(allowlistState(true, ["facebook"]), instant);
assert.ok(facebookAllowed.allowedUrls.includes("https://facebook.com/"));
assert.ok(facebookAllowed.allowedUrls.includes("https://messenger.com/"), "Facebook's allowed companion covers its messaging host");
for (const domain of ["x.com", "twitter.com", "tiktok.com", "reddit.com"]) {
  assert.ok(!facebookAllowed.allowedUrls.includes(`https://${domain}/`), `${domain} must not inherit another service's permission`);
}

const focusedContainer = allowlistState(true, [], true);
focusedContainer.deviceControls.ios.focusedSocial.facebook.enabled = false;
const focusedAllowed = iosPolicyTargets(focusedContainer, instant);
for (const domain of ["x.com", "twitter.com", "tiktok.com", "reddit.com"]) {
  assert.ok(focusedAllowed.allowedUrls.includes(`https://${domain}/`), `${domain} stays reachable for its enabled focused companion`);
}
assert.ok(!focusedAllowed.allowedUrls.includes("https://facebook.com/"), "A disabled focused service must not add a web allowlist exception");
assert.ok(!focusedAllowed.allowedUrls.includes("https://messenger.com/"));

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
for (const argument of ["VIGIL_SERVICE=all", "VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram", "SOCIAL_URL_SCHEME=vigilsocial", "SOCIAL_APP_NAME=Vigil", "SOCIAL_APP_ICON_SET=AppIcon"]) assert.ok(args.includes(argument), argument);
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
