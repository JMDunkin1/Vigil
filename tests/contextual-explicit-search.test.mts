import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { matchContextualExplicitSearchUrl } from "../src/contextualExplicitSearch.js";
import { defaultState } from "../src/defaults.js";
import { baselinePolicy, matchBlockedUrlPattern } from "../src/policy.js";
import { evaluateExtensionCheck } from "../src/extensionPolicy.js";
import { shouldBlockUrl } from "../src/policy.js";

const blocked = [
  "https://www.reddit.com/search/?q=sex",
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
  "https://www.google.com/search?q=sex",
  "https://www.google.com/search?q=adult+content",
  "https://www.google.com/search?q=nude+art+figure+drawing",
  "https://health.example/article/sex-education",
  "https://www.reddit.com/search?q=Middlesex",
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
for (const hostname of ["www.reddit.com", "www.artstation.com", "www.pixiv.net", "www.behance.net"]) {
  const explicitTitle = runInNewContext(titlePredicateSource, { location: { protocol: "https:", hostname } }) as (value: string) => boolean;
  for (const term of ["sex", "adult content", "sexual", "erotic", "mature content", "nudity"]) {
    assert.equal(explicitTitle(term), true, `${hostname}: ${term}`);
  }
  for (const term of ["Middlesex landscape", "sextant drawing", "landscape"]) {
    assert.equal(explicitTitle(term), false, `${hostname}: ${term}`);
  }
}
for (const hostname of ["health.example", "news.example", "reddit.com.example.org"]) {
  const explicitTitle = runInNewContext(titlePredicateSource, { location: { protocol: "https:", hostname } }) as (value: string) => boolean;
  for (const term of ["sex education", "adult content", "mature content"]) assert.equal(explicitTitle(term), false, `${hostname}: ${term}`);
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
  "https://www.google.com/search?q=xxx",
  "https://www.google.com/search?q=free+xxx+videos",
  "https://www.google.com/search?q=xxxvideos",
  "https://www.google.com/search?q=xxx%20photos"
]) {
  assert.equal(shouldBlockUrl(profile, url), true, url);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), true, url);
  assert.equal(staticSearchRule.test(url), true, url);
}
for (const url of ["https://search.example/search/xxx", "https://search.example/?q=%2578%2578%2578"]) {
  assert.equal(shouldBlockUrl(profile, url), true, url);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), true, url);
}
assert.equal(shouldBlockUrl(profile, "https://example.xxx/"), true, "adult TLD protection remains");
