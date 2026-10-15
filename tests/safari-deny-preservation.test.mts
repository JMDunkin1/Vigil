import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { buildSafariFilterProfile, safariFilterDenyUrls } from "../src/safariFilter.js";
import { DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, DEFAULT_FILTER_BYPASS_BLOCKED_SITES } from "../src/priorityBlockedDomains.js";

const state = defaultState();
const baseline = state.profiles.find(profile => profile.id === state.settings.baselineProfileId)!;
const custom = Array.from({ length: 510 }, (_, index) => `retained-${index}.example.test`);
baseline.blockedSites.push(...custom);
const denied = safariFilterDenyUrls(state);
assert.ok(denied.length > 500, "the macOS payload must not inherit the iOS-only truncation");
for (const domain of [...custom, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
  assert.ok(denied.includes(`https://${domain}/`), `${domain} retains its OS-level deny`);
}
const xml = buildSafariFilterProfile(state);
assert.ok(xml.includes("<string>com.apple.familycontrols.contentfilter</string>"));
for (const url of denied) assert.ok(xml.includes(`<string>${url.replaceAll("&", "&amp;")}</string>`), `export preserves ${url}`);
console.log(`macOS export preserves all ${denied.length} denies past the iOS 500-URL ceiling.`);
