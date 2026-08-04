import SwiftUI

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
                    YouTubeWKAuthDiagnosticView()
                } else {
                    RootView(store: store)
                }
                #else
                RootView(store: store)
                #endif
            }
                .onOpenURL { store.open($0) }
        }
    }
}
