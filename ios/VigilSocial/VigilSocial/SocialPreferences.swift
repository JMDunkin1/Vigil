import Combine
import Darwin
import Foundation
import UIKit

struct SocialAccount: Codable, Identifiable, Equatable {
    let id: UUID
    let service: SocialService
    var name: String

    private enum CodingKeys: String, CodingKey { case id, service, name }

    init(id: UUID = UUID(), service: SocialService, name: String) {
        self.id = id
        self.service = service
        self.name = name
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        let raw = try values.decode(String.self, forKey: .service)
        guard let decoded = SocialService(rawValue: raw), decoded != .instagram else {
            throw DecodingError.dataCorruptedError(forKey: .service, in: values, debugDescription: "Unsupported account service")
        }
        service = decoded
        name = try values.decode(String.self, forKey: .name)
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw DecodingError.dataCorruptedError(forKey: .name, in: values, debugDescription: "Missing account name")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(service.rawValue, forKey: .service)
        try values.encode(name, forKey: .name)
    }
}

struct SocialRestriction: Equatable {
    let name: String
    let until: Date?

    var message: String {
        guard let until else { return "Your saved schedule could not be read. Access stays paused." }
        return "\(name) pauses this service until \(until.formatted(date: .abbreviated, time: .shortened))."
    }
}

// Times are local wall-clock minutes, with Calendar's Sunday = 1 convention.
// An overnight interval belongs to its starting weekday, including after midnight.
struct SocialRoutine: Codable, Identifiable, Equatable {
    let id: UUID
    var name: String
    var services: Set<SocialService>
    var weekdays: Set<Int>
    var startMinute: Int
    var endMinute: Int

    private enum CodingKeys: String, CodingKey { case id, name, services, weekdays, startMinute, endMinute }

    init(id: UUID = UUID(), name: String, services: Set<SocialService>, weekdays: Set<Int>, startMinute: Int, endMinute: Int) {
        self.id = id
        self.name = name
        self.services = services
        self.weekdays = weekdays
        self.startMinute = startMinute
        self.endMinute = endMinute
    }

    var isValid: Bool {
        !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !services.isEmpty && !weekdays.isEmpty && weekdays.isSubset(of: Set(1...7))
            && (0..<1440).contains(startMinute) && (0..<1440).contains(endMinute)
            && startMinute != endMinute
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(UUID.self, forKey: .id)
        name = try values.decode(String.self, forKey: .name)
        let rawServices = try values.decode([String].self, forKey: .services)
        let decoded = rawServices.compactMap(SocialService.init(rawValue:))
        guard decoded.count == rawServices.count else {
            throw DecodingError.dataCorruptedError(forKey: .services, in: values, debugDescription: "Unsupported scheduled service")
        }
        services = Set(decoded)
        weekdays = Set(try values.decode([Int].self, forKey: .weekdays))
        startMinute = try values.decode(Int.self, forKey: .startMinute)
        endMinute = try values.decode(Int.self, forKey: .endMinute)
        guard isValid else {
            throw DecodingError.dataCorruptedError(forKey: .startMinute, in: values, debugDescription: "Invalid saved routine")
        }
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(name, forKey: .name)
        try values.encode(services.map(\.rawValue).sorted(), forKey: .services)
        try values.encode(weekdays.sorted(), forKey: .weekdays)
        try values.encode(startMinute, forKey: .startMinute)
        try values.encode(endMinute, forKey: .endMinute)
    }

    func activeInterval(at now: Date, calendar: Calendar = .autoupdatingCurrent) -> DateInterval? {
        guard isValid else { return nil }
        let today = calendar.startOfDay(for: now)
        // Both are checked: today's start and yesterday's overnight start.
        for offset in [0, -1] {
            guard let day = calendar.date(byAdding: .day, value: offset, to: today),
                  weekdays.contains(calendar.component(.weekday, from: day)),
                  let start = Self.wallTime(startMinute, on: day, calendar: calendar),
                  let endDay = calendar.date(byAdding: .day, value: endMinute < startMinute ? 1 : 0, to: day),
                  let end = Self.wallTime(endMinute, on: endDay, calendar: calendar),
                  start <= now, now < end else { continue }
            return DateInterval(start: start, end: end)
        }
        return nil
    }

    private static func wallTime(_ minute: Int, on day: Date, calendar: Calendar) -> Date? {
        // Missing spring-forward times advance to the next available time;
        // repeated fall-back times use their first occurrence consistently.
        calendar.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: day,
                      matchingPolicy: .nextTime, repeatedTimePolicy: .first, direction: .forward)
    }
}

@MainActor
final class SocialPreferences: ObservableObject {
    static let storageKey = "VigilSocial.preferences.v2"
    @Published private(set) var startupService: SocialService?
    @Published private(set) var hapticsEnabled = true
    @Published private(set) var routines: [SocialRoutine] = []
    @Published private(set) var sleepUntil: Date?
    @Published private(set) var savedScheduleUnreadable = false
    @Published private(set) var accounts: [SocialAccount] = []
    @Published private(set) var selectedAccounts: [String: UUID] = [:]
    @Published private(set) var postingService: SocialService?
    @Published private(set) var postingUntil: Date?
    private let defaults: UserDefaults
    private let monotonicNow: () -> TimeInterval
    private var sleepDeadline: SleepDeadline?

    private struct SleepDeadline: Codable {
        var remainingSeconds: TimeInterval
        var startedAt: TimeInterval

        var isValid: Bool {
            remainingSeconds.isFinite && (0...7 * 24 * 3600).contains(remainingSeconds)
                && startedAt.isFinite && startedAt >= 0
        }

        func remaining(at uptime: TimeInterval) -> TimeInterval {
            // A reboot can reset the monotonic clock. Never credit a reset as
            // elapsed sleep or use the adjustable wall clock to release access.
            max(0, remainingSeconds - max(0, uptime - startedAt))
        }
    }

    nonisolated private static func continuousSeconds() -> TimeInterval {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        // This clock advances while the device sleeps and ignores date changes.
        return Double(mach_continuous_time()) * Double(info.numer) / Double(info.denom) / 1_000_000_000
    }

    private struct Record: Codable {
        var version: Int = 1
        var startupService: String?
        var hapticsEnabled: Bool
        var routines: [SocialRoutine]
        var sleepUntil: Date?
        var sleepDeadline: SleepDeadline?
        var accounts: [SocialAccount]
        var selectedAccounts: [String: UUID]
        var postingService: String?
        var postingUntil: Date?
    }

    init(defaults: UserDefaults = .standard, monotonicNow: @escaping () -> TimeInterval = SocialPreferences.continuousSeconds) {
        self.defaults = defaults
        self.monotonicNow = monotonicNow
        guard let data = defaults.data(forKey: Self.storageKey) else { return }
        guard let record = try? JSONDecoder().decode(Record.self, from: data), record.version == 1,
              Set(record.routines.map(\.id)).count == record.routines.count,
              Set(record.accounts.map(\.id)).count == record.accounts.count else {
            savedScheduleUnreadable = true
            return
        }
        guard (record.sleepUntil == nil) == (record.sleepDeadline == nil),
              record.sleepDeadline?.isValid != false else {
            // A deadline without its monotonic evidence cannot safely expire.
            savedScheduleUnreadable = true
            return
        }
        startupService = record.startupService.flatMap(SocialService.init(rawValue:))
        hapticsEnabled = record.hapticsEnabled
        routines = record.routines
        sleepUntil = record.sleepUntil
        sleepDeadline = record.sleepDeadline
        accounts = record.accounts
        selectedAccounts = record.selectedAccounts.filter { raw, id in
            record.accounts.contains { $0.id == id && $0.service.rawValue == raw }
        }
        if let service = record.postingService.flatMap(SocialService.init(rawValue:)), service.postingURL != nil {
            postingService = service
            postingUntil = record.postingUntil
        }
        if var deadline = sleepDeadline, monotonicNow() < deadline.startedAt {
            // Resume the last saved remaining duration after a clock reset.
            // Unverifiable time while rebooting cannot shorten the pause.
            deadline.startedAt = monotonicNow()
            sleepDeadline = deadline
            sleepUntil = Date().addingTimeInterval(deadline.remainingSeconds)
            persist()
        }
    }

    func setStartupService(_ service: SocialService?) { startupService = service; persist() }
    func setHapticsEnabled(_ enabled: Bool) { hapticsEnabled = enabled; persist() }

    func selectionFeedback() {
        guard hapticsEnabled else { return }
        UISelectionFeedbackGenerator().selectionChanged()
    }

    func accounts(for service: SocialService) -> [SocialAccount] {
        service == .instagram ? [] : accounts.filter { $0.service == service }
    }

    func selectedAccountID(for service: SocialService) -> UUID? {
        guard service != .instagram else { return nil }
        return selectedAccounts[service.rawValue]
    }

    @discardableResult
    func addAccount(for service: SocialService, name: String) -> UUID? {
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        guard service != .instagram, !trimmed.isEmpty, !savedScheduleUnreadable else { return nil }
        let account = SocialAccount(service: service, name: trimmed)
        accounts.append(account)
        persist()
        return account.id
    }

    func selectAccount(_ id: UUID?, for service: SocialService) {
        guard service != .instagram, !savedScheduleUnreadable,
              id == nil || accounts(for: service).contains(where: { $0.id == id }) else { return }
        selectedAccounts[service.rawValue] = id
        persist()
    }

    func renameAccount(_ id: UUID, for service: SocialService, name: String) {
        let trimmed = String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(60))
        guard service != .instagram, !trimmed.isEmpty, !savedScheduleUnreadable,
              let index = accounts.firstIndex(where: { $0.id == id && $0.service == service }) else { return }
        accounts[index].name = trimmed
        persist()
    }

    func blockingReason(for service: SocialService, at now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> SocialRestriction? {
        if savedScheduleUnreadable { return SocialRestriction(name: "Saved schedule", until: nil) }
        var reasons: [SocialRestriction] = []
        if let sleep = sleepRestriction(at: now) { reasons.append(sleep) }
        for routine in routines where routine.services.contains(service) {
            if let interval = routine.activeInterval(at: now, calendar: calendar) {
                reasons.append(SocialRestriction(name: routine.name, until: interval.end))
            }
        }
        return reasons.max { ($0.until ?? .distantFuture) < ($1.until ?? .distantFuture) }
    }

    func sleepRestriction(at now: Date = Date()) -> SocialRestriction? {
        guard let sleepDeadline else { return nil }
        let remaining = sleepDeadline.remaining(at: monotonicNow())
        guard remaining > 0 else { return nil }
        return SocialRestriction(name: "Sleep Mode", until: now.addingTimeInterval(remaining))
    }

    func isBlocked(for service: SocialService, at now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> Bool {
        blockingReason(for: service, at: now, calendar: calendar) != nil
    }

    @discardableResult
    func saveRoutine(_ routine: SocialRoutine, at now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> Bool {
        guard routine.isValid, !savedScheduleUnreadable else { return false }
        if let index = routines.firstIndex(where: { $0.id == routine.id }) {
            // While a saved interval runs, edits may only expand its protection.
            // Rename is safe; removing services or shortening that interval is not.
            let previous = routines[index]
            if let active = previous.activeInterval(at: now, calendar: calendar) {
                guard previous.services.isSubset(of: routine.services),
                      let replacement = routine.activeInterval(at: now, calendar: calendar),
                      replacement.start <= active.start, replacement.end >= active.end else { return false }
            }
            routines[index] = routine
        } else { routines.append(routine) }
        persist()
        return true
    }

    @discardableResult
    func removeRoutine(_ id: UUID, at now: Date = Date(), calendar: Calendar = .autoupdatingCurrent) -> Bool {
        guard !savedScheduleUnreadable, let index = routines.firstIndex(where: { $0.id == id }),
              routines[index].activeInterval(at: now, calendar: calendar) == nil else { return false }
        routines.remove(at: index)
        persist()
        return true
    }

    @discardableResult
    func beginSleep(until end: Date, at now: Date = Date()) -> Bool {
        let duration = end.timeIntervalSince(now)
        let uptime = monotonicNow()
        guard !savedScheduleUnreadable, end > now,
              duration <= 7 * 24 * 60 * 60, uptime.isFinite, uptime >= 0 else { return false }
        if let sleepDeadline, duration < sleepDeadline.remaining(at: uptime) { return false }
        sleepUntil = end
        sleepDeadline = SleepDeadline(remainingSeconds: duration, startedAt: uptime)
        persist()
        return true
    }

    @discardableResult
    func beginPosting(for service: SocialService, duration: TimeInterval = 10 * 60, at now: Date = Date()) -> Bool {
        guard service.postingURL != nil, !isBlocked(for: service, at: now), duration > 0, duration <= 10 * 60 else { return false }
        // The countdown is a convenience. It grants no access or policy exception.
        postingService = service
        postingUntil = now.addingTimeInterval(duration)
        persist()
        return true
    }

    func endPosting() {
        postingService = nil
        postingUntil = nil
        persist()
    }

    private func persist() {
        // A damaged restrictions record cannot be replaced by a convenience setting.
        guard !savedScheduleUnreadable else { return }
        if let deadline = sleepDeadline {
            let uptime = monotonicNow()
            let remaining = deadline.remaining(at: uptime)
            sleepDeadline = remaining > 0 ? SleepDeadline(remainingSeconds: remaining, startedAt: uptime) : nil
            if remaining == 0 { sleepUntil = nil }
        }
        let record = Record(startupService: startupService?.rawValue, hapticsEnabled: hapticsEnabled,
                            routines: routines, sleepUntil: sleepUntil, sleepDeadline: sleepDeadline, accounts: accounts,
                            selectedAccounts: selectedAccounts, postingService: postingService?.rawValue,
                            postingUntil: postingUntil)
        guard let data = try? JSONEncoder().encode(record) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
