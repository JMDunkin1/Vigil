# Instagram Reel, comments, and recipient interaction boundaries — October 30, 2026

The user reported intermittent uncontained Reels, frozen comments and recipient
circles, and repeated taps before recipient-search keyboard focus stays active.
This investigation follows the native-pan, comments, recipient-touch timing,
and Send-dismissal fixes from October 26–30. Their individual regression tests
remain necessary, but did not cover these combined paths.

## Reproduced failures

The new maintained fixture fails against the pre-change production adapter in
six independently selected cases:

- `release`: a Direct preview presents its viewer on pointer release, before
  click. The old guard only records the activation on click, so it misses the
  new portal or records that portal as the already-existing one. The new guard
  captures the conversation, origin, and prior viewer before activation and
  keeps that snapshot through the click/history sequence. A preview moved out
  of its original conversation into the viewer is also supported. Cancelled
  activations cannot authorize a later viewer; ordinary chat remains scrollable.
- `recipient-animation`: the search control moves outside its last native
  rectangle during a CSS opening transition. Geometry was refreshed only at
  the transition boundaries. A bounded animation-frame refresh now publishes
  the current sheet rectangles through opening, focus, and layout changes;
  identical native messages remain deduplicated.
- `recipient-nested`: the search area is a nested dialog while the recipient
  circles are its siblings. Requiring the search input to belong directly to
  the closest dialog leaves the surrounding picker frozen. A media-free outer
  picker can now own the complete interaction. Transparent full-screen
  backdrops, the originating conversation, and wrappers containing the pinned
  viewer cannot acquire that permission.
- `recipient-reused`: React reuses a previously locked Reel scroller as a
  foreground recipient panel inside the viewer. Background containment still
  restores its obsolete scroll position. A verified sheet drops that stale
  captured offset; its own scroll container stays usable.
- `keyboard-ancestor`: keyboard focus scrolls a shared ancestor of the Reel and
  recipient sheet. Restoring the Reel's old offset on that ancestor immediately
  reverses the focus adjustment. While the sheet is visible, preserve its
  ancestor's focus adjustment and continue enforcing the Reel's own scroller,
  background gesture boundary, and item-navigation policy. Closing the sheet
  restores the ordinary containment behavior.
- `comments-press`: a Comments control opens on pointer release rather than
  click. The Reel guard suppresses that release along with media hold gestures.
  Exact semantic Comments/Send/Share controls now keep their complete press
  lifecycle. Movement and navigation into another Reel still remain blocked.

These are local reproductions, not a captured DOM trace of the user's phone.
They establish concrete failures that match the symptoms without claiming all
live Instagram variants have been observed.

## Additional containment checks

A retained opaque wrapper around an aria-hidden viewer must not become either
an unrestricted recipient sheet or a replacement media viewer. The fixture
caught the latter through recipient avatars in the anonymous-portal fallback.
Replacement detection now requires active media outside the foreground sheet,
and ignores avatar-sized images. Visible retained viewers still own their lock
even if their media temporarily disappears during remounting.

Native sheet rectangles are prioritized ahead of individual inputs within the
existing 24-region limit. The native recognizer's touch-down decision, carousel
permission, gesture priority, and background cancellation remain unchanged.
The CSS ancestor exceptions, Instagram's drawer dimensions, grip touch-action,
playback sources, and normal input focus are preserved.

## Sources and design constraints

The [Pointer Events specification](https://www.w3.org/TR/pointerevents/#the-touch-action-css-property)
describes ancestor touch-action evaluation and the fixed decision during an
active direct-manipulation gesture. Its [event ordering](https://www.w3.org/TR/pointerevents/#compatibility-mapping-with-mouse-events)
places pointer release before click. These support establishing boundaries
before activation and updating geometry before the next gesture, rather than
trying to repair an already-cancelled touch.

Apple's [gesture-recognizer documentation](https://developer.apple.com/documentation/uikit/uigesturerecognizer)
and [keyboard notification documentation](https://developer.apple.com/documentation/uikit/uiresponder/keyboardwillshownotification)
cover native cancellation and keyboard animation. They support the lifecycle
constraints; they do not prove the user's live keyboard symptom is resolved.

## Validation and delivery

Run `node scripts/test-instagram-interactions-webkit.mjs`. An optional first
argument selects an adapter snapshot; an optional second selects one fixture
mode for before/after checks. CI runs the complete suite.

The fixture is shared with the iOS XCTest
`testInstagramInteractionBoundariesAcrossActivationSheetsAndKeyboard`.
Sixteen combined cases check release/click ordering, anonymous viewers, real
permalink previews, moved previews, animated recipients, nested recipient
search, transparent and retained backdrops, retired sheet markers, reused recipient/comments scrollers,
Comments/Send press activation, keyboard ancestor scrolling, cancelled openings,
and ordinary chat. Each permitted viewer is also checked for blocked background
wheel/swipe/Next/navigation and actual viewer closure.

Validation is repeated in a clean temporary snapshot containing only this
Instagram change over HEAD. Concurrent Snapchat edits in the shared Swift files
and unrelated phone-release changes are preserved and excluded. The clean
snapshot path is recorded in `data/instagram-interactions-validation-root.txt`.
Local results use the `data/instagram-interactions-*` prefix.

Final clean-snapshot checks pass: 16 new combined WebKit scenarios, all 9 Send
roundtrip cases, all 5 comments cases, and all 16 chat-media cases (46 total).
Source lint checks 524 sources; the runtime build and all three social
build/container/route suites pass, including 48 native route-policy probes.
The iOS app and XCTest target compile with `build-for-testing` and signing
disabled for simulator artifacts. This is compilation, not native execution.
The clean build uses the existing local YouTube connection resource through
`VIGIL_YOUTUBE_CONNECTION_FILE`; no connection or endpoint is generated.

The paired physical iPhone is unavailable in CoreDevice. A native simulator
attempt failed before the test connection was established, and a subsequent
probe reported that the installed iOS 27.0 runtime path was unavailable. Native
execution and a real iPhone software-keyboard/touch check are not recorded as
passing. Generic iOS app/test-target compilation is checked separately.

No phone installation was performed. Delivery must use the combined
`npm run agent:update:social` verified app-and-policy transaction, followed by
real-device checks of repeated Reel openings, comment expansion/scroll/dismiss,
recipient-circle scrolling, and first-tap keyboard persistence. No supervision,
signed profile, watchdog, or policy transaction is changed by this patch.
