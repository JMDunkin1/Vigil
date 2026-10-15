import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, adultBlocklistPreloadDomains, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { defaultState } from "../src/defaults.js";
import { extensionRuleSnapshot } from "../src/extensionPolicy.js";

setAdultBlocklistDomainsForTest(Array.from({ length: 1_200 }, (_, index) => `bulk-${String(index).padStart(4, "0")}.example.test`), ADULT_BLOCKLIST_SOURCES[0]);
try {
  const state = defaultState();
  state.settings.adultBlocklistPreloadLimit = 999;
  assert.equal(adultBlocklistPreloadDomains(state).length, 250, "saved network/phone preload remains bounded");
  assert.equal(adultBlocklistPreloadDomains(state, { limit: 1_000 }).length, 1_000, "explicit browser budget can fill its larger paired rule ranges");
  const rules = extensionRuleSnapshot(state).rules;
  assert.equal(rules.length, 1_000);
  assert.ok(rules.filter(rule => rule.kind === "adult-blocklist").length > 250, "existing priority rules leave substantial offline full-list preload capacity");
} finally { clearAdultBlocklistCacheForTest(); }
console.log("Browser preload fills its 1,000-rule budget while preserving the bounded saved phone/network preload.");
