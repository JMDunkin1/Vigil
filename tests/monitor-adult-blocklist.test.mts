import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { Monitor } from "../src/monitor.js";
import { policyForSample } from "../src/monitor/policy.js";

const now = new Date("2026-07-22T16:00:00-04:00");
const state = defaultState();
const domain = "unlisted-example.com";
setAdultBlocklistDomainsForTest([domain], ADULT_BLOCKLIST_SOURCES[0]);

const policy = policyForSample(state, {}, {
  app: "Safari",
  hostname: domain,
  url: `https://${domain}/video`
}, now);

assert.equal(policy?.kind, "adult-blocklist", "the macOS monitor must enforce the full managed snapshot, not only the network preload");
assert.equal(policy?.adultBlocklist?.domain, domain);

// Recognition alone is insufficient: a bulk-list-only domain must reach the
// native redirect even when it is absent from the static network preload.
const redirects: Array<{ target: string; currentUrl: string }> = [];
const monitor = new Monitor({ state, usage: {}, browserActivityNow: () => now.getTime(),
  browserRedirect: async (_app, target, options = {}) => {
    redirects.push({ target, currentUrl: options.currentUrl || "" });
    return { ok: true, matched: true, redirectedTabCount: 1 };
  }
});
for (const hostname of [domain, `www.${domain}`, `reader.${domain}`]) {
  for (const scheme of ["https", "http"]) {
    const front = { app: "Safari", hostname, url: `${scheme}://${hostname}/chapter/1` };
    const decision = monitor.browserBlockDecision(front);
    assert.ok(decision, `immediate bulk-list redirect decision for ${front.url}`);
    assert.equal(decision.policy.adultBlocklist?.domain, domain);
    const target = monitor.blockedPageTarget(decision.front, decision.policy, decision.options);
    assert.equal(new URL(target).pathname, "/blocked");
    assert.equal(monitor.durableEffectApplicable("redirect-browser", {
      app: front.app, hostname, currentUrl: front.url, url: target
    }, now), true, "recoverable redirects must retain bulk-list restrictions");
    const before = redirects.length;
    await monitor.enforce(front);
    assert.equal(redirects.length, before + 1, `routine bulk-list redirect for ${front.url}`);
    assert.equal(redirects.at(-1)?.currentUrl, front.url, "redirects must retain the exact observed tab precondition");
  }
}
assert.equal(monitor.browserBlockDecision({ app: "Safari", hostname: `${domain}.example.org`,
  url: `https://${domain}.example.org/chapter/1` }), null, "unrelated suffixes must remain allowed");
const immediateFront = { app: "Safari", hostname: domain, url: `https://${domain}/chapter/2` };
monitor.readFrontmost = async () => ({ ok: true, ...immediateFront });
const beforeImmediate = redirects.length;
assert.equal(await monitor.probeBrowserActivity(), true);
await monitor.operationTail;
assert.equal(redirects.length, beforeImmediate + 1, "navigation events must dispatch the bulk-list redirect before routine polling");
assert.equal(redirects.at(-1)?.currentUrl, immediateFront.url);

state.adultBlocklist.allowlist = [domain];
assert.equal(
  policyForSample(state, {}, { app: "Safari", hostname: domain, url: `https://${domain}/video` }, now),
  null,
  "a protected adult-list exception must be honored by the monitor matcher"
);
const beforeAllowed = redirects.length;
await monitor.enforce({ app: "Safari", hostname: domain, url: `https://${domain}/chapter/1` });
assert.equal(redirects.length, beforeAllowed, "protected list exceptions must suppress real redirects");

clearAdultBlocklistCacheForTest();
console.log("Full-snapshot native redirects, subdomains, navigation events, durable recovery, and protected exceptions passed.");
