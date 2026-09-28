import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { blockedPage } from "../src/server/pages.js";
import { defaultState } from "../src/defaults.js";

const extension = await readFile(new URL("../extension/blocked-navigation.js", import.meta.url), "utf8");
const guard = await readFile(new URL("../extension/reddit-review-guard.js", import.meta.url), "utf8");
const server = blockedPage({ url: new URL("http://127.0.0.1:8787/blocked"), state: defaultState() }).match(/<script>([\s\S]*?)<\/script>/u)![1];
type Reply = { ok?: boolean; url?: string; handled?: boolean };
function harness(source: string, length: number, quiet = false) {
  const destinations: string[] = [];
  let backCount = 0;
  let clickRegistered = false;
  let click: () => void = () => {};
  let timeout: () => void = () => {};
  let resolve: (value: Reply) => void = () => {};
  let reject: () => void = () => {};
  let status: { textContent?: string } | undefined;
  const body = { hasAttribute: () => quiet, append(value: typeof status) { status = value; } };
  class Element { closest(selector: string) { return selector === "#leaveBlockedPage" ? this : null; } }
  const window = {}; Object.assign(window, { top: window });
  runInNewContext(source, {
    window, Element, URL, atob,
    addEventListener(name: string, fn: () => void) { if (name === "click" && !clickRegistered) { click = fn; clickRegistered = true; } },
    chrome: { runtime: { getURL: () => "extension://vigil/", sendMessage: () => new Promise<Reply>((yes, no) => { resolve = yes; reject = no; }) } },
    history: { length, back() { backCount++; } },
    location: { href: "extension://vigil/blocked.html", replace(url: string) { destinations.push(url); } },
    setTimeout(fn: () => void) { timeout = fn; return 1; }, clearTimeout() {},
    document: { body, readyState: "complete",
      querySelector(selector: string) {
        if (selector === "#leaveBlockedPage") return { addEventListener(_event: string, fn: () => void) { click = fn; } };
        if (selector === "[data-vigil-quiet-return]") return quiet ? body : null;
        return selector === "main" ? body : status;
      },
      createElement() { return { setAttribute() {} }; }
    }
  });
  return { destinations, backCount: () => backCount, status: () => status?.textContent,
    click() { (click as (event: unknown) => void)({ target: new Element(), preventDefault() {}, stopImmediatePropagation() {} }); },
    timeout() { timeout(); }, async reply(value: Reply) { resolve(value); await Promise.resolve(); },
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
console.log("Blocked-page Back navigation, empty history, verifier failure, and timeout races passed.");
