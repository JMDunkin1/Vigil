import Foundation

// Shared by the Personal Team companion and the Safari native-message handler.
// Credentials stay in native code and are never returned to the YouTube page.
enum YouTubeLimitsConnection {
    static func send(_ body: [String: Any], bundle: Bundle = .main) async -> [String: Any] {
        let managed = UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed") ?? [:]
        let resource = bundle.url(forResource: "youtube-connection", withExtension: "json")
        let data = resource.flatMap { try? Data(contentsOf: $0) }
        let connection = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: String] } ?? [:]
        let server = managed["VigilYouTubeServer"] as? String ?? connection["server"] ?? ""
        let token = managed["VigilYouTubeToken"] as? String ?? connection["token"] ?? ""
        guard var components = URLComponents(string: server),
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.scheme == "https" || (components.scheme == "http" && (host.hasSuffix(".local") || host == "localhost" || host == "127.0.0.1")),
              !token.isEmpty, !token.contains("$(") else {
            return ["ok": false, "message": "Connect to Vigil to continue watching."]
        }
        components.path = "/api/extension/youtube"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { return ["ok": false] }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 4
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "x-vigil-extension-token")
        do {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            // Do not forward the bearer credential across redirects.
            let session = URLSession(configuration: .ephemeral, delegate: NoRedirect(), delegateQueue: nil)
            defer { session.finishTasksAndInvalidate() }
            let (data, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200,
                  let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                return ["ok": false, "message": "Connect to Vigil to continue watching."]
            }
            return value
        } catch {
            return ["ok": false, "message": "Connect to Vigil to continue watching."]
        }
    }
    private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            completionHandler(nil)
        }
    }
}
