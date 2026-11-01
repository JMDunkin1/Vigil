# Instagram profile carousel gray-out — November 1, 2026

The user reproduced gray profile posts on the connected iPhone. Captures show
decoded photos inside an article marked `data-vigil-single-reel-card="blocked"`.
The username-prefixed permalink matches the pinned shortcode. This is a
carousel containment failure; no explicit-content verdict was observed.

The live virtual carousel uses a one-pixel flex list, translated slots and a
separate presentation viewport. Its current React props contain a
`mediaFragmentKey` and `PolarisCarouselMedia_media` reference. The older reader
only traversed `props`, `children` and `post`, expecting a legacy Sidecar model.
Both the original reader and a larger version returned no manifest on the
first reproduced post.

## Changes

Read already-loaded carousel/media fragments through Instagram's loaded Relay
selector module and environment. Independently check the stored parent code,
then bind child reads through the shared `__id` record identity. Live inspection
confirmed that the carousel exposes `pk`, the photo fragment exposes `id`, and
those scalar values differ for all seven children while their `__id` values
match. Video source versions are behind a further masked player fragment.

Retain legacy Sidecar support. Prioritize the original track's ancestry in the
bounded props scan and refresh missing evidence at most once per reconciliation
as lazy records arrive. Exact source membership, original track membership,
other-post rejection and onward-navigation containment remain independent gates.

With `VIGIL_WEB_INSPECT=1`, the host can also save a bounded, document-bound
`Documents/vigil-instagram-diagnostics.json` receipt. It contains geometry,
classification booleans and carousel counts, without photo source URLs, captions,
messages, cookies or authentication storage. Normal launches do not enable this
receipt. Diagnostic data cannot grant access.

## Validation and physical status

- Fourteen desktop WebKit cases pass, including different pk/id aliases,
  delayed photo/video records, masked video fragments, legacy data, large
  headers, wrong parent/reference/child identities, missing modules, wrong
  tracks, unlisted srcset sources and onward-navigation containment.
- The exact-Relay case fails against the preceding committed adapter.
- The runtime build, 15 focused runtime tests, 42 native geometry checks,
  repository lint and iOS app compilation passed.
- A read-only evaluation of the corrected production reader on the user's
  seven-photo post returned 133 verified image variants. Every mounted photo
  source matched that exact post's records.
- The last captured rendered article was still blocked. This establishes that
  the identifier repair alone did not prove the full gray-out resolved.
- The latest completed verified installation before the requested Git delivery
  is Vigil Social 0.3.237 (240), phone suite 0.3.258 (261), with the exact live
  supervised policy `7d0ab7c4016d` and service launch verification.
- A fresh diagnostic receipt has not yet been retrieved. Inspection connections
  have timed out or disappeared; another concurrent update replaced one of the
  diagnostic process launches. iOS also locked during a later launch check.
  Do not describe fixture passes or installation checks as physical acceptance.

Ignored mode-600 captures and logs are under `data/instagram-profile-*`.
Continue investigating the retained guard state and verify the actual post's
visibility before claiming the gray-out is fixed. Use only the supported
combined updater; preserve policy, supervision and watchdog protections.

## Requested Git delivery and update

All work was committed and pushed to main as `6eb8308`. The subsequent
combined update installed Vigil Social 0.3.238 (241), suite 0.3.259 (262).
Its first service check timed out while Snapchat's protected document was
loading. Retrying the normal transaction passed, including the exact live
supervised policy `7d0ab7c4016d` and all service launches. No check was bypassed.
Physical gray-out acceptance remains separate from this successful deployment.

## Retained-state repair after the repeated failure

The reader-only repair did not address two independent failures reproduced in
desktop WebKit with the production guard installed at document start:

1. Initial photos matched their captured sources before Relay props existed.
   Because those sources did not change, the guard never refreshed its missing
   manifest. A later unverified image then vetoed the whole article.
2. The article verdict required every asset to pass. An unrelated avatar,
   preload, or recycled media node could therefore hide independently verified
   photos. Rejected nodes and obsolete React wrappers also stayed rejected
   after the selected post's records proved their current sources.

The guard now refreshes a missing manifest even when the initial photos retain
their sources. A verified selected carousel gives each image/video its own
verdict; an unverified asset stays hidden without hiding verified siblings.
Uncertain cards retain the whole-card denial. Track and article replacement
can recover only through the current exact parent code, a visible structural
carousel, and freshly loaded source proof. Recovered captured permissions are
pruned to those proven sources, including initially empty preload shells.
Recycled node rejection heals only with fresh proof in the bound track.

Validation of this repair:

- All 31 production document-start WebKit carousel cases passed, covering the
  startup gap, delayed records, individual asset denial, recycled image/video
  recovery, replacement tracks/articles, temporary missing permalinks, and
  exact parent/child/source denial. The preceding guard fails the newly added
  late outside-image case. These source/layout fixtures are offline; they do
  not establish decoded-image behavior or physical acceptance.
- Existing checks passed: 16 decoded chat-media cases, 66 conversation cases,
  nine Send cases, all five comments modes, the Snapchat viewer suite, 42
  native geometry checks, and 15 focused runtime tests. The comments fade
  mode was rerun in isolation against both baseline and repair after an
  initial concurrent GUI-test failure; both passed.
- Repository lint, runtime build, diff whitespace checks, and the unsigned
  combined iOS Simulator app compilation passed. No app-only installation
  was used. The new carousel suite is included in macOS CI.
- Logs are ignored under `data/instagram-carousel-*`, with the final carousel
  run in `data/instagram-carousel-retained-final.log`.

The iPhone was unavailable in CoreDevice when validation completed. Use the
normal combined verified updater for delivery; do not describe successful
fixtures as a completed phone update or physical acceptance.

The repair was committed and pushed as `92e5225`. The subsequent normal update
stopped before building or installing because the paired iPhone was unreachable.
A detached, one-time local retry worker is waiting in this checkout; its ignored
status file is `data/instagram-carousel-delivery-status.json`. It invokes only
`npm run agent:update:social`, requires the validated phone input fingerprint,
and stops after successful app/signing/live-policy/service verification or a
non-transient failure. It expires after seven days and requires this Mac to
remain running. On success it records and pushes only generated phone release
metadata. No additional reproduction, inspection, policy exception, or restore
is part of this pending delivery. Installation is not yet verified.
