import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { searchBreakAction, type SearchBreakState } from "../src/searchBreak.js";

const guard = await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8");
const background = await readFile(new URL("../extension/search-break-background.js", import.meta.url), "utf8");
const ledger: SearchBreakState = {};
const storage: Record<string, unknown> = {};
const events: string[] = [];
const blocked = "chrome-extension://vigil/blocked.html";
const breakPage = "chrome-extension://vigil/search-break.html";
const tab = { id: 1, active: true, url: "" };
let navigateTab = (target: string) => { tab.url = target; };
let listener: (message: unknown, sender: unknown, reply: (result: unknown) => void) => boolean;
let authorityUnavailable = false;
const api = {
  runtime: {
    getURL: (name: string) => `chrome-extension://vigil/${name}`,
    onMessage: { addListener: (value: typeof listener) => { listener = value; } }
  },
  storage: { local: {
    get: async (key: string | null) => key === null ? { ...storage } : { [key]: storage[key] },
    set: async (values: Record<string, unknown>) => { Object.assign(storage, values); },
    remove: async () => {}
  } },
  tabs: {
    get: async () => { await new Promise(resolve => setTimeout(resolve, 10)); return { ...tab }; },
    query: async () => [{ ...tab }],
    update: async (_id: number, value: { url: string }) => { navigateTab(value.url); },
    onActivated: { addListener() {} }
  },
  webNavigation: { onCommitted: { addListener() {} } }
};
runInNewContext(background, {
  URL, chrome: api,
  fetchVigil: async (_path: string, options: { body: string }) => {
    if (authorityUnavailable) throw new Error("Offline fixture");
    const body = JSON.parse(options.body);
    const result = searchBreakAction(ledger, body);
    if (body.action === "search-break-warning") events.push("warning-recorded");
    return { json: async () => result };
  }
});

async function search(query: string, visible = true, unavailable = false, stallReport = false) {
  const source = `https://www.google.com/search?q=${encodeURIComponent(query)}&safe=active`;
  tab.url = source;
  authorityUnavailable = unavailable;
  const redirects: string[] = [];
  const callbacks = new Map<string, () => void>();
  const root = { id: "topstuff", parentElement: null, querySelector: () => null };
  const notice = {
    innerText: "Results are limited by SafeSearch", parentElement: root,
    getClientRects: () => visible ? [{}] : [], closest: () => null, querySelector: () => null
  };
  let parsed = false;
  const document = {
    hidden: false, readyState: "loading", title: "Search", documentElement: {}, body: {},
    addEventListener: (name: string, callback: () => void) => { callbacks.set(name, callback); },
    querySelector: () => null,
    querySelectorAll: (selector: string) => parsed && selector.startsWith("[role='alert']") ? [notice] : [],
    createTreeWalker: () => {
      let returned = false;
      return { nextNode: () => returned ? null : (returned = true, { parentElement: notice, textContent: notice.innerText }) };
    }
  };
  const location = {
    get href() { return tab.url; },
    replace: (target: string) => { events.push("redirect"); redirects.push(target); tab.url = target; }
  };
  navigateTab = location.replace;
  runInNewContext(guard, {
    URL, URLSearchParams, location, document, crypto: { randomUUID },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    NodeFilter: { SHOW_TEXT: 4 }, Element: class {}, MutationObserver: class { observe() {} },
    addEventListener() {}, setTimeout, clearTimeout, setInterval() {},
    chrome: {
      ...api,
      runtime: {
        ...api.runtime,
        sendMessage: (message: Record<string, unknown>) => {
          return new Promise(resolve => {
            if (stallReport && message.action === "search-break-warning") return;
            const sender = { frameId: 0, tab: { id: tab.id }, url: source };
            listener(message, sender, resolve);
          });
        }
      }
    }
  });
  await new Promise(resolve => setTimeout(resolve, 30));
  parsed = true;
  callbacks.get("DOMContentLoaded")!();
  assert.deepEqual(redirects, [], "a contextual redirect waits while the background validates the current URL");
  await new Promise(resolve => setTimeout(resolve, stallReport ? 1150 : 180));
  return redirects;
}

for (const [index, query] of ["Jane Example photos", "Mary Example photos", "Alex Example photos"].entries()) {
  const start = events.length;
  const redirects = await search(query);
  assert.equal(events[start], "warning-recorded", "the warning is recorded before navigation changes the tab's URL");
  assert.equal(events.slice(start).filter(event => event === "warning-recorded").length, 1, "timer rescans cannot duplicate a page warning");
  assert.deepEqual(redirects, [index === 2 ? breakPage : blocked]);
}
assert.ok(ledger.searchBreak!.until > Date.now(), "three rapidly rejected searches still trigger the durable break");
ledger.searchBreak = undefined;
storage["vigil-search-break-until"] = 0;
await new Promise(resolve => setTimeout(resolve, 510));
const start = events.length;
assert.deepEqual(await search("Hidden Example photos", false), [], "hidden notices cannot supply either evidence or warnings");
assert.equal(events.slice(start).filter(event => event === "warning-recorded").length, 0);
assert.deepEqual(await search("Offline Example photos", true, true), [blocked], "an unavailable warning authority still blocks contextual content");
assert.deepEqual(await search("Stalled Example photos", true, false, true), [blocked], "a stalled warning message cannot indefinitely defer the contextual block");
console.log("Combined search guard records and deduplicates warnings before navigation, triggers the third-warning break, and preserves offline enforcement.");
