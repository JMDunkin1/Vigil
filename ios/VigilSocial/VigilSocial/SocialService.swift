import Foundation

enum SocialService: String, CaseIterable, Identifiable {
    case instagram
    case youtube
    case snapchat

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .instagram: "Instagram"
        case .youtube: "YouTube"
        case .snapchat: "Snapchat"
        }
    }

    var systemImage: String {
        switch self {
        case .instagram: "camera"
        case .youtube: "play.rectangle"
        case .snapchat: "message"
        }
    }

    var homeURL: URL {
        switch self {
        case .instagram:
            URL(string: "https://www.instagram.com/direct/inbox/")!
        case .youtube:
            URL(string: "https://m.youtube.com/")!
        case .snapchat:
            URL(string: "https://web.snapchat.com/")!
        }
    }

    static func resolve(_ url: URL) -> SocialService? {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "vigilsocial" || scheme.hasPrefix("vigil-") {
            let candidates = [url.host, url.pathComponents.last]
                .compactMap { $0?.lowercased() }
                + [scheme.replacingOccurrences(of: "vigil-", with: "")]
            return allCases.first { candidates.contains($0.rawValue) }
        }

        guard scheme == "https" else { return nil }

        let host = url.host?.lowercased() ?? ""
        if host == "instagram.com" || host.hasSuffix(".instagram.com") { return .instagram }
        if host == "youtube.com" || host.hasSuffix(".youtube.com") || host == "youtu.be" { return .youtube }
        if host == "snapchat.com" || host.hasSuffix(".snapchat.com") { return .snapchat }
        return nil
    }

    func allowsNavigation(to url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https" else { return false }
        let host = url.host?.lowercased() ?? ""
        switch self {
        case .instagram:
            return Self.host(host, matches: "instagram.com") || Self.host(host, matches: "facebook.com")
        case .youtube:
            return Self.host(host, matches: "youtube.com")
                || host == "youtu.be"
                || host == "accounts.google.com"
        case .snapchat:
            return Self.host(host, matches: "snapchat.com")
        }
    }

    private static func host(_ host: String, matches domain: String) -> Bool {
        host == domain || host.hasSuffix(".\(domain)")
    }
}

enum AdapterHealth: Equatable {
    case loading
    case ready
    case degraded(String)
    case unsupported(String)

    var message: String? {
        switch self {
        case .loading, .ready:
            nil
        case let .degraded(detail), let .unsupported(detail):
            detail
        }
    }
}
