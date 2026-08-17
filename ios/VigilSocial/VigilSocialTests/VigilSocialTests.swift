import XCTest
import JavaScriptCore
import UIKit
import WebKit
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
    @MainActor
    private static var retainedYouTubeMiniplayerFixtures: [(UIWindow, WKWebView)] = []

    func testGeneratedJavaScriptParses() throws {
        let context = try XCTUnwrap(JSContext())
        let scripts = [
            DOMAdapters.contentFilterBootstrap,
            DOMAdapters.contentFilterBootstrap(for: .revealUnclassified),
            DOMAdapters.earlyMediaGate(audioEnabled: true),
            DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: false
            ),
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
            <html><head>
              <style>.themed #class-child { background-image: url('data:image/gif;base64,R0lGODlhAQABAAAAACw='); }</style>
            </head><body>
              <div id="target" style="width:200px;height:200px;background-image:url('data:image/gif;base64,R0lGODlhAQABAAAAACw=')"></div>
              <div id="empty" style="width:200px;height:200px"></div>
              <div id="gradient" style="width:200px;height:200px;background-image:linear-gradient(red, blue)"></div>
              <div id="class-root"><div id="class-child" style="width:200px;height:200px"></div></div>
              <img id="image" width="64" height="64" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
            </body></html>
            """#,
            baseURL: URL(string: "https://www.instagram.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await Task.sleep(nanoseconds: 750_000_000)

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
        try await Task.sleep(nanoseconds: 750_000_000)
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
        try await Task.sleep(nanoseconds: 750_000_000)
        let stylesheetBackgroundVerdict = try await webView.evaluateJavaScript(
            "document.getElementById('empty').dataset.vigilBackgroundVerdict"
        ) as? String
        XCTAssertEqual(stylesheetBackgroundVerdict, "unknown")

        _ = try await webView.evaluateJavaScript(
            "document.getElementById('class-root').classList.add('themed')"
        )
        try await Task.sleep(nanoseconds: 750_000_000)
        let classDescendantState = try await webView.evaluateJavaScript(
            "[document.getElementById('class-child').dataset.vigilBackgroundVerdict, document.getElementById('class-root').hasAttribute('data-vigil-background-subtree-pending')]"
        ) as? [Any]
        XCTAssertEqual(classDescendantState?.first as? String, "unknown")
        XCTAssertEqual(classDescendantState?.last as? Bool, false)

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
    func testOpenClosedAndDynamicShadowRootsStayFailClosedAndClassified() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let controller = WKUserContentController()
        controller.add(messageHandler, name: "vigil")
        controller.addUserScript(WKUserScript(
            source: "Object.defineProperty(window, 'IntersectionObserver', { value: undefined, configurable: true });",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true
            ),
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
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }
        let loaded = expectation(description: "shadow fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><body>
              <script>
                const imageURL = 'data:image/svg+xml;base64,' + btoa(
                  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">'
                    + '<rect width="64" height="64" fill="red"/></svg>'
                );
                const populate = (root, prefix) => {
                  root.innerHTML = `
                    <style>
                      .fixture-background {
                        width:64px;height:64px;background-image:url("${imageURL}");
                      }
                    </style>
                    <div id="${prefix}-background" class="fixture-background"></div>
                    <img id="${prefix}-image" width="64" height="64" src="${imageURL}">
                    <video id="${prefix}-video" autoplay muted></video>
                  `;
                };
                const openHost = document.createElement('div');
                document.body.appendChild(openHost);
                const openRoot = openHost.attachShadow({ mode: 'open' });
                populate(openRoot, 'open');

                const closedHost = document.createElement('div');
                document.body.appendChild(closedHost);
                const closedRoot = closedHost.attachShadow({ mode: 'closed' });
                populate(closedRoot, 'closed');
                window.__vigilFixtureRoots = { openRoot, closedRoot };

                setTimeout(() => {
                  const dynamicHost = document.createElement('div');
                  document.body.appendChild(dynamicHost);
                  const dynamicRoot = dynamicHost.attachShadow({ mode: 'closed' });
                  populate(dynamicRoot, 'dynamic');
                  window.__vigilFixtureRoots.dynamicRoot = dynamicRoot;
                }, 150);
                setTimeout(() => {
                  Object.values(window.__vigilFixtureRoots).forEach((root) => {
                    root.adoptedStyleSheets = [];
                  });
                }, 300);
              </script>
            </body></html>
            """#,
            baseURL: URL(string: "https://www.instagram.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)

        try await waitForJavaScriptCondition(
            #"""
            (() => {
              const roots = window.__vigilFixtureRoots;
              if (!roots?.dynamicRoot) return false;
              return Object.entries(roots).every(([prefix, root]) => {
                prefix = prefix.replace('Root', '');
                const image = root.getElementById(`${prefix}-image`);
                const video = root.getElementById(`${prefix}-video`);
                const background = root.getElementById(`${prefix}-background`);
                const safetySheetPresent = [...root.adoptedStyleSheets].some((sheet) =>
                  [...sheet.cssRules].some((rule) => rule.cssText.includes('blur(32px)'))
                );
                return safetySheetPresent
                  && Boolean(image?.dataset.vigilMediaId)
                  && getComputedStyle(image).filter.includes('blur')
                  && Boolean(video?.dataset.vigilMediaId)
                  && video.muted
                  && video.paused
                  && window.__vigilEarlyMediaGate.isHeld(video)
                  && background?.dataset.vigilBackgroundVerdict === 'unknown'
                  && getComputedStyle(background).backgroundImage === 'none';
              });
            })()
            """#,
            in: webView
        )

        let identifiers = try await webView.evaluateJavaScript(
            #"""
            Object.fromEntries(Object.entries(window.__vigilFixtureRoots).map(([prefix, root]) => {
              prefix = prefix.replace('Root', '');
              return [prefix, root.getElementById(`${prefix}-image`).dataset.vigilMediaId];
            }))
            """#
        ) as? [String: String]
        let expectedIdentifiers = Set(try XCTUnwrap(identifiers).values)
        for _ in 0..<120 {
            let candidateIdentifiers = Set(messageHandler.messages.compactMap { message in
                message["type"] as? String == "mediaCandidate" ? message["id"] as? String : nil
            })
            if expectedIdentifiers.isSubset(of: candidateIdentifiers) { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let candidateIdentifiers = Set(messageHandler.messages.compactMap { message in
            message["type"] as? String == "mediaCandidate" ? message["id"] as? String : nil
        })
        XCTAssertTrue(expectedIdentifiers.isSubset(of: candidateIdentifiers))
    }

    @MainActor
    func testResponsiveCSSOMContentURLsAndAnimationCompletionFailClosed() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true
            ),
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
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }
        let loaded = expectation(description: "visual CSS fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style id="fixture-style">
                #ordinary::before { content: "ordinary-icon"; }
                #content-url::before { content: url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }
                #responsive { width:64px;height:64px;background-image:linear-gradient(red, blue); }
                @media (min-width: 451px) {
                  #responsive { background-image:url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }
                }
                @keyframes delayed-image {
                  from { background-image:linear-gradient(red, blue); }
                  to { background-image:url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }
                }
                #animated {
                  width:64px;height:64px;
                  animation: delayed-image 120ms steps(1, end) 120ms forwards;
                }
              </style>
            </head><body>
              <div id="ordinary"></div>
              <div id="content-url"></div>
              <div id="responsive"></div>
              <div id="animated"></div>
              <div id="cssom">preserved fallback text</div>
              <div id="shadow-host"></div>
              <script>
                document.documentElement.dataset.vigilPageVerdict = 'safe';
                setTimeout(() => {
                  const sheet = document.getElementById('fixture-style').sheet;
                  sheet.insertRule(
                    '#cssom { width:64px;height:64px;'
                      + 'background-image:url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }'
                  );
                  sheet.cssRules[0].style.setProperty(
                    'content',
                    'url("data:image/gif;base64,R0lGODlhAQABAAAAACw=")'
                  );
                  const cssom = document.getElementById('cssom');
                  const fallbackRange = document.createRange();
                  fallbackRange.selectNodeContents(cssom);
                  window.__vigilImmediateNonEmptyContentState = {
                    content: getComputedStyle(cssom).content,
                    fallbackWidth: fallbackRange.getBoundingClientRect().width
                  };
                  const host = document.getElementById('shadow-host');
                  const root = host.attachShadow({ mode: 'open' });
                  root.innerHTML = '<div class="adopted"></div>';
                  const adopted = new CSSStyleSheet();
                  adopted.replaceSync(
                    '.adopted { width:64px;height:64px;'
                      + 'background-image:url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }'
                      + '.adopted::before {'
                      + 'content:url("data:image/gif;base64,R0lGODlhAQABAAAAACw="); }'
                  );
                  root.adoptedStyleSheets = [...root.adoptedStyleSheets, adopted];
                  window.__vigilAdoptedRoot = root;
                }, 300);
              </script>
            </body></html>
            """#,
            baseURL: URL(string: "https://m.youtube.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)

        try await waitForJavaScriptCondition(
            #"""
            (() => {
              const ordinary = document.getElementById('ordinary');
              const content = document.getElementById('content-url');
              const cssom = document.getElementById('cssom');
              const animated = document.getElementById('animated');
              const adopted = window.__vigilAdoptedRoot?.querySelector('.adopted');
              return window.__vigilImmediateNonEmptyContentState?.content === 'normal'
                && window.__vigilImmediateNonEmptyContentState?.fallbackWidth > 0
                && ordinary.dataset.vigilContentBeforeVerdict === 'none'
                && getComputedStyle(ordinary, '::before').content.includes('ordinary-icon')
                && content.dataset.vigilContentBeforeVerdict === 'unknown'
                && getComputedStyle(content, '::before').content === 'none'
                && cssom.dataset.vigilBackgroundVerdict === 'unknown'
                && cssom.dataset.vigilContentVerdict === 'unknown'
                && getComputedStyle(cssom).backgroundImage === 'none'
                && getComputedStyle(cssom).content === 'normal'
                && cssom.innerText === 'preserved fallback text'
                && animated.dataset.vigilBackgroundVerdict === 'unknown'
                && !animated.hasAttribute('data-vigil-visual-effect-pending')
                && getComputedStyle(animated).backgroundImage === 'none'
                && adopted?.dataset.vigilBackgroundVerdict === 'unknown'
                && adopted?.dataset.vigilContentBeforeVerdict === 'unknown'
                && getComputedStyle(adopted).backgroundImage === 'none'
                && getComputedStyle(adopted, '::before').content === 'none';
            })()
            """#,
            in: webView
        )

        webView.frame = CGRect(x: 0, y: 0, width: 520, height: 844)
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        _ = try await webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'))")
        try await waitForJavaScriptCondition(
            #"""
            (() => {
              const responsive = document.getElementById('responsive');
              return matchMedia('(min-width: 451px)').matches
                && responsive.dataset.vigilBackgroundVerdict === 'unknown'
                && getComputedStyle(responsive).backgroundImage === 'none';
            })()
            """#,
            in: webView
        )
    }

    @MainActor
    func testResponsiveImageSourceChangeInvalidatesSafeVerdictAndRequeues() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeResponsiveImageFixture(messageHandler: messageHandler)
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let initialCandidate = try await waitForMediaCandidate(in: messageHandler)
        try await resolve(initialCandidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            "document.getElementById('image').dataset.vigilMediaVerdict === 'safe'",
            in: webView
        )

        webView.frame = CGRect(x: 0, y: 0, width: 520, height: 844)
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        _ = try await webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'))")

        try await waitForJavaScriptCondition(
            "document.getElementById('image').currentSrc === window.__vigilFixtureWideURL",
            in: webView
        )
        let initialToken = try XCTUnwrap(initialCandidate["token"] as? String)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const image = document.getElementById('image');
              return image.dataset.vigilMediaVerdict === 'unknown'
                && image.dataset.vigilMediaToken !== \(try javaScriptLiteral(initialToken))
                && Boolean(image.dataset.vigilMediaInFlight);
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testPendingResponsiveImageVerdictCannotResolveOntoNewSource() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeResponsiveImageFixture(messageHandler: messageHandler)
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let initialCandidate = try await waitForMediaCandidate(in: messageHandler)
        webView.frame = CGRect(x: 0, y: 0, width: 520, height: 844)
        webView.setNeedsLayout()
        webView.layoutIfNeeded()
        _ = try await webView.evaluateJavaScript("window.dispatchEvent(new Event('resize'))")
        try await waitForJavaScriptCondition(
            "document.getElementById('image').currentSrc === window.__vigilFixtureWideURL",
            in: webView
        )

        try await resolve(initialCandidate, as: .safe, in: webView)
        let initialToken = try XCTUnwrap(initialCandidate["token"] as? String)
        let staleResolutionApplied = try await webView.evaluateJavaScript(
            "document.getElementById('image').dataset.vigilMediaVerdict === 'safe'"
        ) as? Bool
        XCTAssertEqual(staleResolutionApplied, false)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const image = document.getElementById('image');
              return image.dataset.vigilMediaVerdict === 'unknown'
                && image.dataset.vigilMediaToken !== \(try javaScriptLiteral(initialToken))
                && Boolean(image.dataset.vigilMediaInFlight);
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testChangedVideoPosterInvalidatesSafeFrameAndRequiresPosterVerdict() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeVideoFixture(
            messageHandler: messageHandler,
            body: #"""
            <video id="video" width="320" height="180" style="display:block;width:320px;height:180px"></video>
            <script>
              const video = document.getElementById('video');
              window.__vigilFixtureFrameReady = true;
              video.src = 'https://media.example.invalid/classified-frame.mp4';
              Object.defineProperties(video, {
                readyState: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 2 : 0
                },
                videoWidth: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 320 : 0
                },
                videoHeight: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 180 : 0
                }
              });
              window.__vigilInstallPoster = () => {
                window.__vigilFixtureFrameReady = false;
                const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">'
                  + '<rect width="320" height="180" fill="rgb(27, 91, 147)"/></svg>';
                window.__vigilFixturePosterURL = URL.createObjectURL(
                  new Blob([svg], { type: 'image/svg+xml' })
                );
                video.poster = window.__vigilFixturePosterURL;
              };
            </script>
            """#
        )
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let frameCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            kind: "videoFrame"
        )
        try await resolve(frameCandidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.dataset.vigilMediaVerdict === 'safe'
                && video.dataset.vigilVideoFrameVerdict === 'safe';
            })()
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilInstallPoster()")
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.paused
                && video.readyState === 0
                && video.dataset.vigilMediaVerdict === 'unknown'
                && video.dataset.vigilVideoPosterPending === 'true';
            })()
            """,
            in: webView
        )

        let initialToken = try XCTUnwrap(frameCandidate["token"] as? String)
        let posterCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            excludingToken: initialToken,
            kind: "videoPoster"
        )
        XCTAssertEqual(posterCandidate["captureFailed"] as? Bool, false)
        XCTAssertTrue((posterCandidate["dataURL"] as? String)?.hasPrefix("data:image/jpeg") == true)

        let pendingState = try await webView.evaluateJavaScript(
            """
            (() => {
              const video = document.getElementById('video');
              return [
                video.dataset.vigilMediaVerdict,
                video.dataset.vigilVideoFrameVerdict,
                video.dataset.vigilMediaCaptureKind
              ];
            })()
            """
        ) as? [String]
        XCTAssertEqual(pendingState, ["unknown", "safe", "videoPoster"])

        try await resolve(posterCandidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.dataset.vigilMediaVerdict === 'safe'
                && video.dataset.vigilVideoPosterVerdict === 'safe'
                && !video.dataset.vigilVideoPosterPending;
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testPosterOnlyVideoIsClassifiedWithoutLoadedVideoData() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeVideoFixture(
            messageHandler: messageHandler,
            body: #"""
            <video id="video" width="320" height="180" style="display:block;width:320px;height:180px"></video>
            <script>
              const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">'
                + '<rect width="320" height="180" fill="rgb(191, 63, 47)"/></svg>';
              window.__vigilFixturePosterURL = URL.createObjectURL(
                new Blob([svg], { type: 'image/svg+xml' })
              );
              document.getElementById('video').poster = window.__vigilFixturePosterURL;
            </script>
            """#
        )
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let candidate = try await waitForMediaCandidate(
            in: messageHandler,
            kind: "videoPoster"
        )
        XCTAssertEqual(candidate["captureFailed"] as? Bool, false)
        XCTAssertTrue((candidate["dataURL"] as? String)?.hasPrefix("data:image/jpeg") == true)

        try await resolve(candidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.readyState === 0
                && video.dataset.vigilMediaVerdict === 'safe'
                && video.dataset.vigilVideoPosterVerdict === 'safe'
                && video.dataset.vigilVideoFrameVerdict !== 'safe'
                && window.__vigilEarlyMediaGate.isHeld(video);
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testUnclassifiablePosterIsSuppressedWithoutStarvingReadyFrameInspection() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeVideoFixture(
            messageHandler: messageHandler,
            body: #"""
            <video id="video" width="320" height="180" style="display:block;width:320px;height:180px"></video>
            <script>
              const video = document.getElementById('video');
              video.src = 'https://media.example.invalid/classifiable-frame.mp4';
              video.poster = 'data:image/png;base64,AAAA';
              Object.defineProperties(video, {
                readyState: { configurable: true, get: () => 2 },
                videoWidth: { configurable: true, get: () => 320 },
                videoHeight: { configurable: true, get: () => 180 }
              });
            </script>
            """#
        )
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let posterCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            kind: "videoPoster"
        )
        XCTAssertEqual(posterCandidate["captureFailed"] as? Bool, true)
        try await resolve(posterCandidate, as: .unknown, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.poster === ''
                && video.dataset.vigilVideoPosterSuppressed === 'true'
                && video.dataset.vigilVideoPosterVerdict === 'unknown';
            })()
            """,
            in: webView
        )

        let posterToken = try XCTUnwrap(posterCandidate["token"] as? String)
        let frameCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            excludingToken: posterToken,
            kind: "videoFrame"
        )
        try await resolve(frameCandidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.poster === ''
                && video.dataset.vigilVideoPosterSuppressed === 'true'
                && video.dataset.vigilVideoPosterVerdict === 'unknown'
                && video.dataset.vigilVideoFrameVerdict === 'safe'
                && video.dataset.vigilMediaVerdict === 'safe';
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testSensitivePosterStaysSuppressedAfterSourceChangeAndSafeFrameVerdict() async throws {
        let messageHandler = FixtureScriptMessageHandler()
        let fixture = makeVideoFixture(
            messageHandler: messageHandler,
            body: #"""
            <video id="video" width="320" height="180" style="display:block;width:320px;height:180px"></video>
            <script>
              const video = document.getElementById('video');
              window.__vigilFixtureFrameReady = false;
              const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">'
                + '<rect width="320" height="180" fill="rgb(107, 41, 119)"/></svg>';
              window.__vigilFixtureSensitivePosterURL = URL.createObjectURL(
                new Blob([svg], { type: 'image/svg+xml' })
              );
              video.poster = window.__vigilFixtureSensitivePosterURL;
              Object.defineProperties(video, {
                readyState: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 2 : 0
                },
                videoWidth: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 320 : 0
                },
                videoHeight: {
                  configurable: true,
                  get: () => window.__vigilFixtureFrameReady ? 180 : 0
                }
              });
              window.__vigilInstallSafeFrameSource = () => {
                window.__vigilFixtureFrameReady = true;
                video.src = 'https://media.example.invalid/replacement-frame.mp4';
              };
              window.__vigilReattachSensitivePoster = () => {
                video.poster = window.__vigilFixtureSensitivePosterURL;
              };
            </script>
            """#
        )
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        let posterCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            kind: "videoPoster"
        )
        try await resolve(posterCandidate, as: .sensitive, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.poster === ''
                && video.dataset.vigilVideoPosterSuppressed === 'true'
                && video.dataset.vigilVideoPosterVerdict === 'sensitive'
                && video.dataset.vigilMediaVerdict === 'unknown';
            })()
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilInstallSafeFrameSource()")
        let posterToken = try XCTUnwrap(posterCandidate["token"] as? String)
        let frameCandidate = try await waitForMediaCandidate(
            in: messageHandler,
            excludingToken: posterToken,
            kind: "videoFrame"
        )
        try await resolve(frameCandidate, as: .safe, in: webView)
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.poster === ''
                && video.dataset.vigilVideoPosterSuppressed === 'true'
                && video.dataset.vigilVideoPosterVerdict === 'sensitive'
                && video.dataset.vigilVideoFrameVerdict === 'safe'
                && video.dataset.vigilMediaVerdict === 'safe';
            })()
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilReattachSensitivePoster()")
        try await waitForJavaScriptCondition(
            """
            (() => {
              const video = document.getElementById('video');
              return video.poster === ''
                && video.dataset.vigilVideoPosterSuppressed === 'true'
                && video.dataset.vigilMediaVerdict === 'safe';
            })()
            """,
            in: webView
        )
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

    @MainActor
    func testInstagramMigratesLegacyMutedPreferenceToAudioEnabled() throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defaults.set(false, forKey: "VigilSocial.audio.instagram")

        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .instagram,
            loadInitialPages: false
        )

        XCTAssertTrue(store.audioEnabled(for: .instagram))
        XCTAssertTrue(defaults.bool(forKey: "VigilSocial.audio.instagram"))
    }

    @MainActor
    func testInstagramUsesNativeMediaWithoutContentClassification() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameSafetyScript(
                for: .instagram,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }
        let loaded = expectation(description: "Instagram startup mute fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            "<html><body><video id='video' muted></video></body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        let mediaState = try await webView.evaluateJavaScript(
            """
            (() => {
              const video = document.getElementById('video');
              return {
                muted: video.muted,
                defaultMuted: video.defaultMuted,
                compatibilityInstalled: window.__vigilInstagramCompatibilityInstalled === true,
                contentBootstrapInstalled: window.__vigilContentBootstrapInstalled === true,
                earlyMediaGateInstalled: Boolean(window.__vigilEarlyMediaGate),
                mediaCandidateHookInstalled: typeof window.__vigilResolveMedia === 'function'
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(mediaState?["muted"] as? Bool, false)
        XCTAssertEqual(mediaState?["defaultMuted"] as? Bool, false)
        XCTAssertEqual(mediaState?["compatibilityInstalled"] as? Bool, true)
        XCTAssertEqual(mediaState?["contentBootstrapInstalled"] as? Bool, false)
        XCTAssertEqual(mediaState?["earlyMediaGateInstalled"] as? Bool, false)
        XCTAssertEqual(mediaState?["mediaCandidateHookInstalled"] as? Bool, false)
    }

    @MainActor
    func testInstagramAudioOnDefaultSynchronizesItsMuteControl() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameSafetyScript(
                for: .instagram,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "Instagram audio indicator fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><body>
              <article>
                <video id="video" muted></video>
                <button id="mute" aria-label="Unmute">Unmute</button>
              </article>
              <script>
                const video = document.getElementById('video');
                const mute = document.getElementById('mute');
                let interfaceMuted = true;
                window.__vigilFixtureMuteClicks = 0;
                mute.addEventListener('click', () => {
                  window.__vigilFixtureMuteClicks += 1;
                  interfaceMuted = !interfaceMuted;
                  video.muted = interfaceMuted;
                  mute.setAttribute('aria-label', interfaceMuted ? 'Unmute' : 'Mute');
                  mute.textContent = interfaceMuted ? 'Unmute' : 'Mute';
                });
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        var state = try await webView.evaluateJavaScript(
            """
            ({
              muted: document.getElementById('video').muted,
              label: document.getElementById('mute').getAttribute('aria-label'),
              muteClicks: window.__vigilFixtureMuteClicks
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["muted"] as? Bool, false)
        XCTAssertEqual(state?["label"] as? String, "Mute")
        XCTAssertEqual(state?["muteClicks"] as? Int, 1)

        _ = try await webView.evaluateJavaScript("document.getElementById('mute').click()")
        state = try await webView.evaluateJavaScript(
            """
            ({
              muted: document.getElementById('video').muted,
              label: document.getElementById('mute').getAttribute('aria-label'),
              muteClicks: window.__vigilFixtureMuteClicks
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["muted"] as? Bool, true)
        XCTAssertEqual(state?["label"] as? String, "Unmute")
        XCTAssertEqual(state?["muteClicks"] as? Int, 2)
    }

    @MainActor
    func testInstagramSuspendsOnlyPlayingMediaAndResumesOnlyVisibleConnectedMedia() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameSafetyScript(
                for: .instagram,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "Instagram media lifecycle fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%}
                video{display:block;width:160px;height:100px}
                #hidden{display:none}
                #host{display:block;width:160px;height:100px}
              </style>
            </head><body>
              <video id="visible"></video>
              <video id="hidden"></video>
              <video id="removed"></video>
              <video id="already-paused"></video>
              <div id="host"></div>
              <script>
                window.__vigilStubMedia = (media, playing) => {
                  let isPlaying = Boolean(playing);
                  Object.defineProperty(media, 'paused', {
                    configurable: true,
                    get: () => !isPlaying
                  });
                  media.__vigilPauseCount = 0;
                  media.__vigilPlayCount = 0;
                  media.pause = () => {
                    media.__vigilPauseCount += 1;
                    isPlaying = false;
                  };
                  media.play = () => {
                    media.__vigilPlayCount += 1;
                    isPlaying = true;
                    return Promise.resolve();
                  };
                };
                ['visible', 'hidden', 'removed'].forEach((id) =>
                  window.__vigilStubMedia(document.getElementById(id), true));
                window.__vigilStubMedia(document.getElementById('already-paused'), false);
                const shadowRoot = document.getElementById('host').attachShadow({ mode: 'open' });
                shadowRoot.innerHTML = '<video id="shadow"></video>';
                window.__vigilStubMedia(shadowRoot.getElementById('shadow'), true);
                window.__vigilFixtureShadowRoot = shadowRoot;
                window.__vigilShadowDOM = {
                  subscribe(callback) {
                    callback(shadowRoot);
                    return () => {};
                  }
                };
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        let state = try await webView.evaluateJavaScript(
            """
            (() => {
              const visible = document.getElementById('visible');
              const hidden = document.getElementById('hidden');
              const removed = document.getElementById('removed');
              const alreadyPaused = document.getElementById('already-paused');
              const shadow = window.__vigilFixtureShadowRoot.getElementById('shadow');
              const hooksInstalled = typeof window.__vigilSuspendAllMedia === 'function'
                && typeof window.__vigilResumeSuspendedMedia === 'function';
              window.__vigilSuspendAllMedia();
              window.__vigilSuspendAllMedia();
              removed.remove();
              window.__vigilResumeSuspendedMedia();
              window.__vigilResumeSuspendedMedia();
              return {
                hooksInstalled,
                visiblePauses: visible.__vigilPauseCount,
                visiblePlays: visible.__vigilPlayCount,
                hiddenPauses: hidden.__vigilPauseCount,
                hiddenPlays: hidden.__vigilPlayCount,
                removedPauses: removed.__vigilPauseCount,
                removedPlays: removed.__vigilPlayCount,
                pausedPauses: alreadyPaused.__vigilPauseCount,
                pausedPlays: alreadyPaused.__vigilPlayCount,
                shadowPauses: shadow.__vigilPauseCount,
                shadowPlays: shadow.__vigilPlayCount
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["hooksInstalled"] as? Bool, true)
        XCTAssertEqual(state?["visiblePauses"] as? Int, 1)
        XCTAssertEqual(state?["visiblePlays"] as? Int, 1)
        XCTAssertEqual(state?["hiddenPauses"] as? Int, 1)
        XCTAssertEqual(state?["hiddenPlays"] as? Int, 0)
        XCTAssertEqual(state?["removedPauses"] as? Int, 1)
        XCTAssertEqual(state?["removedPlays"] as? Int, 0)
        XCTAssertEqual(state?["pausedPauses"] as? Int, 0)
        XCTAssertEqual(state?["pausedPlays"] as? Int, 0)
        XCTAssertEqual(state?["shadowPauses"] as? Int, 1)
        XCTAssertEqual(state?["shadowPlays"] as? Int, 1)
    }

    @MainActor
    func testHeadAutoplayIsHeldUntilSafeWithAudioEnabled() async throws {
        let webView = try await loadHeadAutoplayFixture(audioEnabled: true)

        let heldState = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('early-audio');
              return {
                attemptedInHead: window.__vigilHeadPlayAttempted === true,
                muted: window.__vigilHeadMediaState?.muted,
                paused: window.__vigilHeadMediaState?.paused,
                held: window.__vigilHeadMediaState?.held,
                stillMuted: media.muted,
                stillPaused: media.paused,
                stillHeld: window.__vigilEarlyMediaGate.isHeld(media)
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(heldState?["attemptedInHead"] as? Bool, true)
        XCTAssertEqual(heldState?["muted"] as? Bool, true)
        XCTAssertEqual(heldState?["paused"] as? Bool, true)
        XCTAssertEqual(heldState?["held"] as? Bool, true)
        XCTAssertEqual(heldState?["stillMuted"] as? Bool, true)
        XCTAssertEqual(heldState?["stillPaused"] as? Bool, true)
        XCTAssertEqual(heldState?["stillHeld"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              document.getElementById('early-audio').play().catch(() => {});
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            (() => {
              const media = document.getElementById('early-audio');
              return !window.__vigilEarlyMediaGate.isHeld(media)
                && media.muted === false
                && media.paused === false;
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testHeadAutoplayStaysMutedAfterSafeWhenAudioPreferenceIsDisabled() async throws {
        let webView = try await loadHeadAutoplayFixture(audioEnabled: false)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              document.getElementById('early-audio').play().catch(() => {});
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            (() => {
              const media = document.getElementById('early-audio');
              return !window.__vigilEarlyMediaGate.isHeld(media)
                && media.muted === true
                && media.paused === false;
            })()
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilSetAudioPreference(true)")
        try await waitForJavaScriptCondition(
            """
            (() => {
              const media = document.getElementById('early-audio');
              return media.muted === false && media.paused === false;
            })()
            """,
            in: webView
        )
    }

    @MainActor
    func testHeldMediaPreservesDynamicMutedAttributeIntent() async throws {
        let webView = try await loadHeadAutoplayFixture(audioEnabled: true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const removed = document.createElement('audio');
              removed.id = 'removed-muted';
              document.body.appendChild(removed);
              removed.setAttribute('muted', '');
              removed.removeAttribute('muted');

              const retained = document.createElement('audio');
              retained.id = 'retained-muted';
              document.body.appendChild(retained);
              retained.setAttribute('muted', '');
            })()
            """
        )
        try await Task.sleep(nanoseconds: 100_000_000)
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              document.getElementById('removed-muted').play().catch(() => {});
              document.getElementById('retained-muted').play().catch(() => {});
            })()
            """
        )

        let muteState = try await webView.evaluateJavaScript(
            """
            (() => {
              const removed = document.getElementById('removed-muted');
              const retained = document.getElementById('retained-muted');
              return {
                removedHeld: window.__vigilEarlyMediaGate.isHeld(removed),
                removedMuted: removed.muted,
                removedDefaultMuted: removed.defaultMuted,
                retainedHeld: window.__vigilEarlyMediaGate.isHeld(retained),
                retainedMuted: retained.muted,
                retainedDefaultMuted: retained.defaultMuted
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(muteState?["removedHeld"] as? Bool, false)
        XCTAssertEqual(muteState?["removedMuted"] as? Bool, false)
        XCTAssertEqual(muteState?["removedDefaultMuted"] as? Bool, false)
        XCTAssertEqual(muteState?["retainedHeld"] as? Bool, false)
        XCTAssertEqual(muteState?["retainedMuted"] as? Bool, true)
        XCTAssertEqual(muteState?["retainedDefaultMuted"] as? Bool, true)
    }

    @MainActor
    func testHeadWebAudioIsHeldUntilSafeAndPausePathsDiscardResumeIntent() async throws {
        let fixture = try await loadHeadWebAudioFixture(audioEnabled: true)
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        try await waitForJavaScriptCondition(
            """
            (() => {
              const context = window.__vigilHeadAudioContext;
              return Boolean(context)
                && context.state === 'suspended'
                && window.__vigilEarlyMediaGate.isAudioContextHeld(context)
                && window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(context);
            })()
            """,
            in: webView
        )
        let constructorState = try await webView.evaluateJavaScript(
            """
            (() => ({
              available: Boolean(window.__vigilHeadAudioContext),
              attemptedInHead: window.__vigilHeadAudioResumeAttempted === true,
              instancePreserved: window.__vigilHeadAudioInstancePreserved === true,
              constructorPreserved: window.__vigilHeadAudioConstructorPreserved === true
            }))()
            """
        ) as? [String: Any]
        XCTAssertEqual(constructorState?["available"] as? Bool, true)
        XCTAssertEqual(constructorState?["attemptedInHead"] as? Bool, true)
        XCTAssertEqual(constructorState?["instancePreserved"] as? Bool, true)
        XCTAssertEqual(constructorState?["constructorPreserved"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              window.__vigilHeadAudioContext.resume().catch(() => {});
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilHeadAudioContext.state === 'running'",
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'unknown';
              const Constructor = window.AudioContext || window.webkitAudioContext;
              const context = new Constructor();
              const oscillator = context.createOscillator();
              oscillator.frequency.value = 1;
              oscillator.connect(context.destination);
              oscillator.start();
              window.__vigilDynamicAudioContext = context;
              window.__vigilDynamicOscillator = oscillator;
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            window.__vigilDynamicAudioContext.state === 'suspended'
              && window.__vigilEarlyMediaGate.isAudioContextHeld(
                window.__vigilDynamicAudioContext
              )
            """,
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            """
            document.documentElement.dataset.vigilPageVerdict = 'safe';
            window.__vigilDynamicAudioContext.resume().catch(() => {});
            true
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilDynamicAudioContext.state === 'running'",
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            """
            window.dispatchEvent(new MessageEvent('message', {
              source: window.parent,
              data: { channel: '__vigilFrameCommandV1', command: 'pause' }
            }));
            true
            """
        )
        try await waitForJavaScriptCondition(
            """
            window.__vigilHeadAudioContext.state === 'suspended'
              && !window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(
                window.__vigilHeadAudioContext
              )
              && window.__vigilDynamicAudioContext.state === 'suspended'
              && !window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(
                window.__vigilDynamicAudioContext
              )
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            "window.__vigilHeadAudioContext.resume().catch(() => {}); true"
        )
        try await waitForJavaScriptCondition(
            "window.__vigilHeadAudioContext.state === 'running'",
            in: webView
        )
        _ = try await webView.evaluateJavaScript("window.__vigilPauseAllMedia()")
        try await waitForJavaScriptCondition(
            """
            window.__vigilHeadAudioContext.state === 'suspended'
              && !window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(
                window.__vigilHeadAudioContext
              )
            """,
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "window.__vigilEarlyMediaGate.refreshAudioContexts()"
        )
        try await Task.sleep(nanoseconds: 100_000_000)
        let stateAfterRefresh = try await webView.evaluateJavaScript(
            "window.__vigilHeadAudioContext.state"
        ) as? String
        XCTAssertEqual(stateAfterRefresh, "suspended")
    }

    @MainActor
    func testWebAudioPreferenceSuspendsAndOnlyResumesPriorSiteIntent() async throws {
        let fixture = try await loadHeadWebAudioFixture(audioEnabled: false)
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              window.__vigilHeadAudioContext.resume().catch(() => {});
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            window.__vigilHeadAudioContext.state === 'suspended'
              && window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(
                window.__vigilHeadAudioContext
              )
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilSetAudioPreference(true)")
        try await waitForJavaScriptCondition(
            "window.__vigilHeadAudioContext.state === 'running'",
            in: webView
        )

        _ = try await webView.evaluateJavaScript("window.__vigilSetAudioPreference(false)")
        try await waitForJavaScriptCondition(
            "window.__vigilHeadAudioContext.state === 'suspended'",
            in: webView
        )
    }

    @MainActor
    func testWebAudioContextInheritsAssociatedVideoSafetyVerdict() async throws {
        let fixture = try await loadHeadWebAudioFixture(
            audioEnabled: true,
            associatesVideo: true
        )
        let webView = fixture.webView
        defer { fixture.window.isHidden = true }

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.dataset.vigilPageVerdict = 'safe';
              window.__vigilHeadAudioContext.resume().catch(() => {});
              return true;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            window.__vigilHeadAudioContext.state === 'suspended'
              && window.__vigilEarlyMediaGate.hasAudioContextResumeIntent(
                window.__vigilHeadAudioContext
              )
            """,
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const video = document.getElementById('web-audio-video');
              const fingerprint = JSON.stringify({
                current: String(video.currentSrc || video.src || ''),
                declared: String(video.getAttribute('src') || ''),
                sources: []
              });
              video.dataset.vigilMediaVerdict = 'safe';
              video.dataset.vigilVideoFrameVerdict = 'safe';
              video.dataset.vigilVideoFrameFingerprint = fingerprint;
              window.__vigilEarlyMediaGate.refreshAudioContexts();
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilHeadAudioContext.state === 'running'",
            in: webView
        )
    }

    func testDocumentStartGateFailClosesPlaybackBeforeTheCommonAdapter() {
        let early = DOMAdapters.earlyMediaGate(audioEnabled: true)
        let common = DOMAdapters.frameSafetyScript(audioEnabled: true)

        XCTAssertTrue(early.contains("vigilGuardedPlay"))
        XCTAssertTrue(early.contains("setPhysicalMute(media, state, true)"))
        XCTAssertTrue(early.contains("new MutationObserver"))
        XCTAssertTrue(early.contains("['play', 'playing']"))
        XCTAssertTrue(early.contains("setEligibilityResolver"))
        XCTAssertTrue(early.contains("record.attributeName === 'muted'"))
        XCTAssertTrue(early.contains("vigilGuardedAudioContextResume"))
        XCTAssertTrue(early.contains("installAudioContextConstructor('AudioContext')"))
        XCTAssertTrue(early.contains("installAudioContextConstructor('webkitAudioContext')"))
        XCTAssertTrue(early.contains("vigilGuardedCreateMediaElementSource"))
        XCTAssertTrue(early.contains("suspendAllAudioContexts"))
        XCTAssertTrue(common.contains("earlyMediaGate?.setEligibilityResolver"))
        XCTAssertTrue(common.contains("earlyMediaGate?.setAudioContextEligibilityResolver"))
        XCTAssertTrue(common.contains("earlyMediaGate?.suspendAudioContexts(true)"))
        XCTAssertTrue(common.contains("pageAllowsPlayback() && mediaAllowsPlayback(media)"))
        XCTAssertTrue(common.contains("earlyMediaGate?.hold(media, rememberIntent, permanentlyBlocked)"))
        XCTAssertTrue(common.contains("earlyMediaGate?.allow(media, true)"))
    }

    func testContentFilterPreblursAndObservesDynamicMediaAndText() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let script = DOMAdapters.script(
            for: .instagram,
            audioEnabled: true,
            contentSafetyEnabled: false
        )
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
        XCTAssertFalse(script.contains("sourceURL:"))
    }

    func testMainDocumentBridgeIncludesTheDocumentStartIdentity() {
        let documentStart = DOMAdapters.documentStartScript(
            for: .instagram,
            unclassifiedMediaPolicy: .conceal,
            audioEnabled: true
        )
        let bridge = DOMAdapters.frameSafetyScript(audioEnabled: true)

        XCTAssertTrue(documentStart.contains("Object.defineProperty(window, '__vigilDocumentID'"))
        XCTAssertTrue(bridge.contains("const existing = String(window.__vigilDocumentID || '')"))
        XCTAssertTrue(bridge.contains("postMessage({ ...payload, documentID })"))
        XCTAssertTrue(bridge.contains("bridge({ type: 'documentReady' })"))
    }

    @MainActor
    func testMainDocumentMessageIdentityRejectsStaleDocumentsWithoutBreakingSPARoutes() {
        let currentDocumentID = "document-generation-2"

        XCTAssertTrue(SocialWebViewStore.isCurrentMainDocumentMessage(
            currentDocumentID,
            currentDocumentID: currentDocumentID
        ))
        XCTAssertFalse(SocialWebViewStore.isCurrentMainDocumentMessage(
            "document-generation-1",
            currentDocumentID: currentDocumentID
        ))
        XCTAssertFalse(SocialWebViewStore.isCurrentMainDocumentMessage(
            nil,
            currentDocumentID: currentDocumentID
        ))
    }

    func testAdaptersBoundInspectionWorkAndRetryUnclassifiedMedia() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let common = DOMAdapters.frameSafetyScript(audioEnabled: true)
        let youtube = DOMAdapters.script(for: .youtube, audioEnabled: true)

        XCTAssertTrue(bootstrap.contains("data-vigil-background-subtree-pending"))
        XCTAssertTrue(common.contains("rootMargin: '1500px 0px'"))
        XCTAssertTrue(common.contains("typeof window.IntersectionObserver === 'function'"))
        XCTAssertTrue(common.contains("pendingBackgroundTrees"))
        XCTAssertTrue(common.contains("const visualTreeContains = (ancestor, candidate)"))
        XCTAssertTrue(common.contains("pendingJob.dirty = true"))
        XCTAssertTrue(common.contains("document.createTreeWalker"))
        XCTAssertTrue(common.contains("let budget = 80"))
        XCTAssertFalse(common.contains("[node, ...node.querySelectorAll('*')]"))
        XCTAssertTrue(common.contains("if (textInspectionTimer) return"))
        XCTAssertTrue(common.contains("if (element.dataset.vigilMediaInFlight) return"))
        XCTAssertTrue(common.contains("queueMedia(element, true, true)"))
        XCTAssertTrue(common.contains("const mediaRequestFingerprints = new Map()"))
        XCTAssertTrue(common.contains("submittedFingerprint !== mediaFingerprint(element)"))
        XCTAssertTrue(common.contains("root.addEventListener('load', (event) => {"))
        XCTAssertTrue(common.contains("event.target instanceof HTMLImageElement"))
        XCTAssertTrue(common.contains("scheduleResponsiveMediaRefresh"))
        XCTAssertTrue(common.contains("window.visualViewport?.addEventListener("))
        XCTAssertTrue(common.contains("'resize',"))
        XCTAssertTrue(common.contains("armResponsiveDensityChange()"))
        XCTAssertTrue(common.contains("'srcset', 'sizes', 'media', 'type'"))
        XCTAssertTrue(common.contains("__vigilPageVerdictChanged"))
        XCTAssertTrue(youtube.contains("await Promise.allSettled(probes)"))
    }

    func testAdaptersPublishRefreshSurfacesAndCurrentYouTubePlaybackHooks() {
        let youtube = DOMAdapters.script(for: .youtube, audioEnabled: true)
        let instagram = DOMAdapters.script(for: .instagram, audioEnabled: true)

        for script in [youtube, instagram] {
            XCTAssertTrue(script.contains("type: 'surface'"))
            XCTAssertTrue(script.contains("refreshEligible"))
            XCTAssertTrue(script.contains("blocksRefresh"))
        }
        XCTAssertTrue(youtube.contains("service: 'youtube'"))
        XCTAssertTrue(youtube.contains("ytm-single-column-watch-next-results-renderer"))
        XCTAssertTrue(youtube.contains("ytm-video-with-context-renderer"))
        XCTAssertTrue(youtube.contains("explicitStartOffset"))
        XCTAssertTrue(youtube.contains("video.addEventListener('pause', pause)"))
        XCTAssertTrue(youtube.contains("addEventListener('pagehide'"))
        XCTAssertTrue(youtube.contains("__vigilPageVerdictChanged"))
        XCTAssertTrue(youtube.contains("const graceMilliseconds = route === 'watch' ? 6000 : 4500"))
        XCTAssertTrue(youtube.contains("setTimeout(() => scheduleHealth(0, true), 7000)"))
        XCTAssertTrue(instagram.contains("service: 'instagram'"))
        XCTAssertTrue(instagram.contains("underlyingRoute === 'feed'"))
        XCTAssertTrue(instagram.contains("underlyingRoute === 'story'"))
    }

    func testYouTubeHealthRecognizesCurrentWatchContainers() {
        let youtube = DOMAdapters.script(for: .youtube, audioEnabled: true)

        XCTAssertTrue(youtube.contains(
            #"'ytm-watch, ytd-watch-flexy, [page-subtype="watch"]'"#
        ))
        XCTAssertTrue(youtube.contains(
            "'ytm-player, ytd-player, #player-container-id, #player'"
        ))
        XCTAssertTrue(youtube.contains("firstVisibleYouTubeElement(youtubeWatchSelector)"))
    }

    @MainActor
    func testYouTubeVisibleWatchShellIsUsableBeforeVideoAttaches() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .youtube,
            loadInitialPages: false
        )

        let webView = store.webView(for: .youtube)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            """
            <html><body>
              <ytm-watch style="display:block;width:390px;height:700px">
                <h1>Fixture ordinary video</h1>
                <div id="deferred-player">Preparing video</div>
              </ytm-watch>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=fixture"))
        )

        for _ in 0..<60 where store.health[.youtube] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(
            store.health[.youtube],
            .ready,
            "A visible YouTube watch shell is usable while its video element attaches asynchronously"
        )
    }

    @MainActor
    func testYouTubeSlowStartupDoesNotFlashADegradedOverlayBeforeContentArrives() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .youtube,
            loadInitialPages: false
        )

        let webView = store.webView(for: .youtube)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            """
            <html><body>
              <main id="content" style="display:block;width:390px;height:760px">
                <div id="hidden-ancestor" style="display:block;width:360px;height:220px;opacity:0">
                  <ytm-item-section-renderer style="display:block;width:360px;height:220px">
                    Hidden prerendered content
                  </ytm-item-section-renderer>
                </div>
              </main>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/"))
        )

        try await Task.sleep(nanoseconds: 1_200_000_000)
        XCTAssertEqual(
            store.health[.youtube],
            .loading,
            "Content under a transparent ancestor must not end YouTube's loading grace period"
        )
        _ = try await webView.evaluateJavaScript(
            "document.getElementById('hidden-ancestor').style.opacity = '1'"
        )

        for _ in 0..<60 where store.health[.youtube] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(store.health[.youtube], .ready)
    }

    @MainActor
    func testYouTubeLateSignInUIRecoversFromBlankRouteOverlay() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .youtube,
            loadInitialPages: false
        )
        let webView = store.webView(for: .youtube)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            "<html><body><main id=\"content\"></main></body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/feed/subscriptions"))
        )

        for _ in 0..<140 {
            if case .degraded = store.health[.youtube] { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case .degraded = store.health[.youtube] else {
            return XCTFail("The blank YouTube route should expose recovery after its grace period")
        }

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const topbar = document.createElement('ytm-mobile-topbar-renderer');
              topbar.style.cssText = 'display:block;width:390px;height:56px';
              topbar.textContent = 'YouTube';
              document.getElementById('content').appendChild(topbar);
              const navigation = document.createElement('ytm-pivot-bar-renderer');
              navigation.style.cssText = 'display:block;width:390px;height:64px';
              navigation.textContent = 'Home You';
              document.getElementById('content').appendChild(navigation);
              const link = document.createElement('a');
              link.href = 'https://accounts.google.com/ServiceLogin';
              link.textContent = 'Sign in';
              link.style.cssText = 'display:block;width:140px;height:44px';
              document.getElementById('content').appendChild(link);
            })()
            """
        )
        for _ in 0..<60 {
            if case .advisory = store.health[.youtube] { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case let .advisory(detail) = store.health[.youtube] else {
            return XCTFail("Late usable sign-in UI should replace the blocking blank-route overlay")
        }
        XCTAssertTrue(detail.contains("signed out"))
    }

    @MainActor
    func testYouTubeEmptySubscriptionsShellIsUsable() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .youtube,
            loadInitialPages: false
        )
        let webView = store.webView(for: .youtube)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            "<html><body><main id=\"content\"></main></body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/feed/subscriptions"))
        )

        for _ in 0..<140 {
            if case .degraded = store.health[.youtube] { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case .degraded = store.health[.youtube] else {
            return XCTFail("The blank subscriptions route should expose recovery before chrome appears")
        }
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const topbar = document.createElement('ytm-mobile-topbar-renderer');
              topbar.style.cssText = 'display:block;width:390px;height:56px';
              topbar.textContent = 'YouTube';
              const navigation = document.createElement('ytm-pivot-bar-renderer');
              navigation.style.cssText = 'display:block;width:390px;height:64px';
              navigation.innerHTML = '<a href="/">Home</a><a href="/feed/you">You</a>';
              document.body.prepend(topbar);
              document.body.appendChild(navigation);
            })()
            """
        )
        for _ in 0..<60 where store.health[.youtube] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(
            store.health[.youtube],
            .ready,
            "An intentionally empty subscriptions page remains usable through its visible YouTube chrome"
        )
    }

    @MainActor
    func testYouTubeEmptyHomeShellWaitsForHomeAvailability() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .youtube,
            loadInitialPages: false
        )
        let webView = store.webView(for: .youtube)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            """
            <html>
              <head><script>window.fetch = () => new Promise(() => {});</script></head>
              <body>
                <ytm-header style="display:block;width:390px;height:56px">YouTube</ytm-header>
                <main style="display:block;width:390px;height:700px"></main>
                <ytm-pivot-bar-renderer style="display:block;width:390px;height:64px">
                  <a href="/">Home</a><a href="/feed/you">You</a>
                </ytm-pivot-bar-renderer>
              </body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/"))
        )

        for _ in 0..<140 {
            if case .degraded = store.health[.youtube] { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard case .degraded = store.health[.youtube] else {
            return XCTFail("A Home shell must not become usable while Home availability is unresolved")
        }
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.setAttribute('data-vigil-feature-home', 'available');
              document.dispatchEvent(new CustomEvent('__vigilPolicyFeaturesChanged', {
                detail: { key: 'home', blocked: false, tier: 'normal' }
              }));
            })()
            """
        )
        for _ in 0..<60 where store.health[.youtube] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(
            store.health[.youtube],
            .ready,
            "A verified available Home shell should recover without a reload"
        )
    }

    @MainActor
    func testInstagramSlowTextShellAndTransparentContentRemainLoadingUntilUsable() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .instagram,
            loadInitialPages: false
        )
        let webView = store.webView(for: .instagram)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }
        webView.loadHTMLString(
            """
            <html><body>
              <main id="content" style="display:block;width:390px;height:760px">Loading…</main>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )

        try await Task.sleep(nanoseconds: 1_200_000_000)
        XCTAssertEqual(
            store.health[.instagram],
            .loading,
            "A generic text shell must not end Instagram's loading grace period"
        )
        _ = try await webView.evaluateJavaScript(
            """
            document.getElementById('content').innerHTML = `
              <div id="transparent-content" style="display:block;width:360px;height:240px;opacity:0">
                <article style="display:block;width:360px;height:220px">
                  <a href="/p/audit/" style="display:block;width:120px;height:44px">Post</a>
                </article>
              </div>
            `;
            """
        )
        try await Task.sleep(nanoseconds: 650_000_000)
        XCTAssertEqual(
            store.health[.instagram],
            .loading,
            "Content under a transparent ancestor must not publish Instagram ready"
        )

        _ = try await webView.evaluateJavaScript(
            "document.getElementById('transparent-content').style.opacity = '1'"
        )
        for _ in 0..<60 where store.health[.instagram] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(store.health[.instagram], .ready)
    }

    @MainActor
    func testInstagramKeepsUsableSurfaceVisibleDuringWarmDocumentNavigation() async throws {
        let suite = #function
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let store = SocialWebViewStore(
            defaults: defaults,
            fixedService: .instagram,
            loadInitialPages: false
        )
        let webView = store.webView(for: .instagram)
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }

        webView.loadHTMLString(
            """
            <html><body><main><article style="display:block;width:360px;height:220px">
              <a href="/p/audit/" style="display:block;width:120px;height:44px">Post</a>
            </article></main></body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        for _ in 0..<80 where store.health[.instagram] != .ready {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(store.health[.instagram], .ready)

        webView.loadHTMLString(
            "<html><body><main>Loading…</main></body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))
        )
        try await Task.sleep(nanoseconds: 250_000_000)
        XCTAssertEqual(
            store.health[.instagram],
            .ready,
            "A warm protected navigation must not replace Instagram with the full-screen loading overlay"
        )
    }

    func testInstagramHealthWaitsForUsableRouteContentAndDetectsBrokenChallenges() {
        let instagram = DOMAdapters.script(for: .instagram, audioEnabled: true)

        XCTAssertTrue(instagram.contains("return 'login'"))
        XCTAssertTrue(instagram.contains("return 'challenge'"))
        XCTAssertTrue(instagram.contains("const instagramHealthSelectors = Object.freeze"))
        XCTAssertTrue(instagram.contains("const boundedPageText = (maximumNodes = 160, maximumCharacters = 16_000)"))
        XCTAssertTrue(instagram.contains("const hasStrongInstagramContent = (route, pageText)"))
        XCTAssertTrue(instagram.contains("const hasUsableChallengeControls = ()"))
        XCTAssertTrue(instagram.contains("const healthElementIsActionableOrMedia"))
        XCTAssertTrue(instagram.contains("const firstActionableHealthElement"))
        XCTAssertTrue(instagram.contains("const hasSemanticInstagramContent"))
        XCTAssertTrue(instagram.contains("if (modal && firstActionableHealthElement("))
        XCTAssertTrue(instagram.contains("route === 'feed' || route === 'login' || route === 'other'"))
        XCTAssertTrue(instagram.contains("route === 'login' || route === 'challenge'"))
        XCTAssertTrue(instagram.contains("? 6000"))
        XCTAssertTrue(instagram.contains("route === 'story'"))
        XCTAssertTrue(instagram.contains("? 5000"))
        XCTAssertTrue(instagram.contains("challengeSignalPattern.test(pageText)"))
        XCTAssertTrue(instagram.contains("route !== 'challenge' && !challengeSignaled && !failureSignaled"))
        XCTAssertTrue(instagram.contains("&& hasSemanticInstagramContent(route)"))
        XCTAssertFalse(instagram.contains(
            "|| firstUsableHealthElement(['main', '[role=\"main\"]', 'section'])"
        ))
        XCTAssertTrue(instagram.contains("did not provide usable verification controls"))
        XCTAssertTrue(instagram.contains("has not loaded a usable ${healthRouteLabel(route)} surface yet"))
        XCTAssertTrue(instagram.contains("if (healthRelevant) scheduleHealth(450)"))
        XCTAssertTrue(instagram.contains("__vigilPageVerdictChanged"))
        XCTAssertTrue(instagram.contains("scheduleHealth(0);"))
        XCTAssertTrue(instagram.contains("setTimeout(() => scheduleHealth(0, true), 7000)"))
        XCTAssertFalse(instagram.contains(
            "window.__vigilBridge({ type: 'health', state: 'ready', detail: '' });"
        ))
    }

    func testWarmInstagramHealthGapsStayNonBlocking() {
        XCTAssertTrue(SocialWebViewStore.isRecoverableInstagramHealthReport(
            "Instagram has not loaded a usable story surface yet.",
            service: .instagram,
            hadUsableContent: true
        ))
        XCTAssertTrue(SocialWebViewStore.isRecoverableInstagramHealthReport(
            "Instagram reported an error instead of a usable Reels surface.",
            service: .instagram,
            hadUsableContent: true
        ))
        XCTAssertFalse(SocialWebViewStore.isRecoverableInstagramHealthReport(
            "Instagram has not loaded a usable story surface yet.",
            service: .instagram,
            hadUsableContent: false
        ))
        XCTAssertFalse(SocialWebViewStore.isRecoverableInstagramHealthReport(
            "YouTube has not loaded a usable watch surface yet.",
            service: .youtube,
            hadUsableContent: true
        ))
    }

    func testWarmInstagramPreservesItsSurfaceThroughTransientNetworkFailures() {
        XCTAssertTrue(SocialWebViewStore.shouldPreserveInstagramSurface(
            after: NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost),
            service: .instagram,
            hadUsableContent: true
        ))
        XCTAssertFalse(SocialWebViewStore.shouldPreserveInstagramSurface(
            after: NSError(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost),
            service: .instagram,
            hadUsableContent: false
        ))
        XCTAssertFalse(SocialWebViewStore.shouldPreserveInstagramSurface(
            after: NSError(domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed),
            service: .instagram,
            hadUsableContent: true
        ))
    }

    @MainActor
    func testInstagramAuthenticationSurfacesStayVisibleWithoutContentHooks() async throws {
        let fixtures: [(name: String, path: String, html: String)] = [
            (
                "challenge",
                "/challenge/",
                """
                <html><body>
                  <main style="display:block;width:320px;height:480px">
                    <form style="display:block;width:300px;height:240px">challenge_required</form>
                  </main>
                </body></html>
                """
            ),
            (
                "challenge-help-only",
                "/challenge/",
                """
                <html><body>
                  <main style="display:block;width:320px;height:480px">
                    <form style="display:block;width:300px;height:240px">
                      challenge_required
                      <a href="/help/" style="display:block;width:120px;height:44px">Help</a>
                    </form>
                  </main>
                </body></html>
                """
            ),
            (
                "challenge-unrelated-control",
                "/challenge/",
                """
                <html><body>
                  <nav style="display:block;width:320px;height:60px">
                    <div role="button" style="display:block;width:80px;height:44px">Menu</div>
                  </nav>
                  <main style="display:block;width:320px;height:420px">
                    <div>challenge_required</div>
                  </main>
                </body></html>
                """
            ),
            (
                "login-error",
                "/accounts/login/",
                """
                <html><body>
                  <main style="display:block;width:320px;height:480px">
                    <form style="display:block;width:300px;height:240px">
                      Sorry, something went wrong. There was a problem loading this page.
                    </form>
                  </main>
                </body></html>
                """
            ),
            (
                "login",
                "/accounts/login/",
                """
                <html><body>
                  <main style="display:block;width:320px;height:480px">
                    <form action="/accounts/login/" style="display:block;width:300px;height:240px">
                      <input name="username" aria-label="Username">
                      <input name="password" type="password" aria-label="Password">
                      <button type="submit">Log in</button>
                    </form>
                  </main>
                </body></html>
                """
            ),
            (
                "story",
                "/stories/audit/1/",
                """
                <html><body>
                  <main style="display:block;width:390px;height:760px">
                    <video style="display:block;width:360px;height:640px"></video>
                    <button aria-label="Next">Next</button>
                  </main>
                </body></html>
                """
            )
        ]
        var stores: [SocialWebViewStore] = []
        for fixture in fixtures {
            let suite = "\(#function).\(fixture.name)"
            let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
            defaults.removePersistentDomain(forName: suite)
            let store = SocialWebViewStore(
                defaults: defaults,
                fixedService: .instagram,
                loadInitialPages: false
            )
            store.webView(for: .instagram).loadHTMLString(
                fixture.html,
                baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com\(fixture.path)"))
            )
            stores.append(store)
        }

        let reachedExpectedStates = {
            guard stores.count == 6 else { return false }
            return stores.allSatisfy { $0.health[.instagram] == .ready }
        }
        for _ in 0..<180 where !reachedExpectedStates() {
            try await Task.sleep(nanoseconds: 50_000_000)
        }

        XCTAssertTrue(reachedExpectedStates(), "Meta's authentication UI must remain visible, including its own errors")
        for store in stores.prefix(5) {
            let hooks = try await store.webView(for: .instagram).evaluateJavaScript(
                "[Boolean(window.__vigilContentBootstrapInstalled), Boolean(window.__vigilEarlyMediaGate), Boolean(window.__vigilInstagramInstalled)]"
            ) as? [Bool]
            XCTAssertEqual(hooks, [false, false, false])
        }
        let storyHooks = try await stores[5].webView(for: .instagram).evaluateJavaScript(
            "[Boolean(window.__vigilContentBootstrapInstalled), Boolean(window.__vigilEarlyMediaGate), Boolean(window.__vigilInstagramInstalled)]"
        ) as? [Bool]
        XCTAssertEqual(storyHooks, [true, true, true])
    }

    func testConservativeTextClassifierStillChecksBoundedTextWhenPageIsLong() async {
        let policy = ExplicitContentTextPolicy.load()
        XCTAssertNotNil(policy, "The generated explicit-content policy must be bundled with the app target")
        let classifier = ConservativePageTextClassifier(policy: policy)
        let truncated = await classifier.classify(pageText: "ordinary page", wasTruncated: true)
        let explicit = await classifier.classify(pageText: "contains explicit sexual content", wasTruncated: false)
        let blockedBrand = await classifier.classify(pageText: "Continue reading on ToonGod", wasTruncated: false)
        let contextual = await classifier.classify(pageText: "A mature webtoon series", wasTruncated: false)
        let ordinary = await classifier.classify(pageText: "ordinary page", wasTruncated: false)
        let unrelatedAdult = await classifier.classify(pageText: "Adult learning and professional development", wasTruncated: false)
        XCTAssertEqual(truncated, .safe)
        XCTAssertEqual(explicit, .sensitive)
        XCTAssertEqual(blockedBrand, .sensitive)
        XCTAssertEqual(contextual, .sensitive)
        XCTAssertEqual(ordinary, .safe)
        XCTAssertEqual(unrelatedAdult, .safe)
    }

    func testTextClassifierFailsClosedWhenGeneratedPolicyIsUnavailableOrIncomplete() async {
        let missing = ConservativePageTextClassifier(policy: nil)
        let incompletePolicy = ExplicitContentTextPolicy(
            schemaVersion: ExplicitContentTextPolicy.currentSchemaVersion,
            terms: ["porn"],
            phrases: ["explicit sexual content"],
            contextualRules: []
        )

        XCTAssertFalse(incompletePolicy.isUsable)
        let missingVerdict = await missing.classify(pageText: "ordinary page", wasTruncated: false)
        let incompleteVerdict = await ConservativePageTextClassifier(policy: incompletePolicy)
            .classify(pageText: "ordinary page", wasTruncated: false)
        XCTAssertEqual(missingVerdict, .unknown)
        XCTAssertEqual(incompleteVerdict, .unknown)
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
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://consent.youtube.com/m")
        )))
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID?ssdc=opaque")
        )))
        XCTAssertTrue(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID/")
        )))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/%53etSID")
        )))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/CheckConnection")
        )))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/RotateCookiesPage")
        )))
        XCTAssertFalse(SocialService.youtube.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com:8443/accounts/SetSID")
        )))
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

    func testAuthenticationDocumentsBypassContentInjection() throws {
        for path in [
            "/accounts/login/",
            "/accounts/password/reset/",
            "/accounts/account_recovery/",
            "/accounts/onetap/",
            "/accounts/challenge/",
            "/accounts/verification/",
            "/challenge/",
            "/checkpoint/",
            "/accounts/two_factor/"
        ] {
            XCTAssertTrue(SocialService.instagram.usesUnmodifiedAuthenticationDocument(
                try XCTUnwrap(URL(string: "https://www.instagram.com\(path)"))
            ))
        }
        XCTAssertTrue(SocialService.instagram.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://www.facebook.com/dialog/oauth?client_id=1"))
        ))
        XCTAssertFalse(SocialService.instagram.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        ))
        XCTAssertFalse(SocialService.instagram.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))
        ))
        XCTAssertFalse(SocialService.instagram.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://www.facebook.com/"))
        ))
        XCTAssertTrue(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.google.com/ServiceLogin"))
        ))
        XCTAssertTrue(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://consent.youtube.com/m"))
        ))
        XCTAssertTrue(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.youtube.com/accounts/SetSID?ssdc=opaque"))
        ))
        XCTAssertTrue(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.youtube.com/accounts/CheckConnection"))
        ))
        XCTAssertTrue(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.youtube.com/RotateCookiesPage"))
        ))
        XCTAssertFalse(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.youtube.com/RotateCookies"))
        ))
        for encodedPath in [
            "/accounts/%53etSID",
            "/accounts/Check%43onnection",
            "/RotateCookies%50age"
        ] {
            XCTAssertFalse(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
                try XCTUnwrap(URL(string: "https://accounts.youtube.com\(encodedPath)"))
            ))
        }
        XCTAssertFalse(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://accounts.google.com.example.com/ServiceLogin"))
        ))
        XCTAssertFalse(SocialService.youtube.usesUnmodifiedAuthenticationDocument(
            try XCTUnwrap(URL(string: "https://m.youtube.com/signin"))
        ))

        let instagramStart = DOMAdapters.documentStartScript(
            for: .instagram,
            unclassifiedMediaPolicy: .conceal,
            audioEnabled: true
        )
        let youtubeStart = DOMAdapters.documentStartScript(
            for: .youtube,
            unclassifiedMediaPolicy: .conceal,
            audioEnabled: true
        )
        let instagramEndScripts = [
            DOMAdapters.installedFrameSafetyScript(for: .instagram, audioEnabled: true),
            DOMAdapters.installedFrameRoutePolicyGuard(for: .instagram),
            DOMAdapters.installedControlsScript(for: .instagram)
        ]
        XCTAssertTrue(instagramStart.contains("Keep Meta's authentication and security-check environment pristine"))
        XCTAssertTrue(instagramStart.contains("__vigilAuthenticationTransitionWatchdogInstalled"))
        XCTAssertTrue(instagramStart.contains("location.reload()"))
        XCTAssertTrue(instagramEndScripts.allSatisfy {
            $0.contains("Keep Meta's authentication and security-check environment pristine")
        })
        XCTAssertTrue(youtubeStart.contains("host === 'accounts.google.com'"))
        XCTAssertTrue(youtubeStart.contains("host === 'consent.youtube.com'"))
        XCTAssertTrue(youtubeStart.contains("host === 'accounts.youtube.com'"))
        XCTAssertTrue(youtubeStart.contains("'/accounts/SetSID'"))
        XCTAssertTrue(youtubeStart.contains("'/accounts/CheckConnection'"))
        XCTAssertTrue(youtubeStart.contains("'/RotateCookiesPage'"))
        XCTAssertTrue(youtubeStart.contains("first-party auth/session frames completely outside Vigil's"))
    }

    func testEmbeddedNavigationRestoresRequiredServiceFramesWithoutBecomingABrowser() throws {
        XCTAssertTrue(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(URL(string: "about:blank"))))
        XCTAssertTrue(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID?ssdc=opaque")
        )))
        XCTAssertTrue(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/CheckConnection")
        )))
        XCTAssertTrue(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/RotateCookiesPage/")
        )))
        XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/RotateCookies")
        )))
        for encodedPath in [
            "/accounts/%53etSID",
            "/accounts/Check%43onnection",
            "/RotateCookies%50age"
        ] {
            XCTAssertFalse(SocialService.youtube.allowsEmbeddedNavigation(to: try XCTUnwrap(
                URL(string: "https://accounts.youtube.com\(encodedPath)")
            )))
        }
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
        XCTAssertEqual(SocialService.instagram.homeURL.path, "/")
        XCTAssertEqual(SocialService.youtube.homeURL.path, "/")
    }

    func testYouTubeAdapterBlocksShortsAndPersistsPlayback() {
        let script = DOMAdapters.script(for: .youtube, audioEnabled: true)
        XCTAssertTrue(script.contains("/shorts"))
        XCTAssertTrue(script.contains("enforceRestrictedLocation"))
        XCTAssertTrue(script.contains("/feed/recommended"))
        XCTAssertTrue(script.contains("/feed/explore"))
        XCTAssertTrue(script.contains("searchParams.get('search_query')"))
        XCTAssertTrue(script.contains("if (window !== window.top) return"))
        XCTAssertTrue(script.contains("'yt-navigate-start', 'yt-navigate-finish'"))
        XCTAssertTrue(script.contains("if (location.href !== lastPolicyRouteURL) scheduleRoutePolicyCheck()"))
        XCTAssertTrue(script.contains("html[data-vigil-route-policy-blocked] body"))
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
        XCTAssertTrue(script.contains("videoHasActiveAd(video)"))
        XCTAssertTrue(script.contains("ytm-open-app-button"))
        XCTAssertTrue(script.contains("disallowed_useragent"))
        XCTAssertTrue(script.contains("YouTube is signed out"))
    }

    @MainActor
    func testYouTubeCachedNativePushStateCannotBypassShortsPolicy() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .youtube),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )

        let loaded = expectation(description: "YouTube cached-history fixture loaded")
        let initialDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = initialDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <script>
                  window.__vigilFixtureNativePushState = history.pushState;
                  window.__vigilFixtureMessages = [];
                  window.__vigilBridge = (payload) => window.__vigilFixtureMessages.push(payload);
                </script>
              </head>
              <body><main id="fixture">YouTube route fixture</main></body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=audit"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "window.__vigilYouTubeInstalled === true",
            in: webView
        )

        let redirected = expectation(description: "Shorts redirected to YouTube subscriptions")
        let routeDelegate = RoutePolicyNavigationDelegate(
            expectedHost: "m.youtube.com",
            expectedPath: "/feed/subscriptions",
            expectation: redirected
        )
        webView.navigationDelegate = routeDelegate
        _ = try? await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureUsedCachedHistory =
                window.__vigilFixtureNativePushState !== history.pushState;
              window.__vigilFixtureNativePushState.call(history, {}, '', '/shorts/audit');
              document.dispatchEvent(new Event('yt-navigate-finish'));
              const mutation = document.createElement('ytm-reel-item-renderer');
              document.getElementById('fixture').appendChild(mutation);
              return true;
            })()
            """
        )
        await fulfillment(of: [redirected], timeout: 3)

        XCTAssertEqual(routeDelegate.matchedURL?.host, "m.youtube.com")
        XCTAssertEqual(routeDelegate.matchedURL?.path, "/feed/subscriptions")
        let rawState = try await webView.evaluateJavaScript(
            """
            ({
              usedCachedHistory: window.__vigilFixtureUsedCachedHistory === true,
              policy: document.documentElement.dataset.vigilRoutePolicyBlocked || '',
              hidden: getComputedStyle(document.body).visibility === 'hidden',
              reported: window.__vigilFixtureMessages.some((message) =>
                String(message.detail || '').includes('Shorts is intentionally unavailable')
              )
            })
            """
        )
        let state = try XCTUnwrap(rawState as? [String: Any])
        XCTAssertEqual(state["usedCachedHistory"] as? Bool, true)
        XCTAssertEqual(state["policy"] as? String, "shorts")
        XCTAssertEqual(state["hidden"] as? Bool, true)
        XCTAssertEqual(state["reported"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            window.__vigilFixtureNativePushState.call(history, {}, '', '/watch?v=recovered');
            document.dispatchEvent(new Event('yt-navigate-finish'));
            """
        )
        try await waitForJavaScriptCondition(
            """
            !document.documentElement.hasAttribute('data-vigil-route-policy-blocked')
              && getComputedStyle(document.body).visibility !== 'hidden'
            """,
            in: webView
        )
    }

    @MainActor
    func testYouTubeCachedNativePushStateCannotBypassDynamicRoutePolicy() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .youtube),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )

        let loaded = expectation(description: "YouTube dynamic-route fixture loaded")
        let initialDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = initialDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <script>
                  window.__vigilFixtureNativePushState = history.pushState;
                  window.__vigilFixtureMessages = [];
                  window.__vigilBridge = (payload) => window.__vigilFixtureMessages.push(payload);
                  window.fetch = () => new Promise(() => {});
                </script>
              </head>
              <body><main id="fixture">YouTube dynamic route fixture</main></body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=audit"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "window.__vigilYouTubeInstalled === true",
            in: webView
        )

        let blockedRoutes = [
            (feature: "explore", route: "/feed/explore"),
            (feature: "home", route: "/feed/recommended"),
            (feature: "home", route: "/"),
            (feature: "suggested", route: "/results?search_query=shorts+audit")
        ]
        for blockedRoute in blockedRoutes {
            _ = try await webView.evaluateJavaScript(
                """
                window.__vigilFixtureNativePushState.call(history, {}, '', '/watch?v=recovered');
                document.dispatchEvent(new Event('yt-navigate-finish'));
                """
            )
            try await waitForJavaScriptCondition(
                "!document.documentElement.hasAttribute('data-vigil-route-policy-blocked')",
                in: webView
            )

            let redirected = expectation(
                description: "\(blockedRoute.feature) redirected to YouTube subscriptions"
            )
            let routeDelegate = RoutePolicyNavigationDelegate(
                expectedHost: "m.youtube.com",
                expectedPath: "/feed/subscriptions",
                expectation: redirected
            )
            webView.navigationDelegate = routeDelegate
            _ = try? await webView.callAsyncJavaScript(
                """
                document.documentElement.setAttribute(
                  `data-vigil-feature-${feature}`,
                  'blocked'
                );
                document.dispatchEvent(new CustomEvent('__vigilPolicyFeaturesChanged', {
                  detail: { key: feature, blocked: true, tier: 'soft' }
                }));
                window.__vigilFixtureNativePushState.call(history, {}, '', route);
                document.dispatchEvent(new Event('yt-navigate-finish'));
                """,
                arguments: [
                    "feature": blockedRoute.feature,
                    "route": blockedRoute.route
                ],
                in: nil,
                in: .page
            )
            await fulfillment(of: [redirected], timeout: 3)

            XCTAssertEqual(routeDelegate.matchedURL?.path, "/feed/subscriptions")
            let rawState = try await webView.evaluateJavaScript(
                """
                ({
                  policy: document.documentElement.dataset.vigilRoutePolicyBlocked || '',
                  hidden: getComputedStyle(document.body).visibility === 'hidden'
                })
                """
            )
            let state = try XCTUnwrap(rawState as? [String: Any])
            XCTAssertEqual(state["policy"] as? String, blockedRoute.feature)
            XCTAssertEqual(state["hidden"] as? Bool, true)
        }
    }

    func testInstagramAdapterPreservesSiteLayoutAndMatchesIndependentNativeControls() {
        let script = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertFalse(script.contains("body { max-width: none"))
        XCTAssertFalse(script.contains("touch-action: pan-x pan-y"))
        XCTAssertTrue(script.contains("['reels', 'explore', 'suggested', 'shopping', 'ads']"))
        XCTAssertTrue(script.contains("a[href=\"/reels/\"]"))
        XCTAssertTrue(script.contains("data-vigil-feature-shopping=\"available\""))
        XCTAssertTrue(script.contains("exactLeafLabel(card, 'sponsored')"))
        XCTAssertFalse(script.contains("navigation.insertBefore(reelsItem, directItem)"))
        XCTAssertTrue(script.contains("feature === 'suggested'"))
        XCTAssertFalse(script.contains("data-vigil-instagram-route-feature=\"reels\""))
        XCTAssertTrue(script.contains("html[data-vigil-route-policy-blocked] body"))
        XCTAssertTrue(script.contains("const enforceRoute = () =>"))
        XCTAssertTrue(script.contains("featureState('suggested') !== 'available'"))
        XCTAssertFalse(script.contains("location.replace('/accounts/login/')"))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-hidden-feature')"))
        XCTAssertTrue(script.contains("__vigilAudioPreferred = configuredAudioPreference"))
        XCTAssertTrue(script.contains("vigilMutedByPreference"))
        XCTAssertFalse(script.contains("window.__vigilAudioPreferred && hasGesture"))
        XCTAssertTrue(script.contains("data-vigil-instagram-comments-sheet=\"true\""))
        XCTAssertTrue(script.contains("height: 52dvh !important"))
        XCTAssertTrue(script.contains("const isInstagramCommentsDialog"))
        XCTAssertTrue(script.contains("normalizeCommentSheets()"))
        XCTAssertTrue(script.contains("const instagramCommentSheetFor"))
        XCTAssertTrue(script.contains("const nestedCommentPanel"))
        XCTAssertTrue(script.contains("const rememberCommentPlayback"))
        XCTAssertTrue(script.contains("window.__vigilEarlyMediaGate?.isHeld?.(media)"))
        XCTAssertFalse(script.contains("const minimumReelsNormalizationInterval = 320"))
        XCTAssertFalse(script.contains("link.rel = 'prefetch'"))
        XCTAssertFalse(script.contains("const reconcileRepostControl"))
        XCTAssertFalse(script.contains("scrollBy({"))
        XCTAssertFalse(script.contains("scrollTop = target"))
    }

    @MainActor
    func testInstagramCommentsUseABottomHalfSheet() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "Instagram comments fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>html,body{margin:0;width:100%;height:100%}</style>
            </head><body>
              <main><article>
                <video id="media" style="display:block;width:390px;height:520px"></video>
                <button id="open-comments" aria-label="Comments">Open comments</button>
              </article></main>
              <script>
                const media = document.getElementById('media');
                let playing = true;
                window.__vigilFixturePlayCalls = 0;
                Object.defineProperty(media, 'paused', {
                  configurable: true,
                  get: () => !playing
                });
                Object.defineProperty(media, 'ended', {
                  configurable: true,
                  get: () => false
                });
                media.play = () => {
                  playing = true;
                  window.__vigilFixturePlayCalls += 1;
                  return Promise.resolve();
                };
                document.getElementById('open-comments').addEventListener('click', () => {
                  playing = false;
                  const dialog = document.createElement('section');
                  dialog.id = 'post-dialog';
                  dialog.setAttribute('role', 'dialog');
                  dialog.setAttribute('aria-label', 'Post');
                  dialog.style.cssText = 'position:fixed;inset:0;width:390px;height:844px';
                  const comments = document.createElement('section');
                  comments.id = 'comments';
                  comments.style.cssText = 'position:absolute;inset:0;width:390px;height:844px;background:white';
                  comments.innerHTML = '<h2>Comments</h2><textarea placeholder="Add a comment…"></textarea>';
                  dialog.append(media, comments);
                  document.body.append(dialog);
                });
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/p/fixture/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        _ = try await webView.evaluateJavaScript("document.getElementById('open-comments').click()")
        try await waitForJavaScriptCondition(
            "document.getElementById('comments')?.dataset.vigilInstagramCommentsSheet === 'true' && !document.getElementById('media').paused",
            in: webView
        )

        let geometry = try await webView.evaluateJavaScript(
            """
            (() => {
              const rect = document.getElementById('comments').getBoundingClientRect();
              const outer = document.getElementById('post-dialog');
              return {
                top: rect.top,
                bottom: rect.bottom,
                viewport: innerHeight,
                outerHeight: outer.getBoundingClientRect().height,
                outerSheet: outer.dataset.vigilInstagramCommentsSheet || '',
                playCalls: window.__vigilFixturePlayCalls,
                playing: !document.getElementById('media').paused
              };
            })()
            """
        ) as? [String: Any]
        let top = try XCTUnwrap(geometry?["top"] as? Double)
        let bottom = try XCTUnwrap(geometry?["bottom"] as? Double)
        let viewport = try XCTUnwrap(geometry?["viewport"] as? Double)
        XCTAssertEqual(bottom, viewport, accuracy: 2)
        XCTAssertGreaterThan(top, viewport * 0.4)
        XCTAssertGreaterThan(try XCTUnwrap(geometry?["outerHeight"] as? Double), 700)
        XCTAssertEqual(geometry?["outerSheet"] as? String, "")
        XCTAssertEqual(geometry?["playCalls"] as? Int, 1)
        XCTAssertEqual(geometry?["playing"] as? Bool, true)
    }

    @MainActor
    func testInstagramFullScreenReelIsNotMistakenForCommentsSheet() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "full-screen Reel fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>html,body{margin:0;width:100%;height:100%;background:black;color:white}</style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilFixtureMessages = [];
                window.__vigilBridge = (payload) => window.__vigilFixtureMessages.push(payload);
              </script>
            </head><body>
              <section id="reel" role="dialog" aria-label="Reel"
                style="position:fixed;inset:0;width:390px;height:780px">
                <video id="reel-video" style="display:block;width:390px;height:650px"></video>
                <div id="description" style="position:absolute;left:12px;bottom:20px;width:280px;height:72px">
                  <a href="/royaluser/">royaluser</a><span> The complete Reel description stays visible.</span>
                </div>
                <textarea aria-label="Add a comment" placeholder="Add a comment…"></textarea>
              </section>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reel/fixture/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "document.documentElement.dataset.vigilFeatureReels === 'available'",
            in: webView
        )
        try await Task.sleep(nanoseconds: 250_000_000)

        let state = try await webView.evaluateJavaScript(
            """
            (() => {
              const reel = document.getElementById('reel');
              const description = document.getElementById('description');
              const reelRect = reel.getBoundingClientRect();
              const descriptionRect = description.getBoundingClientRect();
              return {
                commentsSheet: reel.dataset.vigilInstagramCommentsSheet || '',
                reelHeight: reelRect.height,
                descriptionVisible: getComputedStyle(description).display !== 'none'
                  && descriptionRect.bottom <= reelRect.bottom,
                reportedReels: window.__vigilFixtureMessages.some((message) =>
                  message.type === 'surface' && message.route === 'reels' && message.fullBleedTop === false
                )
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["commentsSheet"] as? String, "")
        XCTAssertGreaterThan(try XCTUnwrap(state?["reelHeight"] as? Double), 700)
        XCTAssertEqual(state?["descriptionVisible"] as? Bool, true)
        XCTAssertEqual(state?["reportedReels"] as? Bool, true)
    }

    @MainActor
    func testInstagramDirectSurfacesSplitInboxAndThreadSynchronouslyOnRouteChange() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "Instagram Direct route fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            """
            <html><head><script>
              window.__vigilFixtureMessages = [];
              window.__vigilBridge = (payload) => window.__vigilFixtureMessages.push(payload);
            </script></head><body>
              <main><a href="/direct/t/fixture/">Conversation</a><textarea></textarea></main>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "window.__vigilFixtureMessages.some((message) => message.route === 'directInbox')",
            in: webView
        )

        let synchronousRoute = try await webView.evaluateJavaScript(
            """
            (() => {
              history.pushState({}, '', '/direct/t/fixture/');
              document.dispatchEvent(new Event('__vigilRouteChanged'));
              return window.__vigilFixtureMessages.filter((message) => message.type === 'surface').at(-1)?.route;
            })()
            """
        ) as? String
        XCTAssertEqual(synchronousRoute, "directThread")
        let directFullBleed = try await webView.evaluateJavaScript(
            "window.__vigilFixtureMessages.filter((message) => message.type === 'surface').at(-1)?.fullBleedTop"
        ) as? Bool
        XCTAssertEqual(directFullBleed, false)
    }

    @MainActor
    func testInstagramDirectQuickTapActivatesOnceAndLongHoldKeepsTheMessageMenu() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "Instagram Direct touch fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            """
            <html><body>
              <div id="message-row">
                <a id="conversation" href="/direct/t/friend/">
                  <span id="conversation-label">Friend</span>
                </a>
                <button id="message-menu" hidden>React · More</button>
              </div>
              <script>
                window.__vigilDirectFixture = {
                  clicks: 0,
                  menuClicks: 0,
                  pointerUps: 0,
                  holdTimer: 0,
                  pointer(type, id, x = 80, y = 120) {
                    document.getElementById('conversation-label').dispatchEvent(
                      new PointerEvent(type, {
                        bubbles: true,
                        cancelable: true,
                        pointerId: id,
                        pointerType: 'touch',
                        isPrimary: true,
                        clientX: x,
                        clientY: y,
                        button: 0
                      })
                    );
                  }
                };
                const fixture = window.__vigilDirectFixture;
                const conversation = document.getElementById('conversation');
                conversation.addEventListener('click', (event) => {
                  event.preventDefault();
                  fixture.clicks += 1;
                  document.getElementById('message-menu').hidden = true;
                });
                document.getElementById('message-menu').addEventListener('click', () => {
                  fixture.menuClicks += 1;
                });
                conversation.addEventListener('pointerdown', () => {
                  clearTimeout(fixture.holdTimer);
                  fixture.holdTimer = setTimeout(() => {
                    document.getElementById('message-menu').hidden = false;
                  }, 320);
                });
                conversation.addEventListener('pointerup', () => {
                  fixture.pointerUps += 1;
                  clearTimeout(fixture.holdTimer);
                });
                conversation.addEventListener('pointercancel', () => {
                  clearTimeout(fixture.holdTimer);
                });
              </script>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const fixture = window.__vigilDirectFixture;
              fixture.pointer('pointerdown', 51);
              fixture.pointer('pointerup', 51);
              // Model the hover menu appearing beneath the touch before
              // WebKit's compatibility click. It must not steal activation.
              document.getElementById('message-menu').hidden = false;
              document.getElementById('message-menu').dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  clientX: 80,
                  clientY: 120
                })
              );
            })()
            """
        )
        try await Task.sleep(nanoseconds: 50_000_000)
        let quickTap = try await webView.evaluateJavaScript(
            """
            ({
              clicks: window.__vigilDirectFixture.clicks,
              menuClicks: window.__vigilDirectFixture.menuClicks,
              pointerUps: window.__vigilDirectFixture.pointerUps,
              menuVisible: !document.getElementById('message-menu').hidden
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(quickTap?["clicks"] as? Int, 1)
        XCTAssertEqual(quickTap?["menuClicks"] as? Int, 0)
        XCTAssertEqual(quickTap?["pointerUps"] as? Int, 1)
        XCTAssertEqual(quickTap?["menuVisible"] as? Bool, false)

        _ = try await webView.evaluateJavaScript(
            "window.__vigilDirectFixture.pointer('pointerdown', 52)"
        )
        try await Task.sleep(nanoseconds: 500_000_000)
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilDirectFixture.pointer('pointerup', 52);
              document.getElementById('conversation-label').dispatchEvent(
                new MouseEvent('click', {
                  bubbles: true,
                  cancelable: true,
                  clientX: 80,
                  clientY: 120
                })
              );
            })()
            """
        )
        try await Task.sleep(nanoseconds: 50_000_000)
        let longHold = try await webView.evaluateJavaScript(
            """
            ({
              clicks: window.__vigilDirectFixture.clicks,
              menuClicks: window.__vigilDirectFixture.menuClicks,
              pointerUps: window.__vigilDirectFixture.pointerUps,
              menuVisible: !document.getElementById('message-menu').hidden
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(longHold?["clicks"] as? Int, 1)
        XCTAssertEqual(longHold?["menuClicks"] as? Int, 0)
        XCTAssertEqual(longHold?["pointerUps"] as? Int, 2)
        XCTAssertEqual(longHold?["menuVisible"] as? Bool, true)
    }

    @MainActor
    func testInstagramReelsSnapPrimeHighDensityMediaAndProtectCaptionHitTarget() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            webView.navigationDelegate = nil
            webView.stopLoading()
            window.isHidden = true
        }

        let loaded = expectation(description: "Reels geometry fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black;color:white}
                #reels-scroll{position:fixed;inset:0 0 64px 0;overflow-y:scroll;scroll-snap-type:y mandatory}
                .card{position:relative;width:390px;height:780px;scroll-snap-align:start}
                .visual{display:block;width:390px;height:620px}
                .metadata{position:absolute;left:12px;bottom:0;width:280px;height:96px}
                .actions{position:absolute;right:8px;bottom:72px;width:52px;height:240px;display:flex;flex-direction:column}
                .actions button{display:block;width:48px;height:48px}
                #bottom-nav{position:fixed;left:0;right:0;bottom:0;height:64px;background:#111}
              </style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilBridge = () => {};
                window.__vigilFixtureCaptionClicks = 0;
                window.__vigilFixtureMediaClicks = 0;
              </script>
            </head><body>
              <main id="reels-scroll">
                <article id="first" class="card">
                  <video id="video" class="visual" preload="none"></video>
                  <div id="metadata" class="metadata">
                    <a href="/royaluser/">royaluser</a>
                    <span> Full-resolution description text.</span>
                    <button id="read-caption" aria-expanded="false">Read caption</button>
                  </div>
                  <div id="actions" class="actions">
                    <button aria-label="Like">Like</button>
                    <button aria-label="Comment">Comment</button>
                    <button id="share" aria-label="Share">Share</button>
                  </div>
                </article>
                <article id="second" class="card">
                  <picture>
                    <source id="source" srcset="https://scontent.test.cdninstagram.com/low.jpg 320w, https://scontent.test.cdninstagram.com/high.jpg 1080w">
                    <img id="image" class="visual" src="https://scontent.test.cdninstagram.com/low.jpg"
                      srcset="https://scontent.test.cdninstagram.com/low.jpg 320w, https://scontent.test.cdninstagram.com/high.jpg 1080w"
                      sizes="100px">
                  </picture>
                </article>
              </main>
              <nav id="bottom-nav"><a href="/direct/inbox/">Direct</a><a href="/reels/">Reels</a></nav>
              <script>
                document.getElementById('first').addEventListener('click', () => {
                  window.__vigilFixtureMediaClicks += 1;
                  const video = document.getElementById('video');
                  video.muted = !video.muted;
                });
                document.getElementById('read-caption').addEventListener('click', () => {
                  window.__vigilFixtureCaptionClicks += 1;
                  document.getElementById('read-caption').setAttribute('aria-expanded', 'true');
                });
                window.__vigilFixtureRepostClicks = 0;
                document.getElementById('share').addEventListener('click', () => {
                  const dialog = document.createElement('div');
                  dialog.id = 'share-sheet';
                  dialog.setAttribute('role', 'dialog');
                  dialog.style.cssText = 'position:fixed;left:20px;top:80px;width:300px;height:300px';
                  const repost = document.createElement('button');
                  repost.setAttribute('aria-label', 'Repost');
                  repost.style.cssText = 'display:block;width:120px;height:48px';
                  repost.addEventListener('click', () => {
                    window.__vigilFixtureRepostClicks += 1;
                    const state = document.createElement('button');
                    state.setAttribute('aria-label', 'Remove repost');
                    state.style.cssText = 'display:block;width:48px;height:48px';
                    document.getElementById('actions').insertBefore(
                      state,
                      document.getElementById('share')
                    );
                    dialog.remove();
                  });
                  dialog.appendChild(repost);
                  document.body.appendChild(dialog);
                });
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "document.getElementById('first')?.dataset.vigilInstagramReelsCard === 'true' && Boolean(document.querySelector('[data-vigil-instagram-repost-proxy=\"true\"]'))",
            in: webView
        )

        let initial = try await webView.evaluateJavaScript(
            """
            (() => {
              const scroller = document.getElementById('reels-scroll');
              const card = document.getElementById('first');
              const metadata = document.getElementById('metadata');
              const image = document.getElementById('image');
              const video = document.getElementById('video');
              const nav = document.getElementById('bottom-nav');
              const metadataRect = metadata.getBoundingClientRect();
              const cardRect = card.getBoundingClientRect();
              return {
                scrollMarked: scroller.dataset.vigilInstagramReelsScroll === 'true',
                snapType: getComputedStyle(scroller).scrollSnapType,
                snapStop: getComputedStyle(card).scrollSnapStop,
                snapAlign: getComputedStyle(card).scrollSnapAlign,
                scrollBehavior: getComputedStyle(scroller).scrollBehavior,
                overscrollY: getComputedStyle(scroller).overscrollBehaviorY,
                overflowAnchor: getComputedStyle(scroller).overflowAnchor,
                cardHeight: cardRect.height,
                navTop: nav.getBoundingClientRect().top,
                metadataMarked: metadata.dataset.vigilInstagramReelsMetadata === 'true',
                metadataInside: metadataRect.bottom <= cardRect.bottom,
                imageSizes: image.sizes,
                sourceSizes: document.getElementById('source').sizes,
                imageLoading: image.loading,
                imagePriority: image.getAttribute('fetchpriority') || '',
                videoPreload: video.preload,
                repostProxy: Boolean(document.querySelector('[data-vigil-instagram-repost-proxy="true"]')),
                preconnected: [...document.querySelectorAll('link[rel="preconnect"]')].some((link) =>
                  link.href === 'https://scontent.test.cdninstagram.com/'
                )
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(initial?["scrollMarked"] as? Bool, true, "Reels scroller was not marked")
        XCTAssertTrue((initial?["snapType"] as? String)?.contains("mandatory") == true)
        XCTAssertEqual(initial?["snapStop"] as? String, "always")
        XCTAssertEqual(initial?["snapAlign"] as? String, "start")
        XCTAssertEqual(initial?["scrollBehavior"] as? String, "auto")
        XCTAssertEqual(initial?["overscrollY"] as? String, "contain")
        XCTAssertEqual(initial?["overflowAnchor"] as? String, "none")
        XCTAssertEqual(
            try XCTUnwrap(initial?["cardHeight"] as? Double),
            try XCTUnwrap(initial?["navTop"] as? Double),
            accuracy: 2
        )
        XCTAssertEqual(initial?["metadataMarked"] as? Bool, true, "Reel metadata was not identified")
        XCTAssertEqual(initial?["metadataInside"] as? Bool, true, "Fixture metadata escaped its card")
        XCTAssertEqual(initial?["imageSizes"] as? String, "390px")
        XCTAssertEqual(initial?["sourceSizes"] as? String, "390px")
        XCTAssertEqual(initial?["imageLoading"] as? String, "eager")
        XCTAssertEqual(initial?["videoPreload"] as? String, "auto")
        XCTAssertEqual(initial?["repostProxy"] as? Bool, true, "Repost fallback was not installed")
        XCTAssertEqual(initial?["preconnected"] as? Bool, true, "Reel CDN was not preconnected")

        _ = try await webView.evaluateJavaScript(
            "document.querySelector('[data-vigil-instagram-repost-proxy=\"true\"] > button').click()"
        )
        try await waitForJavaScriptCondition(
            "window.__vigilFixtureRepostClicks === 1",
            in: webView
        )
        let preCaptionInteractions = try await webView.evaluateJavaScript(
            "({ captionClicks: window.__vigilFixtureCaptionClicks, mediaClicks: window.__vigilFixtureMediaClicks })"
        ) as? [String: Any]
        XCTAssertEqual(
            preCaptionInteractions?["captionClicks"] as? Int,
            0,
            "Repost must not activate the caption"
        )

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const caption = document.getElementById('read-caption');
              const options = {
                bubbles: true, cancelable: true, composed: true,
                clientX: 80, clientY: 730, pointerId: 11,
                pointerType: 'touch', isPrimary: true, button: 0
              };
              caption.dispatchEvent(new PointerEvent('pointerdown', options));
              caption.dispatchEvent(new PointerEvent('pointerup', options));
              document.getElementById('reels-scroll').scrollTop =
                document.getElementById('second').offsetTop;
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('reels-scroll').scrollTop > 600 && document.getElementById('metadata').dataset.vigilInstagramReelsMetadataExpanded === 'true'",
            in: webView
        )
        let interactions = try await webView.evaluateJavaScript(
            """
            ({
              captionClicks: window.__vigilFixtureCaptionClicks,
              mediaClicks: window.__vigilFixtureMediaClicks,
              videoMuted: document.getElementById('video').muted,
              metadataOverflow: getComputedStyle(document.getElementById('metadata')).overflowY
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(interactions?["captionClicks"] as? Int, 1)
        XCTAssertEqual(interactions?["mediaClicks"] as? Int, 1)
        XCTAssertEqual(interactions?["videoMuted"] as? Bool, false)
        XCTAssertEqual(interactions?["metadataOverflow"] as? String, "visible")
    }

    @MainActor
    func testInstagramReelsClearLiveOverflowingMetadataWithoutChangingNativeSnap() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 402, height: 874),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "live-shaped native Reel geometry fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black;color:white}
                #reels-scroll{
                  position:fixed;inset:0 0 79px 0;overflow-y:scroll;
                  scroll-snap-type:y mandatory;scroll-padding-block:0
                }
                .card{position:relative;width:402px;height:795px;scroll-snap-align:start;scroll-snap-stop:always}
                .native-shell{position:relative;width:402px;height:874px}
                .visual{display:block;width:402px;height:874px;background:#111}
                .metadata{position:absolute;left:16px;top:752px;width:342.8px;height:102px}
                .username{position:absolute;left:44px;top:10.5px;width:120px;height:11px;line-height:11px}
                .caption{position:absolute;left:0;top:40px;width:260px;height:18px;line-height:18px}
                .audio{position:absolute;left:27px;top:80px;width:220px;height:16px;line-height:16px}
                .metadata-more-wrapper{position:absolute;right:0;top:38px;width:32px;height:32px}
                .metadata-more{position:absolute;inset:0;width:32px;height:32px;padding:0}
                .sponsor{position:absolute;left:16px;top:714px;width:96px;height:18px;line-height:18px}
                .right-action{position:absolute;right:12px;top:600px;width:48px;height:48px}
                #bottom-nav{position:fixed;z-index:10;left:0;right:0;top:795px;height:79px;background:#111}
              </style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilBridge = () => {};
              </script>
            </head><body>
              <main id="reels-scroll">
                <article id="first" class="card">
                  <div class="native-shell">
                    <video id="video" class="visual"></video>
                    <a id="sponsor" class="sponsor" href="/sponsor/">Sponsor</a>
                    <div id="metadata" class="metadata">
                      <span id="username" class="username">royaluser</span>
                      <span id="caption" class="caption">#porsche <span>… more</span></span>
                      <span id="audio" class="audio">Original audio</span>
                      <span class="metadata-more-wrapper" role="button" aria-label="More">
                        <button id="metadata-more" class="metadata-more" aria-label="More">⋯</button>
                      </span>
                    </div>
                    <button id="right-action" class="right-action" aria-label="Me gusta">♥</button>
                  </div>
                </article>
                <article id="second" class="card">
                  <div class="native-shell">
                    <video class="visual"></video>
                    <div id="metadata-2" class="metadata">
                      <span class="username">seconduser</span>
                      <span id="caption-2" class="caption">Second complete description</span>
                      <span id="audio-2" class="audio">Second original audio</span>
                    </div>
                  </div>
                </article>
              </main>
              <!-- The live rollout has no semantically markable common nav root. -->
              <nav id="bottom-nav"><span>Home</span><span>Search</span><span>Reels</span></nav>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "document.getElementById('metadata')?.dataset.vigilInstagramReelsMetadata === 'true'",
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const scroller = document.getElementById('reels-scroll');
              window.__vigilFixtureScrollByCalls = 0;
              scroller.scrollBy = (options) => {
                window.__vigilFixtureScrollByCalls += 1;
                scroller.scrollTop += Number(options?.top || 0);
              };
            })()
            """
        )
        try await Task.sleep(nanoseconds: 180_000_000)

        let state = try await webView.evaluateJavaScript(
            """
            (() => {
              const scroller = document.getElementById('reels-scroll');
              const card = document.getElementById('first');
              const metadata = document.getElementById('metadata');
              const caption = document.getElementById('caption');
              const audio = document.getElementById('audio');
              const navigation = document.getElementById('bottom-nav');
              const rightAction = document.getElementById('right-action');
              const username = document.getElementById('username');
              const shell = document.querySelector('#first .native-shell');
              const cardRect = card.getBoundingClientRect();
              const metadataRect = metadata.getBoundingClientRect();
              const captionRect = caption.getBoundingClientRect();
              const navigationRect = navigation.getBoundingClientRect();
              return {
                cardHeight: cardRect.height,
                cardTop: cardRect.top,
                metadataBottom: metadataRect.bottom,
                metadataWidth: metadataRect.width,
                metadataHeight: metadataRect.height,
                metadataMarked: metadata.dataset.vigilInstagramReelsMetadata === 'true',
                shellMarked: shell.dataset.vigilInstagramReelsMetadata === 'true',
                rightActionMarked: rightAction.dataset.vigilInstagramReelsMetadata === 'true',
                usernameTag: username.tagName,
                usernameInsideAnchor: Boolean(username.closest('a')),
                captionBottom: captionRect.bottom,
                audioBottom: audio.getBoundingClientRect().bottom,
                navigationTop: navigationRect.top,
                navigationMarked: navigation.dataset.vigilInstagramBottomNavigation === 'true',
                snapType: getComputedStyle(scroller).scrollSnapType,
                snapAlign: getComputedStyle(card).scrollSnapAlign,
                metadataOffset: metadata.style.getPropertyValue('--vigil-instagram-reels-metadata-offset'),
                rightActionTop: rightAction.getBoundingClientRect().top,
                forcedContainerHeight: scroller.style.getPropertyValue('--vigil-instagram-reels-card-height'),
                forcedCardHeight: card.style.getPropertyValue('--vigil-instagram-reels-card-height'),
                scrollByCalls: window.__vigilFixtureScrollByCalls
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(try XCTUnwrap(state?["cardHeight"] as? Double), 795, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(state?["cardTop"] as? Double), 0, accuracy: 1)
        XCTAssertEqual(try XCTUnwrap(state?["metadataWidth"] as? Double), 342.8, accuracy: 0.2)
        XCTAssertEqual(try XCTUnwrap(state?["metadataHeight"] as? Double), 102, accuracy: 0.2)
        XCTAssertEqual(state?["metadataMarked"] as? Bool, true)
        XCTAssertEqual(state?["shellMarked"] as? Bool, false)
        XCTAssertEqual(state?["rightActionMarked"] as? Bool, false)
        XCTAssertEqual(state?["usernameTag"] as? String, "SPAN")
        XCTAssertEqual(state?["usernameInsideAnchor"] as? Bool, false)
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(state?["metadataBottom"] as? Double),
            try XCTUnwrap(state?["navigationTop"] as? Double)
        )
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(state?["captionBottom"] as? Double),
            try XCTUnwrap(state?["navigationTop"] as? Double) - 8
        )
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(state?["audioBottom"] as? Double),
            try XCTUnwrap(state?["navigationTop"] as? Double) - 8
        )
        XCTAssertEqual(state?["navigationMarked"] as? Bool, false)
        XCTAssertTrue((state?["snapType"] as? String)?.contains("mandatory") == true)
        XCTAssertEqual(state?["snapAlign"] as? String, "start")
        XCTAssertEqual(state?["metadataOffset"] as? String, "-61px")
        XCTAssertEqual(try XCTUnwrap(state?["rightActionTop"] as? Double), 600, accuracy: 1)
        XCTAssertEqual(state?["forcedContainerHeight"] as? String, "")
        XCTAssertEqual(state?["forcedCardHeight"] as? String, "")
        XCTAssertEqual(state?["scrollByCalls"] as? Int, 0)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const scroller = document.getElementById('reels-scroll');
              scroller.scrollTop = document.getElementById('second').offsetTop;
              scroller.dispatchEvent(new Event('scroll'));
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('metadata-2').dataset.vigilInstagramReelsMetadataClearance === 'true'",
            in: webView
        )
        let nextReel = try await webView.evaluateJavaScript(
            """
            ({
              captionBottom: document.getElementById('caption-2').getBoundingClientRect().bottom,
              audioBottom: document.getElementById('audio-2').getBoundingClientRect().bottom,
              navigationTop: document.getElementById('bottom-nav').getBoundingClientRect().top,
              scrollByCalls: window.__vigilFixtureScrollByCalls
            })
            """
        ) as? [String: Any]
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(nextReel?["captionBottom"] as? Double),
            try XCTUnwrap(nextReel?["navigationTop"] as? Double) - 8
        )
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(nextReel?["audioBottom"] as? Double),
            try XCTUnwrap(nextReel?["navigationTop"] as? Double) - 8
        )
        XCTAssertEqual(nextReel?["scrollByCalls"] as? Int, 0)
    }

    @MainActor
    func testInstagramReelEdgeHoldUsesTemporaryTwoTimesAndRestoresEveryExit() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 402, height: 874),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "Instagram temporary 2x hold fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%;overflow:hidden;background:black;color:white}
                #scroll{position:fixed;inset:0 0 79px;overflow-y:scroll}
                article{position:relative;width:402px;height:795px}
                #media-wrapper{display:block;width:402px;height:795px}
                video{display:block;width:402px;height:795px;background:#111}
                #metadata{position:absolute;left:12px;bottom:16px;width:270px;height:54px;display:flex;flex-direction:column;gap:8px}
                #metadata a,#metadata span{display:block;height:18px;line-height:18px}
                #mute{position:absolute;right:12px;bottom:80px;width:48px;height:48px}
              </style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilBridge = () => {};
                window.__vigilFixtureGateHeld = false;
                window.__vigilEarlyMediaGate = {
                  isHeld: () => window.__vigilFixtureGateHeld
                };
              </script>
            </head><body>
              <main id="scroll">
                <article>
                  <a id="media-wrapper" href="/reels/current/"><video id="media"></video></a>
                  <div id="metadata">
                    <a href="/royaluser/">royaluser</a>
                    <span id="caption">A caption must win over the edge hold.</span>
                  </div>
                  <button id="mute" aria-label="Mute">Mute</button>
                </article>
                <article><video></video></article>
              </main>
              <script>
                const media = document.getElementById('media');
                let playing = true;
                window.__vigilFixturePlayCalls = 0;
                window.__vigilFixturePauseCalls = 0;
                window.__vigilFixtureNativePointerUps = 0;
                Object.defineProperty(media, 'paused', { configurable: true, get: () => !playing });
                media.play = () => {
                  window.__vigilFixturePlayCalls += 1;
                  playing = true;
                  return Promise.resolve();
                };
                media.pause = () => {
                  window.__vigilFixturePauseCalls += 1;
                  playing = false;
                };
                document.getElementById('media-wrapper').addEventListener('pointerup', () => {
                  window.__vigilFixtureNativePointerUps += 1;
                  media.muted = !media.muted;
                  media.pause();
                });
                window.__vigilFixtureSetPlaying = (value) => { playing = Boolean(value); };
                media.playbackRate = 1.25;
                window.__vigilFixturePointer = (target, type, id, x, y) => target.dispatchEvent(
                  new PointerEvent(type, {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: x, clientY: y, pointerId: id,
                    pointerType: 'touch', isPrimary: true, button: 0
                  })
                );
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "typeof window.__vigilRestoreReelHold === 'function' && document.getElementById('metadata').dataset.vigilInstagramReelsMetadata === 'true'",
            in: webView
        )

        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixturePointer(document.getElementById('media-wrapper'), 'pointerdown', 31, 20, 300)"
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('media').playbackRate === 2 && Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]'))",
            in: webView
        )
        var state = try await webView.evaluateJavaScript(
            """
            (() => {
              const feedback = document.querySelector('[data-vigil-instagram-reels-speed-feedback]');
              return {
                rate: document.getElementById('media').playbackRate,
                defaultRate: document.getElementById('media').defaultPlaybackRate,
                feedback: feedback?.textContent || '',
                feedbackBottom: feedback?.getBoundingClientRect().bottom || 9999,
                captionTop: document.getElementById('caption').getBoundingClientRect().top,
                playCalls: window.__vigilFixturePlayCalls,
                pauseCalls: window.__vigilFixturePauseCalls
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 2)
        XCTAssertEqual(state?["defaultRate"] as? Double, 1)
        XCTAssertTrue((state?["feedback"] as? String)?.contains("2× speed") == true)
        XCTAssertLessThanOrEqual(
            try XCTUnwrap(state?["feedbackBottom"] as? Double),
            try XCTUnwrap(state?["captionTop"] as? Double)
        )
        XCTAssertEqual(state?["playCalls"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)

        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixturePointer(document.getElementById('media-wrapper'), 'pointerup', 31, 20, 300)"
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('media').playbackRate === 1.25 && !document.querySelector('[data-vigil-instagram-reels-speed-feedback]')",
            in: webView
        )
        state = try await webView.evaluateJavaScript(
            "({ nativePointerUps: window.__vigilFixtureNativePointerUps, muted: document.getElementById('media').muted, pauseCalls: window.__vigilFixturePauseCalls })"
        ) as? [String: Any]
        XCTAssertEqual(state?["nativePointerUps"] as? Int, 0)
        XCTAssertEqual(state?["muted"] as? Bool, false)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 32, 382, 300);
              setTimeout(() => window.__vigilFixturePointer(media, 'pointercancel', 32, 382, 300), 380);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 470_000_000)
        var restoredRate = try await webView.evaluateJavaScript(
            "document.getElementById('media').playbackRate"
        ) as? Double
        XCTAssertEqual(restoredRate, 1.25)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 33, 20, 300);
              setTimeout(() => document.dispatchEvent(new Event('touchcancel', { bubbles: true })), 380);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 470_000_000)
        restoredRate = try await webView.evaluateJavaScript(
            "document.getElementById('media').playbackRate"
        ) as? Double
        XCTAssertEqual(restoredRate, 1.25)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 34, 20, 300);
              setTimeout(() => window.__vigilRestoreReelHold(), 380);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 470_000_000)
        restoredRate = try await webView.evaluateJavaScript(
            "document.getElementById('media').playbackRate"
        ) as? Double
        XCTAssertEqual(restoredRate, 1.25)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 35, 20, 300);
              window.__vigilFixturePointer(media, 'pointermove', 35, 22, 345);
              window.__vigilFixturePointer(media, 'pointerup', 35, 22, 345);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 380_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              rate: document.getElementById('media').playbackRate,
              feedback: Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]')),
              playCalls: window.__vigilFixturePlayCalls,
              pauseCalls: window.__vigilFixturePauseCalls
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 1.25)
        XCTAssertEqual(state?["feedback"] as? Bool, false)
        XCTAssertEqual(state?["playCalls"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)

        // iOS reuses numeric pointer IDs. A movement-canceled hold must consume
        // only its own release, then allow the same ID's next center tap.
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 35, 201, 300);
              window.__vigilFixturePointer(media, 'pointerup', 35, 201, 300);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 390_000_000)
        state = try await webView.evaluateJavaScript(
            "({ nativePointerUps: window.__vigilFixtureNativePointerUps, pauseCalls: window.__vigilFixturePauseCalls, paused: document.getElementById('media').paused })"
        ) as? [String: Any]
        XCTAssertEqual(state?["nativePointerUps"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 1)
        XCTAssertEqual(state?["paused"] as? Bool, true)
        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixtureSetPlaying(true); window.__vigilFixturePauseCalls = 0"
        )

        // A full-media role=button wrapper is still the media surface, not a
        // small control exclusion, and must retain the official edge hold.
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const wrapper = document.getElementById('media-wrapper');
              wrapper.setAttribute('role', 'button');
              window.__vigilFixturePointer(wrapper, 'pointerdown', 40, 382, 300);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('media').playbackRate === 2",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixturePointer(document.getElementById('media-wrapper'), 'pointerup', 40, 382, 300)"
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('media').playbackRate === 1.25",
            in: webView
        )
        state = try await webView.evaluateJavaScript(
            "({ nativePointerUps: window.__vigilFixtureNativePointerUps, pauseCalls: window.__vigilFixturePauseCalls })"
        ) as? [String: Any]
        XCTAssertEqual(state?["nativePointerUps"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixtureGateHeld = true;
              window.__vigilFixturePointer(media, 'pointerdown', 36, 20, 300);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 380_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              rate: document.getElementById('media').playbackRate,
              feedback: Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 1.25)
        XCTAssertEqual(state?["feedback"] as? Bool, false)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureGateHeld = false;
              window.__vigilFixtureSetPlaying(false);
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 39, 20, 300);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 380_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              rate: document.getElementById('media').playbackRate,
              feedback: Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]')),
              playCalls: window.__vigilFixturePlayCalls
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 1.25)
        XCTAssertEqual(state?["feedback"] as? Bool, false)
        XCTAssertEqual(state?["playCalls"] as? Int, 0)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureSetPlaying(true);
              const caption = document.getElementById('caption');
              window.__vigilFixturePointer(caption, 'pointerdown', 37, 20, 300);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 380_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              rate: document.getElementById('media').playbackRate,
              feedback: Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 1.25)
        XCTAssertEqual(state?["feedback"] as? Bool, false)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const media = document.getElementById('media');
              window.__vigilFixturePointer(media, 'pointerdown', 38, 20, 300);
              setTimeout(() => {
                history.pushState({}, '', '/p/fixture/');
                document.dispatchEvent(new Event('__vigilRouteChanged'));
              }, 380);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 470_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              rate: document.getElementById('media').playbackRate,
              feedback: Boolean(document.querySelector('[data-vigil-instagram-reels-speed-feedback]')),
              playCalls: window.__vigilFixturePlayCalls,
              pauseCalls: window.__vigilFixturePauseCalls
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["rate"] as? Double, 1.25)
        XCTAssertEqual(state?["feedback"] as? Bool, false)
        XCTAssertEqual(state?["playCalls"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)
    }

    @MainActor
    func testInstagramMediaDoubleTapLikesOnceWithoutChangingVideoTapStateOrLaunchingApp() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "Instagram double-tap fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%}
                article{position:relative;width:390px;height:700px}
                video{display:block;width:390px;height:620px;background:black}
                #like{position:absolute;right:12px;top:440px;width:48px;height:48px}
              </style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilBridge = () => {};
              </script>
            </head><body>
              <article id="current-reel">
                <video id="media" muted></video>
                <button id="like"><svg id="heart" aria-label="Like"></svg></button>
                <button id="mute"><svg id="speaker" aria-label="Mute"></svg></button>
              </article>
              <article id="adjacent-reel">
                <video id="other-media"></video>
                <button id="other-like"><svg aria-label="Unlike"></svg></button>
              </article>
              <a id="native-app" href="instagram://reel/fixture">Open Instagram</a>
              <script>
                window.__vigilFixtureLikeClicks = 0;
                window.__vigilFixtureMediaPointerUps = 0;
                window.__vigilFixtureMediaClicks = 0;
                window.__vigilFixtureNativeClicks = 0;
                window.__vigilFixtureNativeDoubleClicks = 0;
                window.__vigilFixtureOtherLikeClicks = 0;
                window.__vigilFixtureMuteClicks = 0;
                window.__vigilFixturePlayCalls = 0;
                window.__vigilFixturePauseCalls = 0;
                const media = document.getElementById('media');
                const heart = document.getElementById('heart');
                const speaker = document.getElementById('speaker');
                let playing = true;
                Object.defineProperty(media, 'paused', { configurable: true, get: () => !playing });
                media.play = () => {
                  window.__vigilFixturePlayCalls += 1;
                  playing = true;
                  return Promise.resolve();
                };
                media.pause = () => {
                  window.__vigilFixturePauseCalls += 1;
                  playing = false;
                };
                document.getElementById('like').addEventListener('click', () => {
                  window.__vigilFixtureLikeClicks += 1;
                  heart.setAttribute('aria-label',
                    heart.getAttribute('aria-label') === 'Like' ? 'Unlike' : 'Like');
                });
                media.addEventListener('pointerup', () => {
                  window.__vigilFixtureMediaPointerUps += 1;
                  media.muted = !media.muted;
                });
                media.addEventListener('click', () => {
                  window.__vigilFixtureMediaClicks += 1;
                  media.muted = !media.muted;
                });
                media.addEventListener('dblclick', () => {
                  window.__vigilFixtureNativeDoubleClicks += 1;
                  media.muted = !media.muted;
                });
                document.getElementById('mute').addEventListener('click', () => {
                  window.__vigilFixtureMuteClicks += 1;
                  media.muted = !media.muted;
                  speaker.setAttribute('aria-label', media.muted ? 'Unmute' : 'Mute');
                });
                document.getElementById('native-app').addEventListener('click', () => {
                  window.__vigilFixtureNativeClicks += 1;
                });
                document.getElementById('other-like').addEventListener('click', () => {
                  window.__vigilFixtureOtherLikeClicks += 1;
                });
                window.__vigilFixtureTap = (detail = 1) => {
                  const options = {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: 195, clientY: 280, pointerId: 7,
                    pointerType: 'touch', isPrimary: true, button: 0
                  };
                  media.dispatchEvent(new PointerEvent('pointerdown', options));
                  media.dispatchEvent(new PointerEvent('pointerup', options));
                  media.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: 195, clientY: 280, detail
                  }));
                  if (detail >= 2) window.__vigilFixtureDoubleClick();
                };
                window.__vigilFixtureDoubleClick = () => media.dispatchEvent(new MouseEvent('dblclick', {
                  bubbles: true, cancelable: true, clientX: 195, clientY: 280, detail: 2
                }));
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/reels/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.setAttribute('data-vigil-feature-reels', 'available');
              const media = document.getElementById('media');
              media.muted = false;
              window.__vigilFixtureTap(1);
              setTimeout(() => window.__vigilFixtureTap(2), 90);
              setTimeout(() => document.getElementById('native-app').click(), 120);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilFixtureLikeClicks === 1",
            in: webView
        )
        try await Task.sleep(nanoseconds: 180_000_000)

        var state = try await webView.evaluateJavaScript(
            """
            ({
              likeClicks: window.__vigilFixtureLikeClicks,
              label: document.getElementById('heart').getAttribute('aria-label'),
              pointerUps: window.__vigilFixtureMediaPointerUps,
              mediaClicks: window.__vigilFixtureMediaClicks,
              muted: document.getElementById('media').muted,
              paused: document.getElementById('media').paused,
              playCalls: window.__vigilFixturePlayCalls,
              pauseCalls: window.__vigilFixturePauseCalls,
              nativeClicks: window.__vigilFixtureNativeClicks,
              nativeDoubleClicks: window.__vigilFixtureNativeDoubleClicks,
              otherLikeClicks: window.__vigilFixtureOtherLikeClicks
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["likeClicks"] as? Int, 1)
        XCTAssertEqual(state?["label"] as? String, "Unlike")
        XCTAssertEqual(state?["pointerUps"] as? Int, 0)
        XCTAssertEqual(state?["mediaClicks"] as? Int, 0)
        XCTAssertEqual(state?["muted"] as? Bool, false)
        XCTAssertEqual(state?["paused"] as? Bool, false)
        XCTAssertEqual(state?["playCalls"] as? Int, 0)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)
        XCTAssertEqual(state?["nativeClicks"] as? Int, 0)
        XCTAssertEqual(state?["nativeDoubleClicks"] as? Int, 0)
        XCTAssertEqual(state?["otherLikeClicks"] as? Int, 0)

        try await Task.sleep(nanoseconds: 700_000_000)
        _ = try await webView.evaluateJavaScript(
            """
            document.getElementById('media').dispatchEvent(new MouseEvent('dblclick', {
              bubbles: true, cancelable: true, clientX: 195, clientY: 280, detail: 2
            }))
            """
        )
        try await Task.sleep(nanoseconds: 100_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              likeClicks: window.__vigilFixtureLikeClicks,
              label: document.getElementById('heart').getAttribute('aria-label'),
              heartFeedback: Boolean(document.querySelector('[data-vigil-instagram-like-heart="true"]'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["likeClicks"] as? Int, 1)
        XCTAssertEqual(state?["label"] as? String, "Unlike")
        XCTAssertEqual(state?["heartFeedback"] as? Bool, true)

        // A later manual unlike must clear the practical suppression window so
        // the same mounted control can be liked again on a subsequent double tap.
        _ = try await webView.evaluateJavaScript("document.getElementById('like').click()")
        try await Task.sleep(nanoseconds: 700_000_000)
        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureTap(1);
              setTimeout(() => window.__vigilFixtureTap(2), 90);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilFixtureLikeClicks === 3",
            in: webView
        )
        try await Task.sleep(nanoseconds: 160_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              likeClicks: window.__vigilFixtureLikeClicks,
              label: document.getElementById('heart').getAttribute('aria-label'),
              muted: document.getElementById('media').muted,
              paused: document.getElementById('media').paused
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["likeClicks"] as? Int, 3)
        XCTAssertEqual(state?["label"] as? String, "Unlike")
        XCTAssertEqual(state?["muted"] as? Bool, false)
        XCTAssertEqual(state?["paused"] as? Bool, false)

        try await Task.sleep(nanoseconds: 700_000_000)
        _ = try await webView.evaluateJavaScript("window.__vigilFixtureTap()")
        try await Task.sleep(nanoseconds: 390_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              pointerUps: window.__vigilFixtureMediaPointerUps,
              paused: document.getElementById('media').paused,
              muted: document.getElementById('media').muted,
              pauseCalls: window.__vigilFixturePauseCalls
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["pointerUps"] as? Int, 0)
        XCTAssertEqual(state?["paused"] as? Bool, true)
        XCTAssertEqual(state?["muted"] as? Bool, false)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 1)

        _ = try await webView.evaluateJavaScript("document.getElementById('mute').click()")
        state = try await webView.evaluateJavaScript(
            """
            ({
              muteClicks: window.__vigilFixtureMuteClicks,
              muted: document.getElementById('media').muted,
              speaker: document.getElementById('speaker').getAttribute('aria-label'),
              paused: document.getElementById('media').paused
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["muteClicks"] as? Int, 1)
        XCTAssertEqual(state?["muted"] as? Bool, true)
        XCTAssertEqual(state?["speaker"] as? String, "Unmute")
        XCTAssertEqual(state?["paused"] as? Bool, true)

        try await Task.sleep(nanoseconds: 700_000_000)
        _ = try await webView.evaluateJavaScript("window.__vigilFixtureTap()")
        try await Task.sleep(nanoseconds: 390_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              paused: document.getElementById('media').paused,
              muted: document.getElementById('media').muted,
              playCalls: window.__vigilFixturePlayCalls,
              pointerUps: window.__vigilFixtureMediaPointerUps
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["paused"] as? Bool, false)
        XCTAssertEqual(state?["muted"] as? Bool, true)
        XCTAssertEqual(state?["playCalls"] as? Int, 1)
        XCTAssertEqual(state?["pointerUps"] as? Int, 0)
    }

    @MainActor
    func testInstagramMediaGesturesCoverFeedAndPostModalWithoutTakingOverStories() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer { window.isHidden = true }

        let loaded = expectation(description: "Instagram multi-surface media fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html,body{margin:0;width:100%;height:100%}
                .surface{display:none;position:relative;width:390px;height:700px}
                .surface.active{display:block}
                .media{display:block;width:390px;height:620px;background:#111}
                .like{position:absolute;right:12px;top:440px;width:48px;height:48px}
              </style>
              <script>
                window.fetch = async (value) => ({ ok: true, status: 200, url: String(value) });
                window.__vigilBridge = () => {};
              </script>
            </head><body>
              <article id="feed" class="surface active">
                <video id="feed-media" class="media" muted></video>
                <button id="feed-like" class="like">
                  <svg id="feed-heart" aria-label="Like" viewBox="0 0 24 24">
                    <path d="M12 21s-8-4.8-8-11a4.5 4.5 0 0 1 8-3 4.5 4.5 0 0 1 8 3c0 6.2-8 11-8 11Z"></path>
                  </svg>
                </button>
              </article>
              <div id="post" class="surface" role="dialog" aria-hidden="true">
                <img id="post-media" class="media" alt="Post fixture">
                <button id="post-like" class="like"><svg id="post-heart" aria-label="Like"></svg></button>
              </div>
              <section id="story" class="surface">
                <video id="story-media" class="media" muted></video>
                <button id="story-like" class="like"><svg aria-label="Like"></svg></button>
              </section>
              <script>
                window.__vigilFixture = {
                  pointerId: 20,
                  feedLikeClicks: 0,
                  postLikeClicks: 0,
                  storyLikeClicks: 0,
                  feedNativePointerUps: 0,
                  feedNativeClicks: 0,
                  storyNativePointerUps: 0,
                  feedPlayCalls: 0,
                  feedPauseCalls: 0
                };
                const fixture = window.__vigilFixture;
                const feedMedia = document.getElementById('feed-media');
                let feedPlaying = true;
                Object.defineProperty(feedMedia, 'paused', {
                  configurable: true, get: () => !feedPlaying
                });
                feedMedia.play = () => {
                  fixture.feedPlayCalls += 1;
                  feedPlaying = true;
                  feedMedia.dispatchEvent(new Event('play'));
                  return Promise.resolve();
                };
                feedMedia.pause = () => {
                  fixture.feedPauseCalls += 1;
                  feedPlaying = false;
                  feedMedia.dispatchEvent(new Event('pause'));
                };
                fixture.setFeedPlaying = (value) => { feedPlaying = Boolean(value); };
                feedMedia.addEventListener('pointerup', () => {
                  fixture.feedNativePointerUps += 1;
                  feedMedia.pause();
                });
                feedMedia.addEventListener('click', () => {
                  fixture.feedNativeClicks += 1;
                  feedMedia.pause();
                });
                document.getElementById('feed-like').addEventListener('click', () => {
                  fixture.feedLikeClicks += 1;
                  const heart = document.getElementById('feed-heart');
                  heart.setAttribute('aria-label',
                    heart.getAttribute('aria-label') === 'Like' ? 'Unlike' : 'Like');
                });
                document.getElementById('post-like').addEventListener('click', () => {
                  fixture.postLikeClicks += 1;
                  const heart = document.getElementById('post-heart');
                  heart.setAttribute('aria-label',
                    heart.getAttribute('aria-label') === 'Like' ? 'Unlike' : 'Like');
                });
                document.getElementById('story-like').addEventListener('click', () => {
                  fixture.storyLikeClicks += 1;
                });
                document.getElementById('story-media').addEventListener('pointerup', () => {
                  fixture.storyNativePointerUps += 1;
                });
                fixture.tap = (target, x, y, detail = 1) => {
                  fixture.pointerId += 1;
                  const pointer = {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: x, clientY: y, pointerId: fixture.pointerId,
                    pointerType: 'touch', isPrimary: true, button: 0
                  };
                  target.dispatchEvent(new PointerEvent('pointerdown', pointer));
                  target.dispatchEvent(new PointerEvent('pointerup', pointer));
                  target.dispatchEvent(new MouseEvent('click', {
                    bubbles: true, cancelable: true, composed: true,
                    clientX: x, clientY: y, detail
                  }));
                };
                fixture.show = (name, path) => {
                  document.querySelectorAll('.surface').forEach((surface) => {
                    surface.classList.toggle('active', surface.id === name);
                  });
                  document.getElementById('post').setAttribute(
                    'aria-hidden', name === 'post' ? 'false' : 'true'
                  );
                  history.pushState({}, '', path);
                  document.dispatchEvent(new Event('__vigilRouteChanged'));
                };
              </script>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        await fulfillment(of: [loaded], timeout: 5)

        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixture.tap(document.getElementById('feed-media'), 195, 280)"
        )
        try await Task.sleep(nanoseconds: 140_000_000)
        var state = try await webView.evaluateJavaScript(
            """
            ({
              paused: document.getElementById('feed-media').paused,
              pauseCalls: window.__vigilFixture.feedPauseCalls,
              nativePointerUps: window.__vigilFixture.feedNativePointerUps,
              nativeClicks: window.__vigilFixture.feedNativeClicks
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["paused"] as? Bool, false, "tap one must not cause a half-pause")
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)
        XCTAssertEqual(state?["nativePointerUps"] as? Int, 0)
        XCTAssertEqual(state?["nativeClicks"] as? Int, 0)

        try await Task.sleep(nanoseconds: 300_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              paused: document.getElementById('feed-media').paused,
              pauseCalls: window.__vigilFixture.feedPauseCalls,
              feedback: document.querySelector('[data-vigil-instagram-playback-feedback]')?.dataset.state || '',
              feedbackHasSVG: Boolean(document.querySelector('[data-vigil-instagram-playback-feedback] svg'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["paused"] as? Bool, true)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 1)
        XCTAssertEqual(state?["feedback"] as? String, "paused")
        XCTAssertEqual(state?["feedbackHasSVG"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const fixture = window.__vigilFixture;
              fixture.setFeedPlaying(true);
              fixture.feedPauseCalls = 0;
              fixture.feedPlayCalls = 0;
              fixture.tap(document.getElementById('feed-media'), 170, 280, 1);
              setTimeout(() => fixture.tap(document.getElementById('feed-media'), 218, 280, 2), 350);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilFixture.feedLikeClicks === 1",
            in: webView
        )
        state = try await webView.evaluateJavaScript(
            """
            (() => {
              const feedback = document.querySelector('[data-vigil-instagram-like-heart="true"]');
              const feedbackPath = feedback?.querySelector('path');
              const sourcePath = document.querySelector('#feed-heart path');
              return {
                paused: document.getElementById('feed-media').paused,
                pauseCalls: window.__vigilFixture.feedPauseCalls,
                playCalls: window.__vigilFixture.feedPlayCalls,
                likeClicks: window.__vigilFixture.feedLikeClicks,
                label: document.getElementById('feed-heart').getAttribute('aria-label'),
                heartHasSVG: Boolean(feedback?.querySelector('svg')),
                heartPathMatches: feedbackPath?.getAttribute('d') === sourcePath?.getAttribute('d'),
                heartFill: feedbackPath ? getComputedStyle(feedbackPath).fill : ''
              };
            })()
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["paused"] as? Bool, false)
        XCTAssertEqual(state?["pauseCalls"] as? Int, 0)
        XCTAssertEqual(state?["playCalls"] as? Int, 0)
        XCTAssertEqual(state?["likeClicks"] as? Int, 1)
        XCTAssertEqual(state?["label"] as? String, "Unlike")
        XCTAssertEqual(state?["heartHasSVG"] as? Bool, true)
        XCTAssertEqual(state?["heartPathMatches"] as? Bool, true)
        XCTAssertEqual(state?["heartFill"] as? String, "rgb(255, 48, 64)")

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const fixture = window.__vigilFixture;
              fixture.show('post', '/p/fixture/');
              const media = document.getElementById('post-media');
              fixture.tap(media, 195, 280, 1);
              setTimeout(() => fixture.tap(media, 195, 280, 2), 90);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            "window.__vigilFixture.postLikeClicks === 1",
            in: webView
        )
        state = try await webView.evaluateJavaScript(
            """
            ({
              postLikeClicks: window.__vigilFixture.postLikeClicks,
              label: document.getElementById('post-heart').getAttribute('aria-label'),
              heartHasSVG: Boolean(document.querySelector('[data-vigil-instagram-like-heart="true"] svg'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["postLikeClicks"] as? Int, 1)
        XCTAssertEqual(state?["label"] as? String, "Unlike")
        XCTAssertEqual(state?["heartHasSVG"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              const fixture = window.__vigilFixture;
              fixture.show('story', '/stories/fixture/1/');
              const media = document.getElementById('story-media');
              fixture.tap(media, 195, 280, 1);
              fixture.tap(media, 195, 280, 2);
            })()
            """
        )
        try await Task.sleep(nanoseconds: 120_000_000)
        state = try await webView.evaluateJavaScript(
            """
            ({
              nativePointerUps: window.__vigilFixture.storyNativePointerUps,
              storyLikeClicks: window.__vigilFixture.storyLikeClicks,
              vigilHeart: Boolean(document.querySelector('[data-vigil-instagram-like-heart="true"]'))
            })
            """
        ) as? [String: Any]
        XCTAssertEqual(state?["nativePointerUps"] as? Int, 2)
        XCTAssertEqual(state?["storyLikeClicks"] as? Int, 0)
        XCTAssertEqual(state?["vigilHeart"] as? Bool, false)
    }

    @MainActor
    func testInstagramCachedNativePushStateCannotBypassBlockedRoutePolicy() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: .instagram),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )

        let loaded = expectation(description: "Instagram cached-history fixture loaded")
        let initialDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = initialDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <script>
                  window.__vigilFixtureNativePushState = history.pushState;
                  window.__vigilFixtureMessages = [];
                  window.__vigilBridge = (payload) => window.__vigilFixtureMessages.push(payload);
                </script>
              </head>
              <body><main id="fixture">Instagram route fixture</main></body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/accounts/login/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "window.__vigilInstagramInstalled === true",
            in: webView
        )

        let redirected = expectation(description: "Blocked Instagram route redirected home")
        let routeDelegate = RoutePolicyNavigationDelegate(
            expectedHost: "www.instagram.com",
            expectedPath: "/",
            expectation: redirected
        )
        webView.navigationDelegate = routeDelegate
        _ = try? await webView.evaluateJavaScript(
            """
            (() => {
              document.documentElement.setAttribute('data-vigil-feature-reels', 'blocked');
              document.dispatchEvent(new CustomEvent('__vigilPolicyFeaturesChanged', {
                detail: { key: 'reels', blocked: true, tier: 'soft' }
              }));
              window.__vigilFixtureUsedCachedHistory =
                window.__vigilFixtureNativePushState !== history.pushState;
              window.__vigilFixtureNativePushState.call(history, {}, '', '/reels/audit/');
              const mutation = document.createElement('article');
              mutation.textContent = 'router mutation';
              document.getElementById('fixture').appendChild(mutation);
              return true;
            })()
            """
        )
        await fulfillment(of: [redirected], timeout: 3)

        XCTAssertEqual(routeDelegate.matchedURL?.host, "www.instagram.com")
        XCTAssertEqual(routeDelegate.matchedURL?.path, "/")
        let rawState = try await webView.evaluateJavaScript(
            """
            ({
              usedCachedHistory: window.__vigilFixtureUsedCachedHistory === true,
              policy: document.documentElement.dataset.vigilRoutePolicyBlocked || '',
              hidden: getComputedStyle(document.body).visibility === 'hidden',
              reported: window.__vigilFixtureMessages.some((message) =>
                String(message.detail || '').includes('reels surface is intentionally unavailable')
              )
            })
            """
        )
        let state = try XCTUnwrap(rawState as? [String: Any])
        XCTAssertEqual(state["usedCachedHistory"] as? Bool, true)
        XCTAssertEqual(state["policy"] as? String, "reels")
        XCTAssertEqual(state["hidden"] as? Bool, true)
        XCTAssertEqual(state["reported"] as? Bool, true)

        _ = try await webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureNativePushState.call(history, {}, '', '/accounts/login/');
              const mutation = document.createElement('div');
              mutation.textContent = 'safe route mutation';
              document.getElementById('fixture').appendChild(mutation);
            })()
            """
        )
        try await waitForJavaScriptCondition(
            """
            !document.documentElement.hasAttribute('data-vigil-route-policy-blocked')
              && getComputedStyle(document.body).visibility !== 'hidden'
            """,
            in: webView
        )
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

    func testInstagramSuspensionClearsPageNowPlayingMetadata() {
        let adapter = DOMAdapters.installedFrameSafetyScript(
            for: .instagram,
            audioEnabled: true,
            contentSafetyEnabled: false
        )
        XCTAssertTrue(adapter.contains("navigator.mediaSession.metadata = null"))
        XCTAssertTrue(adapter.contains("navigator.mediaSession.setPositionState?.();"))
    }

    func testSafetyBootstrapKeepsVectorInterfaceChromeUsable() {
        let bootstrap = DOMAdapters.contentFilterBootstrap
        let adapter = DOMAdapters.script(for: .instagram, audioEnabled: true)
        XCTAssertFalse(bootstrap.contains("canvas, svg, object"))
        XCTAssertTrue(bootstrap.contains("content: normal !important"))
        XCTAssertTrue(bootstrap.contains("data-vigil-content-inspecting"))
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
        XCTAssertTrue(youtube.configuration.websiteDataStore.isPersistent)
        XCTAssertEqual(
            youtube.configuration.applicationNameForUserAgent,
            YouTubeWebCompatibility.unsupportedSafariApplicationNameSuffix
        )
        XCTAssertNotNil(youtube.scrollView.refreshControl)
        XCTAssertEqual(youtube.scrollView.keyboardDismissMode, .interactive)
        let scripts = youtube.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.count, 5)
        XCTAssertFalse(scripts[0].isForMainFrameOnly)
        XCTAssertFalse(scripts[1].isForMainFrameOnly)
        XCTAssertFalse(scripts[2].isForMainFrameOnly)
        XCTAssertTrue(scripts[3].isForMainFrameOnly)
        XCTAssertTrue(scripts[0].source.contains("vigil-content-safety-style"))
        XCTAssertTrue(scripts[0].source.contains("__vigilEarlyMediaGate"))
        XCTAssertTrue(scripts[0].source.contains("vigilGuardedPlay"))
        XCTAssertTrue(scripts[1].source.contains("mediaCandidate"))
        XCTAssertTrue(scripts[2].source.contains("__vigilFrameRoutePolicyInstalled"))
        XCTAssertTrue(scripts[2].source.contains("window === window.top"))
        XCTAssertTrue(scripts[2].source.contains("mode: 'conceal'"))
        XCTAssertTrue(scripts[2].source.contains("/shorts"))
        XCTAssertTrue(scripts[2].source.contains("/feed/recommended"))
        XCTAssertFalse(scripts[2].source.contains("__vigilPolicyProbeInstalled"))
        XCTAssertTrue(scripts[3].source.contains("__vigilPolicyProbeInstalled"))
        XCTAssertTrue(scripts[4].isForMainFrameOnly)
        XCTAssertEqual(scripts[4].injectionTime, .atDocumentStart)
        XCTAssertTrue(scripts[4].source.contains("__vigilYouTubeParityInstalled"))
        XCTAssertTrue(scripts[4].source.contains("enterFullscreen"))
        XCTAssertFalse(scripts[4].source.contains("youtubeMinimize"))
        XCTAssertFalse(scripts[4].source.localizedCaseInsensitiveContains("miniplayer"))
        XCTAssertTrue(scripts[4].source.contains("recoverFromShorts"))
        let authHostGate = try? XCTUnwrap(scripts[4].source.range(of: "allowedHosts.has"))
        let firstDOMAccess = try? XCTUnwrap(scripts[4].source.range(of: "document.createElement"))
        XCTAssertNotNil(authHostGate)
        XCTAssertNotNil(firstDOMAccess)
        if let authHostGate, let firstDOMAccess {
            XCTAssertLessThan(authHostGate.lowerBound, firstDOMAccess.lowerBound)
        }
    }

    func testContentBlockerReloadCacheInvalidatesForEveryAppBuild() {
        let firstBuild = YouTubeContentBlockerReloadPolicy.buildFingerprint(
            bundleIdentifier: "tech.caseline.vigil.instagram",
            version: "0.3.27",
            build: "30"
        )
        let nextBuild = YouTubeContentBlockerReloadPolicy.buildFingerprint(
            bundleIdentifier: "tech.caseline.vigil.instagram",
            version: "0.3.27",
            build: "31"
        )

        XCTAssertEqual(firstBuild, "tech.caseline.vigil.instagram:0.3.27:30")
        XCTAssertNotEqual(firstBuild, nextBuild)
        XCTAssertNotEqual(
            YouTubeContentBlockerReloadPolicy.reloadKey(for: "filter.one"),
            YouTubeContentBlockerReloadPolicy.reloadKey(for: "filter.two")
        )
    }

    @MainActor
    func testInstagramShellMatchesYouTubeRestrictionLevelWithoutMediaClassifier() {
        let store = SocialWebViewStore(
            defaults: UserDefaults(suiteName: #function)!,
            fixedService: .instagram,
            loadInitialPages: false
        )
        let scripts = store.webView(for: .instagram)
            .configuration.userContentController.userScripts

        XCTAssertEqual(scripts.count, 4)
        XCTAssertNil(store.webView(for: .instagram).configuration.applicationNameForUserAgent)
        XCTAssertFalse(scripts[0].source.contains("vigil-content-safety-style"))
        XCTAssertFalse(scripts[0].source.contains("__vigilEarlyMediaGate"))
        XCTAssertTrue(scripts[1].source.contains("__vigilInstagramCompatibilityInstalled"))
        XCTAssertFalse(scripts[1].source.contains("mediaCandidate"))
        XCTAssertFalse(scripts[1].source.contains("pageText"))
        XCTAssertTrue(scripts[2].source.contains("__vigilFrameRoutePolicyInstalled"))
        XCTAssertTrue(scripts[2].source.contains("/reels"))
        XCTAssertTrue(scripts[3].source.contains("__vigilPolicyProbeInstalled"))
        XCTAssertTrue(scripts[3].source.contains("data-vigil-feature-reels"))
    }

    func testDocumentFinishUsesACompactAdapterInstallationProbe() {
        let instagram = DOMAdapters.mainFrameInstallationProbe(for: .instagram)
        let youtube = DOMAdapters.mainFrameInstallationProbe(for: .youtube)

        XCTAssertLessThan(instagram.utf8.count, 256)
        XCTAssertLessThan(youtube.utf8.count, 256)
        XCTAssertTrue(instagram.contains("__vigilInstagramCompatibilityInstalled"))
        XCTAssertTrue(instagram.contains("__vigilPolicyProbeInstalled"))
        XCTAssertTrue(instagram.contains("__vigilInstagramInstalled"))
        XCTAssertTrue(youtube.contains("__vigilCommonInstalled"))
        XCTAssertTrue(youtube.contains("__vigilYouTubeInstalled"))
    }

    func testPolicyProbePrioritizesPrimaryNavigationAndBoundsBackgroundTraffic() {
        let script = DOMAdapters.controlsScript(for: .instagram)

        XCTAssertTrue(script.contains(
            "document.documentElement.setAttribute(`data-vigil-feature-${key}`, 'pending')"
        ))
        XCTAssertTrue(script.contains("const priorityFeature = 'reels'"))
        XCTAssertTrue(script.contains("probe([priorityFeature]);"))
        XCTAssertTrue(script.contains("addEventListener('load', scheduleInitialProbe, { once: true })"))
        XCTAssertTrue(script.contains("requestIdleCallback(runInitialProbe, { timeout: 1200 })"))
        XCTAssertTrue(script.contains("setTimeout(scheduleInitialProbe, 5000)"))
        XCTAssertTrue(script.contains("probe([featureKeys[periodicProbeIndex]])"))
        XCTAssertFalse(script.contains("setInterval(probe, 15000)"))
        XCTAssertTrue(script.contains(
            "[data-vigil-feature-reels=\"blocked\"], [data-vigil-feature-reels=\"pending\"]"
        ))
    }

    @MainActor
    func testNativeShellUsesFailClosedRefreshAndRouteGatedInteractiveBack() {
        let store = SocialWebViewStore(
            defaults: UserDefaults(suiteName: #function)!,
            fixedService: .instagram,
            loadInitialPages: false
        )
        let webView = store.webView(for: .instagram)
        let refreshControl = webView.scrollView.refreshControl

        XCTAssertFalse(webView.allowsLinkPreview)
        XCTAssertFalse(webView.allowsBackForwardNavigationGestures)
        XCTAssertEqual(refreshControl?.isEnabled, false)
        XCTAssertFalse(webView.scrollView.alwaysBounceVertical)
        XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)

        store.setSurface(
            SocialSurfaceState(route: "feed", refreshEligible: true, blocksRefresh: false),
            for: .instagram
        )
        XCTAssertEqual(refreshControl?.isEnabled, true)
        XCTAssertTrue(webView.scrollView.alwaysBounceVertical)
        XCTAssertFalse(webView.allowsBackForwardNavigationGestures)

        store.setSurface(
            SocialSurfaceState(route: "story", refreshEligible: false, blocksRefresh: true),
            for: .instagram
        )
        XCTAssertEqual(refreshControl?.isEnabled, false)
        XCTAssertFalse(webView.scrollView.alwaysBounceVertical)
        XCTAssertFalse(webView.allowsBackForwardNavigationGestures)
        XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)

        store.setSurface(
            SocialSurfaceState(
                route: "reels",
                refreshEligible: false,
                blocksRefresh: true,
                fullBleedTop: true
            ),
            for: .instagram
        )
        XCTAssertFalse(webView.allowsBackForwardNavigationGestures)
        XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)
        XCTAssertTrue(store.usesFullBleedTop(for: .instagram))

        store.setSurface(
            SocialSurfaceState(route: "post", refreshEligible: false, blocksRefresh: true),
            for: .instagram
        )
        XCTAssertTrue(webView.allowsBackForwardNavigationGestures)
        XCTAssertEqual(webView.scrollView.contentInsetAdjustmentBehavior, .never)
        XCTAssertFalse(store.usesFullBleedTop(for: .instagram))

        store.setSurface(
            SocialSurfaceState(route: "directThread", refreshEligible: false, blocksRefresh: true),
            for: .instagram
        )
        XCTAssertTrue(webView.allowsBackForwardNavigationGestures)

        store.setSurface(
            SocialSurfaceState(route: "modal", refreshEligible: false, blocksRefresh: true),
            for: .instagram
        )
        XCTAssertFalse(webView.allowsBackForwardNavigationGestures)
    }

    @MainActor
    func testInstagramStableAdapterLeavesSiteLayoutAndAppearanceAlone() {
        let script = DOMAdapters.script(
            for: .instagram,
            audioEnabled: true,
            contentSafetyEnabled: false
        )

        XCTAssertTrue(script.contains("window.__vigilInstagramInstalled = true"))
        XCTAssertTrue(script.contains("a[href=\"/reels/\"]"))
        XCTAssertTrue(script.contains(":has(> :is(a[href=\"/reels/\"]"))
        XCTAssertTrue(script.contains("'suggested reels'"))
        XCTAssertTrue(script.contains("path.startsWith('/reel/')"))
        XCTAssertTrue(script.contains("const isSingularReelRoute"))
        XCTAssertTrue(script.contains("let sharedReelPath = ''"))
        XCTAssertTrue(script.contains("location.replace('/direct/inbox/')"))
        XCTAssertTrue(script.contains("data-vigil-instagram-account-search=\"true\""))
        XCTAssertTrue(script.contains("data-vigil-instagram-search-discovery=\"true\""))
        XCTAssertTrue(script.contains("const isAccountSearchRoute"))
        XCTAssertTrue(script.contains("const markAccountOnlySearch"))
        XCTAssertFalse(script.contains("return { feature: 'explore', mode: 'redirect'"))
        XCTAssertTrue(script.contains("{ childList: true, subtree: true }"))
        XCTAssertTrue(script.contains("fullBleedTop: false"))
        XCTAssertTrue(script.contains("object-fit: contain !important"))
        XCTAssertTrue(script.contains("object-position: center center !important"))
        XCTAssertTrue(script.contains("max-width: 100% !important"))
        XCTAssertFalse(script.contains("max-width: 100vw !important"))
        XCTAssertFalse(script.contains("\n            width: 100% !important;"))
        XCTAssertFalse(script.contains("\n            height: 100% !important;"))
        XCTAssertFalse(script.contains("data-vigil-instagram-bottom-chrome"))
        XCTAssertFalse(script.contains("data-vigil-instagram-direct-header"))
        XCTAssertFalse(script.contains("data-vigil-instagram-direct-back"))
        XCTAssertFalse(script.contains("data-vigil-instagram-fit-ready"))
        XCTAssertFalse(script.contains("viewport-fit=cover"))
        XCTAssertFalse(script.contains("article a[href*=\"/reel/\"]"))
        XCTAssertFalse(script.contains("touchmove"))
        XCTAssertFalse(script.contains("normalizeReelSurface"))
        XCTAssertFalse(script.contains("normalizeBottomNavigation"))
        XCTAssertFalse(script.contains("normalizeCommentSheets"))
        XCTAssertFalse(script.contains("vigilInstagramRepostProxy"))
        XCTAssertFalse(script.contains("attributeFilter: ['class', 'style']"))
        XCTAssertTrue(script.contains("attributeFilter: ['muted', 'src']"))
        XCTAssertTrue(script.contains("const fetchMutualFriendship = async (username)"))
        XCTAssertTrue(script.contains("const mutual = viewerFollows && followsViewer"))
        XCTAssertTrue(script.contains("Nothing from your friends yet."))
        XCTAssertFalse(script.contains("homeDigestLimit"))
        XCTAssertTrue(script.contains("document.body?.append(state)"))
        XCTAssertTrue(script.contains("renderFriendsState('loading')"))
        XCTAssertTrue(script.contains("renderFriendsState('empty')"))
        XCTAssertTrue(script.contains("friendshipCacheTTL = 6 * 60 * 60 * 1000"))
        XCTAssertTrue(script.contains("a[href^=\"/stories/\"]:not("))
        XCTAssertTrue(script.contains("const classifyHomeStory"))
        XCTAssertTrue(script.contains("fetchMutualFriendship(username)"))
        XCTAssertTrue(script.contains("isOwnStoryLink(link)"))
        XCTAssertTrue(script.contains("querySelectorAll('a[href^=\"/stories/\"]')"))
        XCTAssertTrue(script.contains("link.closest('li, [role=\"listitem\"]')"))
        XCTAssertFalse(script.contains("background: Canvas"))
        XCTAssertFalse(script.contains("querySelector('main') || document.body)?.prepend(state)"))
        XCTAssertTrue(script.contains("main [role=\"progressbar\"]"))
        XCTAssertTrue(script.contains("state.dataset.vigilState === 'empty' && mode === 'loading'"))
        XCTAssertTrue(script.contains("window.__vigilResetFriendsFeedForRefresh"))
        XCTAssertTrue(script.contains("renderFriendsState('loading', true)"))
        XCTAssertTrue(script.contains("prefers-color-scheme: dark"))
        XCTAssertTrue(script.contains("color: #f5f5f5 !important"))
        XCTAssertTrue(script.contains("data-vigil-instagram-route-transition=\"true\""))
        XCTAssertTrue(script.contains("const prepareRouteTransition"))
        XCTAssertTrue(script.contains("prepareRouteTransition(link.href)"))
    }

    @MainActor
    func testInstagramSearchStaysAvailableButOnlyShowsAccounts() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .revealUnclassified,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.script(
                for: .instagram,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "Instagram account-only search fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><body>
              <main>
                <input aria-label="Search" value="fixture">
                <a id="account" href="/fixture-account/">Fixture Account</a>
                <a id="post" href="/p/discovery-post/">Discovery post</a>
                <a id="reel" href="/reel/discovery-reel/">Discovery Reel</a>
                <a id="tag" href="/explore/tags/discovery/">Discovery tag</a>
                <button id="places" role="tab">Places</button>
              </main>
              <nav>
                <a id="search" href="/explore/">Search</a>
                <a id="reels" href="/reels/">Reels</a>
              </nav>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/explore/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await Task.sleep(nanoseconds: 150_000_000)

        let levelOne = try await webView.evaluateJavaScript(
            #"""
            (() => {
              document.documentElement.setAttribute('data-vigil-feature-reels', 'available');
              document.documentElement.setAttribute('data-vigil-feature-explore', 'available');
              document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'));
              const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
              return {
                account: shown('account'), post: shown('post'), reel: shown('reel'),
                tag: shown('tag'), places: shown('places'), search: shown('search'),
                reels: shown('reels')
              };
            })()
            """#
        ) as? [String: Bool]
        XCTAssertEqual(levelOne?["account"], true)
        XCTAssertEqual(levelOne?["post"], false)
        XCTAssertEqual(levelOne?["reel"], false)
        XCTAssertEqual(levelOne?["tag"], false)
        XCTAssertEqual(levelOne?["places"], false)
        XCTAssertEqual(levelOne?["search"], true)
        XCTAssertEqual(levelOne?["reels"], false, "Level 1 permanently removes the Reels destination")

        let levelTwo = try await webView.evaluateJavaScript(
            #"""
            (() => {
              document.documentElement.setAttribute('data-vigil-feature-reels', 'blocked');
              document.documentElement.setAttribute('data-vigil-feature-explore', 'blocked');
              document.dispatchEvent(new Event('__vigilPolicyFeaturesChanged'));
              const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
              return { account: shown('account'), search: shown('search'), reels: shown('reels') };
            })()
            """#
        ) as? [String: Bool]
        XCTAssertEqual(levelTwo?["account"], true)
        XCTAssertEqual(levelTwo?["search"], true, "account search remains available to the companion")
        XCTAssertEqual(levelTwo?["reels"], false, "the Reels destination stays permanently removed")
        webView.navigationDelegate = nil
    }

    @MainActor
    func testInstagramSafeAreaAdapterPreservesReelStackAndDirectControls() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .revealUnclassified,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.script(
                for: .instagram,
                audioEnabled: true,
                contentSafetyEnabled: false
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "Instagram safe-area fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html><head>
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <style>
                html, body { margin: 0; width: 100%; height: 100%; }
                main { width: 100%; }
                article { width: 100%; height: 760px; overflow: hidden; }
                video { display: block; width: 430px; height: 760px; opacity: 1; }
                header { height: 52px; }
                #back { display: block; width: 44px; height: 44px; }
                nav { height: 52px; display: flex; }
                nav a { flex: 1; }
              </style>
            </head><body>
              <header><button id="back" aria-label="Back">Back</button></header>
              <main>
                <article><video id="first"></video></article>
                <article><video id="second"></video></article>
              </main>
              <nav>
                <a href="/">Home</a>
                <a href="/reels/">Reels</a>
                <a href="/direct/inbox/">Direct</a>
                <a href="/explore/">Search</a>
                <a href="/fixture-profile/">Profile</a>
              </nav>
            </body></html>
            """#,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await Task.sleep(nanoseconds: 120_000_000)

        let state = try await webView.evaluateJavaScript(
            #"""
            (() => {
              const first = document.getElementById('first');
              const second = document.getElementById('second');
              const back = document.getElementById('back');
              const navigation = document.querySelector('nav');
              const firstStyle = getComputedStyle(first);
              const firstRect = first.getBoundingClientRect();
              const secondRect = second.getBoundingClientRect();
              const backRect = back.getBoundingClientRect();
              return {
                viewport: document.querySelector('meta[name="viewport"]')?.content || '',
                navigationMarked: [...navigation.attributes]
                  .some((attribute) => attribute.name.startsWith('data-vigil-instagram')),
                backMarked: [...back.attributes]
                  .some((attribute) => attribute.name.startsWith('data-vigil-instagram')),
                backTop: backRect.top,
                videoWidth: firstStyle.width,
                videoHeight: firstStyle.height,
                videoMaxWidth: firstStyle.maxWidth,
                videoFit: firstStyle.objectFit,
                videoOpacity: firstStyle.opacity,
                reelSpacing: secondRect.top - firstRect.top
              };
            })()
            """#
        ) as? [String: Any]
        XCTAssertFalse((state?["viewport"] as? String)?.contains("viewport-fit=cover") == true)
        XCTAssertEqual(state?["navigationMarked"] as? Bool, false)
        XCTAssertEqual(state?["backMarked"] as? Bool, false)
        XCTAssertEqual(state?["backTop"] as? Double, 0)
        XCTAssertEqual(state?["videoWidth"] as? String, "390px")
        XCTAssertEqual(state?["videoHeight"] as? String, "760px")
        XCTAssertEqual(state?["videoMaxWidth"] as? String, "100%")
        XCTAssertEqual(state?["videoFit"] as? String, "contain")
        XCTAssertEqual(state?["videoOpacity"] as? String, "1")
        XCTAssertEqual(state?["reelSpacing"] as? Double, 760)
        webView.navigationDelegate = nil
    }

    @MainActor
    func testInstagramNavigationKeepsAStableSafeAreaBeforeDocumentMeasurement() {
        let reel = SocialWebViewStore.provisionalInstagramSurface(
            for: URL(string: "https://www.instagram.com/reels/example/")!
        )
        XCTAssertEqual(reel.route, "reels")
        XCTAssertFalse(reel.fullBleedTop)
        XCTAssertTrue(reel.blocksRefresh)
        XCTAssertFalse(reel.refreshEligible)

        let story = SocialWebViewStore.provisionalInstagramSurface(
            for: URL(string: "https://www.instagram.com/stories/example/123/")!
        )
        XCTAssertEqual(story.route, "story")
        XCTAssertFalse(story.fullBleedTop)

        let feed = SocialWebViewStore.provisionalInstagramSurface(
            for: URL(string: "https://www.instagram.com/")!
        )
        XCTAssertEqual(feed.route, "unknown")
        XCTAssertFalse(feed.fullBleedTop)
        XCTAssertTrue(feed.blocksRefresh)
    }

    @MainActor
    func testActivePullToRefreshKeepsBounceAndSpinnerUntilNavigationFinishes() {
        let store = SocialWebViewStore(
            defaults: UserDefaults(suiteName: #function)!,
            fixedService: .instagram,
            loadInitialPages: false
        )
        let webView = store.webView(for: .instagram)
        let refreshControl = webView.scrollView.refreshControl
        store.setSurface(
            SocialSurfaceState(route: "feed", refreshEligible: true, blocksRefresh: false),
            for: .instagram
        )

        refreshControl?.beginRefreshing()
        refreshControl?.sendActions(for: .valueChanged)

        XCTAssertEqual(refreshControl?.isRefreshing, true)
        XCTAssertEqual(refreshControl?.isEnabled, false)
        XCTAssertTrue(webView.scrollView.alwaysBounceVertical)
        store.setSurface(.unknown, for: .instagram)
        XCTAssertEqual(refreshControl?.isRefreshing, true)
        XCTAssertTrue(webView.scrollView.alwaysBounceVertical)

        store.webView(webView, didFinish: nil)
        XCTAssertEqual(refreshControl?.isRefreshing, false)
        store.setSurface(.unknown, for: .instagram)
        XCTAssertFalse(webView.scrollView.alwaysBounceVertical)
    }

    @MainActor
    func testPopupValidationPreservesTheOriginalRequestAndRecoveryFailsClosed() throws {
        var request = URLRequest(
            url: try XCTUnwrap(URL(string: "https://www.instagram.com/direct/inbox/"))
        )
        request.httpMethod = "POST"
        request.httpBody = Data("payload".utf8)
        request.setValue("audit", forHTTPHeaderField: "X-Vigil-Test")

        let validated = try XCTUnwrap(
            SocialWebViewStore.validatedPopupRequest(request, for: .instagram)
        )
        XCTAssertEqual(validated.httpMethod, "POST")
        XCTAssertEqual(validated.httpBody, Data("payload".utf8))
        XCTAssertEqual(validated.value(forHTTPHeaderField: "X-Vigil-Test"), "audit")

        let watchURL = try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=audit"))
        XCTAssertEqual(
            SocialWebViewStore.safeRecoveryURL(watchURL, for: .youtube),
            watchURL
        )
        XCTAssertNil(SocialWebViewStore.safeRecoveryURL(
            try XCTUnwrap(URL(string: "https://m.youtube.com/shorts/audit")),
            for: .youtube
        ))
        for authenticationURL in [
            "https://accounts.google.com/ServiceLogin",
            "https://consent.youtube.com/m",
            "https://accounts.youtube.com/accounts/SetSID?ssdc=opaque",
            "https://accounts.youtube.com/accounts/CheckConnection",
            "https://accounts.youtube.com/RotateCookiesPage/"
        ] {
            XCTAssertEqual(
                SocialWebViewStore.safeRecoveryURL(
                    try XCTUnwrap(URL(string: authenticationURL)),
                    for: .youtube
                ),
                SocialService.youtube.homeURL,
                "Authentication helpers must restart from YouTube home after a content-process crash"
            )
        }
        XCTAssertNil(SocialWebViewStore.validatedPopupRequest(
            URLRequest(url: try XCTUnwrap(URL(string: "https://example.com/"))),
            for: .instagram
        ))
        let setSID = URLRequest(url: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID?ssdc=opaque")
        ))
        XCTAssertEqual(
            SocialWebViewStore.validatedPopupRequest(setSID, for: .youtube)?.url,
            setSID.url
        )
        XCTAssertNil(SocialWebViewStore.validatedPopupRequest(
            URLRequest(url: try XCTUnwrap(
                URL(string: "https://accounts.youtube.com/accounts/CheckConnection")
            )),
            for: .youtube
        ))
    }

    func testAllowedAuthenticationPagesDoNotRemainInLoadingHealth() throws {
        let facebook = try XCTUnwrap(URL(string: "https://www.facebook.com/dialog/oauth?client_id=1"))
        let google = try XCTUnwrap(URL(string: "https://accounts.google.com/ServiceLogin"))
        guard case .advisory = SocialService.instagram.auxiliaryPageHealth(for: facebook) else {
            return XCTFail("Facebook authorization must remain usable outside the loading overlay")
        }
        guard case .advisory = SocialService.youtube.auxiliaryPageHealth(for: google) else {
            return XCTFail("Google authorization must remain usable outside the loading overlay")
        }
        guard case .advisory = SocialService.youtube.auxiliaryPageHealth(for: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID")
        )) else {
            return XCTFail("YouTube's exact session handoff must remain usable outside the loading overlay")
        }
        XCTAssertNil(SocialService.youtube.auxiliaryPageHealth(
            for: try XCTUnwrap(URL(string: "https://m.youtube.com/"))
        ))
    }

    @MainActor
    func testMediaBackpressureResolvesEveryCandidateBeyondQueueCapacity() async throws {
        let store = SocialWebViewStore(
            defaults: UserDefaults(suiteName: #function)!,
            fixedService: .instagram,
            loadInitialPages: false,
            mediaClassifier: DelayedMediaClassifier(),
            unclassifiedMediaPolicy: .conceal
        )
        let webView = store.webView(for: .instagram)
        let loaded = expectation(description: "backpressure fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            "<html><body>backpressure fixture</body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        webView.navigationDelegate = store

        var documentID: String?
        for _ in 0..<20 where documentID == nil {
            let documentIDs = Mirror(reflecting: store).children.first {
                $0.label == "mainDocumentIDs"
            }?.value as? [SocialService: String]
            documentID = documentIDs?[.instagram]
            if documentID == nil {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        let registeredDocumentID = try XCTUnwrap(documentID)

        _ = try await webView.callAsyncJavaScript(
            #"""
            window.__vigilBackpressureResolutions = [];
            window.__vigilResolveMedia = (documentID, id, token, verdict) => {
              window.__vigilBackpressureResolutions.push({ documentID, id, token, verdict });
            };
            for (let index = 0; index < 30; index += 1) {
              window.webkit.messageHandlers.vigil.postMessage({
                type: 'mediaCandidate',
                documentID,
                id: `media-${index}`,
                token: `token-${index}`,
                dataURL: 'data:image/png;base64,AQID'
              });
            }
            return true;
            """#,
            arguments: ["documentID": registeredDocumentID],
            in: nil,
            contentWorld: .page
        )
        try await Task.sleep(nanoseconds: 1_350_000_000)

        let resolvedValue = try await webView.evaluateJavaScript(
            "window.__vigilBackpressureResolutions.map((item) => String(item.id))"
        )
        let resolvedIDs = try XCTUnwrap(resolvedValue as? [String])
        XCTAssertEqual(Set(resolvedIDs), Set((16..<30).map { "media-\($0)" }))
    }

    @MainActor
    func testHangingMediaClassifierTimesOutCurrentTokensAndQueueKeepsProgressing() async throws {
        let store = SocialWebViewStore(
            defaults: UserDefaults(suiteName: #function)!,
            fixedService: .instagram,
            loadInitialPages: false,
            mediaClassifier: HangingFirstFourMediaClassifier(),
            unclassifiedMediaPolicy: .conceal,
            mediaClassificationDeadlineNanoseconds: 100_000_000
        )
        let webView = store.webView(for: .instagram)
        let loaded = expectation(description: "classifier deadline fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            "<html><body>classifier deadline fixture</body></html>",
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        webView.navigationDelegate = store

        var documentID: String?
        for _ in 0..<20 where documentID == nil {
            let documentIDs = Mirror(reflecting: store).children.first {
                $0.label == "mainDocumentIDs"
            }?.value as? [SocialService: String]
            documentID = documentIDs?[.instagram]
            if documentID == nil {
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        let registeredDocumentID = try XCTUnwrap(documentID)

        _ = try await webView.callAsyncJavaScript(
            #"""
            window.__vigilDeadlineResolutions = [];
            window.__vigilResolveMedia = (documentID, id, token, verdict) => {
              window.__vigilDeadlineResolutions.push({ documentID, id, token, verdict });
            };
            for (let index = 0; index < 4; index += 1) {
              window.webkit.messageHandlers.vigil.postMessage({
                type: 'mediaCandidate',
                documentID,
                id: `media-${index}`,
                token: `token-${index}`,
                dataURL: 'data:image/png;base64,AQID'
              });
            }
            window.webkit.messageHandlers.vigil.postMessage({
              type: 'mediaCandidate',
              documentID,
              id: 'media-0',
              token: 'replacement-0',
              dataURL: 'data:image/png;base64,AQID'
            });
            for (let index = 4; index < 6; index += 1) {
              window.webkit.messageHandlers.vigil.postMessage({
                type: 'mediaCandidate',
                documentID,
                id: `media-${index}`,
                token: `token-${index}`,
                dataURL: 'data:image/png;base64,AQID'
              });
            }
            return true;
            """#,
            arguments: ["documentID": registeredDocumentID],
            in: nil,
            contentWorld: .page
        )

        var deadlineRows: [[String: Any]] = []
        for _ in 0..<40 {
            let value = try await webView.evaluateJavaScript(
                "window.__vigilDeadlineResolutions"
            )
            deadlineRows = value as? [[String: Any]] ?? []
            if deadlineRows.count == 6 { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }

        XCTAssertEqual(deadlineRows.count, 6)
        XCTAssertFalse(deadlineRows.contains { $0["token"] as? String == "token-0" })
        XCTAssertEqual(
            deadlineRows.first { $0["token"] as? String == "replacement-0" }?["verdict"] as? String,
            ContentSafetyVerdict.unknown.rawValue
        )
        XCTAssertEqual(
            Set(deadlineRows.compactMap { $0["id"] as? String }),
            Set((0..<6).map { "media-\($0)" })
        )
        XCTAssertEqual(
            Set(deadlineRows.compactMap { $0["token"] as? String }),
            Set(["replacement-0"] + (1..<6).map { "token-\($0)" })
        )
        XCTAssertTrue(deadlineRows.allSatisfy {
            $0["verdict"] as? String == ContentSafetyVerdict.unknown.rawValue
        })

        // The first four native calls finish later despite cancellation. Once
        // retired, the bounded execution pool must admit fresh classification.
        try await Task.sleep(nanoseconds: 550_000_000)
        _ = try await webView.callAsyncJavaScript(
            #"""
            window.webkit.messageHandlers.vigil.postMessage({
              type: 'mediaCandidate',
              documentID,
              id: 'media-recovery',
              token: 'token-recovery',
              dataURL: 'data:image/png;base64,AQID'
            });
            return true;
            """#,
            arguments: ["documentID": registeredDocumentID],
            in: nil,
            contentWorld: .page
        )

        var recoveryRows: [[String: Any]] = []
        for _ in 0..<20 {
            let value = try await webView.evaluateJavaScript(
                "window.__vigilDeadlineResolutions"
            )
            recoveryRows = value as? [[String: Any]] ?? []
            if recoveryRows.contains(where: { $0["token"] as? String == "token-recovery" }) {
                break
            }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        XCTAssertEqual(
            recoveryRows.first { $0["token"] as? String == "token-recovery" }?["verdict"] as? String,
            ContentSafetyVerdict.safe.rawValue
        )
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

    @MainActor
    private func loadHeadAutoplayFixture(audioEnabled: Bool) async throws -> WKWebView {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: audioEnabled
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.frameSafetyScript(audioEnabled: audioEnabled),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let loaded = expectation(description: "head autoplay fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            #"""
            <html>
              <head>
                <script>
                  const sampleRate = 8000;
                  const sampleCount = sampleRate * 5;
                  const bytes = new ArrayBuffer(44 + sampleCount * 2);
                  const view = new DataView(bytes);
                  const writeASCII = (offset, value) => {
                    [...value].forEach((character, index) => {
                      view.setUint8(offset + index, character.charCodeAt(0));
                    });
                  };
                  writeASCII(0, 'RIFF');
                  view.setUint32(4, 36 + sampleCount * 2, true);
                  writeASCII(8, 'WAVE');
                  writeASCII(12, 'fmt ');
                  view.setUint32(16, 16, true);
                  view.setUint16(20, 1, true);
                  view.setUint16(22, 1, true);
                  view.setUint32(24, sampleRate, true);
                  view.setUint32(28, sampleRate * 2, true);
                  view.setUint16(32, 2, true);
                  view.setUint16(34, 16, true);
                  writeASCII(36, 'data');
                  view.setUint32(40, sampleCount * 2, true);

                  const media = document.createElement('audio');
                  media.id = 'early-audio';
                  media.autoplay = true;
                  media.muted = false;
                  media.src = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' }));
                  document.documentElement.appendChild(media);
                  window.__vigilHeadPlayAttempted = true;
                  media.play().catch(() => {});
                  window.__vigilHeadMediaState = {
                    muted: media.muted,
                    paused: media.paused,
                    held: window.__vigilEarlyMediaGate.isHeld(media)
                  };
                </script>
              </head>
              <body></body>
            </html>
            """#,
            baseURL: URL(string: "https://m.youtube.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)
        return webView
    }

    @MainActor
    private func loadHeadWebAudioFixture(
        audioEnabled: Bool,
        associatesVideo: Bool = false
    ) async throws -> (webView: WKWebView, window: UIWindow) {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: audioEnabled
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.frameSafetyScript(audioEnabled: audioEnabled),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false

        let loaded = expectation(description: "head Web Audio fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        let associatesVideoLiteral = associatesVideo ? "true" : "false"
        let html = #"""
        <html>
          <head>
            <script>
              const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
              if (AudioContextConstructor) {
                const context = new AudioContextConstructor();
                window.__vigilHeadAudioContext = context;
                window.__vigilHeadAudioInstancePreserved =
                  context instanceof AudioContextConstructor;
                window.__vigilHeadAudioConstructorPreserved =
                  context.constructor === AudioContextConstructor;
                if (ASSOCIATES_VIDEO) {
                  const video = document.createElement('video');
                  video.id = 'web-audio-video';
                  document.documentElement.appendChild(video);
                  const source = context.createMediaElementSource(video);
                  source.connect(context.destination);
                  window.__vigilHeadAudioSource = source;
                } else {
                  const oscillator = context.createOscillator();
                  oscillator.frequency.value = 1;
                  oscillator.connect(context.destination);
                  oscillator.start();
                  window.__vigilHeadOscillator = oscillator;
                }
                window.__vigilHeadAudioResumeAttempted = true;
                context.resume().catch(() => {});
              }
            </script>
          </head>
          <body></body>
        </html>
        """#.replacingOccurrences(
            of: "ASSOCIATES_VIDEO",
            with: associatesVideoLiteral
        )
        webView.loadHTMLString(
            html,
            baseURL: URL(string: "https://m.youtube.com/")
        )
        await fulfillment(of: [loaded], timeout: 5)
        return (webView, window)
    }

    @MainActor
    private func makeResponsiveImageFixture(
        messageHandler: FixtureScriptMessageHandler
    ) -> (webView: WKWebView, window: UIWindow) {
        let controller = WKUserContentController()
        controller.add(messageHandler, name: "vigil")
        controller.addUserScript(WKUserScript(
            source: "Object.defineProperty(window, 'IntersectionObserver', { value: undefined, configurable: true });",
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
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        webView.loadHTMLString(
            #"""
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
              </head>
              <body>
                <picture>
                  <source id="narrow" media="(max-width: 450px)">
                  <source id="wide" media="(min-width: 451px)">
                  <img id="image" width="64" height="64" style="display:block;width:64px;height:64px">
                </picture>
                <script>
                  const fixtureImageURL = (color) => URL.createObjectURL(new Blob([
                    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">`
                      + `<rect width="64" height="64" fill="${color}"/></svg>`
                  ], { type: 'image/svg+xml' }));
                  window.__vigilFixtureNarrowURL = fixtureImageURL('rgb(16, 32, 48)');
                  window.__vigilFixtureWideURL = fixtureImageURL('rgb(240, 224, 208)');
                  document.getElementById('narrow').srcset = window.__vigilFixtureNarrowURL;
                  document.getElementById('wide').srcset = window.__vigilFixtureWideURL;
                  document.getElementById('image').src = window.__vigilFixtureNarrowURL;
                </script>
              </body>
            </html>
            """#,
            baseURL: URL(string: "https://www.instagram.com/")
        )
        return (webView, window)
    }

    @MainActor
    private func makeVideoFixture(
        messageHandler: FixtureScriptMessageHandler,
        body: String
    ) -> (webView: WKWebView, window: UIWindow) {
        let controller = WKUserContentController()
        controller.add(messageHandler, name: "vigil")
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: .instagram,
                unclassifiedMediaPolicy: .conceal,
                audioEnabled: true
            ),
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
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        webView.loadHTMLString(
            """
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
              </head>
              <body>\(body)</body>
            </html>
            """,
            baseURL: URL(string: "https://m.youtube.com/")
        )
        return (webView, window)
    }

    #if RETIRED_YOUTUBE_MINIPLAYER_TESTS
    @MainActor
    func testYouTubeInteractionExtensionMiniplayerLifecycle() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: #"""
            (() => {
              const fixturePayload = () => ({
                videoDetails: { videoId: 'ordinary-video', title: 'Ordinary video' },
                streamingData: { formats: [{ itag: 18, url: 'https://media.example/video' }] },
                adPlacements: [{ adPlacementRenderer: { config: 'fixture' } }],
                playerAds: [{ playerLegacyDesktopWatchAdsRenderer: { config: 'fixture' } }],
                adSlots: [{ adSlotRenderer: { slotId: 'fixture-slot' } }],
                playerResponse: {
                  videoDetails: { videoId: 'nested-video' },
                  playabilityStatus: { status: 'OK' },
                  adPlacements: [{ nested: true }],
                  playerAds: [{ nested: true }],
                  adSlots: [{ nested: true }]
                },
                metadata: {
                  adPlacements: 'ordinary nested metadata must remain',
                  playerAds: 'ordinary nested metadata must remain'
                }
              });
              window.fetch = input => {
                const url = new URL(input instanceof Request ? input.url : String(input), location.href);
                if (url.searchParams.get('malformed') === 'true') {
                  return Promise.resolve(new Response('not-json', {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                  }));
                }
                const payload = fixturePayload();
                if (url.searchParams.get('schema') === 'drift') {
                  payload.adPlacements = { unexpected: true };
                }
                const response = new Response(JSON.stringify(payload), {
                  status: url.searchParams.get('partial') === 'true' ? 206 : 200,
                  statusText: 'Fixture response',
                  headers: {
                    'content-encoding': 'gzip',
                    'content-length': '999',
                    'content-type': url.searchParams.get('plain') === 'true'
                      ? 'text/plain'
                      : 'application/json',
                    'etag': 'stale-fixture',
                    'x-vigil-fixture': 'true'
                  }
                });
                Object.defineProperty(response, 'url', { value: url.href });
                return Promise.resolve(response);
              };
              window.XMLHttpRequest = class {
                constructor() {
                  this.readyState = 0;
                  this.responseType = '';
                  this.responseURL = '';
                  this.status = 0;
                  this.fixturePayload = fixturePayload();
                }
                open(_method, url) {
                  this.fixtureURL = new URL(String(url), location.href);
                  this.responseURL = this.fixtureURL.href;
                  this.status = 200;
                  this.readyState = 1;
                }
                send() { this.readyState = 4; }
                getResponseHeader(name) {
                  return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
                }
                get response() { return JSON.stringify(this.fixturePayload); }
                get responseText() { return JSON.stringify(this.fixturePayload); }
              };
            })();
            """#,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: try youtubeInteractionExtensionSource(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            window.isHidden = true
            Self.retainedYouTubeMiniplayerFixtures.append((window, webView))
        }

        let loaded = expectation(description: "YouTube interaction fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <meta name="title" content="Fixture ordinary video">
                <style>
                  html, body { margin: 0; min-height: 100%; }
                  [hidden] { display: none !important; }
                  ytm-player, #player-container-id, #player, video { display: block; width: 390px; height: 220px; background: black; }
                  #player { position: relative; }
                  .ytp-fullscreen-grid, .ytp-pause-overlay-container {
                    position: absolute;
                    z-index: 20;
                    inset: 0 0 52px;
                    display: block;
                    background: rgba(20, 20, 20, .92);
                  }
                  .ytp-more-videos-view, .ytp-pause-overlay {
                    display: block;
                    width: 220px;
                    height: 90px;
                  }
                  .ytp-fullscreen-grid-expand-button {
                    position: absolute;
                    z-index: 21;
                    left: 160px;
                    top: 120px;
                    width: 48px;
                    height: 48px;
                  }
                  ytm-fullscreen-related-videos-entry-point-view-model,
                  .fullscreen-recommendations-wrapper,
                  .ytFullscreenVideoRecommendationsHost {
                    position: absolute;
                    z-index: 40;
                    right: 0;
                    bottom: 0;
                    display: block;
                    width: 240px;
                    height: 96px;
                    background: rgba(20, 20, 20, .92);
                  }
                  .fullscreen-more-videos-endpoint {
                    display: block;
                    width: 180px;
                    height: 48px;
                  }
                  player-fullscreen-controls .fullscreen-controls {
                    position: absolute;
                    z-index: 35;
                    left: 0;
                    top: 60px;
                    display: block;
                    width: 80px;
                    height: 104px;
                  }
                  #fixture-fullscreen-ordinary-control {
                    position: absolute;
                    z-index: 45;
                    left: 0;
                    top: 0;
                    width: 44px;
                    height: 44px;
                  }
                  .ytp-fullscreen-button {
                    position: absolute;
                    z-index: 30;
                    right: 4px;
                    bottom: 4px;
                    width: 104px;
                    height: 44px;
                  }
                  .ytp-ad-player-overlay { display: block; width: 240px; height: 72px; }
                  .ytp-ad-skip-button, .ytp-ad-skip-button-modern { display: block; width: 96px; height: 44px; }
                  ytm-single-column-watch-next-results-renderer { display: block; height: 1200px; }
                  #fixture-below-recommendation { display: block; width: 180px; height: 44px; }
                  #fixture-home-content, #fixture-other-content { min-height: 1100px; padding: 72px 20px 100px; }
                  #fixture-home-action { width: 160px; height: 44px; }
                  #fixture-navigation {
                    position: fixed;
                    z-index: 100;
                    left: 0;
                    right: 0;
                    bottom: 0;
                    height: 52px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    background: white;
                  }
                  #fixture-navigation a, #fixture-navigation button {
                    width: 96px;
                    height: 44px;
                    display: grid;
                    place-items: center;
                  }
                </style>
              </head>
              <body>
                <nav id="fixture-navigation" aria-label="YouTube navigation">
                  <button id="fixture-home-control" role="link" aria-label="YouTube Home">Home</button>
                  <a id="fixture-other-control" href="/results?search_query=fixture">Search</a>
                  <a id="fixture-watch-control" href="/watch?v=ordinary-video">Watch</a>
                </nav>
                <main id="fixture-home-content" hidden>
                  <h1>Home</h1>
                  <button id="fixture-home-action" type="button">Open home content</button>
                  <a id="fixture-encoded-shorts" href="/s%68orts/encoded-fixture">Encoded Shorts</a>
                  <a id="fixture-double-encoded-shorts" href="/%2573horts/double-encoded-fixture">Double-encoded Shorts</a>
                </main>
                <main id="fixture-other-content" hidden><h1>Search results</h1></main>
                <ytm-watch id="fixture-watch-content">
                  <ytm-player id="fixture-player">
                    <div id="player-container-id">
                      <div id="player" class="html5-video-player">
                        <video playsinline></video>
                        <input id="seek" type="range" aria-label="Seek">
                        <div id="fixture-more-videos-grid" class="ytp-fullscreen-grid">
                          <button class="ytp-more-videos-button">More videos</button>
                          <div class="ytp-more-videos-view">Suggested videos</div>
                          <button
                            id="fixture-grid-expand"
                            class="ytp-fullscreen-grid-expand-button"
                          >Expand</button>
                        </div>
                        <div id="fixture-pause-overlay" class="ytp-pause-overlay-container">
                          <div class="ytp-pause-overlay">More videos while paused</div>
                        </div>
                        <div class="fullscreen-watch-next-entrypoint-wrapper">
                          <ytm-fullscreen-related-videos-entry-point-view-model
                            id="fixture-mobile-more-videos"
                            class="ytmFullscreenRelatedVideosEntryPointViewModelHost"
                          >
                            <button class="ytmFullscreenRelatedVideosEntryPointViewModelButton fullscreen-more-videos-endpoint">More videos</button>
                          </ytm-fullscreen-related-videos-entry-point-view-model>
                        </div>
                        <button id="fixture-fullscreen" class="ytp-fullscreen-button" aria-label="Full screen">Full screen</button>
                      </div>
                    </div>
                  </ytm-player>
                  <div id="fixture-portaled-more-videos" class="fullscreen-recommendations-wrapper">
                    Portaled fullscreen recommendations
                  </div>
                  <player-fullscreen-controls>
                    <div class="fullscreen-controls expanded">
                      <button id="fixture-fullscreen-ordinary-control">Settings</button>
                      <div id="fixture-fullscreen-recommendations" class="ytFullscreenVideoRecommendationsHost">
                        <div class="ytFullscreenVideoRecommendationsRecommendation fullscreen-recommendation">
                          Expanded fullscreen recommendation
                        </div>
                      </div>
                    </div>
                  </player-fullscreen-controls>
                  <h1>Fixture ordinary video</h1>
                  <ytm-single-column-watch-next-results-renderer id="fixture-watch-next">
                    <ytm-compact-video-renderer>
                      <a id="fixture-below-recommendation" href="/watch?v=recommended-video">
                        Recommended video
                      </a>
                    </ytm-compact-video-renderer>
                  </ytm-single-column-watch-next-results-renderer>
                </ytm-watch>
                <script>
                  window.__vigilFixtureFullscreenClicks = 0;
                  window.__vigilFixtureGridExpandClicks = 0;
                  window.__vigilFixtureFullscreenOrdinaryControlClicks = 0;
                  window.__vigilFixtureRecommendationClicks = 0;
                  window.__vigilFixtureHomeControlClicks = 0;
                  window.__vigilFixtureHomeContentClicks = 0;
                  window.__vigilFixturePauseCalls = 0;
                  window.__vigilFixturePlayCalls = 0;
                  window.__vigilFixtureAdSkipClicks = 0;
                  window.__vigilFixturePlayerTeardowns = 0;
                  window.__vigilFixturePopRoutes = [];
                  window.__vigilFixtureGoCalls = [];
                  window.__vigilFixtureShellClicks = 0;
                  window.__vigilFixtureFallbackClicks = 0;
                  window.__vigilFixtureFallbackStateInput = '';
                  window.__vigilFixtureRestoreRouteIndex = 0;
                  window.__vigilFixtureDuplicateWatchActive = false;
                  window.__vigilFixtureDuplicateWatchAccepted = false;

                  const fixtureNativeHistoryReplaceState = history.replaceState.bind(history);
                  const fixtureVideo = document.querySelector('video');
                  let fixturePaused = false;
                  Object.defineProperty(fixtureVideo, 'paused', {
                    configurable: true,
                    get: () => fixturePaused
                  });
                  fixtureVideo.play = () => {
                    window.__vigilFixturePlayCalls += 1;
                    fixturePaused = false;
                    fixtureVideo.dispatchEvent(new Event('play'));
                    return Promise.resolve();
                  };
                  fixtureVideo.pause = () => {
                    window.__vigilFixturePauseCalls += 1;
                    fixturePaused = true;
                    fixtureVideo.dispatchEvent(new Event('pause'));
                  };
                  new MutationObserver(() => {
                    if (window.__vigilFixtureDuplicateWatchActive
                        && window.__vigilFixtureFallbackClicks === 0
                        && document.getElementById('fixture-watch-content').contains(
                          document.getElementById('fixture-player')
                        )) {
                      window.__vigilFixtureDuplicateWatchAccepted = true;
                    }
                  }).observe(document.getElementById('fixture-watch-content'), {
                    childList: true,
                    subtree: true
                  });

                  document.querySelector('.ytp-fullscreen-button').addEventListener('click', () => {
                    window.__vigilFixtureFullscreenClicks += 1;
                  });
                  document.getElementById('fixture-grid-expand').addEventListener('click', () => {
                    window.__vigilFixtureGridExpandClicks += 1;
                    document.getElementById('fixture-more-videos-grid')
                      .toggleAttribute('data-fixture-expanded');
                  });
                  document.getElementById('fixture-fullscreen-ordinary-control').addEventListener('click', () => {
                    window.__vigilFixtureFullscreenOrdinaryControlClicks += 1;
                  });
                  document.getElementById('fixture-below-recommendation').addEventListener('click', event => {
                    event.preventDefault();
                    window.__vigilFixtureRecommendationClicks += 1;
                  });

                  const renderFixtureRoute = () => {
                    const isHome = location.pathname === '/';
                    const isWatch = location.pathname === '/watch';
                    document.getElementById('fixture-home-content').hidden = !isHome;
                    document.getElementById('fixture-other-content').hidden = isHome || isWatch;
                    document.getElementById('fixture-watch-content').hidden = !isWatch;
                    document.documentElement.dataset.fixtureRoute = isHome
                      ? 'home'
                      : (isWatch ? 'watch' : 'other');
                  };
                  const announceFixtureRoute = () => {
                    document.dispatchEvent(new Event('yt-navigate-finish'));
                  };

                  document.getElementById('fixture-home-control').addEventListener('click', event => {
                    event.preventDefault();
                    window.__vigilFixtureHomeControlClicks += 1;
                    if (location.pathname !== '/') {
                      // The live mobile router pauses the same media element
                      // more than once and can do so well after navigation
                      // begins. Reproduce that sequence instead of the old
                      // single synchronous pause fixture.
                      fixtureVideo.pause();
                      setTimeout(() => fixtureVideo.pause(), 450);
                      setTimeout(() => {
                        window.__vigilFixturePlayerTeardowns += 1;
                        document.getElementById('fixture-player')?.remove();
                      }, 120);
                      history.pushState({ fixture: 'home' }, '', '/');
                    }
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  document.getElementById('fixture-home-action').addEventListener('click', () => {
                    window.__vigilFixtureHomeContentClicks += 1;
                  });
                  const installFixtureRoute = (controlID, state, destination) => {
                    document.getElementById(controlID).addEventListener('click', event => {
                      event.preventDefault();
                      history.pushState({ fixture: state }, '', destination);
                      renderFixtureRoute();
                      announceFixtureRoute();
                    });
                  };
                  installFixtureRoute(
                    'fixture-other-control',
                    'other',
                    '/results?search_query=fixture'
                  );
                  installFixtureRoute(
                    'fixture-watch-control',
                    'watch',
                    '/watch?v=ordinary-video'
                  );
                  document.addEventListener('click', event => {
                    const link = event.target instanceof Element
                      ? event.target.closest('a.yt-simple-endpoint[href]')
                      : null;
                    if (!(link instanceof HTMLAnchorElement) || !link.hidden) return;
                    const destination = new URL(link.href, location.href);
                    if (destination.pathname !== '/watch') return;
                    event.preventDefault();
                    window.__vigilFixtureDuplicateWatchActive = false;
                    window.__vigilFixtureFallbackClicks += 1;
                    window.__vigilFixtureFallbackStateInput = 'fallback-watch';
                    history.pushState(
                      { fixture: window.__vigilFixtureFallbackStateInput },
                      '',
                      `${destination.pathname}${destination.search}`
                    );
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  addEventListener('popstate', () => {
                    window.__vigilFixturePopRoutes.push(`${location.pathname}${location.search}`);
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  window.__vigilFixturePopTo = (destination, state = null) => {
                    fixtureNativeHistoryReplaceState(
                      state || {
                        fixture: destination.startsWith('/watch') ? 'watch' : 'home'
                      },
                      '',
                      destination
                    );
                    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                  };
                  window.__vigilFixtureBackToHome = () => {
                    const state = { fixture: 'home' };
                    const marker = history.state?.__vigilYouTubeMiniplayer;
                    if (marker && typeof marker === 'object') {
                      state.__vigilYouTubeMiniplayer = { ...marker, index: 1 };
                    }
                    window.__vigilFixturePopTo('/', state);
                  };
                  const fixtureNativeHistoryGo = history.go.bind(history);
                  history.go = delta => {
                    window.__vigilFixtureGoCalls.push(delta);
                    if (delta < 0) {
                      const state = { fixture: 'watch' };
                      const marker = history.state?.__vigilYouTubeMiniplayer;
                      if (marker && typeof marker === 'object') {
                        state.__vigilYouTubeMiniplayer = {
                          ...marker,
                          index: window.__vigilFixtureRestoreRouteIndex
                        };
                      }
                      window.__vigilFixtureDuplicateWatchActive =
                        window.__vigilFixtureRestoreRouteIndex !== 0;
                      window.__vigilFixturePopTo('/watch?v=ordinary-video', state);
                      return;
                    }
                    fixtureNativeHistoryGo(delta);
                  };
                  history.replaceState({ fixture: 'watch' }, '', location.href);
                  window.__vigilFixtureWatchHistoryState = history.state?.fixture || '';
                  renderFixtureRoute();
                </script>
              </body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=ordinary-video"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        webView.navigationDelegate = nil
        try await waitForJavaScriptCondition(
            "window.__vigilYouTubeParityTest != null",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "document.getElementById('vigil-youtube-parity-style')?.remove(); true"
        )
        try await waitForJavaScriptCondition(
            "document.getElementById('vigil-youtube-parity-style') != null",
            in: webView
        )

        let portraitMoreVideos = try await evaluateJavaScriptRetryingKnownGestureTransition(
            #"""
            (() => {
              const player = document.getElementById('player');
              const grid = document.getElementById('fixture-more-videos-grid');
              const gridExpand = document.getElementById('fixture-grid-expand');
              const pauseOverlay = document.getElementById('fixture-pause-overlay');
              const mobileMoreVideos = document.getElementById('fixture-mobile-more-videos');
              const portaledMoreVideos = document.getElementById('fixture-portaled-more-videos');
              const fullscreenRecommendations =
                document.getElementById('fixture-fullscreen-recommendations');
              const fullscreen = document.getElementById('fixture-fullscreen');
              const ordinaryFullscreenControl =
                document.getElementById('fixture-fullscreen-ordinary-control');
              const recommendation = document.getElementById('fixture-below-recommendation');
              const visible = element => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return element.isConnected && style.display !== 'none'
                  && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              const hit = element => {
                const rect = element.getBoundingClientRect();
                const target = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2
                );
                return target === element || element.contains(target);
              };
              player.classList.remove('ytp-fullscreen');
              const inlineAllowed = window.__vigilYouTubeParityTest.updateMoreVideosAvailability();
              const suppressedGridRetainsGeometry = grid.getBoundingClientRect().width > 0
                && grid.getBoundingClientRect().height > 0;
              const suppressedGridExpandHidden = !visible(gridExpand) && !hit(gridExpand);
              const fullscreenHittable = hit(fullscreen);
              if (fullscreenHittable) fullscreen.click();
              const ordinaryFullscreenControlHittable = hit(ordinaryFullscreenControl);
              if (ordinaryFullscreenControlHittable) ordinaryFullscreenControl.click();
              const recommendationHittable = hit(recommendation);
              if (recommendationHittable) recommendation.click();

              player.classList.add('ytp-fullscreen');
              const portraitFullscreenAllowed =
                window.__vigilYouTubeParityTest.updateMoreVideosAvailability();
              const portraitFullscreenHidden = !visible(grid) && !visible(pauseOverlay)
                && !visible(mobileMoreVideos) && !visible(portaledMoreVideos)
                && !visible(fullscreenRecommendations);
              player.classList.remove('ytp-fullscreen');
              window.__vigilYouTubeParityTest.updateMoreVideosAvailability();

              return {
                portrait: innerWidth < innerHeight,
                inlineAllowed,
                inlineHidden: !visible(grid) && !visible(pauseOverlay)
                  && !visible(mobileMoreVideos) && !visible(portaledMoreVideos)
                  && !visible(fullscreenRecommendations),
                suppressedGridRetainsGeometry,
                suppressedGridExpandHidden,
                portraitFullscreenAllowed,
                portraitFullscreenHidden,
                fullscreenHittable,
                fullscreenClicks: window.__vigilFixtureFullscreenClicks,
                ordinaryFullscreenControlVisible: visible(ordinaryFullscreenControl),
                ordinaryFullscreenControlHittable,
                ordinaryFullscreenControlClicks:
                  window.__vigilFixtureFullscreenOrdinaryControlClicks,
                recommendationVisible: visible(recommendation),
                recommendationHittable,
                recommendationClicks: window.__vigilFixtureRecommendationClicks,
                normalRecommendationsConnected:
                  document.getElementById('fixture-watch-next').contains(recommendation),
                classifierMatrix:
                  !window.__vigilYouTubeParityTest.moreVideosAllowedForState(false, 844, 390)
                  && !window.__vigilYouTubeParityTest.moreVideosAllowedForState(true, 390, 844)
                  && window.__vigilYouTubeParityTest.moreVideosAllowedForState(true, 844, 390)
              };
            })()
            """#,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(portraitMoreVideos?["portrait"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["inlineAllowed"] as? Bool, false)
        XCTAssertEqual(portraitMoreVideos?["inlineHidden"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["suppressedGridRetainsGeometry"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["suppressedGridExpandHidden"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["portraitFullscreenAllowed"] as? Bool, false)
        XCTAssertEqual(portraitMoreVideos?["portraitFullscreenHidden"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["fullscreenHittable"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["fullscreenClicks"] as? Int, 1)
        XCTAssertEqual(portraitMoreVideos?["ordinaryFullscreenControlVisible"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["ordinaryFullscreenControlHittable"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["ordinaryFullscreenControlClicks"] as? Int, 1)
        XCTAssertEqual(portraitMoreVideos?["recommendationVisible"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["recommendationHittable"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["recommendationClicks"] as? Int, 1)
        XCTAssertEqual(portraitMoreVideos?["normalRecommendationsConnected"] as? Bool, true)
        XCTAssertEqual(portraitMoreVideos?["classifierMatrix"] as? Bool, true)

        webView.frame = CGRect(x: 0, y: 0, width: 844, height: 390)
        try await waitForJavaScriptCondition(
            "(window.visualViewport?.width || innerWidth) > (window.visualViewport?.height || innerHeight)",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "document.getElementById('player').classList.remove('ytp-fullscreen'); true"
        )
        try await waitForJavaScriptCondition(
            "document.documentElement.getAttribute('data-vigil-youtube-more-videos') === 'suppressed'",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "document.getElementById('player').classList.add('ytp-fullscreen'); true"
        )
        try await waitForJavaScriptCondition(
            "document.documentElement.getAttribute('data-vigil-youtube-more-videos') === 'allowed'",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "document.getElementById('player').classList.remove('ytp-fullscreen'); true"
        )
        try await waitForJavaScriptCondition(
            "document.documentElement.getAttribute('data-vigil-youtube-more-videos') === 'suppressed'",
            in: webView
        )
        let landscapeMoreVideos = try await evaluateJavaScriptRetryingKnownGestureTransition(
            #"""
            (() => {
              const player = document.getElementById('player');
              const grid = document.getElementById('fixture-more-videos-grid');
              const gridExpand = document.getElementById('fixture-grid-expand');
              const pauseOverlay = document.getElementById('fixture-pause-overlay');
              const mobileMoreVideos = document.getElementById('fixture-mobile-more-videos');
              const portaledMoreVideos = document.getElementById('fixture-portaled-more-videos');
              const fullscreenRecommendations =
                document.getElementById('fixture-fullscreen-recommendations');
              const recommendation = document.getElementById('fixture-below-recommendation');
              const visible = element => {
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return element.isConnected && style.display !== 'none'
                  && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
              };
              player.classList.remove('ytp-fullscreen');
              const inlineAllowed = window.__vigilYouTubeParityTest.updateMoreVideosAvailability();
              const inlineHidden = !visible(grid) && !visible(pauseOverlay)
                && !visible(mobileMoreVideos) && !visible(portaledMoreVideos)
                && !visible(fullscreenRecommendations);
              player.classList.add('ytp-fullscreen');
              const fullscreenAllowed = window.__vigilYouTubeParityTest.updateMoreVideosAvailability();
              const fullscreenVisible = visible(grid) && visible(pauseOverlay)
                && visible(mobileMoreVideos) && visible(portaledMoreVideos)
                && visible(fullscreenRecommendations);
              const gridExpandVisible = visible(gridExpand);
              const gridExpandInteractive = getComputedStyle(grid).pointerEvents !== 'none'
                && getComputedStyle(gridExpand).pointerEvents !== 'none';
              if (gridExpandVisible && gridExpandInteractive) gridExpand.click();
              const gridExpandWorked = grid.hasAttribute('data-fixture-expanded')
                && window.__vigilFixtureGridExpandClicks === 1;
              const recommendationsPreserved = visible(recommendation)
                && document.getElementById('fixture-watch-next').contains(recommendation);
              player.classList.remove('ytp-fullscreen');
              const exitAllowed = window.__vigilYouTubeParityTest.updateMoreVideosAvailability();
              const hiddenAfterExit = !visible(grid) && !visible(pauseOverlay)
                && !visible(mobileMoreVideos) && !visible(portaledMoreVideos)
                && !visible(fullscreenRecommendations);

              return {
                landscape: (window.visualViewport?.width || innerWidth)
                  > (window.visualViewport?.height || innerHeight),
                inlineAllowed,
                inlineHidden,
                fullscreenAllowed,
                fullscreenVisible,
                gridExpandVisible,
                gridExpandInteractive,
                gridExpandWorked,
                recommendationsPreserved,
                exitAllowed,
                hiddenAfterExit,
                overlaysRemainConnected: grid.isConnected && pauseOverlay.isConnected
                  && mobileMoreVideos.isConnected && portaledMoreVideos.isConnected
                  && fullscreenRecommendations.isConnected
              };
            })()
            """#,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(landscapeMoreVideos?["landscape"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["inlineAllowed"] as? Bool, false)
        XCTAssertEqual(landscapeMoreVideos?["inlineHidden"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["fullscreenAllowed"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["fullscreenVisible"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["gridExpandVisible"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["gridExpandInteractive"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["gridExpandWorked"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["recommendationsPreserved"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["exitAllowed"] as? Bool, false)
        XCTAssertEqual(landscapeMoreVideos?["hiddenAfterExit"] as? Bool, true)
        XCTAssertEqual(landscapeMoreVideos?["overlaysRemainConnected"] as? Bool, true)

        webView.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        try await waitForJavaScriptCondition(
            "(window.visualViewport?.width || innerWidth) < (window.visualViewport?.height || innerHeight)",
            in: webView
        )
        _ = try await webView.evaluateJavaScript(
            "window.__vigilFixtureFullscreenClicks = 0; true"
        )

        let responsePrevention = try await webView.callAsyncJavaScript(
            #"""
            const fetchResponse = await fetch('/youtubei/v1/player?fixture=true');
            const fetchPayload = await fetchResponse.json();
            const ordinaryResponse = await fetch('/youtubei/v1/next?fixture=true');
            const ordinaryPayload = await ordinaryResponse.json();
            const malformedResponse = await fetch('/youtubei/v1/player?malformed=true');
            const malformedText = await malformedResponse.text();
            const driftPayload = await (
              await fetch('/youtubei/v1/player?schema=drift')
            ).json();
            const partialPayload = await (
              await fetch('/youtubei/v1/player?partial=true')
            ).json();
            const plainPayload = await (
              await fetch('/youtubei/v1/player?plain=true')
            ).json();

            const playerXHR = new XMLHttpRequest();
            playerXHR.open('POST', '/youtubei/v1/player?fixture=true');
            playerXHR.send();
            const playerXHRPayload = JSON.parse(playerXHR.responseText);
            const ordinaryXHR = new XMLHttpRequest();
            ordinaryXHR.open('POST', '/youtubei/v1/next?fixture=true');
            ordinaryXHR.send();
            const ordinaryXHRPayload = JSON.parse(ordinaryXHR.responseText);

            const reusedXHR = new XMLHttpRequest();
            reusedXHR.open('POST', '/youtubei/v1/player?fixture=true');
            reusedXHR.send();
            const reusedPlayerPayload = JSON.parse(reusedXHR.responseText);
            reusedXHR.open('POST', '/youtubei/v1/next?fixture=true');
            reusedXHR.send();
            const reusedOrdinaryPayload = JSON.parse(reusedXHR.responseText);

            window.ytInitialPlayerResponse = {
              videoDetails: { videoId: 'initial-video' },
              streamingData: { formats: [{ itag: 18 }] },
              adPlacements: [{ initial: true }],
              playerAds: [{ initial: true }],
              adSlots: [{ initial: true }],
              playerResponse: {
                videoDetails: { videoId: 'nested-initial-video' },
                playabilityStatus: { status: 'OK' },
                adPlacements: [{ nested: true }],
                playerAds: [{ nested: true }],
                adSlots: [{ nested: true }]
              }
            };
            const initialPayload = window.ytInitialPlayerResponse;

            return {
              fetchAdsRemoved: !('adPlacements' in fetchPayload)
                && !('playerAds' in fetchPayload)
                && !('adSlots' in fetchPayload)
                && !('adPlacements' in fetchPayload.playerResponse)
                && !('playerAds' in fetchPayload.playerResponse)
                && !('adSlots' in fetchPayload.playerResponse),
              fetchContentPreserved: fetchPayload.videoDetails.videoId === 'ordinary-video'
                && fetchPayload.streamingData.formats[0].itag === 18
                && fetchPayload.metadata.adPlacements === 'ordinary nested metadata must remain'
                && fetchPayload.metadata.playerAds === 'ordinary nested metadata must remain',
              fetchMetadataPreserved: fetchResponse.status === 200
                && fetchResponse.statusText === 'Fixture response'
                && fetchResponse.headers.get('x-vigil-fixture') === 'true'
                && fetchResponse.headers.get('content-encoding') === null
                && fetchResponse.headers.get('content-length') === null
                && fetchResponse.headers.get('etag') === null,
              ordinaryFetchUntouched: 'adPlacements' in ordinaryPayload
                && 'playerAds' in ordinaryPayload
                && 'adSlots' in ordinaryPayload,
              malformedFailOpen: malformedText === 'not-json',
              schemaDriftFailOpen: !Array.isArray(driftPayload.adPlacements)
                && 'playerAds' in driftPayload
                && 'adSlots' in driftPayload,
              non200FailOpen: 'adPlacements' in partialPayload
                && 'playerAds' in partialPayload
                && 'adSlots' in partialPayload,
              nonJSONFailOpen: 'adPlacements' in plainPayload
                && 'playerAds' in plainPayload
                && 'adSlots' in plainPayload,
              xhrAdsRemoved: !('adPlacements' in playerXHRPayload)
                && !('playerAds' in playerXHRPayload)
                && !('adSlots' in playerXHRPayload)
                && !('adPlacements' in playerXHRPayload.playerResponse)
                && !('playerAds' in playerXHRPayload.playerResponse)
                && !('adSlots' in playerXHRPayload.playerResponse),
              xhrContentPreserved: playerXHRPayload.videoDetails.videoId === 'ordinary-video'
                && playerXHRPayload.streamingData.formats[0].itag === 18,
              ordinaryXHRUntouched: 'adPlacements' in ordinaryXHRPayload
                && 'playerAds' in ordinaryXHRPayload
                && 'adSlots' in ordinaryXHRPayload,
              reusedXHRScoped: !('adPlacements' in reusedPlayerPayload)
                && 'adPlacements' in reusedOrdinaryPayload
                && 'playerAds' in reusedOrdinaryPayload
                && 'adSlots' in reusedOrdinaryPayload,
              initialAdsRemoved: !('adPlacements' in initialPayload)
                && !('playerAds' in initialPayload)
                && !('adSlots' in initialPayload)
                && !('adPlacements' in initialPayload.playerResponse)
                && !('playerAds' in initialPayload.playerResponse)
                && !('adSlots' in initialPayload.playerResponse),
              initialContentPreserved: initialPayload.videoDetails.videoId === 'initial-video'
                && initialPayload.playerResponse.videoDetails.videoId === 'nested-initial-video'
            };
            """#,
            arguments: [:],
            in: nil,
            contentWorld: .page
        ) as? [String: Any]
        XCTAssertEqual(responsePrevention?["fetchAdsRemoved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["fetchContentPreserved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["fetchMetadataPreserved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["ordinaryFetchUntouched"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["malformedFailOpen"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["schemaDriftFailOpen"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["non200FailOpen"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["nonJSONFailOpen"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["xhrAdsRemoved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["xhrContentPreserved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["ordinaryXHRUntouched"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["reusedXHRScoped"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["initialAdsRemoved"] as? Bool, true)
        XCTAssertEqual(responsePrevention?["initialContentPreserved"] as? Bool, true)

        let adSuppression = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const player = document.getElementById('player');
              const video = player.querySelector('video');
              const initialMedia = {
                currentTime: video.currentTime,
                playbackRate: video.playbackRate,
                muted: video.muted,
                playCalls: window.__vigilFixturePlayCalls,
                pauseCalls: window.__vigilFixturePauseCalls
              };
              const overlay = document.createElement('div');
              overlay.className = 'ytp-ad-player-overlay';
              const button = document.createElement('button');
              button.className = 'ytp-ad-skip-button-modern';
              button.textContent = 'Skip ad';
              button.addEventListener('click', () => {
                window.__vigilFixtureAdSkipClicks += 1;
                window.__vigilFixtureAdOverlayConnectedAtClick = overlay.isConnected;
                window.__vigilFixtureAdOverlayVisibleAtClick =
                  getComputedStyle(overlay).display !== 'none'
                  && overlay.getBoundingClientRect().width > 0;
                player.classList.remove('ad-showing');
              });
              overlay.append(button);
              player.classList.add('ad-showing');
              player.append(overlay);
              const suppressed = window.__vigilYouTubeParityTest.suppressYouTubeAds();
              const duplicateSuppressed = window.__vigilYouTubeParityTest.suppressYouTubeAds();
              player.classList.add('ad-showing');
              const reusedControlSuppressed =
                window.__vigilYouTubeParityTest.suppressYouTubeAds();

              overlay.remove();
              const unskippableOverlay = document.createElement('div');
              unskippableOverlay.className = 'ytp-ad-player-overlay';
              unskippableOverlay.textContent = 'Ad playing';
              player.dataset.isAd = 'true';
              player.classList.add('ad-showing');
              player.append(unskippableOverlay);
              const unskippableMedia = {
                currentTime: video.currentTime,
                playbackRate: video.playbackRate,
                muted: video.muted,
                playCalls: window.__vigilFixturePlayCalls,
                pauseCalls: window.__vigilFixturePauseCalls
              };
              const unskippableSuppressed =
                window.__vigilYouTubeParityTest.suppressYouTubeAds();
              window.__vigilYouTubeParityTest.suppressYouTubeAds();
              const unskippablePreserved = unskippableOverlay.isConnected
                && getComputedStyle(unskippableOverlay).display !== 'none'
                && getComputedStyle(player).display !== 'none'
                && video.currentTime === unskippableMedia.currentTime
                && video.playbackRate === unskippableMedia.playbackRate
                && video.muted === unskippableMedia.muted
                && window.__vigilFixturePlayCalls === unskippableMedia.playCalls
                && window.__vigilFixturePauseCalls === unskippableMedia.pauseCalls;

              unskippableOverlay.remove();
              delete player.dataset.isAd;
              const countdownOverlay = document.createElement('div');
              countdownOverlay.className = 'ytp-ad-player-overlay';
              const countdownButton = document.createElement('button');
              countdownButton.className = 'ytp-ad-skip-button';
              countdownButton.textContent = 'Skip ad';
              countdownButton.disabled = true;
              countdownButton.addEventListener('click', () => {
                window.__vigilFixtureAdSkipClicks += 1;
                player.classList.remove('ad-showing');
              });
              countdownOverlay.append(countdownButton);
              player.append(countdownOverlay);
              const disabledSuppressed = window.__vigilYouTubeParityTest.suppressYouTubeAds();
              countdownButton.disabled = false;
              const enabledSuppressed = window.__vigilYouTubeParityTest.suppressYouTubeAds();

              const lookalike = document.createElement('button');
              lookalike.className = 'ytp-ad-skip-button';
              lookalike.textContent = 'Ordinary page control';
              lookalike.addEventListener('click', () => {
                window.__vigilFixtureAdSkipClicks += 100;
              });
              document.body.append(lookalike);
              const lookalikeSuppressed = window.__vigilYouTubeParityTest.suppressYouTubeAds();

              const cosmeticAd = document.createElement('ytm-in-feed-ad-layout-renderer');
              document.body.append(cosmeticAd);
              return {
                suppressed,
                duplicateSuppressed,
                reusedControlSuppressed,
                skipClicks: window.__vigilFixtureAdSkipClicks,
                adEnded: !player.classList.contains('ad-showing'),
                overlayConnectedAtClick: window.__vigilFixtureAdOverlayConnectedAtClick,
                overlayVisibleAtClick: window.__vigilFixtureAdOverlayVisibleAtClick,
                unskippableSuppressed,
                unskippablePreserved,
                disabledSuppressed,
                enabledSuppressed,
                lookalikeSuppressed,
                cosmeticAdHidden: getComputedStyle(cosmeticAd).display === 'none',
                currentTimePreserved: video.currentTime === initialMedia.currentTime,
                mutedPreserved: video.muted === initialMedia.muted,
                speedPreserved: video.playbackRate === initialMedia.playbackRate
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(adSuppression?["suppressed"] as? Bool, true)
        XCTAssertEqual(adSuppression?["duplicateSuppressed"] as? Bool, false)
        XCTAssertEqual(adSuppression?["reusedControlSuppressed"] as? Bool, true)
        XCTAssertEqual(adSuppression?["skipClicks"] as? Int, 3)
        XCTAssertEqual(adSuppression?["adEnded"] as? Bool, true)
        XCTAssertEqual(adSuppression?["overlayConnectedAtClick"] as? Bool, true)
        XCTAssertEqual(adSuppression?["overlayVisibleAtClick"] as? Bool, true)
        XCTAssertEqual(adSuppression?["unskippableSuppressed"] as? Bool, false)
        XCTAssertEqual(adSuppression?["unskippablePreserved"] as? Bool, true)
        XCTAssertEqual(adSuppression?["disabledSuppressed"] as? Bool, false)
        XCTAssertEqual(adSuppression?["enabledSuppressed"] as? Bool, true)
        XCTAssertEqual(adSuppression?["lookalikeSuppressed"] as? Bool, false)
        XCTAssertEqual(adSuppression?["cosmeticAdHidden"] as? Bool, true)
        XCTAssertEqual(adSuppression?["currentTimePreserved"] as? Bool, true)
        XCTAssertEqual(adSuppression?["mutedPreserved"] as? Bool, true)
        XCTAssertEqual(adSuppression?["speedPreserved"] as? Bool, true)

        let unsafePopGrowthIsRejected = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            window.__vigilYouTubeParityTest.reconcilePopRouteIndexForTest({
              currentLength: 3,
              observedLength: 2,
              routeIndex: 1,
              currentURL: 'https://m.youtube.com/',
              routeURLs: [
                'https://m.youtube.com/watch?v=ordinary-video',
                'https://m.youtube.com/'
              ],
              markerIndex: null
            }) === null
              && window.__vigilYouTubeParityTest.reconcilePopRouteIndexForTest({
                currentLength: 2,
                observedLength: 2,
                routeIndex: 1,
                currentURL: 'https://m.youtube.com/',
                routeURLs: [
                  'https://m.youtube.com/watch?v=ordinary-video',
                  'https://m.youtube.com/'
                ],
                markerIndex: 1
              }) === null
            """,
            in: webView
        ) as? Bool
        XCTAssertEqual(
            unsafePopGrowthIsRejected,
            true,
            "Unobserved growth or copied equal-index markers must invalidate Back traversal"
        )

        let blockedEdgeSwipe = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const video = document.querySelector('video');
              const send = (type, x, y) => video.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: y
              }));
              send('pointerdown', 5, 60);
              send('pointermove', 5, 160);
              send('pointerup', 5, 160);
              return document.documentElement.dataset.vigilYoutubeMiniplayer === 'true';
            })()
            """,
            in: webView
        ) as? Bool
        XCTAssertEqual(blockedEdgeSwipe, false, "The iOS edge-back region must win over the player gesture")

        let blockedSeekSwipe = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const seek = document.getElementById('seek');
              const send = (type, x, y) => seek.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 8, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: y
              }));
              send('pointerdown', 190, 190);
              send('pointermove', 190, 290);
              send('pointerup', 190, 290);
              return document.documentElement.dataset.vigilYoutubeMiniplayer === 'true';
            })()
            """,
            in: webView
        ) as? Bool
        XCTAssertEqual(blockedSeekSwipe, false, "Progress scrubbing must not start the miniplayer")

        let diagonalGestureState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const video = document.querySelector('video');
              const swipe = (pointerId, startX, startY, endX, endY) => {
                const send = (type, x, y) => video.dispatchEvent(new PointerEvent(type, {
                  bubbles: true, cancelable: true, pointerId, pointerType: 'touch',
                  isPrimary: true, clientX: x, clientY: y
                }));
                send('pointerdown', startX, startY);
                send('pointermove', endX, endY);
                send('pointerup', endX, endY);
              };
              swipe(82, 100, 70, 275, 150);
              swipe(83, 290, 170, 105, 80);
              return {
                inactive: !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer'),
                fullscreenClicks: window.__vigilFixtureFullscreenClicks,
                route: location.pathname,
                gestureMarkerRemoved: !document.querySelector('[data-vigil-youtube-gesture-player="true"]')
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(diagonalGestureState?["inactive"] as? Bool, true)
        XCTAssertEqual(
            diagonalGestureState?["fullscreenClicks"] as? Int,
            0,
            "Horizontal-dominant player swipes must not minimize or enter fullscreen"
        )
        XCTAssertEqual(diagonalGestureState?["route"] as? String, "/watch")
        XCTAssertEqual(diagonalGestureState?["gestureMarkerRemoved"] as? Bool, true)

        let fullscreenClicks = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const video = document.querySelector('video');
              const send = (type, x, y) => video.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 81, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: y
              }));
              send('pointerdown', 190, 160);
              send('pointermove', 190, 60);
              send('pointerup', 190, 60);
              return window.__vigilFixtureFullscreenClicks;
            })()
            """,
            in: webView
        ) as? Int
        XCTAssertEqual(fullscreenClicks, 1, "Swipe-up should retain ordinary-video fullscreen parity")

        webView.evaluateJavaScript(
            """
            (() => {
              const video = document.querySelector('video');
              const send = (type, x, y) => video.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: y
              }));
              send('pointerdown', 190, 60);
              send('pointermove', 190, 160);
              send('pointerup', 190, 160);
              return true;
            })()
            """,
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
              && location.pathname === '/'
              && document.documentElement.dataset.fixtureRoute === 'home'
              && document.getElementById('vigil-youtube-miniplayer-shell') != null
              && window.__vigilFixturePlayCalls >= 2
              && window.__vigilFixturePlayerTeardowns === 1
              && document.getElementById('vigil-youtube-miniplayer-shell')
                ?.contains(document.getElementById('fixture-player')) === true
              && document.querySelector('video').paused === false
            """,
            in: webView
        )
        let miniState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const shell = document.getElementById('vigil-youtube-miniplayer-shell');
              const player = document.querySelector('[data-vigil-youtube-active-player="true"]');
              const rect = shell?.getBoundingClientRect();
              const viewportWidth = innerWidth || document.documentElement.clientWidth;
              const viewportHeight = innerHeight || document.documentElement.clientHeight;
              const rightGap = rect ? viewportWidth - rect.right : Infinity;
              const bottomGap = rect ? viewportHeight - rect.bottom : Infinity;
              return {
                active: document.documentElement.dataset.vigilYoutubeMiniplayer === 'true',
                route: location.pathname,
                playerConnected: player?.isConnected === true,
                playerInShell: Boolean(shell && player && shell.contains(player)),
                playerTag: player?.tagName || '',
                shell: shell?.getAttribute('aria-label') || '',
                close: shell?.querySelector('.vigil-youtube-mini-close')?.getAttribute('aria-label') || '',
                compact: Boolean(rect && rect.width > 0 && rect.width <= viewportWidth * 0.65),
                rightAnchored: rightGap >= -1 && rightGap <= 24,
                bottomAnchored: bottomGap >= -1 && bottomGap <= 160,
                homeVisible: !document.getElementById('fixture-home-content').hidden,
                watchHidden: document.getElementById('fixture-watch-content').hidden,
                playing: document.querySelector('video').paused === false,
                playbackRecoveries: window.__vigilFixturePlayCalls,
                ownershipRecoveries: window.__vigilFixturePlayerTeardowns
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(miniState?["active"] as? Bool, true)
        XCTAssertEqual(miniState?["route"] as? String, "/", "Swipe-down should return to Home")
        XCTAssertEqual(miniState?["playerConnected"] as? Bool, true)
        XCTAssertEqual(miniState?["playerInShell"] as? Bool, true)
        XCTAssertEqual(miniState?["playerTag"] as? String, "YTM-PLAYER", "The unclipped outer player host must move")
        XCTAssertEqual(miniState?["shell"] as? String, "YouTube miniplayer")
        XCTAssertEqual(miniState?["close"] as? String, "Close miniplayer")
        XCTAssertEqual(miniState?["compact"] as? Bool, true, "The miniplayer must not span the viewport like a bar")
        XCTAssertEqual(miniState?["rightAnchored"] as? Bool, true)
        XCTAssertEqual(miniState?["bottomAnchored"] as? Bool, true)
        XCTAssertEqual(miniState?["homeVisible"] as? Bool, true)
        XCTAssertEqual(miniState?["watchHidden"] as? Bool, true)
        XCTAssertEqual(miniState?["playing"] as? Bool, true)
        XCTAssertGreaterThanOrEqual(miniState?["playbackRecoveries"] as? Int ?? 0, 2)
        XCTAssertEqual(miniState?["ownershipRecoveries"] as? Int, 1)

        let homeInteraction = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const dispatchHitClick = element => {
                const rect = element.getBoundingClientRect();
                const target = document.elementFromPoint(
                  rect.left + rect.width / 2,
                  rect.top + rect.height / 2
                );
                const hit = target === element || element.contains(target);
                target?.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true, view: window
                }));
                return hit;
              };
              const controlClicks = window.__vigilFixtureHomeControlClicks;
              const contentClicks = window.__vigilFixtureHomeContentClicks;
              const controlHit = dispatchHitClick(document.getElementById('fixture-home-control'));
              const contentHit = dispatchHitClick(document.getElementById('fixture-home-action'));
              const player = document.querySelector('[data-vigil-youtube-active-player="true"]');
              return {
                controlHit,
                contentHit,
                controlClicked: window.__vigilFixtureHomeControlClicks === controlClicks + 1,
                contentClicked: window.__vigilFixtureHomeContentClicks === contentClicks + 1,
                active: document.documentElement.dataset.vigilYoutubeMiniplayer === 'true',
                playerConnected: player?.isConnected === true,
                route: location.pathname
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(homeInteraction?["controlHit"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["contentHit"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["controlClicked"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["contentClicked"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["active"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["playerConnected"] as? Bool, true)
        XCTAssertEqual(homeInteraction?["route"] as? String, "/")

        let encodedShortsState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const links = [
                document.getElementById('fixture-encoded-shorts'),
                document.getElementById('fixture-double-encoded-shorts')
              ];
              const blockedClicks = links.map(link => !link.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true, composed: true, view: window
              })));
              return {
                blocked: blockedClicks.every(Boolean),
                browseActivated: location.pathname === '/',
                active: document.documentElement.dataset.vigilYoutubeMiniplayer === 'true',
                route: `${location.pathname}${location.search}`
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(encodedShortsState?["blocked"] as? Bool, true)
        XCTAssertEqual(encodedShortsState?["browseActivated"] as? Bool, true)
        XCTAssertEqual(encodedShortsState?["active"] as? Bool, true)
        XCTAssertEqual(
            encodedShortsState?["route"] as? String,
            "/",
            "Encoded Shorts links must be blocked without leaving the browse surface"
        )

        webView.evaluateJavaScript(
            """
            (() => {
              document.getElementById('fixture-other-control').click();
              return `${location.pathname}${location.search}`;
            })()
            """,
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            document.documentElement.dataset.fixtureRoute === 'other'
              && document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
              && document.querySelector('[data-vigil-youtube-active-player="true"]')?.isConnected === true
            """,
            in: webView
        )
        webView.evaluateJavaScript(
            "window.__vigilFixtureBackToHome()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/'
              && document.documentElement.dataset.fixtureRoute === 'home'
              && document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
            """,
            in: webView
        )

        webView.evaluateJavaScript(
            """
            (() => {
              const shell = document.getElementById('vigil-youtube-miniplayer-shell');
              window.__vigilFixtureShellClicks += 1;
              if (!shell) return false;
              window.__vigilYouTubeParityTest.handleMiniTap();
              return true;
            })()
            """,
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/watch'
              && location.search === '?v=ordinary-video'
              && document.documentElement.dataset.fixtureRoute === 'watch'
              && !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('vigil-youtube-miniplayer-shell') == null
              && document.getElementById('fixture-player')?.isConnected === true
              && document.getElementById('fixture-watch-content').contains(document.getElementById('fixture-player'))
            """,
            in: webView
        )
        let watchState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            ({
              route: location.pathname,
              watchVisible: !document.getElementById('fixture-watch-content').hidden,
              homeHidden: document.getElementById('fixture-home-content').hidden,
              playerConnected: document.getElementById('fixture-player')?.isConnected === true,
              playerInWatch: document.getElementById('fixture-watch-content').contains(document.getElementById('fixture-player')),
              playerInactive: !document.getElementById('fixture-player').hasAttribute('data-vigil-youtube-active-player'),
              historyState: history.state?.fixture || '',
              expectedHistoryState: window.__vigilFixtureWatchHistoryState,
              popRoutes: window.__vigilFixturePopRoutes.join('|'),
              fallbackClicks: window.__vigilFixtureFallbackClicks
            })
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(watchState?["route"] as? String, "/watch", "Tapping the miniplayer should restore the watch route")
        XCTAssertEqual(watchState?["watchVisible"] as? Bool, true)
        XCTAssertEqual(watchState?["homeHidden"] as? Bool, true)
        XCTAssertEqual(watchState?["playerConnected"] as? Bool, true)
        XCTAssertEqual(watchState?["playerInWatch"] as? Bool, true)
        XCTAssertEqual(watchState?["playerInactive"] as? Bool, true)
        XCTAssertEqual(
            watchState?["historyState"] as? String,
            watchState?["expectedHistoryState"] as? String
        )
        XCTAssertEqual(
            watchState?["popRoutes"] as? String,
            "/|/watch?v=ordinary-video",
            "Restore must traverse exactly to the Watch origin without overshooting it"
        )
        XCTAssertEqual(
            watchState?["fallbackClicks"] as? Int,
            0,
            "A verified SPA route stack should restore without a duplicate Watch navigation"
        )

        webView.evaluateJavaScript(
            "window.__vigilYouTubeParityTest.enterMiniPlayer()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
              && location.pathname === '/'
            """,
            in: webView
        )
        webView.evaluateJavaScript(
            """
            (() => {
              document.getElementById('fixture-watch-control').click();
              return `${location.pathname}${location.search}`;
            })()
            """,
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/watch'
              && location.search === '?v=ordinary-video'
              && document.documentElement.dataset.fixtureRoute === 'watch'
              && !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('vigil-youtube-miniplayer-shell') == null
              && document.getElementById('fixture-watch-content').contains(document.getElementById('fixture-player'))
            """,
            in: webView
        )
        let sameWatchState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            ({
              playerConnected: document.getElementById('fixture-player')?.isConnected === true,
              playerInactive: !document.getElementById('fixture-player').hasAttribute('data-vigil-youtube-active-player'),
              route: `${location.pathname}${location.search}`,
              historyState: history.state?.fixture || '',
              expectedHistoryState: window.__vigilFixtureWatchHistoryState
            })
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(sameWatchState?["playerConnected"] as? Bool, true)
        XCTAssertEqual(sameWatchState?["playerInactive"] as? Bool, true)
        XCTAssertEqual(sameWatchState?["route"] as? String, "/watch?v=ordinary-video")
        XCTAssertEqual(
            sameWatchState?["historyState"] as? String,
            sameWatchState?["expectedHistoryState"] as? String
        )

        webView.evaluateJavaScript(
            "window.__vigilYouTubeParityTest.enterMiniPlayer()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
              && location.pathname === '/'
            """,
            in: webView
        )
        webView.evaluateJavaScript(
            """
            (() => {
              window.__vigilFixtureRestoreRouteIndex = 2;
              window.__vigilFixtureDuplicateWatchActive = false;
              window.__vigilFixtureDuplicateWatchAccepted = false;
              history.pushState(
                { fixture: 'duplicate-watch' },
                '',
                '/watch?v=ordinary-video'
              );
              history.pushState({ fixture: 'duplicate-home' }, '', '/');
              window.__vigilYouTubeParityTest.restoreMiniPlayer();
            })()
            """,
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/watch'
              && location.search === '?v=ordinary-video'
              && !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('fixture-watch-content').contains(
                document.getElementById('fixture-player')
              )
              && window.__vigilFixtureFallbackClicks === 1
            """,
            in: webView
        )
        let duplicateRestoreState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              window.__vigilFixtureRestoreRouteIndex = 0;
              return {
                duplicateAccepted: window.__vigilFixtureDuplicateWatchAccepted,
                fallbackClicks: window.__vigilFixtureFallbackClicks,
                lastGo: window.__vigilFixtureGoCalls.at(-1),
                route: `${location.pathname}${location.search}`,
                fallbackStateInput: window.__vigilFixtureFallbackStateInput,
                playerInactive: !document.getElementById('fixture-player')
                  .hasAttribute('data-vigil-youtube-active-player')
              };
            })()
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(
            duplicateRestoreState?["duplicateAccepted"] as? Bool,
            false,
            "Tap restore must not accept a newer duplicate entry for the same video"
        )
        XCTAssertEqual(duplicateRestoreState?["fallbackClicks"] as? Int, 1)
        XCTAssertEqual(duplicateRestoreState?["lastGo"] as? Int, -3)
        XCTAssertEqual(
            duplicateRestoreState?["route"] as? String,
            "/watch?v=ordinary-video"
        )
        XCTAssertEqual(
            duplicateRestoreState?["fallbackStateInput"] as? String,
            "fallback-watch"
        )
        XCTAssertEqual(duplicateRestoreState?["playerInactive"] as? Bool, true)

        webView.evaluateJavaScript(
            "window.__vigilYouTubeParityTest.enterMiniPlayer()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
              && location.pathname === '/'
            """,
            in: webView
        )
        let horizontalRoute = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              const shell = document.getElementById('vigil-youtube-miniplayer-shell');
              const rect = shell.getBoundingClientRect();
              const send = (type, x) => shell.dispatchEvent(new PointerEvent(type, {
                bubbles: true, cancelable: true, pointerId: 11, pointerType: 'touch',
                isPrimary: true, clientX: x, clientY: rect.top + rect.height / 2
              }));
              send('pointerdown', rect.left + 24);
              send('pointermove', rect.left + 124);
              send('pointerup', rect.left + 124);
              return location.pathname;
            })()
            """,
            in: webView
        ) as? String
        XCTAssertEqual(horizontalRoute, "/", "Horizontal miniplayer gestures must remain on the browse route")
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/'
              && document.documentElement.hasAttribute('data-vigil-youtube-miniplayer-hidden')
              && document.getElementById('vigil-youtube-miniplayer-handle') != null
            """,
            in: webView
        )
        let hiddenState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            ({
              active: document.documentElement.dataset.vigilYoutubeMiniplayer === 'true',
              hidden: document.documentElement.hasAttribute('data-vigil-youtube-miniplayer-hidden'),
              handle: document.getElementById('vigil-youtube-miniplayer-handle')?.getAttribute('aria-label') || '',
              route: location.pathname,
              homeVisible: !document.getElementById('fixture-home-content').hidden
            })
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(hiddenState?["active"] as? Bool, true)
        XCTAssertEqual(hiddenState?["hidden"] as? Bool, true)
        XCTAssertEqual(hiddenState?["handle"] as? String, "Show miniplayer")
        XCTAssertEqual(hiddenState?["route"] as? String, "/")
        XCTAssertEqual(hiddenState?["homeVisible"] as? Bool, true)

        let closed = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            (() => {
              document.getElementById('vigil-youtube-miniplayer-handle').click();
              window.__vigilFixturePauseCallsBeforeClose = window.__vigilFixturePauseCalls;
              document.querySelector('#vigil-youtube-miniplayer-shell .vigil-youtube-mini-close').click();
              return true;
            })()
            """,
            in: webView
        ) as? Bool
        XCTAssertEqual(closed, true)
        try await waitForJavaScriptCondition(
            """
            !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('vigil-youtube-miniplayer-shell') == null
            """,
            in: webView
        )
        let closedState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            ({
              inactive: !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer'),
              shellRemoved: document.getElementById('vigil-youtube-miniplayer-shell') == null,
              playerInactive: document.querySelector('[data-vigil-youtube-active-player="true"]') == null,
              playerRemoved: document.getElementById('fixture-player') == null,
              paused: window.__vigilFixturePauseCalls > window.__vigilFixturePauseCallsBeforeClose,
              route: location.pathname,
              homeVisible: !document.getElementById('fixture-home-content').hidden
            })
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(closedState?["inactive"] as? Bool, true)
        XCTAssertEqual(closedState?["shellRemoved"] as? Bool, true)
        XCTAssertEqual(closedState?["playerInactive"] as? Bool, true)
        XCTAssertEqual(closedState?["playerRemoved"] as? Bool, true)
        XCTAssertEqual(closedState?["paused"] as? Bool, true)
        XCTAssertEqual(closedState?["route"] as? String, "/", "Close should leave the user browsing Home")
        XCTAssertEqual(closedState?["homeVisible"] as? Bool, true)

        _ = try await evaluateJavaScriptRetryingKnownGestureTransition(
            "window.__vigilYouTubeParityTest.exitMiniPlayer()",
            in: webView
        )
        let restored = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('vigil-youtube-miniplayer-shell') == null
              && document.querySelector('[data-vigil-youtube-active-player="true"]') == null
              && location.pathname === '/'
            """,
            in: webView
        ) as? Bool
        XCTAssertEqual(restored, true)
    }

    @MainActor
    func testYouTubeInteractionExtensionPreservesPlatformNormalizedHistoryState() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: try youtubeInteractionExtensionSource(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            window.isHidden = true
            Self.retainedYouTubeMiniplayerFixtures.append((window, webView))
        }

        let loaded = expectation(description: "YouTube fallback-history fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                  [hidden] { display: none !important; }
                  ytm-watch, ytm-player, #player, video {
                    display: block;
                    width: 390px;
                    min-height: 220px;
                    background: black;
                  }
                </style>
              </head>
              <body>
                <button id="fixture-home-control" role="link" aria-label="YouTube Home">Home</button>
                <main id="fixture-home" hidden><h1>Home</h1></main>
                <ytm-watch id="fixture-watch">
                  <ytm-player id="fixture-player"><div id="player"><video playsinline></video></div></ytm-player>
                  <h1>Fallback history fixture</h1>
                </ytm-watch>
                <script>
                  window.__vigilFixtureFallbackClicks = 0;
                  window.__vigilFixturePopRoutes = [];
                  window.__vigilFixtureTraversalCalls = [];
                  window.__vigilFixtureOriginHistoryState = null;

                  const fixtureNativeHistoryGo = history.go.bind(history);
                  const fixtureNativeHistoryBack = history.back.bind(history);
                  const fixtureNativeHistoryReplaceState = history.replaceState.bind(history);
                  history.go = delta => {
                    window.__vigilFixtureTraversalCalls.push(`go:${delta}`);
                    if (delta < 0 && typeof window.__vigilFixturePopTo === 'function') {
                      window.__vigilFixturePopTo('/watch?v=ordinary-video');
                      return;
                    }
                    return fixtureNativeHistoryGo(delta);
                  };
                  history.back = () => {
                    window.__vigilFixtureTraversalCalls.push('back');
                    return fixtureNativeHistoryBack();
                  };

                  const fixtureHistorySignature = state => {
                    if (state === null) return 'null';
                    if (Array.isArray(state)) return `array:${JSON.stringify(state)}`;
                    if (state instanceof Date) return `date:${state.toISOString()}`;
                    if (state instanceof Map) {
                      return `map:${JSON.stringify(Array.from(state.entries()))}`;
                    }
                    return `${typeof state}:${JSON.stringify(state)}`;
                  };
                  const fixtureHistoryFactories = {
                    null: () => null,
                    primitive: () => 'fixture-primitive',
                    array: () => ['fixture', 7, { nested: true }],
                    date: () => new Date('2026-08-04T12:34:56.000Z'),
                    map: () => new Map([
                      ['alpha', 1],
                      ['nested', { ok: true }]
                    ])
                  };

                  const renderFixtureRoute = () => {
                    const isWatch = location.pathname === '/watch';
                    document.getElementById('fixture-home').hidden = isWatch;
                    document.getElementById('fixture-watch').hidden = !isWatch;
                    document.documentElement.dataset.fixtureRoute = isWatch ? 'watch' : 'home';
                  };
                  const announceFixtureRoute = () => {
                    document.dispatchEvent(new Event('yt-navigate-finish'));
                  };
                  document.getElementById('fixture-home-control').addEventListener('click', event => {
                    event.preventDefault();
                    history.pushState({ fixture: 'home' }, '', '/');
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  document.addEventListener('click', event => {
                    const link = event.target instanceof Element
                      ? event.target.closest('a.yt-simple-endpoint[href]')
                      : null;
                    if (!(link instanceof HTMLAnchorElement)) return;
                    const destination = new URL(link.href, location.href);
                    if (destination.pathname !== '/watch') return;
                    event.preventDefault();
                    window.__vigilFixtureFallbackClicks += 1;
                    history.pushState(
                      { fixture: 'fallback-watch' },
                      '',
                      `${destination.pathname}${destination.search}`
                    );
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  addEventListener('popstate', () => {
                    window.__vigilFixturePopRoutes.push(`${location.pathname}${location.search}`);
                    renderFixtureRoute();
                    announceFixtureRoute();
                  });
                  window.__vigilFixturePopTo = destination => {
                    fixtureNativeHistoryReplaceState(
                      window.__vigilFixtureOriginHistoryState,
                      '',
                      destination
                    );
                    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                  };
                  window.__vigilFixturePrepareHistoryCase = name => {
                    const state = fixtureHistoryFactories[name]();
                    history.replaceState(state, '', '/watch?v=ordinary-video');
                    window.__vigilFixtureOriginHistoryState = history.state;
                    window.__vigilFixtureExpectedHistorySignature = fixtureHistorySignature(history.state);
                    window.__vigilFixtureFallbackBaseline = window.__vigilFixtureFallbackClicks;
                    window.__vigilFixturePopBaseline = window.__vigilFixturePopRoutes.length;
                    window.__vigilFixtureTraversalCalls = [];
                    renderFixtureRoute();
                    return window.__vigilFixtureExpectedHistorySignature;
                  };
                  window.__vigilFixtureHistoryStateIsPreserved = () =>
                    fixtureHistorySignature(history.state)
                      === window.__vigilFixtureExpectedHistorySignature;
                  renderFixtureRoute();
                </script>
              </body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=ordinary-video"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        webView.navigationDelegate = nil
        try await waitForJavaScriptCondition(
            "window.__vigilYouTubeParityTest != null",
            in: webView
        )

        // WKWebView currently normalizes these top-level History values to
        // null. Preserve what the platform actually stores while the optional
        // marker falls back to the verified in-memory SPA route stack.
        let cases = ["null", "primitive", "array", "date", "map"]
        for historyCase in cases {
            let preparedSignature = try await evaluateJavaScriptRetryingKnownGestureTransition(
                "window.__vigilFixturePrepareHistoryCase('\(historyCase)')",
                in: webView
            ) as? String
            let platformSignature = try XCTUnwrap(preparedSignature)

            webView.evaluateJavaScript(
                "window.__vigilYouTubeParityTest.enterMiniPlayer()",
                completionHandler: nil
            )
            try await waitForJavaScriptCondition(
                """
                location.pathname === '/'
                  && document.documentElement.dataset.fixtureRoute === 'home'
                  && document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
                """,
                in: webView
            )

            webView.evaluateJavaScript(
                "window.__vigilYouTubeParityTest.restoreMiniPlayer()",
                completionHandler: nil
            )
            try await waitForJavaScriptCondition(
                """
                location.pathname === '/watch'
                  && location.search === '?v=ordinary-video'
                  && document.documentElement.dataset.fixtureRoute === 'watch'
                  && !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
                  && document.getElementById('fixture-watch').contains(document.getElementById('fixture-player'))
                  && window.__vigilFixtureFallbackClicks === window.__vigilFixtureFallbackBaseline
                """,
                in: webView
            )
            let fallbackState = try await evaluateJavaScriptRetryingKnownGestureTransition(
                """
                ({
                  fallbackCount: window.__vigilFixtureFallbackClicks
                    - window.__vigilFixtureFallbackBaseline,
                  traversalCalls: window.__vigilFixtureTraversalCalls.join('|'),
                  popCount: window.__vigilFixturePopRoutes.length
                    - window.__vigilFixturePopBaseline,
                  route: `${location.pathname}${location.search}`,
                  playerConnected: document.getElementById('fixture-player')?.isConnected === true
                })
                """,
                in: webView
            ) as? [String: Any]
            XCTAssertEqual(fallbackState?["fallbackCount"] as? Int, 0)
            XCTAssertEqual(fallbackState?["traversalCalls"] as? String, "go:-1")
            XCTAssertEqual(fallbackState?["popCount"] as? Int, 1)
            XCTAssertEqual(fallbackState?["route"] as? String, "/watch?v=ordinary-video")
            XCTAssertEqual(fallbackState?["playerConnected"] as? Bool, true)

            let preservedState = try await evaluateJavaScriptRetryingKnownGestureTransition(
                """
                ({
                  signature: fixtureHistorySignature(history.state),
                  preserved: window.__vigilFixtureHistoryStateIsPreserved(),
                  markerAbsent: !(history.state && typeof history.state === 'object'
                    && Object.prototype.hasOwnProperty.call(
                      history.state,
                      '__vigilYouTubeMiniplayer'
                    ))
                })
                """,
                in: webView
            ) as? [String: Any]
            XCTAssertEqual(preservedState?["signature"] as? String, platformSignature)
            XCTAssertEqual(preservedState?["preserved"] as? Bool, true)
            XCTAssertEqual(preservedState?["markerAbsent"] as? Bool, true)
        }

    }

    @MainActor
    func testYouTubeInteractionExtensionWaitsForReplacementWatchBeforeRestore() async throws {
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(
            source: try youtubeInteractionExtensionSource(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(
            frame: CGRect(x: 0, y: 0, width: 390, height: 844),
            configuration: configuration
        )
        let window = UIWindow(frame: webView.frame)
        let viewController = UIViewController()
        viewController.view.addSubview(webView)
        window.rootViewController = viewController
        window.isHidden = false
        defer {
            window.isHidden = true
            Self.retainedYouTubeMiniplayerFixtures.append((window, webView))
        }

        let loaded = expectation(description: "YouTube replacement-Watch fixture loaded")
        let navigationDelegate = FixtureNavigationDelegate { loaded.fulfill() }
        webView.navigationDelegate = navigationDelegate
        webView.loadHTMLString(
            """
            <html>
              <head>
                <meta name="viewport" content="width=device-width, initial-scale=1">
                <style>
                  [hidden] { display: none !important; }
                  ytm-watch, ytm-player, #player, video {
                    display: block;
                    width: 390px;
                    min-height: 220px;
                    background: black;
                  }
                </style>
              </head>
              <body>
                <button id="fixture-home-control" role="link" aria-label="YouTube Home">Home</button>
                <main id="fixture-home" hidden><h1>Home</h1></main>
                <main id="fixture-route-root">
                  <ytm-watch id="fixture-outgoing-watch" data-owner="outgoing">
                    <ytm-player id="fixture-player"><div id="player"><video playsinline></video></div></ytm-player>
                    <h1>Outgoing Watch</h1>
                  </ytm-watch>
                </main>
                <script>
                  window.__vigilFixtureNewWatchRendered = false;
                  window.__vigilFixturePlayerEnteredOutgoingDuringRestore = false;
                  window.__vigilFixtureFallbackClicks = 0;
                  window.__vigilFixtureGoCalls = [];
                  window.__vigilFixtureOutgoingWatch = document.getElementById('fixture-outgoing-watch');
                  new MutationObserver(() => {
                    if (document.documentElement.dataset.fixtureRoute === 'watch-outgoing'
                        && window.__vigilFixtureOutgoingWatch.contains(
                          document.getElementById('fixture-player')
                        )) {
                      window.__vigilFixturePlayerEnteredOutgoingDuringRestore = true;
                    }
                  }).observe(window.__vigilFixtureOutgoingWatch, {
                    childList: true,
                    subtree: true
                  });

                  const announceFixtureRoute = () => {
                    document.dispatchEvent(new Event('yt-navigate-finish'));
                  };
                  const fixtureNativeHistoryReplaceState = history.replaceState.bind(history);
                  window.__vigilFixturePopTo = destination => {
                    const state = { fixture: 'watch' };
                    const marker = history.state?.__vigilYouTubeMiniplayer;
                    if (marker && typeof marker === 'object') {
                      state.__vigilYouTubeMiniplayer = { ...marker, index: 0 };
                    }
                    fixtureNativeHistoryReplaceState(state, '', destination);
                    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
                  };
                  const fixtureNativeHistoryGo = history.go.bind(history);
                  history.go = delta => {
                    window.__vigilFixtureGoCalls.push(delta);
                    if (delta < 0) {
                      window.__vigilFixturePopTo('/watch?v=ordinary-video');
                      return;
                    }
                    fixtureNativeHistoryGo(delta);
                  };
                  document.getElementById('fixture-home-control').addEventListener('click', event => {
                    event.preventDefault();
                    history.pushState({ fixture: 'home' }, '', '/');
                    document.getElementById('fixture-home').hidden = false;
                    window.__vigilFixtureOutgoingWatch.hidden = true;
                    document.documentElement.dataset.fixtureRoute = 'home';
                    announceFixtureRoute();
                  });
                  document.addEventListener('click', event => {
                    const link = event.target instanceof Element
                      ? event.target.closest('a.yt-simple-endpoint[href]')
                      : null;
                    if (!(link instanceof HTMLAnchorElement) || !link.hidden) return;
                    event.preventDefault();
                    window.__vigilFixtureFallbackClicks += 1;
                    const destination = new URL(link.href, location.href);
                    window.__vigilFixturePopTo(`${destination.pathname}${destination.search}`);
                  });
                  addEventListener('popstate', () => {
                    if (location.pathname !== '/watch') return;
                    const outgoingWatch = window.__vigilFixtureOutgoingWatch;
                    document.getElementById('fixture-home').hidden = true;
                    outgoingWatch.hidden = false;
                    document.documentElement.dataset.fixtureRoute = 'watch-outgoing';
                    announceFixtureRoute();
                    setTimeout(() => {
                      const newWatch = document.createElement('ytm-watch');
                      newWatch.id = 'fixture-new-watch';
                      newWatch.dataset.owner = 'new';
                      newWatch.innerHTML = `
                        <ytm-player id="fixture-replacement-player"></ytm-player>
                        <h1>Newly rendered Watch</h1>
                      `;
                      outgoingWatch.replaceWith(newWatch);
                      window.__vigilFixtureNewWatchRendered = true;
                      document.documentElement.dataset.fixtureRoute = 'watch';
                      announceFixtureRoute();
                    }, 80);
                  });
                  history.replaceState({ fixture: 'watch' }, '', location.href);
                  document.documentElement.dataset.fixtureRoute = 'watch';
                </script>
              </body>
            </html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://m.youtube.com/watch?v=ordinary-video"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        webView.navigationDelegate = nil
        try await waitForJavaScriptCondition(
            "window.__vigilYouTubeParityTest != null",
            in: webView
        )

        webView.evaluateJavaScript(
            "window.__vigilYouTubeParityTest.enterMiniPlayer()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            location.pathname === '/'
              && document.documentElement.dataset.fixtureRoute === 'home'
              && document.documentElement.dataset.vigilYoutubeMiniplayer === 'true'
            """,
            in: webView
        )
        webView.evaluateJavaScript(
            "window.__vigilYouTubeParityTest.restoreMiniPlayer()",
            completionHandler: nil
        )
        try await waitForJavaScriptCondition(
            """
            window.__vigilFixtureNewWatchRendered === true
              && document.documentElement.dataset.fixtureRoute === 'watch'
              && !document.documentElement.hasAttribute('data-vigil-youtube-miniplayer')
              && document.getElementById('fixture-new-watch')?.contains(
                document.getElementById('fixture-player')
              ) === true
              && document.querySelectorAll('ytm-player, ytd-player').length === 1
              && window.__vigilFixtureFallbackClicks === 0
            """,
            in: webView
        )
        let restoredState = try await evaluateJavaScriptRetryingKnownGestureTransition(
            """
            ({
              route: `${location.pathname}${location.search}`,
              outgoingDisconnected: window.__vigilFixtureOutgoingWatch.isConnected === false,
              skippedOutgoing: !window.__vigilFixturePlayerEnteredOutgoingDuringRestore,
              newOwner: document.getElementById('fixture-player')
                ?.closest('ytm-watch, ytd-watch-flexy')?.dataset.owner || '',
              playerConnected: document.getElementById('fixture-player')?.isConnected === true,
              replacementRemoved: document.getElementById('fixture-replacement-player') == null,
              playerCount: document.querySelectorAll('ytm-player, ytd-player').length,
              shellRemoved: document.getElementById('vigil-youtube-miniplayer-shell') == null,
              fallbackClicks: window.__vigilFixtureFallbackClicks,
              goCalls: window.__vigilFixtureGoCalls.join('|')
            })
            """,
            in: webView
        ) as? [String: Any]
        XCTAssertEqual(restoredState?["route"] as? String, "/watch?v=ordinary-video")
        XCTAssertEqual(restoredState?["outgoingDisconnected"] as? Bool, true)
        XCTAssertEqual(restoredState?["skippedOutgoing"] as? Bool, true)
        XCTAssertEqual(restoredState?["newOwner"] as? String, "new")
        XCTAssertEqual(restoredState?["playerConnected"] as? Bool, true)
        XCTAssertEqual(restoredState?["replacementRemoved"] as? Bool, true)
        XCTAssertEqual(restoredState?["playerCount"] as? Int, 1)
        XCTAssertEqual(restoredState?["shellRemoved"] as? Bool, true)
        XCTAssertEqual(restoredState?["fallbackClicks"] as? Int, 0)
        XCTAssertEqual(restoredState?["goCalls"] as? String, "-1")
    }

    #endif

    func testYouTubeInteractionExtensionHasNoMiniplayerPath() throws {
        let source = try youtubeInteractionExtensionSource()
        XCTAssertFalse(source.contains("youtubeMinimize"))
        XCTAssertFalse(source.contains("__vigilExitNativeYouTubeMiniPlayer"))
        XCTAssertFalse(source.localizedCaseInsensitiveContains("miniplayer"))
        XCTAssertTrue(source.contains("enterFullscreen"))
        XCTAssertTrue(source.contains("dy >= 0"))
    }

    @MainActor
    func testYouTubeInteractionExtensionIdentifiersRemainStable() {
        XCTAssertEqual(
            YouTubeSafariSession.contentBlockerIdentifier(appBundleIdentifier: "tech.caseline.vigil.instagram"),
            "tech.caseline.vigil.instagram.shorts-blocker"
        )
        XCTAssertEqual(
            YouTubeSafariSession.interactionExtensionIdentifier(appBundleIdentifier: "tech.caseline.vigil.instagram"),
            "tech.caseline.vigil.instagram.youtube-controls"
        )
    }

    func testYouTubeInteractionExtensionIsNarrowAndKeepsShortsUnavailable() throws {
        let source = try youtubeInteractionExtensionSource()
        let context = try XCTUnwrap(JSContext())
        context.setObject(source, forKeyedSubscript: "source" as NSString)
        context.evaluateScript("new Function(source)")
        XCTAssertNil(context.exception, context.exception?.toString() ?? "YouTube interaction script did not parse")
        XCTAssertTrue(source.contains("recoverFromShorts"))
        XCTAssertTrue(source.contains(
            "const focusedEntryURL = 'https://m.youtube.com/feed/subscriptions'"
        ))
        XCTAssertTrue(source.contains("location.replace(focusedEntryURL)"))
        XCTAssertTrue(source.contains("location.assign(focusedEntryURL)"))
        XCTAssertTrue(source.contains("event.stopImmediatePropagation()"))
        XCTAssertTrue(source.contains("const PLAYER_RESPONSE_PATHS"))
        XCTAssertTrue(source.contains("window.fetch = new Proxy(nativeFetch"))
        XCTAssertTrue(source.contains("window.XMLHttpRequest = class extends NativeXHR"))
        XCTAssertTrue(source.contains("installInitialPlayerResponseGuard()"))
        XCTAssertTrue(source.contains("'ytInitialPlayerResponse'"))
        XCTAssertTrue(source.contains("const MORE_VIDEOS_ATTRIBUTE"))
        XCTAssertTrue(source.contains(".ytp-more-videos-button"))
        XCTAssertTrue(source.contains(".ytp-more-videos-view"))
        XCTAssertTrue(source.contains(".ytp-fullscreen-grid"))
        XCTAssertTrue(source.contains("ytm-fullscreen-related-videos-entry-point-view-model"))
        XCTAssertTrue(source.contains(".ytmFullscreenRelatedVideosEntryPointViewModelHost"))
        XCTAssertTrue(source.contains(".fullscreen-watch-next-entrypoint-wrapper"))
        XCTAssertTrue(source.contains(".fullscreen-more-videos-endpoint"))
        XCTAssertTrue(source.contains(".fullscreen-recommendations-wrapper"))
        XCTAssertTrue(source.contains(".ytFullscreenVideoRecommendationsHost"))
        XCTAssertFalse(source.contains("player-fullscreen-controls .fullscreen-controls"))
        XCTAssertTrue(source.contains("moreVideosAllowedForState"))
        XCTAssertTrue(source.contains(".ytp-ad-skip-button-modern"))
        XCTAssertTrue(source.contains("ytd-in-feed-ad-layout-renderer"))
        XCTAssertFalse(source.contains("'[data-is-ad=\"true\"]'"))
        XCTAssertFalse(source.contains("'.ytp-ad-overlay-container'"))
        XCTAssertFalse(source.contains("'.ytp-ad-player-overlay'"))
        XCTAssertFalse(source.contains("video.playbackRate = 16"))
        XCTAssertFalse(source.contains("video.currentTime = duration"))
        XCTAssertFalse(source.contains("seekTo("))
        XCTAssertFalse(source.contains("loadVideoById("))
        XCTAssertFalse(source.contains("youtubeMinimize"))
        XCTAssertFalse(source.localizedCaseInsensitiveContains("miniplayer"))
        XCTAssertFalse(source.contains("accounts.google.com"))
        XCTAssertEqual(
            SocialWebViewStore.youtubePlaybackPositionNamespace,
            "VigilSocial.youtube.position.v2"
        )

        let manifestURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("VigilYouTubeInteractionExtension/Resources/manifest.json")
        let data = try Data(contentsOf: manifestURL)
        let manifest = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(
            manifest["host_permissions"] as? [String],
            ["https://youtube.com/*", "https://www.youtube.com/*", "https://m.youtube.com/*"]
        )
        let contentScripts = try XCTUnwrap(manifest["content_scripts"] as? [[String: Any]])
        XCTAssertEqual(contentScripts.count, 1)
        XCTAssertEqual(contentScripts[0]["all_frames"] as? Bool, false)
    }

    #if DEBUG
    func testYouTubeWKAuthDiagnosticRequiresExplicitLaunchOptIn() {
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.isRequested(arguments: []))
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.isRequested(arguments: ["VigilSocial"]))
        XCTAssertTrue(YouTubeWKAuthDiagnosticActivation.isRequested(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument
        ]))
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.shouldAutoLoad(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.autoLoadArgument
        ]))
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.shouldAutoLoad(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument
        ]))
        XCTAssertTrue(YouTubeWKAuthDiagnosticActivation.shouldAutoLoad(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument,
            YouTubeWKAuthDiagnosticActivation.autoLoadArgument
        ]))
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.startsAtYouTube(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument,
            YouTubeWKAuthDiagnosticActivation.youtubeEntryArgument
        ]))
        XCTAssertTrue(YouTubeWKAuthDiagnosticActivation.startsAtYouTube(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument,
            YouTubeWKAuthDiagnosticActivation.autoLoadArgument,
            YouTubeWKAuthDiagnosticActivation.youtubeEntryArgument
        ]))
        XCTAssertFalse(YouTubeWKAuthDiagnosticActivation.usesUnsupportedSafariSuffix(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument,
            YouTubeWKAuthDiagnosticActivation.safariSuffixArgument
        ]))
        XCTAssertTrue(YouTubeWKAuthDiagnosticActivation.usesUnsupportedSafariSuffix(arguments: [
            "VigilSocial",
            YouTubeWKAuthDiagnosticActivation.optInArgument,
            YouTubeWKAuthDiagnosticActivation.autoLoadArgument,
            YouTubeWKAuthDiagnosticActivation.safariSuffixArgument
        ]))
    }

    @MainActor
    func testYouTubeWKAuthDiagnosticUsesPristinePersistentScriptlessWebKit() {
        let session = YouTubeWKAuthDiagnosticSession()
        let configuration = session.webView.configuration

        XCTAssertTrue(configuration.websiteDataStore.isPersistent)
        XCTAssertTrue(configuration.userContentController.userScripts.isEmpty)
        XCTAssertNil(configuration.applicationNameForUserAgent)
        XCTAssertNil(session.webView.customUserAgent)

        let suffixSession = YouTubeWKAuthDiagnosticSession(
            useUnsupportedSafariSuffix: true
        )
        XCTAssertEqual(
            suffixSession.webView.configuration.applicationNameForUserAgent,
            "Version/17.0 Safari/605.1.15"
        )
        XCTAssertNil(suffixSession.webView.customUserAgent)
    }

    @MainActor
    func testYouTubeWKAuthDiagnosticLogsOnlySanitizedHostsAndKeepsShortsBlocked() throws {
        let sensitive = try XCTUnwrap(URL(
            string: "https://accounts.google.com/ServiceLogin/private/email@example.com?code=secret#token"
        ))
        let label = YouTubeWKAuthDiagnosticSession.safeHostLabel(for: sensitive)

        XCTAssertEqual(label, "accounts.google.com")
        XCTAssertFalse(label.contains("private"))
        XCTAssertFalse(label.contains("email"))
        XCTAssertFalse(label.contains("secret"))
        XCTAssertTrue(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: sensitive))
        XCTAssertTrue(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID?ssdc=private")
        )))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/Other")
        )))
        XCTAssertTrue(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/SetSID/")
        )))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.youtube.com/accounts/%53etSID")
        )))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://m.youtube.com/shorts/audit")
        )))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://example.com/ServiceLogin")
        )))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: try XCTUnwrap(
            URL(string: "https://accounts.google.com:8443/ServiceLogin")
        )))
        let aboutBlank = try XCTUnwrap(URL(string: "about:blank"))
        XCTAssertFalse(YouTubeWKAuthDiagnosticSession.allowsNavigation(to: aboutBlank))
        XCTAssertTrue(YouTubeWKAuthDiagnosticSession.allowsNavigation(
            to: aboutBlank,
            permitsAboutBlankSubframe: true
        ))
    }
    #endif

    private func youtubeInteractionExtensionSource() throws -> String {
        let sourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("VigilYouTubeInteractionExtension/Resources/youtube-parity.js")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    @MainActor
    private func waitForMediaCandidate(
        in messageHandler: FixtureScriptMessageHandler,
        excludingToken: String? = nil,
        kind: String? = nil
    ) async throws -> [String: Any] {
        for _ in 0..<120 {
            if let candidate = messageHandler.messages.first(where: {
                guard $0["type"] as? String == "mediaCandidate" else { return false }
                if let excludingToken, $0["token"] as? String == excludingToken { return false }
                if let kind, $0["kind"] as? String != kind { return false }
                return true
            }) {
                return candidate
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(
            domain: "VigilSocialTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for a mediaCandidate bridge message"]
        )
    }

    @MainActor
    private func evaluateJavaScriptWithCompletion(
        _ source: String,
        in webView: WKWebView
    ) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(source) { value, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: value)
                }
            }
        }
    }

    @MainActor
    private func evaluateJavaScriptRetryingKnownGestureTransition(
        _ source: String,
        in webView: WKWebView
    ) async throws -> Any? {
        var lastTransientFailure: Error?
        for _ in 0..<120 {
            do {
                return try await evaluateJavaScriptWithCompletion(source, in: webView)
            } catch {
                guard isKnownGestureDeinitTransition(error) else {
                    throw error
                }
                lastTransientFailure = error
                try await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        throw NSError(
            domain: "VigilSocialTests",
            code: 3,
            userInfo: [
                NSLocalizedDescriptionKey: """
                Gesture transition retries were exhausted for JavaScript: \(source). \
                Last failure: \(String(describing: lastTransientFailure))
                """
            ]
        )
    }

    private func isKnownGestureDeinitTransition(_ error: Error) -> Bool {
        let description = String(describing: error)
        return description.contains("InvalidTransition {")
            && description.contains("phase: idle")
            && description.contains("targetPhase: failed(deinit)")
    }

    @MainActor
    private func waitForJavaScriptCondition(
        _ condition: String,
        in webView: WKWebView
    ) async throws {
        var transientFailureCount = 0
        var lastTransientFailure = ""
        for _ in 0..<120 {
            do {
                if try await evaluateJavaScriptWithCompletion(condition, in: webView) as? Bool == true {
                    return
                }
            } catch {
                guard isKnownGestureDeinitTransition(error) else {
                    throw error
                }
                transientFailureCount += 1
                lastTransientFailure = String(describing: error)
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let diagnostic = try? await evaluateJavaScriptWithCompletion(
            """
            JSON.stringify({
              href: location.href,
              route: document.documentElement.dataset.fixtureRoute || '',
              mini: document.documentElement.dataset.vigilYoutubeMiniplayer || '',
              historyLength: history.length,
              historyState: history.state,
              popRoutes: window.__vigilFixturePopRoutes || [],
              traversalCalls: window.__vigilFixtureTraversalCalls || [],
              goCalls: window.__vigilFixtureGoCalls || [],
              shellClicks: window.__vigilFixtureShellClicks || 0
            })
            """,
            in: webView
        )
        throw NSError(
            domain: "VigilSocialTests",
            code: 2,
            userInfo: [
                NSLocalizedDescriptionKey: """
                Timed out waiting for JavaScript condition: \(condition). \
                Known transient gesture failures: \(transientFailureCount). \
                Last transient failure: \(lastTransientFailure). \
                Diagnostic: \(String(describing: diagnostic))
                """
            ]
        )
    }

    @MainActor
    private func resolve(
        _ candidate: [String: Any],
        as verdict: ContentSafetyVerdict,
        in webView: WKWebView
    ) async throws {
        let arguments = [
            try XCTUnwrap(candidate["documentID"] as? String),
            try XCTUnwrap(candidate["id"] as? String),
            try XCTUnwrap(candidate["token"] as? String),
            verdict.rawValue
        ]
        let encoded = try JSONSerialization.data(withJSONObject: arguments)
        let literal = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        _ = try await webView.evaluateJavaScript("window.__vigilResolveMedia(...\(literal))")
    }

    private func javaScriptLiteral(_ value: String) throws -> String {
        let encoded = try JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed)
        return try XCTUnwrap(String(data: encoded, encoding: .utf8))
    }
}

private struct StubMediaClassifier: MediaSafetyClassifying {
    let verdict: ContentSafetyVerdict
    func classify(imageData: Data) async -> ContentSafetyVerdict { verdict }
}

private struct DelayedMediaClassifier: MediaSafetyClassifying {
    func classify(imageData: Data) async -> ContentSafetyVerdict {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        return .safe
    }
}

private actor HangingFirstFourMediaClassifier: MediaSafetyClassifying {
    private var callCount = 0

    func classify(imageData: Data) async -> ContentSafetyVerdict {
        callCount += 1
        if callCount <= 4 {
            await withCheckedContinuation { continuation in
                DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(400)) {
                    continuation.resume()
                }
            }
        }
        return .safe
    }
}

private final class FixtureScriptMessageHandler: NSObject, WKScriptMessageHandler {
    private(set) var messages: [[String: Any]] = []

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        messages.append(body)
    }
}

private final class FixtureNavigationDelegate: NSObject, WKNavigationDelegate {
    private let completion: () -> Void
    private var completed = false

    init(completion: @escaping () -> Void) {
        self.completion = completion
    }

    private func completeOnce() {
        guard !completed else { return }
        completed = true
        completion()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        completeOnce()
    }

    func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation?,
        withError error: Error
    ) {
        completeOnce()
    }
}

private final class RoutePolicyNavigationDelegate: NSObject, WKNavigationDelegate {
    private let expectedHost: String
    private let expectedPath: String
    private let expectation: XCTestExpectation
    private(set) var matchedURL: URL?

    init(expectedHost: String, expectedPath: String, expectation: XCTestExpectation) {
        self.expectedHost = expectedHost
        self.expectedPath = expectedPath
        self.expectation = expectation
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              navigationAction.targetFrame?.isMainFrame != false,
              url.host == expectedHost,
              url.path == expectedPath else {
            decisionHandler(.allow)
            return
        }
        if matchedURL == nil {
            matchedURL = url
            expectation.fulfill()
        }
        decisionHandler(.cancel)
    }
}
