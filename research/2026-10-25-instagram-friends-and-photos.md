# Instagram friends and photo repair — October 25, 2026

## Diagnosis and scope

Home posts and Stories require two confirmed follow directions. Informational
account exceptions skip that lookup, explaining how exceptions can remain
visible during a relationship lookup outage. The old path required REST search
to succeed before Instagram's authenticated batch client could be used. An
HTTP 200 response missing relationship fields also skipped that batch fallback.
These are demonstrated failure paths; the user's live session has not yet been
inspected on the physical phone.

The public client served from [Instagram](https://www.instagram.com/) on this
date uses `PolarisSearchBoxRefetchableQuery.graphql` through `CometRelay` and
`PolarisRelayEnvironment` for search. Its
`PolarisRelationshipActionGetRelationshipInfoForUserIds` calls
`PolarisInstapi.apiPost('/api/v1/friendships/show_many/', {body:{user_ids:...}})`.
`PolarisInstapi` wraps response fields in `data`. These operations and schemas
were read from Instagram's public JavaScript bundles, without a logged-in
account. No persisted GraphQL document ID, new endpoint, or entitlement is added.

## Change

- Resolve exact account identities with the current loaded Relay search client,
  with legacy REST compatibility and an inert profile-document JSON fallback.
  Prefer the account PK over Relay's opaque node ID. Use the token-aware batch
  relationship request before the legacy GET, and handle both response wrappers.
- Continue requiring explicit booleans for both follow directions. Missing
  fields, mismatched usernames, transport failures, and unavailable modules do
  not grant access or become cached nonfriend results. Existing informational
  exceptions and viewer-scoped cache behavior remain.
- Keep recipient dialogs' search wrappers and recipient controls outside the
  shared-item press suppression. Do not synthesize a second Direct activation
  for wrappers containing editable controls. Disable interactive keyboard
  dismissal for Instagram. Only the recipient subtree gets ordinary panning;
  its own scroll container contains overscroll and the viewer stays locked.
- Permit native viewport scaling for Instagram and leave multi-touch pointer
  movement uncanceled. Single-finger shared-item swipes remain contained.
- Tap the rendered profile avatar to view that same image in an accessible,
  closable overlay. Do not fetch unrelated images or rewrite image URLs. The
  surrounding Story link remains available; navigation closes the overlay.

The change was rebased on `3ae67e2` to retain the parallel shared-item containment
work. No supervision, phone policy, enforcement, or update transaction changes.

## Validation

24 targeted iOS Simulator tests passed after integrating the parallel change.
They cover current and legacy friendship lookup, profile-document fallback,
lookalike rejection, unknown-result caching, existing friend/Story behavior,
recipient search editing and configuration, profile-avatar enlargement,
multi-touch versus single-finger containment, and existing shared-item locks.
The final recipient CSS tightening was rerun with the same targeted suite.

Also checked: lint, TypeScript build, social-build contracts, native route
boundaries (48 probes), browser media lifecycle, command contracts, browser
fixture syntax, and whitespace validation.

The new Electron fixture's friendship and recipient phases completed locally.
Some complete local browser runs were killed or exited before the completion
marker, so a complete browser run is not claimed. CI runs the fixture and
requires its completion marker. No enforcement was disabled for testing.

No physical-phone installation or live-account verification has been performed.
The normal combined `npm run agent:update:social` transaction remains the only
installation path when the phone is connected.
