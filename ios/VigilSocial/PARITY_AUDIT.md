# VigilSocial parity contract

VigilSocial contains two fixed companions. Each companion renders the service's
current mobile website in a persistent `WKWebView`, then applies Vigil's
content-safety and focused-social policy. A mismatch caused by Vigil outside
the intentional differences below is a bug.

The practical target is:

1. Preserve the service mobile site's layout, sizing, lazy loading, media
   behavior, and in-page gestures.
2. Match the corresponding native app's surrounding iOS behavior where WebKit
   exposes an equivalent: safe areas, bounce, refresh, edge-back, keyboard
   dismissal, lifecycle pausing, recovery, and app-icon appearances.
3. Never claim or simulate native-only behavior that the service does not
   expose to an embedded browser.

## Intentional differences

- YouTube Shorts is always unavailable.
- Instagram Reels, Explore, suggested posts, shopping/live, and ads can be
  unavailable when the active Vigil policy blocks them.
- YouTube Home, Explore, suggestions, and ads can be unavailable when the
  active Vigil policy blocks them.
- Navigation remains contained to explicitly supported service and
  authentication origins.
- Unknown or sensitive media remains subject to the configured on-device
  content-safety policy.
- Background audio, Picture in Picture, AirPlay/Cast, and unrestricted external
  link handoff are not enabled by the companion.

These differences must not be removed to improve visual parity.

## Native-only limitations

The companion architecture cannot reproduce private native component trees,
caches, or gesture recognizers. In particular:

- Google rejects OAuth inside embedded WebKit. The companion cannot inherit the
  YouTube app's or Safari's signed-in session.
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

The light icon masters were synchronized from the current US App Store
artwork during the audit. Dark and tinted variants were matched against the
installed apps in iOS Home Screen appearance previews.

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
- Offline, timeout, unsupported-authentication, and WebContent-process recovery.
- Light, dark, and tinted app icons for both fixed bundle identifiers.

### Instagram

- Feed inertia and rapid-scroll lazy loading.
- Horizontal post carousels and story-tray scrolling.
- Story open size, progress, tap-forward/back, automatic advance, reply field,
  swipe/close behavior, and return to the prior feed position.
- Profile/post/Direct navigation and edge-back.
- Media remains concealed until its configured safety verdict and sensitive
  media cannot continue audibly.

### YouTube

- Home, Search, Subscriptions, ordinary Watch, comments, and related content.
- Signed-out Home and an empty Subscriptions surface remain usable rather than
  being covered by recovery UI.
- Horizontal topic shelves, progress scrubbing, fullscreen transitions, and
  edge-back.
- Thumbnail and player preload under rapid scrolling.
- Playback checkpointing on pause, route change, background, and process loss
  without overriding explicit `t`/`start` links.
- Shorts stays absent from navigation, shelves, history routes, embeds, and
  direct/deep links.

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
