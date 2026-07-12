import SwiftUI

@main
struct VigilBrowserApp: App {
    @StateObject private var browser = BrowserStore()

    var body: some Scene {
        WindowGroup { BrowserView(store: browser) }
    }
}
