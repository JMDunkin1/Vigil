export const DEFAULT_EXPLICIT_COMIC_SITE_TERMS = [
  "honeytoon", "honeytoons", "hooneytoon", "hooneytoons", "mawha"
];

export interface ExplicitContextualRule {
  id: string;
  contexts: readonly string[];
  markers: readonly string[];
}

// These markers require a comic context, so "uncensored interview" and
// "mature gardening" remain ordinary searches.
export const DEFAULT_EXPLICIT_CONTEXTUAL_RULES: readonly ExplicitContextualRule[] = [
  {
    id: "explicit-comics",
    contexts: ["comic", "comics", "manga", "manhwa", "mawha", "manhua", "webtoon", "webtoons", "doujin", "doujinshi"],
    markers: ["18", "18plus", "r18", "adult", "nsfw", "porn", "hentai", "lewd", "mature", "uncensored", "smut", "ecchi", "erotic", "erotica", "explicit"]
  }
];

export function containsExplicitComicSearch(value: string): boolean {
  const text = value.toLowerCase();
  // manhwa and toongod already belong to every profile's permanent URL rules.
  if ([...DEFAULT_EXPLICIT_COMIC_SITE_TERMS, "manhwa", "toongod"].some(term => text.includes(term))) return true;
  const compact = text.replace(/[^\p{L}\p{N}]/gu, "");
  return DEFAULT_EXPLICIT_CONTEXTUAL_RULES.some(rule => rule.contexts.some(context =>
    rule.markers.some(marker => compact.includes(context + marker) || compact.includes(marker + context))
  ));
}
