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
        "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag", "mode"
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
        var values = components.queryItems?
            .filter { Self.isProtectedSearchParameter($0.name, onSearchRoute: onSearchRoute) }
            .compactMap(\.value) ?? []
        if let fragment = components.percentEncodedFragment, fragmentText != nil,
           let queryStart = fragment.firstIndex(of: "?") {
            for pair in fragment[fragment.index(after: queryStart)...].split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2, Self.isProtectedSearchParameter(String(parts[0]), onSearchRoute: true) {
                    values.append(String(parts[1]))
                }
            }
        }
        if let routeText, !routeText.isEmpty { values.append(routeText) }
        if let fragmentText, !fragmentText.isEmpty { values.append(fragmentText) }
        return values.map { Self.decodedCandidates($0).last ?? $0 }.contains { terms in
            rules.blockedSearchTerms.contains { term in
                !BroadenedExplicitMedia.isAdditionalLabel(term)
                    && terms.range(of: term, options: [.caseInsensitive, .diacriticInsensitive]) != nil
            } || Self.isExplicitPersonSearch(terms) || BroadenedExplicitMedia.containsSearch(terms, hostname: url.host ?? "")
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
        if FilterRules.protectedSearchParameterNames.contains(name) { return true }
        return onSearchRoute && name.range(of: #"^(q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|p|k|s|wd|word|tags|tag)\[(\d*|q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|word|tags|tag)\]$"#, options: .regularExpression) != nil
    }

    private static func searchRouteText(_ value: String) -> String? {
        var route = value
        if route.hasPrefix("#") { route.removeFirst() }
        if route.hasPrefix("!") { route.removeFirst() }
        route = String(route.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        let path = (decodedCandidates(route).last ?? route).replacingOccurrences(of: "+", with: " ")
        let expression = try! NSRegularExpression(pattern: #"(?:^|/)(advancedsearch(?:\.(?:php|json|html|aspx))?|search(?:\.(?:php|json|html|aspx))?|results?|find|browse|tags?|tagged|hashtag|r|tag-[^/?#]+)(?=/|$)"#, options: .caseInsensitive)
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
    private static let labels: Set<String> = ["pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos", "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes", "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate", "futanari", "ecchi"]
    private static let exposure = try! NSRegularExpression(pattern: #"^(?:nud|nuds|nudes?|nued|nudity|naked|nakedness|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|fullfrontal|seethrough|upskirt|downblouse|nipslips?|cameltoe)$"#)
    private static let sexual = try! NSRegularExpression(pattern: #"^(?:erotic|erotica|lewd|horny|sensual|seductive|sex|sexual|sexually|raunchy|salacious|lustful|lascivious|risque|risqué|sultry|racy|titillating|arousing|aroused|fetish|fetishes|kinky|kink|bdsm|bondage)$"#)
    private static let acts = try! NSRegularExpression(pattern: #"^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|ejaculation|fingering|selfpleasure|creampies?|bukkake|gangbangs?|threesomes?|orgies|orgy|masturbation|masturbating|fucking|penetration|anal|oral|doggystyle|pegging|squirting|sexting)$"#)
    private static let strongActs = try! NSRegularExpression(pattern: #"^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|bukkake|gangbangs?|fucking|selfpleasure|upskirt|downblouse|nipslips?|cameltoe)$"#)
    private static let connectors = try! NSRegularExpression(pattern: #"^(?:a|an|the|of|with|who|that|are|is|were|was|be|being|their|very|really|absolutely|totally|completely|fully|amazingly|beautiful|gorgeous|amazing|pretty|lovely)$"#)
    private static let body = try! NSRegularExpression(pattern: #"^(?:boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?)$"#)
    private static let people = try! NSRegularExpression(pattern: #"^(?:girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?)$"#)
    private static let media = try! NSRegularExpression(pattern: #"^(?:videos?|vids?|movies?|films?|clips?|photos?|pics?|pictures?|images?|gifs?|galler(?:y|ies)|albums?|wallpapers?|footage|streams?|livestreams?|webcams?|compilations?|documentar(?:y|ies)|animations?|animated|illustrations?|comics?|manga|hentai|audios?)$"#)
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
        let latin = try! NSRegularExpression(pattern: #"\p{Script=Latin}\p{M}*"#)
        let source = text as NSString
        for match in latin.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            if let range = Range(match.range, in: text) {
                text.replaceSubrange(range, with: source.substring(with: match.range).folding(options: .diacriticInsensitive, locale: Locale(identifier: "en_US_POSIX")))
            }
        }
        let glyphs = ["а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "Α": "A"]
        let vocabulary: Set<String> = ["naked", "nude", "nudes", "porn", "porno", "nsfw", "sex", "sexual", "topless", "nakedgirls", "nudegirls"]
        let glyphSource = text as NSString
        for match in words.matches(in: text, range: NSRange(location: 0, length: glyphSource.length)).reversed() {
            let original = glyphSource.substring(with: match.range)
            let folded = original.map { glyphs[String($0)] ?? String($0) }.joined().lowercased()
            if vocabulary.contains(folded), let range = Range(match.range, in: text) { text.replaceSubrange(range, with: folded) }
        }
        text = text.replacingOccurrences(of: #"\b(?:nak3d|n4ked|n4k3d)\b"#, with: "naked", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:nud3s?|nudez|nudz|n00dz|n00des|noodz)\b"#, with: "nudes", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:ph0t0s|ph0tos|phot0s)\b"#, with: "photos", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bn[\s_.-]+a[\s_.-]+k[\s_.-]+e[\s_.-]+d\b"#, with: "naked", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bn[\s_.-]+u[\s_.-]+d[\s_.-]+e(?:[\s_.-]+s)?\b"#, with: "nudes", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bp[\s_.-]+[o0][\s_.-]+r[\s_.-]+n\b"#, with: "porn", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(naked|nudes?|topless|bottomless|adult|sex)(girls?|boys?|women|woman|men|males?|females?|models?|videos?|vids?|photos?|pics?|images?)\b"#, with: "$1 $2", options: [.regularExpression, .caseInsensitive])
        return text
    }

    static func normalized(_ value: String) -> String {
        var text = normalizedVocabulary(value)
        text = text.replacingOccurrences(of: #"\bnaked[\s_-]+(?:eyes?|mole[\s_-]+rats?|neck[\s_-]+chickens?|singularit(?:y|ies)|dna|seeds?|calls?|puts?|short[\s_-]+(?:selling|positions?)|stocks?|options?|economics|wires?|cables?|roofs?|trucks?|cakes?|burrito(?:[\s_-]+bowls?)?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:bare[\s_-]+naked[\s_-]+ladies|barenaked[\s_-]+ladies|naked[\s_-]+(?:gun|truth|lunch|brothers[\s_-]+band|king|snake|cowboy|chef))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:nude[\s_-]+descending[\s_-]+(?:a[\s_-]+)?staircase|(?:the[\s_-]+)?naked[\s_-]+maja|blue[\s_-]+nude[\s_-]+matisse)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnude[\s_-]+(?:sculptures?|statues?|figure[\s_-]+drawings?|lipsticks?|makeup|nail[\s_-]+polish|nails?|palettes?|manicures?|beige[\s_-]+swatches?|(?:colou?red[\s_-]+)?(?:shoes?|heels?|dresses?|clothing|outfits?|fabrics?|shades?|colou?rs?))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:see[\s_-]+through|seethrough)[\s_-]+(?:glass|windows?|fabrics?|curtains?|materials?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:topless[\s_-]+trucks?|bottomless[\s_-]+(?:coffee|mimosas?|brunch|pits?))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bstripping[\s_-]+(?:paint|wallpaper|furniture|wood|floors?|ions?|bond[\s_-]+coupons?|thyme[\s_-]+leaves)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:boston[\s_-]+cream[\s_-]+pies?|cream[\s_-]+pies?[\s_-]+baker(?:y|ies)|cum[\s_-]+laude)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:blue|great|coal|crested|marsh|willow|bearded|long[\s_-]+tailed)[\s_-]+tits?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:tits?[\s_-]+bird[\s_-]+species|boobies[\s_-]+galapagos[\s_-]+birds?|(?:blue[\s_-]+footed|red[\s_-]+footed|brown|masked|nazca)[\s_-]+boobies|cock[\s_-]+(?:pheasants?|sparrows?|roosters?|robins?)|wild[\s_-]+asses|pussy[\s_-]+willows?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:horny[\s_-]+(?:toads?|goat[\s_-]+weed)|adult[\s_-]+(?:butterflies|birds?|fish|animals?|insects?))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:oral[\s_-]+(?:thrush|feeding|arguments?|presentations?|exams?|hygiene|fixation[\s_-]+shakira)|(?:assisted[\s_-]+)?oral[\s_-]+feeding|anal[\s_-]+fistulas?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:sex[\s_-]+(?:education|determination|differences|changing|chromosomes?)|sexual[\s_-]+(?:health|reproduction|dimorphism|selection|orientation|harassment|assault)|same[\s_-]+sex|opposite[\s_-]+sex)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:breast[\s_-]+(?:reconstruction|feeding|tissue[\s_-]+histology)|buttocks[\s_-]+stretching|feet[\s_-]+pain|thighs?[\s_-]+exercises?|cleavage[\s_-]+(?:crystal|mineral))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:sex[\s_-]+pistols|dick[\s_-]+(?:van[\s_-]+dyke|tracy|clark)|moby[\s_-]+dick|hot[\s_-]+money|penetration[\s_-]+(?:pricing|testing|tests?))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:fingering[\s_-]+(?:guitar|piano|music)|(?:guitar|piano)[\s_-]+fingering|strip[\s_-]+tease[\s_-]+rose(?=[\s_-]+(?:growing|garden|plant)))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bleak(?:s|ed)?[\s_-]+(?:(?:pentagon|government|classified|court|source)[\s_-]+)?(?:documents?|data|databases?|passwords?|code|pipes?|aquariums?|gardening)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        return text
    }

    static func containsSearch(_ value: String, hostname: String = "") -> Bool {
        let text = normalizedVocabulary(value)
        if text.range(of: #"^\s*(?:nud(?:s|3s?)?|nudes)\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)"#, options: [.regularExpression, .caseInsensitive]) != nil || contains(value) { return true }
        let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let domains = ["reddit.com", "deviantart.com", "artstation.com", "pixiv.net", "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com", "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app", "patreon.com", "itch.io", "discord.com", "discordapp.com"]
        let platform = domains.contains { host == $0 || host.hasSuffix("." + $0) }
        if (host == "itch.io" || host.hasSuffix(".itch.io")), text.range(of: #"(?:^|[/#])tag-adult(?:$|[/?.#])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if host == "reddit.com" || host.hasSuffix(".reddit.com") {
            if text.range(of: #"^\s*x{1,2}\s*$|(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        }
        let namedPlatform = text.range(of: #"(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|furaffinity|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil
        let discoveryText = text.replacingOccurrences(of: "3", with: "e").replacingOccurrences(of: "0", with: "o")
        return (platform || namedPlatform) && discoveryText.range(of: #"(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|18\s*\+|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func contains(_ value: String) -> Bool {
        let vocabularyText = normalizedVocabulary(value).lowercased()
        let text = normalized(value).lowercased()
        let textSource = vocabularyText as NSString
        let labelTokens = words.matches(in: vocabularyText, range: NSRange(location: 0, length: textSource.length)).map { textSource.substring(with: $0.range) }
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
            if matches(marker, token) && others.contains(where: { word in [media, marker, contributor].contains(where: { matches($0, word) }) }) { return true }
            if matches(marketing, token) && others.contains(where: { word in [exposure, sexual, acts].contains(where: { matches($0, word) }) }) { return true }
        }
        return false
    }
}
// END GENERATED EXPLICIT MEDIA MATCHER
