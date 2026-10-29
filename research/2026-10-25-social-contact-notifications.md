# Snapchat and Instagram contact notifications

Prepared October 25, 2026; rechecked against the newer source on October 29,
2026. The user will connect the iPhone later. This records the requested behavior
and the checks needed before changing the phone; it does not represent an
implemented or installed notification fix.

## October 29 current-version preparation

Source baseline: `c1937304cfb0efcbc88bb0988867fa86ae68484d` (Instagram carousel
loading and friend-feed recovery). This includes the intervening Instagram
recipient-search, Snapchat portrait-capture/photo-group saving, launcher, and
rendering/memory/network improvements. Continue from the current checkout when
the phone arrives; do not restore the October 25 tree or an older app artifact.

The notification implementation, its native and JavaScript regression tests,
and Personal Team entitlements have no changes between the original preparation
commit `99bfbdf` and this baseline. No notification patch needs to be ported from
October 25: that commit contained preparation only. Instagram contact alerts,
message-versus-media classification, and background delivery are still absent.
The latest compatibility changes do not establish those capabilities.

The current bridge in `SocialWebViewStore.swift` still requires unsuspended
playback, a service-access confirmation less than ten seconds old, and no active
restriction. Do not keep hidden sessions running or extend access receipts to
obtain notification delivery. Recent efficiency and lifecycle changes must be
preserved along with the camera, recipient-search, and feed fixes.

At this check, the existing, uncommitted `ios/phone-release.json` labels the
suite `0.3.227 (230)` and the combined Instagram-bundle app `0.3.207 (210)`.
These are separate version fields, not evidence of the phone's installed
version. The pending release file belongs to other work and was left intact.
The current Personal-edition implementation fingerprint was
`62b9eab6394190244ec20075e951649e2b81bea39c6b6dbb80c54a14da33cc76`, while the
pending release records
`0200fd8a03cd7ec4e934477fe8d78074d5ecb906b9655d019cb4e46ddaed1df3`.
This mismatch needs normal release reconciliation before a verified deployment;
do not edit fingerprints by hand or assume an existing build is current.

Recheck the live inputs immediately before phone work, as ongoing changes and
the active blocklist can change the fingerprint:

```sh
node scripts/ios-phone-suite.mjs fingerprint --edition personal
npm run ios:phone:status
```

The first command is an offline source check. Run phone status after connection
and inspect the persisted edition and live policy before any update. If app or
policy changes are needed, use `npm run agent:update:social`, then
`npm run ios:phone:check`. Retain a verified newer source tree; do not pin an
update to either version number or fingerprint above. No release bump, phone
installation, signing change, or policy change is part of this preparation.

Validation of this baseline:

- `node --experimental-strip-types tests/ios-social-notifications.test.mts`
  passed: opt-in behavior, live permission revocation, persistent permission
  script replacement, native access/origin checks, and private-payload isolation.
- The `VigilInstagram` combined app and extensions compiled for the arm64 iOS
  Simulator with Xcode 27.1 and the normal combined-app bundle/launcher settings
  (`CODE_SIGNING_ALLOWED=NO`, `VIGIL_SERVICE=all`). The resulting app reports
  `tech.caseline.vigil.instagram`, version `0.3.207 (210)`, and service `all`.
  Its Activity, YouTube controls, and Shorts blocker extensions retain the
  `.instagram.activity`, `.instagram.youtube-controls`, and
  `.instagram.shorts-blocker` identifiers. This is an unsigned simulator build,
  not a signed or installed phone release.
- Native notification, Snapchat startup, access-gate, and Personal Team
  entitlement tests were attempted on isolated iOS 27.0 simulators. Xcode 27.1
  could not launch the test host; a boot-completed retry using Xcode 27.0 beta 3
  encountered repeated `DTServiceHubClient` simulator service-connection errors.
  Neither run reached test execution, so native tests are not marked passed.
  The stalled test invocations and only the temporary simulators created for
  them were cleaned up. No global simulator/toolchain settings were changed.

These checks validate the existing implementation. They cannot establish actual
incoming-message, incoming-call, media-exclusion, or locked-phone delivery; those
remain the device acceptance checks below.

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
