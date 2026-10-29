# Comic reader and discovery coverage

Reviewed October 29, 2026 following the user's Q Toon report and Comicle alternatives link. Metadata and catalog labels only; no chapter images were inspected.

## Domain additions

| Domain | Evidence and reason |
| --- | --- |
| `qtoon.com` | User-requested reader ban. [First-party title metadata](https://qtoon.com/detail/c_WH9J2ncQU29L3GOp1OCC) labels its catalog Adult, Mature and Smut. The current root returned empty text; indexed first-party metadata supplied the classification. |
| `qtoon.net` | [Reader genre page](https://qtoon.net/genre) identifies QToon and a Mature category. Treat as a reader destination, without claiming shared ownership with other QToon sites. |
| `qtoon.org` | [Reader home page](https://www.qtoon.org/?lang=en) labels catalog entries Adult, Mature and Smut. |
| `qtoon.ai` | [Developer's Google Play listing](https://play.google.com/store/apps/details?id=com.qtoon.reader) explicitly identifies this as its QToon reader website. Covered by the requested QToon ban; its own homepage returned 403, so no independent adult-content claim is made. |
| `comicle.com` | Reported discovery chain: the [user's Comicle alternatives page](https://comicle-manga-manhwa-comics.soft112.com/comicle-manga-manhwa-comics-alternatives.html) identifies this reader's terms and privacy URLs. Covered as the reported reader; the first-party site timed out, so no verified 18+ classification is claimed. |
| `comicle-manga-manhwa-comics.soft112.com` | User-reported app and alternatives listing. Whole listing subdomain covered, including HTTP, HTTPS and subdomains. |
| `line-webtoon.soft112.com` | The supplied alternatives page links this app listing for WEBTOON, already under a verified whole-platform restriction. |
| `manta-unlimited-trending-webtoons.soft112.com` | The supplied alternatives page links this app listing for Manta, already under a verified whole-platform restriction. |

Do not block all of Soft112. StoryToon, KAI, Cookie Manga, Manga Reader, Manga Abyss, Manga Fox, Manga Maker, and MANGA BANG were present in the alternatives list, but this pass did not establish first-party adult catalog evidence for those specific apps. Directory inclusion alone is not evidence of adult content. No new domain rule was fabricated for them. `qtoon.app` currently serves an unrelated gambling page; `qtoon.me` and `qtoon.pro` could not be verified as comic readers and were not added as curated comic domains. Brand discovery matching can still match an exact QToon label in a destination.

## Discovery gap

Extend the shared bounded-token matcher with QToon, Comicle, and 20 distinctive brands from Vigil's already-reviewed whole-platform inventory. This blocks brand searches, app listing slugs, alternative/competitor routes and matching domain labels independently of SafeSearch evidence and the optional bulk blocklist. Normalize `Q Toon`, punctuation-separated and Unicode spellings through the same JavaScript/Swift vocabulary pipeline. Ambiguous brand names such as Manta and INKR remain domain rules; general comic history/drawing queries and opaque URL credentials/query metadata are not treated as brand discovery.

Use the existing generator for native Swift, iOS text policy, Chrome, Safari and embedded browser resources. Do not hand-edit generated guards. Existing curated blocks, supervised BuiltIn filters, restriction payloads and removal protections remain required.

## Verification and deployment

- Build, source lint (510 files), generated Swift/text-policy freshness and diff checks passed. Fourteen distinct targeted suites passed, including comic discovery, all curated comic domains and migration, every emitted phone filter's capacity and complete deny inventory, semantic URL precision, native text classification, broadened explicit search, phone-suite transactions and Safari guard freshness. New native tests exercise Q Toon spacing, Unicode, bounded matches and ordinary controls.
- The larger adversarial suite exceeded its native navigation execution timeout. The same timeout and an unrelated existing false positive were documented in `research/2026-10-25-print-poster-audit.md`; this suite is not reported as passing. No enforcement settings were changed to make tests run.
- Applied only this task's source/test/generated deltas to the durable Mac source checkout after `git apply --check`, with original files and the patch backed up under `/var/folders/23/n5qk9lh148d_rdzsvr334fvh0000gn/T/vigil-comic-source-backup-p4lprmwd`. Unrelated workspace changes were preserved.
- `npm run agent:update -- --allow-local --timeout-seconds 1200` completed through the authenticated protected transaction. Installed app/source fingerprint: `2b474bd17c9c38f15f8ff836ca7ef35469d9fa0a6d36659d417f995c78a05212`. Live liveness and readiness both report healthy/ready, with no blockers. All four live built-in profiles block subdomains of all eight additions; live normal-profile rules block the checked QToon/Comicle/Lezhin searches.
- `npm run agent:update:safari` installed and verified the canonical signed Safari extension. Live regular Safari navigation to the user's exact Soft112 alternatives URL and `https://qtoon.org/` reached the minimal Vigil block page. A Private Browsing navigation was initiated but concurrent Safari inspection prevented a clean isolated observation, so it is not counted as a verified private-mode test.
- Another verified phone update initially owned the installation lock and included the changed app resources. After it completed, exact policy comparison detected drift following the Mac profile migration. Ran `npm run agent:update:social` again: no companion reinstall was needed, the signed non-removable policy was installed over USB with the persistent supervisor keybag, and all service launches were rechecked. Final status is current for Personal phone release `0.3.232 (235)`, combined app `0.3.212 (215)`. Installed and freshly generated policy fingerprints match exactly: `67485da8b67d4ba4aec260de8b8b84e0a5d78253ca45e03e57d30b48bb8be5f2`. Apple validated the restrictions payload, six BuiltIn filters, DNS settings and profile-removal protection. No erase, enrollment, Home Screen restore or reboot was performed.
