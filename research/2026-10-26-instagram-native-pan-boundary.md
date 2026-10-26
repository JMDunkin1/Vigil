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
