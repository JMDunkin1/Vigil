import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { DEFAULT_ADULT_PRODUCT_BLOCKED_SITES, DEFAULT_MATURE_ART_BLOCKED_SITES } from "../src/priorityBlockedDomains.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "../src/iosProfiles.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { shouldBlockSite, shouldBlockUrl } from "../src/policy.js";
import { sanitizeDefaultFocusProfile, sanitizeFullBrickProfile, sanitizeSoftBlockProfile } from "../src/store.js";
import { parsePlist } from "../src/plist.js";
import { now, usageFixture } from "./test-helpers.mjs";

const sites = [...DEFAULT_MATURE_ART_BLOCKED_SITES, ...DEFAULT_ADULT_PRODUCT_BLOCKED_SITES];
const state = defaultState();
state.settings.adultBlocklistEnabled = false;
state.deviceControls.ios.enabled = true;

for (const profile of state.profiles) {
  for (const site of sites) {
    for (const host of [site, `www.${site}`, `shop.${site}`, `${site}.`]) {
      assert.ok(shouldBlockSite(profile, host), `${profile.id}: ${host}`);
    }
  }
}
const normal = state.profiles.find(profile => profile.id === "normal")!;
for (const site of sites) {
  for (const scheme of ["http", "https"]) {
    const url = `${scheme}://shop.${site}/unlabelled-item`;
    assert.equal(evaluateExtensionCheck(state, usageFixture({}), { url, event: "navigation" }, now).blocked, true, url);
  }
  assert.equal(shouldBlockSite(normal, `${site}.example.org`), false, "domain boundaries remain exact");
}
// Existing saved profiles must gain the same baseline, including custom focus
// profiles; a list confined to newly created installations would leave the gap.
for (const migrate of [sanitizeDefaultFocusProfile, sanitizeFullBrickProfile, sanitizeSoftBlockProfile]) {
  const migrated = migrate({ ...normal, blockedSites: ["prior.example"], blockedUrlPatterns: [] });
  for (const site of sites) assert.ok(shouldBlockSite(migrated, site), `migrated ${site}`);
}
const targets = iosPolicyTargets(state, now);
for (const site of sites) {
  for (const scheme of ["http", "https"]) {
    assert.ok(targets.supplementalDeniedUrls.includes(`${scheme}://${site}/`), `supervised ${scheme}://${site}`);
  }
}
const profile = parsePlist(buildIosConfigurationProfile(state, now)) as {
  PayloadRemovalDisallowed: boolean;
  PayloadContent: Array<Record<string, unknown>>;
};
assert.equal(profile.PayloadRemovalDisallowed, true);
const filters = profile.PayloadContent.filter(payload => payload.PayloadType === "com.apple.webcontent-filter");
assert.equal(filters.length, 2);
assert.equal(new Set(filters.map(filter => filter.PayloadUUID)).size, 2);
for (const filter of filters) {
  assert.equal(filter.FilterType, "BuiltIn");
  assert.equal(filter.AutoFilterEnabled, true);
  assert.ok((filter.DenyListURLs as string[]).length <= 500);
}
const delivered = filters.flatMap(filter => filter.DenyListURLs as string[]);
for (const site of sites) assert.ok(delivered.includes(`https://${site}/`));
// Product URL slugs need protection outside a site's declared search route.
for (const path of ["product/silicone-sex-doll.html", "catalog/love_dolls", "item/sex-toys/123", "product/性爱娃娃/123"]) {
  assert.equal(shouldBlockUrl(normal, `https://marketplace.example/${path}`), true, path);
}
for (const path of ["product/silicone-baking-molds", "product/reborn-dolls", "item/toy-robots"]) {
  assert.equal(shouldBlockUrl(normal, `https://marketplace.example/${path}`), false, path);
}
console.log(`${sites.length} adult-product/art domain bans, existing-profile migration, product slugs and supervised payload protections passed.`);
