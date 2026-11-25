# Vigil performance audit, November 25, 2026

The largest measured cost was in computing usage limits. Reading progress for 20 rules rebuilt and discarded the same 5,000-segment display timeline 20 times. The revised calculation reads the normalized per-device counters once per evaluation. It still sums overlapping device use for limits, supports legacy single-device records, and uses the observed day and current policy for every decision.

## Measurements

The baseline was revision `4213354`. The Node tests ran on the development Mac with Node 26.13.0. The native URL benchmark used an optimized Swift build on that Mac.

| Workload | Baseline | Revised |
| --- | ---: | ---: |
| Read progress for 20 rules with 5,000 usage segments | 206.6 ms | 0.04 ms |
| Sync a 5,000-segment phone usage snapshot | 39.7 ms | 27.5 ms |
| Generate a 600,000-domain phone blocklist | 940 ms | 590 ms |
| Peak process memory during that build, including input generation | 413 MiB | 299 MiB |
| Evaluate 2,000 native browser URLs | 1.278 s | 1.164 s |
| Anchor queries across 22 Reddit reader scans of a test document | 44 | 22 |
| Observers on one shadow root after ten detach/reattach cycles | 11 | 1 |

- **Usage.** The fixture alternated three app names in one-second segments, separated by one-second gaps. Limit timings are the median of five warmed calls. Sync timings are the median of three process runs, each measuring eleven repeated snapshots. All 20 rule totals agreed. An additional 300 comparisons exercised legacy data, multiple devices, time limits and open limits against the baseline.
- **Blocklist.** Three alternating pairs of fresh processes built the same deterministic shuffled list, with identical metadata. The table gives the medians. All six artifacts had SHA-256 `c19878b90c274a1ca0edaed7cc9e1042245a9f3779e69e56ec4baeef08e91f99`. Peak memory is the process high-water mark. Installed-app memory was outside this benchmark.
- **Native navigation.** Three runs per version each exercised 400 repetitions of five URLs covering plain paths, ordinary searches and nested percent encoding. Each run produced 400 blocks. These timings measure filtering on the host Mac. Device energy use and end-to-end page latency require a physical-device trace.
- **Reddit reader.** A deterministic DOM fixture counted queries and observer registrations in the compiled guard. A Chromium spot check independently observed the initial document's anchor queries fall from four to two. Chrome and Safari ship the same generated reader code.

## Other changes and coverage

Phone sync now reuses the aggregate computed for persistence to construct its response. The device-limit route reads counters directly. The blocklist writer stores reversed domains once, sorts them once, and emits rows into 64 KiB buffers. Its regression fixture decodes 50,003 rows and checks every sparse-index offset. Native browser navigation reuses compiled route and percent-decoding expressions and skips work on URLs that need no decoding. Browser Back stops evaluating history candidates after the first verified safe destination.

The review also covered Mac monitor scheduling, dashboard refresh, browser heartbeats, native service-access polling and blocklist lookup. The fixes are in the workspace. Live Mac and physical phone deployments were outside this pass.

## Verification

Lint and the build passed. The runtime suite passed 250 of 254 suites. The same four failures reproduced in a clean checkout of the baseline revision.

| Runtime suite | Failure |
| --- | --- |
| app-update-bridge | Packaged Chrome store shortcut source assertion |
| ios-instagram-message-alerts | Media suspension and notification invalidation source assertion |
| ios-instagram-story-position | Own-profile story position fixture |
| managed-chatgpt-extension | Runtime test working directory lacks build/browser-store.json |

All 17 Vigil Browser tests passed on the iPhone 17 simulator running iOS 27.0. The standalone Chromium YouTube performance fixture did not complete on either attempt. Its renderer was terminated or disposed before the final assertions.

The native WebKit YouTube performance and enforcement fixtures passed on both desktop and mobile layouts. The Vigil Social simulator suite recorded **234 passed, 46 failed and 3 skipped** across two runs. The repository runner timed out after eight minutes with 211 completed cases. A second run used the same build and skipped those completed cases. The Social failures include service-access, navigation, playback, gestures and layout assertions. Their baseline status is unverified.

<details>
<summary>Vigil Social simulator failures</summary>

- `testAccessProbeFallsBackToExactDocumentWithoutAcceptingRedirects`
- `testActivePullToRefreshKeepsBounceAndSpinnerUntilNavigationFinishes`
- `testAdaptersBoundInspectionWorkAndRetryUnclassifiedMedia`
- `testAdaptersPublishRefreshSurfacesAndCurrentYouTubePlaybackHooks`
- `testContentFilterPreblursAndObservesDynamicMediaAndText`
- `testFixedAppKeepsOnePersistentServiceWebView`
- `testFocusedWebInteractionExtensionKeepsShortsAndMatureRevealsUnavailable`
- `testInstagramAuthenticationSurfacesStayVisibleWithoutContentHooks`
- `testInstagramCachedNativePushStateCannotBypassBlockedRoutePolicy`
- `testInstagramCommentsWithoutTextareaKeepScrollingAndExternalCloseControl`
- `testInstagramDirectSurfacesSplitInboxAndThreadSynchronouslyOnRouteChange`
- `testInstagramEmptyFeedContainerStaysClosedDuringScrollRecycling`
- `testInstagramHealthWaitsForUsableRouteContentAndDetectsBrokenChallenges`
- `testInstagramInteractionBoundariesAcrossActivationSheetsAndKeyboard`
- `testInstagramLandscapeDirectSharesPinOnlyTheirNewViewer`
- `testInstagramMediaDoubleTapLikesOnceWithoutChangingVideoTapStateOrLaunchingApp`
- `testInstagramMediaGesturesCoverFeedAndPostModalWithoutTakingOverStories`
- `testInstagramPhotoZoomAndRecipientKeyboardConfiguration`
- `testInstagramReadSurfacesRecoverRealFocusWithoutResettingSession`
- `testInstagramRecipientPickerCannotExemptReopenedLandscapeReel`
- `testInstagramRecipientSearchWrapperKeepsNativeTouchAndFocus`
- `testInstagramReelEdgeHoldUsesTemporaryTwoTimesAndRestoresEveryExit`
- `testInstagramReelsClearLiveOverflowingMetadataWithoutChangingNativeSnap`
- `testInstagramReelsSnapPrimeHighDensityMediaAndProtectCaptionHitTarget`
- `testInstagramSafeAreaAdapterPreservesReelStackAndDirectControls`
- `testInstagramSharedReelDirectModalCannotScrollIntoRecommendations`
- `testInstagramSharedViewerAliasesAndAnonymousPortals`
- `testInstagramSharedViewerContainsCaptionPullsWithoutChangingPlayerLayout`
- `testInstagramShellMatchesYouTubeRestrictionLevelWithoutMediaClassifier`
- `testInstagramSlowTextShellAndTransparentContentRemainLoadingUntilUsable`
- `testInstagramTransientCarouselMutationPreservesVerifiedPostLayoutAndPosition`
- `testInstagramVirtualFeedRecyclingPreservesOpenRegionAndVerticalPosition`
- `testPolicyProbePrioritizesPrimaryNavigationAndBoundsBackgroundTraffic`
- `testSnapchatGroupChatRecoversRealFocusWithoutRemovingPrivacyScreen`
- `testSnapchatRealWebRTCCallAudioRespectsPreferenceAndSuspension`
- `testSnapchatSnapViewerAndReplyCameraUsePhoneFrame`
- `testYouTubeCommentsScrollWithoutCoveringTheWatchPageOrShowingAds`
- `testYouTubeDoesNotTrustPartialInstallationFlagsOrGenericPageHealth`
- `testYouTubeEmptyHomeShellWaitsForHomeAvailability`
- `testYouTubeEmptySubscriptionsShellIsUsable`
- `testYouTubeLateMediaVerdictClearsBlankWatchOverlay`
- `testYouTubeLateSignInUIRecoversFromBlankRouteOverlay`
- `testYouTubeRecoversMissingAllowanceAndAdScriptInjections`
- `testYouTubeSlowStartupDoesNotFlashADegradedOverlayBeforeContentArrives`
- `testYouTubeVisibleWatchShellIsUsableBeforeVideoAttaches`
- `testYouTubeWKAuthDiagnosticUsesPristinePersistentScriptlessWebKit`

</details>
