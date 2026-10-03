import AppKit
import WebKit

final class Scheme: NSObject, WKURLSchemeHandler {
    let html: Data
    init(_ html: Data) { self.html = html }
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        task.didReceive(URLResponse(url: task.request.url!, mimeType: "text/html", expectedContentLength: html.count, textEncodingName: "utf-8"))
        task.didReceive(html); task.didFinish()
    }
    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
final class Fixture: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    var webView: WKWebView!
    var window: NSWindow!
    let scheme: Scheme
    let start: String
    let end: String
    init(start: String, end: String, html: Data) { self.start = start; self.end = end; self.scheme = Scheme(html) }
    func run() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.setURLSchemeHandler(scheme, forURLScheme: "fixture")
        config.userContentController.add(self, name: "vigil")
        config.userContentController.addUserScript(WKUserScript(source: start, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        config.userContentController.addUserScript(WKUserScript(source: end, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
        webView = WKWebView(frame: NSRect(x:0,y:0,width:390,height:844), configuration:config)
        webView.navigationDelegate = self
        window = NSWindow(contentRect:webView.bounds, styleMask:[.titled], backing:.buffered, defer:false)
        window.title = "Vigil benign scrolling regression fixture"
        window.contentView = webView; window.orderFrontRegardless()
        webView.load(URLRequest(url:URL(string:"fixture://m.youtube.com/watch?v=benign-test")!))
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String:Any], body["type"] as? String == "pageText",
              let document = body["documentID"] as? String, let revision = body["revision"] as? String else { return }
        webView.callAsyncJavaScript("window.__vigilResolvePageText(document,revision,'safe');", arguments:["document":document,"revision":revision], in:message.frameInfo, in:.page) { _ in }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.callAsyncJavaScript("return await window.runChecks();", arguments:[:], in:nil, in:.page) { result in
            switch result {
            case .failure(let error): self.fail("Fixture failed: \(error)")
            case .success(let report):
                guard let report = report as? [String:Any] else { self.fail("No report"); return }
                print(String(data:try! JSONSerialization.data(withJSONObject:report,options:[.sortedKeys]),encoding:.utf8)!)
                let checks = ["scrollStable","anchorStable","commentNodesRetained","closedAllowanceRetained","safetyStyleRetained"]
                let passed = checks.allSatisfy { report[$0] as? Bool == true } && report["globalInvalidations"] as? Int == 0
                exit(passed ? 0 : 1)
            }
        }
    }
    func fail(_ message:String) { fputs(message+"\n",stderr); exit(1) }
}
let arguments = CommandLine.arguments
let fixture = Fixture(start:try String(contentsOfFile:arguments[1],encoding:.utf8), end:try String(contentsOfFile:arguments[2],encoding:.utf8), html:try Data(contentsOf:URL(fileURLWithPath:arguments[3])))
let app = NSApplication.shared; app.setActivationPolicy(.accessory)
DispatchQueue.main.async { fixture.run() }
DispatchQueue.main.asyncAfter(deadline:.now()+15) { fixture.fail("Fixture exceeded 15-second bound") }
app.run()
