# Live manga search and Google result-card audit — October 31, 2026

## Method and limits

Opened concurrent native Safari Google tabs for `manga sites`, `read manga online`, and `best manhwa websites`. Used the built-in browser for deeper pagination and first-party catalog inspection. SafeSearch stayed enabled. Inspected 17 generic Google result pages: `manga sites` pages 1–5; `read manga online` pages 1–2; `best manhwa websites` pages 1–4; `free manga websites`, `read manhwa online`, and `read manga chapters` pages 1–2 each. Also followed focused brand results and reader links from the roundups below.

This is a bounded discovery pass, not a claim that every explicit reader has been found. Search rankings, reader domains and catalogs change. Did not open chapter images or bypass certificate warnings. A failed connection does not establish a site's catalog or prove that Vigil blocked it. General manga, Mature/seinen labels, and BL/yaoi labels alone were insufficient grounds for an addition.

Observed roundups:

- https://iamaileen.com/best-free-manga-websites/
- https://www.online-tech-tips.com/best-sites-to-read-manga-online-for-free/

## New permanent domains and evidence

| Domain | Observed evidence | Decision basis |
| --- | --- | --- |
| `zazamanga.com` | Homepage reachable in native Safari before update. First-party indexed chapter metadata at `https://www.zazamanga.com/manga/cleaning-service/chapter-81` labels Adult, Hentai and Smut; first-party genre metadata also describes adult content. | Explicit catalog, rather than the general manga homepage. |
| `mangaowl.io` | Built-in browser reached homepage and `https://mangaowl.io/manga-genre-1/smut/`; rendered Smut category contains uncensored titles. Homepage exposes Adult and Smut genre links. | Direct first-party explicit catalog. |
| `nelomanga.net` | Built-in browser reached homepage and followed Smut genre link. First-party links include `/genre/adult`, `/genre/hentai`, `/genre/erotica`, `/genre/pornographic`, `/genre/smut`. Indexed `https://www.nelomanga.net/manga/despite-that` also labels Adult and Smut. | Direct first-party explicit catalog. |
| `mgread.io` | Google indexed first-party `https://mgread.io/genre/smut/` with 18+ Smut catalog labels. Direct browser navigation encountered a certificate warning, left untouched. | Indexed first-party catalog; direct live rendering remains unverified. |
| `mangapark.cc` | Browser reached reader. Indexed first-party story pages `https://mangapark.cc/manga/sora-yori-takaku` and `https://mangapark.cc/manga/otona-wo-shiritai-onnatomodachi` expose explicit sexual catalog descriptions. | Explicit catalog metadata. The homepage's “Adult Cast” label alone was not used as evidence. |
| `mangapark.one` | Google surfaced same-named MangaPark reader; primary response has reader catalog/genre navigation. | Reader-brand endpoint containment, not an independently verified explicit catalog or a common-ownership assertion. |
| `mangapark.tv` | Actual partner link in MangaOwl's rendered homepage footer. | Reader-brand endpoint containment, not an independently verified explicit catalog or a common-ownership assertion. |
| `mangafreak.net` | Observed roundup link `https://w13.mangafreak.net/` redirects to `https://ww3.mangafreak.me/`, an already blocked adult reader. | Parent-domain coverage for observed reader alias. |

Added exact reader-brand search terms and bounded domain/path matching for ZazaManga, MangaOwl, MangaPark, MGRead and NeloManga/Manganelo. Normalized observed split spellings for Zaza Manga and Nelo Manga/Manga Nelo. Ordinary `manga owl drawing tutorial`, substring lookalikes and generic manga queries remain permitted in policy tests.

## Inconclusive and unadded candidates

`mangapark.org`, `mangapark.io`, and the redirect from `1stkissmanga.io` encountered certificate failures. `mangakakalot.com`, `mangapanda.in`, and `readm.org` timed out; `mangakakalot.to`/`.hot` closed connections; `mangaplanet.com` failed resolution. These failures were not treated as independent catalog evidence. Existing family matching can still apply to known banned brands.

MangaMirai, Omoi, and Orion Scans were not newly banned merely for being manga readers; this pass did not establish explicit catalog evidence for them. ManyToon/MangaClub mentions without a verified endpoint/catalog did not become invented domain entries.

## Reproduced Google presentation bug and change

Native Safari searches showed blocked result headings disappearing while sibling snippet text remained. AI Overview reader recommendations similarly lost their linked names while leaving descriptive text. Current Google results use nested wrappers, and some links use opaque `/goto` redirects; filtering a heading or anchor did not cover the entire result.

The shared helper now selects a whole individual Google card or AI recommendation row, including its citation, snippet, thumbnail and sitelinks. Both search and media guards use that container. The search guard checks direct URLs, standard Google redirect URL parameters, and displayed citation hosts for opaque redirects. It does not interpret opaque redirect bytes or unrelated query metadata. It reconciles dynamically replaced cards and restores their original display when reused for safe content. Multi-result and video groups retain safe sibling cards.

## Validation

- Real built-in browser fixture: old assets failed 14 of the original 25 assertions; changed assets passed all 25. Inspected rendered pass status and safe neighboring results.
- Native WKWebView fixture shares the browser HTML fixture and executes both compiled production guards. Expanded to 28 assertions including separate video cards, snippets, sitelinks, AI rows, redirect citations, dynamic insertion, recycled cards, style repair and immediate click interception.
- Runtime policy, mature-comic, Safari search parity and extension-rule suites cover all new domains and cross-surface generation. Generated native classifiers and phone content policy updated from canonical inputs.
- Electron fixture is provided for compatible runtimes, but its local process exited without the required completion receipt; it is not counted as a passed test.

Full `npm run lint` passed, including the source lint over 531 files. All four targeted runtime suites above and the 28/28 native WebKit checks passed in both the development checkout and the durable updater source, which excludes unrelated concurrent work.

## Protected deployment and live verification

Ran `npm run agent:update -- --allow-local --timeout-seconds 1200` through Vigil's protected update transaction, then `npm run agent:update:safari` from its durable source checkout. Mac transaction `8ad5342b-0077-418b-9ece-611222c98ee9` completed with installed/source fingerprint `eb89fae78af89b2b17bc094e4ce2cf5b1951093afdef952751917b7a74a15013`; health reports healthy/ready and the installed app matches its source checkout. The Safari updater verified the signed bundle, running Vigil connection, and canonical installed resources.

Opened a separate native Safari verification window after installation. Reloaded `manga sites` and opened `best manhwa websites`: ordinary results retained complete descriptions, blocked reader cards had no leftover snippets, and blocked AI recommendations had no dangling row descriptions. Expanded the latter AI Overview and confirmed the remaining Asura/Flame row stayed intact. Direct navigation to the previously reachable ZazaManga homepage and to NeloManga now showed Vigil's minimal “Blocked”/“Back” page. These checks establish the tested searches and navigations, not every possible Google layout.

Read-only phone status reported the paired iPhone unreachable by USB or local network. Phone sources/policy are updated, but this pass did not deploy or verify the phone installation.
