# Snapchat camera recovery and permanent save-bar rollback

## User-confirmed regression

The user found the photo-specific Camera Roll control. The permanent native
bottom-left save bar added in `5f57228` was unnecessary. The same update also
left the actual snap camera unable to open. Earlier generated-frame tests did
not establish that the replacement capture pipeline worked on a physical phone.
This repair supersedes the native-capture and permanent-save-bar approach in
`2026-10-27-snapchat-native-camera-and-save-bar.md`.

## Repair

- Remove the permanent `RootView` save bar, its published status, native action,
  and the injected flag that hid the photo-specific button.
- Keep the existing Camera Roll button on an opened photo. Keep its safe-media,
  privacy-screen, foreground, current-document, unchanged-source, and native
  Photos add-only checks. There is no save control in the ordinary chat/feed.
- Remove the AVFoundation/JPEG/canvas camera replacement and its registrations
  from every app target. Restore WebKit's original `getUserMedia` and
  `enumerateDevices` functions, real device IDs, real MediaStreams and tracks,
  requested audio/constraints, and original error behavior.
- Keep the native WebKit permission delegate's remembered system authorization,
  canonical HTTPS main-frame checks, foreground/access checks, the fullscreen
  snap layout, and complete-frame preview CSS.

The removed bridge required a current access receipt and native document ID,
replaced enumeration with its own device IDs, canceled the prior capture on
any new request, rejected every nonportrait buffer, and waited for its first
JPEG frame before returning a stream. Any of those dependencies could prevent
Snapchat's camera initialization or preflight/switching sequence from completing.
The exact failing hardware path was not observed; the repair removes all of
those replacement-pipeline dependencies instead of adding another capture path.

## Verification

- Eight focused iOS Simulator tests passed, zero skipped. These cover removal of
  the permanent native bar; the photo-specific button's visibility/hit testing
  and an actual Photos write; export pixel/layer retention and privacy rejection;
  remembered permission decisions; fullscreen snap/reply layouts; and original
  camera API/device/stream identity with overlapping generated capture requests.
- The generated-stream regression registers an obsolete camera bridge and checks
  that startup never sends it a request, and that stopping a preflight stream
  does not stop the selected stream. This test verifies the integration contract,
  not physical sensor orientation or lens selection.
- Seven focused runtime suites passed: Snapchat media, authentication,
  coexistence, social build/container, route boundaries, and orientation.
- Runtime build/type checking, repository lint, and the unsigned combined iPhone
  build passed. The unsigned build is compile validation only.

No phone install or policy/profile change is part of this repair. Physical
portrait framing and camera switching remain unverified until the user's
planned phone update and check; a simulator-generated portrait stream must
never be presented as proof that those hardware behaviors are fixed.
