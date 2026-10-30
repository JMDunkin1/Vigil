# Instagram comments interaction and dismissal — October 30, 2026

The user confirmed that shared-Reel containment works, but comments sometimes
stop scrolling/responding and cannot be closed with either the handle or Close.

Two regressions reproduce gaps in the comments exception while preserving the
working Reel lock:

1. An external Close/Back control already had a JavaScript press exception, but
   its rectangle was absent from the native gesture boundary. Native panning
   could therefore cancel an imprecise press on that control. Include only
   foreground dismissal controls while an active comments sheet exists.
2. A cached anonymous drawer shown through a later `hidden`, class, or style
   change was not reliably rediscovered. The general feed observer deliberately
   excludes those high-frequency attributes. Add a separate comments-scoped
   observer, coalesced microtask refresh, and a bounded 1.5-second animation-frame
   geometry refresh after opening or relevant layout changes. Native messages
   remain deduplicated, and ordinary feed observation stays unchanged.

The patch does not alter drawer dimensions, transforms, list overflow, handle
`touch-action`, playback controls, native gesture ownership, or Reel policy.
Touches that begin in the background retain their original restriction; the
native recognizer is not changed to authorize them after a drawer moves.

## Verification

`node scripts/test-instagram-comments-webkit.mjs` runs the production guard and
stable adapter in desktop WebKit using the same HTML fixture as the new iOS test
`testInstagramCachedCommentsKeepInteractionsHandleAndExternalClose`.

Five cases pass: an external Close control, delayed `hidden`, class and style
visibility changes, and a fading portal. Each opens twice, scrolls/interacts
with comments, types in the composer, and closes once through the button with
finger jitter and once through a handle drag. Native exception rectangles must
cover the list, grip, and Close control, while excluding an exposed background
point. The fade case records geometry readiness before the transition finishes.
Every native lock message must remain locked, background swipes/Next/navigation
stay contained, and dismissal removes the comments exceptions.

The prior adapter from `20f141d` fails both the external-control and delayed-class
cases. The nine existing Send/Reel WebKit scenarios also pass with this patch.
The comments suite is added to CI.

Validation is repeated in a clean temporary snapshot containing only this patch.
Unrelated notification work in the shared checkout initially failed source lint
and iOS compilation; it is preserved and excluded from this patch's validation
and commit. Clean-snapshot lint, runtime build, social-build contracts, 48 native
route probes, WebKit suites, and iOS test-target compilation pass there.
Desktop WebKit establishes DOM/event and bridge behavior; physical iPhone touch
verification is still pending. No phone update or enforcement/policy change is
performed in this repair.

Local results: `data/instagram-comments-oct30-current.log`,
`data/instagram-comments-oct30-before-external.log`,
`data/instagram-comments-oct30-before-class.log`, and
`data/instagram-comments-oct30-send.log`. The temporary validation snapshot is
recorded in `data/instagram-comments-oct30-validation-root.txt`.
