import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";

const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
const start = source.indexOf("function invalidateVigilConnection(");
const end = source.indexOf("\nfunction vigilUrl(", start);
assert.ok(start >= 0 && end > start);
type Connection = { localServer: string; extensionToken: string };
type Stored = { vigilLocalServer: string; vigilExtensionToken: string };
const defaults: Stored = { vigilLocalServer: "http://127.0.0.1:8787", vigilExtensionToken: "" };
const reads: Array<(values: Stored) => void> = [];
const writes: unknown[] = [];
let throwNextRead = false;
const runtime: { lastError?: { message: string } } = {};
const context = createContext({
  CONNECTION_DEFAULTS: defaults,
  vigilConnection: { localServer: defaults.vigilLocalServer, extensionToken: "" },
  vigilConnectionRevision: 0,
  vigilConnectionReady: null,
  chrome: { runtime, storage: { local: { get(_defaults: unknown, callback: (values: Stored) => void) {
    if (throwNextRead) {
      throwNextRead = false;
      throw new Error("Storage temporarily unavailable");
    }
    reads.push(callback);
  } } } },
  normalizeLocalServer: (value: string) => value.replace(/\/$/, ""),
  storageSet: async (value: unknown) => { writes.push(value); return true; }
});
runInContext(source.slice(start, end), context);
const load = () => runInContext("loadVigilConnection()", context) as Promise<Connection>;
const invalidate = () => runInContext("invalidateVigilConnection()", context);
const reply = (values: Stored, error = false) => {
  const callback = reads.shift();
  assert.ok(callback, "expected a pending Chrome storage read");
  runtime.lastError = error ? { message: "Storage unavailable" } : undefined;
  callback(values);
  runtime.lastError = undefined;
};
const first = load();
const concurrent = Array.from({ length: 20 }, load);
assert.equal(reads.length, 1, "concurrent checks must share one connection storage read");
reply({ ...defaults, vigilExtensionToken: " token-one " });
assert.equal((await first).extensionToken, "token-one");
await Promise.all(concurrent);
for (let index = 0; index < 100; index += 1) assert.equal((await load()).extensionToken, "token-one");
assert.equal(reads.length, 0, "steady-state requests must not reread unchanged connection storage");
assert.equal(writes.length, 0, "normalized settings must not cause storage writes");

invalidate();
const oldRead = load();
invalidate();
const freshRead = load();
reply({ ...defaults, vigilExtensionToken: "stale" });
reply({ ...defaults, vigilExtensionToken: "fresh" });
assert.equal((await freshRead).extensionToken, "fresh");
assert.equal((await oldRead).extensionToken, "fresh", "a settings change must supersede an older pending storage read");
assert.equal((context.vigilConnection as Connection).extensionToken, "fresh");

invalidate();
const failed = load();
reply(defaults, true);
assert.equal((await failed).extensionToken, "fresh", "transient read failures must retain the last verified settings");
const retry = load();
assert.equal(reads.length, 1, "storage failures must remain retryable, not become a permanent cached default");
reply({ ...defaults, vigilExtensionToken: "recovered" });
assert.equal((await retry).extensionToken, "recovered");

invalidate();
throwNextRead = true;
assert.equal((await load()).extensionToken, "recovered");
const afterThrow = load();
assert.equal(reads.length, 1, "a synchronous API failure must not cache a permanently rejected promise");
reply({ ...defaults, vigilExtensionToken: "after-throw" });
assert.equal((await afterThrow).extensionToken, "after-throw");

invalidate();
const normalized = load();
reply({ ...defaults, vigilLocalServer: `${defaults.vigilLocalServer}/`, vigilExtensionToken: "normalized" });
assert.equal((await normalized).localServer, defaults.vigilLocalServer);
assert.equal(writes.length, 1);
console.log("Extension connection cache tests passed");
