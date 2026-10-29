import Foundation

struct FilterRules: Codable, Equatable, Sendable {
    static let currentSchema = 2
    fileprivate static let legacySchema = 1
    static let defaultExplicitSearchTerms = [
        "porn", "porno", "prno", "p0rn", "xxx", "nsfw", "hentai", "rule34", "gonewild",
        "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube",
        "youporn", "spankbang", "xvideos", "xnxx", "xhamster", "18+",
        "18%2b", "18plus", "18-plus"
    ]
    static let protectedSearchParameterNames: Set<String> = [
        "q", "query", "searchquery", "search_query", "search", "searchterm", "search_term",
        "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag", "mode", "gsc.q", "search_api_fulltext"
    ]
    static let ambiguousSearchParameterNames: Set<String> = ["p", "k", "s", "mode"]
    static let automaticSearchTerms = Set(defaultExplicitSearchTerms)

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
        "leak", "leaks", "leaked", "leakd", "lek", "leks",
        "nud", "nuds", "nude", "nudes", "nued", "naked", "topless"
    ]
    private static let personIntimateContext: Set<String> = [
        "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
        "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
    ]
    private static let leakContext: Set<String> = [
        "air", "api", "app", "apps", "classified", "code", "command", "court",
        "data", "database", "document", "documents", "email", "emails", "episode",
        "episodes", "fc", "film", "films", "game", "games", "gas", "government",
        "guide", "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
        "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
        "products", "release", "releases", "report", "reports", "roof", "roster",
        "rumor", "rumors", "samsung", "security", "software", "source", "sources",
        "spec", "specs", "team", "transfer", "transfers", "tutorial", "tv", "water"
    ]
    private static let nudeContext: Set<String> = [
        "eye", "eyes", "cake", "cakes",
        "truck", "trucks", "coffee", "paint", "roof", "roofs", "wire", "wires", "cable", "cables",
        "stock", "stocks", "option", "options", "selling", "finance", "financial", "health", "education",
        "anatomy", "animal", "animals", "art", "arts", "artwork", "artworks", "beach", "beaches",
        "beige", "color", "colors", "colour", "colours", "drawing", "drawings", "fabric", "fashion",
        "figure", "figures", "lipstick", "makeup", "medical", "mice", "model", "models", "mole",
        "mouse", "museum", "museums", "painting", "paintings", "palette", "photography", "rat", "rats",
        "reference", "references", "sculpture", "sculptures", "shade", "shades", "statue", "statues",
        "studies", "study"
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
        if BroadenedExplicitMedia.containsSemanticURL(url) {
            return .block(reason: "This page is blocked by Vigil.")
        }
        if isBlockedSearch(url) {
            return .block(reason: "That search is blocked by Vigil.")
        }
        return .allow(safeSearchURL(for: url))
    }

    private func isBlockedSearch(_ url: URL) -> Bool {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        let routeText = Self.searchRouteText(components.percentEncodedPath)
        let fragmentText = components.percentEncodedFragment.flatMap(Self.searchRouteText)
        let onSearchRoute = routeText != nil || fragmentText != nil
        let host = Self.normalizedHost(url.host ?? "")
        let path = Self.decodedCandidates(components.percentEncodedPath).last ?? components.path.lowercased()
        let queryItems = (components.percentEncodedQuery ?? "").split(separator: "&").map { pair in
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            return (name: Self.decodeFormField(String(parts[0])), value: parts.count == 2 ? Self.decodeFormField(String(parts[1])) : "")
        }
        var values = queryItems
            .filter { item in
                let name = Self.decodedCandidates(item.name).last ?? item.name.lowercased()
                let providerField = (name == "p" && host == "search.yahoo.com")
                    || (name == "mode" && (host == "pixiv.net" || host.hasSuffix(".pixiv.net"))
                        && path.range(of: #"^/ranking(?:\.php)?/?$"#, options: .regularExpression) != nil)
                return BroadenedExplicitMedia.isMarketplaceSearchField(name, host: host, path: path)
                    || Self.isProtectedSearchParameter(item.name, onSearchRoute: onSearchRoute || providerField)
            }
            .map(\.value)
        if let fragment = components.percentEncodedFragment, fragmentText != nil,
           let queryStart = fragment.firstIndex(of: "?") {
            for pair in fragment[fragment.index(after: queryStart)...].split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2, Self.isProtectedSearchParameter(Self.decodeFormField(String(parts[0])), onSearchRoute: true) {
                    values.append(Self.decodeFormField(String(parts[1])))
                }
            }
        }
        if let fragment = components.percentEncodedFragment,
           fragment.range(of: #"^gsc\.(?:tab|q|page)="#, options: [.regularExpression, .caseInsensitive]) != nil {
            for pair in fragment.split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2, Self.decodeFormField(String(parts[0])).lowercased() == "gsc.q" {
                    values.append(Self.decodeFormField(String(parts[1])))
                }
            }
        }
        if let routeText, !routeText.isEmpty { values.append(routeText) }
        if let fragmentText, !fragmentText.isEmpty { values.append(fragmentText) }
        return values.map { Self.decodedCandidates($0).last ?? $0 }.contains { terms in
            rules.blockedSearchTerms.contains { term in
                !FilterRules.automaticSearchTerms.contains(term.lowercased())
                    && !BroadenedExplicitMedia.isAdditionalLabel(term)
                    && terms.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            } || Self.isExplicitPersonSearch(terms) || BroadenedExplicitMedia.containsSearch(terms, hostname: url.host ?? "", mediaDiscovery: BroadenedExplicitMedia.isMediaDiscoverySearchURL(url))
        }
    }

    private static func isExplicitPersonSearch(_ value: String) -> Bool {
        let tokens = BroadenedExplicitMedia.normalized(value)
            .components(separatedBy: CharacterSet.letters.union(.nonBaseCharacters).inverted)
            .map { $0.lowercased() }
            .filter { !$0.isEmpty }
        guard tokens.count >= 2,
              let markerIndex = tokens.firstIndex(where: personExposureMarkers.contains) else { return false }
        let marker = tokens[markerIndex]
        let ordinaryContext = ["leak", "leaks", "leaked", "leakd", "lek", "leks"].contains(marker)
            ? leakContext
            : nudeContext
        if tokens.enumerated().contains(where: { index, token in
            index != markerIndex && personIntimateContext.contains(token)
        }) { return true }
        if tokens.contains(where: ordinaryContext.contains) { return false }
        let structuralName = tokens.enumerated().compactMap { index, token in
            index != markerIndex && !nameFillerWords.contains(token) ? token : nil
        }
        return (2...4).contains(structuralName.count)
            && structuralName.allSatisfy { $0.count >= 2 }
    }

    private static func isProtectedSearchParameter(_ value: String, onSearchRoute: Bool) -> Bool {
        let name = decodedCandidates(value).last ?? value.lowercased()
        if FilterRules.protectedSearchParameterNames.contains(name),
           !FilterRules.ambiguousSearchParameterNames.contains(name) || onSearchRoute { return true }
        return onSearchRoute && name.range(of: #"^(q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|p|k|s|wd|word|tags|tag)\[(\d*|q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|word|tags|tag)\]$"#, options: .regularExpression) != nil
    }

    private static func searchRouteText(_ value: String) -> String? {
        var route = value
        if route.hasPrefix("#") { route.removeFirst() }
        if route.hasPrefix("!") { route.removeFirst() }
        route = String(route.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let path = decodedCandidates(route).last ?? route
        let expression = try! NSRegularExpression(pattern: #"(?:^|/)(advancedsearch(?:\.(?:php|json|html|aspx))?|search(?:\.(?:php|json|html|aspx))?|results?|find|browse|tags?|tagged|hashtag|r|tag-[^/?#]+|catalog|products?|items?|collections?|categories?|galler(?:y|ies)|art|all|paintings|photography|drawings|sculpture)(?=/|$)"#, options: .caseInsensitive)
        let text = path as NSString
        guard let match = expression.firstMatch(in: path, range: NSRange(location: 0, length: text.length)) else { return nil }
        let marker = text.substring(with: match.range(at: 1))
        let start = marker.hasPrefix("tag-") ? match.range(at: 1).location : NSMaxRange(match.range)
        return text.substring(from: start).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
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

    private static func decodeFormField(_ value: String) -> String {
        // Form separators must become spaces before decoding, so literal %2B
        // content such as 18+ survives the same nested decoding as JavaScript.
        decodePercentRuns(value.replacingOccurrences(of: "+", with: " "))
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

// BEGIN GENERATED EXPLICIT MEDIA MATCHER
// Generated from src/explicitMediaContext.ts; do not edit this section.
private enum BroadenedExplicitMedia {
    private static let labels: Set<String> = ["pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos", "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes", "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate", "toonily", "omegascans", "manhwabuddy", "mangadna", "manghaha", "mangaforfree", "manhwaclub", "webtoonscan", "pornhwa", "qtoon", "comicle", "mangabuddy", "mangameow", "mangaball", "kuramanga", "comizy", "nyrascans", "mangavyvy", "hiperdex", "tappytoon", "toomics", "lezhin", "lezhinus", "lezhinx", "daycomics", "toptoon", "coolmic", "mangaplaza", "ebookrenta", "webcomicsapp", "lalatoon", "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls", "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"]
    private static let searchKeywords: Set<String> = ["porn", "porno", "prno", "p0rn", "p0rno", "pornography", "pornographic", "nsfw", "hentai", "h3ntai", "rule34", "gonewild", "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube", "youporn", "spankbang", "xvideos", "xnxx", "xhamster", "pornhub", "honeytoon", "honeytoons", "hooneytoon", "hooneytoons", "toongod", "pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos", "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes", "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate", "toonily", "omegascans", "manhwabuddy", "mangadna", "manghaha", "mangaforfree", "manhwaclub", "webtoonscan", "pornhwa", "qtoon", "comicle", "mangabuddy", "mangameow", "mangaball", "kuramanga", "comizy", "nyrascans", "mangavyvy", "hiperdex", "tappytoon", "toomics", "lezhin", "lezhinus", "lezhinx", "daycomics", "toptoon", "coolmic", "mangaplaza", "ebookrenta", "webcomicsapp", "lalatoon", "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls", "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"]
    private static let searchCompound = try! NSRegularExpression(pattern: #"^(?:porn|porno|p0rn|hentai|h3ntai|nsfw)(?:videos?|vids?|photos?|pics?|images?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|hub|tube|hd|vr|4k)$"#)
    private static let ageSearchMarker = try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:18\s*\+|18[\s_.-]*plus|eighteen[\s_.-]+plus)(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive)
    private static let searchFormatCharacters = try! NSRegularExpression(pattern: #"[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]"#)
    private static let discoveryNames = try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:de[\s_-]*digger|file[\s_-]*pursuit|searchfiles|filesearch|mediafire(?:trend)?|searchshared|meawfy|eyedex|uvrx|google[\s_-]*drive|gdrive|drive\.google\.com|mega\.(?:nz|io)|4shared|dropbox|gofile|archive\.org|google[\s_-]+(?:images|videos)|(?:file|media|image|video)[\s_-]+(?:search|finder)|(?:shared|public)[\s_-]+(?:files|folders)|open[\s_-]+directories)(?:$|[^\p{L}\p{N}])"#, options: .caseInsensitive)
    private static let discoveryMarkers = try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:adult|adults|mature|explicit|spicy|steamy|sexy|sensual|seductive|sultry|raunchy|racy|risque|suggestive|provocative|revealing|intimate|uncensored|unfiltered|uncut|sensitive|leaks?|leaked|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|lingerie|underwear|bikinis?|thongs?|boudoir|pin[\s_-]*ups?|cleavage|underboob|busty|voluptuous|thicc|thirst[\s_-]*traps?)(?:$|[^\p{L}\p{N}])"#, options: .caseInsensitive)
    private static let contextualMarkers = try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])"#, options: .caseInsensitive)
    // Compile shared normalization patterns once; a discovery URL can inspect
    // several components without rebuilding the same regexes for each one.
    private static let latinLetters = try! NSRegularExpression(pattern: #"\p{Script=Latin}\p{M}*"#)
    private static let vocabularyReplacements: [(NSRegularExpression, String)] = [
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])q[\s_.\p{Pd}]+toon(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " qtoon "),
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:omega[\s_.\p{Pd}]+scans)(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " omegascans "),
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+dna(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " mangadna "),
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+for[\s_.\p{Pd}]+free(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " mangaforfree "),
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+buddy(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " manhwabuddy "),
        (try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+club(?=$|[^\p{L}\p{N}])"#, options: .caseInsensitive), " manhwaclub "),
        (try! NSRegularExpression(pattern: #"\b(?:sex|love)[\s_\p{Pd}]+(?:(?:silicone|tpe|realistic|lifelike|full[\s_\p{Pd}]+body)[\s_\p{Pd}]+){0,3}dolls?\b"#, options: .caseInsensitive), "sexdoll"),
        (try! NSRegularExpression(pattern: #"\bsex[\s_\p{Pd}]+robots?\b"#, options: .caseInsensitive), "sexrobot"),
        (try! NSRegularExpression(pattern: #"\bsex[\s_\p{Pd}]+toys?\b"#, options: .caseInsensitive), "sextoy"),
        (try! NSRegularExpression(pattern: #"\b(sexy|lingerie|mature)(?=\d{1,2}[x×]\d{1,2}\b)"#, options: .caseInsensitive), "$1 "),
        (try! NSRegularExpression(pattern: #"\b(?:bare|exposed|uncovered)[\s_-]+(?:breasts?|nipples?|genitals?)\b"#, options: .caseInsensitive), "nude"),
        (try! NSRegularExpression(pattern: #"\b(?:nak3d|n4ked|n4k3d)\b"#, options: .caseInsensitive), "naked"),
        (try! NSRegularExpression(pattern: #"\b(?:nud3s?|nudez|nudz|n00dz|n00des|noodz)\b"#, options: .caseInsensitive), "nudes"),
        (try! NSRegularExpression(pattern: #"\b(?:ph0t0s|ph0tos|phot0s)\b"#, options: .caseInsensitive), "photos"),
        (try! NSRegularExpression(pattern: #"\bn[\s_.-]+a[\s_.-]+k[\s_.-]+e[\s_.-]+d\b"#, options: .caseInsensitive), "naked"),
        (try! NSRegularExpression(pattern: #"\bn[\s_.-]+u[\s_.-]+d[\s_.-]+e(?:[\s_.-]+s)?\b"#, options: .caseInsensitive), "nudes"),
        (try! NSRegularExpression(pattern: #"\bp[\s_.-]+[o0][\s_.-]+r[\s_.-]+n\b"#, options: .caseInsensitive), "porn"),
        (try! NSRegularExpression(pattern: #"\b(naked|nudes?|topless|bottomless|adult|sex)(girls?|boys?|women|woman|men|males?|females?|models?|videos?|vids?|photos?|pics?|images?)\b"#, options: .caseInsensitive), "$1 $2")
    ]
    private static let ordinaryPatterns: [NSRegularExpression] = [
        try! NSRegularExpression(pattern: #"\bnaked[\s_-]+(?:eyes?|mole[\s_-]+rats?|neck[\s_-]+chickens?|singularit(?:y|ies)|dna|seeds?|calls?|puts?|short[\s_-]+(?:selling|positions?)|stocks?|options?|economics|wires?|cables?|roofs?|trucks?|cakes?|burrito(?:[\s_-]+bowls?)?)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:bare[\s_-]+naked[\s_-]+ladies|barenaked[\s_-]+ladies|naked[\s_-]+(?:gun|truth|lunch|brothers[\s_-]+band|king|snake|cowboy|chef))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:nude[\s_-]+descending[\s_-]+(?:a[\s_-]+)?staircase|(?:the[\s_-]+)?naked[\s_-]+maja|blue[\s_-]+nude[\s_-]+matisse)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnude[\s_-]+(?:sculptures?|statues?|figure[\s_-]+drawings?|lipsticks?|makeup|nail[\s_-]+polish|nails?|palettes?|manicures?|beige[\s_-]+swatches?|(?:colou?red[\s_-]+)?(?:shoes?|heels?|dresses?|clothing|outfits?|fabrics?|shades?|colou?rs?))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:see[\s_-]+through|seethrough)[\s_-]+(?:glass|windows?|fabrics?|curtains?|materials?)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:topless[\s_-]+trucks?|bottomless[\s_-]+(?:coffee|mimosas?|brunch|pits?))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bstripping[\s_-]+(?:paint|wallpaper|furniture|wood|floors?|ions?|bond[\s_-]+coupons?|thyme[\s_-]+leaves)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:boston[\s_-]+cream[\s_-]+pies?|cream[\s_-]+pies?[\s_-]+baker(?:y|ies)|cum[\s_-]+laude)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:blue|great|coal|crested|marsh|willow|bearded|long[\s_-]+tailed)[\s_-]+tits?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:tits?[\s_-]+bird[\s_-]+species|boobies[\s_-]+galapagos[\s_-]+birds?|(?:blue[\s_-]+footed|red[\s_-]+footed|brown|masked|nazca)[\s_-]+boobies|cock[\s_-]+(?:pheasants?|sparrows?|roosters?|robins?)|wild[\s_-]+asses|pussy[\s_-]+willows?)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:horny[\s_-]+(?:toads?|goat[\s_-]+weed)|adult[\s_-]+(?:butterflies|birds?|fish|animals?|insects?))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:oral[\s_-]+(?:thrush|feeding|arguments?|presentations?|exams?|hygiene|fixation[\s_-]+shakira)|(?:assisted[\s_-]+)?oral[\s_-]+feeding|anal[\s_-]+fistulas?)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:sex[\s_-]+(?:education|determination|differences|changing|chromosomes?)|sexual[\s_-]+(?:health|reproduction|dimorphism|selection|orientation|harassment|assault)|same[\s_-]+sex|opposite[\s_-]+sex)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:breast[\s_-]+(?:reconstruction|feeding|tissue[\s_-]+histology)|buttocks[\s_-]+stretching|feet[\s_-]+pain|thighs?[\s_-]+exercises?|cleavage[\s_-]+(?:crystal|mineral))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:sex[\s_-]+pistols|dick[\s_-]+(?:van[\s_-]+dyke|tracy|clark)|moby[\s_-]+dick|hot[\s_-]+money|penetration[\s_-]+(?:pricing|testing|tests?))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:fingering[\s_-]+(?:guitar|piano|music)|(?:guitar|piano)[\s_-]+fingering|strip[\s_-]+tease[\s_-]+rose(?=[\s_-]+(?:growing|garden|plant)))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bleak(?:s|ed)?[\s_-]+(?:(?:pentagon|government|classified|court|source)[\s_-]+)?(?:documents?|data|databases?|passwords?|code|pipes?|aquariums?|gardening)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:nissan|skyline|gt[\s_-]?r)[\s_-]+r[\s_-]?34\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\br[\s_-]?34[\s_-]+(?:nissan|skyline|gt[\s_-]?r)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\brule[\s_.-]*34[\s_-]+(?:algorithm|theorem|proof|specification|standard|procedure)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:chapter|book|section|volume|part|appendix|super[\s_-]+bowl)[\s_-]+x{3,}\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bx{3,}[\s_-]+chromosomes?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bchromosomes?[\s_-]+x{3,}\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bxxx[\s_-]+(?:vin[\s_-]+diesel|return[\s_-]+of[\s_-]+xander[\s_-]+cage|2002[\s_-]+(?:film|movie))\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bvin[\s_-]+diesel[\s_-]+xxx\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\badult[\s_-]+(?:education|learning|training|literacy)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bmature[\s_-]+skin\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\buncensored[\s_-]+interviews?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnude[\s_-]+art[\s_-]+(?:figure[\s_-]+)?drawings?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnude[\s_-]+art[\s_-]+videos?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnudity[\s_-]+anatomy\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnude[\s_-]+(?:watercolou?r[\s_-]+palettes?|art[\s_-]+sculptures?)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bmature[\s_-]+trees?\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\berotic[\s_-]+imagery[\s_-]+art[\s_-]+history\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:porn|porno|pornography|pornographic)[\s_-]+(?:content[\s_-]+)?(?:blockers?|blocking|filters?|filtering|detection|detectors?|moderation|prevention)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bpornography[\s_-]+(?:laws?|legal[\s_-]+history)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b(?:porn|pornography)[\s_-]+(?:addiction[\s_-]+)?(?:recovery|treatment)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnsfw[\s_-]+(?:classifiers?|classification|filters?|filtering|detection|detectors?|moderation)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\bnsfw[\s_-]+api[\s_-]+(?:reference|documentation)\b"#, options: .caseInsensitive),
        try! NSRegularExpression(pattern: #"\b18\s*\+[\s_-]+(?:travel[\s_-]+insurance|insurance|(?:voting[\s_-]+)?eligibility|age[\s_-]+requirements?)\b"#, options: .caseInsensitive)
    ]
    private static let exposure = try! NSRegularExpression(pattern: #"^(?:nud|nuds|nudes?|nued|nudity|naked|nakedness|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|fullfrontal|seethrough|upskirt|downblouse|nipslips?|cameltoe)$"#)
    private static let sexual = try! NSRegularExpression(pattern: #"^(?:erotic|erotica|lewd|horny|sensual|seductive|sex|sexual|sexually|raunchy|salacious|lustful|lascivious|risque|risqué|sultry|racy|titillating|arousing|aroused|fetish|fetishes|kinky|kink|bdsm|bondage)$"#)
    private static let acts = try! NSRegularExpression(pattern: #"^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|ejaculation|fingering|selfpleasure|creampies?|bukkake|gangbangs?|threesomes?|orgies|orgy|masturbation|masturbating|fucking|penetration|anal|oral|doggystyle|pegging|squirting|sexting)$"#)
    private static let strongActs = try! NSRegularExpression(pattern: #"^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|bukkake|gangbangs?|fucking|selfpleasure|upskirt|downblouse|nipslips?|cameltoe)$"#)
    private static let strongMediaMarker = try! NSRegularExpression(pattern: #"^(?:nud|nuds|nudes?|naked|nudity|lewd|erotic|erotica|x{3,})$"#)
    private static let connectors = try! NSRegularExpression(pattern: #"^(?:a|an|the|of|with|who|that|are|is|were|was|be|being|their|very|really|absolutely|totally|completely|fully|amazingly|beautiful|gorgeous|amazing|pretty|lovely)$"#)
    private static let body = try! NSRegularExpression(pattern: #"^(?:boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?)$"#)
    private static let people = try! NSRegularExpression(pattern: #"^(?:girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?)$"#)
    private static let media = try! NSRegularExpression(pattern: #"^(?:videos?|vids?|movies?|films?|clips?|photos?|photographs?|pics?|pictures?|images?|gifs?|prints?|posters?|pin(?:[-_ ]?up)s?|calendars?|galler(?:y|ies)|albums?|wallpapers?|footage|streams?|livestreams?|webcams?|compilations?|documentar(?:y|ies)|animations?|animated|illustrations?|comics?|manga|hentai|audios?)$"#)
    private static let marketing = try! NSRegularExpression(pattern: #"^(?:adults?|spicy|mature|steamy|uncensored|unfiltered|uncut|explicit|revealing|suggestive|provocative|teasing|tease|thirst|thirsttraps?|nsfl)$"#)
    private static let ordinary = try! NSRegularExpression(pattern: #"^(?:recipes?|cooking|baking|food|desserts?|kitchen|chicken|sauce|peppers?|banana|chocolate|coconut|vanilla|pastry|education|educational|learning|classes|training|tutorials?|fitness|medical|medicine|health|anatomy|clinical|diagnosis|symptoms?|treatment|cancer|screening|mammography|reconstruction|surgery|histology|breastfeeding|lactation|consent|prevention|safety|research|scientific|biology|orientation|identity|identities|gender|genders|equality|rights|discrimination|harassment|assault|abuse|violence|victims?|survivors?|legal|laws?)$"#)
    private static let relationship = try! NSRegularExpression(pattern: #"^(?:same|opposite|biological|assigned)$"#)
    private static let bodyContext = try! NSRegularExpression(pattern: #"^(?:art|arts|drawing|paintings?|sculptures?|museum|exhibitions?|makeup|lipstick|palettes?|manicures?|nails?|skincare|cakes?|dresses?|clothing|outfits?|fabric|fabrics|shades?|colors?|colours?)$"#)
    private static let ordinaryBody = try! NSRegularExpression(pattern: #"^(?:presentations?|exams?|examinations?|hygiene|dentists?|dental|languages?|history|historical|measurement|measurements|inches|inch|meters?|metres?|conversion|convert|shoes?|socks?|walking|running|birds?|roosters?|cats?|kittens?|donkeys?|moby|dyke|dickens|mountains?|sailing|storms?)$"#)
    private static let ambiguousBody = try! NSRegularExpression(pattern: #"^(?:oral|anal|penetration|bondage|feet|soles|thighs?|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies)$"#)
    private static let nonsexualExposure = try! NSRegularExpression(pattern: #"^(?:eye|eyes|mole|rats?|roof|roofs|paint|wallpaper|wire|wires|cable|cables|furniture|wood|floor|floors|truck|trucks|pit|pits|coffee|portafilter|stocks?|options?|probability)$"#)
    private static let marker = try! NSRegularExpression(pattern: #"^(?:adults?|spicy|creampies?|nudes?|naked|nudity|erotic|erotica|lewd|x+)$"#)
    private static let contributor = try! NSRegularExpression(pattern: #"^(?:mature|steamy|uncensored)$"#)
    private static let words = try! NSRegularExpression(pattern: #"[\p{L}\p{N}]+"#)

    private static func matches(_ pattern: NSRegularExpression, _ value: String) -> Bool {
        pattern.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
    }

    static func isAdditionalLabel(_ value: String) -> Bool { labels.contains(value.lowercased()) }

    static func normalizedVocabulary(_ value: String) -> String {
        var text = value.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]"#, with: "", options: .regularExpression)
        let source = text as NSString
        for match in latinLetters.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            if let range = Range(match.range, in: text) {
                text.replaceSubrange(range, with: source.substring(with: match.range).folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX")))
            }
        }
        let glyphs = ["а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "α": "a"]
        let vocabulary: Set<String> = searchKeywords.union(["naked", "nude", "nudes", "porn", "porno", "nsfw", "sex", "sexual", "topless", "nakedgirls", "nudegirls"])
        let glyphSource = text as NSString
        for match in words.matches(in: text, range: NSRange(location: 0, length: glyphSource.length)).reversed() {
            let original = glyphSource.substring(with: match.range)
            let folded = original.lowercased().map { glyphs[String($0)] ?? String($0) }.joined()
            if (vocabulary.contains(folded) || matches(searchCompound, folded)), let range = Range(match.range, in: text) { text.replaceSubrange(range, with: folded) }
        }
        for (pattern, replacement) in vocabularyReplacements {
            text = pattern.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: replacement)
        }
        return text
    }

    static func normalized(_ value: String) -> String {
        var text = normalizedVocabulary(value)
        for pattern in ordinaryPatterns {
            text = pattern.stringByReplacingMatches(in: text, range: NSRange(text.startIndex..., in: text), withTemplate: " vigilordinary ")
        }
        return text
    }

    static func normalizedEvidence(_ value: String) -> String { normalized(value) }

    static func isMarketplaceSearchField(_ name: String, host: String, path: String) -> Bool {
        if name == "k", path.range(of: #"^/s/?$"#, options: [.regularExpression, .caseInsensitive]) != nil,
           ["amazon.com", "amazon.ca", "amazon.co.uk", "amazon.com.au", "amazon.de", "amazon.fr", "amazon.it", "amazon.es", "amazon.co.jp", "amazon.in", "amazon.com.mx", "amazon.com.br", "amazon.nl", "amazon.se", "amazon.pl", "amazon.com.be", "amazon.ie", "amazon.com.tr", "amazon.ae", "amazon.sa", "amazon.sg", "amazon.eg", "amazon.co.za"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return true }
        if name == "_nkw", path.range(of: #"^/sch(?:/|$)"#, options: [.regularExpression, .caseInsensitive]) != nil,
           ["ebay.com", "ebay.ca", "ebay.co.uk", "ebay.com.au", "ebay.de", "ebay.fr", "ebay.it", "ebay.es", "ebay.ie", "ebay.at", "ebay.be", "ebay.ch", "ebay.nl", "ebay.pl"].contains(where: { host == $0 || host.hasSuffix("." + $0) }) { return true }
        return false
    }

    private static let printPatterns = [try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:mature|explicit|provocative|suggestive|revealing|spicy|uncensored|unfiltered|sexy|sensual|seductive|sultry|raunchy|racy|risque|erotic|erotica|lewd|nude|naked|topless|underboob|lingerie|underwear|bikinis?|thongs?|boudoir|pin ups?|pinups?|shibari|bondage|fetish|hotwife|swingers?|sexploitation|strippers?|busty|voluptuous|thicc|hotties?|butts?|booty|18plus|r18) (?:[\p{L}\p{N}]+ ){0,4}(?:prints?|posters?|photos?|photographs?|photography|pictures?|images?|portraits?|canvases|canvas|art(?:works?)?|decor|decorations?|illustrations?|paintings?|drawings?|cartoons?|stickers?|decals?|postcards?|calendars?|tapestries|plaques?|trading cards?)(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:prints?|posters?|photos?|photographs?|photography|pictures?|images?|portraits?|canvases|canvas|art(?:works?)?|decor|decorations?|illustrations?|paintings?|drawings?|cartoons?|stickers?|decals?|postcards?|calendars?|tapestries|plaques?|trading cards?) (?:[\p{L}\p{N}]+ ){0,4}(?:mature|explicit|provocative|suggestive|revealing|spicy|uncensored|unfiltered|sexy|sensual|seductive|sultry|raunchy|racy|risque|erotic|erotica|lewd|nude|naked|topless|underboob|lingerie|underwear|bikinis?|thongs?|boudoir|pin ups?|pinups?|shibari|bondage|fetish|hotwife|swingers?|sexploitation|strippers?|busty|voluptuous|thicc|hotties?|butts?|booty|18plus|r18)(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:18plus|r18|adults? only|not suitable for (?:young people|children|minors)) (?:[\p{L}\p{N}]+ ){0,12}(?:(?:prints?|posters?|photos?|photographs?|photography|pictures?|images?|portraits?|canvases|canvas|art(?:works?)?|decor|decorations?|illustrations?|paintings?|drawings?|cartoons?|stickers?|decals?|postcards?|calendars?|tapestries|plaques?|trading cards?)|digital downloads?)(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:(?:prints?|posters?|photos?|photographs?|photography|pictures?|images?|portraits?|canvases|canvas|art(?:works?)?|decor|decorations?|illustrations?|paintings?|drawings?|cartoons?|stickers?|decals?|postcards?|calendars?|tapestries|plaques?|trading cards?)|digital downloads?) (?:[\p{L}\p{N}]+ ){0,12}(?:18plus|r18|adults? only|not suitable for (?:young people|children|minors))(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:abella danger|abelladanger) (?:[\p{L}\p{N}]+ ){0,8}(?:photos?|photographs?|pictures?|images?|prints?|posters?|portraits?|canvas|art|calendars?|trading cards?|autographs?|mugs?)(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:photos?|photographs?|pictures?|images?|prints?|posters?|portraits?|canvas|art|calendars?|trading cards?|autographs?|mugs?) (?:[\p{L}\p{N}]+ ){0,8}(?:abella danger|abelladanger)(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])(?:busty|voluptuous|thicc) (?:[\p{L}\p{N}]+ ){0,4}ai models?(?=$|[^\p{L}\p{N}])"#), try! NSRegularExpression(pattern: #"(?:^|[^\p{L}\p{N}])models? (?:[\p{L}\p{N}]+ ){0,4}mature collections?(?=$|[^\p{L}\p{N}])"#)]
    private static let reviewedPrintProductIDs: Set<String> = ["4596079411", "250555610", "4439331570", "4531137091", "4520580803", "4596303659", "4584233511", "4299890278", "4545313735", "4314991788", "4551934894", "1891438757", "4543154295", "4341915187", "4583202389", "1876924798", "4439560667", "4522401873"]
    private static let reviewedPrintProductRoute = try! NSRegularExpression(pattern: #"^\/(?:listing|r\/similar)\/([0-9]+)(?:\/|$)"#, options: .caseInsensitive)
    private static func containsPrintMediaEvidence(_ value: String) -> Bool {
        var text = value.lowercased()
        text = text.replacingOccurrences(of: #"\b(?:lingerie|underwear|bikinis?|swimsuits?)[\s_-]+(?:(?:sewing|knitting|crochet)[\s_-]+)?patterns?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:floral|leopard|zebra|animal|paisley|polka[\s_-]+dot)[\s_-]+prints?[\s_-]+(?:bikinis?|underwear|lingerie|thongs?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bpin[\s_-]*up[\s_-]+(?:hair(?:styles?)?|hairstyles?|hairdos?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:cigarette|cigar|pork|boston)[\s_-]+butts?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bbutt[\s_-]+joints?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b18\s*\+"#, with: "18plus", options: .regularExpression)
            .replacingOccurrences(of: #"\br[\s_-]+18\b"#, with: "r18", options: .regularExpression)
            .replacingOccurrences(of: #"[^\p{L}\p{N}]+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return printPatterns.contains { matches($0, text) }
    }

    // Match meaningful destination labels and early routes, never credentials,
    // arbitrary query/hash metadata, or identifiers later in the address.
    static func containsSemanticURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host else { return false }
        let productHost = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        if productHost == "etsy.com" || productHost.hasSuffix(".etsy.com") {
            let path = semanticNormalized(components.percentEncodedPath)
            if let match = reviewedPrintProductRoute.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
               reviewedPrintProductIDs.contains((path as NSString).substring(with: match.range(at: 1))) { return true }
        }
        let labels = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ".")).split(separator: ".").map(String.init)
        if ["xxx", "porn"].contains(labels.last ?? "") { return true }
        let hostLabels = labels.dropLast().map(semanticNormalized)
        for (index, label) in hostLabels.enumerated() {
            if semanticClassifies(label, hostname: true) { return true }
            if semanticWeak.contains(label), index + 1 < hostLabels.count,
               semanticMedia.contains(hostLabels[index + 1]) { return true }
        }
        let segments = Array(components.percentEncodedPath.split(separator: "/", omittingEmptySubsequences: true).prefix(4)).map { semanticNormalized(String($0.prefix(512))) }
        let routeText = segments.map(normalizedEvidence).joined(separator: " ")
        let qualifiedRouteText = normalizedEvidence(routeText)
        if containsPrintMediaEvidence(qualifiedRouteText) { return true }
        if qualifiedRouteText != routeText {
            return semanticClassifies(qualifiedRouteText, previous: segments.first(where: semanticCatalog.contains) ?? "")
        }
        for (index, segment) in segments.enumerated() {
            let previous = index > 0 ? segments[index - 1] : ""
            if semanticClassifies(segment, previous: previous) { return true }
            let roman = semanticChapters.contains(previous) && segment.range(of: #"^x{3,}$"#, options: .regularExpression) != nil
            let next = index + 1 < segments.count ? segments[index + 1] : ""
            if !roman, (semanticWeak.contains(segment) || segment == "18+"
                || segment.range(of: #"^x{3,}$"#, options: .regularExpression) != nil
                || (segment == "r34" && semanticComics.contains(next))),
               semanticTokens(next).contains(where: semanticMedia.contains) { return true }
        }
        return false
    }

    private static let semanticMedia: Set<String> = ["video", "videos", "vid", "vids", "photo", "photos", "photograph", "photographs", "pic", "pics", "image", "images", "gif", "gifs", "print", "prints", "poster", "posters", "pinup", "pinups", "calendar", "calendars", "cam", "cams", "comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi", "novel", "novels", "art", "gallery", "galleries"]
    private static let semanticWeak: Set<String> = ["adult", "adults", "mature", "uncensored", "lewd", "erotic", "nude", "nudes", "naked", "sex", "sexual", "xxx", "r18", "18plus"]
    private static let semanticComics: Set<String> = ["comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi"]
    private static let semanticCatalog: Set<String> = ["genre", "genres", "category", "categories", "tag", "tags", "catalog", "browse"]
    private static let semanticChapters: Set<String> = ["chapter", "book", "section", "volume", "part", "appendix"]
    private static let multilingualSemanticLabels = ["色情片", "色情视频", "色情視頻", "色情影片", "色情电影", "色情電影", "性爱娃娃", "性愛娃娃", "情趣娃娃", "性玩具", "ラブドール", "セックスドール", "ポルノ", "포르노", "음란물"]

    private static func semanticNormalized(_ value: String) -> String {
        var decoded = value
        let encodedRuns = try! NSRegularExpression(pattern: #"(?:%[a-f0-9]{2})+"#, options: .caseInsensitive)
        for _ in 0..<3 {
            let next = NSMutableString(string: decoded)
            for match in encodedRuns.matches(in: decoded, range: NSRange(decoded.startIndex..., in: decoded)).reversed() {
                let run = next.substring(with: match.range)
                let bytes = run.split(separator: "%").compactMap { UInt8($0, radix: 16) }
                next.replaceCharacters(in: match.range, with: run.removingPercentEncoding ?? String(String.UnicodeScalarView(bytes.map { UnicodeScalar($0) })))
            }
            if next as String == decoded { break }
            decoded = next as String
        }
        return normalizedVocabulary(decoded).lowercased()
    }

    private static func semanticTokens(_ value: String) -> [String] {
        if value.range(of: #"^[a-z\d]{24,}$"#, options: .regularExpression) != nil,
           value.range(of: #"\d"#, options: .regularExpression) != nil { return [] }
        if value.range(of: #"^[a-f\d]{16,}$|^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$"#, options: .regularExpression) != nil { return [] }
        let text = normalizedEvidence(value).lowercased()
        let source = text as NSString
        return words.matches(in: text, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
    }

    private static func semanticClassifies(_ value: String, previous: String = "", hostname: Bool = false) -> Bool {
        let evidence = normalizedEvidence(semanticChapters.contains(previous) ? previous + " " + value : value).lowercased()
        let tokens = semanticTokens(evidence)
        if tokens.isEmpty { return false }
        if tokens.contains(where: { searchKeywords.contains($0) || ["p0rnography", "erotica"].contains($0) }) { return true }
        let multilingual = evidence.replacingOccurrences(of: #"[\u200b-\u200d\u2060\ufeff\u0640\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[أإآٱ]"#, with: "ا", options: .regularExpression)
        if multilingualSemanticLabels.contains(where: multilingual.contains)
            || multilingual.range(of: #"(?:^|[^\p{L}\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\p{L}\p{N}])"#, options: .regularExpression) != nil
            || multilingual.range(of: #"(?:^|[^\p{L}\p{N}])(?:ال)?(?:فيديو(?:هات)?|فيلم|افلام)[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#, options: .regularExpression) != nil
            || multilingual.range(of: #"(?:^|[^\p{L}\p{N}])(?:pornografi(?:a|co|ca)s?|pornographi(?:e|ques?)|pornografie|pornografisch(?:e[rmns]?)?|порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?|порнографи\p{Cyrillic}*)(?=$|[^\p{L}\p{N}])"#, options: .regularExpression) != nil { return true }
        let compact = tokens.joined()
        if compact.range(of: #"^(?!rule34\d)(?:p[o0]rn|h[e3]ntai|nsfw|rule34)(?:hub|tube|world|land|zone|site|sites|read|reader|live|free|hd|vr|4k|\d{1,3}|videos?|photos?|pics?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)?$"#, options: .regularExpression) != nil
            || compact.range(of: #"^(?:free|best|my|the|all|hd|new|daily|live|watch|read|anime|manga|comic|comics|webtoon|3d|vr|4k)(?:porn|hentai|nsfw)$"#, options: .regularExpression) != nil { return true }
        if hostname, compact.range(of: #"^x{3,}$"#, options: .regularExpression) != nil { return true }
        let media = #"(?:videos?|vids?|photos?|photographs?|pics?|images?|gifs?|prints?|posters?|pin[\s_-]?ups?|calendars?|cams?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|novels?|art|galler(?:y|ies))"#
        let marker = "(?:adults?|mature|uncensored|lewd|erotic|nudes?|naked|sex(?:ual)?|x{3,}|r18|18plus)"
        if tokens.contains(where: { $0.range(of: "^(?:" + marker + media + "|" + media + marker + ")$", options: .regularExpression) != nil }) { return true }
        if tokens.contains(where: { $0.range(of: #"^r34(?:comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)$"#, options: .regularExpression) != nil })
            || (tokens.contains("r34") && (tokens.contains(where: semanticComics.contains) || semanticCatalog.contains(previous))) { return true }
        if semanticChapters.contains(previous), value.range(of: #"^x{3,}$"#, options: .regularExpression) != nil { return false }
        let hasMarker = tokens.enumerated().contains { index, token in
            (semanticWeak.contains(token) || token.range(of: #"^x{3,}$"#, options: .regularExpression) != nil)
                && !(token == "uncensored" && index + 1 < tokens.count && tokens[index + 1] == "interview")
        } || value.range(of: #"(?:^|[^\p{L}\p{N}])18\s*\+(?:$|[^\p{L}\p{N}])"#, options: .regularExpression) != nil
        return hasMarker && (tokens.contains(where: semanticMedia.contains) || semanticCatalog.contains(previous))
    }

    static func isMediaDiscoverySearchURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return false }
        if components.path.range(of: #"(?:^|/)(?:images?|videos?|photos?|media)(?:/|$)"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        return (components.queryItems ?? []).contains { item in
            ["tbm", "udm", "ia", "iax", "category", "categories", "type", "t"].contains(item.name.lowercased())
                && ((item.value ?? "").range(of: #"^(?:isch|vid|images?|videos?|photos?|media)$"#, options: [.regularExpression, .caseInsensitive]) != nil
                    || (item.name.lowercased() == "udm" && ["2", "7"].contains(item.value ?? "")))
        }
    }

    static func containsSearch(_ value: String, hostname: String = "", mediaDiscovery: Bool = false) -> Bool {
        let ageSource = value.precomposedStringWithCompatibilityMapping
        let ageText = searchFormatCharacters.stringByReplacingMatches(in: ageSource, range: NSRange(ageSource.startIndex..., in: ageSource), withTemplate: "")
        if matches(ageSearchMarker, ageText) { return true }
        let text = normalizedEvidence(value)
        let lower = text.lowercased()
        let source = lower as NSString
        let tokens = words.matches(in: lower, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
        if tokens.contains(where: { searchKeywords.contains($0) || matches(searchCompound, $0) }) { return true }
        if text.range(of: #"(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}]|videos?\b|vids?\b|photos?\b|pics?\b|porn\b)"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if text.range(of: #"^\s*(?:nud(?:s|3s?)?|nudes)\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:(?:adults?|mature|uncensored|lewd|erotica?|explicit|smut|ecchi|nsfw|hentai|porn|r[\s_-]*1[89]|1[89](?:\s*\+|[\s_-]*plus))[\s_.-]*(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)|(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)[\s_.-]*(?:adults?|mature|uncensored|lewd|erotica?|explicit|smut|ecchi|nsfw|hentai|porn|r[\s_-]*1[89]|1[89](?:\s*\+|[\s_-]*plus)))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:(?:18\s*\+|18[\s_-]*plus)[\s_-]+(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)|(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)[\s_-]+(?:18\s*\+|18[\s_-]*plus))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil || contains(text) { return true }
        let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let domains = ["reddit.com", "deviantart.com", "artstation.com", "pixiv.net", "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com", "artmajeur.com", "inkbunny.net", "sofurry.com", "weasyl.com", "saatchiart.com", "fineartamerica.com", "flickr.com", "500px.com", "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app", "patreon.com", "itch.io", "discord.com", "discordapp.com", "dedigger.com", "filepursuit.com", "searchfiles.de", "filesearch.link", "mediafiretrend.com", "searchshared.info", "meawfy.com", "eyedex.org", "uvrx.com", "faganfinder.com", "searchftps.net", "mmnt.ru", "drive.google.com", "mega.nz", "mega.io", "mediafire.com", "4shared.com", "dropbox.com", "gofile.io", "archive.org", "images.google.com", "lens.google.com", "images.search.yahoo.com", "video.search.yahoo.com", "tineye.com", "pimeyes.com", "lenso.ai", "facecheck.id", "gettyimages.com", "istockphoto.com", "shutterstock.com", "stock.adobe.com", "alamy.com", "dreamstime.com", "depositphotos.com", "123rf.com", "pexels.com", "pixabay.com", "unsplash.com", "freepik.com", "giphy.com", "tenor.com", "photobucket.com", "imgur.com", "youtube.com", "vimeo.com", "dailymotion.com"]
        let platform = domains.contains { host == $0 || host.hasSuffix("." + $0) }
        if (host == "itch.io" || host.hasSuffix(".itch.io")), text.range(of: #"(?:^|[/#])tag-adult(?:$|[/?.#])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if host == "reddit.com" || host.hasSuffix(".reddit.com") {
            if text.range(of: #"^\s*x{1,2}\s*$|(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        }
        let namedPlatform = text.range(of: #"(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|fur[\s_-]*affinity|artmajeur|inkbunny|sofurry|weasyl|saatchi[\s_-]*art|fine[\s_-]*art[\s_-]*america|flickr|500px|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil
        let discoveryText = text.replacingOccurrences(of: "3", with: "e").replacingOccurrences(of: "0", with: "o")
        let discovery = mediaDiscovery
            || ["dedigger.com", "filepursuit.com", "searchfiles.de", "filesearch.link", "mediafiretrend.com", "searchshared.info", "meawfy.com", "eyedex.org", "uvrx.com", "faganfinder.com", "searchftps.net", "mmnt.ru", "drive.google.com", "mega.nz", "mega.io", "mediafire.com", "4shared.com", "dropbox.com", "gofile.io", "archive.org", "images.google.com", "lens.google.com", "images.search.yahoo.com", "video.search.yahoo.com", "tineye.com", "pimeyes.com", "lenso.ai", "facecheck.id", "gettyimages.com", "istockphoto.com", "shutterstock.com", "stock.adobe.com", "alamy.com", "dreamstime.com", "depositphotos.com", "123rf.com", "pexels.com", "pixabay.com", "unsplash.com", "freepik.com", "giphy.com", "tenor.com", "photobucket.com", "imgur.com", "youtube.com", "vimeo.com", "dailymotion.com"].contains { host == $0 || host.hasSuffix("." + $0) }
            || matches(discoveryNames, text)
        if discovery && (matches(contextualMarkers, discoveryText) || matches(discoveryMarkers, discoveryText)) { return true }
        return (platform || namedPlatform) && matches(contextualMarkers, discoveryText)
    }

    static func contains(_ value: String) -> Bool {
        let text = normalizedEvidence(value).lowercased()
        if containsPrintMediaEvidence(text) { return true }
        let textSource = text as NSString
        let labelTokens = words.matches(in: text, range: NSRange(location: 0, length: textSource.length)).map { textSource.substring(with: $0.range) }
        if labelTokens.contains(where: { labels.contains($0) || ["porn", "porno", "nsfw"].contains($0) }) { return true }
        if text.range(of: #"(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])"#, options: .regularExpression) != nil { return true }
        let combined = text.replacingOccurrences(of: #"\b(?:without(?:[\s_-]+any)?|with[\s_-]+no)[\s_-]+clothes\b"#, with: "naked", options: .regularExpression)
            .replacingOccurrences(of: #"\b(?:wearing[\s_-]+nothing|(?:in[\s_-]+(?:the|their|a)[\s_-]+)?birthday[\s_-]+suits?|in[\s_-]+the[\s_-]+buff)\b"#, with: "naked", options: .regularExpression)
            .replacingOccurrences(of: #"\b(?:pleasur(?:ing|e)[\s_-]+(?:myself|herself|himself|themselves)|playing[\s_-]+with[\s_-]+(?:myself|herself|himself|themselves)|self[\s_-]+pleasure)\b"#, with: "selfpleasure", options: .regularExpression)
            .replacingOccurrences(of: #"\bup[\s_-]+skirt\b"#, with: "upskirt", options: .regularExpression)
            .replacingOccurrences(of: #"\bdown[\s_-]+blouse\b"#, with: "downblouse", options: .regularExpression)
            .replacingOccurrences(of: #"\bstrip[\s_-]+tease\b"#, with: "striptease", options: .regularExpression)
            .replacingOccurrences(of: #"\bnip[\s_-]+slips?\b"#, with: "nipslip", options: .regularExpression)
            .replacingOccurrences(of: #"\bcream[\s_\p{Pd}]+pies?\b"#, with: "creampie", options: .regularExpression)
            .replacingOccurrences(of: #"\bfull[\s_\p{Pd}]+frontal\b"#, with: "fullfrontal", options: .regularExpression)
            .replacingOccurrences(of: #"\bsee[\s_\p{Pd}]+through\b"#, with: "seethrough", options: .regularExpression)
        let source = combined as NSString
        let tokens = words.matches(in: combined, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
        for (index, token) in tokens.enumerated() {
            let directPerson = [1, -1].contains { direction in
                for offset in 1...12 {
                    let target = index + direction * offset
                    if target < 0 || target >= tokens.count { return false }
                    let adjacent = tokens[target]
                    if matches(people, adjacent) { return true }
                    if !matches(connectors, adjacent) { return false }
                }
                return false
            }
            if (matches(exposure, token) || token == "bare") && directPerson { return true }
            let hot = token == "sexy" || token == "hot"
            guard hot || [marker, exposure, sexual, acts, body, marketing].contains(where: { matches($0, token) }) else { continue }
            let lower = max(0, index - 4), upper = min(tokens.count, index + 5)
            let nearby = Array(tokens[lower..<upper])
            if matches(strongActs, token) && nearby.contains(where: { matches(media, $0) || matches(people, $0) }) { return true }
            if matches(strongMediaMarker, token) && nearby.contains(where: { matches(media, $0) }) { return true }
            if token == "x" || token == "xx" {
                if nearby.contains(where: { ["model", "men", "files", "axis", "chromosome", "chromosomes"].contains($0) }) { continue }
            }
            if nearby.contains(where: { matches(ordinary, $0) }) { continue }
            if token == "sex" && nearby.contains(where: { matches(relationship, $0) }) { continue }
            if matches(ambiguousBody, token) && nearby.contains(where: { matches(ordinaryBody, $0) }) { continue }
            if hot || [exposure, sexual, body].contains(where: { matches($0, token) }) {
                if nearby.contains(where: { matches(bodyContext, $0) }) { continue }
            }
            if matches(exposure, token) && nearby.contains(where: { matches(nonsexualExposure, $0) }) { continue }
            let others = (lower..<upper).filter { $0 != index }.map { tokens[$0] }
            if hot {
                if others.contains(where: { matches(people, $0) }) { return true }
                continue
            }
            if [exposure, sexual, acts].contains(where: { matches($0, token) }) && others.contains(where: { word in
                [media, people, body, exposure, sexual, acts, marketing].contains(where: { matches($0, word) })
            }) { return true }
            if matches(body, token) && others.contains(where: { word in [media, exposure, sexual].contains(where: { matches($0, word) }) }) { return true }
            if matches(marker, token) && others.contains(where: { word in
                matches(media, word) || matches(contributor, word)
                    || (matches(marker, word) && !(["adult", "adults"].contains(token) && ["adult", "adults"].contains(word)))
            }) { return true }
            if matches(marketing, token) && others.contains(where: { word in [exposure, sexual, acts].contains(where: { matches($0, word) }) }) { return true }
        }
        return false
    }
}
// END GENERATED EXPLICIT MEDIA MATCHER
