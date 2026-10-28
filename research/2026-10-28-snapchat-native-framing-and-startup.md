# Native portrait framing and missed web capture paths

## What the native camera can do

The user's wider native portrait view is plausible. Apple's [iPhone 17 camera
session](https://developer.apple.com/videos/play/wwdc2026/341/) describes a square
front sensor and wide-angle lens. Native AVFoundation apps can select a portrait
region from that sensor and control zoom and orientation. This retains vertical
sensor content that is already missing from a landscape buffer. Native aspect
selection still involves framing/cropping; it is materially different from
cutting a narrow portrait out of an already-cropped wide web frame.

Snap's public [native Camera Kit API](https://kit.snapchat.com/reference/CameraKit/ios/1.38.0/SCSDKCameraKit/Protocols/SCCameraKitProtocol.html)
also exposes output-buffer orientation. This documents a supported native
approach, not Snapchat's proprietary app's exact capture implementation. Neither
source establishes identical field of view for our WebKit path on this phone.

## Why the previous fix could remain horizontal

Re-inspected the current public [Snapchat Web client](https://cf-st.sc-cdn.net/dw/14a374cb957e6774b9f0.js)
and reproduced two gaps in our adapter:

1. Snapchat's media store acquires/reuses camera streams independently of React
   camera mounting. The old adapter only registered a request when a visible
   `.BN1L1` camera already existed. Early/warm captures, including captures before
   the phone viewport applied, never entered portrait negotiation or its gate.
2. The client supplies the original stream directly when its Camera Kit client
   is present. That path does not use the hidden mirror draw hook, so the old
   portrait observer never ran even for a registered stream.

Both new regression tests failed against the prior implementation. Existing
fixtures had always opened the camera first and constructed the mirror path,
which is why they did not establish those two production paths worked.

## Repair

Register original video streams on trusted main-frame chat documents even before
camera mounting or mobile layout. Keep original requests for preflights, calls,
and hidden/startup capture. Defer changes until the exact stream is displayed in
the visible phone Snap camera. Preserve stream/track identity, the selected lens,
audio, original permission behavior, and caller-owned cleanup.

Map actual canvas capture streams to their source canvases without changing their
capture behavior. Observe the existing visible video for direct Camera Kit input
as well as the original hidden mirror consumer. A bounded audit runs only while
a visible camera has an active stream and stops on background/inactive surfaces.

Follow [Snap's web camera guidance](https://developers.snap.com/camera-kit/integrate-sdk/web/guides/web-considerations):
request standard landscape camera resolutions, check actual delivered frames,
and avoid portrait-shaped/unconventional requests that can cause zoomed or
incorrect fallbacks. Prefer 1280x720, then 1920x1080, with a final native-default
fallback. Retain minimum available zoom and no-resize preferences. This replaces
the speculative 1920x1440 / 1440x1920 pair. Never rotate an upright face or crop a
landscape source into a fake portrait. Direct portrait streams retain their full
source field; the existing mirror path retains its bounded portrait-side framing.

Extend the existing local render receipt with whitelisted geometry, pipeline,
phase, deferred-start, mode-attempt, and zoom fields. No pixels, camera IDs, labels,
chat text, names, or URLs are recorded. These flags have no authorization role.
A dedicated native test rejects unknown fields and out-of-range values.

## Verification

- Sixteen focused simulator tests passed, no skips, including startup before
  camera mounting/mobile layout; direct Camera Kit input with no mirror consumer;
  the existing mirror, failed/stalled mode, shutter, full-field JPEG pixel,
  permissions, Photos export/privacy, fullscreen viewer, and health regressions.
- Seven runtime suites, runtime build/type checking, repository lint, and the
  unsigned combined iPhone build passed.
- Failed baseline and passing final runs are retained in `data/snapchat-oct28-*`.
  Simulator diagnostics collection was disabled after it stalled result finalizing;
  test failures/timeouts were not disabled. The final xcresult reports success.

Camera responses in these tests are generated. They prove the formerly skipped
integration paths now run and preserve the test images' geometry, not that a
physical sensor has the same optical coverage as native Snapchat. CoreDevice
reported the physical iPhone disconnected. No app installation, authenticated
transmission, policy/profile change, or supervision operation was performed.
