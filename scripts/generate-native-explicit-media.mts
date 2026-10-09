import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDITIONAL_EXPLICIT_SEARCH_TERMS, EXPLICIT_MEDIA_PATTERNS, EXPLICIT_MEDIA_ORDINARY_PHRASES, EXPLICIT_VOCABULARY_REPLACEMENTS, EXPLICIT_SEARCH_ALIAS_PATTERNS } from "../src/explicitMediaContext.js";
import { isDirectRun } from "../src/directRun.js";
import { CONTEXTUAL_SEARCH_PLATFORMS, CONTEXTUAL_SEARCH_NAMES, CONTEXTUAL_SEARCH_MARKERS } from "../src/contextualExplicitSearch.js";

const projectRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
const paths = [
  "ios/VigilBrowser/Shared/FilterRules.swift",
  "ios/VigilSocial/VigilSocial/ContentSafetyClassifier.swift"
];
const marker = /\/\/ BEGIN GENERATED EXPLICIT MEDIA MATCHER[\s\S]*?\/\/ END GENERATED EXPLICIT MEDIA MATCHER/u;

export function generatedNativeExplicitMedia(): string {
  const patterns = Object.entries(EXPLICIT_MEDIA_PATTERNS).map(([name, source]) =>
    `    private static let ${name} = try! NSRegularExpression(pattern: #"${source}"#)`
  ).join("\n");
  const vocabularyReplacements = EXPLICIT_VOCABULARY_REPLACEMENTS.map(({ pattern, replacement }) => `        text = text.replacingOccurrences(of: #"${pattern}"#, with: "${replacement}", options: [.regularExpression, .caseInsensitive])`).join("\n");
  const ordinaryReplacements = EXPLICIT_MEDIA_ORDINARY_PHRASES.map(pattern => `        text = text.replacingOccurrences(of: #"${pattern}"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])`).join("\n");
  const aliasChecks = EXPLICIT_SEARCH_ALIAS_PATTERNS.map(pattern => `text.range(of: #"${pattern}"#, options: [.regularExpression, .caseInsensitive]) != nil`).join(" || ");
  return `// BEGIN GENERATED EXPLICIT MEDIA MATCHER
// Generated from src/explicitMediaContext.ts; do not edit this section.
private enum BroadenedExplicitMedia {
    private static let labels: Set<String> = [${ADDITIONAL_EXPLICIT_SEARCH_TERMS.map(term => JSON.stringify(term)).join(", ")}]
${patterns}
    private static let marker = try! NSRegularExpression(pattern: #"^(?:adults?|spicy|creampies?|nudes?|naked|nudity|erotic|erotica|lewd|x+)$"#)
    private static let contributor = try! NSRegularExpression(pattern: #"^(?:mature|steamy|uncensored)$"#)
    private static let words = try! NSRegularExpression(pattern: #"[\\p{L}\\p{N}]+"#)

    private static func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
        pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    static func isAdditionalLabel(_ value: String) -> Bool { labels.contains(value.lowercased()) }

    static func normalizedVocabulary(_ value: String) -> String {
        var text = value.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufe00-\\ufe0f\\ufeff]"#, with: "", options: .regularExpression)
        let latin = try! NSRegularExpression(pattern: #"\\p{Script=Latin}\\p{M}*"#)
        let source = text as NSString
        for match in latin.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            if let range = Range(match.range, in: text) {
                text.replaceSubrange(range, with: source.substring(with: match.range).folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX")))
            }
        }
        let glyphs = ["а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "Α": "A"]
        let vocabulary: Set<String> = ["naked", "nude", "nudes", "porn", "porno", "nsfw", "sex", "sexual", "topless", "nakedgirls", "nudegirls"]
        let glyphSource = text as NSString
        for match in words.matches(in: text, range: NSRange(location: 0, length: glyphSource.length)).reversed() {
            let original = glyphSource.substring(with: match.range)
            let folded = original.map { glyphs[String($0)] ?? String($0) }.joined().lowercased()
            if vocabulary.contains(folded), let range = Range(match.range, in: text) { text.replaceSubrange(range, with: folded) }
        }
${vocabularyReplacements}
        return text
    }

    static func normalized(_ value: String) -> String {
        var text = normalizedVocabulary(value)
${ordinaryReplacements}
        return text
    }

    static func containsSearch(_ value: String, hostname: String = "") -> Bool {
        let text = normalizedVocabulary(value)
        if ${aliasChecks} || contains(value) { return true }
        let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let domains = [${CONTEXTUAL_SEARCH_PLATFORMS.map(domain => JSON.stringify(domain)).join(", ")}]
        let platform = domains.contains { host == $0 || host.hasSuffix("." + $0) }
        if (host == "itch.io" || host.hasSuffix(".itch.io")), text.range(of: #"(?:^|[/#])tag-adult(?:$|[/?.#])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if host == "reddit.com" || host.hasSuffix(".reddit.com") {
            if text.range(of: #"^\\s*x{1,2}\\s*$|(?:^|[^\\p{L}\\p{N}])(?:(?:adult|unreviewed)[\\s_-]+videos?|x{1,2}[\\s_-]+(?:videos?|photos?|pics?))(?:$|[^\\p{L}\\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        }
        let namedPlatform = text.range(of: #"${CONTEXTUAL_SEARCH_NAMES.source}"#, options: [.regularExpression, .caseInsensitive]) != nil
        let discoveryText = text.replacingOccurrences(of: "3", with: "e").replacingOccurrences(of: "0", with: "o")
        return (platform || namedPlatform) && discoveryText.range(of: #"${CONTEXTUAL_SEARCH_MARKERS.source}"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func contains(_ value: String) -> Bool {
        let vocabularyText = normalizedVocabulary(value).lowercased()
        let text = normalized(value).lowercased()
        let textSource = vocabularyText as NSString
        let labelTokens = words.matches(in: vocabularyText, range: NSRange(location: 0, length: textSource.length)).map { textSource.substring(with: $0.range) }
        if labelTokens.contains(where: { labels.contains($0) || ["porn", "porno", "nsfw"].contains($0) }) { return true }
        if text.range(of: #"(?:^|[^\\p{L}\\p{N}])(?:x+[\\s_.\\p{Pd}]*rated|rated[\\s_.\\p{Pd}]*x+)(?:$|[^\\p{L}\\p{N}])"#, options: .regularExpression) != nil { return true }
        let combined = text.replacingOccurrences(of: #"\\b(?:without(?:[\\s_-]+any)?|with[\\s_-]+no)[\\s_-]+clothes\\b"#, with: "naked", options: .regularExpression)
            .replacingOccurrences(of: #"\\b(?:wearing[\\s_-]+nothing|(?:in[\\s_-]+(?:the|their|a)[\\s_-]+)?birthday[\\s_-]+suits?|in[\\s_-]+the[\\s_-]+buff)\\b"#, with: "naked", options: .regularExpression)
            .replacingOccurrences(of: #"\\b(?:pleasur(?:ing|e)[\\s_-]+(?:myself|herself|himself|themselves)|playing[\\s_-]+with[\\s_-]+(?:myself|herself|himself|themselves)|self[\\s_-]+pleasure)\\b"#, with: "selfpleasure", options: .regularExpression)
            .replacingOccurrences(of: #"\\bup[\\s_-]+skirt\\b"#, with: "upskirt", options: .regularExpression)
            .replacingOccurrences(of: #"\\bdown[\\s_-]+blouse\\b"#, with: "downblouse", options: .regularExpression)
            .replacingOccurrences(of: #"\\bstrip[\\s_-]+tease\\b"#, with: "striptease", options: .regularExpression)
            .replacingOccurrences(of: #"\\bnip[\\s_-]+slips?\\b"#, with: "nipslip", options: .regularExpression)
            .replacingOccurrences(of: #"\\bcream[\\s_\\p{Pd}]+pies?\\b"#, with: "creampie", options: .regularExpression)
            .replacingOccurrences(of: #"\\bfull[\\s_\\p{Pd}]+frontal\\b"#, with: "fullfrontal", options: .regularExpression)
            .replacingOccurrences(of: #"\\bsee[\\s_\\p{Pd}]+through\\b"#, with: "seethrough", options: .regularExpression)
        let source = combined as NSString
        let tokens = words.matches(in: combined, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
        for (index, token) in tokens.enumerated() {
            let directPerson = [1, -1].contains { direction in
                for offset in 1...12 {
                    let target = index + direction * offset
                    if target < 0 || target >= tokens.count { return false }
                    let adjacent = tokens[target]
                    if matches(people, adjacent) { return true }
                    if !matches(connectors, adjacent) { return false }
                }
                return false
            }
            if (matches(exposure, token) || token == "bare") && directPerson { return true }
            let hot = token == "sexy" || token == "hot"
            guard hot || [marker, exposure, sexual, acts, body, marketing].contains(where: { matches($0, token) }) else { continue }
            let lower = max(0, index - 4), upper = min(tokens.count, index + 5)
            let nearby = Array(tokens[lower..<upper])
            if matches(strongActs, token) && nearby.contains(where: { matches(media, $0) || matches(people, $0) }) { return true }
            if token == "x" || token == "xx" {
                if nearby.contains(where: { ["model", "men", "files", "axis", "chromosome", "chromosomes"].contains($0) }) { continue }
            }
            if nearby.contains(where: { matches(ordinary, $0) }) { continue }
            if token == "sex" && nearby.contains(where: { matches(relationship, $0) }) { continue }
            if matches(ambiguousBody, token) && nearby.contains(where: { matches(ordinaryBody, $0) }) { continue }
            if hot || [exposure, sexual, body].contains(where: { matches($0, token) }) {
                if nearby.contains(where: { matches(bodyContext, $0) }) { continue }
            }
            if matches(exposure, token) && nearby.contains(where: { matches(nonsexualExposure, $0) }) { continue }
            let others = (lower..<upper).filter { $0 != index }.map { tokens[$0] }
            if hot {
                if others.contains(where: { matches(people, $0) }) { return true }
                continue
            }
            if [exposure, sexual, acts].contains(where: { matches($0, token) }) && others.contains(where: { word in
                [media, people, body, exposure, sexual, acts, marketing].contains(where: { matches($0, word) })
            }) { return true }
            if matches(body, token) && others.contains(where: { word in [media, exposure, sexual].contains(where: { matches($0, word) }) }) { return true }
            if matches(marker, token) && others.contains(where: { word in [media, marker, contributor].contains(where: { matches($0, word) }) }) { return true }
            if matches(marketing, token) && others.contains(where: { word in [exposure, sexual, acts].contains(where: { matches($0, word) }) }) { return true }
        }
        return false
    }
}
// END GENERATED EXPLICIT MEDIA MATCHER`;
}

export async function generateNativeExplicitMedia(write = false): Promise<void> {
  const generated = generatedNativeExplicitMedia();
  for (const relative of paths) {
    const path = join(projectRoot, relative);
    const source = await readFile(path, "utf8");
    if (write) {
      await writeFile(path, marker.test(source) ? source.replace(marker, generated) : `${source.trimEnd()}\n\n${generated}\n`, "utf8");
    } else if (source.match(marker)?.[0] !== generated) {
      throw new Error(`The native explicit-media matcher is stale in ${relative}. Run node dist/runtime/scripts/generate-native-explicit-media.mjs --write after building.`);
    }
  }
}

if (isDirectRun(import.meta.url)) await generateNativeExplicitMedia(process.argv.includes("--write"));
