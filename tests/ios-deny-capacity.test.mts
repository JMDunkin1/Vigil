import assert from "node:assert/strict";
import { ADULT_BLOCKLIST_SOURCES, clearAdultBlocklistCacheForTest, setAdultBlocklistDomainsForTest } from "../src/adultBlocklist.js";
import { BRICK_MODE_PROFILE_ID, DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES, NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { iosPolicyTargets } from "../src/iosProfiles.js";
import { profileById } from "../src/policy.js";
import { now } from "./test-helpers.mjs";

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
  const denied = iosPolicyTargets(state, now).deniedUrls;
  assert.ok(denied.length <= 500);
  for (const host of ["xerography14macro.com", "dxweb003.xyz", "newgrounds.com", "kinklets.com", "protonvpn.com", "croxyproxy.com", "browser.lol", "invidious.f5.si"]) {
    assert.ok(denied.includes(`https://${host}/`), `${profileId}: ${host} must retain its priority slot`);
  }
  // Soft Block's saturated list previously delivered the first eight HTTP
  // proxy entries; Normal has capacity for the complete HTTP overlay.
  const retainedHttpProxies = profileId === NORMAL_PROFILE_ID
    ? DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES
    : DEFAULT_HTTP_FILTER_BYPASS_BLOCKED_SITES.slice(0, 8);
  for (const host of retainedHttpProxies) {
    assert.ok(denied.includes(`http://${host}/`), `${profileId}: plain-HTTP proxy protection must remain`);
  }
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
    const denied = iosPolicyTargets(state, now).deniedUrls;
    assert.ok(denied.length <= 500);
    const bulkUrls = bulkDomains.flatMap(host => [`http://${host}/`, `https://${host}/`]);
    assert.ok(denied.filter(url => bulkUrls.includes(url)).length >= 6, `${profileId}: retain the bulk-adult reserve`);
    assert.ok(denied.includes("https://kinklets.com/"));
    assert.ok(denied.includes("https://protonvpn.com/"), `${profileId}: retain prior guaranteed domain breadth with bulk filtering enabled`);
  }
} finally {
  clearAdultBlocklistCacheForTest();
}
console.log("iOS deny capacity and coverage checks passed.");
