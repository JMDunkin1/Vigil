import Foundation

@main
struct NativeTextClassifierRegression {
    static func main() async throws {
        let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
        let policy = try JSONDecoder().decode(ExplicitContentTextPolicy.self, from: data)
        let classifier = ConservativePageTextClassifier(policy: policy)
        for term in policy.terms {
            let verdict = await classifier.classify(pageText: "before \(term) after", wasTruncated: false)
            precondition(verdict == .sensitive, "Missed policy term: \(term)")
        }
        for phrase in policy.phrases {
            let verdict = await classifier.classify(pageText: "before \(phrase) after", wasTruncated: true)
            precondition(verdict == .sensitive, "Missed policy phrase: \(phrase)")
        }
        for (text, expected) in [
            ("Ordinary reference material about astronomy", ContentSafetyVerdict.safe),
            ("PÓRNOGRAPHY", .sensitive),
            ("PO\u{301}RNOGRAPHY", .sensitive),
            ("😀 XXX\tVÍDEOS 👩‍🔬", .sensitive),
            ("😀 XXX\tVI\u{301}DEOS 👩‍🔬", .sensitive),
            ("😀 cafe\u{301} और सितारे 𐐀", .safe),
            ("xxx videos", .sensitive),
            ("Chapter XXX about astronomy", .safe)
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
