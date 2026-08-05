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
  apps: Record<string, { build: number; version: string }>;
};
const socialWebViewStoreSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "SocialWebViewStore.swift"),
  "utf8"
);
const socialServiceSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "SocialService.swift"),
  "utf8"
);
const socialDOMAdaptersSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "DOMAdapters.swift"),
  "utf8"
);
const instagramStableStart = socialDOMAdaptersSource.indexOf("private static let instagramStable =");
const instagramLegacyStart = socialDOMAdaptersSource.indexOf(
  "// Retained temporarily as a non-production reference"
);
assert.ok(instagramStableStart >= 0 && instagramLegacyStart > instagramStableStart);
const instagramStableAdapterSource = socialDOMAdaptersSource.slice(
  instagramStableStart,
  instagramLegacyStart
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
const iosProfilesSource = await readFile(join(projectRoot, "src", "iosProfiles.ts"), "utf8");
const parityAuditSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "PARITY_AUDIT.md"),
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
  /let primaryWebView = store\.webView\(for: service\)[\s\S]*?SocialWebView\([\s\S]*?webView: primaryWebView/u,
  "both fixed companions must render their protected persistent WKWebView"
);
assert.match(
  socialRootViewSource,
  /case \.loading where service == \.youtube:\s*(?:\/\/[^\n]*\n\s*)+EmptyView\(\)/u,
  "YouTube launch must expose its already protected WKWebView immediately instead of waiting behind the generic health overlay"
);
assert.match(
  socialRootViewSource,
  /case \.loading where service == \.instagram:\s*\/\/[\s\S]*?EmptyView\(\)\s*case \.loading:/u,
  "Instagram startup must expose its already-loading WKWebView instead of covering it with a protected-session spinner"
);
assert.match(
  socialRootViewSource,
  /webViewSafeAreaEdges: Edge\.Set = service == \.instagram\s*\? \[\]\s*: \.bottom/u,
  "Instagram must keep one invariant safe-area frame across route changes"
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
assert.doesNotMatch(socialRootViewSource, /YouTubeFilterHostView/u,
  "the YouTube target must render its contained WK surface instead of the retired Safari helper placeholder");
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
assert.match(socialWebViewStoreSource, /if loadInitialPages \{ _ = webView\(for: selectedService\) \}/u,
  "the fixed YouTube target must create and load its persistent WKWebView");
assert.match(
  socialWebViewStoreSource,
  /webViews\[service\] = webView[\s\S]*?webView\.load\(URLRequest\(url: service\.homeURL\)\)[\s\S]*?let refreshControl = UIRefreshControl\(\)/u,
  "cold-launch navigation must begin before nonessential scroll chrome is configured"
);
assert.match(
  socialRootViewSource,
  /Task\.sleep\(nanoseconds: 400_000_000\)[\s\S]*?self\.refresh\(\)/u,
  "unrelated Safari-extension state checks must yield the initial CPU and I/O window to Instagram"
);
assert.match(
  socialRootViewSource,
  /let reportedIsDark = service == \.instagram\s*\? nil\s*: store\.reportedChromeIsDark/u,
  "transient Instagram DOM backgrounds must not drive the native app appearance"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /scheduleReelsWarmup|normalizeReelSurface|normalizeBottomNavigation|normalizeCommentSheets|repost-proxy/u,
  "the production Instagram adapter must not prefetch or rewrite Instagram's layout and controls"
);
assert.match(
  instagramStableAdapterSource,
  /new MutationObserver\([\s\S]*?\{ childList: true, subtree: true \}/u,
  "the production Instagram adapter may observe inserted cards without watching style and class churn"
);
assert.match(
  instagramStableAdapterSource,
  /:has\(> :is\(a\[href="\/reels\/"\], a\[href="\/reels"\]\)\)/u,
  "blocked Reels navigation must remove its complete navigation item instead of leaving an orphaned icon or gap"
);
assert.match(
  instagramStableAdapterSource,
  /'suggested for you'[\s\S]*?'suggested posts'[\s\S]*?'suggested reels'[\s\S]*?'because you watched'[\s\S]*?'because you follow'/u,
  "Level 2 must recognize conservative exact labels for Instagram recommendation cards"
);
assert.match(
  instagramStableAdapterSource,
  /path === '\/reel'[\s\S]*?path\.startsWith\('\/reel\/'\)[\s\S]*?path === '\/reels'[\s\S]*?path\.startsWith\('\/reels\/'\)/u,
  "both standalone Reel viewer spellings must remain fail-closed"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /article\s+a\[href\*=["']\/reel\//u,
  "friendly inline Reels must not cause their containing followed/profile/Direct card to disappear"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /touchmove|scrollTop\s*=|scrollBy\(|overflow\s*=\s*['"]hidden/u,
  "the stable adapter must not seize Instagram's gestures or scrolling to contain Reels"
);
assert.match(
  socialWebViewStoreSource,
  /if service == \.instagram \{[\s\S]*?webView\.isOpaque = true[\s\S]*?webView\.backgroundColor = \.systemBackground[\s\S]*?webView\.scrollView\.backgroundColor = \.systemBackground/u,
  "Instagram must keep an opaque native backing surface during SPA document swaps"
);
assert.doesNotMatch(socialWebViewStoreSource, /guard service != \.youtube|selectedService != \.youtube/u,
  "YouTube navigation must not retain the retired no-WK early returns");
assert.match(
  socialServiceSource,
  /unsupportedSafariApplicationNameSuffix = "Version\/17\.0 Safari\/605\.1\.15"/u,
  "the unsupported competitor compatibility suffix must remain explicit and centralized"
);
assert.match(
  socialServiceSource,
  /case \.youtube:[\s\S]{0,420}URL\(string: "https:\/\/m\.youtube\.com\/feed\/subscriptions"\)!/u,
  "YouTube must start on Subscriptions instead of loading a blocked recommendations page and redirecting"
);
assert.match(
  socialWebViewStoreSource,
  /if service == \.youtube \{\s*configuration\.applicationNameForUserAgent =\s*YouTubeWebCompatibility\.unsupportedSafariApplicationNameSuffix/u,
  "only the YouTube WK configuration may receive the unsupported Safari application-name suffix"
);
assert.match(socialWebViewStoreSource, /configuration\.websiteDataStore = \.default\(\)/u,
  "the production YouTube WK surface must keep a persistent first-party website-data store");
assert.match(
  socialWebViewStoreSource,
  /let youtubeParitySource = service == \.youtube[\s\S]*?bundledYouTubeParityScript[\s\S]*?if let youtubeParitySource \{[\s\S]*?controller\.addUserScript[\s\S]*?injectionTime: \.atDocumentStart,[\s\S]*?forMainFrameOnly: true/u,
  "the exact ordinary-watch miniplayer/Shorts guard resource must be reused in the YouTube WK main frame"
);
assert.match(socialWebViewStoreSource, /forResource: "youtube-parity", withExtension: "js"/u,
  "the YouTube WK app must load the shared parity resource by its exact bundle name");
assert.match(
  socialProjectSource,
  /youtube-parity\.js in YouTube App Resources[\s\S]*?A40000000000000000000003[^\n]*youtube-parity\.js in YouTube App Resources/u,
  "the shared parity resource must be copied into the production YouTube app bundle"
);
assert.doesNotMatch(socialWebViewStoreSource, /ServiceLogin/u,
  "production must begin at m.youtube.com and use the site's generated sign-in route"
);
assert.match(
  socialServiceSource,
  /isYouTubeSessionHandoffURL[\s\S]*?"\/accounts\/SetSID"[\s\S]*?isExactYouTubeAccountsURL/u,
  "native navigation and popup validation must share one exact SetSID admission predicate"
);
assert.match(
  socialServiceSource,
  /isExactYouTubeAccountsURL[\s\S]*?url\.scheme\?\.lowercased\(\) == "https"[\s\S]*?url\.port == nil \|\| url\.port == 443[\s\S]*?url\.host\?\.lowercased\(\) == "accounts\.youtube\.com"[\s\S]*?URLComponents[\s\S]*?percentEncodedPath[\s\S]*?paths\.contains\(encodedPath\)/u,
  "YouTube authentication helpers must require HTTPS, the default port, the exact host, and an exact encoded path"
);
for (const path of [
  "/accounts/SetSID",
  "/accounts/CheckConnection",
  "/RotateCookiesPage"
]) {
  assert.equal(socialDOMAdaptersSource.includes(`'${path}'`), true,
    `every DOM adapter must identify the exact scriptless authentication helper ${path}`);
}
assert.match(
  socialDOMAdaptersSource,
  /const youtubeAuthenticationFrame = host === 'accounts\.youtube\.com'[\s\S]*?\.includes\(url\.pathname\)[\s\S]*?url\.protocol === 'https:'[\s\S]*?defaultHTTPSPort[\s\S]*?\|\| youtubeAuthenticationFrame\)\) return;/u,
  "every installed DOM adapter must return before touching only the exact HTTPS/default-port authentication frames"
);
assert.match(
  socialWebViewStoreSource,
  /didCommit[\s\S]*?usesUnmodifiedAuthenticationDocument\(webView\.url\)[\s\S]*?bindCommittedMainDocument/u,
  "native document-ID evaluation must be skipped on every unmodified authentication document"
);
assert.doesNotMatch(
  socialWebViewStoreSource,
  /document\.body\?\.innerText|disallowed_useragent|this browser or app may not be secure/u,
  "authentication health must never inspect credential-page body text with evaluateJavaScript"
);
assert.match(iosProfilesSource, /"https:\/\/consent\.youtube\.com\/"/u,
  "the supervised BuiltIn allowlist must admit YouTube consent");
assert.match(iosProfilesSource, /"https:\/\/accounts\.youtube\.com\/accounts\/SetSID"/u,
  "the supervised BuiltIn allowlist must admit only YouTube's exact session handoff path");
assert.match(iosProfilesSource, /"https:\/\/accounts\.youtube\.com\/accounts\/CheckConnection"/u,
  "the supervised BuiltIn allowlist must admit YouTube's exact embedded connection helper");
assert.match(iosProfilesSource, /"https:\/\/accounts\.youtube\.com\/RotateCookiesPage"/u,
  "the supervised BuiltIn allowlist must admit YouTube's exact embedded cookie-rotation helper");
assert.doesNotMatch(iosProfilesSource, /"https:\/\/accounts\.youtube\.com\/"/u,
  "the supervised policy must not widen accounts.youtube.com to an origin-wide allowance");
assert.match(
  socialWebViewStoreSource,
  /safeRecoveryURL[\s\S]*?usesUnmodifiedAuthenticationDocument\(url\)[\s\S]*?return service\.homeURL/u,
  "content-process recovery must not replay one-time authentication helper URLs"
);
const parityHostGate = youtubeInteractionSource.indexOf("allowedHosts.has");
const parityFirstDomAccess = youtubeInteractionSource.indexOf("document.createElement");
assert.ok(parityHostGate >= 0 && parityFirstDomAccess > parityHostGate,
  "the reused miniplayer source must reject authentication hosts before its first DOM access");
assert.match(parityAuditSource, /unsupported[\s\S]*?applicationNameForUserAgent|application-name suffix/iu,
  "the parity contract must disclose the unsupported browser-identity exception");
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
  /if SocialService\.isYouTubeSessionHandoffURL\(url\)[\s\S]*?return true/u,
  "the probe must delegate first-party session handoff admission to the production encoded-path predicate"
);
assert.match(youtubeWKAuthDiagnosticSource, /webView\.customUserAgent = nil/u,
  "the probe must retain WebKit's truthful user-agent identity");
assert.match(
  youtubeWKAuthDiagnosticSource,
  /if useUnsupportedSafariSuffix[\s\S]*?applicationNameForUserAgent =\s*YouTubeWebCompatibility\.unsupportedSafariApplicationNameSuffix/u,
  "the explicit diagnostic comparison must reuse the production YouTube compatibility suffix"
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
assert.ok(instagram.includes(`MARKETING_VERSION=${phoneRelease.apps.instagram.version}`));
assert.ok(instagram.includes(`CURRENT_PROJECT_VERSION=${phoneRelease.apps.instagram.build}`));
assert.ok(instagram.includes("CODE_SIGNING_ALLOWED=NO"));

const explicitVersion = buildArguments(["youtube", "--version", "2.4.1", "--build", "37"]);
assert.equal(explicitVersion[explicitVersion.indexOf("-scheme") + 1], "VigilSocial");
assert.ok(explicitVersion.includes("VIGIL_APP_BUNDLE_IDENTIFIER=tech.caseline.vigil.youtube"));
assert.ok(explicitVersion.includes("VIGIL_SERVICE=youtube"));
assert.ok(explicitVersion.includes("SOCIAL_APP_NAME=YouTube"));
assert.ok(explicitVersion.includes("SOCIAL_APP_ICON_SET=YouTubeAppIcon"));
assert.ok(explicitVersion.includes("SOCIAL_URL_SCHEME=vigil-youtube"));
assert.ok(explicitVersion.includes("MARKETING_VERSION=2.4.1"));
assert.ok(explicitVersion.includes("CURRENT_PROJECT_VERSION=37"));

const personalTeamFallback = buildArguments(["youtube", "--unclassified-media-policy", "reveal-unclassified"]);
assert.ok(personalTeamFallback.includes("VIGIL_UNCLASSIFIED_MEDIA_POLICY=reveal-unclassified"));
assert.ok(personalTeamFallback.includes(`MARKETING_VERSION=${phoneRelease.apps.youtube.version}`));
assert.ok(personalTeamFallback.includes(`CURRENT_PROJECT_VERSION=${phoneRelease.apps.youtube.build}`));

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
