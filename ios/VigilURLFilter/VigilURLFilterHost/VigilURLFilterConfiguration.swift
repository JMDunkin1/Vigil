import Foundation
import NetworkExtension

struct VigilURLFilterServiceConfiguration: Sendable {
    let pirServerURL: URL
    let privacyPassIssuerURL: URL?
    let authenticationToken: String
    let controlProviderBundleIdentifier: String
    let prefilterFetchInterval: TimeInterval

    init(
        pirServerURL: URL,
        privacyPassIssuerURL: URL?,
        authenticationToken: String,
        controlProviderBundleIdentifier: String = "tech.caseline.vigil.url-filter.control",
        prefilterFetchInterval: TimeInterval = 6 * 60 * 60
    ) throws {
        guard pirServerURL.scheme?.lowercased() == "https",
              privacyPassIssuerURL == nil || privacyPassIssuerURL?.scheme?.lowercased() == "https",
              !authenticationToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !controlProviderBundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              prefilterFetchInterval >= 15 * 60
        else { throw VigilURLFilterConfigurationError.invalidServiceConfiguration }
        self.pirServerURL = pirServerURL
        self.privacyPassIssuerURL = privacyPassIssuerURL
        self.authenticationToken = authenticationToken
        self.controlProviderBundleIdentifier = controlProviderBundleIdentifier
        self.prefilterFetchInterval = prefilterFetchInterval
    }
}

enum VigilURLFilterConfigurationError: LocalizedError {
    case unsupportedOS
    case invalidServiceConfiguration

    var errorDescription: String? {
        switch self {
        case .unsupportedOS: "Vigil system-wide URL filtering requires iOS 26 or later."
        case .invalidServiceConfiguration: "The Vigil PIR service configuration is invalid."
        }
    }
}

enum VigilURLFilterConfiguration {
    /// Enables fail-closed URL filtering after a provisioned PIR service has
    /// supplied its endpoint and short-lived authentication token.
    @MainActor
    static func install(_ service: VigilURLFilterServiceConfiguration) async throws {
        guard #available(iOS 26.0, *) else { throw VigilURLFilterConfigurationError.unsupportedOS }
        let manager = NEURLFilterManager.shared
        try await manager.loadFromPreferences()
        try manager.setConfiguration(
            pirServerURL: service.pirServerURL,
            pirPrivacyPassIssuerURL: service.privacyPassIssuerURL,
            pirAuthenticationToken: service.authenticationToken,
            controlProviderBundleIdentifier: service.controlProviderBundleIdentifier
        )
        manager.shouldFailClosed = true
        manager.prefilterFetchInterval = service.prefilterFetchInterval
        manager.isEnabled = true
        try await manager.saveToPreferences()
    }

    @MainActor
    static func status() async throws -> String {
        guard #available(iOS 26.0, *) else { return "unsupported" }
        let manager = NEURLFilterManager.shared
        try await manager.loadFromPreferences()
        return String(describing: await manager.status)
    }
}
