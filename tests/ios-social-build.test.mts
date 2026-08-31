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
assert.equal(
  youtubeBlockerRules.some((rule) => rule.action?.type === "css-display-none" && rule.action.selector?.includes("ytm-comments-entry-point-header-renderer")),
  true,
  "the required YouTube content blocker must hide the mobile comments entry point"
);
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
assert.match(youtubeInteractionSource, /ytd-comments/u,
  "the Personal Team YouTube interaction script must keep comments hidden in its WKWebView path");
const youtubeInteractionInfo = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilYouTubeInteractionExtension", "Info.plist"),
  "utf8"
);
const socialInfoPlistSource = await readFile(
  join(projectRoot, "ios", "VigilSocial", "VigilSocial", "Info.plist"),
  "utf8"
);
const launchBackgroundContents = JSON.parse(await readFile(
  join(
    projectRoot,
    "ios",
    "VigilSocial",
    "VigilSocial",
    "Assets.xcassets",
    "LaunchBackground.colorset",
    "Contents.json"
  ),
  "utf8"
)) as {
  colors: Array<{
    appearances?: Array<{ appearance: string; value: string }>;
    color: { components: { alpha: string; blue: string; green: string; red: string } };
  }>;
};
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
  "Instagram must retain its native safe-area frame and YouTube must retain its original top inset"
);
assert.doesNotMatch(
  socialRootViewSource,
  /webViewSafeAreaEdges:[\s\S]{0,160}usesFullBleedTop/u,
  "Reels route reports must adjust content inset without resizing the WKWebView host"
);
assert.match(
  socialWebViewStoreSource,
  /contentInsetAdjustmentBehavior = service == \.instagram\s*\? \.never\s*: \.automatic[\s\S]*?webView\.load/u,
  "Instagram must establish its invariant scroll-inset policy before its first load"
);
assert.doesNotMatch(
  socialWebViewStoreSource,
  /setSurface[\s\S]{0,900}contentInsetAdjustmentBehavior/u,
  "Instagram route reports must not change viewport geometry after hydration"
);
assert.match(
  instagramStableAdapterSource,
  /video \{[\s\S]*?max-width: 100% !important;[\s\S]*?object-fit: contain !important;[\s\S]*?object-position: center center !important;/u,
  "Instagram video may contain its pixels without replacing site-authored dimensions"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /video \{[\s\S]{0,700}?(?:\n\s+width: 100% !important|\n\s+height: 100% !important|opacity:|transition:)/u,
  "Instagram must not resize or hide recycled Reel video nodes"
);
assert.doesNotMatch(
  socialDOMAdaptersSource,
  /viewport-fit=cover|data-vigil-instagram-(?:bottom-chrome|direct-header|direct-back|fit-ready)/u,
  "Instagram safe areas must be owned by the native host rather than private DOM heuristics"
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
  /scheduleReelsWarmup|normalizeReelSurface|normalizeBottomNavigation|repost-proxy/u,
  "the production Instagram adapter must not prefetch or rewrite Instagram's Reel layout and controls"
);
assert.match(
  instagramStableAdapterSource,
  /const normalizeCommentSheets = \(\)[\s\S]*?sheet\.dataset\.vigilInstagramCommentsSheet = 'true'/u,
  "the production Instagram adapter must normalize every recognized comments surface"
);
assert.match(
  instagramStableAdapterSource,
  /rememberCommentPlayback[\s\S]*?!media\.paused[\s\S]*?restoreCommentPlayback[\s\S]*?__vigilEarlyMediaGate\?\.isHeld\?\.\(media\)[\s\S]*?media\.play\(\)/u,
  "opening comments should resume only media that was playing and remains allowed by the safety gate"
);
assert.match(
  instagramStableAdapterSource,
  /height: 52dvh !important[\s\S]*?nestedCommentPanel[\s\S]*?!candidate\.contains\(largeMedia\)/u,
  "a full-screen post dialog must keep its media outside the normalized half-height comments panel"
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
  /path === '\/reels'[\s\S]*?path\.startsWith\('\/reels\/'\)/u,
  "the plural Reels discovery destination must remain fail-closed"
);
assert.match(
  instagramStableAdapterSource,
  /const isSingularReelRoute[\s\S]*?let sharedReelPath = ''/u,
  "a shared singular Reel must be allowed while navigation to a second Reel is contained"
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
  instagramStableAdapterSource,
  /const directActivationTarget[\s\S]*?event\.pointerType !== 'touch'[\s\S]*?performance\.now\(\) - touch\.startedAt > 420[\s\S]*?touch\.activation\.click\(\)/u,
  "Instagram Direct must activate a quick touch once while reserving held touches for the message menu"
);
assert.match(
  instagramStableAdapterSource,
  /A held release may still be followed[\s\S]*?suppressedDirectClick[\s\S]*?event\.stopImmediatePropagation\(\)/u,
  "a held Direct touch must suppress WebKit's trailing compatibility click without consuming pointerup"
);
assert.match(
  instagramStableAdapterSource,
  /const relationshipFromUser[\s\S]*?viewerFollows && followsViewer[\s\S]*?const fetchMutualFriendship = async \(username\)[\s\S]*?Nothing from your friends yet/u,
  "Instagram home must show only mutually followed friends and fail closed when no friend content is available"
);
assert.match(
  instagramStableAdapterSource,
  /friendships\/show\/[\s\S]*?transport or schema failure is not evidence[\s\S]*?return null/u,
  "a failed relationship request must not be cached as a false non-friend result"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /homeDigestLimit|home-overflow|small home digest/u,
  "Instagram friend filtering must not use an arbitrary item limit"
);
assert.match(
  instagramStableAdapterSource,
  /friendshipCacheTTL = 6 \* 60 \* 60 \* 1000[\s\S]*?friendshipStorage\.setItem/u,
  "Instagram should reuse fresh viewer-scoped relationship checks to improve time to first friend post"
);
assert.match(
  instagramStableAdapterSource,
  /a\[href\^="\/stories\/"\]:not\([\s\S]*?data-vigil-instagram-story-relationship="friend"[\s\S]*?visibility: hidden !important/u,
  "Instagram must conceal unverified Stories before they can paint on Home"
);
assert.match(
  instagramStableAdapterSource,
  /const homeStoryControls[\s\S]*?main button:has\(img\[alt\*="profile picture" i\]\)[\s\S]*?const classifyHomeStory[\s\S]*?isOwnStoryControl\(control\)[\s\S]*?fetchMutualFriendship\(username\)[\s\S]*?controls\.forEach\(classifyHomeStory\)/u,
  "Instagram Home Stories must classify both link and button trays with the mutual-friend verifier while retaining the viewer's own Story"
);
assert.match(
  instagramStableAdapterSource,
  /const semanticItem = control\.closest\('li, \[role="listitem"\]'\)[\s\S]*?return control\.parentElement \|\| control/u,
  "Story removal must target one tray item rather than climbing into the entire Stories surface"
);
assert.match(
  instagramStableAdapterSource,
  /const storyAuthor = \(control\)[\s\S]*?profile picture[\s\S]*?const isOwnStoryControl/u,
  "button-based Stories must derive their author from Instagram's accessible profile-image metadata"
);
assert.match(
  instagramStableAdapterSource,
  /document\.body\?\.append\(state\)/u,
  "Instagram should show a centered out-of-flow spinner before its eventual empty state"
);
assert.match(instagramStableAdapterSource, /renderFriendsState\('loading'\)/u);
assert.match(instagramStableAdapterSource, /renderFriendsState\('empty'\)/u);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /background: Canvas|querySelector\('main'\).*prepend\(state\)/u,
  "friend status must not restyle or move Instagram's stock header and Stories surface"
);
assert.match(
  instagramStableAdapterSource,
  /main \[role="progressbar"\][\s\S]*?display: none !important/u,
  "Instagram's own feed loader must not appear beside Vigil's centered spinner"
);
assert.match(
  instagramStableAdapterSource,
  /state\.dataset\.vigilState === 'empty' && mode === 'loading'/u,
  "a settled empty friend feed must not flash back to loading during background pagination"
);
assert.match(
  instagramStableAdapterSource,
  /window\.__vigilResetFriendsFeedForRefresh[\s\S]*?renderFriendsState\('loading', true\)/u,
  "an intentional pull-to-refresh must explicitly reset the settled friend feed to loading"
);
assert.match(
  socialWebViewStoreSource,
  /service == \.instagram[\s\S]*?__vigilResetFriendsFeedForRefresh[\s\S]*?webView\?\.reload\(\)/u,
  "Instagram's native refresh control must request the friend-feed loading reset before reload"
);
assert.match(
  instagramStableAdapterSource,
  /prefers-color-scheme: dark[\s\S]*?svg\[aria-label="Instagram" i\][\s\S]*?color: #f5f5f5 !important/u,
  "Instagram's wordmark must retain readable contrast in dark mode"
);
assert.match(
  socialWebViewStoreSource,
  /UITraitCollection\.current\.userInterfaceStyle[\s\S]*?webView\.overrideUserInterfaceStyle = initialStyle[\s\S]*?webView\.load/u,
  "Instagram must seed WebKit's native appearance before its first navigation"
);
assert.doesNotMatch(
  instagramStableAdapterSource,
  /html\[data-vigil-instagram-route-transition="true"\] body/u,
  "ordinary Instagram SPA transitions must not blank the entire live document"
);
assert.match(
  instagramStableAdapterSource,
  /const routeKey = \(candidate\)[\s\S]*?routeKey\(url\) === routeKey\(source\)[\s\S]*?return/u,
  "same-route History and Navigation API noise must not arm a visual transition"
);
assert.match(
  instagramStableAdapterSource,
  /vigilInstagramStoryGate = 'pending'[\s\S]*?const reconcileStoryRoute[\s\S]*?fetchMutualFriendship\(username\)[\s\S]*?location\.replace\('\/'\)/u,
  "Stories must remain concealed until the route author is self or a confirmed mutual friend"
);
assert.match(
  instagramStableAdapterSource,
  /vigilInstagramStoryRelationship = 'self'[\s\S]*?const reconcileStoryPlaceholders[\s\S]*?vigilInstagramStoryPlaceholder/u,
  "the viewer's own Story must remain distinct and an empty friend tray must render inert placeholders"
);
assert.match(
  instagramStableAdapterSource,
  /const prepareRouteTransition[\s\S]*?vigilInstagramHomeFilter = 'true'[\s\S]*?prepareRouteTransition\(link\.href\)[\s\S]*?prepareRouteTransition\(args\[2\]\)/u,
  "Home must become fail-closed before click and History API route swaps"
);
assert.match(
  instagramStableAdapterSource,
  /data-vigil-instagram-story-rail="true"[\s\S]*?overscroll-behavior-x: none !important[\s\S]*?const clampStoryRail[\s\S]*?rail\.scrollLeft = clamped/u,
  "the filtered Home Stories rail must stop at its real rendered bounds"
);
assert.match(
  instagramStableAdapterSource,
  /const stagedHomeStoryRelationships[\s\S]*?const flushHomeStoryRelationships[\s\S]*?stagedHomeStoryRelationships\.set\(control, \{ username, relationship \}\)[\s\S]*?flushHomeStoryRelationships\(\)/u,
  "Home Story relationship results must commit as a batch instead of shifting the rail once per request"
);
assert.match(
  socialDOMAdaptersSource,
  /const applyAudioPreference = \(media\)[\s\S]*?media\.defaultMuted = false;[\s\S]*?media\.muted = false;/u,
  "Instagram's audio-on preference must be applied to newly mounted media"
);
assert.match(
  socialRootViewSource,
  /instagramDarkSurface[\s\S]*?red: 18\.0 \/ 255\.0[\s\S]*?surfaceColor[\s\S]*?ignoresSafeArea/u,
  "Instagram's native safe areas must use the same dark surface color as its shell"
);
assert.match(
  socialRootViewSource,
  /InstagramSessionCounter[\s\S]*?TimelineView\(\.periodic[\s\S]*?Time on Instagram[\s\S]*?scenePhase == \.active/u,
  "Instagram must show a foreground-only running session counter above its web surface"
);
assert.match(
  socialWebViewStoreSource,
  /if service == \.instagram \{[\s\S]*?webView\.isOpaque = true[\s\S]*?webView\.backgroundColor = \.black[\s\S]*?webView\.scrollView\.backgroundColor = \.black/u,
  "Instagram must keep a black opaque native backing surface before WebKit's first document"
);
assert.match(
  socialDOMAdaptersSource,
  /vigilInstagramStarting = 'true'[\s\S]*?delete document\.documentElement\.dataset\.vigilInstagramStarting[\s\S]*?DOMContentLoaded[\s\S]*?background-color: #000 !important/u,
  "Instagram must hold a black document canvas until its initial DOM is ready"
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
  /case \.youtube:[\s\S]{0,420}URL\(string: "https:\/\/m\.youtube\.com\/"\)!/u,
  "YouTube must start on Home and let the policy adapter redirect when recommendations are blocked"
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
  "the exact ordinary-watch player-controls/Shorts guard resource must be reused in the YouTube WK main frame"
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
  "the reused YouTube controls source must reject authentication hosts before its first DOM access");
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
assert.doesNotMatch(youtubeInteractionSource, /youtubeMinimize|MiniPlayer|miniplayer/u,
  "the retired miniplayer must not remain in the shipped controls script");
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
assert.match(
  socialInfoPlistSource,
  /<key>UILaunchScreen<\/key>\s*<dict>\s*<key>UIColorName<\/key>\s*<string>LaunchBackground<\/string>/u,
  "the native launch screen must use the adaptive app background instead of iOS's white default"
);
assert.deepEqual(
  launchBackgroundContents.colors.map((entry) => ({
    appearance: entry.appearances?.[0]?.value || "light",
    ...entry.color.components
  })),
  [
    { appearance: "light", alpha: "1.000", blue: "0.000", green: "0.000", red: "0.000" },
    { appearance: "dark", alpha: "1.000", blue: "0.000", green: "0.000", red: "0.000" }
  ],
  "the launch background must always be black so startup cannot flash white before appearance resolves"
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
