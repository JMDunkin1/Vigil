import Foundation

final class ContentBlockerRequestHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let rulesURL = Bundle.main.url(forResource: "blockerList", withExtension: "json") else {
            context.cancelRequest(withError: NSError(
                domain: "VigilYouTubeShortsBlocker",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The Shorts blocker rules are missing."]
            ))
            return
        }
        let attachment = NSItemProvider(contentsOf: rulesURL)
        let item = NSExtensionItem()
        item.attachments = attachment.map { [$0] } ?? []
        context.completeRequest(returningItems: [item])
    }
}
