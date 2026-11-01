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
