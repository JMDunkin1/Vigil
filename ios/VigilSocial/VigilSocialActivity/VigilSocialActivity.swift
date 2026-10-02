import ActivityKit
import SwiftUI
import WidgetKit

@main
struct VigilSocialActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: SocialActivityAttributes.self) { context in
            HStack(spacing: 14) {
                Image(systemName: "timer").font(.title2)
                VStack(alignment: .leading, spacing: 4) {
                    Text(context.attributes.title).font(.headline)
                    Text("Vigil protections remain active").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Text(timerInterval: Date()...max(Date(), context.state.endsAt), countsDown: true)
                    .monospacedDigit().font(.title3.bold()).frame(maxWidth: 90)
            }
            .padding().activityBackgroundTint(Color(.systemBackground))
            .widgetURL(URL(string: "vigilsocial://home"))
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { Image(systemName: "timer") }
                DynamicIslandExpandedRegion(.trailing) {
                    Text(timerInterval: Date()...max(Date(), context.state.endsAt), countsDown: true).monospacedDigit()
                }
                DynamicIslandExpandedRegion(.bottom) { Text(context.attributes.title).font(.headline) }
            } compactLeading: {
                Image(systemName: "timer")
            } compactTrailing: {
                Text(timerInterval: Date()...max(Date(), context.state.endsAt), countsDown: true)
                    .monospacedDigit().frame(width: 45)
            } minimal: {
                Image(systemName: "timer")
            }
            .widgetURL(URL(string: "vigilsocial://home"))
        }
    }
}
