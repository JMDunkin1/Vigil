import CoreGraphics
import Foundation
import ImageIO
import SensitiveContentAnalysis

enum ContentSafetyVerdict: String, Equatable, Sendable {
    case safe
    case sensitive
    case unknown
}

enum UnclassifiedMediaPolicy: String, Equatable, Sendable {
    static let infoDictionaryKey = "VigilUnclassifiedMediaPolicy"

    case conceal
    case revealUnclassified = "reveal-unclassified"

    init(infoDictionaryValue: Any?) {
        guard let value = infoDictionaryValue as? String,
              let configured = Self(rawValue: value) else {
            self = .conceal
            return
        }
        self = configured
    }

    init(bundle: Bundle) {
        self.init(infoDictionaryValue: bundle.object(forInfoDictionaryKey: Self.infoDictionaryKey))
    }

    var concealsUnclassifiedMedia: Bool { self == .conceal }

    func resolve(_ verdict: ContentSafetyVerdict) -> ContentSafetyVerdict {
        guard verdict == .unknown, self == .revealUnclassified else { return verdict }
        return .safe
    }
}

protocol MediaSafetyClassifying: Sendable {
    func classify(imageData: Data) async -> ContentSafetyVerdict
}

protocol PageTextSafetyClassifying: Sendable {
    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict
}

/// Uses Apple's on-device Sensitive Content Analysis framework. The framework only
/// operates when its entitlement and the person's system policy permit analysis.
/// A disabled policy, malformed image, or analysis error deliberately returns
/// `.unknown`; the caller applies the explicit build policy for unclassified
/// media. Full-capability builds conceal it, while the Personal Team fallback
/// can reveal it without changing the classifier's verdict globally.
final class AppleSensitiveMediaClassifier: MediaSafetyClassifying, @unchecked Sendable {
    private let analyzer: SCSensitivityAnalyzer

    init(analyzer: SCSensitivityAnalyzer = SCSensitivityAnalyzer()) {
        self.analyzer = analyzer
    }

    func classify(imageData: Data) async -> ContentSafetyVerdict {
        guard analyzer.analysisPolicy != .disabled,
              let source = CGImageSourceCreateWithData(imageData as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return .unknown
        }

        do {
            let result = try await analyzer.analyzeImage(image)
            return result.isSensitive ? .sensitive : .safe
        } catch {
            return .unknown
        }
    }
}

struct ExplicitContentTextPolicy: Codable, Equatable, Sendable {
    static let currentSchemaVersion = 1
    static let resourceName = "ExplicitContentPolicy"

    struct ContextualRule: Codable, Equatable, Sendable {
        let id: String
        let contexts: [String]
        let markers: [String]
        let maximumDistanceCharacters: Int
    }

    let schemaVersion: Int
    let terms: [String]
    let phrases: [String]
    let contextualRules: [ContextualRule]

    static func load(bundle: Bundle = .main) -> Self? {
        guard let url = bundle.url(forResource: resourceName, withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let policy = try? JSONDecoder().decode(Self.self, from: data),
              policy.isUsable else { return nil }
        return policy
    }

    var isUsable: Bool {
        schemaVersion == Self.currentSchemaVersion
            && terms.count >= 20
            && phrases.count >= 7
            && terms.allSatisfy(Self.isNormalizedValue)
            && phrases.allSatisfy(Self.isNormalizedValue)
            && contextualRules.allSatisfy { rule in
                !rule.id.isEmpty
                    && !rule.contexts.isEmpty
                    && !rule.markers.isEmpty
                    && (1...1_000).contains(rule.maximumDistanceCharacters)
                    && rule.contexts.allSatisfy(Self.isNormalizedValue)
                    && rule.markers.allSatisfy(Self.isNormalizedValue)
            }
    }

    private static func isNormalizedValue(_ value: String) -> Bool {
        !value.isEmpty
            && value == value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// Applies the generated policy shared with Vigil's navigation rules to the
/// bounded text supplied by the page scanner. A missing, stale, or malformed
/// policy is `.unknown`, which keeps the page concealed instead of silently
/// falling back to a much smaller hard-coded phrase list.
struct ConservativePageTextClassifier: PageTextSafetyClassifying {
    private struct Token: Sendable {
        let value: String
        let offset: Int
    }

    private struct CompiledContextualRule: Sendable {
        let contexts: Set<String>
        let markers: Set<String>
        let maximumDistanceCharacters: Int
    }

    private struct MultilingualRule: Sendable {
        let labels: Set<String>
        let pattern: String
    }

    // Keep these bounded grammatical forms and normalization aligned with
    // containsMultilingualExplicitText in src/explicitMediaContext.ts. A rule
    // is active only when the supplied policy contains its existing label.
    private static let multilingualRules: [MultilingualRule] = [
        .init(labels: ["اباحي", "اباحية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["فيديو جنسي", "فيديوهات جنسية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?فيديو(?:هات)?[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["فيلم جنسي"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?فيلم[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["افلام جنسية"], pattern: #"(?:^|[^\p{L}\p{N}])(?:ال)?افلام[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografia", "pornografico", "pornografica"], pattern: #"(?:^|[^\p{L}\p{N}])pornografi(?:a|co|ca)s?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornographie", "pornographique"], pattern: #"(?:^|[^\p{L}\p{N}])pornographi(?:e|ques?)(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografie"], pattern: #"(?:^|[^\p{L}\p{N}])pornografie(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["pornografisch"], pattern: #"(?:^|[^\p{L}\p{N}])pornografisch(?:e[rmns]?)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["порно"], pattern: #"(?:^|[^\p{L}\p{N}])порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?(?=$|[^\p{L}\p{N}])"#),
        .init(labels: ["порнография"], pattern: #"(?:^|[^\p{L}\p{N}])порнографи\p{Cyrillic}*(?=$|[^\p{L}\p{N}])"#)
    ]
    private static let latinAccentPattern = try! NSRegularExpression(pattern: #"\p{Latin}\p{M}*"#)

    private struct CompiledPolicy: Sendable {
        let phrases: [String]
        let terms: Set<String>
        let pornCompoundsEnabled: Bool
        let unspacedTerms: [String]
        let multilingualPatterns: [String]
        let contextualRules: [CompiledContextualRule]
    }

    private let policy: CompiledPolicy?

    init(policy: ExplicitContentTextPolicy? = ExplicitContentTextPolicy.load()) {
        guard let policy, policy.isUsable else {
            self.policy = nil
            return
        }
        let multilingualTerms = Set(policy.terms.map(Self.normalizeMultilingual))
        let multilingualRules = Self.multilingualRules.filter { !$0.labels.isDisjoint(with: multilingualTerms) }
        // Preserve Japanese voicing marks and Korean syllables when matching
        // these labels, rather than applying the ordinary Latin text folding.
        let unspacedTerms = multilingualTerms.filter {
            $0.range(of: #"[\p{Han}\p{Katakana}\p{Hangul}]"#, options: .regularExpression) != nil
        }
        let multilingualLabels = Set(multilingualRules.flatMap { $0.labels }).union(unspacedTerms)
        let terms = Set(policy.terms.filter { !multilingualLabels.contains(Self.normalizeMultilingual($0)) }
            .map(Self.normalize).filter { !$0.isEmpty })
        // Some languages express a policy term with multiple words. Match
        // those as bounded phrases rather than looking for a single token.
        let phrases = Set(policy.phrases.map(Self.normalize).filter { !$0.isEmpty })
            .union(terms.filter { $0.contains(" ") })
        self.policy = CompiledPolicy(
            phrases: phrases.sorted().map { " \($0) " },
            terms: terms,
            pornCompoundsEnabled: !terms.isDisjoint(with: ["porn", "porno"]),
            unspacedTerms: unspacedTerms.sorted(),
            multilingualPatterns: multilingualRules.map { $0.pattern },
            contextualRules: policy.contextualRules.map { rule in
                CompiledContextualRule(
                    contexts: Set(rule.contexts.map(Self.normalize)),
                    markers: Set(rule.markers.map(Self.normalize)),
                    maximumDistanceCharacters: rule.maximumDistanceCharacters
                )
            }
        )
    }

    func classify(pageText: String, wasTruncated: Bool) async -> ContentSafetyVerdict {
        _ = wasTruncated
        guard let policy else { return .unknown }
        let evidence = BroadenedExplicitMedia.normalizedEvidence(pageText)
        let multilingualText = Self.normalizeMultilingual(evidence)
        if policy.unspacedTerms.contains(where: multilingualText.contains)
            || policy.multilingualPatterns.contains(where: {
                multilingualText.range(of: $0, options: .regularExpression) != nil
            }) {
            return .sensitive
        }
        let normalized = Self.normalize(evidence)
        let tokens = Self.tokens(normalized)
        guard !tokens.isEmpty else { return .safe }

        let paddedText = " \(normalized) "
        if BroadenedExplicitMedia.contains(evidence) || policy.phrases.contains(where: paddedText.contains)
            || tokens.contains(where: { token in
                policy.terms.contains(token.value)
                    || (policy.pornCompoundsEnabled && Self.isDeliberatePornCompound(token.value))
            })
            || policy.contextualRules.contains(where: { Self.matches($0, in: tokens) }) {
            return .sensitive
        }

        // The caller records truncation for diagnostics, but long feeds should
        // not become unusable solely because they exceed a bounded inspection.
        return .safe
    }

    private static func normalizeMultilingual(_ value: String) -> String {
        var text = value.precomposedStringWithCompatibilityMapping
            .replacingOccurrences(of: #"[\u200b-\u200d\u2060\ufeff\u0640]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"[أإآٱ]"#, with: "ا", options: .regularExpression)
        let source = text as NSString
        // Fold only Latin accents, as the shared helper does. Other scripts'
        // combining marks can distinguish unrelated words and names.
        for match in latinAccentPattern.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
            let original = source.substring(with: match.range)
            let unmarked = String(String.UnicodeScalarView(original.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
                switch $0.properties.generalCategory {
                case .nonspacingMark, .spacingMark, .enclosingMark: return false
                default: return true
                }
            }))
            if unmarked != original, let range = Range(match.range, in: text) {
                text.replaceSubrange(range, with: unmarked)
            }
        }
        return text.lowercased()
    }

    private static func isDeliberatePornCompound(_ token: String) -> Bool {
        // Prefixes alone also match ordinary names such as Pornichet. Keep
        // deliberate media/service compounds bounded to the complete token.
        token.range(of: #"^(?:porn|porno|p0rn)(?:ography|ographic|stars?|videos?|vids?|photos?|pics?|images?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|hub|tube|hd|vr|4k)$"#, options: .regularExpression) != nil
    }

    private static func normalize(_ value: String) -> String {
        let folded = value
            .folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
            .lowercased()
        var scalars = String.UnicodeScalarView()
        scalars.reserveCapacity(folded.utf8.count)
        for scalar in folded.unicodeScalars {
            scalars.append(CharacterSet.alphanumerics.contains(scalar) ? scalar : " ")
        }
        // Preserve Character-level whitespace handling: combining marks can
        // join a separator's grapheme and must be removed together with it.
        return String(scalars).split(whereSeparator: \Character.isWhitespace).joined(separator: " ")
    }

    private static func tokens(_ normalized: String) -> [Token] {
        var offset = 0
        return normalized.split(separator: " ").map { substring in
            let token = Token(value: String(substring), offset: offset)
            offset += substring.count + 1
            return token
        }
    }

    private static func matches(_ rule: CompiledContextualRule, in tokens: [Token]) -> Bool {
        // Token offsets are ordered. Only the latest occurrence of each side can
        // be the closest match to the current token, so one pass replaces the
        // previous context-by-marker cross product on long, repetitive pages.
        var lastContextOffset: Int?
        var lastMarkerOffset: Int?
        for token in tokens {
            if rule.contexts.contains(token.value) { lastContextOffset = token.offset }
            if rule.markers.contains(token.value) { lastMarkerOffset = token.offset }
            if let context = lastContextOffset, let marker = lastMarkerOffset,
               abs(context - marker) <= rule.maximumDistanceCharacters {
                return true
            }
        }
        return false
    }
}

// BEGIN GENERATED EXPLICIT MEDIA MATCHER
// Generated from src/explicitMediaContext.ts; do not edit this section.
private enum BroadenedExplicitMedia {
    private static let labels: Set<String> = ["pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos", "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes", "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate", "toonily", "omegascans", "manhwabuddy", "mangadna", "manghaha", "mangaforfree", "manhwaclub", "webtoonscan", "pornhwa", "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls", "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"]
    private static let searchKeywords: Set<String> = ["porn", "porno", "prno", "p0rn", "p0rno", "pornography", "pornographic", "nsfw", "hentai", "h3ntai", "rule34", "gonewild", "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube", "youporn", "spankbang", "xvideos", "xnxx", "xhamster", "pornhub", "honeytoon", "honeytoons", "hooneytoon", "hooneytoons", "toongod", "pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos", "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes", "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate", "toonily", "omegascans", "manhwabuddy", "mangadna", "manghaha", "mangaforfree", "manhwaclub", "webtoonscan", "pornhwa", "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls", "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"]
    private static let searchCompound = try! NSRegularExpression(pattern: #"^(?:porn|porno|p0rn|hentai|h3ntai|nsfw)(?:videos?|vids?|photos?|pics?|images?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|hub|tube|hd|vr|4k)$"#)
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
        let latin = try! NSRegularExpression(pattern: #"\p{Script=Latin}\p{M}*"#)
        let source = text as NSString
        for match in latin.matches(in: text, range: NSRange(location: 0, length: source.length)).reversed() {
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
        text = text.replacingOccurrences(of: #"(?:^|[^\p{L}\p{N}])(?:omega[\s_.\p{Pd}]+scans)(?=$|[^\p{L}\p{N}])"#, with: " omegascans ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+dna(?=$|[^\p{L}\p{N}])"#, with: " mangadna ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+for[\s_.\p{Pd}]+free(?=$|[^\p{L}\p{N}])"#, with: " mangaforfree ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+buddy(?=$|[^\p{L}\p{N}])"#, with: " manhwabuddy ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+club(?=$|[^\p{L}\p{N}])"#, with: " manhwaclub ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:sex|love)[\s_\p{Pd}]+(?:(?:silicone|tpe|realistic|lifelike|full[\s_\p{Pd}]+body)[\s_\p{Pd}]+){0,3}dolls?\b"#, with: "sexdoll", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bsex[\s_\p{Pd}]+robots?\b"#, with: "sexrobot", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bsex[\s_\p{Pd}]+toys?\b"#, with: "sextoy", options: [.regularExpression, .caseInsensitive])
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
        text = text.replacingOccurrences(of: #"\b(?:nissan|skyline|gt[\s_-]?r)[\s_-]+r[\s_-]?34\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\br[\s_-]?34[\s_-]+(?:nissan|skyline|gt[\s_-]?r)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\brule[\s_.-]*34[\s_-]+(?:algorithm|theorem|proof|specification|standard|procedure)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:chapter|book|section|volume|part|appendix|super[\s_-]+bowl)[\s_-]+x{3,}\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bx{3,}[\s_-]+chromosomes?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bchromosomes?[\s_-]+x{3,}\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bxxx[\s_-]+(?:vin[\s_-]+diesel|return[\s_-]+of[\s_-]+xander[\s_-]+cage|2002[\s_-]+(?:film|movie))\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bvin[\s_-]+diesel[\s_-]+xxx\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\badult[\s_-]+(?:education|learning|training|literacy)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bmature[\s_-]+skin\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\buncensored[\s_-]+interviews?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnude[\s_-]+art[\s_-]+(?:figure[\s_-]+)?drawings?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnude[\s_-]+art[\s_-]+videos?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnudity[\s_-]+anatomy\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnude[\s_-]+(?:watercolou?r[\s_-]+palettes?|art[\s_-]+sculptures?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bmature[\s_-]+trees?\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\berotic[\s_-]+imagery[\s_-]+art[\s_-]+history\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:porn|porno|pornography|pornographic)[\s_-]+(?:content[\s_-]+)?(?:blockers?|blocking|filters?|filtering|detection|detectors?|moderation|prevention)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bpornography[\s_-]+(?:laws?|legal[\s_-]+history)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b(?:porn|pornography)[\s_-]+(?:addiction[\s_-]+)?(?:recovery|treatment)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnsfw[\s_-]+(?:classifiers?|classification|filters?|filtering|detection|detectors?|moderation)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\bnsfw[\s_-]+api[\s_-]+(?:reference|documentation)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        text = text.replacingOccurrences(of: #"\b18\s*\+[\s_-]+(?:travel[\s_-]+insurance|insurance|(?:voting[\s_-]+)?eligibility|age[\s_-]+requirements?)\b"#, with: " vigilordinary ", options: [.regularExpression, .caseInsensitive])
        return text
    }

    static func normalizedEvidence(_ value: String) -> String { normalized(value) }

    // Match meaningful destination labels and early routes, never credentials,
    // arbitrary query/hash metadata, or identifiers later in the address.
    static func containsSemanticURL(_ url: URL) -> Bool {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host else { return false }
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
        let media = "(?:videos?|vids?|photos?|pics?|images?|gifs?|cams?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|novels?|art|galler(?:y|ies))"
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

    static func containsSearch(_ value: String, hostname: String = "") -> Bool {
        let text = normalizedEvidence(value)
        let lower = text.lowercased()
        let source = lower as NSString
        let tokens = words.matches(in: lower, range: NSRange(location: 0, length: source.length)).map { source.substring(with: $0.range) }
        if tokens.contains(where: { searchKeywords.contains($0) || matches(searchCompound, $0) }) { return true }
        if text.range(of: #"(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}]|videos?\b|vids?\b|photos?\b|pics?\b|porn\b)"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if text.range(of: #"^\s*(?:nud(?:s|3s?)?|nudes)\s*$"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:(?:adults?|mature|uncensored|lewd|erotica?|explicit|smut|ecchi|nsfw|hentai|porn|r[\s_-]*1[89]|1[89](?:\s*\+|[\s_-]*plus))[\s_.-]*(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)|(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)[\s_.-]*(?:adults?|mature|uncensored|lewd|erotica?|explicit|smut|ecchi|nsfw|hentai|porn|r[\s_-]*1[89]|1[89](?:\s*\+|[\s_-]*plus)))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil || text.range(of: #"(?:^|[^\p{L}\p{N}])(?:(?:18\s*\+|18[\s_-]*plus)[\s_-]+(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)|(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)[\s_-]+(?:18\s*\+|18[\s_-]*plus))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil || contains(text) { return true }
        let host = hostname.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        let domains = ["reddit.com", "deviantart.com", "artstation.com", "pixiv.net", "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com", "artmajeur.com", "inkbunny.net", "sofurry.com", "weasyl.com", "saatchiart.com", "fineartamerica.com", "flickr.com", "500px.com", "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app", "patreon.com", "itch.io", "discord.com", "discordapp.com"]
        let platform = domains.contains { host == $0 || host.hasSuffix("." + $0) }
        if (host == "itch.io" || host.hasSuffix(".itch.io")), text.range(of: #"(?:^|[/#])tag-adult(?:$|[/?.#])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        if host == "reddit.com" || host.hasSuffix(".reddit.com") {
            if text.range(of: #"^\s*x{1,2}\s*$|(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil { return true }
        }
        let namedPlatform = text.range(of: #"(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|fur[\s_-]*affinity|artmajeur|inkbunny|sofurry|weasyl|saatchi[\s_-]*art|fine[\s_-]*art[\s_-]*america|flickr|500px|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil
        let discoveryText = text.replacingOccurrences(of: "3", with: "e").replacingOccurrences(of: "0", with: "o")
        return (platform || namedPlatform) && discoveryText.range(of: #"(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func contains(_ value: String) -> Bool {
        let text = normalizedEvidence(value).lowercased()
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
            if matches(marker, token) && others.contains(where: { word in [media, marker, contributor].contains(where: { matches($0, word) }) }) { return true }
            if matches(marketing, token) && others.contains(where: { word in [exposure, sexual, acts].contains(where: { matches($0, word) }) }) { return true }
        }
        return false
    }
}
// END GENERATED EXPLICIT MEDIA MATCHER
