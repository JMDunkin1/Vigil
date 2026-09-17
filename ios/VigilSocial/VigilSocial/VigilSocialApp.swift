import SwiftUI
import SafariServices

@main
struct VigilSocialApp: App {
    @StateObject private var store = SocialWebViewStore()

    var body: some Scene {
        WindowGroup {
            Group {
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
                .onOpenURL { url in
                    if store.fixedService == .instagram,
                       url.scheme == "vigil-instagram", url.host == "safari-settings" {
                        openFocusedExtensionSettings()
                    } else {
                        store.open(url)
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
