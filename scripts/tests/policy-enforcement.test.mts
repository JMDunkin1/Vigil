import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleContentFilterStatusFromRecord } from "../../src/appleContentFilter.js";
import { activeAppLockPolicy, confirmAppLockUnlock, requestAppLockUnlock } from "../../src/appLocks.js";
import { contentFilterEnabled, matchContentFilterUrl } from "../../src/contentFilters.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_EXPLICIT_URL_PATTERNS, defaultState, PANIC_LOCK_PROFILE_ID, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { assertDistanceKey, distanceKeySummary, updateDistanceKeySettings } from "../../src/distanceKey.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionRuleSnapshot } from "../../src/extensionPolicy.js";
import { buildHostsBlock, managedBlockDomains } from "../../src/hardening.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "../../src/keyholder.js";
import { activeLimitBlocks, activeLimitPolicy, overrideLimitRules } from "../../src/limits.js";
import { shouldLockScreenForPolicy } from "../../src/monitor.js";
import { activePolicy, activeSchedule, appMatchesAppTargets, clearSessionsById, emergencyUnlockAllowedForPolicy, expandAppTargets, expandSiteTargets, hostMatchesSiteTargets, isFullLockoutPolicy, matchBlockedUrlPattern, matchStrictBrowserControlUrl, panicLockProfile, profileById, sessionPhase, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "../../src/policy.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "../../src/protection.js";
import { buildSafariFilterProfile, safariFilterDenyUrls, safariFilterPathDenyUrls, safariFilterPolicySignature, safariUrlFilterEnabled } from "../../src/safariFilter.js";
import { applySealVerificationToState, markStateSealed } from "../../src/seal.js";
import { blockedPage } from "../../src/server/pages.js";
import { deleteProfile } from "../../src/server/policyRoutes.js";
import { updateSettings } from "../../src/server/settingsRoutes.js";
import { sanitizeDefaultFocusProfile, sanitizeSoftBlockProfile } from "../../src/store.js";
import { syncDeviceUsageSnapshot } from "../../src/usage.js";
import type { Session, UsageState } from "../../src/types.js";
import { must, mustPolicy, now, recordValue, stringValue, TEST_DAYS, testProfile, usageFixture } from "./test-helpers.mjs";

{
  const state = defaultState();
  state.schedules = [{
    id: "work",
    name: "Work",
    enabled: true,
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    commitmentLock: true,
    days: TEST_DAYS,
    start: "00:00",
    end: "23:59",
    wifiNetworks: ["Office"]
  }];
  state.environment.wifiSsid = "Office";
  const schedule = must(activeSchedule(state, now), "active schedule");
  assert.equal(schedule.schedule.id, "work");
  assert.equal(schedule.session.canEndEarly, false);
  assert.equal(schedule.session.emergencyUnlocksAllowed, false);
  assert.equal(emergencyUnlockAllowedForPolicy(activePolicy(state, now)), false);
  state.environment.wifiSsid = "Home";
  assert.equal(activeSchedule(state, now), null);
}

{
  const state = defaultState();
  state.schedules = [
    {
      id: "light-first",
      name: "Light first",
      enabled: true,
      mode: "focus",
      profileId: "default",
      lockLevel: "light",
      commitmentLock: false,
      days: TEST_DAYS,
      start: "00:00",
      end: "23:59",
      wifiNetworks: []
    },
    {
      id: "commitment-second",
      name: "Commitment second",
      enabled: true,
      mode: "rehab",
      profileId: "default",
      lockLevel: "deep",
      commitmentLock: true,
      days: TEST_DAYS,
      start: "00:00",
      end: "23:59",
      wifiNetworks: []
    }
  ];
  const schedule = must(activeSchedule(state, now), "strongest active schedule");
  assert.equal(schedule.schedule.id, "commitment-second");
  assert.equal(schedule.session.lockLevel, "deep");
  assert.equal(schedule.session.emergencyUnlocksAllowed, false);
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(policy.kind, "schedule");
  assert.equal(policy.session.mode, "rehab");
  assert.equal(emergencyUnlockAllowedForPolicy(policy), false);
  assert.throws(() => assertProtectedEditAllowed(state, { kind: "schedule", id: "commitment-second" }, now), /Protected edits/);
}

{
  const state = defaultState();
  state.schedules = [
    {
      id: "deep-first",
      name: "Deep first",
      enabled: true,
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      commitmentLock: false,
      days: TEST_DAYS,
      start: "00:00",
      end: "23:59",
      wifiNetworks: []
    },
    {
      id: "commitment-second",
      name: "Commitment second",
      enabled: true,
      mode: "focus",
      profileId: "default",
      lockLevel: "deep",
      commitmentLock: true,
      days: TEST_DAYS,
      start: "00:00",
      end: "23:59",
      wifiNetworks: []
    }
  ];
  const schedule = must(activeSchedule(state, now), "commitment schedule");
  assert.equal(schedule.schedule.id, "commitment-second");
  assert.equal(schedule.session.emergencyUnlocksAllowed, false);
  assert.equal(emergencyUnlockAllowedForPolicy(activePolicy(state, now)), false);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "commitment",
    title: "Commitment focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "manual"
  };
  assert.equal(emergencyUnlockAllowedForPolicy(activePolicy(state, now)), false);
}

{
  const state = defaultState();
  const summary = updateKeyholderSettings(state, { enabled: true, passcode: "anchor-passcode" }, now);
  assert.equal(summary.enabled, true);
  assert.equal(summary.hasPasscode, true);
  assert.throws(() => assertKeyholderPasscode(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertKeyholderPasscode(state, "anchor-passcode"));
  state.appLocks = [{
    id: "keyheld-lock",
    name: "Keyheld Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const request = requestAppLockUnlock(state, "keyheld-lock", "I need this app lock opened for a short necessary task.", now);
  assert.equal(Boolean(request.challenge?.text), true);
  assert.throws(() => {
    assertKeyholderPasscode(state, "wrong");
    confirmAppLockUnlock(state, request.id, now);
  }, /incorrect/);
  assert.doesNotThrow(() => {
    assertKeyholderPasscode(state, "anchor-passcode");
    confirmAppLockUnlock(state, request.id, { challengeText: must(request.challenge, "app lock challenge").text }, now);
  });

  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));
  state.keyholder.enabled = false;
  assert.throws(() => assertKeyholderPasscode(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertKeyholderPasscode(state, "anchor-passcode"));
}

{
  const state = defaultState();
  assert.throws(() => updateDistanceKeySettings(state, { enabled: true }, now), /Generate or enter/);
  const result = updateDistanceKeySettings(state, { enabled: true, rotate: true }, now);
  const distanceToken = must(result.token, "distance key token");
  assert.match(distanceToken, /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/);
  assert.equal(distanceKeySummary(state).enabled, true);
  assert.throws(() => assertDistanceKey(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertDistanceKey(state, distanceToken.toLowerCase(), now));
  assert.equal(Boolean(state.distanceKey.lastVerifiedAt), true);

  state.distanceKey.enabled = false;
  markStateSealed(state, now.toISOString());
  applySealVerificationToState(state, {
    ok: false,
    status: "mismatch",
    detail: "State file does not match its integrity seal.",
    sealedAt: now.toISOString(),
    checkedAt: now.toISOString(),
    hasKey: true,
    hasSeal: true
  }, new Date(now.getTime() + 1000));
  assert.throws(() => assertDistanceKey(state, "wrong"), /incorrect/);
  assert.doesNotThrow(() => assertDistanceKey(state, result.token, now));
}

{
  const dir = await mkdtemp(join(tmpdir(), "vigil-distance-key-"));
  try {
    const state = defaultState();
    const keyPath = join(dir, "USB", "vigil.key");
    const result = updateDistanceKeySettings(state, {
      enabled: true,
      keyFilePath: keyPath,
      writeKeyFile: true
    }, now);
    assert.equal(result.keyFilePath, keyPath);
    assert.equal(distanceKeySummary(state).hasKeyFile, true);
    assert.match(await readFile(keyPath, "utf8"), /^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}/);
    assert.doesNotThrow(() => assertDistanceKey(state, "", now));
    assert.equal(Boolean(state.distanceKey.lastFileVerifiedAt), true);
    await rm(keyPath, { force: true });
    assert.throws(() => assertDistanceKey(state, "", now), /incorrect/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

{
  const state = defaultState();
  const profile = state.profiles[0];
  assert.equal(shouldBlockSite(profile, "www.youtube.com"), true);
  assert.equal(shouldBlockSite(profile, "youtu.be"), true);
  assert.equal(shouldBlockSite(profile, "www.youtube-nocookie.com"), true);
  assert.equal(shouldBlockSite(profile, "redd.it"), false);
  assert.equal(shouldBlockSite(profile, "fb.com"), true);
  assert.equal(shouldBlockSite(profile, "docs.google.com"), false);
  assert.equal(expandSiteTargets(["youtube.com"]).includes("youtu.be"), true);
  assert.equal(hostMatchesSiteTargets("mobile.twitter.com", ["x.com"]), true);
  assert.equal(shouldBlockSite(testProfile({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }), "youtu.be"), false);
  assert.equal(shouldBlockSite(testProfile({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }), "reddit.com"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/shorts/abc"), true);
  assert.equal(must(matchContentFilterUrl(state, "https://www.youtube.com/shorts/abc"), "YouTube Shorts filter").id, "youtube-shorts");
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/watch?v=abc"), false);
  assert.equal(shouldBlockUrl(profile, "https://www.reddit.com/r/popular"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.reddit.com/r/learnprogramming/comments/demo"), false);
  assert.equal(DEFAULT_EXPLICIT_URL_PATTERNS.includes("honeytoon"), true);
  assert.equal(DEFAULT_EXPLICIT_URL_PATTERNS.includes("webtoon18"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.google.com/search?q=porn"), true);
  assert.equal(shouldBlockUrl(profile, "https://duckduckgo.com/?q=hooneytoons"), true);
  assert.equal(shouldBlockUrl(profile, "https://search.example/?q=mawha"), true);
  assert.equal(matchBlockedUrlPattern(profile, "https://search.example/?q=webtoon%2018")?.pattern, "webtoon18");
  assert.equal(shouldBlockUrl(profile, "https://search.example/?q=18%2B+manhwa"), true);
  assert.equal(shouldBlockUrl(profile, "https://search.example/?q=webtoon+cooking"), false);
  assert.equal(shouldBlockUrl(profile, "https://search.example/?q=18"), false);
  assert.equal(shouldBlockUrl(profile, "https://example.com/archive/2018/report"), false);
  assert.equal(shouldBlockUrl({ ...profile, blockedUrlPatterns: ["/reels", "casino"] }, "https://example.com/reels/latest"), true);
  assert.equal(matchBlockedUrlPattern({ ...profile, blockedUrlPatterns: ["casino"] }, "https://news.example/search?q=casino")?.pattern, "casino");
  assert.equal(expandAppTargets(["Steam"]).includes("steam helper"), true);
  assert.equal(appMatchesAppTargets("EpicWebHelper", ["Epic Games Launcher"]), true);
  assert.equal(appMatchesAppTargets("Discord Helper.app", ["Discord"]), true);
  assert.equal(appMatchesAppTargets("Slack Helper (Renderer)", ["Slack"]), true);
  assert.equal(appMatchesAppTargets("MSTeams", ["Microsoft Teams"]), true);
  assert.equal(appMatchesAppTargets("Cloudflare WARP", ["WARP"]), true);
  assert.equal(appMatchesAppTargets("Little Snitch Network Monitor", ["Little Snitch Configuration"]), true);
  assert.equal(appMatchesAppTargets("Charles Proxy", ["Charles"]), true);
}

{
  const state = defaultState();
  const usage = {};
  const fromWatch = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/shorts/abc",
    previousUrl: "https://www.youtube.com/watch?v=abc",
    event: "navigation"
  }, now);
  assert.equal(fromWatch.blocked, false);
  assert.equal(fromWatch.paused, true);
  assert.equal(fromWatch.reason, "intentional-use");
  const pauseRedirect = new URL(stringValue(fromWatch.redirectUrl, "Shorts Level 1 pause redirect"));
  assert.equal(pauseRedirect.pathname, "/pause");
  assert.ok(pauseRedirect.searchParams.get("requestId"));

  const direct = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/shorts/abc",
    previousUrl: "",
    event: "navigation"
  }, now);
  assert.equal(direct.blocked, false);
  assert.equal(direct.paused, true);
  assert.equal(stringValue(direct.redirectUrl, "Shorts repeated Level 1 pause redirect"), pauseRedirect.toString());
}

{
  const state = defaultState();
  const page = blockedPage({
    url: new URL("http://127.0.0.1:8787/blocked?site=Example&back=https%3A%2F%2Fexample.com%2Fdocs"),
    state
  });
  assert.match(page, /id="leaveBlockedPage"/);
  assert.match(page, /https:\/\/example\.com\/docs/);
  assert.match(page, /document\.referrer/);
  assert.match(page, /history\.go\(-2\)/);
}

{
  const state = defaultState();
  const baselineUrls = safariFilterDenyUrls(state, now);
  assert.equal(baselineUrls.includes("https://pornhub.com/"), true);
  assert.equal(baselineUrls.includes("https://www.pornhub.com/"), true);
  assert.equal(baselineUrls.includes("https://youtube.com/shorts"), false);
  const baselineProfileText = buildSafariFilterProfile(state, now);
  assert.match(baselineProfileText, /<key>restrictWeb<\/key>\s*<true\/>/);
  assert.match(baselineProfileText, /<key>useContentFilter<\/key>\s*<true\/>/);
  assert.match(baselineProfileText, /com\.apple\.familycontrols\.contentfilter/);
}

{
  const state = defaultState();
  const profile = state.profiles[0];
  state.activeSession = {
    id: "safari-filter-test",
    title: "Safari filter test",
    mode: "focus",
    profileId: profile.id,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: profile
  };
  const urls = safariFilterDenyUrls(state, now);
  assert.equal(urls.includes("https://pornhub.com/"), true);
  assert.equal(urls.includes("https://www.pornhub.com/"), true);
  assert.equal(urls.includes("https://youtube.com/shorts"), true);
  assert.equal(urls.includes("https://www.youtube.com/shorts"), true);
  assert.equal(urls.includes("https://m.youtube.com/shorts"), true);
  assert.equal(urls.includes("https://www.youtube.com/watch"), false);
  assert.equal(safariFilterPathDenyUrls(state, now).some((url) => url.includes("/shorts")), true);
  assert.match(safariFilterPolicySignature(state, now), /^[a-f0-9]{64}$/);
  const profileText = buildSafariFilterProfile(state, now);
  assert.match(profileText, /<key>filterDenyList<\/key>/);
  assert.match(profileText, /<key>restrictWeb<\/key>\s*<true\/>/);
  assert.match(profileText, /<key>useContentFilter<\/key>\s*<true\/>/);
  assert.match(profileText, /<key>PayloadRemovalDisallowed<\/key>\s*<true\/>/);
  assert.match(profileText, /com\.apple\.familycontrols\.contentfilter/);
  assert.match(profileText, /<key>allowSafariHistoryClearing<\/key>\s*<true\/>/);
  assert.match(profileText, /com\.apple\.applicationaccess/);
  assert.match(profileText, /VigilPolicySignature:/);
}

{
  const state = defaultState();
  const usage = {};
  const explicit = evaluateExtensionCheck(state, usage, { url: "https://www.pornhub.com/", event: "navigation" }, now);
  assert.equal(explicit.blocked, true);
  assert.equal(recordValue(explicit.policy, "explicit policy").kind, "adult-blocklist");
  const normalReddit = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/learnprogramming/comments/demo", event: "navigation" }, now);
  assert.equal(normalReddit.blocked, false);
  assert.equal(normalReddit.paused, false);
  const explicitReddit = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/gonewild", event: "navigation" }, now);
  assert.equal(explicitReddit.blocked, false);
  assert.equal(explicitReddit.paused, false);
  const explicitComicSearch = evaluateExtensionCheck(state, usage, { url: "https://www.google.com/search?q=webtoon%2018", event: "navigation" }, now);
  assert.equal(explicitComicSearch.blocked, false);
  assert.equal(explicitComicSearch.paused, false);
  const bare18Search = evaluateExtensionCheck(state, usage, { url: "https://www.google.com/search?q=18", event: "navigation" }, now);
  assert.equal(bare18Search.blocked, false);
  const baselineYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(baselineYoutube.blocked, false);
  const baselineManagedDomains = managedBlockDomains(defaultState(), now);
  assert.equal(baselineManagedDomains.includes("reddit.com"), false);
  assert.equal(baselineManagedDomains.includes("redd.it"), false);
  assert.equal(baselineManagedDomains.includes("pornhub.com"), true);
  assert.equal(profileById(state, "default").blockedSites.includes("reddit.com"), false);
  assert.equal(profileById(state, "default").blockedUrlPatterns.includes("reddit.com/r/popular"), true);
  assert.equal(profileById(state, "default").hostsUrlPatternBlocking, false);
  assert.deepEqual(profileById(state, "normal").blockedUrlPatterns, []);
  const defaultFocusSessionState = defaultState();
  const defaultFocusSession = {
    id: "default-focus",
    title: "Default Focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep" as const,
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual"
  };
  defaultFocusSessionState.activeSession = defaultFocusSession;
  defaultFocusSessionState.activeSessions.computer = defaultFocusSession;
  const defaultFocusManagedDomains = managedBlockDomains(defaultFocusSessionState, now);
  assert.equal(defaultFocusManagedDomains.includes("reddit.com"), false);
  assert.equal(defaultFocusManagedDomains.includes("redd.it"), false);
  assert.equal(defaultFocusManagedDomains.includes("youtube.com"), true);

  const migratedDefaultProfile = sanitizeDefaultFocusProfile({
    ...profileById(state, "default"),
    blockedSites: ["youtube.com", "reddit.com", "redd.it"],
    blockedUrlPatterns: ["reddit.com", "reddit.com/", "https://reddit.com/", "redd.it/", "reddit.com/r/popular"]
  });
  assert.deepEqual(migratedDefaultProfile.blockedSites, ["youtube.com"]);
  assert.equal(migratedDefaultProfile.hostsUrlPatternBlocking, false);
  assert.equal(migratedDefaultProfile.blockedUrlPatterns.includes("reddit.com"), false);
  assert.equal(migratedDefaultProfile.blockedUrlPatterns.includes("reddit.com/"), false);
  assert.equal(migratedDefaultProfile.blockedUrlPatterns.includes("https://reddit.com/"), false);
  assert.equal(migratedDefaultProfile.blockedUrlPatterns.includes("redd.it/"), false);
  assert.equal(migratedDefaultProfile.blockedUrlPatterns.includes("reddit.com/r/popular"), true);

  const softProfile = profileById(state, SOFT_BLOCK_PROFILE_ID);
  const migratedSoftProfile = sanitizeSoftBlockProfile({
    ...softProfile,
    blockedApps: ["Instagram", "Discord"],
    blockedSites: ["instagram.com", "reddit.com", "pornhub.com"],
    blockedUrlPatterns: ["instagram.com/explore", "instagram.com/reels", "reddit.com", "reddit.com/", "https://reddit.com/", "redd.it/"]
  });
  assert.deepEqual(migratedSoftProfile.blockedApps, ["Discord"]);
  assert.deepEqual(migratedSoftProfile.blockedSites, ["pornhub.com"]);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/explore"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("reddit.com"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("reddit.com/"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("https://reddit.com/"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("redd.it/"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/reel"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("reddit.com/r/popular"), true);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("reddit.com/r/nsfw"), true);
  assert.equal(shouldBlockUrl(migratedSoftProfile, "https://www.reddit.com/r/learnprogramming/comments/demo"), false);
  assert.equal(shouldBlockUrl(migratedSoftProfile, "https://www.reddit.com/r/popular"), true);
  assert.equal(shouldBlockUrl(migratedSoftProfile, "https://www.reddit.com/r/gonewild"), true);
  assert.equal(migratedSoftProfile.phoneAppBlocking, false);

  state.activeSessions.phone = {
    id: "phone-soft",
    title: "Phone Soft Block",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone" as const],
    profileSnapshot: softProfile
  };
  assert.equal(activePolicy(state, now), null);
  assert.equal(mustPolicy(activePolicy(state, now, { device: "phone" })).profile.id, SOFT_BLOCK_PROFILE_ID);

  const computerSoft = {
    ...state.activeSessions.phone,
    id: "computer-soft",
    title: "Computer Soft Block",
    deviceTargets: ["computer" as const]
  };
  state.activeSessions.computer = computerSoft;
  state.activeSession = computerSoft;
  const shorts = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/shorts/abc", event: "navigation" }, now);
  assert.equal(shorts.blocked, true);
  const watch = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(watch.blocked, false);
  const instagramHome = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/", event: "navigation" }, now);
  assert.equal(instagramHome.blocked, false);
  const instagramDm = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/direct/inbox/", event: "navigation" }, now);
  assert.equal(instagramDm.blocked, false);
  const instagramStory = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/stories/example/12345/", event: "navigation" }, now);
  assert.equal(instagramStory.blocked, false);
  const instagramReel = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/reel/abc123/", event: "navigation" }, now);
  assert.equal(instagramReel.blocked, true);
  assert.equal(instagramReel.reason, "content-filter");
  assert.equal(must(instagramReel.contentFilter, "instagram reels filter").id, "instagram-reels");
  const instagramReelsTab = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/reels/", event: "navigation" }, now);
  assert.equal(instagramReelsTab.blocked, true);
  const instagramExplore = evaluateExtensionCheck(state, usage, { url: "https://www.instagram.com/explore/", event: "navigation" }, now);
  assert.equal(instagramExplore.blocked, true);
  assert.equal(must(instagramExplore.contentFilter, "instagram explore filter").id, "instagram-explore");
  const hosts = buildHostsBlock(state, now);
  assert.match(hosts, /0\.0\.0\.0 pornhub\.com/);
  assert.doesNotMatch(hosts, /0\.0\.0\.0 youtube\.com/);

  const bothDevices = {
    ...computerSoft,
    id: "both-devices",
    title: "Both devices",
    deviceTargets: ["computer" as const, "phone" as const]
  };
  state.activeSessions.computer = bothDevices;
  state.activeSessions.phone = bothDevices;
  state.activeSession = bothDevices;
  assert.equal(mustPolicy(activePolicy(state, now)).session.id, "both-devices");
  assert.equal(mustPolicy(activePolicy(state, now, { device: "phone" })).session.id, "both-devices");
  assert.deepEqual(clearSessionsById(state, "both-devices"), ["computer", "phone"]);
  assert.equal(state.activeSession, null);
  assert.equal(activePolicy(state, now), null);
  assert.equal(activePolicy(state, now, { device: "phone" }), null);
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  const brick = profileById(state, BRICK_MODE_PROFILE_ID);
  assert.equal(brick.name, "Mac Brick");
  assert.equal(brick.mode, "allowlist");
  assert.equal(shouldBlockSite(brick, "docs.google.com"), false);
  assert.equal(shouldBlockSite(brick, "youtube.com"), true);
  state.activeSession = {
    id: "brick",
    title: "Brick Mode",
    mode: "brick",
    profileId: BRICK_MODE_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 90 * 60 * 1000).toISOString(),
    canEndEarly: false,
    commitmentLock: true,
    emergencyUnlocksAllowed: false,
    source: "manual"
  };
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(policy.session.mode, "brick");
  assert.equal(shouldBlockAppForPolicy(state, policy, "Mail"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Discord"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
  assert.equal(emergencyUnlockAllowedForPolicy(policy), false);
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://extensions/")?.area, "extensions");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "edge://settings/privacy")?.area, "settings");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "brave://flags")?.area, "flags");
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://newtab/"), null);
  assert.equal(matchStrictBrowserControlUrl(state, policy, "https://example.com"), null);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(matchStrictBrowserControlUrl(state, policy, "chrome://extensions/"), null);
  state.settings.strictBypassProtectionEnabled = true;
  const snapshot = extensionRuleSnapshot(state, now);
  assert.equal(snapshot.fallbackRequired, false);
  assert.equal(snapshot.allowlistRules.length, 1);
  assert.equal(snapshot.dynamicRuleCount, extensionDynamicRuleCount(snapshot));
  assert.equal(snapshot.dynamicRuleCount, snapshot.rules.length + snapshot.contentRules.length + snapshot.allowlistRules.length);
  assert.equal(typeof snapshot.dynamicRuleSignature, "string");
  assert.equal(snapshot.dynamicRuleSignature.includes("allowlist"), true);
  const allowlistRule = must(snapshot.allowlistRules[0], "allowlist rule");
  assert.equal(allowlistRule.kind, "allowlist");
  assert.equal((allowlistRule.excludedDomains || []).includes("docs.google.com"), true);
  assert.equal((allowlistRule.excludedDomains || []).includes("youtube.com"), false);
  assert.equal(new URL(allowlistRule.redirectUrl).searchParams.get("kind"), "allowlist");
}

{
  const state = defaultState();
  state.settings.strictBypassProtectionEnabled = true;
  state.activeSession = {
    id: "snap",
    title: "Snapshot focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      blockedApps: [],
      blockedSites: ["reddit.com"],
      allowedSites: []
    }
  };
  state.profiles[0].blockedSites = [];
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(shouldBlockSite(policy.profile, "reddit.com"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Activity Monitor Helper"), true);
  state.settings.strictBypassProtectionEnabled = false;
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), false);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "cycle",
    title: "Cycle focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 55 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    cycle: { enabled: true, workMinutes: 25, breakMinutes: 5, rounds: 2 }
  };
  assert.equal(must(sessionPhase(must(state.activeSession, "cycle session"), now), "work phase").kind, "work");
  assert.equal(mustPolicy(activePolicy(state, now)).phase?.round, 1);

  const breakTime = new Date(now.getTime() + 26 * 60 * 1000);
  assert.equal(must(sessionPhase(must(state.activeSession, "cycle session"), breakTime), "break phase").kind, "break");
  assert.equal(activePolicy(state, breakTime), null);

  const secondWork = new Date(now.getTime() + 31 * 60 * 1000);
  assert.equal(mustPolicy(activePolicy(state, secondWork)).phase?.round, 2);

  activePolicy(state, new Date(now.getTime() + 56 * 60 * 1000));
  assert.equal(state.activeSession, null);
}

{
  const state = defaultState();
  assert.equal(state.settings.panicLockDurationMinutes, 3);
  state.activeSession = {
    id: "underlying-focus",
    title: "Underlying focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  state.panicLock = {
    id: "panic-now",
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
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(policy.kind, "panic");
  assert.equal(isFullLockoutPolicy(policy), true);
  assert.equal(policy.profile.id, PANIC_LOCK_PROFILE_ID);
  assert.equal(policy.profile.mode, "allowlist");
  assert.equal(emergencyUnlockAllowedForPolicy(policy), false);
  assert.equal(shouldBlockSite(policy.profile, "reddit.com"), true);
  assert.equal(shouldBlockSite(policy.profile, "localhost"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Firefox"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Terminal"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Codex"), true);
  assert.equal(shouldBlockAppForPolicy(state, policy, "Vigil"), false);
  assert.equal(shouldBlockAppForPolicy(state, policy, "loginwindow"), false);
  assert.equal(shouldLockScreenForPolicy(state, policy), true);
  const resumed = mustPolicy(activePolicy(state, new Date(now.getTime() + 4 * 60 * 1000)));
  assert.equal(state.panicLock, null);
  assert.equal(resumed.kind, "manual");
  assert.equal(resumed.session.id, "underlying-focus");
}

{
  const state = defaultState();
  state.activeSession = {
    id: "sleep-lock",
    title: "Sleep lock",
    mode: "sleep",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const policy = mustPolicy(activePolicy(state, now));
  assert.equal(shouldLockScreenForPolicy(state, policy), false);
  state.settings.systemSleepLockEnabled = true;
  assert.equal(shouldLockScreenForPolicy(state, policy), true);
  state.activeSession.mode = "focus";
  assert.equal(shouldLockScreenForPolicy(state, mustPolicy(activePolicy(state, now))), false);
  state.activeSession.mode = "sleep";
  state.activeSession.lockLevel = "light";
  assert.equal(shouldLockScreenForPolicy(state, mustPolicy(activePolicy(state, now))), false);
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "social-time",
    name: "Social Time",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["youtube.com", "reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 5,
    blockMinutes: 30
  }];
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 90,
      apps: {},
      sites: { "youtube.com": 61 },
      opens: { apps: {}, sites: {} }
    }
  });
  const policy = mustPolicy(activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now));
  assert.equal(policy.kind, "limit");
  assert.equal(policy.profile.blockedSites.includes("reddit.com"), true);
  assert.equal(policy.profile.blockedSites.includes("youtu.be"), true);
  assert.equal(shouldBlockSite(policy.profile, "youtu.be"), true);

  const phoneUsage: UsageState = {};
  syncDeviceUsageSnapshot(phoneUsage, {
    device: "phone",
    date: "2026-05-28",
    totalSeconds: 61,
    sites: { "youtube.com": 61 }
  }, now);
  assert.equal(mustPolicy(activeLimitPolicy(state, phoneUsage, { app: "Safari", hostname: "reddit.com", device: "phone" }, now)).kind, "limit");
}

{
  const state = defaultState();
  const instagramUsage = usageFixture({
    "2026-05-28": {
      totalSeconds: 20 * 60,
      apps: { Instagram: 20 * 60 },
      sites: { "instagram.com": 20 * 60 },
      opens: { apps: {}, sites: {} }
    }
  });
  const instagramPolicy = mustPolicy(activeLimitPolicy(state, instagramUsage, { app: "Instagram", hostname: "instagram.com" }, now));
  assert.equal(instagramPolicy.kind, "limit");
  assert.equal(instagramPolicy.session.ruleId, "instagram-20-20-template");
  state.limitBlocks = [];

  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 20 * 60,
      apps: {},
      sites: { "youtube.com": 20 * 60 },
      opens: { apps: {}, sites: {} }
    }
  });

  assert.equal(activeLimitPolicy(state, usage, { app: "Safari", hostname: "youtube.com" }, now), null);
  assert.equal(activeLimitBlocks(state, now, { device: "computer" }).length, 0);

  const softLock: Session = {
    id: "computer-soft-lock",
    title: "Soft Lock",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    deviceTargets: ["computer"],
    profileSnapshot: profileById(state, SOFT_BLOCK_PROFILE_ID)
  };
  state.activeSessions.computer = softLock;
  state.activeSession = softLock;

  assert.equal(activeLimitPolicy(state, instagramUsage, { app: "Instagram", hostname: "instagram.com" }, now), null);
  assert.equal(activeLimitBlocks(state, now, { device: "computer" }).length, 0);

  const policy = mustPolicy(activeLimitPolicy(state, usage, { app: "Safari", hostname: "youtube.com" }, now));
  assert.equal(policy.kind, "limit");
  assert.equal(policy.session.ruleId, "soft-lock-youtube-20-20-template");
  assert.equal(policy.profile.blockedSites.includes("youtube.com"), true);
  assert.equal(policy.profile.blockedSites.includes("youtu.be"), true);
  assert.equal(activeLimitBlocks(state, now, { device: "computer" }).length, 1);
  assert.equal(activeLimitBlocks(state, now, { device: "phone" }).length, 0);

  state.activeSessions.computer = null;
  state.activeSession = null;
  assert.equal(activeLimitBlocks(state, now, { device: "computer" }).length, 0);
  assert.equal(activeLimitPolicy(state, usage, { app: "Safari", hostname: "youtube.com" }, now), null);
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "emergency-time",
    name: "Emergency Time",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 5,
    blockMinutes: 30
  }];
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 90,
      apps: {},
      sites: { "reddit.com": 90 },
      opens: { apps: {}, sites: {} }
    }
  });
  const policy = mustPolicy(activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now));
  const block = must(state.limitBlocks[0], "active limit block");
  assert.equal(policy.kind, "limit");
  assert.equal(activeLimitBlocks(state, now).length, 1);

  assert.deepEqual(overrideLimitRules(state, [block.ruleId], block.until, "Emergency unlock", now), ["emergency-time"]);
  assert.equal(activeLimitBlocks(state, now).length, 0);
  state.limitBlocks = [];
  assert.equal(activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now), null);

  const afterOverride = new Date(now.getTime() + 31 * 60 * 1000);
  assert.equal(activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, afterOverride), null);

  const secondWindowUsage = usageFixture({
    "2026-05-28": {
      totalSeconds: 151,
      apps: {},
      sites: { "reddit.com": 151 },
      opens: { apps: {}, sites: {} }
    }
  });
  assert.equal(mustPolicy(activeLimitPolicy(state, secondWindowUsage, { app: "Safari", hostname: "reddit.com" }, afterOverride)).kind, "limit");
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "social-open",
    name: "Social Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 30,
    unlocksAllowed: 2,
    blockMinutes: 0
  }];
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 0,
      apps: {},
      sites: {},
      opens: { apps: {}, sites: { "reddit.com": 3 } }
    }
  });
  const policy = mustPolicy(activeLimitPolicy(state, usage, { app: "Safari", hostname: "reddit.com" }, now));
  assert.equal(policy.kind, "limit");
  assert.equal(policy.session.mode, "open-limit");
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "steam-time",
    name: "Steam Time",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: ["Steam"],
    sites: [],
    limitMinutes: 1,
    unlocksAllowed: 5,
    blockMinutes: 30
  }];
  const usage = usageFixture({
    "2026-05-28": {
      totalSeconds: 90,
      apps: { "Steam Helper": 61 },
      sites: {},
      opens: { apps: {}, sites: {} }
    }
  });
  const policy = mustPolicy(activeLimitPolicy(state, usage, { app: "steamwebhelper", hostname: "" }, now));
  assert.equal(policy.kind, "limit");
  assert.equal(policy.profile.blockedApps.includes("steam helper"), true);
}

{
  const state = defaultState();
  state.appLocks = [{
    id: "lock-social",
    name: "Locked Social",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const locked = mustPolicy(activeAppLockPolicy(state, { app: "Safari", hostname: "redd.it" }, now));
  assert.equal(locked.kind, "app-lock");
  must(state.appLocks[0], "app lock fixture").apps = ["Discord"];
  const appLocked = mustPolicy(activeAppLockPolicy(state, { app: "Discord Helper", hostname: "" }, now));
  assert.equal(appLocked.kind, "app-lock");

  const request = requestAppLockUnlock(state, "lock-social", "I need a short intentional unlock for this task.", now);
  assert.throws(() => confirmAppLockUnlock(state, request.id, { challengeText: "wrong" }, now), /challenge/);
  const unlock = confirmAppLockUnlock(state, request.id, { challengeText: must(request.challenge, "unlock challenge").text }, now);
  assert.equal(unlock.lockId, "lock-social");
  const unlocked = activeAppLockPolicy(state, { app: "Safari", hostname: "reddit.com" }, now);
  assert.equal(unlocked, null);
  assert.throws(() => requestAppLockUnlock(state, "lock-social", "I need another short intentional unlock.", now), /No unlocks remain/);
}

{
  const state = defaultState();
  const usage = {};
  state.appLocks = [{
    id: "lock-social",
    name: "Locked Social",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const result = evaluateExtensionCheck(state, usage, {
    url: "https://redd.it/abc123",
    previousUrl: "https://example.com/work",
    event: "navigation"
  }, now);
  const redirect = new URL(stringValue(result.redirectUrl, "app lock redirect URL"));
  assert.equal(result.reason, "app-lock");
  assert.equal(recordValue(result.policy, "app lock policy").lockId, "lock-social");
  assert.equal(result.browserNoiseBlockingEnabled, true);
  assert.equal(redirect.searchParams.get("kind"), "app-lock");
  assert.equal(redirect.searchParams.get("lockId"), "lock-social");
  assert.equal(redirect.searchParams.get("return"), "https://redd.it/abc123");
  assert.equal(redirect.searchParams.get("back"), "https://example.com/work");
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-filter",
    title: "Content filter session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "allowlist",
      blockedSites: [],
      allowedSites: ["youtube.com", "instagram.com", "reddit.com", "snapchat.com"]
    }
  };
  const usage = {};
  const shorts = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/shorts/abc", event: "navigation" }, now);
  assert.equal(shorts.blocked, true);
  assert.equal(shorts.reason, "content-filter");
  assert.equal(must(shorts.contentFilter, "YouTube Shorts filter").id, "youtube-shorts");
  assert.equal(stringValue(shorts.redirectUrl, "content filter redirect URL"), "https://www.youtube.com/");
  const shortsFromWatch = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/shorts/def",
    previousUrl: "https://www.youtube.com/watch?v=abc",
    event: "navigation"
  }, now);
  assert.equal(stringValue(shortsFromWatch.redirectUrl, "content filter previous-page redirect URL"), "https://www.youtube.com/watch?v=abc");
  const watch = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(watch.blocked, false);
  assert.equal(must(matchContentFilterUrl(state, "https://www.instagram.com/reels/xyz"), "Instagram reels filter").id, "instagram-reels");
  assert.equal(must(matchContentFilterUrl(state, "https://www.instagram.com/reel/xyz"), "Instagram reel filter").id, "instagram-reels");
  assert.equal(must(matchContentFilterUrl(state, "https://www.instagram.com/explore/"), "Instagram Explore filter").id, "instagram-explore");
  const snapFriend = evaluateExtensionCheck(state, usage, { url: "https://web.snapchat.com/", event: "navigation" }, now);
  assert.equal(snapFriend.blocked, false);
  const snapSpotlight = evaluateExtensionCheck(state, usage, { url: "https://www.snapchat.com/spotlight/demo", event: "navigation" }, now);
  assert.equal(snapSpotlight.blocked, true);
  assert.equal(snapSpotlight.reason, "content-filter");
  assert.equal(must(snapSpotlight.contentFilter, "Snapchat Spotlight filter").id, "snapchat-spotlight");
  const snapStories = evaluateExtensionCheck(state, usage, { url: "https://story.snapchat.com/p/demo", event: "navigation" }, now);
  assert.equal(snapStories.blocked, true);
  assert.equal(must(snapStories.contentFilter, "Snapchat Stories filter").id, "snapchat-public-stories");
  state.settings.contentFilterEnabled = false;
  state.settings.safariUrlFilterEnabled = false;
  assert.equal(contentFilterEnabled(state), true);
  assert.equal(safariUrlFilterEnabled(state), true);
  assert.equal(must(matchContentFilterUrl(state, "https://www.youtube.com/shorts/abc"), "YouTube Shorts filter").id, "youtube-shorts");
  assert.equal(must(matchContentFilterUrl(state, "https://snapchat.com/stories"), "Snapchat Stories filter").id, "snapchat-stories");
  updateSettings(state.settings, { contentFilterEnabled: false, safariUrlFilterEnabled: false, strictBypassProtectionEnabled: false });
  assert.equal(state.settings.contentFilterEnabled, true);
  assert.equal(state.settings.safariUrlFilterEnabled, true);
  assert.equal(state.settings.strictBypassProtectionEnabled, true);
}

{
  const on = appleContentFilterStatusFromRecord({
    restrictWeb: true,
    useContentFilter: true,
    allowListEnabled: false,
    filterDenyList: ["https://pornhub.com/"]
  }, "/tmp/com.apple.familycontrols.contentfilter.plist");
  assert.equal(on.current, true);
  assert.equal(on.denyUrlCount, 1);
  assert.match(on.detail, /Limit Adult Websites is on/);

  const off = appleContentFilterStatusFromRecord({
    restrictWeb: false,
    useContentFilter: false,
    allowListEnabled: false
  }, "/tmp/com.apple.familycontrols.contentfilter.plist");
  assert.equal(off.current, false);
  assert.match(off.detail, /off/);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "url-pattern",
    title: "URL pattern session",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      ...state.profiles[0],
      mode: "blocklist",
      blockedSites: [],
      blockedUrlPatterns: ["example.com/games", "casino"],
      allowedSites: []
    }
  };
  const usage = {};
  const game = evaluateExtensionCheck(state, usage, { url: "https://www.example.com/games/play", event: "navigation" }, now);
  assert.equal(game.blocked, true);
  assert.equal(game.reason, "url-pattern");
  assert.equal(must(game.urlPattern, "game URL pattern").pattern, "example.com/games");
  assert.equal(new URL(stringValue(game.redirectUrl, "URL pattern redirect URL")).searchParams.get("site"), "URL pattern: example.com/games");
  const keyword = evaluateExtensionCheck(state, usage, { url: "https://search.example/?q=casino", event: "navigation" }, now);
  assert.equal(keyword.blocked, true);
  assert.equal(must(keyword.urlPattern, "keyword URL pattern").pattern, "casino");
  const normal = evaluateExtensionCheck(state, usage, { url: "https://www.example.com/news", event: "navigation" }, now);
  assert.equal(normal.blocked, false);
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.kind === "url-pattern" && rule.urlFilter === "||example.com/games"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  assert.throws(() => assertProtectedEditAllowed(state, { kind: "settings" }, now), /Protected edits/);
  const request = requestMaintenanceWindow(state, "I need to adjust a protected configuration setting.", now);
  const pending = must(request.pending, "maintenance request");
  assert.equal(Boolean(pending.challenge?.text), true);
  const window = confirmMaintenanceWindow(state, pending.id, { challengeText: must(pending.challenge, "maintenance challenge").text }, new Date(now.getTime() + state.settings.protectedEditDelaySeconds * 1000));
  assert.equal(window.requestId, pending.id);
  assert.doesNotThrow(() => assertProtectedEditAllowed(state, { kind: "settings" }, new Date(now.getTime() + state.settings.protectedEditDelaySeconds * 1000)));
}

{
  const state = defaultState();
  state.profiles.push({
    id: "custom-study",
    name: "Custom study",
    mode: "blocklist",
    description: "",
    blockedApps: ["Steam"],
    blockedSites: ["example.test"],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  });
  state.settings.activeProfileId = "custom-study";
  const fallback = deleteProfile(state, "custom-study");
  assert.equal(fallback.id, "default");
  assert.equal(state.settings.activeProfileId, "default");
  assert.equal(state.profiles.some((profile) => profile.id === "custom-study"), false);
}

{
  const state = defaultState();
  state.profiles.push({
    id: "custom-scheduled",
    name: "Custom scheduled",
    mode: "blocklist",
    description: "",
    blockedApps: [],
    blockedSites: [],
    blockedUrlPatterns: [],
    allowedApps: [],
    allowedSites: []
  });
  state.schedules.push({
    id: "custom-schedule",
    name: "Custom schedule",
    enabled: true,
    mode: "focus",
    profileId: "custom-scheduled",
    lockLevel: "deep",
    days: TEST_DAYS,
    start: "00:00",
    end: "23:59",
    wifiNetworks: []
  });
  assert.throws(() => deleteProfile(state, "custom-scheduled"), /still used by a schedule/);
  assert.throws(() => deleteProfile(state, "default"), /Built-in profiles cannot be deleted/);
}
