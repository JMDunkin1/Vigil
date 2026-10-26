# Instagram Home reading position — October 26, 2026

After confirming ordinary friends were visible again, the user reported the
whole feed jumping vertically while scrolling or moving through photo dumps.

A deterministic iOS WebKit fixture reproduced a **500 CSS-pixel jump** when a
500-pixel friend post above the reading position finished verification and
became visible. It reproduced with both document scrolling and a nested feed
scroller. The original reading post moved from 100 to 600 pixels below the
viewport top without user scrolling.

The fix retains the visible, verified post's viewport offset around Vigil's
synchronous Home filtering changes. It also handles a previously verified card
above the reader being recycled into a filtered account. Compensation uses the
same scrolling container and requires the same verified author and connected
card afterward. Initial rescans are batched, and asynchronous verification and
viewer-identity completion get independent anchors.

This is limited to Home filtering updates. It installs no ordinary-scroll or
touch handlers, changes no photo index, and leaves shared-item containment,
mutual-friend proof, and informational exceptions unchanged.

The regression now preserves position for insertion and removal above the
reader in both scrollers, retains the current photo's horizontal offset, and
allows subsequent ordinary vertical scrolling. All **30 selected native tests**
passed, including the existing feed, Story, relationship, recipient-search,
photo/zoom, Direct, and native-pan regressions. Lint, build, social-build
contracts, 48 native route probes, and whitespace checks passed.

Physical-device deployment is recorded after the verified combined transaction;
the fixture establishes a reproduced cause rather than claiming a recorded
human interaction on the phone.
