import AppKit
import WebKit

// Owned, network-free WebKit fixture. Both authority and media are local;
// no installed Vigil process, browser session, phone, or policy is changed.
@MainActor final class PlayerReplacementFixture: NSObject, WKNavigationDelegate {
    var loaded: CheckedContinuation<Void, Never>?
    var window: NSWindow?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?.resume(); loaded = nil
    }
    func check(_ page: WKWebView, _ expression: String, _ label: String) async throws {
        guard try await page.evaluateJavaScript(expression) as? Bool == true else {
            throw NSError(domain: "PlayerReplacementFixture", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: label])
        }
    }
    func until(_ page: WKWebView, _ expression: String, _ label: String) async throws {
        for _ in 0..<100 {
            if try await page.evaluateJavaScript(expression) as? Bool == true { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw NSError(domain: "PlayerReplacementFixture", code: 2,
                      userInfo: [NSLocalizedDescriptionKey: "Timed out: \(label)"])
    }
    func run() async {
        do {
            let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
            let engine = try String(contentsOfFile: CommandLine.arguments[2], encoding: .utf8)
            let media = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[3])).base64EncodedString()
            let config = WKWebViewConfiguration()
            config.websiteDataStore = .nonPersistent()
            config.mediaTypesRequiringUserActionForPlayback = []
            let page = WKWebView(frame: NSRect(x: 0, y: 0, width: 640, height: 480), configuration: config)
            page.navigationDelegate = self
            let host = NSWindow(contentRect: page.bounds, styleMask: [.titled], backing: .buffered, defer: false)
            host.title = "Vigil · local YouTube player replacement check"
            host.contentView = page; window = host
            host.orderFrontRegardless()
            let html = """
            <!doctype html><html><head><style>
            video{width:320px;height:180px}ytd-video-preview{display:none}
            </style></head><body>
            <ytd-video-preview><video id="preview"></video></ytd-video-preview>
            <ytd-player><div id="movie_player"><video id="watch" muted playsinline loop></video></div></ytd-player>
            </body></html>
            """
            await withCheckedContinuation { loaded = $0; page.loadHTMLString(html, baseURL: URL(string: "https://m.youtube.com/watch?v=video000000")!) }
            _ = try await page.evaluateJavaScript("""
            let fixtureSequence=0;function __uuid(){return 'fixture-'+(++fixtureSequence);}
            \(engine)
            window.fixtureLedger='{}';
            const initial=JSON.parse(vigilLocalAction(fixtureLedger,JSON.stringify({action:'save',videoId:'video000000'})));
            fixtureLedger=JSON.stringify(initial.state);
            window.browser={runtime:{sendMessage:async message=>{
              const result=JSON.parse(vigilLocalAction(fixtureLedger,JSON.stringify(message.youtube)));
              fixtureLedger=JSON.stringify(result.state);return result.reply;
            }}};
            window.fixtureSource='data:video/mp4;base64,\(media)';
            document.getElementById('watch').src=fixtureSource;
            window.fetch=async()=>new Response('ytcfg.set({"LOGGED_IN":true,"DATASYNC_ID":"fixture-account"});var ytInitialData={"contents":{"playlistVideoListRenderer":{"playlistId":"WL","contents":[{"playlistVideoRenderer":{"videoId":"video000000","title":{"simpleText":"Local clip"}}}]}}};');
            true;
            """)
            // Expose only the user-intent entry point to this owned fixture;
            // playback must still acquire the real policy engine's lease.
            let testedSource = source.replacingOccurrences(of: "  if (document.documentElement) clean();",
                with: "  window.fixtureTogglePlayback = togglePlayback;\n  if (document.documentElement) clean();")
            _ = try await page.evaluateJavaScript(testedSource + ";true;")
            try await until(page, "document.getElementById('watch').readyState>=2", "local clip ready")
            _ = try await page.evaluateJavaScript("fixtureTogglePlayback();true;")
            try await until(page, "!document.getElementById('watch').paused", "explicit Play")
            try await check(page, "document.getElementById('preview').paused", "hidden preview remains stopped")
            try await Task.sleep(nanoseconds: 300_000_000)
            _ = try await page.evaluateJavaScript("""
            window.fixtureLease=JSON.parse(fixtureLedger).youtubeLimits.lease.id;
            window.retired=document.getElementById('watch');
            const replacement=document.createElement('video');replacement.id='watch';replacement.muted=true;replacement.playsInline=true;replacement.loop=true;
            replacement.src=fixtureSource;retired.replaceWith(replacement);true;
            """)
            try await until(page, "retired.paused&&!document.getElementById('watch').paused", "replacement plays and old audio stops")
            try await check(page, "JSON.parse(fixtureLedger).youtubeLimits.lease.id===fixtureLease", "same bounded authorization")
            try await until(page, "document.getElementById('watch').getVideoPlaybackQuality().totalVideoFrames>3", "moving replacement frames")
            _ = try await page.evaluateJavaScript("retired.play().catch(()=>{});true;")
            try await until(page, "retired.paused", "detached replay remains stopped")
            try await check(page, "!document.getElementById('watch').paused", "visible player keeps playing")
            _ = try await page.evaluateJavaScript("fixtureTogglePlayback();true;")
            try await until(page, "document.getElementById('watch').paused", "Pause reaches replacement")
            _ = try await page.evaluateJavaScript("""
            window.secondRetired=document.getElementById('watch');
            const next=document.createElement('video');next.id='watch';next.muted=true;next.playsInline=true;next.src=fixtureSource;
            secondRetired.replaceWith(next);true;
            """)
            try await Task.sleep(nanoseconds: 600_000_000)
            try await check(page, "document.getElementById('watch').paused&&retired.paused&&secondRetired.paused", "replacement cannot undo Pause")
            print("PASS native WebKit: replacement frames advance, removed audio stops, late replay is blocked, and Pause is retained.")
            host.orderOut(nil)
            exit(0)
        } catch { print("FAIL native WebKit player replacement: \(error)"); exit(1) }
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in await PlayerReplacementFixture().run() }
Task { try? await Task.sleep(nanoseconds: 35_000_000_000); print("FAIL native WebKit fixture timeout"); exit(1) }
app.run()
