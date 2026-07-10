import XCTest
@testable import SentinelSocial

final class SentinelSocialTests: XCTestCase {
    func testDeepLinksResolveServices() throws {
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "sentinelsocial://open/youtube"))), .youtube)
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))), .instagram)
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "https://web.snapchat.com/"))), .snapchat)
        XCTAssertNil(SocialService.resolve(try XCTUnwrap(URL(string: "https://example.com/"))))
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
        XCTAssertTrue(script.contains("__sentinelRestorePlayback"))
        XCTAssertTrue(script.contains("disallowed_useragent"))
        XCTAssertTrue(script.contains("YouTube is signed out"))
    }

    func testInstagramAdapterUsesFullWidthAndRememberedAudio() {
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(script.contains("max-width: none"))
        XCTAssertTrue(script.contains("touch-action: pan-y"))
        XCTAssertTrue(script.contains("__sentinelAudioPreferred = true"))
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
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .youtube)
        let youtube = store.webView(for: .youtube)
        XCTAssertTrue(youtube === store.webView(for: .youtube))
        XCTAssertFalse(youtube === store.webView(for: .instagram))
        XCTAssertFalse(youtube === store.webView(for: .snapchat))
    }

    @MainActor
    func testConfiguredAppCannotSwitchIntoAnotherService() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .instagram)
        store.select(.youtube)
        XCTAssertEqual(store.selectedService, .instagram)
        XCTAssertEqual(store.fixedService, .instagram)
    }
}
