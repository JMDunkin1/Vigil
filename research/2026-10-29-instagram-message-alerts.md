# Instagram message alerts

Implemented October 29, 2026. The user requested that this build remain ready
for later installation. It has not been installed or enabled on the iPhone.

## Behavior

- Settings has an opt-in **Instagram messages** toggle. It uses iOS alert/sound
  permission. Denied permission exposes the app's notification-settings link.
- While Instagram is visible in an active Vigil window and its native access
  checks remain valid, the monitor reads the existing signed-in inbox. It makes
  no sends, read receipts, or other account writes. Successful checks are spaced
  fifteen seconds apart; failures back off for sixty seconds.
- Only a newly observed incoming `text` item from another account can alert.
  The thread must be unmuted and not pending, archived, or spam. Shared reels,
  photos, stories, link-card entries, reactions, mixed media payloads, outgoing messages,
  unknown item kinds, and call-history items stay silent. A separate text in a
  conversation containing shared media can still alert.
- First load, account switches, pauses, document reloads, and recovery establish
  a fresh baseline. Old inbox history does not produce a burst of alerts.
- The notification says **Instagram — New message.** Message content, sender
  names, conversation identifiers, and media never enter notification payloads
  or the local status report. Tapping opens the fixed Instagram inbox through
  Vigil's existing navigation and access gates.
- Reminder consent is separate from new message-alert permission. Existing
  authorized installations retain their prior reminder behavior; newly granting
  message-alert permission does not enable scheduled reminders.

## Limits and compatibility

This implements foreground text-message alerts. Incoming calls, voice-message
alerts, and background/locked-phone delivery are not implemented. Do not claim
otherwise from an installed version, granted permission, or a successful inbox
check. Existing Snapchat alert behavior is unchanged.

The read-only inbox route and structured fields come from the
[Direct inbox implementation](https://github.com/dilame/instagram-private-api/blob/master/src/feeds/direct-inbox.feed.ts)
and [response model](https://github.com/dilame/instagram-private-api/blob/master/src/responses/direct-inbox.feed.response.ts).
This is an unofficial compatibility surface, not a guaranteed consumer API.
Live compatibility with the user's signed-in iPhone session remains unverified.
Unsupported responses produce an unavailable status and no alerts. The monitor
uses an existing persisted web app ID only when the site supplies one; it does
not invent credentials, app identities, or endpoints.

Apple's [web-push documentation](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers)
describes Home Screen web-app delivery with a push server and service worker.
It does not provide background push to this embedded session. No push
entitlement, paid service, new hosted endpoint, background-audio workaround, or
policy exception has been added.

## Installation and verification later

Use `npm run agent:update:social` for the normal verified app-and-policy
transaction. Preserve and include completed parallel work deliberately; do not
ship unfinished Explore/suggestion changes merely because they share the tree.
Check the live policy fingerprint, signing receipt, all service launches, and
`npm run ios:phone:check` after installation.

For the user's explicit enable request, the exact native activation link is
`vigilsocial://notifications/instagram`. It enables only Instagram message
alerts, requests iOS consent if needed, and opens the fixed inbox without
granting service access. iOS permission still requires the user's response on
the phone. Alternatively use Vigil Settings → Notifications → Instagram messages.

`Documents/vigil-notification-status.json` contains only permission, opted-in
services, reminder preference, build version, a timestamp, and the coarse
Instagram status (`off`, `waiting`, `ready`, `unavailable`). It contains no inbox
content or account identifiers. Verify `ready` before claiming live compatibility,
then arrange an incoming text and a reel-only share to check actual delivery and
exclusion. Do not send test messages to other people without authorization.

Source: `SocialNotifications.swift`, its settings and app hooks, the native
media-suspension baseline invalidation, and `SocialNotificationsTests.swift`.
`tests/ios-instagram-message-alerts.test.mts` covers seeding, incoming text,
duplicates, media exclusion, outgoing/muted/pending/stale data, account changes,
pause generations, hidden documents, errors, redirects, size limits, and native
policy/isolation checks. Native tests include the isolated WebKit baseline and
strict activation URL parsing. Simulator runtime execution remains a separate
check from compiling the native tests.

Validation completed against an isolated `d7de701` source snapshot plus only
these notification changes:

- Lint passed. Type checking passed in the working tree as well.
- All six new JavaScript alert tests and the existing notification tests passed.
- The combined app and native tests compiled with `build-for-testing` for the
  arm64 iOS Simulator. Native test execution and signed-in phone delivery were
  not verified.
- The full runtime run passed 231 of 238 suites. The seven failures reproduce
  on unchanged `d7de701`: `adult-blocklist`, `adult-marketplace-art-policy`,
  `adversarial-search-policy`, `apple-static-url-precision`,
  `browser-preload-capacity`, `manageengine-profile-export`, and
  `mature-comic-platforms`. These failures have not been changed or hidden.

The shared working tree also contains unrelated Explore, suggestion-filtering,
and release-metadata work. Those edits are not part of this notification commit.
