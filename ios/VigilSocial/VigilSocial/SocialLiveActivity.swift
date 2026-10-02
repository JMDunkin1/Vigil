import ActivityKit
import Foundation

@MainActor
enum SocialLiveActivity {
    private static var operation: Task<Void, Never>?

    static func start(title: String, endsAt: Date) {
        guard endsAt > Date(), ActivityAuthorizationInfo().areActivitiesEnabled else { end(); return }
        if Activity<SocialActivityAttributes>.activities.contains(where: {
            $0.attributes.title == title && $0.content.state.endsAt == endsAt
        }) { return }
        operation?.cancel()
        operation = Task {
            for activity in Activity<SocialActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
            guard !Task.isCancelled else { return }
            // Local ActivityKit updates do not use APNs or a provider server.
            _ = try? Activity.request(attributes: SocialActivityAttributes(title: title),
                                      content: ActivityContent(state: .init(endsAt: endsAt), staleDate: endsAt),
                                      pushType: nil)
        }
    }

    static func end() {
        operation?.cancel()
        operation = Task {
            for activity in Activity<SocialActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}
