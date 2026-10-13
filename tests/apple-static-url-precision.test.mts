import assert from "node:assert/strict";
import { defaultState, DEFAULT_EXPLICIT_BLOCKED_SITES } from "../src/defaults.js";
import { iosPolicyTargets, buildIosConfigurationProfile } from "../src/iosProfiles.js";
import { safariFilterDenyMatch, safariFilterDenyUrls, buildSafariFilterProfile } from "../src/safariFilter.js";
import { DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, DEFAULT_FILTER_BYPASS_BLOCKED_SITES } from "../src/priorityBlockedDomains.js";
import { parsePlist } from "../src/plist.js";
import { now } from "./test-helpers.mjs";

// Apple documents literal substring matching, with a special terminal slash
// matching the route root and its descendants. This tests explicit list entries,
// not Apple's separate automatic adult classifier.
function appleLiteralMatch(url: string, pattern: string): boolean {
  const value = url.toLowerCase().replace(/(https?:\/\/)www\./gu, "$1");
  const target = pattern.toLowerCase().replace(/(https?:\/\/)www\./gu, "$1");
  if (value.includes(target)) return true;
  if (!target.endsWith("/")) return false;
  const root = target.slice(0, -1);
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`${escaped}(?:$|[?#])`, "u").test(value);
}
const state = defaultState();
state.settings.adultBlocklistEnabled = false;
state.deviceControls.ios.enabled = true;
const phone = iosPolicyTargets(state, now);
const phoneDenies = [...phone.deniedUrls, ...phone.supplementalDeniedUrls];
const macDenies = safariFilterDenyUrls(state, now);
for (const list of [phoneDenies, macDenies]) {
  for (const domain of [...DEFAULT_EXPLICIT_BLOCKED_SITES, ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES, ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES]) {
    assert.ok(list.includes(`https://${domain}/`), `retain verified deny ${domain}`);
  }
  for (const query of ["18%2B", "xxx", "porn", "manhwa", "manga", "webtoon"]) {
    assert.equal(list.some(url => url.toLowerCase() === `https://www.google.com/search?q=${query}`.toLowerCase()), false, query);
  }
  for (const ordinary of [
    "https://www.google.com/search?q=Pornichet", "https://www.google.com/search?q=18%2B+birthday+ideas",
    "https://www.google.com/search?q=XXX+Super+Bowl", "https://www.google.com/search?q=manhwa+translation+software"
  ]) assert.equal(list.some(pattern => appleLiteralMatch(ordinary, pattern)), false, ordinary);
  assert.ok(list.some(pattern => appleLiteralMatch("https://youtube.com/shorts", pattern)), "route root remains denied");
  assert.ok(list.some(pattern => appleLiteralMatch("https://youtube.com/shorts/video-id", pattern)), "route subtree remains denied");
  assert.equal(list.some(pattern => appleLiteralMatch("https://youtube.com/shortstop", pattern)), false, "ordinary sibling route remains usable");
}
for (const query of ["porn+videos", "porn%20photos", "hentai+manga", "xxx+videos", "18%2B+adult+videos"]) {
  assert.ok(phoneDenies.some(pattern => appleLiteralMatch(`https://www.google.com/search?q=${query}`, pattern)), query);
}
assert.ok(phone.deniedUrls.length <= 500 && phone.supplementalDeniedUrls.length <= 500);
assert.ok(safariFilterDenyMatch(state, "https://www.youtube.com/shorts", now));
assert.ok(safariFilterDenyMatch(state, "https://www.youtube.com/shorts?id=one", now));
assert.equal(safariFilterDenyMatch(state, "https://www.youtube.com/shortstop", now), "");
const mac = buildSafariFilterProfile(state, now);
assert.match(mac, /PayloadRemovalDisallowed<\/key>\s*<true\/>/u);
assert.match(mac, /useContentFilter<\/key>\s*<true\/>/u);
const profile = parsePlist(buildIosConfigurationProfile(state, now)) as { PayloadRemovalDisallowed: boolean; PayloadContent: Array<Record<string, unknown>> };
assert.equal(profile.PayloadRemovalDisallowed, true);
for (const payload of profile.PayloadContent.filter(value => value.PayloadType === "com.apple.webcontent-filter")) {
  assert.equal(payload.FilterType, "BuiltIn"); assert.equal(payload.AutoFilterEnabled, true);
}

// A short authored dictionary does not become automatic merely because it
// shares a default term or route. Preserve those literal-prefix choices.
const custom = { ...state.profiles[0], id: "authored-static-precision", blockedSites: [], blockedUrlPatterns: [
  "precision.example/path", "https://www.google.com/search?q=18%2B", "https://www.google.com/search?q=xxx", "porn"
] };
state.profiles.push(custom);
const session = { id: "authored-static", title: "Authored", mode: "focus", profileId: custom.id, lockLevel: "deep" as const,
  startedAt: now.toISOString(), endsAt: new Date(now.getTime() + 60_000).toISOString(), canEndEarly: false,
  source: "manual", deviceTargets: ["computer", "phone"] as Array<"computer" | "phone">, profileSnapshot: custom };
state.activeSessions.phone = session; state.activeSessions.computer = session; state.activeSession = session;
const authoredPhone = iosPolicyTargets(state, now).deniedUrls;
const authoredMac = safariFilterDenyUrls(state, now);
for (const list of [authoredPhone, authoredMac]) {
  assert.ok(list.includes("https://precision.example/path"));
  assert.ok(list.some(pattern => appleLiteralMatch("https://precision.example/pathology", pattern)), "authored literal prefix remains literal");
  assert.ok(list.some(pattern => appleLiteralMatch("https://www.google.com/search?q=18%2B+birthday", pattern)), "authored age prefix remains literal");
  assert.ok(list.some(pattern => appleLiteralMatch("https://www.google.com/search?q=xxx+chapter", pattern)), "authored XXX prefix remains literal");
}
assert.ok(authoredPhone.includes("https://www.google.com/search?q=porn"), "authored keyword export retains prior meaning");
console.log("Apple exports preserve domains, restrictions and authored literals; automatic phrases and routes are bounded.");
