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

    private let policy: ExplicitContentTextPolicy?

    init(policy: ExplicitContentTextPolicy? = ExplicitContentTextPolicy.load()) {
        self.policy = policy
    }

    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict {
        _ = wasTruncated
        guard let policy, policy.isUsable else { return .unknown }
        let normalized = Self.normalize(pageText)
        let tokens = Self.tokens(normalized)
        guard !tokens.isEmpty else { return .safe }

        if policy.phrases.contains(where: { Self.containsPhrase($0, in: normalized) })
            || policy.terms.contains(where: { Self.containsTerm($0, in: tokens) })
            || policy.contextualRules.contains(where: { Self.matches($0, in: tokens) }) {
            return .sensitive
        }

        // The caller records truncation for diagnostics, but long feeds should
        // not become unusable solely because they exceed a bounded inspection.
        return .safe
    }

    private static func normalize(_ value: String) -> String {
        let folded = value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
        let scalars = folded.unicodeScalars.map { scalar -> Character in
            CharacterSet.alphanumerics.contains(scalar) ? Character(String(scalar)) : " "
        }
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

    private static func containsPhrase(_ phrase: String, in normalized: String) -> Bool {
        let candidate = normalize(phrase)
        return !candidate.isEmpty && " \(normalized) ".contains(" \(candidate) ")
    }

    private static func containsTerm(_ term: String, in tokens: [Token]) -> Bool {
        let candidate = normalize(term)
        guard !candidate.isEmpty else { return false }
        if candidate == "porn" || candidate == "porno" {
            return tokens.contains { $0.value.hasPrefix(candidate) }
        }
        return tokens.contains { $0.value == candidate }
    }

    private static func matches(_ rule: ExplicitContentTextPolicy.ContextualRule, in tokens: [Token]) -> Bool {
        let contexts = Set(rule.contexts.map(normalize))
        let markers = Set(rule.markers.map(normalize))
        let contextOffsets = tokens.filter { contexts.contains($0.value) }.map(\.offset)
        let markerOffsets = tokens.filter { markers.contains($0.value) }.map(\.offset)
        return contextOffsets.contains { contextOffset in
            markerOffsets.contains { markerOffset in
                abs(contextOffset - markerOffset) <= rule.maximumDistanceCharacters
            }
        }
    }
}
