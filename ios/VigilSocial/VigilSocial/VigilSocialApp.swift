import SwiftUI

@main
struct VigilSocialApp: App {
    @StateObject private var store = SocialWebViewStore()

    var body: some Scene {
        WindowGroup {
            RootView(store: store)
            .onOpenURL { store.open($0) }
        }
    }
}
