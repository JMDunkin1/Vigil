import XCTest
import WebKit
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
    func testContentFilterPreblursAndObservesDynamicMediaAndText() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(bootstrap.contains("filter: blur"))
        XCTAssertTrue(bootstrap.contains("background-image: none"))
        XCTAssertTrue(bootstrap.contains("canvas, svg"))
        XCTAssertTrue(bootstrap.contains("vigilPageVerdict = 'unknown'"))
        XCTAssertTrue(script.contains("mediaCandidate"))
        XCTAssertTrue(script.contains("pageText"))
        XCTAssertTrue(script.contains("MutationObserver"))
        XCTAssertTrue(script.contains("videoFrame"))
        XCTAssertTrue(script.contains("__vigilResolveMedia"))
        XCTAssertFalse(script.contains("sourceURL"))
    }

    func testConservativeTextClassifierStillChecksBoundedTextWhenPageIsLong() async {
        let classifier = ConservativePageTextClassifier()
        let truncated = await classifier.classify(pageText: "ordinary page", wasTruncated: true)
        let explicit = await classifier.classify(pageText: "contains explicit sexual content", wasTruncated: false)
        let ordinary = await classifier.classify(pageText: "ordinary page", wasTruncated: false)
        XCTAssertEqual(truncated, .safe)
        XCTAssertEqual(explicit, .sensitive)
        XCTAssertEqual(ordinary, .safe)
    }

    func testInjectedMediaClassifierCanBeUsedWithoutAProductionModel() async {
        let classifier = StubMediaClassifier(verdict: .sensitive)
        let verdict = await classifier.classify(imageData: Data([1, 2, 3]))
        XCTAssertEqual(verdict, .sensitive)
    }

    func testDeepLinksResolveServices() throws {
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "vigilsocial://open/youtube"))), .youtube)
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))), .instagram)
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "https://web.snapchat.com/"))), .snapchat)
        XCTAssertNil(SocialService.resolve(try XCTUnwrap(URL(string: "http://www.instagram.com/"))))
        XCTAssertNil(SocialService.resolve(try XCTUnwrap(URL(string: "https://example.com/"))))
    }

    func testServicesOnlyAllowTheirRequiredHTTPSNavigationHosts() throws {
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://accounts.google.com/"))))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://example.com/"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "http://www.instagram.com/"))))
        XCTAssertTrue(SocialService.snapchat.allowsNavigation(to: try XCTUnwrap(URL(string: "https://accounts.snapchat.com/"))))
    }

    func testEveryServiceHasAnHTTPSHomeURL() {
        for service in SocialService.allCases {
            XCTAssertEqual(service.homeURL.scheme, "https")
        }
    }

    func testYouTubeAdapterBlocksShortsAndPersistsPlayback() {
        let script = DOMAdapters.script(for: .youtube, audioEnabled: true)
        XCTAssertTrue(script.contains("/shorts"))
        XCTAssertTrue(script.contains("playbackRequest"))
        XCTAssertTrue(script.contains("__vigilRestorePlayback"))
        XCTAssertTrue(script.contains("disallowed_useragent"))
        XCTAssertTrue(script.contains("YouTube is signed out"))
    }

    func testInstagramAdapterUsesFullWidthAndRememberedAudio() {
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(script.contains("max-width: none"))
        XCTAssertTrue(script.contains("touch-action: pan-y"))
        XCTAssertTrue(script.contains("__vigilAudioPreferred = true"))
    }

    func testSnapchatAdapterIsExplicitlyExperimental() {
        let script = DOMAdapters.script(for: .snapchat, audioEnabled: false)
        let preflight = DOMAdapters.preflightScript(for: .snapchat)
        XCTAssertTrue(script.contains("spotlight"))
        XCTAssertTrue(script.contains("stories"))
        XCTAssertTrue(script.contains("unsupported"))
        XCTAssertTrue(preflight?.contains("MacIntel") == true)
        XCTAssertNil(DOMAdapters.preflightScript(for: .instagram))
    }

    func testAppDoesNotDeclareBackgroundAudioOrLiveActivities() {
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes"))
        XCTAssertNotEqual(Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool, true)
    }

    @MainActor
    func testServiceWebViewsAreDistinctAndPersistent() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .youtube, loadInitialPages: false)
        let youtube = store.webView(for: .youtube)
        XCTAssertTrue(youtube === store.webView(for: .youtube))
        XCTAssertFalse(youtube === store.webView(for: .instagram))
        XCTAssertFalse(youtube === store.webView(for: .snapchat))
    }

    @MainActor
    func testConfiguredAppCannotSwitchIntoAnotherService() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .instagram, loadInitialPages: false)
        store.select(.youtube)
        XCTAssertEqual(store.selectedService, .instagram)
        XCTAssertEqual(store.fixedService, .instagram)
    }

    @MainActor
    func testCombinedAppCanSwitchServicesAndRememberSelection() {
        let defaults = UserDefaults(suiteName: #function)!
        defaults.removePersistentDomain(forName: #function)
        let store = SocialWebViewStore(defaults: defaults, loadInitialPages: false)
        XCTAssertNil(store.fixedService)
        store.select(.instagram)
        XCTAssertEqual(store.selectedService, .instagram)
        let restored = SocialWebViewStore(defaults: defaults, loadInitialPages: false)
        XCTAssertEqual(restored.selectedService, .instagram)
    }

    @MainActor
    func testSwitchingServicesPausesPreviousRetainedWebView() async throws {
        let defaults = UserDefaults(suiteName: #function)!
        defaults.removePersistentDomain(forName: #function)
        let store = SocialWebViewStore(defaults: defaults, loadInitialPages: false)
        let youtube = store.webView(for: .youtube)
        let navigation = TestNavigationDelegate()
        let loaded = expectation(description: "test page loaded")
        navigation.didFinish = { loaded.fulfill() }
        youtube.navigationDelegate = navigation
        youtube.loadHTMLString("<html><body></body></html>", baseURL: nil)
        await fulfillment(of: [loaded], timeout: 5)
        _ = try await youtube.evaluateJavaScript("""
            window.__vigilDidPause = false;
            window.__vigilPauseAllMedia = () => { window.__vigilDidPause = true; };
            """)

        store.select(.instagram)

        let didPause = try await youtube.evaluateJavaScript("window.__vigilDidPause") as? Bool
        XCTAssertEqual(didPause, true)
    }
}

private final class TestNavigationDelegate: NSObject, WKNavigationDelegate {
    var didFinish: (() -> Void)?

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        didFinish?()
    }
}

private struct StubMediaClassifier: MediaSafetyClassifying {
    let verdict: ContentSafetyVerdict
    func classify(imageData: Data) async -> ContentSafetyVerdict { verdict }
}
