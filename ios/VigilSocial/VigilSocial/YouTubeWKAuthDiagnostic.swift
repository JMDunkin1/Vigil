#if DEBUG
import OSLog
import SwiftUI
import WebKit

enum YouTubeWKAuthDiagnosticActivation {
    static let optInArgument = "--vigil-youtube-wk-auth-diagnostic"
    static let autoLoadArgument = "--vigil-youtube-wk-auth-diagnostic-autoload"
    static let youtubeEntryArgument = "--vigil-youtube-wk-auth-diagnostic-youtube-entry"
    static let safariSuffixArgument = "--vigil-youtube-wk-auth-diagnostic-safari-suffix"

    static func isRequested(arguments: [String]) -> Bool {
        arguments.contains(optInArgument)
    }

    static func shouldAutoLoad(arguments: [String]) -> Bool {
        arguments.contains(optInArgument) && arguments.contains(autoLoadArgument)
    }

    static func startsAtYouTube(arguments: [String]) -> Bool {
        shouldAutoLoad(arguments: arguments) && arguments.contains(youtubeEntryArgument)
    }

    static func usesUnsupportedSafariSuffix(arguments: [String]) -> Bool {
        shouldAutoLoad(arguments: arguments) && arguments.contains(safariSuffixArgument)
    }
}

@MainActor
final class YouTubeWKAuthDiagnosticSession: NSObject, ObservableObject {
    struct Event: Identifiable, Equatable {
        let id = UUID()
        let message: String
    }

    private static let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "tech.caseline.vigil.youtube",
        category: "WKAuthDiagnostic"
    )
    private static let signInURL = URL(
        string: "https://accounts.google.com/ServiceLogin?service=youtube"
    )!
    private static let youtubeSignInURL = URL(string: "https://m.youtube.com/signin")!

    @Published private(set) var events: [Event] = []

    let webView: WKWebView
    private let startURL: URL

    init(
        autoLoad: Bool = false,
        startAtYouTube: Bool = false,
        useUnsupportedSafariSuffix: Bool = false
    ) {
        startURL = startAtYouTube ? Self.youtubeSignInURL : Self.signInURL
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = WKUserContentController()
        let agentLabel: String
        if useUnsupportedSafariSuffix {
            // TinyTube documents this Safari-looking application-name suffix as
            // an unsupported workaround. This Debug path compares that same
            // YouTube-only production exception with WebKit's default identity.
            configuration.applicationNameForUserAgent =
                YouTubeWebCompatibility.unsupportedSafariApplicationNameSuffix
            agentLabel = "unsupported-safari-suffix"
        } else {
            agentLabel = "default-webkit"
        }

        webView = WKWebView(frame: .zero, configuration: configuration)
        // Never replace WebKit's user agent. The explicit comparison above may
        // append only its documented suffix; the default identity stays intact.
        webView.customUserAgent = nil
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        record("ready agent=\(agentLabel) store=persistent scripts=none")
        if autoLoad {
            record("autoload enabled=true")
            loadSignInRoute()
        }
    }

    func loadSignInRoute() {
        record("requested host=\(Self.safeHostLabel(for: startURL))")
        webView.load(URLRequest(url: startURL))
    }

    func reload() {
        guard webView.url != nil else {
            loadSignInRoute()
            return
        }
        record("reload host=\(Self.safeHostLabel(for: webView.url))")
        webView.reload()
    }

    func stop() {
        webView.stopLoading()
        record("stopped")
    }

    static func allowsNavigation(to url: URL, permitsAboutBlankSubframe: Bool = false) -> Bool {
        if url.absoluteString == "about:blank" {
            return permitsAboutBlankSubframe
        }
        if SocialService.isYouTubeSessionHandoffURL(url) {
            // YouTube's first-party sign-in handshake can redirect through this
            // exact endpoint to establish its own site session. Keep the probe's
            // exception path-scoped instead of widening the production allowlist.
            return true
        }
        return SocialService.youtube.allowsNavigation(to: url)
            && !SocialService.youtube.isRestrictedSurface(url)
    }

    static func safeHostLabel(for url: URL?) -> String {
        guard let url,
              url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              !host.isEmpty else { return "invalid" }
        return url.port.map { "\(host):\($0)" } ?? host
    }

    private func record(_ message: String) {
        let event = Event(message: message)
        events.append(event)
        if events.count > 80 { events.removeFirst(events.count - 80) }
        Self.logger.notice("\(message, privacy: .public)")
    }

    private static func navigationKind(_ value: WKNavigationType) -> String {
        switch value {
        case .linkActivated: "link"
        case .formSubmitted: "form"
        case .backForward: "history"
        case .reload: "reload"
        case .formResubmitted: "form-resubmit"
        case .other: "other"
        @unknown default: "unknown"
        }
    }
}

extension YouTubeWKAuthDiagnosticSession: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            record("cancelled reason=missing-url")
            decisionHandler(.cancel, preferences)
            return
        }

        let host = Self.safeHostLabel(for: url)
        let isSubframe = navigationAction.targetFrame?.isMainFrame == false
        let frame = navigationAction.targetFrame == nil
            ? "popup"
            : isSubframe ? "subframe" : "main"
        let kind = Self.navigationKind(navigationAction.navigationType)
        guard Self.allowsNavigation(
            to: url,
            permitsAboutBlankSubframe: isSubframe
        ) else {
            record("cancelled host=\(host) frame=\(frame) kind=\(kind) reason=allowlist")
            decisionHandler(.cancel, preferences)
            return
        }

        record("allowed host=\(host) frame=\(frame) kind=\(kind)")
        decisionHandler(.allow, preferences)
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        let host = Self.safeHostLabel(for: navigationResponse.response.url)
        let status = (navigationResponse.response as? HTTPURLResponse)?.statusCode ?? 0
        record("response host=\(host) status=\(status) main=\(navigationResponse.isForMainFrame)")
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        record("finished host=\(Self.safeHostLabel(for: webView.url))")
    }

    func webView(
        _ webView: WKWebView,
        didReceiveServerRedirectForProvisionalNavigation navigation: WKNavigation?
    ) {
        record("server-redirect host=\(Self.safeHostLabel(for: webView.url))")
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        recordFailure(error, phase: "provisional")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        recordFailure(error, phase: "committed")
    }

    private func recordFailure(_ error: Error, phase: String) {
        let value = error as NSError
        // Localized descriptions and failing-URL keys can contain private query
        // parameters, so diagnostics retain only the public error domain/code.
        record("failed phase=\(phase) domain=\(value.domain) code=\(value.code)")
    }
}

extension YouTubeWKAuthDiagnosticSession: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url,
              Self.allowsNavigation(to: url) else {
            record("cancelled-popup host=\(Self.safeHostLabel(for: navigationAction.request.url))")
            return nil
        }
        record("redirected-popup host=\(Self.safeHostLabel(for: url))")
        webView.load(navigationAction.request)
        return nil
    }
}

struct YouTubeWKAuthDiagnosticView: View {
    @StateObject private var session: YouTubeWKAuthDiagnosticSession
    private let usesUnsupportedSafariSuffix: Bool

    init(
        autoLoad: Bool = false,
        startAtYouTube: Bool = false,
        useUnsupportedSafariSuffix: Bool = false
    ) {
        usesUnsupportedSafariSuffix = useUnsupportedSafariSuffix
        _session = StateObject(
            wrappedValue: YouTubeWKAuthDiagnosticSession(
                autoLoad: autoLoad,
                startAtYouTube: startAtYouTube,
                useUnsupportedSafariSuffix: useUnsupportedSafariSuffix
            )
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Label("Debug-only YouTube sign-in probe", systemImage: "stethoscope")
                    .font(.headline)
                Text(usesUnsupportedSafariSuffix
                    ? "Unsupported Safari-suffix comparison"
                    : "Pristine WebKit user agent")
                    .font(.subheadline.weight(.semibold))
                Text("This probe records host names, response codes, and navigation types only. It never reads cookies, page text, form values, or credentials. You do not need to enter credentials; stop when Google shows its result.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Load YouTube sign-in route") { session.loadSignInRoute() }
                        .buttonStyle(.borderedProminent)
                    Button("Reload") { session.reload() }
                        .buttonStyle(.bordered)
                    Button("Stop") { session.stop() }
                        .buttonStyle(.bordered)
                }
            }
            .padding()

            Divider()

            YouTubeWKAuthDiagnosticWebView(webView: session.webView)
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 4) {
                    ForEach(session.events) { event in
                        Text(event.message)
                            .font(.caption.monospaced())
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(10)
            }
            .frame(height: 120)
            .background(Color(.secondarySystemBackground))
        }
    }
}

private struct YouTubeWKAuthDiagnosticWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
