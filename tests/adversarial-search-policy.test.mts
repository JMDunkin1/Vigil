import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createContext, runInContext, runInNewContext } from "node:vm";
import { DEFAULT_EXPLICIT_SEARCH_TERMS, defaultState } from "../src/defaults.js";
import { containsContextualExplicitMedia } from "../src/explicitMediaContext.js";
import { baselinePolicy, shouldBlockUrl } from "../src/policy.js";
import { adversarialQueryCorpus, adversarialUrlCorpus } from "./fixtures/policy-adversarial-corpus.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : dirname(dirname(runtimeRoot));
const profile = baselinePolicy(defaultState())!.profile;
const failures: string[] = [];
const record = (engine: string, id: string, actual: boolean, expected: boolean, subject: string): void => {
  if (actual !== expected) failures.push(`${engine} ${id}: expected ${expected ? "blocked" : "allowed"}: ${JSON.stringify(subject)}`);
};

// Use the generated, bundled Chrome guard and the standalone Safari decision
// function. These probes execute policy code without visiting explicit pages.
const chrome = createContext({
  URL, URLSearchParams,
  location: { href: "https://www.google.com/search?q=ordinary&safe=active", replace() {} },
  chrome: { runtime: { getURL: (path: string) => `chrome-extension://vigil/${path}` } },
  addEventListener() {}
});
runInContext(await readFile(new URL("../extension/google-safe-search.js", import.meta.url), "utf8"), chrome);
const safariSource = await readFile(join(projectRoot, "ios/VigilBrowser/VigilSafariExtension/Resources/content.js"), "utf8");
const safariBoundary = safariSource.indexOf("  const allowedEscapeURL =");
assert.ok(safariBoundary > 0, "the standalone Safari policy extraction must include its real decision function");
const safariDecision = runInNewContext(`${safariSource.slice(0, safariBoundary)}\nreturn decision; })();`, {
  URL, URLSearchParams, location: { href: "https://www.google.com/" }
}) as (url: string, rules: object) => { allowed: boolean };
const safariRules = {
  blockedHosts: [], blockedURLFragments: [], blockedSearchTerms: DEFAULT_EXPLICIT_SEARCH_TERMS, safeSearchEnabled: true
};

// Each text intent must survive query parameter casing, discovery paths,
// fragment routes, and nested encoding. URL-specific cases cover duplicate
// parameters, structured keys, platform routes, and unrelated URL metadata.
const navigationCases = [
  ...adversarialQueryCorpus.flatMap(({ id, query, expectedBlocked, rationale }) => [
    `https://www.google.com/search?q=${encodeURIComponent(query)}&safe=active`,
    `https://catalog.example/?QUERY=${encodeURIComponent(query)}`,
    `https://catalog.example/search/${encodeURIComponent(query)}`,
    `https://catalog.example/#/search/${encodeURIComponent(query)}`,
    `https://catalog.example/search?q=${encodeURIComponent(encodeURIComponent(query))}`
  ].map((url, variant) => ({ id: `${id}-${variant}`, url, expectedBlocked, rationale }))),
  ...adversarialUrlCorpus
];
assert.equal(new Set([...adversarialQueryCorpus, ...adversarialUrlCorpus].map(({ id }) => id)).size,
  adversarialQueryCorpus.length + adversarialUrlCorpus.length, "reviewed corpus IDs must remain unique");
for (const item of adversarialQueryCorpus) {
  if (item.expectedMediaBlocked !== undefined) {
    record("shared media matcher", item.id, containsContextualExplicitMedia(item.query), item.expectedMediaBlocked, item.query);
  }
}
for (const item of navigationCases) {
  record("server", item.id, shouldBlockUrl(profile, item.url), item.expectedBlocked, item.url);
  record("Chrome", item.id, Boolean(runInContext(`explicitSearchBlockRedirect(${JSON.stringify(item.url)})`, chrome)), item.expectedBlocked, item.url);
  record("standalone Safari", item.id, !safariDecision(item.url, safariRules).allowed, item.expectedBlocked, item.url);
}

// Compile the actual Foundation navigation filter and page-text classifier in
// separate executables: each owns its generated private media matcher. Input
// is JSON so Swift and JavaScript exercise identical strings and expectations.
if (process.platform === "darwin") {
  const execute = promisify(execFile);
  const directory = await mkdtemp(join(tmpdir(), "vigil-adversarial-native-"));
  try {
    const casesPath = join(directory, "cases.json");
    await writeFile(casesPath, JSON.stringify({
      navigation: navigationCases,
      text: adversarialQueryCorpus.filter(item => item.expectedTextBlocked !== undefined),
      terms: DEFAULT_EXPLICIT_SEARCH_TERMS
    }));
    const navigationPath = join(directory, "main.swift");
    await writeFile(navigationPath, `import Foundation
struct NavigationCase: Decodable { let id: String; let url: String; let expectedBlocked: Bool }
struct Corpus: Decodable { let navigation: [NavigationCase]; let terms: [String] }
let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
var rules = FilterRules.bootstrap
rules.blockedSearchTerms = corpus.terms
let filter = NavigationFilter(rules: rules)
var failures: [String] = []
for item in corpus.navigation {
    let blocked: Bool
    switch filter.decide(URL(string: item.url)!) { case .block: blocked = true; case .allow: blocked = false }
    if blocked != item.expectedBlocked { failures.append("Swift navigation \\(item.id): \\(item.url)") }
}
print(String(data: try JSONEncoder().encode(failures), encoding: .utf8)!)
`);
    const executable = join(directory, "navigation");
    await execute("/usr/bin/xcrun", ["swiftc", "-O",
      join(projectRoot, "ios/VigilBrowser/Shared/FilterRules.swift"),
      join(projectRoot, "ios/Shared/PhoneBlocklist.swift"), navigationPath, "-o", executable
    ], { timeout: 60_000 });
    const navigation = await execute(executable, [casesPath], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    failures.push(...JSON.parse(navigation.stdout) as string[]);

    const classifierPath = join(directory, "classifier.swift");
    await writeFile(classifierPath, `import Foundation
struct TextCase: Decodable { let id: String; let query: String; let expectedTextBlocked: Bool }
struct Corpus: Decodable { let text: [TextCase] }
@main struct ClassifierRegression {
    static func main() async throws {
        let corpus = try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1])))
        let policy = try JSONDecoder().decode(ExplicitContentTextPolicy.self, from: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])))
        let classifier = ConservativePageTextClassifier(policy: policy)
        var failures: [String] = []
        for item in corpus.text {
            let verdict = await classifier.classify(pageText: item.query, wasTruncated: false)
            let expected: ContentSafetyVerdict = item.expectedTextBlocked ? .sensitive : .safe
            if verdict != expected { failures.append("Swift text \\(item.id): \\(item.query)") }
        }
        print(String(data: try JSONEncoder().encode(failures), encoding: .utf8)!)
    }
}
`);
    const classifierExecutable = join(directory, "classifier");
    await execute("/usr/bin/xcrun", ["swiftc", "-O",
      join(projectRoot, "ios/VigilSocial/VigilSocial/ContentSafetyClassifier.swift"), classifierPath, "-o", classifierExecutable
    ], { timeout: 60_000 });
    const text = await execute(classifierExecutable, [casesPath,
      join(projectRoot, "ios/VigilSocial/VigilSocial/ExplicitContentPolicy.json")
    ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    failures.push(...JSON.parse(text.stdout) as string[]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.env.VIGIL_ADVERSARIAL_REPORT) await writeFile(process.env.VIGIL_ADVERSARIAL_REPORT, JSON.stringify({ queries: adversarialQueryCorpus.length, navigationCases: navigationCases.length, failures }, null, 2));
assert.deepEqual(failures, [], "adversarial searches and legitimate controls must retain their reviewed outcomes across policy engines");
console.log(`${adversarialQueryCorpus.length} reviewed queries and ${adversarialUrlCorpus.length} URL cases passed (${navigationCases.length} navigation variants; actual Swift navigation and text classifiers on macOS).`);
