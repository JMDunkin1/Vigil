# Companion app icons

The production Home Screen icons are the service-specific app icon sets in
`../Assets.xcassets`. Their 1024×1024 light masters come from the current U.S.
App Store artwork for Instagram (`389801252`) and YouTube (`544007664`).

`IconSources` contains the editable dark and tinted appearance sources matched
against the installed apps. Regenerate all 1024×1024 catalog renditions when a
service changes its production icon, then verify light, dark, and tinted Home
Screen appearances on a physical iPhone.

The 180×180 `instagram.png` and `youtube.png` files are retained only for legacy
resource compatibility; Xcode does not use them as `CFBundleIconFiles`.
