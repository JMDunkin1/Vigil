import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const runtimeParent = dirname(runtimeRoot);
const projectRoot = basename(runtimeRoot) === "runtime" && ["dist", "dist.nosync"].includes(basename(runtimeParent))
  ? dirname(runtimeParent)
  : runtimeRoot;
const [contentSource, historyBridgeSource, safariManifestSource, filterRulesSource, handlerSource] = await Promise.all([
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/history-bridge.js"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/manifest.json"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/SafariWebExtensionHandler.swift"), "utf8")
]);
const safariManifest = JSON.parse(safariManifestSource) as {
  web_accessible_resources?: Array<{ resources?: string[] }>;
};
const schemaMatch = filterRulesSource.match(/static let currentSchema = (\d+)/u);
assert.ok(schemaMatch, "FilterRules must declare its current native-message schema");
const currentSchema = Number(schemaMatch[1]);
assert.match(handlerSource, /"schemaVersion": rules\.schemaVersion/u);
assert.match(contentSource, /const bootstrapRules/u);
assert.match(contentSource, /let rules = null/u, "bootstrap preflight must not weaken the fail-closed native-rule fallback");
assert.match(contentSource, /const preflight = decision\(location\.href, bootstrapRules\)/u);
assert.match(contentSource, /safeSearchEnabled: true/u);
assert.match(contentSource, /"porn", "porno", "xxx"/u);
assert.match(contentSource, /"keyword", "keywords", "term"/u,
  "site-local search parameter names must be inspected by the Safari companion");
assert.match(contentSource, /event\.composedPath/u,
  "shadow-DOM search controls must be inspected through composed events");
assert.match(contentSource, /addEventListener\("input", guardSearchControl/u,
  "SPA search boxes must be blocked before an in-page results container can reveal explicit results");
assert.match(contentSource, /navigationEvents\.addEventListener\("navigate"/u,
  "Safari 26.2+ must synchronously inspect History API and other programmatic navigations");
assert.match(contentSource, /document\.write\(`<script src=/u,
  "older Safari must load its page-world bridge as a parser-blocking resource");
assert.doesNotMatch(contentSource, /historyEvents\[method\] =/u,
  "the older-Safari guard must not rely on an isolated-world History wrapper");
assert.ok(safariManifest.web_accessible_resources?.some((entry) =>
  entry.resources?.includes("history-bridge.js")), "the page-world bridge must be loadable by web pages");
assert.match(historyBridgeSource, /bubbles: true/u,
  "page-world bridge events must reach the isolated window listeners that inspect them");
assert.match(contentSource, /if \(\(rulesSettled && !blockSurfaceActive\) \|\| typeof Observer !== "function"\) return/u,
  "the whole-subtree guard must stop once an allowed page is revealed");

const stored: Array<Record<string, unknown>> = [];
let storageReads = 0;
const nativeRules = {
  schemaVersion: currentSchema,
  revision: 1,
  blockedHosts: [],
  blockedURLFragments: [],
  blockedSearchTerms: ["porn"],
  safeSearchEnabled: true,
  blockedDomain: "",
  filterUnavailable: false
};
type NavigationListener = (event: Record<string, unknown>) => void;
class TestNavigation {
  constructor(private readonly register: (type: string, listener: NavigationListener) => void = () => {}) {}
  addEventListener(type: string, listener: NavigationListener) { this.register(type, listener); }
}
const documentElement = {
  dataset: { vigilHistoryBridge: "main-v1" },
  style: {
    setProperty() {},
    removeProperty() {}
  },
  replaceChildren() {
    assert.fail("compatible native rules must not fail closed");
  }
};

vm.runInNewContext(contentSource, {
  URL,
  addEventListener() {},
  browser: {
    runtime: {
      async sendNativeMessage(application: string, message: Record<string, unknown>) {
        assert.equal(application, "tech.caseline.vigil.browser");
        assert.equal(message.type, "rules");
        assert.equal(message.hostname, "example.com");
        return nativeRules;
      }
    },
    storage: {
      local: {
        async get() {
          storageReads += 1;
          return {};
        },
        async set(value: Record<string, unknown>) {
          stored.push(value);
        }
      }
    }
  },
  document: {
    documentElement,
    readyState: "complete"
  },
  location: {
    assign() {},
    hostname: "example.com",
    href: "https://example.com/",
    replace() {}
  },
  Navigation: TestNavigation,
  navigation: new TestNavigation(),
  setTimeout() { return 0; }
});
await new Promise<void>((resolve) => setImmediate(resolve));

assert.equal(storageReads, 0, "a compatible native response must not fall back to cached rules");
assert.equal(stored.length, 1, "compatible native rules must become the last-known rules");
assert.equal(
  (stored[0]?.["lastKnownRules:example.com"] as { schemaVersion?: unknown } | undefined)?.schemaVersion,
  currentSchema
);

let preflightRedirect = "";
vm.runInNewContext(contentSource, {
  URL,
  addEventListener() {},
  browser: {
    runtime: {
      async sendNativeMessage() { return nativeRules; }
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {}
      }
    }
  },
  document: {
    documentElement,
    readyState: "complete"
  },
  location: {
    assign() {},
    hostname: "www.google.com.",
    href: "https://www.google.com./search?q=ordinary&Safe=off&safe=active&safe=off",
    replace(value: string) { preflightRedirect = value; }
  },
  Navigation: TestNavigation,
  navigation: new TestNavigation(),
  setTimeout() { return 0; }
});
const preflightSafeSearchEntries = [...new URL(preflightRedirect).searchParams]
  .filter(([name]) => name.toLowerCase() === "safe");
assert.deepEqual(preflightSafeSearchEntries, [["safe", "active"]],
  "Safari must replace case-variant and conflicting SafeSearch values before waiting for native rules");

let settleDelayedRules: ((value: typeof nativeRules) => void) | undefined;
const delayedRules = new Promise<typeof nativeRules>((resolve) => { settleDelayedRules = resolve; });
let pendingLocationCheck: (() => void) | undefined;
let pendingPageDestroyed = false;
let pendingDisplay = "";
let pendingGuardCallback: (() => void) | undefined;
const pendingListeners = new Map<string, () => void>();
class PendingPageObserver {
  constructor(callback: () => void) { pendingGuardCallback = callback; }
  observe() {}
  disconnect() {}
}
const pendingLocation = {
  assign() {},
  hostname: "example.com",
  href: "https://example.com/",
  replace() {}
};
vm.runInNewContext(contentSource, {
  URL,
  MutationObserver: PendingPageObserver,
  addEventListener(type: string, listener: () => void) { void pendingListeners.set(type, listener); },
  removeEventListener() {},
  browser: {
    runtime: {
      getURL() { return "safari-web-extension://vigil/history-bridge.js"; },
      sendNativeMessage() { return delayedRules; }
    },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  document: {
    documentElement: {
      dataset: { vigilHistoryBridge: "main-v1" },
      style: {
        setProperty(name: string, value: string) { if (name === "display") pendingDisplay = value; },
        removeProperty(name: string) { if (name === "display") pendingDisplay = ""; }
      },
      replaceChildren() { pendingPageDestroyed = true; }
    },
    readyState: "loading",
    write() {
      const root = this.documentElement as { dataset: Record<string, string> };
      root.dataset.vigilHistoryBridge = "main-v1";
      const readyListener = pendingListeners.get("vigil-history-bridge-ready");
      readyListener?.();
    }
  },
  location: pendingLocation,
  setInterval(callback: () => void) { pendingLocationCheck = callback; return 1; },
  setTimeout() { return 0; }
});
assert.equal(pendingDisplay, "none",
  "pending native rules must conceal the entire root so visible descendants cannot override it");
pendingDisplay = "";
pendingGuardCallback?.();
assert.equal(pendingDisplay, "none",
  "page-world DOM tampering must not reveal a page before native rules settle");
pendingLocation.href = "https://example.com/canonical";
pendingLocationCheck?.();
assert.equal(pendingPageDestroyed, false,
  "an allowed startup URL change must stay hidden, not be destructively covered while native rules are pending");
settleDelayedRules?.(nativeRules);
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(pendingPageDestroyed, false,
  "settling compatible rules must reveal the canonicalized page without a queued false-block surface");
assert.equal(pendingDisplay, "");

const removedPreflightStyles: string[] = [];
const appendableElement = () => ({
  className: "",
  dataset: {} as Record<string, string>,
  style: { cssText: "" },
  textContent: "",
  append() {},
  addEventListener() {}
});
vm.runInNewContext(contentSource, {
  URL,
  addEventListener() {},
  browser: {
    runtime: {
      async sendNativeMessage() { return nativeRules; }
    },
    storage: {
      local: {
        async get() { return {}; },
        async set() {}
      }
    }
  },
  document: {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: {
        setProperty() {},
        removeProperty(name: string) { removedPreflightStyles.push(name); }
      },
      replaceChildren() {},
      append() {}
    },
    createElement: appendableElement,
    readyState: "complete"
  },
  location: {
    assign() {},
    hostname: "example.com",
    href: "https://example.com/search?Q=porn",
    replace() {}
  },
  setTimeout() { return 0; },
  window: { stop() {} }
});
assert.ok(
  removedPreflightStyles.includes("visibility"),
  "a bootstrap-blocked page must reveal Vigil's explanation instead of retaining the visibility lock"
);

const pageListeners = new Map<string, (event: Record<string, unknown>) => void>();
const navigationListeners = new Map<string, (event: Record<string, unknown>) => void>();
const renderedElements: Array<{
  tag: string;
  textContent: string;
  listeners: Map<string, () => void>;
}> = [];
let extensionEscapeTarget = "";
let extensionReloaded = false;
let extensionHistoryTarget = "";
let trustedRestoreNavigationPrevented = false;
const extensionLocation = {
  assign() {},
  hostname: "www.youtube.com",
  href: "https://www.youtube.com/watch?v=safe-video",
  reload() { extensionReloaded = true; },
  replace(value: string) { extensionEscapeTarget = value; }
};
const extensionDocumentElement = {
  dataset: {} as Record<string, string>,
  style: { setProperty() {}, removeProperty() {} },
  replaceChildren() {},
  append() {}
};
vm.runInNewContext(contentSource, {
  URL,
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    pageListeners.set(type, listener);
  },
  browser: {
    runtime: {
      async sendNativeMessage() {
        return { ...nativeRules, blockedHosts: ["blocked.example"], blockedURLFragments: ["/shorts/"] };
      }
    },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  document: {
    documentElement: extensionDocumentElement,
    createElement(tag: string) {
      const listeners = new Map<string, () => void>();
      const element = {
        tag,
        className: "",
        dataset: {} as Record<string, string>,
        style: { cssText: "" },
        textContent: "",
        type: "",
        listeners,
        append() {},
        addEventListener(type: string, listener: () => void) { listeners.set(type, listener); }
      };
      renderedElements.push(element);
      return element;
    },
    readyState: "complete"
  },
  history: {
    state: { page: "safe" },
    replaceState(_state: unknown, _title: string, value: string) {
      extensionHistoryTarget = value;
      extensionLocation.href = value;
      const listener = navigationListeners.get("navigate");
      listener?.({
        cancelable: true,
        destination: { url: value },
        preventDefault() { trustedRestoreNavigationPrevented = true; }
      });
    }
  },
  location: extensionLocation,
  Navigation: TestNavigation,
  navigation: new TestNavigation((type, listener) => { void navigationListeners.set(type, listener); }),
  setTimeout() { return 0; },
  window: { stop() {} }
});
await new Promise<void>((resolve) => setImmediate(resolve));

const navigationListener = navigationListeners.get("navigate");
assert.ok(navigationListener, "Safari 26.2+ must install its Navigation API guard");
let encodedNavigationPrevented = false;
navigationListener({
  cancelable: true,
  destination: { url: "https://www.youtube.com/%2573horts/blocked-video" },
  preventDefault() { encodedNavigationPrevented = true; }
});
assert.equal(encodedNavigationPrevented, true,
  "Navigation API events must synchronously stop encoded SPA routes before blocked content is shown");

let dottedHostNavigationPrevented = false;
navigationListener({
  cancelable: true,
  destination: { url: "https://blocked.example./path" },
  preventDefault() { dottedHostNavigationPrevented = true; }
});
assert.equal(dottedHostNavigationPrevented, true, "trailing dots must not bypass Safari host rules");

let mixedEscapeNavigationPrevented = false;
navigationListener({
  cancelable: true,
  destination: { url: "https://www.youtube.com/%73horts/blocked-video?junk=%zz" },
  preventDefault() { mixedEscapeNavigationPrevented = true; }
});
assert.equal(mixedEscapeNavigationPrevented, true,
  "a malformed escape elsewhere in the URL must not poison valid blocked-path decoding");

let blockedClickPrevented = false;
const blockedClickListener = pageListeners.get("click");
blockedClickListener?.({
  target: { closest: () => ({ href: "https://www.youtube.com/shorts/blocked-video" }) },
  preventDefault() { blockedClickPrevented = true; },
  stopImmediatePropagation() {}
});
assert.equal(blockedClickPrevented, true, "a blocked Safari navigation must be intercepted before leaving the allowed page");
assert.equal(extensionDocumentElement.dataset.vigilBlockPage, "1", "Safari must render Vigil's branded block surface");
assert.ok(renderedElements.some((element) => element.tag === "style" && element.textContent.includes("radial-gradient")));
assert.ok(renderedElements.some((element) => element.textContent === "Vigil"));

extensionHistoryTarget = "";
extensionReloaded = false;
let allowedNavigationPrevented = false;
navigationListener({
  cancelable: true,
  destination: { url: "https://www.youtube.com/watch?v=router-safe" },
  preventDefault() { allowedNavigationPrevented = true; }
});
assert.equal(allowedNavigationPrevented, true,
  "an allowed SPA transition must be canceled while the synthetic block surface is active");
assert.equal(extensionHistoryTarget, "https://www.youtube.com/watch?v=router-safe");
assert.equal(extensionReloaded, true,
  "an allowed SPA transition from a block surface must reconstruct the original document");
assert.equal(trustedRestoreNavigationPrevented, false,
  "the destination-specific restore allowance must prevent recursive cancellation");

const extensionBackButton = renderedElements.find((element) => element.tag === "button" && element.textContent === "Go back");
assert.ok(extensionBackButton, "the Safari block surface must always provide a Back action");
const extensionBackListener = extensionBackButton.listeners.get("click");
extensionHistoryTarget = "";
extensionReloaded = false;
extensionBackListener?.();
assert.equal(extensionHistoryTarget, "https://www.youtube.com/watch?v=safe-video");
assert.equal(extensionReloaded, true, "same-document escapes must reload the validated page after replacing the synthetic block DOM");
assert.equal(extensionEscapeTarget, "");
assert.doesNotMatch(extensionHistoryTarget, /\/shorts\//u, "Back must never reuse the blocked destination");

assert.match(contentSource, /const blankEscapeURL = "about:blank"/u);
assert.match(contentSource, /if \(!result\.allowed\) return blankEscapeURL/u, "directly blocked pages must escape to a neutral blank page");

const directListeners = new Map<string, (event: Record<string, unknown>) => void>();
const directNavigationListeners = new Map<string, (event: Record<string, unknown>) => void>();
const directElements: Array<{
  tag: string;
  textContent: string;
  listeners: Map<string, () => void>;
}> = [];
let directReplaceTarget = "";
let directNavigationPrevented = false;
let directRenderCount = 0;
let tamperCallback: (() => void) | undefined;
class BlockSurfaceObserver {
  constructor(callback: () => void) { tamperCallback = callback; }
  observe() {}
  disconnect() {}
}
const directLocation = {
  assign() {},
  hostname: "example.com",
  href: "https://example.com/search?Q=porn",
  replace(value: string) {
    directReplaceTarget = value;
    const listener = directNavigationListeners.get("navigate");
    listener?.({
      cancelable: true,
      destination: { url: value },
      preventDefault() { directNavigationPrevented = true; }
    });
  }
};
const makeDirectRoot = () => ({
  tag: "html",
  attributes: [
    { name: "hidden" },
    { name: "inert" },
    { name: "style" }
  ],
  hidden: true,
  inert: true,
  dataset: {} as Record<string, string>,
  style: { setProperty() {}, removeProperty() {} },
  removeAttribute(name: string) {
    this.attributes = this.attributes.filter((attribute) => attribute.name !== name);
  },
  replaceChildren() { directRenderCount += 1; },
  append() {}
});
let directRoot: ReturnType<typeof makeDirectRoot> | null = makeDirectRoot();
const directDocument = {
  get documentElement() { return directRoot; },
  append(value: ReturnType<typeof makeDirectRoot>) { directRoot = value; },
  replaceChildren(value: ReturnType<typeof makeDirectRoot>) { directRoot = value; },
  createElement(tag: string) {
    if (tag === "html") return makeDirectRoot();
    const listeners = new Map<string, () => void>();
    const element = {
      tag,
      className: "",
      dataset: {} as Record<string, string>,
      style: { cssText: "" },
      textContent: "",
      type: "",
      listeners,
      append() {},
      addEventListener(type: string, listener: () => void) { listeners.set(type, listener); }
    };
    directElements.push(element);
    return element;
  },
  readyState: "complete"
};
vm.runInNewContext(contentSource, {
  URL,
  MutationObserver: BlockSurfaceObserver,
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    directListeners.set(type, listener);
  },
  browser: {
    runtime: { async sendNativeMessage() { return nativeRules; } },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  document: directDocument,
  history: { state: null, replaceState() {} },
  location: directLocation,
  Navigation: TestNavigation,
  navigation: new TestNavigation((type, listener) => { void directNavigationListeners.set(type, listener); }),
  setTimeout() { return 0; },
  window: { stop() {} }
});
await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(directRenderCount, 1, "a directly denied page must render the branded block surface");
assert.equal(directRoot?.hidden, false);
assert.equal(directRoot?.inert, false);
directRoot!.hidden = true;
directRoot!.inert = true;
directRoot!.attributes = [{ name: "hidden" }, { name: "inert" }, { name: "style" }];
tamperCallback?.();
assert.equal(directRenderCount, 2,
  "isolated-world guarding must restore the block surface after hostile root attributes change");
assert.equal(directRoot?.hidden, false);
assert.equal(directRoot?.inert, false);
assert.deepEqual(directRoot?.attributes, [], "repair must clear hostile root attributes and inline styles");
directRoot = null;
tamperCallback?.();
assert.equal(directRenderCount, 3,
  "isolated-world guarding must recreate a removed document root and restore the block surface");
assert.ok(directRoot);
const directBackButton = [...directElements].reverse()
  .find((element) => element.tag === "button" && element.textContent === "Go back");
assert.ok(directBackButton);
let buttonClickPrevented = false;
let buttonClickStopped = false;
const directClickListener = directListeners.get("click");
directClickListener?.({
  target: { closest: () => null },
  preventDefault() { buttonClickPrevented = true; },
  stopImmediatePropagation() { buttonClickStopped = true; }
});
assert.equal(buttonClickPrevented, false);
assert.equal(buttonClickStopped, false, "the navigation gate must not swallow Vigil's own Back button");
const directBackListener = directBackButton.listeners.get("click");
directBackListener?.();
assert.equal(directReplaceTarget, "about:blank");
assert.equal(directNavigationPrevented, false,
  "the destination-specific restore allowance must permit Vigil's intentional neutral escape");

const unavailableListeners = new Map<string, (event: Record<string, unknown>) => void>();
const unavailableElements: Array<{
  tag: string;
  textContent: string;
  listeners: Map<string, () => void>;
}> = [];
let unavailableEscapeTarget = "";
vm.runInNewContext(contentSource, {
  URL,
  addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
    unavailableListeners.set(type, listener);
  },
  browser: {
    runtime: { async sendNativeMessage() { return { schemaVersion: currentSchema + 1 }; } },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  document: {
    documentElement: {
      dataset: {} as Record<string, string>,
      style: { setProperty() {}, removeProperty() {} },
      replaceChildren() {},
      append() {}
    },
    createElement(tag: string) {
      const listeners = new Map<string, () => void>();
      const element = {
        tag,
        className: "",
        dataset: {} as Record<string, string>,
        style: { cssText: "" },
        textContent: "",
        type: "",
        listeners,
        append() {},
        addEventListener(type: string, listener: () => void) { listeners.set(type, listener); }
      };
      unavailableElements.push(element);
      return element;
    },
    readyState: "complete"
  },
  location: {
    assign() {},
    hostname: "example.com",
    href: "https://example.com/",
    replace(value: string) { unavailableEscapeTarget = value; }
  },
  setInterval() { return 1; },
  setTimeout() { return 0; },
  window: { stop() {} }
});
await new Promise<void>((resolve) => setImmediate(resolve));
const unavailableBackButton = unavailableElements
  .find((element) => element.tag === "button" && element.textContent === "Go back");
assert.ok(unavailableBackButton, "failed native rules must expose a neutral escape action");
let unavailableClickStopped = false;
const unavailableClickListener = unavailableListeners.get("click");
unavailableClickListener?.({
  target: { closest: () => null },
  preventDefault() {},
  stopImmediatePropagation() { unavailableClickStopped = true; }
});
assert.equal(unavailableClickStopped, false,
  "the fail-closed click gate must still allow Vigil's own neutral escape button");
const unavailableBackListener = unavailableBackButton.listeners.get("click");
unavailableBackListener?.();
assert.equal(unavailableEscapeTarget, "about:blank");

const fallbackElements: Array<{ tag: string; textContent: string }> = [];
let fallbackOriginalPushes = 0;
let fallbackFrameGuard: (() => void) | undefined;
let fallbackBridgeWrites = 0;
const fallbackListeners = new Map<string, Array<(event: BridgeEvent) => void>>();
class BridgeEvent {
  readonly type: string;
  readonly cancelable: boolean;
  readonly detail: unknown;
  defaultPrevented = false;
  target: unknown = null;

  constructor(type: string, options: { cancelable?: boolean; detail?: unknown } = {}) {
    this.type = type;
    this.cancelable = options.cancelable === true;
    this.detail = options.detail;
  }

  preventDefault() { if (this.cancelable) this.defaultPrevented = true; }
}
class BridgeCustomEvent extends BridgeEvent {}
const addFallbackListener = (type: string, listener: (event: BridgeEvent) => void) => {
  const listeners = fallbackListeners.get(type) || [];
  listeners.push(listener);
  void fallbackListeners.set(type, listeners);
};
const fallbackLocation = {
  assign() {},
  hostname: "www.youtube.com",
  href: "https://www.youtube.com/watch?v=safe",
  replace() {}
};
let fallbackBaseURL = "https://www.youtube.com/router/";
class MainWorldNode {
  get baseURI() { return fallbackBaseURL; }
}
class MainWorldURL {
  private readonly value: URL;
  constructor(input: string, base: string) { this.value = new URL(input, base); }
  get href() { return this.value.href; }
}
class MainWorldHistory {
  state: unknown = null;
  pushState(_state: unknown, _title: string, value: string) {
    fallbackOriginalPushes += 1;
    fallbackLocation.href = new URL(value, fallbackLocation.href).href;
  }
  replaceState(_state: unknown, _title: string, value: string) {
    fallbackLocation.href = new URL(value, fallbackLocation.href).href;
  }
}
const mainWorldHistory = new MainWorldHistory();
const fallbackDocumentElement = {
  dataset: { vigilHistoryBridge: "main-v1" } as Record<string, string>,
  style: { setProperty() {}, removeProperty() {} },
  replaceChildren() {},
  append() {}
};
let mainBridgeContext: ReturnType<typeof vm.createContext>;
const fallbackDocument = {
  documentElement: fallbackDocumentElement,
  dispatchEvent(event: BridgeEvent) {
    event.target = fallbackDocument;
    for (const listener of fallbackListeners.get(event.type) || []) listener(event);
    return !event.defaultPrevented;
  },
  createElement(tag: string) {
    const element = {
      tag,
      className: "",
      dataset: {} as Record<string, string>,
      style: { cssText: "" },
      textContent: "",
      type: "",
      append() {},
      addEventListener() {}
    };
    fallbackElements.push(element);
    return element;
  },
  readyState: "loading",
  write(value: string) {
    fallbackBridgeWrites += 1;
    assert.match(value, /safari-web-extension:\/\/vigil\/history-bridge\.js/u);
    vm.runInContext(historyBridgeSource, mainBridgeContext);
  }
};
Object.setPrototypeOf(fallbackDocument, MainWorldNode.prototype);
mainBridgeContext = vm.createContext({
  URL: MainWorldURL,
  CustomEvent: BridgeCustomEvent,
  Event: BridgeEvent,
  History: MainWorldHistory,
  Node: MainWorldNode,
  document: fallbackDocument,
  history: mainWorldHistory,
  location: fallbackLocation
});

const isolatedHistory = {
  state: null,
  pushState() { assert.fail("the test must invoke the distinct page-world History object"); },
  replaceState() {}
};
vm.runInNewContext(contentSource, {
  URL,
  addEventListener(type: string, listener: (event: BridgeEvent) => void) {
    addFallbackListener(type, listener);
  },
  browser: {
    runtime: {
      getURL() { return "safari-web-extension://vigil/history-bridge.js"; },
      async sendNativeMessage() {
        return { ...nativeRules, blockedURLFragments: ["/shorts/"] };
      }
    },
    storage: { local: { async get() { return {}; }, async set() {} } }
  },
  document: fallbackDocument,
  history: isolatedHistory,
  location: fallbackLocation,
  navigation: { addEventListener() { assert.fail("named DOM access is not the native Navigation API"); } },
  requestAnimationFrame(callback: () => void) { fallbackFrameGuard = callback; return 1; },
  setInterval() { return 1; },
  setTimeout() { return 0; },
  window: { stop() {} }
});
assert.equal(fallbackDocumentElement.dataset.vigilHistoryBridge, "main-v1",
  "the parser-blocking resource must install in the page world before content is revealed");
assert.equal(fallbackBridgeWrites, 1,
  "a hostile preexisting readiness attribute must not bypass page-world bridge installation");
await new Promise<void>((resolve) => setImmediate(resolve));
let destinationCoercions = 0;
mainWorldHistory.pushState({}, "", {
  toString() {
    destinationCoercions += 1;
    return destinationCoercions === 1 ? "canonical-safe" : "/%73horts/coercion-bypass";
  }
} as unknown as string);
assert.equal(destinationCoercions, 1,
  "the bridge must pass the exact inspected URL to History instead of coercing attacker input twice");
assert.equal(fallbackOriginalPushes, 1);
assert.equal(fallbackLocation.href, "https://www.youtube.com/router/canonical-safe",
  "History routes must resolve against the document base URL");
mainWorldHistory.pushState({}, "", "");
assert.equal(fallbackOriginalPushes, 2);
assert.equal(fallbackLocation.href, "https://www.youtube.com/router/canonical-safe",
  "History's empty-URL special case must preserve the current document URL");
vm.runInContext(`
  const InstalledURL = globalThis.URL;
  globalThis.URL = function TamperedURL() { throw new Error("tampered URL"); };
  globalThis.CustomEvent = function TamperedCustomEvent() { throw new Error("tampered CustomEvent"); };
  globalThis.Reflect = { apply() { throw new Error("tampered Reflect.apply"); } };
  let hrefCoercions = 0;
  Object.defineProperty(InstalledURL.prototype, "href", {
    configurable: true,
    get() {
      return {
        toString() {
          hrefCoercions += 1;
          return hrefCoercions === 1
            ? "https://www.youtube.com/watch?v=forged-safe"
            : "https://www.youtube.com/%73horts/getter-bypass";
        }
      };
    }
  });
  Object.defineProperty(Node.prototype, "baseURI", {
    configurable: true,
    get() { throw new Error("tampered baseURI"); }
  });
`, mainBridgeContext);
fallbackBaseURL = "https://www.youtube.com/changed-base/";
mainWorldHistory.pushState({}, "", "../%73horts/blocked-video");
assert.equal(fallbackOriginalPushes, 2,
  "pre-Navigation-API Safari must synchronously reject page-world History API routes");
assert.equal(fallbackDocumentElement.dataset.vigilBlockPage, "1");
assert.ok(fallbackElements.some((element) => element.textContent === "Vigil"));
assert.ok(fallbackFrameGuard,
  "older Safari must also verify location changes at the pre-paint frame boundary");
