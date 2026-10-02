import Foundation

// Validate content links before selecting a service or granting watch time.
// Custom schemes carry the original HTTPS URL, including its timestamp.
struct SocialIncomingLink {
    let service: SocialService
    let destination: URL
    let grantsExternalPlayback: Bool

    init?(_ input: URL) {
        let components = URLComponents(url: input, resolvingAgainstBaseURL: false)
        let isHandoff = input.scheme?.lowercased() == "vigilsocial" && input.host == "open"
        let url: URL
        if isHandoff {
            let values = components?.queryItems?.filter { $0.name == "url" } ?? []
            guard values.count == 1, let value = values.first?.value,
                  let decoded = URL(string: value) else { return nil }
            url = decoded
        } else { url = input }
        guard url.user == nil, url.password == nil,
              let service = SocialService.resolve(url),
              service.allowsNavigation(to: url), !service.isRestrictedSurface(url) else { return nil }
        self.service = service
        self.grantsExternalPlayback = !isHandoff
            || components?.queryItems?.contains(where: { $0.name == "source" && $0.value == "discovery" }) != true
        if service == .youtube, let id = Self.youtubeVideoID(url),
           var normalized = URLComponents(string: "https://m.youtube.com/watch") {
            let timing = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.filter {
                ["t", "start", "end"].contains($0.name)
            } ?? []
            normalized.queryItems = [URLQueryItem(name: "v", value: id)] + timing
            normalized.fragment = url.fragment
            guard let destination = normalized.url else { return nil }
            self.destination = destination
        } else { self.destination = url }
    }

    static func youtubeVideoID(_ url: URL) -> String? {
        guard SocialService.resolve(url) == .youtube,
              SocialService.youtube.allowsNavigation(to: url),
              !SocialService.youtube.isRestrictedSurface(url) else { return nil }
        let parts = url.path.split(separator: "/")
        let candidate: String?
        if url.host?.lowercased() == "youtu.be", parts.count == 1 {
            candidate = String(parts[0])
        } else if ["/watch", "/watch/"].contains(url.path) {
            candidate = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "v" }?.value
        } else if parts.count == 2, ["live", "embed"].contains(String(parts[0])) {
            candidate = String(parts[1])
        } else { candidate = nil }
        guard let candidate, candidate.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { return nil }
        return candidate
    }
}

enum YouTubeWebCompatibility {
    // TinyTube documents this Safari-looking suffix as an unsupported way to
    // make Google's embedded sign-in surface proceed in WKWebView. It is the
    // single explicit browser-identity exception in VigilSocial.
    static let unsupportedSafariApplicationNameSuffix = "Version/17.0 Safari/605.1.15"
}

enum SnapchatWebCompatibility {
    static let loginURL = URL(string: "https://accounts.snapchat.com/v2/login?continue=https%3A%2F%2Fwww.snapchat.com%2Fweb%2F")!
    // Snapchat for Web is intentionally desktop-only even though its web app
    // is otherwise usable in modern WebKit. The focused companion presents a
    // desktop Safari identity while keeping navigation confined to Snapchat.
    static let desktopSafariUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15"
}

// LinkedIn owns the client and callback. This is its web login, not a native
// Sign in with Apple entitlement or a general Apple browsing exception.
enum LinkedInAppleAuthentication {
    static func isAuthorizationURL(_ url: URL) -> Bool {
        guard let parts = secureComponents(url),
              parts.host?.lowercased() == "appleid.apple.com",
              parts.percentEncodedPath == "/auth/authorize" else { return false }
        let items = parts.queryItems ?? []
        func single(_ name: String) -> String? {
            let matches = items.filter { $0.name == name }
            return matches.count == 1 ? matches.first?.value : nil
        }
        return single("client_id") == "com.linkedin.LinkedIn.service"
            && single("redirect_uri") == "https://www.linkedin.com/redirect"
    }

    static func allowsPopupStart(_ url: URL, from opener: URL?) -> Bool {
        guard let opener, SocialService.linkedin.isCanonicalAppHost(opener.host ?? ""),
              SocialService.linkedin.usesUnmodifiedAuthenticationDocument(opener) else { return false }
        return url.absoluteString == "about:blank" || isAuthorizationURL(url)
    }

    static func allowsNavigation(_ url: URL, authorized: Bool, isMainFrame: Bool) -> Bool {
        if isAuthorizationURL(url) { return isMainFrame }
        guard authorized, let parts = secureComponents(url) else { return false }
        let host = parts.host?.lowercased() ?? ""
        let path = parts.percentEncodedPath
        if host == "www.linkedin.com" { return path == "/redirect" }
        // Do not let a second authorization request change the relying party.
        if ["appleid.apple.com", "account.apple.com"].contains(host) {
            return path.hasPrefix("/auth/") && !path.hasPrefix("/auth/authorize")
        }
        return !isMainFrame && host == "idmsa.apple.com"
            && (["/appleauth/appleauth", "/IDMSWebAuth/acsignin"].contains(path)
                || path.hasPrefix("/appleauth/auth/"))
    }

    private static func secureComponents(_ url: URL) -> URLComponents? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil,
              !parts.percentEncodedPath.contains("%"),
              !parts.percentEncodedPath.contains("\\"),
              !parts.percentEncodedPath.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
        else { return nil }
        return parts
    }
}

enum InstagramSingleReelPolicy {
    static func blocksNavigation(from source: URL?, to destination: URL) -> Bool {
        guard let source, let current = mediaRoute(source), ["reel", "p"].contains(current.kind),
              let next = mediaRoute(destination) else { return false }
        return next.kind != current.kind || current.id != next.id
    }

    private static func mediaRoute(_ url: URL) -> (kind: String, id: String)? {
        guard ["instagram.com", "www.instagram.com"].contains(url.host?.lowercased() ?? "") else { return nil }
        let parts = url.path.split(separator: "/").map(String.init)
        let offset = parts.count == 3 ? 1 : 0
        guard parts.count == offset + 2,
              ["reel", "reels", "p"].contains(parts[offset].lowercased()) else { return nil }
        return (parts[offset].lowercased(), parts[offset + 1])
    }
}

enum SocialService: String, CaseIterable, Identifiable {
    case instagram
    case youtube
    case snapchat
    case linkedin
    case facebook
    case x
    case tiktok
    case reddit

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .instagram: "Instagram"
        case .youtube: "YouTube"
        case .snapchat: "Snapchat"
        case .linkedin: "LinkedIn"
        case .facebook: "Facebook"
        case .x: "X"
        case .tiktok: "TikTok"
        case .reddit: "Reddit"
        }
    }

    var systemImage: String {
        switch self {
        case .instagram: "camera"
        case .youtube: "play.rectangle"
        case .snapchat: "message"
        case .linkedin: "briefcase"
        case .facebook: "person.2"
        case .x: "bubble.left"
        case .tiktok: "music.note"
        case .reddit: "text.bubble"
        }
    }

    var homeURL: URL {
        switch self {
        case .instagram:
            // Go straight to the feed for an existing session. Instagram will
            // route signed-out users to its login surface itself; starting on
            // /accounts/login forced signed-in users through an avoidable
            // redirect plus the protected-document transition reload.
            URL(string: "https://www.instagram.com/")!
        case .youtube:
            // Open the app on YouTube Home. The policy adapter still redirects
            // to Subscriptions when Home recommendations are intentionally
            // blocked, and keeps Subscriptions as the permanent Shorts escape.
            URL(string: "https://m.youtube.com/")!
        case .linkedin:
            URL(string: "https://www.linkedin.com/feed/")!
        case .snapchat:
            // Snapchat now serves its desktop chat client from /web. Starting
            // on this first-party route keeps the companion out of the public
            // Stories and Spotlight surfaces on snapchat.com.
            URL(string: "https://www.snapchat.com/web/")!
        case .facebook, .x, .tiktok, .reddit:
            URL(string: focusedRoutePolicy!.homeURL)!
        }
    }

    // Posting stays inside the filtered companion. Unsupported web upload
    // flows have no shortcut into an unrestricted original app or new host.
    var postingURL: URL? {
        switch self {
        case .instagram, .youtube, .snapchat: nil
        case .linkedin: URL(string: "https://www.linkedin.com/feed/?shareActive=true")
        case .facebook: URL(string: "https://www.facebook.com/composer/")
        case .x: URL(string: "https://x.com/compose/post")
        case .tiktok: URL(string: "https://www.tiktok.com/tiktokstudio/upload?from=creator_center")
        case .reddit: URL(string: "https://www.reddit.com/submit")
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
        case .linkedin:
            true
        case .snapchat:
            // Leave chat-list and conversation swipes to Snapchat's web UI.
            false
        case .facebook, .x, .tiktok, .reddit:
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
        case .linkedin:
            true
        case .snapchat:
            false
        case .facebook, .x, .tiktok, .reddit:
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
        case .linkedin:
            return ["linkedin.com", "www.linkedin.com"].contains(normalized)
        case .snapchat:
            return ["snapchat.com", "www.snapchat.com", "web.snapchat.com"].contains(normalized)
        case .facebook, .x, .tiktok, .reddit:
            return focusedRoutePolicy?.hosts.contains(normalized) == true
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
        if host == "linkedin.com" || host == "www.linkedin.com" { return .linkedin }
        if host == "snapchat.com" || host.hasSuffix(".snapchat.com") { return .snapchat }
        for service in [SocialService.facebook, .x, .tiktok, .reddit] {
            if service.isCanonicalAppHost(host) { return service }
        }
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
            if Self.isYouTubeSessionHandoffURL(url) { return true }
            return ["youtube.com", "www.youtube.com", "m.youtube.com", "consent.youtube.com"].contains(host)
                || host == "youtu.be"
                || host == "accounts.google.com"
        case .linkedin:
            return ["linkedin.com", "www.linkedin.com"].contains(host)
        case .snapchat:
            if ["snapchat.com", "www.snapchat.com", "web.snapchat.com"].contains(host) {
                return true
            }
            return host == "accounts.snapchat.com"
        case .facebook, .x, .tiktok, .reddit:
            return focusedRoutePolicy?.canonicalPath(url) != nil
        }
    }

    func allowsEmbeddedNavigation(to url: URL, mainDocumentURL: URL? = nil) -> Bool {
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" { return url.absoluteString.lowercased() == "about:blank" }
        if self == .linkedin, Self.isLinkedInAuthenticationFrameURL(url) {
            // LinkedIn's password login uses reCAPTCHA. Permit only its exact
            // challenge documents, embedded under a first-party auth page.
            guard let mainDocumentURL,
                  isCanonicalAppHost(mainDocumentURL.host?.lowercased() ?? "") else { return false }
            return usesUnmodifiedAuthenticationDocument(mainDocumentURL)
        }
        if self == .snapchat, Self.isSnapchatAuthenticationFrameURL(url) {
            // reCAPTCHA is a child of Snap's login, never a browsing destination.
            return usesUnmodifiedAuthenticationDocument(mainDocumentURL)
                && mainDocumentURL?.host?.lowercased() == "accounts.snapchat.com"
        }
        if self == .youtube, Self.isYouTubeEmbeddedAuthenticationFrameURL(url) {
            return true
        }
        if focusedRoutePolicy != nil, Self.isRecaptchaFrameURL(url) {
            return usesUnmodifiedAuthenticationDocument(mainDocumentURL)
        }
        return allowsNavigation(to: url) && !isRestrictedSurface(url)
    }

    func usesUnmodifiedAuthenticationDocument(_ url: URL?) -> Bool {
        guard let url,
              url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443,
              let host = url.host?.lowercased() else { return false }
        if let policy = focusedRoutePolicy {
            return policy.isAuthentication(url)
        }
        if self == .youtube {
            return host == "accounts.google.com"
                || host == "consent.youtube.com"
                || Self.isYouTubeEmbeddedAuthenticationFrameURL(url)
        }
        if self == .linkedin {
            if Self.isLinkedInAuthenticationFrameURL(url) { return true }
            guard isCanonicalAppHost(host), url.user == nil, url.password == nil,
                  let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath.lowercased()
            else { return false }
            return ["/login", "/uas", "/checkpoint", "/signup", "/start", "/authwall", "/passwordreset"].contains {
                path == $0 || path.hasPrefix("\($0)/")
            }
        }
        if self == .snapchat {
            return host == "accounts.snapchat.com" || Self.isSnapchatAuthenticationFrameURL(url)
        }
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
        case .linkedin:
            let path = url.path.lowercased()
            return ["/video", "/shorts", "/feed/video", "/feed/immersive"].contains {
                path == $0 || path.hasPrefix("\($0)/")
            }
        case .snapchat:
            let host = url.host?.lowercased() ?? ""
            guard ["snapchat.com", "www.snapchat.com", "web.snapchat.com"].contains(host) else {
                return false
            }
            let path = url.path.lowercased()
            return path == "/spotlight" || path.hasPrefix("/spotlight/")
                || path == "/discover" || path.hasPrefix("/discover/")
        case .facebook, .x, .tiktok, .reddit:
            return focusedRoutePolicy?.allowsContent(url) != true
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
            case "accounts.youtube.com":
                return .advisory("Completing YouTube sign-in.")
            default:
                return .advisory("Opening this link in YouTube.")
            }
        case .linkedin:
            return .advisory("Opening this allowed LinkedIn page.")
        case .snapchat:
            if host == "accounts.snapchat.com" {
                return .advisory("Sign in with your Snapchat username, email, or phone number. Google sign-in isn’t supported in this app.")
            }
            return .advisory("Opening this allowed Snapchat page.")
        case .facebook, .x, .tiktok, .reddit:
            return .advisory("Opening this allowed \(displayName) page.")
        }
    }

    var focusedRoutePolicy: FocusedSocialRoutePolicy? {
        FocusedSocialRoutePolicy.policies[rawValue]
    }

    private static func host(_ host: String, matches domain: String) -> Bool {
        host == domain || host.hasSuffix(".\(domain)")
    }

    static func isSnapchatAuthenticationFrameURL(_ url: URL) -> Bool {
        isRecaptchaFrameURL(url)
    }

    static func isLinkedInAuthenticationFrameURL(_ url: URL) -> Bool {
        isRecaptchaFrameURL(url)
    }

    private static func isRecaptchaFrameURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443,
              url.user == nil, url.password == nil,
              ["www.google.com", "recaptcha.google.com", "www.recaptcha.net"].contains(url.host?.lowercased() ?? ""),
              let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath
        else { return false }
        // Exact documents, not a general Google or /recaptcha/ navigation allow.
        return [
            "/recaptcha/api2/anchor", "/recaptcha/api2/bframe",
            "/recaptcha/enterprise/anchor", "/recaptcha/enterprise/bframe"
        ].contains(path)
    }

    static func isYouTubeSessionHandoffURL(_ url: URL) -> Bool {
        isExactYouTubeAccountsURL(url, paths: [
            "/accounts/SetSID",
            "/accounts/SetSID/"
        ])
    }

    static func isYouTubeEmbeddedAuthenticationFrameURL(_ url: URL) -> Bool {
        isYouTubeSessionHandoffURL(url) || isExactYouTubeAccountsURL(url, paths: [
            "/accounts/CheckConnection",
            "/accounts/CheckConnection/",
            "/RotateCookiesPage",
            "/RotateCookiesPage/"
        ])
    }

    private static func isExactYouTubeAccountsURL(_ url: URL, paths: Set<String>) -> Bool {
        guard url.scheme?.lowercased() == "https",
              url.port == nil || url.port == 443,
              url.host?.lowercased() == "accounts.youtube.com",
              let encodedPath = URLComponents(
                url: url,
                resolvingAgainstBaseURL: false
              )?.percentEncodedPath else { return false }
        // Match the encoded representation too. Foundation's decoded `path`
        // can turn an encoded spelling into a native allow while JavaScript's
        // URL.pathname still sees a different document.
        return paths.contains(encodedPath)
    }
}

// One source of truth for native and SPA navigation. Expanded services retain
// exact first-party login and purposeful destinations; unknown routes fail closed.
struct FocusedSocialRoutePolicy: Codable {
    let hosts: [String]
    let homeURL: String
    let installationFlag: String
    let authentication: [String]
    let allowed: [String]
    let restricted: [String]
    let concealed: [String]
    let controlLabels: [String]

    static let configurationJSON = #"""
    {
      "facebook": {
        "hosts": ["facebook.com", "www.facebook.com", "m.facebook.com", "mbasic.facebook.com", "messenger.com", "www.messenger.com"],
        "homeURL": "https://www.facebook.com/messages/",
        "installationFlag": "__vigilFacebookInstalled",
        "authentication": ["^/(login(?:\\.php)?|logout(?:\\.php)?|checkpoint|recover|reg|two_factor|confirmemail)(/|$)", "^/dialog/oauth/?$"],
        "allowed": ["^/(messages|messenger|composer|settings|notifications|friends/list|bookmarks)(/|$)", "^/(profile|story|photo|permalink|composer)\\.php$", "^/(photo|photos|posts)/[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*/?$", "^/groups/[A-Za-z0-9._-]+(?:/(posts/[A-Za-z0-9._-]+|members|about|create))?/?$", "^/[A-Za-z0-9._-]+(?:/(posts|photos|about|friends)(?:/[A-Za-z0-9._-]+)*)?/?$", "^/(new|t/[A-Za-z0-9._-]+|e2ee/t/[A-Za-z0-9._-]+)/?$"],
        "restricted": ["^/$", "^/(watch|reel|reels|stories|marketplace|gaming|video|videos|discover|explore|feed|home|pages|events|friends/(suggestions|requests)|share|l\\.php)(/|$)", "^/(friends|groups|search)/?$"],
        "concealed": ["[aria-label='Reels' i]", "[data-pagelet*='Reels' i]", "[data-pagelet*='Suggested' i]", "[data-pagelet*='Sponsored' i]", "[aria-label='Suggested for you' i]", "[aria-label='People you may know' i]", "[role='complementary']", "[data-testid*='recommend' i]", "[data-testid*='sponsor' i]"],
        "controlLabels": ["reels", "watch", "videos", "gaming", "marketplace", "suggested for you", "people you may know"]
      },
      "x": {
        "hosts": ["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
        "homeURL": "https://x.com/messages",
        "installationFlag": "__vigilXInstalled",
        "authentication": ["^/(login|logout|signup|account/(login_challenge|access)|i/flow/(login|signup|password_reset)|i/oauth2/authorize|oauth/authenticate)(/|$)"],
        "allowed": ["^/(messages|notifications|settings)(/|$)", "^/i/(chat|bookmarks|lists|communities)(/|$)", "^/compose/(post|tweet)/?$", "^/search/?$", "^/[A-Za-z0-9_]{1,15}(?:/(status/[0-9]+(?:/(photo|video)/[0-9]+)?|with_replies|media|followers|following))?/?$"],
        "restricted": ["^/$", "^/(home|explore|trending|jobs|premium|grok|i/(grok|videos|immersive|timeline|trends|connect_people|spaces)|hashtag|topics)(/|$)"],
        "concealed": ["[data-testid='sidebarColumn']", "[data-testid='placementTracking']", "[data-testid='promotedIndicator']", "[data-testid*='recommend' i]", "[aria-label='Who to follow' i]", "[aria-label='Timeline: Trending now' i]", "[aria-label='Timeline: For you' i]"],
        "controlLabels": ["for you", "explore", "trending", "who to follow", "videos", "grok", "spaces"]
      },
      "tiktok": {
        "hosts": ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
        "homeURL": "https://www.tiktok.com/messages",
        "installationFlag": "__vigilTikTokInstalled",
        "authentication": ["^/(login|signup|passport|verify)(/|$)"],
        "allowed": ["^/(messages|inbox|notifications|settings|upload)(/|$)", "^/creator-center(?:/upload)?/?$", "^/tiktokstudio/upload/?$", "^/search/user/?$", "^/@[A-Za-z0-9._-]+(?:/(video|photo)/[0-9]+)?/?$"],
        "restricted": ["^/$", "^/(foryou|for-you|following|friends|explore|discover|live|tag|music|channel|shop|t|embed)(/|$)"],
        "concealed": ["[data-e2e='recommend-list-item-container']", "[data-e2e='video-recommend-card']", "[data-e2e='recommend-user-list']", "[data-e2e='suggest-accounts']", "[data-e2e='related-video']", "[data-e2e='browse-video-list']", "[class*='DivRecommend' i]", "[class*='DivRelated' i]"],
        "controlLabels": ["for you", "following", "friends", "explore", "live", "shop", "suggested accounts", "related videos"]
      },
      "reddit": {
        "hosts": ["reddit.com", "www.reddit.com", "old.reddit.com", "new.reddit.com", "sh.reddit.com"],
        "homeURL": "https://www.reddit.com/message/inbox/",
        "installationFlag": "__vigilRedditInstalled",
        "authentication": ["^/(login|register|password|account/login|account/register|auth|api/v1/authorize)(/|$)"],
        "allowed": ["^/(message|chat|notifications|settings|prefs|submit)(/|$)", "^/(user|u)/[A-Za-z0-9_-]+(?:/(comments|submitted|saved|about|m/[A-Za-z0-9_-]+))?/?$", "^/r/[A-Za-z0-9_]+(?:/(comments/[A-Za-z0-9]+(?:/[^/]+)?(?:/[A-Za-z0-9]+)?|submit|about(?:/[A-Za-z0-9_-]+)?|new|top|hot|wiki(?:/[A-Za-z0-9_/-]+)?))?/?$", "^/comments/[A-Za-z0-9]+(?:/[^/]+)?(?:/[A-Za-z0-9]+)?/?$", "^/search/?$"],
        "restricted": ["^/$", "^/(explore|best|popular|all|trending|videos|watch|games|topics|media)(/|$)", "^/r/(all|popular|randnsfw|random)(/|$)"],
        "concealed": ["shreddit-post[is-promoted]", "shreddit-post[nsfw]", "shreddit-post[content-type='nsfw']", "[data-testid*='recommend' i]", "[data-testid*='promot' i]", "[data-testid*='nsfw' i]", ".promotedlink", ".over18", "[class*='recommendation' i]", "[slot='right-sidebar']", "faceplate-tracker[source='post-recommendations']"],
        "controlLabels": ["popular", "all", "explore", "trending", "related posts", "recommended for you"]
      }
    }
    """#

    static let policies: [String: FocusedSocialRoutePolicy] = {
        guard let data = configurationJSON.data(using: .utf8),
              let policies = try? JSONDecoder().decode([String: FocusedSocialRoutePolicy].self, from: data)
        else { return [:] }
        return policies
    }()

    var javascriptConfiguration: String {
        guard let data = try? JSONEncoder().encode(self),
              let value = String(data: data, encoding: .utf8) else { return "null" }
        return value
    }

    func canonicalPath(_ url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == "https", parts.port == nil || parts.port == 443,
              parts.user == nil, parts.password == nil,
              hosts.contains(parts.host?.lowercased() ?? ""),
              !parts.percentEncodedPath.contains("%"), !url.absoluteString.contains("\\"),
              !parts.percentEncodedPath.split(separator: "/").contains(where: { $0 == "." || $0 == ".." })
        else { return nil }
        return parts.percentEncodedPath.isEmpty ? "/" : parts.percentEncodedPath
    }

    func isAuthentication(_ url: URL) -> Bool {
        guard let path = canonicalPath(url) else { return false }
        return matches(path, patterns: authentication)
    }

    func allowsContent(_ url: URL) -> Bool {
        guard let path = canonicalPath(url) else { return false }
        if matches(path, patterns: authentication) { return true }
        return !matches(path, patterns: restricted) && matches(path, patterns: allowed)
    }

    private func matches(_ path: String, patterns: [String]) -> Bool {
        patterns.contains { path.range(of: $0, options: [.regularExpression, .caseInsensitive]) != nil }
    }
}

enum TikTokSingleItemPolicy {
    static func blocksNavigation(from source: URL?, to destination: URL) -> Bool {
        guard let source, let current = itemRoute(source), let next = itemRoute(destination) else { return false }
        return current != next
    }

    private static func itemRoute(_ url: URL) -> String? {
        guard SocialService.tiktok.focusedRoutePolicy?.allowsContent(url) == true else { return nil }
        let components = url.path.split(separator: "/")
        guard components.count == 3, components[0].hasPrefix("@"),
              ["video", "photo"].contains(String(components[1])) else { return nil }
        return String(components[2])
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
