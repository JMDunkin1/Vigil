# Instagram recipient touch timing — October 29, 2026

The user reported that recipient search still needed repeated taps before the
keyboard would stay open after the earlier shortlist recognition fix.

The native pan guard accepted every touch at touch-down, then evaluated the
original touch location against the latest sheet rectangles and WebView bounds
when movement began. A keyboard/layout transition could therefore turn a
recipient press into a cancelling background pan. The reverse was also
possible: a sheet moving over an existing background swipe could exempt it.
Two native regression tests failed against that behavior.

The guard now rejects recipient/comments touches immediately. For accepted
touches it remembers the first touch's carousel permission until UIKit resets
the recognizer. Additional fingers cannot replace that decision, and a later
gesture cannot inherit the previous carousel permission. Vertical background
and carousel swipes remain contained.

Validation: 13 targeted iOS Simulator tests passed, including the timing cases,
existing recipient activation/focus, root scrolling, geometry validation,
document binding, reopened landscape media, and Direct viewer containment.
Source lint and whitespace checks passed. The tests exercise native delegate
decisions while sheet rectangles and WebView bounds change; they do not claim
to reproduce the live Instagram keyboard. An exploratory programmatic keyboard
test did not receive a software-keyboard notification and was removed.

Apple documents the asynchronous keyboard lifecycle in
[Keep up with the keyboard](https://developer.apple.com/videos/play/wwdc2023/10281/).
That supports checking transitions across events instead of immediate DOM focus
alone; it does not establish the cause of the user's physical-device symptom.

The iPhone was unreachable, and the user could not connect it during this work.
No phone update or live first-tap acceptance test was performed. Installation
must use the normal combined `npm run agent:update:social` transaction.
