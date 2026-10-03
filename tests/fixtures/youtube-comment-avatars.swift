import AppKit
import WebKit

// A bounded, owned WebKit fixture. No installed browser, phone, or remote
// website is used; even the YouTube-shaped URL is served by this process.
final class FixtureScheme: NSObject, WKURLSchemeHandler {
    let html: Data
    init(html: Data) { self.html = html }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        fputs("fixture: serving local HTML\n", stderr)
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html",
                                    expectedContentLength: html.count, textEncodingName: "utf-8"))
        task.didReceive(html)
        task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}

final class Fixture: NSObject, WKNavigationDelegate {
    let source: String
    let scheme: FixtureScheme
    let screenshotDirectory: String?
    var webView: WKWebView!
    var masked = false
    var beforeGeometry: NSArray?
    var reports: [[String: Any]] = []
    var window: NSWindow!

    init(source: String, html: Data, screenshotDirectory: String?) {
        self.source = source
        self.scheme = FixtureScheme(html: html)
        self.screenshotDirectory = screenshotDirectory
    }

    func load() {
        fputs("fixture: loading \(masked ? "masked" : "baseline")\n", stderr)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(scheme, forURLScheme: "fixture")
        if masked {
            config.userContentController.addUserScript(WKUserScript(
                source: source, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        }
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 740), configuration: config)
        webView.navigationDelegate = self
        if window == nil {
            window = NSWindow(contentRect: webView.bounds, styleMask: [.titled], backing: .buffered, defer: false)
            window.title = "Vigil · benign comment-avatar test"
            window.isReleasedWhenClosed = false
            window.center()
        }
        window.contentView = webView
        // WebKit suspends requestAnimationFrame in unattached/hidden views.
        // This is the fixture's only window; it closes when the process exits.
        window.orderFrontRegardless()
        webView.load(URLRequest(url: URL(string: "fixture://m.youtube.com/watch?v=benign-fixture")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        fputs("fixture: navigation complete\n", stderr)
        webView.evaluateJavaScript("JSON.stringify({visible: document.visibilityState, frames: !!window.initialRenderStyles, href: location.href})") { value, error in
            fputs("fixture: state \(String(describing: value)) \(String(describing: error))\n", stderr)
        }
        webView.callAsyncJavaScript("return await window.runAvatarChecks(masked);",
                                   arguments: ["masked": masked], in: nil, in: .page) { result in
            switch result {
            case .failure(let error): self.fail("JavaScript fixture failed: \(error)")
            case .success(let value):
                fputs("fixture: JavaScript report complete\n", stderr)
                guard let report = value as? [String: Any], let geometry = report["geometry"] as? NSArray else {
                    self.fail("Missing fixture report"); return
                }
                if self.masked {
                    guard self.beforeGeometry?.isEqual(geometry) == true else { self.fail("Avatar layout changed"); return }
                    guard let checks = report["checks"] as? [String: Bool], !checks.isEmpty else { self.fail("Missing checks"); return }
                    let failed = checks.filter { !$0.value }.keys.sorted()
                    if !failed.isEmpty { self.fail("Failed checks: \(failed.joined(separator: ", "))"); return }
                } else { self.beforeGeometry = geometry }
                self.reports.append(report)
                self.snapshot(report: report)
            }
        }
    }

    func snapshot(report: [String: Any]) {
        fputs("fixture: snapshot\n", stderr)
        let config = WKSnapshotConfiguration()
        config.rect = webView.bounds
        config.afterScreenUpdates = false
        webView.takeSnapshot(with: config) { image, error in
            guard let image = image, let tiff = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let sample = report["sample"] as? [String: Double] else {
                self.fail("WebKit snapshot failed: \(String(describing: error))"); return
            }
            let scale = Double(bitmap.pixelsWide) / 640
            let x = Int((sample["x"]! + sample["width"]! / 2) * scale)
            let y = Int((sample["y"]! + sample["height"]! / 2) * scale)
            guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { self.fail("No snapshot pixel"); return }
            let channels = [color.redComponent, color.greenComponent, color.blueComponent]
            if self.masked {
                // Snapshot/TIFF color conversion can vary with the display
                // profile. Compare against the identical CSS gray rendered in
                // this same image; JS separately verifies the exact CSS value.
                guard let reference = report["reference"] as? [String: Double],
                      let gray = bitmap.colorAt(
                        x: Int((reference["x"]! + reference["width"]! / 2) * scale),
                        y: Int((reference["y"]! + reference["height"]! / 2) * scale))?.usingColorSpace(.sRGB) else {
                    self.fail("Missing gray reference pixel"); return
                }
                let expected = [gray.redComponent, gray.greenComponent, gray.blueComponent]
                guard expected.allSatisfy({ $0 > 0.3 && $0 < 0.85 }),
                      abs(expected[0] - expected[1]) < 0.02, abs(expected[1] - expected[2]) < 0.02 else {
                    self.fail("Gray reference did not render"); return
                }
                for fx in [0.25, 0.5, 0.75] {
                    for fy in [0.25, 0.5, 0.75] {
                        guard let pixel = bitmap.colorAt(
                            x: Int((sample["x"]! + sample["width"]! * fx) * scale),
                            y: Int((sample["y"]! + sample["height"]! * fy) * scale))?.usingColorSpace(.sRGB) else {
                            self.fail("Missing avatar pixel"); return
                        }
                        let values = [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
                        if !zip(values, expected).allSatisfy({ abs($0.0 - $0.1) < 0.02 }) {
                            self.fail("Avatar pixels do not match gray reference: \(values)"); return
                        }
                    }
                }
            } else if color.greenComponent < 0.4 || color.redComponent > 0.1 {
                self.fail("Benign baseline image did not render: \(channels)"); return
            }
            if let directory = self.screenshotDirectory, let png = bitmap.representation(using: .png, properties: [:]) {
                do { try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent(self.masked ? "after.png" : "before.png")) }
                catch { self.fail("Cannot save fixture screenshot: \(error)"); return }
            }
            if self.masked {
                let json = try! JSONSerialization.data(withJSONObject: ["passed": true, "reports": self.reports], options: [.sortedKeys])
                print(String(data: json, encoding: .utf8)!)
                exit(0)
            }
            self.masked = true
            self.webView.navigationDelegate = nil
            self.load()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Navigation failed: \(error)") }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Navigation failed: \(error)") }
    func fail(_ message: String) { fputs(message + "\n", stderr); exit(1) }
}

guard CommandLine.arguments.count >= 3 else { fatalError("Usage: fixture guard.js fixture.html [screenshots-directory]") }
let fixture = Fixture(source: try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8),
                      html: try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[2])),
                      screenshotDirectory: CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : nil)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.main.async { fixture.load() }
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { fixture.fail("WebKit fixture timed out after 25 seconds") }
app.run()
