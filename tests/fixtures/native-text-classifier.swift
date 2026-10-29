import Foundation

@main
struct NativeTextClassifierRegression {
    static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let policy = try JSONDecoder().decode(ExplicitContentTextPolicy.self, from: data)
        let classifier = ConservativePageTextClassifier(policy: policy)
        // Mirror the shared helper's blocked/allowed corpus in the actual
        // Foundation classifier, including labels without token boundaries.
        let multilingualBlocked = [
            "فيديو إباحي وجنسي للممثلة Jane Example",
            "إباحية", "اباحي", "والإباحية", "إِبَاحِيّ", "إبـاحي", "إبا\u{200b}حي",
            "فيديو جنسي", "فيديوهات جنسية", "أفلام جنسية", "الفيديو الجنسي",
            "最新色情视频", "色情視頻合集", "色情電影", "ポルノ動画", "ﾎﾟﾙﾉ",
            "포르노를", "음란물", "порно", "порнофильмы", "порнография", "порнографии",
            "pornographie", "pornographiques", "pornografía", "pornograficas", "pornográfico",
            "pornografia", "pornografie", "pornografischen",
            "إبا\u{200c}حي", "إبا\u{200d}حي", "إبا\u{2060}حي", "إبا\u{feff}حي",
            "للإباحية", "والفيديو الجنسي الإباحية", "الفيلم الجنسي", "الأفلام الجنسية",
            "观看色情影片合集", "ポルノを見る", "음란물을", "ПОРНОВИДЕО", "порноролики"
        ]
        let multilingualAllowed = [
            "Jane Example", "أبيلا دينجر", "Jane Example أخبار الممثلة", "فيديو تعليمي",
            "الصحة الجنسية", "sexual health", "性教育", "成人教育", "調色情報",
            "ポルトガル", "영화 교육", "Иван Порнов", "порнозавр", "biography",
            "ボルノ州", "ボルノ州の地理", "ホルノ", "ﾎﾙﾉ", "پروژه"
        ]
        for (expected, texts) in [(ContentSafetyVerdict.sensitive, multilingualBlocked), (.safe, multilingualAllowed)] {
            for text in texts {
                let verdict = await classifier.classify(pageText: text, wasTruncated: false)
                precondition(verdict == expected, "Unexpected multilingual verdict for \(text): \(verdict)")
            }
        }
        for term in policy.terms {
            let verdict = await classifier.classify(pageText: "before \(term) after", wasTruncated: false)
            precondition(verdict == .sensitive, "Missed policy term: \(term)")
        }
        for phrase in policy.phrases {
            let verdict = await classifier.classify(pageText: "before \(phrase) after", wasTruncated: true)
            precondition(verdict == .sensitive, "Missed policy phrase: \(phrase)")
        }
        // Keep ordinary names, opaque tokens, established nonsexual senses,
        // and mixtures aligned with the shared automatic text corpus.
        for text in [
            "Sporn dog harness", "Caporn family history", "webcam480 driver", "actioncam4k", "SKU-RULE34567",
            "AbcHentai90XZ", "dbNSFWfile88123", "account_onlyfanshash_04", "Project118plus build",
            "Nissan R34 photos", "R34 Skyline tuning", "GT-R R34 videos", "Rule 34 algorithm",
            "Chapter XXX images", "XXX chromosome research", "Super Bowl XXX videos", "XXX Vin Diesel movie", "XXX Return of Xander Cage",
            "sex education", "sexual health", "nude lipstick photos", "nude art figure drawing", "naked mole rat photos",
            "Sex Pistols gallery", "adult education video", "mature skin photos", "uncensored interview videos",
            "pornographic content moderation research", "pornography blocker", "pornography addiction recovery",
            "pornography law history", "NSFW classifier", "NSFW API reference",
            "18+5", "manhwa", "manhua", "manga", "webtoon", "mawha",
            "nude watercolor palette", "nude art sculpture", "mature trees", "erotic imagery art history",
            "top 18 manga for beginners", "read 18 comics this year", "chapter 18 manga",
            "nude art drawings", "nudity anatomy"
        ] {
            let verdict = await classifier.classify(pageText: text, wasTruncated: false)
            precondition(verdict == .safe, "Unexpected ordinary automatic text verdict for \(text): \(verdict)")
            precondition(!nativeAutomaticSearchForTesting(text), "Unexpected ordinary native automatic search: \(text)")
        }
        for text in ["18+", "18 plus", "18+ voting eligibility", "18+ travel insurance", "eighteen plus"] {
            let verdict = await classifier.classify(pageText: text, wasTruncated: false)
            precondition(verdict == .safe, "An age label in ordinary page prose is not an explicit-content ban: \(text)")
            precondition(nativeAutomaticSearchForTesting(text), "An intentional age-restricted search must block: \(text)")
        }
        for text in [
            "porn", "p.o.r.n videos", "ｐｏｒｎ", "pornvideos", "hentai manga", "nsfw photos", "cam4", "onlyfans",
            "honeytoon", "toongod", "pornographic content moderation porn videos", "pornography law hentai comics",
            "Nissan R34 porn videos", "Chapter XXX nsfw photos", "XXX Vin Diesel porn videos", "NSFW classifier hentai", "nude lipstick porn photos",
            "PОRN videos", "NАKED GIRLS", "HЕNTAI", "ОNLYFANS", "PОRNVIDEOS"
        ] {
            let verdict = await classifier.classify(pageText: text, wasTruncated: false)
            precondition(verdict == .sensitive, "Missed independent explicit automatic text for \(text): \(verdict)")
            precondition(nativeAutomaticSearchForTesting(text), "Missed independent explicit native automatic search: \(text)")
        }
        for search in ["XXX", "R34", "h3ntai", "nsfwvideos", "hentaicomics", "cam4", "onlyfans", "pornhub", "mature manhwa", "adult webtoon", "18+ videos"] {
            precondition(nativeAutomaticSearchForTesting(search), "Missed bounded native automatic search: \(search)")
        }
        for (text, expected) in [
            ("Ordinary reference material about astronomy", ContentSafetyVerdict.safe),
            ("PÓRNOGRAPHY", .sensitive),
            ("PO\u{301}RNOGRAPHY", .sensitive),
            ("😀 XXX\tVÍDEOS 👩‍🔬", .sensitive),
            ("😀 XXX\tVI\u{301}DEOS 👩‍🔬", .sensitive),
            ("😀 cafe\u{301} और सितारे 𐐀", .safe),
            ("xxx videos", .sensitive),
            ("Chapter XXX about astronomy", .safe),
            ("Pornichet travel guide", .safe),
            ("Actioncam4k camera manual", .safe),
            ("Mawha manhwa manga webtoon reading history", .safe),
            ("Pornographic content moderation research", .safe),
            ("Pornography laws and legal history", .safe),
            ("NSFW classifier API documentation", .safe),
            ("Nude lipstick photos", .safe),
            ("Nude art figure drawing", .safe),
            ("Nissan R34 repair", .safe),
            ("Rule 34 algorithm", .safe),
            ("XXX chromosome research", .safe),
            ("Adult education video", .safe),
            ("Uncensored interview video", .safe),
            ("Porntube and pornvids", .sensitive),
            ("Pornographic content moderation research plus nude photos", .sensitive),
            ("NSFW classifier documentation; pornography videos", .sensitive),
            ("Nude lipstick photos plus nude videos", .sensitive),
            ("Mature manhwa catalog", .sensitive),
            ("Adult webtoon catalog", .sensitive),
            ("Nude photos medical", .sensitive),
            ("Naked photos research", .sensitive),
            ("XXX videos education", .sensitive),
            ("Erotic videos research", .sensitive),
            ("Lewd videos health", .sensitive)
        ] {
            let verdict = await classifier.classify(pageText: text, wasTruncated: false)
            precondition(verdict == expected, "Unexpected verdict for \(text)")
        }
        let contextualPolicy = ExplicitContentTextPolicy(
            schemaVersion: 1,
            terms: (0..<20).map { "blockedterm\($0)" },
            phrases: (0..<7).map { "blocked phrase \($0)" },
            contextualRules: [.init(id: "proximity", contexts: ["alpha", "same"], markers: ["omega", "same"], maximumDistanceCharacters: 12)]
        )
        let contextual = ConservativePageTextClassifier(policy: contextualPolicy)
        for text in multilingualBlocked + multilingualAllowed {
            let verdict = await contextual.classify(pageText: text, wasTruncated: false)
            precondition(verdict == .safe, "A custom policy without multilingual labels must not block \(text)")
        }
        // Each grammatical rule also works without the bundled English
        // porn-prefix terms, and activates only for its own policy family.
        for (label, variants) in [
            ("إباحي", ["إِبَاحِيّ", "والإباحية", "إبـاحي", "إبا\u{200b}حي"]),
            ("فيديو جنسي", ["الفيديو الجنسي", "فيديوهات جنسية"]),
            ("فيلم جنسي", ["الفيلم الجنسي"]),
            ("أفلام جنسية", ["الأفلام الجنسية"]),
            ("ポルノ", ["ﾎﾟﾙﾉ", "ポルノを見る"]),
            ("порно", ["порнофильмы", "ПОРНОВИДЕО"]),
            ("порнография", ["порнографии"]),
            ("pornografía", ["pornograficas", "pornográfico"]),
            ("pornographie", ["pornographiques"]),
            ("pornografie", ["pornografie"]),
            ("pornografisch", ["pornografischen"])
        ] {
            let labelPolicy = ExplicitContentTextPolicy(
                schemaVersion: 1, terms: contextualPolicy.terms + [label], phrases: contextualPolicy.phrases, contextualRules: []
            )
            let labelClassifier = ConservativePageTextClassifier(policy: labelPolicy)
            for text in variants {
                let verdict = await labelClassifier.classify(pageText: text, wasTruncated: false)
                precondition(verdict == .sensitive, "Missed equivalent form of \(label): \(text)")
            }
            for text in multilingualAllowed {
                let verdict = await labelClassifier.classify(pageText: text, wasTruncated: false)
                precondition(verdict == .safe, "Policy label \(label) must preserve benign text: \(text)")
            }
        }
        for (text, expected) in [
            ("alpha omega", ContentSafetyVerdict.sensitive),
            ("omega alpha", .sensitive),
            ("alpha aaaaa omega", .sensitive),
            ("alpha aaaaa \u{0903} omega", .sensitive),
            ("alpha aaaaa \u{1d165} omega", .sensitive),
            ("alpha aaaaaaa omega", .safe),
            ("same", .sensitive),
            ("álpha omega", .sensitive),
            ("a\u{301}lpha omega", .sensitive),
            ("alpha 😀 omega", .sensitive),
            ("alpha 𐐀𐐀𐐀𐐀𐐀 omega", .sensitive),
            ("alpha 𐐀𐐀𐐀𐐀𐐀𐐀𐐀 omega", .safe),
            ("alphabet omega", .safe),
            (String(repeating: "alpha ", count: 2_000) + String(repeating: "x", count: 20) + " " + String(repeating: "omega ", count: 2_000), .safe),
            ("alpha " + String(repeating: "x", count: 20) + " omega alpha", .sensitive)
        ] {
            let verdict = await contextual.classify(pageText: text, wasTruncated: false)
            precondition(verdict == expected, "Unexpected contextual verdict")
        }
        let missing = await ConservativePageTextClassifier(policy: nil).classify(pageText: "", wasTruncated: false)
        precondition(missing == .unknown)
        let invalid = ExplicitContentTextPolicy(schemaVersion: 999, terms: policy.terms, phrases: policy.phrases, contextualRules: [])
        let invalidVerdict = await ConservativePageTextClassifier(policy: invalid).classify(pageText: "normal", wasTruncated: false)
        precondition(invalidVerdict == .unknown)
        print("Swift text policy regressions passed")
    }
}
