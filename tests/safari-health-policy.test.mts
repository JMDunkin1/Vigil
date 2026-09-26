import assert from "node:assert/strict";
import { BROWSER_FILTER_REVISION, browserPageNeedsProtection, recordBrowserFilterHealth, resetBrowserProtectionHealthForTest } from "../src/browserProtection.js";
import { buildBlockedPageUrl } from "../src/blockedPageUrl.js";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { policyForSample } from "../src/monitor/policy.js";

resetBrowserProtectionHealthForTest();
const state = defaultState();
state.settings.protectedBrowsersOnly = true;
const allowed = { app: "Safari", url: "https://example.org/document", hostname: "example.org" };
browserPageNeedsProtection("Safari", allowed.url, 10000);
assert.equal(browserPageNeedsProtection("Safari", allowed.url, 16000), true);
for (const now of [16000, 60000, 86410000]) {
  assert.equal(policyForSample(state, {}, allowed, new Date(now)), null, "missing Safari reports never create a blocking policy");
}
recordBrowserFilterHealth("Safari", allowed.url, BROWSER_FILTER_REVISION, 86410001);
assert.equal(policyForSample(state, {}, allowed, new Date(86430000)), null, "expired Safari reports remain diagnostic");
assert.equal(policyForSample(state, {}, { ...allowed, url: "https://example.org/another" }, new Date(86430001)), null, "old exhausted recovery cannot cascade across Safari pages");
assert.ok(policyForSample(state, {}, { app: "Safari", url: "https://hot.com/", hostname: "hot.com" }), "actual blocked sites still apply to Safari");
const deniedUrl = "https://www.google.com/search?q=porn";
assert.ok(policyForSample(state, {}, { app: "Safari", url: deniedUrl, hostname: "www.google.com" }), "actual restricted search content still applies to Safari");
assert.equal(policyForSample(state, {}, { app: "Firefox", url: "", hostname: "" })?.profile.id, "protected-browser-required", "unsupported browsers remain restricted");

resetBrowserProtectionHealthForTest();
const chrome = { ...allowed, app: "Google Chrome" };
assert.equal(policyForSample(state, {}, chrome, new Date(10000)), null);
assert.equal(policyForSample(state, {}, chrome, new Date(16000))?.browserControl?.area, "browser-protection", "Chrome's timeout behavior is unchanged");

const sessionState = defaultState();
sessionState.profiles.find(profile => profile.id === "default")!.blockedSites.push("example.org");
const now = new Date();
const session = { id: "safari-real-session", title: "Focus", mode: "focus", profileId: "default", lockLevel: "deep" as const,
  startedAt: now.toISOString(), endsAt: new Date(now.getTime() + 3600000).toISOString(), canEndEarly: false, source: "manual", deviceTargets: ["computer" as const] };
sessionState.activeSession = session;
sessionState.activeSessions.computer = session;
assert.equal(policyForSample(sessionState, {}, allowed, now)?.session.id, session.id, "actual focus-session rules remain enforced");

resetBrowserProtectionHealthForTest();
const redirects: string[] = [];
const monitor = new Monitor({ state, usage: {}, browserRedirect: async (_app, url) => {
  redirects.push(url);
  return { ok: true, matched: true, redirectedTabCount: 1 };
} });
const oldHealthTarget = buildBlockedPageUrl({ site: "Browser protection connection interrupted", kind: "browser-protection", policyId: "baseline:computer" });
const staleEffect = { app: "Safari", currentUrl: allowed.url, hostname: allowed.hostname, url: oldHealthTarget, policyId: "baseline:computer" };
assert.equal(monitor.durableEffectApplicable("redirect-browser", staleEffect), false);
await monitor.reconcileDurableEffect("redirect-browser", staleEffect);
assert.deepEqual(redirects, [], "a persisted pre-update health redirect is cancelled during recovery");
await monitor.reconcileDurableEffect("redirect-browser", { ...staleEffect, currentUrl: deniedUrl, hostname: "www.google.com" });
assert.deepEqual(redirects, [], "a new real violation cannot resurrect an old connection-check destination");
const actualDecision = monitor.browserBlockDecision({ app: "Safari", url: deniedUrl, hostname: "www.google.com" });
assert.ok(actualDecision);
assert.notEqual(actualDecision.policy.browserControl?.area, "browser-protection");
const actualTarget = monitor.blockedPageTarget(actualDecision.front, actualDecision.policy, actualDecision.options);
await monitor.reconcileDurableEffect("redirect-browser", { ...staleEffect, currentUrl: deniedUrl, hostname: "www.google.com", url: actualTarget });
assert.deepEqual(redirects, [actualTarget], "a current actual restriction still dispatches its browser redirect");
resetBrowserProtectionHealthForTest();
console.log("Safari connection checks are diagnostic; Chrome checks, actual rules and recovered-effect safety remain enforced.");
