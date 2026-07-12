import Foundation

struct FilterRules: Codable, Equatable, Sendable {
    static let currentSchema = 1

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
        blockedSearchTerms: [],
        safeSearchEnabled: true
    )

    func normalized() -> FilterRules {
        FilterRules(
            schemaVersion: schemaVersion,
            revision: revision,
            blockedHosts: Self.clean(blockedHosts),
            blockedURLFragments: Self.clean(blockedURLFragments),
            blockedSearchTerms: Self.clean(blockedSearchTerms),
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
              decoded.schemaVersion == FilterRules.currentSchema else {
            return .bootstrap
        }
        return decoded.normalized()
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
        guard let host = url.host?.lowercased(), !host.isEmpty else {
            return .block(reason: "This address is not valid.")
        }
        if rules.blockedHosts.contains(where: { host == $0 || host.hasSuffix(".\($0)") }) {
            return .block(reason: "This website is blocked by Vigil.")
        }
        if blocklist?.matchingDomain(for: host) != nil {
            return .block(reason: "This website is blocked by Vigil.")
        }
        let absolute = url.absoluteString.lowercased()
        if rules.blockedURLFragments.contains(where: absolute.contains) {
            return .block(reason: "This page is blocked by Vigil.")
        }
        if isBlockedSearch(url) {
            return .block(reason: "That search is blocked by Vigil.")
        }
        return .allow(safeSearchURL(for: url))
    }

    private func isBlockedSearch(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let terms = components.queryItems?
            .filter { ["q", "query", "search_query", "text"].contains($0.name.lowercased()) }
            .compactMap(\.value).joined(separator: " ").lowercased() ?? ""
        return rules.blockedSearchTerms.contains { term in
            terms.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil
        }
    }

    private func safeSearchURL(for url: URL) -> URL {
        guard rules.safeSearchEnabled,
              let host = url.host?.lowercased(),
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
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
}
