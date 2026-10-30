# Notification delivery and membership preparation — October 30, 2026

The owner requested working Instagram/Snapchat contact alerts, notification
capability for every Vigil service with only those two selected personally, a
fully free supported path, and optional paid-membership infrastructure for later.
The phone will be connected later. This work is prepared source, not a completed
or installed background-notification fix.

SocialLite's [official iOS FAQ](https://sociallite.app/faq/) confirms message
notifications for Instagram and Snapchat. It does not disclose their transport,
whether every alert is immediate/locked-phone capable, or the exact event
classification. Do not infer their implementation from the feature listing.

## Implemented

- All eight services are represented in native alert settings and the relay.
  A one-time native selection migration selects only Instagram and Snapchat;
  later explicit choices are retained. New native notification consent does
  not enable reminders. Denied iOS permission is not treated as consent.
- Snapchat's actual October 30 public desktop bundle calls
  `ServiceWorkerRegistration.showNotification`, including through its foreground
  duplex listener. The previous bridge only handled `new Notification` and the
  compatibility bootstrap left `serviceWorker.ready` pending forever. The
  notification bootstrap now precedes that fallback and supports the foreground
  notification API without installing workers or intercepting network requests.
- Snapchat classifications use the public site's numeric structured types:
  chat/mention/reply 201/205/206 and 230/234/235; initiated calls
  1250/1252/1270/1272. Snaps, typing, reactions, abandoned calls, unknown types
  and generic titles do not become contact alerts. Message text, sender,
  options.data and arbitrary links do not cross the bridge. Native access,
  main-frame origin, recent confirmation and foreground checks remain intact.
- The existing isolated Instagram foreground text monitor remains in place.
  This change does not claim a new Instagram incoming-call source.
- A separate, optional relay and Home Screen receiver implement the free Web
  Push transport. Optional native APNs support, Keychain registration and
  profile-verified paid signing are also prepared. See the
  [service instructions](../services/notifications/README.md).

## Remaining blockers

Neither service yet has a verified background event adapter feeding the relay.
The generic event-ingestion endpoint is infrastructure, not proof of that source.
There is no deployed HTTPS receiver, relay configuration, real subscription,
paid account configuration, account-cookie export or phone installation from
this work. Locked-phone delivery is unresolved until a legitimate source and
real receiver are configured and tested. Simply plugging in the phone will not
automatically complete the server/source work.

Use the phone to inspect the current sessions and consent and collect only
minimal structured evidence needed to validate actual message-versus-media and
call events. Preserve sessions and the normal verified app-and-policy updater.
Do not keep hidden browsing sessions alive, loosen access gates or supervision,
or restore/re-enroll the phone for notifications. App-only deployment is not an
acceptable shortcut. No real message/call was sent as part of testing.

## Other useful membership capabilities

Membership readiness is not a blanket entitlement grant. Vigil already has
optional Sensitive Content Analysis and Enhanced system URL Filter code; retain
their existing capability checks and fail-closed policy verification. The push
entitlement generator preserves the base host entitlements instead of replacing
them. Future App Groups could support a protected shared app/extension ledger,
but need actual group grants and a verified ledger migration; no group identity
or empty-ledger fallback has been introduced. Universal Links would need a real
owned HTTPS domain and association file. Screen Time/Family Controls and Network
Extension capabilities may require additional Apple approval; a membership
alone must never mark those features available.

APNs activation is separate from the Personal/Enhanced **policy edition**: a
paid account can enable the optional native push transport while retaining the
Personal supervised policy and free fallback. Existing policy restrictions,
filters, Safari extensions and per-service launches must still be verified.

## Validation

- Runtime build and type checking passed. Full source lint passed.
- The seven focused runtime suites passed 21 tests, including notification
  isolation/filtering, native-build contracts, free Web Push registration,
  cross-device authorization, expiry, retries, opt-out and duplicate delivery.
- The app/extensions and native tests compiled for the simulator. All seven
  `SocialNotificationsTests` passed on an isolated iOS 27.0 simulator. The older
  inbox fixture needed to wait for its own document, rather than the initial
  blank document; it supplies a lexical first-party location for the isolated
  synthetic inbox. Production origin checks were not loosened.
- The new production dependency tree reported zero known npm audit findings.
- Paid signing, actual APNs/Web Push delivery, the receiver's Home Screen setup,
  real social event sources, and locked-phone behavior remain unverified. No
  complete runtime-policy regression run or phone deployment was performed.
