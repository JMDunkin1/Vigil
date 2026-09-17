import assert from "node:assert/strict";
import { appMatchesAppTargets, expandAppTargets, expandSiteTargets, hostMatchesSiteTargets, matchBlockedUrlPattern, normalizeAppName, normalizeHost, shouldBlockSite } from "../src/policy.js";
import { testProfile } from "./test-helpers.mjs";

// Preserve alias directionality, helper expansion, normalization, and exact
// domain boundaries while eliminating whole-list expansion from membership.
const appTargets: unknown[] = [" Microsoft Edge Beta.app ", "Vigil", "Discord", "Slack", "Unlisted App", "", null];
for (const app of [...expandAppTargets(appTargets), "Microsoft Edge Canary", "Slack impostor", "", null]) {
  assert.equal(appMatchesAppTargets(app, appTargets), expandAppTargets(appTargets).includes(normalizeAppName(app)));
}
const siteTargets: unknown[] = ["https://www.youtube.com/path", "twitter.com", "netflix.com", "example.org", "", null];
for (const domain of [...expandSiteTargets(siteTargets), "unknown.example", "notyoutube.com", ""]) {
  for (const host of [domain, `child.${domain}`, `${domain}.invalid`]) {
    const normalized = normalizeHost(host);
    assert.equal(hostMatchesSiteTargets(host, siteTargets), Boolean(normalized) && expandSiteTargets(siteTargets).some((target) => normalized === target || normalized.endsWith(`.${target}`)));
  }
}

// No identity-based cache may hide an edit made to a currently active policy.
const mutable = ["example.org"];
assert.equal(hostMatchesSiteTargets("example.org", mutable), true);
mutable[0] = "youtube.com";
assert.equal(hostMatchesSiteTargets("example.org", mutable), false);
assert.equal(hostMatchesSiteTargets("youtu.be", mutable), true);
const mutableApps = ["Slack"];
assert.equal(appMatchesAppTargets("Slack Helper", mutableApps), true);
mutableApps[0] = "Discord";
assert.equal(appMatchesAppTargets("Slack Helper", mutableApps), false);
assert.equal(appMatchesAppTargets("Discord Helper", mutableApps), true);

// A match at the front must not normalize every unused target (the original
// implementation expanded and sorted all of them on every process sample).
let unusedReads = 0;
const unusedTarget = { toString() { unusedReads += 1; return "unrelated.example"; } };
assert.equal(hostMatchesSiteTargets("youtu.be", ["youtube.com", unusedTarget]), true);
assert.equal(appMatchesAppTargets("Slack Helper", ["Slack", unusedTarget]), true);
assert.equal(unusedReads, 0);

// DNS root dots must not evade denies, aliases, or allowlist domain boundaries.
const profile = testProfile({ blockedSites: ["youtube.com"] });
for (const hostname of ["youtube.com.", "www.youtube.com.", "m.youtube.com.", "youtu.be."]) {
  assert.equal(shouldBlockSite(profile, hostname), true, hostname);
}
assert.equal(hostMatchesSiteTargets("youtu.be", ["youtube.com."]), true);
const allowlist = testProfile({ mode: "allowlist", allowedSites: ["example.org"] });
assert.equal(shouldBlockSite(allowlist, "example.org."), false);
assert.equal(shouldBlockSite(allowlist, "example.org.evil."), true);
assert.equal(normalizeHost("http://[::1]/"), "[::1]");
assert.equal(matchBlockedUrlPattern(testProfile({ blockedUrlPatterns: ["xxx"] }), "https://example.xxx./")?.pattern, "xxx");

const patterns = testProfile({ blockedUrlPatterns: ["https://www.example.org./blocked", "porn", "onlyfans"] });
assert.equal(matchBlockedUrlPattern(patterns, "https://example.org/blocked")?.pattern, patterns.blockedUrlPatterns[0]);
patterns.blockedUrlPatterns[0] = "https://example.org/other";
assert.equal(matchBlockedUrlPattern(patterns, "https://example.org/blocked"), null);
console.log("Policy target efficiency and DNS normalization checks passed.");
