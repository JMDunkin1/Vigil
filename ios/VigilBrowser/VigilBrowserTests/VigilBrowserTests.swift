import CryptoKit
import XCTest
@testable import VigilBrowser

final class VigilBrowserTests: XCTestCase {
    func testSharedContentSafetyScriptPreblursAndHandlesDynamicMedia() throws {
        let script = try XCTUnwrap(ContentSafetyScript.load())
        XCTAssertTrue(script.contains("filter: blur"))
        XCTAssertTrue(script.contains("MutationObserver"))
        XCTAssertTrue(script.contains("classifyMedia"))
        XCTAssertTrue(script.contains("classifyText"))
        XCTAssertTrue(script.contains("vigilMediaToken"))
        XCTAssertTrue(script.contains("videoFrame"))
        XCTAssertTrue(script.contains("canvas, svg"))
        XCTAssertTrue(script.contains("background-image: none"))
        XCTAssertFalse(script.contains("sourceURL"))
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

    func testBlockedPageIsBrandedAndUsesValidatedNativeEscapeAction() throws {
        let attempted = try XCTUnwrap(URL(string: "https://example.com/shorts/<script>alert(1)</script>"))
        let nonce = try XCTUnwrap(UUID(uuidString: "11111111-2222-3333-4444-555555555555"))
        let documentNonce = try XCTUnwrap(UUID(uuidString: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
        let escapeURL = VigilBlockedPage.escapeURL(nonce: nonce)
        let documentURL = VigilBlockedPage.documentURL(nonce: documentNonce)
        let html = VigilBlockedPage.html(reason: "Page <blocked>", attemptedURL: attempted, escapeURL: escapeURL)

        XCTAssertTrue(html.contains("data-vigil-block-page=\"1\""))
        XCTAssertTrue(html.contains("radial-gradient"))
        XCTAssertTrue(html.contains("#b77952"))
        XCTAssertTrue(html.contains(">Vigil<"))
        XCTAssertTrue(html.contains(">Go back<"))
        XCTAssertTrue(html.contains("href=\"\(escapeURL.absoluteString)\""))
        XCTAssertFalse(html.contains("Page <blocked>"))
        XCTAssertEqual(VigilBlockedPage.fallbackURL.absoluteString, "about:blank")
        XCTAssertEqual(documentURL.absoluteString, "https://blocked.vigil.invalid/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        XCTAssertTrue(VigilBlockedPage.isDocumentURL(documentURL))
        XCTAssertFalse(VigilBlockedPage.isDocumentURL(try XCTUnwrap(URL(string: "https://blocked.vigil.invalid.example/page"))))
        XCTAssertNotEqual(documentURL, VigilBlockedPage.fallbackURL)
        XCTAssertNotEqual(documentURL, escapeURL)
    }

    func testBlockedSurfaceKeepsItsNonceAndStateUntilValidatedNavigationCommits() throws {
        let nonce = try XCTUnwrap(UUID(uuidString: "11111111-2222-3333-4444-555555555555"))
        let otherNonce = try XCTUnwrap(UUID(uuidString: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))
        let escapeURL = VigilBlockedPage.escapeURL(nonce: nonce)
        let wrongEscapeURL = VigilBlockedPage.escapeURL(nonce: otherNonce)
        var state = BrowserSurfaceState.blocked(BrowserBlockedPageSession(escapeURL: escapeURL))

        XCTAssertTrue(state.isShowingBlockedPage)
        XCTAssertFalse(state.isBlockedPageCommitted)
        XCTAssertFalse(state.canEscapeBlockedPage)
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))

        state.blockedPageDidCommit()
        XCTAssertTrue(state.isBlockedPageCommitted)
        XCTAssertTrue(state.canEscapeBlockedPage)
        XCTAssertTrue(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
        XCTAssertFalse(state.acceptsEscape(
            wrongEscapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
        XCTAssertFalse(state.acceptsEscape(
            try XCTUnwrap(URL(string: "\(escapeURL.absoluteString)?replayed=1")),
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: false,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: false,
            isLinkActivation: true
        ))
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: false
        ))

        state.beginAllowedNavigation()
        XCTAssertTrue(state.isShowingBlockedPage)
        XCTAssertTrue(state.isLeavingBlockedPage)
        XCTAssertFalse(state.canEscapeBlockedPage)
        XCTAssertFalse(state.allowsBackForwardNavigationGestures)
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
        state.pendingAllowedNavigationDidFail()
        XCTAssertTrue(state.isShowingBlockedPage)
        XCTAssertTrue(state.isBlockedPageCommitted)
        XCTAssertFalse(state.isLeavingBlockedPage)
        XCTAssertTrue(state.canEscapeBlockedPage)

        state.beginAllowedNavigation()
        state.allowedNavigationDidCommit()
        XCTAssertEqual(state, .browsing)
        XCTAssertTrue(state.allowsBackForwardNavigationGestures)
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
    }

    func testExplicitNeutralEscapeIsDistinctFromCommittedSyntheticBlock() throws {
        let nonce = try XCTUnwrap(UUID(uuidString: "11111111-2222-3333-4444-555555555555"))
        let escapeURL = VigilBlockedPage.escapeURL(nonce: nonce)
        var state = BrowserSurfaceState.blocked(BrowserBlockedPageSession(
            escapeURL: escapeURL,
            isCommitted: true
        ))

        state.beginAllowedNavigation()
        state.neutralNavigationDidCommit()

        XCTAssertTrue(state.isAtNeutralEscapePage)
        XCTAssertFalse(state.isShowingBlockedPage)
        XCTAssertFalse(state.canEscapeBlockedPage)
        XCTAssertFalse(state.allowsBackForwardNavigationGestures)
        XCTAssertFalse(state.acceptsEscape(
            escapeURL,
            sourceIsMainFrame: true,
            targetIsMainFrame: true,
            isLinkActivation: true
        ))
    }

    func testBlocksInsecureAndBlockedHostsIncludingSubdomains() throws {
        var rules = FilterRules.bootstrap
        rules.blockedHosts = ["xvideos.com"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "http://example.com"))), .block(reason: "This browser requires a secure HTTPS connection."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://cdn.xvideos.com/video"))), .block(reason: "This website is blocked by Vigil."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com"))), .allow(try XCTUnwrap(URL(string: "https://example.com"))))
    }

    func testTrailingDotCannotBypassHostRulesOrSafeSearch() throws {
        var rules = FilterRules.bootstrap
        rules.blockedHosts = ["blocked.example"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://blocked.example./path"))),
            .block(reason: "This website is blocked by Vigil.")
        )
        let google = try XCTUnwrap(URL(string: "https://www.google.com./search?q=test&safe=off"))
        guard case let .allow(output) = filter.decide(google) else { return XCTFail("Expected dotted Google host to be allowed safely") }
        let safe = URLComponents(url: output, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "safe" }?.value
        XCTAssertEqual(safe, "active")
    }

    func testEncodedPathsAndSearchTermsCannotBypassRules() throws {
        var rules = FilterRules.bootstrap
        rules.blockedURLFragments = ["/shorts/"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com/%73horts/video"))),
            .block(reason: "This page is blocked by Vigil.")
        )
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com/%2573horts/video"))),
            .block(reason: "This page is blocked by Vigil.")
        )
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com/%25ZZ/%2573horts/video"))),
            .block(reason: "This page is blocked by Vigil.")
        )
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com/%ff%2fshorts%2fvideo"))),
            .block(reason: "This page is blocked by Vigil.")
        )
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://example.com/search?q=%2570orn"))),
            .block(reason: "That search is blocked by Vigil.")
        )
    }

    func testSafeSearchCannotBeDisabledByIncomingURL() throws {
        let filter = NavigationFilter(rules: .bootstrap)
        let input = try XCTUnwrap(URL(string: "https://www.google.com/search?q=test&safe=off"))
        guard case let .allow(output) = filter.decide(input) else { return XCTFail("Expected URL to be allowed") }
        let safe = URLComponents(url: output, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "safe" }?.value
        XCTAssertEqual(safe, "active")
    }

    func testExplicitSearchTermsAreBlockedByDefault() throws {
        let filter = NavigationFilter(rules: .bootstrap)
        XCTAssertTrue(FilterRules.bootstrap.blockedSearchTerms.contains("porn"))
        XCTAssertEqual(
            filter.decide(try XCTUnwrap(URL(string: "https://www.google.com/search?q=porn"))),
            .block(reason: "That search is blocked by Vigil.")
        )
    }

    func testBlockedTermsAreCheckedOnlyInSearchParameters() throws {
        var rules = FilterRules.bootstrap
        rules.blockedSearchTerms = ["bad query"]
        let filter = NavigationFilter(rules: rules)
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com/?q=bad%20query"))), .block(reason: "That search is blocked by Vigil."))
        XCTAssertEqual(filter.decide(try XCTUnwrap(URL(string: "https://example.com/bad-query"))), .allow(try XCTUnwrap(URL(string: "https://example.com/bad-query"))))
    }

    func testRulesRoundTripThroughIsolatedDefaults() {
        let suite = "VigilBrowserTests.\(UUID().uuidString)"
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

    func testLegacyRulesGainAlwaysOnExplicitSearchTerms() throws {
        let suite = "VigilBrowserTests.legacy.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacy = FilterRules(
            schemaVersion: 1,
            revision: 7,
            blockedHosts: ["custom.example"],
            blockedURLFragments: [],
            blockedSearchTerms: [],
            safeSearchEnabled: true
        )
        defaults.set(try JSONEncoder().encode(legacy), forKey: SharedFilterStore.rulesKey)

        let loaded = SharedFilterStore.read(defaults: defaults)

        XCTAssertEqual(loaded.schemaVersion, FilterRules.currentSchema)
        XCTAssertEqual(loaded.revision, 7)
        XCTAssertTrue(loaded.blockedSearchTerms.contains("porn"))
        let persisted = try XCTUnwrap(defaults.data(forKey: SharedFilterStore.rulesKey))
        XCTAssertEqual(try JSONDecoder().decode(FilterRules.self, from: persisted), loaded)
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
            .block(reason: "Vigil's content filter failed its integrity check.")
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
            .block(reason: "This website is blocked by Vigil.")
        )

        let sparseOffsets = Data([0, 0, 0, 0])
        let sparseDigest = SHA256.hash(data: sparseOffsets).map { String(format: "%02x", $0) }.joined()
        let versionTwoMetadata = PhoneBlocklistMetadata(
            formatVersion: 2,
            encoding: "blocked-reversed-domain-front-coding-v2",
            blockSize: 64,
            domainCount: 1,
            sourceDomainCount: 2,
            snapshotHash: "fixture-v2",
            indexSha256: sparseDigest,
            indexBytes: sparseOffsets.count,
            payloadSha256: digest,
            payloadBytes: payload.count,
            generatedAt: "2026-08-03T00:00:00Z",
            source: PhoneBlocklistSource(id: "fixture", label: "Fixture", url: "https://example.test/list", homepage: "https://example.test", license: "fixture-only")
        )
        let versionTwoMetadataData = try JSONEncoder().encode(versionTwoMetadata)
        var versionTwoArtifact = Data("SNTLIDX1".utf8)
        var versionTwoLength = UInt32(versionTwoMetadataData.count).littleEndian
        withUnsafeBytes(of: &versionTwoLength) { versionTwoArtifact.append(contentsOf: $0) }
        versionTwoArtifact.append(versionTwoMetadataData)
        versionTwoArtifact.append(sparseOffsets)
        versionTwoArtifact.append(payload)
        let versionTwoIndex = try PhoneBlocklistIndex(data: versionTwoArtifact)
        XCTAssertEqual(versionTwoIndex.matchingDomain(for: "images.example.com"), "example.com")
    }
}
