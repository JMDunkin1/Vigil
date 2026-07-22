import XCTest
import JavaScriptCore
import WebKit
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
    func testGeneratedJavaScriptParses() throws {
        let context = try XCTUnwrap(JSContext())
        let scripts = [
            DOMAdapters.contentFilterBootstrap,
            DOMAdapters.contentFilterBootstrap(for: .revealUnclassified),
            DOMAdapters.script(for: .instagram, audioEnabled: true),
            DOMAdapters.script(for: .youtube, audioEnabled: false)
        ]
        for script in scripts {
            context.exception = nil
            context.setObject(script, forKeyedSubscript: "source" as NSString)
            context.evaluateScript("new Function(source)")
            XCTAssertNil(context.exception, context.exception?.toString() ?? "Generated JavaScript did not parse")
        }
    }

    @MainActor
    func testDynamicVisualMutationsReturnToFailClosedState() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.contentFilterBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.frameSafetyScript(audioEnabled: true),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        let loaded = expectation(description: "fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head></head><body>
              <div id="target" style="width:200px;height:200px;background-image:url('data:image/gif;base64,R0lGODlhAQABAAAAACw=')"></div>
              <div id="empty" style="width:200px;height:200px"></div>
              <div id="gradient" style="width:200px;height:200px;background-image:linear-gradient(red, blue)"></div>
              <img id="image" width="64" height="64" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
            </body></html>
            """#,
            baseURL: URL(string: "https://www.instagram.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await Task.sleep(nanoseconds: 350_000_000)

        let initialEmptyVerdict = try await webView.evaluateJavaScript(
            "document.getElementById('empty').dataset.vigilBackgroundVerdict"
        ) as? String
        XCTAssertEqual(initialEmptyVerdict, "none")

        let gradientState = try await webView.evaluateJavaScript(
            "[document.getElementById('gradient').dataset.vigilBackgroundVerdict, getComputedStyle(document.getElementById('gradient')).backgroundImage]"
        ) as? [String]
        XCTAssertEqual(gradientState?.first, "safe")
        XCTAssertTrue(gradientState?.last?.contains("gradient") == true)

        _ = try await webView.evaluateJavaScript(
            "document.getElementById('target').style.backgroundImage = \"url('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==')\""
        )
        try await Task.sleep(nanoseconds: 350_000_000)
        let changedBackgroundVerdict = try await webView.evaluateJavaScript(
            "document.getElementById('target').dataset.vigilBackgroundVerdict"
        ) as? String
        XCTAssertEqual(changedBackgroundVerdict, "unknown")

        _ = try await webView.evaluateJavaScript(
            #"""
            (() => {
              const style = document.createElement('style');
              style.textContent = "#empty { background-image: url('data:image/gif;base64,R0lGODlhAQABAAAAACw='); }";
              document.head.appendChild(style);
            })()
            """#
        )
        try await Task.sleep(nanoseconds: 350_000_000)
        let stylesheetBackgroundVerdict = try await webView.evaluateJavaScript(
            "document.getElementById('empty').dataset.vigilBackgroundVerdict"
        ) as? String
        XCTAssertEqual(stylesheetBackgroundVerdict, "unknown")

        _ = try await webView.evaluateJavaScript(
            #"""
            (() => {
              const image = document.getElementById('image');
              image.dataset.vigilMediaVerdict = 'safe';
              image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
            })()
            """#
        )
        let changedImageVerdict = try await webView.evaluateJavaScript(
            "document.getElementById('image').dataset.vigilMediaVerdict"
        ) as? String
        XCTAssertEqual(changedImageVerdict, "unknown")
    }

    @MainActor
    func testMutedPreferenceAppliesImmediatelyToExistingMedia() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.frameSafetyScript(audioEnabled: false),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        let loaded = expectation(description: "audio fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString("<html><body><audio id='audio'></audio></body></html>", baseURL: URL(string: "https://m.youtube.com/"))
        await fulfillment(of: [loaded], timeout: 5)

        let muted = try await webView.evaluateJavaScript("document.getElementById('audio').muted") as? Bool
        XCTAssertEqual(muted, true)
    }

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
        XCTAssertTrue(script.contains("documentID"))
        XCTAssertTrue(script.contains("frame.contentWindow?.postMessage"))
        XCTAssertTrue(script.contains("event.source !== window.parent"))
        XCTAssertTrue(script.contains("__vigilResolveMedia"))
        XCTAssertTrue(script.contains("inspectBackgroundMedia"))
        XCTAssertTrue(bootstrap.contains("data-vigil-background-verdict"))
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
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://m.youtube.com:8443/watch?v=abc"))))
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(URL(string: "https://m.youtube.com:443/watch?v=abc"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "http://www.instagram.com/"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.instagram.com:8443/"))))
        XCTAssertTrue(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/login.php"))))
        XCTAssertTrue(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/v21.0/dialog/oauth?client_id=1"))))
        XCTAssertFalse(SocialService.instagram.allowsNavigation(to: try XCTUnwrap(URL(string: "https://www.facebook.com/"))))
        XCTAssertTrue(SocialService.instagram.isCanonicalAppHost("www.instagram.com"))
        XCTAssertFalse(SocialService.instagram.isCanonicalAppHost("help.instagram.com"))
        XCTAssertTrue(SocialService.youtube.isCanonicalAppHost("m.youtube.com"))
        XCTAssertFalse(SocialService.youtube.isCanonicalAppHost("accounts.google.com"))
    }

    func testEmbeddedNavigationRestoresRequiredServiceFramesWithoutBecomingABrowser() throws {
        XCTAssertTrue(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "about:blank"))))
        XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "https://m.youtube.com/shorts/abc"))))
        XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "blob:https://m.youtube.com/player"))))
        XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "https://www.youtube-nocookie.com/embed/abc"))))
        XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "https://example.com/embed/abc"))))
        XCTAssertFalse(SocialService.instagram.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "data:text/html,hello"))))
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
        XCTAssertEqual(SocialService.instagram.homeURL.path, "/accounts/login")
        XCTAssertEqual(SocialService.youtube.homeURL.path, "/")
    }

    func testYouTubeAdapterBlocksShortsAndPersistsPlayback() {
        let script = DOMAdapters.script(for: .youtube, audioEnabled: true)
        XCTAssertTrue(script.contains("/shorts"))
        XCTAssertTrue(script.contains("enforceShortsLocation"))
        XCTAssertTrue(script.contains("['home', 'explore', 'suggested', 'ads']"))
        XCTAssertTrue(script.contains("__vigil_feature"))
        XCTAssertTrue(script.contains("response.ok"))
        XCTAssertTrue(script.contains("response.status >= 200"))
        XCTAssertTrue(script.contains("responseURL.protocol === 'https:'"))
        XCTAssertTrue(script.contains("allowedHosts.includes(responseHost)"))
        XCTAssertTrue(script.contains("responseURL.searchParams.get('__vigil_feature') === key"))
        XCTAssertTrue(script.contains("method: 'HEAD'"))
        XCTAssertTrue(script.contains("cache: 'no-store'"))
        XCTAssertTrue(script.contains("credentials: 'include'"))
        XCTAssertTrue(script.contains("new Map(featureKeys.map((key) => [key, null]))"))
        XCTAssertTrue(script.contains("data-vigil-feature-${key}`, 'pending'"))
        XCTAssertFalse(script.contains("!response.redirected"))
        XCTAssertFalse(script.contains("responseURL.search === requestedURL.search"))
        XCTAssertFalse(script.contains("ALLOWED_HOSTS"))
        XCTAssertTrue(script.contains("data-vigil-feature-home=\"blocked\""))
        XCTAssertTrue(script.contains("data-vigil-feature-suggested=\"blocked\""))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-hidden-feature')"))
        XCTAssertFalse(script.contains("data-vigil-policy-tier=\"soft\""))
        XCTAssertTrue(script.contains("playbackRequest"))
        XCTAssertTrue(script.contains("__vigilRestorePlayback"))
        XCTAssertTrue(script.contains("ytm-open-app-button"))
        XCTAssertTrue(script.contains("disallowed_useragent"))
        XCTAssertTrue(script.contains("YouTube is signed out"))
    }

    func testInstagramAdapterPreservesSiteLayoutAndMatchesIndependentNativeControls() {
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertFalse(script.contains("max-width: none"))
        XCTAssertFalse(script.contains("touch-action: pan-x pan-y"))
        XCTAssertTrue(script.contains("['reels', 'explore', 'suggested', 'shopping', 'ads']"))
        XCTAssertTrue(script.contains("data-vigil-feature-reels=\"blocked\""))
        XCTAssertTrue(script.contains("data-vigil-feature-shopping=\"blocked\""))
        XCTAssertTrue(script.contains("hasExactLeafLabel(container, 'sponsored')"))
        XCTAssertTrue(script.contains("navigation.insertBefore(reelsItem, directItem)"))
        XCTAssertTrue(script.contains("feature === 'suggested' && isBlocked('explore')"))
        XCTAssertTrue(script.contains("data-vigil-instagram-route-feature=\"reels\""))
        XCTAssertTrue(script.contains("data-vigil-feature-suggested') !== 'available'"))
        XCTAssertFalse(script.contains("location.replace('/accounts/login/')"))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-hidden-feature')"))
        XCTAssertTrue(script.contains("__vigilAudioPreferred = true"))
        XCTAssertTrue(script.contains("vigilMutedByPreference"))
        XCTAssertFalse(script.contains("window.__vigilAudioPreferred && hasGesture"))
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
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription"))
        XCTAssertNotNil(Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryUsageDescription"))
    }

    func testSafetyBootstrapKeepsVectorInterfaceChromeUsable() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let adapter = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertFalse(bootstrap.contains("canvas, svg, object"))
        XCTAssertFalse(bootstrap.contains("content: normal"))
        XCTAssertFalse(bootstrap.contains("mask-image: none"))
        XCTAssertTrue(bootstrap.contains("svg image, svg foreignObject"))
        XCTAssertTrue(bootstrap.contains("[data-vigil-background-verdict=\"unknown\"]"))
        XCTAssertTrue(adapter.contains("static.cdninstagram.com"))
        XCTAssertTrue(adapter.contains("getComputedStyle(element, '::before')"))
        XCTAssertTrue(adapter.contains("attributeFilter: ['class', 'style']"))
        XCTAssertTrue(adapter.contains("markBackgroundPending"))
        XCTAssertTrue(adapter.contains("backgroundInspectionRoots"))
        XCTAssertTrue(adapter.contains("roots.forEach(inspectBackgroundMedia)"))
        XCTAssertFalse(adapter.contains("scheduleInspection = () => {\n              document.documentElement.dataset.vigilPageVerdict = 'unknown'"))
    }

    @MainActor
    func testFixedAppKeepsOnePersistentServiceWebView() {
        let store = SocialWebViewStore(defaults: UserDefaults(suiteName: #function)!, fixedService: .youtube, loadInitialPages: false)
        let youtube = store.webView(for: .youtube)
        XCTAssertTrue(youtube === store.webView(for: .youtube))
        XCTAssertTrue(youtube === store.webView(for: .instagram))
        XCTAssertEqual(youtube.configuration.defaultWebpagePreferences.preferredContentMode, .mobile)
        XCTAssertNotNil(youtube.scrollView.refreshControl)
        XCTAssertEqual(youtube.scrollView.keyboardDismissMode, .interactive)
        let scripts = youtube.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.count, 3)
        XCTAssertFalse(scripts[0].isForMainFrameOnly)
        XCTAssertFalse(scripts[1].isForMainFrameOnly)
        XCTAssertTrue(scripts[2].isForMainFrameOnly)
        XCTAssertTrue(scripts[0].source.contains("vigil-content-safety-style"))
        XCTAssertTrue(scripts[1].source.contains("mediaCandidate"))
        XCTAssertTrue(scripts[2].source.contains("__vigilPolicyProbeInstalled"))
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

private final class FixtureNavigationDelegate: NSObject, WKNavigationDelegate {
    private let completion: () -> Void

    init(completion: @escaping () -> Void) {
        self.completion = completion
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        completion()
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation?,
        withError error: Error
    ) {
        completion()
    }
}
