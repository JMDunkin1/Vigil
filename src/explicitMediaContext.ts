// Shared by navigation/search guards and media-card inspection. Ambiguous
// markers contribute evidence only within a short local phrase.
// Keep the list limited to pornography labels and specific sexual-media
// phrases. Bare translations of "sexual", "adult", or "nude" are too broad.
export const MULTILINGUAL_EXPLICIT_TERMS = [
  "إباحي", "إباحية", "اباحي", "اباحية",
  "فيديو جنسي", "فيديوهات جنسية", "فيلم جنسي", "أفلام جنسية",
  "色情片", "色情视频", "色情視頻", "色情影片", "色情电影", "色情電影",
  "ポルノ", "포르노", "음란물", "порно", "порнография",
  "pornographie", "pornographique", "pornografía", "pornográfico", "pornográfica",
  "pornografia", "pornografie", "pornografisch"
] as const;
const MULTILINGUAL_UNSPACED_LABELS = MULTILINGUAL_EXPLICIT_TERMS.filter(term => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term));

export function containsMultilingualExplicitText(value: string): boolean {
  const text = String(value || "").normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff\u0640]/gu, "")
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu, "")
    .replace(/[أإآٱ]/gu, "ا")
    // Fold Latin accents without removing Japanese voicing marks or
    // decomposing Korean syllables. Both are meaningful letters here.
    .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""))
    .toLowerCase();
  if (/(?:^|[^\p{L}\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\p{L}\p{N}])/u.test(text)) return true;
  if (/(?:^|[^\p{L}\p{N}])(?:ال)?(?:فيديو(?:هات)?|فيلم|افلام)[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])/u.test(text)) return true;
  if (/(?:^|[^\p{L}\p{N}])(?:pornografi(?:a|co|ca)s?|pornographi(?:e|ques?)|pornografie|pornografisch(?:e[rmns]?)?|порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?|порнографи\p{Script=Cyrillic}*)(?=$|[^\p{L}\p{N}])/u.test(text)) return true;
  // Chinese/Japanese text and Korean grammatical suffixes do not reliably
  // delimit these labels with spaces. Use specific, unambiguous media terms.
  return MULTILINGUAL_UNSPACED_LABELS.some(term => text.includes(term));
}

export function containsContextualExplicitMedia(value: string): boolean {
  if (containsMultilingualExplicitText(value)) return true;
  const text = String(value || "").normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "").toLowerCase();
  if (/(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])/u.test(text)) return true;
  const tokens = text.replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie").match(/[\p{L}\p{N}]+/gu) || [];
  const marker = /^(?:adults?|spicy|creampies?|nudes?|naked|nudity|erotic|erotica|lewd|x+)$/u;
  // Marketing adjectives need a stronger nearby clue; "mature film" and
  // "uncensored interview" alone do not establish explicit content.
  const contributor = /^(?:mature|steamy|uncensored)$/u;
  const media = /^(?:videos?|vids?|movies?|films?|clips?|photos?|pics?|pictures?|documentar(?:y|ies)|compilations?)$/u;
  const ordinary = /^(?:recipes?|cooking|baking|food|desserts?|kitchen|chicken|sauce|peppers?|banana|chocolate|coconut|vanilla|pastry|education|educational|learning|classes|training|tutorials?|fitness)$/u;
  const bodyContext = /^(?:art|arts|drawing|paintings?|sculptures?|museum|exhibitions?|anatomy|medical|medicine|health|makeup|lipstick|palettes?|manicures?|nails?|skincare|cakes?)$/u;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!marker.test(tokens[index])) continue;
    // Both orders work; unrelated text elsewhere on a page supplies neither
    // evidence nor an exemption. Ordinary context only qualifies these weak
    // markers and cannot override existing explicit terms or X-rated labels.
    const nearby = tokens.slice(Math.max(0, index - 4), index + 5);
    if (/^x{1,2}$/u.test(tokens[index]) && nearby.some(token => /^(?:model|men|files|axis|chromosomes?)$/u.test(token))) continue;
    if (nearby.some(token => ordinary.test(token))) continue;
    if (/^(?:nudes?|naked|nudity|erotic|erotica|lewd)$/u.test(tokens[index]) && nearby.some(token => bodyContext.test(token))) continue;
    if (tokens[index] === "naked" && nearby.some(token => /^(?:eye|mole|rats?)$/u.test(token))) continue;
    if (nearby.some(token => media.test(token))) return true;
    if (nearby.some(token => token !== tokens[index] && (marker.test(token) || contributor.test(token)))) return true;
  }
  return false;
}
