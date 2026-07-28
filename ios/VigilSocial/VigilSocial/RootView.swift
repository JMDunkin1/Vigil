import SwiftUI
import WebKit

struct RootView: View {
    @ObservedObject var store: SocialWebViewStore
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let service = store.selectedService
        let reportedIsDark = store.reportedChromeIsDark(for: service)
        let isDark = reportedIsDark ?? (colorScheme == .dark)
        ZStack {
            (isDark ? Color.black : Color.white)
                .ignoresSafeArea()

            SocialWebView(
                webView: store.webView(for: service),
                isDark: isDark
            )
                .id(service)
                .ignoresSafeArea(.container, edges: .bottom)

            healthOverlay(
                store.health[service] ?? .loading,
                service: service,
                isDark: isDark
            )
        }
            .preferredColorScheme(reportedIsDark.map { $0 ? .dark : .light })
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { store.pauseAllMedia() }
            }
    }

    @ViewBuilder
    private func healthOverlay(
        _ health: AdapterHealth,
        service: SocialService,
        isDark: Bool
    ) -> some View {
        switch health {
        case .ready:
            EmptyView()
        case .loading:
            SocialHealthOverlay(
                title: "Loading \(service.displayName)",
                message: "Preparing a protected \(service.displayName) session.",
                systemImage: nil,
                isLoading: true,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: nil,
                secondaryAction: nil,
                dismissAction: nil
            )
        case let .advisory(detail):
            SocialHealthNotice(
                message: detail,
                isDark: isDark,
                dismissAction: { store.dismissHealth(for: service) }
            )
        case let .degraded(detail):
            SocialHealthOverlay(
                title: "\(service.displayName) didn’t load",
                message: detail.isEmpty ? "Please try again." : detail,
                systemImage: "wifi.exclamationmark",
                isLoading: false,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: { store.retry(service) },
                secondaryAction: { store.goHome(service) },
                dismissAction: nil
            )
        case let .unsupported(detail):
            SocialHealthOverlay(
                title: "\(service.displayName) needs attention",
                message: detail.isEmpty
                    ? "This version of the page is not currently supported."
                    : detail,
                systemImage: "exclamationmark.triangle.fill",
                isLoading: false,
                isDark: isDark,
                serviceName: service.displayName,
                primaryAction: { store.retry(service) },
                secondaryAction: { store.goHome(service) },
                dismissAction: nil
            )
        }
    }
}

private struct SocialHealthNotice: View {
    let message: String
    let isDark: Bool
    let dismissAction: () -> Void

    var body: some View {
        VStack {
            Spacer()
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "info.circle.fill")
                    .foregroundStyle(.secondary)
                Text(message)
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Dismiss", action: dismissAction)
                    .font(.footnote.weight(.semibold))
            }
            .padding(14)
            .foregroundStyle(isDark ? Color.white : Color.black)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14))
            .padding()
        }
        .allowsHitTesting(true)
        .accessibilityElement(children: .contain)
    }
}

private struct SocialHealthOverlay: View {
    let title: String
    let message: String
    let systemImage: String?
    let isLoading: Bool
    let isDark: Bool
    let serviceName: String
    let primaryAction: (() -> Void)?
    let secondaryAction: (() -> Void)?
    let dismissAction: (() -> Void)?

    var body: some View {
        VStack(spacing: 18) {
            if isLoading {
                ProgressView()
                    .controlSize(.large)
            } else if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 34, weight: .semibold))
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 8) {
                Text(title)
                    .font(.headline)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if primaryAction != nil || secondaryAction != nil || dismissAction != nil {
                VStack(spacing: 10) {
                    if let primaryAction {
                        Button("Try Again", action: primaryAction)
                            .buttonStyle(.borderedProminent)
                    }
                    if let secondaryAction {
                        Button("Go to \(serviceName) Home", action: secondaryAction)
                            .buttonStyle(.bordered)
                    }
                    if let dismissAction {
                        Button("Continue", action: dismissAction)
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(isDark ? Color.white : Color.black)
        .background((isDark ? Color.black : Color.white).ignoresSafeArea())
        .accessibilityElement(children: .contain)
    }
}

private struct SocialWebView: UIViewRepresentable {
    let webView: WKWebView
    let isDark: Bool

    func makeUIView(context: Context) -> WKWebView {
        applyInterfaceStyle(to: webView)
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        applyInterfaceStyle(to: uiView)
    }

    private func applyInterfaceStyle(to webView: WKWebView) {
        webView.overrideUserInterfaceStyle = isDark ? .dark : .light
    }
}
