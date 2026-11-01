# Snapchat full-screen viewer and unread row taps

The supplied IMG_0569.PNG shows the real lightbox header, reactions and
"Reply to Snap" footer. The earlier fixture omitted that footer, so its
full-height outer-lightbox assertion could pass while the actual media was
still shrunk into the upper half of the phone.

Inspected the current public [Snapchat Web entry](https://www.snapchat.com/web/),
[client JavaScript](https://cf-st.sc-cdn.net/dw/02365173525f5f81a3c6.js), and
[stylesheet](https://cf-st.sc-cdn.net/dw/eceeacedbecc23dae201.css). Their hashes,
before/after logs and generated-fictional-media screenshots are retained in
`data/snapchat-viewer-2026-11-01/`. No authenticated messages were accessed.

## Reproduced causes

The `.ecBYF` lightbox is a full-height flex column. Its `.P5ZpW` footer uses
`flex: 1 0 auto`; the inner `.oEzkH` reply row uses `flex: content` and centers
its controls vertically. Giving only the outer lightbox and player 100% height
does not prevent those two growing footer layers from dividing the viewport.
Against the preceding adapter, the expanded fixture measures **318 points of
media and 426 points of footer in a 780-point viewport**.

The current feed row `.O4POs` calls Chat navigation. Its separate enabled
`.w15C2 .HEkDJ.VKjn5` View control calls the existing unread Snap playlist action.
This action is present for Snap-only and mixed Chat/Snap or Snap/reaction rows.
Unavailable mobile-only snaps do not get that enabled class. The previous code
opens Chat exactly once and opens no Snap in the unread-row regression.

## Repair

Within the verified mobile viewer, the original media area occupies the entire
lightbox. The original header and a compact reaction/reply footer overlay it.
The footer's two flex growth rules are removed; its controls retain their
original handlers. A ResizeObserver measures the live footer so playback, mute
and Camera Roll controls remain above it, including when the keyboard or reply
height changes. Portrait and landscape media keep their complete frame using
`contain`; no media node is copied, reparented or center-cropped.

A mobile feed-row click or Enter activation forwards to the existing enabled
View action. Avatar, camera and other nested controls retain their own actions.
Rows without a visible, enabled View action retain Chat navigation. This does
not fetch messages, read private React state, mount a hidden conversation,
invent a playback permission, or mark a Chat read. The forwarded click passes
through the existing policy listeners. Desktop behavior is retained.

Privacy/away/screenshot screens remain in their original hierarchy above the
viewer controls. The live stylesheet gives those screens no z-index, so the
mobile rules explicitly keep them above the overlay controls, including the
screenshot screen rendered beside the lightbox. Spotlight/Discover guards, content classification, media
authorization, native access checks, signing and supervised policy are retained.

## Verification and remaining physical acceptance

`node scripts/test-snapchat-viewer-webkit.mjs` uses native macOS WKWebView with
the production Snapchat restriction and mobile-layout adapters. The new fixture
includes the verified real footer's flex structure and inline desktop media
sizes. It checks 320/390/402/430-point widths, light/dark themes, both desktop
grid arrangements, portrait/landscape photos and video layers, full media
geometry, original reply/reaction/save/playback controls, keyboard-height and
loading phases, all eight reactions, privacy shielding, closing to the feed,
Snap-only/mixed unread activation, keyboard activation, Chat/unavailable/hidden
fallbacks, avatar actions, restricted controls, and desktop restoration.
Both regression scenarios fail against the preceding adapter and pass with the
repair. A third scenario verifies a viewer already mounted at document end,
including both privacy-screen placements with the live auto-z-index styles;
that final stacking check passes. The viewer suite is included in CI. The iPhone XCTest fixture also now
includes the missing growing footer and checks the actual player height.

The four existing call/WebRTC WebKit scenarios, eight received-video safety and
playback scenarios, seven focused runtime suites, runtime build, source lint and
unsigned combined iPhone Release build pass. The iOS simulator runner was killed
before establishing its test connection; no native XCTest execution pass is
claimed. The updated XCTest target passes build-for-testing. All three WebKit
scenarios were rerun against the exact Snapchat source staged for commit and
pass, including the final privacy styles. Earlier reruns while the Mac display
was asleep could not advance their animation frames; those logs are retained
as environmental failures. Production scheduling was not replaced.

The paired iPhone was unavailable during this work. No app/policy installation,
supervision or restore was performed. Physical acceptance remains a received
photo and video opened from the friends list, compact reply controls, and return
to the list after closing, following `npm run agent:update:social` and its exact
live-policy and four-service launch verification.
