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

protocol MediaDataLoading: Sendable {
    func loadImage(from url: URL, maximumBytes: Int) async -> Data?
}

/// Cookie-free fallback for cross-origin images that WebKit cannot copy to a
/// canvas. Streaming enforces the byte ceiling without buffering an untrusted
/// response in full. Only public-looking HTTPS hosts are accepted.
struct EphemeralMediaDataLoader: MediaDataLoading {
    func loadImage(from url: URL, maximumBytes: Int) async -> Data? {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              !host.isEmpty,
              host != "localhost", !host.hasSuffix(".local"),
              !Self.isPrivateAddress(host) else { return nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 12
        let session = URLSession(configuration: configuration)
        var request = URLRequest(url: url)
        request.setValue("image/avif,image/webp,image/*", forHTTPHeaderField: "Accept")

        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse,
                  (200..<300).contains(http.statusCode),
                  http.url?.scheme?.lowercased() == "https",
                  let finalHost = http.url?.host?.lowercased(),
                  finalHost != "localhost", !finalHost.hasSuffix(".local"),
                  !Self.isPrivateAddress(finalHost),
                  http.mimeType?.lowercased().hasPrefix("image/") == true,
                  response.expectedContentLength <= Int64(maximumBytes) else { return nil }
            var data = Data()
            data.reserveCapacity(min(maximumBytes, max(0, Int(response.expectedContentLength))))
            for try await byte in bytes {
                guard data.count < maximumBytes else { return nil }
                data.append(byte)
            }
            return data.isEmpty ? nil : data
        } catch {
            return nil
        }
    }

    private static func isPrivateAddress(_ host: String) -> Bool {
        if host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") { return true }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 10
            || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168)
    }
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
