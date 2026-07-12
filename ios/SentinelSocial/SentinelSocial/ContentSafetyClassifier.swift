import CoreGraphics
import Foundation
import ImageIO
import SensitiveContentAnalysis

enum ContentSafetyVerdict: String, Equatable, Sendable {
    case safe
    case sensitive
    case unknown
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
/// `.unknown`; callers must keep the media concealed in that state.
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

/// A deliberately narrow text backstop. It identifies unambiguous phrases in
/// the bounded text supplied by the page scanner. Truncation is retained so a
/// richer injected classifier can apply a different policy.
struct ConservativePageTextClassifier: PageTextSafetyClassifying {
    private static let explicitPhrases = [
        "pornographic content", "explicit sexual content", "hardcore pornography",
        "nude photos", "nude videos", "sex videos", "xxx videos"
    ]

    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict {
        _ = wasTruncated
        let normalized = pageText
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .lowercased()
        if Self.explicitPhrases.contains(where: normalized.contains) {
            return .sensitive
        }
        // The caller records truncation for diagnostics, but long feeds should
        // not become unusable solely because they exceed a bounded inspection.
        return .safe
    }
}
