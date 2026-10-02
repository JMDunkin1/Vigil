import SwiftUI

struct SocialSettingsView: View {
    @ObservedObject var container: SocialContainerStore
    @ObservedObject private var preferences: SocialPreferences
    @Environment(\.dismiss) private var dismiss
    @State private var now = Date()
    @State private var editingRoutine: SocialRoutine?
    @State private var wakeDate: Date
    @State private var sleepError: String?
    @State private var postingService = "linkedin"

    init(container: SocialContainerStore) {
        self.container = container
        preferences = container.preferences
        let calendar = Calendar.autoupdatingCurrent
        let nextMorning = calendar.nextDate(after: Date(), matching: DateComponents(hour: 7, minute: 0), matchingPolicy: .nextTime)
            ?? Date().addingTimeInterval(8 * 3600)
        _wakeDate = State(initialValue: nextMorning)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Opening Vigil") {
                    Picker("Start at", selection: Binding(get: { preferences.startupService?.rawValue ?? "home" }, set: {
                        preferences.setStartupService(SocialService(rawValue: $0))
                    })) {
                        Text("All apps").tag("home")
                        ForEach(SocialService.allCases) { Text($0.displayName).tag($0.rawValue) }
                    }
                    Toggle("Haptic feedback", isOn: Binding(get: { preferences.hapticsEnabled }, set: preferences.setHapticsEnabled))
                }

                Section {
                    ForEach(SocialService.allCases.filter { $0 != .instagram }) { service in
                        NavigationLink(service.displayName) { SocialAccountSettingsView(container: container, service: service) }
                    }
                } header: { Text("Accounts") } footer: {
                    Text("Each account keeps a separate sign-in. Instagram retains your existing session. Usage limits apply across every account.")
                }

                Section {
                    Toggle("Background audio", isOn: Binding(get: { container.youtubeBackgroundPlaybackEnabled }, set: container.setYouTubeBackgroundPlaybackEnabled))
                    Toggle("Picture-in-picture", isOn: Binding(get: { container.youtubePictureInPictureEnabled }, set: container.setYouTubePictureInPictureEnabled))
                } header: { Text("YouTube playback") } footer: {
                    Text("Background audio and picture-in-picture use the same video checks and watch-time limits as normal playback.")
                }

                SocialNotificationSettingsView()

                Section {
                    Picker("Service", selection: $postingService) {
                        ForEach(SocialService.allCases.filter { $0.postingURL != nil }) { Text($0.displayName).tag($0.rawValue) }
                    }
                    Button("Start ten-minute session") {
                        guard let service = SocialService(rawValue: postingService), let url = service.postingURL,
                              preferences.beginPosting(for: service) else { return }
                        container.open(url)
                        preferences.selectionFeedback()
                        dismiss()
                    }.disabled(SocialService(rawValue: postingService).map { preferences.isBlocked(for: $0) } ?? true)
                } header: { Text("Posting session") } footer: {
                    Text("Open a supported web composer and keep a ten-minute countdown. Your filters stay active. The session returns to Apps when it ends.")
                }

                Section {
                    if preferences.savedScheduleUnreadable {
                        Text("The saved schedule could not be read. Services remain paused to preserve your restrictions.").foregroundStyle(.red)
                    }
                    ForEach(preferences.routines) { routine in
                        Button { editingRoutine = routine } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(routine.name).foregroundStyle(.primary)
                                Text(routineDescription(routine)).font(.caption).foregroundStyle(.secondary)
                                if let interval = routine.activeInterval(at: now) {
                                    Text("Active until \(interval.end.formatted(date: .omitted, time: .shortened))")
                                        .font(.caption).foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                    Button { editingRoutine = SocialRoutine(name: "Focus", services: Set(SocialService.allCases),
                                                            weekdays: Set(1...7), startMinute: 9 * 60, endMinute: 17 * 60) } label: {
                        Label("Add a routine", systemImage: "plus")
                    }
                    .disabled(preferences.savedScheduleUnreadable)
                } header: { Text("Routines") } footer: {
                    Text("Routines add scheduled pauses. An active pause cannot be shortened or removed. Overnight routines finish the following morning.")
                }

                Section {
                    if let end = preferences.sleepRestriction(at: now)?.until {
                        Label("Sleeping until \(end.formatted(date: .abbreviated, time: .shortened))", systemImage: "moon.fill")
                    }
                    DatePicker("Wake time", selection: $wakeDate, in: now...now.addingTimeInterval(7 * 24 * 3600))
                    Button(preferences.sleepRestriction(at: now) != nil ? "Extend Sleep Mode" : "Start Sleep Mode") {
                        if preferences.beginSleep(until: wakeDate) {
                            preferences.selectionFeedback()
                            container.enforceRestrictions()
                            sleepError = nil
                        } else { sleepError = "Choose a future wake time after the current Sleep Mode ends." }
                    }
                    .disabled(preferences.savedScheduleUnreadable)
                    if let sleepError { Text(sleepError).font(.footnote).foregroundStyle(.red) }
                } header: { Text("Sleep Mode") } footer: {
                    Text("Pause every service until your wake time. Sleep Mode ends automatically and cannot be stopped early.")
                }

                Section { NavigationLink("Help and frequently asked questions") { SocialHelpView() } }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .onReceive(Timer.publish(every: 1, on: .main, in: .common).autoconnect()) { now = $0 }
            .sheet(item: $editingRoutine) { SocialRoutineEditor(preferences: preferences, routine: $0) }
        }
    }

    private func routineDescription(_ routine: SocialRoutine) -> String {
        let symbols = Calendar.autoupdatingCurrent.shortWeekdaySymbols
        let days = routine.weekdays.sorted().map { symbols[$0 - 1] }.joined(separator: ", ")
        return "\(days) · \(SocialRoutineEditor.timeLabel(routine.startMinute))–\(SocialRoutineEditor.timeLabel(routine.endMinute)) · \(routine.services.count) services"
    }
}

private struct SocialAccountSettingsView: View {
    @ObservedObject var container: SocialContainerStore
    @ObservedObject private var preferences: SocialPreferences
    let service: SocialService
    @State private var newName = ""
    @State private var renaming: SocialAccount?
    @State private var renamedValue = ""
    @State private var accountError: String?

    init(container: SocialContainerStore, service: SocialService) {
        self.container = container
        preferences = container.preferences
        self.service = service
    }

    var body: some View {
        Form {
            Section("Sign-in sessions") {
                accountButton(id: nil, name: "Existing account")
                ForEach(preferences.accounts(for: service)) { account in
                    HStack {
                        accountButton(id: account.id, name: account.name)
                        Button { renaming = account; renamedValue = account.name } label: {
                            Image(systemName: "pencil").accessibilityLabel("Rename \(account.name)")
                        }.buttonStyle(.borderless)
                    }
                }
            }
            Section {
                TextField("Account name", text: $newName).textInputAutocapitalization(.words)
                Button("Add an account") {
                    if container.addAccount(for: service, name: newName) {
                        newName = ""
                        accountError = nil
                        preferences.selectionFeedback()
                    } else { accountError = "Enter a name. Account switching is unavailable during a scheduled pause." }
                }.disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || preferences.isBlocked(for: service))
                if let accountError { Text(accountError).foregroundStyle(.red).font(.footnote) }
            } footer: { Text("New accounts open a fresh sign-in session. The existing account preserves your original cookies and history.") }
        }
        .navigationTitle(service.displayName)
        .alert("Rename account", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Account name", text: $renamedValue)
            Button("Save") {
                if let renaming { container.renameAccount(renaming.id, for: service, name: renamedValue) }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    private func accountButton(id: UUID?, name: String) -> some View {
        Button {
            container.selectAccount(id, for: service)
            preferences.selectionFeedback()
        } label: {
            HStack {
                Text(name)
                Spacer()
                if preferences.selectedAccountID(for: service) == id { Image(systemName: "checkmark") }
            }
        }
        .disabled(preferences.isBlocked(for: service))
        .accessibilityLabel("\(name)\(preferences.selectedAccountID(for: service) == id ? ", selected" : "")")
    }
}

private struct SocialRoutineEditor: View {
    @ObservedObject var preferences: SocialPreferences
    @Environment(\.dismiss) private var dismiss
    @State var routine: SocialRoutine
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $routine.name)
                    DatePicker("Start", selection: timeBinding(forStart: true), displayedComponents: .hourAndMinute)
                    DatePicker("End", selection: timeBinding(forStart: false), displayedComponents: .hourAndMinute)
                    if routine.endMinute < routine.startMinute { Text("Ends the following day.").foregroundStyle(.secondary) }
                }
                Section("Starting days") {
                    ForEach(1...7, id: \.self) { weekday in
                        Toggle(Calendar.autoupdatingCurrent.weekdaySymbols[weekday - 1], isOn: Binding(get: {
                            routine.weekdays.contains(weekday)
                        }, set: { value in
                            if value { routine.weekdays.insert(weekday) } else { routine.weekdays.remove(weekday) }
                        }))
                    }
                }
                Section("Services to pause") {
                    ForEach(SocialService.allCases) { service in
                        Toggle(service.displayName, isOn: Binding(get: { routine.services.contains(service) }, set: { value in
                            if value { routine.services.insert(service) } else { routine.services.remove(service) }
                        }))
                    }
                }
                if preferences.routines.contains(where: { $0.id == routine.id }) {
                    Section {
                        Button("Delete routine", role: .destructive) {
                            if preferences.removeRoutine(routine.id) { dismiss() }
                            else { error = "This routine is active. You can remove it after its current pause finishes." }
                        }
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Routine")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        if preferences.saveRoutine(routine) { preferences.selectionFeedback(); dismiss() }
                        else { error = routine.isValid
                            ? "An active pause cannot lose services or end earlier. Wait until it finishes to reduce it."
                            : "Enter a name, choose days and services, and use different start and end times." }
                    }
                }
            }
        }
    }

    private func timeBinding(forStart: Bool) -> Binding<Date> {
        Binding(get: {
            let minute = forStart ? routine.startMinute : routine.endMinute
            return Calendar.autoupdatingCurrent.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: Date()) ?? Date()
        }, set: { value in
            let parts = Calendar.autoupdatingCurrent.dateComponents([.hour, .minute], from: value)
            let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
            if forStart { routine.startMinute = minute } else { routine.endMinute = minute }
        })
    }

    static func timeLabel(_ minute: Int) -> String {
        let calendar = Calendar.autoupdatingCurrent
        return (calendar.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: Date()) ?? Date())
            .formatted(date: .omitted, time: .shortened)
    }
}

struct SocialHelpView: View {
    var body: some View {
        List {
            faq("How do I return to the apps?", "Use Apps above a service, or double-tap with three fingers. VoiceOver offers a Return to apps action. Instagram keeps its existing full interface.")
            faq("Which services are available?", "Instagram, YouTube, Snapchat, LinkedIn, Facebook, X, TikTok, and Reddit. Each service stays inside Vigil's filtered web session. Some native-app features are unavailable on the web.")
            faq("Can I post?", "Use a service's own posting controls wherever its web version supports them. Vigil's restrictions remain active while you create or upload content.")
            faq("What happens when I change accounts?", "Other services can keep separate signed-in accounts. Your original account is preserved, and all accounts share the same restrictions and usage limits. Instagram retains its current account.")
            faq("How do audio and picture-in-picture work?", "Enable them in Settings for supported YouTube videos. Only a permitted video with remaining watch time can continue. A scheduled pause stops playback, including the floating window.")
            faq("How do routines and Sleep Mode work?", "They add pauses on top of your existing restrictions. Routines follow local time and may run overnight. An active routine or Sleep Mode cannot be ended early.")
            faq("Why is a service unavailable?", "Vigil checks the phone's live web policy before showing a service. Access also pauses during routines or Sleep Mode. A connection problem may prevent the policy check; Vigil retries automatically.")
            faq("How do notifications work?", "Enable supported alerts in Settings and allow iOS notification permission. Web sessions and iOS background limits affect delivery; see Settings for the current supported notification behavior.")
        }
        .navigationTitle("Help")
    }

    private func faq(_ question: String, _ answer: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(question).font(.headline)
            Text(answer).font(.subheadline).foregroundStyle(.secondary)
        }.padding(.vertical, 5)
    }
}
