import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

type Rule = { id: number; priority: number; action: Record<string, unknown>; condition: { regexFilter?: string; [key: string]: unknown } };
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const baseline = JSON.parse(await readFile(join(projectRoot, "tests/fixtures/extension-dnr-0.3.17.json"), "utf8")) as { search: Rule[]; reddit: Rule[] };
const search: Rule[] = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8"));
const reddit: Rule[] = JSON.parse(await readFile(new URL("../extension/reddit-navigation-rules.json", import.meta.url), "utf8"));
const explicit = search.filter(rule => rule.id === 4 || rule.id >= 7);
const redditPartitions = reddit.filter(rule => rule.id === 1 || rule.id >= 4);
const metadata = (rule: Rule) => ({ priority: rule.priority, action: rule.action, condition: { ...rule.condition, regexFilter: undefined } });
for (const rule of explicit) assert.deepEqual(metadata(rule), metadata(baseline.search[3]!), "partitioning cannot change priority, redirect, frame coverage or case behavior");
for (const rule of redditPartitions) assert.deepEqual(metadata(rule), metadata(baseline.reddit[0]!), "Reddit partitions must preserve the original rule's enforcement metadata");
for (const id of [1, 2, 3, 5, 6]) assert.deepEqual(search.find(rule => rule.id === id), baseline.search.find(rule => rule.id === id), `unaffected search rule ${id}`);
for (const id of [2, 3]) assert.deepEqual(reddit.find(rule => rule.id === id), baseline.reddit.find(rule => rule.id === id), `unaffected Reddit rule ${id}`);
for (const rules of [search, reddit]) assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length, "partition IDs must be unique within each ruleset");
assert.ok([...search, ...reddit].filter(rule => rule.condition.regexFilter).length < 1000);

const originalSearch = new RegExp(baseline.search[3]!.condition.regexFilter!, "i");
const searchMatchers = explicit.map(rule => new RegExp(rule.condition.regexFilter!, "i"));
const fields = "q query search_query search searchterm search_term keyword keywords term text p k s wd word tags tag unknown query_extra".split(" ");
const terms = "porn porno prno p0rn nsfw hentai rule34 gonewild onlyfans fansly chaturbate stripchat cam4 redtube youporn spankbang xvideos xnxx xhamster xxx r_34 r..34 r-34 s3x nud nuds nud3 nud3s".split(" ");
const atoms = "sex s3x nud nude nudes nuds nud3 nud3s porn p0rn r34 nsfw".split(" ");
const values = new Set([...terms, "18%2b", "18+", "18plus", "18-plus", "ordinary", "x34", "xxxtentacion", "nudging", "SKU-R34567"]);
for (const a of atoms) for (const b of atoms) values.add(a + b);
for (const a of atoms.slice(0, 4)) for (const b of atoms) for (const c of atoms.slice(-3)) values.add(a + b + c);
let comparisons = 0;
const compareSearch = (url: string) => {
  assert.equal(searchMatchers.some(regex => regex.test(url)), originalSearch.test(url), `search coverage changed: ${url}`);
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
console.log(`DNR partition coverage and unchanged enforcement metadata passed: ${comparisons} legacy comparisons.`);
