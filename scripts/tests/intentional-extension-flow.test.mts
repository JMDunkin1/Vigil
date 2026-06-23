import assert from "node:assert/strict";
import { defaultState, REQUIRED_EXTENSION_VERSION, SOFT_BLOCK_PROFILE_ID } from "../../src/defaults.js";
import { evaluateExtensionCheck } from "../../src/extensionPolicy.js";
import { accountabilityDigest, confirmIntentionalPause, intentionalUseDecision, intentionalUseSummary, skipIntentionalPause } from "../../src/intentionalUse.js";
import { must, now, stringValue, TEST_DAYS } from "./test-helpers.mjs";

{
  const state = defaultState();
  const usage = {};
  state.settings.activeProfileId = SOFT_BLOCK_PROFILE_ID;
  const normalReddit = evaluateExtensionCheck(state, usage, {
    url: "https://www.reddit.com/r/learnprogramming/comments/demo",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(normalReddit.paused, false);
  assert.equal(normalReddit.blocked, false);

  const popularReddit = evaluateExtensionCheck(state, usage, {
    url: "https://www.reddit.com/r/popular",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(popularReddit.paused, true);
  assert.equal(popularReddit.blocked, false);
  state.intentionalUse.pauses = [];

  const watch = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/watch?v=abc",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(watch.paused, false);
  assert.equal(watch.blocked, false);

  const first = evaluateExtensionCheck(state, usage, {
    url: "https://www.youtube.com/shorts/abc",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(first.paused, true);
  assert.equal(first.blocked, false);
  assert.match(stringValue(first.redirectUrl, "pause redirect URL"), /\/pause\?requestId=/);
  assert.equal(state.intentionalUse.pauses.length, 1);
  const pauseId = must(first.pause, "first pause").id;
  must(state.intentionalUse.pauses[0], "stored pause").eligibleAt = now.toISOString();
  const continued = confirmIntentionalPause(state, pauseId, {
    intention: "Watch one specific tutorial",
    mood: "Focused"
  }, now);
  assert.equal(continued.grant.targetType, "url");
  const allowed = evaluateExtensionCheck(state, usage, {
    url: "https://youtube.com/shorts/abc",
    previousUrl: "",
    event: "activated",
    seconds: 45,
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, new Date(now.getTime() + 1000));
  assert.equal(allowed.paused, false);
  assert.equal(allowed.blocked, false);
  assert.equal(intentionalUseSummary(state, usage, new Date(now.getTime() + 1000)).today.continued, 1);
  assert.equal(intentionalUseSummary(state, usage, new Date(now.getTime() + 1000)).today.seconds, 45);

  const manual = intentionalUseDecision(state, { app: "YouTube", hostname: "", url: "" }, { event: "mac-app" }, now);
  assert.equal(manual.shouldPause, false);

  const unlockedState = defaultState();
  unlockedState.appLocks = [{
    id: "youtube-lock",
    name: "YouTube lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["youtube.com"],
    unlocksAllowed: 1,
    unlockMinutes: 10,
    delaySeconds: 0
  }];
  unlockedState.appLockUnlocks = [{
    id: "youtube-unlock",
    lockId: "youtube-lock",
    lockName: "YouTube lock",
    createdAt: now.toISOString(),
    until: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    reason: "Watch one intentional video"
  }];
  const appLockUnlocked = evaluateExtensionCheck(unlockedState, {}, {
    url: "https://www.youtube.com/shorts/abc",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, now);
  assert.equal(appLockUnlocked.paused, false);
  assert.equal(appLockUnlocked.blocked, false);

  const appState = defaultState();
  appState.intentionalUse.rules = [{
    id: "app-pause",
    name: "Game pause",
    enabled: true,
    frictionLevel: "gentle",
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
    apps: ["Chess"],
    sites: [],
    delaySeconds: 0,
    sessionMinutes: 5,
    dailyBudgetMinutes: 0
  }];
  const appPause = intentionalUseDecision(appState, { app: "Chess", hostname: "", url: "" }, { event: "mac-app" }, now);
  assert.equal(appPause.shouldPause, true);
  assert.equal(must(appPause.pause, "app pause").targetType, "app");
  must(appState.intentionalUse.pauses[0], "stored app pause").eligibleAt = now.toISOString();
  const appContinued = confirmIntentionalPause(appState, must(appPause.pause, "app pause").id, { intention: "One puzzle" }, now);
  assert.equal(appContinued.grant.app, "Chess");
  assert.equal(appContinued.returnUrl, "");

  const second = evaluateExtensionCheck(state, usage, {
    url: "https://www.instagram.com/reels/123",
    previousUrl: "",
    event: "navigation",
    extensionVersion: REQUIRED_EXTENSION_VERSION
  }, new Date(now.getTime() + 16 * 60 * 1000));
  assert.equal(second.paused, true);
  skipIntentionalPause(state, must(second.pause, "second pause").id, { replacement: "Open Notes instead" }, new Date(now.getTime() + 16 * 60 * 1000));
  const digest = accountabilityDigest(state, usage, now);
  assert.match(digest.text, /Intentional pauses:/);
  assert.equal(digest.skipped, 1);
}
