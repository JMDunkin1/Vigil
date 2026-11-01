# Sent Instagram messages appearing unread — November 1, 2026

The supplied screenshot shows an Instagram inbox row with an outgoing preview
and a blue unread dot. It does not show an iOS notification banner. The paired
phone was unavailable for inspection. The user explicitly requested preparing
the repair now and installing later.

Instagram's current public web bundle contains
`XFBIGDirectViewerThreadIsUnreadResolver`. Its decision compares the thread's
last activity with the current viewer's receipt, or honors `marked_as_unread`.
It does not check the activity's sender. `IGDInsertSlideMessageToInbox` advances
that activity timestamp when a message is inserted. This reproduces the false
unread result for an outgoing message newer than the viewer's read watermark;
it is not a capture of the phone's exact account state.

The new document-start compatibility script wraps that resolver. It reads the
original fragment plus optional, already loaded Relay inbox/conversation
connections. At least one connection must contain the latest activity's exact
message timestamp and reach the viewer's watermark. Every loaded message after
the watermark must belong to the current viewer. Any incoming, malformed,
missing, partial, conflicting or newer evidence preserves the original result.
An explicit `marked_as_unread` is always honored. Separate partial connections
cannot establish coverage together.

The correction applies at the shared unread resolver used by inbox rows and
unread counts. It never uses preview text, alters messages or read receipts,
sends read acknowledgments, makes network requests, or persists account state.
The original resolver still runs with its receiver and arguments. Relay caches
the first fragment read during evaluation, so the expanded fragment must be read
first to retain the additional evidence and its update subscriptions.

Validation passed:

- Seven new regression groups, plus the existing message-alert and activity
  checks: 14 Node test results passed.
- `node scripts/test-instagram-unread-webkit.mjs`: actual WebKit document-start
  injection subscribes after the parser creates the loader and repairs the first
  parser-time query. Incoming messages, manual unread, older unseen incoming
  messages and unchanged receipts are checked.
- Actual Relay runtime 21.0.1 with the downloaded Instagram resolver: optional
  missing connection, outgoing correction, incoming subscription invalidation,
  explicit unread, absent-history fallback, zero requests and unchanged receipt.
  The temporary harness and public bundle captures are in
  `/tmp/vigil-instagram-unread/`.
- Existing comments WebKit runner: five cases passed after adding the shared
  runner's optional document-start mode.
- TypeScript checking, source lint, whitespace checks, and iOS app/test
  `build-for-testing` succeeded. Build log:
  `/tmp/vigil-instagram-outgoing-unread-build.log`.

Installation and physical acceptance remain pending. No updater, policy,
supervision, watchdog, signing or enforcement change is part of this repair.
Insufficient loaded history deliberately retains Instagram's unread marker;
the live phone must verify whether its affected row supplies the required data.
