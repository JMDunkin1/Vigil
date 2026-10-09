import XCTest
@testable import VigilSocial

final class SocialPreferencesTests: XCTestCase {
    private final class CommitmentStorage: SocialCommitmentStorage {
        var data: Data?
        var failSave = false
        func load() throws -> Data? { data }
        func save(_ data: Data) throws {
            if failSave { throw NSError(domain: "CommitmentStorage", code: 1) }
            self.data = data
        }
    }

    private final class CommitmentClock {
        var value = SocialCommitmentStore.Clock(boot: "test-boot", seconds: 1000)
    }

    func testSocialLockPersistsAndChangingWallTimeCannotReleaseIt() throws {
        let storage = CommitmentStorage()
        let clock = CommitmentClock()
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let store = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertTrue(store.begin(scope: "instagram", until: now.addingTimeInterval(3600), at: now))
        let reopened = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertNotNil(reopened.restriction(for: .instagram, at: now.addingTimeInterval(10 * 365 * 24 * 3600)))
        XCTAssertNil(reopened.restriction(for: .youtube, at: now))
        clock.value.seconds += 3599
        XCTAssertNotNil(reopened.restriction(for: .instagram, at: now))
        clock.value.seconds += 1
        XCTAssertNil(reopened.restriction(for: .instagram, at: now))
    }

    func testSocialLockCannotBeShortenedAndChangingScopeDoesNotRemoveAnAllServiceLock() {
        let storage = CommitmentStorage()
        let clock = CommitmentClock()
        let now = Date()
        let store = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertTrue(store.begin(scope: "all", until: now.addingTimeInterval(7200), at: now))
        XCTAssertFalse(store.begin(scope: "all", until: now.addingTimeInterval(3600), at: now))
        XCTAssertTrue(store.begin(scope: "instagram", until: now.addingTimeInterval(3600), at: now))
        for service in SocialService.allCases { XCTAssertNotNil(store.restriction(for: service, at: now)) }
        XCTAssertTrue(store.begin(scope: "all", until: now.addingTimeInterval(10800), at: now))
    }

    func testPermanentSocialLockCannotBecomeTimed() {
        let storage = CommitmentStorage()
        let clock = CommitmentClock()
        let now = Date()
        let store = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertTrue(store.begin(scope: "all", until: nil, at: now))
        XCTAssertFalse(store.begin(scope: "all", until: now.addingTimeInterval(7 * 24 * 3600), at: now))
        clock.value.seconds += 100_000_000
        for service in SocialService.allCases { XCTAssertEqual(store.restriction(for: service, at: now)?.permanent, true) }
    }

    func testPhoneRestartRetainsRemainingSocialCommitmentInsteadOfCountingUntrustedWallTime() {
        let storage = CommitmentStorage()
        let clock = CommitmentClock()
        let now = Date()
        let store = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertTrue(store.begin(scope: "all", until: now.addingTimeInterval(3600), at: now))
        clock.value.seconds += 120
        XCTAssertNotNil(store.restriction(for: .youtube, at: now))
        clock.value = .init(boot: "new-boot", seconds: 10)
        let reopened = SocialCommitmentStore(storage: storage, clock: { clock.value })
        XCTAssertNotNil(reopened.restriction(for: .youtube, at: now.addingTimeInterval(86400)))
        clock.value.seconds += 3479
        XCTAssertNotNil(reopened.restriction(for: .youtube, at: now))
        clock.value.seconds += 1
        XCTAssertNil(reopened.restriction(for: .youtube, at: now))
    }

    func testCorruptOrUnwritableCommitmentRecordBlocksEveryService() {
        let storage = CommitmentStorage()
        storage.data = Data("broken commitment".utf8)
        let broken = SocialCommitmentStore(storage: storage)
        for service in SocialService.allCases { XCTAssertNotNil(broken.restriction(for: service, at: Date())) }
        XCTAssertFalse(broken.begin(scope: "all", until: nil, at: Date()))
        let unwritable = CommitmentStorage()
        unwritable.failSave = true
        let clock = CommitmentClock()
        let store = SocialCommitmentStore(storage: unwritable, clock: { clock.value })
        XCTAssertFalse(store.begin(scope: "instagram", until: nil, at: Date()))
        for service in SocialService.allCases { XCTAssertNotNil(store.restriction(for: service, at: Date())) }
    }

    @MainActor
    func testAccountAndConvenienceChangesCannotRemoveSocialCommitment() throws {
        let suite = "VigilSocialTests.commitment.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let storage = CommitmentStorage()
        let preferences = SocialPreferences(defaults: defaults, commitmentStorage: storage)
        XCTAssertTrue(preferences.beginSocialLock(instagramOnly: false, until: nil))
        preferences.setStartupService(.youtube)
        preferences.setHapticsEnabled(false)
        XCTAssertNil(preferences.addAccount(for: .youtube, name: "Other"))
        defaults.removePersistentDomain(forName: suite)
        let reinstalled = SocialPreferences(defaults: defaults, commitmentStorage: storage)
        for service in SocialService.allCases { XCTAssertTrue(reinstalled.isBlocked(for: service)) }
    }

    private func calendar(_ zone: String = "America/New_York") -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: zone)!
        return calendar
    }

    private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int = 0,
                      calendar: Calendar) -> Date {
        calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))!
    }

    func testOvernightRoutineBelongsToItsStartingWeekdayAndUsesExclusiveEnd() {
        let calendar = calendar()
        let routine = SocialRoutine(name: "Sleep", services: [.youtube], weekdays: [2], startMinute: 22 * 60, endMinute: 7 * 60)
        XCTAssertNil(routine.activeInterval(at: date(2026, 10, 5, 21, 59, calendar: calendar), calendar: calendar))
        XCTAssertNotNil(routine.activeInterval(at: date(2026, 10, 5, 22, calendar: calendar), calendar: calendar))
        XCTAssertNotNil(routine.activeInterval(at: date(2026, 10, 6, 6, 59, calendar: calendar), calendar: calendar))
        XCTAssertNil(routine.activeInterval(at: date(2026, 10, 6, 7, calendar: calendar), calendar: calendar))
        XCTAssertNil(routine.activeInterval(at: date(2026, 10, 6, 22, calendar: calendar), calendar: calendar))
    }

    func testDSTAndTimeZoneChangesUseLocalWallTimesRatherThanFixedDurations() throws {
        let eastern = calendar()
        let fall = SocialRoutine(name: "Sleep", services: [.youtube], weekdays: [7], startMinute: 22 * 60, endMinute: 3 * 60)
        let interval = try XCTUnwrap(fall.activeInterval(at: date(2026, 11, 1, 2, calendar: eastern), calendar: eastern))
        XCTAssertEqual(interval.duration, 6 * 3600)
        XCTAssertEqual(interval.end, date(2026, 11, 1, 3, calendar: eastern))
        let spring = SocialRoutine(name: "Focus", services: [.youtube], weekdays: [1], startMinute: 2 * 60 + 30, endMinute: 4 * 60)
        XCTAssertNotNil(spring.activeInterval(at: date(2026, 3, 8, 3, calendar: eastern), calendar: eastern))
        let weekday = SocialRoutine(name: "Work", services: [.youtube], weekdays: [2], startMinute: 9 * 60, endMinute: 10 * 60)
        let sameInstant = date(2026, 10, 5, 9, 30, calendar: eastern)
        XCTAssertNotNil(weekday.activeInterval(at: sameInstant, calendar: eastern))
        XCTAssertNil(weekday.activeInterval(at: sameInstant, calendar: calendar("America/Los_Angeles")))
    }

    @MainActor
    func testActiveRoutineCannotBeDeletedShortenedOrLoseServices() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = SocialPreferences(defaults: defaults)
        let calendar = calendar()
        let now = date(2026, 10, 5, 10, calendar: calendar)
        let original = SocialRoutine(name: "Work", services: [.youtube, .snapchat], weekdays: [2], startMinute: 9 * 60, endMinute: 17 * 60)
        XCTAssertTrue(preferences.saveRoutine(original, at: now, calendar: calendar))
        XCTAssertFalse(preferences.removeRoutine(original.id, at: now, calendar: calendar))
        var shorter = original
        shorter.endMinute = 11 * 60
        XCTAssertFalse(preferences.saveRoutine(shorter, at: now, calendar: calendar))
        var fewerServices = original
        fewerServices.services.remove(.youtube)
        XCTAssertFalse(preferences.saveRoutine(fewerServices, at: now, calendar: calendar))
        var longer = original
        longer.endMinute = 18 * 60
        longer.services.insert(.linkedin)
        XCTAssertTrue(preferences.saveRoutine(longer, at: now, calendar: calendar))
        XCTAssertTrue(preferences.isBlocked(for: .linkedin, at: now, calendar: calendar))
        XCTAssertTrue(preferences.removeRoutine(original.id, at: date(2026, 10, 5, 18, calendar: calendar), calendar: calendar))
    }

    @MainActor
    func testSleepAndAccountsPersistWithoutChangingInstagramOrAllowingEarlyWake() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var uptime: TimeInterval = 1_000_000
        let preferences = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let end = start.addingTimeInterval(8 * 3600)
        preferences.setStartupService(.youtube)
        preferences.setHapticsEnabled(false)
        let account = try XCTUnwrap(preferences.addAccount(for: .youtube, name: "  Work  "))
        XCTAssertNil(preferences.addAccount(for: .instagram, name: "Other"))
        preferences.selectAccount(account, for: .youtube)
        preferences.selectAccount(UUID(), for: .youtube)
        XCTAssertEqual(preferences.selectedAccountID(for: .youtube), account)
        XCTAssertTrue(preferences.beginSleep(until: end, at: start))
        XCTAssertFalse(preferences.beginSleep(until: end.addingTimeInterval(-3600), at: start))
        let reopened = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        XCTAssertEqual(reopened.startupService, .youtube)
        XCTAssertFalse(reopened.hapticsEnabled)
        XCTAssertEqual(reopened.accounts(for: .youtube).first?.name, "Work")
        XCTAssertEqual(reopened.selectedAccountID(for: .youtube), account)
        XCTAssertEqual(reopened.sleepUntil, end)
        for service in SocialService.allCases {
            XCTAssertTrue(reopened.isBlocked(for: service, at: start))
            XCTAssertTrue(reopened.isBlocked(for: service, at: end), "changing only the wall clock cannot wake early")
        }
        uptime += 8 * 3600
        for service in SocialService.allCases { XCTAssertFalse(reopened.isBlocked(for: service, at: end)) }
    }

    @MainActor
    func testSleepRequiresElapsedMonotonicDurationAcrossDateChangesAndRelaunch() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var uptime: TimeInterval = 1_000_000
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let preferences = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        XCTAssertTrue(preferences.beginSleep(until: start.addingTimeInterval(3600), at: start))
        uptime += 600
        let forward = start.addingTimeInterval(30 * 24 * 3600)
        for service in SocialService.allCases { XCTAssertTrue(preferences.isBlocked(for: service, at: forward)) }
        XCTAssertFalse(preferences.beginSleep(until: forward.addingTimeInterval(60), at: forward),
                       "a changed date cannot replace the remaining pause with a shorter duration")
        let reopened = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        XCTAssertTrue(reopened.isBlocked(for: .youtube, at: forward))
        XCTAssertEqual(reopened.sleepRestriction(at: forward)?.until, forward.addingTimeInterval(3000))
        uptime += 3000
        XCTAssertFalse(reopened.isBlocked(for: .youtube, at: start.addingTimeInterval(-86400)),
                       "the real duration expires even if the date moves backwards")
    }

    @MainActor
    func testSleepClockResetResumesSavedRemainingDurationWithoutWallClockCredit() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var uptime: TimeInterval = 1_000_000
        let start = Date(timeIntervalSince1970: 1_800_000_000)
        let preferences = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        XCTAssertTrue(preferences.beginSleep(until: start.addingTimeInterval(3600), at: start))
        uptime += 600
        preferences.setHapticsEnabled(false) // Checkpoint the remaining 50 minutes.
        uptime = 10
        let reopened = SocialPreferences(defaults: defaults, monotonicNow: { uptime })
        let changedDate = start.addingTimeInterval(86400)
        XCTAssertTrue(reopened.isBlocked(for: .youtube, at: changedDate))
        uptime += 2999
        XCTAssertTrue(reopened.isBlocked(for: .youtube, at: changedDate))
        uptime += 1
        XCTAssertFalse(reopened.isBlocked(for: .youtube, at: changedDate))
        reopened.setHapticsEnabled(true)
        XCTAssertNil(reopened.sleepUntil)
        XCTAssertFalse(SocialPreferences(defaults: defaults, monotonicNow: { uptime }).isBlocked(for: .youtube))
    }

    @MainActor
    func testSleepDeadlineWithoutClockEvidenceCannotReleaseServices() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = SocialPreferences(defaults: defaults, monotonicNow: { 100 })
        let start = Date()
        XCTAssertTrue(preferences.beginSleep(until: start.addingTimeInterval(3600), at: start))
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(defaults.data(forKey: SocialPreferences.storageKey))) as? [String: Any])
        record.removeValue(forKey: "sleepDeadline")
        defaults.set(try JSONSerialization.data(withJSONObject: record), forKey: SocialPreferences.storageKey)
        let reopened = SocialPreferences(defaults: defaults, monotonicNow: { 100 })
        XCTAssertTrue(reopened.savedScheduleUnreadable)
        for service in SocialService.allCases { XCTAssertTrue(reopened.isBlocked(for: service, at: start.addingTimeInterval(86400))) }
    }

    @MainActor
    func testCorruptRestrictionRecordCannotBeClearedByConvenienceSettings() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let original = Data("{broken schedule".utf8)
        defaults.set(original, forKey: SocialPreferences.storageKey)
        let preferences = SocialPreferences(defaults: defaults)
        XCTAssertTrue(preferences.savedScheduleUnreadable)
        for service in SocialService.allCases { XCTAssertTrue(preferences.isBlocked(for: service)) }
        preferences.setStartupService(.youtube)
        preferences.setHapticsEnabled(false)
        XCTAssertEqual(defaults.data(forKey: SocialPreferences.storageKey), original)
        XCTAssertNil(preferences.addAccount(for: .youtube, name: "Other"))
    }

    @MainActor
    func testPostingCountdownPersistsAndNeverOverridesAnActivePause() throws {
        let suite = "VigilSocialTests.preferences.\(UUID())"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = SocialPreferences(defaults: defaults)
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        XCTAssertFalse(preferences.beginPosting(for: .instagram, at: now))
        XCTAssertTrue(preferences.beginPosting(for: .linkedin, at: now))
        let restored = SocialPreferences(defaults: defaults)
        XCTAssertEqual(restored.postingService, .linkedin)
        XCTAssertEqual(restored.postingUntil, now.addingTimeInterval(600))
        XCTAssertTrue(restored.beginSleep(until: now.addingTimeInterval(3600), at: now))
        XCTAssertFalse(restored.beginPosting(for: .linkedin, at: now))
        XCTAssertTrue(restored.isBlocked(for: .linkedin, at: now))
        restored.endPosting()
        XCTAssertNil(restored.postingUntil)
        XCTAssertTrue(restored.isBlocked(for: .linkedin, at: now))
    }
}
