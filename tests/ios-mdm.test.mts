import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_IDS, NORMAL_PROFILE_ID, PANIC_LOCK_PROFILE_ID, defaultState, SOFT_BLOCK_PROFILE_ID } from "../src/defaults.js";
import { authorizeIosMdmDeviceRequest, authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, buildIosMdmPushRequest, handleIosMdmCheckIn, handleIosMdmConnect, iosMdmDeviceUsageCredential, iosMdmDoctor, iosMdmQueuedPushEligible, iosMdmSummary, normalizeIosMdmSettings, queueIosMdmPolicyRefresh } from "../src/iosMdm.js";
import { IOS_APP_STORE_BUNDLE_ID, IOS_PANIC_ALLOWED_APP_BUNDLE_IDS, IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER, buildIosConfigurationProfile, iosPolicyTargets, iosProfileSummary } from "../src/iosProfiles.js";
import { IOS_SOCIAL_COMPANION_APPS, IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../src/socialFeatureFilters.js";
import { activeLimitPolicy } from "../src/limits.js";
import { parsePlist, plistData, toPlist } from "../src/plist.js";
import { panicLockProfile, profileById } from "../src/policy.js";
import type { UsageState } from "../src/types.js";
import { syncDeviceUsageSnapshot } from "../src/usage.js";
import { DATA_DIR } from "../src/store.js";
import { must, now, recordValue, stringValue } from "./test-helpers.mjs";

const testUrlFilterServicePath = join(DATA_DIR, "ios-url-filter", "service.json");
const removeTestUrlFilterService = !existsSync(testUrlFilterServicePath);
if (removeTestUrlFilterService) {
  mkdirSync(join(DATA_DIR, "ios-url-filter"), { recursive: true });
  writeFileSync(testUrlFilterServicePath, JSON.stringify({
    schemaVersion: 1,
    pirServerURL: "https://pir.example.test/",
    privacyPassIssuerURL: "https://issuer.example.test/",
    deploymentManifestURL: "https://pir.example.test/deployment.json",
    authenticationToken: "test-authentication-token-0001",
    hostBundleIdentifier: "tech.caseline.vigil.url-filter",
    controlProviderBundleIdentifier: "tech.caseline.vigil.url-filter.control",
    usecaseName: "tech.caseline.vigil.url-filter.url.filtering",
    prefilterFetchIntervalSeconds: 2700,
    prefilterTag: "test-prefilter",
    pirDatabaseRevision: "test-pir",
    pirDatabaseSha256: "a".repeat(64),
    exactIndexSnapshotHash: "b".repeat(64)
  }));
  process.once("exit", () => rmSync(testUrlFilterServicePath, { force: true }));
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.settings.adultBlocklistEnabled = false;
  const targets = iosPolicyTargets(state, now);
  const allPrioritySites = [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES];
  assert.equal(allPrioritySites.length >= 200, true, "the Personal priority overlay should cover a couple hundred high-risk domains");
  assert.equal(allPrioritySites.every((site) => targets.deniedUrls.includes(`https://${site}/`)), true);
  assert.equal(targets.deniedUrls.includes("http://croxyproxy.com/"), false, "HTTPS-only proxy roots preserve capacity for modern services");
  assert.equal(targets.deniedUrls.includes("http://anonymouse.com/"), true, "confirmed plain-HTTP proxies need a second scheme entry");
  assert.equal(DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES.every((site) => targets.deniedUrls.includes(`http://${site}/`)), true);
  assert.equal(targets.deniedUrls.includes("https://www.croxyproxy.com/"), false, "Apple's www normalization makes this twin redundant");
  assert.ok(targets.deniedUrls.length <= 500);
}

{
  const prioritySites = [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES];
  for (const [label, profileId, active] of [
    ["Normal", NORMAL_PROFILE_ID, false],
    ["Soft Block", SOFT_BLOCK_PROFILE_ID, true],
    ["Brick Mode", BRICK_MODE_PROFILE_ID, true]
  ] as const) {
    const state = defaultState();
    state.deviceControls.ios.enabled = true;
    if (active) {
      state.activeSessions.phone = {
        id: `priority-overlay-${profileId}`,
        title: label,
        mode: "focus",
        profileId,
        lockLevel: "deep",
        startedAt: now.toISOString(),
        endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
        canEndEarly: false,
        source: "manual",
        deviceTargets: ["phone"],
        profileSnapshot: profileById(state, profileId)
      };
    } else {
      state.settings.baselineProfileId = profileId;
    }
    const targets = iosPolicyTargets(state, now);
    const deliveredPrioritySites = prioritySites.filter((site) => targets.deniedUrls.includes(`https://${site}/`));
    assert.equal(deliveredPrioritySites.length >= 200, true, `${label} should retain at least 200 curated high-risk domains`);
    assert.equal(targets.deniedUrls.includes("https://croxyproxy.com/"), true, `${label} should retain a direct web proxy`);
    assert.equal(targets.deniedUrls.includes("https://browser.lol/"), true, `${label} should retain a remote browser`);
    assert.equal(targets.deniedUrls.includes("https://invidious.f5.si/"), true, `${label} should retain an alternate video frontend`);
    assert.equal(targets.deniedUrls.includes("https://protonvpn.com/"), true, `${label} should retain a free VPN distributor`);
    assert.ok(targets.deniedUrls.length <= 500);
  }
}

{
  const state = defaultState();
  const mdm = state.deviceControls.ios.mdm;
  const eligibleAt = new Date("2026-07-21T12:00:00.000Z");
  mdm.devices = [{
    id: "eligible-device",
    udid: "eligible-udid",
    status: "enrolled",
    pushMagic: "push-magic",
    token: "push-token",
    tokenHex: Buffer.from("push-token").toString("hex")
  }];
  mdm.commands = [{
    id: "eligible-command",
    commandUuid: "eligible-command-uuid",
    udid: "eligible-udid",
    requestType: "DeviceInformation",
    command: { RequestType: "DeviceInformation" },
    reason: "eligibility-test",
    status: "queued",
    queuedAt: eligibleAt.toISOString(),
    sentAt: null,
    completedAt: null,
    attempts: 0
  }];
  const before = structuredClone(state);

  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt), false, "disabled MDM must not schedule a queued push");
  mdm.enabled = true;
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt), true, "an enrolled device with a queued command is push-eligible");
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt, { udids: ["other-udid"] }), false, "the push UDID filter must be exact");
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt, { udids: ["eligible-udid"] }), true);

  mdm.devices[0]!.lastPushAt = new Date(eligibleAt.getTime() - 29_999).toISOString();
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt), false, "the normal push cooldown must suppress an otherwise eligible device");
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt, { force: true }), true, "forced pushes must bypass the cooldown");
  mdm.devices[0]!.lastPushAt = new Date(eligibleAt.getTime() - 30_000).toISOString();
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt), true, "a device is eligible exactly at the cooldown boundary");

  mdm.commands[0]!.status = "sent";
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt), false, "only queued commands select a device for APNs push");
  mdm.commands[0]!.status = "queued";
  mdm.devices[0]!.status = "checked-out";
  assert.equal(iosMdmQueuedPushEligible(state, eligibleAt, { force: true }), false, "checked-out devices must never be push-selected");

  const disabledProbeState = structuredClone(before);
  iosMdmQueuedPushEligible(disabledProbeState, eligibleAt);
  assert.deepEqual(disabledProbeState, before, "the eligibility probe must not normalize or mutate live MDM state");
}

{
  const state = defaultState();
  const disabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(disabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(disabledProfile, /allowAppInstallation/);
  assert.doesNotMatch(disabledProfile, /PayloadRemovalDisallowed<\/key>\s*<true/);

  state.deviceControls.ios.enabled = true;
  const enabledProfile = buildIosConfigurationProfile(state, now);
  assert.match(enabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(enabledProfile, /com\.zohocorp\.mdm/);
  assert.match(enabledProfile, /com\.burbn\.instagram/);
  assert.match(enabledProfile, /com\.google\.ios\.youtube/);
  assert.match(enabledProfile, /com\.toyopagroup\.picaboo/);
  assert.doesNotMatch(enabledProfile, /com\.google\.chrome\.ios/);
  assert.doesNotMatch(enabledProfile, /org\.mozilla\.ios\.Firefox/);
  assert.doesNotMatch(enabledProfile, /Vigil Instagram/);
  assert.doesNotMatch(enabledProfile, /Vigil YouTube/);
  assert.doesNotMatch(enabledProfile, /Vigil Snapchat/);
  assert.match(enabledProfile, /allowAppInstallation/);
  const enabledParsed = recordValue(parsePlist(enabledProfile), "enabled phone profile");
  assert.ok(Array.isArray(enabledParsed.PayloadContent), "enabled phone profile payload content should be an array");
  assert.equal(enabledParsed.PayloadContent.length, 2, "Level 1 must include release controls plus permanent baseline web protection");
  const enabledRestrictions = enabledParsed.PayloadContent
    .map((item) => recordValue(item, "enabled phone payload"))
    .find((payload) => payload.PayloadType === "com.apple.applicationaccess");
  assert.equal(enabledRestrictions?.allowAppInstallation, true);
  assert.equal(enabledRestrictions?.allowAppRemoval, true);
  assert.equal(enabledRestrictions?.allowUIAppInstallation, true);
  assert.equal(enabledRestrictions?.allowEraseContentAndSettings, true);
  assert.ok(Array.isArray(enabledRestrictions?.blockedAppBundleIDs));
  assert.equal((enabledRestrictions?.blockedAppBundleIDs as unknown[]).includes("com.google.chrome.ios"), false, "browsers must stay available behind the managed web filter");
  assert.equal(IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_IDS.some((bundleId) => (enabledRestrictions?.blockedAppBundleIDs as unknown[]).includes(bundleId)), false);
  assert.equal(enabledRestrictions?.allowListedAppBundleIDs, undefined);
  assert.equal(enabledRestrictions?.allowUIConfigurationProfileInstallation, false);
  assert.equal(enabledRestrictions?.allowVPNCreation, false);
  const enabledWebFilter = enabledParsed.PayloadContent
    .map((item) => recordValue(item, "enabled phone web payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
  assert.ok(enabledWebFilter);
  const levelOneDeniedUrls = enabledWebFilter.DenyListURLs as unknown[];
  assert.equal(levelOneDeniedUrls.includes("https://youtube.com/shorts"), true);
  assert.equal(levelOneDeniedUrls.includes("https://snapchat.com/spotlight"), true);
  assert.equal(levelOneDeniedUrls.includes("https://snapchat.com/stories"), true);
  assert.equal(levelOneDeniedUrls.includes("https://pornhub.com/"), true);
  assert.equal(levelOneDeniedUrls.includes("https://www.google.com/search?q=porn"), true);
  assert.equal(levelOneDeniedUrls.includes("https://duckduckgo.com/?q=nsfw"), true);
  assert.equal(webClipPayloads(enabledParsed).length, 0, "dynamic enforcement profile must not own launcher icons");
  const enabledSummary = iosProfileSummary(state, now);
  assert.equal(enabledSummary.profile.appBundleCount, 10);
  assert.ok(enabledSummary.profile.deniedUrlCount > 0);
  assert.equal(enabledSummary.profile.enforcementActive, false);
  assert.equal(enabledSummary.profile.protectionActive, true);
  assert.equal(enabledSummary.allowSafariHistoryClearing, true);
  assert.deepEqual(enabledSummary.profile.managedHelperAppBundleIds, []);
  assert.deepEqual(enabledSummary.manageEngine.managedHelperAppBundleIds, []);
  assert.equal(enabledSummary.profile.focusedSocial.nativeAppBundleCount, 0);
  assert.equal(enabledSummary.profile.webClipCount, 0);
  assert.equal(enabledSummary.profile.focusedSocial.webClipCount, 0);
  assert.equal(enabledSummary.companionApps.appCount, 2);
  assert.deepEqual(enabledSummary.companionApps.labels, ["Instagram", "YouTube"]);
  assert.deepEqual(enabledSummary.companionApps.bundleIds, Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS));
  assert.deepEqual(enabledSummary.companionApps.apps, IOS_SOCIAL_COMPANION_APPS.map((app) => ({ ...app })));
  assert.equal(enabledSummary.launcherProfile.identifier, IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER);
  assert.equal(enabledSummary.launcherProfile.retired, true);
  assert.equal(enabledSummary.launcherProfile.webClipCount, 0);
  assert.equal(enabledSummary.profile.focusedSocialEnforcementActive, false);
  assert.equal(enabledSummary.appStoreAllowedByThisProfile, true);
  assert.equal(enabledSummary.appStoreRestrictionKeysEmitted, false);
  assert.equal(enabledSummary.protection.appWorkaroundsClosed, true);
  assert.equal(enabledSummary.protection.allAppsHidden, false);
  assert.equal(enabledSummary.protection.explicitSearchesBlocked, true);
  assert.equal(enabledSummary.protection.explicitSearchTermCount, 22);
  assert.equal(enabledSummary.manageEngine.deliveryProvider, "manageengine");
  assert.equal(enabledSummary.manageEngine.preferred, true);
  assert.equal(enabledSummary.manageEngine.exportCommand, "npm run ios:manageengine:export");
  const enabledParsedAgain = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "repeat enabled phone profile");
  assert.equal(enabledParsedAgain.PayloadUUID, enabledParsed.PayloadUUID);
  assert.deepEqual(payloadUuidMap(enabledParsedAgain), payloadUuidMap(enabledParsed));

  state.activeSessions.phone = {
    id: "phone-strict",
    title: "Phone strict",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"]
  };
  const activePhoneProfile = buildIosConfigurationProfile(state, now);
  assert.match(activePhoneProfile, /blockedAppBundleIDs/);
  assert.match(activePhoneProfile, /com\.google\.ios\.youtube/);
  const activePhoneParsed = recordValue(parsePlist(activePhoneProfile), "active phone profile");
  assert.equal(activePhoneParsed.DurationUntilRemoval, undefined, "timed restrictions must not auto-remove the always-on protection profile");
  const activePhoneSummary = iosProfileSummary(state, now);
  assert.equal(activePhoneSummary.profile.focusedSocial.nativeAppBundleCount, 0);

  state.activeSessions.phone = {
    id: "phone-soft-ios",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  const softPhoneProfile = buildIosConfigurationProfile(state, now);
  assert.match(softPhoneProfile, /blockedAppBundleIDs/);
  assert.match(softPhoneProfile, /com\.burbn\.instagram/);
  assert.match(softPhoneProfile, /com\.google\.ios\.youtube/);
  assert.match(softPhoneProfile, /com\.toyopagroup\.picaboo/);
  assert.doesNotMatch(softPhoneProfile, /com\.apple\.webClip\.managed/);
  assert.doesNotMatch(softPhoneProfile, /Vigil Instagram/);
  assert.doesNotMatch(softPhoneProfile, /Vigil YouTube/);
  assert.doesNotMatch(softPhoneProfile, /Vigil Snapchat/);
  assert.match(softPhoneProfile, /instagram\.com\/reel/);
  assert.match(softPhoneProfile, /instagram\.com\/explore/);
  assert.match(softPhoneProfile, /snapchat\.com\/spotlight/);
  assert.match(softPhoneProfile, /story\.snapchat\.com/);
  const softPhoneSummary = iosProfileSummary(state, now);
  assert.equal(softPhoneSummary.profile.focusedSocial.nativeAppBundleCount, 2);
  assert.equal(softPhoneSummary.profile.focusedSocialEnforcementActive, true);
  assert.equal(softPhoneSummary.appStoreAllowedByThisProfile, true);
  assert.doesNotMatch(softPhoneProfile, /allowAppInstallation/);

  const instagramPhoneUsage: UsageState = {};
  syncDeviceUsageSnapshot(instagramPhoneUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 20 * 60,
    apps: { "com.burbn.instagram": 20 * 60 },
    sites: { "instagram.com": 20 * 60 }
  }, now);
  assert.equal(activeLimitPolicy(state, instagramPhoneUsage, { app: "com.burbn.instagram", hostname: "instagram.com", device: "phone" }, now), null);
  const softInstagramProfile = buildIosConfigurationProfile(state, now);
  assert.match(softInstagramProfile, /com\.burbn\.instagram/);

  const phoneUsage: UsageState = {};
  syncDeviceUsageSnapshot(phoneUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 20 * 60,
    apps: { "com.google.ios.youtube": 20 * 60 },
    sites: { "youtube.com": 20 * 60 }
  }, now);
  const softYoutubePolicy = must(activeLimitPolicy(state, phoneUsage, { app: "com.google.ios.youtube", hostname: "youtube.com", device: "phone" }, now), "soft lock YouTube limit policy");
  assert.equal(softYoutubePolicy.session.ruleId, "soft-lock-youtube-20-20-template");
  const softYoutubeProfile = buildIosConfigurationProfile(state, now);
  assert.match(softYoutubeProfile, /com\.google\.ios\.youtube/);
  const softYoutubeParsed = recordValue(parsePlist(softYoutubeProfile), "soft YouTube active profile");
  const softYoutubeRestrictions = profilePayload(softYoutubeParsed, "com.apple.applicationaccess");
  assert.ok((softYoutubeRestrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.ios.youtube"), "active Soft Lock YouTube rest should hide YouTube through MDM");
  const softYoutubeWebFilter = profilePayload(softYoutubeParsed, "com.apple.webcontent-filter");
  assert.ok((softYoutubeWebFilter?.DenyListURLs as unknown[] | undefined)?.includes("https://youtube.com/"), "active Soft Lock YouTube rest should deny regular YouTube web URLs");
  assert.equal(softYoutubeWebFilter?.SafariHistoryRetentionEnabled, false);

  state.activeSessions.phone = null;
  const contextReleasedProfile = buildIosConfigurationProfile(state, now);
  assert.match(contextReleasedProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(contextReleasedProfile, /com\.google\.chrome\.ios/);
  assert.match(contextReleasedProfile, /DenyListURLs/);
  assert.match(contextReleasedProfile, /youtube\.com\/shorts/);
  assert.doesNotMatch(contextReleasedProfile, /<string>https:\/\/youtube\.com\/<\/string>/);
  state.limitBlocks = [{
    id: "phone-limit-only",
    ruleId: "phone-limit-only",
    ruleName: "Phone YouTube limit",
    type: "time",
    lockLevel: "deep",
    apps: ["com.google.ios.youtube"],
    sites: ["youtube.com"],
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + 20 * 60_000).toISOString(),
    deviceTargets: ["phone"]
  }];
  const limitOnlyProfile = buildIosConfigurationProfile(state, now);
  const limitOnlyParsed = recordValue(parsePlist(limitOnlyProfile), "limit-only phone profile");
  const limitOnlyRestrictions = profilePayload(limitOnlyParsed, "com.apple.applicationaccess");
  assert.ok((limitOnlyRestrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.ios.youtube"));
  assert.equal((limitOnlyRestrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.chrome.ios"), false);
  const limitOnlyWebFilter = profilePayload(limitOnlyParsed, "com.apple.webcontent-filter");
  assert.ok((limitOnlyWebFilter?.DenyListURLs as unknown[] | undefined)?.includes("https://youtube.com/"));
  assert.ok((limitOnlyWebFilter?.DenyListURLs as unknown[] | undefined)?.includes("https://www.google.com/search?q=porn"), "standalone time limits must preserve permanent explicit-search protection");
  assert.ok((limitOnlyWebFilter?.DenyListURLs as unknown[] | undefined)?.includes("https://youtube.com/shorts"), "standalone time limits must preserve permanent Shorts protection");
  assert.match(limitOnlyProfile, /com\.burbn\.instagram/);
  state.limitBlocks = [];
  assert.equal(activeLimitPolicy(state, phoneUsage, { app: "com.google.ios.youtube", hostname: "youtube.com", device: "phone" }, now), null);
  const normalYoutubeProfile = buildIosConfigurationProfile(state, now);
  assert.match(normalYoutubeProfile, /com\.google\.ios\.youtube/);
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.settings.adultBlocklistPreloadLimit = 5;
  const source = ADULT_BLOCKLIST_SOURCES[0];
  setAdultBlocklistDomainsForTest(
    Array.from({ length: 300 }, (_, index) => `adult-${index}.example.test`),
    source
  );
  try {
    const summary = iosProfileSummary(state, now);
    assert.equal(summary.protection.knownSiteDomainCount, 5 + DEFAULT_PRIORITY_ADULT_BLOCKED_SITES.length, "phone count must describe every adult domain embedded in its profile");
    assert.notEqual(summary.protection.knownSiteDomainCount, 300, "phone count must not reuse the full desktop blocklist count");
  } finally {
    clearAdultBlocklistCacheForTest();
  }
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.settings.adultBlocklistPreloadLimit = 500;
  const policyUrls = Array.from({ length: 30 }, (_, index) => `https://policy-priority-${index}.example.test/path`);
  const userUrls = Array.from({ length: 500 }, (_, index) => `https://user-priority-${index}.example.test/path`);
  const baseline = profileById(state, state.settings.baselineProfileId);
  assert.ok(baseline);
  baseline.blockedUrlPatterns.push(...policyUrls);
  state.deviceControls.ios.deniedUrls = userUrls;
  setAdultBlocklistDomainsForTest(
    Array.from({ length: 500 }, (_, index) => `adult-priority-${index}.bulk.test`),
    ADULT_BLOCKLIST_SOURCES[0]
  );
  try {
    const parsed = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "capped deny-list profile");
    const webFilter = profilePayload(parsed, "com.apple.webcontent-filter");
    const deniedUrls = webFilter?.DenyListURLs as unknown[] | undefined;
    assert.ok(Array.isArray(deniedUrls));
    assert.equal(deniedUrls.length, 500, "Apple's built-in web filter deny list must never exceed 500 URLs");
    assert.equal(deniedUrls.includes("https://www.google.com/search?q=porn"), true, "permanent explicit-search protection must have first priority");
    assert.equal(deniedUrls.includes("https://archive.org/search?query=porn"), true, "Internet Archive search must retain permanent explicit-query protection");
    assert.equal(deniedUrls.includes("https://archive.org/advancedsearch.php?q=porn"), true, "Internet Archive advanced search must retain permanent explicit-query protection");
    assert.equal(deniedUrls.includes("https://youtube.com/shorts"), true, "permanent default protection must have first priority");
    assert.equal(deniedUrls.includes("https://honeytoon.com/"), true, "named explicit comic sites must be retained ahead of the bulk adult preload");
    assert.equal(deniedUrls.includes("https://toongod.org/"), true, "known Toongod domains must be retained ahead of the bulk adult preload");
    assert.equal(deniedUrls.includes(policyUrls.at(-1)), true, "policy URLs must be retained ahead of user and bulk adult entries");
    assert.equal(deniedUrls.includes(userUrls[0]), true, "user-configured URLs must be retained ahead of the bulk adult preload");
    assert.equal(deniedUrls.includes("https://adult-priority-0.bulk.test/"), false, "bulk adult entries must yield when higher-priority protections fill Apple's limit");
  } finally {
    clearAdultBlocklistCacheForTest();
  }
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.settings.baselineProfileId = BRICK_MODE_PROFILE_ID;
  state.deviceControls.ios.mode = "allowlist";
  state.deviceControls.ios.webMode = "allowlist";
  state.deviceControls.ios.allowedAppBundleIds = ["com.apple.Preferences"];
  state.deviceControls.ios.allowedUrls = ["https://baseline-allowed.test/"];
  state.deviceControls.ios.deniedUrls = ["https://baseline-denied.test/"];
  state.limitBlocks = [{
    id: "allowlist-baseline-phone-limit",
    ruleId: "allowlist-baseline-phone-limit",
    ruleName: "Phone YouTube limit",
    type: "time",
    lockLevel: "deep",
    apps: ["com.google.ios.youtube"],
    sites: ["youtube.com"],
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + 20 * 60_000).toISOString(),
    deviceTargets: ["phone"]
  }];

  const summary = iosProfileSummary(state, now);
  assert.equal(summary.profile.enforcementActive, true);
  assert.equal(summary.profile.appBundleCount, 10);
  assert.ok(summary.profile.deniedUrlCount > 0);
  assert.equal(summary.profile.allowedUrlCount, 0);

  const parsed = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "allowlist baseline limit-only profile");
  const restrictions = profilePayload(parsed, "com.apple.applicationaccess");
  assert.ok((restrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.ios.youtube"));
  assert.equal((restrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.chrome.ios"), false);
  assert.equal(restrictions?.allowListedAppBundleIDs, undefined);
  const webFilter = profilePayload(parsed, "com.apple.webcontent-filter");
  assert.ok((webFilter?.DenyListURLs as unknown[] | undefined)?.includes("https://youtube.com/"));
  assert.equal(webFilter?.AllowListBookmarks, undefined);
  assert.equal((webFilter?.DenyListURLs as unknown[]).includes("https://baseline-denied.test/"), true, "standalone time limits must preserve configured permanent URL blocks");
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  const baseline = must(
    profileById(state, state.settings.baselineProfileId),
    "iPhone baseline profile"
  );
  baseline.mode = "allowlist";
  baseline.blockedSites = ["baseline-policy-denied.test"];
  baseline.blockedUrlPatterns = ["baseline-policy-path.test/private"];
  baseline.allowedSites = ["baseline-policy-allowed.test"];
  state.activeSessions.phone = {
    id: "active-phone-projection",
    title: "Active phone projection",
    mode: "focus",
    profileId: "active-phone-projection",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: {
      id: "active-phone-projection",
      name: "Active phone projection",
      mode: "allowlist",
      blockedApps: [],
      blockedSites: ["active-phone-denied.test"],
      blockedUrlPatterns: ["active-phone-path.test/private"],
      allowedApps: [],
      allowedSites: ["active-phone-allowed.test"]
    }
  };

  const activeTargets = iosPolicyTargets(state, now);
  assert.equal(activeTargets.deniedUrls.includes("https://baseline-policy-denied.test/"), true, "active phone policies must retain baseline site denies");
  assert.equal(activeTargets.deniedUrls.includes("https://baseline-policy-path.test/private"), true, "active phone policies must retain baseline URL-pattern denies");
  assert.equal(activeTargets.deniedUrls.includes("https://active-phone-denied.test/"), true);
  assert.equal(activeTargets.deniedUrls.includes("https://active-phone-path.test/private"), true);
  assert.equal(activeTargets.allowedUrls.includes("https://active-phone-allowed.test/"), true);
  assert.equal(activeTargets.allowedUrls.includes("https://baseline-policy-allowed.test/"), false, "an active phone allowlist must not inherit baseline allowed sites");

  state.activeSessions.phone = null;
  state.limitBlocks = [{
    id: "baseline-projection-phone-limit",
    ruleId: "baseline-projection-phone-limit",
    ruleName: "Baseline projection phone limit",
    type: "time",
    lockLevel: "deep",
    apps: ["com.google.ios.youtube"],
    sites: ["youtube.com"],
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + 20 * 60_000).toISOString(),
    deviceTargets: ["phone"]
  }];
  const limitTargets = iosPolicyTargets(state, now);
  assert.equal(limitTargets.webMode, "denylist");
  assert.equal(limitTargets.deniedUrls.includes("https://baseline-policy-denied.test/"), true, "standalone phone limits must retain baseline site denies");
  assert.equal(limitTargets.deniedUrls.includes("https://baseline-policy-path.test/private"), true, "standalone phone limits must retain baseline URL-pattern denies");
  assert.deepEqual(limitTargets.allowedUrls, [], "standalone phone limits must not inherit baseline allowed sites");
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  const baseline = must(
    profileById(state, state.settings.baselineProfileId),
    "overflow baseline profile"
  );
  const baselineOverflowPatterns = Array.from(
    { length: 400 },
    (_, index) => `a-baseline-overflow-${String(index).padStart(3, "0")}.example.test/path`
  );
  baseline.blockedSites = [];
  baseline.blockedUrlPatterns = baselineOverflowPatterns;
  state.activeSessions.phone = {
    id: "active-phone-cap-priority",
    title: "Active phone cap priority",
    mode: "focus",
    profileId: "active-phone-cap-priority",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: {
      id: "active-phone-cap-priority",
      name: "Active phone cap priority",
      mode: "allowlist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: ["zzzz-active-priority.example.test/path"],
      allowedApps: [],
      allowedSites: ["active-phone-allowed.test"]
    }
  };

  const targets = iosPolicyTargets(state, now);
  assert.equal(targets.deniedUrls.length, 500, "active and baseline policy URLs must still obey Apple's deny-list cap");
  assert.equal(
    targets.deniedUrls.includes("https://zzzz-active-priority.example.test/path"),
    true,
    "active policy denies must be retained ahead of alphabetically earlier baseline overflow"
  );
  assert.equal(
    targets.deniedUrls.includes(`https://${baselineOverflowPatterns.at(-1)}`),
    false,
    "baseline overflow must yield after active policy denies"
  );
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.focusedSocial.youtube.shorts = false;
  state.activeSessions.phone = {
    id: "phone-custom-shorts",
    title: "Custom phone Shorts block",
    mode: "focus",
    profileId: "custom-phone",
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: {
      id: "custom-phone",
      name: "Custom phone",
      mode: "blocklist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: ["youtube.com/shorts"],
      allowedApps: [],
      allowedSites: []
    }
  };
  const profile = buildIosConfigurationProfile(state, now);
  const parsedProfile = recordValue(parsePlist(profile), "custom Shorts profile");
  assert.ok(Array.isArray(parsedProfile.PayloadContent), "profile payload content should be an array");
  const webFilter = parsedProfile.PayloadContent
    .map((item) => recordValue(item, "custom Shorts payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
  assert.ok(webFilter, "custom Shorts profile should include a web filter");
  assert.ok(Array.isArray(webFilter.DenyListURLs), "custom Shorts profile should include denied URLs");
  assert.equal(webFilter.DenyListURLs.includes("https://youtube.com/shorts"), true);
  assert.equal(webFilter.DenyListURLs.includes("https://www.youtube.com/shorts"), false, "Apple normalizes bare and www hosts, so the redundant twin must not consume a slot");
  assert.equal(webFilter.DenyListURLs.includes("https://youtube.com/shorts/"), true, "permanent Shorts variants must survive custom profile snapshots");
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.allowedAppBundleIds = ["com.apple.Preferences"];
  state.activeSessions.phone = {
    id: "phone-brick-web-clips",
    title: "Phone Brick",
    mode: "brick",
    profileId: BRICK_MODE_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, BRICK_MODE_PROFILE_ID)
  };
  const summary = iosProfileSummary(state, now);
  assert.equal(summary.profile.webClipCount, 0);
  assert.equal(summary.launcherProfile.webClipCount, 0);
  assert.equal(summary.companionApps.appCount, 2);
  assert.equal(summary.appStoreAllowedByThisProfile, true);
  const profile = buildIosConfigurationProfile(state, now);
  const parsedProfile = recordValue(parsePlist(profile), "brick web clip profile");
  assert.ok(Array.isArray(parsedProfile.PayloadContent), "brick profile payload content should be an array");
  const brickRestrictions = profilePayload(parsedProfile, "com.apple.applicationaccess");
  assert.ok(Array.isArray(brickRestrictions?.blockedAppBundleIDs), "Level 3 should use a targeted social-app denylist");
  const brickBlockedApps = brickRestrictions?.blockedAppBundleIDs as unknown[];
  assert.equal(brickBlockedApps.includes(IOS_APP_STORE_BUNDLE_ID), false);
  assert.equal(Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS).every((bundleId) => brickBlockedApps.includes(bundleId)), true);
  assert.equal(brickBlockedApps.includes("com.google.ios.youtube"), true);
  assert.equal(brickBlockedApps.includes("com.burbn.instagram"), true);
  assert.equal(brickRestrictions?.allowListedAppBundleIDs, undefined);
  assert.equal(brickRestrictions?.allowAppInstallation, undefined);
  const webFilter = parsedProfile.PayloadContent
    .map((item) => recordValue(item, "brick web clip payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
  assert.ok(webFilter, "brick web clip profile should include a web filter");
  assert.equal(webFilter.AllowListBookmarks, undefined, "Full Brick must not turn unrelated web access into an allowlist");
  assert.ok(Array.isArray(webFilter.DenyListURLs), "Level 3 should keep targeted social and explicit-content denies");
  assert.equal(webFilter.DenyListURLs.includes("https://youtube.com/shorts"), true);
  assert.equal(webFilter.DenyListURLs.includes("https://instagram.com/"), true);
  assert.equal(webFilter.SafariHistoryRetentionEnabled, false);
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.blockApps = false;
  state.deviceControls.ios.blockWeb = false;
  state.deviceControls.ios.allowedAppBundleIds = [
    "com.apple.AppStore",
    "com.google.chrome.ios",
    "com.google.ios.youtube",
    IOS_SOCIAL_COMPANION_BUNDLE_IDS.instagram,
    IOS_SOCIAL_COMPANION_BUNDLE_IDS.youtube
  ];
  state.deviceControls.ios.allowedUrls = [
    "https://instagram.com/",
    "https://youtube.com/"
  ];
  state.panicLock = {
    id: "phone-panic-lockout",
    title: "Panic Lockout",
    mode: "panic",
    profileId: PANIC_LOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 3 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "panic",
    fullLockout: true,
    profileSnapshot: panicLockProfile()
  };

  const summary = iosProfileSummary(state, now);
  assert.equal(summary.profile.enforcementActive, true);
  assert.equal(summary.profile.appBundleCount, IOS_PANIC_ALLOWED_APP_BUNDLE_IDS.length);
  assert.equal(summary.profile.allowedUrlCount, 4);
  assert.equal(summary.profile.deniedUrlCount, 0);
  assert.equal(summary.protection.allAppsHidden, true);
  assert.equal(summary.appStoreAllowedByThisProfile, false);

  const parsed = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "panic phone profile");
  const restrictions = profilePayload(parsed, "com.apple.applicationaccess");
  assert.ok(Array.isArray(restrictions?.allowListedAppBundleIDs), "Panic must enforce a minimal app allowlist even when app blocking is disabled");
  const panicAllowedApps = restrictions?.allowListedAppBundleIDs as string[];
  assert.deepEqual([...panicAllowedApps].sort(), [...IOS_PANIC_ALLOWED_APP_BUNDLE_IDS].sort());
  assert.equal(restrictions?.blockedAppBundleIDs, undefined);
  assert.equal(panicAllowedApps.includes(IOS_APP_STORE_BUNDLE_ID), false);

  const unavailableBrowserBundles = ["com.apple.mobilesafari", ...IOS_SYSTEM_FILTERED_BROWSER_BUNDLE_IDS];
  assert.equal(unavailableBrowserBundles.every((bundleId) => !panicAllowedApps.includes(bundleId)), true, "Panic must make Safari and third-party browsers unavailable");
  const unavailableSocialBundles = [
    "com.burbn.instagram",
    "com.google.ios.youtube",
    "com.toyopagroup.picaboo",
    ...Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS)
  ];
  assert.equal(unavailableSocialBundles.every((bundleId) => !panicAllowedApps.includes(bundleId)), true, "Panic must make native social apps and both fixed companions unavailable");

  const webFilter = profilePayload(parsed, "com.apple.webcontent-filter");
  assert.ok(Array.isArray(webFilter?.AllowListBookmarks), "Panic must enforce a URL allowlist even when web blocking is disabled");
  const panicAllowedUrls = (webFilter?.AllowListBookmarks as unknown[])
    .map((item) => recordValue(item, "panic allowlist bookmark"))
    .map((bookmark) => stringValue(bookmark.URL, "panic allowlist URL"))
    .sort();
  assert.deepEqual(panicAllowedUrls, [
    "http://127.0.0.1/",
    "http://localhost/",
    "https://127.0.0.1/",
    "https://localhost/"
  ]);
  for (const authenticationURL of [
    "https://consent.youtube.com/",
    "https://accounts.youtube.com/accounts/SetSID",
    "https://accounts.youtube.com/accounts/CheckConnection",
    "https://accounts.youtube.com/RotateCookiesPage"
  ]) {
    assert.equal(panicAllowedUrls.includes(authenticationURL), false,
      `Panic must not admit the YouTube authentication URL ${authenticationURL}`);
  }
  assert.equal(webFilter?.DenyListURLs, undefined);
  assert.equal(panicAllowedUrls.some((url) => /instagram|youtube|snapchat/i.test(url)), false);
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.allowedAppBundleIds = [
    "com.apple.mobilemail",
    "com.google.ios.youtube"
  ];
  state.deviceControls.ios.allowedUrls = [
    "https://work.example.test/",
    "https://youtube.com/watch",
    "https://youtu.be/"
  ];
  const customAllowlistProfile = {
    ...profileById(state, BRICK_MODE_PROFILE_ID),
    id: "custom-phone-allowlist",
    name: "Custom phone allowlist",
    mode: "allowlist" as const,
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: ["work.example.test", "youtube.com", "youtu.be"]
  };
  state.profiles.push(customAllowlistProfile);
  state.activeSessions.phone = {
    id: "phone-brick-with-youtube-limit",
    title: "Phone Brick with YouTube limit",
    mode: "brick",
    profileId: customAllowlistProfile.id,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: customAllowlistProfile
  };
  const activeYouTubeTargets = iosPolicyTargets(state, now);
  assert.equal(activeYouTubeTargets.webMode, "allowlist");
  for (const authenticationURL of [
    "https://consent.youtube.com/",
    "https://accounts.youtube.com/accounts/SetSID",
    "https://accounts.youtube.com/accounts/CheckConnection",
    "https://accounts.youtube.com/RotateCookiesPage"
  ]) {
    assert.equal(
      activeYouTubeTargets.allowedUrls.includes(authenticationURL),
      true,
      `the supervised YouTube companion allowlist must include ${authenticationURL}`
    );
  }
  assert.equal(
    activeYouTubeTargets.allowedUrls.includes("https://accounts.youtube.com/"),
    false,
    "the supervised YouTube companion allowlist must not open the whole accounts.youtube.com origin"
  );
  assert.equal(
    activeYouTubeTargets.deniedUrls.includes("https://youtube.com/shorts"),
    true,
    "admitting YouTube authentication helpers must preserve the permanent Shorts deny rule"
  );
  state.limitRules = [{
    id: "brick-youtube-limit",
    name: "Brick YouTube limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: ["com.google.ios.youtube"],
    sites: ["youtube.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 20,
    requiredProfileId: customAllowlistProfile.id
  }];
  const usage: UsageState = {};
  syncDeviceUsageSnapshot(usage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 60,
    apps: { "com.google.ios.youtube": 60 },
    sites: { "youtube.com": 60 }
  }, now);
  const reachedLimit = must(activeLimitPolicy(state, usage, {
    app: "com.google.ios.youtube",
    hostname: "youtube.com",
    device: "phone"
  }, now), "active allowlist YouTube limit policy");
  assert.equal(reachedLimit.kind, "limit");

  const parsed = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "active allowlist profile with reached YouTube limit");
  const restrictions = profilePayload(parsed, "com.apple.applicationaccess");
  const allowedApps = restrictions?.allowListedAppBundleIDs as unknown[];
  assert.ok(Array.isArray(allowedApps), "active allowlist should remain an app allowlist");
  assert.equal(allowedApps.includes("com.google.ios.youtube"), false, "the reached app limit must override the active allowlist");
  assert.equal(allowedApps.includes("com.apple.mobilemail"), true, "unrelated allowed apps must remain available");
  assert.equal(allowedApps.includes(IOS_SOCIAL_COMPANION_BUNDLE_IDS.instagram), false, "custom allowlists must not gain unrelated social companions");
  assert.equal(restrictions?.blockedAppBundleIDs, undefined, "a reached limit must not convert the active app allowlist into a denylist");

  const webFilter = profilePayload(parsed, "com.apple.webcontent-filter");
  assert.ok(Array.isArray(webFilter?.AllowListBookmarks), "active allowlist should remain a web allowlist");
  const allowedUrls = (webFilter?.AllowListBookmarks as unknown[])
    .map((item) => recordValue(item, "active limit allowlist bookmark"))
    .map((bookmark) => stringValue(bookmark.URL, "active limit allowlist URL"));
  assert.equal(allowedUrls.some((url) => ["youtube.com", "youtu.be", "youtube-nocookie.com"].some((host) => {
    const allowedHost = new URL(url).hostname.replace(/^www\./, "");
    return allowedHost === host || allowedHost.endsWith(`.${host}`);
  })), false, "the reached site limit and its aliases must not remain in the URL allowlist");
  for (const authenticationURL of [
    "https://consent.youtube.com/",
    "https://accounts.youtube.com/accounts/SetSID",
    "https://accounts.youtube.com/accounts/CheckConnection",
    "https://accounts.youtube.com/RotateCookiesPage"
  ]) {
    assert.equal(allowedUrls.includes(authenticationURL), false,
      `a reached YouTube limit must remove the companion authentication URL ${authenticationURL}`);
  }
  assert.equal(allowedUrls.includes("https://work.example.test/"), true, "unrelated explicitly allowed sites must remain available");
  assert.equal(allowedUrls.includes("https://www.instagram.com/"), true, "the limit must not remove unrelated social sites");
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.allowSafariHistoryClearing = false;
  state.activeSessions.phone = {
    id: "phone-history-retention",
    title: "Phone history retention",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  const profile = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "history retention profile");
  assert.equal(profilePayload(profile, "com.apple.webcontent-filter")?.SafariHistoryRetentionEnabled, true);
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.blockedAppBundleIds = [IOS_APP_STORE_BUNDLE_ID];
  state.activeSessions.phone = {
    id: "phone-explicit-app-store-block",
    title: "Explicit App Store block",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, "default")
  };
  const summary = iosProfileSummary(state, now);
  assert.equal(summary.appStoreVisibleByAppList, false);
  assert.equal(summary.appStoreAllowedByThisProfile, false);
  const profile = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "explicit App Store block profile");
  const blockedApps = profilePayload(profile, "com.apple.applicationaccess")?.blockedAppBundleIDs as unknown[];
  assert.equal(blockedApps.includes(IOS_APP_STORE_BUNDLE_ID), true);
}

{
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.focusedSocial.forceWebClips = false;
  const summary = iosProfileSummary(state, now);
  assert.equal(summary.profile.webClipCount, 0);
  assert.equal(summary.profile.focusedSocial.webClipCount, 0);
  assert.equal(summary.profile.focusedSocial.nativeAppBundleCount, 0);
  assert.equal(summary.launcherProfile.webClipCount, 0);
  assert.equal(summary.companionApps.appCount, 2);
  const profile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(profile, /com\.apple\.webClip\.managed/);
  assert.doesNotMatch(profile, /Vigil YouTube/);
  assert.doesNotMatch(profile, /Vigil Snapchat/);
  assert.doesNotMatch(profile, /Vigil Instagram/);
  assert.match(profile, /com\.google\.ios\.youtube/);
  assert.match(profile, /com\.toyopagroup\.picaboo/);
  assert.match(profile, /com\.burbn\.instagram/);

  state.activeSessions.phone = {
    id: "phone-soft-no-web-clips",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  const softProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(softProfile, /com\.apple\.webClip\.managed/);
  assert.doesNotMatch(softProfile, /Vigil YouTube/);
  assert.doesNotMatch(softProfile, /Vigil Snapchat/);
  assert.doesNotMatch(softProfile, /Vigil Instagram/);
  assert.match(softProfile, /instagram\.com\/reel/);
}

{
  const noWebState = defaultState();
  noWebState.deviceControls.ios.enabled = true;
  noWebState.deviceControls.ios.blockWeb = false;
  noWebState.activeSessions.phone = {
    id: "phone-apps-only",
    title: "Phone apps only",
    mode: "focus",
    profileId: "default",
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(noWebState, "default")
  };
  const noWebSummary = iosProfileSummary(noWebState, now);
  assert.equal(noWebSummary.profile.deniedUrlCount, 0);
  assert.equal(noWebSummary.profile.allowedUrlCount, 0);
  assert.equal(noWebSummary.profile.webClipCount, 0);
  assert.equal(noWebSummary.launcherProfile.webClipCount, 0);
  assert.equal(noWebSummary.companionApps.appCount, 2);
  assert.equal(noWebSummary.profile.focusedSocial.deniedUrlCount, 0);
  assert.equal(noWebSummary.profile.focusedSocial.webClipCount, 0);
  const noWebProfile = buildIosConfigurationProfile(noWebState, now);
  assert.doesNotMatch(noWebProfile, /com\.apple\.webClip\.managed/);
  assert.doesNotMatch(noWebProfile, /DenyListURLs/);
  assert.match(noWebProfile, /blockedAppBundleIDs/);

  const noAppsState = defaultState();
  noAppsState.deviceControls.ios.enabled = true;
  noAppsState.deviceControls.ios.blockApps = false;
  const noAppsSummary = iosProfileSummary(noAppsState, now);
  assert.equal(noAppsSummary.profile.appBundleCount, 0);
  assert.deepEqual(noAppsSummary.profile.managedHelperAppBundleIds, []);
  assert.equal(noAppsSummary.profile.focusedSocial.nativeAppBundleCount, 0);
  const noAppsProfile = buildIosConfigurationProfile(noAppsState, now);
  assert.doesNotMatch(noAppsProfile, /blockedAppBundleIDs/);
  assert.match(noAppsProfile, /DenyListURLs/);
  assert.match(noAppsProfile, /youtube\.com\/shorts/);
}

{
  const roundTrip = recordValue(parsePlist(toPlist({
    MessageType: "TokenUpdate",
    Count: 2,
    Enabled: true,
    Token: plistData(Buffer.from("hello"))
  })), "round-trip plist");
  assert.equal(roundTrip.MessageType, "TokenUpdate");
  assert.equal(roundTrip.Count, 2);
  assert.equal(roundTrip.Enabled, true);
  assert.equal(recordValue(roundTrip.Token, "plist token").__plistData, Buffer.from("hello").toString("base64"));

  const state = defaultState();
  const unconfiguredDoctor = iosMdmDoctor(state, now);
  assert.ok(unconfiguredDoctor.blockers.map((item) => item.code).includes("missing-push-certificate-payload"));
  try {
    buildIosMdmEnrollmentProfile(state);
    assert.fail("unconfigured self-hosted MDM enrollment should not generate a profile");
  } catch (error) {
    assert.equal((error as { status?: number }).status, 409);
    assert.ok(((error as { blockers?: string[] }).blockers || []).some((item) => /public HTTPS URL/i.test(item)));
  }
  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.mdm = {
    ...state.deviceControls.ios.mdm,
    enabled: true,
    publicBaseUrl: "https://mdm.example.test",
    topic: "com.apple.mgmt.vigil-test",
    identityCertificateUuid: "11111111-2222-3333-4444-555555555555",
    identityCertificatePayloadBase64: pkcs12ShapeFixture()
  };
  const summary = iosMdmSummary(state, now);
  assert.equal(summary.enrollmentReady, true);
  assert.equal(summary.ready, false);
  assert.equal(summary.status, "queue-only");
  assert.equal(summary.enrollmentUrl, "/api/devices/ios/mdm/enrollment.mobileconfig");
  const doctor = iosMdmDoctor(state, now);
  assert.equal(doctor.staticProfile.status, "supervised-profile-ready");
  assert.equal(doctor.remoteMdm.enrollmentUrl, summary.enrollmentUrl);
  assert.deepEqual(doctor.blockers.map((item) => item.code), ["missing-push-certificate-payload"]);

  state.deviceControls.ios.mdm.pushCertificatePayloadBase64 = pkcs12ShapeFixture();
  const pushReadySummary = iosMdmSummary(state, now);
  assert.equal(pushReadySummary.ready, true);
  assert.equal(pushReadySummary.pushSupported, true);
  const readyDoctor = iosMdmDoctor(state, now);
  assert.equal(readyDoctor.status, "ready");
  assert.equal(readyDoctor.warnings.some((item) => item.code === "apple-credentials-not-locally-verifiable"), true);

  {
    const legacyState = structuredClone(state);
    const legacySecret = "legacy-enrollment-secret";
    const legacyUdid = "legacy-iphone-udid";
    legacyState.deviceControls.ios.mdm.enrollmentSecret = legacySecret;
    legacyState.deviceControls.ios.mdm.enrollmentTokens = [];
    legacyState.deviceControls.ios.mdm.devices = [{
      id: "legacy-iphone",
      udid: legacyUdid,
      status: "enrolled",
      firstSeenAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      lastSeenAt: now.toISOString()
    }];

    const legacyCheckInUrl = new URL(`https://mdm.example.test/mdm/checkin?token=${legacySecret}`);
    const legacyConnectUrl = new URL(`https://mdm.example.test/mdm/connect?token=${legacySecret}`);
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyCheckInUrl, { UDID: "unknown-legacy-udid" }, now), false, "an unknown device must not use the legacy secret when a device record already exists");
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyCheckInUrl, { UDID: legacyUdid }, now), true, "a recorded legacy device must remain authenticated before token migration");
    legacyState.deviceControls.ios.mdm.devices[0].status = "checked-out";
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyConnectUrl, { UDID: legacyUdid }, now), false, "a checked-out legacy device must not reconnect with the shared secret");
    legacyState.deviceControls.ios.mdm.devices[0].status = "enrolled";

    const firstEnrollmentState = structuredClone(legacyState);
    firstEnrollmentState.deviceControls.ios.mdm.devices = [];
    assert.equal(authorizeIosMdmDeviceRequest(firstEnrollmentState, legacyCheckInUrl, { UDID: "first-legacy-udid" }, now), true, "an empty legacy installation may complete its first pending enrollment");

    const migratedEnrollment = buildIosMdmEnrollmentProfile(legacyState);
    const migratedToken = migratedEnrollment.match(/token=([^<]+)/)?.[1] || "";
    assert.equal(legacyState.deviceControls.ios.mdm.enrollmentTokens.length, 1);

    assert.equal(authorizeIosMdmRequest(legacyState, legacyCheckInUrl, now), false, "generic MDM auth must keep rejecting the legacy secret after one-time tokens exist");
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyCheckInUrl, { UDID: legacyUdid }, now), true, "a recorded legacy device must continue to check in after token migration");
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyConnectUrl, { UDID: legacyUdid }, now), true, "a recorded legacy device must continue to connect after token migration");
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, legacyCheckInUrl, { UDID: "unknown-legacy-udid" }, now), false, "an unknown device must not enroll with the shared legacy secret");

    const oneTimeCheckInUrl = new URL(`https://mdm.example.test/mdm/checkin?token=${migratedToken}`);
    assert.equal(authorizeIosMdmDeviceRequest(legacyState, oneTimeCheckInUrl, { UDID: "new-iphone-udid" }, now), true, "a new device must use its one-time enrollment token");

    const legacyPolicyUrl = new URL(`https://mdm.example.test/mdm/policy.mobileconfig?token=${legacySecret}`);
    assert.equal(authorizeIosMdmRequest(legacyState, legacyPolicyUrl, now), true, "profile download auth must remain on the legacy enrollment secret");
  }

  const enrollment = buildIosMdmEnrollmentProfile(state);
  assert.doesNotMatch(enrollment, /replace-with-public-mdm-host|replace-with-apns-topic/);
  const profileToken = enrollment.match(/token=([^<]+)/)?.[1] || "";
  const profileUrl = new URL(`https://mdm.example.test/mdm/checkin?token=${profileToken}`);
  const pendingEnrollment = must(state.deviceControls.ios.mdm.enrollmentTokens[0], "pending enrollment token");
  pendingEnrollment.createdAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  assert.equal(authorizeIosMdmRequest(state, profileUrl, now), false);
  assert.equal(authorizeIosMdmDeviceRequest(state, profileUrl, { UDID: "iphone-udid-1" }, now), false);
  must(state.deviceControls.ios.mdm.enrollmentTokens[0], "pending enrollment token after normalization").createdAt = now.toISOString();
  assert.equal(authorizeIosMdmRequest(state, profileUrl, now), true);
  assert.equal(authorizeIosMdmDeviceRequest(state, profileUrl, { UDID: "iphone-udid-1" }, now), true);
  assert.equal(authorizeIosMdmDeviceRequest(state, profileUrl, { UDID: "iphone-udid-2" }, now), false);
  must(state.deviceControls.ios.mdm.enrollmentTokens[0], "bound enrollment token").createdAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  assert.equal(authorizeIosMdmRequest(state, profileUrl, now), true, "a token bound to its enrolled device is no longer pending and must survive the pending-token TTL");
  assert.match(enrollment, /com\.apple\.mdm/);
  assert.match(enrollment, /https:\/\/mdm\.example\.test\/mdm\/connect/);
  assert.match(enrollment, /com\.apple\.mgmt\.vigil-test/);
  const enrollmentProfile = recordValue(parsePlist(enrollment), "MDM enrollment profile");
  const enrollmentPayloads = (enrollmentProfile.PayloadContent as unknown[]).map((item) => recordValue(item, "MDM enrollment payload"));
  const mdmPayload = must(enrollmentPayloads.find((payload) => payload.PayloadType === "com.apple.mdm"), "MDM payload");
  assert.equal(mdmPayload.IdentityCertificateUUID, "11111111-2222-3333-4444-555555555555");
  assert.ok(enrollmentPayloads.some((payload) => payload.PayloadType === "com.apple.security.pkcs12"));

  const checkIn = handleIosMdmCheckIn(state, {
    MessageType: "TokenUpdate",
    UDID: "iphone-udid-1",
    Topic: "com.apple.mgmt.vigil-test",
    PushMagic: "push-magic",
    Token: plistData(Buffer.from("push-token"))
  }, now);
  assert.equal(checkIn.messageType, "TokenUpdate");
  assert.equal(state.deviceControls.ios.mdm.devices.length, 1);
  assert.equal(state.deviceControls.ios.mdm.commands.some((command) => command.requestType === "InstallProfile"), true);
  assert.equal(state.deviceControls.ios.mdm.devices[0].tokenHex, Buffer.from("push-token").toString("hex"));
  const usageCredential = must(iosMdmDeviceUsageCredential(state, "iphone-udid-1"), "per-device usage credential");
  assert.equal(usageCredential.deviceId, "iphone-udid-1");
  assert.match(usageCredential.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(iosMdmDeviceUsageCredential(state, "unknown-device"), null);
  const mdmSettings = normalizeIosMdmSettings({}, state.deviceControls.ios.mdm);
  const enrolledDevice = must(mdmSettings.devices[0], "enrolled MDM device");
  const pushRequest = buildIosMdmPushRequest(mdmSettings, enrolledDevice);
  assert.equal(pushRequest.endpoint, "https://api.push.apple.com");
  assert.equal(pushRequest.path, `/3/device/${Buffer.from("push-token").toString("hex")}`);
  assert.equal(pushRequest.headers["apns-topic"], "com.apple.mgmt.vigil-test");
  assert.equal(pushRequest.headers["apns-push-type"], "mdm");
  assert.equal(pushRequest.payload, JSON.stringify({ mdm: "push-magic" }));

  const nextCommandOfType = (requestType: string) => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const command = handleIosMdmConnect(state, { UDID: "iphone-udid-1", Status: "Idle" }, now);
      assert.equal(command.empty, false);
      const commandBody = recordValue(must(command.body, "MDM command body"), "MDM command body");
      const payload = recordValue(commandBody.Command, "MDM command");
      const commandUuid = stringValue(commandBody.CommandUUID, "sent command UUID");
      if (payload.RequestType === requestType) return { commandBody, payload, commandUuid };
      handleIosMdmConnect(state, {
        UDID: "iphone-udid-1",
        Status: "Acknowledged",
        CommandUUID: commandUuid
      }, now);
    }
    throw new Error(`Expected queued ${requestType} command.`);
  };

  const { payload: installCommand, commandUuid: sentCommandUuid } = nextCommandOfType("InstallProfile");
  assert.equal(installCommand.RequestType, "InstallProfile");
  handleIosMdmConnect(state, {
    UDID: "iphone-udid-2",
    Status: "Acknowledged",
    CommandUUID: sentCommandUuid
  }, now);
  assert.notEqual(must(state.deviceControls.ios.mdm.commands.find((item) => item.commandUuid === sentCommandUuid), "cross-device MDM command").status, "acknowledged");
  const acknowledged = handleIosMdmConnect(state, {
    UDID: "iphone-udid-1",
    Status: "Acknowledged",
    CommandUUID: sentCommandUuid
  }, now);
  assert.equal(must(state.deviceControls.ios.mdm.commands.find((item) => item.commandUuid === sentCommandUuid), "acknowledged MDM command").status, "acknowledged");
  assert.equal(acknowledged.empty, false);
  assert.throws(() => handleIosMdmConnect(state, { UDID: "invalid device id with spaces", Status: "Idle" }, now), /identifier/);

  const duplicate = queueIosMdmPolicyRefresh(state, "test-refresh", now, { udids: ["iphone-udid-1"] });
  assert.equal(duplicate.queued >= 0, true);

  state.activeSessions.phone = {
    id: "phone-expiring",
    title: "Expiring phone lock",
    mode: "focus",
    profileId: "default",
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: profileById(state, "default")
  };
  const activeQueue = queueIosMdmPolicyRefresh(state, "active-phone", now, { udids: ["iphone-udid-1"] }) as { profileQueued?: number };
  assert.equal(activeQueue.profileQueued, 1);
  const activeCommand = state.deviceControls.ios.mdm.commands.find((item) => item.reason === "active-phone" && item.requestType === "InstallProfile");
  const activeMdmProfile = parseMdmProfile(activeCommand?.profileBase64);
  assert.ok(profilePayload(activeMdmProfile, "com.apple.applicationaccess")?.blockedAppBundleIDs, "active phone lock should hide blocked apps");

  const afterExpiry = new Date(now.getTime() + 2 * 60 * 1000);
  const expiredQueue = queueIosMdmPolicyRefresh(state, "expired-phone", afterExpiry, { udids: ["iphone-udid-1"] }) as { profileQueued?: number };
  assert.equal(expiredQueue.profileQueued, 1);
  assert.equal(state.activeSessions.phone, null);
  const expiredCommand = state.deviceControls.ios.mdm.commands.find((item) => item.reason === "expired-phone" && item.requestType === "InstallProfile");
  const expiredMdmProfile = parseMdmProfile(expiredCommand?.profileBase64);
  assert.equal(expiredMdmProfile.DurationUntilRemoval, undefined);
  const expiredRestrictions = profilePayload(expiredMdmProfile, "com.apple.applicationaccess");
  assert.equal((expiredRestrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.google.chrome.ios"), false);
  assert.ok((expiredRestrictions?.blockedAppBundleIDs as unknown[] | undefined)?.includes("com.burbn.instagram"));
  assert.equal(expiredRestrictions?.allowListedAppBundleIDs, undefined);

  state.deviceControls.ios.enabled = false;
  const removePolicy = queueIosMdmPolicyRefresh(state, "disable-ios", now, { udids: ["iphone-udid-1"] }) as { profileQueued?: number };
  assert.equal(removePolicy.profileQueued, 1);
  const { payload: removePayload } = nextCommandOfType("RemoveProfile");
  assert.equal(removePayload.RequestType, "RemoveProfile");
  assert.equal(removePayload.Identifier, "tech.caseline.vigil.ios-lock");
}

function parseMdmProfile(profileBase64: unknown): Record<string, unknown> {
  assert.equal(typeof profileBase64, "string");
  const encoded = profileBase64 as string;
  return recordValue(parsePlist(Buffer.from(encoded, "base64").toString("utf8")), "MDM profile payload");
}

function profilePayload(profile: Record<string, unknown>, payloadType: string): Record<string, unknown> | undefined {
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  return profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .find((payload) => payload.PayloadType === payloadType);
}

function webClipPayloads(profile: Record<string, unknown>): Record<string, unknown>[] {
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  return profile.PayloadContent
    .map((item) => recordValue(item, "profile payload"))
    .filter((payload) => payload.PayloadType === "com.apple.webClip.managed");
}

function payloadUuidMap(profile: Record<string, unknown>): Record<string, unknown> {
  assert.ok(Array.isArray(profile.PayloadContent), "profile payload content should be an array");
  return Object.fromEntries(profile.PayloadContent.map((item) => {
    const payload = recordValue(item, "profile payload");
    return [String(payload.PayloadIdentifier || ""), payload.PayloadUUID];
  }));
}

function pkcs12ShapeFixture(): string {
  return Buffer.concat([Buffer.from([0x30, 0x82, 0x00, 0x80]), Buffer.alloc(128, 1)]).toString("base64");
}
