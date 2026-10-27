# Shared Reel comments touch-path follow-up

The user confirmed that opening comments on a received Reel leaves both scrolling
and dismissal stuck. The previous comments correction was already included in the
installed combined Vigil app, version 0.3.201 (204).

## Reproduced gaps and repair

- The prior CSS excluded comments ancestors from Vigil's touch restriction but
  left Instagram's own `touch-action: none` or horizontal-only restrictions on
  those ancestors intact. The active comments/recipient ancestor path now
  explicitly permits touch gestures. The native pan boundary and JavaScript
  containment still reject background Reel holds, swipes, and item navigation.
- Plain span/div Comments titles now identify a panel when supported by a
  comment composer or comment-specific details. Contenteditable composers with
  comment placeholders or an exact Add/Write-a-comment prompt are recognized.
  Interactive Comments buttons cannot become headings. A nested panel must have
  its own bounds and exclude the large Reel media; a short caption with the word
  Comments and a composer does not turn the viewer into a scroll exception.
- External Close/Back/Dismiss controls now resolve `aria-labelledby` references,
  retaining their pointer press/release lifecycle as existing explicitly labeled
  dismissal controls do.

## Validation

Before the repair, the added iOS WebKit fixture failed six assertions across
semantic and plain-text headings: ancestor touch actions, panel detection,
comments pointer movement, and accessible dismissal. With the final repair, all
17 selected iOS Simulator tests passed, with no failures or skips. They cover
comments, native exception geometry and root scrolling, keyboard geometry,
background containment, selected media recycling, Direct and retained portals,
sent photos/stories, carousels, photo pinch, and recipient search.

TypeScript typechecking, source lint (501 files), the runtime build, three runtime
social build/container/route test files, and `git diff --check` passed. The optional
Electron fixture runner exited without producing test results, so no browser or
physical swipe pass is claimed.

## Delivery state

The normal `npm run agent:update:social` transaction prepared phone release
0.3.222 (225), with combined app version 0.3.202 (205). It stopped before building
or installing because the previously paired iPhone became unreachable over USB
and the local network. CoreDevice independently reported it unavailable.

Reconnect the phone and rerun that same verified transaction. The fix is not yet
installed or physically gesture-tested. No supervision, profile, signing,
watchdog, or restriction setting was changed by this repair.
