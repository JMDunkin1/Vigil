import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const script = source.match(/static let instagramInboxBadgeBootstrap = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(script);

interface Subscription { unsubscribe(): void }
interface Observer {
  start(subscription: Subscription): void;
  error(): void;
  complete(): void;
}
interface Request { observer: Observer; cancelled: boolean }

function fixture({ late = false, nav = true, hidden = false, host = "www.instagram.com", path = "/",
  frame = false, protocol = "https:", port = "", loggedIn = true, bootloader = true } = {}) {
  let now = 1000000, nextTimer = 0, mutation: (() => void) | undefined;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const events = new Map<string, () => void>();
  const requests: Request[] = [];
  const loads: Array<(...modules: unknown[]) => void> = [];
  const location = { hostname: host, pathname: path, protocol, port };
  const document = { visibilityState: hidden ? "hidden" : "visible",
    querySelector() { return nav ? {} : null; },
    addEventListener(name: string, callback: () => void) { events.set(name, callback); } };
  const query = Object.freeze({ kind: "Request", operation: {}, fragment: {},
    params: { name: "IGDBadgeCountOffMsysQuery", operationKind: "query" } });
  const environment = {};
  const modules: Record<string, unknown> = {
    CometRelay: { fetchQuery(env: unknown, operation: unknown, variables: unknown, options: unknown) {
      assert.equal(env, environment);
      assert.equal(operation, query, "The live persisted operation must remain unchanged");
      assert.equal(JSON.stringify(variables), '{"device_id_for_iris_subscription":"site-device"}');
      assert.equal(JSON.stringify(options), '{"fetchPolicy":"network-only","networkCacheConfig":{"force":true}}');
      return { subscribe(observer: Observer) {
        const request = { observer, cancelled: false };
        requests.push(request);
        observer.start({ unsubscribe() { request.cancelled = true; } });
      } };
    } },
    PolarisRelayEnvironment: { default: environment },
    "IGDBadgeCountOffMsysQuery.graphql": query,
    IGDMqttWebDeviceID: { clientId: "site-device" },
    CurrentUser: { isLoggedIn: () => loggedIn }
  };
  const window: Record<string, unknown> = {};
  window.top = frame ? {} : window;
  window.require = (name: string) => {
    if (name === "Bootloader") return bootloader ? { loadModules(names: string[], callback: (...values: unknown[]) => void) {
      assert.equal(JSON.stringify(names), JSON.stringify(Object.keys(modules)));
      loads.push(callback);
    } } : null;
    return late ? null : modules[name];
  };
  const context = vm.createContext({ window, location, document, Date: { now: () => now },
    MutationObserver: class {
      constructor(callback: () => void) { mutation = callback; }
      observe() {}
      disconnect() { mutation = undefined; }
    },
    setTimeout(callback: () => void, delay: number) {
      const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id;
    },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener(name: string, callback: () => void) { events.set(name, callback); }
  });
  vm.runInContext(script!, context);
  return { window, context, requests, loads, modules, location, document, events,
    get status() { return (window.__vigilInstagramInboxBadgeBootstrap as { status: string } | undefined)?.status; },
    nav(value: boolean) { nav = value; mutation?.(); },
    arrive(index = 0) { loads[index]?.(...Object.values(modules)); },
    visibility(value: "hidden" | "visible") { document.visibilityState = value; events.get("visibilitychange")?.(); },
    event(name: string) { events.get(name)?.(); },
    advance(milliseconds: number) {
      const end = now + milliseconds;
      for (let iteration = 0; iteration < 1000; iteration++) {
        const first = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!first || first[1].at > end) { now = end; return; }
        now = first[1].at; timers.delete(first[0]); first[1].callback();
      }
      throw new Error("Unbounded retry loop");
    }
  };
}

test("Home hydrates the native badge query without visiting Messages, including late navigation/loader startup", () => {
  const page = fixture({ late: true, nav: false });
  assert.equal(page.loads.length, 0);
  page.nav(true);
  assert.equal(page.loads.length, 1);
  page.arrive();
  assert.equal(page.requests.length, 1);
  assert.equal(page.status, "loading");
  page.requests[0]!.observer.complete();
  assert.equal(page.status, "ready");
  assert.equal(page.location.pathname, "/");
  page.event("pageshow"); page.event("online"); page.event("__vigilRouteChanged");
  vm.runInContext(script!, page.context);
  assert.equal(page.requests.length, 1, "Startup events and duplicate injection cannot issue duplicate refreshes");
});

test("visible Home refreshes on return; hidden pages and Direct never start or retain badge requests", () => {
  const page = fixture({ hidden: true });
  assert.equal(page.requests.length, 0);
  page.visibility("visible");
  assert.equal(page.requests.length, 1);
  page.visibility("hidden");
  assert.equal(page.requests[0]!.cancelled, true);
  page.requests[0]!.observer.complete();
  assert.notEqual(page.status, "ready", "A cancelled response cannot establish a successful refresh");
  page.visibility("visible");
  assert.equal(page.requests.length, 2);
  page.location.pathname = "/direct/inbox/"; page.event("__vigilRouteChanged");
  assert.equal(page.requests[1]!.cancelled, true);
  page.advance(16000);
  page.location.pathname = "/"; page.event("__vigilRouteChanged");
  assert.equal(page.requests.length, 3);
  page.requests[2]!.observer.complete();
  page.advance(16000); page.visibility("visible");
  assert.equal(page.requests.length, 4);
  page.event("pagehide");
  assert.equal(page.requests[3]!.cancelled, true);
});

test("request failure retries are bounded and a later online event recovers", () => {
  const page = fixture();
  for (let index = 0; index < 3; index++) {
    page.requests[index]!.observer.error(); page.advance(1000);
  }
  page.advance(60000);
  assert.equal(page.requests.length, 3);
  assert.equal(page.status, "unavailable");
  page.event("online");
  assert.equal(page.requests.length, 4);
  page.requests[3]!.observer.complete();
  assert.equal(page.status, "ready");
});

test("late module callbacks and old request errors cannot interfere with a new attempt", () => {
  const page = fixture({ late: true });
  page.advance(5000);
  assert.equal(page.loads.length, 2);
  page.arrive(0);
  assert.equal(page.requests.length, 0, "The timed-out loader callback is stale");
  page.arrive(1); page.arrive(1);
  assert.equal(page.requests.length, 1, "Duplicate loader delivery cannot fetch twice");
  page.requests[0]!.observer.error(); page.advance(1000);
  page.arrive(2);
  assert.equal(page.requests.length, 2);
  page.requests[0]!.observer.error();
  assert.equal(page.requests[1]!.cancelled, false);
  page.requests[1]!.observer.complete();
  assert.equal(page.status, "ready");
});

test("stalled runtime and requests expire without indefinite polling", () => {
  const noRuntime = fixture({ late: true, bootloader: false });
  noRuntime.advance(60000);
  assert.equal(noRuntime.status, "unavailable");
  assert.equal(noRuntime.requests.length, 0);
  const stalled = fixture(); stalled.advance(60000);
  assert.equal(stalled.status, "unavailable");
  assert.equal(stalled.requests.length, 2, "The shared deadline bounds even stalled request retries");
  assert.ok(stalled.requests.every(request => request.cancelled));
});

test("throwing or unsupported site exports leave the page usable and allow recovery", () => {
  const page = fixture({ late: true });
  const original = page.modules.CometRelay;
  page.modules.CometRelay = { fetchQuery() { throw new Error("Site runtime not ready"); } };
  assert.doesNotThrow(() => page.arrive());
  assert.equal(page.status, "unavailable");
  page.advance(1000);
  page.modules.CometRelay = original;
  page.arrive(1);
  assert.equal(page.requests.length, 1);
  page.requests[0]!.observer.complete();
  assert.equal(page.status, "ready");
});

test("foreign origins, frames, authentication, unknown query shapes and signed-out sessions stay untouched", () => {
  for (const options of [{ host: "example.com" }, { host: "instagram.com.example.com" }, { frame: true },
    { protocol: "http:" }, { port: "8443" }, { path: "/accounts/login/" }, { path: "/direct/inbox/" },
    { loggedIn: false }, { nav: false }]) {
    const page = fixture(options); page.advance(60000);
    assert.equal(page.requests.length, 0);
  }
  const unknown = fixture({ late: true });
  unknown.modules["IGDBadgeCountOffMsysQuery.graphql"] = { kind: "Request", params: { operationKind: "mutation" } };
  unknown.arrive(); unknown.advance(1000); unknown.arrive(1); unknown.advance(1000); unknown.arrive(2);
  assert.equal(unknown.requests.length, 0);
});
