# Live Instagram Direct inspection after f38fa24

The user reproduced the remaining problems on app 0.3.220 (223). This time the
installed app was launched using its existing paired-developer
`VIGIL_WEB_INSPECT=1` opt-in. Read-only WebKit inspection captured the real Reel,
comments, recipient picker, and keyboard focus sequence. Page protections were
kept active. Captures remain in ignored `data/instagram-live-*` files; message
text, search input values, cookies, and authentication storage were not collected.

## Confirmed live mismatches

The Suggested Reel remained completely unpinned. The URL still belonged to its
Direct thread. The video measured 402 by 688 CSS pixels in a 402 by 758 page.
Its rail was a static flex container with `overflow-y: scroll` and
`scroll-snap-type: y mandatory`. The card used `scroll-snap-align: center`.
The outer fixed app shell was about 20 ancestors above the video and already
existed as part of the chat. Neither the rail nor its cards had dialog semantics.
A transparent interaction element beside the video intercepted hit tests.

The visible Suggested badge was at approximately (44, 39), inside the current
snap card. It was an ordinary span, without a heading ancestor. The previous
generic modal and label logic missed this real layout despite passing the
dialog-based fixtures.

The working anonymous comments drawer was marked correctly and occupied
(0, 156, 402, 758). The intermittent freeze did not reproduce during inspection.
The new coverage retains the same verified drawer through a heading remount
and searches the nesting depth used by the live page.

The marked Send dialog measured only 40 pixels wide while the visible Search
input was roughly 261 pixels wide at x=48. Exempting the small semantic host
does not cover the real picker. The new discovery rejects undersized hosts,
walks enclosing verified roots, and recognizes the media-free visual picker
following a real Send activation.

The keyboard trace repeatedly showed `focusin(INPUT)`, followed by a resize
from page height 758 to 396 and immediate `focusout(INPUT)`. The keyboard then
closed and the page returned through 724 to 758 pixels. This occurred while
the Reel guard remained unpinned. It therefore cannot be explained solely by
the custom pan recognizer. A native debugger read did not produce usable frame
evidence and is not counted as confirmation of the exact UIKit bounds.

## Changes

- Recognize the foreground snap rail from its full-size snap card, vertical
  snapping, and card-owned foreground hit targets. Recognize it even if the
  original short activation window has elapsed. A retained message list is
  still excluded by conversation structure and media dimensions.
- Own the rail rather than an individual positioned video wrapper. Retain its
  initial scroll position and the conversation baseline through closing and
  remounting. A retained rail covered by the chat loses foreground ownership.
- Detect the exact foreground, upper-left Suggested badge within the current
  snap card, then return to the originating chat using the existing native
  document-bound transaction. Editable content, messages, captions, offscreen
  labels and covered labels remain excluded.
- Grant Send exceptions to the actual visible picker rather than its small
  semantic host. Keep media-bearing and unrequested anonymous search surfaces
  outside these exceptions.
- Include foreground Comments, Send and Back button geometry in the native
  boundary so tap jitter does not cancel their press lifecycle. Explicit Back
  outside the rail disarms the opening hold immediately; JavaScript still
  contains vertical gestures on the Reel. These activation regions are separate
  from scrolling regions and cannot enable the underlying WK scroll view.
- Preserve a verified comments drawer through temporary heading replacement,
  and avoid rewriting unchanged sheet markers on each reconciliation.
- Ignore SwiftUI's keyboard safe area for the selected Instagram canvas only.
  WebKit retains responsibility for its keyboard visual viewport. This targets
  the native resize/focus cycle without synthetic refocusing or keyboard hacks.

Apple documents that SwiftUI normally resizes/positions views to avoid safe
areas, and that the keyboard is a separate safe-area region:
[keyboard safe area](https://developer.apple.com/documentation/swiftui/safearearegions/keyboard),
[ignoresSafeArea](https://developer.apple.com/documentation/swiftui/view/ignoressafearea(_:edges:)).
The keyboard result must be checked on the physical phone after installation.

## Validation

`scripts/test-instagram-mobile-direct-webkit.mjs` adds eleven behavior cases using
the observed nested static rail, sibling interaction overlay, ordinary badge,
unlabelled retained chat composer, and 40-pixel dialog host with a full visual
picker. Its first containment case fails against f38fa24 and the new suite passes
with the repair. Existing conversation, comments, Send, Suggested-header,
decoded-media, native geometry, lint, and app/test compilation checks are also
run before delivery. Physical acceptance is reported separately from these
fixtures and from policy/launch verification.

The final snapshot passes 163 WebKit scenarios (including the eleven new live
layout cases), 42 production Swift geometry/return/activation checks, lint of
534 sources, and iOS app/test compilation. The iPhone became unreachable after
the captures; the new build is not installed or physically accepted until a
subsequent verified combined update succeeds. That update should use the
documented `DEVICECTL_CHILD_VIGIL_WEB_INSPECT=1` developer launch environment so
the unchanged protections can be inspected during the physical follow-up.
