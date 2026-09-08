import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let body = item.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            context.completeRequest(returningItems: [])
            return
        }
        Task {
            let result = await YouTubeLimitsConnection.send(body)
            let response = NSExtensionItem()
            response.userInfo = [SFExtensionMessageKey: result]
            context.completeRequest(returningItems: [response])
        }
    }
}
