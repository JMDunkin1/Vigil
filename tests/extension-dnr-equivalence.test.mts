import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type Rule = { id: number; priority: number; action: Record<string, unknown>; condition: { regexFilter?: string; [key: string]: unknown } };
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = JSON.parse(await readFile(join(projectRoot, "tests/fixtures/extension-dnr-contextual-base.json"), "utf8")) as { searchBaseRef: string; searchMetadataRef: string; search: Rule[]; reddit: Rule[] };
assert.equal(baseline.searchBaseRef, "296c5e6648b5c0d917b6c524e3d449ede2575b0a", "search equivalence uses the contextual matcher at the actual change-set base");
assert.equal(baseline.searchMetadataRef, "3258db6d354f2d6253056528b76215287c2e146f", "search enforcement metadata retains the delivery base's top-level and embedded frame coverage");
const search: Rule[] = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8"));
const reddit: Rule[] = JSON.parse(await readFile(new URL("../extension/reddit-navigation-rules.json", import.meta.url), "utf8"));
const explicit = search.filter(rule => rule.id === 4 || rule.id >= 7);
const redditPartitions = reddit.filter(rule => rule.id === 1 || rule.id >= 4);
const metadata = (rule: Rule) => ({ priority: rule.priority, action: rule.action, condition: { ...rule.condition, regexFilter: undefined } });
for (const rule of search) assert.deepEqual(rule.condition.resourceTypes, ["main_frame", "sub_frame"], `every generated search rule and partition preserves both frame types: rule ${rule.id}`);
for (const rule of explicit) assert.deepEqual(metadata(rule), metadata(baseline.search[3]!), "partitioning cannot change priority, redirect, frame coverage or case behavior");
for (const rule of redditPartitions) assert.deepEqual(metadata(rule), metadata(baseline.reddit[0]!), "Reddit partitions must preserve the original rule's enforcement metadata");
for (const id of [1, 2, 3, 5, 6]) assert.deepEqual(search.find(rule => rule.id === id), baseline.search.find(rule => rule.id === id), `unaffected search rule ${id}`);
for (const id of [2, 3]) assert.deepEqual(reddit.find(rule => rule.id === id), baseline.reddit.find(rule => rule.id === id), `unaffected Reddit rule ${id}`);
for (const rules of [search, reddit]) assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length, "partition IDs must be unique within each ruleset");
assert.ok([...search, ...reddit].filter(rule => rule.condition.regexFilter).length < 1000);

const originalSearch = new RegExp(baseline.search[3]!.condition.regexFilter!, "i");
const searchMatchers = explicit.map(rule => new RegExp(rule.condition.regexFilter!, "i"));
const partitionedSearch = { test: (url: string) => searchMatchers.some(matcher => matcher.test(url)) };
// DNR sees canonical, escaped HTTP(S) network URLs without fragments. Redirects
// also require the manifest's HTTP(S) host permissions. Compare both matchers
// on that execution contract rather than treating invalid raw strings as URLs.
const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8")) as { host_permissions: string[] };
assert.ok(manifest.host_permissions.includes("http://*/*") && manifest.host_permissions.includes("https://*/*"));
assert.ok(manifest.host_permissions.every(permission => /^https?:\/\//u.test(permission)), "canonical search redirects remain scoped to HTTP(S)");
const networkUrl = (input: string): string => {
  const url = new URL(input);
  assert.ok(url.protocol === "http:" || url.protocol === "https:");
  url.hash = "";
  return url.href;
};
const fields = "q query search_query search searchterm search_term keyword keywords term text p k s wd word tags tag unknown query_extra".split(" ");
const terms = "porn porno prno p0rn nsfw hentai rule34 gonewild onlyfans fansly chaturbate stripchat cam4 redtube youporn spankbang xvideos xnxx xhamster xxx r_34 r..34 r-34 s3x nud nuds nud3 nud3s".split(" ");
const atoms = "sex s3x nud nude nudes nuds nud3 nud3s porn p0rn r34 nsfw".split(" ");
const values = new Set([...terms, "18%2b", "18+", "18plus", "18-plus", "ordinary", "x34", "xxxtentacion", "nudging", "SKU-R34567"]);
for (const a of atoms) for (const b of atoms) values.add(a + b);
for (const a of atoms.slice(0, 4)) for (const b of atoms) for (const c of atoms.slice(-3)) values.add(a + b + c);
let comparisons = 0;
const compareSearch = (url: string) => {
  const request = networkUrl(url);
  assert.equal(partitionedSearch.test(request), originalSearch.test(request), `search coverage changed: ${url}`);
  comparisons += 1;
};
for (const field of fields) for (const value of values) {
  for (const prefix of ["", "abc+", "abc%20", "abc%2b", "abc%2d", "abc%5f", "abc_", "abc%2520", "abc%"]) {
    compareSearch(`https://catalog.example/search?${field}=${prefix}${value}`);
    compareSearch(`http://sub.catalog.example:8443/path?other=1&${field}=${prefix}${value}&after=2`);
  }
  for (const suffix of ["videos", "video", "photos", "photo", "pics", "pic", "porn", "x", "_", "%20next", "#fragment"]) {
    compareSearch(`https://catalog.example/find?${field}=${value}${suffix}`);
  }
}
for (const url of ["https://catalog.example/", "https://catalog.example/?q=ordinary&other=porn", "https://catalog.example/#?q=porn", "https://catalog.example?q=porn", "HTTPS://CATALOG.EXAMPLE/SEARCH?QUERY=NUDESNSFW", "https://catalog.example/?q=nud&after=1", "https://catalog.example/?tags=xxxporn"]) compareSearch(url);
for (const [query, expected] of [
  ["18%2B", false], ["18%2B+travel+insurance", false], ["pornography+blocker", false], ["chapter+xxx", false],
  ["18%2B+videos", true], ["pornography+videos", true], ["xxx+videos", true], ["free pornography search", true]
] as const) {
  const request = networkUrl(`https://www.google.com/search?q=${query}`);
  assert.equal(originalSearch.test(request), expected, `base contextual intent: ${query}`);
  assert.equal(partitionedSearch.test(request), expected, `partitioned contextual intent: ${query}`);
}
for (const field of fields) for (const prefix of ["", "free+", "explicit%20", "hardcore%2B", "watch_", "read."]) {
  for (const term of ["pornography", "pornographic", "pornstars", "%70%6f%72%6e", "%50%4F%52%4E", "sexsex", "nudesnsfw", "p0rnr34nud", "xxx", "r_34", "s_3_x", "adult", "18%2b"]) {
    for (const suffix of ["", "+query", "%20search", "+videos", "%2Bmanga", "_blocker", "+law+history"]) {
      compareSearch(`https://catalog.example/search?before=ordinary&${field}=${prefix}${term}${suffix}&after=2`);
    }
  }
}
for (const url of [
  "https://catalog.example/release-notes&tag=xxx",
  "https://catalog.example/login?return=https://catalog.example/search?q=porn",
  "https://catalog.example/search?q=ordinary&tracking=https://catalog.example/search?q=xxx",
  "https://catalog.example/search?q=ordinary#&q=porn",
  "https://catalog.example/search?other=porn#?q=xxx"
]) {
  assert.equal(partitionedSearch.test(networkUrl(url)), false, `metadata and fragments cannot become search fields: ${url}`);
  compareSearch(url);
}

const oldReddit = new RegExp(baseline.reddit[0]!.condition.regexFilter!, "i");
const redditMatchers = redditPartitions.map(rule => new RegExp(rule.condition.regexFilter!, "i"));
const routes = "search user u gallery subreddits over18 api message chat best hot new top controversial rising login register ordinary comments".split(" ");
for (const host of ["reddit.com", "www.reddit.com", "old.reddit.com", "sub.old.reddit.com", "reddit.com.evil.example", "notreddit.com"]) {
  for (const scheme of ["http", "https"]) for (const port of ["", ":8443"]) {
    const paths = ["/", "/?home=1", "/#home", "/r/reviews", "/r/reviews/", "/r/reviews/?sort=top", "/r/reviews/comments/abc123/", "/comments/abc123/"];
    for (const route of routes) for (const ending of ["", "/", "?q=kettle", ".json", "#section", "-extra"]) paths.push("/" + route + ending);
    for (const path of paths) {
      const url = `${scheme}://${host}${port}${path}`;
      assert.equal(redditMatchers.some(regex => regex.test(url)), oldReddit.test(url), `Reddit routing changed: ${url}`);
      comparisons += 1;
    }
  }
}
console.log(`DNR partition coverage and unchanged enforcement metadata passed: ${comparisons} canonical request comparisons.`);
