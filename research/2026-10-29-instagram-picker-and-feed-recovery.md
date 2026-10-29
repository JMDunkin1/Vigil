# Instagram Send/reopen containment and concealed posts — October 29, 2026

The user reported that opening Send, leaving, and reopening a received Reel
allowed scrolling into other videos. Posts also turned grey around the fourth
item on Home and profiles, with a possible shortage of friends' Stories/posts.
The user requested code changes only and deferred phone installation.

## Confirmed failure paths and changes

- Recipient detection accepted retained, invisible Search controls. It also
  treated a short landscape video as picker content because the video did not
  meet the old height threshold. Require an active picker and its own visible
  search control, and exclude active video players regardless of dimensions.
  Keep the actual picker, its native search activation, and its list usable.
- Native horizontal carousels did not receive the selected post's loaded
  Sidecar manifest, and later manifest checks assumed `li` slots. A newly
  mounted fourth photo could therefore reject the entire selected post. Use
  the exact selected post's manifest for both native and virtual carousels,
  requiring the new slide to belong directly to the captured track. Wrong-post
  manifests and unrelated/replaced sources still reject the post.
- Unavailable friend checks were terminal for their mounted cards/Story
  controls. Retry only unavailable checks after 5, 15, and 45 seconds, with
  recovery on reconnect, page return, and foregrounding. Park offscreen work;
  deduplicate posts and Stories by author, and retain the three-request
  concurrency limit. Failed module loads can be retried rather than retaining
  an unavailable module promise. Only fresh explicit mutual-follow proof (or
  the existing informational exception) reveals content; failures never become
  cached denials, and definite nonfriends are not retried by this mechanism.
- A Home stream reused as a profile shell could remain concealed because it
  still contained old Home classifications. Track which descendants belonged
  to Home, conceal those individually on departure, and release only current
  profile-author branches or newly mounted profile-grid post links. Returning
  through Home restores its normal filtering. Retained unrelated Home content
  remains concealed.

There is no item-count or people-count limit in the friendship filter. These
are reproduced code failures that can explain the symptoms; the user's live
Instagram feed and relationship coverage were not inspected in this chat.

## Validation

- Seven desktop WebKit scenarios passed using the production guard and stable
  adapter strings, with fictional accounts and mocked relationship responses.
  They cover Send/picker/reopen containment, reconnect recovery, repeated
  Home/profile shell reuse including an authorless grid, and four native
  carousel combinations of direct/wrapped slots and exact/wrong manifests.
  Every carousel combination also rejects an unrelated replacement source.
- The three initial scenarios and both exact-manifest native carousel cases
  failed against the earlier adapter snapshot. The baseline includes the
  recipient-shortlist edits already present when this chat started.
- Three maintained runtime recovery tests passed: automatic recovery with
  fresh proof, reconnect/offscreen recovery, and bounded/deduplicated retries.
- Build, lint, social-build contracts, 48 native route-boundary probes, Story
  position tests, promotion tests, combined-container restriction/migration
  checks, JavaScript parsing, and whitespace checks passed.
- Maintained iOS WebKit fixtures were added for the four failure paths. The
  iOS app/test target compiles with Xcode 27.1. Native execution is unverified:
  the first simulator attempt failed before the test connection was established,
  and a second invocation remained stuck before tests ran and was interrupted.
  The Electron fixture exited without its required completion marker and is
  also not counted as a pass. Desktop WebKit does not establish iPhone native
  gesture/compositor behavior.

Desktop WebKit logs: `data/instagram-oct29-webkit.log` and
`data/instagram-oct29-webkit-before.log`. Reproduction inputs and the harness
are retained in `data/instagram-oct29-webkit/`; compile `harness.swift` with
`swiftc`, then pass that directory to the executable. Native compilation log:
`data/instagram-oct29-compile.log`.

No phone installation, app/policy transaction, supervision change, or change to
watchdog/enforcement protections was performed. Use the normal combined
`npm run agent:update:social` transaction when the user requests installation.
