import SwiftUI

@main
struct VigilURLFilterHostApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 12) {
                Image(systemName: "lock.shield")
                    .font(.largeTitle)
                Text("Vigil URL Filter")
                    .font(.headline)
                Text("Provision a matching PIR service before enabling system-wide filtering.")
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()
        }
    }
}
