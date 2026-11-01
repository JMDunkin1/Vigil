import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const source = readFileSync(join(root, "ios/VigilSocial/VigilSocial/DOMAdapters.swift"), "utf8");
const script = source.match(/static let instagramOutgoingUnreadCompatibility = #"""([\s\S]*?)"""#/u)?.[1];
assert.ok(script);
const inbox = "__IGDInbox__slide_messages_connection";
const messages = "__IGDMessagesList_slide_messages_connection";
const fragmentName = "XFBIGDirectViewerThreadIsUnreadResolver_XFBIGDirectViewerThread";
type Data = Record<string, unknown>;
const item = (sender = "100", timestamp = "2000") => ({ node: {
  id: `message-${sender}-${timestamp}`, sender_fbid: sender, timestamp_ms: timestamp
} });
const data = (extra: Data = {}): Data => ({
  marked_as_unread: false, last_activity_timestamp_ms: "2000",
  slide_read_receipts: [{ participant_fbid: "100", watermark_timestamp_ms: "1000" }],
  [messages]: { edges: [item(), item("200", "1000")] }, ...extra
});

function fixture({ late = false, host = "www.instagram.com", frame = false, port = "", protocol = "https:" } = {}) {
  const window: Record<string, unknown> = {};
  window.top = frame ? {} : window;
  let notify: (() => void) | undefined;
  let callback: ((...args: unknown[]) => void) | undefined;
  let subscriptions = 0;
  const timers = new Set<() => void>();
  const requireLazy = (names: string[], install: (...args: unknown[]) => void) => {
    assert.deepEqual(Array.from(names), ["XFBIGDirectViewerThreadIsUnreadResolver",
      `${fragmentName}.graphql`, "relay-runtime/store/ResolverFragments", "CurrentUser"]);
    subscriptions++; callback = install;
  };
  if (!late) window.requireLazy = requireLazy;
  const context = vm.createContext({ window, location: { hostname: host, pathname: "/direct/inbox/", port, protocol },
    document: {}, MutationObserver: class {
      constructor(fn: () => void) { notify = fn; }
      observe() {}
      disconnect() { notify = undefined; }
    },
    setInterval: (fn: () => void) => { timers.add(fn); return fn; },
    clearInterval: (fn: () => void) => timers.delete(fn),
    setTimeout: (fn: () => void) => { timers.add(fn); return fn; },
    clearTimeout: (fn: () => void) => timers.delete(fn)
  });
  vm.runInContext(script!, context);
  let viewer: unknown = "100", snapshot: Data | undefined, originalCalls = 0;
  const fragment = { kind: "Fragment", name: fragmentName,
    selections: ["marked_as_unread", "last_activity_timestamp_ms", "slide_read_receipts"].map(name => ({ kind: "ScalarField", name })) };
  const fragments = { readFragment(selection: typeof fragment, key: Data) {
    // Production Relay caches the FIRST fragment read in each resolver call.
    // Project selected fields so reading the original first loses the evidence.
    if (snapshot) return snapshot;
    snapshot = {};
    for (const field of selection.selections) {
      if (field.kind === "ClientExtension") {
        const fields = (field as unknown as { selections: { name: string }[] }).selections;
        for (const client of fields) snapshot[client.name] = key[client.name];
      } else snapshot[field.name] = key[field.name];
    }
    return snapshot;
  } };
  const receiver = {};
  const original = function(this: unknown, key: Data, argument: string) {
    assert.equal(this, receiver); assert.equal(argument, "unchanged"); originalCalls++;
    const value = fragments.readFragment(fragment, key);
    if (key.throwOriginal) throw key.throwOriginal;
    const receipt = (value.slide_read_receipts as Data[]).find(r => r.participant_fbid === viewer);
    return value.marked_as_unread === true || Number(receipt?.watermark_timestamp_ms ?? 0) < Number(value.last_activity_timestamp_ms);
  };
  const module = { client__is_unread: original };
  return { window, context, timers, fragment, module,
    get subscriptions() { return subscriptions; },
    get originalCalls() { return originalCalls; },
    viewer(value: unknown) { viewer = value; },
    arrive() { window.requireLazy = requireLazy; notify?.(); },
    install(value: unknown = module) { callback?.(value, fragment, fragments, { getEIMU: () => viewer }); },
    unread(value: Data) { snapshot = undefined; return module.client__is_unread.call(receiver, value, "unchanged"); }
  };
}

test("outgoing-only activity stops generating unread state; incoming activity and explicit unread remain", () => {
  const page = fixture();
  assert.equal(page.unread(data()), true, "Reproduce the unmodified site: our own send advances activity past our receipt");
  page.install();
  assert.equal(page.unread(data()), false);
  assert.equal(page.unread(data({ [messages]: { edges: [item("200"), item("100", "1000")] } })), true);
  assert.equal(page.unread(data({ marked_as_unread: true })), true);
  assert.equal(page.unread(data({ last_activity_timestamp_ms: "1000", [messages]: undefined })), false);
  assert.equal(page.originalCalls, 5, "The site resolver still runs once with its original receiver and arguments");
});

test("older unseen incoming messages cannot be hidden by a more recent own send", () => {
  const page = fixture(); page.install();
  assert.equal(page.unread(data({ [messages]: { edges: [item(), item("200", "1500"), item("200", "1000")] } })), true);
  assert.equal(page.unread(data({ [inbox]: { edges: [item(), item("200", "1500")] } })), true,
    "Conflicting incoming evidence in either connection wins");
  assert.equal(page.unread(data({ [inbox]: { edges: [item()] }, [messages]: { edges: [item("200", "1000")] } })), true,
    "Separate incomplete histories cannot be combined to claim coverage");
});

test("an inbox or loaded conversation can prove a complete outgoing-only interval without changing data", () => {
  const page = fixture(); page.install();
  for (const connection of [inbox, messages]) {
    const value = data({ [messages]: undefined, [connection]: { edges: [item(), item("100", "1500"), item("200", "1000")] } });
    const before = structuredClone(value);
    assert.equal(page.unread(value), false);
    assert.deepEqual(value, before, "No read receipts, messages or server data may be changed");
  }
  assert.equal(page.fragment.selections.length, 3, "The site's original fragment must remain intact");
});

test("missing, partial, stale and malformed evidence retains the site's unread state", () => {
  const page = fixture(); page.install();
  const cases = [
    { [messages]: undefined }, { [messages]: { edges: [] } },
    { [messages]: { edges: [item()] } },
    { [messages]: { edges: [item("100", "1999"), item("200", "1000")] } },
    { [messages]: { edges: [item(), null, item("200", "1000")] } },
    { [messages]: { edges: [item(), { node: { id: "missing", timestamp_ms: "1000" } }] } },
    { [messages]: { edges: [item(), item("100", "2001"), item("200", "1000")] } },
    { [messages]: { edges: [item(), item("200", "1000.5")] } },
    { [messages]: { edges: Array.from({ length: 501 }, () => item()) } },
    { marked_as_unread: undefined }, { marked_as_unread: null },
    { slide_read_receipts: [] },
    { slide_read_receipts: [{ participant_fbid: "100", watermark_timestamp_ms: "0" }] },
    { slide_read_receipts: [{ participant_fbid: "100", watermark_timestamp_ms: "1000" },
      { participant_fbid: "100", watermark_timestamp_ms: "900" }] }
  ];
  for (const value of cases) assert.equal(page.unread(data(value)), true, JSON.stringify(value).slice(0, 150));
  const sentinel = new Error("Original resolver failure");
  assert.throws(() => page.unread(data({ throwOriginal: sentinel })), error => error === sentinel);
});

test("account changes use the current viewer and never carry a previous account's correction", () => {
  const page = fixture(); page.install();
  assert.equal(page.unread(data()), false);
  page.viewer("200");
  assert.equal(page.unread(data()), true);
  page.viewer("100");
  assert.equal(page.unread(data()), false);
});

test("document-start bootstrap handles delayed modules, repeated injection and unsupported exports", () => {
  const page = fixture({ late: true });
  assert.equal(page.subscriptions, 0); page.arrive();
  assert.equal(page.subscriptions, 1); assert.equal(page.timers.size, 0);
  page.install();
  const resolver = page.module.client__is_unread;
  vm.runInContext(script!, page.context);
  page.arrive();
  assert.equal(page.subscriptions, 1); assert.equal(page.module.client__is_unread, resolver);
  assert.equal((page.window.__vigilInstagramOutgoingUnreadCompatibility as { installed: boolean }).installed, true);
  const frozen = fixture();
  assert.doesNotThrow(() => frozen.install(Object.freeze({ client__is_unread() {} })));
  assert.equal((frozen.window.__vigilInstagramOutgoingUnreadCompatibility as { installed: boolean }).installed, false);
  const unknown = fixture();
  assert.doesNotThrow(() => unknown.install({}));
});

test("foreign pages, embedded frames, HTTP and nonstandard ports stay untouched", () => {
  for (const options of [{ host: "example.com" }, { host: "instagram.com.example.com" }, { frame: true },
    { protocol: "http:" }, { port: "8443" }]) assert.equal(fixture(options).subscriptions, 0);
  assert.equal(fixture({ host: "instagram.com", port: "443" }).subscriptions, 1);
});
