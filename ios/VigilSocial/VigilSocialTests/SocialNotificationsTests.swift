import XCTest
import WebKit
@testable import VigilSocial

final class SocialNotificationsTests: XCTestCase {
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
