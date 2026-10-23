import SwiftUI
import SafariServices
import Combine

@main
struct VigilSocialApp: App {
    @UIApplicationDelegateAdaptor(SocialAppDelegate.self) private var appDelegate
    @StateObject private var container = SocialContainerStore()
    @ObservedObject private var launcherShortcut = SocialLauncherShortcut.shared

    var body: some Scene {
        WindowGroup {
            Group {
                if container.isCombined {
                    SocialContainerView(container: container)
                } else {
                    let store = container.store(for: container.initialService)
                #if DEBUG
                if store.fixedService == .youtube,
                   YouTubeWKAuthDiagnosticActivation.isRequested(
                    arguments: ProcessInfo.processInfo.arguments
                   ) {
                    YouTubeWKAuthDiagnosticView(
                        autoLoad: YouTubeWKAuthDiagnosticActivation.shouldAutoLoad(
                            arguments: ProcessInfo.processInfo.arguments
                        ),
                        startAtYouTube: YouTubeWKAuthDiagnosticActivation.startsAtYouTube(
                            arguments: ProcessInfo.processInfo.arguments
                        ),
                        useUnsupportedSafariSuffix:
                            YouTubeWKAuthDiagnosticActivation.usesUnsupportedSafariSuffix(
                                arguments: ProcessInfo.processInfo.arguments
                            )
                    )
                } else {
                    RootView(store: store)
                }
                #else
                RootView(store: store)
                #endif
                }
            }
                .onChange(of: launcherShortcut.pending, initial: true) { _, pending in
                    if pending { launcherShortcut.consume(in: container) }
                }
                .task {
                    let store = container
                    SocialNotifications.shared.openService = { [weak store] service in store?.select(service) }
                    await SocialNotifications.shared.refreshAuthorization()
                    SocialNotifications.shared.rescheduleReminders(preferences: store.preferences)
                }
                .onOpenURL { url in
                    if (container.isCombined || container.initialService == .instagram),
                       url.scheme == "vigil-instagram", url.host == "safari-settings" {
                        openFocusedExtensionSettings()
                    } else {
                        container.open(url)
                    }
                }
        }
    }

    private func openFocusedExtensionSettings() {
        guard #available(iOS 26.2, *) else { return }
        SFSafariSettings.openExtensionsSettings(forIdentifiers: ["tech.caseline.vigil.instagram.youtube-controls"]) { error in
            // Record only the result of Apple's settings handoff, never browsing data.
            let result: [String: Any] = [
                "opened": error == nil,
                "error": error?.localizedDescription ?? "",
                "domain": (error as NSError?)?.domain ?? "",
                "code": (error as NSError?)?.code ?? 0
            ]
            if let data = try? JSONSerialization.data(withJSONObject: result),
               let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                try? data.write(to: directory.appendingPathComponent("safari-settings-result.json"), options: .atomic)
            }
        }
    }
}

// The plist declares the maximum supported orientations; this live mask keeps
// browsing portrait while allowing YouTube's existing video fullscreen flow.
@MainActor
final class SocialAppDelegate: NSObject, UIApplicationDelegate {
    static var orientationMask: UIInterfaceOrientationMask = .portrait

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        if Bundle.main.object(forInfoDictionaryKey: "VigilService") as? String == "all" {
            application.shortcutItems = [UIApplicationShortcutItem(
                type: SocialLauncherShortcut.type, localizedTitle: "Apps",
                localizedSubtitle: nil, icon: UIApplicationShortcutIcon(systemImageName: "square.grid.2x2"))]
        }
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = session.configuration
        configuration.delegateClass = SocialShortcutSceneDelegate.self
        return configuration
    }

    func application(_ application: UIApplication,
                     supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        Self.orientationMask
    }

    static func allowVideoLandscape(_ allowed: Bool) {
        let mask: UIInterfaceOrientationMask = allowed ? .allButUpsideDown : .portrait
        guard mask != orientationMask else { return }
        orientationMask = mask
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows {
                var controller = window.rootViewController
                while let current = controller {
                    current.setNeedsUpdateOfSupportedInterfaceOrientations()
                    controller = current.presentedViewController
                }
            }
            // Do not force landscape at playback start; respect how the user
            // holds the phone. On leaving playback, bring browsing upright.
            if !allowed { scene.requestGeometryUpdate(.iOS(interfaceOrientations: .portrait)) }
        }
    }
}

// Forward quick actions without owning a window; SwiftUI keeps its scene and URL routing.
@MainActor
final class SocialShortcutSceneDelegate: NSObject, UIWindowSceneDelegate {
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession,
               options connectionOptions: UIScene.ConnectionOptions) {
        if let shortcut = connectionOptions.shortcutItem { SocialLauncherShortcut.shared.handle(shortcut) }
    }

    func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        completionHandler(SocialLauncherShortcut.shared.handle(shortcutItem))
    }
}

// Retain a cold-launch request until the SwiftUI container subscribes.
@MainActor
final class SocialLauncherShortcut: ObservableObject {
    static let shared = SocialLauncherShortcut()
    static let type = "tech.caseline.vigil.apps"
    @Published private(set) var pending = false

    @discardableResult
    func handle(_ shortcut: UIApplicationShortcutItem) -> Bool {
        guard shortcut.type == Self.type else { return false }
        pending = true
        return true
    }

    func consume(in container: SocialContainerStore) {
        guard pending, container.isCombined else { return }
        container.showHome()
        pending = false
    }
}
