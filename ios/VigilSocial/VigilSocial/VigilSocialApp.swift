import SwiftUI

@main
struct VigilSocialApp: App {
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
