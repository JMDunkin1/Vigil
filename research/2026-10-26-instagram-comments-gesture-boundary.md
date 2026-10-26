# Instagram comments within a locked shared viewer

The user confirmed that the native pan boundary stopped Reel advancement, then
reported that comments could neither scroll nor close. The repair keeps that
boundary active and makes its foreground exceptions usable through every layer.

## Causes and repair

- Native code previously disabled the root WebKit scroll view even when its pan
  boundary yielded for a comments rectangle. Root scrolling now remains enabled
  while a verified foreground exception exists. The parent recognizer still
  rejects swipes starting in the background Reel; closing the exception restores
  the strict root lock. Surface updates preserve the exception.
- The CSS lock excluded the comments panel and its children but still constrained
  their ancestors. The [Pointer Events specification](https://w3c.github.io/pointerevents/#the-touch-action-css-property)
  evaluates ancestor touch actions when determining permitted browser gestures.
  Comments and recipient panels now have an unrestricted ancestor path, while
  other descendants retain their pan restriction. Comments can scroll within
  their own panel, with contained overscroll; the background's stored offsets
  remain enforced.
- A comments close/back control may sit outside the marked panel. Exact dismissal
  labels now receive their press/release events while comments are present.
  Reel advancement controls remain blocked.
- Comments identification no longer requires a textarea when an independently
  bounded Comments section exists alongside the video. Modern contenteditable
  composers can therefore retain their panel exception.
- Keyboard height changes previously stretched normalized exception geometry
  across the native view. Regions now use the layout viewport and width-derived
  zoom scale; hidden ancestors cannot provide an exception.
- A post-comments transition can move the original video out of its still-retained
  article. A single-media wrapper may retain only that same selected video with
  its unchanged, nonempty source and no conflicting item route. Carousels and
  replacement sources cannot inherit permission. Closing the portal clears its
  stale reference so enforcement follows the video back to the original article.
  The playback fixture uses a nonempty source and verifies continued visibility
  through opening and closing comments, then rejection of a replacement source.

## Validation and delivery

18 targeted iOS Simulator tests passed, with zero failures or skips. They cover
native pan ownership and root-scroll exceptions, geometry replay and keyboard
changes, comments without a textarea, an external close control, comments
playback, background offset containment, Direct viewers and retained portals,
source recycling, sent posts/photos/stories, carousels and pinch gestures.
TypeScript typechecking, the runtime social-build checks, and whitespace checks
also passed.

This follow-up has not been installed or physically swipe-tested on the phone.
The user will connect it later. Installation must use the normal verified
`npm run agent:update:social` app-and-policy transaction. No profile, signing,
supervision, watchdog, or enforcement setting was changed by this repair.
