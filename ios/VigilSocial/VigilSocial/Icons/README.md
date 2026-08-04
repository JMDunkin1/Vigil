# Companion app icons

The production Home Screen icons are the service-specific app icon sets in
`../Assets.xcassets`. YouTube's 1024×1024 light master comes from the current
U.S. App Store artwork (`544007664`).

Instagram is rendered from the clean vector masters in `IconSources`. Its
App Store artwork already contains a flattened glass treatment, so using that
image as an app-icon input makes current iOS releases add material twice. The
light, dark, and tinted assets instead contain only the familiar gradient and
camera geometry. All three production PNGs are opaque RGB, 1024×1024, and
visually distinct; iOS remains responsible for the final mask and Home Screen
material exactly once.

Run `node scripts/refresh-ios-social-icons.mjs` from the repository root to
render Instagram's SVGs through `scripts/render-opaque-png.swift` and refresh
YouTube's App Store master. Then verify Default, Dark, and Tinted appearances
on a physical iPhone. An Icon Composer package is intentionally not shipped:
even with layer effects, specular highlights, shadow, and translucency disabled,
the current Composer renderer adds a material edge that does not match the
requested flatter Instagram treatment.

The 180×180 `instagram.png` and `youtube.png` files are retained only for legacy
resource compatibility; Xcode does not use them as `CFBundleIconFiles`.
