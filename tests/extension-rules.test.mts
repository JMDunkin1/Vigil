import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { contentFilterRuleEntries } from "../src/contentFilters.js";
import { SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { evaluateExtensionCheck, extensionRuleSnapshot } from "../src/extensionPolicy.js";
import { activePolicy } from "../src/policy.js";
import { must, now, recordValue, stringValue, TEST_DAYS } from "./test-helpers.mjs";

const [backgroundSource, contentSource] = await Promise.all([
  readFile(new URL("../extension/background.js", import.meta.url), "utf8"),
  readFile(new URL("../extension/content.js", import.meta.url), "utf8")
]);
assert.match(backgroundSource, /offlineCheckResult/);
assert.match(backgroundSource, /VIGIL_REQUEST_TIMEOUT_MS/);
assert.match(backgroundSource, /inFlightChecks/);
assert.match(backgroundSource, /duplicateCheckKey/);
assert.match(backgroundSource, /chrome\.alarms/);
assert.match(backgroundSource, /normalizedRuleUntil/);
assert.match(backgroundSource, /PERSISTENT_RULE_UNTIL/);
assert.match(backgroundSource, /vigilPulseFlags/);
assert.doesNotMatch(backgroundSource, /\nexport \{\};?\s*$/u, "the Chrome service worker must be emitted as a classic script");
assert.doesNotMatch(contentSource, /\nexport \{\};?\s*$/u, "Chrome content scripts cannot contain ESM export syntax");
assert.doesNotMatch(backgroundSource, /result\.signature\s*=\s*snapshot\.dynamicRuleSignature/);
assert.doesNotMatch(contentSource, /activateOfflineGuard/);
assert.doesNotMatch(contentSource, /data-vigil-page-guard-state/);
assert.ok(
  contentSource.indexOf("focusedSocialCleanupEnabled === true") < contentSource.indexOf("result.offline === true"),
  "cached cleanup flags must be applied before an offline pulse releases the page guard"
);

{
  const state = defaultState();
  const usage = {};
  const normalYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(normalYoutube.browserNoiseBlockingEnabled, true);
  assert.equal(normalYoutube.focusedSocialCleanupEnabled, false);
  assert.equal(extensionRuleSnapshot(state, now).focusedSocialCleanupEnabled, false);

  state.deviceControls.ios.enabled = true;
  state.deviceControls.ios.focusedSocial.youtube.home = false;
  state.deviceControls.ios.focusedSocial.instagram.explore = false;
  state.deviceControls.ios.focusedSocial.snapchat.stories = false;
  const iosFocusedSocial = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(iosFocusedSocial.focusedSocialCleanupEnabled, false);
  const iosCleanup = recordValue(iosFocusedSocial.focusedSocialCleanupSettings, "iOS cleanup settings");
  assert.equal(recordValue(iosCleanup.youtube, "YouTube cleanup settings").home, false);
  assert.equal(recordValue(iosCleanup.instagram, "Instagram cleanup settings").explore, false);
  assert.equal(recordValue(iosCleanup.snapchat, "Snapchat cleanup settings").stories, true);
  const snapshotCleanup = recordValue(extensionRuleSnapshot(state, now).focusedSocialCleanupSettings, "snapshot cleanup settings");
  assert.equal(recordValue(snapshotCleanup.youtube, "snapshot YouTube cleanup settings").home, false);
  assert.equal(recordValue(snapshotCleanup.snapchat, "snapshot Snapchat cleanup settings").stories, true);
  state.deviceControls.ios.focusedSocial.enabled = false;
  const iosFocusedSocialOff = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(iosFocusedSocialOff.focusedSocialCleanupEnabled, false);

  state.activeSession = {
    id: "strict",
    title: "Strict focus",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const activeYoutube = evaluateExtensionCheck(state, usage, { url: "https://www.youtube.com/watch?v=abc", event: "navigation" }, now);
  assert.equal(activeYoutube.focusedSocialCleanupEnabled, true);
  assert.equal(recordValue(recordValue(activeYoutube.focusedSocialCleanupSettings, "active cleanup settings").youtube, "active YouTube cleanup settings").home, false);
  assert.equal(extensionRuleSnapshot(state, now).focusedSocialCleanupEnabled, true);
  const blocked = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/all", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  assert.equal(stringValue(blocked.redirectUrl, "blocked redirect URL"), "https://www.reddit.com/");
  const normalReddit = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/learnprogramming/comments/demo", event: "navigation" }, now);
  assert.equal(normalReddit.blocked, false);
  assert.equal(normalReddit.paused, false);

  const allowed = evaluateExtensionCheck(state, usage, { url: "https://docs.google.com/document/u/0/", event: "navigation" }, now);
  assert.equal(allowed.blocked, false);

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(new Set(rules.contentRules.map((rule) => rule.urlFilter)).size, rules.contentRules.length);
  assert.equal(rules.dynamicRuleCount, rules.rules.length + rules.contentRules.length + rules.allowlistRules.length);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.redirectUrl.includes("/blocked")), false);
  assert.equal(rules.rules.some((rule) => rule.domain === "youtu.be"), false);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||reddit.com/r/all"), true);
}

{
  const state = defaultState();
  const usage = {};
  state.limitRules = [{
    id: "open-extension",
    name: "Extension Opens",
    enabled: true,
    type: "open",
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 30,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const result = evaluateExtensionCheck(state, usage, { url: "https://reddit.com/", event: "navigation" }, now);
  assert.equal(result.blocked, true);
  assert.equal(state.limitBlocks.length, 1);
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.reason === "limit"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-rules",
    title: "Content rules",
    mode: "focus",
    profileId: SOFT_BLOCK_PROFILE_ID,
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/shorts"), true);
  assert.equal(must(rules.contentRules.find((rule) => rule.urlFilter === "||youtube.com/shorts"), "YouTube Shorts dynamic rule").redirectUrl, "https://www.youtube.com/");
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/explore"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/feed/explore"), true);
  assert.equal(contentFilterRuleEntries(state, activePolicy(state, now)).some((rule) => rule.id === "reddit-popular"), true);
  state.settings.contentFilterEnabled = false;
  const disabledContentRules = extensionRuleSnapshot(state, now).contentRules;
  assert.equal(disabledContentRules.some((rule) => rule.id === "reddit-popular"), true);
  assert.equal(disabledContentRules.some((rule) => rule.kind === "url-pattern"), true);
}

{
  const state = defaultState();
  state.activeSession = {
    id: "content-fallbacks",
    title: "Content fallbacks",
    mode: "focus",
    profileId: "custom-allowlist",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual",
    profileSnapshot: {
      id: "custom-allowlist",
      name: "Content allowlist",
      mode: "allowlist",
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: ["youtube.com", "instagram.com"]
    }
  };
  const rules = extensionRuleSnapshot(state, now);
  const allowlistRule = must(rules.allowlistRules[0], "browser allowlist rule");
  assert.equal(allowlistRule.excludedDomains?.includes("::1"), true);
  assert.equal(allowlistRule.until, state.activeSession.endsAt);
  assert.equal(rules.dynamicRuleCount, rules.rules.length + rules.contentRules.length + rules.allowlistRules.length + 1);
  assert.equal(must(rules.contentRules.find((rule) => rule.urlFilter === "||youtube.com/shorts"), "allowed YouTube Shorts rule").redirectUrl, "https://www.youtube.com/");
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), false);
}

{
  const state = defaultState();
  state.activeSession = null;
  state.appLocks = [{
    id: "extension-lock",
    name: "Extension Lock",
    enabled: true,
    lockLevel: "deep",
    days: TEST_DAYS,
    apps: [],
    sites: ["reddit.com"],
    unlocksAllowed: 1,
    unlockMinutes: 5,
    delaySeconds: 0
  }];
  const rules = extensionRuleSnapshot(state, now);
  const reddit = must(rules.rules.find((rule) => rule.domain === "reddit.com"), "reddit extension rule");
  assert.equal(reddit.reason, "app-lock");
  assert.equal(new URL(reddit.redirectUrl).searchParams.get("lockId"), "extension-lock");
}

{
  const state = defaultState();
  state.integrity.stateSeal.tamperDetectedAt = now.toISOString();
  state.integrity.stateSeal.tamperDetail = "test integrity lockdown";
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.until === "until the tamper alarm is cleared"), true);
  assert.equal(rules.contentRules.every((rule) => rule.until === "until the tamper alarm is cleared"), true);
}

{
  const storage: Record<string, unknown> = {};
  const dynamicRuleUpdates: Array<Record<string, unknown>> = [];
  const alarmCreates: Array<{ name: string; options: Record<string, unknown> }> = [];
  const event = () => ({ addListener() {} });
  const context = createContext({
    AbortController,
    Headers,
    Response,
    URL,
    clearTimeout,
    console,
    fetch: async (url: string) => {
      if (String(url).includes("/api/extension/rules?")) {
        return new Response(JSON.stringify({
          rules: [],
          contentRules: [],
          allowlistRules: [],
          dynamicRuleCount: 0,
          dynamicRuleSignature: JSON.stringify({ site: [], content: [], allowlist: [], localServerAllow: false })
        }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    },
    setTimeout,
    chrome: {
      action: {
        setBadgeBackgroundColor(_options: unknown, callback: () => void) { callback(); },
        setBadgeText(_options: unknown, callback: () => void) { callback(); }
      },
      alarms: {
        create(name: string, options: Record<string, unknown>) { alarmCreates.push({ name, options }); },
        clear(_name: string, callback: () => void) { callback(); },
        onAlarm: event()
      },
      declarativeNetRequest: {
        updateDynamicRules(options: Record<string, unknown>, callback: () => void) {
          dynamicRuleUpdates.push(options);
          callback();
        }
      },
      runtime: {
        getManifest() { return { version: "0.3.2" }; },
        lastError: null,
        onInstalled: event(),
        onMessage: event(),
        onStartup: event()
      },
      storage: {
        local: {
          get(defaults: Record<string, unknown>, callback: (value: Record<string, unknown>) => void) {
            callback({ ...defaults, ...storage });
          },
          set(value: Record<string, unknown>, callback: () => void) {
            Object.assign(storage, value);
            callback();
          }
        },
        onChanged: event()
      },
      tabs: {
        get(_tabId: number, callback: (tab: { url: string }) => void) { callback({ url: "https://example.com/" }); },
        onActivated: event(),
        onRemoved: event(),
        onUpdated: event(),
        remove(_tabId: number, callback: () => void) { callback(); },
        sendMessage(_tabId: number, _message: unknown, callback: (response: unknown) => void) { callback({ ok: true }); },
        update(_tabId: number, _change: unknown, callback: () => void) { callback(); }
      },
      webNavigation: {
        onCommitted: event(),
        onHistoryStateUpdated: event()
      }
    }
  });
  runInContext(backgroundSource.replace(/\nexport \{\};?\s*$/u, ""), context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  dynamicRuleUpdates.length = 0;

  const runtimeNow = new Date();
  const runtimeState = defaultState();
  runtimeState.activeSession = {
    id: "runtime-signature",
    title: "Runtime signature",
    mode: "focus",
    profileId: "default",
    lockLevel: "deep",
    startedAt: runtimeNow.toISOString(),
    endsAt: new Date(runtimeNow.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const serverSnapshot = extensionRuleSnapshot(runtimeState, runtimeNow);
  Object.assign(context, {
    serverRules: serverSnapshot.rules,
    serverContentRules: serverSnapshot.contentRules,
    serverAllowlistRules: serverSnapshot.allowlistRules
  });
  const installedServerSnapshot = await runInContext(
    "syncSiteBlocking(serverRules, serverContentRules, serverAllowlistRules)",
    context
  ) as { count: number; signature: string };
  assert.equal(installedServerSnapshot.count, serverSnapshot.dynamicRuleCount);
  assert.equal(installedServerSnapshot.signature, serverSnapshot.dynamicRuleSignature);

  const persistentUntil = "until the tamper alarm is cleared";
  Object.assign(context, {
    testRules: [{ domain: "example.com", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    testContentRules: [
      { urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil },
      { urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }
    ],
    testAllowlistRules: [{
      excludedDomains: ["localhost", "::1", "127.0.0.1"],
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2099-01-01T00:00:00.000Z"
    }]
  });
  const result = await runInContext("syncSiteBlocking(testRules, testContentRules, testAllowlistRules)", context) as {
    ok: boolean;
    count: number;
    signature: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.count, 4);
  assert.deepEqual(JSON.parse(result.signature), {
    site: [{ domain: "example.com", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    content: [{ urlFilter: "||example.com/feed", redirectUrl: "http://127.0.0.1:8787/blocked", until: persistentUntil }],
    allowlist: [{
      excludedDomains: ["::1", "127.0.0.1", "localhost"],
      redirectUrl: "http://127.0.0.1:8787/blocked",
      until: "2099-01-01T00:00:00.000Z"
    }],
    localServerAllow: true
  });
  const latestUpdate = must(dynamicRuleUpdates.at(-1), "dynamic rule update") as { addRules?: Array<Record<string, unknown>> };
  assert.equal(latestUpdate.addRules?.length, 7);
  const siteTopLevelRule = must(latestUpdate.addRules?.find((rule) => rule.id === 10000), "installed top-level site rule");
  const siteEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 13000), "installed embedded site rule");
  assert.deepEqual(Array.from(recordValue(siteTopLevelRule.condition, "top-level site DNR condition").resourceTypes as unknown[]), ["main_frame"]);
  assert.equal(recordValue(siteEmbeddedRule.action, "embedded site DNR action").type, "block");
  assert.ok((recordValue(siteEmbeddedRule.condition, "embedded site DNR condition").resourceTypes as unknown[]).includes("media"));
  assert.ok((recordValue(siteEmbeddedRule.condition, "embedded site DNR condition").resourceTypes as unknown[]).includes("sub_frame"));
  const contentEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 14000), "installed embedded content rule");
  assert.deepEqual(Array.from(recordValue(contentEmbeddedRule.condition, "embedded content DNR condition").resourceTypes as unknown[]), ["sub_frame"]);
  const allowlistRule = must(latestUpdate.addRules?.find((rule) => rule.id === 12000), "installed allowlist rule");
  const condition = recordValue(allowlistRule.condition, "allowlist DNR condition");
  assert.equal(Array.isArray(condition.excludedRequestDomains) && condition.excludedRequestDomains.includes("::1"), true);
  const allowlistEmbeddedRule = must(latestUpdate.addRules?.find((rule) => rule.id === 15000), "installed embedded allowlist rule");
  const embeddedAllowlistCondition = recordValue(allowlistEmbeddedRule.condition, "embedded allowlist DNR condition");
  assert.deepEqual(Array.from(embeddedAllowlistCondition.resourceTypes as unknown[]), ["sub_frame"]);
  assert.equal(Array.isArray(embeddedAllowlistCondition.excludedRequestDomains) && embeddedAllowlistCondition.excludedRequestDomains.includes("example.com"), false);
  assert.equal(runInContext("normalizedRuleUntil(PERSISTENT_RULE_UNTIL)", context), persistentUntil);
  assert.equal(runInContext("duplicateCheckKey(1, 'https://example.com/', 'heartbeat', 5, {})", context), null);
  assert.equal(runInContext("duplicateCheckKey(1, 'https://example.com/', 'navigation', 1, {})", context), null);
  assert.notEqual(runInContext("duplicateCheckKey(1, 'https://example.com/', 'navigation', 0, {})", context), null);

  await runInContext("rememberPulseFlags({ focusedSocialCleanupEnabled: true, focusedSocialCleanupSettings: { enabled: true } })", context);
  runInContext("cachedPulseFlags = {}", context);
  await runInContext("loadPulseFlags()", context);
  const offline = runInContext("offlineCheckResult()", context) as Record<string, unknown>;
  assert.equal(offline.offline, true);
  assert.equal(offline.focusedSocialCleanupEnabled, true);
  assert.equal(alarmCreates.some((alarm) => alarm.name === "vigil-rule-expiry"), true);
}
