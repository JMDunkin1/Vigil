import { containsContextualExplicitMedia, containsMultilingualExplicitText, normalizeExplicitVocabulary, containsExplicitSearchAliases } from "./explicitMediaContext.js";
import { decodeSearchQueryValue, searchQueries } from "./searchQueryContext.js";

export function containsExplicitMediaLabel(value: string): boolean {
  return containsContextualExplicitMedia(value);
}

// Mixed-use platforms supply context only for search/tag/community navigation.
// Ordinary page prose, unrelated hosts, and generic searches retain their own
// policy. Existing explicit terms and permanently denied sites still apply.
export const CONTEXTUAL_SEARCH_PLATFORMS = [
  "reddit.com", "deviantart.com", "artstation.com", "pixiv.net",
  "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com",
  "artmajeur.com", "inkbunny.net", "sofurry.com", "weasyl.com",
  "saatchiart.com", "fineartamerica.com", "flickr.com", "500px.com",
  "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app",
  "patreon.com", "itch.io", "discord.com", "discordapp.com"
];
export const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|fur[\s_-]*affinity|artmajeur|inkbunny|sofurry|weasyl|saatchi[\s_-]*art|fine[\s_-]*art[\s_-]*america|flickr|500px|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])/iu;
export const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|18\s*\+|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;
function contextualSearchDecode(value: string): string {
  return normalizeExplicitVocabulary(decodeSearchQueryValue(value));
}

// Bounded aliases and concatenated blocked words; never fuzzy-match arbitrary
// substrings such as Middlesex, nudging, or an alphanumeric product identifier.
export function containsExplicitSearchVariants(query: string): boolean {
  return containsExplicitSearchAliases(contextualSearchDecode(query));
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
      && [url.pathname, url.hash.split("?", 1)[0]].some(path => containsMultilingualExplicitText(contextualSearchDecode(path)));
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
