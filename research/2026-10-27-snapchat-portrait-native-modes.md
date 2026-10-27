# Portrait Snap capture without a landscape center crop

## Requirement and retained fixes

Portrait output is required. Keep the verified mirror/clipping repair, original
camera/device ownership, remembered permission handling, fullscreen viewer,
photo-specific save button, and camera-local health recovery. Do not reinstate
the failed AVFoundation/JPEG bridge or the permanent save bar.

A native portrait source must precede the normal narrow Snap framing. Cropping a
16:9 landscape buffer to 9:16 removes roughly 68% of its width, producing the
extreme face enlargement the user rejected. Cropping a 3:4 portrait frame to
9:16 trims only 25% of its sides and keeps its entire vertical field. The repair
does the latter only after actual decoded portrait frames have arrived; no
rotation of an upright face, artificial stretching, upscaling, or portrait
padding is used as a substitute for native portrait capture.

## Capture changes

- Scope request adjustment to the visible phone Snap camera and the client's
  known desktop portrait-size requests. Boolean camera/microphone permission
  preflights, desktop capture, hidden cameras, and other service surfaces retain
  their normal behavior. Preserve requested device ID/facing mode, audio, and
  nongeometric constraints. Enumeration is unchanged.
- Remove the desktop dimensions, exact 9:16 aspect ratio, and inherited zoom
  constraints, including geometric entries inside advanced constraints. Prefer
  `resizeMode: none` where supported, allowing a native full-field camera format.
- Immediately return the original WebKit MediaStream. Never wait for a hidden
  consumer or native bridge before returning it; never stop another stream or
  replace track methods/settings. Observe Snapchat's existing mirror consumer.
- Apply the selected camera's reported minimum zoom when available. If stable
  decoded frames remain landscape, try both 1920x1440 and 1440x1920 ideal size
  orders on that same track, retaining full-field/minimum-zoom preferences.
  There is no hardcoded assumption about the front sensor's mounting.
- Bound optional mode applications and ignore old request ownership when
  negotiating a new camera. Keep displayed mirror-to-capture associations when
  the browser exposes the canvas track's source, including late capture results.
- Require stable decoded portrait frames before enabling a shutter gesture.
  Produce the outgoing mirror at 9:16 by trimming portrait-source sides while
  retaining all source height and using a 1:1 pixel mapping. Already narrower
  portrait frames keep their full width. Correct mirror resizing/reflection
  remains in effect during transitions.
- During preparation, keep Snapchat's real camera menu and close action usable.
  If all native modes fail or stall, explain that locally and prevent a silent
  landscape send. Do not replace the whole app with a loading failure.

## Evidence behind the approach

The [public Snapchat client](https://cf-st.sc-cdn.net/dw/14a374cb957e6774b9f0.js)
requests 406x720 or an exact 9:16 aspect ratio, then uses its mirror canvas as the
photo source. The earlier mirror repair established the need to use decoded
frame dimensions rather than initial track settings.

[WebKit issue 323550](https://bugs.webkit.org/show_bug.cgi?id=323550) reports
portrait/landscape request inversion and changing initial dimensions on other
iPhones. [Apple's camera engineer](https://developer.apple.com/forums/thread/813548)
confirms that the iPhone 17 front sensor has a different mounting. These support
trying both dimension orders and observing real frames, rather than assuming one
orientation from the device name. [WebKit's capture source](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/mediastream/cocoa/AVVideoCaptureSource.mm)
exposes camera-specific zoom bounds and rotates reported settings with delivered
frames. None of these sources substitutes for physical verification on this phone.

## Validation

Thirteen focused iOS Simulator tests pass with no skips. The new managed-camera
regression uses real generated canvas streams and actual WebKit JPEG encoding,
covering five native-response cases: already-portrait frames, success with the
first dimension order, rejection followed by success with the second order,
no portrait mode, and mode promises that never resolve. It verifies:

- Actual 9:16 JPEG dimensions; retained top/bottom field and center marker scale.
- The original real stream and selected ultra-wide device ID; one acquisition
  request, unchanged audio, minimum zoom, and no software resize-mode crop.
- A guarded shutter during preparation/failure, usable camera selection/close,
  bounded failed/stalled attempts, and successful shutter release once ready.

Existing tests retain the clipping repair, photo export/privacy checks, remembered
permissions, native bar removal, fullscreen viewing, and health recovery. Runtime
cases verify request immutability, nested geometric-constraint removal, native
stream/device ownership, preflight overlap, denials without retries, and scope.
Seven focused runtime suites, runtime build/type checking, source lint, and the
unsigned combined iPhone build also pass.

No phone installation or policy/profile/supervision changes were made. Simulator
camera-mode responses are generated; physical iPhone framing, quality, lens
switching, and authenticated recipient appearance remain unverified.
