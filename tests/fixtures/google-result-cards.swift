import AppKit
import WebKit
import Foundation

@MainActor final class ResultRunner: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var view: WKWebView?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let rows = message.body as? [[String: Any]] else { print("Invalid result payload"); exit(1) }
        let failures = rows.filter { $0["passed"] as? Bool != true }
        for row in failures { print("FAIL: \(row["label"] ?? "unknown")") }
        print("Google result WebKit assertions: \(rows.count - failures.count)/\(rows.count)")
        if failures.isEmpty { print("VIGIL_GOOGLE_RESULT_CARDS_COMPLETE"); exit(0) }
        exit(1)
    }
    func run() {
        do {
            let directory = CommandLine.arguments[1]
            let script = try String(contentsOfFile: directory + "/guard.js", encoding: .utf8)
            let html = try String(contentsOfFile: directory + "/fixture.html", encoding: .utf8)
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            configuration.userContentController.add(self, name: "results")
            configuration.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
            let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 1100, height: 1000), configuration: configuration)
            view = page
            page.navigationDelegate = self
            page.loadHTMLString(html, baseURL: URL(string: "https://www.google.com/search?q=manga+sites&safe=active")!)
            Task { try? await Task.sleep(nanoseconds: 30_000_000_000); print("Google result WebKit fixture timed out"); exit(1) }
        } catch { print(error); exit(1) }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { print(error); exit(1) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { print(error); exit(1) }
}
MainActor.assumeIsolated {
    let application = NSApplication.shared
    application.setActivationPolicy(.prohibited)
    let runner = ResultRunner()
    runner.run()
    application.run()
}
