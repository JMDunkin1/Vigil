import assert from "node:assert/strict";
import { BRICK_MODE_PROFILE_ID, defaultState, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { authorizeIosMdmRequest, buildIosMdmEnrollmentProfile, buildIosMdmPushRequest, handleIosMdmCheckIn, handleIosMdmConnect, iosMdmDoctor, iosMdmSummary, normalizeIosMdmSettings, queueIosMdmPolicyRefresh } from "../../src/iosMdm.js";
import { IOS_APP_STORE_BUNDLE_ID, IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER, buildIosConfigurationProfile, buildIosSocialLauncherProfile, iosProfileSummary } from "../../src/iosProfiles.js";
import { IOS_SOCIAL_COMPANION_BUNDLE_IDS } from "../../src/socialFeatureFilters.js";
import { activeLimitPolicy } from "../../src/limits.js";
import { parsePlist, plistData, toPlist } from "../../src/plist.js";
import { profileById } from "../../src/policy.js";
import type { UsageState } from "../../src/types.js";
import { syncDeviceUsageSnapshot } from "../../src/usage.js";
import { must, now, recordValue, stringValue } from "./test-helpers.mjs";

{
  const state = defaultState();
  const disabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(disabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(disabledProfile, /allowAppInstallation/);
  assert.doesNotMatch(disabledProfile, /PayloadRemovalDisallowed<\/key>\s*<true/);

  state.deviceControls.ios.enabled = true;
  const enabledProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(enabledProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(enabledProfile, /com\.zohocorp\.mdm/);
  assert.doesNotMatch(enabledProfile, /com\.burbn\.instagram/);
  assert.doesNotMatch(enabledProfile, /com\.google\.ios\.youtube/);
  assert.doesNotMatch(enabledProfile, /com\.toyopagroup\.picaboo/);
  assert.doesNotMatch(enabledProfile, /Sentinel Instagram/);
  assert.doesNotMatch(enabledProfile, /Sentinel YouTube/);
  assert.doesNotMatch(enabledProfile, /Sentinel Snapchat/);
  assert.match(enabledProfile, /allowAppInstallation/);
  const enabledParsed = recordValue(parsePlist(enabledProfile), "enabled phone profile");
  assert.ok(Array.isArray(enabledParsed.PayloadContent), "enabled phone profile payload content should be an array");
  assert.equal(enabledParsed.PayloadContent.length, 1, "Level 1 profile must contain only the explicit restriction-release payload");
  const enabledRestrictions = enabledParsed.PayloadContent
    .map((item) => recordValue(item, "enabled phone payload"))
    .find((payload) => payload.PayloadType === "com.apple.applicationaccess");
  assert.equal(enabledRestrictions?.allowAppInstallation, true);
  assert.equal(enabledRestrictions?.allowAppRemoval, true);
  assert.equal(enabledRestrictions?.allowUIAppInstallation, true);
  assert.equal(enabledRestrictions?.allowEraseContentAndSettings, true);
  assert.equal(enabledRestrictions?.blockedAppBundleIDs, undefined);
  assert.equal(enabledRestrictions?.allowListedAppBundleIDs, undefined);
  const enabledWebFilter = enabledParsed.PayloadContent
    .map((item) => recordValue(item, "enabled phone web payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
  assert.equal(enabledWebFilter, undefined);
  assert.equal(webClipPayloads(enabledParsed).length, 0, "dynamic enforcement profile must not own launcher icons");
  const launcherProfileText = buildIosSocialLauncherProfile();
  const launcherParsed = recordValue(parsePlist(launcherProfileText), "social launcher profile");
  assert.equal(launcherParsed.PayloadIdentifier, IOS_SOCIAL_LAUNCHER_PROFILE_IDENTIFIER);
  assert.equal(launcherParsed.DurationUntilRemoval, undefined);
  const enabledWebClips = webClipPayloads(launcherParsed);
  assert.deepEqual(enabledWebClips.map((payload) => stringValue(payload.Label, "web clip label")).sort(), ["Instagram", "Snapchat", "YouTube"]);
  for (const payload of enabledWebClips) {
    assert.equal(payload.PayloadDisplayName, payload.Label);
    assert.equal(payload.Precomposed, true);
    const service = String(payload.Label || "").toLowerCase() as keyof typeof IOS_SOCIAL_COMPANION_BUNDLE_IDS;
    assert.equal(payload.TargetApplicationBundleIdentifier, IOS_SOCIAL_COMPANION_BUNDLE_IDS[service]);
    const icon = recordValue(payload.Icon, "web clip icon data");
    assert.equal(typeof icon.__plistData, "string");
    assert.ok(String(icon.__plistData).length > 500, "web clip should include embedded PNG icon data");
  }
  const enabledSummary = iosProfileSummary(state, now);
  assert.equal(enabledSummary.profile.appBundleCount, 0);
  assert.equal(enabledSummary.profile.deniedUrlCount, 0);
  assert.equal(enabledSummary.profile.enforcementActive, false);
  assert.equal(enabledSummary.allowSafariHistoryClearing, true);
  assert.deepEqual(enabledSummary.profile.managedHelperAppBundleIds, []);
  assert.deepEqual(enabledSummary.manageEngine.managedHelperAppBundleIds, []);
  assert.equal(enabledSummary.profile.focusedSocial.nativeAppBundleCount, 0);
  assert.equal(enabledSummary.profile.webClipCount, 0);
  assert.equal(enabledSummary.profile.focusedSocial.webClipCount, 0);
  assert.equal(enabledSummary.launcherProfile.webClipCount, 3);
  assert.equal(enabledSummary.launcherProfile.durationUntilRemoval, false);
  assert.equal(enabledSummary.profile.focusedSocialEnforcementActive, false);
  assert.equal(enabledSummary.appStoreAllowedByThisProfile, true);
  assert.equal(enabledSummary.appStoreRestrictionKeysEmitted, false);
  assert.equal(enabledSummary.manageEngine.deliveryProvider, "manageengine");
  assert.equal(enabledSummary.manageEngine.preferred, true);
  assert.equal(enabledSummary.manageEngine.exportCommand, "npm run ios:manageengine:export");
  const enabledParsedAgain = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "repeat enabled phone profile");
  assert.equal(enabledParsedAgain.PayloadUUID, enabledParsed.PayloadUUID);
  assert.deepEqual(payloadUuidMap(enabledParsedAgain), payloadUuidMap(enabledParsed));
  const launcherParsedAgain = recordValue(parsePlist(buildIosSocialLauncherProfile()), "repeat social launcher profile");
  assert.equal(launcherParsedAgain.PayloadUUID, launcherParsed.PayloadUUID);
  assert.deepEqual(payloadUuidMap(launcherParsedAgain), payloadUuidMap(launcherParsed));

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
  assert.equal(activePhoneParsed.DurationUntilRemoval, 3630);
  const activePhoneSummary = iosProfileSummary(state, now);
  assert.equal(activePhoneSummary.profile.focusedSocial.nativeAppBundleCount, 3);

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
  assert.doesNotMatch(softPhoneProfile, /Sentinel Instagram/);
  assert.doesNotMatch(softPhoneProfile, /Sentinel YouTube/);
  assert.doesNotMatch(softPhoneProfile, /Sentinel Snapchat/);
  assert.match(softPhoneProfile, /instagram\.com\/reel/);
  assert.match(softPhoneProfile, /instagram\.com\/explore/);
  assert.match(softPhoneProfile, /snapchat\.com\/spotlight/);
  assert.match(softPhoneProfile, /story\.snapchat\.com/);
  const softPhoneSummary = iosProfileSummary(state, now);
  assert.equal(softPhoneSummary.profile.focusedSocial.nativeAppBundleCount, 3);
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
  const normalWithLingeringLimitProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(normalWithLingeringLimitProfile, /blockedAppBundleIDs/);
  assert.doesNotMatch(normalWithLingeringLimitProfile, /DenyListURLs/);
  state.limitBlocks = [];
  assert.equal(activeLimitPolicy(state, phoneUsage, { app: "com.google.ios.youtube", hostname: "youtube.com", device: "phone" }, now), null);
  const normalYoutubeProfile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(normalYoutubeProfile, /com\.google\.ios\.youtube/);
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
  assert.equal(webFilter.DenyListURLs.includes("https://www.youtube.com/shorts"), true);
  assert.equal(webFilter.DenyListURLs.includes("https://youtube.com/shorts/"), true);
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
  assert.equal(summary.launcherProfile.webClipCount, 3);
  assert.equal(summary.appStoreAllowedByThisProfile, true);
  const profile = buildIosConfigurationProfile(state, now);
  const parsedProfile = recordValue(parsePlist(profile), "brick web clip profile");
  assert.ok(Array.isArray(parsedProfile.PayloadContent), "brick profile payload content should be an array");
  const brickRestrictions = profilePayload(parsedProfile, "com.apple.applicationaccess");
  assert.ok(Array.isArray(brickRestrictions?.allowListedAppBundleIDs), "Level 3 should use an app allowlist");
  const brickAllowedApps = brickRestrictions?.allowListedAppBundleIDs as unknown[];
  assert.equal(brickAllowedApps.includes(IOS_APP_STORE_BUNDLE_ID), true);
  assert.equal(Object.values(IOS_SOCIAL_COMPANION_BUNDLE_IDS).every((bundleId) => brickAllowedApps.includes(bundleId)), true);
  assert.equal(brickAllowedApps.includes("com.google.ios.youtube"), false);
  assert.equal(brickRestrictions?.allowAppInstallation, undefined);
  const webFilter = parsedProfile.PayloadContent
    .map((item) => recordValue(item, "brick web clip payload"))
    .find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
  assert.ok(webFilter, "brick web clip profile should include a web filter");
  assert.ok(Array.isArray(webFilter.AllowListBookmarks), "brick web clip profile should include allowlist bookmarks");
  const bookmarkUrls = webFilter.AllowListBookmarks
    .map((item) => recordValue(item, "brick allowlist bookmark"))
    .map((bookmark) => stringValue(bookmark.URL, "brick allowlist bookmark URL"));
  assert.equal(bookmarkUrls.includes("https://www.instagram.com/direct/inbox/"), true);
  assert.equal(bookmarkUrls.includes("https://m.youtube.com/feed/subscriptions"), true);
  assert.equal(bookmarkUrls.includes("https://web.snapchat.com/"), true);
  assert.equal(bookmarkUrls.includes("https://www.instagram.com/"), true, "Instagram DM threads need the host-level allow pattern");
  assert.equal(bookmarkUrls.includes("https://m.youtube.com/"), true, "YouTube watch routes need the mobile host-level allow pattern");
  assert.equal(bookmarkUrls.some((pattern) => "https://www.instagram.com/direct/t/12345/".startsWith(pattern)), true);
  assert.equal(bookmarkUrls.some((pattern) => "https://m.youtube.com/watch?v=abc123".startsWith(pattern)), true);
  assert.ok(Array.isArray(webFilter.DenyListURLs), "Level 3 should keep targeted short-form denies alongside the allowlist");
  assert.equal(webFilter.DenyListURLs.includes("https://youtube.com/shorts"), true);
  assert.equal(webFilter.DenyListURLs.includes("https://instagram.com/reel"), true);
  assert.equal(webFilter.SafariHistoryRetentionEnabled, false);
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
  assert.equal(summary.launcherProfile.webClipCount, 3);
  const profile = buildIosConfigurationProfile(state, now);
  assert.doesNotMatch(profile, /com\.apple\.webClip\.managed/);
  assert.doesNotMatch(profile, /Sentinel YouTube/);
  assert.doesNotMatch(profile, /Sentinel Snapchat/);
  assert.doesNotMatch(profile, /Sentinel Instagram/);
  assert.doesNotMatch(profile, /com\.google\.ios\.youtube/);
  assert.doesNotMatch(profile, /com\.toyopagroup\.picaboo/);
  assert.doesNotMatch(profile, /com\.burbn\.instagram/);

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
  assert.doesNotMatch(softProfile, /Sentinel YouTube/);
  assert.doesNotMatch(softProfile, /Sentinel Snapchat/);
  assert.doesNotMatch(softProfile, /Sentinel Instagram/);
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
  assert.equal(noWebSummary.launcherProfile.webClipCount, 3);
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
  assert.doesNotMatch(noAppsProfile, /DenyListURLs/);
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
    topic: "com.apple.mgmt.sentinel-test",
    identityCertificateUuid: "11111111-2222-3333-4444-555555555555",
    identityCertificatePayloadBase64: pkcs12ShapeFixture()
  };
  const summary = iosMdmSummary(state, now);
  assert.equal(summary.enrollmentReady, true);
  assert.equal(summary.ready, false);
  assert.equal(summary.status, "queue-only");
  assert.match(summary.enrollmentUrl, /^https:\/\/mdm\.example\.test\/mdm\/enroll\.mobileconfig\?token=/);
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

  const enrollment = buildIosMdmEnrollmentProfile(state);
  assert.doesNotMatch(enrollment, /replace-with-public-mdm-host|replace-with-apns-topic/);
  const profileToken = enrollment.match(/token=([^<]+)/)?.[1] || "";
  assert.equal(authorizeIosMdmRequest(state, new URL(`https://mdm.example.test/mdm/checkin?token=${profileToken}`)), true);
  assert.match(enrollment, /com\.apple\.mdm/);
  assert.match(enrollment, /https:\/\/mdm\.example\.test\/mdm\/connect/);
  assert.match(enrollment, /com\.apple\.mgmt\.sentinel-test/);
  const enrollmentProfile = recordValue(parsePlist(enrollment), "MDM enrollment profile");
  const enrollmentPayloads = (enrollmentProfile.PayloadContent as unknown[]).map((item) => recordValue(item, "MDM enrollment payload"));
  const mdmPayload = must(enrollmentPayloads.find((payload) => payload.PayloadType === "com.apple.mdm"), "MDM payload");
  assert.equal(mdmPayload.IdentityCertificateUUID, "11111111-2222-3333-4444-555555555555");
  assert.ok(enrollmentPayloads.some((payload) => payload.PayloadType === "com.apple.security.pkcs12"));

  const checkIn = handleIosMdmCheckIn(state, {
    MessageType: "TokenUpdate",
    UDID: "iphone-udid-1",
    Topic: "com.apple.mgmt.sentinel-test",
    PushMagic: "push-magic",
    Token: plistData(Buffer.from("push-token"))
  }, now);
  assert.equal(checkIn.messageType, "TokenUpdate");
  assert.equal(state.deviceControls.ios.mdm.devices.length, 1);
  assert.equal(state.deviceControls.ios.mdm.commands.some((command) => command.requestType === "InstallProfile"), true);
  assert.equal(state.deviceControls.ios.mdm.devices[0].tokenHex, Buffer.from("push-token").toString("hex"));
  const mdmSettings = normalizeIosMdmSettings({}, state.deviceControls.ios.mdm);
  const enrolledDevice = must(mdmSettings.devices[0], "enrolled MDM device");
  const pushRequest = buildIosMdmPushRequest(mdmSettings, enrolledDevice);
  assert.equal(pushRequest.endpoint, "https://api.push.apple.com");
  assert.equal(pushRequest.path, `/3/device/${Buffer.from("push-token").toString("hex")}`);
  assert.equal(pushRequest.headers["apns-topic"], "com.apple.mgmt.sentinel-test");
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
  const acknowledged = handleIosMdmConnect(state, {
    UDID: "iphone-udid-1",
    Status: "Acknowledged",
    CommandUUID: sentCommandUuid
  }, now);
  assert.equal(must(state.deviceControls.ios.mdm.commands.find((item) => item.commandUuid === sentCommandUuid), "acknowledged MDM command").status, "acknowledged");
  assert.equal(acknowledged.empty, false);

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
  assert.equal(expiredRestrictions?.blockedAppBundleIDs, undefined);
  assert.equal(expiredRestrictions?.allowListedAppBundleIDs, undefined);

  state.deviceControls.ios.enabled = false;
  const removePolicy = queueIosMdmPolicyRefresh(state, "disable-ios", now, { udids: ["iphone-udid-1"] }) as { profileQueued?: number };
  assert.equal(removePolicy.profileQueued, 1);
  const { payload: removePayload } = nextCommandOfType("RemoveProfile");
  assert.equal(removePayload.RequestType, "RemoveProfile");
  assert.equal(removePayload.Identifier, "com.local-screen-time.ios-lock");
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
