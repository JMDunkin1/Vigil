import Foundation

enum SocialService: String, CaseIterable, Identifiable {
    case instagram
    case youtube

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .instagram: "Instagram"
        case .youtube: "YouTube"
        }
    }

    var systemImage: String {
        switch self {
        case .instagram: "camera"
        case .youtube: "play.rectangle"
        }
    }

    var homeURL: URL {
        switch self {
        case .instagram:
            // The public root is a marketing shell on signed-out mobile WebKit.
            // Authenticated sessions are redirected back to the feed by Instagram.
            URL(string: "https://www.instagram.com/accounts/login/")!
        case .youtube:
            URL(string: "https://m.youtube.com/")!
        }
    }

    var allowsBackForwardNavigationGestures: Bool {
        switch self {
        case .instagram:
            // Preserve Instagram's horizontal carousels and inbox gestures;
            // WebKit's edge history recognizer competes with those gestures.
            false
        case .youtube:
            // YouTube uses edge-back navigation, while its in-page horizontal
            // controls continue to be handled by the mobile site.
            true
        }
    }

    var usesDirectionalScrollLock: Bool {
        switch self {
        case .instagram:
            // Instagram intentionally mixes horizontal and vertical movement.
            false
        case .youtube:
            // Keep vertical watch/feed motion from drifting into horizontal UI.
            true
        }
    }

    func isCanonicalAppHost(_ host: String) -> Bool {
        let normalized = host.lowercased()
        switch self {
        case .instagram:
            return normalized == "instagram.com" || normalized == "www.instagram.com"
        case .youtube:
            return ["youtube.com", "www.youtube.com", "m.youtube.com"].contains(normalized)
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
        return nil
    }

    func allowsNavigation(to url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443 else { return false }
        let host = url.host?.lowercased() ?? ""
        switch self {
        case .instagram:
            if Self.host(host, matches: "instagram.com") { return true }
            guard Self.host(host, matches: "facebook.com") else { return false }
            let path = url.path.lowercased()
            return path == "/login.php"
                || path.hasPrefix("/login/")
                || path.hasPrefix("/dialog/oauth")
                || path.contains("/dialog/oauth")
                || path.hasPrefix("/checkpoint/")
        case .youtube:
            return ["youtube.com", "www.youtube.com", "m.youtube.com", "consent.youtube.com"].contains(host)
                || host == "youtu.be"
                || host == "accounts.google.com"
        }
    }

    func allowsEmbeddedNavigation(to url: URL) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" { return url.absoluteString.lowercased() == "about:blank" }
        return allowsNavigation(to: url) && !isRestrictedSurface(url)
    }

    func usesUnmodifiedAuthenticationDocument(_ url: URL?) -> Bool {
        guard self == .instagram,
              let url,
              url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased() else { return false }
        if Self.host(host, matches: "facebook.com") {
            return allowsNavigation(to: url)
        }
        guard Self.host(host, matches: "instagram.com") else { return false }
        let path = url.path.lowercased()
        return [
            "/accounts/login",
            "/accounts/emailsignup",
            "/accounts/signup",
            "/accounts/password",
            "/accounts/account_recovery",
            "/accounts/onetap",
            "/accounts/confirm",
            "/accounts/challenge",
            "/accounts/two_factor",
            "/accounts/verification",
            "/challenge",
            "/checkpoint",
            "/two_factor",
            "/accounts/suspended",
            "/accounts/disabled"
        ].contains { prefix in
            path == prefix || path.hasPrefix("\(prefix)/")
        }
    }

    func isRestrictedSurface(_ url: URL) -> Bool {
        guard allowsNavigation(to: url) else { return true }
        switch self {
        case .instagram:
            return false
        case .youtube:
            let path = url.path.lowercased()
            return path == "/shorts" || path.hasPrefix("/shorts/")
        }
    }

    func auxiliaryPageHealth(for url: URL) -> AdapterHealth? {
        guard allowsNavigation(to: url),
              let host = url.host?.lowercased(),
              !isCanonicalAppHost(host) else { return nil }
        switch self {
        case .instagram:
            if Self.host(host, matches: "facebook.com") {
                return .advisory("Continue signing in with Facebook. You’ll return to Instagram after authorization.")
            }
            return .advisory("This allowed Instagram page uses its original web layout.")
        case .youtube:
            switch host {
            case "accounts.google.com":
                return .advisory("Continue signing in with Google. Embedded sign-in availability is controlled by Google.")
            case "consent.youtube.com":
                return .advisory("Review YouTube’s consent choices to continue.")
            default:
                return .advisory("Opening this link in YouTube.")
            }
        }
    }

    func isUnsupportedEmbeddedAuthentication(_ url: URL) -> Bool {
        guard self == .youtube,
              url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443 else { return false }
        return url.host?.lowercased() == "accounts.google.com"
    }

    private static func host(_ host: String, matches domain: String) -> Bool {
        host == domain || host.hasSuffix(".\(domain)")
    }
}

enum AdapterHealth: Equatable {
    case loading
    case ready
    case advisory(String)
    case degraded(String)
    case unsupported(String)

    var message: String? {
        switch self {
        case .loading, .ready:
            nil
        case let .advisory(detail), let .degraded(detail), let .unsupported(detail):
            detail
        }
    }
}
