import SafariServices
import SwiftUI
import WebKit
import ImageIO

// These immutable bundle images are reused by the picker and launch cover.
// Downsample before decoding: the largest artwork is 1024px but the largest
// rendered icon is 104pt. NSCache also lets iOS reclaim decoded images.
@MainActor
enum SocialServiceArtwork {
    private static let images: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.countLimit = SocialService.allCases.count
        cache.totalCostLimit = 4 * 1024 * 1024
        return cache
    }()

    static func image(for service: SocialService, scale: CGFloat, bundle: Bundle = .main) -> UIImage? {
        let pixels = Int(ceil(104 * min(4, max(1, scale))))
        guard let url = bundle.url(forResource: service.rawValue, withExtension: "png") else { return nil }
        let key = "\(url.path):\(pixels)" as NSString
        if let image = images.object(forKey: key) { return image }
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: pixels
              ] as CFDictionary) else { return nil }
        let image = UIImage(cgImage: thumbnail)
        images.setObject(image, forKey: key, cost: thumbnail.bytesPerRow * thumbnail.height)
        return image
    }
}

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
                        SocialServiceAccessView(store: store,
                                                isServiceVisible: container.selectedService == service,
                                                restriction: preferences.blockingReason(for: service, at: now),
                                                onBack: returnHome)
                    }
                    .id(ObjectIdentifier(store))
                    .opacity(container.selectedService == service ? 1 : 0)
                    .allowsHitTesting(container.selectedService == service)
                    .accessibilityHidden(container.selectedService != service)
                }
            }
            if container.selectedService == nil {
                if container.isResolvingLaunch {
                    Color.black.ignoresSafeArea()
                } else { home }
            }
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
            guard scenePhase == .active else {
                container.beginLaunchHandoff()
                return
            }
            // SwiftUI delivers the Home Screen URL after constructing the scene.
            // Conceal the picker for that handoff, including a warm launch from Home.
            if container.isResolvingLaunch {
                try? await Task.sleep(for: .milliseconds(120))
                guard !Task.isCancelled else { return }
                container.finishLaunchHandoff()
            }
            SocialNotifications.shared.rescheduleReminders(preferences: preferences)
            while !Task.isCancelled {
                now = Date()
                container.enforceRestrictions(at: now)
                reconcilePostingSession()
                try? await Task.sleep(for: .seconds(1))
            }
        }
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
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    HStack {
                        Text("Vigil").font(.largeTitle.bold())
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
                    LazyVGrid(columns: [GridItem(.flexible(), spacing: 32), GridItem(.flexible())], spacing: 28) {
                        ForEach(SocialService.allCases) { service in
                            let restriction = preferences.blockingReason(for: service, at: now)
                            Button {
                                container.select(service)
                                preferences.selectionFeedback()
                            } label: {
                                SocialServiceIcon(service: service)
                                    .frame(width: 104, height: 104)
                                    .opacity(restriction == nil ? 1 : 0.45)
                                    .overlay(alignment: .bottomTrailing) {
                                        if restriction != nil {
                                            Image(systemName: "lock.fill")
                                                .font(.caption.weight(.semibold))
                                                .foregroundStyle(.white)
                                                .padding(8)
                                                .background(.black.opacity(0.75), in: Circle())
                                                .padding(6)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                            .disabled(restriction != nil)
                            .accessibilityLabel(service.displayName)
                            .accessibilityIdentifier("social-launch-\(service.rawValue)")
                            .accessibilityHint(restriction?.message ?? "Open your filtered session")
                        }
                    }
                    .frame(maxWidth: 288)
                    .frame(maxWidth: .infinity)
                    Button { showingOpenLink = true } label: { Label("Open a shared link", systemImage: "link") }
                        .buttonStyle(.bordered)
                }
                .padding(24).frame(maxWidth: 650)
                .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .center)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
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

// The service artwork fills the entire square; names remain available to VoiceOver.
struct SocialServiceIcon: View {
    let service: SocialService
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        Group {
            if let icon = SocialServiceArtwork.image(for: service, scale: displayScale) {
                Image(uiImage: icon).resizable().scaledToFit()
            } else {
                Image(systemName: service.systemImage)
                    .font(.system(size: 64))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(uiColor: .secondarySystemGroupedBackground))
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .accessibilityHidden(true)
    }
}

struct SocialLaunchScreen: View {
    let service: SocialService
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.displayScale) private var displayScale

    private var background: Color {
        switch service {
        case .snapchat: return Color(red: 1, green: 252.0 / 255.0, blue: 0)
        case .reddit: return Color(red: 1, green: 69.0 / 255.0, blue: 0)
        case .x, .tiktok: return .black
        default: return colorScheme == .dark ? .black : .white
        }
    }

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            mark
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Opening \(service.displayName)")
        .accessibilityIdentifier("social-splash-\(service.rawValue)")
        .allowsHitTesting(false)
    }

    @ViewBuilder private var mark: some View {
        switch service {
        case .instagram:
            ZStack(alignment: .topTrailing) {
                RoundedRectangle(cornerRadius: 19).stroke(lineWidth: 6)
                Circle().stroke(lineWidth: 6).frame(width: 29, height: 29).frame(maxWidth: .infinity, maxHeight: .infinity)
                Circle().frame(width: 8, height: 8).padding(12)
            }
            .frame(width: 68, height: 68)
            .foregroundStyle(LinearGradient(colors: [Color.yellow, Color.orange, Color.pink, Color.purple],
                                            startPoint: .bottomLeading, endPoint: .topTrailing))
        case .youtube:
            ZStack {
                RoundedRectangle(cornerRadius: 14).fill(Color.red).frame(width: 88, height: 62)
                Path { path in
                    path.move(to: CGPoint(x: 0, y: 0))
                    path.addLine(to: CGPoint(x: 0, y: 26))
                    path.addLine(to: CGPoint(x: 24, y: 13))
                    path.closeSubpath()
                }.fill(Color.white).frame(width: 24, height: 26).offset(x: 3)
            }
        case .facebook:
            Text("f").font(.system(size: 100, weight: .bold)).foregroundStyle(Color(red: 0.03, green: 0.40, blue: 1))
        default:
            if let icon = SocialServiceArtwork.image(for: service, scale: displayScale) {
                Image(uiImage: icon).resizable().scaledToFit().frame(width: 100, height: 100)
            }
        }
    }
}

// A loaded page becomes inaccessible immediately when policy or a routine denies it.
// The WebKit probe remains isolated from page scripts and still runs after pauses end.
private struct SocialServiceAccessView: View {
    @ObservedObject var store: SocialWebViewStore
    let isServiceVisible: Bool
    let restriction: SocialRestriction?
    let onBack: () -> Void
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
                if checking && restriction == nil {
                    SocialLaunchScreen(service: store.fixedService)
                } else {
                    VStack(spacing: 8) {
                        Text("Blocked").font(.system(size: 30, weight: .regular))
                        Button("Back", action: onBack)
                            .font(.system(size: 12))
                            .foregroundStyle(Color(red: 141.0 / 255.0, green: 179.0 / 255.0, blue: 154.0 / 255.0))
                            .frame(minWidth: 44, minHeight: 44)
                            .buttonStyle(.plain)
                    }
                    .multilineTextAlignment(.center).padding(28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .foregroundStyle(Color(white: 0.76))
                    .background(Color(red: 24.0 / 255.0, green: 26.0 / 255.0, blue: 28.0 / 255.0).ignoresSafeArea())
                    .overlay(alignment: .bottomTrailing) {
                        Text("V1-SOC-\(store.fixedService.rawValue.uppercased())-\(restriction != nil ? (restriction?.permanent == true ? "LOCK" : "ROUTINE") : "CONNECTION")")
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(Color(white: 0.46))
                            .padding(16)
                            .accessibilityHint(restriction?.message ?? store.serviceAccessDetail)
                    }
                    .environment(\.colorScheme, .dark)
                }
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
            var failedChecks = 0
            while !Task.isCancelled {
                let allowed = await store.confirmServiceAccess()
                guard !Task.isCancelled else { return }
                if allowed, store.fixedService == .snapchat || store.fixedService == .instagram {
                    // The covered child reports itself invisible until access
                    // is published; reaffirm the selected foreground service.
                    await store.handleSceneActivity(true, isServiceVisible: isServiceVisible)
                    await store.prepareForegroundInteraction()
                }
                guard !Task.isCancelled else { return }
                accessConfirmed = allowed
                failedChecks = allowed || store.serviceAccessIsSettling ? 0 : failedChecks + 1
                checking = !allowed && (store.serviceAccessIsSettling || failedChecks < 3)
                if allowed { store.resumeSuspendedMedia() }
                else { store.suspendAllMedia(relinquishExternalPlayback: false) }
                try? await Task.sleep(for: .milliseconds(checking ? 150 : 5000))
            }
        }
    }
}

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    var isServiceVisible = true
    @State private var hasShownUsablePage = false
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

    static func surfaceColor(store: SocialWebViewStore, colorScheme: ColorScheme) -> Color {
        let service = store.fixedService
        let isDark = (service == .instagram ? nil : store.reportedChromeIsDark(for: service))
            ?? (colorScheme == .dark)
        let base = service == .instagram && isDark ? instagramDarkSurface
            : (isDark ? (service == .youtube ? youtubeDarkSurface : Color.black) : Color.white)
        return service == .snapchat
            ? store.snapchatChromeColor.map { Color(uiColor: $0) } ?? base : base
    }

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
        // Keep service canvases inside the native safe areas. Extending a
        // canvas beneath the bottom safe area makes WebKit alternate automatic
        // insets as short pages fit/unfit the
        // viewport. Retained hidden services can trigger that same resize loop.
        // Native backgrounds still fill the status/home-indicator areas, and
        // the established safe area remains unchanged.
        let webViewSafeAreaEdges: Edge.Set = []
        let surfaceColor = Self.surfaceColor(store: store, colorScheme: colorScheme)
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
            .onChange(of: store.health[service], initial: true) { _, health in
                if health == .ready { hasShownUsablePage = true }
                if case .advisory = health { hasShownUsablePage = true }
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
        case .loading:
            if !hasShownUsablePage { SocialLaunchScreen(service: service) }
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
