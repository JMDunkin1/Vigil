import Combine
import SwiftUI
import UserNotifications
import WebKit

// Local delivery needs no APNs entitlement, provider server, or paid team.
// Web events can only be observed while iOS is running the opened web session.
@MainActor
final class SocialNotifications: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    static let shared = SocialNotifications()
    static let supportedServices: [SocialService] = [.instagram, .snapchat, .linkedin, .facebook, .x, .tiktok, .reddit]
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
    }

    func disableReminders() {
        remindersEnabled = false
        defaults.set(false, forKey: "VigilSocial.reminders.enabled")
        if let preferences { rescheduleReminders(preferences: preferences) }
        recordDiagnostics()
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
        guard service != .instagram, enabled(for: service), UIApplication.shared.applicationState == .active else { return }
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
        controller.addUserScript(permissionScript)
        SocialNotifications.shared.register(webView, for: service, permissionScript: permissionScript, policyAllows: policyAllows)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, policyAllows(), service != .instagram,
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
            Toggle("Scheduled reminders", isOn: Binding(
                get: { notifications.remindersEnabled && notifications.isAuthorized },
                set: { enabled in
                    if enabled { Task { await notifications.authorizeReminders() } }
                    else { notifications.disableReminders() }
                }
            ))
            ForEach(SocialNotifications.supportedServices) { service in
                Toggle(service == .instagram ? "Instagram messages" : service.displayName, isOn: Binding(
                    get: { notifications.enabled(for: service) },
                    set: { enabled in Task { await notifications.setEnabled(enabled, for: service) } }
                ))
            }
            Text("Instagram alerts are for new text messages while Instagram is open in Vigil. Shared reels, photos, stories, reactions, and call history stay silent. Incoming-call and background alerts are unavailable.")
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
            if let error = notifications.error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task { await notifications.refreshAuthorization() }
    }
}
