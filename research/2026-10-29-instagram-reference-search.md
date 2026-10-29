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
