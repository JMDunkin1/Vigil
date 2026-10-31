# YouTube Safari performance — October 31, 2026

Vigil's shared media guard rescanned the complete document and every observed shadow root after each mutation delivery. YouTube is a contextual media platform, so the guard also synchronously ran those scans before clicks, pointer presses, key presses, changes and media playback. Player animation, elapsed-time text and ordinary typing consequently repeated expensive text classification across an unchanged feed.

## Confirmed recent trigger

The follow-up history investigation identified commit `df2b34c7b80560652a4a09b4c74c2ee50f3949b4` (October 29, 2026, 7:03 p.m. Eastern). It added `youtube.com` to `MEDIA_DISCOVERY_PLATFORMS`, which was spread into `CONTEXTUAL_SEARCH_PLATFORMS`. The generated media guard reused that list to determine `isMixedPlatform`. This activated the mixed-platform scanner on YouTube and the synchronous full-document scan before each click, pointer press, key press, change, submit and play event.

The generic mutation/periodic scanner already existed. The newly activated interaction scanner and additional mixed-platform document walk were recent. They explain why the previous implementation could be acceptable before this update and become substantially worse afterward.

Archived signed Safari packages establish the local installation timeline:

- The October 29, 2:56 p.m. package did not classify YouTube as a mixed platform (media guard SHA-256 prefix `3c0cc15d72a6ca`).
- The October 30, 1:49 a.m. update replaced that package with the affected guard (`095b4bfd0323f5`). Their media guards differ only in the generated platform-list line.
- The October 30, 5:05 p.m. package retained that behavior (`64064f889335bf`). The backup of the live installation taken before this performance fix has that same hash. This connects the regression to the actual installed package, not just Git source.

A second native WebKit comparison loaded the archived guards into the same approximately 6,400-element local fixture. It measured 30 ordinary search-field key presses:

| Guard | Whole-document walks | Expensive classifications | Synchronous elapsed time |
| --- | ---: | ---: | ---: |
| Installed October 29 afternoon | 0 | 0 | 1 ms |
| Installed October 30 early morning | 60 | 390,630 | 3,561 ms |
| Installed October 30 afternoon (live before fix) | 60 | 390,630 | 3,590 ms |
| Current fix | 0 | 30 | 5 ms |

These are fixture measurements, not real-page latency percentiles. The deterministic work counts and one-line archived-source difference directly establish a recent Vigil interaction-performance regression. The timing is approximately 119 ms of additional synchronous scanning per key press in this fixture. The installed fix addresses that path while retaining the added restrictions. This does not prove there are no independent network, YouTube or other-extension issues.

## Remaining typing overhead

A follow-up repeated the typing measurement after warming each archived guard, alternating the pre-regression and installed fixed versions twice. Each page ran eleven batches of 300 synthetic key presses. The older handler took 0–1 ms per batch; the fixed handler took 29–32 ms, with a 30 ms median in both runs (approximately 0.1 ms per key). Both performed zero full-document walks. The fixed handler retains inspection of the relevant semantic unit and pending DOM changes, so some real overhead remains relative to the older path that did no interaction scan. The earlier 1 ms versus 5 ms totals should not be presented as a meaningful fivefold change in YouTube responsiveness. These measurements isolate synthetic event-handler work and exclude real input, layout, painting and network latency.

## Change

- Cache the three short classification inputs for each element in a `WeakMap`. Each lookup compares the current exact text; changed and recycled cards are reclassified. Detached elements are collectible, and inputs over 700 characters are not retained.
- On YouTube, coalesce mutations into affected semantic units rather than rescanning the complete page. Include enclosing posts, links, controls, forms and preference groups, plus controls with external accessible/form labels. Large mutation batches fall back to a full scan.
- Before an interaction, synchronously drain pending mutation records and inspect the target's semantic unit. Cross-shadow interactions retain the complete scan. Newly discovered shadow roots join the current inspection pass.
- Preserve the full initial, periodic, lifecycle and requested health scans. Preserve every matcher, hiding rule, click gate, allowance check and playback authorization. Other platforms retain their full mutation/interaction scans.

## Measurements

The local fixture contains 100 cards and approximately 6,400 DOM elements. It intercepts network requests and uses ordinary astronomy labels. Measurements are development fixture samples, not live YouTube network or playback benchmarks.

| Five consecutive full health checks | Original | Updated |
| --- | ---: | ---: |
| Expensive contextual text classifications | 65,105 | 505 |
| Chromium elapsed time, sample | 518 ms | 168 ms |
| Native WebKit desktop elapsed time, sample | 740 ms | 249 ms |

Classification work fell 99.2%; the native WebKit sample took approximately 66% less time. The updated mobile YouTube fixture passed in native WebKit as well (263 ms for the same five full checks). Player class/style/clock updates and 30 ordinary key presses triggered **zero whole-document scans** in the updated Chromium and WebKit fixtures. Full periodic checks remained active.

## Validation

- `npm run build` and targeted ESLint passed.
- `node_modules/.bin/electron tests/youtube-media-performance-browser.cjs` passed. It covers performance work counts, recycled nodes, immediate unsafe clicks, split labels, enclosing post text, externally referenced labels, nested buttons/groups, alt changes, new/nested shadow content, safe neighboring cards and periodic full scans. The original guard fails the unchanged-text work-count regression.
- Native WebKit desktop/mobile smoke checks passed using `tests/fixtures/youtube-media-performance.swift`, compiled with `xcrun swiftc`, and supplied the production media guard path. The original guard fails the same classification-work assertion.
- Browser filter reporting, media catalog filtering, browser extension parity, iOS browser guards, Safari background traffic and Safari resource verification passed. All 53 YouTube player tests and 21 allowance tests passed.
- Existing real-browser marketplace and Reddit/media fixtures passed. `mixed-platform-browser.cjs` has an existing X preference-visibility assertion failure; the original guard produces the identical failure. That separate behavior was not changed here.

## Installation

The signed Mac Safari extension was installed with the dedicated updater. The final `/Applications/Vigil Safari.app` signature passed strict/deep verification, and every packaged Safari resource was verified byte-for-byte against the final source. Existing YouTube documents need to reload to pick up updated content scripts. No Vigil process, watchdog or enforcement policy was disabled.

The standard Mac updater was also invoked; it returned a verified no-update result because its managed checkout has local edits. No main-app installation was required for this extension-only change.

The shared source also serves the iPhone Safari extension and combined native app. The paired phone was unreachable over USB/local network, so no phone installation or policy transaction was attempted. The phone update remains pending a reachable device. Other ongoing workspace edits were preserved.
