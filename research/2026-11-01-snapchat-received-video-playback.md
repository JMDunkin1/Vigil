# Received Snapchat video playback

The user reported a “failed to play” message when opening received videos or
Snaps in Vigil on iPhone. The initial single-video WebKit fixture played, and
the existing phone render receipt had no video-error details. That first test
did not cover replacing an already approved player's source.

The current public Snapchat client forwards a rejected `video.play()` promise
to its player error callback. The received-Snap lightbox error callback closes
the viewer and displays a media failure message. Inspected source:
https://cf-st.sc-cdn.net/dw/02365173525f5f81a3c6.js

## Reproduction and repair

The document-start gate retained an `allowed` flag for a previously classified
video. When the same element received a new blob URL and immediately called
`play()`, the gate called native playback using that old flag. The source
observer then revoked approval and paused the pending native request. WebKit
rejected the caller's promise with `AbortError`; a Snapchat-shaped error handler
removed the viewer. Although later classification could approve the new video,
the caller had already treated it as a playback failure.

The guarded `play()` now consults the live eligibility resolver on every call,
including calls on previously approved elements. A changed source is held for
the existing fingerprint-bound classification flow before native playback
begins. The repair neither approves media nor changes classification outcomes,
audio preferences, native access gates, or the supervised policy.

## Validation

`node scripts/test-snapchat-video-webkit.mjs` runs the production concealment
bootstrap, early playback gate, common inspection adapter, and Snapchat mobile
layout in native macOS WebKit. A local generated MP4 is decoded and captured;
only native classifier replies are simulated through the real
document/id/token protocol. No fixture calls `allow()` or replaces eligibility.

Five scenarios pass: repeated safe source changes without a false error,
unknown replacement sources remaining paused/muted, sensitive replacements
remaining paused/muted, stale safe replies rejected after another replacement,
and a blocked page unable to replay an approved source. Running the same suite
against the preceding adapter fails with `AbortError` and a removed viewer.
The suite is included in CI.

The existing four Snapchat call/received-Snap/WebRTC WebKit scenarios and seven
focused runtime suites pass. Runtime build, source lint, Swift parsing, diff
whitespace checks, and the unsigned combined iPhone Release build pass. The
physical phone became unavailable before installation; no phone update was
performed by this chat. Physical playback acceptance is separate from these
fixture results and must be confirmed after the verified combined update.
