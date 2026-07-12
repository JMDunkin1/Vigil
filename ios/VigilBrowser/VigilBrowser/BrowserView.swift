import SwiftUI
import WebKit

struct BrowserView: View {
    @ObservedObject var store: BrowserStore

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "lock.shield.fill").foregroundStyle(.green)
                    TextField("Search or enter website", text: $store.address)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.webSearch)
                        .submitLabel(.go)
                        .onSubmit(store.submitAddress)
                    if store.isLoading { ProgressView().controlSize(.small) }
                }
                .padding(10)
                .background(Color(uiColor: .secondarySystemBackground))
                BrowserWebView(webView: store.webView).ignoresSafeArea(.container, edges: .bottom)
            }
            .navigationTitle(store.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button(action: store.goBack) { Label("Back", systemImage: "chevron.backward") }.disabled(!store.canGoBack)
                    Button(action: store.goForward) { Label("Forward", systemImage: "chevron.forward") }.disabled(!store.canGoForward)
                    Spacer()
                    Text(store.status).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    Button(action: store.reload) { Label("Reload", systemImage: "arrow.clockwise") }
                }
            }
        }
    }
}
private struct BrowserWebView: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
