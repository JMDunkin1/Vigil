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

// Explicit-media labels and services, rather than general anatomy, identities,
// relationship words or sexual-health vocabulary. Ambiguous words belong in
// the phrase matcher below and in verified SafeSearch evidence, never here.
export const ADDITIONAL_EXPLICIT_SEARCH_TERMS = [
  "pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos",
  "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes",
  "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate",
  "futanari", "ecchi"
] as const;

// Normalize known vocabulary, rather than fuzzy-matching arbitrary names or
// product IDs. Ordinary subjects retain their own accents and spellings.
export const EXPLICIT_VOCABULARY_REPLACEMENTS = [
  { pattern: /\b(?:nak3d|n4ked|n4k3d)\b/giu.source, replacement: "naked" },
  { pattern: /\b(?:nud3s?|nudez|nudz|n00dz|n00des|noodz)\b/giu.source, replacement: "nudes" },
  { pattern: /\b(?:ph0t0s|ph0tos|phot0s)\b/giu.source, replacement: "photos" },
  { pattern: /\bn[\s_.-]+a[\s_.-]+k[\s_.-]+e[\s_.-]+d\b/giu.source, replacement: "naked" },
  { pattern: /\bn[\s_.-]+u[\s_.-]+d[\s_.-]+e(?:[\s_.-]+s)?\b/giu.source, replacement: "nudes" },
  { pattern: /\bp[\s_.-]+[o0][\s_.-]+r[\s_.-]+n\b/giu.source, replacement: "porn" },
  { pattern: /\b(naked|nudes?|topless|bottomless|adult|sex)(girls?|boys?|women|woman|men|males?|females?|models?|videos?|vids?|photos?|pics?|images?)\b/giu.source, replacement: "$1 $2" }
] as const;

// Each exception consumes only the established nonsexual phrase. Adding an
// unrelated word to a nude-person query therefore cannot excuse that query,
// and a separate explicit phrase remains visible to the matcher.
export const EXPLICIT_MEDIA_ORDINARY_PHRASES = [
  /\bnaked[\s_-]+(?:eyes?|mole[\s_-]+rats?|neck[\s_-]+chickens?|singularit(?:y|ies)|dna|seeds?|calls?|puts?|short[\s_-]+(?:selling|positions?)|stocks?|options?|economics|wires?|cables?|roofs?|trucks?|cakes?|burrito(?:[\s_-]+bowls?)?)\b/giu.source,
  /\b(?:bare[\s_-]+naked[\s_-]+ladies|barenaked[\s_-]+ladies|naked[\s_-]+(?:gun|truth|lunch|brothers[\s_-]+band|king|snake|cowboy|chef))\b/giu.source,
  /\b(?:nude[\s_-]+descending[\s_-]+(?:a[\s_-]+)?staircase|(?:the[\s_-]+)?naked[\s_-]+maja|blue[\s_-]+nude[\s_-]+matisse)\b/giu.source,
  /\bnude[\s_-]+(?:sculptures?|statues?|figure[\s_-]+drawings?|lipsticks?|makeup|nail[\s_-]+polish|nails?|palettes?|manicures?|beige[\s_-]+swatches?|(?:colou?red[\s_-]+)?(?:shoes?|heels?|dresses?|clothing|outfits?|fabrics?|shades?|colou?rs?))\b/giu.source,
  /\b(?:see[\s_-]+through|seethrough)[\s_-]+(?:glass|windows?|fabrics?|curtains?|materials?)\b/giu.source,
  /\b(?:topless[\s_-]+trucks?|bottomless[\s_-]+(?:coffee|mimosas?|brunch|pits?))\b/giu.source,
  /\bstripping[\s_-]+(?:paint|wallpaper|furniture|wood|floors?|ions?|bond[\s_-]+coupons?|thyme[\s_-]+leaves)\b/giu.source,
  /\b(?:boston[\s_-]+cream[\s_-]+pies?|cream[\s_-]+pies?[\s_-]+baker(?:y|ies)|cum[\s_-]+laude)\b/giu.source,
  /\b(?:blue|great|coal|crested|marsh|willow|bearded|long[\s_-]+tailed)[\s_-]+tits?\b/giu.source,
  /\b(?:tits?[\s_-]+bird[\s_-]+species|boobies[\s_-]+galapagos[\s_-]+birds?|(?:blue[\s_-]+footed|red[\s_-]+footed|brown|masked|nazca)[\s_-]+boobies|cock[\s_-]+(?:pheasants?|sparrows?|roosters?|robins?)|wild[\s_-]+asses|pussy[\s_-]+willows?)\b/giu.source,
  /\b(?:horny[\s_-]+(?:toads?|goat[\s_-]+weed)|adult[\s_-]+(?:butterflies|birds?|fish|animals?|insects?))\b/giu.source,
  /\b(?:oral[\s_-]+(?:thrush|feeding|arguments?|presentations?|exams?|hygiene|fixation[\s_-]+shakira)|(?:assisted[\s_-]+)?oral[\s_-]+feeding|anal[\s_-]+fistulas?)\b/giu.source,
  /\b(?:sex[\s_-]+(?:education|determination|differences|changing|chromosomes?)|sexual[\s_-]+(?:health|reproduction|dimorphism|selection|orientation|harassment|assault)|same[\s_-]+sex|opposite[\s_-]+sex)\b/giu.source,
  /\b(?:breast[\s_-]+(?:reconstruction|feeding|tissue[\s_-]+histology)|buttocks[\s_-]+stretching|feet[\s_-]+pain|thighs?[\s_-]+exercises?|cleavage[\s_-]+(?:crystal|mineral))\b/giu.source,
  /\b(?:sex[\s_-]+pistols|dick[\s_-]+(?:van[\s_-]+dyke|tracy|clark)|moby[\s_-]+dick|hot[\s_-]+money|penetration[\s_-]+(?:pricing|testing|tests?))\b/giu.source,
  /\b(?:fingering[\s_-]+(?:guitar|piano|music)|(?:guitar|piano)[\s_-]+fingering|strip[\s_-]+tease[\s_-]+rose(?=[\s_-]+(?:growing|garden|plant)))\b/giu.source,
  /\bleak(?:s|ed)?[\s_-]+(?:(?:pentagon|government|classified|court|source)[\s_-]+)?(?:documents?|data|databases?|passwords?|code|pipes?|aquariums?|gardening)\b/giu.source
] as const;
const vocabularyReplacements = EXPLICIT_VOCABULARY_REPLACEMENTS.map(({ pattern, replacement }) => ({ pattern: new RegExp(pattern, "giu"), replacement }));
const ordinaryPhrasePatterns = EXPLICIT_MEDIA_ORDINARY_PHRASES.map(pattern => new RegExp(pattern, "giu"));
const explicitHomoglyphs: Record<string, string> = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "Α": "A" };

export function normalizeExplicitVocabulary(value: string): string {
  let text = String(value || "").normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "")
    .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""));
  text = text.replace(/[\p{L}\p{N}]+/gu, token => {
    const folded = token.replace(/[аеорсхіуΑ]/gu, letter => explicitHomoglyphs[letter]).toLowerCase();
    return /^(?:naked|nudes?|porn|porno|nsfw|sex|sexual|topless|nakedgirls|nudegirls)$/u.test(folded) ? folded : token;
  });
  for (const { pattern, replacement } of vocabularyReplacements) text = text.replace(pattern, replacement);
  return text;
}

export function normalizeExplicitMediaText(value: string): string {
  let text = normalizeExplicitVocabulary(value);
  for (const pattern of ordinaryPhrasePatterns) text = text.replace(pattern, " vigilordinary ");
  return text;
}

export const EXPLICIT_SEARCH_ALIAS_PATTERNS = [
  /^\s*(?:nud(?:s|3s?)?|nudes)\s*$/iu.source,
  /(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.source
] as const;
export function containsExplicitSearchAliases(value: string): boolean {
  const text = normalizeExplicitVocabulary(value);
  return EXPLICIT_SEARCH_ALIAS_PATTERNS.some(pattern => new RegExp(pattern, "iu").test(text));
}

// Sources also generate the native phone matcher. All evidence and exceptions
// are bounded to four words either side; an unrelated paragraph cannot supply
// a sexual clue or cancel a separate explicit phrase.
export const EXPLICIT_MEDIA_PATTERNS = {
  exposure: /^(?:nud|nuds|nudes?|nued|nudity|naked|nakedness|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|fullfrontal|seethrough|upskirt|downblouse|nipslips?|cameltoe)$/u.source,
  sexual: /^(?:erotic|erotica|lewd|horny|sensual|seductive|sex|sexual|sexually|raunchy|salacious|lustful|lascivious|risque|risqué|sultry|racy|titillating|arousing|aroused|fetish|fetishes|kinky|kink|bdsm|bondage)$/u.source,
  acts: /^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|ejaculation|fingering|selfpleasure|creampies?|bukkake|gangbangs?|threesomes?|orgies|orgy|masturbation|masturbating|fucking|penetration|anal|oral|doggystyle|pegging|squirting|sexting)$/u.source,
  strongActs: /^(?:blowjobs?|handjobs?|cumshots?|cum|cumming|bukkake|gangbangs?|fucking|selfpleasure|upskirt|downblouse|nipslips?|cameltoe)$/u.source,
  connectors: /^(?:a|an|the|of|with|who|that|are|is|were|was|be|being|their|very|really|absolutely|totally|completely|fully|amazingly|beautiful|gorgeous|amazing|pretty|lovely)$/u.source,
  body: /^(?:boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?)$/u.source,
  people: /^(?:girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?)$/u.source,
  media: /^(?:videos?|vids?|movies?|films?|clips?|photos?|pics?|pictures?|images?|gifs?|galler(?:y|ies)|albums?|wallpapers?|footage|streams?|livestreams?|webcams?|compilations?|documentar(?:y|ies)|animations?|animated|illustrations?|comics?|manga|hentai|audios?)$/u.source,
  marketing: /^(?:adults?|spicy|mature|steamy|uncensored|unfiltered|uncut|explicit|revealing|suggestive|provocative|teasing|tease|thirst|thirsttraps?|nsfl)$/u.source,
  ordinary: /^(?:recipes?|cooking|baking|food|desserts?|kitchen|chicken|sauce|peppers?|banana|chocolate|coconut|vanilla|pastry|education|educational|learning|classes|training|tutorials?|fitness|medical|medicine|health|anatomy|clinical|diagnosis|symptoms?|treatment|cancer|screening|mammography|reconstruction|surgery|histology|breastfeeding|lactation|consent|prevention|safety|research|scientific|biology|orientation|identity|identities|gender|genders|equality|rights|discrimination|harassment|assault|abuse|violence|victims?|survivors?|legal|laws?)$/u.source,
  relationship: /^(?:same|opposite|biological|assigned)$/u.source,
  bodyContext: /^(?:art|arts|drawing|paintings?|sculptures?|museum|exhibitions?|makeup|lipstick|palettes?|manicures?|nails?|skincare|cakes?|dresses?|clothing|outfits?|fabric|fabrics|shades?|colors?|colours?)$/u.source,
  ordinaryBody: /^(?:presentations?|exams?|examinations?|hygiene|dentists?|dental|languages?|history|historical|measurement|measurements|inches|inch|meters?|metres?|conversion|convert|shoes?|socks?|walking|running|birds?|roosters?|cats?|kittens?|donkeys?|moby|dyke|dickens|mountains?|sailing|storms?)$/u.source,
  ambiguousBody: /^(?:oral|anal|penetration|bondage|feet|soles|thighs?|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies)$/u.source,
  nonsexualExposure: /^(?:eye|eyes|mole|rats?|roof|roofs|paint|wallpaper|wire|wires|cable|cables|furniture|wood|floor|floors|truck|trucks|pit|pits|coffee|portafilter|stocks?|options?|probability)$/u.source
} as const;
const explicitMediaPatterns = Object.fromEntries(Object.entries(EXPLICIT_MEDIA_PATTERNS)
  .map(([name, source]) => [name, new RegExp(source, "u")])) as Record<keyof typeof EXPLICIT_MEDIA_PATTERNS, RegExp>;

export function containsAdditionalExplicitSearchTerm(value: string): boolean {
  const tokens = normalizeExplicitVocabulary(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.some(token => ["porn", "porno", "nsfw", ...ADDITIONAL_EXPLICIT_SEARCH_TERMS].includes(token));
}

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
  if (containsAdditionalExplicitSearchTerm(value)) return true;
  const text = normalizeExplicitMediaText(value).toLowerCase();
  if (/(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])/u.test(text)) return true;
  const tokens = text.replace(/\b(?:without(?:[\s_-]+any)?|with[\s_-]+no)[\s_-]+clothes\b/gu, "naked")
    .replace(/\b(?:wearing[\s_-]+nothing|(?:in[\s_-]+(?:the|their|a)[\s_-]+)?birthday[\s_-]+suits?|in[\s_-]+the[\s_-]+buff)\b/gu, "naked")
    .replace(/\b(?:pleasur(?:ing|e)[\s_-]+(?:myself|herself|himself|themselves)|playing[\s_-]+with[\s_-]+(?:myself|herself|himself|themselves)|self[\s_-]+pleasure)\b/gu, "selfpleasure")
    .replace(/\bup[\s_-]+skirt\b/gu, "upskirt").replace(/\bdown[\s_-]+blouse\b/gu, "downblouse")
    .replace(/\bstrip[\s_-]+tease\b/gu, "striptease").replace(/\bnip[\s_-]+slips?\b/gu, "nipslip")
    .replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie")
    .replace(/\bfull[\s_\p{Pd}]+frontal\b/gu, "fullfrontal")
    .replace(/\bsee[\s_\p{Pd}]+through\b/gu, "seethrough").match(/[\p{L}\p{N}]+/gu) || [];
  const { exposure, sexual, acts, strongActs, connectors, body, people, media, marketing, ordinary, relationship, bodyContext, ordinaryBody, ambiguousBody, nonsexualExposure } = explicitMediaPatterns;
  const marker = /^(?:adults?|spicy|creampies?|nudes?|naked|nudity|erotic|erotica|lewd|x+)$/u;
  // Marketing adjectives need a stronger nearby clue; "mature film" and
  // "uncensored interview" alone do not establish explicit content.
  const contributor = /^(?:mature|steamy|uncensored)$/u;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const directPerson = [1, -1].some(direction => {
      for (let offset = 1; offset <= 12; offset += 1) {
        const adjacent = tokens[index + direction * offset];
        if (!adjacent) return false;
        if (people.test(adjacent)) return true;
        if (!connectors.test(adjacent)) return false;
      }
      return false;
    });
    if ((exposure.test(token) || token === "bare") && directPerson) return true;
    if (!(marker.test(token) || exposure.test(token) || sexual.test(token) || acts.test(token)
      || body.test(token) || marketing.test(token) || /^(?:sexy|hot)$/u.test(token))) continue;
    // Both orders work; unrelated text elsewhere on a page supplies neither
    // evidence nor an exemption. Ordinary context only qualifies these weak
    // markers and cannot override existing explicit terms or X-rated labels.
    const nearby = tokens.slice(Math.max(0, index - 4), index + 5);
    if (strongActs.test(token) && nearby.some(word => media.test(word) || people.test(word))) return true;
    if (/^x{1,2}$/u.test(tokens[index]) && nearby.some(token => /^(?:model|men|files|axis|chromosomes?)$/u.test(token))) continue;
    if (nearby.some(token => ordinary.test(token))) continue;
    if (token === "sex" && nearby.some(word => relationship.test(word))) continue;
    if (ambiguousBody.test(token) && nearby.some(word => ordinaryBody.test(word))) continue;
    if ((exposure.test(token) || sexual.test(token) || body.test(token) || /^(?:sexy|hot)$/u.test(token))
      && nearby.some(word => bodyContext.test(word))) continue;
    if (exposure.test(token) && nearby.some(word => nonsexualExposure.test(word))) continue;
    const others = nearby.filter((_word, offset) => Math.max(0, index - 4) + offset !== index);
    // Hot is too broad for generic media (weather, music, food). Sexy clothing
    // and isolated anatomy or fetish terms likewise need a qualifying phrase.
    if (/^(?:sexy|hot)$/u.test(token)) {
      if (others.some(word => people.test(word))) return true;
      continue;
    }
    if (exposure.test(token) || sexual.test(token) || acts.test(token)) {
      if (others.some(word => media.test(word) || people.test(word) || body.test(word)
        || exposure.test(word) || sexual.test(word) || acts.test(word) || marketing.test(word))) return true;
    }
    if (body.test(token) && others.some(word => media.test(word) || exposure.test(word) || sexual.test(word))) return true;
    if (marker.test(token) && others.some(word => media.test(word) || marker.test(word) || contributor.test(word))) return true;
    if (marketing.test(token) && others.some(word => exposure.test(word) || sexual.test(word) || acts.test(word))) return true;
  }
  return false;
}
