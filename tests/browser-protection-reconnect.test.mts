import assert from "node:assert/strict";
import { defaultState, BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { BROWSER_FILTER_REVISION, browserPageNeedsProtection, recordBrowserFilterHealth, resetBrowserProtectionHealthForTest } from "../src/browserProtection.js";
import { Monitor } from "../src/monitor.js";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import { startVigilRuntime } from "../src/server.js";

const url = "https://example.org/article";
resetBrowserProtectionHealthForTest();
assert.equal(browserPageNeedsProtection("Safari", url, 10000), false);
assert.equal(browserPageNeedsProtection("Safari", url, 11500), false, "the next heartbeat must not race the recovery deadline");
assert.equal(browserPageNeedsProtection("Safari", url, 15999), false);
assert.equal(browserPageNeedsProtection("Safari", "https://other.example/", 16000), true, "navigation cannot renew recovery");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, 16001);
assert.equal(browserPageNeedsProtection("Safari", "https://other.example/", 16002), true, "a delayed report for another page cannot reset the deadline");
assert.equal(browserPageNeedsProtection("Safari", url, 16003), false);
assert.equal(browserPageNeedsProtection("Safari", url, 24001), false);
assert.equal(browserPageNeedsProtection("Safari", url, 30001), true, "a disabled extension still fails closed after bounded recovery");

resetBrowserProtectionHealthForTest();
let now = 10000;
const state = defaultState();
state.settings.protectedBrowsersOnly = true;
const monitor = new Monitor({ state, usage: {}, browserActivityNow: () => now, externalEffectsEnabled: false });
const front = { app: "Safari", hostname: "example.org", url };
assert.equal(monitor.browserBlockDecision(front), null);
now = 11501;
assert.equal(monitor.browserBlockDecision(front), null, "transport delay does not replace the page");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, 15000);
now = 15001;
assert.equal(monitor.browserBlockDecision(front), null, "successful reconnection keeps the existing page");
now = 23000;
assert.equal(monitor.browserBlockDecision(front), null);
now = 29000;
const decision = monitor.browserBlockDecision(front)!;
assert.equal(decision.policy.browserControl?.area, "browser-protection");
assert.equal(new URL(monitor.blockedPageTarget(decision.front, decision.policy, decision.options)).searchParams.get("kind"), "browser-protection");
resetBrowserProtectionHealthForTest();
assert.ok(monitor.browserBlockDecision({ ...front, url: "https://www.google.com/search?q=porn" }), "actual denied content remains blocked immediately during recovery");
const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = basename(runtimeRoot) === "runtime" ? dirname(dirname(runtimeRoot)) : runtimeRoot;
const monitorSource = await readFile(join(projectRoot, "src/monitor.ts"), "utf8");
assert.doesNotMatch(monitorSource, /refreshActiveBrowserTab|refreshBrowserProtection|browserRefresh/, "health recovery must never reload user documents");

const runtime = await startVigilRuntime({ systemEffects: "isolated" });
const originalRun = RuntimeMutationCoordinator.prototype.run;
let admittedRequests = 0;
RuntimeMutationCoordinator.prototype.run = (function(this: RuntimeMutationCoordinator, operation: Parameters<typeof originalRun>[0], options: Parameters<typeof originalRun>[1]) {
  if (options?.admission) {
    admittedRequests += 1;
    throw new Error("routine state mutation queue unavailable during update");
  }
  return originalRun.call(this, operation, options);
}) as typeof originalRun;
try {
  const report = (origin: string, revision: string) => runtime.request({
    method: "POST", path: "/api/extension/browser-health",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ url, revision })
  });
  assert.equal((await report(`chrome-extension://${BUILT_IN_CHROME_EXTENSION_ID}`, BROWSER_FILTER_REVISION)).status, 200);
  assert.equal(admittedRequests, 0, "health attestation bypasses routine state work");
  assert.equal((await report("https://example.org", BROWSER_FILTER_REVISION)).status, 403, "web pages cannot attest themselves");
  assert.equal((await report(`chrome-extension://${BUILT_IN_CHROME_EXTENSION_ID}`, "obsolete")).status, 400, "old filter code remains untrusted");
} finally {
  RuntimeMutationCoordinator.prototype.run = originalRun;
  await runtime.stop();
  resetBrowserProtectionHealthForTest();
}
