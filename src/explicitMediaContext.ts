// Shared by navigation/search guards and media-card inspection. Ambiguous
// markers contribute evidence only within a short local phrase.
// Keep the list limited to pornography labels and specific sexual-media
// phrases. Bare translations of "sexual", "adult", or "nude" are too broad.
export const MULTILINGUAL_ADULT_PRODUCT_TERMS = [
  "性爱娃娃", "性愛娃娃", "情趣娃娃", "性玩具", "ラブドール", "セックスドール"
] as const;
export const MULTILINGUAL_EXPLICIT_TERMS = [
  "إباحي", "إباحية", "اباحي", "اباحية",
  "فيديو جنسي", "فيديوهات جنسية", "فيلم جنسي", "أفلام جنسية",
  "色情片", "色情视频", "色情視頻", "色情影片", "色情电影", "色情電影",
  ...MULTILINGUAL_ADULT_PRODUCT_TERMS,
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
  // Verified adult comic brands also occur in search/discovery pages and mirrors.
  "toonily", "omegascans", "manhwabuddy", "mangadna", "manghaha", "mangaforfree", "manhwaclub", "webtoonscan", "pornhwa",
  // Include reported readers and distinctive brands from the reviewed whole-site
  // inventory so app listings, alternatives, and new mirrors are also covered.
  // Ambiguous names such as Manta and INKR stay domain-only.
  "qtoon", "comicle", "mangabuddy", "mangameow", "mangaball", "kuramanga", "comizy",
  "nyrascans", "mangavyvy", "hiperdex", "tappytoon", "toomics", "lezhin", "lezhinus", "lezhinx",
  "daycomics", "toptoon", "coolmic", "mangaplaza", "ebookrenta", "webcomicsapp", "lalatoon",
  "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls",
  "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"
] as const;

// Normalize known vocabulary, rather than fuzzy-matching arbitrary names or
// product IDs. Ordinary subjects retain their own accents and spellings.
export const EXPLICIT_VOCABULARY_REPLACEMENTS = [
  { pattern: /(?:^|[^\p{L}\p{N}])q[\s_.\p{Pd}]+toon(?=$|[^\p{L}\p{N}])/giu.source, replacement: " qtoon " },
  { pattern: /(?:^|[^\p{L}\p{N}])(?:omega[\s_.\p{Pd}]+scans)(?=$|[^\p{L}\p{N}])/giu.source, replacement: " omegascans " },
  { pattern: /(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+dna(?=$|[^\p{L}\p{N}])/giu.source, replacement: " mangadna " },
  { pattern: /(?:^|[^\p{L}\p{N}])manga[\s_.\p{Pd}]+for[\s_.\p{Pd}]+free(?=$|[^\p{L}\p{N}])/giu.source, replacement: " mangaforfree " },
  { pattern: /(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+buddy(?=$|[^\p{L}\p{N}])/giu.source, replacement: " manhwabuddy " },
  { pattern: /(?:^|[^\p{L}\p{N}])manhwa[\s_.\p{Pd}]+club(?=$|[^\p{L}\p{N}])/giu.source, replacement: " manhwaclub " },
  // Product labels also occur on ordinary marketplaces. Match the specific
  // adult product, never bare silicone, dolls, toys, or reborn collectibles.
  { pattern: /\b(?:sex|love)[\s_\p{Pd}]+(?:(?:silicone|tpe|realistic|lifelike|full[\s_\p{Pd}]+body)[\s_\p{Pd}]+){0,3}dolls?\b/giu.source, replacement: "sexdoll" },
  { pattern: /\bsex[\s_\p{Pd}]+robots?\b/giu.source, replacement: "sexrobot" },
  { pattern: /\bsex[\s_\p{Pd}]+toys?\b/giu.source, replacement: "sextoy" },
  // Marketplace titles often attach a marketing label directly to a print size.
  { pattern: /\b(sexy|lingerie|mature)(?=\d{1,2}[x×]\d{1,2}\b)/giu.source, replacement: "$1 " },
  { pattern: /\b(?:bare|exposed|uncovered)[\s_-]+(?:breasts?|nipples?|genitals?)\b/giu.source, replacement: "nude" },
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
const explicitHomoglyphs: Record<string, string> = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "α": "a" };

export function normalizeExplicitVocabulary(value: string): string {
  let text = String(value || "").normalize("NFKC")
    .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "")
    .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""));
  text = text.replace(/[\p{L}\p{N}]+/gu, token => {
    const folded = token.toLowerCase().replace(/[аеорсхіуα]/gu, letter => explicitHomoglyphs[letter]);
    return /^(?:naked|nudes?|porn|porno|nsfw|sex|sexual|topless|nakedgirls|nudegirls)$/u.test(folded)
      || explicitSearchKeywordTerms.has(folded) || explicitSearchCompoundPattern.test(folded) ? folded : token;
  });
  for (const { pattern, replacement } of vocabularyReplacements) text = text.replace(pattern, replacement);
  return text;
}

export function normalizeExplicitMediaText(value: string): string {
  let text = normalizeExplicitVocabulary(value);
  for (const pattern of ordinaryPhrasePatterns) text = text.replace(pattern, " vigilordinary ");
  return text;
}

// Qualify only an established ordinary phrase, never a whole query. For
// example, a separate "porn videos" clause survives "pornography blocker".
export const EXPLICIT_AUTOMATIC_ORDINARY_PHRASES = [
  /\b(?:nissan|skyline|gt[\s_-]?r)[\s_-]+r[\s_-]?34\b/giu.source,
  /\br[\s_-]?34[\s_-]+(?:nissan|skyline|gt[\s_-]?r)\b/giu.source,
  /\brule[\s_.-]*34[\s_-]+(?:algorithm|theorem|proof|specification|standard|procedure)\b/giu.source,
  /\b(?:chapter|book|section|volume|part|appendix|super[\s_-]+bowl)[\s_-]+x{3,}\b/giu.source,
  /\bx{3,}[\s_-]+chromosomes?\b/giu.source,
  /\bchromosomes?[\s_-]+x{3,}\b/giu.source,
  /\bxxx[\s_-]+(?:vin[\s_-]+diesel|return[\s_-]+of[\s_-]+xander[\s_-]+cage|2002[\s_-]+(?:film|movie))\b/giu.source,
  /\bvin[\s_-]+diesel[\s_-]+xxx\b/giu.source,
  /\badult[\s_-]+(?:education|learning|training|literacy)\b/giu.source,
  /\bmature[\s_-]+skin\b/giu.source,
  /\buncensored[\s_-]+interviews?\b/giu.source,
  /\bnude[\s_-]+art[\s_-]+(?:figure[\s_-]+)?drawings?\b/giu.source,
  /\bnude[\s_-]+art[\s_-]+videos?\b/giu.source,
  /\bnudity[\s_-]+anatomy\b/giu.source,
  /\bnude[\s_-]+(?:watercolou?r[\s_-]+palettes?|art[\s_-]+sculptures?)\b/giu.source,
  /\bmature[\s_-]+trees?\b/giu.source,
  /\berotic[\s_-]+imagery[\s_-]+art[\s_-]+history\b/giu.source,
  /\b(?:porn|porno|pornography|pornographic)[\s_-]+(?:content[\s_-]+)?(?:blockers?|blocking|filters?|filtering|detection|detectors?|moderation|prevention)\b/giu.source,
  /\bpornography[\s_-]+(?:laws?|legal[\s_-]+history)\b/giu.source,
  /\b(?:porn|pornography)[\s_-]+(?:addiction[\s_-]+)?(?:recovery|treatment)\b/giu.source,
  /\bnsfw[\s_-]+(?:classifiers?|classification|filters?|filtering|detection|detectors?|moderation)\b/giu.source,
  /\bnsfw[\s_-]+api[\s_-]+(?:reference|documentation)\b/giu.source,
  /\b18\s*\+[\s_-]+(?:travel[\s_-]+insurance|insurance|(?:voting[\s_-]+)?eligibility|age[\s_-]+requirements?)\b/giu.source
] as const;
const automaticOrdinaryPhrasePatterns = EXPLICIT_AUTOMATIC_ORDINARY_PHRASES.map(pattern => new RegExp(pattern, "giu"));

export function normalizeAutomaticExplicitText(value: string): string {
  let text = normalizeExplicitMediaText(value);
  for (const pattern of automaticOrdinaryPhrasePatterns) text = text.replace(pattern, " vigilordinary ");
  return text;
}

// Printed sexual imagery is still sexual media when sold as decor or a
// collectible. Keep the evidence local and require both a sexual label and a
// visual product. Reviewed sexual print subjects also qualify otherwise plain
// photo/collectible titles. Names alone, canvas supplies and ordinary art stay
// outside this rule. Exact nonsexual phrases consume only their own words.
export const EXPLICIT_PRINT_ORDINARY_PHRASES = [
  /\b(?:lingerie|underwear|bikinis?|swimsuits?)[\s_-]+(?:(?:sewing|knitting|crochet)[\s_-]+)?patterns?\b/giu.source,
  /\b(?:floral|leopard|zebra|animal|paisley|polka[\s_-]+dot)[\s_-]+prints?[\s_-]+(?:bikinis?|underwear|lingerie|thongs?)\b/giu.source,
  /\bpin[\s_-]*up[\s_-]+(?:hair(?:styles?)?|hairstyles?|hairdos?)\b/giu.source,
  /\b(?:cigarette|cigar|pork|boston)[\s_-]+butts?\b/giu.source,
  /\bbutt[\s_-]+joints?\b/giu.source
] as const;
const printVisual = "(?:prints?|posters?|photos?|photographs?|photography|pictures?|images?|portraits?|canvases|canvas|art(?:works?)?|decor|decorations?|illustrations?|paintings?|drawings?|cartoons?|stickers?|decals?|postcards?|calendars?|tapestries|plaques?|trading cards?)";
const printSexual = "(?:mature|explicit|provocative|suggestive|revealing|spicy|uncensored|unfiltered|sexy|sensual|seductive|sultry|raunchy|racy|risque|erotic|erotica|lewd|nude|naked|topless|underboob|lingerie|underwear|bikinis?|thongs?|boudoir|pin ups?|pinups?|shibari|bondage|fetish|hotwife|swingers?|sexploitation|strippers?|busty|voluptuous|thicc|hotties?|butts?|booty|18plus|r18)";
const printGap = "(?:[\\p{L}\\p{N}]+ ){0,4}";
// Full subjects verified in the reviewed explicit photo-print catalog. Never
// infer a sexual subject from a first name, surname, or arbitrary celebrity.
const reviewedPrintSubjects = "(?:abella danger|abelladanger)";
const subjectPrintProduct = "(?:photos?|photographs?|pictures?|images?|prints?|posters?|portraits?|canvas|art|calendars?|trading cards?|autographs?|mugs?)";
const printRating = "(?:18plus|r18|adults? only|not suitable for (?:young people|children|minors))";
export const EXPLICIT_PRINT_PATTERNS = [
  `(?:^|[^\\p{L}\\p{N}])${printSexual} ${printGap}${printVisual}(?=$|[^\\p{L}\\p{N}])`,
  `(?:^|[^\\p{L}\\p{N}])${printVisual} ${printGap}${printSexual}(?=$|[^\\p{L}\\p{N}])`,
  // A trailing age label can follow a longer product name or edition number.
  `(?:^|[^\\p{L}\\p{N}])${printRating} (?:[\\p{L}\\p{N}]+ ){0,12}(?:${printVisual}|digital downloads?)(?=$|[^\\p{L}\\p{N}])`,
  `(?:^|[^\\p{L}\\p{N}])(?:${printVisual}|digital downloads?) (?:[\\p{L}\\p{N}]+ ){0,12}${printRating}(?=$|[^\\p{L}\\p{N}])`,
  `(?:^|[^\\p{L}\\p{N}])${reviewedPrintSubjects} (?:[\\p{L}\\p{N}]+ ){0,8}${subjectPrintProduct}(?=$|[^\\p{L}\\p{N}])`,
  `(?:^|[^\\p{L}\\p{N}])${subjectPrintProduct} (?:[\\p{L}\\p{N}]+ ){0,8}${reviewedPrintSubjects}(?=$|[^\\p{L}\\p{N}])`,
  /(?:^|[^\p{L}\p{N}])(?:busty|voluptuous|thicc) (?:[\p{L}\p{N}]+ ){0,4}ai models?(?=$|[^\p{L}\p{N}])/u.source,
  /(?:^|[^\p{L}\p{N}])models? (?:[\p{L}\p{N}]+ ){0,4}mature collections?(?=$|[^\p{L}\p{N}])/u.source
] as const;

// Visually reviewed sexual listings whose neutral titles carry no dependable
// text signal. IDs are provider-scoped, never global words or tracking values.
// Evidence: research/2026-10-25-print-poster-audit.md.
export const REVIEWED_EXPLICIT_PRINT_PRODUCT_IDS = [
  "4596079411", "250555610", "4439331570", "4531137091", "4520580803",
  "4596303659", "4584233511", "4299890278", "4545313735", "4314991788",
  "4551934894", "1891438757", "4543154295", "4341915187", "4583202389",
  "1876924798", "4439560667", "4522401873"
] as const;
export const REVIEWED_EXPLICIT_PRINT_PRODUCT_ROUTE = /^\/(?:listing|r\/similar)\/([0-9]+)(?:\/|$)/iu.source;

export function isReviewedExplicitPrintProductUrl(value: unknown): boolean {
  let url: URL;
  try { url = new URL(String(value || "")); } catch { return false; }
  if (!/^https?:$/u.test(url.protocol)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (host !== "etsy.com" && !host.endsWith(".etsy.com")) return false;
  let path = url.pathname;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { const decoded = decodeURIComponent(path); if (decoded === path) break; path = decoded; }
    catch { break; }
  }
  const id = new RegExp(REVIEWED_EXPLICIT_PRINT_PRODUCT_ROUTE, "iu").exec(path)?.[1];
  return Boolean(id && (REVIEWED_EXPLICIT_PRINT_PRODUCT_IDS as readonly string[]).includes(id));
}
const printOrdinaryPatterns = EXPLICIT_PRINT_ORDINARY_PHRASES.map(pattern => new RegExp(pattern, "giu"));
const printPatterns = EXPLICIT_PRINT_PATTERNS.map(pattern => new RegExp(pattern, "u"));

export function containsExplicitPrintMedia(value: string): boolean {
  return containsExplicitPrintEvidence(normalizeAutomaticExplicitText(value));
}

function containsExplicitPrintEvidence(value: string): boolean {
  let text = value.toLowerCase();
  for (const pattern of printOrdinaryPatterns) text = text.replace(pattern, " vigilordinary ");
  text = text.replace(/\b18\s*\+/gu, "18plus").replace(/\br[\s_-]+18\b/gu, "r18")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return printPatterns.some(pattern => pattern.test(text));
}

// Automatic rules use complete vocabulary tokens. User-authored literal URL
// rules retain their separate matching semantics in the policy engine.
export const EXPLICIT_SEARCH_KEYWORD_TERMS = [
  "porn", "porno", "prno", "p0rn", "p0rno", "pornography", "pornographic", "nsfw", "hentai", "h3ntai", "rule34",
  "gonewild", "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube", "youporn", "spankbang",
  "xvideos", "xnxx", "xhamster", "pornhub", "honeytoon", "honeytoons", "hooneytoon", "hooneytoons", "toongod",
  ...ADDITIONAL_EXPLICIT_SEARCH_TERMS
] as const;
export const EXPLICIT_SEARCH_COMPOUND_PATTERN = /^(?:porn|porno|p0rn|hentai|h3ntai|nsfw)(?:videos?|vids?|photos?|pics?|images?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|hub|tube|hd|vr|4k)$/u.source;
const explicitSearchKeywordTerms = new Set<string>(EXPLICIT_SEARCH_KEYWORD_TERMS);
const explicitSearchCompoundPattern = new RegExp(EXPLICIT_SEARCH_COMPOUND_PATTERN, "u");

export function containsExplicitSearchKeyword(value: string): boolean {
  const text = normalizeAutomaticExplicitText(value).toLowerCase();
  const tokens = text.match(/[\p{L}\p{N}]+/gu) || [];
  return tokens.some(token => explicitSearchKeywordTerms.has(token) || explicitSearchCompoundPattern.test(token));
}

export const EXPLICIT_SEARCH_ALIAS_PATTERNS = [
  /^\s*(?:nud(?:s|3s?)?|nudes)\s*$/iu.source,
  /(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.source
] as const;
export function containsExplicitSearchAliases(value: string): boolean {
  const text = normalizeAutomaticExplicitText(value);
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
  strongMediaMarker: /^(?:nud|nuds|nudes?|naked|nudity|lewd|erotic|erotica|x{3,})$/u.source,
  connectors: /^(?:a|an|the|of|with|who|that|are|is|were|was|be|being|their|very|really|absolutely|totally|completely|fully|amazingly|beautiful|gorgeous|amazing|pretty|lovely)$/u.source,
  body: /^(?:boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?)$/u.source,
  people: /^(?:girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?)$/u.source,
  media: /^(?:videos?|vids?|movies?|films?|clips?|photos?|photographs?|pics?|pictures?|images?|gifs?|prints?|posters?|pin(?:[-_ ]?up)s?|calendars?|galler(?:y|ies)|albums?|wallpapers?|footage|streams?|livestreams?|webcams?|compilations?|documentar(?:y|ies)|animations?|animated|illustrations?|comics?|manga|hentai|audios?)$/u.source,
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
  const tokens = normalizeAutomaticExplicitText(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
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
  const text = normalizeAutomaticExplicitText(value).toLowerCase();
  if (containsExplicitPrintEvidence(text)) return true;
  if (/(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])/u.test(text)) return true;
  const tokens = text.replace(/\b(?:without(?:[\s_-]+any)?|with[\s_-]+no)[\s_-]+clothes\b/gu, "naked")
    .replace(/\b(?:wearing[\s_-]+nothing|(?:in[\s_-]+(?:the|their|a)[\s_-]+)?birthday[\s_-]+suits?|in[\s_-]+the[\s_-]+buff)\b/gu, "naked")
    .replace(/\b(?:pleasur(?:ing|e)[\s_-]+(?:myself|herself|himself|themselves)|playing[\s_-]+with[\s_-]+(?:myself|herself|himself|themselves)|self[\s_-]+pleasure)\b/gu, "selfpleasure")
    .replace(/\bup[\s_-]+skirt\b/gu, "upskirt").replace(/\bdown[\s_-]+blouse\b/gu, "downblouse")
    .replace(/\bstrip[\s_-]+tease\b/gu, "striptease").replace(/\bnip[\s_-]+slips?\b/gu, "nipslip")
    .replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie")
    .replace(/\bfull[\s_\p{Pd}]+frontal\b/gu, "fullfrontal")
    .replace(/\bsee[\s_\p{Pd}]+through\b/gu, "seethrough").match(/[\p{L}\p{N}]+/gu) || [];
  const { exposure, sexual, acts, strongActs, strongMediaMarker, connectors, body, people, media, marketing, ordinary, relationship, bodyContext, ordinaryBody, ambiguousBody, nonsexualExposure } = explicitMediaPatterns;
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
    // Exact ordinary phrases were consumed above. An unrelated qualification
    // cannot turn an otherwise clear nude/erotic media request into safe text.
    if (strongMediaMarker.test(token) && nearby.some(word => media.test(word))) return true;
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
    // An audience description can repeat adult/adults ("adults and young
    // adults"). Repetition alone adds no explicit evidence. Media terms and
    // distinct explicit markers must still qualify in either word order.
    if (marker.test(token) && others.some(word => media.test(word) || contributor.test(word)
      || (marker.test(word) && !(/^adults?$/u.test(token) && /^adults?$/u.test(word))))) return true;
    if (marketing.test(token) && others.some(word => exposure.test(word) || sexual.test(word) || acts.test(word))) return true;
  }
  return false;
}
