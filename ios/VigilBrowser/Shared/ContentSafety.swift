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

final class AppleSensitiveMediaClassifier: MediaSafetyClassifying, @unchecked Sendable {
    private let analyzer: SCSensitivityAnalyzer

    init(analyzer: SCSensitivityAnalyzer = SCSensitivityAnalyzer()) {
        self.analyzer = analyzer
    }

    func classify(imageData: Data) async -> ContentSafetyVerdict {
        guard analyzer.analysisPolicy != .disabled,
              let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return .unknown }
        do {
            return try await analyzer.analyzeImage(image).isSensitive ? .sensitive : .safe
        } catch {
            return .unknown
        }
    }
}

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
        return Self.explicitPhrases.contains(where: normalized.contains) ? .sensitive : .safe
    }
}

enum ContentSafetyPayload {
    static let maximumMediaBytes = 4 * 1024 * 1024

    static func inlineMedia(from body: [String: Any]) -> Data? {
        guard let dataURL = body["dataURL"] as? String,
              let comma = dataURL.firstIndex(of: ","),
              dataURL.prefix(upTo: comma).contains(";base64"),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              data.count <= maximumMediaBytes else { return nil }
        return data
    }

}

enum ContentSafetyScript {
    static func load(bundle: Bundle = .main) -> String? {
        guard let url = bundle.url(forResource: "ContentSafety", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    static let failClosedBootstrap = "document.documentElement.style.setProperty('visibility','hidden','important');"
}
