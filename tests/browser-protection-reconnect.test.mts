import assert from "node:assert/strict";
import { defaultState, BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { BROWSER_FILTER_REVISION, browserPageNeedsProtection, observeBrowserProtectionForeground, recordBrowserFilterHealth, resetBrowserProtectionHealthForTest, setBrowserProtectionSuspended } from "../src/browserProtection.js";
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
observeBrowserProtectionForeground("Safari", 10000);
assert.equal(browserPageNeedsProtection("Safari", url, 10000), false);
observeBrowserProtectionForeground("Codex", 11000);
// A suspended browser must get its remaining five seconds after returning,
// even if a whole night elapsed while another app was in front.
const nextDay = 86410000;
observeBrowserProtectionForeground("Safari", nextDay);
assert.equal(browserPageNeedsProtection("Safari", url, nextDay), false, "time in another app cannot exhaust reconnection");
assert.equal(browserPageNeedsProtection("Safari", url, nextDay + 4999), false);
assert.equal(browserPageNeedsProtection("Safari", "https://other.example/", nextDay + 5000), true, "returning and navigating preserve the cumulative six-second limit");
observeBrowserProtectionForeground("Codex", nextDay + 5001);
observeBrowserProtectionForeground("Safari", nextDay * 2);
assert.equal(browserPageNeedsProtection("Safari", url, nextDay * 2), true, "app switching cannot revive an exhausted budget");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, nextDay * 2 + 1);
assert.equal(browserPageNeedsProtection("Safari", url, nextDay * 2 + 2), false, "only a verified matching report recovers an exhausted page");

resetBrowserProtectionHealthForTest();
observeBrowserProtectionForeground("Safari", 10000);
browserPageNeedsProtection("Safari", url, 10000);
// Repeated short switches cannot stretch six seconds of unprotected browsing
// into an unlimited allowance. Chrome has its own independent budget.
for (let index = 0; index < 6; index += 1) {
  const start = 10000 + index * 11000;
  observeBrowserProtectionForeground("Safari", start);
  assert.equal(browserPageNeedsProtection("Safari", url, start + 999), false);
  observeBrowserProtectionForeground("Google Chrome", start + 1000);
  browserPageNeedsProtection("Google Chrome", url, start + 1000);
}
observeBrowserProtectionForeground("Safari", 76000);
assert.equal(browserPageNeedsProtection("Safari", url, 76000), true, "six one-second visits exhaust the same budget");
observeBrowserProtectionForeground("Codex", 76001);
observeBrowserProtectionForeground("Safari", 9000);
assert.equal(browserPageNeedsProtection("Safari", url, 9000), true, "clock rollback remains fail closed");

resetBrowserProtectionHealthForTest();
observeBrowserProtectionForeground("Safari", 10000);
browserPageNeedsProtection("Safari", url, 10000);
setBrowserProtectionSuspended("screen-lock", true, 11000);
setBrowserProtectionSuspended("system-suspend", true, 12000);
// Native foreground observations still run on the lock screen. They cannot
// count locked time or clear the independent suspend/lock reasons.
observeBrowserProtectionForeground("Safari", 20000);
setBrowserProtectionSuspended("system-suspend", false, 86410000);
observeBrowserProtectionForeground("Safari", 86420000);
assert.equal(browserPageNeedsProtection("Safari", url, 86420000), false, "resume before unlock preserves the remaining recovery budget");
setBrowserProtectionSuspended("screen-lock", false, 86430000);
assert.equal(browserPageNeedsProtection("Safari", url, 86434999), false);
assert.equal(browserPageNeedsProtection("Safari", url, 86435000), true, "unlock restores only the unspent five seconds");
setBrowserProtectionSuspended("system-suspend", true, 86435001);
setBrowserProtectionSuspended("system-suspend", false, 172870000);
assert.equal(browserPageNeedsProtection("Safari", url, 172870000), true, "another sleep cannot revive an exhausted budget");
recordBrowserFilterHealth("Safari", url, BROWSER_FILTER_REVISION, 172870001);
assert.equal(browserPageNeedsProtection("Safari", url, 172870002), false, "a verified report still restores protection after wake");

resetBrowserProtectionHealthForTest();
setBrowserProtectionSuspended("screen-lock", true, 10000);
observeBrowserProtectionForeground("Safari", 11000);
browserPageNeedsProtection("Safari", url, 11000);
observeBrowserProtectionForeground("Safari", 21000);
assert.equal(browserPageNeedsProtection("Safari", url, 21000), false, "new recovery started while locked has no foreground time");
setBrowserProtectionSuspended("screen-lock", false, 22000);
assert.equal(browserPageNeedsProtection("Safari", url, 27999), false);
assert.equal(browserPageNeedsProtection("Safari", url, 28000), true);

resetBrowserProtectionHealthForTest();
observeBrowserProtectionForeground("Safari", 10000);
browserPageNeedsProtection("Safari", url, 10000);
setBrowserProtectionSuspended("system-suspend", true, 11000);
setBrowserProtectionSuspended("system-suspend", true, 12000);
setBrowserProtectionSuspended("screen-lock", true, 13000);
setBrowserProtectionSuspended("screen-lock", false, 20000);
assert.equal(browserPageNeedsProtection("Safari", url, 30000), false, "unlock cannot resume a still-suspended Mac");
setBrowserProtectionSuspended("system-suspend", false, 31000);
assert.equal(browserPageNeedsProtection("Safari", url, 35999), false);
assert.equal(browserPageNeedsProtection("Safari", url, 36000), true, "duplicate events cannot discard the spent second");

resetBrowserProtectionHealthForTest();
observeBrowserProtectionForeground("Safari", 10000);
browserPageNeedsProtection("Safari", url, 10000);
observeBrowserProtectionForeground("", 11000); // Actual Safari Start Page/non-web foreground.
observeBrowserProtectionForeground("Safari", 86410000);
assert.equal(browserPageNeedsProtection("Safari", url, 86414999), false);
assert.equal(browserPageNeedsProtection("Safari", url, 86415000), true, "non-web pages pause without replenishing the budget");

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
assert.equal(monitor.browserBlockDecision(front), null, "Safari heartbeat expiry is diagnostic and cannot replace the page");
const chromeFront = { ...front, app: "Google Chrome" };
assert.equal(monitor.browserBlockDecision(chromeFront), null);
now = 35000;
const decision = monitor.browserBlockDecision(chromeFront)!;
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
