import SafariServices
import SwiftUI
import WebKit

struct SocialContainerView: View {
    @ObservedObject var container: SocialContainerStore
    @ObservedObject private var preferences: SocialPreferences
    @Environment(\.scenePhase) private var scenePhase
    @State private var showingOpenLink = false
    @State private var showingSettings = false
    @State private var showingHelp = false
    @State private var sharedLink = ""
    @State private var linkError: String?
    @State private var now = Date()
    @State private var trackedPostingDeadline: Date?

    init(container: SocialContainerStore) {
        self.container = container
        preferences = container.preferences
    }

    var body: some View {
        ZStack {
            ForEach(SocialService.allCases) { service in
                if let store = container.stores[service] {
                    VStack(spacing: 0) {
                        // Instagram keeps its established full-size canvas and counter.
                        // Its existing home gesture and VoiceOver actions stay available.
                        if service != .instagram { serviceNavigation(service) }
                        SocialServiceAccessView(store: store,
                                                isServiceVisible: container.selectedService == service,
                                                restriction: preferences.blockingReason(for: service, at: now))
                    }
                    .id(ObjectIdentifier(store))
                    .opacity(container.selectedService == service ? 1 : 0)
                    .allowsHitTesting(container.selectedService == service)
                    .accessibilityHidden(container.selectedService != service)
                }
            }
            if container.selectedService == nil { home }
            if !container.migrationReady {
                VStack(spacing: 16) {
                    ProgressView()
                    Text("Finishing your app migration").font(.headline)
                    Text("Vigil is preserving your usage records. Keep the phone connected until the update finishes.")
                        .foregroundStyle(.secondary)
                }
                .multilineTextAlignment(.center).padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(uiColor: .systemBackground).ignoresSafeArea())
            }
        }
        .task {
            while !container.migrationReady && !Task.isCancelled {
                container.refreshMigrationReadiness()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            SocialNotifications.shared.rescheduleReminders(preferences: preferences)
            while !Task.isCancelled {
                now = Date()
                container.enforceRestrictions(at: now)
                reconcilePostingSession()
                try? await Task.sleep(for: .seconds(1))
            }
        }
        .background(SocialHomeGesture(action: returnHome))
        .accessibilityAction(named: Text("Return to apps"), returnHome)
        .accessibilityAction(named: Text("Open settings")) { showingSettings = true }
        .accessibilityAction(named: Text("Open help")) { showingHelp = true }
        .sheet(isPresented: $showingSettings) { SocialSettingsView(container: container) }
        .sheet(isPresented: $showingHelp) {
            NavigationStack {
                SocialHelpView().toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showingHelp = false } } }
            }
        }
        .sheet(isPresented: $showingOpenLink) { sharedLinkSheet }
        .onChange(of: preferences.postingUntil) { _, _ in reconcilePostingSession() }
        .onChange(of: preferences.routines) { _, _ in SocialNotifications.shared.rescheduleReminders(preferences: preferences) }
        .onChange(of: preferences.sleepUntil) { _, _ in SocialNotifications.shared.rescheduleReminders(preferences: preferences) }
        .onChange(of: preferences.postingUntil) { _, _ in SocialNotifications.shared.rescheduleReminders(preferences: preferences) }
    }

    private var home: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Vigil").font(.largeTitle.bold())
                        Text("Your services").foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button { showingHelp = true; preferences.selectionFeedback() } label: { Image(systemName: "questionmark.circle").font(.title2) }
                        .accessibilityLabel("Help")
                        .accessibilityIdentifier("social-help")
                    Button { showingSettings = true; preferences.selectionFeedback() } label: { Image(systemName: "gearshape").font(.title2) }
                        .accessibilityLabel("Settings")
                        .accessibilityIdentifier("social-settings")
                }
                if let end = preferences.sleepRestriction(at: now)?.until {
                    Label("Sleep Mode until \(end.formatted(date: .abbreviated, time: .shortened))", systemImage: "moon.fill")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
                if let service = preferences.postingService, let end = preferences.postingUntil, end > now {
                    HStack {
                        Label("\(service.displayName) posting", systemImage: "square.and.pencil")
                        Text(end, style: .timer).monospacedDigit()
                        Spacer()
                        Button("End") { endPostingSession() }
                    }.font(.subheadline)
                }
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 16) {
                    ForEach(SocialService.allCases) { service in
                        let restriction = preferences.blockingReason(for: service, at: now)
                        Button {
                            container.select(service)
                            preferences.selectionFeedback()
                        } label: {
                            VStack(spacing: 12) {
                                if let path = Bundle.main.path(forResource: service.rawValue, ofType: "png"),
                                   let icon = UIImage(contentsOfFile: path) {
                                    Image(uiImage: icon).resizable().scaledToFit()
                                        .frame(width: 58, height: 58)
                                        .clipShape(RoundedRectangle(cornerRadius: 13))
                                } else {
                                    Image(systemName: service.systemImage).font(.largeTitle)
                                        .frame(width: 58, height: 58)
                                }
                                Text(service.displayName).font(.headline)
                                if let restriction {
                                    Text(restriction.name).font(.caption).foregroundStyle(.secondary)
                                }
                            }
                            .frame(maxWidth: .infinity).padding(.vertical, 24)
                            .background(Color(uiColor: .secondarySystemGroupedBackground),
                                        in: RoundedRectangle(cornerRadius: 24))
                        }
                        .buttonStyle(.plain)
                        .disabled(restriction != nil)
                        .accessibilityIdentifier("social-launch-\(service.rawValue)")
                        .accessibilityHint(restriction?.message ?? "Open your filtered session")
                    }
                }
                Button { showingOpenLink = true } label: { Label("Open a shared link", systemImage: "link") }
                    .buttonStyle(.bordered)
                Text("Double-tap with three fingers to return here from any service.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            .padding(24).frame(maxWidth: 650)
            .frame(maxWidth: .infinity)
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
    }

    private func serviceNavigation(_ service: SocialService) -> some View {
        VStack(spacing: 8) {
          HStack(spacing: 16) {
            Button(action: returnHome) { Label("Apps", systemImage: "square.grid.2x2") }
                .accessibilityIdentifier("social-return-home")
            Spacer(minLength: 0)
            if service == .youtube, let store = container.stores[service], store.youtubePictureInPictureEnabled {
                Button {
                    Task { if await store.requestYouTubePictureInPicture() { preferences.selectionFeedback() } }
                } label: { Image(systemName: "pip.enter") }
                    .disabled(!store.youtubeExternalPlaybackAvailable)
                    .accessibilityLabel("Start picture-in-picture")
            }
            Text(service.displayName).font(.subheadline.bold()).lineLimit(1)
            Spacer(minLength: 0)
            Menu {
                Button("Existing account") { container.selectAccount(nil, for: service); preferences.selectionFeedback() }
                ForEach(preferences.accounts(for: service)) { account in
                    Button(account.name) { container.selectAccount(account.id, for: service); preferences.selectionFeedback() }
                }
                Divider()
                Button("Manage accounts") { showingSettings = true }
            } label: { Image(systemName: "person.crop.circle") }
                .accessibilityLabel("Switch \(service.displayName) account")
                .disabled(preferences.isBlocked(for: service, at: now))
            Button { showingSettings = true; preferences.selectionFeedback() } label: { Image(systemName: "gearshape") }
                .accessibilityLabel("Settings")
          }
          if preferences.postingService == service, let end = preferences.postingUntil, end > now {
              HStack {
                  Text("Posting session").foregroundStyle(.secondary)
                  Text(end, style: .timer).monospacedDigit()
                  Spacer()
                  Button("End") { endPostingSession() }
              }.font(.caption)
          }
        }
        .font(.subheadline)
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(Color(uiColor: .systemBackground))
    }

    private func returnHome() { container.showHome(); preferences.selectionFeedback() }

    private func reconcilePostingSession() {
        guard let end = preferences.postingUntil, let service = preferences.postingService else {
            if trackedPostingDeadline != nil { SocialLiveActivity.end(); trackedPostingDeadline = nil }
            return
        }
        guard Date() < end, !preferences.isBlocked(for: service) else { endPostingSession(); return }
        if trackedPostingDeadline != end {
            trackedPostingDeadline = end
            SocialLiveActivity.start(title: "\(service.displayName) posting", endsAt: end)
        }
    }

    private func endPostingSession() {
        preferences.endPosting()
        trackedPostingDeadline = nil
        SocialLiveActivity.end()
        container.showHome()
    }

    private var sharedLinkSheet: some View {
        NavigationStack {
            Form {
                TextField("Paste a link", text: $sharedLink)
                    .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                Text("Open a supported service in your existing Vigil session. Direct YouTube videos use watch time without a Watch Later save.")
                    .font(.footnote).foregroundStyle(.secondary)
                if let linkError { Text(linkError).foregroundStyle(.red) }
                Button("Open in Vigil") {
                    guard let url = URL(string: sharedLink.trimmingCharacters(in: .whitespacesAndNewlines)),
                          let link = SocialIncomingLink(url) else {
                        linkError = "Paste a supported link. Restricted pages stay unavailable."
                        return
                    }
                    if let restriction = preferences.blockingReason(for: link.service) {
                        linkError = restriction.message
                        return
                    }
                    container.open(url)
                    showingOpenLink = false
                    sharedLink = ""
                    linkError = nil
                    preferences.selectionFeedback()
                }
            }
            .navigationTitle("Open a shared link")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showingOpenLink = false } } }
        }
        .presentationDetents([.medium, .large])
    }
}

// A loaded page becomes inaccessible immediately when policy or a routine denies it.
// The WebKit probe remains isolated from page scripts and still runs after pauses end.
private struct SocialServiceAccessView: View {
    @ObservedObject var store: SocialWebViewStore
    let isServiceVisible: Bool
    let restriction: SocialRestriction?
    @Environment(\.scenePhase) private var scenePhase
    @State private var accessConfirmed = false
    @State private var checking = true

    var body: some View {
        ZStack {
            RootView(store: store, isServiceVisible: isServiceVisible && accessConfirmed && restriction == nil)
                .opacity(accessConfirmed && restriction == nil ? 1 : 0)
                .allowsHitTesting(accessConfirmed && restriction == nil)
                .accessibilityHidden(!accessConfirmed || restriction != nil)
            if !accessConfirmed || restriction != nil {
                VStack(spacing: 16) {
                    if checking && restriction == nil { ProgressView() }
                    Text(restriction != nil ? "\(store.fixedService.displayName) is paused" :
                         (checking ? "Opening \(store.fixedService.displayName)…" : "\(store.fixedService.displayName) is unavailable"))
                        .font(.headline)
                    if let restriction { Text(restriction.message).font(.subheadline).foregroundStyle(.secondary) }
                    else if !checking {
                        Text("Vigil could not confirm access under the current web policy. This will retry automatically when access and your connection are available.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .multilineTextAlignment(.center).padding(28)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .foregroundStyle(Color.white)
                .background(Color.black.ignoresSafeArea())
                .environment(\.colorScheme, .dark)
            }
        }
        .task(id: isServiceVisible && scenePhase == .active && restriction == nil) {
            guard restriction == nil else {
                accessConfirmed = false
                store.suspendAllMedia(relinquishExternalPlayback: true)
                return
            }
            guard isServiceVisible && scenePhase == .active else {
                await store.handleSceneActivity(scenePhase == .active, isServiceVisible: isServiceVisible)
                return
            }
            accessConfirmed = false
            checking = true
            await store.handleSceneActivity(true, isServiceVisible: true)
            store.suspendAllMedia(relinquishExternalPlayback: false)
            while !Task.isCancelled {
                let allowed = await store.confirmServiceAccess()
                guard !Task.isCancelled else { return }
                accessConfirmed = allowed
                checking = !allowed && store.webView(for: store.fixedService).isLoading
                if allowed { store.resumeSuspendedMedia() }
                else { store.suspendAllMedia(relinquishExternalPlayback: false) }
                try? await Task.sleep(for: .seconds(checking ? 1 : 5))
            }
        }
    }
}

// Install on the window rather than a transparent overlay: web controls keep
// their normal hit testing, scrolling, and one/two-finger gestures.
struct SocialHomeGesture: UIViewRepresentable {
    let action: () -> Void

    func makeUIView(context: Context) -> GestureAnchor {
        let view = GestureAnchor()
        view.action = action
        return view
    }
    func updateUIView(_ uiView: GestureAnchor, context: Context) { uiView.action = action }
    static func dismantleUIView(_ uiView: GestureAnchor, coordinator: ()) { uiView.detach() }

    final class GestureAnchor: UIView, UIGestureRecognizerDelegate {
        var action: (() -> Void)?
        private weak var attachedWindow: UIWindow?
        private(set) lazy var recognizer: UITapGestureRecognizer = {
            let gesture = UITapGestureRecognizer(target: self, action: #selector(returnHome))
            gesture.numberOfTouchesRequired = 3
            gesture.numberOfTapsRequired = 2
            gesture.cancelsTouchesInView = false
            gesture.delaysTouchesBegan = false
            gesture.delaysTouchesEnded = false
            gesture.delegate = self
            return gesture
        }()
        override func didMoveToWindow() {
            super.didMoveToWindow()
            detach()
            attachedWindow = window
            window?.addGestureRecognizer(recognizer)
        }
        func detach() {
            attachedWindow?.removeGestureRecognizer(recognizer)
            attachedWindow = nil
        }
        @objc private func returnHome() { if recognizer.state == .ended { action?() } }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    var isServiceVisible = true
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    // Match Instagram's dark --ig-primary-background (#0c1014) across
    // the status area, session counter, and home-indicator safe area.
    private static let instagramDarkSurface = Color(
        red: 12.0 / 255.0,
        green: 16.0 / 255.0,
        blue: 20.0 / 255.0
    )

    private static let youtubeDarkSurface = Color(white: 15.0 / 255.0)

    var body: some View {
        let service = store.selectedService
        filteredWebView(service: service)
    }

    private func filteredWebView(service: SocialService) -> some View {
        // Match the safe-area bars to the page without feeding its background
        // back into WebKit's preferred appearance or the shared presentation.
        // Instagram retains its stable system-matched canvas during navigation.
        let isDark = (service == .instagram ? nil : store.reportedChromeIsDark(for: service))
            ?? (colorScheme == .dark)
        let primaryWebView = store.webView(for: service)
        // Keep YouTube's toolbar and canvas inside the native safe areas.
        // Extending this nested canvas beneath the bottom safe area
        // makes WebKit alternate automatic scroll insets as a short
        // document fits/unfits its viewport, triggering continuous DOM rescans.
        // Keep every service's established top inset and native home gesture.
        let webViewSafeAreaEdges: Edge.Set = service == .instagram || service == .youtube || service == .snapchat || service == .linkedin
            ? []
            : .bottom
        let defaultSurfaceColor = service == .instagram && isDark
            ? Self.instagramDarkSurface
            : (isDark ? (service == .youtube ? Self.youtubeDarkSurface : Color.black) : Color.white)
        let surfaceColor = service == .snapchat
            ? store.snapchatChromeColor.map { Color(uiColor: $0) } ?? defaultSurfaceColor
            : defaultSurfaceColor
        return ZStack {
            surfaceColor
                .ignoresSafeArea()

            VStack(spacing: 0) {
                if service == .instagram {
                    InstagramSessionCounter(
                        scenePhase: scenePhase,
                        isServiceVisible: isServiceVisible,
                        isDark: isDark,
                        surfaceColor: surfaceColor
                    )
                }

                SocialWebView(
                    webView: primaryWebView,
                    isDark: colorScheme == .dark,
                    backingColor: surfaceColor
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
            .onChange(of: isServiceVisible && scenePhase == .active && store.youtubeAllowsLandscape,
                      initial: true) { _, allowed in
                if store.fixedService == .youtube {
                    SocialAppDelegate.allowVideoLandscape(allowed)
                }
            }

            .onChange(of: scenePhase) { _, phase in
                Task { await store.handleSceneActivity(phase == .active, isServiceVisible: isServiceVisible) }
            }
            .onChange(of: isServiceVisible) { _, visible in
                Task { await store.handleSceneActivity(scenePhase == .active, isServiceVisible: visible) }
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
                isDark: true,
                serviceName: service.displayName,
                primaryAction: nil,
                secondaryAction: nil,
                dismissAction: nil
            )
            .environment(\.colorScheme, .dark)
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
    let isServiceVisible: Bool
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
            if phase == .active && isServiceVisible {
                resumeIfNeeded(at: Date())
            } else {
                pauseIfNeeded(at: Date())
            }
        }
        .onChange(of: isServiceVisible) { _, visible in
            if visible { resumeIfNeeded(at: Date()) }
            else { pauseIfNeeded(at: Date()) }
        }
        .onDisappear { pauseIfNeeded(at: Date()) }
    }

    private func elapsed(at date: Date) -> TimeInterval {
        accumulatedSeconds + max(0, activeSince.map { date.timeIntervalSince($0) } ?? 0)
    }

    private func resumeIfNeeded(at date: Date) {
        guard scenePhase == .active, isServiceVisible, activeSince == nil else { return }
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
    let backingColor: Color?

    func makeUIView(context: Context) -> WKWebView {
        applyInterfaceStyle(to: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        applyInterfaceStyle(to: uiView)
    }

    private func applyInterfaceStyle(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = isDark ? .dark : .light
        if let backingColor {
            webView.backgroundColor = UIColor(backingColor)
            webView.scrollView.backgroundColor = UIColor(backingColor)
        }
    }
}
