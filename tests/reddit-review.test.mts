import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { redditReviewDestination, redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewTarget, redditReviewRedirect, vigilReturnPage } from "../src/redditReview.js";
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
for (const target of ["https://www.reddit.com/", "https://www.reddit.com/r/reviews/", "https://redd.it/abc123", first + ".json"]) {
  for (const wrapped of [`https://www.google.com/url?q=${encodeURIComponent(target)}`, `https://duckduckgo.com/l/?uddg=${encodeURIComponent(target)}`, `https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString("base64url")}`]) {
    assert.equal(redditReviewTarget(wrapped), target);
    assert.equal(redditReviewDestination(wrapped), null);
  }
}
assert.equal(redditReviewHost("https://reddit.com.evil.example/"), false);

const source = await readFile(new URL("../extension/reddit-review-background.js", import.meta.url), "utf8");
type Listener = (...args: unknown[]) => unknown; // Browser API harness deliberately exercises malformed senders too.
function harness(storageValues: Record<string, unknown> = {}, incognito = false, safari = false) {
  const listeners: Record<string, Listener> = {};
  const tabs = new Map<number, { id: number; url: string; windowId?: number; incognito?: boolean }>([[1, { id: 1, url: search, windowId: 10, incognito }]]);
  const creations: Array<{ windowId: number; openerTabId: number }> = [];
  const returnChecks: Array<{ candidates: string[]; inspect?: string }> = [];
  let verifierAvailable = true;
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
  const verifyReturn = async (body: { candidates: string[]; inspect?: string }) => {
    returnChecks.push(structuredClone(body));
    if (!verifierAvailable) throw new Error("Verifier temporarily unavailable");
    return { ok: true, url: body.candidates.find(url => !url.includes("porn")) || "about:blank" };
  };
  const api = {
    storage: { session: storage },
    runtime: { onMessage: event("message"), onStartup: event("startup"), getURL: (path: string) => `extension://vigil/${path.replace(/^\//u, "")}`,
      sendNativeMessage: async (_host: string, body: { candidates: string[]; inspect?: string }) => verifyReturn(body) },
    tabs: { async get(id: number) { return tabs.get(id); },
      async create({ url, windowId, openerTabId }: { url: string; windowId: number; openerTabId: number }) { creations.push({ windowId, openerTabId }); const tab = { id: nextTab++, url, windowId, incognito: tabs.get(openerTabId)?.incognito }; void tabs.set(tab.id, tab); return tab; },
      async update(id: number, { url }: { url: string }) { updates.push({ id, url }); void tabs.set(id, { ...tabs.get(id), id, url }); return tabs.get(id); },
      onRemoved: event("removed") },
    webNavigation: { onBeforeNavigate: event("before"), onCommitted: event("committed"), onHistoryStateUpdated: event("history") }
  };
  runInNewContext(source, { chrome: api, ...(safari ? { browser: api } : {}), URL, atob, console, fetchVigil: async (_path: string, options: { body: string }) => {
    const body: { candidates: string[]; inspect?: string } = JSON.parse(options.body);
    const result = await verifyReturn(body);
    return { json: async () => result };
  } });
  const send = (action: string, url?: string, options: { tabId?: number; frameId?: number; senderURL?: string; newTab?: boolean } = {}) => new Promise<{ ok: boolean; retry?: boolean; url?: string; handled?: boolean; exhausted?: boolean }>(resolve => {
    const tabId = options.tabId || 1;
    listeners.message({ type: "VIGIL_REDDIT_REVIEW", action, url, newTab: options.newTab },
      { tab: { id: tabId }, frameId: options.frameId ?? 0, url: options.senderURL || tabs.get(tabId)?.url }, resolve);
  });
  const navigate = async (url: string, kind = "committed", id = 1, transition: { transitionType?: string; transitionQualifiers?: string[] } = {}) => {
    void tabs.set(id, { ...tabs.get(id), id, url }); listeners[kind]({ tabId: id, frameId: 0, url, ...transition });
    await new Promise<void>(resolve => setImmediate(resolve));
  };
  return { send, navigate, tabs, updates, listeners, storageValues, creations, returnChecks,
    setVerifierAvailable(value: boolean) { verifierAvailable = value; } };
}
const holding = "http://127.0.0.1:8787/blocked#vigil-holding-12345678-1234-1234-1234-123456789abc";
const replacement = holding.replace("vigil-holding-", "vigil-blocker-");
for (const root of ["chrome-extension://vigil/", "safari-web-extension://vigil/"]) {
  assert.equal(vigilReturnPage(root + "search-break.html", root), true, "search-break Back must use the verified return handler");
  assert.equal(vigilReturnPage("https://example.com/search-break.html", root), false, "websites cannot act as extension return pages");
}
for (const safari of [false, true]) {
  const blocker = "extension://vigil/search-break.html";
  const redirect = "https://example.com/redirect";
  const h = harness({}, false, safari);
  await h.navigate(search);
  await h.navigate(redirect);
  await h.navigate(blocker);
  assert.equal((await h.send("return")).url, redirect);
  await h.navigate(redirect);
  await h.navigate("https://example.com/redirected", "committed", 1, { transitionType: "link", transitionQualifiers: ["client_redirect"] });
  await h.navigate(blocker);
  assert.equal((await h.send("return")).url, search, "a return that redirects into a blocker is skipped in Safari and Chrome");
  assert.deepEqual(h.returnChecks.at(-1)?.candidates, [search], "the whole failed redirect chain is excluded");
  const exhausted = harness({}, false, safari);
  await exhausted.navigate(redirect);
  await exhausted.navigate(blocker);
  assert.equal((await exhausted.send("return")).url, redirect);
  await exhausted.navigate(redirect);
  await exhausted.navigate(blocker);
  assert.equal((await exhausted.send("return")).exhausted, true, "no candidate means stop rather than native Back into the same loop");
  const rejected = harness({}, false, safari);
  await rejected.navigate("https://example.com/porn");
  await rejected.navigate(blocker);
  assert.equal((await rejected.send("return")).exhausted, true, "policy-rejected history never falls back into denied URLs");
  const manual = harness({}, false, safari);
  await manual.navigate(redirect);
  await manual.navigate(blocker);
  await manual.send("return");
  await manual.navigate(redirect);
  await manual.navigate("https://example.com/another-page", "committed", 1, { transitionType: "link" });
  await manual.navigate(blocker);
  assert.equal((await manual.send("return")).url, "https://example.com/another-page", "new user navigation is distinct from a failed return");
}
{
  const h = harness({}, true);
  await h.navigate(search);
  await h.navigate("https://example.com/porn");
  // The native operation can delete the source before our async callback runs.
  h.listeners.before({ tabId: 1, frameId: 0, url: holding });
  h.tabs.delete(1); h.listeners.removed(1);
  void h.tabs.set(2, { id: 2, url: replacement, windowId: 10, incognito: true });
  await h.navigate(replacement, "committed", 2);
  assert.equal((await h.send("return", undefined, { tabId: 2 })).url, search, "native replacement keeps the original private tab's safe return history");
  assert.equal(h.returnChecks.at(-1)?.candidates[0], "https://example.com/porn", "copied history still goes through policy validation");
  // A delayed holding-page event must not issue a second copy of the handoff.
  h.storageValues["vigil-reddit-review:1"] = { history: [search], windowId: 10, incognito: true };
  h.listeners.before({ tabId: 1, frameId: 0, url: holding });
  void h.tabs.set(3, { id: 3, url: replacement, windowId: 10, incognito: true });
  assert.equal((await h.send("return", undefined, { tabId: 3 })).url, "about:blank", "a transfer is consumed by only one replacement");
}
for (const [windowId, incognito] of [[11, true], [10, false]] as const) {
  const h = harness({}, true);
  await h.navigate(search);
  await h.navigate(holding, "before");
  void h.tabs.set(2, { id: 2, url: replacement, windowId, incognito });
  assert.equal((await h.send("return", undefined, { tabId: 2 })).url, "about:blank", "history must never cross a window or privacy partition");
}
{
  const h = harness({}, true);
  await h.navigate(search);
  await h.navigate(holding, "before");
  for (const [key, value] of Object.entries(h.storageValues)) {
    if (key.startsWith("vigil-block-return:")) (value as { expiresAt: number }).expiresAt = 0;
  }
  void h.tabs.set(2, { id: 2, url: replacement, windowId: 10, incognito: true });
  assert.equal((await h.send("return", undefined, { tabId: 2 })).url, "about:blank", "an expired handoff cannot restore history");
}
{
  const h = harness();
  await h.navigate(`http://127.0.0.1:8787/blocked?back=${encodeURIComponent(search)}`);
  assert.equal((await h.send("return")).url, search, "a monitor-provided back URL survives missing extension history and is revalidated");
  assert.deepEqual(h.returnChecks.at(-1)?.candidates, [search]);
  await h.navigate("http://127.0.0.1:8787/blocked?back=https%3A%2F%2Fexample.com%2Fporn");
  assert.equal((await h.send("return")).url, "about:blank", "a supplied back URL never skips policy validation");
}
{
  const h = harness();
  await h.navigate(search);
  await h.navigate("extension://vigil/blocked.html");
  h.setVerifierAvailable(false);
  assert.equal((await h.send("return")).url, "about:blank");
  h.setVerifierAvailable(true);
  assert.equal((await h.send("return")).url, search, "a verifier failure does not destroy this tab's return history");
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
{
  const h = harness();
  assert.equal((await h.send("open", "https://www.google.com/url?q=https%3A%2F%2Fwww.reddit.com%2F")).ok, false, "a known wrapped homepage cannot become an opaque navigation ticket");
  assert.equal(h.updates.length, 0, "forbidden wrapped links never enter the network loader");
  assert.equal((await h.send("open", first)).ok, true, "rejecting a feed does not consume this search's thread selection");
}
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
