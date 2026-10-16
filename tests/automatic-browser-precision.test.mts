import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { generatedIosSafariGuard } from "../scripts/generate-ios-safari-guard.mjs";
import { defaultState } from "../src/defaults.js";
import { baselinePolicy, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";

const sources = [await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), await generatedIosSafariGuard()];
const rules = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8")) as chrome.declarativeNetRequest.Rule[];
const staticRule = rules.find(rule => rule.id === 4)!;
const staticSearchMatchers = rules.filter(rule => rule.id === 4 || rule.id >= 7).map(rule => new RegExp(rule.condition.regexFilter!, "i"));
const staticSearch = { test: (url: string) => staticSearchMatchers.some(matcher => matcher.test(url)) };
assert.equal(staticRule.priority, 1_000);
assert.deepEqual(staticRule.action, { type: "redirect", redirect: { extensionPath: "/blocked.html" } });
assert.deepEqual(staticRule.condition.resourceTypes, ["main_frame", "sub_frame"]);
assert.deepEqual(rules.filter(rule => rule.id < 7).map(rule => rule.id).sort(), [1, 2, 3, 4, 5, 6], "precision changes retain the complete existing SafeSearch and explicit-domain ruleset");

class SearchInput {
  readonly tagName = "INPUT";
  constructor(readonly value: string) {}
  getAttribute(name: string): string | null { return name === "type" ? "search" : name === "name" ? "q" : null; }
  closest(): null { return null; }
}
function page(source: string, url: string) {
  const redirects: string[] = [];
  const listeners = new Map<string, (event: unknown) => void>();
  const location = { href: url, replace: (target: string) => redirects.push(target), assign: (target: string) => redirects.push(target) };
  let tick = () => {};
  runInNewContext(source, {
    URL, URLSearchParams, location, Element: SearchInput,
    document: { title: "Ordinary catalog", readyState: "loading", addEventListener() {}, querySelectorAll: () => [], querySelector: () => null },
    chrome: { runtime: { getURL: () => "extension-test://blocked.html" } },
    browser: { runtime: { getURL: () => "extension-test://blocked.html" } },
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, callback),
    setInterval: (callback: () => void) => { tick = callback; }
  });
  return { redirects, listeners, location, tick: () => tick() };
}
const ordinary = [
  "Sporn dog harness", "Caporn family history", "SKU-RULE34567", "webcam480 driver", "AbcHentai90XZ",
  "dbNSFWfile88123", "account_onlyfanshash_04", "Project118plus build", "Nissan R34 photos", "Nissan Skyline R34 tuning",
  "18+", "18%252B", "18+ travel insurance", "18+ voting eligibility", "Chapter XXX", "Super Bowl XXX videos", "Chapter XXX videos",
  "sex education reddit", "sexual health reddit", "nude lipstick pinterest", "uncensored interview Reddit",
  "naked mole rat photos", "Sex Pistols gallery", "pornography law history", "pornography prevention research",
  "adult education video", "banana cream pie video", "manhwa", "manhua", "manga", "webtoon", "mawha",
  "top 18 manga", "read 18 comics", "chapter 18 manga", "top18manga", "read18comics", "chapter18manga"
];
const explicit = [
  "porn videos", "hentai comics", "nsfw photos", "onlyfans leaks", "honeytoon", "toongod",
  "mature manhwa", "adult webtoon", "uncensored manhua", "xxx videos", "r34 comics", "18+ manga", "r18 manga", "naked girls photos",
  "sex education porn videos", "Nissan R34 hentai comics", "Chapter XXX porn photos", "nude lipstick naked girls",
  "pornography law porn videos", "p.o.r.n videos", "ｐｏｒｎ videos", "%2570%256f%2572%256e videos"
];
const state = defaultState();
const profile = baselinePolicy(state)!.profile;
const urlFor = (query: string, host = "catalog.example") => `https://${host}/search?q=${encodeURIComponent(query)}&safe=active`;
for (const source of sources) {
  for (const [queries, blocked] of [[ordinary, false], [explicit, true]] as const) {
    for (const query of queries) {
      const url = urlFor(query);
      assert.equal(shouldBlockUrl(profile, url), blocked, `automatic native search: ${query}`);
      assert.equal(page(source, url).redirects.length > 0, blocked, `browser navigation: ${query}`);
      const inputPage = page(source, "https://catalog.example/");
      let cancelled = false;
      inputPage.listeners.get("keydown")!({ type: "keydown", key: "Enter", target: new SearchInput(query), cancelable: true,
        preventDefault() { cancelled = true; }, stopImmediatePropagation() {} });
      assert.equal(cancelled, blocked, `browser input: ${query}`);
      assert.equal(inputPage.redirects.length > 0, blocked, `browser input redirect: ${query}`);
      const spa = page(source, "https://catalog.example/");
      spa.location.href = url; spa.tick();
      assert.equal(spa.redirects.length > 0, blocked, `browser SPA search: ${query}`);
      if (!blocked) assert.equal(staticSearch.test(url), false, `network rules must not preempt ordinary intent: ${query}`);
    }
  }
  for (const query of ["sex education", "sexual health", "nude lipstick", "uncensored interview", "Nissan R34 photos", "Chapter XXX"]) {
    assert.equal(page(source, urlFor(query, "www.reddit.com")).redirects.length, 0, `ordinary platform search: ${query}`);
  }
  for (const path of ["/sex-pistols-gallery", "/naked-mole-rat-photos", "/pornography-law-history", "/nsfw-api-reference"]) {
    assert.equal(page(source, "https://catalog.example" + path).redirects.length, 0, `ordinary meaningful route: ${path}`);
  }
  for (const name of ["mode", "p", "k", "s"]) {
    const url = `https://ordinary.example/auth?${name}=xxx&state=ordinary-authentication`;
    assert.equal(shouldBlockUrl(profile, url), false, "ordinary configuration field: " + url);
    assert.equal(page(source, url).redirects.length, 0);
    assert.equal(staticSearch.test(url), false);
  }
  for (const url of ["https://search.yahoo.com/?p=porn", "https://www.pixiv.net/ranking.php?mode=r18", "https://catalog.example/search?mode=naked+girls"]) {
    assert.equal(shouldBlockUrl(profile, url), true, "declared discovery context: " + url);
    assert.equal(page(source, url).redirects.length > 0, true);
  }
}
for (const query of ["porn", "explicit porn query", "prno", "p0rn", "hentai comics", "nsfw photos", "onlyfans leaks", "18+ videos", "xxx videos", "r34 comics"]) {
  assert.equal(staticSearch.test(urlFor(query)), true, `conservative network deny retains clear explicit searches: ${query}`);
}
for (const url of [
  "https://catalog.example/search?q=%70%6f%72%6e",
  "https://catalog.example/search?q=%50%4f%52%4e",
  "https://catalog.example/search?q=%70%6f%72%6e+videos"
]) assert.equal(staticSearch.test(url), true, "encoded whole-word explicit search remains blocked before page scripts: " + url);
for (const url of [
  "https://catalog.example/release-notes&tag=xxx",
  "https://catalog.example/login?return=https://catalog.example/search?q=porn",
  "https://catalog.example/search?q=ordinary&tracking=https://catalog.example/search?q=xxx",
  "https://catalog.example/login?return=https%3A%2F%2Fcatalog.example%2Fsearch%3Fq%3Dporn"
]) {
  assert.equal(staticSearch.test(url), false, "static search rules parse actual query fields, not mentioned addresses: " + url);
  assert.equal(shouldBlockUrl(profile, url), false, "ordinary URL scaffolding retains server parity: " + url);
}
for (const url of [
  "https://catalog.example/search?tracking=ordinary&q=porn",
  "https://catalog.example/login?return=https://catalog.example/search&q=porn",
  "https://catalog.example/search?q=ordinary&tracking=anything&q=xxx"
]) assert.equal(staticSearch.test(url), true, "an actual outer query field retains static enforcement: " + url);
for (const domain of ["theblank.net", "comicland.org", "manhwaread.com", "manhwaread.org"]) {
  assert.equal(shouldBlockSite(profile, domain), true, `verified adult domain survives automatic vocabulary precision: ${domain}`);
}
for (const pattern of ["porn", "manhwa"]) {
  const authored = { ...profile, id: "authored-precision-control", blockedSites: [], blockedUrlPatterns: [pattern] };
  assert.equal(shouldBlockUrl(authored, `https://catalog.example/?opaque=abc${pattern}12`), true,
    "precision does not rewrite an authored literal restriction: " + pattern);
}
console.log("Automatic browser/server/DNR precision passed: whole-word explicit controls, contextual mixtures, ordinary names/topics/IDs, encoded searches and authored/curated restrictions.");
