import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { DEFAULT_MATURE_COMIC_BLOCKED_SITES } from "../src/priorityBlockedDomains.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "../src/iosProfiles.js";
import { shouldBlockSite } from "../src/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { now, usageFixture } from "./test-helpers.mjs";
import { parsePlist } from "../src/plist.js";

const state = defaultState();
state.deviceControls.ios.enabled = true;
state.settings.adultBlocklistEnabled = false;
for (const profile of state.profiles) {
  for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
    for (const host of [domain, `www.${domain}`, `reader.${domain}`]) {
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
const normal = state.profiles.find(profile => profile.id === "normal")!;
assert.equal(shouldBlockSite(normal, "notwebcomicsapp.com"), false);
assert.equal(shouldBlockSite(normal, "webcomicsapp.com.example.org"), false);
const targets = iosPolicyTargets(state);
assert.ok(targets.deniedUrls.length <= 500);
assert.equal(targets.supplementalDeniedUrls.length, DEFAULT_MATURE_COMIC_BLOCKED_SITES.length * 2);
for (const domain of DEFAULT_MATURE_COMIC_BLOCKED_SITES) {
  for (const scheme of ["http", "https"]) {
    assert.ok(targets.supplementalDeniedUrls.includes(`${scheme}://${domain}/`));
  }
}
const profile = parsePlist(buildIosConfigurationProfile(state)) as { PayloadContent: Array<Record<string, unknown>> };
const filters = profile.PayloadContent.filter(payload => payload.PayloadType === "com.apple.webcontent-filter");
assert.equal(filters.length, 2);
assert.equal(new Set(filters.map(payload => payload.PayloadUUID)).size, 2);
for (const filter of filters) {
  assert.equal(filter.FilterType, "BuiltIn");
  assert.equal(filter.AutoFilterEnabled, true);
  assert.ok((filter.DenyListURLs as string[]).length <= 500);
}
assert.deepEqual(filters[0].DenyListURLs, targets.deniedUrls);
assert.deepEqual(filters[1].DenyListURLs, targets.supplementalDeniedUrls);
state.deviceControls.ios.enabled = false;
const disabled = parsePlist(buildIosConfigurationProfile(state)) as { PayloadContent: Array<Record<string, unknown>> };
assert.equal(disabled.PayloadContent.some(payload => payload.PayloadType === "com.apple.webcontent-filter"), false);
console.log("Whole-platform comic bans and additive iOS filtering checks passed.");
