import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const script = source.match(/static let instagramActivityFeedCompatibility = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(script);

function fixture({ host = "www.instagram.com", path = "/notifications/", frame = false, late = false } = {}) {
  const callbacks: Array<(module: unknown) => void> = [];
  const timers = new Map<number, () => void>();
  let mutations: (() => void) | undefined;
  let nextTimer = 1;
  const window: Record<string, unknown> = {};
  window.top = frame ? {} : window;
  const requireLazy = (names: string[], callback: (module: unknown) => void) => {
    assert.deepEqual(Array.from(names), ["PolarisStoryTemplateConfigForSystemEntry"]);
    callbacks.push(callback);
  };
  if (!late) window.requireLazy = requireLazy;
  const location = { hostname: host, pathname: path, protocol: "https:", port: "" };
  const context = vm.createContext({ window, location, document: {},
    MutationObserver: class {
      constructor(callback: () => void) { mutations = callback; }
      observe() {}
      disconnect() { mutations = undefined; }
    },
    setInterval: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearInterval: (id: number) => timers.delete(id),
    setTimeout: (callback: () => void) => { const id = nextTimer++; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id)
  });
  vm.runInContext(script!, context);
  return { window, location, callbacks, timers, context,
    loaderArrives() { window.requireLazy = requireLazy; mutations?.(); }
  };
}

const page = fixture({ late: true });
assert.equal(page.callbacks.length, 0);
page.loaderArrives();
assert.equal(page.callbacks.length, 1, "Parser-time module-loader arrival must subscribe before the renderer is used");
assert.equal(page.timers.size, 0, "Registration releases bootstrap observation and timers");
let calls = 0;
const badDestination = new Error("Destination is null for activity feed story");
const unrelated = new Error("Unrelated renderer failure");
const module = { getItemTemplateConfigForSystemEntry(this: unknown, entry: { kind: string }, viewer: unknown): unknown {
  calls++;
  assert.equal(this, module);
  assert.equal(viewer, "viewer");
  if (entry.kind === "malformed") throw badDestination;
  if (entry.kind === "other-error") throw unrelated;
  return entry;
} };
page.callbacks[0]!(module);
const valid = { kind: "valid" };
const withoutDestination = { kind: "supported-destinationless-type" };
const entries = [valid, { kind: "malformed" }, withoutDestination];
assert.deepEqual(entries.map(entry => module.getItemTemplateConfigForSystemEntry(entry, "viewer")), [valid, null, withoutDestination],
  "One malformed system entry must not discard valid notifications or supported destinationless types");
assert.equal(calls, 3);
assert.throws(() => module.getItemTemplateConfigForSystemEntry({ kind: "other-error" }, "viewer"), error => error === unrelated);
page.location.pathname = "/direct/inbox/";
assert.throws(() => module.getItemTemplateConfigForSystemEntry({ kind: "malformed" }, "viewer"), error => error === badDestination,
  "The compatibility exception belongs only to Notifications");
page.location.pathname = "/notifications";
assert.equal(module.getItemTemplateConfigForSystemEntry({ kind: "malformed" }, "viewer"), null);
const wrapped = module.getItemTemplateConfigForSystemEntry;
vm.runInContext(script, page.context);
assert.equal(page.callbacks.length, 1, "Repeated installation must not stack module subscriptions");
assert.equal(module.getItemTemplateConfigForSystemEntry, wrapped);
assert.equal((page.window.__vigilInstagramActivityFeedCompatibility as { skipped: number }).skipped, 2);

for (const options of [{ host: "example.com" }, { host: "instagram.com.example.com" }, { frame: true }]) {
  assert.equal(fixture(options).callbacks.length, 0, "Foreign pages and embedded frames must remain untouched");
}
const unknown = fixture();
assert.doesNotThrow(() => unknown.callbacks[0]!(Object.freeze({})));
assert.equal((unknown.window.__vigilInstagramActivityFeedCompatibility as { installed: boolean }).installed, false);
const frozen = fixture();
assert.doesNotThrow(() => frozen.callbacks[0]!(Object.freeze({ getItemTemplateConfigForSystemEntry() {} })));
assert.equal((frozen.window.__vigilInstagramActivityFeedCompatibility as { installed: boolean }).installed, false);
console.log("Instagram Notifications: delayed loader, mixed entries, exact error scope, repeated installation, and foreign-frame boundaries passed.");
