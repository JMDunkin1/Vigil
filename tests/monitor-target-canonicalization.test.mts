import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { canonicalPolicySample, policyForSample } from "../src/monitor/policy.js";

const now = new Date("2026-10-13T12:00:00-04:00");
const state = defaultState();
const listed = "bulk-only-policy.example";
const profileBlocked = "profile-only-policy.example";
const safeHost = "ordinary-policy.example";
const baseline = state.profiles.find(profile => profile.id === state.settings.baselineProfileId)!;
baseline.blockedSites = [profileBlocked];
baseline.blockedUrlPatterns = [];
setAdultBlocklistDomainsForTest([listed], ADULT_BLOCKLIST_SOURCES[0]);

const redirects: Array<{ target: string; currentUrl: string }> = [];
const monitor = new Monitor({ state, usage: {}, browserActivityNow: () => now.getTime(),
  browserRedirect: async (_app, target, options = {}) => {
    redirects.push({ target, currentUrl: options.currentUrl || "" });
    return { ok: true, matched: true, redirectedTabCount: 1 };
  }
});

try {
  for (const domain of [listed, profileBlocked]) {
    for (const hostname of ["", safeHost, "Content filter diagnostic label"]) {
      for (const url of [
        `https://${domain}/chapter/1`,
        `https://reader.${domain}./chapter/2`,
        `http://${domain.replace("-", "%2d")}/chapter/3`,
        `https://${safeHost}@${domain}/chapter/4`
      ]) {
        const front = { app: "Safari", hostname, url };
        const policy = policyForSample(state, {}, front, now);
        assert.ok(policy, `actual blocked URL must win over supplied hostname ${hostname}: ${url}`);
        assert.equal(policy?.adultBlocklist?.domain || policy?.profile.blockedSites[0], domain);
        const decision = monitor.browserBlockDecision(front);
        assert.ok(decision, `recognition must dispatch an immediate redirect for ${url}`);
        assert.equal(decision.sample.url, url, "canonical matching must preserve the exact observed URL");
        assert.equal(decision.front.hostname, canonicalPolicySample(front).hostname);
        const target = monitor.blockedPageTarget(decision.front, decision.policy, decision.options);
        assert.equal(monitor.durableEffectApplicable("redirect-browser", {
          app: front.app, hostname, currentUrl: url, url: target
        }, now), true, "recovered effects must derive the host from currentUrl, including display labels");
        const before = redirects.length;
        await monitor.enforce(front);
        assert.equal(redirects.length, before + 1, "the routine enforcement path must also act on a recognized URL");
        assert.equal(redirects.at(-1)?.currentUrl, url, "redirects must retain the browser's exact-tab precondition");
      }
    }
  }

  for (const hostname of [listed, profileBlocked]) {
    const front = { app: "Safari", hostname, url: `https://${safeHost}/documents` };
    assert.equal(policyForSample(state, {}, front, now), null,
      "a stale blocked hostname must not redirect a different currently observed safe URL");
    assert.equal(monitor.browserBlockDecision(front), null);
    assert.equal(monitor.durableEffectApplicable("redirect-browser", {
      app: front.app, hostname, currentUrl: front.url, url: "http://127.0.0.1:8787/blocked"
    }, now), false, "recovered effects must retire when their real destination is allowed");
  }

  const hostOnly = { app: "Safari", hostname: listed, url: "" };
  assert.equal(policyForSample(state, {}, hostOnly, now)?.adultBlocklist?.domain, listed,
    "native observations with only a host must keep their existing match behavior");
  assert.equal(canonicalPolicySample(hostOnly), hostOnly);
  const internal = { app: "Google Chrome", hostname: "extensions", url: "chrome://extensions/" };
  assert.equal(canonicalPolicySample(internal), internal, "browser controls are not web hosts");
} finally {
  clearAdultBlocklistCacheForTest();
}

console.log("Native canonical URL matching, missing/stale hosts, encoded hosts, immediate/routine enforcement, and recovery passed.");
