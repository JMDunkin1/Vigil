import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";

const background = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const start = background.indexOf("async function checkEmbeddedFrameUrl(");
const end = background.indexOf("\nchrome.tabs.onRemoved.addListener", start);
assert.ok(start >= 0 && end > start);
const target = "https://outside-preload.example/chapter";
const sender = { tab: { id: 17 }, frameId: 4, documentId: "current-frame" };
type Frame = { url: string; documentId: string };
function authority(result: object = { ok: true, blocked: true }) {
  let frame: Frame | null = { url: target, documentId: "current-frame" };
  const requests: Array<{ url: string; event: string; seconds: number; previousUrl?: string }> = [];
  let resolveRequest: ((response: Response) => void) | undefined;
  const context = createContext({ manifest: { version: "fixture" },
    chrome: { webNavigation: { getFrame: async () => frame } },
    fetchVigil: async (_path: string, options: RequestInit) => {
      requests.push(JSON.parse(String(options.body)));
      return await new Promise<Response>(resolve => { resolveRequest = resolve; });
    }
  });
  runInContext(background.slice(start, end), context);
  const check = (identity: object = sender, url: string = target) => runInContext(
    `checkEmbeddedFrameUrl(${JSON.stringify(url)}, ${JSON.stringify(identity)})`, context
  ) as Promise<{ ok?: boolean; blocked?: boolean; stale?: boolean; skipped?: boolean }>;
  return { check, requests, replaceFrame: (next: Frame | null) => { frame = next; },
    reply: () => { assert.ok(resolveRequest); resolveRequest(new Response(JSON.stringify(result))); } };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
const denied = authority();
const pending = denied.check();
await turn();
assert.deepEqual(denied.requests, [{ url: target, event: "embedded", seconds: 0, extensionVersion: "fixture" }]);
denied.reply();
assert.deepEqual(JSON.parse(JSON.stringify(await pending)), { ok: true, blocked: true });
for (const identity of [{ ...sender, frameId: 0 }, { frameId: 4 }, { ...sender, documentId: "retired-frame" }]) {
  const rejected = authority();
  const result = await rejected.check(identity);
  assert.equal(result.ok, false);
  assert.equal(rejected.requests.length, 0, "top-level, missing-tab and retired-document requests cannot use frame authority");
}
const wrongURL = authority();
assert.equal((await wrongURL.check(sender, "https://different.example/")).stale, true);
assert.equal(wrongURL.requests.length, 0);
const navigated = authority();
const stale = navigated.check();
await turn();
navigated.replaceFrame({ url: target, documentId: "replacement-document" });
navigated.reply();
assert.equal((await stale).stale, true, "a replacement frame with the same URL cannot reuse the old verdict");

// The full native blocklist decision covers hosts outside the DNR preload,
// including their subdomains, while frame inspection adds no opens or time.
setAdultBlocklistDomainsForTest(["outside-preload.example"], ADULT_BLOCKLIST_SOURCES[0]);
try {
  const state = defaultState();
  const usage = {};
  for (const url of [target, "https://reader.outside-preload.example/chapter"]) {
    const result = evaluateExtensionCheck(state, usage, { url, event: "embedded", seconds: 0 });
    assert.equal(result.blocked, true);
    assert.equal(result.recorded, false);
  }
  assert.deepEqual(usage, {});
  state.adultBlocklist.allowlist = ["outside-preload.example"];
  assert.equal(evaluateExtensionCheck(state, usage, { url: target, event: "embedded", seconds: 0 }).blocked, false,
    "protected full-list exceptions retain the same semantics in embedded documents");
} finally { clearAdultBlocklistCacheForTest(); }

const source = await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8");
function page(url = target, topFrame = false, invalidated = false) {
  const requests: Array<{ url: string; reply: (value: { ok: boolean; blocked?: boolean; stale?: boolean }) => void }> = [];
  const redirects: string[] = [];
  const timers = new Map<number, { run: () => void; delay: number }>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const observers: Array<(records: object[]) => void> = [];
  const makeRoot = () => {
    const properties = new Map<string, { value: string; priority: string }>();
    return { style: {
    getPropertyValue: (name: string) => properties.get(name)?.value || "",
    getPropertyPriority: (name: string) => properties.get(name)?.priority || "",
    setProperty: (name: string, value: string, priority = "") => { properties.set(name, { value, priority }); },
    removeProperty: (name: string) => properties.delete(name)
    } };
  };
  const root = makeRoot();
  class Media { pauses = 0; plays = 0; paused = false; isConnected = true;
    pause() { this.pauses++; this.paused = true; }
    play() { this.plays++; this.paused = false; return Promise.resolve(); } }
  const alreadyPlaying = new Media();
  let tick = () => {};
  let now = 10_000;
  let timerId = 0;
  const top = {};
  const location = { href: url, replace: (value: string) => redirects.push(value) };
  const documentFixture = { title: "Ordinary frame", readyState: "loading", documentElement: root,
    addEventListener: (name: string, listener: (event: unknown) => void) => documentListeners.set(name, listener),
    querySelectorAll: (selector: string) => selector === "video, audio" ? [alreadyPlaying] : [], querySelector: () => null };
  runInNewContext(source, {
    URL, URLSearchParams, location, top, self: topFrame ? top : {},
    Date: { now: () => now }, addEventListener() {},
    document: documentFixture,
    HTMLMediaElement: Media,
    MutationObserver: class { constructor(callback: (records: object[]) => void) { observers.push(callback); } observe() {} disconnect() {} },
    chrome: { runtime: { getURL: (path: string) => { if (invalidated) throw new Error("Invalidated extension"); return "chrome-extension://fixture/" + path; },
      sendMessage: (message: { type: string; url: string }) => message.type === "VIGIL_EMBEDDED_FRAME_CHECK"
        ? new Promise(resolve => requests.push({ url: message.url, reply: resolve })) : Promise.resolve({ ok: true, blocked: false }) } },
    setTimeout: (run: () => void, delay: number) => { const id = ++timerId; timers.set(id, { run, delay }); return id; },
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void) => { tick = callback; }
  });
  return { requests, redirects, location, tick, root, alreadyPlaying,
    hidden: () => documentFixture.documentElement.style.getPropertyValue("display") === "none" && documentFixture.documentElement.style.getPropertyPriority("display") === "important",
    tamper: () => { documentFixture.documentElement.style.setProperty("display", "block", "important"); observers.forEach(observer => observer([])); },
    replaceRoot: () => { documentFixture.documentElement = makeRoot(); observers.forEach(observer => observer([])); },
    play: () => { const media = new Media(); documentListeners.get("play")?.({ target: media }); return media.pauses; },
    fire: (delay: number) => { const timer = [...timers].find(([, entry]) => entry.delay === delay); assert.ok(timer); timers.delete(timer[0]); timer[1].run(); },
    advance: () => { now += 5_001; } };
}
const embedded = page();
assert.equal(embedded.requests.length, 1, "document-start frame guard asks for the authoritative full-list verdict");
assert.equal(embedded.hidden(), true, "a pending long-tail frame cannot render before an authoritative allow");
assert.equal(embedded.play(), 1, "pending frame media cannot begin playback");
assert.equal(embedded.alreadyPlaying.pauses, 1, "media already playing before the frame check is paused too");
embedded.tamper();
assert.equal(embedded.hidden(), true, "removing the frame veil cannot authorize its content");
for (let index = 0; index < 20; index += 1) embedded.tick();
assert.equal(embedded.requests.length, 1, "the URL polling timer cannot flood an in-flight frame check");
embedded.requests[0].reply({ ok: true, blocked: true });
await turn();
assert.deepEqual(embedded.redirects, ["chrome-extension://fixture/blocked.html"]);
assert.equal(embedded.hidden(), true);
assert.equal(page(target, true).requests.length, 0, "top-level activity remains on its existing accounting path");
const moved = page();
moved.location.href = "https://ordinary.example/";
moved.tick();
assert.equal(moved.requests.length, 2);
moved.requests[0].reply({ ok: true, blocked: true });
moved.requests[1].reply({ ok: true, blocked: false });
await turn();
assert.deepEqual(moved.redirects, [], "the old frame URL's delayed ban cannot replace the new allowed page");
assert.equal(moved.hidden(), false, "only the new URL's authenticated allow releases the veil");
assert.equal(moved.play(), 0);
assert.equal(moved.alreadyPlaying.plays, 1, "a fresh allow restores only media that this veil interrupted");
const offline = page();
offline.requests[0].reply({ ok: false, blocked: false });
await turn();
assert.deepEqual(offline.redirects, ["chrome-extension://fixture/blocked.html"], "offline authority closes only the unverifiable frame");
assert.equal(offline.hidden(), true);
const neverSettled = page();
neverSettled.fire(3_000);
assert.equal(neverSettled.hidden(), true);
assert.deepEqual(neverSettled.redirects, ["chrome-extension://fixture/blocked.html"], "a never-settling reply cannot leave restricted content visible");
neverSettled.requests[0].reply({ ok: true, blocked: false });
await turn();
assert.equal(neverSettled.hidden(), true, "a late allow cannot reopen a terminally closed frame before its fallback commits");
const invalidated = page(target, false, true);
assert.equal(invalidated.hidden(), true);
assert.deepEqual(invalidated.redirects, ["about:blank"], "an invalidated extension retains a frame-scoped closed fallback");
const earlyFrame = page();
earlyFrame.requests[0].reply({ ok: false, stale: true });
await turn();
assert.equal(earlyFrame.hidden(), true);
assert.deepEqual(earlyFrame.redirects, []);
earlyFrame.fire(50);
assert.equal(earlyFrame.requests.length, 2, "document-start frame discovery retries under the same closed deadline");
earlyFrame.requests[1].reply({ ok: true, blocked: false });
await turn();
assert.equal(earlyFrame.hidden(), false);
earlyFrame.advance(); earlyFrame.tick();
assert.equal(earlyFrame.hidden(), true, "policy renewal conceals the frame until reauthorized");
earlyFrame.requests[2].reply({ ok: true, blocked: true });
await turn();
assert.deepEqual(earlyFrame.redirects, ["chrome-extension://fixture/blocked.html"]);
const replacedRoot = page();
replacedRoot.replaceRoot();
assert.equal(replacedRoot.hidden(), true, "a replacement document root remains veiled while the decision is pending");
replacedRoot.requests[0].reply({ ok: true, blocked: false });
await turn();
assert.equal(replacedRoot.hidden(), false, "an authorized replacement root is restored alongside the original veiled root");
assert.equal(replacedRoot.root.style.getPropertyValue("display"), "");
console.log("Full-list embedded enforcement, closed pending/offline/timeout fallbacks, protected exceptions, no usage accounting, document races, bounded retries and parent isolation passed.");
