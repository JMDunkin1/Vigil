import Foundation
enum SocialService: String, CaseIterable { case instagram, youtube, snapchat, linkedin, facebook, x, tiktok, reddit }
final class MemoryStorage: SocialCommitmentStorage {
 var data: Data?; var fail = false
 func load() throws -> Data? { data }
 func save(_ data: Data) throws { if fail { throw NSError(domain:"test",code:1) }; self.data = data }
}
final class ClockBox { var value = SocialCommitmentStore.Clock(boot:"A",seconds:1000) }
@main
struct NativeSocialCommitmentRegression {
 static func main() {
let now = Date(timeIntervalSince1970: 1800000000)
let memory = MemoryStorage(); let time = ClockBox()
let first = SocialCommitmentStore(storage:memory,clock:{time.value})
precondition(first.begin(scope:"instagram",until:now.addingTimeInterval(3600),at:now))
let reopened = SocialCommitmentStore(storage:memory,clock:{time.value})
precondition(reopened.restriction(for:.instagram,at:now.addingTimeInterval(100000000)) != nil)
precondition(reopened.restriction(for:.youtube,at:now) == nil)
precondition(!reopened.begin(scope:"instagram",until:now.addingTimeInterval(1800),at:now))
time.value.seconds += 120
precondition(reopened.restriction(for:.instagram,at:now) != nil)
time.value = .init(boot:"B",seconds:10)
let rebooted = SocialCommitmentStore(storage:memory,clock:{time.value})
precondition(rebooted.restriction(for:.instagram,at:now.addingTimeInterval(86400)) != nil)
time.value.seconds += 3479
precondition(rebooted.restriction(for:.instagram,at:now) != nil)
time.value.seconds += 1
precondition(rebooted.restriction(for:.instagram,at:now) == nil)
precondition(rebooted.begin(scope:"all",until:nil,at:now))
precondition(!rebooted.begin(scope:"all",until:now.addingTimeInterval(86400),at:now))
time.value.seconds += 100000000
for service in SocialService.allCases { precondition(rebooted.restriction(for:service,at:now)?.permanent == true) }
let corruption = MemoryStorage(); corruption.data = Data("{broken".utf8)
let broken = SocialCommitmentStore(storage:corruption)
for service in SocialService.allCases { precondition(broken.restriction(for:service,at:now) != nil) }
let failure = MemoryStorage(); failure.fail = true
let unsaved = SocialCommitmentStore(storage:failure,clock:{time.value})
precondition(!unsaved.begin(scope:"all",until:nil,at:now))
for service in SocialService.allCases { precondition(unsaved.restriction(for:service,at:now) != nil) }
let liveClock = SocialCommitmentStore.Clock.current()
precondition(!liveClock.boot.isEmpty && liveClock.seconds > 0)
print("Native commitment regressions passed: persistence, all-service scope, no shortening, wall-clock changes, reboot retention, expiry, permanence, corruption, failed writes, and native clock.")

 }
}
