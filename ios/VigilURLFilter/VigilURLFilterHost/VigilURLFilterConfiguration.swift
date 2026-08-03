import CryptoKit
import Foundation
import NetworkExtension

struct VigilURLFilterAudit: Codable, Sendable {
    let status: String
    let enabled: Bool
    let failClosed: Bool
    let prefilterFetchInterval: TimeInterval
    let pirServerURL: String
    let privacyPassIssuerURL: String
    let authenticationTokenSha256: String
    let controlProviderBundleIdentifier: String
    let lastDisconnectError: String
    let recordedAt: String
}

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
        guard !authenticationToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !controlProviderBundleIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              Self.isHTTPSOrigin(pirServerURL),
              privacyPassIssuerURL == nil || Self.isHTTPSOrigin(privacyPassIssuerURL!),
              prefilterFetchInterval >= 45 * 60
        else { throw VigilURLFilterConfigurationError.invalidServiceConfiguration }
        self.pirServerURL = pirServerURL
        self.privacyPassIssuerURL = privacyPassIssuerURL
        self.authenticationToken = authenticationToken
        self.controlProviderBundleIdentifier = controlProviderBundleIdentifier
        self.prefilterFetchInterval = prefilterFetchInterval
    }

    private static func isHTTPSOrigin(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https"
            && url.host != nil
            && url.user == nil
            && url.password == nil
            && url.query == nil
            && url.fragment == nil
    }
}

enum VigilURLFilterConfigurationError: LocalizedError {
    case unsupportedOS
    case invalidServiceConfiguration
    case savedConfigurationMismatch

    var errorDescription: String? {
        switch self {
        case .unsupportedOS: "Vigil system-wide URL filtering requires iOS 26 or later."
        case .invalidServiceConfiguration: "The Vigil PIR service configuration is invalid."
        case .savedConfigurationMismatch: "iOS did not retain Vigil's exact fail-closed URL Filter configuration."
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
        do {
            try await manager.saveToPreferences()
        } catch NEURLFilterManager.Error.configurationUnchanged {
            // The required configuration is already persisted.
        }
        try await manager.loadFromPreferences()
        guard manager.isEnabled,
              manager.shouldFailClosed,
              manager.prefilterFetchInterval == service.prefilterFetchInterval,
              manager.pirServerURL == service.pirServerURL,
              manager.pirPrivacyPassIssuerURL == service.privacyPassIssuerURL,
              manager.pirAuthenticationToken == service.authenticationToken,
              manager.controlProviderBundleIdentifier == service.controlProviderBundleIdentifier
        else { throw VigilURLFilterConfigurationError.savedConfigurationMismatch }
    }

    @MainActor
    static func status() async throws -> String {
        try await audit().status
    }

    @MainActor
    static func audit() async throws -> VigilURLFilterAudit {
        guard #available(iOS 26.0, *) else { throw VigilURLFilterConfigurationError.unsupportedOS }
        let manager = NEURLFilterManager.shared
        try await manager.loadFromPreferences()
        let status = await manager.status
        let lastError = await manager.lastDisconnectError
        let token = manager.pirAuthenticationToken ?? ""
        return VigilURLFilterAudit(
            status: String(describing: status),
            enabled: manager.isEnabled,
            failClosed: manager.shouldFailClosed,
            prefilterFetchInterval: manager.prefilterFetchInterval,
            pirServerURL: manager.pirServerURL?.absoluteString ?? "",
            privacyPassIssuerURL: manager.pirPrivacyPassIssuerURL?.absoluteString ?? "",
            authenticationTokenSha256: SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined(),
            controlProviderBundleIdentifier: manager.controlProviderBundleIdentifier ?? "",
            lastDisconnectError: lastError.map { String(describing: $0) } ?? "",
            recordedAt: ISO8601DateFormatter().string(from: Date())
        )
    }
}
