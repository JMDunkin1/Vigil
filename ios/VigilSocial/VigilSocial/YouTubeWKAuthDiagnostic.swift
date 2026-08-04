#if DEBUG
import OSLog
import SwiftUI
import WebKit

enum YouTubeWKAuthDiagnosticActivation {
    static let optInArgument = "--vigil-youtube-wk-auth-diagnostic"

    static func isRequested(arguments: [String]) -> Bool {
        arguments.contains(optInArgument)
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

    @Published private(set) var events: [Event] = []

    let webView: WKWebView

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.userContentController = WKUserContentController()

        webView = WKWebView(frame: .zero, configuration: configuration)
        // Any custom user agent or application-name suffix would alter the
        // experiment. Keep WebKit's truthful default identity intact.
        webView.customUserAgent = nil
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsLinkPreview = false

        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        record("ready agent=default-webkit store=persistent scripts=none")
    }

    func loadSignInRoute() {
        record("requested host=\(Self.safeHostLabel(for: Self.signInURL))")
        webView.load(URLRequest(url: Self.signInURL))
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

    static func allowsNavigation(to url: URL) -> Bool {
        if url.scheme?.lowercased() == "https",
           url.port == nil || url.port == 443,
           url.host?.lowercased() == "accounts.youtube.com" {
            // YouTube's first-party sign-in handshake can redirect through this
            // exact endpoint to establish its own site session. Keep the probe's
            // exception path-scoped instead of widening the production allowlist.
            return url.path == "/accounts/SetSID"
                || url.path == "/accounts/SetSID/"
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
        let frame = navigationAction.targetFrame == nil
            ? "popup"
            : navigationAction.targetFrame?.isMainFrame == true ? "main" : "subframe"
        let kind = Self.navigationKind(navigationAction.navigationType)
        guard Self.allowsNavigation(to: url) else {
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
    @StateObject private var session = YouTubeWKAuthDiagnosticSession()

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                Label("Debug-only YouTube sign-in probe", systemImage: "stethoscope")
                    .font(.headline)
                Text("Pristine WebKit user agent")
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
