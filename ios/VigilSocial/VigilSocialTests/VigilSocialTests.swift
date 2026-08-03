import XCTest
import JavaScriptCore
import UIKit
import WebKit
@testable import VigilSocial

final class VigilSocialTests: XCTestCase {
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
        XCTAssertTrue(instagram.contains("setTimeout(() => scheduleHealth(0, true), 7000)"))
        XCTAssertFalse(instagram.contains(
            "window.__vigilBridge({ type: 'health', state: 'ready', detail: '' });"
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
        XCTAssertTrue(youtubeStart.contains("content scripts completely out of that credential surface"))
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
        XCTAssertTrue(script.contains("data-vigil-feature-reels=\"blocked\""))
        XCTAssertTrue(script.contains("data-vigil-feature-shopping=\"blocked\""))
        XCTAssertTrue(script.contains("hasExactLeafLabel(container, 'sponsored')"))
        XCTAssertTrue(script.contains("navigation.insertBefore(reelsItem, directItem)"))
        XCTAssertTrue(script.contains("feature === 'suggested' && isBlocked('explore')"))
        XCTAssertTrue(script.contains("data-vigil-instagram-route-feature=\"reels\""))
        XCTAssertTrue(script.contains("html[data-vigil-route-policy-blocked] body"))
        XCTAssertTrue(script.contains("const routePolicyWatchdog = setInterval"))
        XCTAssertTrue(script.contains("data-vigil-feature-suggested') !== 'available'"))
        XCTAssertFalse(script.contains("location.replace('/accounts/login/')"))
        XCTAssertTrue(script.contains("removeAttribute('data-vigil-hidden-feature')"))
        XCTAssertTrue(script.contains("__vigilAudioPreferred = configuredAudioPreference"))
        XCTAssertTrue(script.contains("vigilMutedByPreference"))
        XCTAssertFalse(script.contains("window.__vigilAudioPreferred && hasGesture"))
        XCTAssertTrue(script.contains("data-vigil-instagram-comments-sheet=\"true\""))
        XCTAssertTrue(script.contains("height: 52dvh !important"))
        XCTAssertTrue(script.contains("const isInstagramCommentsDialog"))
        XCTAssertTrue(script.contains("normalizeCommentSheets()"))
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
            """
            <html><body>
              <main><article><button>Open comments</button></article></main>
              <section id="comments" role="dialog" aria-label="Comments"
                style="position:fixed;inset:0;width:100vw;height:100vh">
                <h2>Comments</h2>
                <textarea placeholder="Add a comment…"></textarea>
              </section>
            </body></html>
            """,
            baseURL: try XCTUnwrap(URL(string: "https://www.instagram.com/p/fixture/"))
        )
        await fulfillment(of: [loaded], timeout: 5)
        try await waitForJavaScriptCondition(
            "document.getElementById('comments')?.dataset.vigilInstagramCommentsSheet === 'true'",
            in: webView
        )

        let geometry = try await webView.evaluateJavaScript(
            """
            (() => {
              const rect = document.getElementById('comments').getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, viewport: innerHeight };
            })()
            """
        ) as? [String: Any]
        let top = try XCTUnwrap(geometry?["top"] as? Double)
        let bottom = try XCTUnwrap(geometry?["bottom"] as? Double)
        let viewport = try XCTUnwrap(geometry?["viewport"] as? Double)
        XCTAssertEqual(bottom, viewport, accuracy: 2)
        XCTAssertGreaterThan(top, viewport * 0.4)
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
        XCTAssertNotNil(youtube.scrollView.refreshControl)
        XCTAssertEqual(youtube.scrollView.keyboardDismissMode, .interactive)
        let scripts = youtube.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.count, 4)
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

    @MainActor
    func testNativeShellUsesFailClosedRefreshAndInstagramEdgeBack() {
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

        let edgeBackGestures = webView.gestureRecognizers?.compactMap {
            $0 as? UIScreenEdgePanGestureRecognizer
        }.filter { $0.edges == .left } ?? []
        XCTAssertEqual(edgeBackGestures.count, 1)
        XCTAssertEqual(edgeBackGestures.first?.maximumNumberOfTouches, 1)

        store.setSurface(
            SocialSurfaceState(route: "feed", refreshEligible: true, blocksRefresh: false),
            for: .instagram
        )
        XCTAssertEqual(refreshControl?.isEnabled, true)
        XCTAssertTrue(webView.scrollView.alwaysBounceVertical)

        store.setSurface(
            SocialSurfaceState(route: "story", refreshEligible: false, blocksRefresh: true),
            for: .instagram
        )
        XCTAssertEqual(refreshControl?.isEnabled, false)
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
        XCTAssertNil(SocialWebViewStore.validatedPopupRequest(
            URLRequest(url: try XCTUnwrap(URL(string: "https://example.com/"))),
            for: .instagram
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
    private func waitForJavaScriptCondition(
        _ condition: String,
        in webView: WKWebView
    ) async throws {
        for _ in 0..<120 {
            if try await webView.evaluateJavaScript(condition) as? Bool == true {
                return
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(
            domain: "VigilSocialTests",
            code: 2,
            userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for JavaScript condition: \(condition)"]
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
