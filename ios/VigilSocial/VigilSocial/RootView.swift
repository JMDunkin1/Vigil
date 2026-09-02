import SafariServices
import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    // Match Instagram's dark --ig-primary-background (#0c1014) across
    // the status area, session counter, and home-indicator safe area.
    private static let instagramDarkSurface = Color(
        red: 12.0 / 255.0,
        green: 16.0 / 255.0,
        blue: 20.0 / 255.0
    )

    var body: some View {
        let service = store.selectedService
        filteredWebView(service: service)
    }

    private func filteredWebView(service: SocialService) -> some View {
        // Instagram's SPA frequently changes transient container backgrounds
        // while navigating. Driving the native color scheme from those DOM
        // mutations made the entire WKWebView flash between light and dark.
        // Let iOS and Instagram share the user's system appearance instead.
        let reportedIsDark = service == .instagram
            ? nil
            : store.reportedChromeIsDark(for: service)
        let isDark = reportedIsDark ?? (colorScheme == .dark)
        let primaryWebView = store.webView(for: service)
        // Instagram stays entirely inside the native safe area. YouTube keeps
        // its original system-managed top inset and extends only beneath the
        // home indicator; extending beneath the status area can strand its
        // header above the visible viewport until the user scrolls.
        let webViewSafeAreaEdges: Edge.Set = service == .instagram
            ? []
            : .bottom
        let surfaceColor = service == .instagram && isDark
            ? Self.instagramDarkSurface
            : (isDark ? Color.black : Color.white)
        return ZStack {
            surfaceColor
                .ignoresSafeArea()

            VStack(spacing: 0) {
                if service == .instagram {
                    InstagramSessionCounter(
                        scenePhase: scenePhase,
                        isDark: isDark,
                        surfaceColor: surfaceColor
                    )
                }

                SocialWebView(
                    webView: primaryWebView,
                    isDark: isDark
                )
                    .id(ObjectIdentifier(primaryWebView))
                    .ignoresSafeArea(.container, edges: webViewSafeAreaEdges)
            }

            healthOverlay(
                store.health[service] ?? .loading,
                service: service,
                isDark: isDark
            )

            if service == .instagram {
                YouTubeContentBlockerGate(isDark: isDark)
            }
        }
            .preferredColorScheme(reportedIsDark.map { $0 ? .dark : .light })
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    store.resumeSuspendedMedia()
                } else {
                    store.suspendAllMedia()
                }
            }
    }

    @ViewBuilder
    private func healthOverlay(
        _ health: AdapterHealth,
        service: SocialService,
        isDark: Bool
    ) -> some View {
        switch health {
        case .ready:
            EmptyView()
        case .loading where service == .youtube:
            // YouTube's document-start scripts already conceal unclassified or
            // restricted content before its first paint. Keep the WKWebView on
            // screen while it loads instead of covering it until the page's
            // separate health probe eventually reports a usable DOM surface.
            EmptyView()
        case .loading where service == .instagram:
            // Instagram's WKWebView starts loading during store creation and
            // its document-end adapter remains responsible for health and
            // feature enforcement. Do not cover that live surface while the
            // adapter waits for Instagram to expose a recognizable shell.
            EmptyView()
        case .loading:
            SocialHealthOverlay(
                title: "Loading \(service.displayName)",
                message: "Preparing a protected \(service.displayName) session.",
                systemImage: nil,
                isLoading: true,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: nil,
                secondaryAction: nil,
                dismissAction: nil
            )
        case let .advisory(detail):
            SocialHealthNotice(
                message: detail,
                isDark: isDark,
                dismissAction: { store.dismissHealth(for: service) }
            )
        case let .degraded(detail):
            SocialHealthOverlay(
                title: "\(service.displayName) didn’t load",
                message: detail.isEmpty ? "Please try again." : detail,
                systemImage: "wifi.exclamationmark",
                isLoading: false,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: { store.retry(service) },
                secondaryAction: { store.goHome(service) },
                dismissAction: nil
            )
        case let .unsupported(detail):
            SocialHealthOverlay(
                title: "\(service.displayName) needs attention",
                message: detail.isEmpty
                    ? "This version of the page is not currently supported."
                    : detail,
                systemImage: "exclamationmark.triangle.fill",
                isLoading: false,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: { store.retry(service) },
                secondaryAction: { store.goHome(service) },
                dismissAction: nil
            )
        }
    }
}

private struct InstagramSessionCounter: View {
    let scenePhase: ScenePhase
    let isDark: Bool
    let surfaceColor: Color

    @State private var accumulatedSeconds: TimeInterval = 0
    @State private var activeSince: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(Self.formattedDuration(elapsed(at: context.date)))
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundStyle(isDark ? Color.white.opacity(0.72) : Color.black.opacity(0.62))
                .contentTransition(.numericText())
                .frame(maxWidth: .infinity)
                .frame(height: 20)
                .background(surfaceColor)
                .accessibilityLabel("Time on Instagram")
                .accessibilityValue(Self.formattedDuration(elapsed(at: context.date)))
        }
        .allowsHitTesting(false)
        .onAppear { resumeIfNeeded(at: Date()) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                resumeIfNeeded(at: Date())
            } else {
                pauseIfNeeded(at: Date())
            }
        }
        .onDisappear { pauseIfNeeded(at: Date()) }
    }

    private func elapsed(at date: Date) -> TimeInterval {
        accumulatedSeconds + max(0, activeSince.map { date.timeIntervalSince($0) } ?? 0)
    }

    private func resumeIfNeeded(at date: Date) {
        guard scenePhase == .active, activeSince == nil else { return }
        activeSince = date
    }

    private func pauseIfNeeded(at date: Date) {
        guard let activeSince else { return }
        accumulatedSeconds += max(0, date.timeIntervalSince(activeSince))
        self.activeSince = nil
    }

    private static func formattedDuration(_ interval: TimeInterval) -> String {
        let seconds = max(0, Int(interval.rounded(.down)))
        let hours = seconds / 3600
        let minutes = (seconds % 3600) / 60
        let remainder = seconds % 60
        if hours > 0 {
            return String(format: "%d:%02d:%02d", hours, minutes, remainder)
        }
        return String(format: "%02d:%02d", minutes, remainder)
    }
}

private struct YouTubeContentBlockerGate: View {
    let isDark: Bool
    @StateObject private var health = YouTubeContentBlockerHealth()

    var body: some View {
        Group {
            if health.isEnabled == false {
                VStack(spacing: 18) {
                    Image(systemName: "shield.slash")
                        .font(.system(size: 34, weight: .semibold))
                        .foregroundStyle(.orange)
                    VStack(spacing: 8) {
                        Text("Enable the YouTube filter")
                            .font(.headline)
                        Text(health.filterErrorMessage ?? "Vigil moved the YouTube Shorts blocker into Instagram so the old helper app can be removed. Enable Vigil YouTube Shorts Filter in Safari Extensions once.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    Button("Open Safari Extension Settings") { health.openSettings() }
                        .buttonStyle(.borderedProminent)
                    Button("Check Again") { health.refresh() }
                        .buttonStyle(.bordered)
                }
                .padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(isDark ? Color.white : Color.black)
                .background((isDark ? Color.black : Color.white).ignoresSafeArea())
            } else if health.areControlsEnabled == false {
                VStack {
                    Spacer()
                    VStack(alignment: .leading, spacing: 12) {
                        Label("Enable focused web controls", systemImage: "hand.draw")
                            .font(.headline)
                        Text(health.controlsErrorMessage ?? "Vigil Focused Web Controls is installed but disabled. Enable it and allow access to YouTube, Reddit, X, and Twitter. This retains focused YouTube gestures and removes platform-labeled mature media and reveal controls; Shorts stays blocked separately.")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("Open Extension Settings") { health.openSettings() }
                                .buttonStyle(.borderedProminent)
                            Button("Check Again") { health.refresh() }
                                .buttonStyle(.bordered)
                        }
                    }
                    .padding(18)
                    .foregroundStyle(isDark ? Color.white : Color.black)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                    .padding()
                }
            }
        }
        .task { health.scheduleInitialRefresh() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            health.scheduleInitialRefresh()
        }
    }
}

@MainActor
private final class YouTubeContentBlockerHealth: ObservableObject {
    @Published private(set) var isEnabled: Bool?
    @Published private(set) var areControlsEnabled: Bool?
    @Published private(set) var filterErrorMessage: String?
    @Published private(set) var controlsErrorMessage: String?
    private var isRefreshing = false
    private var controlsStateGeneration: UInt64 = 0
    private var initialRefreshTask: Task<Void, Never>?
    private var completedInitialRefresh = false

    private var filterIdentifier: String? {
        YouTubeSafariSession.contentBlockerIdentifier(appBundleIdentifier: Bundle.main.bundleIdentifier)
    }

    private var controlsIdentifier: String? {
        YouTubeSafariSession.interactionExtensionIdentifier(appBundleIdentifier: Bundle.main.bundleIdentifier)
    }

    func scheduleInitialRefresh() {
        guard completedInitialRefresh else {
            guard initialRefreshTask == nil else { return }
            initialRefreshTask = Task { @MainActor [weak self] in
                // These Safari-extension checks are unrelated to rendering
                // Instagram. Let WebKit claim the cold-launch CPU/I/O window
                // first; the installed extensions remain active meanwhile.
                try? await Task.sleep(nanoseconds: 400_000_000)
                guard !Task.isCancelled, let self else { return }
                self.initialRefreshTask = nil
                self.completedInitialRefresh = true
                self.refresh()
            }
            return
        }
        refresh()
    }

    func refresh() {
        refreshControlsState()
        guard let identifier = filterIdentifier else {
            isEnabled = false
            filterErrorMessage = "This build is missing the YouTube filter identifier."
            return
        }
        guard !isRefreshing else { return }
        isRefreshing = true
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: identifier) { [weak self] state, error in
            Task { @MainActor in
                guard let self else { return }
                if let error {
                    self.isRefreshing = false
                    self.isEnabled = false
                    self.filterErrorMessage = "The YouTube filter could not be checked: \(error.localizedDescription)"
                    print("Vigil YouTube content blocker enabled: false (\(error.localizedDescription))")
                    return
                }
                guard state?.isEnabled == true else {
                    self.isRefreshing = false
                    self.isEnabled = false
                    self.filterErrorMessage = nil
                    print("Vigil YouTube content blocker enabled: false")
                    return
                }
                let fingerprint = YouTubeContentBlockerReloadPolicy.buildFingerprint()
                let reloadKey = YouTubeContentBlockerReloadPolicy.reloadKey(for: identifier)
                guard UserDefaults.standard.string(forKey: reloadKey) != fingerprint else {
                    self.isRefreshing = false
                    self.isEnabled = true
                    self.filterErrorMessage = nil
                    print("Vigil YouTube content blocker enabled: true")
                    return
                }
                do {
                    try await SFContentBlockerManager.reloadContentBlocker(withIdentifier: identifier)
                    UserDefaults.standard.set(fingerprint, forKey: reloadKey)
                    self.isRefreshing = false
                    self.isEnabled = true
                    self.filterErrorMessage = nil
                    print("Vigil YouTube content blocker enabled: true")
                } catch {
                    self.isRefreshing = false
                    self.isEnabled = false
                    self.filterErrorMessage = "The YouTube filter could not load: \(error.localizedDescription)"
                    print("Vigil YouTube content blocker enabled: false (\(error.localizedDescription))")
                }
            }
        }
    }

    private func refreshControlsState() {
        controlsStateGeneration &+= 1
        let generation = controlsStateGeneration
        guard #available(iOS 26.2, *) else {
            areControlsEnabled = nil
            controlsErrorMessage = nil
            return
        }
        guard let identifier = controlsIdentifier else {
            areControlsEnabled = false
            controlsErrorMessage = "This build is missing the YouTube controls identifier."
            return
        }
        SFSafariExtensionManager.getStateOfExtension(withIdentifier: identifier) { [weak self] state, error in
            Task { @MainActor in
                guard let self, self.controlsStateGeneration == generation else { return }
                if let error {
                    self.areControlsEnabled = false
                    self.controlsErrorMessage = "The YouTube controls extension could not be checked: \(error.localizedDescription)"
                    print("Vigil YouTube controls enabled: false (\(error.localizedDescription))")
                    return
                }
                self.areControlsEnabled = state?.isEnabled == true
                self.controlsErrorMessage = nil
                print("Vigil YouTube controls enabled: \(self.areControlsEnabled == true)")
            }
        }
    }

    func openSettings() {
        let identifiers = [
            isEnabled == false ? filterIdentifier : nil,
            areControlsEnabled == false ? controlsIdentifier : nil
        ].compactMap { $0 }
        let requestedIdentifiers = identifiers.isEmpty
            ? [filterIdentifier, controlsIdentifier].compactMap { $0 }
            : identifiers
        guard !requestedIdentifiers.isEmpty else { return }
        if #available(iOS 26.2, *) {
            SFSafariSettings.openExtensionsSettings(forIdentifiers: requestedIdentifiers) { [weak self] error in
                Task { @MainActor in
                    if let error {
                        self?.controlsErrorMessage = "Safari extension settings could not be opened: \(error.localizedDescription)"
                    }
                }
            }
            return
        }
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}

enum YouTubeContentBlockerReloadPolicy {
    static func buildFingerprint(bundle: Bundle = .main) -> String {
        buildFingerprint(
            bundleIdentifier: bundle.bundleIdentifier ?? "unknown-bundle",
            version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                ?? "0",
            build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String
                ?? "0"
        )
    }

    static func buildFingerprint(
        bundleIdentifier: String,
        version: String,
        build: String
    ) -> String {
        "\(bundleIdentifier):\(version):\(build)"
    }

    static func reloadKey(for contentBlockerIdentifier: String) -> String {
        "VigilSocial.contentBlockerReload.\(contentBlockerIdentifier)"
    }
}

private struct SocialHealthNotice: View {
    let message: String
    let isDark: Bool
    let dismissAction: () -> Void

    var body: some View {
        VStack {
            Spacer()
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(.secondary)
                Text(message)
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Dismiss", action: dismissAction)
                    .font(.footnote.weight(.semibold))
            }
            .padding(14)
            .foregroundStyle(isDark ? Color.white : Color.black)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding()
        }
        .allowsHitTesting(true)
        .accessibilityElement(children: .contain)
    }
}

private struct SocialHealthOverlay: View {
    let title: String
    let message: String
    let systemImage: String?
    let isLoading: Bool
    let isDark: Bool
    let serviceName: String
    let primaryAction: (() -> Void)?
    let secondaryAction: (() -> Void)?
    let dismissAction: (() -> Void)?

    var body: some View {
        VStack(spacing: 18) {
            if isLoading {
                ProgressView()
                    .controlSize(.large)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 8) {
                Text(title)
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if primaryAction != nil || secondaryAction != nil || dismissAction != nil {
                VStack(spacing: 10) {
                    if let primaryAction {
                        Button("Try Again", action: primaryAction)
                            .buttonStyle(.borderedProminent)
                    }
                    if let secondaryAction {
                        Button("Go to \(serviceName) Home", action: secondaryAction)
                            .buttonStyle(.bordered)
                    }
                    if let dismissAction {
                        Button("Continue", action: dismissAction)
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(isDark ? Color.white : Color.black)
        .background((isDark ? Color.black : Color.white).ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }
}

private struct SocialWebView: UIViewRepresentable {
    let webView: WKWebView
    let isDark: Bool

    func makeUIView(context: Context) -> WKWebView {
        applyInterfaceStyle(to: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        applyInterfaceStyle(to: uiView)
    }

    private func applyInterfaceStyle(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = isDark ? .dark : .light
    }
}
