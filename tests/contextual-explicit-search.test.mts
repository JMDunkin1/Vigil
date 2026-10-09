import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { matchContextualExplicitSearchUrl } from "../src/contextualExplicitSearch.js";
import { defaultState } from "../src/defaults.js";
import { baselinePolicy, matchBlockedUrlPattern } from "../src/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { shouldBlockUrl } from "../src/policy.js";

const platforms = ["x.com", "twitter.com", "bsky.app", "pixiv.net", "patreon.com", "itch.io", "creator.itch.io", "discord.com", "discordapp.com", "saatchiart.com", "fineartamerica.com", "flickr.com", "500px.com"];
const blocked = [
  "https://www.saatchiart.com/en-nl/paintings/nude",
  "https://fineartamerica.com/art/paintings/nude",
  "https://500px.com/galleries/erotic",
  "https://www.flickr.com/collections/adult-content",
  ...["ArtMajeur", "Inkbunny", "SoFurry", "Weasyl", "Fur Affinity", "Saatchi Art", "Fine Art America", "Flickr", "500px"].map(name => `https://www.google.com/search?q=${encodeURIComponent(`${name} nude art`)}`),
  ...["X rated", "x-rated documentary", "XX_rated", "XXXX–rated", "rated X", "ｘ ｒａｔｅｄ", "x\u200brated",
    "adult videos", "adult vids", "vids for adults", "videos adult", "spicy clips", "spicy adult", "cream pie videos", "creampie compilation", "cream-pie spicy", "xx vids", "x videos",
    "nude videos", "naked photos", "nudity compilation", "erotic films", "lewd pictures", "spicy steamy", "uncensored nude", "mature erotic clips", "naked cream pie", "nude ＶＩＤＥＯＳ"
  ].flatMap(q => ["catalog.example", "www.google.com", "www.reddit.com"].map(host => `https://${host}/search?q=${encodeURIComponent(q)}`)),
  "https://catalog.example/search.php/x-rated",
  "https://catalog.example/#/search/cream%20pie%20videos",
  "https://catalog.example/?q=%2578%2520rated",
  ...platforms.flatMap(host => ["nude", "erotica", "R-18", "adult content", "%2573%2565%2578"].map(q => `https://${host}/search?q=${encodeURIComponent(q)}`)),
  "https://www.pixiv.net/ranking.php?mode=r18",
  "https://www.pixiv.net/en/tags/R-18/artworks",
  "https://www.pixiv.net/novel/tags/R-18/novels",
  "https://itch.io/games/tag-erotica",
  "https://itch.io/games/tag-adult",
  "https://itch.io/games/tag-adult-content",
  "https://bsky.app/hashtag/nsfw",
  "https://www.google.com/search?q=bluesky+erotica",
  "https://www.google.com/search?q=site%3Ax.com+nude",
  ...["r34", "R34", "r_34", "rule 34", "s3x", "s.3.x", "nud", "nuds", "nud3s", "s3xnud", "nudsex", "pornnudes", "p.o.r.n", "ｒ３４", "r​34", "%2572%2533%2534"].flatMap(q => ["www.reddit.com", "www.google.com"].map(host => `https://${host}/search?q=${encodeURIComponent(q)}`)),
  "https://www.reddit.com/search/?q=sex",
  ...["x", "xx", "X", "%2578%2578", "ｘ", "x%E2%80%8Bx", "adult+video", "adult+videos", "unreviewed+videos", "xx+videos"].map(q => `https://www.reddit.com/search?q=${q}`),
  "https://old.reddit.com/r/gardening/search.json?q=x",
  "https://www.reddit.com/search?q=gardening&q=xx",
  "https://old.reddit.com/r/Art/search/?sort=new&q=adult+content",
  "https://www.reddit.com/search?q=%2573%2565%2578",
  "https://www.reddit.com/r/sex/",
  "https://www.artstation.com/search?query=sexual+art&sort_by=relevance",
  "https://www.pixiv.net/en/tags/成人/artworks?word=sex",
  "https://www.pixiv.net/en/tags/nudity/artworks",
  "https://www.behance.net/search/projects?search=adult%20content",
  "https://www.tumblr.com/tagged/erotic",
  "https://www.pinterest.com/#/search/nude",
  "https://www.google.com/search?q=sex+on+reddit",
  "https://www.google.com/search?q=artstation+adult+content",
  "https://www.google.com/search?q=site%3Areddit.com+sex",
  "https://search.example/?q=adult+content+on+pixiv"
];
const allowed = [
  "https://www.saatchiart.com/en-nl/paintings/landscape",
  "https://fineartamerica.com/art/paintings/flowers",
  "https://500px.com/galleries/architecture",
  "https://www.flickr.com/collections/gardening",
  ...["spicy", "cream pie", "creampie", "banana cream pie recipe video", "spicy chicken videos", "adult education video", "video editing for adult learning", "Model X video", "X-Men film", "X Files documentary", "spicy recipe clips", "adult", "vids",
    "nude", "naked", "erotic", "lewd", "steamy", "mature films", "uncensored interview video", "nude makeup videos", "nude figure drawing photos", "nudity anatomy video", "naked mole rat documentary", "naked eye astronomy video", "naked cake video", "spicy recipe steamy clips", "spicy news today. A long unrelated story about gardening has many pictures"
  ].map(q => `https://catalog.example/search?q=${encodeURIComponent(q)}`),
  "https://catalog.example/watch?id=xxxxx&tracking=x-rated",
  "https://catalog.example/article/x-rated",
  ...platforms.flatMap(host => ["Middlesex", "adult education", "SpaceX", "x", "landscapes"].map(q => `https://${host}/search?q=${encodeURIComponent(q)}`)),
  "https://discord.com/channels/123456/654321",
  "https://bsky.app/profile/gardener.example/post/abcdef",
  "https://www.patreon.com/posts/garden-123456",
  "https://itch.io/games/tag-platformer",
  "https://www.pixiv.net/artworks/12345678",
  "https://x.com.example.org/search?q=nude",
  ...["nudging", "nudibranch", "SKU-R34567", "Middlesex"].map(q => `https://www.reddit.com/search?q=${q}`),
  "https://www.google.com/search?q=sex",
  "https://www.google.com/search?q=adult+content",
  "https://www.google.com/search?q=nude+art+figure+drawing",
  "https://health.example/article/sex-education",
  "https://www.reddit.com/search?q=Middlesex",
  ...["Xbox", "SpaceX", "X-Men", "x+axis", "Model+X", "adult+education", "video+editing"].map(q => `https://www.reddit.com/search?q=${q}`),
  "https://www.google.com/search?q=x",
  "https://www.reddit.com.example.org/search?q=xx",
  "https://www.reddit.com/r/gardening/comments/abc/x/",
  "https://www.reddit.com/search?q=sextant",
  "https://www.reddit.com/search?q=sexuality",
  "https://www.artstation.com/search?query=landscapes",
  "https://www.artstation.com/about?notice=adult+content",
  "https://www.reddit.com/comments/123/article-about-sex",
  "https://www.reddit.com.example.org/search?q=sex",
  "https://notreddit.com/search?q=adult+content",
  "https://search.example/?q=redditish+sex",
  "https://example.com/search?q=sex&ref=reddit",
  "file:///search?q=reddit+sex"
];
const state = defaultState();
const profile = baselinePolicy(state)!.profile;
const context = createContext({
  URL, URLSearchParams, location: { href: "https://example.org/", replace() {} },
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } },
  addEventListener() {}
});
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), context);
for (const [expected, urls] of [[true, blocked], [false, allowed]] as const) {
  for (const url of urls) {
    assert.equal(matchContextualExplicitSearchUrl(url), expected, url);
    assert.equal(matchBlockedUrlPattern(profile, url)?.pattern === "contextual-explicit-search", expected, url);
    assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), expected, url);
    if (expected) assert.equal(evaluateExtensionCheck(state, {}, { url, event: "navigation" }).blocked, true, url);
  }
}
for (const query of ["Jane Example nudes naked eye", "naked cake Jane Example porn", "naked cake nude photos"]) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  assert.equal(shouldBlockUrl(profile, url), true, "an ordinary phrase cannot cancel separate explicit evidence: " + query);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), true, query);
}
runInContext('location.href = "https://www.reddit.com/"', context);
assert.equal(runInContext('containsExplicitSearchText("adult content")', context), true,
  "search-box input must use the current platform before a URL exists");
assert.equal(runInContext('explicitSearchBlockRedirect("https://example.org/search?q=sex")', context), null,
  "outgoing links must use the destination context");
assert.equal(matchBlockedUrlPattern({ ...profile, blockedUrlPatterns: [] }, blocked[0]), null,
  "the matcher belongs to profiles with explicit search protection");

// Exercise the media-label predicate used by the shared Safari/Chrome script.
const mediaSource = await readFile(new URL("../extension/media-child-lock.js", import.meta.url), "utf8");
const titlePredicateSource = `${mediaSource.slice(0, mediaSource.indexOf("  const isX ="))}\nreturn explicitTitle; })();`;
const mixedPredicates = runInNewContext(`${mediaSource.slice(0, mediaSource.indexOf("  const roots ="))}\nreturn { explicitAccount, ageConfirmation, sensitivePreference, adultWarning }; })();`, {
  location: { protocol: "https:", hostname: "bsky.app" }
}) as Record<string, (value: string) => boolean>;
for (const account of ["ArtistNSFW", "ArtistXXX", "ArtistOnlyFans", "ArtistＸＸＸ", "ArtistX​XX"]) assert.equal(mixedPredicates.explicitAccount(account), true, account);
for (const account of ["SpaceX", "MiddlesexGardens", "NudibranchArtist"]) assert.equal(mixedPredicates.explicitAccount(account), false, account);
for (const label of ["I am over 18", "Yes, I'm eighteen", "I am 18 or older"]) assert.equal(mixedPredicates.ageConfirmation(label), true, label);
for (const label of ["Show sensitive content", "Blur nudity", "Adult content Hide Warn Show", "Safe Search"]) assert.equal(mixedPredicates.sensitivePreference(label), true, label);
for (const label of ["Age-restricted channel", "Sexually suggestive", "R-18", "Adult content"]) assert.equal(mixedPredicates.adultWarning(label), true, label);
for (const label of ["Adult education", "Show comments", "Show spoiler", "Chapter XVIII"]) {
  assert.equal(mixedPredicates.adultWarning(label), false, label);
  assert.equal(mixedPredicates.sensitivePreference(label), false, label);
}
for (const hostname of ["www.reddit.com", "www.artstation.com", "www.pixiv.net", "www.behance.net", ...platforms]) {
  const explicitTitle = runInNewContext(titlePredicateSource, { location: { protocol: "https:", hostname } }) as (value: string) => boolean;
  for (const term of ["r34", "s3x", "nud", "s3xnud", "pornnudes", "sex", "adult content", "sexual", "erotic", "mature content", "nudity"]) {
    assert.equal(explicitTitle(term), true, `${hostname}: ${term}`);
  }
  for (const term of ["Middlesex landscape", "sextant drawing", "landscape"]) {
    assert.equal(explicitTitle(term), false, `${hostname}: ${term}`);
  }
}
for (const hostname of ["health.example", "news.example", "reddit.com.example.org"]) {
  const explicitTitle = runInNewContext(titlePredicateSource, { location: { protocol: "https:", hostname } }) as (value: string) => boolean;
  for (const term of ["sex education", "adult content", "mature content", "nude", "steamy films", "uncensored interview videos", "nude makeup photos", "nude art videos", "naked mole rat documentary"]) assert.equal(explicitTitle(term), false, `${hostname}: ${term}`);
  for (const term of ["nude videos", "naked photos", "erotic films", "lewd pictures", "uncensored nude", "spicy steamy"]) assert.equal(explicitTitle(term), true, `${hostname}: ${term}`);
  assert.equal(explicitTitle("pornography"), true, "unambiguous protections remain in force");
  assert.equal(explicitTitle("Chapter XXX"), false, "Roman numerals must not hide ordinary media");
  assert.equal(explicitTitle("xxx videos"), true, "explicit phrases remain protected");
}

const staticRules = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8"));
const staticSearchRule = new RegExp(staticRules.find((rule: { id: number }) => rule.id === 4).condition.regexFilter, "i");
for (const url of [
  "https://news.example/articles/xxx-report",
  "https://news.example/article?id=aXXXb&tracking=xxx",
  "https://news.example/history/super-bowl-xxx",
  "https://www.google.com/search?q=axxxb+error+code",
  "https://www.reddit.com/comments/abc/chapter_xxx_review"
]) {
  assert.equal(shouldBlockUrl(profile, url), false, url);
  assert.equal(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context), null, url);
  assert.equal(staticSearchRule.test(url), false, url);
}
for (const url of [
  ...[3, 4, 5, 6, 8, 12].flatMap(count => ["x".repeat(count), `${"x".repeat(count)}vids`].map(q => `https://catalog.example/search?q=${q}`)),
  "https://www.google.com/search?q=xxx",
  "https://www.google.com/search?q=free+xxx+videos",
  "https://www.google.com/search?q=xxxvideos",
  "https://www.google.com/search?q=xxx%20photos"
]) {
  assert.equal(shouldBlockUrl(profile, url), true, url);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), true, url);
  if (!url.includes("catalog.example")) assert.equal(staticSearchRule.test(url), true, url);
}
for (const url of ["https://search.example/search/xxx", "https://search.example/?q=%2578%2578%2578"]) {
  assert.equal(shouldBlockUrl(profile, url), true, url);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), true, url);
}
assert.equal(shouldBlockUrl(profile, "https://example.xxx/"), true, "adult TLD protection remains");
