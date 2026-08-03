import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_EXPLICIT_BLOCKED_SITES,
  DEFAULT_EXPLICIT_COMIC_SITE_TERMS,
  DEFAULT_EXPLICIT_CONTEXTUAL_RULES,
  DEFAULT_EXPLICIT_SEARCH_TERMS,
  DEFAULT_FILTER_BYPASS_BLOCKED_SITES,
  DEFAULT_PRIORITY_ADULT_BLOCKED_SITES
} from "../src/defaults.js";
import { buildExplicitContentTextPolicy } from "../src/explicitContentPolicy.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = dirname(dirname(runtimeRoot));
const policyPath = join(projectRoot, "ios", "VigilSocial", "VigilSocial", "ExplicitContentPolicy.json");
const swiftPath = join(projectRoot, "ios", "VigilSocial", "VigilSocial", "ContentSafetyClassifier.swift");

const expected = buildExplicitContentTextPolicy({
  blockedSites: DEFAULT_EXPLICIT_BLOCKED_SITES,
  comicSiteTerms: DEFAULT_EXPLICIT_COMIC_SITE_TERMS,
  contextualRules: DEFAULT_EXPLICIT_CONTEXTUAL_RULES,
  searchTerms: DEFAULT_EXPLICIT_SEARCH_TERMS
});
const committed = JSON.parse(await readFile(policyPath, "utf8")) as unknown;

assert.deepEqual(committed, expected, "the iOS text policy must stay generated from Vigil's main explicit-content rules");
assert.ok(expected.terms.includes("toongod"));
assert.ok(expected.terms.includes("honeytoon"));
assert.ok(expected.terms.includes("porn"));
assert.equal(expected.terms.includes("18+"), false, "ambiguous age-gate text remains a URL-only rule");
assert.equal(expected.terms.includes("croxyproxy"), false, "circumvention domains must remain network-only rules");
assert.equal(expected.terms.includes("wildlife"), false, "priority adult domains must not become generic page-text terms");
assert.ok(DEFAULT_FILTER_BYPASS_BLOCKED_SITES.includes("croxyproxy.com"));
assert.ok(DEFAULT_PRIORITY_ADULT_BLOCKED_SITES.includes("wildlife.adult"));
assert.ok(expected.contextualRules.some((rule) => (
  rule.contexts.includes("webtoon") && rule.markers.includes("mature")
)));

const swift = await readFile(swiftPath, "utf8");
assert.match(swift, /ExplicitContentPolicy/);
assert.match(swift, /return \.unknown/);
assert.doesNotMatch(
  swift,
  /private static let explicitPhrases/,
  "the app must not silently return to the old hard-coded seven-phrase subset"
);

const buildScript = await readFile(join(projectRoot, "scripts", "build-ios-social-app.mts"), "utf8");
assert.match(
  buildScript,
  /assertGeneratedIosContentPolicyCurrent\(\)/,
  "social app builds must reject a stale generated policy before invoking Xcode"
);

const project = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial.xcodeproj", "project.pbxproj"),
  "utf8"
);
assert.match(
  project,
  /ExplicitContentPolicy\.json in Resources/,
  "the generated policy must be copied into each focused social app bundle"
);
