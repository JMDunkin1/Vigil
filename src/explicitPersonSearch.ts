import { normalizeExplicitMediaText } from "./explicitMediaContext.js";
import { searchQueries } from "./searchQueryContext.js";

export const EXPLICIT_PERSON_SEARCH_RULE_ID = "person-intimate-exposure";
const EXPOSURE_MARKERS = new Set([
  "leak", "leaks", "leaked", "leakd", "lek", "leks",
  "nud", "nuds", "nude", "nudes", "nued", "naked", "topless"
]);
const INTIMATE_CONTEXT = new Set([
  "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
  "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
]);

// These words make a short, name-shaped query substantially more likely to be
// about technology, infrastructure, current events, entertainment, or sports.
// Keep the list conservative: it is only a false-positive guard, not a list of
// content that Vigil permits.
const LEAK_CONTEXT = new Set([
  "air", "api", "app", "apps", "classified", "code", "command", "court",
  "data", "database", "document", "documents", "email", "emails", "episode",
  "episodes", "fc", "film", "films", "game", "games", "gas", "government",
  "guide", "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
  "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
  "products", "release", "releases", "report", "reports", "roof", "roster",
  "rumor", "rumors", "samsung", "security", "software", "source", "sources",
  "spec", "specs", "team", "transfer", "transfers", "tutorial", "tv", "water"
]);
const NUDE_CONTEXT = new Set([
  "eye", "eyes", "cake", "cakes",
  "truck", "trucks", "coffee", "paint", "roof", "roofs", "wire", "wires", "cable", "cables",
  "stock", "stocks", "option", "options", "selling", "finance", "financial", "health", "education",
  "anatomy", "animal", "animals", "art", "arts", "artwork", "artworks", "beach", "beaches",
  "beige", "color", "colors", "colour", "colours", "drawing", "drawings", "fabric", "fashion",
  "figure", "figures", "lipstick", "makeup", "medical", "mice", "model", "models", "mole",
  "mouse", "museum", "museums", "painting", "paintings", "palette", "photography", "rat", "rats",
  "reference", "references", "sculpture", "sculptures", "shade", "shades", "statue", "statues",
  "studies", "study"
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
  for (const { query } of searchQueries(value)) {
    const match = matchExplicitPersonSearchText(query);
    if (match) return match;
  }
  return null;
}

export function matchExplicitPersonSearchText(value: unknown): ExplicitPersonSearchMatch | null {
  const query = normalizeExplicitMediaText(decodeNested(String(value || "")).replace(/\+/gu, " "));
  const tokens = wordTokens(query);
  if (tokens.length < 2) return null;
  const normalized = tokens.map((token) => token.toLocaleLowerCase("en-US"));
  const markerIndex = normalized.findIndex((token) => EXPOSURE_MARKERS.has(token));
  if (markerIndex < 0) return null;
  const marker = normalized[markerIndex];
  const ordinaryContext = isLeakMarker(marker) ? LEAK_CONTEXT : NUDE_CONTEXT;

  if (normalized.some((token, index) => index !== markerIndex && INTIMATE_CONTEXT.has(token))) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }
  // These established phrases describe vision and baking. Another intimate
  // marker above still takes precedence over the ordinary phrase.
  if (marker === "naked" && /(?:^|[^\p{L}\p{N}])naked[\s_-]+(?:eye|cakes?)(?=$|[^\p{L}\p{N}])/iu.test(query)) return null;

  const possibleNameTokens = tokens.filter((_token, index) => (
    index !== markerIndex
      && !NAME_FILLER_WORDS.has(normalized[index])
      && !ordinaryContext.has(normalized[index])
  ));
  if (possibleNameTokens.length >= 2 && possibleNameTokens.some(startsWithUppercaseLetter)) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }

  // Preserve protection when a user enters a lowercase name. The deliberately
  // narrow shape covers "first last leaks" and "nude first last" while the
  // context exclusions above keep ordinary broad uses of "leaks" available.
  if (normalized.some((token) => ordinaryContext.has(token))) return null;
  const structuralName = normalized.filter((token, index) => (
    index !== markerIndex && !NAME_FILLER_WORDS.has(token)
  ));
  if (structuralName.length >= 2 && structuralName.length <= 4
      && structuralName.every(isNameWord)) {
    return { marker, query, ruleId: EXPLICIT_PERSON_SEARCH_RULE_ID };
  }
  return null;
}

function isLeakMarker(value: string): boolean {
  return ["leak", "leaks", "leaked", "leakd", "lek", "leks"].includes(value);
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
