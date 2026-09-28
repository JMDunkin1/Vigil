// Shared by navigation/search guards and media-card inspection. Ambiguous
// markers contribute evidence only within a short local phrase.
export function containsContextualExplicitMedia(value: string): boolean {
  const text = value.normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/gu, "").toLowerCase();
  if (/(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])/u.test(text)) return true;
  const tokens = text.replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie").match(/[\p{L}\p{N}]+/gu) || [];
  const marker = /^(?:adults?|spicy|creampies?|x+)$/u;
  const media = /^(?:videos?|vids?|movies?|films?|clips?|photos?|pics?|pictures?|documentar(?:y|ies)|compilations?)$/u;
  const ordinary = /^(?:recipes?|cooking|baking|food|desserts?|kitchen|chicken|sauce|peppers?|banana|chocolate|coconut|vanilla|pastry|education|educational|learning|classes|training|tutorials?|fitness)$/u;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!marker.test(tokens[index])) continue;
    // Both orders work; unrelated text elsewhere on a page supplies neither
    // evidence nor an exemption. Ordinary context only qualifies these weak
    // markers and cannot override existing explicit terms or X-rated labels.
    const nearby = tokens.slice(Math.max(0, index - 4), index + 5);
    if (/^x{1,2}$/u.test(tokens[index]) && nearby.some(token => /^(?:model|men|files|axis|chromosomes?)$/u.test(token))) continue;
    if (nearby.some(token => ordinary.test(token))) continue;
    if (nearby.some(token => media.test(token))) return true;
    if (nearby.some(token => token !== tokens[index] && marker.test(token))) return true;
  }
  return false;
}
