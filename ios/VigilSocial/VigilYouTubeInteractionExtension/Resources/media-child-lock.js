(() => {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
// BEGIN GENERATED CONTEXTUAL PLATFORMS
  const contextualHosts = ["reddit.com","deviantart.com","artstation.com","pixiv.net","behance.net","newgrounds.com","furaffinity.net","tumblr.com","artmajeur.com","inkbunny.net","sofurry.com","weasyl.com","saatchiart.com","fineartamerica.com","flickr.com","500px.com","pinterest.com","pinterest.co.uk","x.com","twitter.com","bsky.app","patreon.com","itch.io","discord.com","discordapp.com"];
  const currentHost = location.hostname.toLowerCase().replace(/\.$/u, '');
  const isContextualPlatform = contextualHosts.some(domain => currentHost === domain || currentHost.endsWith('.' + domain));
// END GENERATED CONTEXTUAL PLATFORMS
  // BEGIN GENERATED EXPLICIT MEDIA CONTEXT
/* eslint-disable no-unused-vars -- Shared matchers include helpers unused by this entry point. */
// Shared by navigation/search guards and media-card inspection. Ambiguous
// markers contribute evidence only within a short local phrase.
// Keep the list limited to pornography labels and specific sexual-media
// phrases. Bare translations of "sexual", "adult", or "nude" are too broad.
const MULTILINGUAL_ADULT_PRODUCT_TERMS = [
    "性爱娃娃", "性愛娃娃", "情趣娃娃", "性玩具", "ラブドール", "セックスドール"
];
const MULTILINGUAL_EXPLICIT_TERMS = [
    "إباحي", "إباحية", "اباحي", "اباحية",
    "فيديو جنسي", "فيديوهات جنسية", "فيلم جنسي", "أفلام جنسية",
    "色情片", "色情视频", "色情視頻", "色情影片", "色情电影", "色情電影",
    ...MULTILINGUAL_ADULT_PRODUCT_TERMS,
    "ポルノ", "포르노", "음란물", "порно", "порнография",
    "pornographie", "pornographique", "pornografía", "pornográfico", "pornográfica",
    "pornografia", "pornografie", "pornografisch"
];
const MULTILINGUAL_UNSPACED_LABELS = MULTILINGUAL_EXPLICIT_TERMS.filter(term => /[\p{Script=Han}\p{Script=Katakana}\p{Script=Hangul}]/u.test(term));
// Explicit-media labels and services, rather than general anatomy, identities,
// relationship words or sexual-health vocabulary. Ambiguous words belong in
// the phrase matcher below and in verified SafeSearch evidence, never here.
const ADDITIONAL_EXPLICIT_SEARCH_TERMS = [
    "pornography", "pornographic", "pornstar", "pornstars", "pornpics", "pornvideos",
    "sexcam", "sexcams", "camsex", "camgirl", "camgirls", "sextape", "sextapes",
    "nhentai", "hanime", "redgifs", "youjizz", "tnaflix", "tube8", "jerkmate",
    "futanari", "ecchi", "sexdoll", "sexdolls", "lovedoll", "lovedolls",
    "sexrobot", "sexrobots", "sextoy", "sextoys", "masturbator", "masturbators"
];
// Normalize known vocabulary, rather than fuzzy-matching arbitrary names or
// product IDs. Ordinary subjects retain their own accents and spellings.
const EXPLICIT_VOCABULARY_REPLACEMENTS = [
    // Product labels also occur on ordinary marketplaces. Match the specific
    // adult product, never bare silicone, dolls, toys, or reborn collectibles.
    { pattern: /\b(?:sex|love)[\s_\p{Pd}]+(?:(?:silicone|tpe|realistic|lifelike|full[\s_\p{Pd}]+body)[\s_\p{Pd}]+){0,3}dolls?\b/giu.source, replacement: "sexdoll" },
    { pattern: /\bsex[\s_\p{Pd}]+robots?\b/giu.source, replacement: "sexrobot" },
    { pattern: /\bsex[\s_\p{Pd}]+toys?\b/giu.source, replacement: "sextoy" },
    { pattern: /\b(?:nak3d|n4ked|n4k3d)\b/giu.source, replacement: "naked" },
    { pattern: /\b(?:nud3s?|nudez|nudz|n00dz|n00des|noodz)\b/giu.source, replacement: "nudes" },
    { pattern: /\b(?:ph0t0s|ph0tos|phot0s)\b/giu.source, replacement: "photos" },
    { pattern: /\bn[\s_.-]+a[\s_.-]+k[\s_.-]+e[\s_.-]+d\b/giu.source, replacement: "naked" },
    { pattern: /\bn[\s_.-]+u[\s_.-]+d[\s_.-]+e(?:[\s_.-]+s)?\b/giu.source, replacement: "nudes" },
    { pattern: /\bp[\s_.-]+[o0][\s_.-]+r[\s_.-]+n\b/giu.source, replacement: "porn" },
    { pattern: /\b(naked|nudes?|topless|bottomless|adult|sex)(girls?|boys?|women|woman|men|males?|females?|models?|videos?|vids?|photos?|pics?|images?)\b/giu.source, replacement: "$1 $2" }
];
// Each exception consumes only the established nonsexual phrase. Adding an
// unrelated word to a nude-person query therefore cannot excuse that query,
// and a separate explicit phrase remains visible to the matcher.
const EXPLICIT_MEDIA_ORDINARY_PHRASES = [
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
];
const vocabularyReplacements = EXPLICIT_VOCABULARY_REPLACEMENTS.map(({ pattern, replacement }) => ({ pattern: new RegExp(pattern, "giu"), replacement }));
const ordinaryPhrasePatterns = EXPLICIT_MEDIA_ORDINARY_PHRASES.map(pattern => new RegExp(pattern, "giu"));
const explicitHomoglyphs = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "Α": "A" };
function normalizeExplicitVocabulary(value) {
    let text = String(value || "").normalize("NFKC")
        .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "")
        .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""));
    text = text.replace(/[\p{L}\p{N}]+/gu, token => {
        const folded = token.replace(/[аеорсхіуΑ]/gu, letter => explicitHomoglyphs[letter]).toLowerCase();
        return /^(?:naked|nudes?|porn|porno|nsfw|sex|sexual|topless|nakedgirls|nudegirls)$/u.test(folded) ? folded : token;
    });
    for (const { pattern, replacement } of vocabularyReplacements)
        text = text.replace(pattern, replacement);
    return text;
}
function normalizeExplicitMediaText(value) {
    let text = normalizeExplicitVocabulary(value);
    for (const pattern of ordinaryPhrasePatterns)
        text = text.replace(pattern, " vigilordinary ");
    return text;
}
const EXPLICIT_SEARCH_ALIAS_PATTERNS = [
    /^\s*(?:nud(?:s|3s?)?|nudes)\s*$/iu.source,
    /(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.source
];
function containsExplicitSearchAliases(value) {
    const text = normalizeExplicitVocabulary(value);
    return EXPLICIT_SEARCH_ALIAS_PATTERNS.some(pattern => new RegExp(pattern, "iu").test(text));
}
// Sources also generate the native phone matcher. All evidence and exceptions
// are bounded to four words either side; an unrelated paragraph cannot supply
// a sexual clue or cancel a separate explicit phrase.
const EXPLICIT_MEDIA_PATTERNS = {
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
};
const explicitMediaPatterns = Object.fromEntries(Object.entries(EXPLICIT_MEDIA_PATTERNS)
    .map(([name, source]) => [name, new RegExp(source, "u")]));
function containsAdditionalExplicitSearchTerm(value) {
    const tokens = normalizeExplicitVocabulary(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    return tokens.some(token => ["porn", "porno", "nsfw", ...ADDITIONAL_EXPLICIT_SEARCH_TERMS].includes(token));
}
function containsMultilingualExplicitText(value) {
    const text = String(value || "").normalize("NFKC")
        .replace(/[\u200b-\u200d\u2060\ufeff\u0640]/gu, "")
        .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/gu, "")
        .replace(/[أإآٱ]/gu, "ا")
        // Fold Latin accents without removing Japanese voicing marks or
        // decomposing Korean syllables. Both are meaningful letters here.
        .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""))
        .toLowerCase();
    if (/(?:^|[^\p{L}\p{N}])(?:(?:[وف]?ال|[بك]ال|لل|[وف]))?اباحي(?:ة|ا|ات|ون|ين)?(?=$|[^\p{L}\p{N}])/u.test(text))
        return true;
    if (/(?:^|[^\p{L}\p{N}])(?:ال)?(?:فيديو(?:هات)?|فيلم|افلام)[\s_-]+(?:ال)?جنسي(?:ة)?(?=$|[^\p{L}\p{N}])/u.test(text))
        return true;
    if (/(?:^|[^\p{L}\p{N}])(?:pornografi(?:a|co|ca)s?|pornographi(?:e|ques?)|pornografie|pornografisch(?:e[rmns]?)?|порно(?:видео|фильм(?:ы|ов)?|ролик(?:и|ов)?)?|порнографи\p{Script=Cyrillic}*)(?=$|[^\p{L}\p{N}])/u.test(text))
        return true;
    // Chinese/Japanese text and Korean grammatical suffixes do not reliably
    // delimit these labels with spaces. Use specific, unambiguous media terms.
    return MULTILINGUAL_UNSPACED_LABELS.some(term => text.includes(term));
}
function containsContextualExplicitMedia(value) {
    if (containsMultilingualExplicitText(value))
        return true;
    if (containsAdditionalExplicitSearchTerm(value))
        return true;
    const text = normalizeExplicitMediaText(value).toLowerCase();
    if (/(?:^|[^\p{L}\p{N}])(?:x+[\s_.\p{Pd}]*rated|rated[\s_.\p{Pd}]*x+)(?:$|[^\p{L}\p{N}])/u.test(text))
        return true;
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
                if (!adjacent)
                    return false;
                if (people.test(adjacent))
                    return true;
                if (!connectors.test(adjacent))
                    return false;
            }
            return false;
        });
        if ((exposure.test(token) || token === "bare") && directPerson)
            return true;
        if (!(marker.test(token) || exposure.test(token) || sexual.test(token) || acts.test(token)
            || body.test(token) || marketing.test(token) || /^(?:sexy|hot)$/u.test(token)))
            continue;
        // Both orders work; unrelated text elsewhere on a page supplies neither
        // evidence nor an exemption. Ordinary context only qualifies these weak
        // markers and cannot override existing explicit terms or X-rated labels.
        const nearby = tokens.slice(Math.max(0, index - 4), index + 5);
        if (strongActs.test(token) && nearby.some(word => media.test(word) || people.test(word)))
            return true;
        if (/^x{1,2}$/u.test(tokens[index]) && nearby.some(token => /^(?:model|men|files|axis|chromosomes?)$/u.test(token)))
            continue;
        if (nearby.some(token => ordinary.test(token)))
            continue;
        if (token === "sex" && nearby.some(word => relationship.test(word)))
            continue;
        if (ambiguousBody.test(token) && nearby.some(word => ordinaryBody.test(word)))
            continue;
        if ((exposure.test(token) || sexual.test(token) || body.test(token) || /^(?:sexy|hot)$/u.test(token))
            && nearby.some(word => bodyContext.test(word)))
            continue;
        if (exposure.test(token) && nearby.some(word => nonsexualExposure.test(word)))
            continue;
        const others = nearby.filter((_word, offset) => Math.max(0, index - 4) + offset !== index);
        // Hot is too broad for generic media (weather, music, food). Sexy clothing
        // and isolated anatomy or fetish terms likewise need a qualifying phrase.
        if (/^(?:sexy|hot)$/u.test(token)) {
            if (others.some(word => people.test(word)))
                return true;
            continue;
        }
        if (exposure.test(token) || sexual.test(token) || acts.test(token)) {
            if (others.some(word => media.test(word) || people.test(word) || body.test(word)
                || exposure.test(word) || sexual.test(word) || acts.test(word) || marketing.test(word)))
                return true;
        }
        if (body.test(token) && others.some(word => media.test(word) || exposure.test(word) || sexual.test(word)))
            return true;
        if (marker.test(token) && others.some(word => media.test(word) || marker.test(word) || contributor.test(word)))
            return true;
        if (marketing.test(token) && others.some(word => exposure.test(word) || sexual.test(word) || acts.test(word)))
            return true;
    }
    return false;
}
/* eslint-enable no-unused-vars */
// END GENERATED EXPLICIT MEDIA CONTEXT
  const explicitTitle = value => {
    const text = String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
    if (containsContextualExplicitMedia(text)) return true;
    if (/(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|nud(?:s|3s?)?|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.test(text)) return true;
    // Catalog titles use XXX without a following word such as "videos".
    // Match the title token on every host, not arbitrary URL/identifier substrings.
    const titleMarkers = text.replace(/\b(?:chapter|volume|section|book|part|act|super bowl)\s+x{3,}\b/giu, '');
    if (/(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}])/iu.test(titleMarkers)) return true;
    return /(?:^|[^a-z0-9])(?:porn(?:ography|ographic)?|p0rn|hentai|nsfw|gonewild|onlyfans|fansly|blowjob|cumshot)(?:$|[^a-z0-9])|\b(?:nude|naked|sex|xxx)\s+(?:videos?|photos?|tapes?)\b/i.test(text)
      || (isContextualPlatform && /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|r[\s_-]*18g?|18\s*\+|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu.test(text));
  };
  const isX = /(^|\.)(x\.com|twitter\.com)$/i.test(location.hostname);
  const sensitiveWarning = value => /(?:this (?:post|media|profile|account)|the following media|content warning)[\s\S]{0,100}(?:sensitive|adult|nudity|sexual)|^(?:sensitive content|adult content|age.restricted content)$/i.test(String(value || '').trim());
  const scanX = root => {
    if (!isX) return;
    // Keep the whole post together: hiding only its label leaves attached media visible.
    for (const post of root.querySelectorAll('article, [data-testid="tweet"], [data-testid="UserCell"]')) {
      const text = post.textContent || '';
      if (explicitTitle(text) || sensitiveWarning(text) || post.querySelector('[data-testid*="sensitiveMedia" i], [data-testid*="sensitive_media" i]')) conceal(post);
    }
    for (const marker of root.querySelectorAll('span, [role="dialog"], [data-testid*="sensitive" i]')) {
      const text = (marker.textContent || '').trim();
      if (text.length > 700 || !sensitiveWarning(text)) continue;
      conceal(marker.closest('article, [role="dialog"], [data-testid="cellInnerDiv"]') || marker.parentElement || marker);
    }
    for (const control of root.querySelectorAll('button, a, input, label, [role="button"], [role="checkbox"], [role="switch"]')) {
      const text = [control.textContent, control.getAttribute('aria-label'), ...(control.labels || [])].map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ').trim();
      // Lock both directions of the preference controls. This is a browser-side
      // interlock, not a claim that X's account preference has been saved.
      if (text.length < 400 && /(?:display|show|hide|view|allow)\s+(?:media that may contain\s+)?sensitive (?:content|media)|(?:yes[,]?\s*)?i(?: am|'m|’m) (?:over )?18/i.test(text)) conceal(control);
      if (/^(?:show|view|continue|yes)$/i.test(text)) {
        const context = control.closest('article, [role="dialog"], [data-testid="cellInnerDiv"]');
        if (context && sensitiveWarning(context.textContent)) conceal(context);
      }
    }
  };
  // Reddit has a stricter dedicated guard and external-search review flow.
  // These platforms share label/age protections without inheriting Reddit's
  // single-post navigation rules (which would break messaging and creator pages).
  const isMixedPlatform = isContextualPlatform && !/(^|\.)reddit\.com$/i.test(location.hostname);
  const cards = 'article, [data-testid="tweet"], [data-testid="UserCell"], [data-testid^="feedItem"], [data-testid="post"], [data-tag="post-card"], [data-testid="post-card"], .game_cell, [id^="chat-messages-"]';
  const controls = 'button, a, input, label, select, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"]';
  const describe = element => [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('name'), ...(element.labels || []),
    ...(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => element.getRootNode().getElementById?.(id))]
    .map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  const adultWarning = value => sensitiveWarning(value)
    || /(?:age[ -]restricted|adults?[ -]only|adult content|sexually (?:explicit|suggestive)|sexual content|\bnsfw\b|\br[ -]?18g?\b|18\s*\+|成人向け|成人向)/i.test(value);
  const ageConfirmation = value => /(?:i\s*(?:am|'m|’m)|yes[,]?\s*i(?:m|'m|’m)?|confirm[^.]{0,30}(?:age|over)|(?:enter|continue|view|show)[^.]{0,30}(?:over|age))[^.]{0,35}(?:18|eighteen)|(?:18|eighteen)[^.]{0,30}(?:or older|years or over)/i.test(value);
  const sensitivePreference = value => /(?:safe[ -]?search|(?:blur|hide|show|display|allow|include|filter|block|enable|disable|view)[^.]{0,65}(?:sensitive|adult|explicit|sexual|nudity|nsfw|r[ -]?18)|(?:sensitive|adult|explicit|sexual|nudity|nsfw|r[ -]?18)[^.]{0,65}(?:blur|hide|show|display|allow|include|filter|block|enable|disable))/i.test(value);
  const localContainer = element => {
    for (let node = element; node; node = node.getRootNode().host) {
      const card = node.closest(`${cards}, [role="dialog"], dialog, [data-testid*="contentWarning" i], [data-testid*="ageGate" i]`);
      if (card) return card;
      const form = node.closest('form');
      if (form && describe(form).length < 700 && adultWarning(describe(form))) return form;
    }
    return null;
  };
  const explicitAccount = value => explicitTitle(value) || /porn|p0rn|nsfw|onlyfans|fansly|gonewild|xxx/i.test(String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, ''));
  const authorMarkers = '[author], [data-author], [author-name], .author, .user_name, [data-testid="User-Name"], [data-testid="postAuthor"], [data-testid="post-author"], [data-tag="creator-name"]';
  const scanMixedPlatforms = root => {
    if (!isMixedPlatform) return;
    for (const author of root.querySelectorAll(authorMarkers)) {
      if ([author.getAttribute('author'), author.getAttribute('data-author'), author.getAttribute('author-name'),
        ...(author.matches(cards) ? [] : [author.textContent])].some(explicitAccount)) conceal(localContainer(author) || author);
    }
    for (const anchor of root.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const samePlatform = url.hostname === location.hostname;
      let account = null;
      if (samePlatform && isX) account = url.pathname.match(/^\/([^/]+)(?:\/|$)/)?.[1];
      else if (samePlatform && /(^|\.)bsky\.app$/i.test(url.hostname)) account = url.pathname.match(/^\/profile\/([^/]+)/)?.[1];
      else if (samePlatform && /(^|\.)patreon\.com$/i.test(url.hostname)) account = url.pathname.match(/^\/c\/([^/]+)/)?.[1];
      if (account) {
        try { account = decodeURIComponent(account); } catch { /* Keep undecodable text bounded to the account segment. */ }
        if (explicitAccount(account)) conceal(localContainer(anchor) || anchor);
      }
    }
    for (const card of root.querySelectorAll(cards)) {
      if (explicitTitle(describe(card)) || adultWarning(card.textContent || '')
        || card.querySelector('[data-nsfw="true"], [data-adult="true"], [data-rating="adult"], [data-x-restrict="1"], [data-x-restrict="2"]')) conceal(card);
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.matches('script, style, textarea, input, [contenteditable="true"]') || element.closest('[contenteditable="true"], script, style')) continue;
      const text = describe(element);
      const marked = element.matches('[data-nsfw="true"], [data-adult="true"], [data-rating="adult"], [data-x-restrict="1"], [data-x-restrict="2"]');
      // Bound prose checks so a label cannot erase a whole feed or channel.
      if (marked || (text.length < 700 && (adultWarning(text) || ageConfirmation(text)))) {
        const container = localContainer(element);
        if (container) conceal(container);
        else if (marked || element.matches('span, p, h1, h2, h3, label, button, summary') || element.childElementCount === 0) {
          if (!element.matches('html, body, main, nav, form')) conceal(mediaContainer(element));
        }
      }
    }
    for (const control of root.querySelectorAll(controls)) {
      const text = describe(control);
      const group = control.closest('label, fieldset, [role="group"], [role="radiogroup"]');
      const groupText = group && describe(group);
      const adultContext = localContainer(control);
      if ((text.length < 500 && (sensitivePreference(text) || ageConfirmation(text)))
        || (groupText && groupText.length < 700 && sensitivePreference(groupText))
        || (adultContext && adultWarning(describe(adultContext)) && /^(?:show|view|reveal|continue|enter|yes|confirm|accept)$/i.test(text))) {
        conceal(group || control);
      }
    }
  };
  const roots = new Set();
  const observers = new WeakMap();
  let pending = false;
  const conceal = element => {
    element.setAttribute('data-vigil-explicit-media', 'blocked');
    if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important') element.style.setProperty('display', 'none', 'important');
    if (element.matches('video, audio')) { try { element.pause(); } catch {} }
    element.querySelectorAll('video, audio').forEach(media => { try { media.pause(); } catch {} });
  };
  const mediaContainer = label => {
    // Select the smallest media-bearing ancestor, never an entire result grid.
    // An explicit poster label must remove its card, not just the image.
    let node = label.matches('img, video, picture, canvas')
      ? label.parentElement || label
      : label;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement || node.getRootNode().host) {
      if (node === document.body || node === document.documentElement) break;
      const media = node.querySelectorAll('img, picture, video, canvas, [style*="background-image"]');
      if (media.length > 4) break;
      if (media.length || node.matches('img, video, picture')) return node;
    }
    return label.closest('a, button, [role="link"], [role="button"]') || label;
  };
  const scan = () => {
    if (!document.documentElement) return;
    observe(document);
    for (const root of roots) {
      if (root !== document && !root.host.isConnected) { roots.delete(root); continue; }
      scanX(root);
      scanMixedPlatforms(root);
      // A search-result heading can split a label across spans while its URL
      // contains only an opaque app ID. Inspect the complete local link label.
      for (const link of root.querySelectorAll('a[href], [role="link"]')) {
        if (link.closest('[contenteditable="true"]')) continue;
        const label = describe(link);
        if (label.length <= 700 && explicitTitle(label)) conceal(link);
      }
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) observe(element.shadowRoot);
        if (element.closest('[data-vigil-explicit-media="blocked"]')) {
          if (element.getAttribute('data-vigil-explicit-media') === 'blocked') conceal(element);
          continue;
        }
        if (element.matches('script, style, textarea, input, [contenteditable="true"]') || element.closest('script, style, [contenteditable="true"]')) continue;
        const label = [element.getAttribute('alt'), element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('data-title')].filter(Boolean).join(' ');
        // Short direct text catches catalog labels even if they use plain divs.
        const directText = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim();
        if (explicitTitle(label) || (directText.length <= 180 && explicitTitle(directText))) {
          const target = mediaContainer(element);
          if (target !== element || element.matches('img, video, a, button, [role="link"], [role="button"]') || element.querySelector('img, video, picture') || (isMixedPlatform && !element.matches('main, nav, body, html'))) conceal(target);
        }
      }
    }
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; scan(); }, 0);
  };
  const observe = root => {
    roots.add(root);
    if (observers.has(root)) return;
    const observer = new MutationObserver(schedule);
    try {
      observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['alt','title','aria-label','data-title','data-testid','data-nsfw','data-adult','data-rating','data-x-restrict','author','data-author','author-name','href','class','aria-labelledby','name','value','aria-checked','checked','style']});
      const style = document.createElement('style');
      style.textContent = '[data-vigil-explicit-media="blocked"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }';
      (root === document ? document.documentElement : root).append(style);
      observers.set(root, observer);
    } catch (error) {
      // A later complete scan must retry all setup, rather than attest a root
      // whose mutation observer or hiding style was never installed.
      observer.disconnect();
      throw error;
    }
  };
  const guard = event => {
    if (isX || isMixedPlatform) scan();
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.matches('a[href], [role="link"]') && explicitTitle(describe(element))) conceal(element);
      if (element.getAttribute('data-vigil-explicit-media') !== 'blocked') continue;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };
  for (const event of ['click','pointerdown','keydown','submit','change','play']) window.addEventListener(event, guard, true);
  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  // Safari enforces the filters directly without a separate page-connection
  // timeout. Keep every scan and guard running, but avoid sending unused
  // health messages. Chrome retains its existing reporting protocol.
  let reportsHealth = true;
  try { reportsHealth = !String(runtime?.getURL?.('') || '').startsWith('safari-web-extension:'); }
  catch { /* Identifying a stale extension context must not stop its filters. */ }
  const reportHealth = () => {
    // Every frame keeps its filters active, including hidden and newly parsed
    // frames that cannot attest the visible top-level page.
    // A transient DOM failure must not end the reporting lifecycle. A failed
    // scan provides no health evidence; the next lifecycle event or heartbeat
    // must perform the complete scan again before it can report success.
    try { scan(); } catch { return; }
    if (!reportsHealth) return;
    if (window.top !== window || document.visibilityState !== 'visible' || !document.documentElement) return;
    // A successful scan precedes every report. The background supplies the
    // sender URL and verifies its active, focused window. Safari can leave
    // focus in its address bar after a private search: document.hasFocus()
    // would reject a visible, protected page in that case.
    try { Promise.resolve(runtime?.sendMessage({type:'VIGIL_BROWSER_FILTER_HEALTH', revision:'2026-09-17.1'})).catch(() => {}); } catch {}
  };
  document.addEventListener('DOMContentLoaded', reportHealth, {once:true});
  addEventListener('pageshow', reportHealth, true);
  addEventListener('focus', reportHealth, true);
  document.addEventListener('visibilitychange', reportHealth);
  // Browser focus can return to the address bar without a DOM focus or
  // visibility event. Re-scan on a background request without reloading the
  // document, losing a form, or changing its navigation history.
  runtime?.onMessage?.addListener(message => {
    if (message?.type === 'VIGIL_REQUEST_BROWSER_FILTER_HEALTH') reportHealth();
  });
  setInterval(reportHealth, 1500);
  reportHealth();
})();
