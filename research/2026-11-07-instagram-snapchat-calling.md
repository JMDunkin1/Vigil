# Instagram call windows and Snapchat audio continuity

Implemented foreground Instagram call-window support and repaired a reproduced
Snapchat media interruption. Real account calls, physical speaker output and
installation remain unverified: CoreDevice reports the paired iPhone unavailable.
No phone update, policy change, supervision operation or Mac update was performed.

## Evidence and implementation

Inspected the current public [Instagram Direct bootstrap](https://www.instagram.com/direct/inbox/)
and its first-party assets. `ZenonCallWindowOpener_Popup` opens a real child
window, initially using the bare hostname on Safari. `ZenonCallWindowController`
retains that window and initializes it asynchronously. `IGCallUriBuilder` obtains
the call information from Meta and passes it to `XPolarisCallControllerRouteBuilder`.
That builder defines the exact [`/call/` route](https://static.cdninstagram.com/rsrc.php/v4iEct4/yL/l/en_US/G-_gCCsP7Hi.js).
`ZenonBrowsers` explicitly detects Mobile Safari.

Previously Vigil returned no child window and loaded allowed popup requests into
the chat's web view. This loses the opener/child relationship needed by that flow.
The new adapter normalizes only Meta's Safari placeholder to `about:blank` in
Direct, returning the original result of `window.open`. Native code returns an
actual WKWebView using WebKit's supplied configuration and cookie store.
Instagram's main view receives a Safari application-name suffix while retaining
its mobile browser identity. Call parameters, contacts, signaling, mute, camera,
answer/decline and hangup remain Meta-owned; no backend or fake call endpoint was
introduced. This does not prove Meta exposes calling for every account or browser.

The call child accepts only the opener's exact canonical origin and `/call/`.
Subframes, nested windows, other routes, credentials, nonstandard ports and
encoded path aliases are rejected. Its history API is confined too. It has no
native message bridge. Existing service checks, audio preferences, media
suspension and capture suspension cover the child. Native capture requires the
real system permissions and rechecks document identity and foreground eligibility
after permission prompts, including same-URL navigation generations. An independent
call monitor keeps the existing live policy probe fresh while the full-screen
child covers the normal SwiftUI access monitor. Leaving the service, backgrounding or a service block
closes the child and stops capture. Short inactive permission-sheet transitions
wait for the normal access check before granting or resuming. The shared WebKit
duplex session lifecycle is scoped to the Instagram call document. Inline video
and a mobile viewport preserve the site's call controls; a native End call action
also tears down capture and the child document.

For Snapchat, the early media observer previously paused every inserted player,
including an existing approved audio element moved by a layout update. A local
WebRTC regression moved the received audio player sixteen times and reproduced
pause events on the preceding implementation. The fix preserves an existing
grant only when the current eligibility resolver still permits that element.
New players and changed/revoked eligibility still enter the normal hold path.
This is a confirmed interruption source, not proof that it explains every dropout
on the user's phone. The user clarified that received speech cuts in and out so
severely that only occasional fragments are audible. Repeated pause/restart is
consistent with that report, but this exact severity has not been reproduced on
the phone; it must not be reported as a confirmed resolution of that symptom.

Source receipts (SHA-256): route builder asset
`335e9e9df90dd4d4b0df0942b60be9bd85f7a7379b7cb833fff21a7190d63cfe`;
IGCallUriBuilder asset
`ed3dd3c7ba2af806e9b3fb10a053391b6dcea838cbb3977d641beb79e707e88e`;
combined popup/browser asset
`53d0245067e7b57b67b4afa8e0a3280d7b1aeab1afa2ad96a17cdf03d16b55fe`.

## Verification and remaining limits

- Silent, offscreen WebKit tests exchange generated PCM and video through two
  real local RTCPeerConnections. Instagram tests exercise the actual Swift-built
  production scripts, decoded audio energy/video dimensions, inline presentation,
  preserved local-video mute, audio preference changes, reparenting continuity,
  suspend/resume, and rejection of eight disallowed history operations.
- The Snapchat WebKit suite passes call shells at three widths, controls,
  received-Snap transitions, audio preference and blocked outcomes. The new
  continuity test fails before the fix and passes afterward; revoked eligibility
  still stops reparented audio and its AudioContext.
- Runtime tests execute the production Swift URL admission policy and computed
  Instagram microphone script, covering real child identity, untouched audio and
  video parameters, origin/path boundaries and microphone lifecycle. Existing
  Snapchat capture, authentication, coexistence, combined-container, iOS build
  invariants and service-route tests pass.
- Runtime build, TypeScript, source lint and the unsigned combined iPhone build
  pass. A direct initial Xcode invocation omitted the shared bundle-ID override
  and failed extension validation; the corrected combined build uses the same
  bundle identifier for the host and extension prefixes.
- Both call WebKit suites are in CI. Their shared runner uses an invisible,
  offscreen, non-key window and rejects interactive-focus scenarios. Generated
  media has zero output volume; receiver analysis occurs before that output
  control. No audible tone, camera, microphone or external signaling is needed.

These checks do not establish actual Meta/Snap incoming calls, acoustic quality,
Bluetooth/earpiece routing, native CallKit behavior, lock-screen ringing or
background calling. Foreground restrictions remain in place. Device deployment
must use the verified `npm run agent:update:social` app-and-policy transaction.
