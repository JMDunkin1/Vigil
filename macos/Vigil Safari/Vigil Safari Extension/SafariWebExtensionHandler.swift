import Foundation
import SafariServices

// Only the native extension sees the credential. Safari uses the running Mac
// Vigil ledger, so another browser/profile cannot create a fresh allowance.
final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    private static let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        return URLSession(configuration: configuration, delegate: NoRedirects(), delegateQueue: nil)
    }()
    func beginRequest(with context: NSExtensionContext) {
        guard let item = context.inputItems.first as? NSExtensionItem,
              let body = item.userInfo?[SFExtensionMessageKey] as? [String: Any] else {
            complete(context, ["ok": false, "message": "Invalid Vigil request."])
            return
        }
        Task {
            do {
                guard let path = Bundle.main.url(forResource: "youtube-connection", withExtension: "json"),
                      let config = try JSONSerialization.jsonObject(with: Data(contentsOf: path)) as? [String: Any],
                      let token = config["token"] as? String, token.count == 64 else {
                    throw BridgeError.configuration
                }
                let endpoint = body["action"] as? String == "browser-filter-health" ? "browser-health" : "youtube"
                var request = URLRequest(url: URL(string: "http://127.0.0.1:8789/api/extension/\(endpoint)")!)
                request.httpMethod = "POST"
                request.timeoutInterval = 4
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue(token, forHTTPHeaderField: "x-vigil-extension-token")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                let (data, response) = try await Self.session.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    throw BridgeError.unavailable
                }
                complete(context, reply)
            } catch {
                complete(context, ["ok": false, "message": "Safari cannot reach Vigil. Reconnect Vigil Safari before watching."])
            }
        }
    }
    private func complete(_ context: NSExtensionContext, _ reply: [String: Any]) {
        let response = NSExtensionItem()
        response.userInfo = [SFExtensionMessageKey: reply]
        context.completeRequest(returningItems: [response])
    }
    private enum BridgeError: Error { case configuration, unavailable }
    private final class NoRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask,
                        willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest,
                        completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
