# Instagram conversation regression after the October 31 delivery

The user reported missing/gray received posts and Reels, conversation scrolling
freezing, and the conversation jumping down while using app 0.3.219 (222),
delivered from `d4825df`. The screenshot shows the conversation and composer
remaining present while attachment space is empty.

## Reproduction

The preceding interaction fixtures used an ordinary, unpositioned conversation
container. They did not cover a viewport-sized positioned message scroller
inside a retained chat.

`scripts/test-instagram-conversation-webkit.mjs` reproduces the regression using
the production guard and Instagram adapter in WebKit. Before the repair,
`absolute/photo/tap` fails: pressing a received post marks the existing message
viewport `data-vigil-single-reel-scope="p"` and activates containment although no
media viewer has opened. This leaves attachment space present while policy CSS
conceals non-selected media. Scroll containment now applies to the conversation.

A second case was exposed when testing actual opening and closing: after the
real overlay disappears, the retained conversation can become its apparent
replacement, preventing release of the viewer lock.

## Repair

- Capture every eligible existing media viewport at activation time. Existing
  conversation containers cannot become newly opened viewers merely because
  the activation target has a post/Reel permalink.
- Keep that baseline for the full opened-viewer lifetime, including remounts,
  sheets, and closing, so the conversation cannot become a replacement viewer.
- Reject containers that own conversation logs or a message composer. A
  candidate inside the retained conversation, or following its remount, must
  occupy the foreground above the conversation's header and composer. A new
  fixed portal scaling into view can be recognized from its full viewport
  layout; an identity/translation transform alone is insufficient.
- Cancel pending Direct activation when an unpinned gesture becomes a drag.
- Deduplicate ancestor inspection and inspect composer/log roots once per
  discovery, keeping acquisition work bounded by the distinct page ancestors.

Actual opened media retain their viewer containment, comments/Send exceptions,
and existing content filtering. Suggested Reels still return to the originating
chat through the document-bound native route.

## Validation

The new conversation runner has 66 scenarios: absolute, fixed, transformed, and
dialog message viewports; photo and video attachments; taps, swipes, text,
lazy loading, message-list replacement, and whole-chat remounting; plus real
Reel/post opening, containment, and release back to the original scroll offset.

Related maintained suites cover 30 comments/Send interaction cases, 16 decoded
chat-media roundtrips, 26 Suggested-header cases, nine Send roundtrips, and five
comments cases. The production Swift geometry/return-policy runner has 40
checks. Source lint and iOS app/test compilation are also required for delivery.

The final verified adapter snapshot passes all 66 conversation scenarios and
the 40 production Swift checks. Lint passes 533 sources, and the iOS app/test
target compiles. The remaining animation/media suites could not complete after
the Mac locked: the cold/animated fixtures remained at `transform: scale(0)`
because their animation-frame callbacks did not run. `IOConsoleLocked=Yes` was
confirmed. These interrupted suites are not counted as passes for this snapshot.

Logs and the exact verified adapter snapshot are under
`data/instagram-conversation-*`. Physical device inspection was attempted, but
no inspectable page was exposed and CoreDevice subsequently lost the phone's
connection. WebKit fixtures and build checks do not constitute physical swipe
acceptance. Installation and policy/launch verification are recorded separately
by the standard combined app-and-policy deployment receipt. The attempted normal
phone update stopped before installation because the paired device was not
reachable over USB or the local network; the previous deployment receipt remains
authoritative until a subsequent verified update succeeds.
