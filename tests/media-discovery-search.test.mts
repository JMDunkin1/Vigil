import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { MEDIA_DISCOVERY_PLATFORMS, containsContextualExplicitSearch } from "../src/contextualExplicitSearch.js";
import { defaultState, DEFAULT_EXPLICIT_SEARCH_TERMS } from "../src/defaults.js";
import { baselinePolicy, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";

const profile = baselinePolicy(defaultState())!.profile;
const cases: Array<[string, boolean]> = [];
for (const host of MEDIA_DISCOVERY_PLATFORMS) {
  for (const query of ["nude", "sex", "sexy", "spicy", "mature", "suggestive", "lingerie", "uncensored", "leaked"]) {
    cases.push([`https://${host}/search?q=${encodeURIComponent(query)}`, true]);
  }
  for (const query of ["family photos", "project files", "landscapes", "adult education", "mature trees", "naked mole rat", "leaks pipes"]) {
    cases.push([`https://${host}/search?q=${encodeURIComponent(query)}`, false]);
  }
}
for (const query of ["18+", "18 plus", "18-plus", "18plus", "eighteen plus", "１８＋", "18\u200b+", "18%252B", "18+ travel insurance"]) {
  assert.equal(containsContextualExplicitSearch(query), true, query);
  for (const route of [
    `search?q=${encodeURIComponent(query)}`, `search/${encodeURIComponent(query)}`,
    `#/search?q=${encodeURIComponent(query)}`, `#gsc.tab=0&gsc.q=${encodeURIComponent(query)}`
  ]) cases.push([`https://catalog.example/${route}`, true]);
}
for (const name of ["Google Drive", "de-digger", "FilePursuit", "Meawfy", "public files", "file search", "site:drive.google.com", "site:mega.nz", "site:mediafire.com"]) {
  cases.push([`https://www.google.com/search?q=${encodeURIComponent(name + " suggestive")}`, true]);
  cases.push([`https://www.google.com/search?q=${encodeURIComponent(name + " landscapes")}`, false]);
}
for (const route of [
  "https://www.google.com/search?udm=2&q=", "https://www.google.com/search?tbm=vid&q=",
  "https://www.bing.com/images/search?q=", "https://duckduckgo.com/?ia=images&q=",
  "https://search.brave.com/videos?q=", "https://search.example/?categories=images&q="
]) {
  cases.push([route + "suggestive", true], [route + "landscapes", false]);
}
cases.push(
  ["https://www.dedigger.com/#gsc.tab=0&gsc.q=spicy&gsc.sort=", true],
  ["https://www.dedigger.com/#gsc.q=mature", true],
  ["https://filepursuit.com/?search_api_fulltext=sexy", true],
  ["https://drive.google.com/drive/u/0/search?q=lingerie", true],
  ["https://ordinary.example/?q=sexy", false],
  ["https://ordinary.example/?q=suggestive&type=2", false],
  ["https://dedigger.com.example.org/?q=mature", false],
  ["https://ordinary.example/document/18plus", false],
  ["https://ordinary.example/document/18%2B", false],
  ["https://drive.google.com/file/d/ab18plus9/view", false],
  ["https://ordinary.example/?id=18%2B&tracking=18plus", false],
  ["https://www.dedigger.com/?q=landscape&tracking=sexy", false],
  ["https://ordinary.example/search?q=118plus", false],
  ["https://ordinary.example/search?q=Project18plus9", false],
  ["https://ordinary.example/search?q=18%2B5", false],
  ["https://ordinary.example/search?q=18+landscapes", false],
  ["https://ordinary.example/#notes?gsc.q=18plus", false]
);
const chrome = createContext({ URL, URLSearchParams, location: { href: "https://ordinary.example/", replace() {} },
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } }, addEventListener() {} });
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), chrome);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const source = await readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8");
const safariDecision = runInNewContext(`${source.slice(0, source.indexOf("  const allowedEscapeURL ="))}\nreturn decision; })();`, {
  URL, URLSearchParams, location: { href: "https://ordinary.example/" }
}) as (url: string, rules: object) => { allowed: boolean };
const rules = { blockedHosts: [], blockedURLFragments: [], blockedSearchTerms: DEFAULT_EXPLICIT_SEARCH_TERMS, safeSearchEnabled: true };
const staticRules = JSON.parse(await readFile(new URL("../extension/rules.json", import.meta.url), "utf8")) as Array<{ id: number; condition: { regexFilter: string } }>;
const ageNetworkMatchers = staticRules.filter(rule => rule.id >= 10000).map(rule => new RegExp(rule.condition.regexFilter, "i"));
for (const [query, blocked] of [
  ["18+", true], ["18 plus", true], ["18-plus", true], ["18plus", true], ["eighteen plus", true],
  ["18+ travel insurance", true], ["18+5", false], ["118plus", false], ["Project18plus9", false], ["18 landscapes", false]
] as const) {
  assert.equal(ageNetworkMatchers.some(matcher => matcher.test(`https://ordinary.example/search?q=${encodeURIComponent(query)}`)), blocked, `static age search: ${query}`);
}
for (const url of ["https://drive.google.com/file/d/ab18plus9/view", "https://ordinary.example/?id=18%2B", "https://ordinary.example/18plus"]) {
  assert.equal(ageNetworkMatchers.some(matcher => matcher.test(url)), false, `static metadata: ${url}`);
}
for (const [url, blocked] of cases) {
  assert.equal(shouldBlockUrl(profile, url), blocked, `server: ${url}`);
  assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, chrome)), blocked || shouldBlockSite(profile, new URL(url).hostname), `Chrome: ${url}`);
  assert.equal(safariDecision(url, rules).allowed, !blocked, `Safari: ${url}`);
}
runInContext('location.href = "https://www.dedigger.com/"', chrome);
for (const query of ["spicy", "suggestive", "18+"]) assert.equal(runInContext(`containsExplicitSearchText(${JSON.stringify(query)})`, chrome), true);
assert.equal(runInContext('explicitSearchBlockRedirect("https://ordinary.example/search?q=suggestive")', chrome), null, "outgoing links retain destination context");

if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-media-search-"));
  try {
    const main = join(directory, "main.swift");
    await writeFile(main, `import Foundation
let cases = try! JSONSerialization.jsonObject(with: Data(base64Encoded: "${Buffer.from(JSON.stringify(cases)).toString("base64")}")!) as! [[Any]]
let filter = NavigationFilter(rules: .bootstrap)
for item in cases {
    let raw = item[0] as! String
    let expected = item[1] as! Bool
    let blocked: Bool
    switch filter.decide(URL(string: raw)!) { case .block: blocked = true; case .allow: blocked = false }
    precondition(blocked == expected, "Media search mismatch: \\(raw)")
}
print("Native media-discovery parity passed.")
`);
    const executable = join(directory, "media-search");
    execFileSync("/usr/bin/xcrun", ["swiftc", join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), main, "-o", executable], { timeout: 120_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(`${cases.length} media-discovery, search-only age, ordinary-query and opaque-URL cases passed across server, Chrome, Safari and native iOS.`);
