import Combine
import SwiftUI
import UserNotifications
import WebKit

// Local delivery needs no APNs entitlement, provider server, or paid team.
// Web events can only be observed while iOS is running the opened web session.
@MainActor
final class SocialNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = SocialNotifications()
    static let supportedServices: [SocialService] = [.snapchat, .linkedin, .facebook, .x, .tiktok, .reddit]
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var enabledServices: Set<String>
    @Published private(set) var error: String?
    private var lastDelivery: [String: Date] = [:]
    private let center: UNUserNotificationCenter
    private let defaults: UserDefaults
    private var webSessions: [WeakNotificationSession] = []
    private weak var preferences: SocialPreferences?
    private var reminderRescheduleTask: Task<Void, Never>?
    var openService: ((SocialService) -> Void)?

    init(center: UNUserNotificationCenter = .current(), defaults: UserDefaults = .standard) {
        self.center = center
        self.defaults = defaults
        enabledServices = Set(defaults.stringArray(forKey: "VigilSocial.webAlerts.services") ?? [])
        super.init()
        center.delegate = self
        Task { await refreshAuthorization() }
    }

    var isAuthorized: Bool { authorization == .authorized || authorization == .provisional || authorization == .ephemeral }
    func enabled(for service: SocialService) -> Bool {
        Self.supportedServices.contains(service) && enabledServices.contains(service.rawValue) && isAuthorized
    }

    func setEnabled(_ enabled: Bool, for service: SocialService) async {
        guard Self.supportedServices.contains(service) else { return }
        if enabled {
            do {
                let allowed = try await center.requestAuthorization(options: [.alert, .sound])
                await refreshAuthorization()
                guard allowed else { error = "Allow Vigil notifications in iPhone Settings to enable alerts."; return }
                enabledServices.insert(service.rawValue)
            } catch { self.error = "Notifications could not be enabled. Try again in iPhone Settings."; return }
        } else { enabledServices.remove(service.rawValue) }
        defaults.set(Array(enabledServices).sorted(), forKey: "VigilSocial.webAlerts.services")
        error = nil
        refreshWebPermissions()
        if let preferences { rescheduleReminders(preferences: preferences) }
    }

    func authorizeReminders() async {
        do {
            let allowed = try await center.requestAuthorization(options: [.alert, .sound])
            await refreshAuthorization()
            error = allowed ? nil : "Allow Vigil notifications in iPhone Settings to enable reminders."
        } catch { self.error = "Notifications could not be enabled. Try again in iPhone Settings." }
    }

    func refreshAuthorization() async {
        authorization = await center.notificationSettings().authorizationStatus
        refreshWebPermissions()
        if let preferences { rescheduleReminders(preferences: preferences) }
    }

    func register(_ webView: WKWebView, for service: SocialService, permissionScript: WKUserScript) {
        webSessions.removeAll { $0.webView == nil || $0.webView === webView }
        webSessions.append(WeakNotificationSession(webView: webView, service: service, permissionScript: permissionScript))
    }

    private func refreshWebPermissions() {
        webSessions.removeAll { $0.webView == nil }
        for session in webSessions {
            session.updatePermission(enabled(for: session.service))
        }
    }

    func deliverWebActivity(for service: SocialService, sessionID: String) {
        guard enabled(for: service), UIApplication.shared.applicationState == .active else { return }
        let key = service.rawValue + ":" + sessionID
        let now = Date()
        guard now.timeIntervalSince(lastDelivery[key] ?? .distantPast) >= 10 else { return }
        lastDelivery[key] = now
        let content = UNMutableNotificationContent()
        content.title = service.displayName
        // Message text/media stay inside the filtered session. Never reflect
        // unclassified page text or a site-supplied URL onto the Lock Screen.
        content.body = "New activity in your opened Vigil session."
        content.sound = .default
        content.userInfo = ["vigilService": service.rawValue]
        center.add(UNNotificationRequest(identifier: "vigil-web-" + key, content: content, trigger: nil))
    }

    func scheduleReminder(id: String, title: String, body: String, at date: Date) {
        guard isAuthorized, date > Date() else { return }
        let content = UNMutableNotificationContent()
        content.title = title; content.body = body; content.sound = .default
        let components = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let trigger = UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
        center.add(UNNotificationRequest(identifier: "vigil-reminder-" + id, content: content, trigger: trigger))
    }

    func rescheduleReminders(preferences: SocialPreferences, at now: Date = Date()) {
        self.preferences = preferences
        let plan = SocialReminderPlan.items(routines: preferences.routines, sleepUntil: preferences.sleepRestriction(at: now)?.until,
                                            postingUntil: preferences.postingUntil, now: now)
        reminderRescheduleTask?.cancel()
        reminderRescheduleTask = Task {
            let pending = await center.pendingNotificationRequests()
            guard !Task.isCancelled else { return }
            center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier).filter { $0.hasPrefix("vigil-reminder-") })
            guard isAuthorized, !preferences.savedScheduleUnreadable else { return }
            for item in plan {
                guard !Task.isCancelled else { return }
                let content = UNMutableNotificationContent()
                content.title = item.title; content.body = item.body; content.sound = .default
                let components = Calendar.autoupdatingCurrent.dateComponents([.year, .month, .day, .hour, .minute, .second], from: item.date)
                let request = UNNotificationRequest(identifier: "vigil-reminder-" + item.id, content: content,
                    trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false))
                do { try await center.add(request) }
                catch { self.error = "Some reminders could not be scheduled. Your pauses remain active." }
            }
        }
    }

    func removeReminders(prefix: String) {
        Task {
            let requests = await center.pendingNotificationRequests()
            center.removePendingNotificationRequests(withIdentifiers: requests.map(\.identifier).filter { $0.hasPrefix("vigil-reminder-" + prefix) })
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                          withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                          withCompletionHandler completionHandler: @escaping () -> Void) {
        let rawValue = response.notification.request.content.userInfo["vigilService"] as? String
        Task { @MainActor [weak self] in
            if let rawValue, let service = SocialService(rawValue: rawValue), Self.supportedServices.contains(service) {
                self?.openService?(service)
            }
            completionHandler()
        }
    }
}

struct SocialReminder {
    let id: String
    let title: String
    let body: String
    let date: Date
}

enum SocialReminderPlan {
    static func items(routines: [SocialRoutine], sleepUntil: Date?, postingUntil: Date?, now: Date,
                      calendar: Calendar = .autoupdatingCurrent) -> [SocialReminder] {
        var items: [SocialReminder] = []
        let today = calendar.startOfDay(for: now)
        for routine in routines where routine.isValid {
            for offset in -1...7 {
                guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                      routine.weekdays.contains(calendar.component(.weekday, from: day)),
                      let start = calendar.date(bySettingHour: routine.startMinute / 60, minute: routine.startMinute % 60,
                                               second: 0, of: day, matchingPolicy: .nextTime, repeatedTimePolicy: .first, direction: .forward),
                      let interval = routine.activeInterval(at: start.addingTimeInterval(0.1), calendar: calendar) else { continue }
                let stamp = String(Int(interval.start.timeIntervalSince1970))
                if interval.start > now {
                    items.append(.init(id: "routine-\(routine.id)-\(stamp)-start", title: "Routine started",
                                       body: "Your scheduled Vigil pause is active.", date: interval.start))
                }
                if interval.end > now {
                    items.append(.init(id: "routine-\(routine.id)-\(stamp)-end", title: "Routine ended",
                                       body: "A scheduled Vigil pause has ended. Other protections remain active.", date: interval.end))
                }
            }
        }
        if let sleepUntil, sleepUntil > now {
            items.append(.init(id: "sleep-end", title: "Sleep Mode ended", body: "Your wake time has arrived.", date: sleepUntil))
        }
        if let postingUntil, postingUntil > now {
            items.append(.init(id: "posting-end", title: "Posting session ended", body: "Your ten-minute posting timer has finished.", date: postingUntil))
        }
        // iOS retains at most 64 pending local notifications. Keep the next 60
        // so routine expansion cannot crowd out nearer sleep/posting deadlines.
        return Array(items.sorted { $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date }.prefix(60))
    }
}

@MainActor
final class WeakNotificationSession {
    weak var webView: WKWebView?
    let service: SocialService
    private var permissionScript: WKUserScript

    init(webView: WKWebView, service: SocialService, permissionScript: WKUserScript) {
        self.webView = webView; self.service = service; self.permissionScript = permissionScript
    }

    func updatePermission(_ allowed: Bool) {
        guard let webView else { return }
        let replacement = WKUserScript(source: SocialMessageNotificationBridge.script(allowed: allowed),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: true)
        if replacement.source != permissionScript.source {
            let controller = webView.configuration.userContentController
            // WebKit may return copies of WKUserScript. Materialize the list
            // before removal and preserve every other safety/control script.
            let scripts = controller.userScripts.map { script in
                script.source == permissionScript.source && script.isForMainFrameOnly
                    && script.injectionTime == .atDocumentStart ? replacement : script
            }
            controller.removeAllUserScripts()
            for script in scripts { controller.addUserScript(script) }
            permissionScript = replacement
        }
        // Update this document as well as every future navigation/reload.
        webView.evaluateJavaScript("window.__vigilWebAlertsAllowed = \(allowed ? "true" : "false");")
    }
}

@MainActor
final class SocialMessageNotificationBridge: NSObject, WKScriptMessageHandler {
    let service: SocialService
    let sessionID = UUID().uuidString
    private let policyAllows: () -> Bool

    init(service: SocialService, policyAllows: @escaping () -> Bool) {
        self.service = service; self.policyAllows = policyAllows
    }

    static func install(on webView: WKWebView, service: SocialService, policyAllows: @escaping () -> Bool = { true }) {
        guard SocialNotifications.supportedServices.contains(service) else { return }
        let controller = webView.configuration.userContentController
        let bridge = SocialMessageNotificationBridge(service: service, policyAllows: policyAllows)
        controller.add(bridge, name: "vigilWebActivity")
        let permissionScript = WKUserScript(source: script(allowed: SocialNotifications.shared.enabled(for: service)),
                                            injectionTime: .atDocumentStart, forMainFrameOnly: true)
        controller.addUserScript(permissionScript)
        SocialNotifications.shared.register(webView, for: service, permissionScript: permissionScript)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, policyAllows(),
              let webView = message.webView, let url = webView.url,
              service.isCanonicalAppHost(url.host ?? ""), service.allowsNavigation(to: url), !service.isRestrictedSurface(url),
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host.lowercased() == url.host?.lowercased(),
              let body = message.body as? [String: Any], body["type"] as? String == "activity",
              body["href"] as? String == url.absoluteString else { return }
        SocialNotifications.shared.deliverWebActivity(for: service, sessionID: sessionID)
    }

    static func script(allowed: Bool) -> String {
        """
        (() => {
          if (window.top !== window || window.__vigilWebNotificationBridgeInstalled) return;
          window.__vigilWebNotificationBridgeInstalled = true;
          window.__vigilWebAlertsAllowed = \(allowed ? "true" : "false");
          class VigilWebNotification extends EventTarget {
            constructor(title, options = {}) {
              super(); this.title = String(title ?? ''); this.tag = String(options.tag ?? '');
              this.body = ''; this.data = null; this.onclick = null; this.onclose = null;
              if (window.__vigilWebAlertsAllowed === true) {
                window.webkit?.messageHandlers?.vigilWebActivity?.postMessage({ type: 'activity', href: location.href });
              }
            }
            static get permission() { return window.__vigilWebAlertsAllowed === true ? 'granted' : 'denied'; }
            static get maxActions() { return 0; }
            static requestPermission(callback) {
              const permission = VigilWebNotification.permission;
              if (typeof callback === 'function') callback(permission);
              return Promise.resolve(permission);
            }
            close() { this.dispatchEvent(new Event('close')); if (typeof this.onclose === 'function') this.onclose(); }
          }
          try { Object.defineProperty(window, 'Notification', { configurable: true, value: VigilWebNotification }); } catch {}
        })();
        """
    }
}

struct SocialNotificationSettingsView: View {
    @ObservedObject private var notifications = SocialNotifications.shared
    var body: some View {
        Section("Notifications") {
            Text("Web-session alerts work while Vigil is open on screen. New social messages cannot arrive while it is in the background or closed. Scheduled reminders can still arrive.")
                .font(.footnote).foregroundStyle(.secondary)
            if notifications.isAuthorized {
                Label("Scheduled reminders are allowed", systemImage: "bell.badge")
            } else {
                Button("Enable scheduled reminders") { Task { await notifications.authorizeReminders() } }
            }
            ForEach(SocialNotifications.supportedServices) { service in
                Toggle(service.displayName, isOn: Binding(
                    get: { notifications.enabled(for: service) },
                    set: { enabled in Task { await notifications.setEnabled(enabled, for: service) } }
                ))
            }
            if let error = notifications.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task { await notifications.refreshAuthorization() }
    }
}
