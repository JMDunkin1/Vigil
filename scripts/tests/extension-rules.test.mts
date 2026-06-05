import assert from "node:assert/strict";
import { contentFilterRuleEntries } from "../../src/contentFilters.js";
import { defaultState } from "../../src/defaults.js";
import { evaluateExtensionCheck, extensionRuleSnapshot } from "../../src/extensionPolicy.js";
import { activePolicy } from "../../src/policy.js";
import { must, now, stringValue, TEST_DAYS } from "./test-helpers.mjs";

{
  const state = defaultState();
  const usage = {};
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
  const blocked = evaluateExtensionCheck(state, usage, { url: "https://www.reddit.com/r/all", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  assert.match(stringValue(blocked.redirectUrl, "blocked redirect URL"), /\/blocked/);

  const allowed = evaluateExtensionCheck(state, usage, { url: "https://docs.google.com/document/u/0/", event: "navigation" }, now);
  assert.equal(allowed.blocked, false);

  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.rules.some((rule) => rule.domain === "reddit.com" && rule.redirectUrl.includes("/blocked")), true);
  assert.equal(rules.rules.some((rule) => rule.domain === "youtu.be"), true);
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
    profileId: "default",
    lockLevel: "deep",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: false,
    source: "manual"
  };
  const rules = extensionRuleSnapshot(state, now);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||youtube.com/shorts"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/reel"), true);
  assert.equal(rules.contentRules.some((rule) => rule.urlFilter === "||instagram.com/explore"), false);
  assert.equal(contentFilterRuleEntries(state, activePolicy(state, now)).some((rule) => rule.id === "reddit-popular"), true);
  state.settings.contentFilterEnabled = false;
  const disabledContentRules = extensionRuleSnapshot(state, now).contentRules;
  assert.equal(disabledContentRules.some((rule) => rule.id === "reddit-popular"), true);
  assert.equal(disabledContentRules.some((rule) => rule.kind === "url-pattern"), true);
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
