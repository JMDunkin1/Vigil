# Instagram shared-item containment — October 25, 2026

## Required behavior

Open the item sent in Direct or through a shared link, including a Reel, a
post/photo dump, or the exact shared story. Keep playback, playback taps,
in-post carousel movement, comments, and closing the viewer usable. Do not let
that viewer advance into other posts, Reels, or stories. Ordinary Direct
message scrolling resumes when the viewer closes.

## History reviewed

| Changes | What the code established; lesson retained |
| --- | --- |
| `3c94fcd` | Singular shared Reel routes are allowed while the Reels discovery destination remains permanently blocked. Route containment alone cannot stop a nested scroller before its URL changes. |
| `a99ebde` | Installed the early single-item guard, with video-source pinning and ancestor overflow/snap rewrites. These mechanisms must not be reapplied wholesale to the native Reel player. |
| `296c5e6`, `21e55ef`, merge `32a2347` | Hold-to-recommend containment, post carousels, exact shared stories, route aliases, and Direct modals. Preserve all of these entry paths and the early installation order. |
| `2fafa38`, `327b535` | Corrected card boundaries, ancestor-hidden portals, player remounts, and independently changing poster images. A poster cannot veto a legitimate Reel video. |
| `e5329f5`, `70f2d45`, `c48a1cf` | Released retained Direct attachments and transparent/hidden viewers. Large inline message previews and the thread's own dialog are not an opened viewer. |
| `1accf30` | Stopped freezing/hiding Reel video sources; source changes can belong to the same legitimate player. Its ancestor-locking approach still rewrote overflow and snap geometry. |
| `a59fd48` | Temporarily exempted Reels entirely to recover playback. That also removed containment. Do not repeat the exemption. |
| `ebb1f92` | Restored Reel gesture/route containment while leaving its media untouched. Nested scroll offsets were no longer constrained. |
| `33abcdc` | Restored press-and-hold containment without preventing ordinary click activation. Keep the distinction between propagation suppression and canceling a tap. |
| `37aa322` | Added root `touch-action` to stop native panning. The root is beyond a nested scroll container's panning boundary, so it does not cover all hit targets. |
| `e6fb5ff` | Added document-bound native root scrolling messages and preserved the lock across modal/Direct surface reports. Other transient surface reports could still unlock it; the root WebView is not every nested scrolling element. |

Deployment-only commits record the releases around these changes; they do not
add another containment mechanism.

## Browser research

The [Pointer Events specification, section 8.2](https://www.w3.org/TR/pointerevents3/#determining-supported-direct-manipulation-behavior)
defines panning permissions between the hit element and its nearest scroll
container. It also states that changing `touch-action` after a gesture starts
does not change that gesture. This supports declaring the restriction on viewer
hit targets before a touch, rather than waiting for a six-pixel move or relying
only on the root.

[WebKit's scrolling architecture](https://trac.webkit.org/wiki/Scrolling)
describes asynchronous scrolling and iOS's use of native scroll views. Cancelable
JavaScript movement events alone are therefore insufficient evidence that the
native scroll position is contained.

[WebKit's tapping guidance](https://webkit.org/blog/5610/more-responsive-tapping-on-ios/)
explains how canceling touch release can interfere with ordinary browser click
behavior. Small tap jitter stays uncanceled; its movement is kept away from
Instagram's own gesture handlers. Actual swipes are canceled.

## Implementation decisions

- Declare panning restrictions on nested viewer elements, captions, buttons,
  and empty containers. The comments subtree remains scrollable and contains
  its own overscroll; opening comments does not release the background.
- Allow horizontal native panning only inside the captured original post
  carousel. Retry capturing that original layout if WebKit observes it before
  it becomes measurable. Existing post/story identity and source checks remain.
- Leave Reel video sources, posters, dimensions, overflow, and scroll-snap
  geometry to Instagram. Remember actual scrolling ancestor offsets when input
  begins, after the opened item has aligned, and restore any drift.
- Retain the six-pixel tap tolerance. Suppress smaller movement's propagation
  without preventing the eventual click.
- Accept explicit Direct preview activation without a link. Identify its new
  modal/fixed viewer using viewer dimensions, including landscape media. Exclude
  the originating thread even when it is itself a fullscreen fixed dialog.
- Keep the lock through temporary missing media and replacement Direct portals.
  Hidden/closed viewers release their state and restore the thread.
- Keep native locking authoritative until the item guard explicitly releases
  it. An underlying feed/unknown surface report cannot unlock an open viewer.

## Validation

Passed: 12 targeted iOS Simulator tests, followed by a final two-test Direct
rerun after excluding ordinary profile links from preview activation;
TypeScript typechecking; the social-build regression suite; 48 native route
boundary probes; two story-position tests; browser-fixture syntax checking; and
`git diff --check`.

The targeted iOS Simulator suite covers native root locking, transient surface
reports, route restrictions, sent photos/carousels/stories, Direct modals,
landscape linkless photo/video shares, replacement portals, tiny caption pulls,
tap jitter, source/player recycling, comments, and viewer closure. Its fixtures
use deterministic media where network loading previously delayed completion.

The Electron regression fixture also includes compositor-driven tiny/repeated
swipes starting on video, captions, and buttons; comment scrolling versus the
background; and real video playback through blob-source rotation and a player
remount. The preexisting browser regressions completed earlier during this
change. Extended local runs were terminated or exited before the completion
marker, so the final extended trusted-input fixture is not reported as passed.
CI already requires that marker and cannot treat a silent early exit as a pass.
No enforcement process or restriction was disabled to run tests.

No phone installation, policy migration, supervision change, or live Instagram
session test was performed. Physical-device verification remains necessary when
the phone is connected.
