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
  return safeSearchWords(value).some(word => SAFE_SEARCH_CONTRIBUTORS.test(normalizeExplicitVocabulary(word)));
}

export function hasOrdinarySafeSearchContext(value: string): boolean {
  return SAFE_SEARCH_ORDINARY_CONTEXT.test(safeSearchWords(value).map(word => normalizeExplicitVocabulary(word)).join(" "));
}

// Cache exact subjects rather than carrying an unsafe flag to an unrelated
// search. Strip only media/navigation qualifiers, never part of a person's name.
export function safeSearchSubject(value: string): string {
  if (hasOrdinarySafeSearchContext(value)) return "";
  const withoutSites = value.replace(/\bsite:\S+/giu, "");
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
  if (onHost("drive.google.com") && /^\/(?:file\/d|drive\/folders)\//u.test(url.pathname)) return url.href;
  if (onHost("dropbox.com") && /^\/(?:s|sh|scl)\//u.test(url.pathname)) return url.href;
  if (["pixl.li", "cyberdrop.me", "cyberdrop.to", "bunkr.is", "bunkr.si", "bunkr.ru", "erome.com"].some(onHost)
    && /^\/(?:a|album|f|v)\//u.test(url.pathname)) return url.href;
  return null;
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
