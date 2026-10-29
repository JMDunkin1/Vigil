# Instagram Send dismissal drops the shared-Reel lock — October 29, 2026

The user clarified the remaining failure: open Send on a received Reel, then
close Send back to that same Reel. This differs from leaving Direct and
reopening a shared item, which the earlier regression emphasized.

## Reproduced cause

A Direct viewer can keep the `/direct/t/...` URL. When its Send picker appears,
Instagram can mark the underlying viewer `aria-hidden`, hide it, or transition
it out of view. `syncRoute()` treated that as a closed viewer and called
`reset()`, clearing the item identity and publishing `reelScrollLock: false`.
Dismissing Send does not generate another Direct preview activation, so showing
the original Reel again did not recreate the pin. The prior guard fails the
new maintained regression while the Send picker is open.

## Change

Retain the already-pinned Direct item's identity and native lock while its
foreground recipient/comments sheet is active. A semantic Send/Share/Comments
activation permits a bounded 1.5-second presentation gap; an observed sheet's
dismissal permits a bounded 1-second return/remount gap. Explicit scheduled
checks expire abandoned transitions. A visible returning viewer clears its
closing grace, so subsequently closing the Reel restores the chat promptly.

Only the foreground sheet retains its existing input/scrolling exception.
Dismissing the sheet removes those native regions without unlocking the item.
Replacement viewers inherit the existing pin using the existing foreground
viewer checks, excluding the originating chat. This does not authorize another
Reel, change media sources/layout, or loosen route restrictions.

## Validation

- The maintained desktop WebKit suite passes nine cases. Seven viewer variants
  cover `aria-hidden`, display, opacity, separate opening/closing render frames,
  remounted viewers, and anonymous fixed portals. Each repeats Send/dismiss
  twice, tests recipient search/scrolling, then verifies wheel/swipe/Next/route
  containment and playback click delivery. The complete native message history
  must contain no unlock until actual viewer closure, and dismissed picker
  regions must be empty.
- Two negative cases verify actual viewer closure under Send and an abandoned
  Send presentation both expire their transition hold and release Direct.
- The same maintained runner fails against the earlier guard from `766e484`.
- Run `node scripts/test-instagram-send-webkit.mjs` from the repository root. An
  optional first argument selects a saved adapter source for baseline checks.
  CI runs this suite, and the Electron shared-item suite includes the same
  HTML fixture and focused checks (`--send-roundtrip-only`).
- Lint, runtime build, social-build contracts, 48 native route-boundary probes,
  friend-recovery regressions, JavaScript parsing, and whitespace checks pass.
- The iOS app/test target compiles. Native execution remains unverified: the
  simulator test invocation stayed in startup before any test results and was
  interrupted. The focused Electron run was killed before its completion
  marker and is not counted as a pass. Desktop WebKit validates DOM/event and
  bridge behavior; physical iPhone native gestures still require verification.

The iOS XCTest fixture is
`testInstagramClosingSendPreservesDirectReelContainment`; its HTML is also the
single source for the desktop WebKit and Electron tests. Local logs are
`data/instagram-send-maintained-webkit.log`,
`data/instagram-send-maintained-baseline.log`, and
`data/instagram-send-compile.log`.

No phone update, supervision/policy transaction, watchdog change, or enforcement
workaround was performed. The user's earlier code-only preference remains in
force; deployment must use the normal combined `agent:update:social` command
when requested.
