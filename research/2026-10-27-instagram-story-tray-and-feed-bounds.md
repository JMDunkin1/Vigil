# Instagram watched portraits and feed bounds — October 27, 2026

The user reported an own-avatar-only tray after watching all Stories, early
horizontal jumps in that tray, and excessive blank scrolling after Home posts.

The adapter now recognizes compact, horizontally clipped portrait rows whose
watched buttons have only usernames. Existing viewer-scoped mutual-friend proof
is applied synchronously when those controls mount, instead of putting verified
portraits through another hidden asynchronous batch. Instagram retains its
native images, watched appearance, and Story activation.

A regression reproduced a recycled Story slot collapsing from 100 pixels to
zero during an active swipe. Recycled authors are now concealed with their slot
geometry retained until touch and momentum settle. Layout normalization and
relationship commits wait for that boundary; newly denied accounts then collapse.
This does not grant access to pending authors or change Story route verification.

Home filtering also left fixed/minimum-height wrappers and trailing virtual
spacers after denied posts were hidden. Settled regions containing filtered
cards now let post carriers size to their actual content and collapse empty
denied carriers and trailing spacers. Leading virtual-window spacers, native
vertical viewports, real controls/media, and pagination nodes are retained.
Recycling preserves the previous region height while new authors are verified.
When pagination inserts a verified post into a previously trimmed carrier, that
carrier expands to its real content instead of regaining its old virtual height.

Three maintained iOS WebKit fixtures cover initial watched portraits, slot
recycling through both allowed and denied accounts during touch, and feed bounds
with subsequent pagination in document and nested scrolling containers. These
are deterministic fixtures with fictional accounts, not a recording of the
intermittent behavior on the user's phone.

## Validation

The wider run found an existing failure in
`testInstagramMediaGesturesCoverFeedAndPostModalWithoutTakingOverStories`.
The same eight failures reproduce against unchanged HEAD, including its
`InvalidTransition` error. That fixture is not used as evidence of a passing
media-gesture check. The final scoped suite passed **25 of 25 native iOS tests**, including all
three new regressions and existing Story anchoring, filtering, activation,
continuation, feed recycling, profile, and shared-item checks. The result bundle
is `data/instagram-home-layout-baseline-qa/Logs/Test/Test-VigilSocial-2026.10.27_00-37-47--0400.xcresult`.

Lint, the runtime build, source whitespace checks, and eight selected runtime
checks passed; those include 48 native ambiguous-route probes. Both production
Instagram adapter strings in the shared checkout match the validated isolated
checkout exactly.

## Phone installation

The changes are present in the shared checkout. No phone installation was
started in this chat because the concurrent Snapchat repair is modifying the
same combined application and was still in progress when validation finished.
Use the normal `npm run agent:update:social` verified app-and-policy transaction
once the shared phone sources are ready. No policy, supervision, watchdog, or
service restrictions were modified by this change.
