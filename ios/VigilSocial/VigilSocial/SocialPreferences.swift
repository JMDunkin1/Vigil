import Combine
import Foundation
import UIKit
import Security
import Darwin

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
    var permanent = false

    var message: String {
        if permanent { return "This service is permanently locked." }
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
    private let commitments: SocialCommitmentStore
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

    init(defaults: UserDefaults = .standard, commitmentStorage: SocialCommitmentStorage = KeychainSocialCommitmentStorage(), monotonicNow: @escaping () -> TimeInterval = SocialPreferences.continuousSeconds) {
        self.defaults = defaults
        commitments = SocialCommitmentStore(storage: commitmentStorage)
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
        guard service != .instagram, !trimmed.isEmpty, !savedScheduleUnreadable, !isBlocked(for: service) else { return nil }
        let account = SocialAccount(service: service, name: trimmed)
        accounts.append(account)
        persist()
        return account.id
    }

    func selectAccount(_ id: UUID?, for service: SocialService) {
        guard service != .instagram, !savedScheduleUnreadable, !isBlocked(for: service),
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
        if let committed = commitments.restriction(for: service, at: now) { return committed }
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
    func beginSocialLock(instagramOnly: Bool, until end: Date?, at now: Date = Date()) -> Bool {
        guard !savedScheduleUnreadable else { return false }
        let saved = commitments.begin(scope: instagramOnly ? "instagram" : "all", until: end, at: now)
        objectWillChange.send()
        return saved
    }

    func socialLocks(at now: Date = Date()) -> [(name: String, restriction: SocialRestriction)] {
        commitments.active(at: now)
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

protocol SocialCommitmentStorage {
    func load() throws -> Data?
    func save(_ data: Data) throws
}

struct KeychainSocialCommitmentStorage: SocialCommitmentStorage {
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "tech.caseline.vigil.social-commitment.v1",
         kSecAttrAccount as String: "commitments"]
    }

    func load() throws -> Data? {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw CommitmentError.storage }
        return data
    }

    func save(_ data: Data) throws {
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw CommitmentError.storage }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw CommitmentError.storage }
    }
}

private enum CommitmentError: Error { case storage }

/// Separate from preferences and web accounts; reinstalling the app cannot reset a commitment.
/// No method deletes a lock, shortens its time, or grants an early unlock.
final class SocialCommitmentStore {
    struct Clock {
        var boot: String
        var seconds: TimeInterval

        private static let bootIdentity: String = {
            // A process-local identity is a conservative fallback: reopening can
            // extend a lock when the kernel identity is unavailable, never shorten it.
            let fallback = UUID().uuidString
            var size = 0
            guard sysctlbyname("kern.bootsessionuuid", nil, &size, nil, 0) == 0, size > 1 else {
                return fallback
            }
            var bytes = [CChar](repeating: 0, count: size)
            guard sysctlbyname("kern.bootsessionuuid", &bytes, &size, nil, 0) == 0 else {
                return fallback
            }
            return String(decoding: bytes.prefix(while: { $0 != 0 }).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        }()
        private static let ticksToSeconds: Double = {
            var scale = mach_timebase_info_data_t()
            mach_timebase_info(&scale)
            guard scale.denom != 0 else { return 0 }
            return Double(scale.numer) / Double(scale.denom) / 1_000_000_000
        }()
        static func current() -> Clock {
            Clock(boot: bootIdentity, seconds: Double(mach_continuous_time()) * ticksToSeconds)
        }
    }

    private struct Lock: Codable {
        var remaining: TimeInterval? // nil means permanent
    }
    private struct Record: Codable {
        var version = 1
        var boot: String
        var seconds: TimeInterval
        var locks: [String: Lock]
    }
    private let storage: SocialCommitmentStorage
    private let clock: () -> Clock
    private var record: Record?
    private var savedAt: TimeInterval = 0
    private(set) var unreadable = false

    init(storage: SocialCommitmentStorage, clock: @escaping () -> Clock = Clock.current) {
        self.storage = storage
        self.clock = clock
        do {
            if let bytes = try storage.load() {
                let decoded = try JSONDecoder().decode(Record.self, from: bytes)
                guard decoded.version == 1, decoded.seconds.isFinite, decoded.seconds >= 0,
                      decoded.locks.keys.allSatisfy({ ["all", "instagram"].contains($0) }),
                      decoded.locks.values.allSatisfy({ $0.remaining == nil || ($0.remaining!.isFinite && $0.remaining! >= 0) }) else {
                    throw CommitmentError.storage
                }
                record = decoded
                savedAt = decoded.seconds
            }
        } catch { unreadable = true }
    }

    private func reconcile() {
        guard !unreadable, var next = record else { return }
        let observed = clock()
        // A missing boot identity freezes the timer rather than releasing access.
        guard !observed.boot.isEmpty, observed.seconds.isFinite, observed.seconds >= 0 else { return }
        let elapsed = next.boot == observed.boot ? max(0, observed.seconds - next.seconds) : 0
        let rebooted = next.boot != observed.boot
        let hadActive = next.locks.values.contains { ($0.remaining ?? .infinity) > 0 }
        for key in next.locks.keys {
            if let remaining = next.locks[key]?.remaining { next.locks[key]?.remaining = max(0, remaining - elapsed) }
        }
        next.boot = observed.boot
        next.seconds = observed.seconds
        record = next
        let expired = hadActive && !next.locks.values.contains { ($0.remaining ?? .infinity) > 0 }
        // Continuous time includes sleep and cannot be advanced by changing the date.
        // After a reboot, retain the last saved remaining time conservatively.
        if rebooted || expired || observed.seconds - savedAt >= 60 {
            do { try persist(next) } catch { unreadable = true }
        }
    }

    private func persist(_ next: Record) throws {
        try storage.save(JSONEncoder().encode(next))
        savedAt = next.seconds
        record = next
    }

    func begin(scope: String, until end: Date?, at now: Date) -> Bool {
        reconcile()
        guard !unreadable, ["all", "instagram"].contains(scope) else { return false }
        let remaining = end.map { $0.timeIntervalSince(now) }
        if let remaining, !remaining.isFinite || remaining <= 0 || remaining > 7 * 24 * 3600 { return false }
        let observed = clock()
        guard !observed.boot.isEmpty else { return false }
        var next = record ?? Record(boot: observed.boot, seconds: observed.seconds, locks: [:])
        if let existing = next.locks[scope], (existing.remaining ?? .infinity) > (remaining ?? .infinity) { return false }
        next.locks[scope] = Lock(remaining: remaining)
        do { try persist(next); return true } catch { unreadable = true; return false }
    }

    func restriction(for service: SocialService, at now: Date) -> SocialRestriction? {
        reconcile()
        if unreadable { return SocialRestriction(name: "Saved social lock", until: nil) }
        let applicable = [record?.locks["all"], service == .instagram ? record?.locks["instagram"] : nil].compactMap { $0 }
        if applicable.contains(where: { $0.remaining == nil }) { return SocialRestriction(name: "Social lock", until: nil, permanent: true) }
        guard let remaining = applicable.compactMap(\.remaining).max(), remaining > 0 else { return nil }
        return SocialRestriction(name: "Social lock", until: now.addingTimeInterval(remaining))
    }

    func active(at now: Date) -> [(name: String, restriction: SocialRestriction)] {
        reconcile()
        if unreadable { return [("Saved social lock", SocialRestriction(name: "Saved social lock", until: nil))] }
        return ["all", "instagram"].compactMap { scope in
            guard let lock = record?.locks[scope], (lock.remaining ?? .infinity) > 0 else { return nil }
            return (scope == "all" ? "All services" : "Instagram",
                    SocialRestriction(name: "Social lock", until: lock.remaining.map { now.addingTimeInterval($0) }, permanent: lock.remaining == nil))
        }
    }
}
