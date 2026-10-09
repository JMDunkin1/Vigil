import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { activeSearchBreakUntil, limitedSearchPage, limitedSearchWarning, searchBreakAction } from "../src/searchBreak.js";
import type { SearchBreakState } from "../src/searchBreak.js";
import { defaultState } from "../src/defaults.js";
import { protectedStateSnapshot } from "../src/seal.js";
import { policyForSample, shouldQuitAppForPolicy, sweepBlockedApps } from "../src/monitor/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { youtubeLocalEngine } from "../scripts/youtube-build-connection.mjs";

const warning = "Results are limited by SafeSearch";
const report = (state: SearchBreakState, id: string, at: number) => searchBreakAction(state, { action: "search-break-warning", warning, id }, at);
for (const text of [warning, "Some results are limited by SafeSearch.", "Results are limited by search", "Results\nare limited by SafeSearch"]) assert.equal(limitedSearchWarning(text), true);
for (const text of ["SafeSearch is on", "About results are limited by SafeSearch", "Learn why results are limited by SafeSearch", "Results are limited", "no results"]) assert.equal(limitedSearchWarning(text), false);
for (const url of ["https://www.google.com/search?q=art", "https://images.google.com/search?q=trees&safe=active"]) assert.equal(limitedSearchPage(url), true);
for (const url of ["https://google.com.evil.test/search?q=x", "http://www.google.com/search?q=x", "https://user@www.google.com/search?q=x", "https://www.google.com/", "https://example.org/search?q=x"]) assert.equal(limitedSearchPage(url), false);

const state = defaultState();
assert.equal(report(state, "safari:1", 100_000).blocked, false);
assert.equal(report(state, "safari:1", 110_000).accepted, false, "duplicate reports cannot count twice");
assert.equal(report(state, "chrome:2", 120_000).blocked, false);
const third = report(state, "safari:3", 160_000);
assert.equal(third.triggered, true, "the third warning counts at the exact rolling-minute boundary");
assert.equal(third.until, 310_000);
assert.equal(report(state, "safari:4", 165_000).until, 310_000, "reports during a break cannot extend it");
assert.equal(searchBreakAction(state, { action: "search-break-status" }, 170_000).remainingMs, 140_000);
const restored = JSON.parse(JSON.stringify(state));
assert.equal(activeSearchBreakUntil(restored, 309_999), 310_000, "a restart preserves the break");
assert.equal(activeSearchBreakUntil(restored, 310_000), 0, "access returns exactly at 150 seconds");
assert.equal(report(restored, "next:1", 310_000).count, 1, "a new window starts after the break");
const late: SearchBreakState = {};
report(late, "1", 100_000); report(late, "2", 120_000);
assert.equal(report(late, "3", 160_001).blocked, false, "a warning older than a minute expires");
const invalid: SearchBreakState = {};
assert.equal(searchBreakAction(invalid, { action: "search-break-warning", id: "1", warning: "SafeSearch is on" }, 0).accepted, false);
assert.equal(report(invalid, "bad id", 0).accepted, false);
const backwards: SearchBreakState = {};
report(backwards, "1", 100_000); report(backwards, "2", 120_000);
assert.equal(report(backwards, "3", 110_000).until, 270_000, "clock rollback cannot shorten the window or break");

state.settings.appQuitEnabled = false;
state.settings.processSweepEnabled = false;
state.settings.protectedBrowsersOnly = false;
for (const app of ["Safari", "Google Chrome", "Firefox", "Microsoft Edge"]) {
  const policy = policyForSample(state, {}, { app }, new Date(200_000));
  assert.equal(policy?.profile.id, "search-break", app);
  assert.equal(shouldQuitAppForPolicy(state, policy, app), true);
}
assert.deepEqual(sweepBlockedApps(state, {}, ["Safari", "Google Chrome", "Vigil", "Finder", "Codex"], new Date(200_000)).map(item => item.app), ["Safari", "Google Chrome"]);
assert.equal(policyForSample(state, {}, { app: "Safari" }, new Date(310_000))?.profile.id === "search-break", false);
assert.equal(evaluateExtensionCheck(state, {}, { url: "https://example.org/", event: "navigation" }, new Date(200_000)).blocked, true);
const sealed = protectedStateSnapshot(state as unknown as Record<string, unknown>);
assert.deepEqual(sealed.searchBreak, state.searchBreak, "the break ledger is protected enforcement state");

// Exercise the exact generated phone engine with its saved YouTube ledger.
const engineContext: Record<string, unknown> = { __uuid: randomUUID, Intl, Date };
runInNewContext(await youtubeLocalEngine(), engineContext);
const invoke = engineContext.vigilLocalAction as (state: string, body: string) => string;
let phoneState = JSON.stringify({ youtubeLimits: { day: "9999-12-31", timezone: "UTC", slots: [null, null, null, null], played: {}, usedMs: 1234,
  grace: { status: "unused", videoId: null, usedMs: 0 }, feeds: {}, external: [], lease: null } });
for (let i = 0; i < 3; i++) {
  const result = JSON.parse(invoke(phoneState, JSON.stringify({ action: "search-break-warning", warning, id: String(i) })));
  phoneState = JSON.stringify(result.state);
  assert.equal(result.reply.blocked, i === 2);
  assert.equal(result.state.youtubeLimits.usedMs, 1234, "search breaks preserve the phone's existing allowance");
}
assert.equal(JSON.parse(invoke(phoneState, JSON.stringify({ action: "search-break-status" }))).reply.blocked, true);

// Run the packaged background with browser-owned sender provenance and storage.
const source = await readFile(new URL("../extension/search-break-background.js", import.meta.url), "utf8");
const authority: SearchBreakState = {};
let now = 1_000_000;
let unavailable = false;
const storage: Record<string, unknown> = {};
const updates: number[] = [];
const tabs = [{ id: 1, active: true, url: "https://www.google.com/search?q=trees" }, { id: 2, active: false, url: "https://example.org/" }];
let listener: (message: unknown, sender: unknown, reply: (value: unknown) => void) => boolean;
const api = {
  runtime: { getURL: (path: string) => `safari-web-extension://vigil/${path}`,
    onMessage: { addListener: (value: typeof listener) => { listener = value; } },
    sendNativeMessage: async (_app: string, body: Parameters<typeof searchBreakAction>[1]) => {
      if (unavailable) throw new Error("offline");
      return searchBreakAction(authority, body, now);
    } },
  storage: { local: { get: async () => storage, set: async (values: Record<string, unknown>) => Object.assign(storage, values) } },
  tabs: { query: async () => tabs, get: async (id: number) => tabs.find(tab => tab.id === id),
    update: async (id: number, value: { url: string }) => { updates.push(id); tabs.find(tab => tab.id === id)!.url = value.url; },
    onActivated: { addListener() {} } },
  webNavigation: { onCommitted: { addListener() {} } }
};
runInNewContext(source, { URL, browser: api, Date: { now: () => now } });
const message = (sender: unknown, action = "search-break-warning", id = randomUUID()) => new Promise<Record<string, unknown>>(resolve => {
  assert.equal(listener!({ type: "VIGIL_SEARCH_BREAK", action, warning, id, url: tabs[0].url }, sender, reply => resolve(reply as Record<string, unknown>)), true);
});
const sender = () => ({ url: tabs[0].url, frameId: 0, tab: tabs[0] });
assert.equal((await message({ ...sender(), url: "https://evil.test/" })).ok, false);
for (let i = 0; i < 3; i++) { now += 1000; await message(sender()); }
assert.deepEqual(updates, [1, 2], "the break redirects every open browsing tab");
const pageSender = { url: "safari-web-extension://vigil/search-break.html" };
unavailable = true; now += 1000;
assert.equal((await message(pageSender, "search-break-status")).blocked, true, "an offline authority cannot clear a cached active break");
unavailable = false; now += 150_000;
assert.equal((await message(pageSender, "search-break-status")).blocked, false);

// Exercise the document-start detector with visible notices, hidden markup,
// result snippets, repaints, and same-document search navigations.
const detector = await readFile(new URL("../extension/search-break.js", import.meta.url), "utf8");
let tick = () => {};
let detectorNow = 2_000_000;
const detectorLedger: SearchBreakState = {};
const reports: Array<Record<string, unknown>> = [];
const redirects: string[] = [];
const location = { href: "https://www.google.com/search?q=trees&safe=active", replace: (url: string) => redirects.push(url) };
const root = { id: "topstuff", parentElement: null, querySelector: () => null };
const notice = { innerText: warning, visible: false, visibility: "visible", parentElement: root,
  getClientRects: () => notice.visible ? [{}] : [], closest: () => null };
const snippet = { ...notice, visible: true, getClientRects: () => [{}], parentElement: { id: "result", parentElement: root, querySelector: () => ({ tagName: "H3" }) } };
runInNewContext(detector, {
  URL, location, crypto: { randomUUID }, Date: { now: () => detectorNow },
  getComputedStyle: (node: typeof notice) => ({ visibility: node.visibility }),
  document: { hidden: false, documentElement: {}, querySelectorAll: () => [notice, snippet], addEventListener() {} },
  MutationObserver: class { observe() {} }, addEventListener() {}, setTimeout() {},
  setInterval: (callback: () => void) => { tick = callback; },
  chrome: { runtime: { getURL: (name: string) => `chrome-extension://vigil/${name}`,
    sendMessage: async (body: Record<string, unknown>) => { reports.push(body); return searchBreakAction(detectorLedger, body, detectorNow); } } }
});
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
await flush();
assert.equal(reports.filter(item => item.action === "search-break-warning").length, 0, "hidden banners and search-result snippets cannot count");
notice.visible = true; notice.visibility = "hidden"; detectorNow += 1000; tick(); await flush();
assert.equal(reports.filter(item => item.action === "search-break-warning").length, 0, "visibility-hidden notices cannot count");
notice.visibility = "visible"; detectorNow += 1000; tick(); await flush();
assert.equal(reports.filter(item => item.action === "search-break-warning").length, 1, "a visible standalone notice counts");
detectorNow += 1000; tick(); await flush();
assert.equal(reports.filter(item => item.action === "search-break-warning").length, 1, "polling and repainting cannot count the same page again");
for (const query of ["flowers", "gardens"]) {
  location.href = `https://www.google.com/search?q=${query}&safe=active`;
  detectorNow += 1000; tick(); await flush();
}
assert.equal(reports.filter(item => item.action === "search-break-warning").length, 3);
assert.deepEqual(redirects, ["chrome-extension://vigil/search-break.html"], "the third distinct search immediately leaves the page");
console.log("Search warning threshold, expiry, deduplication, restart persistence, desktop enforcement and phone authority passed.");
