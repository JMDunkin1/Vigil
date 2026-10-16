import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";

const guards = [await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), await generatedIosSafariGuard()];
type Failure = "missing" | "partial" | "invalidated" | "empty";
class Element {
  readonly textContent = "Spicy clips";
  constructor(readonly tagName = "INPUT", readonly value = "honeytoon") {}
  getAttribute(name: string): string | null { return name === "type" ? "search" : name === "name" ? "q" : null; }
  closest(_selector: string): Element | null { return null; }
}
class Anchor extends Element {
  readonly href = "https://catalog.example/search?q=honeytoon";
  constructor() { super("A"); }
  override closest(selector: string): Element | null { return selector === "a[href]" ? this : null; }
}
class Form extends Element {
  readonly method = "post";
  readonly action = "https://catalog.example/search";
  readonly elements: Element[];
  constructor(readonly query = "honeytoon") { super("FORM"); this.elements = [new Element("INPUT", query)]; }
}
class FormDataFixture {
  constructor(readonly form: Form) {}
  *[Symbol.iterator]() { yield ["q", this.form.query]; }
}

function fixture(source: string, surface: "chrome" | "browser", failure: Failure, url = "https://catalog.example/") {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  let interval = () => {};
  const runtime = failure === "partial" ? {} : { getURL() {
    if (failure === "invalidated") throw new Error("Extension context unavailable");
    return "";
  } };
  const location = { href: url, replace: (target: string) => redirects.push(target), assign: (target: string) => redirects.push(target) };
  runInNewContext(source, {
    URL, URLSearchParams, Element, HTMLAnchorElement: Anchor, HTMLFormElement: Form, FormData: FormDataFixture, location,
    [surface]: failure === "missing" ? undefined : { runtime },
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    setInterval: (callback: () => void) => { interval = callback; }
  });
  return { redirects, listeners, location, tick: () => interval() };
}

for (const source of guards) for (const surface of ["chrome", "browser"] as const) {
  for (const failure of ["missing", "partial", "invalidated", "empty"] as const) {
    for (const url of ["https://reader.toomics.com/chapter", "https://catalog.example/?q=%2568oneytoon", "https://catalog.example/#/search/spicy%20clips"]) {
      assert.deepEqual(fixture(source, surface, failure, url).redirects, ["about:blank"], `${surface}/${failure}: ${url}`);
    }
    const dynamic = fixture(source, surface, failure);
    dynamic.location.href = "https://catalog.example/search?q=adult%20manhwa";
    dynamic.tick();
    assert.deepEqual(dynamic.redirects, ["about:blank"], `${surface}/${failure}: SPA navigation`);
    for (const [type, target] of [["keydown", new Element()], ["click", new Anchor()], ["auxclick", new Anchor()], ["contextmenu", new Anchor()], ["submit", new Form()]] as const) {
      const page = fixture(source, surface, failure);
      let cancelled = false, stopped = false;
      page.listeners.get(type)!({ type, target, key: "Enter", cancelable: true,
        preventDefault() { cancelled = true; }, stopImmediatePropagation() { stopped = true; } });
      assert.equal(cancelled, true, `${surface}/${failure}: ${type} cancels the unsafe action`);
      assert.equal(stopped, true, `${surface}/${failure}: ${type} stops the site's handler`);
      assert.deepEqual(page.redirects, ["about:blank"], `${surface}/${failure}: ${type} leaves restricted content`);
    }
    for (const query of ["manhwa", "manhua", "manga", "adult education video", "Middlesex gardening"]) {
      const ordinary = fixture(source, surface, failure, `https://catalog.example/search?q=${encodeURIComponent(query)}`);
      ordinary.tick();
      ordinary.listeners.get("keydown")!({ type: "keydown", key: "Enter", target: new Element("INPUT", query) });
      ordinary.listeners.get("submit")!({ type: "submit", target: new Form(query) });
      assert.deepEqual(ordinary.redirects, [], `${surface}/${failure}: ordinary search remains usable: ${query}`);
    }
  }

  // A durable break remains enforceable when messaging works but the extension
  // URL API has been invalidated; it must not silently cancel the native verdict.
  const redirects: string[] = [];
  const window = {};
  runInNewContext(source, {
    URL, URLSearchParams, top: window, self: window,
    location: { href: "https://www.google.com/search?q=landscapes&safe=active", replace: (target: string) => redirects.push(target) },
    document: { hidden: false, readyState: "loading", title: "Ordinary search", documentElement: {},
      addEventListener() {}, querySelectorAll: () => [] },
    crypto: { randomUUID: () => "native-break" },
    [surface]: { runtime: { getURL() { throw new Error("Extension context unavailable"); },
      sendMessage: async () => ({ ok: true, blocked: true }) } },
    MutationObserver: class { observe() {} }, addEventListener() {}, setInterval() {}
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(redirects, ["about:blank"], `${surface}: unavailable break page preserves the native restriction`);
}
console.log("Safari/Chrome fallback parity passed: missing, partial, invalidated and empty APIs; direct, SPA, link, input, POST and native-break enforcement.");
