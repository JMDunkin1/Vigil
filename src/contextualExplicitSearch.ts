// Mixed-use platforms supply context only for search/tag/community navigation.
// Ordinary page prose, unrelated hosts, and generic searches retain their own
// policy. Existing explicit terms and permanently denied sites still apply.
const CONTEXTUAL_SEARCH_PLATFORMS = [
  "reddit.com", "deviantart.com", "artstation.com", "pixiv.net",
  "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com",
  "pinterest.com", "pinterest.co.uk"
];
const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|furaffinity|tumblr|pinterest)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_PARAMETERS = new Set([
  "q", "query", "search_query", "search", "searchterm", "search_term",
  "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag"
]);
const CONTEXTUAL_SEARCH_ROUTE = /(?:^|[/#])(?:search|results?|find|browse|tags?|tagged|r)(?:[/?.#]|$)/iu;

function contextualSearchDecode(value: string): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch { break; }
  }
  return value.replace(/\+/gu, " ").normalize("NFKC");
}

export function containsContextualExplicitSearch(query: string, hostname = ""): boolean {
  const decoded = contextualSearchDecode(query);
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  const platform = CONTEXTUAL_SEARCH_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`));
  return (platform || CONTEXTUAL_SEARCH_NAMES.test(decoded)) && CONTEXTUAL_SEARCH_MARKERS.test(decoded);
}

export function matchContextualExplicitSearchUrl(value: unknown): boolean {
  return searchQueries(value).some(({ query, hostname }) => containsContextualExplicitSearch(query, hostname));
}

// XXX occurs in document IDs, tracking values and Roman numerals. It is only
// an explicit URL signal in actual search text, never an arbitrary URL substring.
export function containsExplicitXxxSearchText(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}])xxx(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b|porn\b)/iu.test(contextualSearchDecode(query));
}

export function matchExplicitXxxSearchUrl(value: unknown): boolean {
  return searchQueries(value).some(({ query }) => containsExplicitXxxSearchText(query));
}

function searchQueries(value: unknown): Array<{ query: string; hostname: string }> {
  let url: URL;
  try { url = new URL(String(value || "")); }
  catch { return []; }
  if (!["http:", "https:"].includes(url.protocol)) return [];
  const queries = [...url.searchParams]
    .filter(([name]) => CONTEXTUAL_SEARCH_PARAMETERS.has(name.toLowerCase()))
    .map(([, query]) => query);
  for (const route of [url.pathname, url.hash]) {
    const decoded = contextualSearchDecode(route);
    if (CONTEXTUAL_SEARCH_ROUTE.test(decoded)) queries.push(decoded);
  }
  return queries.map(query => ({ query, hostname: url.hostname }));
}
