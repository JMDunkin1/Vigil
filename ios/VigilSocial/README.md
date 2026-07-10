# Vigil social iOS apps

The project produces three independent iPhone applications. Each build has its own bundle identifier, normal app name and icon, fixed service, cookie store, and saved state. There is no shared service picker.

- `tech.caseline.vigil.instagram` builds as **Instagram**.
- `tech.caseline.vigil.youtube` builds as **YouTube**.
- `tech.caseline.vigil.snapchat` builds as **Snapchat**.

The shared SwiftUI/WebKit source uses targeted DOM adapters for the requested friction:

- YouTube Shorts navigation is blocked and video position is stored per video.
- Instagram uses the full available width, keeps edge navigation gestures enabled, hides Reels, Explore, and suggested surfaces, and remembers the audio preference.
- Snapchat requests the desktop web client, hides known Spotlight and Stories entry points, and reports an explicit degraded or unsupported state when Snapchat rejects WebKit.

YouTube authentication must be verified on the physical phone. Google can reject embedded `WKWebView` sign-in with `disallowed_useragent`; the adapter detects signed-out/failed-auth states and reports them instead of declaring the wrapper ready. Level 1 keeps native YouTube available as the supported fallback.

Each app uses WebKit's persistent default data store, so its session and cookies survive relaunches. The apps declare neither background audio nor Live Activities. iOS can still show the Dynamic Island while WebKit is actively playing media; there is no supported API for a third-party app to suppress that system indicator. Media is paused when an app leaves the active scene.

The app code hard-codes only Vigil's permanent YouTube Shorts and Snapchat Spotlight/Stories blocks. Configurable Instagram and other feature toggles remain the MDM web-filter policy's responsibility; the iPhone apps do not yet receive live `FocusedSocialSettings` from the desktop agent.

Snapchat currently rejects its web client inside an iOS `WKWebView`, including with a desktop user agent. Its build intentionally reports that unsupported state. Do not hide or replace native Snapchat with this build unless a working client is proven on the physical phone.

```sh
xcodebuild -allowProvisioningUpdates \
  -project ios/VigilSocial/VigilSocial.xcodeproj \
  -scheme VigilSocial \
  -sdk iphoneos \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/Vigil-Instagram-device \
  PRODUCT_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram \
  PRODUCT_NAME=Instagram \
  SOCIAL_APP_NAME=Instagram \
  SOCIAL_ICON_NAME=instagram.png \
  VIGIL_SERVICE=instagram \
  SOCIAL_URL_SCHEME=vigil-instagram \
  DEVELOPMENT_TEAM=3RY7A22U4L \
  CODE_SIGN_STYLE=Automatic build
```

Do not install the app or either ManageEngine profile until Vigil has a current, complete iPhone layout checkpoint. The static launcher profile and dynamic enforcement profile are intentionally separate so Level changes cannot expire and recreate the launcher icons.
