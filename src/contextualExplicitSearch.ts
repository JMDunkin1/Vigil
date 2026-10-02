import { containsContextualExplicitMedia, containsMultilingualExplicitText } from "./explicitMediaContext.js";

export function containsExplicitMediaLabel(value: string): boolean {
  return containsContextualExplicitMedia(value);
}

// Mixed-use platforms supply context only for search/tag/community navigation.
// Ordinary page prose, unrelated hosts, and generic searches retain their own
// policy. Existing explicit terms and permanently denied sites still apply.
const CONTEXTUAL_SEARCH_PLATFORMS = [
  "reddit.com", "deviantart.com", "artstation.com", "pixiv.net",
  "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com",
  "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app",
  "patreon.com", "itch.io", "discord.com", "discordapp.com"
];
const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|furaffinity|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|18\s*\+|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_PARAMETERS = new Set([
  "q", "query", "search_query", "search", "searchterm", "search_term",
  "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag", "mode"
]);
const CONTEXTUAL_SEARCH_ROUTE = /(?:^|[/#])(?:advancedsearch(?:\.php)?|search(?:\.php)?|results?|find|browse|tags?|tagged|hashtag|r|tag-[^/]+)(?:[/?.#]|$)/iu;

function contextualSearchDecode(value: string): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch { break; }
  }
  return value.replace(/\+/gu, " ").normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "");
}

// Bounded aliases and concatenated blocked words; never fuzzy-match arbitrary
// substrings such as Middlesex, nudging, or an alphanumeric product identifier.
export function containsExplicitSearchVariants(query: string): boolean {
  return /^\s*nud(?:s|3s?)?\s*$/iu.test(contextualSearchDecode(query))
    || /(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.test(contextualSearchDecode(query));
}

export function containsContextualExplicitSearch(query: string, hostname = "", includeRedditShorthand = true): boolean {
  const decoded = contextualSearchDecode(query);
  if (containsContextualExplicitMedia(decoded)) return true;
  if (containsExplicitSearchVariants(decoded)) return true;
  const normalized = decoded.replace(/3/gu, "e").replace(/0/gu, "o");
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  const platform = CONTEXTUAL_SEARCH_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`));
  if ((host === "itch.io" || host.endsWith(".itch.io"))
    && /(?:^|[/#])tag-adult(?:$|[/?.#])/iu.test(decoded)) return true;
  // Bare x/xx are unsafe Reddit discovery queries, but not general keywords:
  // preserve Xbox, SpaceX, X-Men, ordinary post URLs, and in-progress typing.
  const reddit = host === "reddit.com" || host.endsWith(".reddit.com");
  if (reddit && ((includeRedditShorthand && /^\s*x{1,2}\s*$/iu.test(decoded))
    || /(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])/iu.test(decoded))) return true;
  return (platform || CONTEXTUAL_SEARCH_NAMES.test(decoded)) && CONTEXTUAL_SEARCH_MARKERS.test(normalized);
}

export function matchContextualExplicitSearchUrl(value: unknown): boolean {
  if (searchQueries(value).some(({ query, hostname }) => containsContextualExplicitSearch(query, hostname))) return true;
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol)
      && [url.pathname, url.hash].some(path => containsMultilingualExplicitText(contextualSearchDecode(path)));
  } catch { return false; }
}

// XXX occurs in document IDs, tracking values and Roman numerals. It is only
// an explicit URL signal in actual search text, never an arbitrary URL substring.
export function containsExplicitXxxSearchText(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}]|videos?\b|vids?\b|photos?\b|pics?\b|porn\b)/iu.test(contextualSearchDecode(query));
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
