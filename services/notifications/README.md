# Vigil notification delivery — prepared, not activated

This service prepares two delivery transports for all eight Vigil services. It
does **not yet provide authenticated Instagram/Snapchat event sources**. A relay,
an enabled toggle, an APNs token, or a successful transport test does not prove
that incoming social messages will reach the user.

Nothing has been deployed, no public origin has been configured, no account
cookies have been exported, and the phone has not been updated by this work.
Enforcement, supervision, the policy transaction, extensions and usage ledgers
remain independent of notification delivery.

## Free path

`receiver/` is a small Home Screen web app. It subscribes to Apple's standard
Web Push service and registers that browser-provided subscription with the
relay. The relay uses VAPID and encrypted `aes128gcm` messages through `web-push`.
No Apple membership, native push entitlement, paid hosting or persistent phone
background process is required. A real HTTPS origin and a running relay/event
source are still necessary. A local Mac relay must remain online; free signing
does not create an always-online server.

The receiver is not a social browser: it has no social account credentials,
message content, arbitrary destination support, cache/fetch handler, or policy
exception. Notification taps open its own fixed page, with a user-gesture link
into the existing gated `vigilsocial://SERVICE` route. The receiver defaults to
Instagram and Snapchat; the other six choices are off. Its choices apply to
this receiver separately from the native app's local-alert settings.

**Filter before sending.** Safari requires received Web Push messages to display
notifications. Do not forward all service traffic and silently discard unwanted
categories in the worker. Only verified message/call events may be ingested for
Instagram and Snapchat; snaps, reel shares, promotions and unknown categories
must be excluded by the source adapter before ingestion. The current generic
ingress contract is not itself a source-specific classifier.

## Optional paid path

The native app implements APNs token callbacks, authenticated registration,
token rotation, preference synchronization, redirect rejection and Keychain
storage. The relay implements ES256 provider authentication and HTTP/2 APNs
delivery for the retained `tech.caseline.vigil.instagram` app. It never borrows
another app's token, topic or signing identity. Incoming calls are ordinary
notification alerts, not VoIP/CallKit calls.

The normal app-and-policy updater accepts
`--push-notifications development|production`. Initially it is `off`; after
activation, updates/renewal retain the deployment receipt's choice. Explicit
`--push-notifications off` restores the free host signing path. The optional
host-only entitlement file preserves the base capabilities and leaves the
Safari, content-blocker and widget extensions' entitlements alone. A requested
push build fails instead of falling back silently when signing fails.

Before installation, the updater checks the actual signed app's
`aps-environment`, Apple's embedded provisioning profile's environment and exact
application identifier, and the runtime configuration. A source entitlement
plist or a build flag is never proof of a grant. An active Developer Program
account, appropriate App ID/profile, and real APNs key are prerequisites; none
are fabricated or enabled here. Default Personal Team signing remains free.

## Configuration and startup

Run from the repository root. All credentials belong in a private environment
or secret store, never command arguments, source, URLs, logs or screenshots.

1. Set `VIGIL_NOTIFICATION_STATE_FILE` to a new private state file. Run the
   compiled `scripts/notification-relay.mjs --initialize` once. It uses exclusive
   creation and refuses to overwrite existing state. Runtime refuses missing or
   damaged state rather than replacing registrations with an empty store.
2. For free Web Push, set `VIGIL_WEB_PUSH_KEYS_FILE` to a private output file and
   run `scripts/notification-relay.mjs --generate-web-push-keys` once. Keep and
   back up this VAPID key pair; do not rotate it casually. Startup validates the
   pair. Its private half never goes to the browser.
3. Configure `VIGIL_NOTIFICATION_ORIGIN` with the actual HTTPS origin (no path),
   and separate random 256-bit hex secrets in
   `VIGIL_NOTIFICATION_PAIRING_TOKEN` and `VIGIL_NOTIFICATION_SOURCE_TOKEN`.
   Pairing credentials cannot ingest events; source credentials cannot enroll
   devices. Paired devices receive their own credential, stored as a hash on
   the server and in Keychain/IndexedDB on the receiving device.
4. Optional native APNs additionally requires `VIGIL_APNS_ENVIRONMENT`
   (`development` or `production`), `VIGIL_APNS_TEAM_ID`, `VIGIL_APNS_KEY_ID` and
   `VIGIL_APNS_KEY_FILE`. These are actual Apple-issued values. Omit APNs
   configuration for a fully free receiver.
5. `npm run notifications:relay` starts the separate service on loopback port
   8789. Put it behind a correctly configured HTTPS reverse proxy at the real
   origin. Static receiver files are served from `/notifications/`. No tunnel,
   domain, cloud account or public service is created by startup.
6. Open `/notifications/` in Safari, add it to the Home Screen, open that saved
   app, enter the pairing code and grant notification consent. Native APNs
   pairing is available in Vigil Settings only in a push-configured signed
   build. Registering a device still does not establish a social event source.

## Trusted event-source contract

`POST /api/notifications/events` accepts only
`{id, service, kind, occurredAt}` with the source bearer credential. `id` must be
an opaque 16–128-character event identifier. The service is one of Instagram,
YouTube, Snapchat, LinkedIn, Facebook, X, TikTok or Reddit. `kind` is `message`,
`call`, or (only for the other six services) `activity`. No title, body, sender,
credentials, media, conversation ID or destination can be supplied. Text alerts
expire after 60 seconds, call alerts after 30. Unknown fields/categories fail
closed. Duplicate reservations are persisted before sending, per recipient;
failed sends can retry within the event's short lifetime. Expired push tokens
are retired. Data is stored with private filesystem permissions.

The source must have an independently verified, authorized, read-only delivery
path from the actual account. Do not guess message/call categories from titles,
unread counts or generic activity, send periodic fake alerts, create hidden
browsing sessions, extend access receipts, or export social cookies to an
unapproved host. No background source adapter is implemented in this change.

## Acceptance before claiming working notifications

Verify a real signed-in incoming text and incoming call for both services while
the phone is locked and while another app is foregrounded. Verify snap/reel-only
shares, stories, reactions and promotions stay silent, and an alert tap obeys
every existing restriction. Check opt-out, consent revocation, token rotation,
relay restart, duplicate events, and offline recovery without stale alerts.
For paid activation also verify the actual APNs environment/token and deployment
receipt. For free activation verify delivery from the installed Home Screen
receiver with Vigil suspended. Do not treat mock tests or compilation as device
acceptance, and do not send test messages to other people without authorization.

References: [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers),
[WebKit Home Screen support](https://webkit.org/blog/13878/),
[APNs registration](https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns),
[web-push library](https://github.com/web-push-libs/web-push).
