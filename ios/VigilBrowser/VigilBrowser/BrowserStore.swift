import Combine
import Foundation
import WebKit

@MainActor
final class BrowserStore: NSObject, ObservableObject {
    @Published var address = ""
    @Published private(set) var title = "Vigil Browser"
    @Published private(set) var status = "Protected"
    @Published private(set) var isLoading = false
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false

    let webView: WKWebView
    private var rules: FilterRules
    private var blocklist: PhoneBlocklistIndex?
    private var blocklistIntegrityValid = true
    private let rulesProvider: any FilterRulesProviding
    private let mediaClassifier: any MediaSafetyClassifying
    private let textClassifier: any PageTextSafetyClassifying
    private var observations: [NSKeyValueObservation] = []
    private var contentSafetyBridge: BrowserScriptMessageBridge?
    private var textInspections: [String: BrowserTextInspection] = [:]
    private static let contentSafetyWorld = WKContentWorld.world(name: "VigilContentSafety")

    override convenience init() { self.init(rulesProvider: AppGroupFilterRulesProvider()) }

    init(
        rulesProvider: any FilterRulesProviding,
        mediaClassifier: any MediaSafetyClassifying = AppleSensitiveMediaClassifier(),
        textClassifier: any PageTextSafetyClassifying = ConservativePageTextClassifier()
    ) {
        self.rulesProvider = rulesProvider
        self.mediaClassifier = mediaClassifier
        self.textClassifier = textClassifier
        rules = rulesProvider.currentRules()
        do { blocklist = try rulesProvider.currentBlocklist() }
        catch { blocklist = nil; blocklistIntegrityValid = false }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.preferences.isFraudulentWebsiteWarningEnabled = true
        let bridge = BrowserScriptMessageBridge()
        configuration.userContentController.add(
            bridge,
            contentWorld: Self.contentSafetyWorld,
            name: "vigilContentSafety"
        )
        let safetySource = ContentSafetyScript.load() ?? ContentSafetyScript.failClosedBootstrap
        configuration.userContentController.addUserScript(WKUserScript(
            source: safetySource,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false,
            in: Self.contentSafetyWorld
        ))
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        bridge.handler = { [weak self] message in
            Task { @MainActor in self?.handleContentSafety(message) }
        }
        contentSafetyBridge = bridge
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        observeWebView()
        installContentRules()
        open(URL(string: "https://www.google.com/?safe=active")!)
    }

    func submitAddress() {
        let input = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else { return }
        if let direct = URL(string: input), direct.scheme != nil { open(direct); return }
        if input.contains("."), !input.contains(" "), let direct = URL(string: "https://\(input)") {
            open(direct)
            return
        }
        var components = URLComponents(string: "https://www.google.com/search")!
        components.queryItems = [URLQueryItem(name: "q", value: input), URLQueryItem(name: "safe", value: "active")]
        if let url = components.url { open(url) }
    }

    func open(_ url: URL) {
        switch NavigationFilter(rules: rules, blocklist: blocklist, blocklistIntegrityValid: blocklistIntegrityValid).decide(url) {
        case let .allow(filtered): webView.load(URLRequest(url: filtered))
        case let .block(reason): showBlocked(reason: reason, attemptedURL: url)
        }
    }

    func reloadRules() {
        rules = rulesProvider.currentRules()
        do { blocklist = try rulesProvider.currentBlocklist(); blocklistIntegrityValid = true }
        catch { blocklist = nil; blocklistIntegrityValid = false }
        installContentRules()
        if let current = webView.url { open(current) }
    }

    func goBack() { if webView.canGoBack { webView.goBack() } }
    func goForward() { if webView.canGoForward { webView.goForward() } }
    func reload() { webView.reload() }

    private func observeWebView() {
        observations = [
            webView.observe(\.title, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.title = view.title ?? "Vigil Browser" }
            },
            webView.observe(\.url, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in self?.address = view.url?.absoluteString ?? "" }
            },
            webView.observe(\.isLoading, options: [.new]) { [weak self] view, _ in
                Task { @MainActor in
                    self?.isLoading = view.isLoading
                    self?.canGoBack = view.canGoBack
                    self?.canGoForward = view.canGoForward
                }
            }
        ]
    }

    private func installContentRules() {
        let domains = rules.blockedHosts.map { "*\($0)" }
        guard !domains.isEmpty else {
            webView.configuration.userContentController.removeAllContentRuleLists()
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: [[
                "trigger": ["url-filter": ".*", "if-domain": domains],
                "action": ["type": "block"]
              ]]),
              let json = String(data: data, encoding: .utf8) else { return }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "VigilBrowser-\(rules.revision)", encodedContentRuleList: json) { [weak self] list, _ in
            guard let list else { return }
            Task { @MainActor in
                self?.webView.configuration.userContentController.removeAllContentRuleLists()
                self?.webView.configuration.userContentController.add(list)
            }
        }
    }

    private func showBlocked(reason: String, attemptedURL: URL) {
        status = reason
        let escapedReason = reason.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        let escapedURL = attemptedURL.absoluteString.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;")
        let html = """
        <!doctype html><meta name='viewport' content='width=device-width'><style>
        body{font:17px -apple-system;margin:0;display:grid;place-items:center;min-height:100vh;background:#111;color:#fff}main{max-width:32rem;padding:2rem;text-align:center}small{color:#aaa;overflow-wrap:anywhere}
        </style><main><h1>Page blocked</h1><p>\(escapedReason)</p><small>\(escapedURL)</small></main>
        """
        webView.loadHTMLString(html, baseURL: nil)
    }

    private func handleContentSafety(_ message: WKScriptMessage) {
        guard message.webView === webView,
              let body = message.body as? [String: Any],
              let frameID = body["frameID"] as? String, !frameID.isEmpty,
              let type = body["type"] as? String else { return }
        switch type {
        case "classifyMedia": classifyMedia(body, in: message.frameInfo)
        case "classifyText": classifyText(body, frameID: frameID, in: message.frameInfo)
        default: break
        }
    }

    private func classifyMedia(_ body: [String: Any], in frame: WKFrameInfo) {
        guard let id = body["id"] as? String, !id.isEmpty,
              let token = body["token"] as? String, !token.isEmpty else { return }
        let inlineData = ContentSafetyPayload.inlineMedia(from: body)
        Task { [weak self] in
            guard let self else { return }
            let verdict: ContentSafetyVerdict
            if let inlineData { verdict = await self.mediaClassifier.classify(imageData: inlineData) }
            else { verdict = .unknown }
            self.resolveContentSafety(
                "globalThis.__vigilResolveMedia?.(id, token, verdict)",
                arguments: ["id": id, "token": token, "verdict": verdict.rawValue],
                in: frame
            )
        }
    }

    private func classifyText(_ body: [String: Any], frameID: String, in frame: WKFrameInfo) {
        guard let revision = body["revision"] as? String,
              let index = body["index"] as? Int,
              let total = body["total"] as? Int,
              let text = body["text"] as? String,
              total > 0, total <= 32, index >= 0, index < total else { return }
        let wasTruncated = body["wasTruncated"] as? Bool ?? true
        let inspectionKey = "\(frameID):\(revision)"
        var inspection = textInspections[inspectionKey]
            ?? BrowserTextInspection(chunks: [:], total: total, wasTruncated: wasTruncated)
        guard inspection.total == total else { return }
        inspection.chunks[index] = text
        textInspections[inspectionKey] = inspection
        guard inspection.chunks.count == total else { return }
        textInspections.removeValue(forKey: inspectionKey)
        let pageText = (0..<total).compactMap { inspection.chunks[$0] }.joined()
        Task { [weak self] in
            guard let self else { return }
            let verdict = await self.textClassifier.classify(pageText: pageText, wasTruncated: inspection.wasTruncated)
            self.resolveContentSafety(
                "globalThis.__vigilResolvePageText?.(revision, verdict)",
                arguments: ["revision": revision, "verdict": verdict.rawValue],
                in: frame
            )
            if verdict == .sensitive { self.status = "Sensitive page content was hidden" }
        }
    }

    private func resolveContentSafety(_ script: String, arguments: [String: Any], in frame: WKFrameInfo) {
        webView.callAsyncJavaScript(
            script,
            arguments: arguments,
            in: frame,
            in: Self.contentSafetyWorld
        ) { _ in }
    }
}

private struct BrowserTextInspection {
    var chunks: [Int: String]
    let total: Int
    let wasTruncated: Bool
}

private final class BrowserScriptMessageBridge: NSObject, WKScriptMessageHandler {
    var handler: ((WKScriptMessage) -> Void)?
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        handler?(message)
    }
}

extension BrowserStore: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if url.scheme == "about" || (url.scheme == nil && url.host == nil) { decisionHandler(.allow); return }
        switch NavigationFilter(rules: rules, blocklist: blocklist, blocklistIntegrityValid: blocklistIntegrityValid).decide(url) {
        case let .allow(filtered):
            if filtered != url {
                decisionHandler(.cancel)
                webView.load(URLRequest(url: filtered))
            } else { decisionHandler(.allow) }
        case let .block(reason):
            decisionHandler(.cancel)
            showBlocked(reason: reason, attemptedURL: url)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) { isLoading = true }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        isLoading = false
        status = "Protected"
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        isLoading = false
        status = error.localizedDescription
    }
}

extension BrowserStore: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { open(url) }
        return nil
    }
}
