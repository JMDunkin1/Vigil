import { containsContextualExplicitMedia, containsMultilingualExplicitText, normalizeExplicitVocabulary, normalizeAutomaticExplicitText, containsExplicitSearchAliases } from "./explicitMediaContext.js";
import { decodeSearchQueryValue, searchQueries } from "./searchQueryContext.js";

// Search context only: these services are not whole-site bans. Inventory and
// category sources are recorded in research/2026-10-29-media-discovery-search.md.
export const MEDIA_DISCOVERY_PLATFORMS = [
  "dedigger.com", "filepursuit.com", "searchfiles.de", "filesearch.link",
  "mediafiretrend.com", "searchshared.info", "meawfy.com", "eyedex.org",
  "uvrx.com", "faganfinder.com", "searchftps.net", "mmnt.ru",
  "drive.google.com", "mega.nz", "mega.io", "mediafire.com", "4shared.com",
  "dropbox.com", "gofile.io", "archive.org",
  "images.google.com", "lens.google.com", "images.search.yahoo.com", "video.search.yahoo.com",
  "tineye.com", "pimeyes.com", "lenso.ai", "facecheck.id",
  "gettyimages.com", "istockphoto.com", "shutterstock.com", "stock.adobe.com",
  "alamy.com", "dreamstime.com", "depositphotos.com", "123rf.com",
  "pexels.com", "pixabay.com", "unsplash.com", "freepik.com",
  "giphy.com", "tenor.com", "photobucket.com", "imgur.com",
  "youtube.com", "vimeo.com", "dailymotion.com"
] as const;
export const MEDIA_DISCOVERY_NAMES = /(?:^|[^\p{L}\p{N}])(?:de[\s_-]*digger|file[\s_-]*pursuit|searchfiles|filesearch|mediafire(?:trend)?|searchshared|meawfy|eyedex|uvrx|google[\s_-]*drive|gdrive|drive\.google\.com|mega\.(?:nz|io)|4shared|dropbox|gofile|archive\.org|google[\s_-]+(?:images|videos)|(?:file|media|image|video)[\s_-]+(?:search|finder)|(?:shared|public)[\s_-]+(?:files|folders)|open[\s_-]+directories)(?:$|[^\p{L}\p{N}])/iu;
// Promote suggestive/exposure contributors to independent negative signals on
// media discovery surfaces. Neutral words (photos, files, models) stay neutral.
export const MEDIA_DISCOVERY_MARKERS = /(?:^|[^\p{L}\p{N}])(?:adult|adults|mature|explicit|spicy|steamy|sexy|sensual|seductive|sultry|raunchy|racy|risque|suggestive|provocative|revealing|intimate|uncensored|unfiltered|uncut|sensitive|leaks?|leaked|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|lingerie|underwear|bikinis?|thongs?|boudoir|pin[\s_-]*ups?|cleavage|underboob|busty|voluptuous|thicc|thirst[\s_-]*traps?)(?:$|[^\p{L}\p{N}])/iu;
export const AGE_RESTRICTED_SEARCH_MARKER = /(?:^|[^\p{L}\p{N}])(?:18\s*\+|18[\s_.-]*plus|eighteen[\s_.-]+plus)(?=$|[^\p{L}\p{N}])/iu;

export function isMediaDiscoverySearchUrl(value: unknown): boolean {
  let url: URL;
  try { url = new URL(String(value || "")); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  // Explicit image/video routes also cover metasearch and self-hosted engines.
  if (/(?:^|\/)(?:images?|videos?|photos?|media)(?:\/|$)/iu.test(url.pathname)) return true;
  return [...url.searchParams].some(([name, mode]) =>
    /^(?:tbm|udm|ia|iax|category|categories|type|t)$/iu.test(name)
      && (/^(?:isch|vid|images?|videos?|photos?|media)$/iu.test(mode)
        || (name.toLowerCase() === "udm" && /^(?:2|7)$/u.test(mode))));
}

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
  "patreon.com", "itch.io", "discord.com", "discordapp.com", ...MEDIA_DISCOVERY_PLATFORMS
];
export const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|fur[\s_-]*affinity|artmajeur|inkbunny|sofurry|weasyl|saatchi[\s_-]*art|fine[\s_-]*art[\s_-]*america|flickr|500px|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])/iu;
export const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;

const comicSearchBoundary = "(?:^|[^\\p{L}\\p{N}])";
const comicSearchEnd = "(?:$|[^\\p{L}\\p{N}])";
const comicSearchGenres = "(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)";
const comicSearchMarker = "(?:adults?|mature|uncensored|lewd|erotica?|explicit|smut|ecchi|nsfw|hentai|porn|r[\\s_-]*1[89]|1[89](?:\\s*\\+|[\\s_-]*plus))";
const ageSearchMarker = "(?:18\\s*\\+|18[\\s_-]*plus)";
const ageSearchMedia = "(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)";
export const EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS = [
  `${comicSearchBoundary}(?:${comicSearchMarker}[\\s_.-]*${comicSearchGenres}|${comicSearchGenres}[\\s_.-]*${comicSearchMarker})${comicSearchEnd}`,
  `${comicSearchBoundary}(?:${ageSearchMarker}[\\s_-]+${ageSearchMedia}|${ageSearchMedia}[\\s_-]+${ageSearchMarker})${comicSearchEnd}`
] as const;

function containsExplicitComicOrAgeSearch(value: string): boolean {
  return EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS.some(pattern => new RegExp(pattern, "iu").test(value));
}
function contextualSearchDecode(value: string): string {
  return normalizeExplicitVocabulary(decodeSearchQueryValue(value));
}

// Bounded aliases and concatenated blocked words; never fuzzy-match arbitrary
// substrings such as Middlesex, nudging, or an alphanumeric product identifier.
export function containsExplicitSearchVariants(query: string): boolean {
  return containsExplicitSearchAliases(normalizeAutomaticExplicitText(contextualSearchDecode(query)));
}

export function containsContextualExplicitSearch(query: string, hostname = "", includeRedditShorthand = true, mediaDiscovery = false): boolean {
  const decoded = contextualSearchDecode(query);
  // Search intent is deliberately stricter than URL/page prose. Check before
  // ordinary-phrase removal: even "18+ travel insurance" is a typed age query.
  if (AGE_RESTRICTED_SEARCH_MARKER.test(decoded)) return true;
  // Consume only established ordinary phrases. Separate explicit intent in
  // the same query remains available to the media/alias checks.
  const evidence = normalizeAutomaticExplicitText(decoded);
  if (containsContextualExplicitMedia(evidence)) return true;
  if (containsExplicitSearchVariants(evidence)) return true;
  if (containsExplicitComicOrAgeSearch(evidence)) return true;
  const normalized = evidence.replace(/3/gu, "e").replace(/0/gu, "o");
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  const platform = CONTEXTUAL_SEARCH_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`));
  const discovery = mediaDiscovery || MEDIA_DISCOVERY_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`))
    || MEDIA_DISCOVERY_NAMES.test(decoded);
  if (discovery && (CONTEXTUAL_SEARCH_MARKERS.test(normalized) || MEDIA_DISCOVERY_MARKERS.test(normalized))) return true;
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
  if (searchQueries(value).some(({ query, hostname }) => containsContextualExplicitSearch(query, hostname, true, isMediaDiscoverySearchUrl(value)))) return true;
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol)
      && [url.pathname, url.hash.split("?", 1)[0]].some(path => containsMultilingualExplicitText(contextualSearchDecode(path)));
  } catch { return false; }
}

// XXX occurs in document IDs, tracking values and Roman numerals. It is only
// an explicit URL signal in actual search text, never an arbitrary URL substring.
export function containsExplicitXxxSearchText(query: string): boolean {
  return /(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}]|videos?\b|vids?\b|photos?\b|pics?\b|porn\b)/iu.test(normalizeAutomaticExplicitText(contextualSearchDecode(query)));
}

export function matchExplicitXxxSearchUrl(value: unknown): boolean {
  return searchQueries(value).some(({ query }) => containsExplicitXxxSearchText(query));
}
