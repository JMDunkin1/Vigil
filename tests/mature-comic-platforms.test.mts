import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import {
  DEFAULT_ADULT_PRODUCT_BLOCKED_SITES,
  DEFAULT_FILTER_BYPASS_BLOCKED_SITES,
  DEFAULT_MATURE_ART_BLOCKED_SITES,
  DEFAULT_MATURE_COMIC_BLOCKED_SITES,
  DEFAULT_PRIORITY_ADULT_BLOCKED_SITES
} from "../src/priorityBlockedDomains.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "../src/iosProfiles.js";
import { shouldBlockSite } from "../src/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { now, usageFixture } from "./test-helpers.mjs";
import { parsePlist } from "../src/plist.js";
import { sanitizeDefaultFocusProfile, sanitizeFullBrickProfile, sanitizeSoftBlockProfile } from "../src/store.js";

const state = defaultState();
state.deviceControls.ios.enabled = true;
state.settings.adultBlocklistEnabled = false;
assert.equal(new Set(DEFAULT_MATURE_COMIC_BLOCKED_SITES).size, DEFAULT_MATURE_COMIC_BLOCKED_SITES.length,
  "reviewed comic domains must not waste phone capacity on duplicate entries");
for (const requestedDomain of ["comicland.org", "manhwaread.com", "manhwaread.org", "toon-hub.com",
  "mangakakalots.co.uk", "mangafire.to", "atsu.moe", "everythingmoe.com", "cubari.moe",
  "weebcentral.com", "mangadistrict.com", "madaradex.org", "kakamanga.com", "asmhentai.com", "schale.network",
  "qtoon.com", "qtoon.net", "qtoon.org", "qtoon.ai", "comicle.com", "comicle-manga-manhwa-comics.soft112.com"]) {
  assert.ok(DEFAULT_MATURE_COMIC_BLOCKED_SITES.some(domain => domain === requestedDomain), requestedDomain);
}
for (const profile of state.profiles) {
  for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
    for (const host of [domain, `www.${domain}`, `reader.${domain}`, `cdn.reader.${domain}`, domain.toUpperCase()]) {
      assert.ok(shouldBlockSite(profile, host), `${profile.id}: ${host}`);
    }
  }
}
for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
  for (const scheme of ["http", "https"]) {
    const url = `${scheme}://reader.${domain}/ordinary-comic`;
    assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event: "navigation" }, now).blocked, true, url);
  }
}
for (const [profileId, sanitize] of [
  ["default", sanitizeDefaultFocusProfile],
  ["soft-block", sanitizeSoftBlockProfile],
  ["brick-mode", sanitizeFullBrickProfile]
] as const) {
  const original = state.profiles.find(profile => profile.id === profileId);
  assert.ok(original, profileId);
  const legacy = { ...original, blockedSites: ["retained-custom-block.example"] };
  const migrated = sanitize(legacy);
  for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
    assert.ok(shouldBlockSite(migrated, `reader.${domain}`), `${profileId}: saved pre-upgrade profile gains ${domain}`);
  }
}
const normal = state.profiles.find(profile => profile.id === "normal")!;
assert.equal(shouldBlockSite(normal, "notwebcomicsapp.com"), false);
assert.equal(shouldBlockSite(normal, "webcomicsapp.com.example.org"), false);
for (const unrelatedHost of ["comicland.org.example.org", "notcomicland.org", "manhwaread.org.example.org", "notmanhwaread.org",
  "nottoon-hub.com", "toon-hub.com.example.org", "mangakakalots.co.uk.example.org", "notmangafire.to"]) {
  assert.equal(shouldBlockSite(normal, unrelatedHost), false, unrelatedHost);
}
const targets = iosPolicyTargets(state);
assert.ok(targets.deniedUrls.length <= 500);
assert.ok(targets.supplementalDeniedUrls.length >= DEFAULT_MATURE_COMIC_BLOCKED_SITES.length * 2,
  "the supplemental payload retains every comic deny alongside displaced priority rules");
for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
  for (const scheme of ["http", "https"]) {
    assert.ok(targets.supplementalDeniedUrls.includes(`${scheme}://${domain}/`));
  }
}
const deliveredUrls = new Set([...targets.deniedUrls, ...targets.supplementalDeniedUrls]);
for (const domain of [...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
  assert.ok(deliveredUrls.has(`https://${domain}/`), `the expansion must retain the curated deny for ${domain}`);
}
for (const domain of [...DEFAULT_MATURE_ART_BLOCKED_SITES, ...DEFAULT_ADULT_PRODUCT_BLOCKED_SITES]) {
  for (const scheme of ["http", "https"]) {
    assert.ok(deliveredUrls.has(`${scheme}://${domain}/`), `the expansion must retain ${scheme} coverage for ${domain}`);
  }
}
const profile = parsePlist(buildIosConfigurationProfile(state)) as { PayloadContent: Array<Record<string, unknown>> };
const filters = profile.PayloadContent.filter(payload => payload.PayloadType === "com.apple.webcontent-filter");
// Supplemental inventory now spans several payloads. Enforce Apple's cap on
// every emitted payload and prove that chunking loses no curated URLs.
assert.equal(filters.length, 1 + Math.ceil(targets.supplementalDeniedUrls.length / 500));
assert.equal(new Set(filters.map(payload => payload.PayloadUUID)).size, filters.length);
for (const filter of filters) {
  assert.equal(filter.FilterType, "BuiltIn");
  assert.equal(filter.AutoFilterEnabled, true);
  assert.ok((filter.DenyListURLs as string[]).length <= 500);
}
assert.deepEqual(filters[0].DenyListURLs, targets.deniedUrls);
assert.deepEqual(filters.slice(1).flatMap(filter => filter.DenyListURLs), targets.supplementalDeniedUrls);
state.deviceControls.ios.enabled = false;
const disabled = parsePlist(buildIosConfigurationProfile(state)) as { PayloadContent: Array<Record<string, unknown>> };
assert.equal(disabled.PayloadContent.some(payload => payload.PayloadType === "com.apple.webcontent-filter"), false);
console.log("Whole-platform comic bans and additive iOS filtering checks passed.");
