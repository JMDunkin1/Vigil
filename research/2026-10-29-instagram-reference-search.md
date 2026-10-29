# Instagram reference search — October 29, 2026

The requested search behavior is deliberate lookup followed by one contained
post or Reel, with no search quota or session timer. A result qualifies when
its author has at least 10,000 followers OR the particular post has at least
1,000 likes OR 10,000 views. This lets a viral post from a small account qualify.
Popularity is an additional gate; it does not override text/content policy.

The document-start guard retains native account search, enables post/Reel
results only for a nonempty checked query, suppresses in-search video playback,
and consumes result activation while checking structured metadata. It reads
same-origin Instagram JSON responses and inert JSON from the exact permalink,
with the existing profile compatibility endpoint and inert profile-document
fallback for follower counts. No new endpoint, persisted GraphQL ID, paid
service, signing entitlement, or OS-policy exception is introduced. Counts bind
to the exact shortcode or username. Missing, malformed, string, or mismatched
counts cannot qualify; arbitrary tile labels and captions never supply counts.
Metadata stays in bounded, short-lived, in-memory caches.

The query and result context require a native safe text verdict. A checked tap
opens the exact permalink, rather than retaining a search modal. Both History
and native full-document navigation require that query's approval. Query
changes, recycled tiles, unavailable classification, and old asynchronous
completions cannot grant navigation. Status remains on Search if a result does
not qualify. Existing native/single-item containment continues to block moving
to other posts or Reels; comments, sharing, and within-post photo carousels use
the existing boundaries. Explicit incoming external shares retain their
existing separate path. Home/Stories mutual-follow rules and informational
exceptions are unchanged.

Validation completed:

- TypeScript build, source lint, and whitespace checks.
- Four structured-metadata and installation/syntax tests.
- Three iOS Simulator tests: native URL boundaries, query/popularity cases
  (including both threshold branches and stale-query rejection), and the
  existing account-only default-search regression.
- Four existing iOS Simulator containment tests: native shared-Reel navigation,
  recycled-media/scroll containment, Direct modal containment, and single-finger
  swipe containment during post-photo pinch.
- Existing social-build, expanded-service parity, command contracts, friendship
  recovery, Story position, and promotion checks.

An additional Electron fixture is wired into CI with a mandatory completion
marker. Local Electron runs were killed or exited without that marker, so they
are not claimed as completed. The native WebKit fixture completed successfully.
No live Instagram account or physical-phone behavior was verified.

The supported `npm run agent:update:social` transaction prepared personal release
0.3.228 (231), then stopped because the paired iPhone was unreachable by USB or
local network. The update was not installed and no app-only path was attempted.
The release record already had local changes before this work; those were
preserved and the normal transaction advanced the record.

## Follow-up: evidence assessment and deployment hold

The user challenged the numeric defaults as arbitrary. They are provisional
product guesses, not validated bot or explicit-content thresholds. No
installation should be represented as an evidence-based final policy while
that calibration is unresolved. The earlier failed install left the phone
unchanged.

Primary sources reviewed:

- Meta, [Testing Meta Verified to Help Creators Establish Their Presence](https://about.fb.com/news/2023/02/testing-meta-verified-to-help-creators/):
  a subscription can provide identity verification using government ID; the
  badge does not by itself establish notability, audience size, or content
  suitability. Existing legacy verification and subscription verification must
  not be assumed distinguishable from a generic verified indicator.
- Meta, [Preventing Inauthentic Behavior on Instagram](https://about.fb.com/news/2019/04/preventing-inauthentic-behavior-on-instagram/):
  followers, likes, and views are all subject to purchased fake engagement.
- Tricomi et al., [Are We All in a Truman Show? Spotting Instagram Crowdturfing through Self-Training](https://arxiv.org/abs/2206.12904):
  detecting purchased engagement requires more than a single count; the study
  uses labeled purchased profiles and a learned multi-feature detector. Its
  results do not supply a portable numerical safety cutoff for this feature.
- Powers et al., [Investigating the Impact of Changes to Social Media Verification Policies on User Perceptions of Verified Accounts](https://www.usenix.org/system/files/soups2024-powers.pdf):
  documents the shift from notable-only to open, paid identity verification on
  Instagram. It does not validate badge-only content approval.

A public brand-engagement benchmark was also inspected, but not adopted as a
bot-filter calibration dataset. Its sample is organic business-account posts,
not labeled suitable references versus spam; its current methodology also has
inconsistent reporting periods and inclusion boundaries. Brand averages cannot
justify arbitrary precision in an account-safety rule.

Recommended next calibration step: collect representative intended reference
searches and independently labeled unsuitable/spam results, retaining the exact
structured account/post evidence available to the real app. Check any candidate
rule on held-out accounts and report actual false accepts, false rejects, and
missing-evidence cases. Keep the established-account OR individually popular
post requirement, so small creators can still qualify through a viral item.
Use genuine verification only as an identity signal, unless the available data
can independently substantiate notability. Do not infer legacy versus paid
verification, account age, unique reach, or organic engagement from fields that
do not establish them. A percentile or engagement ratio chosen without this
evaluation would merely introduce another unvalidated cutoff.

The user was asked for 3–5 intended search topics or reference examples to make
that validation relevant. No new automatic badge allowance, replacement numeric
cutoff, additional usage quota, or enforcement exception was installed during
this follow-up.

## Search-result filtering and gray-viewer repair

The user requested that results below the current eligibility rule disappear
rather than produce a popup, and reported that qualifying results still opened
to gray viewers. The eligibility thresholds remain provisional and unchanged.

Result checks now run before tiles become visible. A bounded-concurrency queue
uses the existing structured-metadata readers and native text verdict; unknown
or denied results remain hidden. Each result cell is hidden individually, and
rows containing only hidden result cells collapse. Account search and query
controls remain available. Later responses, newly mounted tiles, changed
permalinks, and query changes trigger classification without per-result toast
messages. Evidence revisions and expiry invalidate previous approvals.

Approved taps now send a document-bound native open request. The real host
rechecks the exact current approval, rejects noncanonical/foreign/parameterized
destinations, and loads the selected permalink with WKWebView. Its navigation
delegate independently checks the approval; the new document installs the
existing single-item guard. This addresses the retained-Search-viewer path in
which Search's concealed-preview CSS can also conceal the selected media.
The phone was unreachable, so that path was not inspected in the user's live
session and no installed-version diagnosis is claimed.

Eight focused iOS Simulator tests passed, including prefiltering/cell collapse,
photo and video/Reel destination visibility, default account-only Search,
native URL boundaries, and the existing gesture/recycled-media containment
regressions. Fourteen targeted Node checks and the TypeScript build also passed.
The earlier Electron completion limitation still applies. Repository-wide lint also passed after adding the missing `void` annotation
to the suggestions fixture's existing top-level promise. That one-line test
harness correction preserves its behavior.

Concurrent notification and suggestions edits appeared during this work; those
changes were preserved. The user explicitly requested preparation for later
installation, so this repair was not installed and no phone update was run.

The destination-rendering test was then strengthened to use the real
SocialWebViewStore, its native message handler, bundled text classifier,
installed scripts, and navigation policy. Only the destination server document
is substituted. That test passed for photos, post videos, and Reels, including
visible media elements, absence of Search preview CSS, and blocked next-item
swipes/History changes. These are fixture visibility checks; they do not prove
live Instagram streaming or on-phone behavior. The final test harness preserves
the host's script controller without removing/readding its installed scripts.

## Follow-up: live Search reproduction and hydration repair

The subsequent phone report reproduced on the wired iPhone using a normal
topic Search. The supported combined updater was run with the existing
paired-developer inspection opt-in. It verified the exact installed supervised
policy (`bcd3df1d6fea`), all service launches, and the signed combined app.
Inspection was enabled for that process launch; no permanent inspector setting
or enforcement exception was added.

The live Search returned 21 approved results. Clicking one through the actual
Search handler loaded its native `/p/.../` document successfully. The selected
video and its containing article nevertheless had the single-item guard's
`blocked` markers and computed hidden visibility. The live selected video URL
also matched the exact post's structured video versions. This established a
viewer-containment failure after successful navigation, rather than an
unapproved result or a failed native open.

The first live repair check exposed an additional identity mismatch: the
`/p/<code>/` destination's own article contained a username-prefixed
`/<author>/reel/<same-code>/` link. The guard compared route kind as well as
shortcode, so it could never select this article. DOM and native containment
now recognize post/Reel permalink aliases for the exact same case-sensitive
shortcode. Different shortcodes, the general Reels feed, and Story identities
remain separate. The regression fixture includes that real mixed-permalink
structure; native tests cover both alias directions and different-item denials.

A new regression reproduced permanent rejection when an empty player shell
arrived before measurable layout and then acquired its source. Before a card
had been selected, the guard recorded that shell as permanently rejected. The
repair conceals unselected shells without binding or rejecting their sources
until the selected card exists. Source recycling, alternate posts, and onward
gestures retain their existing independent restrictions.

Live Search layout inspection found grid rows with three fixed tracks inside a
virtualized vertical container. Hiding a cell retained unused tracks. Approved
cells now share the row's available width, and fully filtered rows disappear.
The original row containers remain intact for Instagram's virtualizer. Layout
ownership follows reparented anchors, drops disconnected rows, and clears when
leaving Search, including a Search with an empty query.

The expanded Search fixture also reproduced a second instability: a like/view
counter increment changed the text-verdict fingerprint and re-hid the tile.
The fingerprint now compares qualification boundaries, exact author identity,
and the same text inputs. Every open still independently requires fresh,
qualifying counts; changes that remove qualification or change text revoke
approval. Popularity thresholds and text policy were not relaxed.

Regression coverage now uses the observed nested three-column layout and
checks removed columns, empty rows, counter updates, query revocation, and
route cleanup. The destination test uses a locally encoded H.264 fixture and
checks decoded playback progress after delayed player hydration, in addition
to element visibility and the navigation boundary. Its mounted media/gesture
fixtures remain retained for the test process, avoiding the simulator's known
immediate-teardown `InvalidTransition` error. Eleven focused simulator tests
passed together, including the real native Search handler, actual decoded
post/Reel playback, alias URL boundaries, recycled media, recipient/comment
containment, pinch, and onward-swipe prevention. Fourteen targeted Node checks,
the TypeScript build, and repository lint also passed.

The final combined installation is Vigil `0.3.212 (215)` / phone suite
`0.3.232 (235)`. The supported updater confirmed the exact installed and live
supervised policy fingerprint `67485da8b67d`, matching deployment receipt,
signing, companions, and service launches. Other policy work was concurrent in
the shared checkout; those changes were preserved and the final transaction
was rechecked against the current live source after that policy update.

Final live verification reopened the exact previously blank basketball post
through its approved Search result. Its article and video were now allowed and
visible; the normal video playback request resolved, readyState reached 4, and
playback advanced beyond eight seconds. The live guard continued to reject a
different post. A separate niche-meme Search produced 36 allowed results and
6 denied results. A two-result row had two 201.5-pixel tracks filling its
404-pixel width instead of retaining an empty third column. Instagram also
returned profile-reader rate limits during this diagnostic session; unverifiable
account evidence remained fail-closed and did not bypass the popularity rule.
