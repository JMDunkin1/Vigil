import Combine
import Foundation
import WebKit

@MainActor
final class SocialWebViewStore: NSObject, ObservableObject {
    @Published private(set) var selectedService: SocialService
    @Published private(set) var health: [SocialService: AdapterHealth] = [:]
    @Published private(set) var audioPreferences: [SocialService: Bool] = [:]

    let fixedService: SocialService
    private let defaults: UserDefaults
    private let loadInitialPages: Bool
    private let mediaClassifier: any MediaSafetyClassifying
    private let textClassifier: any PageTextSafetyClassifying
    private let mediaLoader: any MediaDataLoading
    private var webViews: [SocialService: WKWebView] = [:]
    private var serviceByWebView: [ObjectIdentifier: SocialService] = [:]
    private var messageBridges: [SocialService: ScriptMessageBridge] = [:]
    private var textInspections: [SocialService: [String: TextInspection]] = [:]

    init(
        defaults: UserDefaults = .standard,
        fixedService: SocialService? = nil,
        bundle: Bundle = .main,
        loadInitialPages: Bool = true,
        mediaClassifier: any MediaSafetyClassifying = AppleSensitiveMediaClassifier(),
        textClassifier: any PageTextSafetyClassifying = ConservativePageTextClassifier(),
        mediaLoader: any MediaDataLoading = EphemeralMediaDataLoader()
    ) {
        let configured = fixedService
            ?? (bundle.object(forInfoDictionaryKey: "VigilService") as? String).flatMap(SocialService.init(rawValue:))
            ?? .youtube
        self.fixedService = configured
        self.selectedService = configured
        self.defaults = defaults
        self.loadInitialPages = loadInitialPages
        self.mediaClassifier = mediaClassifier
        self.textClassifier = textClassifier
        self.mediaLoader = mediaLoader
        super.init()
        for service in SocialService.allCases {
            let key = audioPreferenceKey(service)
            audioPreferences[service] = defaults.object(forKey: key) == nil ? true : defaults.bool(forKey: key)
            health[service] = .loading
        }
    }

    func select(_ service: SocialService) {
        guard service == fixedService else { return }
        selectedService = service
        _ = webView(for: service)
    }

    func open(_ url: URL) {
        guard let service = SocialService.resolve(url), service == fixedService else { return }
        select(service)
        guard service.allowsNavigation(to: url) else { return }
        webView(for: service).load(URLRequest(url: url))
    }

    func webView(for service: SocialService) -> WKWebView {
        if let existing = webViews[service] { return existing }

        let controller = WKUserContentController()
        let bridge = ScriptMessageBridge { [weak self] message in
            Task { @MainActor in self?.handle(message, service: service) }
        }
        controller.add(bridge, name: "vigil")
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.contentFilterBootstrap,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        if let preflight = DOMAdapters.preflightScript(for: service) {
            controller.addUserScript(WKUserScript(
                source: preflight,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: false
            ))
        }
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.script(for: service, audioEnabled: audioEnabled(for: service)),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        ))

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .default()
        configuration.allowsAirPlayForMediaPlayback = false
        configuration.allowsPictureInPictureMediaPlayback = false
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.alwaysBounceVertical = true
        webView.scrollView.isDirectionalLockEnabled = true
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        if service == .snapchat {
            webView.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
        }

        webViews[service] = webView
        serviceByWebView[ObjectIdentifier(webView)] = service
        messageBridges[service] = bridge
        if loadInitialPages { webView.load(URLRequest(url: service.homeURL)) }
        return webView
    }

    func audioEnabled(for service: SocialService) -> Bool {
        audioPreferences[service] ?? true
    }

    func toggleAudio(for service: SocialService) {
        let enabled = !audioEnabled(for: service)
        audioPreferences[service] = enabled
        defaults.set(enabled, forKey: audioPreferenceKey(service))
        let literal = enabled ? "true" : "false"
        webViews[service]?.evaluateJavaScript("window.__vigilSetAudioPreference?.(\(literal));")
    }

    func reload(_ service: SocialService) {
        webView(for: service).reload()
    }

    func goBack(_ service: SocialService) {
        let webView = webView(for: service)
        if webView.canGoBack { webView.goBack() }
    }

    func goForward(_ service: SocialService) {
        let webView = webView(for: service)
        if webView.canGoForward { webView.goForward() }
    }

    func pauseAllMedia() {
        webViews.values.forEach { $0.evaluateJavaScript("window.__vigilPauseAllMedia?.();") }
    }

    private func handle(_ message: WKScriptMessage, service: SocialService) {
        guard message.frameInfo.isMainFrame,
              let url = message.frameInfo.request.url ?? message.webView?.url,
              service.allowsNavigation(to: url) else { return }
        let payload = message.body
        guard let body = payload as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "health":
            let detail = body["detail"] as? String ?? ""
            switch body["state"] as? String {
            case "ready": health[service] = .ready
            case "unsupported": health[service] = .unsupported(detail)
            case "degraded": health[service] = .degraded(detail)
            default: health[service] = .loading
            }
        case "audio":
            guard let enabled = body["enabled"] as? Bool else { return }
            audioPreferences[service] = enabled
            defaults.set(enabled, forKey: audioPreferenceKey(service))
        case "playback":
            guard service == .youtube,
                  let key = body["key"] as? String,
                  !key.isEmpty,
                  let position = body["position"] as? Double,
                  position.isFinite else { return }
            defaults.set(position, forKey: playbackKey(key))
        case "playbackRequest":
            guard service == .youtube,
                  let key = body["key"] as? String,
                  !key.isEmpty else { return }
            let position = defaults.double(forKey: playbackKey(key))
            guard position > 1 else { return }
            let encodedKey = javascriptString(key)
            webViews[service]?.evaluateJavaScript("window.__vigilRestorePlayback?.(\(encodedKey), \(position));")
        case "mediaCandidate":
            handleMediaCandidate(body, service: service)
        case "pageText":
            handlePageText(body, service: service)
        default:
            break
        }
    }

    private func handleMediaCandidate(_ body: [String: Any], service: SocialService) {
        guard let id = body["id"] as? String, !id.isEmpty,
              let token = body["token"] as? String, !token.isEmpty else { return }
        let inlineData: Data? = {
            guard let dataURL = body["dataURL"] as? String,
                  let comma = dataURL.firstIndex(of: ","),
                  dataURL.prefix(upTo: comma).contains(";base64"),
                  let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
                  data.count <= 4 * 1024 * 1024 else { return nil }
            return data
        }()
        let sourceURL = (body["sourceURL"] as? String).flatMap(URL.init(string:))
        Task { [weak self] in
            guard let self else { return }
            let data: Data?
            if let inlineData { data = inlineData }
            else if let sourceURL { data = await self.mediaLoader.loadImage(from: sourceURL, maximumBytes: 4 * 1024 * 1024) }
            else { data = nil }
            guard let data else {
                self.resolveMedia(id: id, token: token, verdict: .unknown, service: service)
                return
            }
            let verdict = await self.mediaClassifier.classify(imageData: data)
            self.resolveMedia(id: id, token: token, verdict: verdict, service: service)
        }
    }

    private func resolveMedia(id: String, token: String, verdict: ContentSafetyVerdict, service: SocialService) {
        let encodedID = javascriptString(id)
        let encodedToken = javascriptString(token)
        webViews[service]?.evaluateJavaScript("window.__vigilResolveMedia?.(\(encodedID), \(encodedToken), '\(verdict.rawValue)');")
    }

    private func handlePageText(_ body: [String: Any], service: SocialService) {
        guard let revision = body["revision"] as? String,
              let index = body["index"] as? Int,
              let total = body["total"] as? Int,
              let text = body["text"] as? String,
              total > 0, total <= 32, index >= 0, index < total else { return }
        let truncated = body["wasTruncated"] as? Bool ?? true
        var inspection = textInspections[service]?[revision]
            ?? TextInspection(chunks: [:], total: total, wasTruncated: truncated)
        guard inspection.total == total else { return }
        inspection.chunks[index] = text
        textInspections[service] = [revision: inspection]
        guard inspection.chunks.count == total else { return }
        let completeText = (0..<total).compactMap { inspection.chunks[$0] }.joined()
        Task { [weak self] in
            guard let self else { return }
            let verdict = await self.textClassifier.classify(pageText: completeText, wasTruncated: inspection.wasTruncated)
            let encodedRevision = self.javascriptString(revision)
            self.webViews[service]?.evaluateJavaScript("window.__vigilResolvePageText?.(\(encodedRevision), '\(verdict.rawValue)');")
        }
    }

    private func service(for webView: WKWebView) -> SocialService? {
        serviceByWebView[ObjectIdentifier(webView)]
    }

    private func audioPreferenceKey(_ service: SocialService) -> String {
        "VigilSocial.audio.\(service.rawValue)"
    }

    private func playbackKey(_ videoID: String) -> String {
        "VigilSocial.youtube.position.\(videoID)"
    }

    private func javascriptString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }
}

private struct TextInspection {
    var chunks: [Int: String]
    let total: Int
    let wasTruncated: Bool
}

extension SocialWebViewStore: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        guard let service = service(for: webView), let url = navigationAction.request.url else {
            decisionHandler(.allow, preferences)
            return
        }

        if service == .snapchat { preferences.preferredContentMode = .desktop }
        guard service.allowsNavigation(to: url) else {
            decisionHandler(.cancel, preferences)
            return
        }
        let path = url.path.lowercased()
        let blocked = (service == .youtube && path.hasPrefix("/shorts"))
            || (service == .snapchat && (path.contains("/spotlight") || path.contains("/stories")))
        if blocked {
            health[service] = .degraded("That short-form surface is intentionally unavailable.")
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
        if let service = service(for: webView) { health[service] = .loading }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        guard let service = service(for: webView) else { return }
        webView.evaluateJavaScript(DOMAdapters.script(for: service, audioEnabled: audioEnabled(for: service)))
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        if let service = service(for: webView) { health[service] = .degraded(error.localizedDescription) }
    }
}

extension SocialWebViewStore: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let request = navigationAction.request.url { webView.load(URLRequest(url: request)) }
        return nil
    }
}

private final class ScriptMessageBridge: NSObject, WKScriptMessageHandler {
    private let handler: (WKScriptMessage) -> Void

    init(handler: @escaping (WKScriptMessage) -> Void) {
        self.handler = handler
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        handler(message)
    }
}
