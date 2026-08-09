import SafariServices
import SwiftUI

struct YouTubeSafariRequest: Equatable, Identifiable {
    let id = UUID()
    let url: URL
}

struct YouTubeSafariView: View {
    let request: YouTubeSafariRequest
    @StateObject private var session = YouTubeSafariSession()

    var body: some View {
        ZStack {
            Color(.systemBackground).ignoresSafeArea()
            if session.isPreparingInitialPresentation {
                YouTubeLaunchPlaceholder()
            } else {
                VStack(spacing: 20) {
                    Image(systemName: session.isFilterEnabled == false ? "shield.slash" : "play.rectangle.fill")
                        .font(.system(size: 44, weight: .semibold))
                        .foregroundStyle(session.isFilterEnabled == false ? Color.orange : Color.red)

                    VStack(spacing: 8) {
                        Text(session.isFilterEnabled == false ? "Enable the YouTube filter" : "Focused YouTube")
                            .font(.title3.weight(.semibold))
                        Text(message)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }

                    if session.isFilterEnabled == false {
                        Button("Open Safari Extension Settings") { session.openSettings() }
                            .buttonStyle(.borderedProminent)
                        Button("Check Again") { session.refreshFilterState(andOpen: request.url) }
                            .buttonStyle(.bordered)
                    } else {
                        Button("Open YouTube") { session.open(request.url) }
                            .buttonStyle(.borderedProminent)
                    }

                    if let error = session.errorMessage {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                    }
                }
                .padding(28)
                .frame(maxWidth: 520)
            }

            YouTubeSafariPresentationAnchor(session: session)
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
        }
        .task { session.refreshFilterState(andOpen: request.url) }
        .onChange(of: request.id) { _, _ in session.refreshFilterState(andOpen: request.url) }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            session.refreshFilterState(andOpen: nil)
            session.applicationDidBecomeActive()
        }
    }

    private var message: String {
        if session.isFilterEnabled == false {
            return "In Settings, open Apps › Safari › Extensions and enable Vigil YouTube Shorts Filter. The companion stays closed until its Shorts protection is active."
        }
        return "YouTube opens in Apple’s secure Safari view, where Google sign-in is supported. Vigil removes comments and Shorts links, and blocks direct Shorts pages and reel data. Apple keeps the standard browser controls visible; they collapse as you scroll."
    }
}

private struct YouTubeLaunchPlaceholder: View {
    var body: some View {
        Image(systemName: "play.rectangle.fill")
            .font(.system(size: 44, weight: .semibold))
            .foregroundStyle(Color.red)
            .accessibilityLabel("Opening YouTube")
    }
}

@MainActor
final class YouTubeSafariSession: NSObject, ObservableObject, @preconcurrency SFSafariViewControllerDelegate {
    @Published private(set) var isFilterEnabled: Bool?
    @Published private(set) var isPresentingYouTube = false
    @Published private(set) var hasPresentedYouTube = false
    @Published private(set) var errorMessage: String?

    private weak var presentationAnchor: UIViewController?
    private weak var safariViewController: SFSafariViewController?
    private var pendingURL: URL?
    private var prewarmedOrigin: String?
    private var prewarmingToken: SFSafariViewController.PrewarmingToken?
    private var filterStateGeneration: UInt64 = 0
    private var presentationAnchorHasAppeared = false
    private var pendingPresentationTask: Task<Void, Never>?

    var isPreparingInitialPresentation: Bool {
        isFilterEnabled != false && (!hasPresentedYouTube || isPresentingYouTube)
    }

    static func contentBlockerIdentifier(appBundleIdentifier: String?) -> String? {
        appBundleIdentifier.map { "\($0).shorts-blocker" }
    }

    static func interactionExtensionIdentifier(appBundleIdentifier: String?) -> String? {
        appBundleIdentifier.map { "\($0).youtube-controls" }
    }

    func attach(to viewController: UIViewController) {
        presentationAnchor = viewController
    }

    func presentationAnchorDidAppear(_ viewController: UIViewController) {
        presentationAnchor = viewController
        presentationAnchorHasAppeared = true
        schedulePendingPresentation()
    }

    func presentationAnchorDidDisappear(_ viewController: UIViewController) {
        guard presentationAnchor === viewController else { return }
        presentationAnchorHasAppeared = false
        pendingPresentationTask?.cancel()
        pendingPresentationTask = nil
    }

    func applicationDidBecomeActive() {
        schedulePendingPresentation()
    }

    func refreshFilterState(andOpen url: URL?) {
        if let url {
            let validatedURL = validatedYouTubeURL(url)
            pendingURL = validatedURL
            prewarmConnection(to: validatedURL)
        }
        filterStateGeneration &+= 1
        let generation = filterStateGeneration
        guard let identifier = Self.contentBlockerIdentifier(appBundleIdentifier: Bundle.main.bundleIdentifier) else {
            isFilterEnabled = false
            errorMessage = "The YouTube filter identifier is missing from this build."
            return
        }
        SFContentBlockerManager.getStateOfContentBlocker(withIdentifier: identifier) { [weak self] state, error in
            Task { @MainActor in
                guard let self, self.filterStateGeneration == generation else { return }
                if let error {
                    self.isFilterEnabled = false
                    self.errorMessage = "The YouTube filter could not be checked: \(error.localizedDescription)"
                    self.dismissYouTubeIfPresented()
                    return
                }
                guard state?.isEnabled == true else {
                    self.errorMessage = nil
                    self.isFilterEnabled = false
                    self.dismissYouTubeIfPresented()
                    return
                }
                do {
                    try await SFContentBlockerManager.reloadContentBlocker(withIdentifier: identifier)
                    guard self.filterStateGeneration == generation else { return }
                    self.errorMessage = nil
                    self.isFilterEnabled = true
                    self.schedulePendingPresentation()
                } catch {
                    guard self.filterStateGeneration == generation else { return }
                    self.isFilterEnabled = false
                    self.errorMessage = "The YouTube filter could not load: \(error.localizedDescription)"
                    self.dismissYouTubeIfPresented()
                }
            }
        }
    }

    func open(_ url: URL) {
        let validatedURL = validatedYouTubeURL(url)
        pendingURL = validatedURL
        prewarmConnection(to: validatedURL)
        schedulePendingPresentation()
    }

    func openSettings() {
        guard let identifier = Self.contentBlockerIdentifier(appBundleIdentifier: Bundle.main.bundleIdentifier) else {
            errorMessage = "The YouTube filter identifier is missing from this build."
            return
        }
        if #available(iOS 26.2, *) {
            SFSafariSettings.openExtensionsSettings(forIdentifiers: [identifier]) { [weak self] error in
                Task { @MainActor in
                    self?.errorMessage = error.map { "Safari extension settings could not be opened: \($0.localizedDescription)" }
                }
            }
            return
        }
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func presentPendingURLIfPossible() {
        guard isFilterEnabled == true,
              let anchor = presentationAnchor,
              presentationAnchorHasAppeared,
              UIApplication.shared.applicationState == .active,
              let windowScene = anchor.viewIfLoaded?.window?.windowScene,
              windowScene.activationState == .foregroundActive,
              anchor.presentedViewController == nil,
              let url = pendingURL,
              !isPresentingYouTube else { return }
        pendingURL = nil
        prewarmConnection(to: url)

        let configuration = SFSafariViewController.Configuration()
        configuration.barCollapsingEnabled = true
        let controller = SFSafariViewController(url: url, configuration: configuration)
        controller.delegate = self
        controller.dismissButtonStyle = .close
        controller.modalPresentationStyle = .fullScreen
        controller.preferredControlTintColor = UIColor(red: 1, green: 0, blue: 0.2, alpha: 1)
        safariViewController = controller
        hasPresentedYouTube = true
        isPresentingYouTube = true
        anchor.present(controller, animated: true)
    }

    private func schedulePendingPresentation() {
        guard pendingPresentationTask == nil else { return }
        pendingPresentationTask = Task { @MainActor [weak self] in
            // Let SwiftUI finish the host controller's appearance transition
            // before asking the out-of-process Safari service to create a scene.
            await Task.yield()
            guard !Task.isCancelled, let self else { return }
            self.pendingPresentationTask = nil
            self.presentPendingURLIfPossible()
        }
    }

    private func dismissYouTubeIfPresented() {
        finishPrewarming()
        guard let controller = safariViewController else {
            isPresentingYouTube = false
            return
        }
        safariViewController = nil
        isPresentingYouTube = false
        controller.dismiss(animated: true)
    }

    private func validatedYouTubeURL(_ url: URL) -> URL {
        guard SocialService.youtube.allowsNavigation(to: url),
              !SocialService.youtube.isRestrictedSurface(url) else {
            return SocialService.youtube.homeURL
        }
        return url
    }

    private func prewarmConnection(to url: URL) {
        #if targetEnvironment(simulator)
        // iOS 27 Simulator can retain a prewarmed SafariViewService across an
        // app rebuild. Presenting that stale service gives SafariServices a nil
        // client application and aborts in _SFLocationManager. A real device
        // keeps the launch optimization; simulator builds favor reliability.
        return
        #else
        guard let scheme = url.scheme?.lowercased(),
              let host = url.host?.lowercased() else { return }
        let origin = "\(scheme)://\(host):\(url.port ?? (scheme == "https" ? 443 : 80))"
        guard prewarmingToken == nil || prewarmedOrigin != origin else { return }
        finishPrewarming()
        prewarmedOrigin = origin
        prewarmingToken = SFSafariViewController.prewarmConnections(to: [url])
        #endif
    }

    private func finishPrewarming() {
        prewarmingToken?.invalidate()
        prewarmingToken = nil
        prewarmedOrigin = nil
    }

    func safariViewController(
        _ controller: SFSafariViewController,
        didCompleteInitialLoad didLoadSuccessfully: Bool
    ) {
        guard safariViewController === controller else { return }
        finishPrewarming()
    }

    func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        if safariViewController === controller { safariViewController = nil }
        finishPrewarming()
        isPresentingYouTube = false
    }
}

private struct YouTubeSafariPresentationAnchor: UIViewControllerRepresentable {
    let session: YouTubeSafariSession

    func makeUIViewController(context: Context) -> PresentationAnchorViewController {
        let controller = PresentationAnchorViewController()
        controller.onAppear = { [weak session] controller in
            session?.presentationAnchorDidAppear(controller)
        }
        controller.onDisappear = { [weak session] controller in
            session?.presentationAnchorDidDisappear(controller)
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: PresentationAnchorViewController, context: Context) {
        session.attach(to: uiViewController)
    }
}

private final class PresentationAnchorViewController: UIViewController {
    var onAppear: ((UIViewController) -> Void)?
    var onDisappear: ((UIViewController) -> Void)?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        onAppear?(self)
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        onDisappear?(self)
    }
}
