# Manga reader and adult-directory coverage

Reviewed October 30, 2026 after the user reported five additional reachable destinations. The earlier MangaDex addition did not establish exhaustive coverage. This pass uses a defined directory inventory and records every attempted reader URL, including failures, rather than claiming all adult manga sites have been found.

## Scope and evidence

The requested targets are `mangakakalots.co.uk`, `mangafire.to`, `atsu.moe`, `everythingmoe.com` and `proxy.cubari.moe` (normalize the supplied trailing DNS dot). Followed EverythingMoe's manga, manhwa and explicit comic-reader sections, including the lower-ranked JSON inventories, then checked reader metadata and adult-category links. Attempted 198 reader URLs. No chapter images were downloaded or visually inspected.

The companion JSON records 96 new permanent-policy domains. Each selected entry distinguishes a user request, first-party explicit catalog, directory-labeled NSFW reader, or documented alternate reader endpoint. The requested Cubari proxy is covered by the parent `cubari.moe` rule; the directory explicitly lists that parent as an alternate. Recorded reader redirects are covered as well. Directory classifications and documented alternate endpoints are not independent proof that every listed catalog is pornographic. Failed HTTP/TLS/DNS requests and JavaScript-only responses remain failed or inconclusive first-party checks.

First-party examples include Atsumaru's adult-content warning and Adult/Smut labels, MangaFire's Pornographic/Adult/Smut labels, Weeb Central's Adult Content field, MangaKatana's Adult/Erotica genres, MangaHub's explicit catalog filters, and KakaManga's Adult/Pornographic genres. The requested MangaKakalots landing page links directly to KakaManga. URLs and exact classification labels are retained in the JSON without copying story descriptions.

Mature, seinen, romance, BL, yaoi and yuri labels alone were not used to classify sites as sexual. General bookstores, ordinary manga resources and sites with only inconclusive metadata were not added solely because a directory listed them.

## Policy and discovery behavior

Added the selected domains to the shared permanent priority inventory so they migrate into all four saved built-in profiles, browser static rules and supervised BuiltIn deny payloads, independently of the optional bulk list. Existing deny entries are retained. Known distinctive reader brands now also match discovery/search URLs and mirror host labels across new TLDs; selected spaced names, Unicode forms, and numbered MangaSee/XToonhub mirrors share the generated JavaScript/Swift matcher. Short or common labels such as `atsu`, `akuma`, `naisho` and `schale` remain domain-only.

Opaque credentials and return-link query metadata do not become discovery evidence. General manga drawing/history searches remain allowed. Unknown readers or new brands with no recognizable adult labels remain possible: this is a dated coverage expansion, not an exhaustive or self-updating web inventory.

## Verification

- Build and lint passed; native matcher and iOS text-policy generated resources are current.
- Comic discovery tests passed across server, browser and native Swift, including reported URLs, trailing DNS dot, offline domains, new-TLD/numbered mirrors, spaced and Unicode brand names, and ordinary controls.
- Whole-platform/migration, explicit-content policy, native text classifier, broadened search, Safari guard, browser extension rules and phone-suite transaction tests passed.
- Independently checked all 96 new domains and five requests in every built-in profile and browser static inventory, with bulk blocking disabled. Both HTTP and HTTPS survive supervised-policy generation. Seven BuiltIn payloads contain 500, 500, 500, 500, 500, 500 and 13 URLs respectively, within Apple's per-payload cap, without losing existing priority denies.

## Deployment

- Applied only this task's deltas to the durable updater source, preserving its existing changes. Its native Swift resources were regenerated with that checkout's own generator; its discovery and complete inventory/migration checks also passed.
- `npm run agent:update -- --allow-local --timeout-seconds 1200` completed the authenticated protected transaction. Installed source fingerprint: `ed33525697053d562c9c4df43dc500cdb1d73b6d696d5e159632b290dd4454be`. Verified every new domain and requested target against all four live profiles, confirmed extension-policy blocking, and checked healthy liveness/readiness and the installed-checkout identity.
- `npm run agent:update:safari` installed and verified the signed canonical Safari extension and its resources.
- `npm run ios:phone:status` could not reach the paired iPhone over USB or the local network. The expanded signed supervised policy and phone app resources have not been deployed or live-verified on that phone. No erase, enrollment, layout restore, policy removal, or enforcement suspension was performed.
