import XCTest
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
    func testContentFilterPreblursAndObservesDynamicMediaAndText() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(bootstrap.contains("filter: blur"))
        XCTAssertFalse(bootstrap.contains("background-image"))
        XCTAssertTrue(bootstrap.contains("vigilPageVerdict = 'unknown'"))
        XCTAssertTrue(script.contains("mediaCandidate"))
        XCTAssertTrue(script.contains("pageText"))
        XCTAssertTrue(script.contains("MutationObserver"))
        XCTAssertTrue(script.contains("videoFrame"))
        XCTAssertTrue(script.contains("__vigilResolveMedia"))
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

    func testMediaLoaderRejectsLocalAndInsecureURLs() async throws {
        let loader = EphemeralMediaDataLoader()
        let insecure = await loader.loadImage(from: try XCTUnwrap(URL(string: "http://example.com/a.jpg")), maximumBytes: 10)
        let local = await loader.loadImage(from: try XCTUnwrap(URL(string: "https://127.0.0.1/a.jpg")), maximumBytes: 10)
        XCTAssertNil(insecure)
        XCTAssertNil(local)
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
}

private struct StubMediaClassifier: MediaSafetyClassifying {
    let verdict: ContentSafetyVerdict
    func classify(imageData: Data) async -> ContentSafetyVerdict { verdict }
}
