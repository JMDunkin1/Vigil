import ExtensionFoundation
import Foundation
import NetworkExtension

@available(iOS 26.0, *)
private actor URLFilterArtifactStore {
    private var artifact: URLFilterPrefilterArtifact?

    func start() throws {
        artifact = try URLFilterPrefilterArtifact.loadBundled()
    }

    func stop() {
        artifact = nil
    }

    func prefilter(existingTag: String?) throws -> NEURLFilterPrefilter? {
        let current: URLFilterPrefilterArtifact
        if let artifact {
            current = artifact
        } else {
            current = try URLFilterPrefilterArtifact.loadBundled()
            artifact = current
        }
        if existingTag == current.metadata.tag { return nil }
        return current.systemPrefilter()
    }
}

/// Supplies only the Bloom prefilter. Apple performs the URL verdict and PIR
/// confirmation; this provider never receives browsing URLs.
@main
@available(iOS 26.0, *)
final class VigilURLFilterControlProvider: NEURLFilterControlProvider {
    private let artifacts = URLFilterArtifactStore()

    required init() {}

    func start() async throws {
        try await artifacts.start()
    }

    func stop(reason: NEProviderStopReason) async throws {
        await artifacts.stop()
    }

    func fetchPrefilter(existingPrefilterTag: String?) async throws -> NEURLFilterPrefilter? {
        try await artifacts.prefilter(existingTag: existingPrefilterTag)
    }
}
