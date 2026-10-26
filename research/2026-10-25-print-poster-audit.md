# Print and poster filtering audit

Reviewed the user's three open private Safari tabs: Amazon, eBay and Etsy print searches. Existing protection missed mature-tagged prints, lingerie photo prints, sexualized decor, and some listings whose title and image were separate links.

Changes:

- Added shared, bounded visual-product rules for mature, explicit, lingerie, boudoir, pin-up and sexualized print/poster labels. Trailing 18+ and R-18 labels have a separate bounded title window.
- Preserved ordinary family/movie/art prints, apparel sewing patterns, relevant textile patterns, names without sexual labels and unrelated URL metadata.
- Recognized Amazon's `k` field on `/s` and eBay's `_nkw` field on `/sch`, with exact provider-domain boundaries and matching native generation.
- Removed the complete marketplace card when title/image links are separate. Etsy's outer list item takes precedence over the listing ID also attached to its image link. Immediate image-link interactions inspect the containing product label.
- Regenerated shared Safari/Chrome scripts and both native Swift matchers.

Validation:

- Build and source lint passed (500 source files on the final follow-up run).
- Broadened search regressions passed: 133 blocked and 125 legitimate queries across shared policy, generated browser guards, standalone Safari and compiled native matchers.
- Marketplace policy, media catalogs, query fields, browser extension parity, Safari search-guard freshness, filter health reporting, semantic URLs and adult marketplace policy suites passed.
- The initial synthetic Chromium marketplace fixture completed successfully. Subsequent standalone Electron fixture runs were intermittent; the final rerun reported `ERR_FAILED` while loading its intercepted Etsy fixture and did not complete. The fixture now explicitly reports premature exit. No enforcement settings were changed to force a test run.
- The larger adversarial suite exceeded its normal native execution timeout. A diagnostic run with a longer timeout completed the native checks and reported only the existing `oral ulcer photographs` false positive. Evaluating the pre-change matcher at commit `99bfbdf` confirmed the same result. That unrelated policy was left unchanged.

Deployment and live verification:

- Installed the signed Safari extension using `npm run agent:update:safari`. Verified every required installed Safari resource against the tested source bytes.
- Refreshed all three original tabs. Etsy's mature/lingerie and long-title 18+ examples disappeared while ordinary custom family and Henry Danger prints remained. eBay's lingerie and sexualized photo-print titles disappeared while unqualified photo listings remained. Amazon's sexualized poster example disappeared.
- Applied only the task's source/test deltas to the durable Vigil Source Checkout after checking patches and backing up its prior files. Unrelated edits were preserved.
- Attempted `npm run agent:update -- --allow-local --timeout-seconds 1200`. The protected updater refused an unfinished previous replacement at `/Applications/Vigil.app.vigil-next` and `/Applications/Vigil.app.vigil-transaction.json`. Those recovery files were preserved; the main Mac app update is not installed.
- Live Vigil reports `liveness.ok=true`. Its existing readiness blocker says compact usage checkpoints are disabled while sealed full snapshots remain active. Vigil and its watchdog/relaunch protections were never stopped or disabled.
- No phone deployment was attempted. These are label, URL and DOM protections; they do not classify unlabeled image pixels.

## Follow-up after the user's recheck

The first live verification was too narrow: it confirmed labelled examples had disappeared but left unqualified photo titles visible. Reopening the same eBay and Etsy searches with the installed resources verified that many remaining images were sexual despite neutral titles. The extension bytes matched the first revision; this was a remaining policy gap.

The follow-up adds exact full-subject matching for the reviewed Abella Danger photo/print/collectible catalog, including compact and underscore forms. The name by itself and ordinary biographies remain outside that rule. It also handles exposed/bare-body descriptions, sexualized AI-model downloads, mature model collections, and adult-only/not-for-young-people ratings on visual downloads.

Neutral-title products below were visually reviewed in the returned Etsy grid and now have provider-scoped listing/similar-item ID bans. They are not global title keywords or seller bans. A non-explicit sculpture shown in the same grid (`4563889586`) remains an ordinary control.

| Etsy listing ID | Reviewed listing |
| --- | --- |
| 4596079411 | Hot for Teacher Print: sexualized thong photo |
| 250555610 | The Dr. is in: sexualized cartoon print |
| 4439331570 | AI model picture pack: censored topless previews |
| 4531137091 | Bare-breast photo pack |
| 4520580803 | Luxury glamor photo pack: lingerie/butt-focused preview |
| 4596303659 | Dexter's Mommy Print: lingerie photo |
| 4584233511 | Hot for Teacher: sexualized cartoon artwork |
| 4299890278 | Busty AI Model Digital Download |
| 4545313735 | Two is Better than One: nude photo print |
| 4314991788 | Blissed Out Print: sexual illustration with genital censorship |
| 4551934894 | Southern Belle: sexualized cartoon artwork |
| 1891438757 | Underboob personalized shirt: explicit exposure/text preview |
| 4543154295 | Overnight Stay: sexualized character print |
| 4341915187 | Farmer Daughters: adults-only censored photo pack |
| 4583202389 | Vargas Girl: nude Playboy page print |
| 1876924798 | Mature model collection: censored topless previews |
| 4439560667 | Work Harder flag: censored sexual photo |
| 4522401873 | THICC BEAUTY sticker: censored topless character |

Follow-up regressions cover original eBay/Etsy queries, unqualified photo and trading-card titles, reviewed neutral product routes, encoded routes, related-item discovery, exact ID/hostname boundaries, unrelated tracking parameters, ordinary biographies, family/movie prints and classical-art route exceptions. Native query/URL parity and generated browser parity pass. The standalone Electron fixture still reports `ERR_FAILED` loading its intercepted Etsy fixture; it is not reported as passing.

Unknown neutral listings can still require visual review; the finite reviewed-ID set is not an image classifier. The original explicit print searches now qualify for navigation blocking instead of depending solely on individual result labels.

Installed the signed follow-up Safari revision and verified its resources match the tested source exactly. Live navigation to the original eBay search, original Etsy search, and reviewed Etsy listing `4596079411` each produced Vigil's Safari explicit-content block page. Closed the temporary verification window afterward. The main Mac app's earlier transaction blocker remains separate from this verified Safari installation.
