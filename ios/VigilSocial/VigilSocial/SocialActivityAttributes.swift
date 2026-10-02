import ActivityKit
import Foundation

struct SocialActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var endsAt: Date
    }
    var title: String
}
