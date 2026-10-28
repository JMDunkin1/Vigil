import Foundation
import JavaScriptCore

// The ledger lives in this app's protected container. YouTube account data is
// reconciled by the page adapter. A prepared shared authority is opt-in and
// is contacted directly by both the app and Safari, without a nearby Mac.
@MainActor
enum YouTubeLimitsConnection {
    private static var cachedRuntime: (resource: URL, configuration: [String: Any], context: JSContext)?
    // Reuse connections for frequent shared-ledger requests in both the app and
    // Safari extension, while keeping every reply live and credentials isolated.
    static func sharedSessionConfiguration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCredentialStorage = nil
        return configuration
    }
    private static let sharedSession = URLSession(configuration: sharedSessionConfiguration(),
                                                 delegate: SharedRedirectGuard(), delegateQueue: nil)

    private static func runtime(bundle: Bundle) throws -> (configuration: [String: Any], context: JSContext) {
        guard let resource = bundle.url(forResource: "youtube-connection", withExtension: "json") else { throw LedgerError.invalid }
        if let cached = cachedRuntime, cached.resource == resource {
            return (cached.configuration, cached.context)
        }
        guard let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: resource)) as? [String: Any],
              configuration["mode"] as? String == "local",
              let engine = configuration["engine"] as? String,
              let context = JSContext() else { throw LedgerError.invalid }
        let uuid: @convention(block) () -> String = { UUID().uuidString }
        context.setObject(uuid, forKeyedSubscript: "__uuid" as NSString)
        context.evaluateScript(engine)
        guard context.exception == nil else { throw LedgerError.invalid }
        // MainActor serializes access. Retain one engine, never a cached ledger.
        cachedRuntime = (resource, configuration, context)
        return (configuration, context)
    }

    static func send(_ body: [String: Any], bundle: Bundle = .main) async -> [String: Any] {
        do {
            let (configuration, _) = try runtime(bundle: bundle)
            let authority = try authorityPath()
            if FileManager.default.fileExists(atPath: authority.path) {
                let pinned = try String(contentsOf: authority, encoding: .utf8)
                guard let shared = configuration["shared"] as? [String: Any], shared["endpoint"] as? String == pinned else { throw LedgerError.invalid }
            }
            if configuration["shared"] != nil {
                guard let shared = configuration["shared"] as? [String: Any],
                      let endpoint = shared["endpoint"] as? String, let url = URL(string: endpoint),
                      url.scheme == "https", url.host?.isEmpty == false, url.user == nil, url.password == nil,
                      url.query == nil, url.fragment == nil, url.path == "/api/youtube",
                      let token = shared["token"] as? String,
                      token.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw LedgerError.invalid }
                if !FileManager.default.fileExists(atPath: authority.path) {
                    try endpoint.write(to: authority, atomically: true, encoding: .utf8)
                }
                var request = URLRequest(url: url, timeoutInterval: 4)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                request.httpBody = try JSONSerialization.data(withJSONObject: body)
                // No cookies, caches, or redirects to a different credential recipient.
                let (data, response) = try await sharedSession.data(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200,
                      let reply = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      reply["ok"] is Bool, let slots = reply["slots"] as? [Any], slots.count == 4,
                      reply["day"] is String, reply["serverTime"] is NSNumber,
                      reply["usedMs"] is NSNumber, reply["grace"] is [String: Any] else { throw LedgerError.invalid }
                return reply
            }
            return perform(body, bundle: bundle)
        } catch {
            return ["ok": false, "message": "The shared YouTube allowance is unavailable. Try again when connected."]
        }
    }

    // Seed document-start feed filtering from the same protected ledger used
    // by the bridge, before YouTube can choose a different renderer cache.
    static func statusSnapshot(bundle: Bundle = .main) -> [String: Any] {
        let pinned = (try? authorityPath()).map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        if pinned || ((try? runtime(bundle: bundle).configuration["shared"]) != nil) {
            return ["ok": false, "message": "Checking shared YouTube allowance…"]
        }
        return perform(["action": "status"], bundle: bundle)
    }

    private static func authorityPath() throws -> URL {
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        return directory.appendingPathComponent("youtube-shared-authority.txt")
    }

    private static func perform(_ body: [String: Any], bundle: Bundle) -> [String: Any] {
        do {
            let (configuration, context) = try runtime(bundle: bundle)
            context.exception = nil
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let path = directory.appendingPathComponent("youtube-daily-ledger.json")
            let existing = FileManager.default.fileExists(atPath: path.path)
            let state = existing ? try Data(contentsOf: path) : try JSONSerialization.data(withJSONObject: configuration["seed"] as? [String: Any] ?? [:])
            guard let object = try JSONSerialization.jsonObject(with: state) as? [String: Any],
                  !existing || object["youtubeLimits"] is [String: Any],
                  let stateText = String(data: state, encoding: .utf8),
                  let bodyText = String(data: try JSONSerialization.data(withJSONObject: body), encoding: .utf8) else { throw LedgerError.invalid }
            guard context.exception == nil,
                  let encoded = context.objectForKeyedSubscript("vigilLocalAction")?.call(withArguments: [stateText, bodyText])?.toString(),
                  context.exception == nil,
                  let bytes = encoded.data(using: .utf8),
                  let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let next = result["state"] as? [String: Any],
                  let reply = result["reply"] as? [String: Any] else { throw LedgerError.invalid }
            // Persist before granting playback. A failed write cannot grant time.
            if !existing || !NSDictionary(dictionary: object).isEqual(to: next) {
                try JSONSerialization.data(withJSONObject: next).write(to: path, options: .atomic)
            }
            return reply
        } catch {
            cachedRuntime = nil
            return ["ok": false, "message": "Your saved YouTube limits could not be read or saved. Reopen Vigil YouTube to retry."]
        }
    }
    private enum LedgerError: Error { case invalid }
}

private final class SharedRedirectGuard: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
