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

The initial snapshot passes 163 WebKit scenarios (including the eleven new live
layout cases), 42 production Swift geometry/return/activation checks, lint of
534 sources, and iOS app/test compilation.

## Physical follow-up and remaining comments failure

A subsequent verified combined update installed Vigil Social 0.3.223 (226),
phone release 0.3.243 (246), with the exact existing supervised policy and all
eight service launches verified. The user reported that the interactions were
working during their trial, then reproduced the intermittent comments freeze.
This is not physical acceptance of the comments behavior.

The updated app did not expose an inspectable page when launched using only
`DEVICECTL_CHILD_VIGIL_WEB_INSPECT=1`. No frozen-drawer DOM snapshot or usable
native geometry was captured. A debugger attempt failed without obtaining that
evidence. The user needed to leave and was told they could unplug; subsequent
investigation continued offline. The earlier comments capture describes a
working drawer, not the frozen one.

Offline reproduction found two concrete failures:

- Inserting a 260-by-300 image or video into an already verified comment list
  revoked the drawer marker and reduced native scrolling regions to zero.
  Even an offscreen image could do this. Discovery treated the added comment
  media as proof that the containing drawer was a media viewer.
- Covering and uncovering the drawer could transfer viewer ownership from the
  snapping rail to one of its own positioned video wrappers. The rail then
  lost its containment scope despite retaining a nominal Reel pin.

The repair retains the exact previously verified comments root while it has a
live comment composer and owns foreground hit targets. Hidden, covered,
disconnected, or repurposed roots lose their exception. A cached root can recover
after the original activation expires; disconnected roots are pruned. Fresh
drawers retain the existing strict media-free discovery. A connected viewer
cannot transfer its rail ownership to its own descendant during a sheet
transition. These changes do not authorize additional Reel scrolling or alter
content-filter decisions.

Eight added behavior cases cover lazy image/video content, offscreen media,
semantic drawers and heading replacement, cached hide/reveal, covering pickers,
and a former drawer reused for media. An Add a comment action button without a
real editor cannot retain the media exception. The lazy-image case fails on the preceding
implementation; the new cases pass with the repair. These are confirmed local
regressions, not proof of the exact cause of the user's uncaptured frozen state.

The normal verified phone-update launch now passes an explicit CoreDevice
`--environment-variables` argument when `VIGIL_WEB_INSPECT=1` (or its legacy
`DEVICECTL_CHILD_` equivalent) is supplied. Only that diagnostic flag is forwarded;
ordinary updates do not enable inspection. The next physical update and
comments acceptance remain pending while the phone is unplugged.

The repaired snapshot passes 164 WebKit behavior cases: 19 mobile Direct,
66 conversation, 25 interaction, 16 decoded-media, 25 Suggested, nine Send,
and four comments cases. It also passes 42 native geometry/return/activation
checks, phone-updater unit checks, lint of 534 source files, the TypeScript
build, and iOS app/test compilation. Seven animation-dependent cases remain
unverified on this snapshot: the Mac locked during the run and WebKit stopped
delivering animation frames. The failed fixtures remained in their initial
animation classes; their conditions were not changed to make them pass. The
other scenarios were rerun with their original assertions. These limitations
and the missing physical acceptance must not be reported as successful checks.

The prepared combined app is 0.3.224 (227), phone release 0.3.244 (247). It has
not replaced the installed 0.3.223 (226) until a later verified phone update.
