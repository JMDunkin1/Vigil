import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../extension/reddit-review-guard.js", import.meta.url), "utf8");
const post = "https://www.reddit.com/r/reviews/comments/abc123/kettle/";
class Element {
  isConnected = true;
  textContent = "";
  matches() { return false; }
  closest() { return null; }
  getAttribute() { return null; }
  setAttribute() { /* DOM fixture has no matching controls. */ }
  append() { /* DOM fixture has no matching controls. */ }
  remove() { this.isConnected = false; }
  querySelectorAll() { return []; }
}
class Form extends Element {
  method = "get";
  action = post;
  submissions = 0;
  requestSubmit() { this.submissions++; }
}
class Document extends Element {
  documentElement = new Element();
  createElement() { return new Element(); }
}
async function attempt({ ok = true, action = post, method = "get", changed = false, disconnected = false } = {}) {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  let resolveCheck: (result: { ok: boolean }) => void = () => {};
  const window = { top: null as unknown }; window.top = window;
  const document = new Document();
  runInNewContext(source, {
    URL, window, document, Element, Document, ShadowRoot: class {}, HTMLFormElement: Form,
    HTMLAnchorElement: class extends Element {}, KeyboardEvent: class {},
    location: { ...Object.fromEntries(["href", "hostname", "pathname"].map(key => [key, (new URL(post) as unknown as Record<string, string>)[key]])), replace: () => {} },
    chrome: { runtime: { getURL: (path: string) => "extension://vigil/" + path.replace(/^\//u, ""),
      sendMessage: ({ action }: { action: string }) => {
        if (action === "check") return new Promise(resolve => { resolveCheck = resolve; });
        return Promise.resolve({ ok: false });
      } } },
    addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, [...(listeners.get(name) || []), listener]),
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, queueMicrotask: () => {}
  });
  const form = new Form(); form.action = action; form.method = method;
  let prevented = false;
  const event = { type: "submit", target: form, cancelable: true, composedPath: () => [form],
    preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => {} };
  for (const listener of listeners.get("submit") || []) listener(event);
  assert.equal(prevented, true, "submission stays suspended until provenance resolves");
  assert.equal(form.submissions, 0);
  if (changed) form.action = "https://www.reddit.com/";
  if (disconnected) form.isConnected = false;
  resolveCheck({ ok });
  await new Promise<void>(resolve => setImmediate(resolve));
  return form.submissions;
}
assert.equal(await attempt(), 1, "an authorized thread resumes its own automatic GET document check");
assert.equal(await attempt({ ok: false }), 0, "a direct or denied thread never resumes a form");
assert.equal(await attempt({ action: "https://www.reddit.com/" }), 0, "homepage forms cannot navigate after authorization");
assert.equal(await attempt({ action: post.replace("abc123", "def456") }), 0, "authorization cannot resume a different thread");
assert.equal(await attempt({ method: "post" }), 0, "social actions remain blocked");
assert.equal(await attempt({ changed: true }), 0, "a queued form is revalidated at the moment of replay");
assert.equal(await attempt({ disconnected: true }), 0, "removed forms cannot be replayed");
console.log("Reddit document-check timing and form permission boundaries passed.");
