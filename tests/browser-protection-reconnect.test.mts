import assert from "node:assert/strict";
import { defaultState, BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { BROWSER_FILTER_REVISION, browserPageNeedsProtection, recordBrowserFilterHealth, resetBrowserProtectionHealthForTest, takeBrowserProtectionRefresh } from "../src/browserProtection.js";
import { Monitor } from "../src/monitor.js";
import { browserRefreshScript } from "../src/macos.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import { startVigilRuntime } from "../src/server.js";

const url = "https://example.org/article";
resetBrowserProtectionHealthForTest();
assert.equal(browserPageNeedsProtection("Safari", url, 10000), false);
assert.equal(takeBrowserProtectionRefresh("Safari", url, 10000), true);
assert.equal(takeBrowserProtectionRefresh("Safari", url, 10001), false, "one refresh only");
assert.equal(browserPageNeedsProtection("Safari", url, 11500), true, "repair never extends the deadline");
assert.equal(takeBrowserProtectionRefresh("Safari", "https://other.example/", 11501), false, "navigation cannot renew repair");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, 12000);
assert.equal(browserPageNeedsProtection("Safari", url, 12001), false);
assert.equal(takeBrowserProtectionRefresh("Safari", url, 12001), false, "a healthy tab stays untouched");
assert.equal(browserPageNeedsProtection("Safari", "https://other.example/", 12100), false);
assert.equal(takeBrowserProtectionRefresh("Safari", "https://other.example/", 12101), false, "ordinary navigation is not reloaded");
resetBrowserProtectionHealthForTest();
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, 10000);
assert.equal(browserPageNeedsProtection("Safari", url, 18000), false);
assert.equal(takeBrowserProtectionRefresh("Safari", url, 18000), true, "a lost companion connection gets one repair");
assert.equal(browserPageNeedsProtection("Safari", url, 19500), true);
resetBrowserProtectionHealthForTest();
assert.equal(browserPageNeedsProtection("Safari", "http://127.0.0.1:8787/blocked", 10000), false);
assert.equal(takeBrowserProtectionRefresh("Safari", "http://127.0.0.1:8787/blocked", 10000), false, "do not refresh blocker pages in a loop");

resetBrowserProtectionHealthForTest();
let now = 10000;
const refreshed: string[] = [];
const state = defaultState();
state.settings.protectedBrowsersOnly = true;
const monitor = new Monitor({ state, usage: {}, browserActivityNow: () => now,
  browserRefresh: async (_app, target) => { refreshed.push(target); return { ok: true, matched: true }; }
});
const front = { app: "Safari", hostname: "example.org", url };
await monitor.refreshBrowserProtection(front);
await monitor.refreshBrowserProtection(front);
assert.deepEqual(refreshed, [url]);
now = 11501;
assert.equal(monitor.browserBlockDecision(front)?.policy.browserControl?.area, "browser-protection", "disabled protection still blocks after the same window");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, now);
assert.equal(monitor.browserBlockDecision(front), null, "successful reconnection keeps the existing page");
resetBrowserProtectionHealthForTest();
await monitor.refreshBrowserProtection({ ...front, url: "https://www.google.com/search?q=porn" });
assert.equal(refreshed.length, 1, "a genuinely denied URL must never be reloaded as recovery");
for (const app of ["Safari", "Google Chrome"]) {
  const script = browserRefreshScript(app, url);
  assert.ok(script.includes(`if URL of observedTab is not "${url}" then return "refresh:0"`));
  assert.ok(script.includes(`set URL of observedTab to "${url}"`));
  assert.doesNotMatch(script, /activate|keystroke|delay /u);
}

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
