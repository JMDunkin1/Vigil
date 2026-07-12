import CryptoKit
import XCTest
@testable import SentinelBrowser

final class SentinelBrowserTests: XCTestCase {
    func testSharedContentSafetyScriptPreblursAndHandlesDynamicMedia() throws {
        let script = try XCTUnwrap(ContentSafetyScript.load())
        XCTAssertTrue(script.contains("filter: blur"))
        XCTAssertTrue(script.contains("MutationObserver"))
        XCTAssertTrue(script.contains("classifyMedia"))
        XCTAssertTrue(script.contains("classifyText"))
        XCTAssertTrue(script.contains("sentinelMediaToken"))
        XCTAssertTrue(script.contains("videoFrame"))
    }

    func testBoundedTextClassifierFindsExplicitPhraseOnLongPage() async {
        let classifier = ConservativePageTextClassifier()
        let explicit = await classifier.classify(pageText: "This page labels explicit sexual content.", wasTruncated: true)
        let ordinary = await classifier.classify(pageText: "Ordinary reference material.", wasTruncated: false)
        XCTAssertEqual(explicit, .sensitive)
        XCTAssertEqual(ordinary, .safe)
    }

    func testOversizedInlineMediaPayloadIsRejected() {
        let oversized = Data(repeating: 1, count: ContentSafetyPayload.maximumMediaBytes + 1).base64EncodedString()
        XCTAssertNil(ContentSafetyPayload.inlineMedia(from: ["dataURL": "data:image/jpeg;base64,\(oversized)"]))
    }

    func testBlocksInsecureAndBlockedHostsIncludingSubdomains() throws {
        var rules = FilterRules.bootstrap
        rules.blockedHosts = ["xvideos.com"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "http://example.com"))), .block(reason: "This browser requires a secure HTTPS connection."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://cdn.xvideos.com/video"))), .block(reason: "This website is blocked by Sentinel."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com"))), .allow(try XCTUnwrap(URL(string: "https://example.com"))))
    }

    func testSafeSearchCannotBeDisabledByIncomingURL() throws {
        let filter = NavigationFilter(rules: .bootstrap)
        let input = try XCTUnwrap(URL(string: "https://www.google.com/search?q=test&safe=off"))
        guard case let .allow(output) = filter.decide(input) else { return XCTFail("Expected URL to be allowed") }
        let safe = URLComponents(url: output, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "safe" }?.value
        XCTAssertEqual(safe, "active")
    }

    func testBlockedTermsAreCheckedOnlyInSearchParameters() throws {
        var rules = FilterRules.bootstrap
        rules.blockedSearchTerms = ["bad query"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com/?q=bad%20query"))), .block(reason: "That search is blocked by Sentinel."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com/bad-query"))), .allow(try XCTUnwrap(URL(string: "https://example.com/bad-query"))))
    }

    func testRulesRoundTripThroughIsolatedDefaults() {
        let suite = "SentinelBrowserTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        var rules = FilterRules.bootstrap
        rules.revision = 42
        rules.blockedHosts += ["Example.COM", "example.com"]
        XCTAssertTrue(SharedFilterStore.write(rules, defaults: defaults))
        let loaded = SharedFilterStore.read(defaults: defaults)
        XCTAssertEqual(loaded.revision, 42)
        XCTAssertEqual(loaded.blockedHosts.filter { $0 == "example.com" }.count, 1)
    }

    func testMissingBundledBlocklistIsAValidFallback() {
        final class EmptyBundle: Bundle, @unchecked Sendable {
            override func url(forResource name: String?, withExtension ext: String?) -> URL? { nil }
        }
        XCTAssertNil(try PhoneBlocklistIndex.loadBundled(bundle: EmptyBundle()))
    }

    func testInvalidBlocklistStateFailsClosed() throws {
        let filter = NavigationFilter(rules: .bootstrap, blocklist: nil, blocklistIntegrityValid: false)
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com"))),
            .block(reason: "Sentinel's content filter failed its integrity check.")
        )
    }

    func testCompactBlocklistBlocksListedParentAndSubdomain() throws {
        let reversed = Data("com.example".utf8)
        var payload = Data([0, UInt8(reversed.count)])
        payload.append(reversed)
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        let metadata = PhoneBlocklistMetadata(
            formatVersion: 1,
            encoding: "blocked-reversed-domain-front-coding-v1",
            blockSize: 64,
            domainCount: 1,
            snapshotHash: "fixture",
            payloadSha256: digest,
            payloadBytes: payload.count,
            generatedAt: "2026-07-12T00:00:00Z",
            source: PhoneBlocklistSource(id: "fixture", label: "Fixture", url: "https://example.test/list", homepage: "https://example.test", license: "fixture-only")
        )
        let metadataData = try JSONEncoder().encode(metadata)
        var artifact = Data("SNTLIDX1".utf8)
        var length = UInt32(metadataData.count).littleEndian
        withUnsafeBytes(of: &length) { artifact.append(contentsOf: $0) }
        artifact.append(metadataData)
        artifact.append(payload)
        let index = try PhoneBlocklistIndex(data: artifact)
        let filter = NavigationFilter(rules: .bootstrap, blocklist: index)
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://images.example.com/path"))),
            .block(reason: "This website is blocked by Sentinel.")
        )
    }
}
