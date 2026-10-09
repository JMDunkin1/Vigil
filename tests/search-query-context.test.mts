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

const blockedURLs = [
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
const rules = { blockedHosts: [], blockedURLFragments: [], blockedSearchTerms: ["porn", "xxx"], safeSearchEnabled: true };
for (const url of blockedURLs) assert.equal(safariDecision(url, rules).allowed, false, `Safari: ${url}`);
for (const url of allowedURLs) assert.equal(safariDecision(url, rules).allowed, true, `Safari: ${url}`);

if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-search-context-native-"));
  try {
    const mainPath = join(directory, "main.swift");
    const cases = [...blockedURLs.map(url => [url, true] as const), ...allowedURLs.map(url => [url, false] as const)];
    const checks = cases.map(([url, expected]) => {
      const base64 = Buffer.from(url).toString("base64");
      return `check(String(data: Data(base64Encoded: "${base64}")!, encoding: .utf8)!, ${expected})`;
    });
    await writeFile(mainPath, `import Foundation
let filter = NavigationFilter(rules: FilterRules.bootstrap)
func check(_ raw: String, _ expected: Bool) {
    let blocked: Bool
    switch filter.decide(URL(string: raw)!) { case .block: blocked = true; case .allow: blocked = false }
    precondition(blocked == expected, "Search-context mismatch: \\(raw)")
}
${checks.join("\n")}
print("Native search-route and metadata parity passed.")
`);
    const executable = join(directory, "search-context");
    execFileSync("/usr/bin/xcrun", ["swiftc", join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), mainPath, "-o", executable], { timeout: 60_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log("Search query fields, structured forms, SPA routes, benign scaffolding and metadata isolation passed.");
