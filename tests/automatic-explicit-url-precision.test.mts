import assert from "node:assert/strict";
import { defaultState, DEFAULT_EXPLICIT_URL_PATTERNS } from "../src/defaults.js";
import { matchAdultBlocklistHost } from "../src/adultBlocklist.js";
import { matchGeneratedPresetUrlPattern, usesAutomaticExplicitUrlPolicy } from "../src/automaticExplicitUrlPolicy.js";
import { matchBlockedUrlPattern, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";

const state = defaultState();
const profile = state.profiles.find(candidate => candidate.id === state.settings.baselineProfileId)!;
for (const preset of state.profiles) assert.equal(usesAutomaticExplicitUrlPolicy(preset), true, preset.id);

const ordinary = [
  "https://actioncam4k.example/support",
  "https://docs.example/download/backup-123porn789.bin",
  "https://ordinary.example/login?state=aaahentai432ccc",
  "https://ordinary.example/api?sig=z8p0rn9w",
  "https://ordinary.example/?token=honeytoon89234auth",
  "https://ordinary.example/view?id=ab18plus9cd",
  "https://ordinary.example/watch?v=anxnxxkQ1234",
  "https://www.google.com/search?q=18%2B5",
  "https://reader.example/chapter/18-plus-5-is-23",
  "https://docs.example/article/pornographic-content-moderation-research",
  "https://ordinary.example/tools/notporn-analysis",
  "https://docs.example/?state=amanhwa213b",
  "https://ordinary.example/?status=mature&webtoon=disabled",
  "https://ordinary.example/api?utm_campaign=nsfw-training",
  "https://ordinary.example/?utm_campaign=honeytoon-research",
  "https://www.google.com/search?q=Nissan+R34+repair",
  "https://www.google.com/search?q=Chapter+XXX+summary",
  "https://www.google.com/search?q=XXX+chromosome+research",
  "https://www.google.com/search?q=Rule+34+algorithm",
  "https://www.google.com/search?q=cam4k+camera+manual",
  "https://ordinary.example/search?q=pornographic+content+moderation+research",
  "https://ordinary.example/?q=adult+education+video",
  "https://ordinary.example/?q=nude+lipstick+photos",
  "https://ordinary.example/?q=uncensored+interview+video",
  "https://ordinary.example/?q=NSFW+filter+configuration",
  "https://notwebtoons.com/docs",
  "https://docs.example/reports/webtoons.com-api.md",
  "https://docs.example/reports?source=https%3A%2F%2Fwebtoons.com",
  "https://findmyhotkey.com.example.org/",
  "https://notreddit.com/over18",
  "https://ordinary.example/docs?source=reddit.com%2Fr%2Fporn",
  "https://www.google.com/search?q=manhwa",
  "https://www.google.com/search?q=mawha",
  "https://www.google.com/search?q=manga+history",
  "https://ordinary.example/library/manhwa/chapter/1",
  "https://ordinary.example/#abc-hentai-123-token",
  "https://ordinary.example/?mode=xxx&state=ordinary-authentication"
];
for (const url of ordinary) {
  assert.equal(matchBlockedUrlPattern(profile, url), null, `automatic rules must not reinterpret ordinary URL components: ${url}`);
}

const explicit = [
  "https://porn-reader.example/catalog",
  "https://ordinary.example/artifacts/p-o-r-n-checkpoint.json",
  "https://reader.example/category/porn-videos",
  "https://reader.example/category/%2570%256f%2572%256e",
  "https://ordinary.example/search?q=hentai+manga",
  "https://ordinary.example/search?q=adult+webtoon",
  "https://ordinary.example/search?q=mature+manhwa",
  "https://ordinary.example/search?q=xxx+videos",
  "https://ordinary.example/search?q=R34+comics",
  "https://ordinary.example/search?q=Rule+34+porn",
  "https://ordinary.example/search?q=18%2B+adult+videos",
  "https://ordinary.example/search?q=honeytoon",
  "https://ordinary.example/search?q=toongod",
  "https://ordinary.example/#/search/hentai",
  "https://reader.example/genres/uncensored-manhwa",
  "https://webtoons.com/",
  "https://reader.webtoons.com./",
  "https://findmyhotkey.com/"
];
for (const url of explicit) assert.equal(shouldBlockUrl(profile, url), true, `clear explicit or permanent preset destination: ${url}`);

for (const host of ["theblank.net", "manhwaread.com", "cam4.com", "xnxx.com"]) {
  assert.equal(shouldBlockSite(profile, host), true, `verified adult-site rule remains authoritative: ${host}`);
}
for (const host of ["cam4.com", "xnxx.com"]) {
  assert.ok(matchAdultBlocklistHost(state, host), `built-in adult-domain protection remains intact: ${host}`);
}

for (const id of ["normal", "default", "personal-custom"]) {
  for (const dictionary of [["cam4"], ["porn", "onlyfans"], ["manhwa"], ["token=xxx"]]) {
    const authored = { ...profile, id, blockedUrlPatterns: dictionary };
    assert.equal(usesAutomaticExplicitUrlPolicy(authored), false, "short authored dictionaries cannot opt in by vocabulary membership");
    const target = dictionary[0] === "cam4" ? ordinary[0]
      : dictionary[0] === "porn" ? ordinary[1]
      : dictionary[0] === "manhwa" ? "https://ordinary.example/?token=abmanhwa123"
      : "https://ordinary.example/?token=xxx";
    assert.equal(shouldBlockUrl(authored, target), true, `authored ${dictionary[0]} literal retains its full-address behavior`);
  }
}
const completeCustom = { ...profile, id: "personal-custom", blockedUrlPatterns: [...DEFAULT_EXPLICIT_URL_PATTERNS] };
assert.equal(usesAutomaticExplicitUrlPolicy(completeCustom), false, "copying generated vocabulary does not turn a custom profile into an automatic preset");
assert.equal(shouldBlockUrl(completeCustom, ordinary[1]), true);
assert.equal(shouldBlockUrl({ ...profile, blockedUrlPatterns: ["porn", "onlyfans"] }, "https://adultcomics.example/"), false,
  "two authored words must not activate a separate automatic semantic classifier");
const withAuthoredRule = { ...profile, blockedUrlPatterns: [...profile.blockedUrlPatterns, "opaque-block-token"] };
assert.equal(shouldBlockUrl(withAuthoredRule, "https://ordinary.example/?state=opaque-block-token"), true,
  "a literal appended to a complete preset remains authoritative outside automatic vocabulary");

for (const [pattern, url, expected] of [
  ["webtoons.com", "https://notwebtoons.com/docs", false],
  ["webtoons.com", "https://reader.webtoons.com./chapter", true],
  ["https://reddit.com/over18", "https://reddit.com/over18-info", false],
  ["https://reddit.com/over18", "https://www.reddit.com/%6fver18/confirm", true],
  ["youtube.com/shorts", "https://youtube.com/shortstory", false],
  ["youtube.com/shorts", "https://youtube.com/%2573horts/abc", true],
  ["reddit.com/search?q=porn", "https://reddit.com/search?state=porn", false],
  ["reddit.com/search?q=porn", "https://reddit.com/search?q=sporn2q", false],
  ["reddit.com/search?q=porn", "https://reddit.com/search?q=porn+videos", true]
] as const) {
  assert.equal(matchGeneratedPresetUrlPattern(pattern, new URL(url)), expected, `generated component boundaries: ${pattern}: ${url}`);
}
assert.equal(matchGeneratedPresetUrlPattern("state=custom", new URL("https://ordinary.example/?state=custom")), null);

console.log(`${ordinary.length} ordinary URLs and ${explicit.length} explicit controls passed; generated destination boundaries and authored literals retained.`);
