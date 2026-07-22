import Combine
import Foundation
import UIKit
import WebKit

@MainActor
final class SocialWebViewStore: NSObject, ObservableObject {
    @Published private(set) var selectedService: SocialService
    @Published private(set) var health: [SocialService: AdapterHealth] = [:]
    @Published private(set) var audioPreferences: [SocialService: Bool] = [:]
    @Published private(set) var darkChromePreferences: [SocialService: Bool] = [:]

    let fixedService: SocialService
    private let defaults: UserDefaults
    private let loadInitialPages: Bool
    private let mediaClassifier: any MediaSafetyClassifying
    private let textClassifier: any PageTextSafetyClassifying
    private let unclassifiedMediaPolicy: UnclassifiedMediaPolicy
    private var webViews: [SocialService: WKWebView] = [:]
    private var serviceByWebView: [ObjectIdentifier: SocialService] = [:]
    private var messageBridges: [SocialService: ScriptMessageBridge] = [:]
    private var textInspections: [SocialService: [TextInspectionKey: TextInspection]] = [:]
    private var mediaClassificationTasks: [MediaRequestKey: Task<Void, Never>] = [:]
    private var mediaClassificationTokens: [MediaRequestKey: String] = [:]

    init(
        defaults: UserDefaults = .standard,
        fixedService: SocialService? = nil,
        bundle: Bundle = .main,
        loadInitialPages: Bool = true,
        mediaClassifier: any MediaSafetyClassifying = AppleSensitiveMediaClassifier(),
        textClassifier: any PageTextSafetyClassifying = ConservativePageTextClassifier(),
        unclassifiedMediaPolicy: UnclassifiedMediaPolicy? = nil
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
        self.unclassifiedMediaPolicy = unclassifiedMediaPolicy ?? UnclassifiedMediaPolicy(bundle: bundle)
        super.init()
        for service in SocialService.allCases {
            let key = audioPreferenceKey(service)
            audioPreferences[service] = defaults.object(forKey: key) == nil ? true : defaults.bool(forKey: key)
            health[service] = .loading
        }
        if loadInitialPages { _ = webView(for: selectedService) }
    }

    func select(_ service: SocialService) {
        guard service == fixedService else { return }
        _ = webView(for: fixedService)
    }

    func open(_ url: URL) {
        guard let service = SocialService.resolve(url), service == fixedService else { return }
        let scheme = url.scheme?.lowercased() ?? ""
        let destination = scheme == "vigilsocial" || scheme.hasPrefix("vigil-") ? service.homeURL : url
        guard service.allowsNavigation(to: destination), !service.isRestrictedSurface(destination) else { return }
        webView(for: fixedService).load(URLRequest(url: destination))
    }

    func webView(for requestedService: SocialService) -> WKWebView {
        let service = requestedService == fixedService ? requestedService : fixedService
        if let existing = webViews[service] { return existing }

        let controller = WKUserContentController()
        let bridge = ScriptMessageBridge { [weak self] message in
            Task { @MainActor in self?.handle(message, service: service) }
        }
        controller.add(bridge, name: "vigil")
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.contentFilterBootstrap(for: unclassifiedMediaPolicy),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.frameSafetyScript(audioEnabled: audioEnabled(for: service)),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.controlsScript(for: service),
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
        configuration.defaultWebpagePreferences.preferredContentMode = .mobile

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = service.allowsBackForwardNavigationGestures
        webView.allowsLinkPreview = true
        webView.scrollView.alwaysBounceVertical = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.scrollView.isDirectionalLockEnabled = service.usesDirectionalScrollLock
        webView.scrollView.keyboardDismissMode = .interactive
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(self, action: #selector(refreshWebView(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refreshControl
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webViews[service] = webView
        serviceByWebView[ObjectIdentifier(webView)] = service
        messageBridges[service] = bridge
        if loadInitialPages { webView.load(URLRequest(url: service.homeURL)) }
        return webView
    }

    func audioEnabled(for service: SocialService) -> Bool {
        audioPreferences[service] ?? true
    }

    func chromeIsDark(for service: SocialService, fallback: Bool = false) -> Bool {
        darkChromePreferences[service] ?? fallback
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

    @objc private func refreshWebView(_ sender: UIRefreshControl) {
        guard let webView = webViews.values.first(where: { $0.scrollView.refreshControl === sender }) else {
            sender.endRefreshing()
            return
        }
        webView.reload()
    }

    private func handle(_ message: WKScriptMessage, service: SocialService) {
        let frame = message.frameInfo
        let url = frame.isMainFrame ? (frame.request.url ?? message.webView?.url) : frame.request.url
        guard let url else { return }
        let permitted = frame.isMainFrame
            ? service.allowsNavigation(to: url)
            : service.allowsEmbeddedNavigation(to: url)
        guard permitted else { return }
        if !frame.isMainFrame, url.scheme?.lowercased() == "https" {
            let origin = frame.securityOrigin
            let requestedPort = url.port ?? 443
            guard origin.protocol.lowercased() == "https",
                  origin.host.lowercased() == url.host?.lowercased(),
                  origin.port == 0 || origin.port == requestedPort else { return }
        }
        let payload = message.body
        guard let body = payload as? [String: Any], let type = body["type"] as? String else { return }
        if !frame.isMainFrame && type != "mediaCandidate" && type != "pageText" { return }
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
        case "appearance":
            guard let dark = body["dark"] as? Bool else { return }
            darkChromePreferences[service] = dark
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
            handleMediaCandidate(body, service: service, frame: frame)
        case "pageText":
            handlePageText(body, service: service, frame: frame)
        default:
            break
        }
    }

    private func handleMediaCandidate(_ body: [String: Any], service: SocialService, frame: WKFrameInfo) {
        guard let documentID = body["documentID"] as? String,
              !documentID.isEmpty, documentID.utf8.count <= 128,
              let id = body["id"] as? String, !id.isEmpty, id.utf8.count <= 64,
              let token = body["token"] as? String,
              !token.isEmpty, token.utf8.count <= 64 else { return }
        let requestKey = MediaRequestKey(service: service, documentID: documentID, id: id)
        let isReplacement = mediaClassificationTasks[requestKey] != nil
        mediaClassificationTasks[requestKey]?.cancel()
        guard isReplacement || mediaClassificationTasks.count < 24 else {
            Task { [weak self] in
                guard let self else { return }
                await self.resolveMedia(
                    documentID: documentID,
                    id: id,
                    token: token,
                    verdict: .unknown,
                    service: service,
                    frame: frame
                )
            }
            return
        }
        let dataURL = body["dataURL"] as? String
        mediaClassificationTokens[requestKey] = token
        let task = Task { [weak self] in
            guard let self else { return }
            guard !Task.isCancelled else { return }
            let inlineData = await Task.detached(priority: .userInitiated) {
                Self.decodeInlineMedia(dataURL)
            }.value
            guard !Task.isCancelled, self.mediaClassificationTokens[requestKey] == token else { return }
            let verdict = if let inlineData {
                await self.mediaClassifier.classify(imageData: inlineData)
            } else {
                ContentSafetyVerdict.unknown
            }
            guard !Task.isCancelled, self.mediaClassificationTokens[requestKey] == token else { return }
            self.mediaClassificationTasks.removeValue(forKey: requestKey)
            self.mediaClassificationTokens.removeValue(forKey: requestKey)
            await self.resolveMedia(
                documentID: documentID,
                id: id,
                token: token,
                verdict: verdict,
                service: service,
                frame: frame
            )
        }
        mediaClassificationTasks[requestKey] = task
    }

    nonisolated private static func decodeInlineMedia(_ dataURL: String?) -> Data? {
        guard let dataURL,
              dataURL.utf8.count <= 5_900_000,
              let comma = dataURL.firstIndex(of: ","),
              dataURL.prefix(upTo: comma).contains(";base64"),
              let data = Data(base64Encoded: String(dataURL[dataURL.index(after: comma)...])),
              data.count <= 4 * 1024 * 1024 else { return nil }
        return data
    }

    private func resolveMedia(
        documentID: String,
        id: String,
        token: String,
        verdict: ContentSafetyVerdict,
        service: SocialService,
        frame: WKFrameInfo
    ) async {
        let resolvedVerdict = unclassifiedMediaPolicy.resolve(verdict)
        guard let webView = webViews[service] else { return }
        _ = try? await webView.callAsyncJavaScript(
            "window.__vigilResolveMedia?.(documentID, id, token, verdict);",
            arguments: [
                "documentID": documentID,
                "id": id,
                "token": token,
                "verdict": resolvedVerdict.rawValue
            ],
            in: frame,
            contentWorld: .page
        )
    }

    private func handlePageText(_ body: [String: Any], service: SocialService, frame: WKFrameInfo) {
        guard let documentID = body["documentID"] as? String,
              !documentID.isEmpty, documentID.utf8.count <= 128,
              let revision = body["revision"] as? String,
              !revision.isEmpty, revision.utf8.count <= 64,
              let index = body["index"] as? Int,
              let total = body["total"] as? Int,
              let text = body["text"] as? String,
              text.utf8.count <= 96_000,
              total > 0, total <= 32, index >= 0, index < total else { return }
        let truncated = body["wasTruncated"] as? Bool ?? true
        let inspectionKey = TextInspectionKey(documentID: documentID, revision: revision)
        var serviceInspections = textInspections[service] ?? [:]
        serviceInspections = serviceInspections.filter {
            $0.key.documentID != documentID || $0.key == inspectionKey
        }
        var inspection = serviceInspections[inspectionKey]
            ?? TextInspection(chunks: [:], total: total, wasTruncated: truncated, byteCount: 0)
        guard inspection.total == total else { return }
        let previousByteCount = inspection.chunks[index]?.utf8.count ?? 0
        let updatedByteCount = inspection.byteCount - previousByteCount + text.utf8.count
        guard updatedByteCount <= 2_100_000 else { return }
        inspection.chunks[index] = text
        inspection.byteCount = updatedByteCount
        serviceInspections[inspectionKey] = inspection
        if serviceInspections.count > 64 {
            serviceInspections = [inspectionKey: inspection]
        }
        textInspections[service] = serviceInspections
        guard inspection.chunks.count == total else { return }
        textInspections[service]?.removeValue(forKey: inspectionKey)
        let completeText = (0..<total).compactMap { inspection.chunks[$0] }.joined()
        Task { [weak self] in
            guard let self else { return }
            let verdict = await self.textClassifier.classify(pageText: completeText, wasTruncated: inspection.wasTruncated)
            _ = try? await self.webViews[service]?.callAsyncJavaScript(
                "window.__vigilResolvePageText?.(documentID, revision, verdict);",
                arguments: [
                    "documentID": documentID,
                    "revision": revision,
                    "verdict": verdict.rawValue
                ],
                in: frame,
                contentWorld: .page
            )
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
    var byteCount: Int
}

private struct TextInspectionKey: Hashable {
    let documentID: String
    let revision: String
}

private struct MediaRequestKey: Hashable {
    let service: SocialService
    let documentID: String
    let id: String
}

extension SocialWebViewStore: WKNavigationDelegate {
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        guard let service = service(for: webView), let url = navigationAction.request.url else {
            decisionHandler(.cancel, preferences)
            return
        }

        preferences.preferredContentMode = .mobile

        if navigationAction.targetFrame?.isMainFrame == false {
            decisionHandler(service.allowsEmbeddedNavigation(to: url) ? .allow : .cancel, preferences)
            return
        }

        guard service.allowsNavigation(to: url) else {
            decisionHandler(.cancel, preferences)
            return
        }
        if service.isRestrictedSurface(url) {
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
        webView.scrollView.refreshControl?.endRefreshing()
        webView.evaluateJavaScript(DOMAdapters.script(for: service, audioEnabled: audioEnabled(for: service)))
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        webView.scrollView.refreshControl?.endRefreshing()
        if let service = service(for: webView) { health[service] = .degraded(error.localizedDescription) }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        webView.scrollView.refreshControl?.endRefreshing()
        if let service = service(for: webView) { health[service] = .degraded(error.localizedDescription) }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let service = service(for: webView) else { return }
        health[service] = .loading
        webView.reload()
    }
}

extension SocialWebViewStore: WKUIDelegate {
    func webView(
        _ webView: WKWebView,
        requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo,
        type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        guard let service = service(for: webView),
              service.isCanonicalAppHost(origin.host),
              frame.isMainFrame else {
            decisionHandler(.deny)
            return
        }
        decisionHandler(.prompt)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let service = service(for: webView), let request = navigationAction.request.url else { return nil }
        guard service.allowsNavigation(to: request), !service.isRestrictedSurface(request) else {
            return nil
        }
        webView.load(URLRequest(url: request))
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
