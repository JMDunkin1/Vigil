# Shared Instagram scrolling: physical-device follow-up

The user confirmed that swiping an opened share still advanced into different
Reels/posts. Phone status verified that the connected iPhone had the current
Personal release 0.3.216 (219), combined companion 0.3.196 (199), with the exact
live supervised policy. The previous fix was present; this was not an old build.

## Gaps reproduced in code

- Direct can activate a preview through an ordinary `div`, then present a
  viewport-sized absolute portal. Requiring an anchor/button and fixed/dialog
  portal semantics misses that path.
- The recipient-search exemption treated a Direct thread dialog containing a
  Search input as a share-recipient sheet. That exemption could cover its media
  before the viewer was pinned. The regression fixture now includes the retained
  thread Search box and an ordinary div preview.
- Disabling `WKWebView.scrollView` does not install a decision boundary above
  every nested scroll recognizer. JavaScript gesture cancellation was not
  sufficient proof of native swipe containment.
- A document-start native-lock message can arrive before native document-ID
  binding. The JavaScript state cache then prevents resending the same lock.

## Changes

A public-UIKit pan recognizer on the Instagram WebView gives nested pan
recognizers an explicit failure dependency. It consumes shared-viewer pans
without adding an overlay, hiding media, changing player sources, or delaying
ordinary touch presses/releases. It yields for pinch zoom, foreground comments
and recipient controls, and horizontal movement within the verified post
carousel. Scrolling exceptions use normalized visible rectangles; covered
background controls cannot authorize a pan through the foreground viewer.

The item guard now recognizes ordinary Direct activation targets and bounded
absolute portals. Recipient-sheet identification excludes message/main/article
surfaces and substantial media. Native state includes scrolling exceptions and
is replayed after document binding, with viewport changes updating geometry.

The implementation uses Apple's documented
[gesture failure dependency](https://developer.apple.com/documentation/uikit/uigesturerecognizerdelegate/gesturerecognizer(_:shouldberequiredtofailby:))
and [recognizer prevention](https://developer.apple.com/documentation/uikit/uigesturerecognizer/canprevent(_:))
APIs. No private WebKit classes or selectors are used.

## Validation before deployment

- 17 targeted iOS Simulator tests passed, covering the native priority and
  exception geometry, document-binding replay, Direct Search/raw-div/absolute
  portal regression, comments, recipients, posts/stories, playback-source
  recycling, retained portals, carousel layout, and pinch behavior.
- TypeScript typechecking, browser-fixture syntax checking, and whitespace
  checking passed.
- The extended Electron fixture again exited before its completion marker
  (`target closed while handling command`); it is not recorded as passed.

Physical-device deployment and live validation are recorded separately after
the verified app-and-policy transaction completes. Simulator success alone
does not establish that a live Instagram swipe is blocked.

## Physical-device deployment

`npm run agent:update:social` completed on the paired, wired iPhone. Installed
combined companion: **0.3.197 (200)**; phone release: **0.3.217 (220)**. The
transaction verified the current implementation, signing, and launches for all
eight services. Exact live policy fingerprint:
`4e6da9b09d55539e804a6a68094db7404cf5fde971f5bee9a0a34ce99ad1c1a0`.
The existing non-removable policy already matched and was left installed.

The paired developer diagnostic launch exposed the existing opt-in inspector.
Read-only inspection confirmed the new guard and its diagnostic state on the
physical phone's Instagram page. Home correctly reported no pinned item. A
human swipe of an opened share is still required to verify live containment;
deployment and script presence are not that verification.

Subsequent live inspection observed a sent Reel while Direct retained its
thread route: `pinned=true`, `kind=reel`, `viewer=true`, no misclassified recipient
or comments sheet, and a visible, actively playing video. Its viewport-sized
ancestor was an anonymous absolute-positioned div, matching the missed portal
shape now covered by the regression. This confirms activation and playback on
the device; the user's swipe result remains the final containment check.

The refreshed runtime social-build checks, 48 native route probes, and two
story-position regressions also passed.
