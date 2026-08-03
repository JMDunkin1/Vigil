# Companion app icons

The production Home Screen icons are the service-specific app icon sets in
`../Assets.xcassets`. Their 1024×1024 light masters come from the current U.S.
App Store artwork for Instagram (`389801252`) and YouTube (`544007664`).

Instagram intentionally publishes only that full-color App Store master to its
production icon set. This keeps Automatic/Dark Home Screen appearance from
selecting Vigil's old hand-matched grayscale artwork; iOS may still apply its
own system tint when the user explicitly selects Tinted appearance.

`IconSources` contains historical editable appearance sources. Regenerate the
App Store masters when a service changes its production icon, then verify every
Home Screen appearance on a physical iPhone.

The 180×180 `instagram.png` and `youtube.png` files are retained only for legacy
resource compatibility; Xcode does not use them as `CFBundleIconFiles`.
