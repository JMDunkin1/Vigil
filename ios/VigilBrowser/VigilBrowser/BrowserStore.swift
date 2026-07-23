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
    private var lastKnownAllowedURL: URL?
    private var surfaceState: BrowserSurfaceState = .browsing
    private var blockedPageNavigation: WKNavigation?
    private var blockedPagePolicyURL: URL?
    private var pendingAllowedNavigation: WKNavigation?
    private var pendingAllowedPolicyURL: URL?
    private var pendingNeutralNavigation: WKNavigation?
    private var pendingNeutralPolicyURL: URL?
    private var recoverableCommittedNavigation: WKNavigation?
    private var blockedPageContext: BrowserBlockedPageContext?
    private static let contentSafetyWorld = WKContentWorld.world(name: "VigilContentSafety")

    private var isShowingBlockedPage: Bool { surfaceState.isShowingBlockedPage }
    private var isAtNeutralEscapePage: Bool { surfaceState.isAtNeutralEscapePage }

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
        case let .allow(filtered): loadAllowed(filtered)
        case let .block(reason): showBlocked(reason: reason, attemptedURL: url)
        }
    }

    func reloadRules() {
        rules = rulesProvider.currentRules()
        do { blocklist = try rulesProvider.currentBlocklist(); blocklistIntegrityValid = true }
        catch { blocklist = nil; blocklistIntegrityValid = false }
        installContentRules()
        if isShowingBlockedPage, let context = blockedPageContext {
            open(context.attemptedURL)
        } else if !isAtNeutralEscapePage, let current = webView.url {
            open(current)
        }
    }

    func goBack() {
        if isShowingBlockedPage { escapeBlockedPage(); return }
        if isAtNeutralEscapePage { return }
        if webView.canGoBack { webView.goBack() }
    }
    func goForward() {
        if !isShowingBlockedPage, !isAtNeutralEscapePage, webView.canGoForward { webView.goForward() }
    }
    func reload() {
        if !isShowingBlockedPage, !isAtNeutralEscapePage { webView.reload() }
    }

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
                    self?.updateNavigationAvailability()
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
        let escapeURL = VigilBlockedPage.escapeURL()
        let documentURL = VigilBlockedPage.documentURL()
        surfaceState = .blocked(BrowserBlockedPageSession(escapeURL: escapeURL))
        recoverableCommittedNavigation = nil
        pendingAllowedNavigation = nil
        pendingAllowedPolicyURL = nil
        pendingNeutralNavigation = nil
        pendingNeutralPolicyURL = nil
        blockedPageNavigation = nil
        blockedPagePolicyURL = documentURL
        blockedPageContext = BrowserBlockedPageContext(reason: reason, attemptedURL: attemptedURL)
        updateNavigationAvailability()
        status = reason
        blockedPageNavigation = webView.loadSimulatedRequest(
            URLRequest(url: documentURL),
            responseHTML: VigilBlockedPage.html(reason: reason, attemptedURL: attemptedURL, escapeURL: escapeURL)
        )
    }

    private func loadAllowed(_ url: URL) {
        if url == VigilBlockedPage.fallbackURL {
            loadNeutralEscapePage()
            return
        }
        if !surfaceState.isShowingBlockedPage {
            blockedPageContext = nil
            recoverableCommittedNavigation = nil
        }
        surfaceState.beginAllowedNavigation()
        blockedPageNavigation = nil
        blockedPagePolicyURL = nil
        pendingNeutralNavigation = nil
        pendingNeutralPolicyURL = nil
        pendingAllowedPolicyURL = url
        pendingAllowedNavigation = webView.load(URLRequest(url: url))
        if pendingAllowedNavigation == nil {
            pendingAllowedPolicyURL = nil
            recoverBlockedSurfaceAfterProvisionalFailure()
        }
        updateNavigationAvailability()
    }

    private func loadNeutralEscapePage() {
        if !surfaceState.isShowingBlockedPage {
            blockedPageContext = nil
            recoverableCommittedNavigation = nil
        }
        surfaceState.beginAllowedNavigation()
        blockedPageNavigation = nil
        blockedPagePolicyURL = nil
        pendingAllowedNavigation = nil
        pendingAllowedPolicyURL = nil
        pendingNeutralPolicyURL = VigilBlockedPage.fallbackURL
        pendingNeutralNavigation = webView.load(URLRequest(url: VigilBlockedPage.fallbackURL))
        if pendingNeutralNavigation == nil {
            pendingNeutralPolicyURL = nil
            recoverBlockedSurfaceAfterProvisionalFailure()
        }
        updateNavigationAvailability()
    }

    private func escapeBlockedPage() {
        guard surfaceState.canEscapeBlockedPage else { return }
        let destination = lastKnownAllowedURL.flatMap(allowedEscapeURL) ?? VigilBlockedPage.fallbackURL
        loadAllowed(destination)
    }

    private func allowedEscapeURL(_ url: URL) -> URL? {
        switch NavigationFilter(rules: rules, blocklist: blocklist, blocklistIntegrityValid: blocklistIntegrityValid).decide(url) {
        case let .allow(filtered): return filtered
        case .block: return nil
        }
    }

    private func updateNavigationAvailability() {
        webView.allowsBackForwardNavigationGestures = surfaceState.allowsBackForwardNavigationGestures
        if surfaceState.isShowingBlockedPage {
            canGoBack = surfaceState.canEscapeBlockedPage
            canGoForward = false
        } else if surfaceState.isAtNeutralEscapePage {
            canGoBack = false
            canGoForward = false
        } else {
            canGoBack = webView.canGoBack
            canGoForward = webView.canGoForward
        }
    }

    private func isNavigation(_ navigation: WKNavigation?, identicalTo expected: WKNavigation?) -> Bool {
        guard let navigation, let expected else { return false }
        return navigation === expected
    }

    private func isExactURL(_ candidate: URL, _ expected: URL) -> Bool {
        candidate.absoluteString == expected.absoluteString
    }

    private func retireCommittedBlockRecovery() {
        recoverableCommittedNavigation = nil
        blockedPageContext = nil
    }

    private func recoverBlockedSurfaceAfterProvisionalFailure() {
        guard surfaceState.isShowingBlockedPage else {
            updateNavigationAvailability()
            return
        }
        if surfaceState.isBlockedPageCommitted {
            surfaceState.pendingAllowedNavigationDidFail()
            updateNavigationAvailability()
        } else if let context = blockedPageContext {
            showBlocked(reason: context.reason, attemptedURL: context.attemptedURL)
        }
    }

    private func restoreRestrictedSurface() {
        if let context = blockedPageContext {
            showBlocked(reason: context.reason, attemptedURL: context.attemptedURL)
        } else {
            surfaceState = .neutral
            loadNeutralEscapePage()
        }
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

private struct BrowserBlockedPageContext {
    let reason: String
    let attemptedURL: URL
}

struct BrowserBlockedPageSession: Equatable {
    let escapeURL: URL
    fileprivate var isCommitted: Bool
    fileprivate var isLeaving: Bool

    init(escapeURL: URL, isCommitted: Bool = false, isLeaving: Bool = false) {
        self.escapeURL = escapeURL
        self.isCommitted = isCommitted
        self.isLeaving = isLeaving
    }
}

enum BrowserSurfaceState: Equatable {
    case browsing
    case blocked(BrowserBlockedPageSession)
    case neutral

    var isShowingBlockedPage: Bool {
        if case .blocked = self { return true }
        return false
    }

    var isAtNeutralEscapePage: Bool { self == .neutral }
    var isRestricted: Bool { self != .browsing }
    var allowsBackForwardNavigationGestures: Bool { self == .browsing }

    var isBlockedPageCommitted: Bool {
        guard case let .blocked(session) = self else { return false }
        return session.isCommitted
    }

    var isLeavingBlockedPage: Bool {
        guard case let .blocked(session) = self else { return false }
        return session.isLeaving
    }

    var canEscapeBlockedPage: Bool {
        guard case let .blocked(session) = self else { return false }
        return session.isCommitted && !session.isLeaving
    }

    mutating func blockedPageDidCommit() {
        guard case var .blocked(session) = self else { return }
        session.isCommitted = true
        self = .blocked(session)
    }

    mutating func beginAllowedNavigation() {
        guard case var .blocked(session) = self else { return }
        session.isLeaving = true
        self = .blocked(session)
    }

    mutating func pendingAllowedNavigationDidFail() {
        guard case var .blocked(session) = self else { return }
        session.isLeaving = false
        self = .blocked(session)
    }

    mutating func allowedNavigationDidCommit() { self = .browsing }
    mutating func neutralNavigationDidCommit() { self = .neutral }

    func acceptsEscape(
        _ candidate: URL,
        sourceIsMainFrame: Bool,
        targetIsMainFrame: Bool,
        isLinkActivation: Bool
    ) -> Bool {
        guard case let .blocked(session) = self,
              session.isCommitted,
              !session.isLeaving,
              sourceIsMainFrame,
              targetIsMainFrame,
              isLinkActivation else { return false }
        return candidate.absoluteString == session.escapeURL.absoluteString
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
        if url.scheme?.lowercased() == VigilBlockedPage.escapeScheme {
            decisionHandler(.cancel)
            if surfaceState.acceptsEscape(
                url,
                sourceIsMainFrame: action.sourceFrame.isMainFrame,
                targetIsMainFrame: action.targetFrame?.isMainFrame == true,
                isLinkActivation: action.navigationType == .linkActivated
            ) {
                escapeBlockedPage()
            }
            return
        }
        if surfaceState.isRestricted, action.targetFrame == nil {
            decisionHandler(.cancel)
            return
        }
        if action.targetFrame?.isMainFrame == true {
            if surfaceState.isRestricted {
                if let expected = pendingAllowedPolicyURL {
                    guard isExactURL(url, expected) else { decisionHandler(.cancel); return }
                    pendingAllowedPolicyURL = nil
                } else if let expected = pendingNeutralPolicyURL {
                    guard isExactURL(url, expected) else { decisionHandler(.cancel); return }
                    pendingNeutralPolicyURL = nil
                } else if let expected = blockedPagePolicyURL {
                    guard isExactURL(url, expected) else { decisionHandler(.cancel); return }
                    blockedPagePolicyURL = nil
                    decisionHandler(.allow)
                    return
                } else if pendingAllowedNavigation != nil {
                    decisionHandler(.cancel)
                    switch NavigationFilter(
                        rules: rules,
                        blocklist: blocklist,
                        blocklistIntegrityValid: blocklistIntegrityValid
                    ).decide(url) {
                    case let .allow(filtered): loadAllowed(filtered)
                    case let .block(reason): showBlocked(reason: reason, attemptedURL: url)
                    }
                    return
                } else {
                    decisionHandler(.cancel)
                    return
                }
            } else if recoverableCommittedNavigation != nil {
                // A new main-frame action supersedes any failure still arriving for
                // the just-committed escape navigation.
                retireCommittedBlockRecovery()
            }
        }
        if VigilBlockedPage.isDocumentURL(url) {
            decisionHandler(.cancel)
            return
        }
        if url.scheme?.lowercased() == "about" || (url.scheme == nil && url.host == nil) {
            decisionHandler(.allow)
            return
        }
        switch NavigationFilter(rules: rules, blocklist: blocklist, blocklistIntegrityValid: blocklistIntegrityValid).decide(url) {
        case let .allow(filtered):
            if filtered != url {
                decisionHandler(.cancel)
                loadAllowed(filtered)
            } else { decisionHandler(.allow) }
        case let .block(reason):
            decisionHandler(.cancel)
            showBlocked(reason: reason, attemptedURL: url)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
        if let navigation,
           let recoverableCommittedNavigation,
           navigation !== recoverableCommittedNavigation {
            retireCommittedBlockRecovery()
        }
        isLoading = true
    }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation?) {
        if isNavigation(navigation, identicalTo: blockedPageNavigation) {
            blockedPageNavigation = nil
            blockedPagePolicyURL = nil
            surfaceState.blockedPageDidCommit()
            updateNavigationAvailability()
            return
        }
        if isNavigation(navigation, identicalTo: pendingNeutralNavigation) {
            pendingNeutralNavigation = nil
            pendingNeutralPolicyURL = nil
            pendingAllowedNavigation = nil
            pendingAllowedPolicyURL = nil
            blockedPageNavigation = nil
            blockedPagePolicyURL = nil
            recoverableCommittedNavigation = blockedPageContext == nil ? nil : navigation
            surfaceState.neutralNavigationDidCommit()
            updateNavigationAvailability()
            return
        }
        if isNavigation(navigation, identicalTo: pendingAllowedNavigation) {
            pendingAllowedNavigation = nil
            pendingAllowedPolicyURL = nil
            pendingNeutralNavigation = nil
            pendingNeutralPolicyURL = nil
            blockedPageNavigation = nil
            blockedPagePolicyURL = nil
            guard let current = webView.url,
                  ["http", "https"].contains(current.scheme?.lowercased() ?? ""),
                  allowedEscapeURL(current) != nil else {
                restoreRestrictedSurface()
                return
            }
            recoverableCommittedNavigation = blockedPageContext == nil ? nil : navigation
            surfaceState.allowedNavigationDidCommit()
            updateNavigationAvailability()
            return
        }
        if surfaceState.isRestricted {
            restoreRestrictedSurface()
            return
        }
        guard let current = webView.url,
              ["http", "https"].contains(current.scheme?.lowercased() ?? ""),
              allowedEscapeURL(current) != nil else { return }
        surfaceState.allowedNavigationDidCommit()
        updateNavigationAvailability()
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
        isLoading = false
        if isNavigation(navigation, identicalTo: recoverableCommittedNavigation) {
            retireCommittedBlockRecovery()
        }
        if isShowingBlockedPage {
            updateNavigationAvailability()
            return
        }
        if isAtNeutralEscapePage {
            updateNavigationAvailability()
            status = "Protected"
            return
        }
        if let current = webView.url, let allowed = allowedEscapeURL(current) {
            lastKnownAllowedURL = allowed
        }
        status = "Protected"
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation?, withError error: Error) {
        isLoading = false
        if isNavigation(navigation, identicalTo: pendingAllowedNavigation) {
            pendingAllowedNavigation = nil
            pendingAllowedPolicyURL = nil
            recoverBlockedSurfaceAfterProvisionalFailure()
            status = error.localizedDescription
            return
        }
        if isNavigation(navigation, identicalTo: pendingNeutralNavigation) {
            pendingNeutralNavigation = nil
            pendingNeutralPolicyURL = nil
            recoverBlockedSurfaceAfterProvisionalFailure()
            status = error.localizedDescription
            return
        }
        if isNavigation(navigation, identicalTo: blockedPageNavigation) {
            blockedPageNavigation = nil
            blockedPagePolicyURL = nil
            if let context = blockedPageContext {
                showBlocked(reason: context.reason, attemptedURL: context.attemptedURL)
            } else {
                updateNavigationAvailability()
            }
            status = error.localizedDescription
            return
        }
        if (error as NSError).code != NSURLErrorCancelled { status = error.localizedDescription }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
        isLoading = false
        if isNavigation(navigation, identicalTo: recoverableCommittedNavigation) {
            recoverableCommittedNavigation = nil
            if let context = blockedPageContext {
                showBlocked(reason: context.reason, attemptedURL: context.attemptedURL)
            } else {
                updateNavigationAvailability()
            }
            status = error.localizedDescription
            return
        }
        if isNavigation(navigation, identicalTo: pendingAllowedNavigation)
            || isNavigation(navigation, identicalTo: pendingNeutralNavigation) {
            pendingAllowedNavigation = nil
            pendingAllowedPolicyURL = nil
            pendingNeutralNavigation = nil
            pendingNeutralPolicyURL = nil
            if let context = blockedPageContext {
                showBlocked(reason: context.reason, attemptedURL: context.attemptedURL)
                status = error.localizedDescription
            } else {
                updateNavigationAvailability()
                status = error.localizedDescription
            }
            return
        }
        if (error as NSError).code != NSURLErrorCancelled { status = error.localizedDescription }
    }
}

enum VigilBlockedPage {
    static let escapeScheme = "vigil-back"
    static let fallbackURL = URL(string: "about:blank")!
    private static let documentHost = "blocked.vigil.invalid"

    static func documentURL(nonce: UUID = UUID()) -> URL {
        URL(string: "https://\(documentHost)/\(nonce.uuidString.lowercased())")!
    }

    static func isDocumentURL(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.lowercased() == documentHost
    }

    static func escapeURL(nonce: UUID = UUID()) -> URL {
        URL(string: "\(escapeScheme)://escape/\(nonce.uuidString.lowercased())")!
    }

    static func html(reason: String, attemptedURL: URL, escapeURL: URL) -> String {
        let escapedReason = escape(reason)
        let escapedURL = escape(attemptedURL.absoluteString)
        let escapedEscapeURL = escape(escapeURL.absoluteString)
        return """
        <!doctype html>
        <html lang="en">
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Blocked · Vigil</title>
          <style>
            :root { color-scheme: dark; --paper: #101111; --paper-2: #161717; --ink: #f0ece5; --muted: #aaa49c; --primary: #b77952; --primary-strong: #d5a16b; --focus: rgba(213, 161, 107, .24); }
            * { box-sizing: border-box; }
            body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; color: var(--ink); background: radial-gradient(circle at 78% -8%, rgba(183, 121, 82, .18), transparent 34rem), radial-gradient(circle at 28% 106%, rgba(157, 124, 88, .10), transparent 30rem), linear-gradient(180deg, var(--paper), var(--paper-2)); font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif; }
            main { width: min(560px, 100%); }
            .eyebrow { margin: 0 0 12px; color: var(--primary-strong); font-size: .78rem; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
            h1 { max-width: 12ch; margin: 0; font: 700 clamp(2.75rem, 12vw, 5rem)/.98 Georgia, "Times New Roman", serif; letter-spacing: -.04em; }
            .reason { margin: 22px 0 0; color: var(--muted); line-height: 1.55; }
            .attempted { margin: 10px 0 0; color: var(--muted); font-size: .8rem; opacity: .72; overflow-wrap: anywhere; }
            .escape-actions { margin-top: 32px; }
            .escape-actions a { min-height: 48px; display: inline-grid; place-items: center; padding: 0 22px; border-radius: 7px; color: #16120f; background: var(--primary); text-decoration: none; font-weight: 700; }
            .escape-actions a:active { background: var(--primary-strong); transform: translateY(1px); }
            .escape-actions a:focus-visible { outline: 3px solid var(--focus); outline-offset: 3px; }
            @media (max-width: 520px) { body { place-items: start; padding: 64px 24px; } }
          </style>
        </head>
        <body data-vigil-block-page="1">
          <main>
            <p class="eyebrow">Vigil</p>
            <h1>This page is blocked.</h1>
            <p class="reason">\(escapedReason)</p>
            <p class="attempted">\(escapedURL)</p>
            <div class="escape-actions"><a id="leaveBlockedPage" href="\(escapedEscapeURL)">Go back</a></div>
          </main>
        </body>
        </html>
        """
    }

    private static func escape(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

extension BrowserStore: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard !surfaceState.isRestricted else { return nil }
        if let url = action.request.url { open(url) }
        return nil
    }
}
