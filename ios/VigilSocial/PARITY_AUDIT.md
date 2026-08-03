# VigilSocial parity contract

VigilSocial contains two fixed companions. Instagram renders the current mobile
website in a persistent `WKWebView` with Vigil's content-safety and focused-
social policy. YouTube uses `SFSafariViewController`, the Google-supported
signed-in browser surface, with a bundled Safari content blocker that removes
Shorts. A mismatch caused by Vigil outside the intentional differences below is
a bug.

The practical target is:

1. Preserve the service mobile site's layout, sizing, lazy loading, media
   behavior, and in-page gestures.
2. Match the corresponding native app's surrounding iOS behavior where the web
   surface exposes an equivalent: safe areas, bounce, refresh, edge-back,
   keyboard dismissal, recovery, and app-icon appearances.
3. Never spoof a browser identity or transfer protected browser credentials.

## Intentional differences

- YouTube Shorts is always unavailable.
- Instagram Reels, Explore, suggested posts, shopping/live, and ads can be
  unavailable when the active Vigil policy blocks them.
- YouTube Home, Explore, suggestions, and ads can be unavailable when the
  active Vigil policy blocks them.
- Instagram navigation remains contained to explicitly supported service and
  authentication origins. YouTube uses Safari's visible, secure browser chrome.
- Instagram login, recovery, two-factor, checkpoint, and allowed Facebook
  authorization documents run without Vigil's DOM/media hooks. A completed
  same-document sign-in reloads once before protected Instagram content appears.
- Instagram media remains subject to the configured on-device classifier.
  YouTube remains subject to the supervised web policy and Shorts blocker.
- Instagram does not enable background audio, Picture in Picture, AirPlay/Cast,
  or unrestricted external link handoff. YouTube retains the browser features
  that YouTube and iOS expose.

These differences must not be removed to improve visual parity.

## Native-only limitations

The companion architecture cannot reproduce private native component trees,
caches, or gesture recognizers. In particular:

- Google rejects OAuth inside embedded WebKit. YouTube therefore uses
  `SFSafariViewController`; sign-in persists while its cookies and page contents
  remain inaccessible to Vigil.
- YouTube's native miniplayer drag/pinch gestures, Cast integration, uploads,
  editing, notifications, and native prefetch pipeline are not available from
  `m.youtube.com`.
- Instagram's native prefetch cache, notification integration, and private
  story/feed component behavior are not available through its mobile website.

The app must show a truthful recoverable state when one of these limitations is
encountered. It must not spoof a user agent or weaken navigation/content policy
to conceal the limitation.

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
- Profile/post/Direct navigation and edge-back.
- Media remains concealed until its configured safety verdict and sensitive
  media cannot continue audibly.

### YouTube

- Home, Search, Subscriptions, ordinary Watch, comments, and related content.
- Google sign-in succeeds through the supported Safari surface and persists on
  relaunch.
- Horizontal topic shelves, progress scrubbing, fullscreen transitions, and
  edge-back.
- Thumbnail and player preload under rapid scrolling.
- The companion refuses to open YouTube until its content blocker is enabled.
- Shorts stays absent from navigation and shelves; direct/deep `/shorts` links
  are blocked or recovered to Home.

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

The official apps were captured and exercised through iPhone Mirroring during
this audit. The previously installed Vigil companions could not be relaunched:
their Personal Team provisioning profile expired on July 26, 2026, and the
installed Xcode 27 beta has no Apple Account configured to issue a replacement.
The fixed companions therefore passed the simulator matrix, but the
physical-only gesture and perceived-preload checks above must be repeated after
the apps are signed and updated in place.
