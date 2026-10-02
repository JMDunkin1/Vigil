import CoreGraphics
import Foundation
import ImageIO
import SensitiveContentAnalysis

enum ContentSafetyVerdict: String, Equatable, Sendable {
    case safe
    case sensitive
    case unknown
}

enum UnclassifiedMediaPolicy: String, Equatable, Sendable {
    static let infoDictionaryKey = "VigilUnclassifiedMediaPolicy"

    case conceal
    case revealUnclassified = "reveal-unclassified"

    init(infoDictionaryValue: Any?) {
        guard let value = infoDictionaryValue as? String,
              let configured = Self(rawValue: value) else {
            self = .conceal
            return
        }
        self = configured
    }

    init(bundle: Bundle) {
        self.init(infoDictionaryValue: bundle.object(forInfoDictionaryKey: Self.infoDictionaryKey))
    }

    var concealsUnclassifiedMedia: Bool { self == .conceal }

    func resolve(_ verdict: ContentSafetyVerdict) -> ContentSafetyVerdict {
        guard verdict == .unknown, self == .revealUnclassified else { return verdict }
        return .safe
    }
}

protocol MediaSafetyClassifying: Sendable {
    func classify(imageData: Data) async -> ContentSafetyVerdict
}

protocol PageTextSafetyClassifying: Sendable {
    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict
}

/// Uses Apple's on-device Sensitive Content Analysis framework. The framework only
/// operates when its entitlement and the person's system policy permit analysis.
/// A disabled policy, malformed image, or analysis error deliberately returns
/// `.unknown`; the caller applies the explicit build policy for unclassified
/// media. Full-capability builds conceal it, while the Personal Team fallback
/// can reveal it without changing the classifier's verdict globally.
final class AppleSensitiveMediaClassifier: MediaSafetyClassifying, @unchecked Sendable {
    private let analyzer: SCSensitivityAnalyzer

    init(analyzer: SCSensitivityAnalyzer = SCSensitivityAnalyzer()) {
        self.analyzer = analyzer
    }

    func classify(imageData: Data) async -> ContentSafetyVerdict {
        guard analyzer.analysisPolicy != .disabled,
              let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return .unknown
        }

        do {
            let result = try await analyzer.analyzeImage(image)
            return result.isSensitive ? .sensitive : .safe
        } catch {
            return .unknown
        }
    }
}

struct ExplicitContentTextPolicy: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1
    static let resourceName = "ExplicitContentPolicy"

    struct ContextualRule: Codable, Equatable, Sendable {
        let id: String
        let contexts: [String]
        let markers: [String]
        let maximumDistanceCharacters: Int
    }

    let schemaVersion: Int
    let terms: [String]
    let phrases: [String]
    let contextualRules: [ContextualRule]

    static func load(bundle: Bundle = .main) -> Self? {
        guard let url = bundle.url(forResource: resourceName, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let policy = try? JSONDecoder().decode(Self.self, from: data),
              policy.isUsable else { return nil }
        return policy
    }

    var isUsable: Bool {
        schemaVersion == Self.currentSchemaVersion
            && terms.count >= 20
            && phrases.count >= 7
            && terms.allSatisfy(Self.isNormalizedValue)
            && phrases.allSatisfy(Self.isNormalizedValue)
            && contextualRules.allSatisfy { rule in
                !rule.id.isEmpty
                    && !rule.contexts.isEmpty
                    && !rule.markers.isEmpty
                    && (1...1_000).contains(rule.maximumDistanceCharacters)
                    && rule.contexts.allSatisfy(Self.isNormalizedValue)
                    && rule.markers.allSatisfy(Self.isNormalizedValue)
            }
    }

    private static func isNormalizedValue(_ value: String) -> Bool {
        !value.isEmpty
            && value == value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// Applies the generated policy shared with Vigil's navigation rules to the
/// bounded text supplied by the page scanner. A missing, stale, or malformed
/// policy is `.unknown`, which keeps the page concealed instead of silently
/// falling back to a much smaller hard-coded phrase list.
struct ConservativePageTextClassifier: PageTextSafetyClassifying {
    private struct Token: Sendable {
        let value: String
        let offset: Int
    }

    private struct CompiledContextualRule: Sendable {
        let contexts: Set<String>
        let markers: Set<String>
        let maximumDistanceCharacters: Int
    }

    private struct MultilingualRule: Sendable {
        let labels: Set<String>
        let pattern: String
    }

    // Keep these bounded grammatical forms and normalization aligned with
    // containsMultilingualExplicitText in src/explicitMediaContext.ts. A rule
    // is active only when the supplied policy contains its existing label.
    private static let multilingualRules: [MultilingualRule] = [
        .init(labels: ["اباحي", "اباحية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["فيديو جنسي", "فيديوهات جنسية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?فيديو(?:هات)?[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["فيلم جنسي"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?فيلم[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["افلام جنسية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?افلام[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografia", "pornografico", "pornografica"], pattern: #"(?:^|[^\p{L}\p{N}])pornografi(?:a|co|ca)s?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornographie", "pornographique"], pattern: #"(?:^|[^\p{L}\p{N}])pornographi(?:e|ques?)(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografie"], pattern: #"(?:^|[^\p{L}\p{N}])pornografie(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografisch"], pattern: #"(?:^|[^\p{L}\p{N}])pornografisch(?:e[rmns]?)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["порно"], pattern: #"(?:^|[^\p{L}\p{N}])порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["порнография"], pattern: #"(?:^|[^\p{L}\p{N}])порнографи\p{Cyrillic}*(?=$|[^\p{L}\p{N}])"#)
    ]
    private static let latinAccentPattern = try! NSRegularExpression(pattern: #"\p{Latin}\p{M}*"#)

    private struct CompiledPolicy: Sendable {
        let phrases: [String]
        let terms: Set<String>
        let prefixTerms: [String]
        let unspacedTerms: [String]
        let multilingualPatterns: [String]
        let contextualRules: [CompiledContextualRule]
    }

    private let policy: CompiledPolicy?

    init(policy: ExplicitContentTextPolicy? = ExplicitContentTextPolicy.load()) {
        guard let policy, policy.isUsable else {
            self.policy = nil
            return
        }
        let multilingualTerms = Set(policy.terms.map(Self.normalizeMultilingual))
        let multilingualRules = Self.multilingualRules.filter { !$0.labels.isDisjoint(with: multilingualTerms) }
        // Preserve Japanese voicing marks and Korean syllables when matching
        // these labels, rather than applying the ordinary Latin text folding.
        let unspacedTerms = multilingualTerms.filter {
            $0.range(of: #"[\p{Han}\p{Katakana}\p{Hangul}]"#, options: .regularExpression) != nil
        }
        let multilingualLabels = Set(multilingualRules.flatMap { $0.labels }).union(unspacedTerms)
        let terms = Set(policy.terms.filter { !multilingualLabels.contains(Self.normalizeMultilingual($0)) }
            .map(Self.normalize).filter { !$0.isEmpty })
        // Some languages express a policy term with multiple words. Match
        // those as bounded phrases rather than looking for a single token.
        let phrases = Set(policy.phrases.map(Self.normalize).filter { !$0.isEmpty })
            .union(terms.filter { $0.contains(" ") })
        self.policy = CompiledPolicy(
            phrases: phrases.sorted().map { " \($0) " },
            terms: terms.subtracting(["porn", "porno"]),
            prefixTerms: ["porn", "porno"].filter { terms.contains($0) },
            unspacedTerms: unspacedTerms.sorted(),
            multilingualPatterns: multilingualRules.map { $0.pattern },
            contextualRules: policy.contextualRules.map { rule in
                CompiledContextualRule(
                    contexts: Set(rule.contexts.map(Self.normalize)),
                    markers: Set(rule.markers.map(Self.normalize)),
                    maximumDistanceCharacters: rule.maximumDistanceCharacters
                )
            }
        )
    }

    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict {
        _ = wasTruncated
        guard let policy else { return .unknown }
        let multilingualText = Self.normalizeMultilingual(pageText)
        if policy.unspacedTerms.contains(where: multilingualText.contains)
            || policy.multilingualPatterns.contains(where: {
                multilingualText.range(of: $0, options: .regularExpression) != nil
            }) {
            return .sensitive
        }
        let normalized = Self.normalize(pageText)
        let tokens = Self.tokens(normalized)
        guard !tokens.isEmpty else { return .safe }

        let paddedText = " \(normalized) "
        if policy.phrases.contains(where: paddedText.contains)
            || tokens.contains(where: { token in
                policy.terms.contains(token.value)
                    || policy.prefixTerms.contains(where: token.value.hasPrefix)
            })
            || policy.contextualRules.contains(where: { Self.matches($0, in: tokens) }) {
            return .sensitive
        }

        // The caller records truncation for diagnostics, but long feeds should
        // not become unusable solely because they exceed a bounded inspection.
        return .safe
    }

    private static func normalizeMultilingual(_ value: String) -> String {
        var text = value.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"[\u200b-\u200d\u2060\ufeff\u0640]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[أإآٱ]"#, with: "ا", options: .regularExpression)
        let source = text as NSString
        // Fold only Latin accents, as the shared helper does. Other scripts'
        // combining marks can distinguish unrelated words and names.
        for match in latinAccentPattern.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let original = source.substring(with: match.range)
            let unmarked = String(String.UnicodeScalarView(original.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
                switch $0.properties.generalCategory {
                case .nonspacingMark, .spacingMark, .enclosingMark: return false
                default: return true
                }
            }))
            if unmarked != original, let range = Range(match.range, in: text) {
                text.replaceSubrange(range, with: unmarked)
            }
        }
        return text.lowercased()
    }

    private static func normalize(_ value: String) -> String {
        let folded = value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
        var scalars = String.UnicodeScalarView()
        scalars.reserveCapacity(folded.utf8.count)
        for scalar in folded.unicodeScalars {
            scalars.append(CharacterSet.alphanumerics.contains(scalar) ? scalar : " ")
        }
        // Preserve Character-level whitespace handling: combining marks can
        // join a separator's grapheme and must be removed together with it.
        return String(scalars).split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
    }

    private static func tokens(_ normalized: String) -> [Token] {
        var offset = 0
        return normalized.split(separator: " ").map { substring in
            let token = Token(value: String(substring), offset: offset)
            offset += substring.count + 1
            return token
        }
    }

    private static func matches(_ rule: CompiledContextualRule, in tokens: [Token]) -> Bool {
        // Token offsets are ordered. Only the latest occurrence of each side can
        // be the closest match to the current token, so one pass replaces the
        // previous context-by-marker cross product on long, repetitive pages.
        var lastContextOffset: Int?
        var lastMarkerOffset: Int?
        for token in tokens {
            if rule.contexts.contains(token.value) { lastContextOffset = token.offset }
            if rule.markers.contains(token.value) { lastMarkerOffset = token.offset }
            if let context = lastContextOffset, let marker = lastMarkerOffset,
               abs(context - marker) <= rule.maximumDistanceCharacters {
                return true
            }
        }
        return false
    }
}
