import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { redditReviewDestination, redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewRedirect } from "../src/redditReview.js";
import { assertGeneratedIosSafariGuardCurrent } from "../scripts/generate-ios-safari-guard.mjs";
import { defaultState } from "../src/defaults.js";
import { baselinePolicy, shouldBlockUrl } from "../src/policy.js";

const first = "https://www.reddit.com/r/BuyItForLife/comments/abc123/kettle_reviews/";
const second = "https://www.reddit.com/r/BuyItForLife/comments/def456/other_reviews/";
const search = "https://www.google.com/search?q=kettle+reviews+reddit";
for (const url of [first, first + "ghi789/?context=3", first.replace("www.", "old."), "https://reddit.com/comments/abc123/"]) {
  assert.equal(redditReviewPostId(url), "abc123", url);
}
for (const url of ["https://www.reddit.com/", "https://reddit.com/search?q=kettle", "https://reddit.com/r/BuyItForLife/", "https://reddit.com/user/person/", "https://redd.it/abc123", first + ".json", "https://reddit.com/r/a/comments/abc123/title/more/arbitrary", first.replace("https:", "http:"), first.replace("www.reddit.com", "www.reddit.com.evil.example"), first.replace("www.reddit.com", "www.reddit.com:444"), first.replace("www.reddit.com", "user@www.reddit.com")]) {
  assert.equal(redditReviewPostId(url), null, url);
}
for (const url of [search, "https://www.bing.com/search?q=kettle", "https://duckduckgo.com/?q=kettle", "https://search.brave.com/search?q=kettle", "https://www.google.co.uk/search?q=kettle", "https://kagi.com/search?q=kettle", "https://search.yahoo.com/search?p=kettle"]) assert.ok(redditReviewSearchPage(url), url);
for (const url of ["https://www.reddit.com/search?q=kettle", "https://google.com.evil.example/search?q=kettle", "https://www.google.com/search?q=", "https://www.google.com/maps?q=kettle", "https://news.example/?q=kettle", "https://accounts.google.com/search?q=kettle"]) assert.equal(redditReviewSearchPage(url), null, url);
assert.equal(redditReviewDestination(`https://www.google.com/url?q=${encodeURIComponent(first)}`), first);
assert.equal(redditReviewDestination(`https://duckduckgo.com/l/?uddg=${encodeURIComponent(first)}`), first);
assert.equal(redditReviewDestination(`https://www.bing.com/ck/a?u=a1${Buffer.from(first).toString("base64url")}`), first);
assert.equal(redditReviewDestination("https://www.google.com/url?q=https://evil.example/"), null);
assert.equal(redditReviewHost("https://reddit.com.evil.example/"), false);

const source = await readFile(new URL("../extension/reddit-review-background.js", import.meta.url), "utf8");
type Listener = (...args: unknown[]) => unknown; // Browser API harness deliberately exercises malformed senders too.
function harness(storageValues: Record<string, unknown> = {}, incognito = false) {
  const listeners: Record<string, Listener> = {};
  const tabs = new Map<number, { id: number; url: string; windowId?: number; incognito?: boolean }>([[1, { id: 1, url: search, windowId: 10, incognito }]]);
  const creations: Array<{ windowId: number; openerTabId: number }> = [];
  const returnChecks: Array<{ candidates: string[]; inspect?: string }> = [];
  let nextTab = 2;
  const updates: Array<{ id: number; url: string }> = [];
  const event = (name: string) => ({ addListener(fn: Listener) { listeners[name] = fn; } });
  const storage = {
    async get(keys: string | string[] | null) {
      return structuredClone(Object.fromEntries((keys === null ? Object.keys(storageValues) : Array.isArray(keys) ? keys : [keys]).map(key => [key, storageValues[key]])));
    },
    async set(values: Record<string, unknown>) { Object.assign(storageValues, structuredClone(values)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storageValues[key]; }
  };
  const api = {
    storage: { session: storage },
    runtime: { onMessage: event("message"), onStartup: event("startup"), getURL: (path: string) => `extension://vigil/${path.replace(/^\//u, "")}` },
    tabs: { async get(id: number) { return tabs.get(id); },
      async create({ url, windowId, openerTabId }: { url: string; windowId: number; openerTabId: number }) { creations.push({ windowId, openerTabId }); const tab = { id: nextTab++, url, windowId, incognito: tabs.get(openerTabId)?.incognito }; void tabs.set(tab.id, tab); return tab; },
      async update(id: number, { url }: { url: string }) { updates.push({ id, url }); void tabs.set(id, { ...tabs.get(id), id, url }); return tabs.get(id); },
      onRemoved: event("removed") },
    webNavigation: { onCommitted: event("committed"), onHistoryStateUpdated: event("history") }
  };
  runInNewContext(source, { chrome: api, URL, atob, console, fetchVigil: async (_path: string, options: { body: string }) => {
    const body: { candidates: string[]; inspect?: string } = JSON.parse(options.body);
    returnChecks.push(body);
    return { json: async () => ({ ok: true, url: body.candidates.find(url => !url.includes("porn")) || "about:blank" }) };
  } });
  const send = (action: string, url?: string, options: { tabId?: number; frameId?: number; senderURL?: string; newTab?: boolean } = {}) => new Promise<{ ok: boolean; retry?: boolean; url?: string; handled?: boolean }>(resolve => {
    const tabId = options.tabId || 1;
    listeners.message({ type: "VIGIL_REDDIT_REVIEW", action, url, newTab: options.newTab },
      { tab: { id: tabId }, frameId: options.frameId ?? 0, url: options.senderURL || tabs.get(tabId)?.url }, resolve);
  });
  const navigate = async (url: string, kind = "committed", id = 1, transition: { transitionType?: string; transitionQualifiers?: string[] } = {}) => {
    void tabs.set(id, { ...tabs.get(id), id, url }); listeners[kind]({ tabId: id, frameId: 0, url, ...transition });
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { send, navigate, tabs, updates, listeners, storageValues, creations, returnChecks };
}
{
  const h = harness();
  void h.tabs.set(1, { ...h.tabs.get(1), id: 1, url: first });
  assert.equal((await h.send("check")).ok, false, "a typed URL or bookmark never grants access");
  assert.equal((await h.send("open", first, { senderURL: search })).ok, false, "stale search document is rejected");
  void h.tabs.set(1, { ...h.tabs.get(1), id: 1, url: search });
  assert.equal((await h.send("open", first, { frameId: 1 })).ok, false, "embedded pages cannot grant");
  assert.equal((await h.send("open", first)).ok, true);
  assert.equal((await h.send("check")).ok, true);
  await h.navigate(first + "ghi789/?sort=top");
  assert.equal((await h.send("check")).ok, true, "comments and sorting stay in the same thread");
  assert.equal((await h.send("open", second)).ok, false, "a Reddit link cannot grant another post");
  await h.navigate(second, "history");
  assert.equal(h.updates.at(-1)?.url, first + "ghi789/?sort=top", "SPA post changes quietly return to this thread");
  assert.equal((await h.send("check")).ok, true, "the original permitted thread remains readable");
}
{
  const h = harness();
  const results = await Promise.all([h.send("open", first, { newTab: true }), h.send("open", second, { newTab: true })]);
  assert.deepEqual(results.map(result => result.ok), [true, false], "one search cannot race two grants");
  assert.equal(h.tabs.get(2)?.url, first);
  assert.equal((await h.send("check", undefined, { tabId: 2 })).ok, true);
  assert.equal((await h.send("open", first, { newTab: true })).ok, true, "same selected post remains accessible");
  await h.navigate(search + "&start=10&tracking=changed");
  assert.equal((await h.send("open", second, { newTab: true })).ok, false, "pagination and tracking do not reset the selected post");
  await h.navigate(search + "+durability");
  assert.equal((await h.send("open", second, { newTab: true })).ok, true, "a new external search can select a new post");
  h.listeners.startup();
  assert.equal((await h.send("check", undefined, { tabId: 2 })).ok, false, "restart clears persistent fallback grants");
}
{
  const h = harness();
  await h.send("open", first);
  const resumed = harness(h.storageValues);
  void resumed.tabs.set(1, { ...resumed.tabs.get(1), id: 1, url: first });
  assert.equal((await resumed.send("check")).ok, true, "service-worker suspension preserves the active thread");
  await resumed.navigate("https://example.com/");
  await resumed.navigate(first);
  assert.equal(resumed.updates.at(-1)?.url, "https://example.com/", "leaving Reddit consumes permission and returns to the same tab's previous page");
}
const wrapper = "https://www.google.com/goto?opaque=actual-search-result";
assert.equal(redditReviewRedirect(wrapper, search), true);
for (const invalid of ["https://google.com.evil.example/goto", "https://www.google.com/maps", "https://user@www.google.com/goto", "http://www.google.com/goto"]) assert.equal(redditReviewRedirect(invalid, search), false);
{
  const h = harness({}, true);
  assert.equal((await h.send("open", wrapper, { newTab: true })).ok, true);
  assert.deepEqual(h.creations, [{ windowId: 10, openerTabId: 1 }], "new result tabs explicitly retain the private source window");
  assert.equal(h.tabs.get(2)?.incognito, true);
  await h.navigate(first, "committed", 2, { transitionType: "link", transitionQualifiers: ["server_redirect"] });
  assert.equal((await h.send("check", undefined, { tabId: 2 })).ok, true, "Google's opaque redirect grants its final post");
  assert.equal((await h.send("open", second, { newTab: true })).ok, false, "the source search is locked to the final post");
  await h.navigate("https://reddit.com/", "committed", 2);
  assert.equal(h.tabs.get(2)?.url, first, "homepage navigation quietly restores the selected post");
  assert.equal(h.tabs.get(2)?.incognito, true);
  assert.equal((await h.send("open", wrapper, { newTab: true })).ok, true, "an opaque link to the already selected post can be reopened");
  await h.navigate(second, "committed", 3, { transitionType: "link", transitionQualifiers: ["server_redirect"] });
  assert.equal(h.tabs.get(3)?.url, "about:blank", "the opaque redirect still cannot select a different post");
}
{
  const h = harness({}, true);
  await h.navigate("https://normal-window.example/", "committed", 8);
  void h.tabs.set(2, { id: 2, url: "extension://vigil/blocked.html", windowId: 10, incognito: true });
  assert.equal((await h.send("return", undefined, { tabId: 2 })).url, "about:blank", "a new private tab never falls back to another tab's history");
  await h.navigate(search);
  await h.navigate("https://example.com/porn");
  await h.navigate("extension://vigil/blocked.html");
  assert.equal((await h.send("return")).url, search, "Back returns to the exact same-tab search and skips pages the verifier rejects");
  assert.equal(h.returnChecks.at(-1)?.candidates.includes("https://normal-window.example/"), false);
}
{
  const h = harness();
  await h.send("open", wrapper);
  void h.tabs.set(1, { ...h.tabs.get(1), id: 1, url: first });
  assert.equal((await h.send("check")).retry, true, "content scripts wait for navigation provenance instead of consuming an unresolved ticket");
  await h.navigate(first, "committed", 1, { transitionType: "typed" });
  assert.equal((await h.send("check")).ok, false, "typing a permalink cannot take over a pending redirect ticket");
}
const profile = baselinePolicy(defaultState())!.profile;
for (const url of ["https://reddit.com/", "https://reddit.com/search?q=reviews", "https://old.reddit.com/r/reviews/", "https://reddit.com/user/person/", "https://redd.it/abc123"]) assert.equal(shouldBlockUrl(profile, url), true, url);
assert.equal(shouldBlockUrl(profile, first), false, "eligible post still requires the separate browser grant");
assert.equal(shouldBlockUrl(profile, first.replace("kettle_reviews", "porn")), true, "review permission never overrides explicit policy");
await assertGeneratedIosSafariGuardCurrent();
console.log("Reddit review provenance, one-post concurrency, revocation, reload, startup and policy tests passed.");
