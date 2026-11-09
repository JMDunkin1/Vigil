# Instagram unread DM badge startup refresh

The user reports that Home never shows an unread DM badge on a fresh app launch,
but visiting the inbox and returning makes the count appear. The supplied
screenshots show two unread inbox rows and a badge of two after that visit.
They do not capture the failing startup. Physical inspection is unavailable:
CoreDevice reports the paired phone unavailable and usbmux lists no devices.
The user requested a source change and will install the update later.

The captured first-party client uses `IGDBadgeCountOffMsysQuery` and
`useIGDSystemFolderUnreadThreadCountFromFragment` for navigation badges. The
query hydrates the INBOX thread connection shared with Direct; the hook counts
unread, unmuted threads and applies Instagram's hidden Meta AI filtering. The
exact reason the phone's initial badge request fails or stays stale remains
unconfirmed. This change adds an explicit startup refresh of that connection;
it does not claim a reproduced Meta client root cause.

`instagramInboxBadgeBootstrap` waits for Home's Messages navigation link and
loads the current client's badge query, Relay environment, device identity and
user modules through its module loader. `CometRelay.fetchQuery` requests the
unchanged live query with its real device variable and normalizes the response
into the store read by Instagram's existing badge. There are no hardcoded query
IDs, custom message requests, invented counts, badge DOM edits, navigation, read
receipts, or message writes. Existing mute/unread rules and mailbox subscription
components remain Instagram-owned.

The refresh runs on visible Home startup and eligible foreground/online/Home
return events, coalesces duplicate events, and throttles successful refreshes.
Loader/request work has a 15-second overall deadline and at most three attempts.
Hidden documents, route departure and pagehide cancel active subscriptions.
Per-attempt identity rejects stale module callbacks, duplicate callback delivery
and errors from cancelled requests. Unknown module shapes fail without altering
the page. Diagnostics expose status and request count only.

Validation includes seven runtime lifecycle/recovery tests, three offscreen real
WebKit document-start scenarios (two unread, zero unread and delayed runtime),
existing outgoing-unread/Notifications/notification-isolation tests, TypeScript,
repository lint, and an unsigned combined iOS Simulator build. The WebKit
scenario uses a fictional mailbox and a simulated Relay publication to prove
startup timing and badge-store refresh; it is not a live account acceptance
test. The existing message-alert suite also has a pre-existing source assertion
that incorrectly requires alert invalidation to be the first statement in
`suspendAllMedia`; the call lifecycle now precedes that unchanged invalidation.

The startup WebKit regression is included in CI. Installation, policy changes
and phone operations were deliberately left for the user. A subsequent physical
acceptance check must cold-open Instagram Home with unread DMs and observe the
badge before entering Messages.

Relay documents that `fetchQuery` saves results in the shared store and notifies
subscribed components, supports cancellation through `subscribe`, and should
process incremental payloads with `subscribe` rather than `toPromise`:
<https://relay.dev/docs/api-reference/fetch-query/>.
