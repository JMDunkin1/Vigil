import Foundation
import JavaScriptCore

// The ledger lives in this app's protected container. YouTube account data is
// reconciled by the page adapter; playback authority never needs a nearby Mac.
@MainActor
enum YouTubeLimitsConnection {
    static func send(_ body: [String: Any], bundle: Bundle = .main) async -> [String: Any] {
        do {
            guard let resource = bundle.url(forResource: "youtube-connection", withExtension: "json"),
                  let configuration = try JSONSerialization.jsonObject(with: Data(contentsOf: resource)) as? [String: Any],
                  configuration["mode"] as? String == "local",
                  let engine = configuration["engine"] as? String,
                  let context = JSContext() else { throw LedgerError.invalid }
            let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
            let path = directory.appendingPathComponent("youtube-daily-ledger.json")
            let existing = FileManager.default.fileExists(atPath: path.path)
            let state = existing ? try Data(contentsOf: path) : try JSONSerialization.data(withJSONObject: configuration["seed"] as? [String: Any] ?? [:])
            guard let object = try JSONSerialization.jsonObject(with: state) as? [String: Any],
                  !existing || object["youtubeLimits"] is [String: Any],
                  let stateText = String(data: state, encoding: .utf8),
                  let bodyText = String(data: try JSONSerialization.data(withJSONObject: body), encoding: .utf8) else { throw LedgerError.invalid }
            let uuid: @convention(block) () -> String = { UUID().uuidString }
            context.setObject(uuid, forKeyedSubscript: "__uuid" as NSString)
            context.evaluateScript(engine)
            guard context.exception == nil,
                  let encoded = context.objectForKeyedSubscript("vigilLocalAction")?.call(withArguments: [stateText, bodyText])?.toString(),
                  context.exception == nil,
                  let bytes = encoded.data(using: .utf8),
                  let result = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
                  let next = result["state"] as? [String: Any],
                  let reply = result["reply"] as? [String: Any] else { throw LedgerError.invalid }
            // Persist before granting playback. A failed write cannot grant time.
            try JSONSerialization.data(withJSONObject: next).write(to: path, options: .atomic)
            return reply
        } catch {
            return ["ok": false, "message": "Your saved YouTube limits could not be read or saved. Reopen Vigil YouTube to retry."]
        }
    }
    private enum LedgerError: Error { case invalid }
}
