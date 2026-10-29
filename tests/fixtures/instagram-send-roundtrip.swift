import AppKit
import WebKit
import Foundation

struct Scenario: Decodable {
    struct Step: Decodable { let action: String?; let condition: String?; let delay: Int? }
    let name: String
    let html: String
    let path: String
    let steps: [Step]
}
@MainActor final class Runner: NSObject, WKNavigationDelegate {
    var continuation: CheckedContinuation<Void, Never>?
    var webView: WKWebView?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { continuation?.resume(); continuation = nil }
    func run() async {
        do {
            let directory = CommandLine.arguments[1]
            let scenarios = try JSONDecoder().decode([Scenario].self, from: Data(contentsOf: URL(fileURLWithPath: directory + "/scenarios.json")))
            let source = try String(contentsOfFile: directory + "/guard.js", encoding: .utf8)
                + String(contentsOfFile: directory + "/stable.js", encoding: .utf8)
            for scenario in scenarios {
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
                let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
                webView = page
                page.navigationDelegate = self
                await withCheckedContinuation { continuation in
                    self.continuation = continuation
                    page.loadHTMLString(scenario.html, baseURL: URL(string: "https://www.instagram.com" + scenario.path)!)
                }
                for (index, step) in scenario.steps.enumerated() {
                    if let action = step.action { _ = try await page.evaluateJavaScript(action + ";true;") }
                    if let delay = step.delay { try await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000) }
                    if let condition = step.condition {
                        var passed = false
                        for _ in 0..<120 {
                            if try await page.evaluateJavaScript(condition) as? Bool == true { passed = true; break }
                            try await Task.sleep(nanoseconds: 50_000_000)
                        }
                        if !passed {
                            let diagnostic = try await page.evaluateJavaScript("JSON.stringify({path:location.pathname,html:document.body.innerHTML,state:window.__vigilInstagramSharedItem?.containmentState()})")
                            print("FAIL \(scenario.name) step \(index): \(condition)\n\(String(describing: diagnostic))")
                            exit(1)
                        }
                    }
                }
                print("PASS \(scenario.name)")
                page.navigationDelegate = nil
            }
            print("VIGIL_INSTAGRAM_SEND_ROUNDTRIP_WEBKIT_COMPLETE")
            exit(0)
        } catch { print("ERROR \(error)"); exit(1) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
Task { @MainActor in
    let runner = Runner()
    await runner.run()
}
app.run()
