import assert from "node:assert/strict";
import { BROWSER_FILTER_REVISION, browserFilterHealthSummary, browserPageNeedsProtection, browserProtectionDiagnostic, observeBrowserProtectionForeground, recordBrowserFilterHealth, recordBrowserNavigationProof, resetBrowserProtectionHealthForTest } from "../src/browserProtection.js";
import { defaultState, BUILT_IN_CHROME_EXTENSION_ID } from "../src/defaults.js";
import { policyForSample } from "../src/monitor/policy.js";
import { startVigilRuntime } from "../src/server.js";

const target = "https://example.org/slow-response";
const documentUrl = "https://example.org/previous";
const proof = (sequence: number, now: number, fields: Record<string, unknown> = {}) => ({
  action: "browser-navigation", phase: "pending", revision: BROWSER_FILTER_REVISION,
  epoch: 1000, sequence, observedAt: now, url: target, documentUrl,
  tabId: 7, windowId: 3, ...fields
});
function start() {
  resetBrowserProtectionHealthForTest();
  observeBrowserProtectionForeground("Safari", 10000);
  assert.equal(browserPageNeedsProtection("Safari", target, 10000), false);
}

start();
for (let now = 11000, sequence = 1; now <= 25000; now += 2000, sequence += 1) {
  recordBrowserFilterHealth("Safari", documentUrl, BROWSER_FILTER_REVISION, now);
  assert.equal(recordBrowserNavigationProof("Safari", proof(sequence, now), now), true);
  assert.equal(browserPageNeedsProtection("Safari", target, now + 1500), false, "a slow request is not an unprotected rendered document");
}
assert.equal(browserFilterHealthSummary(26500)[0].url, documentUrl, "navigation never fabricates destination content health");
assert.equal(browserProtectionDiagnostic("Safari", target, 26500).recoveryElapsedMs, 1000, "renewals retain the already-spent second");
assert.equal(recordBrowserNavigationProof("Safari", proof(9, 27000, { phase: "clear" }), 27000), true);
assert.equal(browserPageNeedsProtection("Safari", target, 31999), false);
assert.equal(browserPageNeedsProtection("Safari", target, 32000), true, "commit/error resumes only the unspent recovery time");
assert.equal(recordBrowserNavigationProof("Safari", proof(8, 27000), 27001), false, "late pending cannot undo a commit clear");
assert.equal(browserPageNeedsProtection("Safari", target, 32001), true);
recordBrowserFilterHealth("Safari", target, BROWSER_FILTER_REVISION, 32002);
assert.equal(browserPageNeedsProtection("Safari", target, 32003), false, "only the new document's scan restores content health");

start();
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, { documentUrl: "about:blank" }), 11000), true);
assert.equal(browserPageNeedsProtection("Safari", target, 18999), false);
assert.equal(browserPageNeedsProtection("Safari", target, 19000), true, "a lost extension or clear event expires the short proof and fails closed");
assert.equal(browserFilterHealthSummary(19000)[0].fresh, false, "blank navigation evidence is never a health report");

start();
for (let now = 11000, sequence = 1; now <= 23000; now += 2000, sequence += 1) {
  assert.equal(recordBrowserNavigationProof("Safari", proof(sequence, now, { documentUrl: "favorites://" }), now), true);
  assert.equal(browserPageNeedsProtection("Safari", target, now + 1500), false, "verified native Safari Start Page remains safe throughout a slow Google request");
}
assert.equal(browserFilterHealthSummary(24500)[0].url, null, "native Start Page proof cannot impersonate destination filter health");
assert.equal(browserProtectionDiagnostic("Safari", target, 24500).recoveryElapsedMs, 1000);
assert.equal(recordBrowserNavigationProof("Safari", proof(8, 25000, { phase: "clear" }), 25000), true);
assert.equal(browserPageNeedsProtection("Safari", target, 29999), false);
assert.equal(browserPageNeedsProtection("Safari", target, 30000), true, "Start Page proof preserves the original spent budget across commit");
assert.equal(recordBrowserNavigationProof("Google Chrome", proof(1, 30000, { documentUrl: "favorites://" }), 30000), false, "Safari's native Start Page sentinel has no meaning in Chrome");

start();
const sensitiveDocument = "https://example.org/private-document?token=private-source";
const sensitiveTarget = target + "?token=private-target";
recordBrowserFilterHealth("Safari", sensitiveDocument, BROWSER_FILTER_REVISION, 11000);
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, { url: sensitiveTarget, documentUrl: sensitiveDocument }), 11000), true);
const safeDiagnostic = browserProtectionDiagnostic("Safari", sensitiveTarget, 12000);
assert.equal(safeDiagnostic.navigation.sourceKind, "web-document");
assert.equal(safeDiagnostic.navigation.sourceHost, "example.org");
assert.equal(safeDiagnostic.navigation.targetMatches, true);
assert.equal(safeDiagnostic.navigation.remainingMs, 2000);
assert.doesNotMatch(JSON.stringify(safeDiagnostic), /private-document|private-source|private-target|token|https:/, "persisted proof diagnostics expose no URL paths, queries or document identifiers");

for (const fields of [
  { documentUrl: "" }, { documentUrl: target }, { documentUrl: "file:///tmp/page" },
  { documentUrl: "safari://new-tab" }, { documentUrl: documentUrl }, { tabId: -1 },
  { windowId: undefined }, { revision: "obsolete" }, { observedAt: 11001 },
  { observedAt: 8000 }, { epoch: 12000 }, { sequence: 0 }, { phase: "loading" }
]) {
  start();
  assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, fields), 11000), false, `invalid or unscanned proof rejected: ${JSON.stringify(fields)}`);
  assert.equal(browserPageNeedsProtection("Safari", target, 16000), true, "rejected evidence cannot delay failure");
}

start();
recordBrowserFilterHealth("Google Chrome", documentUrl, BROWSER_FILTER_REVISION, 11000);
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000), 11000), false, "another browser cannot attest the old Safari document");
recordBrowserFilterHealth("Safari", documentUrl, BROWSER_FILTER_REVISION, 11000);
assert.equal(recordBrowserNavigationProof("Safari", proof(2, 18000), 18000), true);
assert.equal(browserPageNeedsProtection("Safari", target, 18500), false);
assert.equal(browserPageNeedsProtection("Safari", target, 19000), true, "pending proof cannot outlive the old document's independent health");

start();
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, { documentUrl: "about:blank" }), 11000), true);
assert.equal(browserPageNeedsProtection("Safari", "https://example.org/another", 19000), true, "one tab's pending destination cannot cover another target");
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 20000, { phase: "clear", epoch: 2000 }), 20000), true);
assert.equal(recordBrowserNavigationProof("Safari", proof(100, 20001, { documentUrl: "about:blank" }), 20001), false, "an old background session cannot restore a newer session's cleared proof");

start();
const denied = "https://www.google.com/search?q=porn";
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, { url: denied, documentUrl: "about:blank" }), 11000), true);
const state = defaultState();
state.settings.protectedBrowsersOnly = true;
const deniedPolicy = policyForSample(state, {}, { app: "Safari", url: denied, hostname: "www.google.com" }, new Date(11001));
assert.ok(deniedPolicy, "provisional navigation still evaluates actual URL/content restrictions immediately");
assert.notEqual(deniedPolicy.browserControl?.area, "browser-protection");

start();
recordBrowserFilterHealth("Safari", denied, BROWSER_FILTER_REVISION, 11000);
assert.equal(recordBrowserNavigationProof("Safari", proof(1, 11000, { documentUrl: denied }), 11000), true);
const deniedDocumentPolicy = policyForSample(state, {}, { app: "Safari", url: target, hostname: "example.org" }, new Date(11001));
assert.equal(deniedDocumentPolicy, null, "Safari provisional health evidence cannot manufacture a block for an allowed actual target");
recordBrowserFilterHealth("Google Chrome", denied, BROWSER_FILTER_REVISION, 11000);
assert.equal(recordBrowserNavigationProof("Google Chrome", proof(1, 11000, { documentUrl: denied }), 11000), true);
const chromeDocumentPolicy = policyForSample(state, {}, { app: "Google Chrome", url: target, hostname: "example.org" }, new Date(11001));
assert.equal(chromeDocumentPolicy?.browserControl?.area, "navigation-document", "Chrome's existing provisional-document enforcement remains active");

resetBrowserProtectionHealthForTest();
const runtime = await startVigilRuntime({ systemEffects: "isolated" });
try {
  const report = (origin: string, fields: Record<string, unknown> = {}) => {
    const now = Date.now();
    return runtime.request({ method: "POST", path: "/api/extension/browser-health",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(proof(1, now, { documentUrl: "about:blank", ...fields })) });
  };
  assert.equal((await report("https://example.org")).status, 403, "ordinary pages cannot issue navigation evidence");
  assert.equal((await report(`chrome-extension://${BUILT_IN_CHROME_EXTENSION_ID}`)).status, 200);
  assert.equal((await report(`chrome-extension://${BUILT_IN_CHROME_EXTENSION_ID}`, { revision: "obsolete", sequence: 2 })).status, 400);
} finally {
  await runtime.stop();
  resetBrowserProtectionHealthForTest();
}
console.log("Authenticated provisional navigation, expiry, ordering, accumulated recovery and actual restriction tests passed.");
