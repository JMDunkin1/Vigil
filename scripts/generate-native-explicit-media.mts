import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ADDITIONAL_EXPLICIT_SEARCH_TERMS, EXPLICIT_MEDIA_PATTERNS, EXPLICIT_MEDIA_ORDINARY_PHRASES, EXPLICIT_AUTOMATIC_ORDINARY_PHRASES, EXPLICIT_VOCABULARY_REPLACEMENTS, EXPLICIT_SEARCH_ALIAS_PATTERNS, EXPLICIT_SEARCH_KEYWORD_TERMS, EXPLICIT_SEARCH_COMPOUND_PATTERN, MULTILINGUAL_EXPLICIT_TERMS } from "../src/explicitMediaContext.js";
import { isDirectRun } from "../src/directRun.js";
import { CONTEXTUAL_SEARCH_PLATFORMS, CONTEXTUAL_SEARCH_NAMES, CONTEXTUAL_SEARCH_MARKERS, EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS } from "../src/contextualExplicitSearch.js";

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
  const ordinaryReplacements = [...EXPLICIT_MEDIA_ORDINARY_PHRASES, ...EXPLICIT_AUTOMATIC_ORDINARY_PHRASES].map(pattern => `        text = text.replacingOccurrences(of: #"${pattern}"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])`).join("\n");
  const aliasChecks = EXPLICIT_SEARCH_ALIAS_PATTERNS.map(pattern => `text.range(of: #"${pattern}"#, options: [.regularExpression, .caseInsensitive]) != nil`).join(" || ");
  const comicChecks = EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS.map(pattern => `text.range(of: #"${pattern}"#, options: [.regularExpression, .caseInsensitive]) != nil`).join(" || ");
  return `// BEGIN GENERATED EXPLICIT MEDIA MATCHER
// Generated from src/explicitMediaContext.ts; do not edit this section.
private enum BroadenedExplicitMedia {
    private static let labels: Set<String> = [${ADDITIONAL_EXPLICIT_SEARCH_TERMS.map(term => JSON.stringify(term)).join(", ")}]
    private static let searchKeywords: Set<String> = [${EXPLICIT_SEARCH_KEYWORD_TERMS.map(term => JSON.stringify(term)).join(", ")}]
    private static let searchCompound = try! NSRegularExpression(pattern: #"${EXPLICIT_SEARCH_COMPOUND_PATTERN}"#)
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
        let glyphs = ["а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "α": "a"]
        let vocabulary: Set<String> = searchKeywords.union(["naked", "nude", "nudes", "porn", "porno", "nsfw", "sex", "sexual", "topless", "nakedgirls", "nudegirls"])
        let glyphSource = text as NSString
        for match in words.matches(in: text, range: NSRange(location: 0, length: glyphSource.length)).reversed() {
            let original = glyphSource.substring(with: match.range)
            let folded = original.lowercased().map { glyphs[String($0)] ?? String($0) }.joined()
            if (vocabulary.contains(folded) || matches(searchCompound, folded)), let range = Range(match.range, in: text) { text.replaceSubrange(range, with: folded) }
        }
${vocabularyReplacements}
        return text
    }

    static func normalized(_ value: String) -> String {
        var text = normalizedVocabulary(value)
${ordinaryReplacements}
        return text
    }

    static func normalizedEvidence(_ value: String) -> String { normalized(value) }

    // Match meaningful destination labels and early routes, never credentials,
    // arbitrary query/hash metadata, or identifiers later in the address.
    static func containsSemanticURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host else { return false }
        let labels = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")).split(separator: ".").map(String.init)
        if ["xxx", "porn"].contains(labels.last ?? "") { return true }
        let hostLabels = labels.dropLast().map(semanticNormalized)
        for (index, label) in hostLabels.enumerated() {
            if semanticClassifies(label, hostname: true) { return true }
            if semanticWeak.contains(label), index + 1 < hostLabels.count,
               semanticMedia.contains(hostLabels[index + 1]) { return true }
        }
        let segments = Array(components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true).prefix(4)).map { semanticNormalized(String($0.prefix(512))) }
        let routeText = segments.map(normalizedEvidence).joined(separator: " ")
        let qualifiedRouteText = normalizedEvidence(routeText)
        if qualifiedRouteText != routeText {
            return semanticClassifies(qualifiedRouteText, previous: segments.first(where: semanticCatalog.contains) ?? "")
        }
        for (index, segment) in segments.enumerated() {
            let previous = index > 0 ? segments[index - 1] : ""
            if semanticClassifies(segment, previous: previous) { return true }
            let roman = semanticChapters.contains(previous) && segment.range(of: #"^x{3,}$"#, options: .regularExpression) != nil
            let next = index + 1 < segments.count ? segments[index + 1] : ""
            if !roman, (semanticWeak.contains(segment) || segment == "18+"
                || segment.range(of: #"^x{3,}$"#, options: .regularExpression) != nil
                || (segment == "r34" && semanticComics.contains(next))),
               semanticTokens(next).contains(where: semanticMedia.contains) { return true }
        }
        return false
    }

    private static let semanticMedia: Set<String> = ["video", "videos", "vid", "vids", "photo", "photos", "photograph", "photographs", "pic", "pics", "image", "images", "gif", "gifs", "print", "prints", "poster", "posters", "pinup", "pinups", "calendar", "calendars", "cam", "cams", "comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi", "novel", "novels", "art", "gallery", "galleries"]
    private static let semanticWeak: Set<String> = ["adult", "adults", "mature", "uncensored", "lewd", "erotic", "nude", "nudes", "naked", "sex", "sexual", "xxx", "r18", "18plus"]
    private static let semanticComics: Set<String> = ["comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi"]
    private static let semanticCatalog: Set<String> = ["genre", "genres", "category", "categories", "tag", "tags", "catalog", "browse"]
    private static let semanticChapters: Set<String> = ["chapter", "book", "section", "volume", "part", "appendix"]
    private static let multilingualSemanticLabels = [${MULTILINGUAL_EXPLICIT_TERMS.filter(term => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term)).map(term => JSON.stringify(term)).join(", ")}]

    private static func semanticNormalized(_ value: String) -> String {
        var decoded = value
        let encodedRuns = try! NSRegularExpression(pattern: #"(?:%[a-f0-9]{2})+"#, options: .caseInsensitive)
        for _ in 0..<3 {
            let next = NSMutableString(string: decoded)
            for match in encodedRuns.matches(in: decoded, range: NSRange(decoded.startIndex..., in: decoded)).reversed() {
                let run = next.substring(with: match.range)
                let bytes = run.split(separator: "%").compactMap { UInt8($0, radix: 16) }
                next.replaceCharacters(in: match.range, with: run.removingPercentEncoding ?? String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) })))
            }
            if next as String == decoded { break }
            decoded = next as String
        }
        return normalizedVocabulary(decoded).lowercased()
    }

    private static func semanticTokens(_ value: String) -> [String] {
        if value.range(of: #"^[a-z\\d]{24,}$"#, options: .regularExpression) != nil,
           value.range(of: #"\\d"#, options: .regularExpression) != nil { return [] }
        if value.range(of: #"^[a-f\\d]{16,}$|^[a-f\\d]{8}(?:-[a-f\\d]{4}){3}-[a-f\\d]{12}$"#, options: .regularExpression) != nil { return [] }
        let text = normalizedEvidence(value).lowercased()
        let source = text as NSString
        return words.matches(in: text, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
    }

    private static func semanticClassifies(_ value: String, previous: String = "", hostname: Bool = false) -> Bool {
        let evidence = normalizedEvidence(semanticChapters.contains(previous) ? previous + " " + value : value).lowercased()
        let tokens = semanticTokens(evidence)
        if tokens.isEmpty { return false }
        if tokens.contains(where: { searchKeywords.contains($0) || ["p0rnography", "erotica"].contains($0) }) { return true }
        let multilingual = evidence.replacingOccurrences(of: #"[\\u200b-\\u200d\\u2060\\ufeff\\u0640\\u0610-\\u061a\\u064b-\\u065f\\u0670\\u06d6-\\u06ed]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[أإآٱ]"#, with: "ا", options: .regularExpression)
        if multilingualSemanticLabels.contains(where: multilingual.contains)
            || multilingual.range(of: #"(?:^|[^\\p{L}\\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\\p{L}\\p{N}])"#, options: .regularExpression) != nil
            || multilingual.range(of: #"(?:^|[^\\p{L}\\p{N}])(?:ال)?(?:فيديو(?:هات)?|فيلم|افلام)[\\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\\p{L}\\p{N}])"#, options: .regularExpression) != nil
            || multilingual.range(of: #"(?:^|[^\\p{L}\\p{N}])(?:pornografi(?:a|co|ca)s?|pornographi(?:e|ques?)|pornografie|pornografisch(?:e[rmns]?)?|порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?|порнографи\\p{Cyrillic}*)(?=$|[^\\p{L}\\p{N}])"#, options: .regularExpression) != nil { return true }
        let compact = tokens.joined()
        if compact.range(of: #"^(?!rule34\\d)(?:p[o0]rn|h[e3]ntai|nsfw|rule34)(?:hub|tube|world|land|zone|site|sites|read|reader|live|free|hd|vr|4k|\\d{1,3}|videos?|photos?|pics?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)?$"#, options: .regularExpression) != nil
            || compact.range(of: #"^(?:free|best|my|the|all|hd|new|daily|live|watch|read|anime|manga|comic|comics|webtoon|3d|vr|4k)(?:porn|hentai|nsfw)$"#, options: .regularExpression) != nil { return true }
        if hostname, compact.range(of: #"^x{3,}$"#, options: .regularExpression) != nil { return true }
        let media = "(?:videos?|vids?|photos?|pics?|images?|gifs?|cams?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|novels?|art|galler(?:y|ies))"
        let marker = "(?:adults?|mature|uncensored|lewd|erotic|nudes?|naked|sex(?:ual)?|x{3,}|r18|18plus)"
        if tokens.contains(where: { $0.range(of: "^(?:" + marker + media + "|" + media + marker + ")$", options: .regularExpression) != nil }) { return true }
        if tokens.contains(where: { $0.range(of: #"^r34(?:comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)$"#, options: .regularExpression) != nil })
            || (tokens.contains("r34") && (tokens.contains(where: semanticComics.contains) || semanticCatalog.contains(previous))) { return true }
        if semanticChapters.contains(previous), value.range(of: #"^x{3,}$"#, options: .regularExpression) != nil { return false }
        let hasMarker = tokens.enumerated().contains { index, token in
            (semanticWeak.contains(token) || token.range(of: #"^x{3,}$"#, options: .regularExpression) != nil)
                && !(token == "uncensored" && index + 1 < tokens.count && tokens[index + 1] == "interview")
        } || value.range(of: #"(?:^|[^\\p{L}\\p{N}])18\\s*\\+(?:$|[^\\p{L}\\p{N}])"#, options: .regularExpression) != nil
        return hasMarker && (tokens.contains(where: semanticMedia.contains) || semanticCatalog.contains(previous))
    }

    static func containsSearch(_ value: String, hostname: String = "") -> Bool {
        let text = normalizedEvidence(value)
        let lower = text.lowercased()
        let source = lower as NSString
        let tokens = words.matches(in: lower, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
        if tokens.contains(where: { searchKeywords.contains($0) || matches(searchCompound, $0) }) { return true }
        if text.range(of: #"(?:^|[^\\p{L}\\p{N}])x{3,}(?:$|[^\\p{L}\\p{N}]|videos?\\b|vids?\\b|photos?\\b|pics?\\b|porn\\b)"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if ${aliasChecks} || ${comicChecks} || contains(text) { return true }
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
        let text = normalizedEvidence(value).lowercased()
        let textSource = text as NSString
        let labelTokens = words.matches(in: text, range: NSRange(location: 0, length: textSource.length)).map { textSource.substring(with: $0.range) }
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
            if matches(strongMediaMarker, token) && nearby.contains(where: { matches(media, $0) }) { return true }
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
      await writeFile(path, marker.test(source) ? source.replace(marker, () => generated) : `${source.trimEnd()}\n\n${generated}\n`, "utf8");
    } else if (source.match(marker)?.[0] !== generated) {
      throw new Error(`The native explicit-media matcher is stale in ${relative}. Run node dist/runtime/scripts/generate-native-explicit-media.mjs --write after building.`);
    }
  }
}

if (isDirectRun(import.meta.url)) await generateNativeExplicitMedia(process.argv.includes("--write"));
