import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PORT, defaultState } from "../src/defaults.js";
import { intentionalUseDecision } from "../src/intentionalUse.js";
import { HUMAN_ACTIVITY_RESTART_DELAYS_MS, humanActivityHelperArguments } from "../src/macos.js";
import type { BrowserActivitySignal } from "../src/macos.js";
import {
  BROWSER_ACTIVITY_PERSISTENCE_RETRY_DELAYS_MS,
  BROWSER_ACTIVITY_PERSISTENCE_SHUTDOWN_MAX_ATTEMPTS,
  Monitor
} from "../src/monitor.js";
import { BrowserActivityBurstScheduler } from "../src/monitor/browserActivity.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import { dateKey } from "../src/time.js";
import { recordUsage } from "../src/usage.js";

{
  const state = defaultState();
  const usage = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  let url = "https://www.google.com/";
  let enforcementChecks = 0;
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "google.com",
    url
  });
  monitor.enforce = async () => {
    enforcementChecks += 1;
  };

  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;
  assert.equal(enforcementChecks, 1);
  assert.equal(snapshotWrites, 0, "an allowed activity probe must not write a sealed runtime snapshot");

  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;
  assert.equal(enforcementChecks, 1, "an unchanged browser URL must not enter the mutation coordinator again");

  url = "https://www.google.com/search?q=blocked-term";
  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;
  assert.equal(enforcementChecks, 2, "a URL transition during the burst must be evaluated");
  assert.equal(snapshotWrites, 0);

  monitor.readFrontmost = async () => ({ ok: true, app: "Codex", hostname: "", url: "" });
  assert.equal(await monitor.probeBrowserActivity(), true, "non-browser activity must retain a short browser-activation grace period");
  assert.equal(enforcementChecks, 2);

  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "example.com",
    url: "https://example.com/after-browser-activation"
  });
  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;
  assert.equal(enforcementChecks, 3, "a browser activated just after a click must still be evaluated");

  let staleRead = true;
  const staleReadOptions: Array<{ fresh?: boolean; updateHealth?: boolean }> = [];
  monitor.readFrontmost = async (options = {}) => {
    staleReadOptions.push(options);
    if (staleRead) {
      staleRead = false;
      return {
        ok: true,
        app: "Safari",
        hostname: "stale.example",
        url: "https://stale.example/blocked"
      };
    }
    return { ok: true, app: "Codex", hostname: "", url: "" };
  };
  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;
  assert.equal(enforcementChecks, 3, "the serialized re-read must not enforce a tab that is no longer frontmost");
  assert.deepEqual(staleReadOptions, [
    { fresh: true, updateHealth: false },
    { fresh: true }
  ], "both the candidate and final validation must bypass the cached frontmost app");
  assert.equal("lastBrowserActivity" in monitor.status, false, "global input timing must not be exposed through monitor status");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage = {};
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    committedRevision: () => coordinator.committedRevision(),
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  const sameUrl = "https://example.com/continuity-network";
  let evaluations = 0;
  monitor.readFrontmost = async () => ({ ok: true, app: "Safari", hostname: "example.com", url: sameUrl });
  monitor.enforce = async () => { evaluations += 1; };

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(evaluations, 1);
  await coordinator.run(async ({ state: draftState }) => {
    draftState.settings.systemNetworkBlockingEnabled = !draftState.settings.systemNetworkBlockingEnabled;
  }, { persist: false });
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(evaluations, 2,
    "the same URL in one continuity must re-evaluate after a committed network-only enforcement change");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  const encodedBlockedTarget = encodeURIComponent("https://www.google.com/search?q=porn");
  const vigilBlockedPage = `http://127.0.0.1:${PORT}/blocked?back=${encodedBlockedTarget}#details`;
  const lookalikes = [
    `http://127.0.0.1:${PORT}/blocked/?back=${encodedBlockedTarget}`,
    `http://127.0.0.1:${PORT}/blocked-copy?back=${encodedBlockedTarget}`,
    `http://127.0.0.1:${PORT + 1}/blocked?back=${encodedBlockedTarget}`,
    `http://localhost:${PORT}/blocked?back=${encodedBlockedTarget}`,
    `https://127.0.0.1:${PORT}/blocked?back=${encodedBlockedTarget}`,
    `https://example.com/blocked?back=${encodedBlockedTarget}`
  ];

  assert.equal(
    monitor.browserBlockDecision({ app: "Safari", hostname: "127.0.0.1", url: vigilBlockedPage }),
    null,
    "the fast path must leave Vigil's exact blocker route visible even when its back query contains a blocked URL"
  );
  for (const url of lookalikes) {
    assert.ok(
      monitor.browserBlockDecision({ app: "Safari", hostname: new URL(url).hostname, url }),
      `the fast path must still evaluate blocker-route lookalike ${url}`
    );
  }

  let scheduledPolicyEvaluations = 0;
  monitor.policyForTarget = () => {
    scheduledPolicyEvaluations += 1;
    return null;
  };
  await monitor.enforce({ app: "Safari", hostname: "127.0.0.1", url: vigilBlockedPage });
  assert.equal(scheduledPolicyEvaluations, 1,
    "scheduled enforcement must still evaluate app policy on the exact blocker route");
  for (const url of lookalikes) {
    await monitor.enforce({ app: "Safari", hostname: new URL(url).hostname, url });
  }
  assert.equal(scheduledPolicyEvaluations, lookalikes.length + 1,
    "scheduled enforcement must not exempt same-origin paths or origin lookalikes");
}

{
  const state = defaultState();
  const usage = {};
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    committedRevision: () => coordinator.committedRevision(),
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  const sameUrl = "https://example.com/continuity-policy";
  let sample = { ok: true as const, app: "Safari", hostname: "example.com", url: sameUrl };
  let appPolicyEnabled = false;
  let appBlocks = 0;
  const appPolicy = {
    kind: "manual" as const,
    session: {
      id: "continuity-app-policy",
      title: "Continuity app policy",
      mode: "focus",
      profileId: "default",
      lockLevel: "deep" as const,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString()
    },
    profile: {
      id: "default",
      name: "Default",
      mode: "blocklist" as const,
      blockedApps: ["Safari"],
      blockedSites: [],
      blockedUrlPatterns: [],
      allowedApps: [],
      allowedSites: []
    },
    endsAt: new Date(Date.now() + 60_000).toISOString()
  };
  monitor.readFrontmost = async () => sample;
  monitor.policyForTarget = () => appPolicyEnabled ? appPolicy : null;
  monitor.pauseIntentionalUse = async () => false;
  monitor.blockApp = async () => { appBlocks += 1; };

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(appBlocks, 0, "an unchanged allowed URL may be de-duplicated within one browsing continuity");

  appPolicyEnabled = true;
  await coordinator.run(async ({ state: draftState }) => {
    draftState.profiles[0]!.blockedApps = [...draftState.profiles[0]!.blockedApps, "Safari"];
  }, { persist: false });
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(appBlocks, 1,
    "the same URL in one continuity must re-evaluate after a committed app-only policy change");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage = {};
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    committedRevision: () => coordinator.committedRevision(),
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  const sameUrl = "https://example.com/continuity-intentional";
  let sample = { ok: true as const, app: "Safari", hostname: "example.com", url: sameUrl };
  let intentionalPolicyEnabled = false;
  let intentionalChecks = 0;
  monitor.readFrontmost = async () => sample;
  monitor.policyForTarget = () => null;
  monitor.pauseIntentionalUse = async () => {
    intentionalChecks += 1;
    return intentionalPolicyEnabled;
  };

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(intentionalChecks, 1);
  intentionalPolicyEnabled = true;
  await coordinator.run(async ({ state: draftState }) => {
    draftState.intentionalUse.rules = [{
      ...draftState.intentionalUse.rules[0]!,
      id: "committed-continuity-rule",
      name: "Committed continuity rule"
    }];
  }, { persist: false });
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(intentionalChecks, 2,
    "the same URL in one continuity must re-evaluate after a committed intentional-use rule change");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage = {};
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    committedRevision: () => coordinator.committedRevision(),
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  const sameUrl = "https://example.com/continuity-limit";
  let limitPolicyEnabled = false;
  let evaluations = 0;
  monitor.readFrontmost = async () => ({ ok: true, app: "Safari", hostname: "example.com", url: sameUrl });
  monitor.enforce = async () => { evaluations += 1; };

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(evaluations, 1);

  limitPolicyEnabled = true;
  await coordinator.run(async ({ usage: draftUsage }) => {
    draftUsage[dateKey()] = {
      apps: { Safari: { seconds: 60 } },
      sites: {},
      opens: { apps: {}, sites: {} }
    } as never;
  }, { persist: false });
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(limitPolicyEnabled, true);
  assert.equal(evaluations, 2,
    "the same URL in one continuity must re-evaluate after committed usage changes can cross a limit");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const baseNow = Date.now();
  let policyNow = baseNow;
  const monitor = new Monitor({ state, usage: {}, browserActivityNow: () => policyNow });
  const sameUrl = "https://example.com/stale-policy-marker";
  let evaluations = 0;
  monitor.readFrontmost = async () => ({ ok: true, app: "Safari", hostname: "example.com", url: sameUrl });
  monitor.enforce = async () => {
    evaluations += 1;
    if (evaluations === 1) policyNow = Math.floor(baseNow / 60_000) * 60_000 + 60_000;
  };

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(monitor.lastBrowserActivityEvaluatedTarget, "",
    "a queued check must not publish a de-duplication marker after its policy-time generation changes");
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(evaluations, 2,
    "the unchanged URL must be evaluated again when the stale queued check could not publish its marker");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  const sameUrl = "https://example.com/stale-queued-check";
  let sample = { ok: true as const, app: "Safari", hostname: "example.com", url: sameUrl };
  let evaluations = 0;
  monitor.readFrontmost = async () => sample;
  monitor.enforce = async () => { evaluations += 1; };
  let releaseRoutineWork = () => {};
  const routineWork = new Promise<void>((resolve) => { releaseRoutineWork = resolve; });
  monitor.enqueueOperation(async () => await routineWork);

  await monitor.probeBrowserActivity();
  sample = { ok: true, app: "Codex", hostname: "", url: "" };
  await monitor.probeBrowserActivity();
  releaseRoutineWork();
  await monitor.operationTail;
  assert.equal(evaluations, 0, "a queued check from a broken browsing continuity must be discarded");
  assert.equal(monitor.lastBrowserActivityEvaluatedTarget, "",
    "a stale queued check must not repopulate browser de-duplication after continuity loss");

  sample = { ok: true, app: "Safari", hostname: "example.com", url: sameUrl };
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(evaluations, 1, "the same URL must be evaluated after returning from the broken continuity");
}

{
  const state = defaultState();
  state.intentionalUse.rules = [{
    id: "safari-intentional-use",
    name: "Pause before Safari",
    enabled: true,
    frictionLevel: "standard",
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "00:00",
    apps: ["Safari"],
    sites: [],
    urlPatterns: [],
    delaySeconds: 30,
    sessionMinutes: 10,
    dailyBudgetMinutes: 60
  }];
  const monitor = new Monitor({ state, usage: {} });
  const blockedTarget = "https://www.google.com/search?q=porn";
  const vigilBlockedPage = `http://127.0.0.1:${PORT}/blocked?back=${encodeURIComponent(blockedTarget)}`;
  const urlPolicy = {
    kind: "manual" as const,
    session: {
      id: "blocked-url-policy",
      title: "Blocked URL",
      mode: "focus",
      profileId: "blocked-url-profile",
      lockLevel: "deep" as const,
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString()
    },
    profile: {
      id: "blocked-url-profile",
      name: "Blocked URL",
      mode: "blocklist" as const,
      blockedApps: [],
      blockedSites: [],
      blockedUrlPatterns: ["porn"],
      allowedApps: [],
      allowedSites: []
    },
    endsAt: new Date(Date.now() + 60_000).toISOString()
  };
  const policySamples: Array<{ app: string; hostname: string; url: string }> = [];
  const intentionalUseSamples: Array<{ app: string; hostname: string; url: string }> = [];
  monitor.policyForTarget = (sample) => {
    const captured = {
      app: sample.app || "",
      hostname: sample.hostname || "",
      url: sample.url || ""
    };
    policySamples.push(captured);
    return captured.url.includes("porn") ? urlPolicy : null;
  };
  monitor.pauseIntentionalUse = async (sample) => {
    intentionalUseSamples.push({ ...sample });
    return intentionalUseDecision(state, sample, { event: "mac-app" }).shouldPause;
  };

  await monitor.enforce({ app: "Safari", hostname: "127.0.0.1", url: vigilBlockedPage });

  const appOnlySample = { app: "Safari", hostname: "", url: "" };
  assert.deepEqual(policySamples, [appOnlySample],
    "the exact blocker route must not let its encoded back URL select a site or URL policy");
  assert.deepEqual(intentionalUseSamples, [appOnlySample],
    "an app-targeted intentional-use rule must still be evaluated on the exact blocker route");
  assert.equal(state.intentionalUse.pauses[0]?.ruleId, "safari-intentional-use",
    "the app-targeted intentional-use rule must interrupt use while the blocker route is visible");
}

{
  const state = defaultState();
  state.settings.appQuitEnabled = true;
  state.settings.processSweepEnabled = false;
  const monitor = new Monitor({ state, usage: {} });
  const blockedTarget = "https://www.google.com/search?q=porn";
  const vigilBlockedPage = `http://127.0.0.1:${PORT}/blocked?back=${encodeURIComponent(blockedTarget)}`;
  const endsAt = new Date(Date.now() + 60_000).toISOString();
  const policy = {
    kind: "manual" as const,
    session: {
      id: "blocked-browser-policy",
      title: "Blocked browser",
      mode: "focus",
      profileId: "blocked-browser-profile",
      lockLevel: "deep" as const,
      startedAt: new Date().toISOString(),
      endsAt
    },
    profile: {
      id: "blocked-browser-profile",
      name: "Blocked browser",
      mode: "blocklist" as const,
      blockedApps: ["Safari"],
      blockedSites: ["127.0.0.1"],
      blockedUrlPatterns: ["porn"],
      allowedApps: [],
      allowedSites: []
    },
    endsAt
  };
  let appBlocks = 0;
  let siteBlocks = 0;
  const policySamples: Array<{ app: string; hostname: string; url: string }> = [];
  const appBlockSamples: Array<{ app: string; hostname: string; url: string }> = [];
  monitor.policyForTarget = (sample) => {
    policySamples.push({
      app: sample.app || "",
      hostname: sample.hostname || "",
      url: sample.url || ""
    });
    return policy;
  };
  monitor.blockApp = async (sample) => {
    appBlocks += 1;
    appBlockSamples.push({ ...sample });
  };
  monitor.blockSite = async () => { siteBlocks += 1; };

  await monitor.enforce({ app: "Safari", hostname: "127.0.0.1", url: vigilBlockedPage });

  const appOnlySample = { app: "Safari", hostname: "", url: "" };
  assert.deepEqual(policySamples, [appOnlySample],
    "app blocking on the exact blocker route must be selected from an app-only policy sample");
  assert.deepEqual(appBlockSamples, [appOnlySample],
    "the exact blocker route must be stripped before app enforcement bookkeeping");
  assert.equal(siteBlocks, 0, "the exact Vigil blocker route must not be redirected again");
  assert.equal(appBlocks, 1,
    "a browser blocked at the app level must still be quit while its blocker route is active");
}

{
  const state = defaultState();
  const blockedUrl = "https://www.google.com/search?q=porn";
  const redirects: Array<{ app: string; target: string; currentUrl: string }> = [];
  const monitor = new Monitor({
    state,
    usage: {},
    browserRedirect: async (app, target, options = {}) => {
      redirects.push({ app, target, currentUrl: options.currentUrl || "" });
      return { ok: true, matched: true, redirectedTabCount: 1, method: "test-exact-tab" };
    }
  });
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "google.com",
    url: blockedUrl
  });

  let releaseRoutineWork = () => {};
  const routineWork = new Promise<void>((resolve) => { releaseRoutineWork = resolve; });
  monitor.enqueueOperation(async () => await routineWork);
  monitor.lastBrowserActivityEvaluatedTarget = `Safari\n${blockedUrl}`;

  assert.equal(await monitor.probeBrowserActivity(), true,
    "a confirmed exact-tab block must retain its recovery tail until bookkeeping commits");
  assert.equal(redirects.length, 1, "a blocked browser target must redirect before stalled routine monitor work completes");
  assert.deepEqual(
    { app: redirects[0]?.app, currentUrl: redirects[0]?.currentUrl },
    { app: "Safari", currentUrl: blockedUrl },
    "the immediate redirect must carry the exact observed tab URL as its atomic precondition"
  );
  const blockerTarget = new URL(redirects[0]?.target || "");
  assert.equal(blockerTarget.hostname, "127.0.0.1");
  assert.equal(blockerTarget.pathname, "/blocked");
  assert.equal(blockerTarget.searchParams.get("back"), "https://www.google.com/");
  assert.equal(decodeURIComponent(blockerTarget.toString()).includes(blockedUrl), false,
    "the blocker receipt must never embed the URL that Safari just denied");

  releaseRoutineWork();
  await monitor.operationTail;
  assert.equal(monitor.status.lastEnforcement?.type, "url", "successful fast blocking must still be recorded after serialization resumes");
}

{
  const state = defaultState();
  const blockedUrl = "https://www.google.com/search?q=porn";
  let redirectAttempts = 0;
  const monitor = new Monitor({
    state,
    usage: {},
    externalEffectsEnabled: false,
    browserRedirect: async () => {
      redirectAttempts += 1;
      return { ok: true, matched: true, redirectedTabCount: 1, method: "unexpected-test-redirect" };
    }
  });
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "google.com",
    url: blockedUrl
  });

  assert.equal(await monitor.probeBrowserActivity(), true,
    "an isolated runtime must still evaluate blocked browser activity");
  await monitor.operationTail;
  assert.equal(redirectAttempts, 0,
    "an isolated test runtime must never redirect the developer's live browser");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  const safe = { ok: true as const, app: "Safari", hostname: "example.com", url: "https://example.com/work" };
  const blocked = { ok: true as const, app: "Safari", hostname: "google.com", url: "https://www.google.com/search?q=porn" };
  monitor.applyFrontmostSample(safe);
  monitor.applyFrontmostSample(blocked);
  const policy = monitor.policyForTarget(blocked);
  assert.ok(policy, "the normal monitor path must identify the blocked explicit search");
  const target = new URL(monitor.blockedPageTarget(blocked, policy));
  assert.equal(target.searchParams.get("back"), safe.url,
    "scheduled enforcement must preserve the prior validated page instead of overwriting it with the blocked sample");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  const safe = { ok: true as const, app: "Safari", hostname: "example.com", url: "https://example.com/work" };
  const previousBlocked = { ok: true as const, app: "Safari", hostname: "pornhub.com", url: "https://www.pornhub.com/video/first" };
  const currentBlocked = { ok: true as const, app: "Safari", hostname: "pornhub.com", url: "https://www.pornhub.com/video/second" };
  monitor.applyFrontmostSample(safe);
  monitor.applyFrontmostSample(previousBlocked);
  const policy = monitor.policyForTarget(currentBlocked);
  assert.ok(policy, "the fast path must identify the newly observed blocked URL");
  const target = new URL(monitor.blockedPageTarget(currentBlocked, policy));
  assert.equal(target.searchParams.get("back"), safe.url,
    "a denied last sample must fall through to the older validated page instead of discarding it");
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "transactional-browser-limit",
    name: "Transactional browser limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const usage = {};
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {});
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    )
  });
  const blocked = { ok: true as const, app: "Safari", hostname: "reddit.com", url: "https://www.reddit.com/r/typescript/" };
  let redirect = "";
  await monitor.enqueueMutationOperation(async () => {
    monitor.applyFrontmostSample(blocked);
    recordUsage(monitor.usage, blocked, 61);
    const policy = monitor.policyForTarget(blocked);
    assert.ok(policy?.limitBlock, "crossing the limit inside the transaction must create a draft limit block");
    redirect = monitor.blockedPageTarget(blocked, policy);
  });
  const target = new URL(redirect);
  assert.equal(target.searchParams.has("back"), false,
    "a newly denied origin must be validated against the draft restriction before entering the blocker URL");
  assert.equal(decodeURIComponent(target.toString()).includes("reddit.com"), false);
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "fast-browser-limit",
    name: "Fast browser limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const usage = {};
  recordUsage(usage, { app: "Safari", hostname: "reddit.com" }, 61);
  let snapshotWrites = 0;
  let persistedLimitBlockCount = 0;
  let persistedCycleAnchor = "";
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async (snapshotState) => {
    snapshotWrites += 1;
    persistedLimitBlockCount = snapshotState.limitBlocks.length;
    persistedCycleAnchor = snapshotState.limitRules[0]?.cycleAnchorDateKey || "";
  });
  const blockedUrl = "https://www.reddit.com/r/typescript/";
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    ),
    browserRedirect: async () => ({ ok: true, matched: true, redirectedTabCount: 1, method: "test-exact-tab" })
  });
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "reddit.com",
    url: blockedUrl
  });

  assert.equal(state.limitBlocks.length, 0);
  assert.equal(await monitor.probeBrowserActivity(), true);
  await monitor.operationTail;

  assert.equal(state.limitBlocks.length, 1,
    "a limit discovered by an exact-tab redirect must be committed to live state");
  assert.equal(state.limitBlocks[0]?.ruleId, "fast-browser-limit");
  assert.ok(state.limitRules[0]?.cycleAnchorDateKey,
    "a rolling timed limit discovered by the fast path must commit its cycle anchor");
  assert.equal(state.limitRules[0]?.cycleAnchorSeconds, 61);
  assert.equal(snapshotWrites, 1,
    "a confirmed fast-path block must persist its bookkeeping immediately");
  assert.equal(persistedLimitBlockCount, 1,
    "the immediate snapshot must contain the newly created limit block");
  assert.ok(persistedCycleAnchor,
    "the immediate snapshot must contain the rolling-cycle anchor");

  state.limitBlocks = [];
  assert.equal(monitor.browserBlockDecision({ app: "Safari", hostname: "reddit.com", url: blockedUrl }), null,
    "the committed cycle anchor must prevent an immediate fresh-expiry block from being recreated");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "retry-fast-browser-limit",
    name: "Retry fast browser limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const usage = {};
  const policyStart = new Date();
  policyStart.setHours(12, 0, 0, 0);
  let policyNow = policyStart.getTime();
  recordUsage(usage, { app: "Safari", hostname: "reddit.com" }, 61, new Date(policyNow));
  let failSnapshot = true;
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
    if (failSnapshot) throw new Error("deterministic fast-block snapshot failure");
  });
  const blockedUrl = "https://www.reddit.com/r/typescript/";
  let currentUrl = blockedUrl;
  let frontReads = 0;
  let redirects = 0;
  const monitor = new Monitor({
    state,
    usage,
    browserActivityNow: () => policyNow,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    ),
    browserRedirect: async () => {
      redirects += 1;
      return { ok: true, matched: true, redirectedTabCount: 1, method: "test-exact-tab" };
    }
  });
  monitor.readFrontmost = async () => {
    frontReads += 1;
    return {
      ok: true,
      app: "Safari",
      hostname: new URL(currentUrl).hostname,
      url: currentUrl
    };
  };

  let recoveryWakes = 0;
  const recoveryWakeProbe = new BrowserActivityBurstScheduler(() => {
    recoveryWakes += 1;
    return false;
  });
  monitor.browserActivityBurst = recoveryWakeProbe;
  const persistenceErrors: string[] = [];
  const originalConsoleError = console.error;
  console.error = (...values) => { persistenceErrors.push(values.map(String).join(" ")); };
  try {
    assert.equal(await monitor.probeBrowserActivity(), true);
    await monitor.operationTail;
    await Promise.resolve();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(state.limitBlocks.length, 0,
    "a failed snapshot must roll the speculative limit block out of live state");
  assert.equal(state.events.filter((event) => event.type === "blocked_site").length, 0,
    "a failed snapshot must roll back the confirmed-redirect event before replay");
  assert.equal(monitor.pendingBrowserActivityMutations.size, 1,
    "the exact fast-path decision must remain available for retry after rollback");
  assert.equal(recoveryWakes, 0,
    "a failed fast-path commit must not create an unbounded self-waking retry loop");
  assert.match(persistenceErrors[0] || "", /could not persist browser-activity block bookkeeping/u);
  assert.equal(monitor.status.componentHealth["browser-activity-persistence"]?.state, "degraded");
  assert.match(
    monitor.status.componentHealth["browser-activity-persistence"]?.error || "",
    /deterministic fast-block snapshot failure/u,
    "the persistence failure must be visible in monitor health"
  );
  const pending = [...monitor.pendingBrowserActivityMutations.values()][0]!;
  assert.equal(pending.attempts, 1);
  assert.ok(pending.nextRetryAt > Date.now(),
    "a failed fast-path commit must receive an exponential retry due-time");
  monitor.retryPendingBrowserActivityMutations();
  await monitor.operationTail;
  assert.equal(snapshotWrites, 1,
    "retry probes before the due-time must not produce another snapshot or log loop");

  assert.equal(await monitor.probeBrowserActivity(), true,
    "Back navigation to the same blocked URL must still reapply the exact-tab redirect while bookkeeping is pending");
  await monitor.operationTail;
  assert.equal(redirects, 2,
    "pending bookkeeping must deduplicate persistence without suppressing re-enforcement");
  assert.equal(snapshotWrites, 1);
  assert.equal(monitor.pendingBrowserActivityMutations.size, 1);

  policyNow += 31 * 60 * 1000;
  recordUsage(usage, { app: "Safari", hostname: "reddit.com" }, 539, new Date(policyNow));
  failSnapshot = false;
  pending.nextRetryAt = 0;
  currentUrl = `http://127.0.0.1:${PORT}/blocked?back=${encodeURIComponent(blockedUrl)}`;
  monitor.lastBrowserActivityEvaluatedTarget = `Safari\n${currentUrl}`;
  monitor.lastBrowserActivityEvaluatedPolicyGeneration = monitor.currentBrowserActivityPolicyGeneration();
  assert.equal(await monitor.probeBrowserActivity(), true,
    "the queued decision must retry even after the browser has reached Vigil's blocked page");
  await monitor.operationTail;
  await Promise.resolve();

  assert.equal(state.limitBlocks[0]?.ruleId, "retry-fast-browser-limit",
    "the retry must restore the site-only limit block without observing the original URL again");
  assert.equal(state.limitBlocks[0]?.createdAt, new Date(policyNow).toISOString(),
    "a delayed replay must create the limit block at the current policy time, not the original redirect time");
  assert.equal(state.limitBlocks[0]?.until, new Date(policyNow + 30 * 60 * 1000).toISOString(),
    "a delayed replay must leave a full active block instead of persisting an already-expired block");
  assert.ok(Date.parse(state.limitBlocks[0]?.until || "") > policyNow,
    "the recovered limit block must be active when its current-usage anchor is advanced");
  assert.equal(state.limitRules[0]?.cycleAnchorSeconds, 600,
    "replay must anchor the usage that triggered the current block, not advance an anchor from stale evidence");
  assert.equal(state.limitRules[0]?.cycleAnchorDateKey, dateKey(new Date(policyNow)));
  assert.equal(state.events.filter((event) => event.type === "blocked_site").length, 1,
    "replaying confirmed redirect bookkeeping must commit exactly one event after rollback");
  assert.equal(snapshotWrites, 2);
  assert.equal(redirects, 2, "bookkeeping recovery must not redirect the already replaced tab again");
  assert.equal(frontReads, 3);
  assert.equal(monitor.pendingBrowserActivityMutations.size, 0);
  assert.equal(monitor.status.componentHealth["browser-activity-persistence"]?.state, "healthy");

  await recoveryWakeProbe.stop();
  monitor.browserActivityBurst = null;
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const blockedUrl = "https://www.google.com/search?q=porn";
  let redirects = 0;
  const monitor = new Monitor({
    state,
    usage: {},
    browserRedirect: async () => {
      redirects += 1;
      return { ok: true };
    }
  });
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "google.com",
    url: blockedUrl
  });
  monitor.enforce = async () => {};

  assert.equal(await monitor.probeBrowserActivity(), true,
    "an ambiguous redirect success must retain the sparse recovery tail");
  await monitor.operationTail;
  assert.equal(redirects, 1);
}

{
  const state = defaultState();
  const usage = {};
  let failMutation = true;
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation) => {
      const result = await operation(state, usage, () => {});
      if (failMutation) throw new Error("deterministic browser-activity rollback");
      return result;
    }
  });
  const allowedUrl = "https://example.com/reference";
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "example.com",
    url: allowedUrl
  });
  monitor.enforce = async () => {};

  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(monitor.lastBrowserActivityEvaluatedTarget, "",
    "a rolled-back monitor mutation must not poison browser target deduplication");

  failMutation = false;
  await Promise.resolve();
  await monitor.probeBrowserActivity();
  await monitor.operationTail;
  assert.equal(monitor.lastBrowserActivityEvaluatedTarget, `Safari\n${allowedUrl}`,
    "the same URL must be evaluated again after rollback");
}

{
  const state = defaultState();
  const monitor = new Monitor({ state, usage: {} });
  const previous = process.env.VIGIL_BROWSER_ACTIVITY_WATCH;
  process.env.VIGIL_BROWSER_ACTIVITY_WATCH = "0";
  monitor.startBrowserActivityAcceleration();
  assert.equal(monitor.browserActivityBurst, null, "the activity off-switch must disable the default source completely");
  if (previous === undefined) delete process.env.VIGIL_BROWSER_ACTIVITY_WATCH;
  else process.env.VIGIL_BROWSER_ACTIVITY_WATCH = previous;
}

{
  const state = defaultState();
  const source: { listener?: (signal: BrowserActivitySignal) => void } = {};
  let unsubscribed = 0;
  let probes = 0;
  const applicationSignals: string[] = [];
  const monitor = new Monitor({
    state,
    usage: {},
    browserActivitySubscribe(listener) {
      source.listener = listener;
      return () => { unsubscribed += 1; };
    },
    browserActivityBurstDependencies: {
      now: () => 0,
      setTimeout(callback) {
        queueMicrotask(callback);
        return callback;
      },
      clearTimeout() {}
    }
  });
  monitor.runScheduledTick = async () => {};
  monitor.probeBrowserActivity = async () => {
    probes += 1;
    return false;
  };
  monitor.handleApplicationActivity = ((kind) => {
    applicationSignals.push(kind);
  }) as typeof monitor.handleApplicationActivity;

  monitor.start();
  assert.ok(source.listener, "starting the monitor must attach the activity source");
  source.listener({ kind: "key", at: Date.now() });
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  assert.equal(probes, 1, "a browser-activity signal must launch a debounced probe");
  source.listener({ kind: "activate", at: Date.now() });
  source.listener({ kind: "launch", at: Date.now() });
  assert.deepEqual(applicationSignals, ["activate", "launch"],
    "workspace lifecycle signals must use event-driven application enforcement");

  await monitor.stop();
  assert.equal(unsubscribed, 1, "stopping must detach the activity source");
  source.listener({ kind: "click", at: Date.now() });
  await Promise.resolve();
  assert.equal(probes, 1, "activity after stop must not launch another probe");
}

{
  const monitor = new Monitor({ state: defaultState(), usage: {} });
  let browserTailWakes = 0;
  let enforcements = 0;
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "example.com",
    url: "https://example.com/"
  });
  monitor.enforceFrontmost = async () => { enforcements += 1; };
  await monitor.enforceActivatedApplication({ wake() { browserTailWakes += 1; } } as BrowserActivityBurstScheduler);
  assert.equal(enforcements, 1, "an application activation must enforce the newly frontmost target immediately");
  assert.equal(browserTailWakes, 1, "a browser activation must retain the post-navigation settling tail");
  assert.equal(monitor.lastSample?.app, "Safari");

  let processSweeps = 0;
  monitor.sweepBlockedProcesses = async (_now, options = {}) => {
    assert.equal(options.force, true);
    processSweeps += 1;
  };
  await monitor.enforceLaunchedApplications();
  assert.equal(processSweeps, 1, "an application launch must trigger an immediate blocked-process sweep");
}

{
  const state = defaultState();
  const usage = {};
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
  });
  const source: { listener?: (signal: BrowserActivitySignal) => void } = {};
  let releaseRedirect = () => {};
  const redirectGate = new Promise<void>((resolve) => { releaseRedirect = resolve; });
  let markRedirectStarted = () => {};
  const redirectStarted = new Promise<void>((resolve) => { markRedirectStarted = resolve; });
  const blockedUrl = "https://www.google.com/search?q=porn";
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    ),
    browserActivitySubscribe(listener) {
      source.listener = listener;
      return () => {};
    },
    browserRedirect: async () => {
      markRedirectStarted();
      await redirectGate;
      return { ok: true, matched: true, redirectedTabCount: 1, method: "test-exact-tab" };
    }
  });
  monitor.runScheduledTick = async () => {};
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "google.com",
    url: blockedUrl
  });

  monitor.start();
  source.listener?.({ kind: "click", at: Date.now() });
  await redirectStarted;
  let stopped = false;
  const stopping = monitor.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, "monitor shutdown must drain an exact-tab redirect already in flight");
  releaseRedirect();
  await stopping;
  assert.equal(snapshotWrites, 1,
    "shutdown must persist the in-flight redirect's policy bookkeeping before the monitor stops");
  assert.equal(monitor.status.lastEnforcement?.type, "url");
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  state.limitRules = [{
    id: "shutdown-fast-browser-limit",
    name: "Shutdown fast browser limit",
    enabled: true,
    type: "time",
    lockLevel: "deep",
    days: [0, 1, 2, 3, 4, 5, 6],
    apps: [],
    sites: ["reddit.com"],
    limitMinutes: 1,
    unlocksAllowed: 0,
    blockMinutes: 30
  }];
  const usage = {};
  recordUsage(usage, { app: "Safari", hostname: "reddit.com" }, 61);
  let snapshotWrites = 0;
  const coordinator = new RuntimeMutationCoordinator(state, usage, [], async () => {
    snapshotWrites += 1;
    if (snapshotWrites === 1) throw new Error("deterministic shutdown fast-block snapshot failure");
  });
  const blockedUrl = "https://www.reddit.com/r/typescript/";
  const monitor = new Monitor({
    state,
    usage,
    mutate: async (operation, options) => await coordinator.run(
      ({ state: draftState, usage: draftUsage, afterCommit }) => operation(draftState, draftUsage, afterCommit),
      options
    ),
    browserRedirect: async () => ({
      ok: true,
      matched: true,
      redirectedTabCount: 1,
      method: "test-exact-tab"
    })
  });
  monitor.readFrontmost = async () => ({
    ok: true,
    app: "Safari",
    hostname: "reddit.com",
    url: blockedUrl
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    assert.equal(await monitor.probeBrowserActivity(), true);
    await monitor.operationTail;
    await Promise.resolve();
    const pending = [...monitor.pendingBrowserActivityMutations.values()][0]!;
    assert.ok(pending.nextRetryAt > Date.now(), "the failed block commit must be in normal retry backoff");
    assert.equal(state.limitBlocks.length, 0);

    await monitor.stop();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(snapshotWrites, 2,
    "shutdown must force a pending exact-tab bookkeeping retry without waiting for its backoff deadline");
  assert.equal(state.limitBlocks[0]?.ruleId, "shutdown-fast-browser-limit");
  assert.ok(state.limitRules[0]?.cycleAnchorDateKey,
    "shutdown recovery must durably retain the rolling limit cycle anchor");
  assert.ok(state.events.some((event) => event.type === "blocked_site"),
    "shutdown recovery must durably retain the confirmed browser-block event");
  assert.equal(monitor.pendingBrowserActivityMutations.size, 0);
  coordinator.stopAdmission();
  await coordinator.drain();
}

{
  const state = defaultState();
  const usage = {};
  let mutationAttempts = 0;
  const monitor = new Monitor({
    state,
    usage,
    mutate: async () => {
      mutationAttempts += 1;
      throw new Error("persistent deterministic shutdown failure");
    }
  });
  monitor.pendingBrowserActivityMutations.set("block:persistent", {
    operation: async () => {},
    persist: true,
    attempts: 1,
    nextRetryAt: Date.now() + 60_000
  });

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      monitor.stop(),
      /could not persist 1 browser block bookkeeping mutation/u,
      "permanent persistence failure must fail shutdown instead of retrying forever"
    );
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(mutationAttempts, BROWSER_ACTIVITY_PERSISTENCE_SHUTDOWN_MAX_ATTEMPTS,
    "shutdown persistence retries must have a strict attempt bound");
  assert.equal(monitor.browserActivityMutationAdmissionOpen, false);
}

{
  const directSource = join(process.cwd(), "app", "vigil-human-idle.c");
  const projectRoot = existsSync(directSource)
    ? process.cwd()
    : dirname(dirname(process.cwd()));
  const helperSource = await readFile(join(projectRoot, "app", "vigil-human-idle.c"), "utf8");
  const macosSource = await readFile(join(projectRoot, "src", "macos.ts"), "utf8");
  assert.match(helperSource, /browserActivityPollMilliseconds = 25/u,
    "permission-free activity detection must stay within a 25ms native polling bound");
  assert.match(helperSource, /CGEventSourceCounterForEventType/u);
  assert.match(helperSource, /kCGEventSourceStateCombinedSessionState/u,
    "browser acceleration must include assistive, remote, and synthesized session input");
  for (const eventType of [
    "kCGEventKeyDown", "kCGEventKeyUp", "kCGEventFlagsChanged",
    "kCGEventLeftMouseDown", "kCGEventLeftMouseUp",
    "kCGEventRightMouseDown", "kCGEventRightMouseUp",
    "kCGEventOtherMouseDown", "kCGEventOtherMouseUp", "kCGEventScrollWheel"
  ]) {
    assert.ok(helperSource.includes(eventType), `browser activity helper must cover ${eventType}`);
  }
  assert.match(helperSource, /printf\("wake\\t%s\\n", kind\)/u);
  assert.match(helperSource, /printf\("watch\\talive\\n"\)/u,
    "the native watcher must expose liveness without requiring another full monitor sweep");
  assert.match(helperSource, /NSWorkspaceDidActivateApplicationNotification/u);
  assert.match(helperSource, /NSWorkspaceDidLaunchApplicationNotification/u);
  assert.match(helperSource, /printf\("wake\\tactivate\\n"\)/u);
  assert.match(helperSource, /printf\("wake\\tlaunch\\n"\)/u);
  assert.match(helperSource, /strcmp\(request, "watch\\n"\)/u);
  assert.match(helperSource, /strcmp\(request, "unwatch\\n"\)/u);
  assert.doesNotMatch(helperSource, /CGEventTapCreate|CGEventGetIntegerValueField|CGEventKeyboardGetUnicodeString|NSEvent\.keyCode/u,
    "the activity helper must not capture key codes, characters, coordinates, or event-tap payloads");
  assert.match(macosSource, /child\.stdin\.on\("error", \(error\) => failHumanActivityProcess\(child, error, true\)\)/u,
    "helper stdin failures must be observed separately from ChildProcess failures");
  assert.match(
    macosSource,
    /function writeHumanActivityRequest[\s\S]*?child\.stdin\.destroyed \|\| !child\.stdin\.writable[\s\S]*?child\.stdin\.write\(request, \(error\) => \{\s*if \(error\) failHumanActivityProcess\(child, error, true\);[\s\S]*?catch \(error\) \{\s*failHumanActivityProcess/u,
    "unwritable, asynchronous, and synchronous input failures must enter helper recovery"
  );
  assert.match(macosSource, /requestBrowserActivityWatch[\s\S]*?writeHumanActivityRequest\(child, enabled \? "watch\\n" : "unwatch\\n"\)/u);
  assert.match(macosSource, /queryHumanActivityOnce[\s\S]*?writeHumanActivityRequest\(child, "\\n"\)/u,
    "queries must use the same fail-and-evict helper input path as watch commands");
  const consumeStart = macosSource.indexOf("function consumeHumanActivityOutput");
  const consumeEnd = macosSource.indexOf("\nfunction notifyBrowserActivity", consumeStart);
  const consumeSource = macosSource.slice(consumeStart, consumeEnd);
  assert.doesNotMatch(
    consumeSource,
    /resetHumanActivityRestart\(\)/u,
    "a single valid helper frame must not erase short-lifetime crash history"
  );
  assert.match(macosSource, /parseBrowserActivityWatchHeartbeat\(line\)[\s\S]*?humanActivityLastWatchAliveAt = Date\.now\(\)[\s\S]*?continue/u,
    "watcher heartbeats must be consumed before pending idle-sample responses");
  const stabilityStart = macosSource.indexOf("function armHumanActivityStabilityReset");
  const stabilityEnd = macosSource.indexOf("\nexport async function runAppleScript", stabilityStart);
  const stabilitySource = macosSource.slice(stabilityStart, stabilityEnd);
  assert.match(
    stabilitySource,
    /setTimeout\([\s\S]*?humanActivityProcess === child\) resetHumanActivityRestart\(\)/u,
    "helper restart backoff must reset only after the process survives its stability window"
  );
}

assert.deepEqual(humanActivityHelperArguments(false), [], "a helper without subscribers must not sense browser activity");
assert.deepEqual(humanActivityHelperArguments(true), ["--watch-browser-activity"]);
assert.deepEqual(HUMAN_ACTIVITY_RESTART_DELAYS_MS, [25, 100, 250, 500, 1_000, 3_000],
  "activity-helper recovery must start promptly and cap persistent-failure retries at the monitor backstop interval");
assert.deepEqual(BROWSER_ACTIVITY_PERSISTENCE_RETRY_DELAYS_MS, [250, 500, 1_000, 3_000],
  "browser bookkeeping retries must back off and cap at the regular monitor interval");
assert.equal(BROWSER_ACTIVITY_PERSISTENCE_SHUTDOWN_MAX_ATTEMPTS, 4,
  "shutdown bookkeeping recovery must remain bounded");
