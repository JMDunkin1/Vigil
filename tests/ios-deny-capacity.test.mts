import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { buildIosConfigurationProfile, iosPolicyTargets } from "../src/iosProfiles.js";
import { parsePlist } from "../src/plist.js";
import { profileById } from "../src/policy.js";
import { now, recordValue } from "./test-helpers.mjs";

function stateForMode(profileId: string) {
  const state = defaultState();
  state.deviceControls.ios.enabled = true;
  state.settings.adultBlocklistEnabled = false;
  if (profileId !== NORMAL_PROFILE_ID) {
    state.activeSessions.phone = {
      id: `capacity-${profileId}`, title: profileId, mode: "focus", profileId,
      lockLevel: "deep", startedAt: now.toISOString(),
      endsAt: new Date(now.getTime() + 60 * 60_000).toISOString(),
      canEndEarly: false, source: "manual", deviceTargets: ["phone"],
      profileSnapshot: profileById(state, profileId)
    };
  }
  return state;
}

for (const profileId of [NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]) {
  const state = stateForMode(profileId);
  const targets = iosPolicyTargets(state, now);
  const denied = targets.deniedUrls;
  const combined = [...denied, ...targets.supplementalDeniedUrls];
  assert.ok(denied.length <= 500);
  assert.ok(targets.supplementalDeniedUrls.length <= 500);
  for (const host of [...DEFAULT_FILTER_BYPASS_BLOCKED_SITES, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES]) {
    assert.ok(combined.includes(`https://${host}/`), `${profileId}: every curated priority domain must remain blocked`);
  }
  for (const host of DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES) {
    assert.ok(combined.includes(`http://${host}/`), `${profileId}: every plain-HTTP proxy protection must remain`);
  }
  const profile = recordValue(parsePlist(buildIosConfigurationProfile(state, now)), "capacity profile");
  assert.equal(profile.PayloadRemovalDisallowed, true, "expanded service policies must retain non-removable supervision enforcement");
  assert.ok(Array.isArray(profile.PayloadContent));
  const payloads = profile.PayloadContent.map(value => recordValue(value, "capacity payload"));
  const filters = payloads.filter(payload => payload.PayloadType === "com.apple.webcontent-filter" && payload.FilterType === "BuiltIn");
  assert.ok(filters.length >= 1);
  const delivered = filters.flatMap(filter => {
    assert.ok(Array.isArray(filter.DenyListURLs));
    assert.ok(filter.DenyListURLs.length <= 500, `${profileId}: each OS deny payload must obey Apple's capacity`);
    assert.equal(filter.AutoFilterEnabled, true);
    return filter.DenyListURLs as string[];
  });
  assert.deepEqual([...new Set(delivered)].sort(), [...new Set(combined)].sort(),
    `${profileId}: primary and supplemental coverage must actually reach the supervised profile`);
  assert.equal(new Set(filters.map(filter => filter.PayloadUUID)).size, filters.length,
    "additive BuiltIn filters require distinct payload identities");
  if (profileId === SOFT_BLOCK_PROFILE_ID) {
    for (const scheme of ["http", "https"]) {
      for (const host of ["youtube.com", "m.youtube.com"]) {
        const removed = `${scheme}://${host}/shorts/`;
        assert.equal(denied.includes(removed), false, "a covered trailing-slash twin should not consume a slot");
        assert.ok(denied.some(prefix => removed.startsWith(prefix)), `removed ${removed} must remain covered`);
      }
    }
  }
}

// Exercise caller-supplied twins as well as the built-in Shorts paths. Every
// removed input must remain covered by a retained literal prefix; a standalone
// slash URL must remain untouched. Existing query-prefix compaction still works.
const custom = stateForMode(NORMAL_PROFILE_ID);
const candidates = [
  "https://capacity.example/path", "https://capacity.example/path/",
  "https://capacity.example/path//", "https://capacity.example/standalone/",
  "https://capacity.example/search?q=porn", "https://capacity.example/search?q=porno",
  "https://blocked-root.example/", "https://blocked-root.example/path",
  "https://blocked-root.example/?q=anything", "https://www.blocked-root.example/path"
];
custom.deviceControls.ios.deniedUrls = candidates;
const customDenied = iosPolicyTargets(custom, now).deniedUrls;
for (const candidate of candidates) {
  assert.ok(customDenied.some(prefix => candidate.replace("://www.", "://").startsWith(prefix.replace("://www.", "://"))), `${candidate} must remain covered`);
}
assert.ok(customDenied.includes("https://capacity.example/standalone/"));
assert.equal(customDenied.includes("https://capacity.example/path/"), false);
assert.equal(customDenied.includes("https://capacity.example/path//"), false);
assert.equal(customDenied.includes("https://capacity.example/search?q=porno"), false);
assert.equal(customDenied.includes("https://blocked-root.example/path"), false);
assert.equal(customDenied.includes("https://blocked-root.example/?q=anything"), false);
assert.equal(customDenied.includes("https://www.blocked-root.example/path"), false);

// Keep the six bulk-adult slots even when the curated and active-policy lists
// saturate Apple's limit. Reclaimed capacity must not come from this reserve.
const bulkDomains = Array.from({ length: 20 }, (_, index) => `bulk${index}.example`);
try {
  setAdultBlocklistDomainsForTest(bulkDomains, ADULT_BLOCKLIST_SOURCES[0]);
  for (const profileId of [NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]) {
    const state = stateForMode(profileId);
    state.settings.adultBlocklistEnabled = true;
    const targets = iosPolicyTargets(state, now);
    const denied = targets.deniedUrls;
    assert.ok(denied.length <= 500);
    assert.ok(targets.supplementalDeniedUrls.length <= 500);
    const combined = [...denied, ...targets.supplementalDeniedUrls];
    for (const host of [...DEFAULT_FILTER_BYPASS_BLOCKED_SITES, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES]) {
      assert.ok(combined.includes(`https://${host}/`), `${profileId}: bulk overlay must preserve all curated priority domains`);
    }
    for (const host of DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES) {
      assert.ok(combined.includes(`http://${host}/`), `${profileId}: bulk overlay must preserve all plain-HTTP proxies`);
    }
    const bulkUrls = bulkDomains.flatMap(host => [`http://${host}/`, `https://${host}/`]);
    assert.ok(denied.filter(url => bulkUrls.includes(url)).length >= 6, `${profileId}: retain the bulk-adult reserve`);
    assert.ok(combined.includes("https://kinklets.com/"));
    assert.ok(combined.includes("https://protonvpn.com/"), `${profileId}: retain prior guaranteed domain breadth with bulk filtering enabled`);
  }
} finally {
  clearAdultBlocklistCacheForTest();
}
console.log("iOS deny capacity and coverage checks passed.");
