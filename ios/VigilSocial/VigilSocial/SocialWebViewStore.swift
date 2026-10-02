import AVFoundation
import Combine
import Foundation
import MediaPlayer
import UIKit
import WebKit

// Keep one unchanged, fixed-service engine per service. Switching changes only
// which engine is visible; web history, page state, and usage ledgers survive.
@MainActor
final class SocialContainerStore: ObservableObject {
    let isCombined: Bool
    let initialService: SocialService
    @Published private(set) var selectedService: SocialService?
    @Published private(set) var stores: [SocialService: SocialWebViewStore] = [:]
    @Published private(set) var migrationReady = false
    let preferences: SocialPreferences
    private var didApplyStartupPreference = false
    private let bundle: Bundle
    private let defaults: UserDefaults
    private let loadInitialPages: Bool
    private var accountStores: [SocialService: [String: SocialWebViewStore]] = [:]

    init(bundle: Bundle = .main, defaults: UserDefaults = .standard,
         combined: Bool? = nil, loadInitialPages: Bool = true) {
        self.bundle = bundle
        self.defaults = defaults
        self.preferences = SocialPreferences(defaults: defaults)
        self.loadInitialPages = loadInitialPages
        let configured = bundle.object(forInfoDictionaryKey: "VigilService") as? String
        isCombined = combined ?? (configured == "all")
        initialService = configured.flatMap(SocialService.init(rawValue:)) ?? .youtube
        selectedService = isCombined ? nil : initialService
        refreshMigrationReadiness()
        if !isCombined {
            _ = store(for: initialService)
        }
    }

    func refreshMigrationReadiness() {
        defer { applyStartupPreferenceIfReady() }
        #if targetEnvironment(simulator)
        migrationReady = true
        #else
        guard isCombined else { migrationReady = true; return }
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? Data(contentsOf: directory.appendingPathComponent("vigil-social-migration.json")),
              let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        migrationReady = record["schemaVersion"] as? Int == 1 && record["complete"] as? Bool == true
        if migrationReady, let id = record["id"] as? String,
           defaults.string(forKey: "VigilSocial.migration.v1") != id {
            for (key, value) in record["preferences"] as? [String: Any] ?? [:] {
                if SocialService.allCases.contains(where: { key.hasPrefix("VigilSocial.\($0.rawValue).") }) {
                    defaults.set(value, forKey: key)
                }
            }
            defaults.set(id, forKey: "VigilSocial.migration.v1")
        }
        #endif
    }

    func store(for service: SocialService) -> SocialWebViewStore {
        if let existing = stores[service] { return existing }
        let sessionKey = preferences.selectedAccountID(for: service)?.uuidString ?? "existing"
        if let existing = accountStores[service]?[sessionKey] {
            stores[service] = existing
            return existing
        }
        let store = SocialWebViewStore(defaults: defaults, fixedService: service,
                                      bundle: bundle, loadInitialPages: loadInitialPages,
                                      websiteDataStore: isCombined
                                        ? Self.websiteDataStore(for: service, accountID: preferences.selectedAccountID(for: service)) : nil)
        store.accessRestriction = { [weak preferences] in preferences?.isBlocked(for: service) ?? true }
        stores[service] = store
        accountStores[service, default: [:]][sessionKey] = store
        if isCombined { store.openSocialLink = { [weak self] url in self?.open(url) } }
        return store
    }

    static func websiteDataStore(for service: SocialService, accountID: UUID? = nil) -> WKWebsiteDataStore {
        // Instagram keeps its existing store; other services get persistent,
        // isolated stores, including their third-party authentication cookies.
        if service != .instagram, let accountID { return WKWebsiteDataStore(forIdentifier: accountID) }
        switch service {
        case .instagram: return .default()
        case .youtube: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000002")!)
        case .snapchat: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000003")!)
        case .linkedin: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000004")!)
        case .facebook: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000005")!)
        case .x: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000006")!)
        case .tiktok: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000007")!)
        case .reddit: return WKWebsiteDataStore(forIdentifier: UUID(uuidString: "B1853428-14D1-4532-8F11-000000000008")!)
        }
    }

    func accounts(for service: SocialService) -> [SocialAccount] { preferences.accounts(for: service) }

    func selectedAccountID(for service: SocialService) -> UUID? { preferences.selectedAccountID(for: service) }

    @discardableResult
    func addAccount(for service: SocialService, name: String) -> Bool {
        guard migrationReady, service != .instagram, !preferences.isBlocked(for: service),
              let id = preferences.addAccount(for: service, name: name) else { return false }
        selectAccount(id, for: service)
        return true
    }

    func selectAccount(_ id: UUID?, for service: SocialService) {
        guard migrationReady, service != .instagram, !preferences.isBlocked(for: service),
              id == nil || accounts(for: service).contains(where: { $0.id == id }),
              id != selectedAccountID(for: service) else { return }
        stores[service]?.suspendAllMedia(relinquishExternalPlayback: true)
        preferences.selectAccount(id, for: service)
        stores.removeValue(forKey: service)
        // Cookie containers change; the single YouTube ledger remains shared.
        if selectedService == service {
            let replacement = store(for: service)
            replacement.requestFreshServiceAccessReceipt()
            replacement.suspendAllMedia(relinquishExternalPlayback: false)
        }
    }

    func renameAccount(_ id: UUID, for service: SocialService, name: String) {
        preferences.renameAccount(id, for: service, name: name)
    }

    var youtubeBackgroundPlaybackEnabled: Bool {
        defaults.object(forKey: "VigilSocial.youtube.backgroundPlayback") == nil
            || defaults.bool(forKey: "VigilSocial.youtube.backgroundPlayback")
    }

    var youtubePictureInPictureEnabled: Bool {
        defaults.object(forKey: "VigilSocial.youtube.pictureInPicture") == nil
            || defaults.bool(forKey: "VigilSocial.youtube.pictureInPicture")
    }

    func setYouTubeBackgroundPlaybackEnabled(_ enabled: Bool) {
        objectWillChange.send()
        defaults.set(enabled, forKey: "VigilSocial.youtube.backgroundPlayback")
        accountStores[.youtube]?.values.forEach { $0.setYouTubeBackgroundPlaybackEnabled(enabled) }
    }

    func setYouTubePictureInPictureEnabled(_ enabled: Bool) {
        objectWillChange.send()
        defaults.set(enabled, forKey: "VigilSocial.youtube.pictureInPicture")
        accountStores[.youtube]?.values.forEach { $0.setYouTubePictureInPictureEnabled(enabled) }
    }

    func enforceRestrictions(at date: Date = Date()) {
        for (service, sessions) in accountStores where preferences.isBlocked(for: service, at: date) {
            for store in sessions.values {
                store.suspendAllMedia(relinquishExternalPlayback: selectedService == service)
            }
        }
    }

    private func applyStartupPreferenceIfReady() {
        guard isCombined, migrationReady, !didApplyStartupPreference else { return }
        didApplyStartupPreference = true
        if let service = preferences.startupService, !preferences.isBlocked(for: service) { select(service) }
    }

    func select(_ service: SocialService) {
        guard migrationReady else { return }
        guard isCombined || service == initialService else { return }
        guard !preferences.isBlocked(for: service) else { enforceRestrictions(); return }
        if let previous = selectedService, previous != service { stores[previous]?.suspendAllMedia(relinquishExternalPlayback: false) }
        let next = store(for: service)
        next.requestFreshServiceAccessReceipt()
        selectedService = service
        writeSelectionReceipt()
        // The combined view rechecks the system web policy before resuming.
        if !isCombined { next.resumeSuspendedMedia() }
    }

    func showHome() {
        guard isCombined else { return }
        stores.values.forEach { $0.suspendAllMedia(relinquishExternalPlayback: false) }
        InstagramExternalPlaybackPolicy.relinquish()
        selectedService = nil
        writeSelectionReceipt()
    }

    private func writeSelectionReceipt() {
        guard isCombined,
              let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: [
                "combined": true,
                "service": selectedService?.rawValue ?? "home",
                "selectedAt": ISO8601DateFormatter().string(from: Date())
              ]) else { return }
        try? data.write(to: directory.appendingPathComponent("vigil-social-selection.json"), options: .atomic)
    }

    func open(_ url: URL) {
        refreshMigrationReadiness()
        guard migrationReady else { return }
        if isCombined && url.scheme == "vigilsocial" && url.host == "home" {
            showHome()
            return
        }
        if let link = SocialIncomingLink(url), isCombined || link.service == initialService {
            guard !preferences.isBlocked(for: link.service) else { enforceRestrictions(); return }
            select(link.service)
            store(for: link.service).open(link)
            return
        }
        // A malformed handoff must never fall back to a Home Screen launcher.
        if url.scheme == "vigilsocial", url.host == "open",
           URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems != nil { return }
        guard let service = SocialService.resolve(url),
              isCombined || service == initialService else { return }
        let isLauncher = url.scheme == "vigilsocial" || url.scheme == "vigil-\(service.rawValue)"
        // Invalid/restricted URLs must not switch to or load another service.
        guard isLauncher else { return }
        select(service)
        // A Home Screen launch resumes the existing page, like opening the old
        // standalone app. Only an explicit content link changes its location.
    }
}

enum InstagramExternalPlaybackPolicy {
    @MainActor
    static func relinquish() {
        let nowPlayingCenter = MPNowPlayingInfoCenter.default()
        nowPlayingCenter.playbackState = .stopped
        nowPlayingCenter.nowPlayingInfo = nil
        try? AVAudioSession.sharedInstance().setActive(
            false,
            options: .notifyOthersOnDeactivation
        )
    }
}

// This is a launch-verification receipt, not the authority for access. The
// live WebKit probe still runs on every check. Persist transitions and the
// first result after each launcher selection without rewriting every poll.
struct SocialServiceAccessReceipt {
    private var lastConfirmed: Bool?

    mutating func invalidate() { lastConfirmed = nil }

    mutating func write(confirmed: Bool, service: SocialService, directory: URL, now: Date = Date()) throws {
        guard lastConfirmed != confirmed else { return }
        let data = try JSONSerialization.data(withJSONObject: [
            "service": service.rawValue,
            "accessConfirmed": confirmed,
            "checkedAt": ISO8601DateFormatter().string(from: now)
        ])
        try data.write(to: directory.appendingPathComponent("vigil-social-access-\(service.rawValue).json"), options: .atomic)
        // A failed write must remain retryable on the next check.
        lastConfirmed = confirmed
    }
}

enum InstagramInformationalAccounts {
    static let storageKey = "VigilSocial.instagram.informationalAccounts.v1"
    static let initialAccounts = ["wludining", "whiterhino.asylumfightteam"]

    static func normalizedUsername(_ input: String) -> String? {
        var value = input.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if value.hasPrefix("https://") {
            guard let url = URLComponents(string: value),
                  ["instagram.com", "www.instagram.com"].contains(url.host ?? ""),
                  url.port == nil, url.user == nil, url.password == nil else { return nil }
            let parts = url.path.split(separator: "/")
            guard parts.count == 1 else { return nil }
            value = String(parts[0])
        } else if value.hasPrefix("@") {
            value.removeFirst()
        }
        let reserved = ["accounts", "direct", "explore", "reels", "reel", "p", "stories", "about", "legal", "shop", "shopping", "live"]
        guard value.range(of: #"^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$"#, options: .regularExpression) != nil,
              !value.contains(".."), !reserved.contains(value) else { return nil }
        return value
    }
}

@MainActor
final class SocialWebViewStore: NSObject, ObservableObject {
    @Published private(set) var selectedService: SocialService
    @Published private(set) var health: [SocialService: AdapterHealth] = [:]
    @Published private(set) var audioPreferences: [SocialService: Bool] = [:]
    @Published private(set) var darkChromePreferences: [SocialService: Bool] = [:]
    @Published private(set) var snapchatChromeColor: UIColor?
    @Published private(set) var youtubeAllowsLandscape = false
    @Published private(set) var youtubeSafariRequest: YouTubeSafariRequest
    @Published private(set) var youtubeBackgroundPlaybackEnabled = true
    @Published private(set) var youtubePictureInPictureEnabled = true
    @Published private(set) var youtubeExternalPlaybackAvailable = false

    @Published private(set) var instagramInformationalAccounts: [String] = []
    private var instagramControlsUserScript: WKUserScript?

    let fixedService: SocialService
    private let defaults: UserDefaults
    private let bundle: Bundle
    private let loadInitialPages: Bool
    private let websiteDataStore: WKWebsiteDataStore?
    private var mediaClassifier: (any MediaSafetyClassifying)?
    private var textClassifier: (any PageTextSafetyClassifying)?
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
    @Published private var surfaceStates: [SocialService: SocialSurfaceState] = [:]
    private var webContentRecovery: [SocialService: WebContentRecoveryState] = [:]
    private var refreshingServices: Set<SocialService> = []
    private var mediaPlaybackIsSuspended = false
    private var externalPlaybackMayRelinquish = false
    private var externalPlaybackRelinquishTask: Task<Void, Never>?
    private var serviceAccessReceipt = SocialServiceAccessReceipt()
    private(set) var linkedInApplePopup: LinkedInApplePopupController?
    var openSocialLink: ((URL) -> Void)?
    var accessRestriction: (() -> Bool)?
    private let mediaClassificationDeadlineNanoseconds: UInt64
    private var externalPlaybackAuthorization = YouTubeExternalPlaybackAuthorization()
    private var externalPlaybackMonitor: Task<Void, Never>?
    private var externalPlaybackMonitorGeneration: UInt64 = 0
    private var externalPlaybackPolicyProbe: Task<Void, Never>?
    private var externalPlaybackCreditDeadline: Task<Void, Never>?
    private var lastConfirmedServiceAccess: TimeInterval?
    private var playbackIsBackgrounded = false
    private var playbackServiceIsVisible = false
    private var sceneActivityGeneration: UInt64 = 0
    private var youtubeAudioSessionIsActive = false
    private var permittedYouTubeVideoFrameCheckTimes: [String: TimeInterval] = [:]

    private var managedWebViews: [WKWebView] {
        Array(webViews.values)
    }

    private static let maximumConcurrentMediaClassifications = 4
    private static let maximumPendingMediaClassifications = 12
    private static let maximumMediaRetryTasks = 12
    static let youtubePlaybackPositionNamespace = "VigilSocial.youtube.position.v2"
    init(
        defaults: UserDefaults = .standard,
        fixedService: SocialService? = nil,
        bundle: Bundle = .main,
        loadInitialPages: Bool = true,
        mediaClassifier: (any MediaSafetyClassifying)? = nil,
        textClassifier: (any PageTextSafetyClassifying)? = nil,
        unclassifiedMediaPolicy: UnclassifiedMediaPolicy? = nil,
        websiteDataStore: WKWebsiteDataStore? = nil,
        mediaClassificationDeadlineNanoseconds: UInt64 = 5_000_000_000
    ) {
        let configured = fixedService
            ?? (bundle.object(forInfoDictionaryKey: "VigilService") as? String).flatMap(SocialService.init(rawValue:))
            ?? .youtube
        self.fixedService = configured
        self.selectedService = configured
        self.youtubeSafariRequest = YouTubeSafariRequest(url: SocialService.youtube.homeURL)
        self.defaults = defaults
        self.bundle = bundle
        self.loadInitialPages = loadInitialPages
        self.websiteDataStore = websiteDataStore
        self.mediaClassifier = mediaClassifier
        self.textClassifier = textClassifier
        self.unclassifiedMediaPolicy = unclassifiedMediaPolicy ?? UnclassifiedMediaPolicy(bundle: bundle)
        self.mediaClassificationDeadlineNanoseconds = max(1, mediaClassificationDeadlineNanoseconds)
        super.init()
        youtubeBackgroundPlaybackEnabled = defaults.object(forKey: "VigilSocial.youtube.backgroundPlayback") == nil
            || defaults.bool(forKey: "VigilSocial.youtube.backgroundPlayback")
        youtubePictureInPictureEnabled = defaults.object(forKey: "VigilSocial.youtube.pictureInPicture") == nil
            || defaults.bool(forKey: "VigilSocial.youtube.pictureInPicture")
        instagramInformationalAccounts = Array(Set(
            (defaults.stringArray(forKey: InstagramInformationalAccounts.storageKey)
                ?? InstagramInformationalAccounts.initialAccounts)
                .compactMap(InstagramInformationalAccounts.normalizedUsername)
        )).sorted()
        for service in SocialService.allCases {
            let key = audioPreferenceKey(service)
            if service == .instagram {
                // The fixed Instagram shell no longer exposes the old native
                // audio toggle. Do not let a legacy off value strand every
                // future session in a muted state with no way to recover.
                audioPreferences[service] = true
                if defaults.object(forKey: key) == nil || !defaults.bool(forKey: key) {
                    defaults.set(true, forKey: key)
                }
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

    func requestFreshServiceAccessReceipt() {
        serviceAccessReceipt.invalidate()
        lastConfirmedServiceAccess = nil
    }

    func confirmServiceAccess() async -> Bool {
        var confirmed = false
        defer {
            lastConfirmedServiceAccess = confirmed ? ProcessInfo.processInfo.systemUptime : nil
            if !confirmed, playbackIsBackgrounded { suspendAllMedia() }
            if bundle.object(forInfoDictionaryKey: "VigilService") as? String == "all",
               let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? serviceAccessReceipt.write(confirmed: confirmed, service: fixedService, directory: directory)
            }
        }
        guard accessRestriction?() != true else { return false }
        let view = webView(for: fixedService)
        guard let url = view.url, fixedService.allowsNavigation(to: url), !view.isLoading else { return false }
        do {
            let result = try await view.callAsyncJavaScript("""
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 4000);
                try {
                    const target = new URL('/robots.txt', location.origin);
                    const response = await fetch(target.href, {
                        method: 'HEAD', cache: 'no-store', credentials: 'include',
                        redirect: 'error', signal: controller.signal
                    });
                    // An HTTP error still proves the origin is reachable. Do
                    // not reject sign-in/CAPTCHA pages just because their
                    // server declines HEAD or has no robots.txt resource.
                    return response.status >= 200 && response.status < 600 && response.url === target.href;
                } catch (_) { return false; }
                finally { clearTimeout(timeout); }
                """, arguments: [:], in: nil, contentWorld: .defaultClient)
            confirmed = result as? Bool == true
            return confirmed
        } catch { return false }
    }

    func open(_ url: URL) {
        guard let link = SocialIncomingLink(url) else { return }
        open(link)
    }

    func open(_ link: SocialIncomingLink) {
        guard link.service == fixedService, accessRestriction?() != true else { return }
        let destination = link.destination
        if link.service == .youtube, link.grantsExternalPlayback,
           let id = SocialIncomingLink.youtubeVideoID(destination) {
            Task { @MainActor in
                let reply = await YouTubeLimitsConnection.send(["action": "external", "videoId": id], bundle: bundle)
                guard reply["ok"] as? Bool == true else {
                    health[fixedService] = .advisory(reply["message"] as? String ?? "Your watch time could not be checked.")
                    return
                }
                webView(for: fixedService).load(URLRequest(url: destination))
            }
        } else {
            webView(for: fixedService).load(URLRequest(url: destination))
        }
    }

    @discardableResult
    func addInstagramInformationalAccount(_ input: String) -> Bool {
        guard let username = InstagramInformationalAccounts.normalizedUsername(input) else { return false }
        guard !instagramInformationalAccounts.contains(username) else { return true }
        instagramInformationalAccounts.append(username)
        instagramInformationalAccounts.sort()
        saveInstagramInformationalAccounts()
        return true
    }

    func removeInstagramInformationalAccount(_ username: String) {
        instagramInformationalAccounts.removeAll { $0 == username }
        saveInstagramInformationalAccounts()
    }

    private func saveInstagramInformationalAccounts() {
        defaults.set(instagramInformationalAccounts, forKey: InstagramInformationalAccounts.storageKey)
        guard let webView = webViews[.instagram], let previous = instagramControlsUserScript else { return }
        let replacement = WKUserScript(
            source: DOMAdapters.installedControlsScript(for: .instagram, informationalAccounts: instagramInformationalAccounts),
            injectionTime: .atDocumentEnd, forMainFrameOnly: true
        )
        let controller = webView.configuration.userContentController
        // Materialize before removal: WebKit can expose a bridged live array
        // and return copies of WKUserScript rather than the original objects.
        let scripts = controller.userScripts.map { script in
            script.source == previous.source && script.isForMainFrameOnly
                ? replacement : script
        }
        controller.removeAllUserScripts()
        for script in scripts { controller.addUserScript(script) }
        instagramControlsUserScript = replacement
        // Reload clears all old author decisions, including in-flight lookups and
        // verified story paths, so removal cannot retain an exception in memory.
        webView.reload()
    }

    func webView(for requestedService: SocialService) -> WKWebView {
        let service = requestedService == fixedService ? requestedService : fixedService
        if let existing = webViews[service] { return existing }

        let controller = WKUserContentController()
        let bridge = ScriptMessageBridge { [weak self] message in
            Task { @MainActor in self?.handle(message, service: service) }
        }
        controller.add(bridge, name: "vigil")
        if service == .youtube {
            controller.addUserScript(WKUserScript(source: Self.youtubeOrientationScript,
                injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        if service == .youtube {
            controller.addScriptMessageHandler(YouTubeLimitsMessageBridge(bundle: bundle) { [weak self] body, reply in
                await self?.receivedYouTubePlaybackAuthorization(body: body, reply: reply)
            }, contentWorld: .page, name: "vigilYouTube")
            controller.addUserScript(WKUserScript(source: YouTubeExternalPlaybackScript.source,
                injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .defaultClient))
            if let resource = bundle.url(forResource: "youtube-limits", withExtension: "js"),
               let source = try? String(contentsOf: resource, encoding: .utf8) {
                controller.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            }
        }
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.documentStartScript(
                for: service,
                unclassifiedMediaPolicy: unclassifiedMediaPolicy,
                audioEnabled: audioEnabled(for: service),
                contentSafetyEnabled: service != .instagram
            ),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameSafetyScript(
                for: service,
                audioEnabled: audioEnabled(for: service),
                contentSafetyEnabled: service != .instagram
            ),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: DOMAdapters.installedFrameRoutePolicyGuard(for: service),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: false
        ))
        let controlsUserScript = WKUserScript(
            source: DOMAdapters.installedControlsScript(for: service, informationalAccounts: instagramInformationalAccounts),
            injectionTime: .atDocumentEnd,
            forMainFrameOnly: true
        )
        controller.addUserScript(controlsUserScript)
        if service == .instagram { instagramControlsUserScript = controlsUserScript }
        let youtubeParitySource = service == .youtube
            ? Self.bundledYouTubeParityScript(in: bundle)
            : nil
        if let youtubeParitySource {
            controller.addUserScript(WKUserScript(
                source: youtubeParitySource,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            ))
        }

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = websiteDataStore ?? .default()
        configuration.allowsAirPlayForMediaPlayback = false
        // Every other service keeps the previous no-external-video behavior.
        // The isolated YouTube script exposes PiP only for classified watch
        // media with a persisted ledger reservation.
        configuration.allowsPictureInPictureMediaPlayback = service == .youtube
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        // LinkedIn loads its Apple handler asynchronously after the tap. The
        // native delegate still accepts only the confined authentication popup.
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = service == .linkedin
        configuration.defaultWebpagePreferences.preferredContentMode = service == .snapchat
            ? .desktop
            : .mobile
        if service == .youtube {
            configuration.applicationNameForUserAgent =
                YouTubeWebCompatibility.unsupportedSafariApplicationNameSuffix
        }

        let webView = WKWebView(frame: .zero, configuration: configuration)
        if service == .snapchat {
            webView.customUserAgent = SnapchatWebCompatibility.desktopSafariUserAgent
        }
        // RootView applies the exact SwiftUI environment style once the view
        // is mounted, but the first Instagram navigation begins before that
        // representable callback. Seed WebKit from UIKit's current trait first
        // so its initial media-query/layout paint cannot use light appearance
        // for one frame on a dark device.
        if service == .instagram {
            let initialStyle = UITraitCollection.current.userInterfaceStyle
            if initialStyle == .dark || initialStyle == .light {
                webView.overrideUserInterfaceStyle = initialStyle
            }
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // Finalize viewport geometry before the first navigation. RootView
        // keeps Instagram, Snapchat, and LinkedIn inside the safe area, so
        // automatic scroll insets would apply that spacing a second time. One
        // invariant policy also prevents the startup resize/flicker seen when
        // Instagram hydrates its fixed shell.
        webView.scrollView.contentInsetAdjustmentBehavior = service == .instagram || service == .snapchat || service == .linkedin
            ? .never
            : .automatic
        if service == .instagram {
            // Resolve the initial canvas against the seeded appearance; the
            // representable supplies the matching page surface once mounted.
            webView.isOpaque = true
            webView.backgroundColor = .systemBackground
            webView.scrollView.backgroundColor = .systemBackground
        }
        webViews[service] = webView
        serviceByWebView[ObjectIdentifier(webView)] = service
        messageBridges[service] = bridge
        SocialMessageNotificationBridge.install(on: webView, service: service) { [weak self] in
            guard let self else { return false }
            return !self.mediaPlaybackIsSuspended && self.hasRecentConfirmedAccess
                && self.accessRestriction?() != true
        }
        if service == .youtube, youtubeParitySource == nil {
            health[service] = .unsupported(
                "This YouTube build is missing its ordinary-watch gesture policy."
            )
        } else if loadInitialPages {
            // Navigation runs in WebKit's processes. Start it before finishing
            // the local scroll/gesture chrome so those independent setup paths
            // overlap during a cold launch.
            // Snapchat's /web landing can return a mobile download shell before
            // it ever offers login. Begin with first-party authentication;
            // its continue URL returns the persistent session to friend chat.
            let initialURL = service == .snapchat
                ? SnapchatWebCompatibility.loginURL
                : service.homeURL
            webView.load(URLRequest(url: initialURL))
        }

        webView.allowsBackForwardNavigationGestures = service.allowsBackForwardNavigationGestures
        webView.allowsLinkPreview = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.isDirectionalLockEnabled = service.usesDirectionalScrollLock
        webView.scrollView.keyboardDismissMode = .interactive
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(self, action: #selector(refreshWebView(_:)), for: .valueChanged)
        refreshControl.isEnabled = false
        webView.scrollView.refreshControl = refreshControl
        // UIKit enables vertical bounce when a refresh control is attached.
        // Reassert the fail-closed state until the page reports a safe route.
        webView.scrollView.alwaysBounceVertical = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
        // Opt in only for a paired developer-tool launch when diagnosing the
        // installed Personal Team build. Ordinary launches remain unchanged.
        if ProcessInfo.processInfo.environment["VIGIL_WEB_INSPECT"] == "1",
           #available(iOS 16.4, *) { webView.isInspectable = true }
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

    func usesFullBleedTop(for service: SocialService) -> Bool {
        service == .instagram && surfaceStates[service]?.fullBleedTop == true
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
        if service == .snapchat {
            // Restart the first-party handoff with the existing cookie store.
            // Reloading a failed post-login document can replay a consumed
            // ticket, while a download shell has already exhausted recovery.
            cancelDocumentWork(for: service)
            health[service] = .loading
            setSurface(.unknown, for: service)
            webView(for: service).load(URLRequest(url: SnapchatWebCompatibility.loginURL))
            return
        }
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
        stopYouTubeExternalPlayback()
        managedWebViews.forEach { $0.evaluateJavaScript("window.__vigilPauseAllMedia?.();") }
    }

    func suspendAllMedia(relinquishExternalPlayback: Bool = true) {
        stopYouTubeExternalPlayback()
        externalPlaybackMayRelinquish = SocialMediaSuspensionPolicy.relinquishesGlobalAudio(
            requested: relinquishExternalPlayback, serviceIsVisible: playbackServiceIsVisible)
        externalPlaybackRelinquishTask?.cancel()
        guard !mediaPlaybackIsSuspended else {
            if externalPlaybackMayRelinquish { InstagramExternalPlaybackPolicy.relinquish() }
            return
        }
        mediaPlaybackIsSuspended = true
        externalPlaybackRelinquishTask?.cancel()
        if externalPlaybackMayRelinquish { InstagramExternalPlaybackPolicy.relinquish() }

        managedWebViews.forEach { webView in
            webView.evaluateJavaScript(
                "window.__vigilSuspendAllMedia ? window.__vigilSuspendAllMedia() : window.__vigilPauseAllMedia?.();"
            )
            // Submit the page hook first so it can record site playback intent.
            // Do not wait on its completion: a wedged page must still become
            // externally unplayable as the scene backgrounds.
            webView.setAllMediaPlaybackSuspended(true) { [weak self] in
                guard let self, self.mediaPlaybackIsSuspended else { return }
                if self.externalPlaybackMayRelinquish { InstagramExternalPlaybackPolicy.relinquish() }
            }
        }

        guard externalPlaybackMayRelinquish else { return }
        externalPlaybackRelinquishTask = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 250_000_000)
            guard !Task.isCancelled,
                  let self,
                  self.mediaPlaybackIsSuspended,
                  self.externalPlaybackMayRelinquish else { return }
            InstagramExternalPlaybackPolicy.relinquish()
        }
    }

    func resumeSuspendedMedia() {
        guard accessRestriction?() != true else { suspendAllMedia(); return }
        guard mediaPlaybackIsSuspended else { return }
        mediaPlaybackIsSuspended = false
        externalPlaybackRelinquishTask?.cancel()
        externalPlaybackRelinquishTask = nil
        managedWebViews.forEach { webView in
            webView.setAllMediaPlaybackSuspended(false) { [weak self, weak webView] in
                guard let self, let webView, !self.mediaPlaybackIsSuspended else { return }
                webView.evaluateJavaScript("window.__vigilResumeSuspendedMedia?.();")
            }
        }
    }

    func setYouTubeBackgroundPlaybackEnabled(_ enabled: Bool) {
        guard fixedService == .youtube else { return }
        youtubeBackgroundPlaybackEnabled = enabled
        defaults.set(enabled, forKey: "VigilSocial.youtube.backgroundPlayback")
        if !enabled && playbackIsBackgrounded { suspendAllMedia() }
    }

    func setYouTubePictureInPictureEnabled(_ enabled: Bool) {
        guard fixedService == .youtube else { return }
        youtubePictureInPictureEnabled = enabled
        defaults.set(enabled, forKey: "VigilSocial.youtube.pictureInPicture")
        updateYouTubePictureInPicturePermission()
    }

    func requestYouTubePictureInPicture() async -> Bool {
        guard fixedService == .youtube, youtubePictureInPictureEnabled,
              accessRestriction?() != true,
              let snapshot = await youtubePlaybackSnapshot(),
              hasFreshPermittedVideoFrameCheck(snapshot),
              externalPlaybackAuthorization.permits(snapshot, accessConfirmed: hasRecentConfirmedAccess,
                                                     restricted: false), snapshot.playing,
              let webView = webViews[.youtube] else { return false }
        youtubeExternalPlaybackAvailable = true
        updateYouTubePictureInPicturePermission()
        let result = try? await webView.callAsyncJavaScript(
            "return window.__vigilRequestExternalPictureInPicture?.() === true;",
            arguments: [:], in: nil, contentWorld: .defaultClient)
        let requested = result as? Bool == true
        if !requested { health[.youtube] = .advisory("Picture-in-picture is unavailable for this video on this device.") }
        return requested
    }

    // A scene can become inactive for PiP or for the lock screen. Continue only
    // the already-playing YouTube watch player permitted by the install policy;
    // never resume a paused player or hidden companion to stay alive.
    func handleSceneActivity(_ active: Bool, isServiceVisible: Bool) async {
        sceneActivityGeneration &+= 1
        let generation = sceneActivityGeneration
        playbackServiceIsVisible = isServiceVisible
        playbackIsBackgrounded = !active
        if active {
            externalPlaybackPolicyProbe?.cancel()
            externalPlaybackPolicyProbe = nil
            if !isServiceVisible || accessRestriction?() == true {
                suspendAllMedia(relinquishExternalPlayback: isServiceVisible)
            }
            return
        }
        guard isServiceVisible, fixedService == .youtube,
              accessRestriction?() != true,
              !mediaPlaybackIsSuspended,
              let snapshot = await youtubePlaybackSnapshot(),
              generation == sceneActivityGeneration else {
            if generation == sceneActivityGeneration {
                suspendAllMedia(relinquishExternalPlayback: isServiceVisible)
            }
            return
        }
        externalPlaybackAuthorization.sample(snapshot)
        guard snapshot.playing,
              hasFreshPermittedVideoFrameCheck(snapshot),
              youtubeBackgroundPlaybackEnabled || (youtubePictureInPictureEnabled && snapshot.pictureInPicture),
              externalPlaybackAuthorization.permits(snapshot, accessConfirmed: hasRecentConfirmedAccess,
                                                     restricted: false) else { suspendAllMedia(); return }
        guard activateYouTubeAudioSession() else { suspendAllMedia(); return }
        scheduleYouTubeCreditDeadline(snapshot)
        ensureYouTubeExternalPlaybackMonitor()
        externalPlaybackPolicyProbe?.cancel()
        externalPlaybackPolicyProbe = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self, self.playbackIsBackgrounded,
                      self.playbackServiceIsVisible, !self.mediaPlaybackIsSuspended else { return }
                guard await self.confirmServiceAccess() else { return }
                try? await Task.sleep(nanoseconds: 4_000_000_000)
            }
        }
    }

    private var hasRecentConfirmedAccess: Bool {
        guard let lastConfirmedServiceAccess else { return false }
        let age = ProcessInfo.processInfo.systemUptime - lastConfirmedServiceAccess
        return age >= 0 && age < 10
    }

    private func receivedYouTubePlaybackAuthorization(body: [String: Any], reply: [String: Any]) async {
        guard fixedService == .youtube else { return }
        if let lease = reply["lease"] as? [String: Any], let id = lease["videoId"] as? String {
            guard let url = webViews[.youtube]?.url,
                  ["/watch", "/watch/"].contains(url.path),
                  SocialIncomingLink.youtubeVideoID(url) == id else { return }
        }
        externalPlaybackAuthorization.receive(request: body, reply: reply)
        if let snapshot = await youtubePlaybackSnapshot() {
            // Capture a paused baseline before a new ledger reply reaches the
            // page and starts playback. Renewals retain accumulated progress.
            externalPlaybackAuthorization.sample(snapshot)
            youtubeExternalPlaybackAvailable = externalPlaybackAuthorization.permits(
                snapshot, accessConfirmed: hasRecentConfirmedAccess, restricted: accessRestriction?() == true)
                && hasFreshPermittedVideoFrameCheck(snapshot)
            if youtubeExternalPlaybackAvailable { scheduleYouTubeCreditDeadline(snapshot) }
        } else { youtubeExternalPlaybackAvailable = false }
        updateYouTubePictureInPicturePermission()
        ensureYouTubeExternalPlaybackMonitor()
    }

    private func ensureYouTubeExternalPlaybackMonitor() {
        guard fixedService == .youtube, externalPlaybackAuthorization.hasLease,
              externalPlaybackMonitor == nil else { return }
        externalPlaybackMonitorGeneration &+= 1
        let generation = externalPlaybackMonitorGeneration
        externalPlaybackMonitor = Task { @MainActor [weak self] in
            defer {
                if self?.externalPlaybackMonitorGeneration == generation { self?.externalPlaybackMonitor = nil }
            }
            while !Task.isCancelled {
                guard let self, self.externalPlaybackAuthorization.hasLease else { return }
                guard let snapshot = await self.youtubePlaybackSnapshot() else {
                    if !Task.isCancelled, self.externalPlaybackMonitorGeneration == generation { self.suspendAllMedia() }
                    return
                }
                guard !Task.isCancelled, self.externalPlaybackMonitorGeneration == generation else { return }
                self.externalPlaybackAuthorization.sample(snapshot)
                let allowed = self.externalPlaybackAuthorization.permits(
                    snapshot, accessConfirmed: self.hasRecentConfirmedAccess,
                    restricted: self.accessRestriction?() == true) && self.hasFreshPermittedVideoFrameCheck(snapshot)
                self.youtubeExternalPlaybackAvailable = allowed
                self.updateYouTubePictureInPicturePermission()
                if allowed { self.scheduleYouTubeCreditDeadline(snapshot) }
                if allowed, snapshot.playing,
                   self.youtubeBackgroundPlaybackEnabled || snapshot.pictureInPicture,
                   !self.activateYouTubeAudioSession() {
                    self.suspendAllMedia()
                    return
                }
                if self.accessRestriction?() == true
                    || ((self.playbackIsBackgrounded || snapshot.pictureInPicture) && !allowed)
                    || (self.playbackIsBackgrounded && !snapshot.playing) {
                    self.suspendAllMedia()
                    return
                }
                try? await Task.sleep(nanoseconds: 200_000_000)
            }
        }
    }

    private func youtubePlaybackSnapshot() async -> YouTubeExternalPlaybackSnapshot? {
        guard let webView = webViews[.youtube] else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<YouTubeExternalPlaybackSnapshot?, Never>) in
            var completed = false
            let timeout = Task { @MainActor in
                try? await Task.sleep(nanoseconds: 750_000_000)
                guard !Task.isCancelled, !completed else { return }
                completed = true
                continuation.resume(returning: nil)
            }
            webView.callAsyncJavaScript("return window.__vigilExternalPlaybackSnapshot?.();",
                                       arguments: [:], in: nil, in: .defaultClient) { result in
                Task { @MainActor in
                    guard !completed else { return }
                    completed = true
                    timeout.cancel()
                    switch result {
                    case .success(let value): continuation.resume(returning: YouTubeExternalPlaybackSnapshot(result: value))
                    case .failure: continuation.resume(returning: nil)
                    }
                }
            }
        }
    }

    private func updateYouTubePictureInPicturePermission() {
        guard fixedService == .youtube, let webView = webViews[.youtube] else { return }
        let id = youtubeExternalPlaybackAvailable ? externalPlaybackAuthorization.videoID : nil
        webView.callAsyncJavaScript("window.__vigilExternalPlaybackPermission?.(videoID, enabled);",
            arguments: ["videoID": id as Any? ?? NSNull(), "enabled": youtubePictureInPictureEnabled],
            in: nil, in: .defaultClient, completionHandler: nil)
    }

    private func stopYouTubeExternalPlayback() {
        guard fixedService == .youtube else { return }
        externalPlaybackAuthorization.reset()
        youtubeExternalPlaybackAvailable = false
        externalPlaybackMonitor?.cancel()
        externalPlaybackMonitor = nil
        externalPlaybackMonitorGeneration &+= 1
        externalPlaybackPolicyProbe?.cancel()
        externalPlaybackPolicyProbe = nil
        externalPlaybackCreditDeadline?.cancel()
        externalPlaybackCreditDeadline = nil
        if youtubeAudioSessionIsActive {
            youtubeAudioSessionIsActive = false
            InstagramExternalPlaybackPolicy.relinquish()
        }
        webViews[.youtube]?.callAsyncJavaScript("window.__vigilStopExternalPlayback?.();",
            arguments: [:], in: nil, in: .defaultClient, completionHandler: nil)
    }

    private func activateYouTubeAudioSession() -> Bool {
        guard !youtubeAudioSessionIsActive else { return true }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .moviePlayback)
            try session.setActive(true)
            youtubeAudioSessionIsActive = true
            return true
        } catch { return false }
    }

    private func scheduleYouTubeCreditDeadline(_ snapshot: YouTubeExternalPlaybackSnapshot) {
        externalPlaybackCreditDeadline?.cancel()
        externalPlaybackCreditDeadline = nil
        guard snapshot.playing, playbackIsBackgrounded || snapshot.pictureInPicture else { return }
        let milliseconds = min(5_000, externalPlaybackAuthorization.remainingPlaybackMilliseconds)
        guard milliseconds > 0 else { suspendAllMedia(); return }
        let lease = externalPlaybackAuthorization.leaseID
        externalPlaybackCreditDeadline = Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(milliseconds * 1_000_000))
            guard !Task.isCancelled, let self, self.externalPlaybackAuthorization.leaseID == lease else { return }
            // A wedged WebKit sample must not keep playing past the persisted
            // reservation. Successful progress samples and renewals re-arm it.
            self.suspendAllMedia()
        }
    }

    private func hasFreshPermittedVideoFrameCheck(_ snapshot: YouTubeExternalPlaybackSnapshot) -> Bool {
        guard let id = snapshot.mediaID else { return false }
        return YouTubeExternalPlaybackFramePolicy.isFresh(
            completedAt: permittedYouTubeVideoFrameCheckTimes[id],
            uptime: ProcessInfo.processInfo.systemUptime)
    }

    private func recordYouTubeVideoFrameCheck(_ request: MediaClassificationRequest,
                                             verdict: ContentSafetyVerdict,
                                             completedValidFrameCheck: Bool) {
        guard request.key.service == .youtube, request.frame.isMainFrame,
              request.kind == "videoFrame",
              request.key.documentID == mainDocumentIDs[.youtube] else { return }
        let permitted = YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
            verdict: verdict, policy: unclassifiedMediaPolicy,
            completedValidFrameCheck: completedValidFrameCheck)
        permittedYouTubeVideoFrameCheckTimes[request.key.id] = permitted ? ProcessInfo.processInfo.systemUptime : nil
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
        if service == .instagram {
            // A settled friend-feed empty state is sticky against background
            // pagination, but an intentional pull must visibly begin a fresh
            // loading cycle before WebKit swaps in the reloaded document.
            webView.evaluateJavaScript("window.__vigilResetFriendsFeedForRefresh?.();")
            DispatchQueue.main.async { [weak webView] in
                webView?.reload()
            }
        } else {
            webView.reload()
        }
    }

    // Watch pages only: feed previews must never unlock browsing rotation.
    static let youtubeOrientationScript = """
    (() => {
      let previous;
      const update = () => {
        const watch = location.pathname === '/watch' && new URLSearchParams(location.search).has('v');
        const video = document.querySelector('video');
        const fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement || video?.webkitDisplayingFullscreen);
        const allowed = Boolean(watch && video && !video.ended &&
          ((!video.paused && video.readyState >= 2) || fullscreen));
        if (allowed === previous) return;
        previous = allowed;
        window.webkit.messageHandlers.vigil.postMessage({type: 'videoOrientation', allowed});
      };
      for (const event of ['playing', 'pause', 'ended', 'emptied', 'loadeddata',
        'fullscreenchange', 'webkitfullscreenchange', 'webkitbeginfullscreen',
        'webkitendfullscreen', 'popstate', 'yt-navigate-finish']) {
        document.addEventListener(event, update, true);
        window.addEventListener(event, update, true);
      }
      setInterval(update, 250);
      update();
    })();
    """

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
        case "videoOrientation":
            guard service == .youtube, frame.isMainFrame else { return }
            let allowed = body["allowed"] as? Bool == true
            if youtubeAllowsLandscape != allowed { youtubeAllowsLandscape = allowed }
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
            let nextHealth: AdapterHealth
            switch body["state"] as? String {
            case "ready":
                servicesWithUsableContent.insert(service)
                nextHealth = .ready
            case "unsupported": nextHealth = .unsupported(detail)
            case "degraded":
                nextHealth = isAdvisoryHealthMessage(detail)
                    || Self.isRecoverableInstagramHealthReport(
                        detail,
                        service: service,
                        hadUsableContent: servicesWithUsableContent.contains(service)
                    )
                    ? .advisory(detail)
                    : .degraded(detail)
            default: nextHealth = .loading
            }
            if health[service] != nextHealth { health[service] = nextHealth }
        case "audio":
            guard let enabled = body["enabled"] as? Bool,
                  audioPreferences[service] != enabled else { return }
            audioPreferences[service] = enabled
            defaults.set(enabled, forKey: audioPreferenceKey(service))
        case "chromeColor":
            guard service == .snapchat, frame.isMainFrame,
                  let rgb = body["rgb"] as? [Double], rgb.count == 3,
                  rgb.allSatisfy({ $0.isFinite && (0...255).contains($0) }) else { return }
            let color = UIColor(red: CGFloat(rgb[0] / 255), green: CGFloat(rgb[1] / 255),
                                blue: CGFloat(rgb[2] / 255), alpha: 1)
            if snapchatChromeColor != color { snapchatChromeColor = color }
        case "appearance":
            guard let dark = body["dark"] as? Bool,
                  darkChromePreferences[service] != dark else { return }
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
                    blocksRefresh: blocksRefresh,
                    fullBleedTop: body["fullBleedTop"] as? Bool ?? false
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
            kind: body["kind"] as? String,
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
            let classifier = resolvedMediaClassifier()
            let requestID = request.requestID
            let dataURL = request.dataURL
            let isYouTubeVideoFrame = key.service == .youtube && request.frame.isMainFrame && request.kind == "videoFrame"
            let task = Task { [weak self] in
                guard !Task.isCancelled else {
                    self?.retireNativeMediaClassification(requestID)
                    return
                }
                let captured = await Task.detached(priority: .userInitiated) {
                    let data = Self.decodeInlineMedia(dataURL)
                    return (data: data, validFrame: isYouTubeVideoFrame && YouTubeExternalPlaybackFramePolicy.isValidCapturedFrame(data))
                }.value
                guard !Task.isCancelled else {
                    self?.retireNativeMediaClassification(requestID)
                    return
                }
                let verdict = if let inlineData = captured.data {
                    await classifier.classify(imageData: inlineData)
                } else {
                    ContentSafetyVerdict.unknown
                }
                let wasCancelled = Task.isCancelled
                await self?.nativeMediaClassificationReturned(
                    for: key,
                    requestID: requestID,
                    verdict: verdict,
                    completedValidFrameCheck: captured.validFrame,
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
        completedValidFrameCheck: Bool,
        wasCancelled: Bool
    ) async {
        nativeMediaClassificationExecutions.remove(requestID)
        guard !wasCancelled,
              let request = activeMediaRequests[key],
              request.requestID == requestID else {
            pumpMediaClassifications()
            return
        }
        await finishMediaClassification(request, verdict: verdict,
                                        completedValidFrameCheck: completedValidFrameCheck)
    }

    private func retireNativeMediaClassification(_ requestID: UUID) {
        nativeMediaClassificationExecutions.remove(requestID)
        pumpMediaClassifications()
    }

    private func finishMediaClassification(
        _ request: MediaClassificationRequest,
        verdict: ContentSafetyVerdict,
        completedValidFrameCheck: Bool
    ) async {
        guard activeMediaRequests[request.key]?.requestID == request.requestID else { return }
        activeMediaRequests.removeValue(forKey: request.key)
        mediaClassificationTasks.removeValue(forKey: request.key)
        mediaClassificationDeadlineTasks.removeValue(forKey: request.key)?.cancel()

        let shouldResolve = retireLatestMediaRequestIfCurrent(request)
        pumpMediaClassifications()

        guard shouldResolve else { return }
        recordYouTubeVideoFrameCheck(request, verdict: verdict,
                                    completedValidFrameCheck: completedValidFrameCheck)
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
        recordYouTubeVideoFrameCheck(request, verdict: .unknown, completedValidFrameCheck: false)
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
        recordYouTubeVideoFrameCheck(request, verdict: .unknown, completedValidFrameCheck: false)
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
            self.recordYouTubeVideoFrameCheck(request, verdict: .unknown, completedValidFrameCheck: false)
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
        if service == .youtube { permittedYouTubeVideoFrameCheckTimes.removeAll() }
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
        let classifier = resolvedTextClassifier()
        Task { [weak self] in
            guard let self else { return }
            let verdict = await classifier.classify(
                pageText: completeText,
                wasTruncated: inspection.wasTruncated
            )
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

    private func resolvedMediaClassifier() -> any MediaSafetyClassifying {
        if let mediaClassifier { return mediaClassifier }
        let classifier = AppleSensitiveMediaClassifier()
        mediaClassifier = classifier
        return classifier
    }

    private func resolvedTextClassifier() -> any PageTextSafetyClassifying {
        if let textClassifier { return textClassifier }
        let classifier = ConservativePageTextClassifier()
        textClassifier = classifier
        return classifier
    }

    private func service(for webView: WKWebView) -> SocialService? {
        serviceByWebView[ObjectIdentifier(webView)]
    }

    static func bundledYouTubeParityScript(in bundle: Bundle) -> String? {
        guard let url = bundle.url(forResource: "youtube-parity", withExtension: "js"),
              let responseURL = bundle.url(forResource: "youtube-player-response", withExtension: "js"),
              let controls = try? String(contentsOf: url, encoding: .utf8),
              let responseGuard = try? String(contentsOf: responseURL, encoding: .utf8) else { return nil }
        return responseGuard + "\n" + controls
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

    private func verifyInstalledAdapter(for service: SocialService, in webView: WKWebView) {
        let generation = mainDocumentGenerations[service, default: 0]
        Task { @MainActor [weak self, weak webView] in
            guard let self, let webView else { return }
            let installed = try? await webView.evaluateJavaScript(
                DOMAdapters.mainFrameInstallationProbe(for: service)
            ) as? Bool
            guard self.webViews[service] === webView,
                  self.mainDocumentGenerations[service, default: 0] == generation,
                  installed != true else { return }
            // Registered document-end scripts are the normal installation
            // path. Send the full adapter only as a recovery fallback; doing
            // it after every successful navigation made WebKit parse the
            // large Instagram adapter twice during cold launch.
            _ = try? await webView.evaluateJavaScript(DOMAdapters.script(
                for: service,
                audioEnabled: self.audioEnabled(for: service),
                contentSafetyEnabled: service != .instagram,
                informationalAccounts: self.instagramInformationalAccounts
            ))
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
        if surfaceStates[service] != surface { surfaceStates[service] = surface }
        guard let webView = webViews[service] else { return }
        if service == .instagram {
            // WebKit supplies the same interactive back/forward transition as
            // Safari. Route-gating it keeps center-screen carousels, Stories,
            // Reels, feed swipes, and modals entirely owned by Instagram.
            webView.allowsBackForwardNavigationGestures = surface.allowsInstagramEdgeBack
        }
        let scrollView = webView.scrollView
        let allowsRefresh = surface.allowsRefresh
        let isRefreshing = refreshingServices.contains(service)
        // A reload temporarily reports an unknown surface. Keep the active
        // refresh presentation alive until navigation completes, while
        // disabling the control so a second pull cannot start concurrently.
        scrollView.refreshControl?.isEnabled = allowsRefresh && !isRefreshing
        scrollView.alwaysBounceVertical = allowsRefresh || isRefreshing
        if !allowsRefresh && !isRefreshing {
            scrollView.refreshControl?.endRefreshing()
        }
    }

    static func provisionalInstagramSurface(for url: URL) -> SocialSurfaceState {
        let path = url.path.lowercased()
        let isReels = path == "/reel" || path.hasPrefix("/reel/")
            || path == "/reels" || path.hasPrefix("/reels/")
        let isStory = path == "/stories" || path.hasPrefix("/stories/")
        return SocialSurfaceState(
            route: isReels ? "reels" : isStory ? "story" : "unknown",
            refreshEligible: false,
            blocksRefresh: true,
            // The stable Instagram wrapper never changes the WKWebView frame
            // during navigation. Instagram's own mobile layout stays inside
            // the ordinary iOS safe area on every route.
            fullBleedTop: false
        )
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
        if Self.shouldPreserveInstagramSurface(
            after: nsError,
            service: service,
            hadUsableContent: servicesWithUsableContent.contains(service)
        ) {
            health[service] = .advisory(
                "Instagram briefly lost its connection. The page you were using is still open."
            )
            return
        }
        health[service] = .degraded(error.localizedDescription)
        setSurface(.unknown, for: service)
    }

    nonisolated static func isRecoverableInstagramHealthReport(
        _ detail: String,
        service: SocialService,
        hadUsableContent: Bool
    ) -> Bool {
        guard service == .instagram, hadUsableContent else { return false }
        return detail.localizedCaseInsensitiveContains("has not loaded a usable")
            || detail.localizedCaseInsensitiveContains("reported an error instead of a usable")
    }

    nonisolated static func shouldPreserveInstagramSurface(
        after error: NSError,
        service: SocialService,
        hadUsableContent: Bool
    ) -> Bool {
        guard service == .instagram,
              hadUsableContent,
              error.domain == NSURLErrorDomain else { return false }
        return [
            NSURLErrorTimedOut,
            NSURLErrorCannotFindHost,
            NSURLErrorCannotConnectToHost,
            NSURLErrorNetworkConnectionLost,
            NSURLErrorDNSLookupFailed,
            NSURLErrorResourceUnavailable,
            NSURLErrorNotConnectedToInternet
        ].contains(error.code)
    }

    private func isAdvisoryHealthMessage(_ detail: String) -> Bool {
        detail.localizedCaseInsensitiveContains("intentionally unavailable")
            || detail.localizedCaseInsensitiveContains("signed out")
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
        guard let url else { return nil }
        // Authentication helper URLs may carry one-time session state. Never
        // replay them after WebKit terminates its content process; return to
        // the service-owned entry point and let the site restart auth safely.
        if service.usesUnmodifiedAuthenticationDocument(url) {
            if service == .snapchat { return SnapchatWebCompatibility.loginURL }
            return service.homeURL
        }
        guard
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
    }

    private func audioPreferenceKey(_ service: SocialService) -> String {
        "VigilSocial.audio.\(service.rawValue)"
    }

    private func playbackKey(_ videoID: String) -> String {
        "\(Self.youtubePlaybackPositionNamespace).\(videoID)"
    }

    private func javascriptString(_ value: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [value]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }

    static func shouldHandoffContentLink(from service: SocialService, to url: URL) -> Bool {
        // Existing first-party authentication exceptions stay in their original
        // session even when that authentication host is also a new service.
        guard !service.allowsNavigation(to: url), let link = SocialIncomingLink(url) else { return false }
        return link.service != service
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
    let kind: String?
    let dataURL: String?
    let frame: WKFrameInfo
}

struct SocialSurfaceState: Equatable {
    let route: String
    let refreshEligible: Bool
    let blocksRefresh: Bool
    let fullBleedTop: Bool

    init(
        route: String,
        refreshEligible: Bool,
        blocksRefresh: Bool,
        fullBleedTop: Bool = false
    ) {
        self.route = route
        self.refreshEligible = refreshEligible
        self.blocksRefresh = blocksRefresh
        self.fullBleedTop = fullBleedTop
    }

    static let unknown = SocialSurfaceState(
        route: "unknown",
        refreshEligible: false,
        blocksRefresh: true
    )

    var allowsRefresh: Bool {
        refreshEligible && !blocksRefresh
    }

    var allowsInstagramEdgeBack: Bool {
        // Instagram owns horizontal gestures on feeds, carousels, Stories,
        // Reels, modals, and unclassified pages. Only routes with an explicit
        // history-backed detail surface opt in to the native edge recognizer.
        switch route {
        case "post", "profile", "directThread": true
        default: false
        }
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

        preferences.preferredContentMode = service == .snapchat ? .desktop : .mobile

        if service == .linkedin, navigationAction.targetFrame == nil,
           navigationAction.sourceFrame.isMainFrame,
           LinkedInAppleAuthentication.allowsPopupStart(url, from: webView.url) {
            decisionHandler(.allow, preferences)
            return
        }

        if navigationAction.targetFrame?.isMainFrame == false {
            guard service.allowsEmbeddedNavigation(to: url, mainDocumentURL: webView.url) else {
                decisionHandler(.cancel, preferences)
                return
            }
        } else {
            if navigationAction.navigationType == .linkActivated,
               Self.shouldHandoffContentLink(from: service, to: url),
               let openSocialLink {
                decisionHandler(.cancel, preferences)
                openSocialLink(url)
                return
            }
            guard service.allowsNavigation(to: url) else {
                decisionHandler(.cancel, preferences)
                return
            }
            if service == .instagram,
               InstagramSingleReelPolicy.blocksNavigation(from: webView.url, to: url) {
                decisionHandler(.cancel, preferences)
                return
            }
            if service == .tiktok,
               TikTokSingleItemPolicy.blocksNavigation(from: webView.url, to: url) {
                decisionHandler(.cancel, preferences)
                return
            }
            if service.isRestrictedSurface(url) {
                health[service] = .advisory("That short-form surface is intentionally unavailable.")
                decisionHandler(.cancel, preferences)
                return
            }
            // Establish the host frame before Instagram measures a new main
            // document. Waiting for the document-end surface report made the
            // same WKWebView grow beneath an already-snapped Reel, leaving its
            // account and caption one navigation-bar height too low.
            if service == .instagram {
                setSurface(Self.provisionalInstagramSurface(for: url), for: service)
            }
        }

        // SocialService has already confined this request to the companion's
        // HTTPS host/path allowlist. No general-purpose adult-domain index is
        // needed for an app that cannot navigate to arbitrary sites.
        decisionHandler(.allow, preferences)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation?) {
        youtubeAllowsLandscape = false
        guard let service = service(for: webView) else { return }
        if service == .youtube { stopYouTubeExternalPlayback(); lastConfirmedServiceAccess = nil }
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
        let provisionalFullBleedTop = service == .instagram
            ? surfaceStates[service]?.fullBleedTop ?? false
            : false
        setSurface(
            SocialSurfaceState(
                route: "unknown",
                refreshEligible: false,
                blocksRefresh: true,
                fullBleedTop: provisionalFullBleedTop
            ),
            for: service
        )
        scheduleNavigationHealthTimeout(for: service, generation: generation)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation?) {
        guard let service = service(for: webView) else { return }
        guard !service.usesUnmodifiedAuthenticationDocument(webView.url) else { return }
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
        verifyInstalledAdapter(for: service, in: webView)
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
            if webView.url != safeURL || webView.reload() == nil {
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
        if service(for: webView) == .linkedin, navigationAction.targetFrame == nil,
           navigationAction.sourceFrame.isMainFrame,
           let url = navigationAction.request.url,
           LinkedInAppleAuthentication.allowsPopupStart(url, from: webView.url) {
            return makeLinkedInApplePopup(configuration: configuration, opener: webView, url: url)
        }
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url, let currentService = service(for: webView),
           Self.shouldHandoffContentLink(from: currentService, to: url), let openSocialLink {
            openSocialLink(url)
            return nil
        }
        guard let service = service(for: webView),
              let request = Self.validatedPopupRequest(
                  navigationAction.request,
                  for: service
              ) else { return nil }
        webView.load(request)
        return nil
    }

    func makeLinkedInApplePopup(configuration: WKWebViewConfiguration, opener: WKWebView, url: URL) -> WKWebView? {
        guard fixedService == .linkedin, linkedInApplePopup == nil,
              LinkedInAppleAuthentication.allowsPopupStart(url, from: opener.url),
              var presenter = opener.window?.rootViewController else { return nil }
        while let presented = presenter.presentedViewController { presenter = presented }
        let popup = LinkedInApplePopupController(configuration: configuration)
        popup.onClose = { [weak self] in self?.linkedInApplePopup = nil }
        linkedInApplePopup = popup
        presenter.present(popup, animated: true)
        // WebKit loads the supplied request itself and retains window.opener.
        // Replaying it in the main web view loses Apple's web_message reply.
        return popup.webView
    }
}

@MainActor
final class LinkedInApplePopupController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    var onClose: (() -> Void)?
    private var authorized = false

    init(configuration: WKWebViewConfiguration) {
        // Use WebKit's popup configuration to preserve the opener and cookie
        // store, but give auth its own controller with no content scripts or
        // native bridges. Navigation below is confined to authentication.
        configuration.userContentController = WKUserContentController()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init(nibName: nil, bundle: nil)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsLinkPreview = false
        isModalInPresentation = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let bar = UINavigationBar()
        let item = UINavigationItem(title: "Sign in with Apple")
        item.rightBarButtonItem = UIBarButtonItem(barButtonSystemItem: .cancel, target: self, action: #selector(close))
        bar.items = [item]
        for child in [bar, webView] {
            child.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(child)
        }
        NSLayoutConstraint.activate([
            bar.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: bar.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        ])
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        if !authorized, url.absoluteString == "about:blank" {
            decisionHandler(.allow)
            return
        }
        let mainFrame = action.targetFrame?.isMainFrame == true
        guard action.targetFrame != nil,
              LinkedInAppleAuthentication.allowsNavigation(url, authorized: authorized, isMainFrame: mainFrame) else {
            decisionHandler(.cancel)
            return
        }
        if mainFrame, LinkedInAppleAuthentication.isAuthorizationURL(url) { authorized = true }
        decisionHandler(.allow)
    }

    func webViewDidClose(_ webView: WKWebView) { close() }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { close() }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    @objc func close() {
        webView.stopLoading()
        dismiss(animated: true) { [weak self] in
            self?.onClose?()
            self?.onClose = nil
        }
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

// WebKit owns the reply channel, including during document-start navigation.
// Do not inject callbacks into a URL that may have changed while awaiting I/O.
@MainActor
private final class YouTubeLimitsMessageBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let bundle: Bundle
    private let observeReply: @MainActor ([String: Any], [String: Any]) async -> Void
    init(bundle: Bundle, observeReply: @escaping @MainActor ([String: Any], [String: Any]) async -> Void) {
        self.bundle = bundle
        self.observeReply = observeReply
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "https",
              ["youtube.com", "www.youtube.com", "m.youtube.com"].contains(origin.host.lowercased()),
              let envelope = message.body as? [String: Any],
              var body = envelope["body"] as? [String: Any],
              body["action"] as? String != "external" else {
            replyHandler(["ok": false, "message": "Open YouTube in the Vigil app to use Watch Later."], nil)
            return
        }
        body["client"] = "ios:" + (body["client"] as? String ?? "").prefix(100)
        Task { @MainActor in
            let reply = await YouTubeLimitsConnection.send(body, bundle: bundle)
            await observeReply(body, reply)
            replyHandler(reply, nil)
        }
    }
}
