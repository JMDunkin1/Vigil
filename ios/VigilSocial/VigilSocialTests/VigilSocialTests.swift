import XCTest
import WebKit
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
    func testContentFilterPreblursAndObservesDynamicMediaAndText() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(bootstrap.contains("filter: blur"))
        XCTAssertTrue(bootstrap.contains("background-image: none"))
        XCTAssertTrue(bootstrap.contains("canvas, object, embed"))
        XCTAssertTrue(bootstrap.contains("svg image, svg foreignObject"))
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

    func testUnclassifiedMediaPolicyDefaultsRestrictiveAndOnlyRelaxesUnknown() {
        let defaultPolicy = UnclassifiedMediaPolicy(infoDictionaryValue: nil)
        let invalidPolicy = UnclassifiedMediaPolicy(infoDictionaryValue: "allow")
        let personalTeamPolicy = UnclassifiedMediaPolicy(infoDictionaryValue: "reveal-unclassified")

        XCTAssertEqual(defaultPolicy, .conceal)
        XCTAssertEqual(invalidPolicy, .conceal)
        XCTAssertEqual(personalTeamPolicy, .revealUnclassified)
        XCTAssertEqual(personalTeamPolicy.resolve(.unknown), .safe)
        XCTAssertEqual(personalTeamPolicy.resolve(.safe), .safe)
        XCTAssertEqual(personalTeamPolicy.resolve(.sensitive), .sensitive)
        XCTAssertEqual(defaultPolicy.resolve(.unknown), .unknown)
    }

    func testPersonalTeamBootstrapAllowsUnclassifiedVisualsButKeepsInspection() {
        let bootstrap = DOMAdapters.contentFilterBootstrap(for: .revealUnclassified)
        let script = DOMAdapters.script(for: .youtube, audioEnabled: true)

        XCTAssertTrue(bootstrap.contains("filter: blur"))
        XCTAssertFalse(bootstrap.contains("background-image: none"))
        XCTAssertFalse(bootstrap.contains("canvas, object, embed"))
        XCTAssertTrue(bootstrap.contains("vigilUnclassifiedMediaPolicy = 'reveal-unclassified'"))
        XCTAssertTrue(script.contains("mediaCandidate"))
        XCTAssertTrue(script.contains("pageText"))
        XCTAssertTrue(script.contains("/shorts"))
    }

    func testDeepLinksResolveServices() throws {
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "vigilsocial://open/youtube"))), .youtube)
        XCTAssertEqual(SocialService.resolve(try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))), .instagram)
        XCTAssertEqual(SocialService.allCases, [.instagram, .youtube])
        XCTAssertNil(SocialService.resolve(try XCTUnwrap(URL(string: "http://www.instagram.com/"))))
        XCTAssertNil(SocialService.resolve(try XCTUnwrap(URL(string: "https://example.com/"))))
    }

    func testServicesOnlyAllowTheirRequiredHTTPSNavigationHosts() throws {
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://accounts.google.com/"))))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://music.youtube.com/"))))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://example.com/"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "http://www.instagram.com/"))))
        XCTAssertTrue(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/login.php"))))
        XCTAssertTrue(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/v21.0/dialog/oauth?client_id=1"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/"))))
    }

    func testYouTubeShortsIsARestrictedNavigationSurface() throws {
        XCTAssertTrue(SocialService.youtube.isRestrictedSurface(try XCTUnwrap(URL(string: "https://m.youtube.com/shorts/abc"))))
        XCTAssertFalse(SocialService.youtube.isRestrictedSurface(try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=abc"))))
        XCTAssertTrue(SocialService.youtube.isRestrictedSurface(try XCTUnwrap(URL(string: "https://example.com/shorts/abc"))))
    }

    func testEveryServiceHasAnHTTPSHomeURL() {
        for service in SocialService.allCases {
            XCTAssertEqual(service.homeURL.scheme, "https")
        }
        XCTAssertEqual(SocialService.instagram.homeURL.path, "/")
        XCTAssertEqual(SocialService.youtube.homeURL.path, "/")
    }

    func testYouTubeAdapterBlocksShortsAndPersistsPlayback() {
        let script = DOMAdapters.script(for: .youtube, audioEnabled: true)
        XCTAssertTrue(script.contains("/shorts"))
        XCTAssertTrue(script.contains("enforceShortsLocation"))
        XCTAssertTrue(script.contains("vigilPolicyTier"))
        XCTAssertTrue(script.contains("/feed/explore?__vigil_policy_probe__=1"))
        XCTAssertTrue(script.contains("response.ok"))
        XCTAssertTrue(script.contains("response.status >= 200"))
        XCTAssertTrue(script.contains("responseURL.protocol === 'https:'"))
        XCTAssertTrue(script.contains("responseHost.endsWith('.youtube.com')"))
        XCTAssertTrue(script.contains("responseURL.pathname === requestedURL.pathname"))
        XCTAssertTrue(script.contains("responseURL.searchParams.get('__vigil_policy_probe__') === '1'"))
        XCTAssertFalse(script.contains("!response.redirected"))
        XCTAssertFalse(script.contains("responseURL.search === requestedURL.search"))
        XCTAssertFalse(script.contains("SERVICE_DOMAIN"))
        XCTAssertTrue(script.contains("publish(accepted ? 'normal' : 'soft')"))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-soft-hidden')"))
        XCTAssertTrue(script.contains("playbackRequest"))
        XCTAssertTrue(script.contains("__vigilRestorePlayback"))
        XCTAssertTrue(script.contains("disallowed_useragent"))
        XCTAssertTrue(script.contains("YouTube is signed out"))
    }

    func testInstagramAdapterUsesFullWidthAndRememberedAudio() {
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertTrue(script.contains("max-width: none"))
        XCTAssertTrue(script.contains("touch-action: pan-x pan-y"))
        XCTAssertTrue(script.contains("/reels/?__vigil_policy_probe__=1"))
        XCTAssertTrue(script.contains("responseHost.endsWith('.instagram.com')"))
        XCTAssertTrue(script.contains("suggested for you"))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-soft-hidden')"))
        XCTAssertTrue(script.contains("__vigilAudioPreferred = true"))
    }

    func testServicesUseDifferentNavigationGesturePolicies() {
        XCTAssertFalse(SocialService.instagram.allowsBackForwardNavigationGestures)
        XCTAssertFalse(SocialService.instagram.usesDirectionalScrollLock)
        XCTAssertTrue(SocialService.youtube.allowsBackForwardNavigationGestures)
        XCTAssertTrue(SocialService.youtube.usesDirectionalScrollLock)
    }

    func testAppDoesNotDeclareBackgroundAudioOrLiveActivities() {
        XCTAssertNil(Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes"))
        XCTAssertNotEqual(Bundle.main.object(forInfoDictionaryKey: "NSSupportsLiveActivities") as? Bool, true)
    }

    func testSafetyBootstrapKeepsVectorInterfaceChromeUsable() {
        let script = DOMAdapters.contentFilterBootstrap
        XCTAssertFalse(script.contains("canvas, svg, object"))
        XCTAssertFalse(script.contains("content: normal"))
        XCTAssertFalse(script.contains("mask-image: none"))
        XCTAssertTrue(script.contains("svg image, svg foreignObject"))
    }

    @MainActor
    func testFixedAppKeepsOnePersistentServiceWebView() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .youtube, loadInitialPages: false)
        let youtube = store.webView(for: .youtube)
        XCTAssertTrue(youtube === store.webView(for: .youtube))
        XCTAssertTrue(youtube === store.webView(for: .instagram))
    }

    @MainActor
    func testConfiguredAppCannotSwitchIntoAnotherService() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .instagram, loadInitialPages: false)
        store.select(.youtube)
        XCTAssertEqual(store.selectedService, .instagram)
        XCTAssertEqual(store.fixedService, .instagram)
    }

    @MainActor
    func testUnconfiguredLegacyBundleStillDefaultsToAFixedService() {
        let defaults = UserDefaults(suiteName: #function)!
        defaults.removePersistentDomain(forName: #function)
        let store = SocialWebViewStore(defaults: defaults, loadInitialPages: false)
        store.select(.instagram)
        XCTAssertEqual(store.fixedService, .youtube)
        XCTAssertEqual(store.selectedService, .youtube)
    }
}

private struct StubMediaClassifier: MediaSafetyClassifying {
    let verdict: ContentSafetyVerdict
    func classify(imageData: Data) async -> ContentSafetyVerdict { verdict }
}
