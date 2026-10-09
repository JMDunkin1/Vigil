// SafeSearch being enabled is universal in Vigil. Only a notice about results
// actually removed for this query supplies additional classification evidence.
export function isSafeSearchLimitedNotice(value: string): boolean {
  const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (text.length > 600) return false;
  return /\b(?:explicit|some|search) results (?:have been |were |are )?(?:filtered|limited|removed|hidden|blurred) (?:with|by|due to) safe\s?search\b/iu.test(text)
    || /\bresults (?:have been |were |are )?(?:filtered|limited|removed|hidden|blurred) (?:with|by|due to) safe\s?search\b/iu.test(text)
    || /\bsafe\s?search (?:has |have )?(?:filtered|limited|removed|hidden|blurred) (?:some |explicit |search )?results\b/iu.test(text);
}

// These already-ambiguous media, exposure and search markers do not become
// standalone bans. A real limited-results notice supplies the missing context.
const SAFE_SEARCH_CONTRIBUTORS = /^(?:photos?|pics?|pictures?|images?|videos?|vids?|movies?|films?|clips?|documentar(?:y|ies)|compilations?|albums?|galler(?:y|ies)|collections?|links?|downloads?|folders?|files?|packs?|mirrors?|adults?|mature|steamy|spicy|uncensored|nud|nuds|nude|nudes|nued|nudity|naked|topless|erotic|erotica|lewd|fetish|sex|sexual|explicit|sensitive|intimate|leak|leaks|leaked|leakd|lek|leks|creampies?|x+|18|18g|r18g?|unreviewed|成人|成人向|成人向け|mega|gofile|pixl|cyberdrop|bunkr)$/u;
const SAFE_SEARCH_ORDINARY_CONTEXT = /\b(?:news|biograph(?:y|ies)|interviews?|journalism|research|education|educational|medical|medicine|anatomy|health|history|historical|science|museum|art|drawing|painting|sculpture|makeup|lipstick|recipes?|cooking|baking|chicken|peppers?|software|source code|documentation|security|tutorials?)\b/u;

function safeSearchWords(value: string): string[] {
  let text = String(value || "");
  for (let pass = 0; pass < 3; pass += 1) {
    try { const decoded = decodeURIComponent(text); if (decoded === text) break; text = decoded; }
    catch { break; }
  }
  return text.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "").toLowerCase()
    .replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie").match(/[\p{L}\p{N}]+/gu) || [];
}

export function hasSafeSearchContributor(value: string): boolean {
  const words = safeSearchWords(value);
  return words.some(word => SAFE_SEARCH_CONTRIBUTORS.test(word));
}

export function hasOrdinarySafeSearchContext(value: string): boolean {
  return SAFE_SEARCH_ORDINARY_CONTEXT.test(safeSearchWords(value).join(" "));
}

// Cache exact subjects rather than carrying an unsafe flag to an unrelated
// search. Strip only media/navigation qualifiers, never part of a person's name.
export function safeSearchSubject(value: string): string {
  if (SAFE_SEARCH_ORDINARY_CONTEXT.test(safeSearchWords(value).join(" "))) return "";
  const withoutSites = value.replace(/\bsite:\S+/giu, "");
  const words = safeSearchWords(withoutSites).filter(word => !SAFE_SEARCH_CONTRIBUTORS.test(word)
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
