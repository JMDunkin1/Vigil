import SwiftUI

@main
struct SentinelSocialApp: App {
    @StateObject private var store = SocialWebViewStore()

    var body: some Scene {
        WindowGroup {
            NavigationStack {
                RootView(store: store)
                    .toolbar(.hidden, for: .navigationBar)
            }
            .onOpenURL { store.open($0) }
        }
    }
}
