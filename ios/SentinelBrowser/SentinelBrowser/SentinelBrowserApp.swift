import SwiftUI

@main
struct SentinelBrowserApp: App {
    @StateObject private var browser = BrowserStore()

    var body: some Scene {
        WindowGroup { BrowserView(store: browser) }
    }
}
