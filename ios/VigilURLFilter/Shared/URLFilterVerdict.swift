import Foundation
import NetworkExtension

enum VigilURLFilterVerdict {
    /// For clients that do not use WebKit, CFNetwork, or Network.framework.
    /// Unknown is denied so a provider/PIR failure cannot silently bypass Vigil.
    @available(iOS 26.0, macOS 26.0, macCatalyst 26.0, *)
    static func allowsVoluntaryRequest(to url: URL) async -> Bool {
        switch await NEURLFilter.verdict(for: url) {
        case .allow:
            true
        case .deny, .unknown:
            false
        @unknown default:
            false
        }
    }
}
