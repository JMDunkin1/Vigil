# Instagram photo gestures and recipient search — October 26, 2026

The user confirmed that ordinary friends and Stories were restored, then asked
for three interaction corrections: a circular profile-photo preview without
visible close chrome, pinch enlargement confined to post contents, and a
recipient search keyboard that remains usable when sharing Reels.

## Behavior and evidence

Instagram's original public zoom announcement is its own post at
https://www.instagram.com/p/BJxv5WthYas/. The historical interaction enlarges the
media beneath two fingers and returns it on release. The public announcement
was inaccessible through the text fetcher; its embedded demonstration and
release behavior are documented at
https://petapixel.com/2016/08/31/instagram-adds-pinch-zoom-give-closer-look-photos-videos/.
The user's current native-app comparison supplies the circular avatar and
background-tap dismissal requirement. This change matches those interactions;
it does not claim that the web companion is pixel-identical to every current
native-app rollout.

The previous companion explicitly ignored viewport scale limits, enabling
whole-page WebKit zoom. That scaled captions, navigation, and the touch
coordinate system along with the image. It also drew the profile preview as an
uncropped image with a visible Close button.

The Direct quick-tap shim could activate a Search button synthetically before
its textbox mounted. Previously only controls already containing editable
fields were exempt. The shim now yields to Search buttons and foreground
dialogs, preserving the site's user-initiated focus/keyboard lifecycle. A
retained Direct thread with main content still receives its existing quick-tap
handling. This supplements the existing keyboard-dismiss setting and the
parallel comments/sheet ancestor and root-scroll corrections.

## Changes

- Circular, cropped profile preview on a dim backdrop. Tapping dismisses it.
  The visual button is removed; an accessible Close action and Escape remain.
- Two-finger post-photo enlargement uses the image's initial rectangle,
  individual touch IDs, a fixed finger origin and centroid translation. Only
  the image presentation changes; the source image, caption, feed position and
  carousel index stay intact. Releasing returns the image in 160 ms.
- An Instagram-specific WebView disables browser zoom after WebKit creates its
  native recognizer. Other services keep their existing configuration.
- The preview reuses the displayed source, without image URL rewriting or new
  Instagram endpoints. Its shadow DOM keeps the copy out of carousel/shared
  item discovery, while Vigil's normal shadow-media classifier remains active.
  No safe verdict is copied. Concealed/blurred source media cannot start zoom;
  removal, changed source, policy concealment, or a route change closes it.
- Single-finger shared-item pan containment, native pan ownership, mutual-friend
  verification, informational exceptions and phone policy remain in force.

## Validation

Native WebKit regressions cover circular cropping and dismissal, browser zoom
configuration after navigation/layout, a two-finger pinch with reversed
TouchList ordering, a stable photo coordinate beneath the fingers, unchanged
caption/page/viewport geometry, release, source concealment, shadow-media
classification, navigation cleanup, and recipient-search activation before the
textbox exists. Existing feed, Stories, identity, Direct, carousel and native
pan regressions run alongside these checks.

The simulator validates deterministic interaction and focus contracts. The
actual Instagram share-sheet software keyboard and physical two-finger feel
remain device acceptance checks after the combined app-and-policy update.

All **37 selected native tests passed** on the combined source, including the
completed comments fix. Lint (500 sources), the TypeScript build, social-build
contracts, Story-position regressions, promotion regressions and whitespace
checks passed. The native fixtures include a transparent photo hit layer and
confirm that a new zoom copy remains concealed/blurred until separately
classified. A source or page concealment also prevents starting the gesture.

The changes are prepared for the normal `npm run agent:update:social` update.
No phone installation, supervision transaction, or live keyboard/pinch test is
claimed by this commit.
