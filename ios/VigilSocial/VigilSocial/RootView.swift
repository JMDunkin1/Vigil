import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if store.fixedService == nil {
                Picker("Service", selection: Binding(
                    get: { store.selectedService },
                    set: { store.select($0) }
                )) {
                    ForEach(SocialService.allCases) { service in
                        Label(service.displayName, systemImage: service.systemImage).tag(service)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            healthBanner
            SocialWebView(webView: store.webView(for: store.selectedService))
                .id(store.selectedService)
                .ignoresSafeArea(.container, edges: .bottom)
        }
        .background(Color(uiColor: .systemBackground))
        .toolbar {
            ToolbarItemGroup(placement: .bottomBar) {
                Button { store.goBack(store.selectedService) } label: {
                    Label("Back", systemImage: "chevron.backward")
                }
                Button { store.goForward(store.selectedService) } label: {
                    Label("Forward", systemImage: "chevron.forward")
                }
                Spacer()
                Button { store.toggleAudio(for: store.selectedService) } label: {
                    Label(
                        store.audioEnabled(for: store.selectedService) ? "Mute" : "Use audio",
                        systemImage: store.audioEnabled(for: store.selectedService) ? "speaker.wave.2" : "speaker.slash"
                    )
                }
                Button { store.reload(store.selectedService) } label: {
                    Label("Reload", systemImage: "arrow.clockwise")
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { store.pauseAllMedia() }
        }
    }

    @ViewBuilder
    private var healthBanner: some View {
        switch store.health[store.selectedService] ?? .loading {
        case .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Loading \(store.selectedService.displayName)…")
            }
            .font(.footnote)
            .frame(maxWidth: .infinity)
            .padding(8)
            .background(Color.secondary.opacity(0.12))
        case .ready:
            EmptyView()
        case let .degraded(detail):
            banner(detail, color: .orange, icon: "exclamationmark.triangle")
        case let .unsupported(detail):
            banner(detail, color: .red, icon: "xmark.octagon")
        }
    }

    private func banner(_ text: String, color: Color, icon: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: icon)
            Text(text).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button("Retry") { store.reload(store.selectedService) }
        }
        .font(.footnote)
        .padding(10)
        .foregroundStyle(color)
        .background(color.opacity(0.12))
    }
}

private struct SocialWebView: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
