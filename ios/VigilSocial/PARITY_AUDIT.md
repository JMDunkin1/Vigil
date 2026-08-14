# VigilSocial parity contract

VigilSocial contains fixed Instagram and YouTube companions. Each renders its
current mobile website in a persistent `WKWebView` with Vigil's content-safety
and focused-social policy. The Instagram target also hosts the legacy YouTube
Safari content blocker and ordinary-watch interaction extension. A mismatch
caused by Vigil outside the intentional differences below is a bug.

The practical target is:

1. Preserve the service mobile site's layout, sizing, lazy loading, media
   behavior, and in-page gestures. In particular, Instagram must not be
   reconstructed, resized, reordered, or given replacement gestures by Vigil.
2. Match the corresponding native app's surrounding iOS behavior where the web
   surface exposes an equivalent: an invariant edge-to-edge vertical canvas,
   safe control insets, bounce, refresh, edge-back, keyboard dismissal,
   recovery, and app-icon appearances. Instagram video is aspect-fit so the
   complete horizontal source remains visible instead of being crop-filled.
3. Never transfer protected browser credentials. The one browser-identity
   exception is the explicit unsupported YouTube compatibility suffix below.

## Intentional differences

- YouTube Shorts is always unavailable.
- Instagram Reels, Explore, suggested posts, shopping/live, and ads can be
  unavailable when the active Vigil policy blocks them.
- YouTube Home, Explore, suggestions, and ads can be unavailable when the
  active Vigil policy blocks them.
- Both companions remain contained to explicitly supported service and
  authentication origins. YouTube additionally admits only the exact
  `accounts.youtube.com/accounts/SetSID` session-handoff route (with an optional
  trailing slash) in a main frame or flattened popup. Embedded frames may also
  use exact `accounts/CheckConnection` and `RotateCookiesPage` paths for account
  availability and session rotation; every other `accounts.youtube.com` route
  fails closed.
- Instagram login, recovery, two-factor, checkpoint, and allowed Facebook
  authorization documents run without Vigil's DOM/media hooks. Google sign-in,
  YouTube consent, and the exact YouTube session handoff are likewise kept
  outside every Vigil DOM/media/player hook. A completed same-document Instagram
  sign-in reloads once before protected content appears.
- YouTube ordinary content remains subject to the configured on-device
  classifier. Instagram uses only its route/card policy guards so its rapidly
  changing media DOM is not repeatedly concealed and rebuilt. Both companions
  remain subject to the supervised web policy, and YouTube retains overlapping
  native/DOM Shorts guards.
- Neither companion enables Picture in Picture, AirPlay/Cast, or unrestricted
  external link handoff.

These differences must not be removed to improve visual parity.

## Native-only limitations

The companion architecture cannot reproduce private native component trees,
caches, or gesture recognizers. In particular:

- Google officially treats embedded user agents as unsupported. At the user's
  explicit request, the YouTube-only `WKWebViewConfiguration` appends TinyTube's
  documented `applicationNameForUserAgent` value
  `Version/17.0 Safari/605.1.15`. This unsupported application-name suffix does
  not replace `customUserAgent`, does not import Safari credentials, and may
  stop working whenever Google changes its policy or detection. Instagram and
  the default diagnostic path retain WebKit's truthful identity.
- Vigil intentionally does not reproduce YouTube's native miniplayer. Moving a
  live WebKit video surface between a compact overlay and a second browsing web
  view is not reliable on the supported Personal Team companion path. Ordinary
  playback and swipe-up fullscreen remain available; private native player
  transitions, Cast integration, uploads, editing, notifications, and the
  native prefetch pipeline are not available from `m.youtube.com`.
- Instagram's native prefetch cache, notification integration, and private
  story/feed component behavior are not available through its mobile website.

The app must show a truthful recoverable state when one of these limitations is
encountered. The unsupported YouTube-only suffix must not expand into a custom
user-agent replacement, cookie transfer, broader authentication allowlist, or
weaker Shorts/content policy.

## Reference baseline

The July 27, 2026 audit used:

- iPhone 17, iOS 27.0, 402 × 874 points.
- Instagram 439.0.0 (`com.burbn.instagram`).
- YouTube 21.29.3 (`com.google.ios.youtube`).
- Instagram and YouTube light, dark, and tinted Home Screen appearances.

The icon masters were synchronized from the current US App Store artwork during
the audit. Instagram publishes only its full-color master so Automatic/Dark
appearance cannot select stale hand-matched grayscale artwork; iOS remains
responsible for an explicitly selected system tint.

Official-app observations should be refreshed whenever either service changes
its major navigation, story/player, or icon presentation.

## Required verification matrix

### Shared shell

- Cold launch, warm launch, foreground/background/inactive transitions.
- Light/dark page chrome and status-bar contrast.
- Top and bottom safe-area clearance on every supported iPhone size.
- Keyboard appearance and interactive dismissal.
- Leading-edge history navigation without stealing center-screen carousels.
- Feed-only pull-to-refresh; no refresh recognizer in stories, watch/player,
  modal, login, or Direct surfaces.
- Offline, timeout, authentication, and WebContent-process recovery.
- Light, dark, and tinted app icons for both fixed bundle identifiers.

### Instagram

- Login, forgot-password recovery, two-factor, checkpoint/challenge, and
  Facebook authorization work with Meta's original page environment.
- Feed inertia and rapid-scroll lazy loading.
- Horizontal post carousels and story-tray scrolling.
- Story open size, progress, tap-forward/back, automatic advance, reply field,
  swipe/close behavior, and return to the prior feed position.
- The Reels tab and plural `/reels/` discovery destination are permanently
  unavailable, including at Level 1. Their entry points are hidden at document
  start and direct navigation is redirected to Direct.
- Friendly Reel media embedded in a followed feed/profile post or Direct thread
  remains available. A singular `/reel/{id}` permalink shared by another person
  may open, but the companion contains it to that item instead of permitting an
  advance into another Reel. An article must never be hidden merely because it
  contains its own Reel permalink.
- Repost, like, playback, mute, comments, and navigation use Instagram's own
  controls. Vigil must not inject proxy controls or reinterpret tap, hold,
  double-tap, pinch, or swipe gestures.
- Instagram appearance reporting must not change the native color scheme or
  safe-area geometry while the page is loading or navigating.
- Profile/post/Direct navigation and edge-back.
- Media remains concealed until its configured safety verdict and sensitive
  media cannot continue audibly.
- Locking the phone or backgrounding Instagram pauses playback, removes its
  Lock Screen/Dynamic Island Now Playing controls, and prevents external replay.
  Returning to the app may resume only the visible item that was playing.

### YouTube

- Home, Search, Subscriptions, ordinary Watch, comments, and related content.
- Google sign-in is attempted from YouTube's site-generated route, uses the
  persistent WK website-data store, and either persists there on relaunch or
  exposes Google's failure truthfully. No credential import is permitted.
- Horizontal topic shelves, progress scrubbing, fullscreen transitions, and
  edge-back.
- Downward player gestures remain owned by YouTube/WebKit and do not create a
  miniplayer or a second browsing web view.
- Swipe-up fullscreen does not steal progress scrubbing, buttons, links, or iOS
  edge-back.
- Thumbnail and player preload under rapid scrolling.
- Direct Shorts routes and Shorts UI remain blocked by native navigation,
  document-start route policy, and the reused parity script's same-document
  guard.
- Shorts stays absent from navigation and shelves; direct/deep `/shorts` links
  are blocked or recovered to Home.

## Development-safe YouTube updates

Safari remembers whether an extension is enabled by its bundle identifier and
permission contract. After the one-time offline activation of `Vigil YouTube
Controls`, ordinary YouTube interaction work must update that same extension in
place:

```sh
npm run ios:youtube:develop
```

This command builds, audits, signs, and installs both Personal Team companions
and their freshly generated supervised web-filter profile in one transaction.
The native YouTube sign-in path depends on exact authentication URLs, so an
app-only development update is not sufficient. Before installation the command
also compares the built controls extension with the last deployment receipt and
refuses a new bundle identifier, manifest version, host scope, content-script
scope, or API permission set. JavaScript, CSS, and other implementation bytes
may change. The receipt records the complete extension contract and the
app-root YouTube parity-script hash for the next update.

Adding another Safari extension or changing the controls extension's identity
or permissions is a maintenance operation, not an ordinary development update.
It must be done while the iPhone is offline, with the exact restriction profile
restored and verified before connectivity returns. Do not enroll the phone in a
new management system or disturb its supervision/Home Screen checkpoint for
routine app development.

## Commands

Run the deterministic simulator suite:

```sh
npm run ios:social:test
```

Audit generated phone policies:

```sh
npm run ios:phone:audit
```

After a signed physical build is installed, compare by exact bundle identifier:

```sh
xcrun devicectl device process launch --device <device> com.burbn.instagram
xcrun devicectl device process launch --device <device> tech.caseline.vigil.instagram
xcrun devicectl device process launch --device <device> com.google.ios.youtube
xcrun devicectl device process launch --device <device> tech.caseline.vigil.youtube
```

iPhone Mirroring is suitable for screenshot geometry and navigation checks.
Scroll inertia, competing recognizers, perceived preload latency, and dropped
frames must also be checked on the physical phone because mirroring adds its own
input and video latency.

## Current physical-device status

The Personal Team Instagram and YouTube companions are installed on the
physical phone as 0.3.40 (43). The supervised policy still matches the current
generated source exactly (`bab127c02bb9`); no restriction was removed or
weakened. A final exact-bundle launch attempt was denied because the phone was
locked, rather than because the app failed to install.

The final update receipt/profile-label refresh could not be written because the
`pymobiledevice3` USB channel disappeared after both apps were installed. The
live policy itself remains current. Reconnect the phone over USB and rerun
`npm run ios:phone:update:personal` before treating the deployment receipt as
complete. The user explicitly declined a visual confirmation for this update.
