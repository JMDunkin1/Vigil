import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        SocialWebView(
            webView: store.webView(for: store.selectedService),
            colorScheme: colorScheme
        )
            .id(store.selectedService)
            .ignoresSafeArea(.container, edges: .bottom)
            .background(store.chromeIsDark(
                for: store.selectedService,
                fallback: colorScheme == .dark
            ) ? Color.black : Color.white)
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { store.pauseAllMedia() }
            }
    }
}

private struct SocialWebView: UIViewRepresentable {
    let webView: WKWebView
    let colorScheme: ColorScheme

    func makeUIView(context: Context) -> WKWebView {
        applyInterfaceStyle(to: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        applyInterfaceStyle(to: uiView)
    }

    private func applyInterfaceStyle(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = colorScheme == .dark ? .dark : .light
    }
}
