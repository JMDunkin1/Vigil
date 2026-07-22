import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        SocialWebView(webView: store.webView(for: store.selectedService))
            .id(store.selectedService)
            .ignoresSafeArea(.container, edges: .bottom)
            .background(Color(uiColor: .systemBackground))
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { store.pauseAllMedia() }
            }
    }
}

private struct SocialWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
