import assert from "node:assert/strict";
import { BROWSER_FILTER_REVISION, browserPageNeedsProtection, browserProtectionDiagnostic, browserFilterHealthSummary, recordBrowserFilterHealth, resetBrowserProtectionHealthForTest } from "../src/browserProtection.js";
import { policyForSample } from "../src/monitor/policy.js";
import { blockedPage } from "../src/server/pages.js";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { RuntimeMutationCoordinator } from "../src/server/mutationCoordinator.js";
import { compactStateEvents } from "../src/store.js";

const page = "https://example.org/form-complete";
async function queuedRedirect(url: string, recoverDuringCommit: boolean, app: "Safari" | "Google Chrome" = "Safari"): Promise<number> {
  resetBrowserProtectionHealthForTest();
  const now = Date.now();
  browserPageNeedsProtection(app, url, now - 7000);
  assert.equal(browserPageNeedsProtection(app, url, now), true);
  const state = defaultState();
  state.settings.protectedBrowsersOnly = true;
  let calls = 0;
  const coordinator = new RuntimeMutationCoordinator(state, {}, [], async () => {
    if (recoverDuringCommit) recordBrowserFilterHealth(app, url, BROWSER_FILTER_REVISION);
  });
  const monitor = new Monitor({ state, usage: {},
    mutate: async operation => coordinator.run(({ state, usage, afterCommit }) => operation(state, usage, afterCommit))
  });
  await monitor.runMutation(async () => monitor.externalEffect("redirect-browser", {
    app, currentUrl: url, url: "http://127.0.0.1:8787/blocked", policyId: "baseline:computer"
  }, async () => { calls += 1; return { ok: true, matched: true }; }));
  coordinator.stopAdmission();
  await coordinator.drain();
  assert.equal(coordinator.pendingEffects().length, 0);
  return calls;
}

assert.equal(await queuedRedirect(page, true), 0, "a valid report arriving during persistence must cancel even the FIRST queued redirect");
assert.equal(await queuedRedirect(page, false), 0, "a queued Safari heartbeat-only redirect is obsolete even without a new report");
assert.equal(await queuedRedirect(page, false, "Google Chrome"), 1, "Chrome's existing per-page protection requirement remains active");
assert.equal(await queuedRedirect("https://www.google.com/search?q=porn", true), 1, "a healthy extension cannot cancel an actual content restriction");

resetBrowserProtectionHealthForTest();
const now = 10000;
recordBrowserFilterHealth("Safari", page, BROWSER_FILTER_REVISION, now);
// Native requests can finish in a different order from tab activation. An old
// page's late report must not erase the new page's still-valid attestation.
recordBrowserFilterHealth("Safari", "https://example.org/previous", BROWSER_FILTER_REVISION, now + 1);
assert.equal(browserPageNeedsProtection("Safari", page, now + 2), false);
assert.equal(browserPageNeedsProtection("Safari", page, now + 6002), false, "out-of-order reports cannot turn a still-protected page into a block");
assert.equal(browserPageNeedsProtection("Safari", page, now + 8000), false, "expired attestations still require bounded reconnection");
assert.equal(browserPageNeedsProtection("Safari", page, now + 14000), true);
resetBrowserProtectionHealthForTest();
// Cross-browser reports, old code and unrelated pages must never attest the
// target; URL fragments represent navigation within the same filtered document.
for (const invalid of ["", "about:blank", "file:///tmp/page", "not a url"]) {
  assert.equal(recordBrowserFilterHealth("Safari", invalid, BROWSER_FILTER_REVISION, 10000), false);
}
assert.equal(recordBrowserFilterHealth("Safari", page, "old", 10000), false);
recordBrowserFilterHealth("Google Chrome", page, BROWSER_FILTER_REVISION, 10000);
browserPageNeedsProtection("Safari", page, 10000);
assert.equal(browserPageNeedsProtection("Safari", page, 16000), true);
recordBrowserFilterHealth("Safari", page + "#report", BROWSER_FILTER_REVISION, 16001);
assert.equal(browserPageNeedsProtection("Safari", page + "#summary", 16002), false);
assert.equal(browserPageNeedsProtection("Safari", page, 24000), false);
assert.equal(browserPageNeedsProtection("Safari", page, 24001), false);
assert.equal(browserPageNeedsProtection("Safari", page, 30001), true);

resetBrowserProtectionHealthForTest();
// Cached attestations must remain bounded and must not authorize another page.
for (let index = 0; index < 100; index += 1) {
  recordBrowserFilterHealth("Safari", `${page}?route=${index}`, BROWSER_FILTER_REVISION, 10000 + index);
}
browserPageNeedsProtection("Safari", `${page}?route=0`, 10100);
assert.equal(browserPageNeedsProtection("Safari", `${page}?route=0`, 16100), true);
assert.equal(browserPageNeedsProtection("Safari", `${page}?route=99`, 16100), false);
browserPageNeedsProtection("Safari", `${page}?route=unreported`, 16101);
assert.equal(browserPageNeedsProtection("Safari", `${page}?route=99`, 9999), true, "future-dated health fails closed when a pending deadline is already in the future");

resetBrowserProtectionHealthForTest();
const sensitivePage = page + "?token=" + "secret".repeat(500) + "#private";
recordBrowserFilterHealth("Safari", page + "?route=previous", BROWSER_FILTER_REVISION, 10000);
browserPageNeedsProtection("Safari", sensitivePage, 10000);
const diagnostic = browserProtectionDiagnostic("Safari", sensitivePage, 16000);
assert.equal(diagnostic.reason, "different-page");
assert.equal(diagnostic.samePath, true);
assert.equal(diagnostic.sameQuery, false);
assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private|token/);
const compacted = compactStateEvents([{ id: "regression", type: "blocked_browser_control", at: new Date().toISOString(), detail: {
  site: "Browser protection connection interrupted", app: "Safari", originalSite: sensitivePage,
  browserControl: { area: "browser-protection", label: "Browser protection connection interrupted", url: sensitivePage },
  browserProtection: diagnostic, result: { ok: false, error: "Durable macOS effect is pending." }
} }]);
assert.equal((compacted[0].detail.browserProtection as typeof diagnostic).reason, "different-page", "compaction retains the evidence needed to diagnose recurring failures");
assert.doesNotMatch(JSON.stringify(compacted), /secret|private|token/);
resetBrowserProtectionHealthForTest();
console.log("Browser protection commit and out-of-order report races passed.");

// Speculative fallback links, page rendering and old effect bookkeeping must
// not create or move the current foreground page's recovery clock.
const inspectionState = defaultState();
inspectionState.settings.protectedBrowsersOnly = true;
const target = { app: "Safari", hostname: "example.org", url: page };
policyForSample(inspectionState, {}, target, new Date(10000), { observeBrowserProtection: false });
assert.equal(browserPageNeedsProtection("Safari", page, 20000), false, "inspecting a candidate cannot start recovery ten seconds early");
recordBrowserFilterHealth("Safari", "https://example.org/healthy", BROWSER_FILTER_REVISION, 20001);
const beforeInspection = browserFilterHealthSummary(20002);
policyForSample(inspectionState, {}, { ...target, url: "https://example.org/other" }, new Date(20002), { observeBrowserProtection: false });
policyForSample(inspectionState, {}, { ...target, url: "https://example.org/healthy" }, new Date(20002), { observeBrowserProtection: false });
assert.deepEqual(browserFilterHealthSummary(20002), beforeInspection, "speculation cannot change the awaiting URL or reset recovery through a healthy unrelated page");
assert.equal(browserPageNeedsProtection("Safari", page, 26000), true, "read-only checks preserve the full spent foreground budget");
resetBrowserProtectionHealthForTest();
const renderingNow = Date.now();
recordBrowserFilterHealth("Safari", page, BROWSER_FILTER_REVISION, renderingNow);
const renderingMonitor = new Monitor({ state: inspectionState, usage: {}, browserActivityNow: () => renderingNow, externalEffectsEnabled: false });
renderingMonitor.safeBlockedPageBackUrl(target);
blockedPage({ state: inspectionState, url: new URL("http://127.0.0.1:8787/blocked?back=https%3A%2F%2Fexample.org%2Fprevious") });
assert.equal(browserFilterHealthSummary(renderingNow)[0].awaitingUrl, null, "building and rendering Go back links never invents an unprotected foreground page");
resetBrowserProtectionHealthForTest();
