import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
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

state.adultBlocklist.allowlist = [domain];
assert.equal(
  policyForSample(state, {}, { app: "Safari", hostname: domain, url: `https://${domain}/video` }, now),
  null,
  "a protected adult-list exception must be honored by the monitor matcher"
);

clearAdultBlocklistCacheForTest();
