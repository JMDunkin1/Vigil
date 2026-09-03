import Foundation

struct FilterRules: Codable, Equatable, Sendable {
    static let currentSchema = 2
    fileprivate static let legacySchema = 1
    static let defaultExplicitSearchTerms = [
        "porn", "porno", "xxx", "nsfw", "hentai", "rule34", "gonewild",
        "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube",
        "youporn", "spankbang", "xvideos", "xnxx", "xhamster", "18+",
        "18%2b", "18plus", "18-plus"
    ]
    static let protectedSearchParameterNames: Set<String> = [
        "q", "query", "search_query", "search", "searchterm", "search_term",
        "keyword", "keywords", "term", "text", "p", "k", "s", "wd"
    ]

    var schemaVersion: Int
    var revision: Int
    var blockedHosts: [String]
    var blockedURLFragments: [String]
    var blockedSearchTerms: [String]
    var safeSearchEnabled: Bool

    static let bootstrap = FilterRules(
        schemaVersion: currentSchema,
        revision: 1,
        // The generated compact on-device blocklist is supplied by ios/Shared.
        // This array is reserved for small administrator overrides.
        blockedHosts: [],
        blockedURLFragments: [],
        blockedSearchTerms: defaultExplicitSearchTerms,
        safeSearchEnabled: true
    )

    func normalized() -> FilterRules {
        FilterRules(
            schemaVersion: Self.currentSchema,
            revision: revision,
            blockedHosts: Self.clean(blockedHosts),
            blockedURLFragments: Self.clean(blockedURLFragments),
            blockedSearchTerms: Self.clean(Self.defaultExplicitSearchTerms + blockedSearchTerms),
            safeSearchEnabled: safeSearchEnabled
        )
    }

    private static func clean(_ values: [String]) -> [String] {
        Array(Set(values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            .filter { !$0.isEmpty })).sorted()
    }
}

enum SharedFilterStore {
    static let appGroup = "group.tech.caseline.vigil.browser"
    static let rulesKey = "VigilBrowser.filterRules.v1"

    static func read(defaults: UserDefaults? = nil) -> FilterRules {
        let source = defaults ?? UserDefaults(suiteName: appGroup)
        guard let data = source?.data(forKey: rulesKey),
              let decoded = try? JSONDecoder().decode(FilterRules.self, from: data),
              decoded.schemaVersion == FilterRules.currentSchema || decoded.schemaVersion == FilterRules.legacySchema else {
            return .bootstrap
        }
        let normalized = decoded.normalized()
        if decoded.schemaVersion == FilterRules.legacySchema {
            _ = write(normalized, defaults: source)
        }
        return normalized
    }

    @discardableResult
    static func write(_ rules: FilterRules, defaults: UserDefaults? = nil) -> Bool {
        guard rules.schemaVersion == FilterRules.currentSchema,
              let data = try? JSONEncoder().encode(rules.normalized()),
              let destination = defaults ?? UserDefaults(suiteName: appGroup) else { return false }
        destination.set(data, forKey: rulesKey)
        return destination.synchronize()
    }
}

protocol FilterRulesProviding: Sendable {
    func currentRules() -> FilterRules
    func currentBlocklist() throws -> PhoneBlocklistIndex?
}

struct AppGroupFilterRulesProvider: FilterRulesProviding {
    func currentRules() -> FilterRules { SharedFilterStore.read() }
    func currentBlocklist() throws -> PhoneBlocklistIndex? {
        // Missing is a supported development state. A present but invalid
        // artifact is rejected by PhoneBlocklistIndex rather than trusted.
        try PhoneBlocklistIndex.loadBundled()
    }
}

enum FilterDecision: Equatable {
    case allow(URL)
    case block(reason: String)
}

struct NavigationFilter: Sendable {
    private static let personExposureMarkers: Set<String> = [
        "leak", "leaks", "leaked", "nude", "nudes", "naked", "topless"
    ]
    private static let personIntimateContext: Set<String> = [
        "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
        "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
    ]
    private static let nonPersonSearchContext: Set<String> = [
        "air", "album", "api", "app", "apps", "classified", "code", "color", "court",
        "data", "database", "document", "documents", "email", "emails", "episode",
        "episodes", "fc", "film", "films", "game", "games", "gas", "government",
        "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
        "palette", "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
        "products", "release", "releases", "report", "reports", "roof", "roster",
        "rumor", "rumors", "samsung", "security", "software", "source", "sources",
        "spec", "specs", "team", "transfer", "transfers", "tv", "water"
    ]
    private static let nameFillerWords: Set<String> = [
        "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"
    ]

    let rules: FilterRules
    var blocklist: PhoneBlocklistIndex? = nil
    var blocklistIntegrityValid = true

    func decide(_ url: URL) -> FilterDecision {
        guard blocklistIntegrityValid else {
            return .block(reason: "Vigil's content filter failed its integrity check.")
        }
        guard let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else {
            return .block(reason: "Only web links are allowed.")
        }
        guard scheme == "https" else { return .block(reason: "This browser requires a secure HTTPS connection.") }
        guard let rawHost = url.host, !rawHost.isEmpty else {
            return .block(reason: "This address is not valid.")
        }
        let host = Self.normalizedHost(rawHost)
        if rules.blockedHosts.contains(where: {
            let blocked = Self.normalizedHost($0)
            return !blocked.isEmpty && (host == blocked || host.hasSuffix(".\(blocked)"))
        }) {
            return .block(reason: "This website is blocked by Vigil.")
        }
        if blocklist?.matchingDomain(for: host) != nil {
            return .block(reason: "This website is blocked by Vigil.")
        }
        let candidates = Self.decodedCandidates(url.absoluteString)
        if rules.blockedURLFragments.contains(where: { fragment in
            candidates.contains(where: { $0.contains(fragment.lowercased()) })
        }) {
            return .block(reason: "This page is blocked by Vigil.")
        }
        if isBlockedSearch(url) {
            return .block(reason: "That search is blocked by Vigil.")
        }
        return .allow(safeSearchURL(for: url))
    }

    private func isBlockedSearch(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        var values = components.queryItems?
            .filter { FilterRules.protectedSearchParameterNames.contains($0.name.lowercased()) }
            .compactMap(\.value) ?? []
        if Self.looksLikeSearchRoute(components.path) { values.append(components.path) }
        if let fragment = components.fragment, Self.looksLikeSearchRoute(fragment) { values.append(fragment) }
        let terms = values.flatMap(Self.decodedCandidates).joined(separator: " ").lowercased()
        return rules.blockedSearchTerms.contains { term in
            terms.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        } || Self.isExplicitPersonSearch(terms)
    }

    private static func isExplicitPersonSearch(_ value: String) -> Bool {
        let tokens = value
            .components(separatedBy: CharacterSet.letters.union(.nonBaseCharacters).inverted)
            .map { $0.lowercased() }
            .filter { !$0.isEmpty }
        guard tokens.count >= 2,
              let markerIndex = tokens.firstIndex(where: personExposureMarkers.contains) else { return false }
        if tokens.enumerated().contains(where: { index, token in
            index != markerIndex && personIntimateContext.contains(token)
        }) { return true }
        let nameSide: ArraySlice<String>
        if markerIndex == tokens.count - 1 {
            nameSide = tokens[..<markerIndex]
        } else if markerIndex == 0 {
            nameSide = tokens.dropFirst()
        } else {
            return false
        }
        let structuralName = nameSide.filter { !nameFillerWords.contains($0) }
        return (2...4).contains(structuralName.count)
            && structuralName.allSatisfy { $0.count >= 2 && !nonPersonSearchContext.contains($0) }
    }

    private static func looksLikeSearchRoute(_ value: String) -> Bool {
        let normalized = value.lowercased()
        return ["/search", "/search.php", "/advancedsearch", "/advancedsearch.php", "/results", "/result", "/find", "/browse"]
            .contains { marker in
                guard let range = normalized.range(of: marker) else { return false }
                let suffix = normalized[range.upperBound...]
                return suffix.isEmpty || ["/", "?", ".", "#"].contains(suffix.first!)
            }
    }

    private func safeSearchURL(for url: URL) -> URL {
        guard rules.safeSearchEnabled,
              let rawHost = url.host,
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        let host = Self.normalizedHost(rawHost)
        var items = components.queryItems ?? []
        let value: (String, String)?
        if host == "google.com" || host.hasSuffix(".google.com") { value = ("safe", "active") }
        else if host == "bing.com" || host.hasSuffix(".bing.com") { value = ("adlt", "strict") }
        else if host == "duckduckgo.com" || host.hasSuffix(".duckduckgo.com") { value = ("kp", "1") }
        else { value = nil }
        guard let (name, setting) = value else { return url }
        items.removeAll { $0.name.caseInsensitiveCompare(name) == .orderedSame }
        items.append(URLQueryItem(name: name, value: setting))
        components.queryItems = items
        return components.url ?? url
    }

    private static func normalizedHost(_ value: String) -> String {
        var host = value.lowercased()
        while host.last == "." { host.removeLast() }
        return host
    }

    private static func decodedCandidates(_ value: String) -> [String] {
        var candidates = [value.lowercased()]
        var decoded = candidates[0]
        for _ in 0..<3 {
            let next = decodePercentRuns(decoded).lowercased()
            guard next != decoded else { break }
            candidates.append(next)
            decoded = next
        }
        var seen = Set<String>()
        return candidates.filter { seen.insert($0).inserted }
    }

    private static func decodePercentRuns(_ value: String) -> String {
        guard let expression = try? NSRegularExpression(pattern: "(?:%[0-9a-fA-F]{2})+") else { return value }
        let result = NSMutableString(string: value)
        let matches = expression.matches(in: value, range: NSRange(location: 0, length: (value as NSString).length))
        for match in matches.reversed() {
            let encoded = result.substring(with: match.range)
            let decoded = encoded.removingPercentEncoding ?? bytewisePercentDecode(encoded)
            result.replaceCharacters(in: match.range, with: decoded)
        }
        return result as String
    }

    private static func bytewisePercentDecode(_ value: String) -> String {
        let hexBytes = value.split(separator: "%", omittingEmptySubsequences: true)
        let bytes = hexBytes.compactMap { UInt8($0, radix: 16) }
        guard bytes.count == hexBytes.count else { return value }
        return String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) }))
    }
}
