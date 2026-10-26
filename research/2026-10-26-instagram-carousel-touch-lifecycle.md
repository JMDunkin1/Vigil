# Restore Instagram photo-dump swipes — October 26, 2026

The user could move between post photos only with the web carousel's arrows.
A native WebKit regression reproduced the failure without any arrow buttons:
Instagram's swipe controller received no touch start/end lifecycle, even though
an earlier regression checked only whether a horizontal move was cancelled.

The first-party Instagram assets examined for the earlier repair show the
actual path: `PolarisSidecar_DEPRECATED.react` uses
`PolarisVirtualHSnapScroll.react`, which composes `PolarisHSnapScroll.react` and
`PolarisSwipeArea.react`. SwipeArea records the opening touch and completes the
swipe on release. HSnapScroll temporarily changes its viewport's horizontal
overflow to `hidden`, and its virtual list uses translated `li` slots. The
left/right buttons are supplied by Instagram's `PolarisPagerButton.react`.

Vigil's shared-item guard suppressed press and release on the photo, preventing
that native site controller from starting. It also required the slide list to
be a scrolling container itself and allowed horizontal touch action only on
its descendants. Instagram's nested virtual list and the constrained ancestor
chain could therefore remain blocked.

The correction lets an identified carousel in the exact selected post receive
the site's original start/move/end events. It recognizes the virtual list and
its separate SwipeArea viewport, reports that viewport to the existing native
pan boundary, and permits horizontal panning along its ancestor chain. It does
not add a replacement carousel controller, advance an index, or add buttons.
Vertical movement and navigation into another post remain contained.

Instagram unmounts offscreen slides. For these virtual lists, later mounts are
authorized only by an immutable source manifest read from the already-loaded
React props of the exact selected shortcode and Sidecar. The bounded reader
uses data properties and the `props`, `children`, and `post` fields, without
calling site functions or traversing recommendations. The manifest captures
only declared child-image/video resource URLs. A different shortcode,
unlisted source, another list, or replacement media stays blocked. Existing
source bindings remain the fallback when that loaded manifest is absent.
There are no new network queries or endpoint/URL rewrites.

When a second finger starts photo zoom, the prior one-finger site swipe is
cancelled before Vigil owns the pinch. That releases Instagram's temporary
pressed/overflow state and keeps the next ordinary photo swipe working.
The existing media-classification and shadow-preview gates remain intact.

The new fixtures exercise forward/backward swipes through scroll-based and
virtual lists without buttons, full event delivery, horizontal permission at
every ancestor, a swipe immediately after a pinch, exact-post virtual remounts,
rejection of unrelated replacement sources, and continued vertical/route
containment. The original fixture failed before the correction and passed
afterward. Live phone swipe verification requires the normal combined
`npm run agent:update:social` transaction; no installation is claimed here.

Validation: all **40 selected native tests passed** in the final clean run,
including the previous photo zoom, recipient search, comments, native pan,
friendship, feed-position, Story and shared-item regressions. Lint (500 sources),
the build, social-build contracts, Story-position tests and whitespace checks
passed. The fixture source list contains only fictional accounts and media.
