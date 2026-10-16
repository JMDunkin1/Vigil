import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { blockedPage } from "../src/server/pages.js";
import { defaultState } from "../src/defaults.js";

const extension = await readFile(new URL("../extension/blocked-navigation.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../extension/reddit-review-guard.js", import.meta.url), "utf8");
const server = blockedPage({ url: new URL("http://127.0.0.1:8787/blocked"), state: defaultState() }).match(/<script>([\s\S]*?)<\/script>/u)![1];
type Reply = { ok?: boolean; url?: string; handled?: boolean; exhausted?: boolean };
type Provenance = { type?: string; key?: string; entries?: { key: string; index: number }[]; index?: number };
function harness(source: string, length: number, quiet = false, stored = new Map<string, string>(), href = "extension://vigil/blocked.html", provenance: Provenance = { type: "navigate", key: "current" }) {
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
    performance: { getEntriesByType: () => provenance.type ? [{ type: provenance.type }] : [] },
    navigation: provenance.key ? { currentEntry: { key: provenance.key, index: provenance.index ?? 2 }, entries: () => provenance.entries || [] } : undefined,
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
  const firstAttemptState = new Map(firstAttempt.stored);
  firstAttempt.advance(); firstAttempt.click(); await firstAttempt.reply({ ok: false });
  assert.deepEqual(firstAttempt.traversals, [-2], "the same document can retry a failed Back");
  const earlierReload = {
    type: "reload", key: "denied", index: 1, entries: [{ key: "denied", index: 1 }, { key: "current", index: 2 }]
  };
  const retry = harness(source, 4, false, new Map(firstAttemptState), undefined, earlierReload);
  retry.click(); await retry.reply({ ok: false });
  assert.deepEqual(retry.traversals, [-2], "a reloaded block page skips the entry that just bounced back");
  retry.click(); await retry.reply({ ok: false });
  assert.deepEqual(retry.traversals, [-2], "rapid clicks cannot queue multiple history traversals");
  retry.returnTimeout();
  assert.equal(retry.backCount(), 1, "an oversized traversal retries one step because history length includes forward entries");
  const stale = harness(source, 4, false, new Map([["vigil-blocked-page-back", JSON.stringify({ steps: 2, length: 4, at: Date.now() - 60_000, entryKey: "current" })]]), undefined, earlierReload);
  stale.click(); await stale.reply({ ok: false });
  assert.equal(stale.backCount(), 1, "old fallback attempts do not affect a new browsing session");
  const cached = harness(source, 4, false, new Map([["vigil-blocked-page-back", JSON.stringify({ steps: 1, length: 4, at: Date.now(), entryKey: "current" })]]), undefined, earlierReload);
  cached.click(); await cached.reply({ ok: false });
  cached.pagehide(); cached.returnTimeout();
  assert.equal(cached.backCount(), 0, "a timer suspended in BFCache cannot navigate on restoration");
  for (const length of [2, 4]) {
    const previousVisit = harness(source, length);
    previousVisit.click(); await previousVisit.reply({ ok: false });
    assert.equal(previousVisit.backCount(), 1);
    previousVisit.pagehide();
    const freshVisit = harness(source, length, false, previousVisit.stored, undefined, { type: "navigate", key: "fresh" });
    freshVisit.click(); await freshVisit.reply({ ok: false });
    assert.equal(freshVisit.backCount(), 1, "a successful Back followed by a fresh block visit still returns one entry");
    assert.deepEqual(freshVisit.traversals, [], "a new visit cannot skip the safe page because it shares retry storage");
  }
  const originalEntry = {
    key: "current", index: 1, entries: [{ key: "safe", index: 0 }, { key: "current", index: 1 }]
  };
  const successfulReturn = harness(source, 2, false, undefined, undefined, { ...originalEntry, type: "navigate" });
  successfulReturn.click(); await successfulReturn.reply({ ok: false });
  assert.equal(successfulReturn.backCount(), 1);
  successfulReturn.pagehide();
  const forwarded = harness(source, 2, false, successfulReturn.stored, undefined, { ...originalEntry, type: "back_forward" });
  forwarded.pagehide();
  const reloaded = harness(source, 2, false, forwarded.stored, undefined, { ...originalEntry, type: "reload" });
  reloaded.click(); await reloaded.reply({ ok: false });
  assert.equal(reloaded.backCount(), 1, "successful Back followed by Forward and reload still reaches the safe predecessor");
  assert.deepEqual(reloaded.traversals, [], "reloading the original blocker does not prove that its previous Back failed");
  assert.equal(reloaded.status(), undefined, "an available safe predecessor must not be reported exhausted");
  const replaced = harness(source, 4, false, new Map(firstAttemptState), undefined, {
    type: "navigate", key: "denied", index: 1, entries: [{ key: "denied", index: 1 }, { key: "current", index: 2 }]
  });
  replaced.click(); await replaced.reply({ ok: false });
  assert.deepEqual(replaced.traversals, [-2], "a client replacement bounce retains the attempted blocker as a forward entry");
  const traversed = harness(source, 4, false, new Map(firstAttemptState), undefined, {
    type: "back_forward", key: "earlier", index: 1, entries: [{ key: "earlier", index: 1 }, { key: "current", index: 2 }]
  });
  traversed.click(); await traversed.reply({ ok: false });
  assert.deepEqual(traversed.traversals, [-2], "a native history bounce can retry the failed traversal");
  const unavailable = harness(source, 4, false, new Map(firstAttemptState), undefined, {});
  unavailable.click(); await unavailable.reply({ ok: false });
  assert.equal(unavailable.backCount(), 1, "unavailable navigation provenance conservatively uses one-step Back");
  assert.deepEqual(unavailable.traversals, []);
  for (const provenance of [{ type: "back_forward", key: "current" }, { type: "back_forward" }, { type: "reload", key: "fresh" }]) {
    const forward = harness(source, 4, false, new Map(firstAttemptState), undefined, provenance);
    forward.click(); await forward.reply({ ok: false });
    assert.equal(forward.backCount(), 1, "Forward to the original blocker or reload of a new visit cannot reuse an unrelated retry");
    assert.deepEqual(forward.traversals, []);
  }
  const assigned = harness(source, 4, false, new Map(firstAttemptState), undefined, { type: "navigate", key: "assigned" });
  assigned.click(); await assigned.reply({ ok: false });
  assert.equal(assigned.backCount(), 1, "an unverified client assign bounce is ambiguous with a fresh visit and uses ordinary Back");
  const restored = harness(source, 4);
  restored.click(); await restored.reply({ ok: false });
  restored.pagehide(); restored.pageshow(); restored.click(); await restored.reply({ ok: false });
  assert.equal(restored.backCount(), 2, "restoring the original blocker after successful Back does not retain its in-document retry");
  assert.deepEqual(restored.traversals, []);
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
