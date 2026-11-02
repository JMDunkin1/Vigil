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

// Model the real loader's synchronous factory hook, exports reset, arity-based
// arguments and consumer-before-requireLazy ordering. No observer/timer runs
// between loader initialization, factory execution and the first render.
const factorySetup = `
  window.fixtureFactoryCalls = 0;
  window.fixtureReceiver = {};
  window.fixtureRecord = {
    id: 'PolarisStoryTemplateConfigForSystemEntry', exports: null,
    factory: function(global, require, module, exports) {
      if (this !== window.fixtureReceiver || global !== window || require !== 'dependency'
          || module !== window.fixtureRecord || exports !== module.exports) throw new Error('Factory contract changed');
      window.fixtureFactoryCalls++;
      exports.getItemTemplateConfigForSystemEntry = function(entry) {
        if (this !== module.exports) throw new Error('Renderer receiver changed');
        if (entry.bad) throw new Error('Destination is null for activity feed story');
        return entry;
      };
    }
  };
  window.fixtureEvaluate = () => {
    const record = window.fixtureRecord;
    window.__onBeforeModuleFactory?.(record);
    if (record.factory.length !== 4) throw new Error('Factory arity changed');
    record.exports = {};
    const result = record.factory.call(window.fixtureReceiver, window, 'dependency', record, record.exports);
    if (result !== undefined) record.exports = result;
    const renderer = record.exports.getItemTemplateConfigForSystemEntry;
    const entries = [{id:'before'}, {bad:true}, {id:'after'}];
    return entries.map(entry => renderer.call(record.exports, entry));
  };
`;
const race = fixture({ late: true });
vm.runInContext(factorySetup, race.context);
vm.runInContext("window.__onBeforeModuleFactory = null", race.context);
assert.equal(JSON.stringify(vm.runInContext("window.fixtureEvaluate()", race.context)), '[{"id":"before"},null,{"id":"after"}]',
  "The very first same-task render must work, before any lazy callback or mutation observer");
assert.equal(race.window.fixtureFactoryCalls, 1);
assert.equal(race.window.__onBeforeModuleFactory, null, "Successful installation restores the site's latest hook");
assert.equal(race.timers.size, 0);

const lateVisit = fixture({ path: "/direct/inbox/", late: true });
vm.runInContext(factorySetup, lateVisit.context);
for (const callback of [...lateVisit.timers.values()]) callback();
assert.equal(lateVisit.timers.size, 0, "Bootstrap polling is bounded");
lateVisit.location.pathname = "/notifications/";
assert.equal(JSON.stringify(vm.runInContext("window.fixtureEvaluate()", lateVisit.context)), '[{"id":"before"},null,{"id":"after"}]',
  "A first Notifications visit after the polling deadline still installs before rendering");
assert.equal(Object.hasOwn(lateVisit.window, "__onBeforeModuleFactory"), false, "An unassigned hook is removed after installation");

const chained = fixture({ late: true });
vm.runInContext(factorySetup + `
  window.fixtureHookReceiver = false;
  window.fixtureSiteHook = function(record, marker) {
    window.fixtureHookReceiver = this === window && marker === 'marker';
    return 42;
  };
  window.__onBeforeModuleFactory = window.fixtureSiteHook;
  window.fixtureHookResult = window.__onBeforeModuleFactory({id:'OtherModule',factory:window.fixtureRecord.factory}, 'marker');
`, chained.context);
assert.equal(chained.window.fixtureHookReceiver, true);
assert.equal(chained.window.fixtureHookResult, 42, "The site's hook keeps its receiver, arguments and result");
vm.runInContext("window.fixtureEvaluate()", chained.context);
assert.equal(chained.window.__onBeforeModuleFactory, chained.window.fixtureSiteHook);

const capturedHook = fixture({ late: true });
vm.runInContext(factorySetup + `
  const originalHook = window.__onBeforeModuleFactory;
  window.fixtureSiteHook = function(record) {return originalHook.call(this, record)};
  window.__onBeforeModuleFactory = window.fixtureSiteHook;
  window.fixtureEvaluate();
`, capturedHook.context);
assert.equal(capturedHook.window.__onBeforeModuleFactory, capturedHook.window.fixtureSiteHook,
  "A site hook wrapping the observed hook must not recurse or lose its own installation");

const returned = fixture({ late: true });
assert.equal(vm.runInContext(`
  const exported = {getItemTemplateConfigForSystemEntry() {throw new Error('Destination is null for activity feed story')}};
  const record = {id:'PolarisStoryTemplateConfigForSystemEntry',factory:function() {return exported},exports:{}};
  window.__onBeforeModuleFactory(record);
  record.factory() === exported && exported.getItemTemplateConfigForSystemEntry() === null;
`, returned.context), true, "Factory return-value exports are also wrapped without changing their identity");

const throwing = fixture({ late: true });
assert.equal(vm.runInContext(`
  const failure = new Error('Factory failure');
  const record = {id:'PolarisStoryTemplateConfigForSystemEntry',factory:function() {throw failure},exports:{}};
  window.__onBeforeModuleFactory(record);
  let preserved = false; try {record.factory()} catch(error) {preserved = error === failure}
  preserved;
`, throwing.context), true, "Factory failures retain their original behavior");
assert.equal((throwing.window.__vigilInstagramActivityFeedCompatibility as { installed: boolean }).installed, false);
console.log("Instagram Notifications: first same-task render, late SPA visit, loader hook lifecycle/contracts, mixed entries, exact error scope, and frame boundaries passed.");
