# Instagram: cold Direct viewers, native coordinates, and Suggested Reels

The user confirmed that the prior repair did not resolve the original problems,
that failures occur in Direct, and that newly entered chats/new app sessions make
scroll containment less reliable. They also identified the top-left “Suggested”
label as evidence that the viewer has entered recommendations. The phone could
not be connected during this follow-up.

## The previous repair was installed

Before editing, `socialAppImplementationFingerprint('instagram')` exactly matched
the deployment receipt: `a377d5023514527be646ece42e51044a3f93d17b2b366610a67b7a6e4316c676`.
The receipt records combined app **0.3.216 (219)** deployed October 30 at
**5:33 p.m. Eastern**, after commit `6874a58`. An outdated installation does not
explain this report. The current physical DOM and native gesture stream were
not available for inspection.

## Reproduced cold-opening failures

1. A viewer beginning at `scale(0)` has no eligible rectangle when the DOM
   observer first runs. Its later animation frames do not mutate the DOM. The
   previous guard can therefore miss the opening until unrelated work changes
   the page. A bounded frame acquisition now follows a completed Direct
   activation, and media/layout transitions re-arm acquisition while that intent
   remains valid. An independently positioned transformed viewer's full layout
   dimensions identify it as soon as its first pixels become visible; the lock
   no longer waits for its measured animation rectangle to reach 60–72% size.
2. Lazy hydration can remove the newly pinned portal in one frame and mount its
   replacement in a later frame. Previously that cleared both pin and intent,
   leaving the replacement unguarded. Preserve the existing pin through a
   bounded 1.5-second opening interval, with a scheduled expiry. A real Close or
   Back activation disarms this interval. Tests require an explicit close to
   release within 300 ms and an abandoned viewer to release after the bounded
   hold; a retained conversation cannot become the replacement viewer.
3. A preview can expand into a positioned viewer while remaining inside its
   conversation. Blanket rejection of every candidate containing the activation
   target excludes this viewer. The guard now distinguishes a promoted child
   from the actual retained conversation or an ancestor containing that
   conversation. Both semantic and anonymous portal variants are covered.

`cold-release`, `cold-remount-release`, and `inplace-release` fail against saved
pre-change adapters. Cold fixtures require containment before the opening
animation finishes; merely locking a settled viewer is insufficient.

## Comments, recipients, and keyboard coordinates

- Recipient search can be a contenteditable/ARIA searchbox rather than an
  `input`, and Send can mount a positioned anonymous panel. Recognize these
  forms using visible search evidence, an explicit recent Send/Share activation
  or the same previously verified root, independent panel bounds, and the
  existing rejection of media viewers, thread roots, and transparent backdrops.
  Unrequested search panels cannot gain the anonymous exception. Reused panels
  lose their marker when their recipient evidence disappears.
- Retained hidden comments dialogs/composers consumed the discovery budgets
  before a new sheet was examined. Filter hidden/inert/accessibility-hidden
  candidates before applying those budgets. Thirty-six cached drawers reproduce
  the old failure. Recipient discovery likewise filters visible candidates
  before its bounded search.
- Foreground hit testing clamped layout-client coordinates to a visual viewport
  beginning at zero. Keyboard panning can give that viewport a nonzero offset.
  Hit testing now uses the actual visible intersection in layout coordinates,
  and native exception rectangles are clipped to that visible area.
- Native touch coordinates previously divided Y by the *current native height*,
  although cached rectangles belonged to WebKit's *layout viewport*. For an
  input at CSS Y=300–360 in a 390×844 layout, shrinking the native height to 500
  rejects an input touch at Y=320 and incorrectly permits a background touch at
  Y=200. The bridge now carries validated layout viewport dimensions. Native
  normalization scales both axes using width, preserving the same CSS points
  across a native-only height transition. Invalid dimensions grant no regions.
  The existing original-touch decision and carousel axis rules remain intact.

Apple documents [SwiftUI's keyboard-driven resizing](https://developer.apple.com/documentation/swiftui/adding-a-background-to-your-view)
and [the keyboard safe-area region](https://developer.apple.com/documentation/swiftui/safearearegions/keyboard).
WebKit documents [client/layout coordinates for elementFromPoint](https://www2.webkit.org/show_bug.cgi?id=172019).
These constrain the implementation; they are not a trace of the user's phone.

## Independent Suggested Reels block

A foreground, viewport-sized media surface with a top-left **Suggested** or
**Suggested Reels** header is quarantined even if no shared-item pin was
acquired. Detection requires substantial foreground video and the actual
foreground label. Semantic main-page rails additionally require a real header
and exclude Direct message composers. Ordinary chat text, clickable captions,
recipient lists, covered or hidden headers, and retained conversation roots do
not establish a recommendation surface. Pointer-transparent video, animations,
and a keyboard-panned visual viewport are covered.

The guard immediately hides the recommendation surface and pauses its media.
A document-bound native message activates a separate block state, suspends the
WebView's media, removes native scrolling exceptions, and prevents an ordinary
resume or stale viewer-unlock message from releasing the block. The native UI
shows only **Blocked**, **Back**, and `V1-SOC-INSTAGRAM-REELS`; its accessibility
hint contains the full restriction. The diagnostic label is not authorization.

Back loads the existing trusted Direct route, or Instagram's Direct inbox as a
fallback. The block remains until a new trusted document binds. A committed
trusted authentication document also releases this state because authentication
pages deliberately omit the injected page bridge. Suggested detection is
replayed after document binding so a cold document cannot lose its first block
message. No new endpoint, entitlement, or access permission is introduced.

## Verification and limits

Maintained runners:

- `node scripts/test-instagram-interactions-webkit.mjs`
- `node scripts/test-instagram-suggested-webkit.mjs`
- `node scripts/test-instagram-native-geometry.mjs`

The WebKit runners share fixtures with iOS XCTest. The geometry runner extracts
and executes the actual production Swift coordinate/parser methods using
CoreGraphics; it does **not** simulate UIKit touch delivery or a software
keyboard. Its input-after-resize check fails on the preceding Swift method.
The Suggested suite also fails against the preceding adapter.

Final isolated validation passes **75 WebKit scenarios**: 30 combined
interaction cases, 15 Suggested-surface cases, 9 Send roundtrips, 5 comments
cases, and 16 chat-media cases. All **19 production Swift geometry/parser
checks** pass. Lint checks 532 sources; runtime build and the three social
build/container/route suites pass, including 48 native route-policy probes.
The iOS app and test target compile with `build-for-testing`. The verified
snapshot's app source, fixtures, and runners exactly match this working patch.
These checks were completed before the subsequent commit and deployment request; installation is verified separately by the delivery receipt.

The new native XCTest cases cover coordinate resizing, malformed viewport
metadata, the production message bridge, and the Suggested block lifecycle.
XCTest execution still failed before establishing the test connection. A
separate temporary simulator-only host also exited without a completion result;
it is not counted as a pass, and its experiment is retained under
`data/instagram-oct31-native-experiment/`. No simulator keyboard/swipe or physical
phone acceptance result is claimed.

Validation runs in an isolated snapshot of committed HEAD plus this Instagram
patch, excluding concurrent unrelated work. Its path and base commit are in
`data/instagram-oct31-validation-root.txt` and
`data/instagram-oct31-validation-base.txt`. Logs use
`data/instagram-oct31-*`; final WebKit results use `verified-*`.

The phone is unavailable and the user cannot connect it now. Installation and
real-phone acceptance remain outstanding. Delivery must use the normal combined
`npm run agent:update:social` verified app-and-policy transaction. This follow-up
does not change supervision, profiles, signing requirements, or watchdogs.
