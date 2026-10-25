# Snapchat and Instagram contact notifications

Prepared October 25, 2026. The user will connect the iPhone later. This records
the requested behavior and the checks needed before changing the phone; it does
not represent an implemented or installed notification fix.

## Requested behavior

| Service | Allow | Keep silent |
| --- | --- | --- |
| Snapchat | Incoming chat messages and incoming voice/video calls from people | Snaps, stories, Spotlight, suggestions, promotions, and other activity |
| Instagram | Incoming personal messages and incoming voice/video calls from people | Shared reels by themselves, stories, likes, follows, suggestions, promotions, and other activity |

The reason is to be reachable when people contact the user. Receiving alerts
while the phone is locked or another app is open must be checked explicitly;
an alert that works only while reading the opened web session is not sufficient
evidence that this need has been met. Do not enable other services or scheduled
reminders as part of this request. Preserve existing enforcement commitments.

## What the current source establishes

- `ios/VigilSocial/VigilSocial/SocialNotifications.swift` supports Snapchat,
  LinkedIn, Facebook, X, TikTok, and Reddit web alerts. Instagram is absent from
  `supportedServices`.
- `VigilSocial.webAlerts.services` stores opt-in service names in the app's
  `UserDefaults`. iOS notification authorization is a separate requirement.
  Neither value has been read from the current phone in this preparation.
- `SocialMessageNotificationBridge` intercepts page-created `Notification`
  objects and posts only `{type: 'activity', href: location.href}`. It drops
  the event's title, body, tag, and data. Native delivery therefore cannot
  distinguish a message, call, snap, or shared reel from that payload.
- `deliverWebActivity` requires `UIApplication` to be active and emits
  "New activity in your opened Vigil session." The native bridge also requires
  an allowed first-party route, matching HTTPS frame origin, recent confirmed
  access, and no active restriction. Preserve these checks and private-payload
  isolation in any implementation.
- `SocialWebViewStore.swift` installs the bridge on supported embedded sessions.
  Simply adding Instagram to the list or enabling Snapchat's toggle would
  produce generic activity alerts, not the requested filtering.
- `ios/Shared/PersonalTeam.entitlements` is empty. The current notification
  implementation is local delivery, with no APNs provider or remote social
  notification transport. A local permission toggle cannot supply that transport.

Apple's [web-push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
describes server delivery, subscription handling, and service workers, including
iPhone Home Screen web apps. The [WebKit explanation](https://webkit.org/blog/13878/)
also requires permission through user interaction. These do not establish a
working, filtered background-notification path for Vigil's embedded social
sessions. A proposed alternative must be verified against the existing policy
and free Personal Team path before being treated as supported.

## Work when the phone is connected

1. Read the current phone-suite status, installed combined app, signing receipt,
   and exact supervised policy. Inspect the app's saved alert services, iOS
   authorization, Focus/Scheduled Summary behavior, and available service-level
   notification settings. Record the cause rather than assuming the user
   disabled a particular setting. Do not reset app data or notification consent.
2. Establish whether the actual installed sessions expose a supported delivery
   path for messages and calls when Vigil is backgrounded and when the phone is
   locked. Do not represent foreground local alerts as a background fix.
3. Inspect the services' actual event structure using minimal local diagnostics.
   Find evidence that text messages and calls can be separated from snap/media
   deliveries and Instagram reel shares. Do not guess from "new activity",
   unread counts, or a notification title alone. Keep private message text,
   sender details, media, credentials, and arbitrary destinations out of logs
   and native notification payloads.
4. If a supported solution exists, implement only Snapchat/Instagram contact
   alerts and test filtering before enabling it. Suppress unknown categories
   rather than promoting all social activity to a contact notification. If the
   available events cannot distinguish shared reels from personal messages,
   report that limitation instead of promising an exact filter.
5. Deliver app changes through `npm run agent:update:social` with the normal
   app-and-policy verification. Retain the combined Instagram bundle identifier,
   Safari extensions, sessions, ledger, supervision, non-removable profile,
   BuiltIn filtering, deny rules, and restrictions. Do not unblock native apps,
   add an unfiltered web-app route, add paid signing/hosting requirements, invent
   entitlements/endpoints, or use background-audio tricks to keep polling alive.
6. Verify observed outcomes with the phone open, another app active, and the
   phone locked. The user may arrange incoming test messages/calls; do not send
   messages to other people without explicit authorization.

## Acceptance evidence

For each service, verify a text message and an incoming voice/video call alert.
Verify that a Snapchat snap and an Instagram reel share alone stay silent, as
do stories and promotional activity. Check that a separate text message in a
conversation containing shared media can still alert. Test duplicate events,
disabled permission, and existing access restrictions. Notification taps must
open the filtered service and obey its current access gate.

Record delivery separately for foreground, background, and locked states. Do
not mark the user's reachability problem fixed until the required states and
category exclusions are demonstrated on the phone. No phone update, system
notification change, or enforcement change was performed during preparation.
