import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { decodeSearchQueryValue, isProtectedSearchParameter, searchQueries } from "../src/searchQueryContext.js";
import { matchContextualExplicitSearchUrl } from "../src/contextualExplicitSearch.js";

const queryTexts = (url: string) => searchQueries(url).map(({ query }) => query);
assert.deepEqual(queryTexts("https://catalog.example/search/leaks%20pipes"), ["leaks pipes"]);
assert.deepEqual(queryTexts("https://catalog.example/en/search.php/naked%20girls?tracking=naked+girls"), ["naked girls"]);
assert.deepEqual(queryTexts("https://catalog.example/#/search?q=leaks+pipes&tracking=naked+girls"), ["leaks pipes"]);
assert.deepEqual(queryTexts("https://catalog.example/#/search?search%5Bkeyword%5D=naked%20girls"), ["naked girls"]);
assert.deepEqual(queryTexts("https://catalog.example/#/search?q=naked%26girls"), ["naked&girls"], "encoded delimiters stay within one query");
assert.deepEqual(queryTexts("https://catalog.example/watch?q%5B%5D=naked+girls&search%5Bkeyword%5D=naked+girls"), []);
assert.deepEqual(queryTexts("https://catalog.example/#notes?q=naked+girls"), []);
assert.deepEqual(queryTexts("https://catalog.example/search?q=astronomy&q=naked+girls"), ["astronomy", "naked girls"]);
assert.deepEqual(queryTexts("https://catalog.example/search?q%5B%5D=naked&q%5B%5D=girls"), ["naked", "girls"], "independent values do not invent a phrase");
assert.equal(decodeSearchQueryValue("adult%2520videos%25ZZ"), "adult videos%ZZ");
assert.equal(isProtectedSearchParameter("searchQuery"), true);
assert.equal(isProtectedSearchParameter("q[]"), false);
assert.equal(isProtectedSearchParameter("q[]", true), true);
assert.equal(isProtectedSearchParameter("search[keyword]", true), true);
assert.equal(isProtectedSearchParameter("search[tracking]", true), false);
for (const name of ["p", "k", "s", "mode"]) {
  assert.equal(isProtectedSearchParameter(name), false, "ambiguous metadata requires a declared search context: " + name);
  assert.equal(isProtectedSearchParameter(name, true), true);
  assert.deepEqual(queryTexts(`https://ordinary.example/auth?${name}=xxx`), []);
  assert.deepEqual(queryTexts(`https://ordinary.example/search?${name}=porn`), ["porn"]);
}
assert.deepEqual(queryTexts("https://search.yahoo.com/?p=porn"), ["porn"]);
assert.deepEqual(queryTexts("https://www.pixiv.net/ranking.php?mode=r18"), ["r18"]);
assert.deepEqual(queryTexts("https://www.amazon.com/s?k=lingerie+prints"), ["lingerie prints"]);
assert.deepEqual(queryTexts("https://www.ebay.com/sch/i.html?_nkw=mature+poster"), ["mature poster"]);

const blockedURLs = [
  "https://www.amazon.com/s?k=lingerie+prints",
  "https://www.amazon.co.uk/s?k=mature+poster",
  "https://www.ebay.com/sch/i.html?_nkw=lingerie+photo+print",
  "https://www.ebay.co.uk/sch/360/i.html?_nkw=provocative+wall+art",
  ...["word", "tag", "tags", "mode", "searchQuery", "q[]", "search[keyword]"].map(key =>
    `https://catalog.example/search?${encodeURIComponent(key)}=naked+girls`),
  ...["tags", "tagged", "hashtag", "search", "search.php", "results"].map(route =>
    `https://catalog.example/${route}/naked%20girls`),
  "https://catalog.example/#/search?q=naked+girls",
  "https://catalog.example/#!/search?searchQuery=naked+girls",
  "https://catalog.example/#/search?search%5Bkeyword%5D=naked+girls",
  "https://catalog.example/search?q=adult%2520videos%25ZZ"
];
const allowedURLs = [
  "https://www.amazon.com/s?k=family+photo+prints",
  "https://www.ebay.com/sch/i.html?_nkw=Henry+Danger+poster",
  "https://www.amazon.com/ap/signin?k=lingerie+prints",
  "https://www.ebay.com/auth?_nkw=mature+poster",
  "https://www.amazon.com.example.org/s?k=lingerie+prints",
  "https://www.ebay.com.example.org/sch/i.html?_nkw=mature+poster",
  ...["leaks pipes", "leaks aquariums", "naked economics", "naked eye astronomy", "sex education"].flatMap(query => [
    `https://catalog.example/search?q=${encodeURIComponent(query)}`,
    `https://catalog.example/search/${encodeURIComponent(query)}`,
    `https://catalog.example/#/search?q=${encodeURIComponent(query)}`
  ]),
  "https://catalog.example/watch?q%5B%5D=naked+girls&search%5Bkeyword%5D=naked+girls",
  "https://catalog.example/#/search?q=astronomy&tracking=naked+girls",
  "https://catalog.example/search?tracking=naked+girls",
  "https://catalog.example/notes/search-history?notice=naked+girls",
  "https://catalog.example/document/xxx?tracking=naked+girls",
  "https://catalog.example/tags/sex-education"
];
for (const url of blockedURLs) assert.equal(matchContextualExplicitSearchUrl(url), true, url);
for (const url of allowedURLs) assert.equal(matchContextualExplicitSearchUrl(url), false, url);

const projectRoot = process.env.VIGIL_TEST_SOURCE_ROOT || fileURLToPath(new URL("../../../", import.meta.url));
const safariSource = await readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8");
const safariDecision = runInNewContext(`${safariSource.slice(0, safariSource.indexOf("  const allowedEscapeURL ="))}\nreturn decision; })();`, {
  URL, URLSearchParams, location: { href: "https://catalog.example/" }
}) as (url: string, rules: object) => { allowed: boolean };
const rules = { blockedHosts: [], blockedURLFragments: [], blockedSearchTerms: ["porn", "xxx", "sexdoll", "sextoy"], safeSearchEnabled: true };
for (const url of blockedURLs) assert.equal(safariDecision(url, rules).allowed, false, `Safari: ${url}`);
for (const url of allowedURLs) assert.equal(safariDecision(url, rules).allowed, true, `Safari: ${url}`);

const ordinaryQueries = [
  "Sporn dog harness", "Caporn family history", "SKU-RULE34567", "Actioncam4k manual", "AbcHentai90XZ",
  "dbNSFWfile88123", "account_onlyfanshash_04", "Project118plus build", "Nissan R34 photos", "Chapter XXX videos",
  "XXX chromosomes", "sex education reddit", "sexual health reddit", "nude lipstick photos", "naked mole rat photos",
  "nsfw moderation", "nsfw API reference", "pornography law history", "porn blocker detection",
  "adult education video", "manhwa", "manga", "sexdollhouse product", "sextoyota engine",
  "top 18 manga", "read 18 comics", "chapter 18 manga"
];
const explicitQueries = [
  "18+", "18%252B", "18+ travel insurance", "18+ voting eligibility", "18 plus", "eighteen plus",
  "porn", "hentai", "onlyfans", "cam4", "fansly", "toongod", "honeytoon", "xxx", "xxx videos",
  "pornvids", "hentaicomics", "nsfwphotos", "mature manhwa", "adult webtoon", "18+ videos", "18+ manga", "r18 manga",
  "Nissan R34 hentai comics", "Chapter XXX porn photos", "nsfw moderation porn videos",
  "nude lipstick naked girls", "nude videos lipstick", "naked photos eye", "nude photos medical",
  "naked photos research", "xxx videos education", "pornography law porn videos"
];
const precisionURLs: Array<readonly [string, boolean]> = [
  ["https://www.etsy.com/listing/4596079411/neutral-title", true],
  ["https://www.etsy.com/r/similar/250555610/", true],
  ["https://www.etsy.com/%6cisting/4439331570/neutral", true],
  ["https://www.etsy.com.example.org/listing/4596079411/neutral", false],
  ["https://www.etsy.com/listing/45960794110/neutral", false],
  ["https://www.etsy.com/?tracking=4596079411", false],
  ["https://www.ebay.com/sch/i.html?_nkw=abella+danger+prints", true],
  ["https://www.etsy.com/search?q=abella+danger+hot+prints", true],
  ["https://www.ebay.com/sch/i.html?_nkw=henry+danger+prints", false],
  ...ordinaryQueries.map(query => [`https://catalog.example/search?q=${encodeURIComponent(query)}`, false] as const),
  ...explicitQueries.map(query => [`https://catalog.example/search?q=${encodeURIComponent(query)}`, true] as const),
  ...["p", "k", "s", "mode"].map(name => [`https://ordinary.example/auth?${name}=xxx`, false] as const),
  ...["p", "k", "s", "mode"].map(name => [`https://catalog.example/search?${name}=porn`, true] as const),
  ["https://search.yahoo.com/?p=porn", true],
  ["https://search.yahoo.com/?p=Actioncam4k", false],
  ["https://search.yahoo.com.example.org/?p=porn", false],
  ["https://www.pixiv.net/ranking.php?mode=r18", true],
  ["https://www.pixiv.net/auth?mode=r18", false],
  ["https://pixiv.net.example.org/ranking.php?mode=r18", false],
  ...["Chapter XXX videos", "pornographic content moderation research", "nude lipstick photos"].flatMap(query => [
    [`https://catalog.example/search?q=${query.replaceAll(" ", "+")}`, false] as const,
    [`https://catalog.example/search?q=${encodeURIComponent(query)}`, false] as const,
    [`https://catalog.example/#/search?q=${query.replaceAll(" ", "+")}`, false] as const
  ]),
  ...["18%2B+videos", "18%2B%20videos", "mature+manhwa", "mature%20manhwa"].flatMap(query => [
    [`https://catalog.example/search?q=${query}`, true] as const,
    [`https://catalog.example/#/search?q=${query}`, true] as const
  ]),
  ["https://catalog.example/porn/videos", true],
  ["https://catalog.example/onlyfans-leaks", true],
  ["https://catalog.example/products/sex-dolls", true],
  ["https://catalog.example/nude-videos-lipstick", true],
  ["https://catalog.example/naked-photos-eye", true],
  ["https://catalog.example/nude-photos-medical", true],
  ["https://catalog.example/uncensored-interview-nude-photos", true],
  ["https://catalog.example/porno-blocage-hentai", true],
  ["https://catalog.example/pornography/law/18%2B/videos", true],
  ["https://catalog.example/pornography/law/naked/photos", true],
  ["https://catalog.example/nsfw/api/reference/hentai", true],
  ["https://catalog.example/sex-pistols-gallery", false],
  ["https://catalog.example/naked-mole-rat-photos", false],
  ["https://catalog.example/nude-watercolor-palette-photos", false],
  ["https://catalog.example/nude-art-sculpture-photos", false],
  ["https://catalog.example/mature-trees-photos", false],
  ["https://catalog.example/erotic-imagery-art-history", false],
  ["https://catalog.example/pornography/law/history", false],
  ["https://catalog.example/nsfw/api/reference", false],
  ["https://catalog.example/nude/art/sculpture/photos", false],
  ["https://catalog.example/chapter/XXX/images", false],
  ["https://catalog.example/a/b/c/d/hentai", false],
  ["https://catalog.example/?tracking=abcporn12", false]
];
for (const [url, blocked] of precisionURLs) {
  assert.equal(safariDecision(url, rules).allowed, !blocked, `Legacy Safari automatic precision: ${url}`);
}
const authoredRules = { ...rules, blockedSearchTerms: [...rules.blockedSearchTerms, "sporn"] };
assert.equal(safariDecision("https://catalog.example/search?q=Sporn+dog+harness", authoredRules).allowed, false,
  "appended authored search literals retain their intentional substring restriction");
assert.equal(safariDecision("https://catalog.example/?opaque=abcPorn12", {
  ...rules, blockedURLFragments: ["abcporn12"]
}).allowed, false, "authored address fragments remain literal");

if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-search-context-native-"));
  try {
    const mainPath = join(directory, "main.swift");
    const cases = [...blockedURLs.map(url => [url, true] as const), ...allowedURLs.map(url => [url, false] as const), ...precisionURLs];
    const checks = cases.map(([url, expected]) => {
      const base64 = Buffer.from(url).toString("base64");
      return `check(String(data: Data(base64Encoded: "${base64}")!, encoding: .utf8)!, ${expected})`;
    });
    await writeFile(mainPath, `import Foundation
var automaticRules = FilterRules.bootstrap
automaticRules.blockedSearchTerms += ["sexdoll", "sextoy"]
let filter = NavigationFilter(rules: automaticRules)
func check(_ raw: String, _ expected: Bool) {
    let blocked: Bool
    switch filter.decide(URL(string: raw)!) { case .block: blocked = true; case .allow: blocked = false }
    precondition(blocked == expected, "Search-context mismatch: \\(raw)")
}
${checks.join("\n")}
var authoredRules = FilterRules.bootstrap
authoredRules.blockedSearchTerms.append("sporn")
let authoredFilter = NavigationFilter(rules: authoredRules.normalized())
switch authoredFilter.decide(URL(string: "https://catalog.example/search?q=Sporn+dog+harness")!) {
case .block: break
case .allow: preconditionFailure("Appended authored search literal was weakened")
}
authoredRules.blockedURLFragments.append("abcporn12")
let fragmentFilter = NavigationFilter(rules: authoredRules.normalized())
switch fragmentFilter.decide(URL(string: "https://catalog.example/?opaque=abcPorn12")!) {
case .block: break
case .allow: preconditionFailure("Authored address fragment was weakened")
}
print("Native search-route and metadata parity passed.")
`);
    const executable = join(directory, "search-context");
    execFileSync("/usr/bin/xcrun", ["swiftc", join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), mainPath, "-o", executable], { timeout: 60_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log("Search query fields, structured forms, SPA routes, benign scaffolding and metadata isolation passed.");
