import XCTest
import WebKit
@testable import VigilSocial

final class SocialNotificationsTests: XCTestCase {
    @MainActor
    func testOwnerContactSelectionAppliesOnceAndKeepsOtherServicesOff() async throws {
        let name = "VigilNotificationSelectionTests-" + UUID().uuidString
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        defaults.set(["youtube", "reddit"], forKey: "VigilSocial.webAlerts.services")
        let first = SocialNotifications(defaults: defaults)
        XCTAssertEqual(first.enabledServices, ["instagram", "snapchat"])
        XCTAssertEqual(Set(SocialNotifications.supportedServices), Set(SocialService.allCases))
        await first.setEnabled(false, for: .instagram)
        let next = SocialNotifications(defaults: defaults)
        XCTAssertEqual(next.enabledServices, ["snapchat"], "Later choices must not be overwritten on launch")
    }

    func testInstagramEnableLinkIsExactAndCannotSupplyDestinations() throws {
        for value in ["vigilsocial://notifications/instagram", "vigil-instagram://notifications/instagram"] {
            XCTAssertTrue(InstagramMessageAlerts.isEnableURL(try XCTUnwrap(URL(string: value))))
        }
        for value in ["https://notifications/instagram", "vigilsocial://notifications/instagram?url=https://example.com",
                      "vigilsocial://notifications/instagram#other", "vigilsocial://notifications/snapchat",
                      "vigilsocial://notifications/instagram/"] {
            XCTAssertFalse(InstagramMessageAlerts.isEnableURL(try XCTUnwrap(URL(string: value))))
        }
    }

    @MainActor
    func testInstagramMessageBaselineIsIsolatedFromThePage() async throws {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.loadHTMLString("<html><body>Inbox fixture</body></html>", baseURL: SocialNotifications.instagramInboxURL)
        // Do not mistake the initial blank document for the completed fixture.
        try await waitForAlertCondition("document.readyState === 'complete' && document.body?.textContent === 'Inbox fixture'", in: webView)
        _ = try await webView.callAsyncJavaScript(#"""
            Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
            globalThis.fixtureTime = 1800000000000;
            globalThis.fixtureItems = [];
            Date.now = () => globalThis.fixtureTime;
            globalThis.fetch = async url => {
              const response = new Response(JSON.stringify({status:'ok',inbox:{threads:[{
                thread_id:'thread',viewer_id:100,muted:false,pending:false,items:globalThis.fixtureItems
              }]}}), {status:200,headers:{'content-type':'application/json'}});
              Object.defineProperty(response, 'url', {value:url});
              return response;
            };
            return true;
            """#, arguments: [:], in: nil, contentWorld: .defaultClient)
        // loadHTMLString keeps an about:blank location on this WebKit runtime.
        // This isolated fixture tests the baseline, without a live account or
        // network navigation. Supply its location lexically, not in production.
        let fixtureScript = "const location = {protocol:'https:',hostname:'www.instagram.com',origin:'https://www.instagram.com'};\n"
            + InstagramMessageAlerts.inboxScript
        let initial = try await webView.callAsyncJavaScript(fixtureScript,
            arguments: ["generation": "first"], in: nil, contentWorld: .defaultClient) as? [String: Any]
        XCTAssertEqual(initial?["status"] as? String, "ready")
        XCTAssertEqual(initial?["hasMessage"] as? Bool, false)
        _ = try await webView.callAsyncJavaScript(#"""
            globalThis.fixtureTime += 1000;
            globalThis.fixtureItems = [{item_id:'new',user_id:200,item_type:'text',text:'Private text',
                timestamp:String(BigInt(Date.now())*1000n)}];
            return true;
            """#, arguments: [:], in: nil, contentWorld: .defaultClient)
        let incoming = try await webView.callAsyncJavaScript(fixtureScript,
            arguments: ["generation": "first"], in: nil, contentWorld: .defaultClient) as? [String: Any]
        XCTAssertEqual(incoming?["hasMessage"] as? Bool, true)
        XCTAssertEqual(Set(incoming?.keys.map { $0 } ?? []), ["status", "hasMessage"])
        let isolated = try await webView.evaluateJavaScript("globalThis.__vigilInstagramMessageBaseline === undefined") as? Bool
        XCTAssertEqual(isolated, true)
        let resumed = try await webView.callAsyncJavaScript(fixtureScript,
            arguments: ["generation": "resumed"], in: nil, contentWorld: .defaultClient) as? [String: Any]
        XCTAssertEqual(resumed?["hasMessage"] as? Bool, false)
    }

    @MainActor
    func testWebAlertPermissionSurvivesDocumentRecreationAndPreservesOtherScripts() async throws {
        let controller = WKUserContentController()
        let capture = WebAlertActivityCapture()
        controller.add(capture, name: "vigilWebActivity")
        controller.addUserScript(WKUserScript(source: "window.otherSafetyScriptRan = true;",
                                            injectionTime: .atDocumentStart, forMainFrameOnly: false))
        let permissionScript = WKUserScript(source: SocialMessageNotificationBridge.script(allowed: false),
                                            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(permissionScript)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = controller
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let session = WeakNotificationSession(webView: webView, service: .snapchat, permissionScript: permissionScript)

        try await loadAlertDocument(1, in: webView)
        let disabled = try await webView.evaluateJavaScript("window.permissionAtDocumentStart") as? String
        XCTAssertEqual(disabled, "denied")
        XCTAssertEqual(capture.count, 0)

        session.updatePermission(true)
        try await waitForAlertCondition("Notification.permission === 'granted'", in: webView)
        _ = try await webView.evaluateJavaScript("new Notification('Current document'); true;")
        try await waitForActivityCount(1, capture: capture)

        try await loadAlertDocument(2, in: webView)
        let enabled = try await webView.evaluateJavaScript("window.permissionAtDocumentStart") as? String
        XCTAssertEqual(enabled, "granted")
        try await waitForActivityCount(2, capture: capture)
        let safetyRan = try await webView.evaluateJavaScript("window.otherSafetyScriptRan") as? Bool
        XCTAssertEqual(safetyRan, true)
        XCTAssertEqual(controller.userScripts.count, 2)

        session.updatePermission(false)
        try await waitForAlertCondition("Notification.permission === 'denied'", in: webView)
        _ = try await webView.evaluateJavaScript("new Notification('Disabled current document'); true;")
        try await loadAlertDocument(3, in: webView)
        let disabledAgain = try await webView.evaluateJavaScript("window.permissionAtDocumentStart") as? String
        XCTAssertEqual(disabledAgain, "denied")
        XCTAssertEqual(capture.count, 2)
        XCTAssertEqual(controller.userScripts.count, 2)
    }

    @MainActor
    private func loadAlertDocument(_ number: Int, in webView: WKWebView) async throws {
        webView.loadHTMLString("""
            <html><body><script>
              window.permissionAtDocumentStart = Notification.permission;
              new Notification('Document activity');
              window.alertDocumentNumber = \(number);
            </script></body></html>
            """, baseURL: SocialService.snapchat.homeURL)
        try await waitForAlertCondition("window.alertDocumentNumber === \(number)", in: webView)
    }

    @MainActor
    private func waitForAlertCondition(_ condition: String, in webView: WKWebView) async throws {
        for _ in 0..<100 {
            if (try? await webView.evaluateJavaScript(condition)) as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Web alert condition did not become true: \(condition)")
    }

    @MainActor
    private func waitForActivityCount(_ count: Int, capture: WebAlertActivityCapture) async throws {
        for _ in 0..<100 {
            if capture.count == count { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Expected \(count) web activity messages, received \(capture.count)")
    }

    private func date(_ string: String) -> Date { ISO8601DateFormatter().date(from: string)! }
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "America/New_York")!
        return calendar
    }

    func testOvernightRemindersUseStartingWeekdayAndKeepAnActiveEnd() {
        let routine = SocialRoutine(name: "Private schedule name", services: [.x], weekdays: [2], startMinute: 22 * 60, endMinute: 7 * 60)
        let now = date("2026-10-06T03:00:00Z") // Monday 11pm, already active.
        let plan = SocialReminderPlan.items(routines: [routine], sleepUntil: nil, postingUntil: nil, now: now, calendar: calendar)
        XCTAssertEqual(plan.first?.date, date("2026-10-06T11:00:00Z"))
        XCTAssertEqual(plan.first?.title, "Routine ended")
        XCTAssertTrue(plan.allSatisfy { $0.date > now })
        XCTAssertTrue(plan.allSatisfy { !$0.body.contains(routine.name) })
    }

    func testNearestSleepAndPostingDeadlinesRemainInsideIOSPendingLimit() {
        let now = date("2026-10-05T10:00:00Z")
        let routines = (0..<12).map { index in
            SocialRoutine(name: "\(index)", services: [.reddit], weekdays: Set(1...7), startMinute: 9 * 60, endMinute: 17 * 60)
        }
        let plan = SocialReminderPlan.items(routines: routines, sleepUntil: now.addingTimeInterval(300),
                                            postingUntil: now.addingTimeInterval(600), now: now, calendar: calendar)
        XCTAssertEqual(plan.count, 60)
        XCTAssertEqual(plan.prefix(2).map(\.id), ["sleep-end", "posting-end"])
        XCTAssertEqual(Set(plan.map(\.id)).count, plan.count)
    }

    func testDSTReminderEndMatchesTheSameEnforcementInterval() throws {
        let now = date("2026-11-01T04:30:00Z")
        let routine = SocialRoutine(name: "Sunday", services: [.facebook], weekdays: [1], startMinute: 90, endMinute: 150)
        let plan = SocialReminderPlan.items(routines: [routine], sleepUntil: nil, postingUntil: nil, now: now, calendar: calendar)
        let start = try XCTUnwrap(plan.first { $0.title == "Routine started" })
        let end = try XCTUnwrap(plan.first { $0.title == "Routine ended" })
        let active = try XCTUnwrap(routine.activeInterval(at: start.date.addingTimeInterval(1), calendar: calendar))
        XCTAssertEqual(end.date, active.end)
        XCTAssertEqual(end.date.timeIntervalSince(start.date), 2 * 3600)
    }
}

@MainActor
private final class WebAlertActivityCapture: NSObject, WKScriptMessageHandler {
    private(set) var count = 0
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        count += 1
    }
}
