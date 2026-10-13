/* eslint-disable no-unused-vars -- Shared desktop matcher includes helpers unused by this entry point. */
// Generated from the desktop search guard; run the generator after npm run build.
(() => {
function vigilBlockedSearchURL() {
  try {
    return (globalThis.browser || globalThis.chrome).runtime.getURL("blocked.html");
  } catch { return "about:blank"; }
}
function limitedSearchWarning(value) {
    return typeof value === "string" && value.length <= 240
        && /^(?:some\s+)?results\s+are\s+limited\s+by\s+(?:safe\s*search|search)\s*[.!]?$/iu.test(value.replace(/\s+/gu, " ").trim());
}
function limitedSearchPage(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
            && ["google.com", "www.google.com", "images.google.com"].includes(url.hostname)
            && url.pathname === "/search" && Boolean(url.searchParams.get("q"));
    }
    catch {
        return false;
    }
}

const checkSearchBreakBeforeNavigation = (() => {
    if (globalThis.top !== globalThis.self || typeof document === "undefined" || typeof document.addEventListener !== "function")
        return () => undefined;
    const api = globalThis.browser || chrome;
    let warningURL = "";
    let warningID = "";
    let reported = false;
    let pending;
    let lastStatusAt = 0;
    let scheduled = false;
    function check(warningsOnly = false) {
        if (document.hidden)
            return;
        const url = location.href;
        if (warningURL !== url) {
            warningURL = url;
            warningID = limitedSearchPage(url) ? crypto.randomUUID() : "";
            reported = false;
        }
        const notice = !reported && limitedSearchPage(url) ? findNotice() : "";
        if (!notice && warningsOnly)
            return;
        if (pending)
            return pending.then(blocked => blocked || check(warningsOnly) || false);
        if (!notice && Date.now() - lastStatusAt < 1000)
            return;
        lastStatusAt = Date.now();
        const work = async () => {
            try {
                const result = await api.runtime.sendMessage({ type: "VIGIL_SEARCH_BREAK", action: notice ? "search-break-warning" : "search-break-status",
                    id: warningID, warning: notice, url });
                if (result?.ok && notice && warningURL === url)
                    reported = true;
                if (result?.ok && result.blocked && location.href === url) {
                    location.replace(api.runtime.getURL("search-break.html"));
                    return true;
                }
            }
            catch { /* The background retains the durable break across page retries. */ }
            return false;
        };
        const next = work();
        pending = next;
        void next.finally(() => { if (pending === next)
            pending = undefined; });
        return next;
    }
    function findNotice() {
        // Read visible, standalone notice text, never a search query, result title,
        // quoted code sample, or a result snippet describing this feature.
        for (const node of document.querySelectorAll("[role='alert'], [role='alert'] *, [role='status'], [role='status'] *, [role='dialog'], [role='dialog'] *, [aria-live], [aria-live] *, #taw *, #topstuff *, #botstuff *, #search div, #search span, #search p")) {
            const text = node.innerText?.trim() || "";
            if (!limitedSearchWarning(text) || !node.getClientRects().length
                || getComputedStyle(node).visibility !== "visible"
                || node.closest("#rso, article, a, h3, input, textarea, pre, code, [hidden], [aria-hidden='true']"))
                continue;
            let resultCard = false;
            for (let parent = node.parentElement; parent && parent !== document.body && parent !== document.documentElement && !["search", "topstuff", "botstuff", "taw"].includes(parent.id); parent = parent.parentElement) {
                if (parent.querySelector("a h3")) {
                    resultCard = true;
                    break;
                }
            }
            if (!resultCard)
                return text;
        }
        return "";
    }
    function schedule() {
        if (scheduled)
            return;
        scheduled = true;
        setTimeout(() => { scheduled = false; void check(); }, 100);
    }
    function observe() {
        if (document.documentElement)
            new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style", "class", "aria-hidden"] });
        void check();
    }
    if (document.documentElement)
        observe();
    else
        document.addEventListener("DOMContentLoaded", observe, { once: true });
    addEventListener("pageshow", schedule);
    addEventListener("popstate", schedule);
    document.addEventListener("visibilitychange", schedule);
    setInterval(() => { void check(); }, 1000);
    return () => check(true);
})();

/** Shared by the native policy and the generated browser guards. */
function matchSemanticExplicitUrl(value) {
    let url;
    try {
        url = value instanceof URL ? value : new URL(String(value || ""));
    }
    catch {
        return null;
    }
    if (!/^https?:$/u.test(url.protocol))
        return null;
    const strong = new Set([
        ...EXPLICIT_SEARCH_KEYWORD_TERMS,
        "porn", "porno", "pornography", "pornographic", "p0rn", "p0rno", "p0rnography", "hentai", "h3ntai", "nhentai", "nsfw",
        "rule34", "sexcam", "sexcams", "camsex", "sextape", "sextapes",
        "futanari", "erotica", "pornhub", "xvideos", "xnxx", "redgifs"
    ]);
    const media = new Set([
        "video", "videos", "vid", "vids", "photo", "photos", "pic", "pics", "image", "images",
        "gif", "gifs", "cam", "cams", "comic", "comics", "manga", "manhwa", "manhua",
        "webtoon", "webtoons", "doujin", "doujinshi", "novel", "novels", "art", "gallery", "galleries"
    ]);
    const weak = new Set(["adult", "adults", "mature", "uncensored", "lewd", "erotic", "nude", "nudes", "naked", "sex", "sexual", "xxx", "r18", "18plus"]);
    const comics = new Set(["comic", "comics", "manga", "manhwa", "manhua", "webtoon", "webtoons", "doujin", "doujinshi"]);
    const catalog = new Set(["genre", "genres", "category", "categories", "tag", "tags", "catalog", "browse"]);
    function decode(text) {
        let output = text;
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const next = decodeURIComponent(output);
                if (next === output)
                    break;
                output = next;
            }
            catch {
                // An unrelated malformed escape must not hide valid encoded words.
                const next = output.replace(/(?:%[0-9a-f]{2})+/giu, run => {
                    try {
                        return decodeURIComponent(run);
                    }
                    catch {
                        return run.replace(/%([0-9a-f]{2})/giu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
                    }
                });
                if (next === output)
                    break;
                output = next;
            }
        }
        return output;
    }
    // Browser URL objects expose IDNs as punycode. Decode one bounded DNS label
    // before evaluating words; never scan the arbitrary xn-- payload as prose.
    function unicodeLabel(label) {
        if (!label.startsWith("xn--"))
            return label;
        const input = label.slice(4);
        if (input.length > 63)
            return label;
        const delimiter = input.lastIndexOf("-");
        const output = delimiter < 0 ? [] : [...input.slice(0, delimiter)].map(c => c.codePointAt(0));
        let position = delimiter < 0 ? 0 : delimiter + 1;
        let n = 128;
        let index = 0;
        let bias = 72;
        while (position < input.length && output.length < 128) {
            const previous = index;
            let weight = 1;
            for (let k = 36;; k += 36) {
                if (position >= input.length)
                    return label;
                const code = input.charCodeAt(position++);
                const digit = code >= 48 && code <= 57 ? code - 22
                    : code >= 65 && code <= 90 ? code - 65 : code >= 97 && code <= 122 ? code - 97 : 36;
                if (digit >= 36 || index + digit * weight > Number.MAX_SAFE_INTEGER)
                    return label;
                index += digit * weight;
                const threshold = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
                if (digit < threshold)
                    break;
                weight *= 36 - threshold;
                if (!Number.isSafeInteger(weight))
                    return label;
            }
            const count = output.length + 1;
            let delta = Math.floor((index - previous) / (previous === 0 ? 700 : 2));
            delta += Math.floor(delta / count);
            let k = 0;
            while (delta > 455) {
                delta = Math.floor(delta / 35);
                k += 36;
            }
            bias = k + Math.floor(36 * delta / (delta + 38));
            n += Math.floor(index / count);
            index %= count;
            if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff))
                return label;
            output.splice(index++, 0, n);
        }
        try {
            return String.fromCodePoint(...output);
        }
        catch {
            return label;
        }
    }
    function normalize(text) {
        // Fold known lookalike vocabulary without partially transliterating real
        // Cyrillic words before the multilingual matcher can recognize them.
        return normalizeExplicitVocabulary(decode(text)).toLowerCase();
    }
    function words(text) {
        // Long undelimited identifiers are metadata, not natural-language slugs.
        if (/^[a-z\d_-]{24,}$/iu.test(text) && !/[-_]/u.test(text) && /\d/u.test(text))
            return [];
        if (/^[a-f\d]{16,}$/iu.test(text) || /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu.test(text))
            return [];
        return normalizeAutomaticExplicitText(normalize(text)).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    }
    function classify(text, previousRoute = "", hostname = false) {
        if (containsMultilingualExplicitText(normalizeAutomaticExplicitText(normalize(text))))
            return "explicit-media";
        const tokens = words(/^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute) ? `${previousRoute} ${text}` : text);
        if (!tokens.length)
            return "";
        const explicit = tokens.find(token => strong.has(token));
        if (explicit)
            return explicit;
        const compact = tokens.join("");
        if (/^(?!rule34\d)(?:p[o0]rn|h[e3]ntai|nsfw|rule34)(?:hub|tube|world|land|zone|site|sites|read|reader|live|free|hd|vr|4k|\d{1,3}|videos?|photos?|pics?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)?$/u.test(compact))
            return compact;
        if (/^(?:free|best|my|the|all|hd|new|daily|live|watch|read|anime|manga|comic|comics|webtoon|3d|vr|4k)(?:porn|hentai|nsfw)$/u.test(compact))
            return compact;
        // X runs only mean explicit content as a deliberate domain label or with
        // media/catalog context. Embedded axxxb IDs and Chapter XXX are untouched.
        if (hostname && /^x{3,}$/u.test(compact))
            return "xxx";
        const mediaAlternatives = "(?:videos?|vids?|photos?|pics?|images?|gifs?|cams?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|novels?|art|galler(?:y|ies))";
        const markerAlternatives = "(?:adults?|mature|uncensored|lewd|erotic|nudes?|naked|sex(?:ual)?|x{3,}|r18|18plus)";
        const compound = new RegExp(`^(?:${markerAlternatives}${mediaAlternatives}|${mediaAlternatives}${markerAlternatives})$`, "u");
        const compoundToken = tokens.find(token => compound.test(token));
        if (compoundToken)
            return compoundToken;
        // R34 also names an ordinary Nissan chassis. Only comic/catalog context
        // supplies an explicit meaning; car photos and videos remain ordinary.
        if (tokens.some(token => /^r34(?:comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?)$/u.test(token))
            || (tokens.includes("r34") && (tokens.some(token => comics.has(token)) || catalog.has(previousRoute))))
            return "r34";
        // A Roman chapter label remains ordinary even when its next route is a
        // gallery. An unrelated medical/research word cannot excuse nude media.
        if (/^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute) && /^x{3,}$/u.test(text))
            return "";
        const marker = tokens.find((token, index) => (weak.has(token) || /^x{3,}$/u.test(token))
            && !(token === "uncensored" && tokens[index + 1] === "interview"))
            || (/(?:^|[^\p{L}\p{N}])18\+(?=$|[^\p{L}\p{N}])/u.test(text) ? "18plus" : "");
        return marker && (tokens.some(token => media.has(token)) || catalog.has(previousRoute)) ? marker : "";
    }
    const labels = url.hostname.toLowerCase().replace(/\.$/u, "").split(".");
    if (["xxx", "porn"].includes(labels.at(-1) || "")) {
        return { component: "hostname", term: labels.at(-1), normalizedText: url.hostname };
    }
    const hostLabels = labels.slice(0, -1).map(label => normalize(unicodeLabel(label)));
    for (const [index, normalizedText] of hostLabels.entries()) {
        const term = classify(normalizedText, "", true);
        if (term)
            return { component: "hostname", term, normalizedText };
        if (weak.has(normalizedText) && media.has(hostLabels[index + 1] || "")) {
            return { component: "hostname", term: normalizedText, normalizedText: `${normalizedText}.${hostLabels[index + 1]}` };
        }
    }
    // Query values, fragments, credentials, ports and deep path identifiers are
    // deliberately excluded. Existing explicit search/custom rules handle them.
    const segments = url.pathname.split(/\/+/u, 6).filter(Boolean).slice(0, 4);
    // Directory separators can delimit the same established ordinary phrase as
    // hyphens. Qualify only that phrase and retain any separate explicit words.
    const routeText = segments.map(segment => normalizeAutomaticExplicitText(normalize(segment.slice(0, 512)))).join(" ");
    const qualifiedRouteText = normalizeAutomaticExplicitText(routeText);
    if (qualifiedRouteText !== routeText) {
        const catalogRoute = segments.map(segment => normalize(segment)).find(segment => catalog.has(segment)) || "";
        const term = classify(qualifiedRouteText, catalogRoute);
        return term ? { component: "path", term, normalizedText: qualifiedRouteText } : null;
    }
    for (let i = 0; i < segments.length; i += 1) {
        const normalizedText = normalize(segments[i].slice(0, 512));
        const previousRoute = i ? normalize(segments[i - 1]) : "";
        const term = classify(normalizedText, previousRoute);
        if (term)
            return { component: "path", term, normalizedText };
        const romanChapter = /^x{3,}$/u.test(normalizedText) && /^(?:chapter|book|section|volume|part|appendix)$/u.test(previousRoute);
        if (!romanChapter && (weak.has(normalizedText) || /^x{3,}$/u.test(normalizedText) || /^18\+$/u.test(normalizedText)
            || (normalizedText === "r34" && comics.has(normalize(segments[i + 1] || ""))))
            && i + 1 < segments.length && words(segments[i + 1]).some(token => media.has(token))) {
            return { component: "path", term: normalizedText, normalizedText };
        }
    }
    return null;
}


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
const explicitHomoglyphs = { "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "і": "i", "у": "y", "α": "a" };
function normalizeExplicitVocabulary(value) {
    let text = String(value || "").normalize("NFKC")
        .replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "")
        .replace(/\p{Script=Latin}\p{M}*/gu, letter => letter.normalize("NFD").replace(/\p{M}/gu, ""));
    text = text.replace(/[\p{L}\p{N}]+/gu, token => {
        const folded = token.toLowerCase().replace(/[аеорсхіуα]/gu, letter => explicitHomoglyphs[letter]);
        return /^(?:naked|nudes?|porn|porno|nsfw|sex|sexual|topless|nakedgirls|nudegirls)$/u.test(folded)
            || explicitSearchKeywordTerms.has(folded) || explicitSearchCompoundPattern.test(folded) ? folded : token;
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
// Qualify only an established ordinary phrase, never a whole query. For
// example, a separate "porn videos" clause survives "pornography blocker".
const EXPLICIT_AUTOMATIC_ORDINARY_PHRASES = [
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
];
const automaticOrdinaryPhrasePatterns = EXPLICIT_AUTOMATIC_ORDINARY_PHRASES.map(pattern => new RegExp(pattern, "giu"));
function normalizeAutomaticExplicitText(value) {
    let text = normalizeExplicitMediaText(value);
    for (const pattern of automaticOrdinaryPhrasePatterns)
        text = text.replace(pattern, " vigilordinary ");
    return text;
}
// Automatic rules use complete vocabulary tokens. User-authored literal URL
// rules retain their separate matching semantics in the policy engine.
const EXPLICIT_SEARCH_KEYWORD_TERMS = [
    "porn", "porno", "prno", "p0rn", "p0rno", "pornography", "pornographic", "nsfw", "hentai", "h3ntai", "rule34",
    "gonewild", "onlyfans", "fansly", "chaturbate", "stripchat", "cam4", "redtube", "youporn", "spankbang",
    "xvideos", "xnxx", "xhamster", "pornhub", "honeytoon", "honeytoons", "hooneytoon", "hooneytoons", "toongod",
    ...ADDITIONAL_EXPLICIT_SEARCH_TERMS
];
const EXPLICIT_SEARCH_COMPOUND_PATTERN = /^(?:porn|porno|p0rn|hentai|h3ntai|nsfw)(?:videos?|vids?|photos?|pics?|images?|gifs?|comics?|manga|manhwa|manhua|webtoons?|doujin(?:shi)?|hub|tube|hd|vr|4k)$/u.source;
const explicitSearchKeywordTerms = new Set(EXPLICIT_SEARCH_KEYWORD_TERMS);
const explicitSearchCompoundPattern = new RegExp(EXPLICIT_SEARCH_COMPOUND_PATTERN, "u");
function containsExplicitSearchKeyword(value) {
    const text = normalizeAutomaticExplicitText(value).toLowerCase();
    const tokens = text.match(/[\p{L}\p{N}]+/gu) || [];
    return tokens.some(token => explicitSearchKeywordTerms.has(token) || explicitSearchCompoundPattern.test(token));
}
const EXPLICIT_SEARCH_ALIAS_PATTERNS = [
    /^\s*(?:nud(?:s|3s?)?|nudes)\s*$/iu.source,
    /(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.source
];
function containsExplicitSearchAliases(value) {
    const text = normalizeAutomaticExplicitText(value);
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
    strongMediaMarker: /^(?:nud|nuds|nudes?|naked|nudity|lewd|erotic|erotica|x{3,})$/u.source,
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
    const tokens = normalizeAutomaticExplicitText(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
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
    const text = normalizeAutomaticExplicitText(value).toLowerCase();
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
        // Exact ordinary phrases were consumed above. An unrelated qualification
        // cannot turn an otherwise clear nude/erotic media request into safe text.
        if (strongMediaMarker.test(token) && nearby.some(word => media.test(word)))
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

// Search text belongs to declared query fields and discovery routes. Do not
// turn arbitrary URL metadata or route scaffolding into apparent search words.
const SEARCH_PARAMETER_NAMES = new Set([
    "q", "query", "searchquery", "search_query", "search", "searchterm", "search_term",
    "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag", "mode"
]);
const AMBIGUOUS_SEARCH_PARAMETER_NAMES = new Set(["p", "k", "s", "mode"]);
// Art categories and product catalogs carry discovery text in the path too;
// direct category links need the same checks as a site's search box.
const SEARCH_ROUTE_CONTEXT_PATTERN = /(?:^|\/)(advancedsearch(?:\.(?:php|json|html|aspx))?|search(?:\.(?:php|json|html|aspx))?|results?|find|browse|tags?|tagged|hashtag|r|tag-[^/?#]+|catalog|products?|items?|collections?|categories?|galler(?:y|ies)|art|all|paintings|photography|drawings|sculpture)(?=\/|$)/iu;
const STRUCTURED_SEARCH_PARAMETER_PATTERN = /^(q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|p|k|s|wd|word|tags|tag)\[(\d*|q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|word|tags|tag)\]$/iu;
function decodeSearchQueryValue(value) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const next = value.replace(/(?:%[a-f0-9]{2})+/giu, run => {
            try {
                return decodeURIComponent(run);
            }
            catch {
                return run.replace(/%([a-f0-9]{2})/giu, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
            }
        });
        if (next === value)
            break;
        value = next;
    }
    // URLSearchParams already decodes query separators. A percent-encoded plus
    // is literal content (for example 18+) and must survive nested decoding.
    return value;
}
function isProtectedSearchParameter(name, onSearchRoute = false) {
    const normalized = decodeSearchQueryValue(name).toLowerCase();
    return (SEARCH_PARAMETER_NAMES.has(normalized) && (!AMBIGUOUS_SEARCH_PARAMETER_NAMES.has(normalized) || onSearchRoute))
        || (onSearchRoute && STRUCTURED_SEARCH_PARAMETER_PATTERN.test(normalized));
}
function searchRoutePath(value) {
    return decodeSearchQueryValue(value.replace(/^#!?/u, "").split("?", 1)[0]);
}
function looksLikeSearchRoute(value) {
    return SEARCH_ROUTE_CONTEXT_PATTERN.test(searchRoutePath(value));
}
function searchRouteText(value) {
    const path = searchRoutePath(value);
    const match = SEARCH_ROUTE_CONTEXT_PATTERN.exec(path);
    if (!match)
        return null;
    // An embedded tag carries its value in the route segment itself. Keep that
    // segment so the existing platform-specific tag-adult rule retains context.
    const start = match[1].toLowerCase().startsWith("tag-")
        ? match.index + match[0].length - match[1].length
        : match.index + match[0].length;
    return path.slice(start).replace(/^\/+|\/+$/gu, "");
}
function searchQueries(value) {
    let url;
    try {
        url = new URL(String(value || ""));
    }
    catch {
        return [];
    }
    if (!["http:", "https:"].includes(url.protocol))
        return [];
    const fragment = url.hash.replace(/^#!?/u, "");
    const pathIsSearch = looksLikeSearchRoute(url.pathname);
    const fragmentIsSearch = looksLikeSearchRoute(fragment);
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
    const protectedParameter = (name) => {
        const normalized = decodeSearchQueryValue(name).toLowerCase();
        // These short field names are ordinary configuration/authentication data
        // elsewhere, but these providers declare their exact discovery meaning.
        const providerField = (normalized === "p" && hostname === "search.yahoo.com")
            || (normalized === "mode" && (hostname === "pixiv.net" || hostname.endsWith(".pixiv.net"))
                && /^\/ranking(?:\.php)?\/?$/u.test(decodeSearchQueryValue(url.pathname).toLowerCase()));
        return isProtectedSearchParameter(name, pathIsSearch || fragmentIsSearch || providerField);
    };
    const queries = [...url.searchParams]
        .filter(([name]) => protectedParameter(name))
        .map(([, query]) => decodeSearchQueryValue(query));
    if (fragmentIsSearch) {
        const queryStart = fragment.indexOf("?");
        if (queryStart >= 0) {
            queries.push(...[...new URLSearchParams(fragment.slice(queryStart + 1))]
                .filter(([name]) => isProtectedSearchParameter(name, true))
                .map(([, query]) => decodeSearchQueryValue(query)));
        }
    }
    for (const route of [url.pathname, fragment]) {
        const text = searchRouteText(route);
        if (text)
            queries.push(text);
    }
    return queries.map(query => ({ query, hostname: url.hostname }));
}

function containsExplicitMediaLabel(value) {
    return containsContextualExplicitMedia(value);
}
// Mixed-use platforms supply context only for search/tag/community navigation.
// Ordinary page prose, unrelated hosts, and generic searches retain their own
// policy. Existing explicit terms and permanently denied sites still apply.
const CONTEXTUAL_SEARCH_PLATFORMS = [
    "reddit.com", "deviantart.com", "artstation.com", "pixiv.net",
    "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com",
    "artmajeur.com", "inkbunny.net", "sofurry.com", "weasyl.com",
    "saatchiart.com", "fineartamerica.com", "flickr.com", "500px.com",
    "pinterest.com", "pinterest.co.uk", "x.com", "twitter.com", "bsky.app",
    "patreon.com", "itch.io", "discord.com", "discordapp.com"
];
const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|fur[\s_-]*affinity|artmajeur|inkbunny|sofurry|weasyl|saatchi[\s_-]*art|fine[\s_-]*art[\s_-]*america|flickr|500px|tumblr|pinterest|twitter|x\.com|bluesky|bsky\.app|patreon|itch\.io|discord)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nud|nuds|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|nsfw|r[\s_-]*18g?|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;
const comicSearchBoundary = "(?:^|[^\\p{L}\\p{N}])";
const comicSearchEnd = "(?:$|[^\\p{L}\\p{N}])";
const comicSearchGenres = "(?:comics?|manga|manhwa|manhua|mawha|webtoons?|doujin(?:shi)?)";
const comicSearchMarker = "(?:adults?|mature|uncensored|lewd|erotic|nsfw|hentai|porn|r18|18(?:\\s*\\+|plus))";
const ageSearchMarker = "(?:18\\s*\\+|18[\\s_-]*plus)";
const ageSearchMedia = "(?:videos?|vids?|photos?|pics?|images?|gifs?|clips?|comics?|manga|manhwa|manhua|webtoons?)";
const EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS = [
    `${comicSearchBoundary}(?:${comicSearchMarker}[\\s_.-]*${comicSearchGenres}|${comicSearchGenres}[\\s_.-]*${comicSearchMarker})${comicSearchEnd}`,
    `${comicSearchBoundary}(?:${ageSearchMarker}[\\s_-]+${ageSearchMedia}|${ageSearchMedia}[\\s_-]+${ageSearchMarker})${comicSearchEnd}`
];
function containsExplicitComicOrAgeSearch(value) {
    return EXPLICIT_COMIC_OR_AGE_SEARCH_PATTERNS.some(pattern => new RegExp(pattern, "iu").test(value));
}
function contextualSearchDecode(value) {
    return normalizeExplicitVocabulary(decodeSearchQueryValue(value));
}
// Bounded aliases and concatenated blocked words; never fuzzy-match arbitrary
// substrings such as Middlesex, nudging, or an alphanumeric product identifier.
function containsExplicitSearchVariants(query) {
    return containsExplicitSearchAliases(normalizeAutomaticExplicitText(contextualSearchDecode(query)));
}
function containsContextualExplicitSearch(query, hostname = "", includeRedditShorthand = true) {
    const decoded = contextualSearchDecode(query);
    // Consume only established ordinary phrases. Separate explicit intent in
    // the same query remains available to the media/alias checks.
    const evidence = normalizeAutomaticExplicitText(decoded);
    if (containsContextualExplicitMedia(evidence))
        return true;
    if (containsExplicitSearchVariants(evidence))
        return true;
    if (containsExplicitComicOrAgeSearch(evidence))
        return true;
    const normalized = evidence.replace(/3/gu, "e").replace(/0/gu, "o");
    const host = hostname.toLowerCase().replace(/\.$/u, "");
    const platform = CONTEXTUAL_SEARCH_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`));
    if ((host === "itch.io" || host.endsWith(".itch.io"))
        && /(?:^|[/#])tag-adult(?:$|[/?.#])/iu.test(decoded))
        return true;
    // Bare x/xx are unsafe Reddit discovery queries, but not general keywords:
    // preserve Xbox, SpaceX, X-Men, ordinary post URLs, and in-progress typing.
    const reddit = host === "reddit.com" || host.endsWith(".reddit.com");
    if (reddit && ((includeRedditShorthand && /^\s*x{1,2}\s*$/iu.test(decoded))
        || /(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])/iu.test(decoded)))
        return true;
    return (platform || CONTEXTUAL_SEARCH_NAMES.test(decoded)) && CONTEXTUAL_SEARCH_MARKERS.test(normalized);
}
function matchContextualExplicitSearchUrl(value) {
    if (searchQueries(value).some(({ query, hostname }) => containsContextualExplicitSearch(query, hostname)))
        return true;
    try {
        const url = new URL(String(value || ""));
        return ["http:", "https:"].includes(url.protocol)
            && [url.pathname, url.hash.split("?", 1)[0]].some(path => containsMultilingualExplicitText(contextualSearchDecode(path)));
    }
    catch {
        return false;
    }
}
// XXX occurs in document IDs, tracking values and Roman numerals. It is only
// an explicit URL signal in actual search text, never an arbitrary URL substring.
function containsExplicitXxxSearchText(query) {
    return /(?:^|[^\p{L}\p{N}])x{3,}(?:$|[^\p{L}\p{N}]|videos?\b|vids?\b|photos?\b|pics?\b|porn\b)/iu.test(normalizeAutomaticExplicitText(contextualSearchDecode(query)));
}
function matchExplicitXxxSearchUrl(value) {
    return searchQueries(value).some(({ query }) => containsExplicitXxxSearchText(query));
}



// SafeSearch being enabled is universal in Vigil. Only a notice about results
// actually removed for this query supplies additional classification evidence.
function isSafeSearchLimitedNotice(value) {
    const text = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (text.length > 600)
        return false;
    // Evidence must be an affirmative result notice, not a substring inside
    // "No results ...", an if-clause, or a help article quoting the notice.
    const notice = text.match(/^(?:(?:(?:explicit|some|search) )?results (?:have been |were |are )?(?:filtered|limited|removed|hidden|blurred) (?:with|by|due to) safe\s?search|safe\s?search (?:has |have )?(?:filtered|limited|removed|hidden|blurred) (?:some |explicit |search )?results)\b/iu);
    if (!notice)
        return false;
    // Google's notices can include their normal explanation/settings links.
    // Other trailing prose can instead describe, negate, or quote this wording.
    const tail = text.slice(notice[0].length).replace(/^[\s.!:;\u2013\u2014-]+/u, "");
    return !tail || /^(?:learn more|(?:change|manage|view|open) (?:your )?(?:safe\s?search )?settings)\b/iu.test(tail);
}
// These already-ambiguous media, exposure and search markers do not become
// standalone bans. A real limited-results notice supplies the missing context.
const SAFE_SEARCH_CONTRIBUTORS = /^(?:photos?|pics?|pictures?|images?|videos?|vids?|movies?|films?|clips?|gifs?|wallpapers?|footage|streams?|livestreams?|webcams?|documentar(?:y|ies)|compilations?|animations?|illustrations?|comics?|manga|audios?|albums?|galler(?:y|ies)|collections?|links?|downloads?|folders?|files?|packs?|mirrors?|adults?|mature|steamy|spicy|uncensored|unfiltered|uncut|nud|nuds|nude|nudes|nued|nudity|naked|topless|bottomless|unclothed|undressed|undressing|stripping|striptease|frontal|erotic|erotica|lewd|horny|sensual|seductive|sexualized|sexualised|raunchy|salacious|lustful|lascivious|risque|risqué|sultry|racy|titillating|arousing|aroused|fetish|fetishes|kinky|kink|bdsm|bondage|sex|sexual|sexually|sexy|hot|explicit|sensitive|intimate|revealing|suggestive|provocative|teasing|tease|thirst|thirsttraps?|nsfl|leak|leaks|leaked|leakd|lek|leks|creampies?|blowjobs?|handjobs?|cumshots?|bukkake|gangbangs?|threesomes?|orgies|orgy|masturbation|masturbating|fucking|penetration|anal|oral|doggystyle|pegging|squirting|sexting|boobs?|boobies|tits?|titties|breasts?|nipples?|butts?|buttocks|asses|ass|booty|cleavage|crotch|genitals?|vulvas?|vaginas?|penis|penises|dicks?|cocks?|pussy|pussies|feet|soles|thighs?|girls?|women|woman|ladies|lady|females?|boys?|men|man|males?|guys?|babes?|models?|celebrity|celebrities|celebs?|actress|actresses|actors?|girlfriends?|boyfriends?|wives|wife|husbands?|couples?|milfs?|dilfs?|waifus?|stepmoms?|stepmothers?|stepsisters?|stepbrothers?|stepdaughters?|amateurs?|cosplayers?|cosplay|furry|furries|doujinshi|lingerie|underwear|bikinis?|swimsuits?|stockings|pantyhose|upskirt|downblouse|x+|18|18g|r18g?|unreviewed|成人|成人向|成人向け|mega|gofile|pixl|cyberdrop|bunkr)$/u;
const SAFE_SEARCH_ORDINARY_CONTEXT = /\b(?:news|biograph(?:y|ies)|interviews?|journalism|research|education|educational|medical|medicine|anatomy|health|history|historical|science|museum|art|drawing|painting|sculpture|makeup|lipstick|recipes?|cooking|baking|chicken|peppers?|software|source code|documentation|security|tutorials?)\b/u;
function safeSearchWords(value) {
    const text = decodeSearchQueryValue(String(value || ""));
    return text.normalize("NFKC").replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "").toLowerCase()
        .replace(/\bcream[\s_\p{Pd}]+pies?\b/gu, "creampie").match(/[\p{L}\p{N}]+/gu) || [];
}
function hasSafeSearchContributor(value) {
    return safeSearchWords(value).some(word => SAFE_SEARCH_CONTRIBUTORS.test(normalizeExplicitVocabulary(word)));
}
function hasOrdinarySafeSearchContext(value) {
    return SAFE_SEARCH_ORDINARY_CONTEXT.test(safeSearchWords(value).map(word => normalizeExplicitVocabulary(word)).join(" "));
}
// Cache exact subjects rather than carrying an unsafe flag to an unrelated
// search. Strip only media/navigation qualifiers, never part of a person's name.
function safeSearchSubject(value) {
    if (hasOrdinarySafeSearchContext(value))
        return "";
    const withoutSites = value.replace(/\bsite:\S+/giu, "");
    const words = safeSearchWords(withoutSites).filter(word => !SAFE_SEARCH_CONTRIBUTORS.test(normalizeExplicitVocabulary(word))
        && !/^(?:a|an|the|and|of|for|in|on|with|free|full|hd|official|nz|io|com|it)$/u.test(word));
    return words.length >= 1 && words.length <= 6 && words.join(" ").length >= 4 ? words.join(" ") : "";
}
function matchesSafeSearchSubject(value, subject) {
    const text = ` ${safeSearchWords(value).join(" ")} `;
    return Boolean(subject && text.includes(` ${subject} `));
}
function sharedFileDestination(value, baseUrl) {
    let url;
    try {
        url = new URL(value, baseUrl);
    }
    catch {
        return null;
    }
    if (!["https:", "http:"].includes(url.protocol))
        return null;
    const host = url.hostname.toLowerCase().replace(/\.$/u, "");
    const onHost = (domain) => host === domain || host.endsWith(`.${domain}`);
    if ((onHost("mega.nz") || onHost("mega.io")) && /^\/(?:folder|file)\//u.test(url.pathname))
        return url.href;
    if (onHost("gofile.io") && /^\/d\//u.test(url.pathname))
        return url.href;
    if (onHost("drive.google.com") && /^\/(?:file\/d|drive\/folders)\//u.test(url.pathname))
        return url.href;
    if (onHost("dropbox.com") && /^\/(?:s|sh|scl)\//u.test(url.pathname))
        return url.href;
    if (["pixl.li", "cyberdrop.me", "cyberdrop.to", "bunkr.is", "bunkr.si", "bunkr.ru", "erome.com"].some(onHost)
        && /^\/(?:a|album|f|v)\//u.test(url.pathname))
        return url.href;
    return null;
}
function isAdultMediaDestination(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/\.$/u, "");
        return ["http:", "https:"].includes(url.protocol)
            && (host === "erome.com" || host.endsWith(".erome.com")) && /^\/a\//u.test(url.pathname);
    }
    catch {
        return false;
    }
}
function isExplicitLinkCollection(destinations, safeSearchEvidence) {
    const files = [...new Set(destinations.map(value => sharedFileDestination(value)).filter((value) => Boolean(value)))];
    // Neither cloud storage nor link density alone establishes adult content.
    return files.length >= 2 && (safeSearchEvidence || files.some(isAdultMediaDestination));
}

function guardBlockedPageURL() {
    try {
        const target = vigilBlockedSearchURL();
        return typeof target === "string" && target ? target : "about:blank";
    }
    catch {
        return "about:blank";
    }
}
const GOOGLE_SEARCH_HOSTNAMES = new Set(["google.com", "www.google.com", "images.google.com"]);
const PERSON_EXPOSURE_MARKERS = new Set([
    "leak", "leaks", "leaked", "leakd", "lek", "leks",
    "nud", "nuds", "nude", "nudes", "nued", "naked", "topless"
]);
const PERSON_INTIMATE_CONTEXT = new Set([
    "explicit", "fansly", "intimate", "nsfw", "nude", "nudes", "naked",
    "onlyfans", "porn", "porno", "sex", "sextape", "topless", "xxx"
]);
const PERSON_LEAK_CONTEXT = new Set([
    "air", "api", "app", "apps", "classified", "code", "command", "court",
    "data", "database", "document", "documents", "email", "emails", "episode",
    "episodes", "fc", "film", "films", "game", "games", "gas", "government",
    "guide", "iphone", "javascript", "memory", "movie", "movies", "news", "oil",
    "papers", "password", "passwords", "phone", "pipeline", "pixel", "product",
    "products", "release", "releases", "report", "reports", "roof", "roster",
    "rumor", "rumors", "samsung", "security", "software", "source", "sources",
    "spec", "specs", "team", "transfer", "transfers", "tutorial", "tv", "water"
]);
const PERSON_NUDE_CONTEXT = new Set([
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
const PERSON_NAME_FILLER_WORDS = new Set([
    "a", "an", "and", "at", "for", "from", "in", "of", "on", "or", "the", "to", "with"
]);
const SEARCH_DESCRIPTOR_PATTERN = /(?:^|[-_\s])(?:search|query|keyword)(?:$|[-_\s])/iu;
let lastInspectedSearchUrl = location.href;
const SAFE_SEARCH_EVIDENCE_KEY = "vigil-safe-search-subjects-v1";
const SAFE_SEARCH_SUBJECT_KEY_PREFIX = `${SAFE_SEARCH_EVIDENCE_KEY}:`;
const SAFE_SEARCH_EVIDENCE_LIFETIME_MS = 30 * 60 * 1000;
const safeSearchSubjects = new Map();
let safeSearchEvidenceUrl = "";
let safeSearchEvidenceAt = 0;
let embeddedPolicyGeneration = 0;
let embeddedPolicyCheckedAt = 0;
let embeddedPolicyPendingUrl = "";
let embeddedPolicyDeadline = null;
let embeddedPolicyObserver = null;
const embeddedPolicyPreviousDisplays = new Map();
let embeddedPolicyAwaiting = false;
let embeddedPolicyMediaGuardInstalled = false;
const embeddedPolicyPausedMedia = new Set();
function explicitSearchBlockRedirect(rawUrl, baseUrl = location.href) {
    let url;
    try {
        url = new URL(rawUrl, baseUrl);
    }
    catch {
        return null;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        return null;
    if (matchSemanticExplicitUrl(url.href))
        return guardBlockedPageURL();
    if (matchContextualExplicitSearchUrl(url))
        return guardBlockedPageURL();
    if (searchQueries(url).some(({ query }) => containsExplicitSearchText(query, url.hostname)))
        return guardBlockedPageURL();
    return null;
}
function containsExplicitSearchText(rawValue, hostname = new URL(location.href).hostname, includeRedditShorthand = true) {
    const decoded = decodeNestedSearchValue(rawValue);
    return containsExplicitSearchKeyword(decoded)
        || containsContextualExplicitSearch(decoded, hostname, includeRedditShorthand)
        || containsExplicitXxxSearchText(decoded)
        || containsExplicitPersonSearchText(decoded)
        || (hasSafeSearchContributor(decoded) && (hasSavedSafeSearchSubject(decoded)
            || (hasCurrentSafeSearchEvidence() && sameSafeSearchQuery(decoded, currentGoogleSearchQuery()))));
}
function currentGoogleSearchQuery() {
    try {
        const url = new URL(location.href);
        return ["http:", "https:"].includes(url.protocol)
            && GOOGLE_SEARCH_HOSTNAMES.has(url.hostname.toLowerCase().replace(/\.$/u, ""))
            && url.pathname === "/search" ? url.searchParams.get("q") || "" : "";
    }
    catch {
        return "";
    }
}
function hasSavedSafeSearchSubject(value) {
    const subject = safeSearchSubject(value);
    const observedAt = safeSearchSubjects.get(subject) || 0;
    return Boolean(subject && observedAt > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS && observedAt <= Date.now());
}
function hasCurrentSafeSearchEvidence() {
    const now = Date.now();
    return safeSearchEvidenceUrl === location.href && safeSearchEvidenceAt > now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
        && safeSearchEvidenceAt <= now;
}
function sameSafeSearchQuery(first, second) {
    const normalize = (value) => decodeNestedSearchValue(value).normalize("NFKC")
        .replace(/\+/gu, " ").replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
    return Boolean(second && normalize(first) === normalize(second));
}
function safeSearchContextStorage() {
    const api = globalThis.browser || globalThis.chrome;
    return api?.storage?.local;
}
function safeSearchSubjectStorageKey(subject, observedAt) {
    return `${SAFE_SEARCH_SUBJECT_KEY_PREFIX}${Math.floor(observedAt / SAFE_SEARCH_EVIDENCE_LIFETIME_MS)}:${encodeURIComponent(subject)}`;
}
function rememberSafeSearchSubject(query) {
    if (hasCurrentSafeSearchEvidence())
        return;
    safeSearchEvidenceUrl = location.href;
    safeSearchEvidenceAt = Date.now();
    const subject = safeSearchSubject(query);
    // The current search is enforceable even when it consists only of an
    // ambiguous word or has ordinary context. Subject caching is more selective.
    if (!subject)
        return;
    safeSearchSubjects.set(subject, safeSearchEvidenceAt);
    // Each subject has its own key so a tab's stale snapshot cannot erase
    // evidence observed by another tab. Buckets allow safe expiry cleanup.
    const key = safeSearchSubjectStorageKey(subject, safeSearchEvidenceAt);
    try {
        void safeSearchContextStorage()?.set({ [key]: { subject, observedAt: safeSearchEvidenceAt } }).catch(() => { });
    }
    catch { /* In-memory enforcement remains available without extension storage. */ }
}
function visibleContextElement(element) {
    if (element.closest("[hidden], [aria-hidden='true']"))
        return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}
function observeSafeSearchNotice() {
    const query = currentGoogleSearchQuery();
    if (!query)
        return;
    const excludedText = "#rso, article, h3, pre, code, blockquote, q, figcaption";
    const candidates = new Set(document.querySelectorAll("[role='alert'], [role='status'], [role='dialog'], [aria-live], #taw, #taw *, #topstuff, #topstuff *, #botstuff, #botstuff *"));
    for (const link of document.querySelectorAll("a[href*='safesearch' i]")) {
        let parent = link;
        for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement)
            candidates.add(parent);
    }
    for (const candidate of candidates) {
        // Search snippets, quoted documentation and hidden settings are not notices.
        if (candidate.closest(`${excludedText}, a`) || candidate.querySelector("h3") || !visibleContextElement(candidate))
            continue;
        let resultCard = false;
        for (let parent = candidate.parentElement; parent && parent !== document.body && parent !== document.documentElement
            && !["search", "topstuff", "botstuff", "taw"].includes(parent.id); parent = parent.parentElement) {
            if (parent.querySelector("a h3")) {
                resultCard = true;
                break;
            }
        }
        if (resultCard)
            continue;
        let notice = "";
        const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node && notice.length <= 600; node = walker.nextNode()) {
            if (node.parentElement && !node.parentElement.closest(excludedText)
                && visibleContextElement(node.parentElement))
                notice += `${node.textContent || ""} `;
        }
        if (isSafeSearchLimitedNotice(notice)) {
            rememberSafeSearchSubject(query);
            return;
        }
    }
}
function readerContextRoots() {
    const host = new URL(location.href).hostname.toLowerCase();
    if (host === "scribd.com" || host.endsWith(".scribd.com")) {
        // Use the document's text layer, excluding suggested documents in sidebars.
        const roots = Array.from(document.querySelectorAll(".text_layer, .document_scroller, [data-testid='document-viewer'], [role='document']"));
        return roots.filter(root => !roots.some(other => other !== root && other.contains(root)));
    }
    const root = document.querySelector("#article, article, [role='document'], main, #content");
    const pasteHost = ["justpaste.it", "pastebin.com", "paste.ee", "rentry.co", "rentry.org", "telegra.ph"]
        .some(domain => host === domain || host.endsWith(`.${domain}`));
    return root ? [root] : (pasteHost && document.body ? [document.body] : []);
}
function readerFileDestinations(roots) {
    const files = new Set();
    for (const root of roots) {
        const excluded = "nav, header, footer, aside, [role='navigation'], [role='complementary']";
        for (const anchor of root.querySelectorAll("a[href]")) {
            if (anchor.closest(excluded))
                continue;
            const file = sharedFileDestination(anchor.href, location.href);
            if (file)
                files.add(file);
        }
        // PDFs and pastes can expose URLs as text instead of clickable anchors.
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest(`${excluded}, script, style, noscript`))
                continue;
            for (const url of (node.textContent || "").match(/https?:\/\/[^\s<>"']+/gu) || []) {
                const file = sharedFileDestination(url.replace(/[),.;]+$/u, ""));
                if (file)
                    files.add(file);
            }
        }
    }
    return [...files];
}
function contextualLinkIsBlocked(anchor) {
    const query = currentGoogleSearchQuery();
    const label = [anchor.textContent, anchor.getAttribute("title"), anchor.getAttribute("aria-label")].filter(Boolean).join(" ");
    const file = sharedFileDestination(anchor.href, location.href);
    if (query && hasCurrentSafeSearchEvidence() && (hasSafeSearchContributor(label) || file))
        return true;
    if (hasOrdinarySafeSearchContext(label) || (!query && hasOrdinarySafeSearchContext(document.title)))
        return false;
    if (query && hasSavedSafeSearchSubject(query) && (hasSafeSearchContributor(label) || file))
        return true;
    return [...safeSearchSubjects].some(([subject, at]) => at > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
        && at <= Date.now() && matchesSafeSearchSubject(label, subject) && hasSafeSearchContributor(label));
}
function redirectAfterSearchWarning(target, navigation = "replace") {
    const navigate = () => location[navigation](target);
    const pending = checkSearchBreakBeforeNavigation();
    if (!pending) {
        navigate();
        return;
    }
    const source = location.href;
    // Give the background time to validate and record the warning while its
    // current-tab URL still matches. An unavailable authority cannot suspend
    // the content block indefinitely.
    let timeout;
    const deadline = new Promise(resolve => { timeout = setTimeout(() => resolve(false), 1000); });
    void Promise.race([pending, deadline]).then(blocked => {
        clearTimeout(timeout);
        if (!blocked && location.href === source)
            navigate();
    });
}
function scanSafeSearchContext() {
    observeSafeSearchNotice();
    // Cached evidence can arrive after the initial URL/control checks on any
    // search provider, including pages whose URLs do not change afterward.
    const redirect = explicitSearchBlockRedirect(location.href);
    if (redirect) {
        redirectAfterSearchWarning(redirect);
        return;
    }
    if (scanExistingSearchControls(document))
        return;
    const query = currentGoogleSearchQuery();
    if (query) {
        if ((hasCurrentSafeSearchEvidence() || hasSavedSafeSearchSubject(query)) && hasSafeSearchContributor(query)) {
            redirectAfterSearchWarning(guardBlockedPageURL());
            return;
        }
    }
    else {
        const roots = readerContextRoots();
        const title = `${document.title} ${document.querySelector("h1")?.textContent || ""}`;
        const evidence = !hasOrdinarySafeSearchContext(title) && [...safeSearchSubjects].some(([subject, at]) => at > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
            && at <= Date.now() && matchesSafeSearchSubject(title, subject));
        if (!hasOrdinarySafeSearchContext(title) && isExplicitLinkCollection(readerFileDestinations(roots), evidence)) {
            redirectAfterSearchWarning(guardBlockedPageURL());
            return;
        }
    }
}
function installSafeSearchContextGuard() {
    if (typeof document === "undefined")
        return;
    let scanPending = false;
    const scheduleScan = () => {
        if (scanPending)
            return;
        scanPending = true;
        setTimeout(() => { scanPending = false; scanSafeSearchContext(); }, 100);
    };
    const start = () => {
        scanSafeSearchContext();
        if (typeof MutationObserver === "function" && document.documentElement) {
            new MutationObserver(scheduleScan).observe(document.documentElement, {
                childList: true, subtree: true, characterData: true, attributes: true,
                attributeFilter: ["href", "hidden", "aria-hidden", "role", "class", "style"]
            });
        }
    };
    if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", start, { once: true });
    else
        start();
    function mergeEvidence(result) {
        const now = Date.now();
        for (const [subject, at] of safeSearchSubjects) {
            if (at <= now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS || at > now)
                safeSearchSubjects.delete(subject);
        }
        const candidates = [];
        const saved = result[SAFE_SEARCH_EVIDENCE_KEY];
        if (saved && typeof saved === "object") {
            // Retain evidence written by previous versions during migration.
            candidates.push(...Object.entries(saved));
        }
        const expiredKeys = [];
        const oldestBucket = Math.floor((now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS) / SAFE_SEARCH_EVIDENCE_LIFETIME_MS);
        for (const [key, entry] of Object.entries(result)) {
            if (!key.startsWith(SAFE_SEARCH_SUBJECT_KEY_PREFIX) || !entry || typeof entry !== "object")
                continue;
            const { subject, observedAt } = entry;
            if (typeof subject !== "string" || typeof observedAt !== "number"
                || key !== safeSearchSubjectStorageKey(subject, observedAt))
                continue;
            candidates.push([subject, observedAt]);
            // No current observation can write to a completely expired bucket,
            // including a renewal of the same subject in another tab.
            if (Math.floor(observedAt / SAFE_SEARCH_EVIDENCE_LIFETIME_MS) < oldestBucket)
                expiredKeys.push(key);
        }
        const valid = candidates.filter((entry) => typeof entry[1] === "number"
            && entry[1] <= now && entry[1] > now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
            && safeSearchSubject(entry[0]) === entry[0]).sort((a, b) => b[1] - a[1]);
        for (const [subject, at] of valid) {
            if (!safeSearchSubjects.has(subject) && safeSearchSubjects.size >= 64)
                continue;
            safeSearchSubjects.set(subject, Math.max(at, safeSearchSubjects.get(subject) || 0));
        }
        return expiredKeys;
    }
    async function loadEvidence() {
        try {
            const storage = safeSearchContextStorage();
            const result = await storage?.get(null);
            if (!result)
                return;
            const expiredKeys = mergeEvidence(result);
            if (expiredKeys.length)
                void storage?.remove(expiredKeys).catch(() => { });
            scheduleScan();
        }
        catch { /* Local page evidence still enforces this rule. */ }
    }
    try {
        const api = globalThis.browser || globalThis.chrome;
        // Subscribe before loading the snapshot so observations from other tabs
        // cannot be missed while the initial storage read is pending.
        api?.storage?.onChanged?.addListener((changes, area) => {
            if (area !== "local")
                return;
            const evidence = {};
            for (const [key, change] of Object.entries(changes)) {
                if ((key === SAFE_SEARCH_EVIDENCE_KEY || key.startsWith(SAFE_SEARCH_SUBJECT_KEY_PREFIX))
                    && change.newValue !== undefined)
                    evidence[key] = change.newValue;
            }
            if (!Object.keys(evidence).length)
                return;
            mergeEvidence(evidence);
            scheduleScan();
        });
    }
    catch { /* Local page evidence still enforces this rule. */ }
    void loadEvidence();
    addEventListener("popstate", scheduleScan, true);
    addEventListener("hashchange", scheduleScan, true);
}
function containsExplicitPersonSearchText(rawValue) {
    const query = normalizeExplicitMediaText(decodeNestedSearchValue(rawValue).replace(/\+/gu, " "));
    const tokens = query.match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)
        ?.map(token => token.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, ""))
        .filter(Boolean) || [];
    if (tokens.length < 2)
        return false;
    const normalized = tokens.map(token => token.toLocaleLowerCase("en-US"));
    const markerIndex = normalized.findIndex(token => PERSON_EXPOSURE_MARKERS.has(token));
    if (markerIndex < 0)
        return false;
    const marker = normalized[markerIndex];
    const ordinaryContext = ["leak", "leaks", "leaked", "leakd", "lek", "leks"].includes(marker)
        ? PERSON_LEAK_CONTEXT
        : PERSON_NUDE_CONTEXT;
    if (normalized.some((token, index) => index !== markerIndex && PERSON_INTIMATE_CONTEXT.has(token)))
        return true;
    if (marker === "naked" && /(?:^|[^\p{L}\p{N}])naked[\s_-]+(?:eye|cakes?)(?=$|[^\p{L}\p{N}])/iu.test(query))
        return false;
    const possibleNameTokens = tokens.filter((_token, index) => (index !== markerIndex
        && !PERSON_NAME_FILLER_WORDS.has(normalized[index])
        && !ordinaryContext.has(normalized[index])));
    if (possibleNameTokens.length >= 2
        && possibleNameTokens.some(startsWithUppercaseLetter))
        return true;
    if (normalized.some(token => ordinaryContext.has(token)))
        return false;
    const structuralName = normalized.filter((token, index) => (index !== markerIndex && !PERSON_NAME_FILLER_WORDS.has(token)));
    return structuralName.length >= 2 && structuralName.length <= 4
        && structuralName.every(token => (token.length >= 2
            && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(token)));
}
function startsWithUppercaseLetter(value) {
    const first = value.match(/[\p{L}]/u)?.[0] || "";
    return Boolean(first && first === first.toLocaleUpperCase("en-US") && first !== first.toLocaleLowerCase("en-US"));
}
function decodeNestedSearchValue(rawValue) {
    return decodeSearchQueryValue(rawValue);
}
function googleSafeSearchRedirect(rawUrl, baseUrl = location.href) {
    let url;
    try {
        url = new URL(rawUrl, baseUrl);
    }
    catch {
        return null;
    }
    const hostname = url.hostname.toLowerCase();
    if ((url.protocol !== "http:" && url.protocol !== "https:")
        || !GOOGLE_SEARCH_HOSTNAMES.has(hostname)
        || url.pathname !== "/search")
        return null;
    if (url.searchParams.get("safe") === "active")
        return null;
    url.searchParams.set("safe", "active");
    return url.href;
}
function alwaysOnSearchRedirect(rawUrl, baseUrl = location.href) {
    return explicitSearchBlockRedirect(rawUrl, baseUrl) ?? googleSafeSearchRedirect(rawUrl, baseUrl);
}
function enforceGoogleSafeSearchForCurrentNavigation() {
    lastInspectedSearchUrl = location.href;
    const redirect = alwaysOnSearchRedirect(location.href);
    if (redirect && redirect !== location.href) {
        location.replace(redirect);
        return;
    }
    checkEmbeddedFramePolicy();
}
function checkEmbeddedFramePolicy() {
    // Safari keeps its supervised BuiltIn filter and bundled all-frame guard.
    // Chrome can additionally ask its local companion for long-tail domains
    // omitted from the capacity-limited dynamic rules, without moving the parent.
    if (globalThis.top === globalThis.self || !/^https?:\/\//u.test(location.href))
        return;
    const api = globalThis.browser || globalThis.chrome;
    try {
        const origin = api?.runtime?.getURL("");
        if (origin?.startsWith("safari-web-extension:"))
            return;
        if (!origin?.startsWith("chrome-extension:") || !api.runtime.sendMessage)
            throw new Error("Frame policy authority unavailable");
    }
    catch {
        concealEmbeddedPolicyDocument();
        location.replace("about:blank");
        return;
    }
    const url = location.href;
    if (embeddedPolicyPendingUrl === url)
        return;
    if (lastInspectedSearchUrl === url && Date.now() - embeddedPolicyCheckedAt < 5_000)
        return;
    embeddedPolicyPendingUrl = url;
    embeddedPolicyCheckedAt = Date.now();
    const generation = ++embeddedPolicyGeneration;
    concealEmbeddedPolicyDocument();
    if (embeddedPolicyDeadline !== null)
        clearTimeout(embeddedPolicyDeadline);
    let closed = false;
    const current = () => !closed && generation === embeddedPolicyGeneration && location.href === url;
    const close = () => {
        if (!current())
            return;
        closed = true;
        if (embeddedPolicyDeadline !== null)
            clearTimeout(embeddedPolicyDeadline);
        embeddedPolicyDeadline = null;
        embeddedPolicyPendingUrl = "";
        location.replace(guardBlockedPageURL());
    };
    embeddedPolicyDeadline = setTimeout(close, 3_000);
    const request = () => {
        if (!current())
            return;
        try {
            const requestResult = api.runtime.sendMessage({ type: "VIGIL_EMBEDDED_FRAME_CHECK", url }).then(result => {
                if (!current())
                    return;
                if (result?.stale === true || result?.skipped === true) {
                    // Chrome can briefly report no frame at document_start. Keep it
                    // concealed while retrying, under the original bounded deadline.
                    setTimeout(request, 50);
                    return;
                }
                if (result?.ok !== true || result.blocked !== false) {
                    close();
                    return;
                }
                if (embeddedPolicyDeadline !== null)
                    clearTimeout(embeddedPolicyDeadline);
                embeddedPolicyDeadline = null;
                embeddedPolicyPendingUrl = "";
                releaseEmbeddedPolicyDocument();
            });
            void requestResult.catch(close);
        }
        catch {
            close();
        }
    };
    request();
}
function concealEmbeddedPolicyDocument() {
    embeddedPolicyAwaiting = true;
    if (typeof document === "undefined")
        return;
    const conceal = () => {
        const root = document.documentElement;
        if (!root)
            return;
        if (!embeddedPolicyPreviousDisplays.has(root))
            embeddedPolicyPreviousDisplays.set(root, {
                value: root.style.getPropertyValue("display"), priority: root.style.getPropertyPriority("display")
            });
        if (root.style.getPropertyValue("display") !== "none" || root.style.getPropertyPriority("display") !== "important") {
            root.style.setProperty("display", "none", "important");
        }
    };
    conceal();
    for (const media of document.querySelectorAll("video, audio")) {
        if (!media.paused) {
            embeddedPolicyPausedMedia.add(media);
            media.pause();
        }
    }
    if (!embeddedPolicyObserver && typeof MutationObserver === "function") {
        embeddedPolicyObserver = new MutationObserver(conceal);
        embeddedPolicyObserver.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    }
    if (!embeddedPolicyMediaGuardInstalled && typeof document.addEventListener === "function") {
        embeddedPolicyMediaGuardInstalled = true;
        document.addEventListener("play", event => {
            if (embeddedPolicyAwaiting && event.target instanceof HTMLMediaElement)
                event.target.pause();
        }, true);
    }
}
function releaseEmbeddedPolicyDocument() {
    embeddedPolicyAwaiting = false;
    embeddedPolicyObserver?.disconnect();
    embeddedPolicyObserver = null;
    for (const [root, previous] of embeddedPolicyPreviousDisplays) {
        if (previous.value)
            root.style.setProperty("display", previous.value, previous.priority);
        else
            root.style.removeProperty("display");
    }
    embeddedPolicyPreviousDisplays.clear();
    // Resume only playback this veil interrupted, after a fresh authoritative
    // allow. A site's new autoplay attempts made while pending stay paused.
    for (const media of embeddedPolicyPausedMedia) {
        if (media.isConnected && media.paused)
            void media.play().catch(() => { });
    }
    embeddedPolicyPausedMedia.clear();
}
function enforceGoogleSafeSearchForLink(event) {
    if (enforceExplicitSearchControlInteraction(event))
        return;
    const target = eventTargetElement(event);
    if (!target)
        return;
    const anchor = target.closest("a[href]");
    if (!anchor)
        return;
    observeSafeSearchNotice();
    const label = [anchor.textContent, anchor.getAttribute("title"), anchor.getAttribute("aria-label")].filter(Boolean).join(" ");
    if (containsExplicitMediaLabel(label) || contextualLinkIsBlocked(anchor)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        redirectAfterSearchWarning(guardBlockedPageURL(), "assign");
        return;
    }
    const redirect = alwaysOnSearchRedirect(anchor.href);
    if (!redirect || redirect === anchor.href)
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    redirectAfterSearchWarning(redirect, "assign");
}
function enforceGoogleSafeSearchForForm(event) {
    const form = event.target;
    if (!(form instanceof HTMLFormElement))
        return;
    const submitter = event.submitter;
    const method = submitter?.hasAttribute("formmethod") === true
        ? submitter.formMethod
        : form.method || "get";
    const action = submitter?.hasAttribute("formaction") === true
        ? submitter.formAction
        : form.action || location.href;
    let target;
    try {
        target = new URL(action, location.href);
    }
    catch {
        return;
    }
    const fields = formDataEntries(form, submitter);
    const explicitFormSearch = explicitSearchTextFromForm(form, fields);
    const directBlock = explicitSearchBlockRedirect(target.href);
    if (explicitFormSearch || directBlock) {
        event.preventDefault();
        event.stopImmediatePropagation();
        redirectAfterSearchWarning(guardBlockedPageURL(), "assign");
        return;
    }
    if (method.toLowerCase() !== "get")
        return;
    target.search = "";
    for (const [name, value] of fields)
        target.searchParams.append(name, value);
    const redirect = alwaysOnSearchRedirect(target.href);
    if (!redirect || redirect === target.href)
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    redirectAfterSearchWarning(redirect, "assign");
}
function formDataEntries(form, submitter) {
    let fields;
    try {
        fields = submitter ? new FormData(form, submitter) : new FormData(form);
    }
    catch {
        fields = new FormData(form);
    }
    return [...fields].map(([name, value]) => [name, typeof value === "string" ? value : value.name]);
}
function explicitSearchTextFromForm(form, fields) {
    const formIsSearch = elementLooksLikeSearchContainer(form)
        || looksLikeSearchRoute(form.action || "");
    if (fields.some(([name, value]) => (isProtectedSearchParameter(name, formIsSearch)
        && containsExplicitSearchText(value))))
        return true;
    const controls = form.elements ? Array.from(form.elements) : [];
    return controls.some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)));
}
function enforceExplicitSearchControlInteraction(event) {
    if (event.type === "keydown" && event.key !== "Enter")
        return false;
    const target = eventTargetElement(event);
    if (!target)
        return false;
    // Short Reddit queries are checked on activation, not while typing Xbox.
    const activating = event.type === "keydown";
    let blocked = isSearchControl(target) && containsExplicitSearchText(searchControlValue(target), undefined, activating);
    if (!blocked && event.type === "click" && isSearchActivationControl(target)) {
        const container = target.closest("form, [role='search'], [data-search], [class*='search' i], [id*='search' i]");
        blocked = Boolean(container && explicitSearchTextInContainer(container));
    }
    if (!blocked)
        return false;
    if (event.cancelable)
        event.preventDefault();
    event.stopImmediatePropagation();
    redirectAfterSearchWarning(guardBlockedPageURL(), "assign");
    return true;
}
function eventTargetElement(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    const pathElement = path.find((item) => item instanceof Element);
    return pathElement || (event.target instanceof Element ? event.target : null);
}
function isSearchControl(value) {
    if (!(value instanceof Element))
        return false;
    const tagName = String(value.tagName || "").toLowerCase();
    const editable = value.isContentEditable === true;
    if (!editable && tagName !== "input" && tagName !== "textarea")
        return false;
    const type = (value.getAttribute("type") || "").toLowerCase();
    // Tracking fields, checkboxes and submit labels are not user search text.
    // Real hidden query fields are still checked through URL/submission policy.
    if (tagName === "input" && !["", "text", "search"].includes(type))
        return false;
    if (value.closest("[hidden], [aria-hidden='true']") || value.getAttribute("disabled") !== null)
        return false;
    if (typeof getComputedStyle === "function") {
        const style = getComputedStyle(value);
        if (style.display === "none" || style.visibility === "hidden")
            return false;
    }
    const role = (value.getAttribute("role") || "").toLowerCase();
    const descriptor = [
        value.getAttribute("name"), value.getAttribute("id"), value.getAttribute("aria-label"),
        value.getAttribute("placeholder"), value.getAttribute("data-testid")
    ].filter(Boolean).join(" ");
    return type === "search" || role === "searchbox"
        || isProtectedSearchParameter(value.getAttribute("name") || "")
        || SEARCH_DESCRIPTOR_PATTERN.test(descriptor)
        || Boolean(value.closest("[role='search'], form[action*='search' i], form[action*='find' i]"));
}
function searchControlValue(value) {
    if (!(value instanceof Element))
        return "";
    const controlValue = value.value;
    return typeof controlValue === "string" ? controlValue : String(value.textContent || "");
}
function isSearchActivationControl(value) {
    const tagName = String(value.tagName || "").toLowerCase();
    if (tagName !== "button" && !(tagName === "input" && ["button", "submit", "image"].includes((value.getAttribute("type") || "").toLowerCase()))) {
        return false;
    }
    const descriptor = [value.textContent, value.getAttribute("aria-label"), value.getAttribute("title"), value.getAttribute("id")]
        .filter(Boolean).join(" ");
    return /search|find/iu.test(descriptor) || Boolean(value.closest("[role='search']"));
}
function elementLooksLikeSearchContainer(value) {
    const descriptor = [
        value.getAttribute?.("role"), value.getAttribute?.("aria-label"),
        value.getAttribute?.("id"), value.getAttribute?.("class")
    ].filter(Boolean).join(" ");
    return /(?:^|[-_\s])search(?:$|[-_\s])/iu.test(descriptor);
}
function explicitSearchTextInContainer(container, includeRedditShorthand = true) {
    const controls = container.querySelectorAll?.("input, textarea, [contenteditable='true'], [role='searchbox']") || [];
    return Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control), undefined, includeRedditShorthand));
}
function scanExistingSearchControls(root) {
    const controls = root.querySelectorAll?.("input[type='search'], [role='searchbox'], input[name], textarea[name], [contenteditable='true']") || [];
    if (Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control), undefined, false))) {
        redirectAfterSearchWarning(guardBlockedPageURL());
        return true;
    }
    return false;
}
function installDynamicSearchGuard() {
    if (typeof document === "undefined")
        return;
    if (containsExplicitMediaLabel(document.title)) {
        redirectAfterSearchWarning(guardBlockedPageURL());
        return;
    }
    scanExistingSearchControls(document);
    if (typeof MutationObserver !== "function" || !document.documentElement)
        return;
    new MutationObserver((records) => {
        if (containsExplicitMediaLabel(document.title)) {
            redirectAfterSearchWarning(guardBlockedPageURL());
            return;
        }
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) {
                    if ((isSearchControl(node) && containsExplicitSearchText(searchControlValue(node), undefined, false))
                        || explicitSearchTextInContainer(node, false)) {
                        redirectAfterSearchWarning(guardBlockedPageURL());
                        return;
                    }
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}
function checkForSearchUrlChange() {
    if (lastInspectedSearchUrl === location.href) {
        checkEmbeddedFramePolicy();
        return;
    }
    // A previous URL's pending decision cannot authorize or block this document.
    embeddedPolicyCheckedAt = 0;
    enforceGoogleSafeSearchForCurrentNavigation();
    if (typeof document !== "undefined")
        scanSafeSearchContext();
}
addEventListener("click", enforceGoogleSafeSearchForLink, true);
addEventListener("auxclick", enforceGoogleSafeSearchForLink, true);
addEventListener("contextmenu", enforceGoogleSafeSearchForLink, true);
addEventListener("submit", enforceGoogleSafeSearchForForm, true);
addEventListener("input", enforceExplicitSearchControlInteraction, true);
addEventListener("change", enforceExplicitSearchControlInteraction, true);
addEventListener("keydown", enforceExplicitSearchControlInteraction, true);
addEventListener("popstate", checkForSearchUrlChange, true);
addEventListener("hashchange", checkForSearchUrlChange, true);
globalThis.setInterval?.(checkForSearchUrlChange, 250);
enforceGoogleSafeSearchForCurrentNavigation();
installDynamicSearchGuard();
installSafeSearchContextGuard();

})();
