# Snapchat mirror canvas, outgoing photos, and camera-switch health

## What the screenshot can establish

The new screenshot has a clipped camera image at the top and a large black lower
section. It cannot establish the bytes received by another person. In particular,
it was incorrect to treat complete-frame CSS or a raw-stream fixture as proof
that Snapchat's actual outgoing photo retained the full camera image.

## First-party client inspection

Inspected the public unauthenticated Snapchat Web client again on October 27:

- [Client JavaScript](https://cf-st.sc-cdn.net/dw/14a374cb957e6774b9f0.js),
  SHA-256 `e9efda14663f23e5af437fe6b2001ea67fbc83ec176fc7e7d8ae51a41443a03c`.
- [Client CSS](https://cf-st.sc-cdn.net/dw/eceeacedbecc23dae201.css).

The Safari fallback creates a hidden canvas using the raw track's initial
`getSettings()` dimensions and a hidden video playing the same raw stream.
It reflects the context horizontally and repeatedly draws the video at natural
size without supplying destination dimensions. When decoded frame dimensions
and initial settings disagree, the canvas clips an edge and leaves unused pixels
at the bottom. Its canvas stream becomes the displayed camera stream. The client
also stores that mirror canvas and preferentially uses it for shutter capture;
the shutter copies its intrinsic dimensions and pixels into the image encoder.
The normal base-image encoder uses JPEG at quality 0.95 (WebP in a quality
experiment). Thus the defect can reach the outgoing file, rather than being only
a preview-layout issue. No authenticated snap was sent or received to establish
which exact frames were affected on this particular phone.

[HTML's drawImage rules](https://html.spec.whatwg.org/multipage/canvas.html#dom-context-2d-drawimage-dev)
use video intrinsic dimensions for an unscaled draw; CSS does not repair the
canvas bitmap. [Canvas capture](https://www.w3.org/TR/mediacapture-fromelement/#html-canvas-element-media-capture-extensions)
likewise captures the canvas's bitmap dimensions.
[WebKit issue 323550](https://bugs.webkit.org/show_bug.cgi?id=323550) documents
orientation/dimension discrepancies on other iPhones; it is supporting context,
not proof of identical iPhone 17 behavior. Earlier investigation of constraints
alone missed Snapchat's intermediate mirror buffer.

## Changes

1. Keep WebKit's original camera acquisition, enumeration, streams, tracks,
   device selection, audio, constraints, and permission handling.
2. Recognize only the verified hidden local-camera reflection draw: direct body
   children, absolute/transparent/noninteractive canvas and video, local-camera
   track, exact reflection matrix, and the client's three-argument draw shape.
   On an HTTPS canonical phone-sized `/web` page, wait for decoded dimensions,
   resize that existing canvas to match each actual frame, restore reflection
   after resizing resets context state, and draw the entire frame explicitly.
   Remote videos, visible previews, ordinary canvas draws, compositing masks,
   other routes/origins, desktop layouts, and media-classifier draws retain their
   original behavior. No new capture pipeline, stream, or camera controls exist.
3. Recognize Snapchat's still-interactive camera and viewer controls in health
   detection. During a switch the feed/chat can be hidden while a camera-local
   error toast remains. That toast must not trigger Vigil's full-page “didn't
   load” overlay. Snapchat's own error stays visible, and genuine whole-page
   failures still report degraded health. Content-policy enforcement is unchanged.

## Validation and limits

- Before implementation, a reduced reproduction of the client's mirror/shutter
  algorithm failed encoded-photo dimensions and edge/bottom pixel checks. A
  separate test reproduced a camera-local toast becoming degraded page health.
- Both regressions passed after the change. Twelve focused iOS simulator tests
  passed with no skips, covering existing permissions, actual Photos export,
  privacy shields, fullscreen viewing, chat controls, and health recovery.
- The expanded mirror test also plays the mirror's real generated canvas stream
  in the preview, switches decoded landscape/portrait/square sizes repeatedly,
  copies the mirror through the shutter path, encodes/decodes JPEG at 0.95, and
  checks both edges and the bottom. Pixels are generated; this verifies the
  real browser drawing/encoding integration, not physical camera optics.
- Seven runtime suites, runtime build/type checking, repository lint, and the
  unsigned combined iPhone build passed. Runtime cases also check that the fix
  does not alter capture/enumeration APIs or unrelated drawing operations.

The paired physical iPhone was unavailable to CoreDevice during this repair.
No phone install, authenticated transmission, policy/profile replacement, or
supervision operation was performed. This prevents the mirror's additional crop
and black area from being introduced into delivered camera frames; it does not
force a wide sensor output to become portrait or recover pixels already omitted
by the camera. Physical framing and recipient appearance remain unverified.
