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

struct EphemeralMediaDataLoader: MediaDataLoading {
    func loadImage(from url: URL, maximumBytes: Int) async -> Data? {
        guard Self.allows(url) else { return nil }
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
                  let finalURL = http.url, Self.allows(finalURL),
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

    private static func allows(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased(),
              !host.isEmpty, host != "localhost", !host.hasSuffix(".local") else { return false }
        if host == "::1" || host.hasPrefix("fe80:") || host.hasPrefix("fc") || host.hasPrefix("fd") { return false }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return true }
        return !(octets[0] == 10 || octets[0] == 127
            || (octets[0] == 169 && octets[1] == 254)
            || (octets[0] == 172 && (16...31).contains(octets[1]))
            || (octets[0] == 192 && octets[1] == 168))
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

    static func sourceURL(from body: [String: Any]) -> URL? {
        (body["sourceURL"] as? String).flatMap(URL.init(string:))
    }
}

enum ContentSafetyScript {
    static func load(bundle: Bundle = .main) -> String? {
        guard let url = bundle.url(forResource: "ContentSafety", withExtension: "js") else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    static let failClosedBootstrap = "document.documentElement.style.setProperty('visibility','hidden','important');"
}
