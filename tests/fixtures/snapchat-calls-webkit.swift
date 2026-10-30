import AppKit
import WebKit

struct SnapchatCallScenario: Decodable {
    struct Step: Decodable {
        let action: String?
        let condition: String?
        let width: Double?
        let height: Double?
        let snapshot: String?
    }
    let name: String
    let html: String
    let steps: [Step]
}

@MainActor final class SnapchatCallRunner: NSObject, WKNavigationDelegate {
    var continuation: CheckedContinuation<Void, Never>?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume(); continuation = nil
    }
    func snapshot(_ page: WKWebView, name: String, root: URL) async throws {
        let image = try await page.takeSnapshot(configuration: nil)
        if let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
           let png = bitmap.representation(using: .png, properties: [:]) {
            try png.write(to: root.appendingPathComponent(name + ".png"))
        }
    }
    func run() async {
        do {
            let directory = CommandLine.arguments[1]
            let root = URL(fileURLWithPath: directory)
            let scenarios = try JSONDecoder().decode([SnapchatCallScenario].self,
                from: Data(contentsOf: root.appendingPathComponent("scenarios.json")))
            let source = try String(contentsOf: root.appendingPathComponent("adapter.js"), encoding: .utf8)
            let prelude = try String(contentsOf: root.appendingPathComponent("prelude.js"), encoding: .utf8)
            for scenario in scenarios {
                let configuration = WKWebViewConfiguration()
                configuration.websiteDataStore = .nonPersistent()
                configuration.mediaTypesRequiringUserActionForPlayback = []
                configuration.userContentController.addUserScript(WKUserScript(source: prelude,
                    injectionTime: .atDocumentStart, forMainFrameOnly: true))
                configuration.userContentController.addUserScript(WKUserScript(source: source,
                    injectionTime: .atDocumentEnd, forMainFrameOnly: true))
                let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 390, height: 780), configuration: configuration)
                page.navigationDelegate = self
                let window = NSWindow(contentRect: page.bounds, styleMask: [.titled], backing: .buffered, defer: false)
                window.title = "Vigil · local Snapchat call regression"
                window.isReleasedWhenClosed = false
                window.contentView = page
                window.makeKeyAndOrderFront(nil)
                await withCheckedContinuation { continuation in
                    self.continuation = continuation
                    page.loadHTMLString(scenario.html, baseURL: URL(string: "https://www.snapchat.com/web/")!)
                }
                for (index, step) in scenario.steps.enumerated() {
                    if let width = step.width {
                        window.setContentSize(NSSize(width: width, height: step.height ?? 780))
                        page.frame.size = NSSize(width: width, height: step.height ?? 780)
                    }
                    if let action = step.action { _ = try await page.evaluateJavaScript(action + ";true") }
                    if let condition = step.condition {
                        var passed = false
                        for _ in 0..<120 {
                            if try await page.evaluateJavaScript(condition) as? Bool == true { passed = true; break }
                            try await Task.sleep(for: .milliseconds(50))
                        }
                        if !passed {
                            let diagnostic = try await page.evaluateJavaScript("JSON.stringify({call:document.querySelector('#fixture-call')?fixtureCallGeometry():null,loopback:window.loopbackResult,error:window.loopbackError,context:window.fixtureLoopback?.context.state,audio:window.fixtureLoopback?.media&&{paused:fixtureLoopback.media.paused,muted:fixtureLoopback.media.muted,defaultMuted:fixtureLoopback.media.defaultMuted},layout:document.querySelector('[data-vigil-snap-layout]')?.outerHTML.slice(0,500),snap:document.querySelector('.ecBYF')?.getBoundingClientRect().toJSON()})")
                            print("FAIL \(scenario.name) step \(index): \(condition)\n\(String(describing: diagnostic))")
                            exit(1)
                        }
                    }
                    if let name = step.snapshot { try await snapshot(page, name: name, root: root) }
                }
                if !scenario.steps.contains(where: { $0.snapshot == scenario.name }) {
                    try await snapshot(page, name: scenario.name, root: root)
                }
                print("PASS \(scenario.name)")
                page.navigationDelegate = nil
                window.close()
            }
            print("VIGIL_SNAPCHAT_CALLS_WEBKIT_COMPLETE")
            exit(0)
        } catch { print("ERROR \(error)"); exit(1) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in await SnapchatCallRunner().run() }
app.run()
