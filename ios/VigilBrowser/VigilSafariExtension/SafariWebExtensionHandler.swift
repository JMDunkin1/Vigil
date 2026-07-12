import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let blocklistState: Result<PhoneBlocklistIndex?, Error> = Result {
        try PhoneBlocklistIndex.loadBundled()
    }
    private static let mediaClassifier: any MediaSafetyClassifying = AppleSensitiveMediaClassifier()
    private static let textClassifier: any PageTextSafetyClassifying = ConservativePageTextClassifier()
    private static let mediaLoader: any MediaDataLoading = EphemeralMediaDataLoader()

    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let message = item.userInfo?[SFExtensionMessageKey] as? [String: Any],
              let type = message["type"] as? String else {
            Self.complete(context, response: ["error": "unsupported-message"])
            return
        }

        if type == "rules" {
            let rules = SharedFilterStore.read()
            let hostname = message["hostname"] as? String ?? ""
            let blocklist = try? Self.blocklistState.get()
            Self.complete(context, response: [
                "schemaVersion": rules.schemaVersion,
                "revision": rules.revision,
                "blockedHosts": rules.blockedHosts,
                "blockedURLFragments": rules.blockedURLFragments,
                "blockedSearchTerms": rules.blockedSearchTerms,
                "safeSearchEnabled": rules.safeSearchEnabled,
                "blockedDomain": blocklist?.matchingDomain(for: hostname) ?? "",
                "filterUnavailable": Self.blocklistState.failure != nil
            ])
            return
        }

        if type == "classifyText" {
            guard let text = message["text"] as? String, text.count <= 25_000 else {
                Self.complete(context, response: ["verdict": ContentSafetyVerdict.unknown.rawValue])
                return
            }
            let wasTruncated = message["wasTruncated"] as? Bool ?? true
            Task {
                let verdict = await Self.textClassifier.classify(pageText: text, wasTruncated: wasTruncated)
                Self.complete(context, response: ["verdict": verdict.rawValue])
            }
            return
        }

        if type == "classifyMedia" {
            let inlineData = ContentSafetyPayload.inlineMedia(from: message)
            let sourceURL = ContentSafetyPayload.sourceURL(from: message)
            Task {
                let data: Data?
                if let inlineData { data = inlineData }
                else if let sourceURL { data = await Self.mediaLoader.loadImage(from: sourceURL, maximumBytes: ContentSafetyPayload.maximumMediaBytes) }
                else { data = nil }
                let verdict: ContentSafetyVerdict
                if let data { verdict = await Self.mediaClassifier.classify(imageData: data) }
                else { verdict = .unknown }
                Self.complete(context, response: ["verdict": verdict.rawValue])
            }
            return
        }

        Self.complete(context, response: ["error": "unsupported-message"])
    }

    private static func complete(_ context: NSExtensionContext, response: [String: Any]) {
        let responseItem = NSExtensionItem()
        responseItem.userInfo = [SFExtensionMessageKey: response]
        context.completeRequest(returningItems: [responseItem])
    }
}

private extension Result {
    var failure: Failure? {
        if case let .failure(error) = self { return error }
        return nil
    }
}
