import SwiftUI

@main
struct VigilURLFilterHostApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @State private var filterStatus = "Checking managed filter…"

    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Image(systemName: "lock.shield")
                    .font(.largeTitle)
                Text("Vigil URL Filter")
                    .font(.headline)
                Text(filterStatus)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .task { await refreshStatus() }
            .onChange(of: scenePhase) { _, phase in
                guard phase == .active else { return }
                Task { await refreshStatus() }
            }
        }
    }

    @MainActor
    private func refreshStatus() async {
        do {
            let audit = try await VigilURLFilterConfiguration.audit()
            try saveAudit(audit)
            filterStatus = audit.status == "running"
                ? "Running • fail-closed system filtering is managed by Vigil."
                : "Managed filter status: \(audit.status)."
        } catch {
            filterStatus = "Filter configuration error: \(error.localizedDescription)"
        }
    }

    private func saveAudit(_ audit: VigilURLFilterAudit) throws {
        let documents = try FileManager.default.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let bytes = try JSONEncoder().encode(audit)
        try bytes.write(
            to: documents.appendingPathComponent("vigil-url-filter-audit.json"),
            options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
        )
    }
}
