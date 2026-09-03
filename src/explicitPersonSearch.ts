export const EXPLICIT_PERSON_SEARCH_RULE_ID = "person-intimate-exposure";

const SEARCH_PARAMETER_NAMES = new Set([
  "q", "query", "search_query", "search", "searchterm", "search_term",
  "keyword", "keywords", "term", "text", "p", "k", "s", "wd"
]);

const SEARCH_ROUTE_PATTERN = /(?:^|[/#])(?:advancedsearch(?:\.php)?|search(?:\.php)?|results?|find|browse)(?:[/?.#]|$)/iu;
const EXPOSURE_MARKERS = new Set(["leak", "leaks", "leaked", "nude", "nudes", "naked", "topless"]);
const INTIMATE_CONTEXT = new Set([
  "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
  "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
]);

// These words make a short, name-shaped query substantially more likely to be
// about technology, infrastructure, current events, entertainment, or sports.
// Keep the list conservative: it is only a false-positive guard, not a list of
// content that Vigil permits.
const NON_PERSON_CONTEXT = new Set([
  "air", "album", "api", "app", "apps", "classified", "code", "color", "court",
  "data", "database", "document", "documents", "email", "emails", "episode",
  "episodes", "fc", "film", "films", "game", "games", "gas", "government",
  "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
  "palette", "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
  "products", "release", "releases", "report", "reports", "roof", "roster",
  "rumor", "rumors", "samsung", "security", "software", "source", "sources",
  "spec", "specs", "team", "transfer", "transfers", "tv", "water"
]);

const NAME_FILLER_WORDS = new Set([
  "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"
]);

export interface ExplicitPersonSearchMatch {
  marker: string;
  query: string;
  ruleId: typeof EXPLICIT_PERSON_SEARCH_RULE_ID;
}

/**
 * Finds search text that combines an intimate-exposure marker with a likely
 * person's name. Broad words such as "leaks" are never sufficient by
 * themselves, which preserves ordinary technical, repair, news, and product
 * searches.
 */
export function matchExplicitPersonSearchUrl(value: unknown): ExplicitPersonSearchMatch | null {
  let url: URL;
  try {
    url = new URL(String(value || ""));
    if (!["http:", "https:"].includes(url.protocol)) return null;
  } catch {
    return null;
  }

  const candidates = [...url.searchParams]
    .filter(([name]) => SEARCH_PARAMETER_NAMES.has(name.toLowerCase()))
    .map(([, query]) => query);
  const path = decodeNested(url.pathname);
  const hash = decodeNested(url.hash.replace(/^#/u, ""));
  if (SEARCH_ROUTE_PATTERN.test(path)) candidates.push(path);
  if (SEARCH_ROUTE_PATTERN.test(hash)) candidates.push(hash);

  for (const query of candidates) {
    const match = matchExplicitPersonSearchText(query);
    if (match) return match;
  }
  return null;
}

export function matchExplicitPersonSearchText(value: unknown): ExplicitPersonSearchMatch | null {
  const query = decodeNested(String(value || "")).replace(/\+/gu, " ").normalize("NFKC");
  const tokens = wordTokens(query);
  if (tokens.length < 2) return null;
  const normalized = tokens.map((token) => token.toLocaleLowerCase("en-US"));
  const markerIndex = normalized.findIndex((token) => EXPOSURE_MARKERS.has(token));
  if (markerIndex < 0) return null;
  const marker = normalized[markerIndex];

  if (normalized.some((token, index) => index !== markerIndex && INTIMATE_CONTEXT.has(token))) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }

  const possibleNameTokens = tokens.filter((_token, index) => (
    index !== markerIndex
      && !NAME_FILLER_WORDS.has(normalized[index])
      && !NON_PERSON_CONTEXT.has(normalized[index])
  ));
  if (possibleNameTokens.length >= 2 && possibleNameTokens.some(startsWithUppercaseLetter)
      && !normalized.some((token) => NON_PERSON_CONTEXT.has(token))) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }

  // Preserve protection when a user enters a lowercase name. The deliberately
  // narrow shape covers "first last leaks" and "nude first last" while the
  // context exclusions above keep ordinary broad uses of "leaks" available.
  const nameSide = markerIndex === tokens.length - 1
    ? normalized.slice(0, markerIndex)
    : markerIndex === 0
      ? normalized.slice(1)
      : [];
  const structuralName = nameSide.filter((token) => !NAME_FILLER_WORDS.has(token));
  if (structuralName.length >= 2 && structuralName.length <= 4
      && structuralName.every((token) => isNameWord(token) && !NON_PERSON_CONTEXT.has(token))) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }
  return null;
}

function wordTokens(value: string): string[] {
  return value.match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)
    ?.map((token) => token.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, ""))
    .filter(Boolean) || [];
}

function startsWithUppercaseLetter(value: string): boolean {
  const first = value.match(/[\p{L}]/u)?.[0] || "";
  return Boolean(first && first === first.toLocaleUpperCase("en-US") && first !== first.toLocaleLowerCase("en-US"));
}

function isNameWord(value: string): boolean {
  return value.length >= 2 && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(value);
}

function decodeNested(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}
