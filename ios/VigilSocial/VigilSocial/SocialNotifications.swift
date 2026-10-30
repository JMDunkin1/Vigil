import Combine
import SwiftUI
import UserNotifications
import WebKit
import Security

// Local delivery needs no APNs entitlement, provider server, or paid team.
// Web events can only be observed while iOS is running the opened web session.
@MainActor
final class SocialNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = SocialNotifications()
    static let supportedServices = SocialService.allCases
    static let instagramInboxURL = URL(string: "https://www.instagram.com/direct/inbox/")!
    @Published private(set) var authorization: UNAuthorizationStatus = .notDetermined
    @Published private(set) var enabledServices: Set<String>
    @Published private(set) var error: String?
    @Published private(set) var instagramStatus = "off"
    @Published private(set) var remindersEnabled = false
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
        // Explicit owner selection, applied once. Later changes remain the user's.
        if !defaults.bool(forKey: "VigilSocial.contactAlertsSelection.20261030") {
            enabledServices = ["instagram", "snapchat"]
            defaults.set(["instagram", "snapchat"], forKey: "VigilSocial.webAlerts.services")
            defaults.set(true, forKey: "VigilSocial.contactAlertsSelection.20261030")
        }
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
            // Preserve legacy reminder choices before asking for a new permission.
            await refreshAuthorization()
            do {
                let allowed = try await center.requestAuthorization(options: [.alert, .sound])
                await refreshAuthorization()
                guard allowed else { error = "Allow Vigil notifications in iPhone Settings to enable alerts."; return }
                enabledServices.insert(service.rawValue)
            } catch { self.error = "Notifications could not be enabled. Try again in iPhone Settings."; return }
        } else { enabledServices.remove(service.rawValue) }
        defaults.set(Array(enabledServices).sorted(), forKey: "VigilSocial.webAlerts.services")
        if service == .instagram { instagramStatus = enabled ? "waiting" : "off" }
        error = nil
        refreshWebPermissions()
        if let preferences { rescheduleReminders(preferences: preferences) }
        recordDiagnostics()
        RemoteSocialNotifications.shared.synchronizeSelection()
    }

    func activateSelectedAlerts() async {
        await refreshAuthorization()
        if authorization == .notDetermined && !enabledServices.isEmpty {
            do { _ = try await center.requestAuthorization(options: [.alert, .sound]) }
            catch { self.error = "Notifications could not be enabled. Try again in iPhone Settings." }
            await refreshAuthorization()
        }
        RemoteSocialNotifications.shared.registerIfConfigured()
    }

    func authorizeReminders() async {
        do {
            let allowed = try await center.requestAuthorization(options: [.alert, .sound])
            await refreshAuthorization()
            if allowed {
                remindersEnabled = true
                defaults.set(true, forKey: "VigilSocial.reminders.enabled")
                if let preferences { rescheduleReminders(preferences: preferences) }
            }
            error = allowed ? nil : "Allow Vigil notifications in iPhone Settings to enable reminders."
        } catch { self.error = "Notifications could not be enabled. Try again in iPhone Settings." }
        recordDiagnostics()
        RemoteSocialNotifications.shared.synchronizeSelection()
    }

    func disableReminders() {
        remindersEnabled = false
        defaults.set(false, forKey: "VigilSocial.reminders.enabled")
        if let preferences { rescheduleReminders(preferences: preferences) }
        recordDiagnostics()
        RemoteSocialNotifications.shared.synchronizeSelection()
    }

    func refreshAuthorization() async {
        authorization = await center.notificationSettings().authorizationStatus
        // Existing authorized installations already scheduled reminders. Keep
        // that behavior; a new message-alert permission must not opt into them.
        if defaults.object(forKey: "VigilSocial.reminders.enabled") == nil {
            defaults.set(isAuthorized, forKey: "VigilSocial.reminders.enabled")
        }
        remindersEnabled = defaults.bool(forKey: "VigilSocial.reminders.enabled")
        refreshWebPermissions()
        if let preferences { rescheduleReminders(preferences: preferences) }
        recordDiagnostics()
        RemoteSocialNotifications.shared.synchronizeSelection()
    }

    func register(_ webView: WKWebView, for service: SocialService, permissionScript: WKUserScript,
                  policyAllows: @escaping () -> Bool = { true }) {
        webSessions.removeAll { $0.webView == nil || $0.webView === webView }
        let session = WeakNotificationSession(webView: webView, service: service, permissionScript: permissionScript,
            policyAllows: policyAllows) { [weak self] status, hasMessage in
                guard let self else { return }
                if self.instagramStatus != status {
                    self.instagramStatus = status
                    self.recordDiagnostics()
                }
                if hasMessage { self.deliverInstagramMessage() }
            }
        webSessions.append(session)
        session.updatePermission(enabled(for: service))
    }

    private func refreshWebPermissions() {
        webSessions.removeAll { $0.webView == nil }
        for session in webSessions {
            session.updatePermission(enabled(for: session.service))
        }
    }

    func invalidateWebAlerts(in webView: WKWebView? = nil) {
        for session in webSessions where webView == nil || session.webView === webView {
            session.invalidateInstagramBaseline()
        }
    }

    func deliverWebActivity(for service: SocialService, sessionID: String) {
        guard service != .instagram, service != .snapchat, enabled(for: service), UIApplication.shared.applicationState == .active else { return }
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

    func deliverSnapchatContact(kind: String, sessionID: String) {
        guard ["message", "call"].contains(kind), enabled(for: .snapchat),
              UIApplication.shared.applicationState == .active else { return }
        let key = "snapchat:" + sessionID + ":" + kind
        let now = Date()
        guard now.timeIntervalSince(lastDelivery[key] ?? .distantPast) >= 10 else { return }
        lastDelivery[key] = now
        let content = UNMutableNotificationContent()
        content.title = "Snapchat"
        content.body = kind == "call" ? "Incoming call." : "New message."
        content.sound = .default
        content.userInfo = ["vigilService": "snapchat"]
        center.add(UNNotificationRequest(identifier: "vigil-web-" + key, content: content, trigger: nil))
    }

    private func deliverInstagramMessage() {
        guard enabled(for: .instagram), UIApplication.shared.applicationState == .active else { return }
        let content = UNMutableNotificationContent()
        content.title = "Instagram"
        content.body = "New message."
        content.sound = .default
        content.userInfo = ["vigilService": SocialService.instagram.rawValue]
        // The isolated inbox monitor deduplicates items. No sender, message
        // text, thread identifier, media, or supplied URL leaves that monitor.
        center.add(UNNotificationRequest(identifier: "vigil-instagram-message", content: content, trigger: nil))
    }

    private func recordDiagnostics() {
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let report: [String: Any] = [
            "schemaVersion": 1, "authorization": authorization.rawValue,
            "enabledServices": Array(enabledServices).sorted(), "instagramStatus": instagramStatus,
            "remindersEnabled": remindersEnabled,
            "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            "checkedAt": ISO8601DateFormatter().string(from: Date())
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report) {
            try? data.write(to: directory.appendingPathComponent("vigil-notification-status.json"), options: .atomic)
        }
    }

    func scheduleReminder(id: String, title: String, body: String, at date: Date) {
        guard isAuthorized, remindersEnabled, date > Date() else { return }
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
            guard isAuthorized, remindersEnabled, !preferences.savedScheduleUnreadable else { return }
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
        let rawValue = notification.request.content.userInfo["vigilService"] as? String
        Task { @MainActor in
            if let rawValue {
                guard let service = SocialService(rawValue: rawValue), Self.shared.enabled(for: service) else {
                    completionHandler([]); return
                }
            }
            completionHandler([.banner, .sound])
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                          withCompletionHandler completionHandler: @escaping () -> Void) {
        let rawValue = response.notification.request.content.userInfo["vigilService"] as? String
        Task { @MainActor [weak self] in
            if let rawValue, let service = SocialService(rawValue: rawValue), self?.enabled(for: service) == true {
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
    private let policyAllows: () -> Bool
    private let instagramResult: ((String, Bool) -> Void)?
    private var instagramPollingTask: Task<Void, Never>?
    private var instagramGeneration = UUID().uuidString
    private var permissionAllowed = false

    init(webView: WKWebView, service: SocialService, permissionScript: WKUserScript,
         policyAllows: @escaping () -> Bool = { true }, instagramResult: ((String, Bool) -> Void)? = nil) {
        self.webView = webView; self.service = service; self.permissionScript = permissionScript
        self.policyAllows = policyAllows; self.instagramResult = instagramResult
    }

    func updatePermission(_ allowed: Bool) {
        guard let webView else { return }
        permissionAllowed = allowed
        if service == .instagram {
            if !allowed {
                instagramPollingTask?.cancel()
                instagramPollingTask = nil
                instagramGeneration = UUID().uuidString
                instagramResult?("off", false)
            } else if instagramPollingTask == nil {
                instagramPollingTask = Task { [weak self] in
                    while !Task.isCancelled {
                        guard let delay = await self?.pollInstagramInbox() else { return }
                        do { try await Task.sleep(for: delay) } catch { return }
                    }
                }
            }
        }
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

    private func instagramAccessAllowed(_ webView: WKWebView) -> Bool {
        guard permissionAllowed, policyAllows(), UIApplication.shared.applicationState == .active,
              webView.window?.isKeyWindow == true, !webView.isLoading, let url = webView.url,
              url.scheme == "https", service.isCanonicalAppHost(url.host ?? ""),
              service.allowsNavigation(to: url), !service.isRestrictedSurface(url),
              !service.usesUnmodifiedAuthenticationDocument(url) else { return false }
        return true
    }

    private func pollInstagramInbox() async -> Duration {
        guard let webView, instagramAccessAllowed(webView) else {
            instagramGeneration = UUID().uuidString
            instagramResult?(permissionAllowed ? "waiting" : "off", false)
            return .seconds(3)
        }
        let generation = instagramGeneration
        let documentURL = webView.url
        do {
            let value = try await webView.callAsyncJavaScript(InstagramMessageAlerts.inboxScript,
                arguments: ["generation": generation], in: nil, contentWorld: .defaultClient)
            guard !Task.isCancelled, instagramGeneration == generation,
                  webView.url == documentURL, instagramAccessAllowed(webView),
                  let result = value as? [String: Any], let status = result["status"] as? String,
                  ["ready", "unavailable", "waiting"].contains(status) else {
                instagramGeneration = UUID().uuidString
                return .seconds(3)
            }
            instagramResult?(status, status == "ready" && result["hasMessage"] as? Bool == true)
            return .seconds(status == "unavailable" ? 60 : 15)
        } catch {
            instagramGeneration = UUID().uuidString
            if !Task.isCancelled { instagramResult?("unavailable", false) }
            return .seconds(60)
        }
    }

    func invalidateInstagramBaseline() {
        guard service == .instagram else { return }
        instagramGeneration = UUID().uuidString
    }
}

enum InstagramMessageAlerts {
    static func isEnableURL(_ url: URL) -> Bool {
        ["vigilsocial://notifications/instagram", "vigil-instagram://notifications/instagram"].contains(url.absoluteString)
    }

    // Runs only in WKContentWorld.defaultClient. Page scripts cannot access
    // this baseline. It performs no writes, read receipts, or message sends.
    // Shape reference: instagram-private-api's direct-inbox.feed.response.ts.
    // Unsupported shapes fail closed; call-history records are not ringing calls.
    static let inboxScript = #"""
    return await (async () => {
      const quiet = (status) => ({ status, hasMessage: false });
      if (location.protocol !== 'https:' || !['instagram.com', 'www.instagram.com'].includes(location.hostname)
          || document.visibilityState !== 'visible') {
        delete globalThis.__vigilInstagramMessageBaseline;
        return quiet('waiting');
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const url = new URL('/api/v1/direct_v2/inbox/', location.origin);
        url.search = 'persistentBadging=true&limit=20&thread_message_limit=10';
        const headers = { Accept: 'application/json' };
        // Use the site's own persisted web app identifier when available.
        // Never substitute a mobile identity or invent an app identifier.
        try {
          const appID = localStorage.getItem('instagramWebFBAppId');
          if (typeof appID === 'string' && /^\d{5,30}$/.test(appID)) headers['X-IG-App-ID'] = appID;
        } catch (_) {}
        const response = await fetch(url.href, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers, signal: controller.signal
        });
        if (!response.ok || response.redirected || response.url !== url.href
            || !response.headers.get('content-type')?.includes('application/json')) {
          delete globalThis.__vigilInstagramMessageBaseline;
          return quiet('unavailable');
        }
        const reader = response.body?.getReader();
        if (!reader) { delete globalThis.__vigilInstagramMessageBaseline; return quiet('unavailable'); }
        const chunks = []; let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) {
            await reader.cancel(); delete globalThis.__vigilInstagramMessageBaseline; return quiet('unavailable');
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const payload = JSON.parse(new TextDecoder().decode(bytes));
        if (document.visibilityState !== 'visible' || controller.signal.aborted) {
          delete globalThis.__vigilInstagramMessageBaseline;
          return quiet('waiting');
        }
        if (payload.status !== 'ok' || !Array.isArray(payload.inbox?.threads) || payload.inbox.threads.length > 20) {
          delete globalThis.__vigilInstagramMessageBaseline;
          return quiet('unavailable');
        }
        const id = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value
          : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
        const userID = (value) => { const result = id(value); return result && /^\d+$/.test(result) && BigInt(result) > 0n ? result : null; };
        const threads = payload.inbox.threads;
        const viewers = new Set(threads.map(thread => userID(thread.viewer_id)));
        if (!threads.length || viewers.size !== 1 || viewers.has(null)) {
          delete globalThis.__vigilInstagramMessageBaseline;
          return quiet(threads.length ? 'unavailable' : 'ready');
        }
        const viewer = [...viewers][0];
        const now = BigInt(Date.now()) * 1000n;
        let state = globalThis.__vigilInstagramMessageBaseline;
        const seed = !state || state.generation !== generation || state.viewer !== viewer;
        if (seed) state = { generation, viewer, cutoff: now, seen: new Set() };
        const mediaKeys = ['media', 'media_share', 'reel_share', 'raven_media', 'visual_media',
          'xma_media_share', 'animated_media', 'story_share', 'clip', 'link', 'video_call_event'];
        let hasMessage = false;
        for (const thread of threads) {
          const threadID = id(thread.thread_id);
          if (!threadID || !Array.isArray(thread.items) || thread.items.length > 50) continue;
          for (const item of thread.items) {
            const itemID = id(item.item_id), sender = userID(item.user_id);
            if (!itemID) continue;
            const key = threadID + ':' + itemID;
            if (state.seen.has(key)) continue;
            state.seen.add(key);
            const rawTimestamp = typeof item.timestamp === 'number' && Number.isSafeInteger(item.timestamp)
              ? String(item.timestamp) : item.timestamp;
            if (seed || !sender || sender === viewer || thread.muted !== false || thread.pending !== false
                || thread.archived === true || thread.is_spam === true
                || item.item_type !== 'text' || typeof item.text !== 'string' || !item.text.trim()
                || item.text.length > 20000 || mediaKeys.some(key => item[key] != null)
                || /(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels|p|stories)\//i.test(item.text)
                || typeof rawTimestamp !== 'string' || !/^\d{10,20}$/.test(rawTimestamp)) continue;
            const timestamp = BigInt(rawTimestamp);
            if (timestamp <= state.cutoff || timestamp < now - 60000000n || timestamp > now + 30000000n) continue;
            hasMessage = true;
          }
        }
        while (state.seen.size > 4000) state.seen.delete(state.seen.values().next().value);
        globalThis.__vigilInstagramMessageBaseline = state;
        return { status: 'ready', hasMessage };
      } catch (_) {
        delete globalThis.__vigilInstagramMessageBaseline;
        return quiet('unavailable');
      } finally { clearTimeout(timeout); }
    })();
    """#
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
        // Install before the Snapchat desktop bootstrap, whose inert worker
        // fallback otherwise makes service-worker notification delivery hang.
        let existing = controller.userScripts
        controller.removeAllUserScripts()
        controller.addUserScript(WKUserScript(source: "window.__vigilNotificationService = '\(service.rawValue)';",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.addUserScript(permissionScript)
        for script in existing { controller.addUserScript(script) }
        SocialNotifications.shared.register(webView, for: service, permissionScript: permissionScript, policyAllows: policyAllows)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, policyAllows(), service != .instagram,
              let webView = message.webView, let url = webView.url,
              service.isCanonicalAppHost(url.host ?? ""), service.allowsNavigation(to: url), !service.isRestrictedSurface(url),
              message.frameInfo.securityOrigin.protocol == "https",
              message.frameInfo.securityOrigin.host.lowercased() == url.host?.lowercased(),
              let body = message.body as? [String: Any],
              body["href"] as? String == url.absoluteString else { return }
        if service == .snapchat, body["type"] as? String == "contact", let kind = body["kind"] as? String {
            SocialNotifications.shared.deliverSnapchatContact(kind: kind, sessionID: sessionID)
        } else if body["type"] as? String == "activity" {
            SocialNotifications.shared.deliverWebActivity(for: service, sessionID: sessionID)
        }
    }

    static func script(allowed: Bool) -> String {
        """
        (() => {
          if (window.top !== window || window.__vigilWebNotificationBridgeInstalled) return;
          window.__vigilWebNotificationBridgeInstalled = true;
          window.__vigilWebAlertsAllowed = \(allowed ? "true" : "false");
          const emit = (options) => {
            if (window.__vigilWebAlertsAllowed !== true) return;
            let event = { type: 'activity', href: location.href };
            if (window.__vigilNotificationService === 'snapchat') {
              // Snapchat's public desktop bundle notification enum (2026-10-30).
              // No classification from titles, body text, unread counts or URLs.
              const type = options?.data?.type;
              const kind = [201, 205, 206, 230, 234, 235].includes(type) ? 'message'
                : [1250, 1252, 1270, 1272].includes(type) ? 'call' : null;
              if (!kind) return;
              event = { type: 'contact', kind, href: location.href };
            }
            window.webkit?.messageHandlers?.vigilWebActivity?.postMessage(event);
          };
          class VigilWebNotification extends EventTarget {
            constructor(title, options = {}) {
              super(); this.title = String(title ?? ''); this.tag = String(options.tag ?? '');
              this.body = ''; this.data = null; this.onclick = null; this.onclose = null;
              emit(options);
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
          // Worker-originated local alerts use a different API from new Notification.
          // Retain native workers where available; do not create caches or fetch handlers.
          if (typeof ServiceWorkerRegistration !== 'undefined') {
            try { ServiceWorkerRegistration.prototype.showNotification = async (_title, options) => { emit(options); }; } catch {}
          }
          if (window.__vigilNotificationService === 'snapchat' && !('serviceWorker' in navigator)) {
            const registration = {
              showNotification: async (_title, options) => { emit(options); },
              getNotifications: async () => [],
              pushManager: {
                getSubscription: async () => null,
                subscribe: async () => { throw new DOMException('Remote push is not configured.', 'NotSupportedError'); }
              }
            };
            const workers = new EventTarget();
            Object.defineProperties(workers, {
              controller: { value: null }, ready: { value: Promise.resolve(registration) },
              register: { value: async () => { throw new DOMException('Workers are unavailable.', 'NotSupportedError'); } },
              getRegistration: { value: async () => registration },
              getRegistrations: { value: async () => [] }
            });
            Object.defineProperty(navigator, 'serviceWorker', { value: workers });
            // Snap gates its foreground duplex notification listener on this
            // interface. subscribe always rejects: this is not a push transport.
            if (typeof PushManager === 'undefined') window.PushManager = class PushManager {};
          }
        })();
        """
    }
}

struct SocialNotificationSettingsView: View {
    @ObservedObject private var notifications = SocialNotifications.shared
    var body: some View {
        Section("Notifications") {
            Text("Web-session alerts work while Vigil is open on screen. Background delivery needs a connected notification service and supported push signing. Scheduled reminders are separate.")
                .font(.footnote).foregroundStyle(.secondary)
            Toggle("Scheduled reminders", isOn: Binding(
                get: { notifications.remindersEnabled && notifications.isAuthorized },
                set: { enabled in
                    if enabled { Task { await notifications.authorizeReminders() } }
                    else { notifications.disableReminders() }
                }
            ))
            ForEach(SocialNotifications.supportedServices) { service in
                Toggle(service == .instagram ? "Instagram messages" : service.displayName, isOn: Binding(
                    get: { notifications.enabledServices.contains(service.rawValue) },
                    set: { enabled in Task { await notifications.setEnabled(enabled, for: service) } }
                ))
            }
            Text("Instagram checks new text messages in its opened session. Snapchat forwards classified message and incoming-call alerts. Snaps, shared reels, stories, reactions, and unknown activity stay silent. Background sources still need verification.")
                .font(.footnote).foregroundStyle(.secondary)
            if notifications.enabled(for: .instagram) {
                Text(notifications.instagramStatus == "ready" ? "Instagram message checks are ready."
                     : notifications.instagramStatus == "unavailable" ? "Instagram could not provide the inbox. Open Messages and check your sign-in; Vigil will retry."
                     : "Open Instagram in Vigil to start message checks.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            if notifications.authorization == .denied {
                Button("Open iPhone notification settings") {
                    if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                }
            }
            RemoteSocialNotificationSettingsView()
            if let error = notifications.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task { await notifications.refreshAuthorization() }
    }
}

// Optional paid-team transport. Merely compiling this code grants no entitlement
// and never changes Personal Team signing, supervision, or service access gates.
@MainActor
final class RemoteSocialNotifications: ObservableObject {
    static let shared = RemoteSocialNotifications()
    @Published private(set) var status = "Not connected"
    private struct Connection: Codable {
        let origin: URL
        let deviceID: String
        let secret: String
        let token: String?
    }
    private var connection: Connection?
    private var deviceToken: String?
    private var pendingPairing: (URL, String)?
    private var synchronizing = false
    private var needsSync = false
    private let keychainService = "tech.caseline.vigil.notification-relay"
    private let redirects = NotificationRedirectBlocker()
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        return URLSession(configuration: config, delegate: redirects, delegateQueue: nil)
    }()

    init() {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService, kSecAttrAccount as String: "connection",
            kSecReturnData as String: true]
        var result: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data {
            connection = try? JSONDecoder().decode(Connection.self, from: data)
            deviceToken = connection?.token
            if connection != nil { status = "Registration pending" }
        }
    }

    var supportsPushSigning: Bool {
        ["development", "production"].contains(Bundle.main.object(forInfoDictionaryKey: "VigilPushEnvironment") as? String ?? "")
    }
    var hasConnection: Bool { connection != nil }

    func connect(origin: String, pairingCode: String) {
        guard supportsPushSigning else { status = "This build uses free signing; native push is unavailable."; return }
        guard connection == nil, !synchronizing else { status = "A connection already exists or is being saved."; return }
        guard let parts = URLComponents(string: origin), parts.scheme == "https", parts.host != nil,
              parts.user == nil, parts.password == nil, parts.port == nil || parts.port == 443,
              parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path), let url = parts.url,
              pairingCode.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            status = "Enter the actual HTTPS service address and pairing code."; return
        }
        pendingPairing = (url, pairingCode)
        registerIfConfigured()
    }

    func registerIfConfigured() {
        if !supportsPushSigning && connection != nil {
            Task { await disconnect() }
            return
        }
        guard supportsPushSigning, connection != nil || pendingPairing != nil,
              SocialNotifications.shared.isAuthorized else { return }
        status = "Registering with Apple"
        // The system is the authority: absent/invalid aps-environment returns an
        // error through didFailToRegisterForRemoteNotifications, never a token.
        UIApplication.shared.registerForRemoteNotifications()
    }

    func registered(_ token: Data) {
        guard supportsPushSigning else { return }
        deviceToken = token.map { String(format: "%02x", $0) }.joined()
        synchronizeSelection()
    }

    func registrationFailed() { status = "Apple push registration failed. Check the signed provisioning profile." }

    func disconnect() async {
        guard !synchronizing, let existing = connection else { return }
        synchronizing = true
        defer { synchronizing = false }
        do {
            var request = URLRequest(url: existing.origin.appendingPathComponent("api/notifications/devices/" + existing.deviceID))
            request.httpMethod = "DELETE"
            request.timeoutInterval = 10
            request.setValue("Bearer " + existing.secret, forHTTPHeaderField: "Authorization")
            let (_, response) = try await session.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw URLError(.badServerResponse) }
            let result = SecItemDelete([kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: keychainService, kSecAttrAccount as String: "connection"] as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw URLError(.cannotWriteToFile) }
            connection = nil
            deviceToken = nil
            pendingPairing = nil
            needsSync = false
            UIApplication.shared.unregisterForRemoteNotifications()
            status = "Disconnected"
        } catch { status = "Disconnect has not been confirmed. The notification service must be reachable." }
    }

    func synchronizeSelection() {
        guard supportsPushSigning, deviceToken != nil, connection != nil || pendingPairing != nil else { return }
        needsSync = true
        guard !synchronizing else { return }
        synchronizing = true
        Task {
            defer { synchronizing = false }
            while needsSync {
                needsSync = false
                do { try await saveCurrentSelection() }
                catch { status = "Notification service unavailable; changes have not been confirmed." }
            }
        }
    }

    private func saveCurrentSelection() async throws {
        guard let deviceToken else { return }
        let existing = connection
        guard let origin = existing?.origin ?? pendingPairing?.0,
              let credential = existing?.secret ?? pendingPairing?.1 else { return }
        let route = existing.map { "/api/notifications/devices/" + $0.deviceID } ?? "/api/notifications/devices"
        let selected = SocialNotifications.supportedServices.filter { SocialNotifications.shared.enabled(for: $0) }.map(\.rawValue).sorted()
        var request = URLRequest(url: origin.appendingPathComponent(String(route.dropFirst())))
        request.httpMethod = existing == nil ? "POST" : "PUT"
        request.timeoutInterval = 10
        request.setValue("Bearer " + credential, forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["token": deviceToken, "services": selected])
        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == (existing == nil ? 201 : 200),
              http.url == request.url, http.value(forHTTPHeaderField: "Content-Type")?.contains("application/json") == true else {
            throw URLError(.badServerResponse)
        }
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > 4096 { throw URLError(.dataLengthExceedsMaximum) }
        }
        if existing == nil {
            guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let id = body["deviceID"] as? String, let secret = body["secret"] as? String,
                  id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                  secret.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw URLError(.cannotParseResponse) }
            let saved = Connection(origin: origin, deviceID: id, secret: secret, token: deviceToken)
            let value = try JSONEncoder().encode(saved)
            let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: keychainService, kSecAttrAccount as String: "connection"]
            let attributes: [String: Any] = [kSecValueData as String: value,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let result = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            guard result == errSecSuccess || (result == errSecDuplicateItem
                && SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess) else { throw URLError(.cannotWriteToFile) }
            connection = saved
            pendingPairing = nil
        } else {
            guard (try JSONSerialization.jsonObject(with: data) as? [String: Any])?["ok"] as? Bool == true else { throw URLError(.cannotParseResponse) }
        }
        status = "Device registered. Incoming social sources still need verification."
    }
}

private final class NotificationRedirectBlocker: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

private struct RemoteSocialNotificationSettingsView: View {
    @ObservedObject private var remote = RemoteSocialNotifications.shared
    @State private var origin = ""
    @State private var pairingCode = ""
    var body: some View {
        Text("Background notifications: " + remote.status).font(.footnote).foregroundStyle(.secondary)
        if remote.supportsPushSigning {
            TextField("Notification service HTTPS address", text: $origin)
                .textInputAutocapitalization(.never).autocorrectionDisabled().keyboardType(.URL)
            SecureField("Pairing code", text: $pairingCode).textInputAutocapitalization(.never)
            Button("Connect background notifications") {
                remote.connect(origin: origin, pairingCode: pairingCode)
                pairingCode = ""
            }
        }
        if remote.hasConnection {
            Button("Disconnect background notifications") { Task { await remote.disconnect() } }
        }
    }
}
