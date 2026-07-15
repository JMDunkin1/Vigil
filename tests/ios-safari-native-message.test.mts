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
const [contentSource, filterRulesSource, handlerSource] = await Promise.all([
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), "utf8"),
  readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/SafariWebExtensionHandler.swift"), "utf8")
]);
const schemaMatch = filterRulesSource.match(/static let currentSchema = (\d+)/u);
assert.ok(schemaMatch, "FilterRules must declare its current native-message schema");
const currentSchema = Number(schemaMatch[1]);
assert.match(handlerSource, /"schemaVersion": rules\.schemaVersion/u);

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
const documentElement = {
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
  setTimeout() { return 0; }
});
await new Promise<void>((resolve) => setImmediate(resolve));

assert.equal(storageReads, 0, "a compatible native response must not fall back to cached rules");
assert.equal(stored.length, 1, "compatible native rules must become the last-known rules");
assert.equal(
  (stored[0]?.["lastKnownRules:example.com"] as { schemaVersion?: unknown } | undefined)?.schemaVersion,
  currentSchema
);
