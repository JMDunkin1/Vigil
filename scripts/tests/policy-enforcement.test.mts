import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeAppLockPolicy, confirmAppLockUnlock, requestAppLockUnlock } from "../../src/appLocks.js";
import { contentFilterEnabled, matchContentFilterUrl } from "../../src/contentFilters.js";
import { BRICK_MODE_PROFILE_ID, defaultState, PANIC_LOCK_PROFILE_ID, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { assertDistanceKey, distanceKeySummary, updateDistanceKeySettings } from "../../src/distanceKey.js";
import { evaluateExtensionCheck, extensionDynamicRuleCount, extensionRuleSnapshot } from "../../src/extensionPolicy.js";
import { buildHostsBlock } from "../../src/hardening.js";
import { assertKeyholderPasscode, updateKeyholderSettings } from "../../src/keyholder.js";
import { activeLimitPolicy } from "../../src/limits.js";
import { shouldLockScreenForPolicy } from "../../src/monitor.js";
import { activePolicy, activeSchedule, appMatchesAppTargets, clearSessionsById, emergencyUnlockAllowedForPolicy, expandAppTargets, expandSiteTargets, hostMatchesSiteTargets, isFullLockoutPolicy, matchBlockedUrlPattern, matchStrictBrowserControlUrl, panicLockProfile, profileById, sessionPhase, shouldBlockAppForPolicy, shouldBlockSite, shouldBlockUrl } from "../../src/policy.js";
import { assertProtectedEditAllowed, confirmMaintenanceWindow, requestMaintenanceWindow } from "../../src/protection.js";
import { buildSafariFilterProfile, safariFilterDenyUrls, safariFilterPathDenyUrls, safariFilterPolicySignature, safariUrlFilterEnabled } from "../../src/safariFilter.js";
import { applySealVerificationToState, markStateSealed } from "../../src/seal.js";
import { updateSettings } from "../../src/server/settingsRoutes.js";
import { sanitizeSoftBlockProfile } from "../../src/store.js";
import { syncDeviceUsageSnapshot } from "../../src/usage.js";
import type { UsageState } from "../../src/types.js";
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
  const dir = await mkdtemp(join(tmpdir(), "sentinel-distance-key-"));
  try {
    const state = defaultState();
    const keyPath = join(dir, "USB", "sentinel.key");
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
  assert.equal(shouldBlockSite(profile, "redd.it"), true);
  assert.equal(shouldBlockSite(profile, "fb.com"), true);
  assert.equal(shouldBlockSite(profile, "docs.google.com"), false);
  assert.equal(expandSiteTargets(["youtube.com"]).includes("youtu.be"), true);
  assert.equal(hostMatchesSiteTargets("mobile.twitter.com", ["x.com"]), true);
  assert.equal(shouldBlockSite(testProfile({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }), "youtu.be"), false);
  assert.equal(shouldBlockSite(testProfile({ mode: "allowlist", allowedSites: ["youtube.com"], blockedSites: [] }), "reddit.com"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/shorts/abc"), true);
  assert.equal(shouldBlockUrl(profile, "https://www.youtube.com/watch?v=abc"), false);
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
  assert.match(profileText, /SentinelPolicySignature:/);
}

{
  const state = defaultState();
  const usage = {};
  const explicit = evaluateExtensionCheck(state, usage, { url: "https://www.pornhub.com/", event: "navigation" }, now);
  assert.equal(explicit.blocked, true);
  assert.equal(recordValue(explicit.policy, "explicit policy").kind, "baseline");
  const baselineYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(baselineYoutube.blocked, false);

  const softProfile = profileById(state, SOFT_BLOCK_PROFILE_ID);
  const migratedSoftProfile = sanitizeSoftBlockProfile({
    ...softProfile,
    blockedApps: ["Instagram", "Discord"],
    blockedSites: ["instagram.com", "pornhub.com"],
    blockedUrlPatterns: ["instagram.com/explore", "instagram.com/reels"]
  });
  assert.deepEqual(migratedSoftProfile.blockedApps, ["Discord"]);
  assert.deepEqual(migratedSoftProfile.blockedSites, ["pornhub.com"]);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/explore"), false);
  assert.equal(migratedSoftProfile.blockedUrlPatterns.includes("instagram.com/reel"), true);
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
  assert.equal(instagramExplore.blocked, false);
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
  assert.equal(shouldBlockAppForPolicy(state, policy, "Sentinel"), false);
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
  assert.equal(mustPolicy(activeLimitPolicy(state, phoneUsage, { app: "Safari", hostname: "reddit.com" }, now)).kind, "limit");
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
  const result = evaluateExtensionCheck(state, usage, { url: "https://redd.it/abc123", event: "navigation" }, now);
  const redirect = new URL(stringValue(result.redirectUrl, "app lock redirect URL"));
  assert.equal(result.reason, "app-lock");
  assert.equal(recordValue(result.policy, "app lock policy").lockId, "lock-social");
  assert.equal(result.browserNoiseBlockingEnabled, true);
  assert.equal(redirect.searchParams.get("kind"), "app-lock");
  assert.equal(redirect.searchParams.get("lockId"), "lock-social");
  assert.equal(redirect.searchParams.get("return"), "https://redd.it/abc123");
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
      allowedSites: ["youtube.com", "instagram.com", "reddit.com"]
    }
  };
  const usage = {};
  const shorts = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/shorts/abc", event: "navigation" }, now);
  assert.equal(shorts.blocked, true);
  assert.equal(shorts.reason, "content-filter");
  assert.equal(must(shorts.contentFilter, "YouTube Shorts filter").id, "youtube-shorts");
  assert.equal(new URL(stringValue(shorts.redirectUrl, "content filter redirect URL")).searchParams.get("site"), "YouTube Shorts");
  const watch = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(watch.blocked, false);
  assert.equal(must(matchContentFilterUrl(state, "https://www.instagram.com/reels/xyz"), "Instagram reels filter").id, "instagram-reels");
  assert.equal(must(matchContentFilterUrl(state, "https://www.instagram.com/reel/xyz"), "Instagram reel filter").id, "instagram-reels");
  assert.equal(matchContentFilterUrl(state, "https://www.instagram.com/explore/"), null);
  state.settings.contentFilterEnabled = false;
  state.settings.safariUrlFilterEnabled = false;
  assert.equal(contentFilterEnabled(state), true);
  assert.equal(safariUrlFilterEnabled(state), true);
  assert.equal(must(matchContentFilterUrl(state, "https://www.youtube.com/shorts/abc"), "YouTube Shorts filter").id, "youtube-shorts");
  updateSettings(state.settings, { contentFilterEnabled: false, safariUrlFilterEnabled: false });
  assert.equal(state.settings.contentFilterEnabled, true);
  assert.equal(state.settings.safariUrlFilterEnabled, true);
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
