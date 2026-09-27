# Whole-platform mature comic restrictions

Reviewed September 27, 2026. User requested whole-site bans when a platform has an 18+ section or version. These are domain rules, including ordinary pages and subdomains, rather than page-text keywords. This audit covers major webcomic and digital manga platforms found through web searches; it is not an exhaustive inventory of the internet.

| Platform / blocked domain | First-party evidence | Finding |
| --- | --- | --- |
| WebComics — `webcomicsapp.com` | [Privacy policy](https://h5.webcomicsapp.com/public/app/disclaimer/privacy.html) | Mature Content Filter restricts some content for users under 18. Its terms prohibit pornography; an 18+ classification alone satisfies this user's rule. |
| WEBTOON — `webtoons.com` | [Content ratings notice](https://m.webtoons.com/en/notice/detail?noticeNo=3651) | Mature category is 18+; this need not mean explicit sexual content. Already banned by Vigil's URL baseline; domain rule makes host enforcement explicit. |
| Tapas — `tapas.io` | [Mature section help](https://help.tapas.io/hc/en-us/articles/360036988533-What-is-the-Mature-section) | Web-only explicit-content section for adults 18+. |
| Tappytoon — `tappytoon.com` | [Official uncut edition listing](https://www.tappytoon.com/en/book/to-you-who-will-ruin-me-m) | Uncut edition is restricted to adults 18+. |
| Manta — `manta.net` | [Full version help](https://help.manta.net/hc/en-us/articles/33842317646615-What-is-a-Full-Version) | Full versions contain mature content and require age 18+. |
| Toomics — `toomics.com` | [Age verification](https://toomics.com/en/age_verification) | Adult restricted content requires confirming age over 18. |
| Lezhin — `lezhin.com`, `lezhinus.com` | [Official Plus page](https://www.lezhinus.com/en/lezhin-plus) | Adult-comic edition; official instructions identify both domains. |
| Lezhin X — `lezhinx.com` | [FAQ](https://www.lezhinx.com/faq) | Confirms adult comics and age verification. |
| DayComics — `daycomics.com` | [Terms](https://app.daycomics.com/terms) | Identifies sexually oriented material for adults 18+. |
| Toptoon — `toptoon.com` | [Terms](https://global.toptoon.com/terms) | Identifies sexually oriented material for adults 18+. |
| Coolmic — `coolmic.me` | [Official feature announcement](https://coolmic.me/event/news/220117_Manga_Format.html) | Documents an additional +18 comic selection. |
| INKR — `inkr.com` | [Official mature listing](https://comics.inkr.com/title/1548-caught-on-tape-mature) | Explicitly rated Mature (18+). |
| GlobalComix — `globalcomix.com` | [Publisher listing](https://globalcomix.com/c/vescell) | Explicit adult-only 18+ warning and sexual-content advisory. |
| MangaPlaza — `mangaplaza.com` | [Mature category](https://mangaplaza.com/genre/3/151/) | Dedicated Mature (18+) catalog category. |
| eManga — `emanga.com` | [Publisher listing](https://emanga.com/products/because-isnt-it-love) | Adult sexual-content title cataloged with age tag 18. |
| BOOK WALKER — `bookwalker.jp` | [Official catalog](https://bookwalker.jp/new/?qinc_bnst=1&qtag=1196) | Explicit R-18 adult-only storefront navigation. |
| Renta! — `ebookrenta.com` | [Official publisher listing](https://www.ebookrenta.com/renta/sc/frm/item/145429/) | Specifies sexual content intended for ages 18 and up. |

Comikey's [guidelines](https://comikey.com/guidelines/) document mature warnings but prohibit nudity and sexually gratifying content; the reviewed evidence did not establish an 18+ edition. Searches for NETCOMICS and Manga Planet did not produce sufficient first-party confirmation in this pass, so no new rule was inferred for them. Keyword landing pages alone were not treated as proof.

## Enforcement

The 18 domains are included in the existing domain-only priority baseline used by Mac profiles. The iPhone profile preserves its existing primary deny list and adds a separate BuiltIn filter containing both HTTP and HTTPS roots for every domain. Each payload has a distinct deterministic UUID. Existing restrictions, automatic filtering, permitted exceptions, SafeSearch DNS, and removal protection remain intact.

Apple documents [multiple Web Content Filter payloads](https://support.apple.com/guide/deployment/depc77c9609/web), whole-domain coverage including subdomains, and [a maximum of 500 deny URLs per payload](https://github.com/apple/device-management/blob/release/mdm/profiles/com.apple.webcontent-filter.yaml). The supplemental payload has 36 URLs; it does not consume primary-list slots. Deployment still requires Vigil's verified app-and-policy transaction and exact live-policy verification.

## Deployment result

- Build, source lint, and six targeted test suites passed, including whole-domain/subdomain enforcement, iOS capacity, MDM profile generation, policy enforcement, explicit-content policy, and the phone suite.
- Protected Mac update completed; all four live built-in profiles contain all 18 domains. Evaluating the live state blocks sample subdomain URLs for every domain. Overall readiness remains unverified: the existing process sweep reports an Electron Helper command failure, and the static hosts/Safari profiles report stale state. Do not represent this as fully verified system-wide blocking.
- Apple validated the signed phone profile with both BuiltIn payloads. After the user confirmed the phone was unlocked, the protected transaction completed: combined app 0.3.132 (135), release 0.3.143 (146), live policy fingerprint prefix `5875ccc0679f`. Final phone status is current; exact installed and generated policy fingerprints match. The non-removable profile was installed using the persistent supervisor keybag. The deployment receipt verifies launches for Instagram, YouTube, Snapchat, and LinkedIn.
