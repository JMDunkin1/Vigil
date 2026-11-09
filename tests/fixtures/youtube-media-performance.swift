import AppKit
import WebKit
import Foundation
@MainActor final class Runner: NSObject, WKNavigationDelegate {
    var loaded: CheckedContinuation<Void, Never>?
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { loaded?.resume(); loaded = nil }
    func check(_ page: WKWebView, _ expression: String, _ label: String) async throws {
        guard try await page.evaluateJavaScript(expression) as? Bool == true else { print("FAIL \(label)"); exit(1) }
    }
    func run() async {
        do {
            let source = try String(contentsOfFile: CommandLine.arguments[1], encoding: .utf8)
                .replacingOccurrences(of: "function containsContextualExplicitMedia(value) {", with: "function containsContextualExplicitMedia(value) { window.metrics.matches++;")
            for host in ["www.youtube.com", "m.youtube.com"] {
                let config = WKWebViewConfiguration()
                config.websiteDataStore = .nonPersistent()
                let page = WKWebView(frame: NSRect(x:0,y:0,width:host.hasPrefix("m.") ? 390 : 1400,height:900), configuration:config)
                page.navigationDelegate = self
                await withCheckedContinuation { loaded = $0; page.loadHTMLString("<!doctype html><title>YouTube</title><main><div id='player'><video></video><span id='clock'>0:00</span></div><form><input id='search'></form><section id='feed'></section></main>", baseURL:URL(string:"https://\(host)/watch?v=abcdefghijk")!) }
                _ = try await page.evaluateJavaScript("""
                document.getElementById('feed').innerHTML=Array.from({length:100},(_,i)=>'<article><a href="/watch?v=video'+i+'"><img src="data:," alt="Astronomy tutorial '+i+'"><h3>The science of stars '+i+'</h3></a>'+Array.from({length:30},(_,j)=>'<div><span>Channel '+i+' episode '+j+'</span></div>').join('')+'</article>').join('');
                window.metrics={matches:0,fullScans:0};
                for(const owner of [Document.prototype,Element.prototype]){const original=owner.querySelectorAll;owner.querySelectorAll=function(s){if(s==='*'&&(this===document||this===document.documentElement||this===document.body))metrics.fullScans++;return original.call(this,s);};}
                window.setInterval=callback=>{window.healthHeartbeat=callback;return 1;};window.siteClicks=0;document.addEventListener('click',e=>{e.preventDefault();siteClicks++;});true;
                """)
                _ = try await page.evaluateJavaScript(source + ";true;")
                _ = try await page.evaluateJavaScript("document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));true;")
                let sample = try await page.evaluateJavaScript("(()=>{metrics={matches:0,fullScans:0};const start=performance.now();for(let i=0;i<5;i++)dispatchEvent(new Event('focus'));return JSON.stringify({...metrics,ms:performance.now()-start});})()")
                print("\(host) health sample: \(String(describing: sample))")
                try await check(page, "metrics.matches<1000&&metrics.fullScans===5", "unchanged classifications and full health inspections")
                _ = try await page.evaluateJavaScript("""
                metrics={matches:0,fullScans:0};for(let i=0;i<60;i++){document.getElementById('clock').style.transform='translateX('+i+'px)';document.getElementById('clock').firstChild.data='0:'+i;document.getElementById('player').className='state-'+i;}for(let i=0;i<30;i++)document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true,cancelable:true}));true;
                """)
                try await check(page, "metrics.fullScans===0&&metrics.matches<50", "player changes and typing stay scoped")
                _ = try await page.evaluateJavaScript("""
                document.getElementById('feed').insertAdjacentHTML('afterend','<article id="unsafe"><a href="/watch?v=other"><img src="data:,"><h3>Stars</h3></a></article>');document.querySelector('#unsafe h3').textContent='NSFW videos';document.querySelector('#unsafe a').click();true;
                """)
                try await check(page, "siteClicks===0&&getComputedStyle(document.getElementById('unsafe')).display==='none'", "immediate changed-content blocking")
                _ = try await page.evaluateJavaScript("""
                document.getElementById('feed').insertAdjacentHTML('afterend',
                  '<span id="preference-label">Captions</span><button id="preference" aria-labelledby="preference-label"></button>'
                  +'<label id="external-label" for="external-input">Captions</label><input id="external-input" type="checkbox">'
                  +'<article id="split"><a href="/watch?v=split"><span>Cream</span><span> recipe</span></a><video></video></article>'
                  +'<article id="attribute"><img src="data:," alt="Stars"></article><div id="shadow-host"></div>');
                document.getElementById('preference-label').firstChild.data='Show sensitive media';
                document.getElementById('external-label').firstChild.data='Show sensitive media';
                document.querySelector('#split span:last-child').firstChild.data=' pie videos';
                document.querySelector('#attribute img').setAttribute('alt','NSFW videos');
                document.getElementById('shadow-host').attachShadow({mode:'open'}).innerHTML='<article id="shadow-unsafe">NSFW videos<video></video></article><article id="shadow-safe">Stars</article>';
                document.querySelector('#split a').click();
                true;
                """)
                // A key event drains pending observer records before checking visibility.
                _ = try await page.evaluateJavaScript("document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));true;")
                try await check(page, "siteClicks===0&&['preference','external-input','split','attribute'].every(id=>getComputedStyle(document.getElementById(id)).display==='none')", "accessible labels, split titles and changed attributes")
                try await check(page, "['shadow-unsafe','shadow-safe'].map(id=>getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById(id)).display==='none').join(',')==='true,false'", "new shadow roots retain both inspectors")
                _ = try await page.evaluateJavaScript("document.getElementById('shadow-host').shadowRoot.getElementById('shadow-safe').textContent='NSFW videos';healthHeartbeat();true;")
                try await check(page, "getComputedStyle(document.getElementById('shadow-host').shadowRoot.getElementById('shadow-safe')).display==='none'", "changed shadow content and full periodic inspection")
                try await check(page, "getComputedStyle(document.getElementById('feed').firstElementChild).display==='block'", "ordinary neighboring content remains available")
                print("PASS \(host) native WebKit performance and enforcement")
            }
            exit(0)
        } catch { print("ERROR \(error)"); exit(1) }
    }
}
let app=NSApplication.shared
app.setActivationPolicy(.accessory)
Task { @MainActor in await Runner().run() }
app.run()
