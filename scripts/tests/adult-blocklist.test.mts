import assert from "node:assert/strict";
import {
  ADULT_BLOCKLIST_SOURCES,
  adultBlocklistPreloadDomains,
  adultBlocklistSource,
  adultBlocklistSummary,
  clearAdultBlocklistCacheForTest,
  invalidateAdultBlocklistIfSourceChanged,
  matchAdultBlocklistHost,
  normalizeAdultDomain,
  normalizeAdultDomainList,
  parseAdultBlocklistDomains,
  setAdultBlocklistDomainsForTest
} from "../../src/adultBlocklist.js";
import { SOFT_BLOCK_PROFILE_ID, defaultState } from "../../src/defaults.js";
import { evaluateExtensionCheck, extensionRuleSnapshot } from "../../src/extensionPolicy.js";
import { buildHostsBlock } from "../../src/hardening.js";
import { iosPolicyTargets } from "../../src/iosProfiles.js";
import { explainRuleDecision } from "../../src/ruleSimulator.js";
import { safariFilterDenyUrls } from "../../src/safariFilter.js";
import { now, recordValue } from "./test-helpers.mjs";

const testSource = ADULT_BLOCKLIST_SOURCES[0];

try {
  setAdultBlocklistDomainsForTest([
    "exampleadult.test",
    "nested.exampleadult.test",
    "video.exampleexplicit.test"
  ], testSource);

  assert.deepEqual(parseAdultBlocklistDomains(`
# Comment
0.0.0.0 ExampleAdult.test
||video.exampleexplicit.test^
https://www.nested.exampleadult.test/path
localhost
bad_domain
`), [
    "exampleadult.test",
    "nested.exampleadult.test",
    "video.exampleexplicit.test"
  ]);
  assert.equal(normalizeAdultDomain("0.0.0.0 www.ExampleAdult.test"), "exampleadult.test");
  assert.deepEqual(normalizeAdultDomainList("www.ExampleAdult.test\nexampleadult.test"), ["exampleadult.test"]);

  const state = defaultState();
  state.settings.adultBlocklistPreloadLimit = 25;
  let match = matchAdultBlocklistHost(state, "media.exampleadult.test");
  assert.equal(match?.domain, "exampleadult.test");
  assert.equal(match?.sourceId, testSource.id);

  state.adultBlocklist.allowlist = ["exampleadult.test"];
  assert.equal(matchAdultBlocklistHost(state, "media.exampleadult.test"), null);
  assert.equal(matchAdultBlocklistHost(state, "video.exampleexplicit.test")?.domain, "video.exampleexplicit.test");
  assert.equal(adultBlocklistPreloadDomains(state).includes("exampleadult.test"), false);
  state.adultBlocklist.allowlist = [];

  const summary = adultBlocklistSummary(state);
  assert.equal(summary.ready, true);
  assert.equal(summary.domainCount, 3);
  assert.equal(summary.preloadedDomainCount > 0, true);
  assert.equal(summary.selectedSourceId, "hagezi-nsfw");
  state.adultBlocklist.hash = summary.hash;
  state.adultBlocklist.source = {
    id: testSource.id,
    label: testSource.label,
    url: testSource.url,
    homepage: testSource.homepage,
    license: testSource.license
  };
  assert.equal(adultBlocklistSummary(state).current, true);

  const blocked = evaluateExtensionCheck(state, {}, { url: "https://media.exampleadult.test/watch", event: "navigation" }, now);
  assert.equal(blocked.blocked, true);
  assert.equal(recordValue(blocked.policy, "adult policy").kind, "adult-blocklist");

  const explained = explainRuleDecision(state, {}, { url: "https://media.exampleadult.test/watch", at: now.toISOString() });
  assert.equal(explained.blocked, true);
  assert.equal(explained.reasonCode, "adult-blocklist");
  assert.equal(explained.match?.domain, "exampleadult.test");

  const snapshot = extensionRuleSnapshot(state, now);
  assert.equal(snapshot.rules.some((rule) => rule.domain === "exampleadult.test" && rule.kind === "adult-blocklist"), true);
  assert.equal(snapshot.rules.length <= 300, true);

  const hosts = buildHostsBlock(state, now);
  assert.match(hosts, /0\.0\.0\.0 exampleadult\.test/);

  const safariUrls = safariFilterDenyUrls(state, now);
  assert.equal(safariUrls.includes("https://exampleadult.test/"), true);

  state.deviceControls.ios.enabled = true;
  const levelOneIosTargets = iosPolicyTargets(state, now);
  assert.deepEqual(levelOneIosTargets.deniedUrls, []);
  const softProfile = state.profiles.find((profile) => profile.id === SOFT_BLOCK_PROFILE_ID);
  assert.ok(softProfile, "Soft Lock profile should exist");
  state.activeSessions.phone = {
    id: "adult-blocklist-phone-soft",
    title: "Phone Soft Lock",
    mode: "focus",
    profileId: softProfile.id,
    lockLevel: "light",
    startedAt: now.toISOString(),
    endsAt: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    canEndEarly: true,
    source: "manual",
    deviceTargets: ["phone"],
    profileSnapshot: softProfile
  };
  const activeIosTargets = iosPolicyTargets(state, now);
  assert.equal(activeIosTargets.deniedUrls.includes("https://exampleadult.test/"), true);

  const previousSource = adultBlocklistSource(state);
  state.settings.adultBlocklistSourceId = "custom";
  state.settings.adultBlocklistCustomUrl = "https://example.test/custom-adult-domains.txt";
  const staleSummary = adultBlocklistSummary(state);
  assert.equal(staleSummary.current, false);
  assert.equal(staleSummary.ready, false);
  assert.equal(staleSummary.domainCount, 0);
  assert.equal(staleSummary.shortHash, "");
  assert.equal(matchAdultBlocklistHost(state, "media.exampleadult.test"), null);
  assert.equal(invalidateAdultBlocklistIfSourceChanged(state, previousSource), true);
  assert.equal(state.adultBlocklist.hash, "");
  assert.equal(state.adultBlocklist.source, null);
} finally {
  clearAdultBlocklistCacheForTest();
}
