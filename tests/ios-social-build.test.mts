import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildArguments } from "../scripts/build-ios-social-app.mjs";
import { SIMCTL_LIST_TIMEOUT_MS, selectIosSimulator } from "../scripts/test-ios-social.mjs";
import { FOCUSED_SOCIAL_PLATFORMS } from "../src/socialFeatureFilters.js";
import { socialIconPngBase64 } from "../src/socialIconAssets.js";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const projectRoot = existsSync(join(runtimeRoot, "ios")) ? runtimeRoot : resolve(runtimeRoot, "..", "..");
const phoneRelease = JSON.parse(await readFile(join(projectRoot, "ios", "phone-release.json"), "utf8")) as {
  build: number;
  version: string;
};
const socialWebViewStoreSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "SocialWebViewStore.swift"),
  "utf8"
);
const socialDOMAdaptersSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "DOMAdapters.swift"),
  "utf8"
);
const socialRootViewSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "RootView.swift"),
  "utf8"
);
const youtubeSafariSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "YouTubeSafariView.swift"),
  "utf8"
);
const youtubeWKAuthDiagnosticSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "YouTubeWKAuthDiagnostic.swift"),
  "utf8"
);
const socialAppSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "VigilSocialApp.swift"),
  "utf8"
);
const youtubeBlockerRules = JSON.parse(await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeShortsBlocker", "blockerList.json"),
  "utf8"
)) as Array<{ action?: { type?: string; selector?: string }; trigger?: { "url-filter"?: string } }>;
const socialProjectSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial.xcodeproj", "project.pbxproj"),
  "utf8"
);
const youtubeBlockerInfo = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeShortsBlocker", "Info.plist"),
  "utf8"
);
const youtubeInteractionManifest = JSON.parse(await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Resources", "manifest.json"),
  "utf8"
)) as { content_scripts?: Array<{ js?: string[]; matches?: string[] }>; host_permissions?: string[] };
const youtubeInteractionSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Resources", "youtube-parity.js"),
  "utf8"
);
const youtubeInteractionInfo = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Info.plist"),
  "utf8"
);
const socialInfoPlistSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Info.plist"),
  "utf8"
);

assert.doesNotMatch(
  socialWebViewStoreSource,
  /UIApplication\.shared\.open/u,
  "fixed social companions must cancel navigation outside their allowlisted service instead of handing an unrestricted URL to Safari"
);
assert.match(
  socialRootViewSource,
  /\.preferredColorScheme\(reportedIsDark\.map \{ \$0 \? \.dark : \.light \}\)/u,
  "reported page appearance must drive host/status-bar contrast"
);
assert.match(
  socialRootViewSource,
  /SocialWebView\([\s\S]*?webView: store\.webView\(for: service\)/u,
  "Instagram must render its protected persistent WKWebView"
);
assert.match(
  socialRootViewSource,
  /webViewSafeAreaEdges: Edge\.Set = service == \.instagram\s*\? \[\.top, \.bottom\]\s*: \.bottom/u,
  "Instagram must keep one invariant full-screen WKWebView frame across route changes"
);
assert.doesNotMatch(
  socialRootViewSource,
  /webViewSafeAreaEdges:[\s\S]{0,160}usesFullBleedTop/u,
  "Reels route reports must adjust content inset without resizing the WKWebView host"
);
assert.match(
  socialRootViewSource,
  /phase == \.active \{\s*store\.resumeSuspendedMedia\(\)\s*\} else \{\s*store\.suspendAllMedia\(\)/u,
  "Instagram must suspend media whenever its scene leaves the foreground"
);
assert.match(
  socialWebViewStoreSource,
  /setAllMediaPlaybackSuspended\(true\)/u,
  "backgrounded Instagram media must be blocked from external replay by WebKit"
);
assert.match(
  socialWebViewStoreSource,
  /setAllMediaPlaybackSuspended\(false\)/u,
  "foregrounding must pair WebKit media suspension with an explicit release"
);
assert.match(socialWebViewStoreSource, /nowPlayingCenter\.playbackState = \.stopped/u);
assert.match(socialWebViewStoreSource, /nowPlayingCenter\.nowPlayingInfo = nil/u);
assert.match(
  socialWebViewStoreSource,
  /AVAudioSession\.sharedInstance\(\)\.setActive\(\s*false,[\s\S]*?notifyOthersOnDeactivation/u,
  "Instagram must relinquish its iOS audio session when it leaves the foreground"
);
assert.match(
  socialDOMAdaptersSource,
  /navigator\.mediaSession\.metadata = null/u,
  "Instagram's page-level Now Playing metadata must be cleared on suspension"
);
assert.match(
  socialRootViewSource,
  /if service == \.youtube \{\s*YouTubeFilterHostView\(\)/u,
  "the YouTube extension host must not render a browser surface"
);
assert.match(
  socialRootViewSource,
  /if service == \.instagram \{\s*YouTubeContentBlockerGate\(isDark: isDark\)/u,
  "Instagram must verify the migrated YouTube blocker before the old helper app is removed"
);
assert.match(socialRootViewSource, /SFContentBlockerManager\.getStateOfContentBlocker/u);
assert.match(socialRootViewSource, /SFSafariExtensionManager\.getStateOfExtension/u,
  "the containing app must report whether the ordinary-watch gesture extension is actually enabled");
assert.match(socialRootViewSource, /allow access to youtube\.com/u,
  "the disabled controls state must explain Safari's per-site access requirement");
assert.match(socialRootViewSource, /SFSafariSettings\.openExtensionsSettings/u);
assert.doesNotMatch(
  socialRootViewSource,
  /YouTubeSafariView\(request: store\.youtubeSafariRequest\)/u,
  "YouTube must not add SafariViewController chrome around the active companion surface"
);
assert.match(
  socialWebViewStoreSource,
  /if loadInitialPages, selectedService != \.youtube/u,
  "the YouTube filter host must not create or load a WKWebView"
);
assert.match(youtubeWKAuthDiagnosticSource, /^#if DEBUG/u,
  "the WKWebView authentication probe must compile only in Debug builds");
assert.match(socialAppSource, /#if DEBUG[\s\S]*?YouTubeWKAuthDiagnosticActivation\.isRequested/u,
  "the WKWebView authentication probe must require an explicit Debug launch argument");
assert.match(
  youtubeWKAuthDiagnosticSource,
  /autoLoadArgument = "--vigil-youtube-wk-auth-diagnostic-autoload"[\s\S]*?arguments\.contains\(optInArgument\) && arguments\.contains\(autoLoadArgument\)/u,
  "automatic loading must require a second explicit argument in addition to the primary diagnostic opt-in"
);
assert.match(socialAppSource, /YouTubeWKAuthDiagnosticView\([\s\S]*?shouldAutoLoad/u,
  "the Debug-only app route must explicitly pass the double-opt-in auto-load decision");
assert.match(
  youtubeWKAuthDiagnosticSource,
  /youtubeEntryArgument = "--vigil-youtube-wk-auth-diagnostic-youtube-entry"[\s\S]*?https:\/\/m\.youtube\.com\/signin/u,
  "the probe should offer a separately gated first-party YouTube sign-in entry route"
);
assert.match(
  youtubeWKAuthDiagnosticSource,
  /url\.absoluteString == "about:blank"[\s\S]*?return permitsAboutBlankSubframe/u,
  "about:blank must remain blocked except when the delegate identifies a subframe"
);
assert.match(
  youtubeWKAuthDiagnosticSource,
  /didReceiveServerRedirectForProvisionalNavigation[\s\S]*?safeHostLabel/u,
  "the probe should record server redirects using sanitized host labels only"
);
assert.match(youtubeWKAuthDiagnosticSource, /websiteDataStore\s*=\s*\.default\(\)/u,
  "the probe should test WebKit's ordinary persistent data store");
assert.match(youtubeWKAuthDiagnosticSource, /accounts\.google\.com\/ServiceLogin\?service=youtube/u,
  "the probe must exercise Google's first-party YouTube ServiceLogin document without private OAuth configuration");
assert.match(
  youtubeWKAuthDiagnosticSource,
  /host\?\.lowercased\(\) == "accounts\.youtube\.com"[\s\S]*?url\.path == "\/accounts\/SetSID"/u,
  "the probe must narrowly permit YouTube's first-party post-authentication session handoff"
);
assert.match(youtubeWKAuthDiagnosticSource, /webView\.customUserAgent = nil/u,
  "the probe must retain WebKit's truthful user-agent identity");
assert.match(
  youtubeWKAuthDiagnosticSource,
  /if useUnsupportedSafariSuffix[\s\S]*?applicationNameForUserAgent = "Version\/17\.0 Safari\/605\.1\.15"/u,
  "the documented unsupported Safari suffix must remain inside its explicit diagnostic variant"
);
assert.match(
  youtubeWKAuthDiagnosticSource,
  /usesUnsupportedSafariSuffix[\s\S]*?shouldAutoLoad\(arguments: arguments\) && arguments\.contains\(safariSuffixArgument\)/u,
  "the unsupported Safari suffix must require both the primary and auto-load diagnostic opt-ins"
);
assert.doesNotMatch(youtubeWKAuthDiagnosticSource, /preferredContentMode\s*=/u,
  "the probe must not force a desktop or mobile content mode that could alter WebKit's default identity");
assert.doesNotMatch(
  youtubeWKAuthDiagnosticSource,
  /addUserScript|evaluateJavaScript|httpCookieStore|HTTPCookie|UIApplication\.shared\.open/u,
  "the probe must not inject scripts, inspect cookies/page content, or open Safari"
);
assert.match(youtubeSafariSource, /SFSafariViewController/u);
assert.match(
  youtubeSafariSource,
  /if session\.isPreparingInitialPresentation \{\s*YouTubeLaunchPlaceholder\(\)/u,
  "the initial blocker check should use a quiet launch placeholder instead of looking like a redirect"
);
assert.match(
  youtubeSafariSource,
  /SFSafariViewController\.prewarmConnections\(to: \[url\]\)/u,
  "the signed-in YouTube surface should prewarm its initial connection while the blocker is verified"
);
assert.match(
  youtubeSafariSource,
  /#if targetEnvironment\(simulator\)[\s\S]*?return[\s\S]*?#else[\s\S]*?SFSafariViewController\.prewarmConnections/u,
  "simulator builds must not retain a stale prewarmed SafariViewService across companion rebuilds"
);
assert.match(
  youtubeSafariSource,
  /windowScene\.activationState == \.foregroundActive/u,
  "SafariViewService presentation must wait until the companion scene is fully active"
);
assert.match(youtubeSafariSource, /SFContentBlockerManager\.getStateOfContentBlocker/u);
assert.match(youtubeSafariSource, /SFSafariSettings\.openExtensionsSettings/u,
  "supported iOS releases must open the exact Safari extension settings pane");
assert.match(youtubeSafariSource, /isFilterEnabled == true/u);
assert.match(youtubeBlockerInfo, /<key>CFBundleIdentifier<\/key>\s*<string>\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>/u,
  "the embedded blocker must publish the bundle identifier Xcode validates against its parent app");
assert.match(socialProjectSource, /VIGIL_APP_BUNDLE_IDENTIFIER = tech\.caseline\.vigil\.youtube;/u,
  "the blocker target needs a standalone default bundle prefix for tests and local builds");
assert.match(
  socialProjectSource,
  /D60000000000000000000001 \/\* VigilInstagram \*\/[\s\S]*?D40000000000000000000004 \/\* Embed App Extensions \*\/[\s\S]*?D70000000000000000000001 \/\* PBXTargetDependency \*\//u,
  "Instagram must carry the YouTube content blocker before the standalone YouTube helper can be removed"
);
assert.match(
  socialProjectSource,
  /D1000000000000000000000F \/\* VigilYouTubeShortsBlocker\.appex in Embed App Extensions \*\//u,
  "Instagram must copy the signed content blocker into its app bundle"
);
assert.match(
  socialProjectSource,
  /E10000000000000000000004 \/\* VigilYouTubeInteractionExtension\.appex in Embed App Extensions \*\//u,
  "Instagram must copy the signed ordinary-watch interaction extension into its app bundle"
);
assert.doesNotMatch(
  socialProjectSource,
  /PhoneBlocklist|adult-blocklist|Copy Phone Blocklist|copy-phone-blocklist/u,
  "the narrow Instagram and YouTube companions must not compile or copy the general adult-domain blocklist"
);
assert.doesNotMatch(
  socialWebViewStoreSource,
  /PhoneBlocklist|phoneBlocklist|adult-blocklist/u,
  "the narrow social web view must rely on its exact host/path allowlist instead of loading a general-domain index"
);
assert.match(
  socialProjectSource,
  /PRODUCT_BUNDLE_IDENTIFIER = "\$\(VIGIL_APP_BUNDLE_IDENTIFIER\)\.youtube-controls";/u,
  "the interaction extension must remain inside the signed Instagram app namespace"
);
assert.match(youtubeInteractionInfo, /com\.apple\.Safari\.web-extension/u);
assert.deepEqual(youtubeInteractionManifest.host_permissions, [
  "https://youtube.com/*",
  "https://www.youtube.com/*",
  "https://m.youtube.com/*"
], "the interaction extension must not receive access outside YouTube");
assert.deepEqual(
  youtubeInteractionManifest.content_scripts?.[0]?.js,
  ["youtube-parity.js"],
  "the interaction extension must ship its tested parity script"
);
assert.match(youtubeInteractionSource, /enterMiniPlayer/u);
assert.match(youtubeInteractionSource, /exitMiniPlayer/u);
assert.match(youtubeInteractionSource, /dismissMiniPlayer/u);
assert.match(youtubeInteractionSource, /PointerEvent/u,
  "ordinary-watch gestures should use the primary iOS pointer-event path");
assert.match(youtubeInteractionSource, /webkitEnterFullscreen/u,
  "the ordinary player should retain swipe-up fullscreen parity");
assert.match(youtubeInteractionSource, /recoverFromShorts/u,
  "same-document Shorts navigation must recover to ordinary YouTube instead of exposing Shorts");
assert.match(youtubeInteractionSource, /const isShortsRoute/u);
assert.doesNotMatch(youtubeInteractionSource, /accounts\.google\.com/u,
  "ordinary-watch gestures do not need access to Google sign-in documents");
assert.equal(
  youtubeBlockerRules.some((rule) => rule.action?.type === "block" && rule.trigger?.["url-filter"]?.includes("/shorts")),
  true,
  "direct YouTube Shorts documents must be blocked"
);
assert.equal(
  youtubeBlockerRules.some((rule) => rule.action?.type === "block"
    && rule.trigger?.["url-filter"]?.includes("reel_watch_sequence")
  ) && youtubeBlockerRules.some((rule) => rule.action?.type === "block"
    && rule.trigger?.["url-filter"]?.includes("reel_item_watch")),
  true,
  "YouTube's live Shorts sequence and item endpoints must be blocked even after same-document routing"
);
assert.equal(
  youtubeBlockerRules.some((rule) => rule.action?.type === "css-display-none" && rule.action.selector?.includes("ytm-reel-shelf-renderer")),
  true,
  "mobile YouTube Shorts shelves must be removed"
);
assert.equal(
  youtubeBlockerRules.some((rule) => rule.action?.type === "css-display-none"
    && rule.action.selector?.includes("ytm-pivot-bar-item-renderer:nth-of-type(2)")),
  true,
  "mobile YouTube's current shadow-DOM pivot host for Shorts must be removed"
);
assert.match(
  socialRootViewSource,
  /webView\.overrideUserInterfaceStyle = isDark \? \.dark : \.light/u,
  "reported page appearance must drive the embedded web view interface style"
);

const instagram = buildArguments(["instagram", "--unsigned", "--destination", "generic/platform=iOS Simulator"]);
assert.equal(instagram[instagram.indexOf("-scheme") + 1], "VigilInstagram");
assert.ok(instagram.includes("VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.instagram"));
assert.ok(instagram.includes("VIGIL_SERVICE=instagram"));
assert.ok(instagram.includes("SOCIAL_APP_NAME=Instagram"));
assert.ok(instagram.includes("SOCIAL_APP_ICON_SET=InstagramAppIcon"));
assert.ok(instagram.includes("SOCIAL_URL_SCHEME=vigil-instagram"));
assert.ok(instagram.includes("VIGIL_UNCLASSIFIED_MEDIA_POLICY=conceal"));
assert.ok(instagram.includes(`MARKETING_VERSION=${phoneRelease.version}`));
assert.ok(instagram.includes(`CURRENT_PROJECT_VERSION=${phoneRelease.build}`));
assert.ok(instagram.includes("CODE_SIGNING_ALLOWED=NO"));

const explicitVersion = buildArguments(["youtube", "--version", "2.4.1", "--build", "37"]);
assert.equal(explicitVersion[explicitVersion.indexOf("-scheme") + 1], "VigilSocial");
assert.ok(explicitVersion.includes("VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.youtube"));
assert.ok(explicitVersion.includes("VIGIL_SERVICE=youtube"));
assert.ok(explicitVersion.includes("SOCIAL_APP_NAME=YouTube Filter"));
assert.ok(explicitVersion.includes("SOCIAL_APP_ICON_SET=YouTubeAppIcon"));
assert.ok(explicitVersion.includes("SOCIAL_URL_SCHEME=vigil-youtube"));
assert.ok(explicitVersion.includes("MARKETING_VERSION=2.4.1"));
assert.ok(explicitVersion.includes("CURRENT_PROJECT_VERSION=37"));

const personalTeamFallback = buildArguments(["youtube", "--unclassified-media-policy", "reveal-unclassified"]);
assert.ok(personalTeamFallback.includes("VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified"));

assert.throws(() => buildArguments(["combined"]), /Unknown social service/);
assert.throws(() => buildArguments(["snapchat"]), /Unknown social service/);
assert.throws(() => buildArguments(["tiktok"]), /Unknown social service/);
assert.throws(() => buildArguments(["youtube", "--config", "Debug"]), /Unknown option: --config/);
assert.throws(() => buildArguments(["--service"]), /Missing value for --service/);
assert.throws(() => buildArguments(["youtube", "--destination", "--unsigned"]), /Missing value for --destination/);
assert.throws(
  () => buildArguments(["youtube", "--unclassified-media-policy", "allow"]),
  /Unknown unclassified media policy/
);

assert.match(
  socialProjectSource,
  /ASSETCATALOG_COMPILER_APPICON_NAME = "\$\(SOCIAL_APP_ICON_SET\)";/u,
  "the Xcode target must compile the service-selected app icon set"
);
assert.match(
  socialProjectSource,
  /Assets\.xcassets in Resources/u,
  "the social app asset catalog must be included in the resources build phase"
);
assert.doesNotMatch(
  socialInfoPlistSource,
  /CFBundleIcon(?:Files|Name)|SOCIAL_ICON_NAME/u,
  "the legacy plist PNG declaration must not override the compiled app icon catalog"
);

for (const [service, iconSet] of [["youtube", "YouTubeAppIcon"]] as const) {
  const contents = JSON.parse(await readFile(
    join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Assets.xcassets", `${iconSet}.appiconset`, "Contents.json"),
    "utf8"
  )) as {
    images: Array<{
      appearances?: Array<{ appearance: string; value: string }>;
      filename: string;
      idiom: string;
      platform: string;
      size: string;
    }>;
  };
  assert.deepEqual(
    contents.images.map((image) => ({
      appearance: image.appearances?.[0]?.value || "light",
      filename: image.filename,
      idiom: image.idiom,
      platform: image.platform,
      size: image.size
    })),
    [
      { appearance: "light", filename: `${service}-light.png`, idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearance: "dark", filename: `${service}-dark.png`, idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearance: "tinted", filename: `${service}-tinted.png`, idiom: "universal", platform: "ios", size: "1024x1024" }
    ],
    `${service} must provide light, dark, and tinted iOS app icons`
  );
}

const instagramIconContents = JSON.parse(await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Assets.xcassets", "InstagramAppIcon.appiconset", "Contents.json"),
  "utf8"
)) as {
  images: Array<{
    appearances?: Array<{ appearance: string; value: string }>;
    filename: string;
    idiom: string;
    platform: string;
    size: string;
  }>;
};
assert.deepEqual(
  instagramIconContents.images.map((image) => ({
    appearance: image.appearances?.[0]?.value || "light",
    filename: image.filename,
    idiom: image.idiom,
    platform: image.platform,
    size: image.size
  })),
  [
    { appearance: "light", filename: "instagram-light.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    { appearance: "dark", filename: "instagram-dark.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    { appearance: "tinted", filename: "instagram-tinted.png", idiom: "universal", platform: "ios", size: "1024x1024" }
  ],
  "Instagram must supply explicit clean pre-glass light, dark, and tinted appearances"
);

const instagramAppIconRoot = join(
  projectRoot,
  "ios",
  "VigilSocial",
  "VigilSocial",
  "Assets.xcassets",
  "InstagramAppIcon.appiconset"
);
const instagramAppIconPNGs = await Promise.all(
  instagramIconContents.images.map((image) => readFile(join(instagramAppIconRoot, image.filename)))
);
for (const [index, png] of instagramAppIconPNGs.entries()) {
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "Instagram app icon must be a PNG");
  assert.equal(png.readUInt32BE(16), 1024, "Instagram app icon must be 1024 pixels wide");
  assert.equal(png.readUInt32BE(20), 1024, "Instagram app icon must be 1024 pixels tall");
  assert.equal(png[24], 8, "Instagram app icon must use 8-bit channels");
  assert.equal(
    png[25],
    2,
    `${instagramIconContents.images[index].filename} must be opaque RGB without an alpha channel`
  );
}
assert.equal(instagramAppIconPNGs[0].equals(instagramAppIconPNGs[1]), false, "Instagram dark must differ from light");
assert.equal(instagramAppIconPNGs[0].equals(instagramAppIconPNGs[2]), false, "Instagram tinted must differ from light");
assert.equal(instagramAppIconPNGs[1].equals(instagramAppIconPNGs[2]), false, "Instagram dark and tinted must be distinct");

for (const platform of FOCUSED_SOCIAL_PLATFORMS) {
  if (platform.id !== "instagram" && platform.id !== "youtube") continue;
  const filename = `${platform.id}.png`;
  const canonical = await readFile(platform.id === "youtube"
    ? join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Icons", "youtube-webclip.png")
    : join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Icons", filename));
  const packaged = await readFile(join(runtimeRoot, "public", "art", "social", filename));
  assert.equal(packaged.equals(canonical), true, `${platform.id} runtime icon should match its canonical Xcode asset`);
}

const invalidIconRoot = await mkdtemp(join(tmpdir(), "vigil-social-icon-"));
try {
  const invalidIconDir = join(invalidIconRoot, "public", "art", "social");
  await mkdir(invalidIconDir, { recursive: true });
  await writeFile(join(invalidIconDir, "instagram.png"), "not a png");
  assert.throws(() => socialIconPngBase64("instagram", invalidIconRoot), /not a valid packaged PNG/);
  assert.throws(() => socialIconPngBase64("youtube", invalidIconRoot), /Could not load the youtube social icon/);
  assert.throws(() => socialIconPngBase64("unknown" as never, invalidIconRoot), /Unknown social icon/);
} finally {
  await rm(invalidIconRoot, { recursive: true, force: true });
}

assert.deepEqual(selectIosSimulator({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-25-4": [
      { name: "iPhone 16", udid: "older", isAvailable: true }
    ],
    "com.apple.CoreSimulator.SimRuntime.iOS-26-3": [
      { name: "iPad Air", udid: "ipad", isAvailable: true },
      { name: "iPhone 17 Pro", udid: "newer", isAvailable: true }
    ]
  }
}), { name: "iPhone 17 Pro", udid: "newer" });
assert.equal(selectIosSimulator({ devices: {} }), null);
assert.equal(SIMCTL_LIST_TIMEOUT_MS, 120_000);
