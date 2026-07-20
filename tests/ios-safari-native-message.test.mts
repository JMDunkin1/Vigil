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
assert.match(contentSource, /const bootstrapRules/u);
assert.match(contentSource, /let rules = null/u, "bootstrap preflight must not weaken the fail-closed native-rule fallback");
assert.match(contentSource, /const preflight = decision\(location\.href, bootstrapRules\)/u);
assert.match(contentSource, /safeSearchEnabled: true/u);
assert.match(contentSource, /"porn", "porno", "xxx"/u);

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
    hostname: "www.google.com",
    href: "https://www.google.com/search?q=ordinary&safe=off",
    replace(value: string) { preflightRedirect = value; }
  },
  setTimeout() { return 0; }
});
assert.equal(new URL(preflightRedirect).searchParams.get("safe"), "active", "Safari must enforce SafeSearch before waiting for native rules");

const removedPreflightStyles: string[] = [];
const appendableElement = () => ({
  style: { cssText: "" },
  textContent: "",
  append() {}
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
    href: "https://example.com/search?q=porn",
    replace() {}
  },
  setTimeout() { return 0; },
  window: { stop() {} }
});
assert.ok(
  removedPreflightStyles.includes("visibility"),
  "a bootstrap-blocked page must reveal Vigil's explanation instead of retaining the visibility lock"
);
