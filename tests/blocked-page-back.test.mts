import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { blockedPage } from "../src/server/pages.js";
import { defaultState } from "../src/defaults.js";

const extension = await readFile(new URL("../extension/blocked-navigation.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../extension/reddit-review-guard.js", import.meta.url), "utf8");
const server = blockedPage({ url: new URL("http://127.0.0.1:8787/blocked"), state: defaultState() }).match(/<script>([\s\S]*?)<\/script>/u)![1];
type Reply = { ok?: boolean; url?: string; handled?: boolean; exhausted?: boolean };
function harness(source: string, length: number, quiet = false, stored = new Map<string, string>(), href = "extension://vigil/blocked.html") {
  const destinations: string[] = [];
  const traversals: number[] = [];
  let backCount = 0;
  let now = Date.now();
  let clickRegistered = false;
  let click: () => void = () => {};
  let timeout: () => void = () => {};
  let returnTimeout: () => void = () => {};
  let pageshow: () => void = () => {};
  let pagehide: () => void = () => {};
  let resolve: (value: Reply) => void = () => {};
  let reject: () => void = () => {};
  let status: { textContent?: string } | undefined;
  const body = { hasAttribute: () => quiet, append(value: typeof status) { status = value; } };
  class Element { closest(selector: string) { return selector === "#leaveBlockedPage" ? this : null; } }
  const window = {}; Object.assign(window, { top: window });
  runInNewContext(source, {
    window, Element, URL, atob, Date: class extends Date { static override now() { return now; } },
    addEventListener(name: string, fn: () => void) {
      if (name === "click" && !clickRegistered) { click = fn; clickRegistered = true; }
      if (name === "pageshow") pageshow = fn;
      if (name === "pagehide") pagehide = fn;
    },
    chrome: { runtime: { getURL: () => "extension://vigil/", sendMessage: () => new Promise<Reply>((yes, no) => { resolve = yes; reject = no; }) } },
    history: { length, back() { backCount++; }, go(delta: number) { traversals.push(delta); } },
    location: { href, replace(url: string) { destinations.push(url); } },
    sessionStorage: { getItem(key: string) { return stored.get(key); }, setItem(key: string, value: string) { stored.set(key, value); }, removeItem(key: string) { stored.delete(key); } },
    setTimeout(fn: () => void, ms: number) { if (ms === 1500) { returnTimeout = fn; return 2; } timeout = fn; return 1; },
    clearTimeout(id: number) { if (id === 2) returnTimeout = () => {}; },
    document: { body, readyState: "complete",
      querySelector(selector: string) {
        if (selector === "#leaveBlockedPage") return { setAttribute() {}, addEventListener(_event: string, fn: () => void) { click = fn; } };
        if (selector === "[data-vigil-quiet-return]") return quiet ? body : null;
        return selector === "main" ? body : status;
      },
      createElement() { return { setAttribute() {} }; }
    }
  });
  return { destinations, traversals, stored, backCount: () => backCount, status: () => status?.textContent,
    click() { (click as (event: unknown) => void)({ target: new Element(), preventDefault() {}, stopImmediatePropagation() {} }); },
    timeout() { timeout(); }, async reply(value: Reply) { resolve(value); await Promise.resolve(); },
    advance(ms = 2000) { now += ms; }, returnTimeout() { now += 2000; returnTimeout(); }, pageshow() { pageshow(); }, pagehide() { pagehide(); },
    async fail() { reject(); await Promise.resolve(); } };
}
for (const source of [extension, guard, server]) {
  const h = harness(source, 2);
  h.click();
  await h.reply({ ok: true, url: "about:blank" });
  assert.equal(h.backCount(), 1, "missing saved history uses native Back");
  assert.deepEqual(h.destinations, [], "manual Back must never select a white page");
  const empty = harness(source, 1);
  empty.click();
  await empty.reply({ ok: false });
  assert.equal(empty.backCount(), 0);
  assert.match(empty.status() || "", /previous page/u);
  assert.deepEqual(empty.destinations, []);
  const firstAttempt = harness(source, 4);
  firstAttempt.click(); await firstAttempt.reply({ ok: false });
  const retry = harness(source, 4, false, firstAttempt.stored);
  retry.click(); await retry.reply({ ok: false });
  assert.deepEqual(retry.traversals, [-2], "a reloaded block page skips the entry that just bounced back");
  retry.click(); await retry.reply({ ok: false });
  assert.deepEqual(retry.traversals, [-2], "rapid clicks cannot queue multiple history traversals");
  retry.returnTimeout();
  assert.equal(retry.backCount(), 1, "an oversized traversal retries one step because history length includes forward entries");
  const stale = harness(source, 4, false, new Map([["vigil-blocked-page-back", JSON.stringify({ steps: 2, length: 4, at: Date.now() - 60_000 })]]));
  stale.click(); await stale.reply({ ok: false });
  assert.equal(stale.backCount(), 1, "old fallback attempts do not affect a new browsing session");
  const cached = harness(source, 4, false, new Map([["vigil-blocked-page-back", JSON.stringify({ steps: 1, length: 4, at: Date.now() })]]));
  cached.click(); await cached.reply({ ok: false });
  cached.pagehide(); cached.returnTimeout();
  assert.equal(cached.backCount(), 0, "a timer suspended in BFCache cannot navigate on restoration");
}
for (const source of [extension, guard]) {
  const h = harness(source, 4);
  h.click(); await h.reply({ ok: true, url: "about:blank", exhausted: true });
  assert.equal(h.backCount(), 0, "verified exhausted history must not revisit rejected entries");
  assert.match(h.status() || "", /available previous page/u);
  const returned = harness(source, 4);
  returned.click(); await returned.reply({ ok: true, url: "https://example.com/previous" });
  returned.click(); await returned.reply({ ok: true, url: "https://example.com/duplicate" });
  assert.deepEqual(returned.destinations, ["https://example.com/previous"], "a successful return ignores further clicks while navigating");
  returned.advance(); returned.pageshow(); returned.click();
  await returned.reply({ ok: true, url: "https://example.com/restored" });
  assert.equal(returned.destinations.at(-1), "https://example.com/restored", "Back still works after restoring the blocker from BFCache");
}
{
  const h = harness(extension, 3);
  h.click(); h.click();
  await h.reply({ ok: true, url: "https://example.com/previous" });
  assert.deepEqual(h.destinations, ["https://example.com/previous"]);
  assert.equal(h.backCount(), 0);
}
{
  const h = harness(extension, 3);
  h.click(); h.timeout();
  await h.reply({ ok: true, url: "https://example.com/late" });
  assert.equal(h.backCount(), 1, "timeout triggers only one Back");
  assert.deepEqual(h.destinations, [], "late replies cannot override the fallback navigation");
}
{
  const h = harness(extension, 2);
  h.click(); await h.fail();
  assert.equal(h.backCount(), 1, "an unavailable companion still allows normal Back");
}
{
  const h = harness(extension, 2, true);
  await h.reply({ ok: false });
  assert.equal(h.backCount(), 0, "automatic Reddit enforcement keeps its fail-closed behavior");
  assert.deepEqual(h.destinations, ["about:blank"]);
}
console.log("Blocked-page Back loop recovery, exhausted history, BFCache, verifier failure, and timeout races passed.");
