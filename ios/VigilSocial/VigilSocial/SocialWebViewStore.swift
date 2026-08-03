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
    @Published private(set) var youtubeSafariRequest: YouTubeSafariRequest

    let fixedService: SocialService
    private let defaults: UserDefaults
    private let loadInitialPages: Bool
    private let mediaClassifier: any MediaSafetyClassifying
    private let textClassifier: any PageTextSafetyClassifying
    private let phoneBlocklist: PhoneBlocklistIndex?
    private let unclassifiedMediaPolicy: UnclassifiedMediaPolicy
    private var webViews: [SocialService: WKWebView] = [:]
    private var serviceByWebView: [ObjectIdentifier: SocialService] = [:]
    private var messageBridges: [SocialService: ScriptMessageBridge] = [:]
    private var textInspections: [SocialService: [TextInspectionKey: TextInspection]] = [:]
    private var mainDocumentIDs: [SocialService: String] = [:]
    private var mainDocumentGenerations: [SocialService: UInt64] = [:]
    private var servicesWithUsableContent: Set<SocialService> = []
    private var mediaClassificationTasks: [MediaRequestKey: Task<Void, Never>] = [:]
    private var mediaClassificationDeadlineTasks: [MediaRequestKey: Task<Void, Never>] = [:]
    private var nativeMediaClassificationExecutions: Set<UUID> = []
    private var activeMediaRequests: [MediaRequestKey: MediaClassificationRequest] = [:]
    private var pendingMediaRequests: [MediaRequestKey: MediaClassificationRequest] = [:]
    private var pendingMediaOrder: [MediaRequestKey] = []
    private var latestMediaTokens: [MediaRequestKey: String] = [:]
    private var latestMediaRequestIDs: [MediaRequestKey: UUID] = [:]
    private var mediaRetryTasks: [MediaRequestKey: Task<Void, Never>] = [:]
    private var surfaceStates: [SocialService: SocialSurfaceState] = [:]
    private var webContentRecovery: [SocialService: WebContentRecoveryState] = [:]
    private var refreshingServices: Set<SocialService> = []
    private let mediaClassificationDeadlineNanoseconds: UInt64

    private static let maximumConcurrentMediaClassifications = 4
    private static let maximumPendingMediaClassifications = 12
    private static let maximumMediaRetryTasks = 12

    init(
        defaults: UserDefaults = .standard,
        fixedService: SocialService? = nil,
        bundle: Bundle = .main,
        loadInitialPages: Bool = true,
        mediaClassifier: any MediaSafetyClassifying = AppleSensitiveMediaClassifier(),
        textClassifier: any PageTextSafetyClassifying = ConservativePageTextClassifier(),
        unclassifiedMediaPolicy: UnclassifiedMediaPolicy? = nil,
        mediaClassificationDeadlineNanoseconds: UInt64 = 5_000_000_000
    ) {
        let configured = fixedService
            ?? (bundle.object(forInfoDictionaryKey: "VigilService") as? String).flatMap(SocialService.init(rawValue:))
            ?? .youtube
        self.fixedService = configured
        self.selectedService = configured
        self.youtubeSafariRequest = YouTubeSafariRequest(url: SocialService.youtube.homeURL)
        self.defaults = defaults
        self.loadInitialPages = loadInitialPages
        self.mediaClassifier = mediaClassifier
        self.textClassifier = textClassifier
        self.phoneBlocklist = try? PhoneBlocklistIndex.loadBundled(bundle: bundle)
        self.unclassifiedMediaPolicy = unclassifiedMediaPolicy ?? UnclassifiedMediaPolicy(bundle: bundle)
        self.mediaClassificationDeadlineNanoseconds = max(1, mediaClassificationDeadlineNanoseconds)
        super.init()
        for service in SocialService.allCases {
            let key = audioPreferenceKey(service)
            if service == .instagram {
                // The fixed Instagram shell no longer exposes the old native
                // audio toggle. Do not let a legacy off value strand every
                // future session in a muted state with no way to recover.
                audioPreferences[service] = true
                defaults.set(true, forKey: key)
            } else {
                audioPreferences[service] = defaults.object(forKey: key) == nil
                    ? true
                    : defaults.bool(forKey: key)
            }
            health[service] = .loading
            surfaceStates[service] = .unknown
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
            source: DOMAdapters.documentStartScript(
                for: service,
                unclassifiedMediaPolicy: unclassifiedMediaPolicy,
                audioEnabled: audioEnabled(for: service)
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameSafetyScript(
                for: service,
                audioEnabled: audioEnabled(for: service)
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameRoutePolicyGuard(for: service),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedControlsScript(for: service),
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
        webView.allowsLinkPreview = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        webView.scrollView.isDirectionalLockEnabled = service.usesDirectionalScrollLock
        webView.scrollView.keyboardDismissMode = .interactive
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(self, action: #selector(refreshWebView(_:)), for: .valueChanged)
        refreshControl.isEnabled = false
        webView.scrollView.refreshControl = refreshControl
        // UIKit enables vertical bounce when a refresh control is attached.
        // Reassert the fail-closed state until the page reports a safe route.
        webView.scrollView.alwaysBounceVertical = false
        if service == .instagram {
            let edgeBackGesture = UIScreenEdgePanGestureRecognizer(
                target: self,
                action: #selector(handleInstagramEdgeBack(_:))
            )
            edgeBackGesture.edges = .left
            edgeBackGesture.maximumNumberOfTouches = 1
            edgeBackGesture.delegate = self
            webView.addGestureRecognizer(edgeBackGesture)
        }
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

    func reportedChromeIsDark(for service: SocialService) -> Bool? {
        darkChromePreferences[service]
    }

    func toggleAudio(for service: SocialService) {
        let enabled = !audioEnabled(for: service)
        audioPreferences[service] = enabled
        defaults.set(enabled, forKey: audioPreferenceKey(service))
        let literal = enabled ? "true" : "false"
        webViews[service]?.evaluateJavaScript("window.__vigilSetAudioPreference?.(\(literal));")
    }

    func reload(_ service: SocialService) {
        health[service] = .loading
        setSurface(.unknown, for: service)
        webView(for: service).reload()
    }

    func retry(_ service: SocialService) {
        reload(service)
    }

    func goHome(_ service: SocialService) {
        let webView = webView(for: service)
        cancelDocumentWork(for: service)
        health[service] = .loading
        setSurface(.unknown, for: service)
        webView.load(URLRequest(url: service.homeURL))
    }

    func dismissHealth(for service: SocialService) {
        guard case .advisory = health[service] else { return }
        health[service] = .ready
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
        guard let webView = webViews.values.first(where: { $0.scrollView.refreshControl === sender }),
              let service = service(for: webView),
              surfaceStates[service]?.allowsRefresh == true else {
            sender.endRefreshing()
            return
        }
        refreshingServices.insert(service)
        setSurface(.unknown, for: service)
        webView.reload()
    }

    @objc private func handleInstagramEdgeBack(_ gesture: UIScreenEdgePanGestureRecognizer) {
        guard gesture.state == .ended,
              let webView = gesture.view as? WKWebView,
              service(for: webView) == .instagram,
              webView.canGoBack else { return }
        let translation = gesture.translation(in: webView)
        let velocity = gesture.velocity(in: webView)
        guard translation.x >= 52 || velocity.x >= 480 else { return }
        webView.goBack()
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
        if frame.isMainFrame, type == "health" || type == "surface" {
            guard Self.isCurrentMainDocumentMessage(
                body["documentID"],
                currentDocumentID: mainDocumentIDs[service]
            ) else { return }
        }
        switch type {
        case "documentReady":
            guard frame.isMainFrame,
                  let documentID = body["documentID"] as? String,
                  !documentID.isEmpty,
                  documentID.utf8.count <= 128 else { return }
            if let currentDocumentID = mainDocumentIDs[service] {
                guard currentDocumentID == documentID else { return }
            } else {
                mainDocumentIDs[service] = documentID
            }
        case "health":
            let detail = body["detail"] as? String ?? ""
            switch body["state"] as? String {
            case "ready":
                servicesWithUsableContent.insert(service)
                health[service] = .ready
            case "unsupported": health[service] = .unsupported(detail)
            case "degraded":
                health[service] = isAdvisoryHealthMessage(detail)
                    ? .advisory(detail)
                    : .degraded(detail)
            default: health[service] = .loading
            }
        case "audio":
            guard let enabled = body["enabled"] as? Bool else { return }
            audioPreferences[service] = enabled
            defaults.set(enabled, forKey: audioPreferenceKey(service))
        case "appearance":
            guard let dark = body["dark"] as? Bool else { return }
            darkChromePreferences[service] = dark
        case "surface":
            guard let reportedService = body["service"] as? String,
                  reportedService == service.rawValue,
                  let route = body["route"] as? String,
                  !route.isEmpty,
                  route.utf8.count <= 64,
                  let refreshEligible = body["refreshEligible"] as? Bool,
                  let blocksRefresh = body["blocksRefresh"] as? Bool else {
                setSurface(.unknown, for: service)
                return
            }
            setSurface(
                SocialSurfaceState(
                    route: route,
                    refreshEligible: refreshEligible,
                    blocksRefresh: blocksRefresh
                ),
                for: service
            )
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
        if frame.isMainFrame {
            guard Self.isCurrentMainDocumentMessage(
                documentID,
                currentDocumentID: mainDocumentIDs[service]
            ) else { return }
        }
        let requestKey = MediaRequestKey(service: service, documentID: documentID, id: id)
        let request = MediaClassificationRequest(
            requestID: UUID(),
            key: requestKey,
            token: token,
            dataURL: body["dataURL"] as? String,
            frame: frame
        )
        latestMediaTokens[requestKey] = token
        latestMediaRequestIDs[requestKey] = request.requestID

        if pendingMediaRequests[requestKey] != nil {
            pendingMediaRequests[requestKey] = request
            return
        }

        if pendingMediaRequests.count >= Self.maximumPendingMediaClassifications,
           activeMediaRequests[requestKey] == nil {
            scheduleMediaRetry(for: request)
            return
        }

        if activeMediaRequests[requestKey] != nil {
            pendingMediaRequests[requestKey] = request
            pendingMediaOrder.append(requestKey)
            return
        }

        pendingMediaRequests[requestKey] = request
        pendingMediaOrder.append(requestKey)
        pumpMediaClassifications()
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

    private func pumpMediaClassifications() {
        while activeMediaRequests.count < Self.maximumConcurrentMediaClassifications {
            guard let nextIndex = pendingMediaOrder.firstIndex(where: {
                pendingMediaRequests[$0] != nil && activeMediaRequests[$0] == nil
            }) else { return }
            let key = pendingMediaOrder.remove(at: nextIndex)
            guard let request = pendingMediaRequests.removeValue(forKey: key) else { continue }

            // A classifier implementation is allowed to ignore cancellation. Keep
            // those native executions bounded and fail closed instead of spawning
            // an unbounded number of stale tasks after their logical slots expire.
            guard nativeMediaClassificationExecutions.count
                    < Self.maximumConcurrentMediaClassifications else {
                resolveCurrentMediaWithoutClassification(request)
                continue
            }

            activeMediaRequests[key] = request
            nativeMediaClassificationExecutions.insert(request.requestID)
            let classifier = mediaClassifier
            let requestID = request.requestID
            let dataURL = request.dataURL
            let task = Task { [weak self] in
                guard !Task.isCancelled else {
                    self?.retireNativeMediaClassification(requestID)
                    return
                }
                let inlineData = await Task.detached(priority: .userInitiated) {
                    Self.decodeInlineMedia(dataURL)
                }.value
                guard !Task.isCancelled else {
                    self?.retireNativeMediaClassification(requestID)
                    return
                }
                let verdict = if let inlineData {
                    await classifier.classify(imageData: inlineData)
                } else {
                    ContentSafetyVerdict.unknown
                }
                let wasCancelled = Task.isCancelled
                await self?.nativeMediaClassificationReturned(
                    for: key,
                    requestID: requestID,
                    verdict: verdict,
                    wasCancelled: wasCancelled
                )
            }
            mediaClassificationTasks[key] = task
            let deadline = mediaClassificationDeadlineNanoseconds
            mediaClassificationDeadlineTasks[key] = Task { [weak self] in
                do {
                    try await Task.sleep(nanoseconds: deadline)
                } catch {
                    return
                }
                guard let self, !Task.isCancelled else { return }
                await self.expireMediaClassification(for: key, requestID: requestID)
            }
        }
    }

    private func nativeMediaClassificationReturned(
        for key: MediaRequestKey,
        requestID: UUID,
        verdict: ContentSafetyVerdict,
        wasCancelled: Bool
    ) async {
        nativeMediaClassificationExecutions.remove(requestID)
        guard !wasCancelled,
              let request = activeMediaRequests[key],
              request.requestID == requestID else {
            pumpMediaClassifications()
            return
        }
        await finishMediaClassification(request, verdict: verdict)
    }

    private func retireNativeMediaClassification(_ requestID: UUID) {
        nativeMediaClassificationExecutions.remove(requestID)
        pumpMediaClassifications()
    }

    private func finishMediaClassification(
        _ request: MediaClassificationRequest,
        verdict: ContentSafetyVerdict
    ) async {
        guard activeMediaRequests[request.key]?.requestID == request.requestID else { return }
        activeMediaRequests.removeValue(forKey: request.key)
        mediaClassificationTasks.removeValue(forKey: request.key)
        mediaClassificationDeadlineTasks.removeValue(forKey: request.key)?.cancel()

        let shouldResolve = retireLatestMediaRequestIfCurrent(request)
        pumpMediaClassifications()

        guard shouldResolve else { return }
        await resolveMedia(
            documentID: request.key.documentID,
            id: request.key.id,
            token: request.token,
            verdict: verdict,
            service: request.key.service,
            frame: request.frame
        )
    }

    private func expireMediaClassification(
        for key: MediaRequestKey,
        requestID: UUID
    ) async {
        guard let request = activeMediaRequests[key],
              request.requestID == requestID else { return }
        mediaClassificationTasks.removeValue(forKey: key)?.cancel()
        mediaClassificationDeadlineTasks.removeValue(forKey: key)
        activeMediaRequests.removeValue(forKey: key)

        let shouldResolve = retireLatestMediaRequestIfCurrent(request)
        pumpMediaClassifications()

        guard shouldResolve else { return }
        await resolveMedia(
            documentID: request.key.documentID,
            id: request.key.id,
            token: request.token,
            verdict: .unknown,
            service: request.key.service,
            frame: request.frame
        )
    }

    private func resolveCurrentMediaWithoutClassification(_ request: MediaClassificationRequest) {
        guard retireLatestMediaRequestIfCurrent(request) else { return }
        resolveMediaWithoutWaiting(request, verdict: .unknown)
    }

    private func retireLatestMediaRequestIfCurrent(
        _ request: MediaClassificationRequest
    ) -> Bool {
        guard latestMediaRequestIDs[request.key] == request.requestID,
              latestMediaTokens[request.key] == request.token else {
            return false
        }
        latestMediaRequestIDs.removeValue(forKey: request.key)
        latestMediaTokens.removeValue(forKey: request.key)
        return true
    }

    private func scheduleMediaRetry(for request: MediaClassificationRequest) {
        mediaRetryTasks[request.key]?.cancel()
        mediaRetryTasks.removeValue(forKey: request.key)
        guard mediaRetryTasks.count < Self.maximumMediaRetryTasks else {
            resolveCurrentMediaWithoutClassification(request)
            return
        }

        let task = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 650_000_000)
            guard let self, !Task.isCancelled else { return }
            self.mediaRetryTasks.removeValue(forKey: request.key)
            guard self.retireLatestMediaRequestIfCurrent(request) else { return }
            await self.resolveMedia(
                documentID: request.key.documentID,
                id: request.key.id,
                token: request.token,
                verdict: .unknown,
                service: request.key.service,
                frame: request.frame
            )
        }
        mediaRetryTasks[request.key] = task
    }

    private func cancelDocumentWork(for service: SocialService) {
        let activeKeys = Set(
            mediaClassificationTasks.keys.filter { $0.service == service }
                + mediaClassificationDeadlineTasks.keys.filter { $0.service == service }
                + activeMediaRequests.keys.filter { $0.service == service }
        )
        activeKeys.forEach {
            mediaClassificationTasks[$0]?.cancel()
            mediaClassificationTasks.removeValue(forKey: $0)
            mediaClassificationDeadlineTasks[$0]?.cancel()
            mediaClassificationDeadlineTasks.removeValue(forKey: $0)
            activeMediaRequests.removeValue(forKey: $0)
        }

        let pendingKeys = pendingMediaRequests.keys.filter { $0.service == service }
        pendingKeys.forEach {
            pendingMediaRequests.removeValue(forKey: $0)
        }
        pendingMediaOrder.removeAll { $0.service == service }

        let retryKeys = mediaRetryTasks.keys.filter { $0.service == service }
        retryKeys.forEach {
            mediaRetryTasks[$0]?.cancel()
            mediaRetryTasks.removeValue(forKey: $0)
        }
        latestMediaTokens.keys.filter { $0.service == service }.forEach {
            latestMediaTokens.removeValue(forKey: $0)
        }
        latestMediaRequestIDs.keys.filter { $0.service == service }.forEach {
            latestMediaRequestIDs.removeValue(forKey: $0)
        }
        textInspections[service] = [:]
        mainDocumentIDs.removeValue(forKey: service)
        pumpMediaClassifications()
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

    private func resolveMediaWithoutWaiting(
        _ request: MediaClassificationRequest,
        verdict: ContentSafetyVerdict
    ) {
        let resolvedVerdict = unclassifiedMediaPolicy.resolve(verdict)
        guard let webView = webViews[request.key.service] else { return }
        webView.callAsyncJavaScript(
            "window.__vigilResolveMedia?.(documentID, id, token, verdict);",
            arguments: [
                "documentID": request.key.documentID,
                "id": request.key.id,
                "token": request.token,
                "verdict": resolvedVerdict.rawValue
            ],
            in: request.frame,
            in: .page
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
        if frame.isMainFrame {
            guard Self.isCurrentMainDocumentMessage(
                documentID,
                currentDocumentID: mainDocumentIDs[service]
            ) else { return }
        }
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

    static func isCurrentMainDocumentMessage(
        _ documentID: Any?,
        currentDocumentID: String?
    ) -> Bool {
        guard let documentID = documentID as? String,
              !documentID.isEmpty,
              documentID.utf8.count <= 128 else { return false }
        return documentID == currentDocumentID
    }

    private func bindCommittedMainDocument(for service: SocialService, in webView: WKWebView) {
        let generation = mainDocumentGenerations[service, default: 0]
        webView.evaluateJavaScript("window.__vigilDocumentID") { [weak self, weak webView] value, _ in
            Task { @MainActor in
                guard let self, let webView,
                      self.webViews[service] === webView,
                      self.mainDocumentGenerations[service, default: 0] == generation,
                      let documentID = value as? String,
                      !documentID.isEmpty,
                      documentID.utf8.count <= 128 else { return }
                self.mainDocumentIDs[service] = documentID
            }
        }
    }

    private func scheduleNavigationHealthTimeout(for service: SocialService, generation: UInt64) {
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 15_000_000_000)
            guard let self,
                  self.mainDocumentGenerations[service, default: 0] == generation,
                  self.health[service] == .loading else { return }
            self.health[service] = .degraded(
                "\(service.displayName) is taking too long to finish loading. Your session is still available; try again or return Home."
            )
        }
    }

    func setSurface(_ surface: SocialSurfaceState, for service: SocialService) {
        surfaceStates[service] = surface
        guard let scrollView = webViews[service]?.scrollView else { return }
        let allowsRefresh = surface.allowsRefresh
        scrollView.refreshControl?.isEnabled = allowsRefresh
        scrollView.alwaysBounceVertical = allowsRefresh
        if !allowsRefresh && !refreshingServices.contains(service) {
            scrollView.refreshControl?.endRefreshing()
        }
    }

    private func recordNavigationFailure(_ error: Error, for service: SocialService) {
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
            return
        }
        // WebKit reports policy-driven frame replacements through its private
        // compatibility domain/code rather than the public WKError.Code enum.
        if nsError.domain == "WebKitErrorDomain", nsError.code == 102 {
            return
        }
        health[service] = .degraded(error.localizedDescription)
        setSurface(.unknown, for: service)
    }

    private func isAdvisoryHealthMessage(_ detail: String) -> Bool {
        detail.localizedCaseInsensitiveContains("intentionally unavailable")
            || detail.localizedCaseInsensitiveContains("signed out")
    }

    private func isBlockedByPhoneBlocklist(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host else { return false }
        return phoneBlocklist?.matchingDomain(for: host) != nil
    }

    static func validatedPopupRequest(
        _ request: URLRequest,
        for service: SocialService
    ) -> URLRequest? {
        guard let url = request.url,
              service.allowsNavigation(to: url),
              !service.isRestrictedSurface(url) else { return nil }
        return request
    }

    static func safeRecoveryURL(_ url: URL?, for service: SocialService) -> URL? {
        guard let url,
              service.allowsNavigation(to: url),
              !service.isRestrictedSurface(url) else { return nil }
        return url
    }

    private func restoreWebContentPositionIfNeeded(for service: SocialService, in webView: WKWebView) {
        guard let recovery = webContentRecovery.removeValue(forKey: service),
              webView.url == recovery.url else { return }
        Task { @MainActor [weak webView] in
            var expectedOffset = webView?.scrollView.contentOffset
            // The second delay is relative to the first, so the restores occur
            // approximately 180 ms and 850 ms after navigation completion.
            for delay in [180_000_000, 670_000_000] as [UInt64] {
                try? await Task.sleep(nanoseconds: delay)
                guard let webView, webView.url == recovery.url else { return }
                let scrollView = webView.scrollView
                guard !scrollView.isTracking,
                      !scrollView.isDragging,
                      !scrollView.isDecelerating else { return }
                if let expectedOffset {
                    let distance = hypot(
                        scrollView.contentOffset.x - expectedOffset.x,
                        scrollView.contentOffset.y - expectedOffset.y
                    )
                    guard distance <= 12 else { return }
                }
                let minimumX = -scrollView.adjustedContentInset.left
                let maximumX = max(
                    minimumX,
                    scrollView.contentSize.width - scrollView.bounds.width
                        + scrollView.adjustedContentInset.right
                )
                let minimumY = -scrollView.adjustedContentInset.top
                let maximumY = max(
                    minimumY,
                    scrollView.contentSize.height - scrollView.bounds.height
                        + scrollView.adjustedContentInset.bottom
                )
                let restoredX = min(max(recovery.contentOffset.x, minimumX), maximumX)
                let restoredY = min(max(recovery.contentOffset.y, minimumY), maximumY)
                scrollView.setContentOffset(
                    CGPoint(x: restoredX, y: restoredY),
                    animated: false
                )
                expectedOffset = CGPoint(x: restoredX, y: restoredY)
            }
        }
    }

    private func updateAuxiliaryPageHealthIfNeeded(
        for service: SocialService,
        in webView: WKWebView
    ) {
        guard let url = webView.url,
              let auxiliaryHealth = service.auxiliaryPageHealth(for: url) else { return }
        health[service] = auxiliaryHealth
        setSurface(.unknown, for: service)

        guard service == .youtube, url.host?.lowercased() == "accounts.google.com" else { return }
        webView.evaluateJavaScript(
            #"""
            (() => {
              const text = String(document.body?.innerText || '').toLowerCase();
              return /disallowed_useragent|this browser or app may not be secure|couldn.?t sign you in/.test(text);
            })()
            """#
        ) { [weak self, weak webView] result, _ in
            guard let self, let webView,
                  result as? Bool == true,
                  webView.url == url else { return }
            self.health[service] = .unsupported(
                "Google rejected embedded WebKit sign-in. This authentication path is unavailable in the YouTube companion."
            )
        }
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

private struct MediaClassificationRequest {
    let requestID: UUID
    let key: MediaRequestKey
    let token: String
    let dataURL: String?
    let frame: WKFrameInfo
}

struct SocialSurfaceState {
    let route: String
    let refreshEligible: Bool
    let blocksRefresh: Bool

    static let unknown = SocialSurfaceState(
        route: "unknown",
        refreshEligible: false,
        blocksRefresh: true
    )

    var allowsRefresh: Bool {
        refreshEligible && !blocksRefresh
    }
}

private struct WebContentRecoveryState {
    let url: URL
    let contentOffset: CGPoint
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

        if isBlockedByPhoneBlocklist(url) {
            health[service] = .unsupported("Vigil blocked this site using the protected phone blocklist.")
            setSurface(.unknown, for: service)
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
            health[service] = .advisory("That short-form surface is intentionally unavailable.")
            decisionHandler(.cancel, preferences)
            return
        }
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
        guard let service = service(for: webView) else { return }
        mainDocumentGenerations[service, default: 0] &+= 1
        let generation = mainDocumentGenerations[service, default: 0]
        cancelDocumentWork(for: service)
        // Once a protected page has been presented, keep the web surface visible
        // during ordinary Instagram document navigations. The document-start
        // policy still hides unclassified page/media content fail-closed, while
        // avoiding a full-screen loading takeover for stories and Direct.
        if !refreshingServices.contains(service),
           !servicesWithUsableContent.contains(service) {
            health[service] = .loading
        }
        setSurface(.unknown, for: service)
        scheduleNavigationHealthTimeout(for: service, generation: generation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation?) {
        guard let service = service(for: webView) else { return }
        bindCommittedMainDocument(for: service, in: webView)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        guard let service = service(for: webView) else { return }
        refreshingServices.remove(service)
        webView.scrollView.refreshControl?.endRefreshing()
        updateAuxiliaryPageHealthIfNeeded(for: service, in: webView)
        if let url = webView.url, service.usesUnmodifiedAuthenticationDocument(url) {
            if service.auxiliaryPageHealth(for: url) == nil {
                servicesWithUsableContent.insert(service)
                health[service] = .ready
            }
            setSurface(.unknown, for: service)
            restoreWebContentPositionIfNeeded(for: service, in: webView)
            return
        }
        webView.evaluateJavaScript(DOMAdapters.script(for: service, audioEnabled: audioEnabled(for: service)))
        restoreWebContentPositionIfNeeded(for: service, in: webView)
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation?,
        withError error: Error
    ) {
        if let service = service(for: webView) {
            refreshingServices.remove(service)
        }
        webView.scrollView.refreshControl?.endRefreshing()
        if let service = service(for: webView) {
            recordNavigationFailure(error, for: service)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        if let service = service(for: webView) {
            refreshingServices.remove(service)
        }
        webView.scrollView.refreshControl?.endRefreshing()
        if let service = service(for: webView) {
            recordNavigationFailure(error, for: service)
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard let service = service(for: webView) else { return }
        cancelDocumentWork(for: service)
        setSurface(.unknown, for: service)
        health[service] = .loading
        let safeURL = Self.safeRecoveryURL(webView.url, for: service)
        if let safeURL {
            webContentRecovery[service] = WebContentRecoveryState(
                url: safeURL,
                contentOffset: webView.scrollView.contentOffset
            )
            if webView.reload() == nil {
                webView.load(URLRequest(url: safeURL))
            }
        } else {
            webContentRecovery.removeValue(forKey: service)
            webView.load(URLRequest(url: service.homeURL))
        }
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
        guard let service = service(for: webView),
              let request = Self.validatedPopupRequest(
                  navigationAction.request,
                  for: service
              ) else { return nil }
        webView.load(request)
        return nil
    }
}

extension SocialWebViewStore: UIGestureRecognizerDelegate {
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard let edgeGesture = gestureRecognizer as? UIScreenEdgePanGestureRecognizer,
              edgeGesture.edges == .left,
              let webView = edgeGesture.view as? WKWebView,
              service(for: webView) == .instagram,
              webView.canGoBack else { return false }
        let velocity = edgeGesture.velocity(in: webView)
        return velocity.x > 0 && abs(velocity.x) > abs(velocity.y) * 1.15
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
