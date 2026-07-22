import assert from "node:assert/strict";
import { SOFT_BLOCK_PROFILE_ID, defaultState } from "../src/defaults.js";
import { buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { parsePlist } from "../src/plist.js";
import { profileById } from "../src/policy.js";
import {
  focusedSocialDeniedUrls,
  normalizeFocusedSocialSettings,
  withoutFocusedSocialDeniedUrls
} from "../src/socialFeatureFilters.js";

const instagramProbe = (feature: string) => `https://www.instagram.com/?__vigil_feature=${feature}`;
const youtubeProbes = (feature: string) => [
  `https://www.youtube.com/?__vigil_feature=${feature}`,
  `https://m.youtube.com/?__vigil_feature=${feature}`
];

const settings = normalizeFocusedSocialSettings();
for (const feature of ["reels", "explore", "suggested", "shopping", "ads"] as const) {
  const isolated = structuredClone(settings);
  for (const key of ["reels", "explore", "suggested", "shopping", "ads"] as const) {
    isolated.instagram[key] = key === feature;
  }
  isolated.youtube.home = false;
  isolated.youtube.explore = false;
  isolated.youtube.suggested = false;
  isolated.youtube.ads = false;
  const denied = focusedSocialDeniedUrls(isolated);
  assert.ok(denied.includes(instagramProbe(feature)), `${feature} should carry its own Instagram companion probe`);
  for (const other of ["reels", "explore", "suggested", "shopping", "ads"] as const) {
    if (other !== feature) assert.equal(denied.includes(instagramProbe(other)), false);
  }
}

for (const feature of ["home", "explore", "suggested", "ads"] as const) {
  const isolated = structuredClone(settings);
  isolated.instagram.reels = false;
  isolated.instagram.explore = false;
  isolated.instagram.suggested = false;
  isolated.instagram.shopping = false;
  isolated.instagram.ads = false;
  for (const key of ["home", "explore", "suggested", "ads"] as const) {
    isolated.youtube[key] = key === feature;
  }
  const denied = focusedSocialDeniedUrls(isolated);
  for (const sentinel of youtubeProbes(feature)) {
    assert.ok(denied.includes(sentinel), `${feature} should carry its ${new URL(sentinel).host} companion probe`);
  }
  for (const other of ["home", "explore", "suggested", "ads"] as const) {
    if (other !== feature) {
      for (const sentinel of youtubeProbes(other)) assert.equal(denied.includes(sentinel), false);
    }
  }
}

const allProbes = focusedSocialDeniedUrls(settings).filter((url) => url.includes("?__vigil_feature="));
assert.equal(allProbes.length, 13);
assert.equal(allProbes.every((url) => url.startsWith("https://")), true);
assert.equal(allProbes.filter((url) => url.startsWith("https://m.youtube.com/")).length, 4);
assert.deepEqual(withoutFocusedSocialDeniedUrls(allProbes), []);

// Apple's built-in filter matches when the deny-list pattern is a substring of
// the requested URL, after treating a leading www host label as equivalent to
// the bare host. A query sentinel therefore matches its probe request without
// matching (and accidentally blocking) the shorter service root. Mobile
// YouTube remains distinct, so it needs the explicit m.youtube.com sentinels.
for (const probe of allProbes) {
  const root = new URL(probe);
  root.search = "";
  assert.equal(appleBuiltInFilterMatches(probe, root.href), false, `${probe} must not deny the service root`);
  assert.equal(appleBuiltInFilterMatches(probe, `${probe}&vigil_request=1`), true, `${probe} must deny its probe request`);
}
assert.equal(
  appleBuiltInFilterMatches(instagramProbe("reels"), "https://instagram.com/?__vigil_feature=reels"),
  true,
  "Apple's www normalization should cover Instagram's bare canonical host"
);
assert.equal(
  appleBuiltInFilterMatches(youtubeProbes("home")[0], youtubeProbes("home")[1]),
  false,
  "mobile YouTube needs a distinct sentinel because it is not the bare/www host variant"
);

// Shorts stays permanent and is intentionally independent of the optional
// feature-probe contract.
const everythingOptionalOff = structuredClone(settings);
everythingOptionalOff.instagram.enabled = false;
everythingOptionalOff.youtube.enabled = false;
const permanentOnly = focusedSocialDeniedUrls(everythingOptionalOff);
assert.ok(permanentOnly.includes("youtube.com/shorts"));
assert.equal(permanentOnly.some((url) => url.includes("?__vigil_feature=")), false);

// Exercise the final Apple payload, not just the logical feature list. Explicit
// HTTPS sentinels must survive verbatim instead of expanding into HTTP/www
// variants and consuming unnecessary entries from Apple's 500-URL cap.
const generatedAt = new Date("2026-07-22T12:00:00.000Z");
const profileState = defaultState();
profileState.deviceControls.ios.enabled = true;
profileState.activeSessions.phone = {
  id: "feature-probe-profile",
  title: "Feature probe profile",
  mode: "focus",
  profileId: SOFT_BLOCK_PROFILE_ID,
  lockLevel: "light",
  startedAt: generatedAt.toISOString(),
  endsAt: new Date(generatedAt.getTime() + 60 * 60 * 1000).toISOString(),
  canEndEarly: true,
  source: "manual",
  deviceTargets: ["phone"],
  profileSnapshot: profileById(profileState, SOFT_BLOCK_PROFILE_ID)
};
const parsedProfile = asRecord(parsePlist(buildIosConfigurationProfile(profileState, generatedAt)));
const payloads = Array.isArray(parsedProfile.PayloadContent)
  ? parsedProfile.PayloadContent.map(asRecord)
  : [];
const webFilter = payloads.find((payload) => payload.PayloadType === "com.apple.webcontent-filter");
const finalDenied = Array.isArray(webFilter?.DenyListURLs)
  ? webFilter.DenyListURLs.map(String)
  : [];
const finalProbes = finalDenied.filter((url) => url.includes("?__vigil_feature="));
assert.deepEqual(new Set(finalProbes), new Set(allProbes));
assert.equal(finalProbes.length, 13);
assert.equal(finalProbes.some((url) => url.startsWith("http://")), false);
assert.ok(finalDenied.length <= 500);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function appleBuiltInFilterMatches(pattern: string, requestedUrl: string): boolean {
  return normalizeAppleWww(requestedUrl).includes(normalizeAppleWww(pattern));
}

function normalizeAppleWww(value: string): string {
  return value.replace(/^(https?:\/\/)www\./iu, "$1");
}
