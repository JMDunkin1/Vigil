import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { defaultState, DEFAULT_EXPLICIT_SEARCH_TERMS, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES } from "../src/defaults.js";
import { ADDITIONAL_EXPLICIT_SEARCH_TERMS, containsContextualExplicitMedia } from "../src/explicitMediaContext.js";
import { baselinePolicy, shouldBlockSite, shouldBlockUrl } from "../src/policy.js";
import { hasSafeSearchContributor } from "../src/safeSearchContext.js";
import { generateNativeExplicitMedia, generatedNativeExplicitMedia } from "../scripts/generate-native-explicit-media.mjs";
import { broadenedAllowedSearches, broadenedBlockedSearches, broadenedSafeSearchOnlyWords } from "./fixtures/broadened-explicit-search.mjs";

const state = defaultState();
const profile = baselinePolicy(state)!.profile;
const context = createContext({
  URL, URLSearchParams, location: { href: "https://www.google.com/search?q=ordinary&safe=active", replace() {} },
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } }, addEventListener() {}
});
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), context);
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const legacySource = await readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8");
const legacyDecision = runInNewContext(`${legacySource.slice(0, legacySource.indexOf("  const allowedEscapeURL ="))}\nreturn decision; })();`, {
  URL, URLSearchParams, location: { href: "https://www.google.com/" }
}) as (url: string, rules: object) => { allowed: boolean };
for (const [queries, expected] of [[broadenedBlockedSearches, true], [broadenedAllowedSearches, false]] as const) {
  for (const query of queries) {
    assert.equal(containsContextualExplicitMedia(query), expected, `phrase matcher: ${query}`);
    for (const url of [
      `https://www.google.com/search?q=${encodeURIComponent(query)}&safe=active`,
      `https://search.example/?QUERY=${encodeURIComponent(query)}`,
      `https://search.example/search/${encodeURIComponent(query)}`,
      `https://search.example/#/search/${encodeURIComponent(query)}`,
      `https://search.example/?q=${encodeURIComponent(encodeURIComponent(query))}`
    ]) {
      assert.equal(shouldBlockUrl(profile, url), expected, `server: ${url}`);
      assert.equal(Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(url)})`, context)), expected, `browser: ${url}`);
      assert.equal(legacyDecision(url, { blockedHosts: [], blockedURLFragments: [], blockedSearchTerms: DEFAULT_EXPLICIT_SEARCH_TERMS, safeSearchEnabled: true }).allowed, !expected, `standalone Safari: ${url}`);
    }
  }
}
for (const query of broadenedSafeSearchOnlyWords) assert.equal(hasSafeSearchContributor(query), true, query);
assert.ok(DEFAULT_PRIORITY_ADULT_BLOCKED_SITES.includes("artpal.com"));
for (const host of ["artpal.com", "www.artpal.com", "gallery.artpal.com", "artpal.com."]) {
  assert.equal(shouldBlockSite(profile, host), true, host);
}
for (const host of ["artpal.com.example.org", "myartpal.com"]) assert.equal(shouldBlockSite(profile, host), false, host);
for (const query of ["naked girls pornography medical", "nude art porn", "sexual health nhentai"]) {
  assert.equal(shouldBlockUrl(profile, `https://www.google.com/search?q=${encodeURIComponent(query)}`), true, `ordinary context cannot cancel explicit labels: ${query}`);
}
assert.equal(containsContextualExplicitMedia("naked anatomy notes ordinary neutral words separate naked girls"), true, "a distant benign context must not excuse a separate explicit phrase");
assert.equal(containsContextualExplicitMedia("naked plain neutral words ordinary separate neutral girls"), false, "distant words must not form a phrase");

await generateNativeExplicitMedia();
if (process.platform === "darwin") {
  const directory = await mkdtemp(join(tmpdir(), "vigil-explicit-native-"));
  try {
    const path = join(directory, "main.swift");
    const cases = [...broadenedBlockedSearches.map(query => [query, true] as const), ...broadenedAllowedSearches.map(query => [query, false] as const)];
    const literals = cases.map(([query, expected]) => {
      const base64 = Buffer.from(query).toString("base64");
      return `precondition(BroadenedExplicitMedia.contains(String(data: Data(base64Encoded: "${base64}")!, encoding: .utf8)!) == ${expected}, "${base64}")`;
    });
    await writeFile(path, `import Foundation\n${generatedNativeExplicitMedia()}\n${literals.join("\n")}\nprint("Native phrase parity passed.")\n`);
    const executable = join(directory, "native-parity");
    execFileSync("/usr/bin/xcrun", ["swiftc", path, "-o", executable], { timeout: 120_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
    const navigationCases = cases.flatMap(([query, expected]) => [query, encodeURIComponent(query)].map(encoded => {
      const base64 = Buffer.from(encoded).toString("base64");
      return `check(String(data: Data(base64Encoded: "${base64}")!, encoding: .utf8)!, ${expected})`;
    }));
    await writeFile(path, `import Foundation
var rules = FilterRules.bootstrap
rules.blockedSearchTerms += [${ADDITIONAL_EXPLICIT_SEARCH_TERMS.map(term => JSON.stringify(term)).join(", ")}]
let filter = NavigationFilter(rules: rules)
func check(_ query: String, _ expected: Bool) {
    var url = URLComponents(string: "https://www.google.com/search")!
    url.queryItems = [URLQueryItem(name: "q", value: query)]
    let blocked: Bool
    switch filter.decide(url.url!) { case .block: blocked = true; case .allow: blocked = false }
    precondition(blocked == expected, "Navigation mismatch: \\(query)")
}
${navigationCases.join("\n")}
print("Native browser navigation parity passed.")
`);
    execFileSync("/usr/bin/xcrun", ["swiftc", join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"), join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), path, "-o", executable], { timeout: 120_000, stdio: "pipe" });
    execFileSync(executable, [], { timeout: 30_000, stdio: "pipe" });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log(`${broadenedBlockedSearches.length} blocked and ${broadenedAllowedSearches.length} legitimate searches verified across server, browser and native phrase matching.`);
