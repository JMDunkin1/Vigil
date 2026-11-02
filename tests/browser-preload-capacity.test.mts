import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, adultBlocklistPreloadDomains, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { browserPermanentDomainRules } from "../src/browserStaticProtection.js";
import { extensionRuleSnapshot } from "../src/extensionPolicy.js";

setAdultBlocklistDomainsForTest(Array.from({ length: 1_200 }, (_, index) => `bulk-${String(index).padStart(4, "0")}.example.test`), ADULT_BLOCKLIST_SOURCES[0]);
try {
  const state = defaultState();
  state.settings.adultBlocklistPreloadLimit = 999;
  assert.equal(adultBlocklistPreloadDomains(state).length, 250, "saved network/phone preload remains bounded");
  assert.equal(adultBlocklistPreloadDomains(state, { limit: 1_000 }).length, 1_000, "explicit browser budget can fill its larger paired rule ranges");
  const permanentRules = browserPermanentDomainRules();
  const permanentNavigation = new Set(permanentRules.filter(rule => rule.action.type === "redirect").flatMap(rule => rule.condition.requestDomains || []));
  const permanentResources = new Set(permanentRules.filter(rule => rule.action.type === "block").flatMap(rule => rule.condition.requestDomains || []));
  const baseline = state.profiles.find(profile => profile.id === state.settings.baselineProfileId)!;
  for (const domain of baseline.blockedSites) {
    assert.ok(permanentNavigation.has(domain), `${domain} retains offline top-level protection regardless of the dynamic quota`);
    assert.ok(permanentResources.has(domain), `${domain} retains offline subresource protection regardless of the dynamic quota`);
  }
  const defaultRules = extensionRuleSnapshot(state).rules;
  assert.ok(defaultRules.length <= 1_000);
  assert.equal(new Set(defaultRules.map(rule => rule.domain)).size, defaultRules.length);

  // A bounded authored fixture gives this capacity test stable spare room as
  // the separately verified permanent production deny list keeps growing.
  const priorityDomains = Array.from({ length: 100 }, (_, index) => `priority-${index}.example.test`);
  baseline.blockedSites = priorityDomains;
  const rules = extensionRuleSnapshot(state).rules;
  assert.equal(rules.length, 1_000);
  assert.equal(new Set(rules.map(rule => rule.domain)).size, rules.length);
  for (const domain of priorityDomains) {
    assert.ok(rules.some(rule => rule.domain === domain && rule.reason === "baseline"), `${domain} cannot be evicted by a bulk-source rule`);
  }
  assert.ok(rules.filter(rule => rule.kind === "adult-blocklist").length > 250, "a bounded priority fixture leaves substantial offline full-list preload capacity");
} finally { clearAdultBlocklistCacheForTest(); }
console.log("Browser preload fills its 1,000-rule budget while preserving the bounded saved phone/network preload.");
