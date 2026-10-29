# File and media discovery search restrictions

The reported issue is a category gap: public-file discovery services expose
shared media without necessarily using explicit adult labels. They need at
least the existing art/community discovery context, with suggestive terms
promoted from supporting evidence to independent search restrictions.

## Discovery sources

Reviewed on October 29, 2026:

- [OSINT.link](https://osint.link/), especially Files Search Engines, FTP search,
  image tools and video tools. Extracted the actual outbound domains for
  de-digger, FilePursuit, SearchFiles, FileSearch, Mediafiretrend, Search Shared,
  Meawfy, Eyedex, UVRX, Fagan Finder, NAPALM and Mamont.
- [OH SHINT search engine inventory](https://ohshint.gitbook.io/oh-shint-its-a-blog/osint-web-resources/search-engines),
  which independently groups Drive discovery and open-directory/file search.
- [de-digger about](https://www.dedigger.com/about) and its
  [current home page](https://www.dedigger.com/). Inspected the site's HTML:
  it embeds Google Custom Search. Its queries can use `#gsc.tab=0&gsc.q=…`,
  which the previous URL query extractor did not recognize.
- [Sunlight Research image/video tools](https://www.sunlightresearch.net/image-and-video)
  and [InfoEpi image search inventory](https://infoepi.org/tools/search-for-image.html)
  for the broader image/video retrieval category.
- [Google Drive search help](https://support.google.com/drive/answer/2375114)
  for the distinction between declared search input and ordinary file URLs.

## Implemented scope

`MEDIA_DISCOVERY_PLATFORMS` in `src/contextualExplicitSearch.ts` covers 47
domains: public-file/FTP indexers, shared-storage search, image/reverse-image
search, stock/photo/GIF discovery and video services. Existing whole-site bans
remain in force; this inventory adds search context, not access exceptions.

Known hosts, named services in a query (including `site:drive.google.com`),
image/video search routes and search-mode parameters receive the stricter
rules. In the browser, the title, main heading or description can identify an
otherwise unknown file/media finder. Only actual search input uses that page
context; unrelated page prose and outgoing destinations do not inherit it.

In addition to art/community markers, words such as sexy, spicy, mature,
suggestive, provocative, lingerie, revealing, uncensored and leaked are
independent negative search signals on these surfaces. Neutral terms such as
files, photos and models alone remain usable. Established ordinary phrases
such as adult education, mature trees and leaking pipes retain their scope;
they cannot consume separate explicit evidence.

`18+`, `18 plus`, `18plus`, `18-plus` and `eighteen plus` independently block
in deliberate search text, including encoded and normalized variants. This
check precedes ordinary-phrase removal, so an age query does not become
permitted by adding travel insurance. File IDs, arbitrary URL metadata and
ordinary routes do not receive a new substring ban. `18+5` remains arithmetic.

Server, browser, standalone Safari and native iOS matchers share the change.
Google Custom Search fragments and `search_api_fulltext` are parsed as declared
search fields. Chromium's static network rules add search-only age protection
without replacing the existing frozen baseline or exceeding its regex budget.

## Verification

- 835 URL cases across all 47 domains, search modes, named services, CSE
  fragments, age forms, ordinary queries, spoofed hosts and opaque metadata.
- DOM fixtures exercise prefilled controls, typing, Enter, click and POST form
  submission on an otherwise unknown media finder.
- Existing policy, precision, adversarial, browser/native parity and static
  DNR equivalence checks, plus the Chromium RE2 compiler budget check.

The adversarial suite has one pre-existing expectation mismatch: its
`legitimate-confirmed-16` case expects `oral ulcer photographs` to be allowed,
while the unchanged HEAD version of `containsContextualExplicitMedia` already
returns true. This change preserves that restriction. The rest of the 1,599
navigation variants retain their reviewed outcomes. Native normalization
patterns are compiled once so the enlarged cross-engine checks do not rebuild
the same regexes for every URL component.

The domain inventory is finite. New or unrecognized tools can be covered by
declared media routes/modes or browser page context; this is not a claim of
perfect classification of every future service or arbitrary native app.
