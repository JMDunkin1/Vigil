import { normalizeExplicitVocabulary } from "./explicitMediaContext.js";
import { decodeSearchQueryValue } from "./searchQueryContext.js";

// SafeSearch being enabled is universal in Vigil. Only a notice about results
// actually removed for this query supplies additional classification evidence.
export function isSafeSearchLimitedNotice(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (text.length > 600) return false;
  // Evidence must be an affirmative result notice, not a substring inside
  // "No results ...", an if-clause, or a help article quoting the notice.
  const notice = text.match(/^(?:(?:(?:explicit|some|search) )?results (?:have been |were |are )?(?:filtered|limited|removed|hidden|blurred) (?:with|by|due to) safe\s?search|safe\s?search (?:has |have )?(?:filtered|limited|removed|hidden|blurred) (?:some |explicit |search )?results)\b/iu);
  if (!notice) return false;
  // Google's notices can include their normal explanation/settings links.
  // Other trailing prose can instead describe, negate, or quote this wording.
  const tail = text.slice(notice[0].length).replace(/^[\s.!:;\u2013\u2014-]+/u, "");
  return !tail || /^(?:learn more|(?:change|manage|view|open) (?:your )?(?:safe\s?search )?settings)\b/iu.test(tail);
}

// Google's locked-state banner is not a claim that results were filtered.
// Keep it separate from limited-result evidence; it only activates the
// file-sharing destination rule on the current Google results page.
export function isSafeSearchLockedNotice(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (text.length > 300) return false;
  return /^safe\s?search is locked to filter by (?:safety settings applied to this browser|your network, browser,? or device)\.?\s*(?:learn more\.?\s*)?$/iu.test(text);
}

// These already-ambiguous media, exposure and search markers do not become
// standalone bans. A real limited-results notice supplies the missing context.
const SAFE_SEARCH_CONTRIBUTORS = /^(?:photos?|pics?|pictures?|images?|videos?|vids?|movies?|films?|clips?|gifs?|wallpapers?|footage|streams?|livestreams?|webcams?|documentar(?:y|ies)|compilations?|animations?|illustrations?|comics?|manga|audios?|albums?|galler(?:y|ies)|collections?|links?|downloads?|folders?|files?|packs?|mirrors?|adults?|mature|steamy|spicy|uncensored|unfiltered|uncut|nud|nuds|nude|nudes|nued|nudity|naked|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|frontal|erotic|erotica|lewd|horny|sensual|seductive|sexualized|sexualised|raunchy|salacious|lustful|lascivious|risque|risqué|sultry|racy|titillating|arousing|aroused|fetish|fetishes|kinky|kink|bdsm|bondage|sex|sexual|sexually|sexy|hot|explicit|sensitive|intimate|revealing|suggestive|provocative|teasing|tease|thirst|thirsttraps?|nsfl|leak|leaks|leaked|leakd|lek|leks|creampies?|blowjobs?|handjobs?|cumshots?|bukkake|gangbangs?|threesomes?|orgies|orgy|masturbation|masturbating|fucking|penetration|anal|oral|doggystyle|pegging|squirting|sexting|boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?|girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?|cosplay|furry|furries|doujinshi|lingerie|underwear|bikinis?|swimsuits?|stockings|pantyhose|upskirt|downblouse|x+|18|18g|r18g?|unreviewed|成人|成人向|成人向け|mega|gofile|pixl|cyberdrop|bunkr)$/u;
const SAFE_SEARCH_ORDINARY_CONTEXT = /\b(?:news|biograph(?:y|ies)|interviews?|journalism|research|education|educational|medical|medicine|anatomy|health|history|historical|science|museum|art|drawing|painting|sculpture|makeup|lipstick|recipes?|cooking|baking|chicken|peppers?|software|source code|documentation|security|tutorials?)\b/u;

function safeSearchWords(value: string): string[] {
  const text = decodeSearchQueryValue(String(value || ""));
  return text.normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "").toLowerCase()
    .replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie").match(/[\p{L}\p{N}]+/gu) || [];
}

export function hasSafeSearchContributor(value: string): boolean {
  return safeSearchWords(value).some(word => SAFE_SEARCH_CONTRIBUTORS.test(normalizeExplicitVocabulary(word)))
    || hasSharedFileSearchResultText(value);
}

export function hasOrdinarySafeSearchContext(value: string): boolean {
  return SAFE_SEARCH_ORDINARY_CONTEXT.test(safeSearchWords(value).map(word => normalizeExplicitVocabulary(word)).join(" "));
}

// Cache exact subjects rather than carrying an unsafe flag to an unrelated
// search. Strip only media/navigation qualifiers, never part of a person's name.
export function safeSearchSubject(value: string): string {
  if (hasOrdinarySafeSearchContext(value)) return "";
  const withoutSites = value.replace(/\bsite:\S+/giu, "")
    .replace(SHARED_FILE_SEARCH_URL_TEXT, candidate => sharedFileSearchTextDestination(candidate) ? " " : candidate)
    .replace(SHARED_FILE_SEARCH_NAMES_FOR_SUBJECT, " ");
  const words = safeSearchWords(withoutSites).filter(word => !SAFE_SEARCH_CONTRIBUTORS.test(normalizeExplicitVocabulary(word))
    && !/^(?:a|an|the|and|of|for|in|on|with|free|full|hd|official|nz|io|com|it)$/u.test(word));
  return words.length >= 1 && words.length <= 6 && words.join(" ").length >= 4 ? words.join(" ") : "";
}

export function matchesSafeSearchSubject(value: string, subject: string): boolean {
  const text = ` ${safeSearchWords(value).join(" ")} `;
  return Boolean(subject && text.includes(` ${subject} `));
}

export function sharedFileDestination(value: string, baseUrl?: string): string | null {
  let url: URL;
  try { url = new URL(value, baseUrl); } catch { return null; }
  if (!["https:", "http:"].includes(url.protocol)) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  const onHost = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if ((onHost("mega.nz") || onHost("mega.io")) && /^\/(?:folder|file)\//u.test(url.pathname)) return url.href;
  if (onHost("gofile.io") && /^\/d\//u.test(url.pathname)) return url.href;
  if (onHost("gofile.today") && /^\/l\/d\//u.test(url.pathname)) return url.href;
  if ((onHost("link-center.net") || onHost("direct-link.net")) && /^\/\d+\/[^/]/u.test(url.pathname)) return url.href;
  if (onHost("drive.google.com") && /^\/(?:file\/d|drive\/folders)\//u.test(url.pathname)) return url.href;
  if (onHost("dropbox.com") && /^\/(?:s|sh|scl)\//u.test(url.pathname)) return url.href;
  if (SHARED_ALBUM_DOMAINS.some(onHost)
    && /^\/(?:a|album|f|v)\//u.test(url.pathname)) return url.href;
  if (["t.me", "telegram.me", "telegram.dog"].includes(host) && /^\/[^/]/u.test(url.pathname)) return url.href;
  return null;
}

// Search results often expose only a service homepage, paste/index page, or
// shortened citation. This category is used only with a verified SafeSearch
// notice on the current results page; it is not a whole-site/content ban and
// must not count homepages as shared files in reader link collections.
const SHARED_ALBUM_DOMAINS = ["pixl.li", "cyberdrop.me", "cyberdrop.to", "bunkr.is", "bunkr.si", "bunkr.ru", "bunkr.cr", "erome.com"];
// Verified service sources and migration evidence:
// research/2026-11-07-shared-file-search-services.md
export const SHARED_FILE_SEARCH_DOMAINS = [
  "mega.nz", "mega.io", "gofile.io", "gofile.today", "drive.google.com", "dropbox.com",
  "mediafire.com", "4shared.com", "link-center.net", "direct-link.net",
  ...SHARED_ALBUM_DOMAINS, "bunkr-albums.io", "balbums.st",
  "pixeldrain.com", "catbox.moe", "send.now", "swisstransfer.com", "filebin.net",
  "sendvid.com", "imgbox.com", "streamable.com", "wetransfer.com", "we.tl",
  "onedrive.live.com", "1drv.ms", "pcloud.com",
  "justpaste.it", "pastebin.com", "paste.ee", "rentry.co", "rentry.org", "telegra.ph"
] as const;
// Distinctive service names only. Generic words such as "drive", "send now",
// "streamable", "box", "mega" and "litterbox" need a known domain/name phrase.
const SHARED_FILE_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}_./@-])(?:gofile|mediafire|4shared|dropbox|pixeldrain|catbox|cyberdrop|bunkr(?:[\s_-]+albums)?|balbums|sendvid|imgbox|wetransfer|swisstransfer|filebin|onedrive|pcloud|rentry|pastebin|justpaste|google[\s_-]+drive)(?=$|[^\p{L}\p{N}_./@-])/iu;
const SHARED_FILE_SEARCH_NAMES_FOR_SUBJECT = new RegExp(SHARED_FILE_SEARCH_NAMES.source, "giu");
const SHARED_FILE_SEARCH_URL_TEXT = /\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z0-9-]+(?::\d+)?(?:[/?#@][^\s<>"']*)?/giu;
// Declared sharing/index surfaces cover a new provider before it is named in
// the inventory. Ordinary words like "file" or "download" alone do not.
const SHARED_FILE_SEARCH_CATEGORY = /(?:^|[^\p{L}\p{N}])(?:file[\s_-]+(?:shar(?:e|ing)|host(?:ing)?|index(?:es)?)|(?:shared|public)[\s_-]+(?:files|folders|albums)|(?:download|folder|album|mirror)[\s_-]+links)(?=$|[^\p{L}\p{N}])/iu;

function sharedFileSearchTextDestination(candidate: string): boolean {
  return isSharedFileSearchDestination(/^https?:\/\//iu.test(candidate) ? candidate : `https://${candidate}`);
}

export function isSharedFileSearchDestination(value: string, baseUrl?: string): boolean {
  let url: URL;
  try { url = new URL(value, baseUrl); } catch { return false; }
  if (!["https:", "http:"].includes(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  return SHARED_FILE_SEARCH_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`))
    || Boolean(sharedFileDestination(url.href));
}

export function hasSharedFileSearchResultText(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\p{Cf}/gu, "");
  // Parse the entire hostname so gofile.io.example.org cannot match gofile.io.
  for (const candidate of text.match(SHARED_FILE_SEARCH_URL_TEXT) || []) {
    if (sharedFileSearchTextDestination(candidate)) return true;
  }
  return SHARED_FILE_SEARCH_NAMES.test(text) || SHARED_FILE_SEARCH_CATEGORY.test(text);
}

export function isAdultMediaDestination(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    return ["http:", "https:"].includes(url.protocol)
      && (host === "erome.com" || host.endsWith(".erome.com")) && /^\/a\//u.test(url.pathname);
  } catch { return false; }
}

export function isExplicitLinkCollection(destinations: readonly string[], safeSearchEvidence: boolean): boolean {
  const files = [...new Set(destinations.map(value => sharedFileDestination(value)).filter((value): value is string => Boolean(value)))];
  // Neither cloud storage nor link density alone establishes adult content.
  return files.length >= 2 && (safeSearchEvidence || files.some(isAdultMediaDestination));
}
