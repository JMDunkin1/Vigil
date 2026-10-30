# Foreground Snapchat calls and received Snaps

The user confirmed the hearing problem occurs with Snapchat already open. They
requested finishing the code now and installing later. No phone installation or
policy/supervision operation was performed.

## Research and reproduced defects

Inspected the current public [Snapchat Web entry point](https://www.snapchat.com/web/),
its [client JavaScript](https://cf-st.sc-cdn.net/dw/02365173525f5f81a3c6.js), and
[stylesheet](https://cf-st.sc-cdn.net/dw/eceeacedbecc23dae201.css). Source hashes
and local verification receipts are in `data/snapchat-calls-2026-10-30/manifest.json`.
Snap's [support page](https://help.snapchat.com/hc/en-us/articles/7121575005332-How-to-Call-Snap-and-Chat-from-Snapchat-for-Web)
documents desktop browser calling, microphone permission and device selection.
It does not establish native-iPhone parity for a WKWebView wrapper.

Three presentation defects were reproduced against the preceding adapter in real
macOS WebKit, using structural fixtures with fictional contacts:

1. The incoming call is `.hpge3`, a fixed **300 × 528** desktop drawer. Active
   calls can instead be `.Rnl06` in the secondary grid area or `.PvwWu` in the
   main area. None was covered by the existing full-screen media rules. Within
   the call, the one-to-one `.oKUDa` grid divides the participants into desktop
   columns; merely enlarging the outer container cannot enlarge the remote caller.
2. The existing lightbox detector required `.ecBYF .RdKti .vDdE2`. Removing the
   not-yet-mounted player reproduced a **390 × 374** lightbox in a 390 × 780
   viewport. The loading and away phases already have the outer `.ecBYF`, which
   is the correct presentation boundary.
3. A surviving secondary call panel recreates an **implicit CSS grid track**
   after the lightbox's explicit rows are collapsed. Opening a received Snap
   during an ongoing call reproduced this separately. The previous fixture had
   not combined the two surfaces.

The current client also sometimes renders its only Hang up button in `.wUTRn`
above the grid, while suppressing the duplicate header inside the call. This
header must remain reachable when the call fills the phone. It cannot simply be
hidden to eliminate its desktop grid row.

Remote call video in the inspected client omits `playsinline`.
[WebKit's iPhone media policy](https://webkit.org/blog/6784/new-video-policies-for-ios/)
explains that this attribute keeps video within the page instead of automatically
entering the system video presentation. The adapter now sets it on call/lightbox
videos without changing playback authorization or muting.

## Audio findings and limits

Snapchat renders remote voice and screen audio in separate autoplay `<audio>`
elements with `srcObject` streams. Its microphone acquisition is separate from
the Snap camera. The layout repair preserves these elements and their streams,
and it does not apply portrait camera constraints to call capture.

WebKit has primary bug reports for [output switching to the receiver during
capture](https://bugs.webkit.org/show_bug.cgi?id=231421), [capture-related low
volume](https://bugs.webkit.org/show_bug.cgi?id=218012), and [system device
selection/session state](https://bugs.webkit.org/show_bug.cgi?id=282939). These
are evidence of a relevant failure class, **not proof of the physical phone's
current output route**. The last report includes a capture-session transition
and playback reset used to recover routing/gain after microphone use.

Inspected WebKit's actual [DOM Audio Session implementation](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/audiosession/DOMAudioSession.cpp),
[iOS audio session](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/ios/AudioSessionIOS.mm),
and [media session selection](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/audio/cocoa/MediaSessionManagerCocoa.mm).
The web audio session manages WebKit's capture/playback category.
Changing only the host application's AVAudioSession is insufficient evidence of
changing the web process's route. Apple's [videoChat documentation](https://developer.apple.com/documentation/avfaudio/avaudiosession/mode-swift.struct/videochat)
also explains the relationship between chat mode, speaker defaults, and voice
processing; blindly changing modes can reduce playback level.

The scoped repair sets `navigator.audioSession.type` to `play-and-record` only
after a real microphone request succeeds. After the final captured microphone
ends, it restores the preceding type; an originally automatic session passes
through `playback` first to clear stale capture state. An intervening site/session
choice is preserved. Hidden documents release the override. Failed requests and
unsupported engines retain their original behavior. Streams, track stop/clone
methods, permissions, device IDs, system route selection, and microphone mute
remain caller-owned. Diagnostics cannot reject successful microphone capture.

Physical speaker volume, headphones, and a real incoming call **remain
unverified**. The paired iPhone was unavailable, and installation was explicitly
deferred. Generated PCM proves delivery through the tested WebRTC/media path;
it cannot prove acoustic loudness or a physical output route.

## Implementation and safety

The original incoming/active call nodes occupy one mobile grid area. The remote
tile fills a one-to-one call, with the self preview overlaid in a corner. Group
and screen-sharing grids retain Snapchat's arrangement. Loading/privacy Snap
surfaces use the outer lightbox from mount. A received Snap takes temporary
presentation priority over an ongoing call; closing it restores the call. An
incoming call retains priority over the lightbox. Genuine Join, Not Now, Hang up,
camera/microphone controls, navigation, and privacy shields remain owned by Snap.

The existing bounded render receipt now includes fixed call-presentation/session
enums and counts of remote audio elements, live streams, playing elements, and
muted elements. Native code whitelists values and rejects unknown/private fields
and unbounded counts. No caller names, conversation IDs, URLs, device IDs,
audio samples, or video frames enter this receipt. These fields do not authorize
access or playback. Filtering and the existing foreground/access checks remain
in force.

## Verification

- Four native macOS WebKit scenarios pass through
  `node scripts/test-snapchat-calls-webkit.mjs`: all three call shells at
  320/390/430 pixels; full remote tile; original controls and external Hang up;
  keyboard-sized viewport; desktop restoration; loading Snap; and opening/closing
  a received Snap during an ongoing call.
- The same harness exchanges generated tone audio and portrait video through two
  real local RTCPeerConnections, with no external signalling, camera or microphone.
  It measures non-silent received audio and verifies decoded video dimensions.
  The production early media gate is installed. Deterministic fixture
  classification signals let it test audio preference off/on and refusal to play
  or resume an AudioContext after a blocked/suspended outcome.
- All three layout regressions above fail on the preceding adapter. The retained
  before logs include actual measured rectangles. Current scenario screenshots
  were rendered and inspected. The WebKit harness is added to CI.
- Seven focused runtime suites pass: calls, camera/media, authentication,
  coexistence, combined container, iOS build invariants, and route boundaries.
  The microphone lifecycle tests cover stopping/ending/muting, hidden/visible
  transitions, prior session choices, denied capture, unavailable APIs, origin
  confinement, unchanged stream/request identity, and diagnostic failure.
- Runtime build, TypeScript checks, source lint and the unsigned iPhone build pass.
  The iPhone XCTest target compiles with new full-store WebRTC, call-layout and
  diagnostic privacy tests. Local XCTest **execution did not succeed**: the
  simulator test runner terminated or disconnected before establishing its
  connection, including with a compatible SDK build. No XCTest pass is claimed.

Other chats' Instagram work and release metadata were preserved. Deployment must
use the existing verified `npm run agent:update:social` transaction when the user
is ready; this change does not substitute an app-only installation.
