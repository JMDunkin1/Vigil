/* eslint-disable no-unused-vars -- Shared desktop matcher includes helpers unused by this entry point. */
// Generated from the desktop search guard; run the generator after npm run build.
(() => {
// Mixed-use platforms supply context only for search/tag/community navigation.
// Ordinary page prose, unrelated hosts, and generic searches retain their own
// policy. Existing explicit terms and permanently denied sites still apply.
const CONTEXTUAL_SEARCH_PLATFORMS = [
    "reddit.com", "deviantart.com", "artstation.com", "pixiv.net",
    "behance.net", "newgrounds.com", "furaffinity.net", "tumblr.com",
    "pinterest.com", "pinterest.co.uk"
];
const CONTEXTUAL_SEARCH_NAMES = /(?:^|[^\p{L}\p{N}])(?:reddit|deviantart|artstation|pixiv|behance|newgrounds|furaffinity|tumblr|pinterest)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_MARKERS = /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu;
const CONTEXTUAL_SEARCH_PARAMETERS = new Set([
    "q", "query", "search_query", "search", "searchterm", "search_term",
    "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag"
]);
const CONTEXTUAL_SEARCH_ROUTE = /(?:^|[/#])(?:search|results?|find|browse|tags?|tagged|r)(?:[/?.#]|$)/iu;
function contextualSearchDecode(value) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const decoded = decodeURIComponent(value);
            if (decoded === value)
                break;
            value = decoded;
        }
        catch {
            break;
        }
    }
    return value.replace(/\+/gu, " ").normalize("NFKC");
}
function containsContextualExplicitSearch(query, hostname = "") {
    const decoded = contextualSearchDecode(query);
    const host = hostname.toLowerCase().replace(/\.$/u, "");
    const platform = CONTEXTUAL_SEARCH_PLATFORMS.some(domain => host === domain || host.endsWith(`.${domain}`));
    return (platform || CONTEXTUAL_SEARCH_NAMES.test(decoded)) && CONTEXTUAL_SEARCH_MARKERS.test(decoded);
}
function matchContextualExplicitSearchUrl(value) {
    return searchQueries(value).some(({ query, hostname }) => containsContextualExplicitSearch(query, hostname));
}
// XXX occurs in document IDs, tracking values and Roman numerals. It is only
// an explicit URL signal in actual search text, never an arbitrary URL substring.
function containsExplicitXxxSearchText(query) {
    return /(?:^|[^\p{L}\p{N}])xxx(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b|porn\b)/iu.test(contextualSearchDecode(query));
}
function matchExplicitXxxSearchUrl(value) {
    return searchQueries(value).some(({ query }) => containsExplicitXxxSearchText(query));
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
    const queries = [...url.searchParams]
        .filter(([name]) => CONTEXTUAL_SEARCH_PARAMETERS.has(name.toLowerCase()))
        .map(([, query]) => query);
    for (const route of [url.pathname, url.hash]) {
        const decoded = contextualSearchDecode(route);
        if (CONTEXTUAL_SEARCH_ROUTE.test(decoded))
            queries.push(decoded);
    }
    return queries.map(query => ({ query, hostname: url.hostname }));
}

const GOOGLE_SEARCH_HOSTNAMES = new Set(["google.com", "www.google.com", "images.google.com"]);
const EXPLICIT_SEARCH_PARAMETER_NAMES = new Set([
    "q", "query", "search_query", "search", "searchterm", "search_term",
    "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag"
]);
const EXPLICIT_SEARCH_PATTERN = /porn|porno|prno|p0rn|nsfw|hentai|rule34|gonewild|onlyfans|fansly|chaturbate|stripchat|cam4|redtube|youporn|spankbang|xvideos|xnxx|xhamster|18(?:\+|plus|-plus)/iu;
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
const SEARCH_ROUTE_PATTERN = /(?:^|[/#])(?:advancedsearch(?:\.php)?|search(?:\.php)?|results?|find|browse)(?:[/?.#]|$)/iu;
const SEARCH_DESCRIPTOR_PATTERN = /(?:^|[-_\s])(?:search|query|keyword)(?:$|[-_\s])/iu;
let lastInspectedSearchUrl = location.href;
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
    if (matchContextualExplicitSearchUrl(url))
        return "about:blank";
    for (const [name, rawValue] of url.searchParams) {
        if (!EXPLICIT_SEARCH_PARAMETER_NAMES.has(name.toLowerCase()))
            continue;
        if (containsExplicitSearchText(rawValue, url.hostname))
            return "about:blank";
    }
    const decodedPath = decodeNestedSearchValue(url.pathname);
    const decodedHash = decodeNestedSearchValue(url.hash.replace(/^#/u, ""));
    if ((SEARCH_ROUTE_PATTERN.test(decodedPath) && containsExplicitSearchText(decodedPath, url.hostname))
        || (SEARCH_ROUTE_PATTERN.test(decodedHash) && containsExplicitSearchText(decodedHash, url.hostname))) {
        return "about:blank";
    }
    return null;
}
function containsExplicitSearchText(rawValue, hostname = new URL(location.href).hostname) {
    const decoded = decodeNestedSearchValue(rawValue);
    return EXPLICIT_SEARCH_PATTERN.test(decoded)
        || EXPLICIT_SEARCH_PATTERN.test(decoded.replace(/\+/gu, " "))
        || containsContextualExplicitSearch(decoded, hostname)
        || containsExplicitXxxSearchText(decoded)
        || containsExplicitPersonSearchText(decoded);
}
function containsExplicitPersonSearchText(rawValue) {
    const query = decodeNestedSearchValue(rawValue).replace(/\+/gu, " ").normalize("NFKC");
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
    let value = rawValue;
    for (let pass = 0; pass < 3; pass += 1) {
        try {
            const decoded = decodeURIComponent(value);
            if (decoded === value)
                break;
            value = decoded;
        }
        catch {
            break;
        }
    }
    return value;
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
    if (redirect && redirect !== location.href)
        location.replace(redirect);
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
    const redirect = alwaysOnSearchRedirect(anchor.href);
    if (!redirect || redirect === anchor.href)
        return;
    event.preventDefault();
    event.stopImmediatePropagation();
    location.assign(redirect);
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
        location.assign("about:blank");
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
    location.assign(redirect);
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
        || SEARCH_ROUTE_PATTERN.test(form.action || "");
    if (fields.some(([name, value]) => ((formIsSearch || EXPLICIT_SEARCH_PARAMETER_NAMES.has(name.toLowerCase()))
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
    let blocked = isSearchControl(target) && containsExplicitSearchText(searchControlValue(target));
    if (!blocked && event.type === "click" && isSearchActivationControl(target)) {
        const container = target.closest("form, [role='search'], [data-search], [class*='search' i], [id*='search' i]");
        blocked = Boolean(container && explicitSearchTextInContainer(container));
    }
    if (!blocked)
        return false;
    if (event.cancelable)
        event.preventDefault();
    event.stopImmediatePropagation();
    location.assign("about:blank");
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
    const role = (value.getAttribute("role") || "").toLowerCase();
    const descriptor = [
        value.getAttribute("name"), value.getAttribute("id"), value.getAttribute("aria-label"),
        value.getAttribute("placeholder"), value.getAttribute("data-testid")
    ].filter(Boolean).join(" ");
    return type === "search" || role === "searchbox"
        || EXPLICIT_SEARCH_PARAMETER_NAMES.has((value.getAttribute("name") || "").toLowerCase())
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
function explicitSearchTextInContainer(container) {
    const controls = container.querySelectorAll?.("input, textarea, [contenteditable='true'], [role='searchbox']") || [];
    return Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)));
}
function scanExistingSearchControls(root) {
    const controls = root.querySelectorAll?.("input[type='search'], [role='searchbox'], input[name], textarea[name], [contenteditable='true']") || [];
    if (Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)))) {
        location.replace("about:blank");
    }
}
function installDynamicSearchGuard() {
    if (typeof document === "undefined")
        return;
    scanExistingSearchControls(document);
    if (typeof MutationObserver !== "function" || !document.documentElement)
        return;
    new MutationObserver((records) => {
        for (const record of records) {
            for (const node of record.addedNodes) {
                if (node instanceof Element) {
                    if ((isSearchControl(node) && containsExplicitSearchText(searchControlValue(node)))
                        || explicitSearchTextInContainer(node)) {
                        location.replace("about:blank");
                        return;
                    }
                }
            }
        }
    }).observe(document.documentElement, { childList: true, subtree: true });
}
function checkForSearchUrlChange() {
    if (lastInspectedSearchUrl === location.href)
        return;
    enforceGoogleSafeSearchForCurrentNavigation();
}
addEventListener("click", enforceGoogleSafeSearchForLink, true);
addEventListener("submit", enforceGoogleSafeSearchForForm, true);
addEventListener("input", enforceExplicitSearchControlInteraction, true);
addEventListener("change", enforceExplicitSearchControlInteraction, true);
addEventListener("keydown", enforceExplicitSearchControlInteraction, true);
addEventListener("popstate", checkForSearchUrlChange, true);
addEventListener("hashchange", checkForSearchUrlChange, true);
globalThis.setInterval?.(checkForSearchUrlChange, 250);
enforceGoogleSafeSearchForCurrentNavigation();
installDynamicSearchGuard();


})();
