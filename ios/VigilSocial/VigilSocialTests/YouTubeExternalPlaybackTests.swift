import XCTest
import UIKit
import WebKit
@testable import VigilSocial

final class YouTubeExternalPlaybackTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let videoID = "abcdefghijk"

    func testCompletedFrameChecksFollowTheExplicitInstallPolicy() {
        let rawUnknown: ContentSafetyVerdict = .unknown
        for policy in [UnclassifiedMediaPolicy.conceal, .revealUnclassified] {
            XCTAssertTrue(YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
                verdict: .safe, policy: policy, completedValidFrameCheck: true))
            XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
                verdict: .sensitive, policy: policy, completedValidFrameCheck: true))
            XCTAssertEqual(YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
                verdict: rawUnknown, policy: policy, completedValidFrameCheck: true),
                policy == .revealUnclassified)
        }
        XCTAssertEqual(rawUnknown, .unknown)
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
            verdict: .unknown, policy: UnclassifiedMediaPolicy(infoDictionaryValue: nil),
            completedValidFrameCheck: true))
    }

    func testIncompleteChecksCannotUseThePersonalTeamUnknownMediaPolicy() {
        for verdict in [ContentSafetyVerdict.safe, .unknown, .sensitive] {
            for policy in [UnclassifiedMediaPolicy.conceal, .revealUnclassified] {
                XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.permitsCompletedFrameCheck(
                    verdict: verdict, policy: policy, completedValidFrameCheck: false))
            }
        }
    }

    func testCompletedFrameCheckFreshnessRejectsExpiredMissingAndFutureChecks() {
        XCTAssertTrue(YouTubeExternalPlaybackFramePolicy.isFresh(completedAt: 100, uptime: 100))
        XCTAssertTrue(YouTubeExternalPlaybackFramePolicy.isFresh(completedAt: 100, uptime: 111.999))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isFresh(completedAt: 100, uptime: 112))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isFresh(completedAt: 100, uptime: 99))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isFresh(completedAt: nil, uptime: 100))
    }

    @MainActor
    func testACompletedFrameCheckRequiresDecodableImageData() {
        let frame = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { context in
            UIColor.black.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        XCTAssertTrue(YouTubeExternalPlaybackFramePolicy.isValidCapturedFrame(frame))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isValidCapturedFrame(nil))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isValidCapturedFrame(Data()))
        XCTAssertFalse(YouTubeExternalPlaybackFramePolicy.isValidCapturedFrame(Data("not an image".utf8)))
    }

    func testSuspendingHiddenServicesCannotReleaseVisibleYouTubeAudio() {
        XCTAssertFalse(SocialMediaSuspensionPolicy.relinquishesGlobalAudio(requested: true, serviceIsVisible: false))
        XCTAssertFalse(SocialMediaSuspensionPolicy.relinquishesGlobalAudio(requested: false, serviceIsVisible: false))
        XCTAssertFalse(SocialMediaSuspensionPolicy.relinquishesGlobalAudio(requested: false, serviceIsVisible: true))
        XCTAssertTrue(SocialMediaSuspensionPolicy.relinquishesGlobalAudio(requested: true, serviceIsVisible: true))
    }

    private func start(_ gate: inout YouTubeExternalPlaybackAuthorization) {
        gate.receive(request: ["action": "start", "client": "ios:test", "videoId": videoID],
                     reply: reply(), now: now)
    }

    private func reply(milliseconds: Double = 2_000, settled: Double = 0,
                       client: String = "ios:test", id: String = "lease") -> [String: Any] {
        ["ok": true, "serverTime": now.timeIntervalSince1970 * 1_000,
            "lease": ["id": id, "client": client, "videoId": videoID,
            "milliseconds": milliseconds, "settledMs": settled,
            "expiresAt": now.addingTimeInterval(30).timeIntervalSince1970 * 1_000]]
    }

    private func snapshot(position: Double, uptime: Double, rate: Double = 1,
                          safe: Bool = true, seeking: Bool = false,
                          video: String = "abcdefghijk", playing: Bool = true) -> YouTubeExternalPlaybackSnapshot {
        YouTubeExternalPlaybackSnapshot(result: ["videoID": video, "permittedUnderPolicy": safe,
            "position": position, "rate": rate, "playing": playing, "seeking": seeking,
            "pictureInPicture": false], uptime: uptime)!
    }

    func testInstalledPolicyAndRoutineRemainMandatory() {
        var gate = YouTubeExternalPlaybackAuthorization()
        start(&gate)
        let safe = snapshot(position: 0, uptime: 1)
        XCTAssertTrue(gate.permits(safe, accessConfirmed: true, restricted: false, now: now))
        XCTAssertFalse(gate.permits(safe, accessConfirmed: false, restricted: false, now: now))
        XCTAssertFalse(gate.permits(safe, accessConfirmed: true, restricted: true, now: now))
        XCTAssertFalse(gate.permits(snapshot(position: 0, uptime: 1, safe: false),
                                    accessConfirmed: true, restricted: false, now: now))
        XCTAssertFalse(gate.permits(snapshot(position: 0, uptime: 1, video: "xxxxxxxxxxx"),
                                    accessConfirmed: true, restricted: false, now: now))
        XCTAssertFalse(gate.permits(safe, accessConfirmed: true, restricted: false,
                                    now: now.addingTimeInterval(30)))
    }

    func testActualPlayAtDoubleSpeedCountsElapsedListeningTimeAndStopsAtReservation() {
        var gate = YouTubeExternalPlaybackAuthorization()
        start(&gate)
        gate.sample(snapshot(position: 0, uptime: 0, rate: 2))
        gate.sample(snapshot(position: 2, uptime: 1, rate: 2))
        XCTAssertEqual(gate.playedMilliseconds, 1_000, accuracy: 0.001)
        gate.sample(snapshot(position: 4, uptime: 2, rate: 2))
        XCTAssertFalse(gate.permits(snapshot(position: 4, uptime: 2, rate: 2),
                                    accessConfirmed: true, restricted: false, now: now))
    }

    func testPauseBufferingAndSeekingDoNotSpendUnplayedTime() {
        var gate = YouTubeExternalPlaybackAuthorization()
        start(&gate)
        gate.sample(snapshot(position: 0, uptime: 0))
        gate.sample(snapshot(position: 0, uptime: 5))
        gate.sample(snapshot(position: 100, uptime: 6, seeking: true))
        gate.sample(snapshot(position: 100, uptime: 7, playing: false))
        gate.sample(snapshot(position: 100, uptime: 10, playing: false))
        XCTAssertEqual(gate.playedMilliseconds, 0)
    }

    func testOnlyPersistedMatchingRenewalExtendsReservation() {
        var gate = YouTubeExternalPlaybackAuthorization()
        start(&gate)
        gate.receive(request: ["action": "renew", "client": "ios:test", "leaseId": "lease"],
                     reply: reply(milliseconds: 3_000, settled: 1_000), now: now)
        XCTAssertEqual(gate.allowedMilliseconds, 3_000)
        XCTAssertEqual(gate.playedMilliseconds, 1_000)
        gate.receive(request: ["action": "renew", "client": "ios:test", "leaseId": "lease"],
                     reply: reply(milliseconds: 5_000, settled: 2_000, client: "other-client"), now: now)
        XCTAssertFalse(gate.hasLease)
    }

    func testSettleAndFailedWritesRevokeExternalAuthorization() {
        var gate = YouTubeExternalPlaybackAuthorization()
        start(&gate)
        gate.receive(request: ["action": "settle", "leaseId": "lease"], reply: ["ok": true], now: now)
        XCTAssertFalse(gate.hasLease)
        start(&gate)
        gate.receive(request: ["action": "renew", "client": "ios:test", "leaseId": "lease"],
                     reply: ["ok": false], now: now)
        XCTAssertFalse(gate.hasLease)
    }

    func testWallClockRollbackCannotExtendExternalLease() {
        var gate = YouTubeExternalPlaybackAuthorization()
        gate.receive(request: ["action": "start", "client": "ios:test", "videoId": videoID],
                     reply: reply(), now: now, uptime: 100)
        XCTAssertTrue(gate.permits(snapshot(position: 0, uptime: 101), accessConfirmed: true,
                                   restricted: false, now: now.addingTimeInterval(-3_600), uptime: 101))
        XCTAssertFalse(gate.permits(snapshot(position: 0, uptime: 106), accessConfirmed: true,
                                    restricted: false, now: now.addingTimeInterval(-3_600), uptime: 106))
    }
}

@MainActor
final class SocialContainerAccountTests: XCTestCase {
    func testInstagramFacebookAuthenticationStaysInItsOriginalSessionForLinksAndPopups() throws {
        for address in ["https://www.facebook.com/login.php", "https://www.facebook.com/dialog/oauth"] {
            let url = try XCTUnwrap(URL(string: address))
            XCTAssertTrue(SocialService.instagram.allowsNavigation(to: url), address)
            XCTAssertFalse(SocialWebViewStore.shouldHandoffContentLink(from: .instagram, to: url), address)
        }
        XCTAssertTrue(SocialWebViewStore.shouldHandoffContentLink(from: .instagram,
            to: try XCTUnwrap(URL(string: "https://www.facebook.com/messages/"))))
        XCTAssertFalse(SocialWebViewStore.shouldHandoffContentLink(from: .instagram,
            to: try XCTUnwrap(URL(string: "https://facebook.com.evil.example/login.php"))))
    }
    func testAdditionalAccountsUsePersistentIsolatedStoresAndInstagramStaysOriginal() throws {
        let suite = "VigilSocial.account-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let container = SocialContainerStore(defaults: defaults, combined: true, loadInitialPages: false)
        let instagram = container.store(for: .instagram)
        let originalYouTube = container.store(for: .youtube)
        XCTAssertNil(SocialContainerStore.websiteDataStore(for: .instagram).identifier)
        XCTAssertFalse(container.addAccount(for: .instagram, name: "Other"))
        container.selectAccount(UUID(), for: .instagram)
        XCTAssertTrue(instagram === container.store(for: .instagram))
        XCTAssertTrue(container.addAccount(for: .youtube, name: "Study"))
        let id = try XCTUnwrap(container.selectedAccountID(for: .youtube))
        let studyYouTube = container.store(for: .youtube)
        XCTAssertFalse(originalYouTube === studyYouTube)
        container.setYouTubeBackgroundPlaybackEnabled(false)
        container.setYouTubePictureInPictureEnabled(false)
        XCTAssertFalse(originalYouTube.youtubeBackgroundPlaybackEnabled)
        XCTAssertFalse(studyYouTube.youtubeBackgroundPlaybackEnabled)
        XCTAssertFalse(originalYouTube.youtubePictureInPictureEnabled)
        XCTAssertFalse(studyYouTube.youtubePictureInPictureEnabled)
        XCTAssertEqual(SocialContainerStore.websiteDataStore(for: .youtube, accountID: id).identifier, id)
        XCTAssertTrue(SocialContainerStore.websiteDataStore(for: .youtube, accountID: id).isPersistent)
        let reopened = SocialContainerStore(defaults: defaults, combined: true, loadInitialPages: false)
        XCTAssertEqual(reopened.selectedAccountID(for: .youtube), id)
        XCTAssertEqual(reopened.accounts(for: .youtube).first?.name, "Study")
        container.selectAccount(nil, for: .youtube)
        XCTAssertNil(container.selectedAccountID(for: .youtube))
        XCTAssertTrue(originalYouTube === container.store(for: .youtube))
        XCTAssertEqual(SocialContainerStore.websiteDataStore(for: .youtube).identifier,
                       UUID(uuidString: "B1853428-14D1-4532-8F11-000000000002"))
        XCTAssertTrue(instagram === container.store(for: .instagram))
    }

    func testUnknownAccountAndActiveSleepCannotSelectAnotherSession() throws {
        let suite = "VigilSocial.account-tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let container = SocialContainerStore(defaults: defaults, combined: true, loadInitialPages: false)
        XCTAssertTrue(container.addAccount(for: .reddit, name: "Work"))
        let selected = container.selectedAccountID(for: .reddit)
        container.selectAccount(UUID(), for: .reddit)
        XCTAssertEqual(container.selectedAccountID(for: .reddit), selected)
        _ = container.preferences.beginSleep(until: Date().addingTimeInterval(3_600))
        container.selectAccount(nil, for: .reddit)
        XCTAssertEqual(container.selectedAccountID(for: .reddit), selected)
        XCTAssertFalse(container.addAccount(for: .reddit, name: "Break"))
        container.select(.reddit)
        XCTAssertNil(container.selectedService)
    }
}
