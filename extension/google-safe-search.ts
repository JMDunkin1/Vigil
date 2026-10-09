import { checkSearchBreakBeforeNavigation } from "./search-break.js";
import { containsContextualExplicitSearch, containsExplicitXxxSearchText, containsExplicitMediaLabel, matchContextualExplicitSearchUrl } from "../src/contextualExplicitSearch.js";
import { hasSafeSearchContributor, hasOrdinarySafeSearchContext, isSafeSearchLimitedNotice, safeSearchSubject, matchesSafeSearchSubject, sharedFileDestination, isExplicitLinkCollection } from "../src/safeSearchContext.js";
import { SEARCH_PARAMETER_NAMES, searchQueries, looksLikeSearchRoute, decodeSearchQueryValue, isProtectedSearchParameter } from "../src/searchQueryContext.js";
import { normalizeExplicitVocabulary, normalizeExplicitMediaText } from "../src/explicitMediaContext.js";

const GOOGLE_SEARCH_HOSTNAMES = new Set(["google.com", "www.google.com", "images.google.com"]);
const EXPLICIT_SEARCH_PARAMETER_NAMES = SEARCH_PARAMETER_NAMES;
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
const safeSearchSubjects = new Map<string, number>();
let safeSearchEvidenceUrl = "";
let safeSearchEvidenceAt = 0;

function explicitSearchBlockRedirect(rawUrl: string, baseUrl = location.href): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (matchContextualExplicitSearchUrl(url)) return chrome.runtime.getURL("blocked.html");
  if (searchQueries(url).some(({ query }) => containsExplicitSearchText(query, url.hostname))) return chrome.runtime.getURL("blocked.html");
  return null;
}

function containsExplicitSearchText(rawValue: string, hostname = new URL(location.href).hostname, includeRedditShorthand = true): boolean {
  const decoded = decodeNestedSearchValue(rawValue);
  const vocabulary = normalizeExplicitVocabulary(decoded);
  return EXPLICIT_SEARCH_PATTERN.test(vocabulary)
    || EXPLICIT_SEARCH_PATTERN.test(vocabulary.replace(/\+/gu, " "))
    || containsContextualExplicitSearch(decoded, hostname, includeRedditShorthand)
    || containsExplicitXxxSearchText(decoded)
    || containsExplicitPersonSearchText(decoded)
    || (hasSafeSearchContributor(decoded) && (hasSavedSafeSearchSubject(decoded)
      || (hasCurrentSafeSearchEvidence() && sameSafeSearchQuery(decoded, currentGoogleSearchQuery()))));
}

function currentGoogleSearchQuery(): string {
  try {
    const url = new URL(location.href);
    return ["http:", "https:"].includes(url.protocol)
      && GOOGLE_SEARCH_HOSTNAMES.has(url.hostname.toLowerCase().replace(/\.$/u, ""))
      && url.pathname === "/search" ? url.searchParams.get("q") || "" : "";
  } catch { return ""; }
}

function hasSavedSafeSearchSubject(value: string): boolean {
  const subject = safeSearchSubject(value);
  const observedAt = safeSearchSubjects.get(subject) || 0;
  return Boolean(subject && observedAt > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS && observedAt <= Date.now());
}

function hasCurrentSafeSearchEvidence(): boolean {
  const now = Date.now();
  return safeSearchEvidenceUrl === location.href && safeSearchEvidenceAt > now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
    && safeSearchEvidenceAt <= now;
}

function sameSafeSearchQuery(first: string, second: string): boolean {
  const normalize = (value: string) => decodeNestedSearchValue(value).normalize("NFKC")
    .replace(/\+/gu, " ").replace(/[\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]|\p{Variation_Selector}/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
  return Boolean(second && normalize(first) === normalize(second));
}

function safeSearchContextStorage(): typeof chrome.storage.local | undefined {
  const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || globalThis.chrome;
  return api?.storage?.local;
}

function safeSearchSubjectStorageKey(subject: string, observedAt: number): string {
  return `${SAFE_SEARCH_SUBJECT_KEY_PREFIX}${Math.floor(observedAt / SAFE_SEARCH_EVIDENCE_LIFETIME_MS)}:${encodeURIComponent(subject)}`;
}

function rememberSafeSearchSubject(query: string): void {
  if (hasCurrentSafeSearchEvidence()) return;
  safeSearchEvidenceUrl = location.href;
  safeSearchEvidenceAt = Date.now();
  const subject = safeSearchSubject(query);
  // The current search is enforceable even when it consists only of an
  // ambiguous word or has ordinary context. Subject caching is more selective.
  if (!subject) return;
  safeSearchSubjects.set(subject, safeSearchEvidenceAt);
  // Each subject has its own key so a tab's stale snapshot cannot erase
  // evidence observed by another tab. Buckets allow safe expiry cleanup.
  const key = safeSearchSubjectStorageKey(subject, safeSearchEvidenceAt);
  try { void safeSearchContextStorage()?.set({ [key]: { subject, observedAt: safeSearchEvidenceAt } }).catch(() => {}); }
  catch { /* In-memory enforcement remains available without extension storage. */ }
}

function visibleContextElement(element: Element): boolean {
  if (element.closest("[hidden], [aria-hidden='true']")) return false;
  const style = getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function observeSafeSearchNotice(): void {
  const query = currentGoogleSearchQuery();
  if (!query) return;
  const excludedText = "#rso, article, h3, pre, code, blockquote, q, figcaption";
  const candidates = new Set(document.querySelectorAll("[role='alert'], [role='status'], [role='dialog'], [aria-live], #taw, #taw *, #topstuff, #topstuff *, #botstuff, #botstuff *"));
  for (const link of document.querySelectorAll("a[href*='safesearch' i]")) {
    let parent: Element | null = link;
    for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) candidates.add(parent);
  }
  for (const candidate of candidates) {
    // Search snippets, quoted documentation and hidden settings are not notices.
    if (candidate.closest(`${excludedText}, a`) || candidate.querySelector("h3") || !visibleContextElement(candidate)) continue;
    let resultCard = false;
    for (let parent = candidate.parentElement; parent && parent !== document.body && parent !== document.documentElement
      && !["search", "topstuff", "botstuff", "taw"].includes(parent.id); parent = parent.parentElement) {
      if (parent.querySelector("a h3")) { resultCard = true; break; }
    }
    if (resultCard) continue;
    let notice = "";
    const walker = document.createTreeWalker(candidate, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && notice.length <= 600; node = walker.nextNode()) {
      if (node.parentElement && !node.parentElement.closest(excludedText)
        && visibleContextElement(node.parentElement)) notice += `${node.textContent || ""} `;
    }
    if (isSafeSearchLimitedNotice(notice)) {
      rememberSafeSearchSubject(query);
      return;
    }
  }
}

function readerContextRoots(): Element[] {
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

function readerFileDestinations(roots: Element[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    const excluded = "nav, header, footer, aside, [role='navigation'], [role='complementary']";
    for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (anchor.closest(excluded)) continue;
      const file = sharedFileDestination(anchor.href, location.href);
      if (file) files.add(file);
    }
    // PDFs and pastes can expose URLs as text instead of clickable anchors.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest(`${excluded}, script, style, noscript`)) continue;
      for (const url of (node.textContent || "").match(/https?:\/\/[^\s<>"']+/gu) || []) {
        const file = sharedFileDestination(url.replace(/[),.;]+$/u, ""));
        if (file) files.add(file);
      }
    }
  }
  return [...files];
}

function contextualLinkIsBlocked(anchor: HTMLAnchorElement): boolean {
  const query = currentGoogleSearchQuery();
  const label = [anchor.textContent, anchor.getAttribute("title"), anchor.getAttribute("aria-label")].filter(Boolean).join(" ");
  const file = sharedFileDestination(anchor.href, location.href);
  if (query && hasCurrentSafeSearchEvidence() && (hasSafeSearchContributor(label) || file)) return true;
  if (hasOrdinarySafeSearchContext(label) || (!query && hasOrdinarySafeSearchContext(document.title))) return false;
  if (query && hasSavedSafeSearchSubject(query) && (hasSafeSearchContributor(label) || file)) return true;
  return [...safeSearchSubjects].some(([subject, at]) => at > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
    && at <= Date.now() && matchesSafeSearchSubject(label, subject) && hasSafeSearchContributor(label));
}

function redirectAfterSearchWarning(target: string, navigation: "replace" | "assign" = "replace"): void {
  const navigate = () => location[navigation](target);
  const pending = checkSearchBreakBeforeNavigation();
  if (!pending) { navigate(); return; }
  const source = location.href;
  // Give the background time to validate and record the warning while its
  // current-tab URL still matches. An unavailable authority cannot suspend
  // the content block indefinitely.
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 1000); });
  void Promise.race([pending, deadline]).then(blocked => {
    clearTimeout(timeout);
    if (!blocked && location.href === source) navigate();
  });
}

function scanSafeSearchContext(): void {
  observeSafeSearchNotice();
  // Cached evidence can arrive after the initial URL/control checks on any
  // search provider, including pages whose URLs do not change afterward.
  const redirect = explicitSearchBlockRedirect(location.href);
  if (redirect) {
    redirectAfterSearchWarning(redirect);
    return;
  }
  if (scanExistingSearchControls(document)) return;
  const query = currentGoogleSearchQuery();
  if (query) {
    if ((hasCurrentSafeSearchEvidence() || hasSavedSafeSearchSubject(query)) && hasSafeSearchContributor(query)) {
      redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
      return;
    }
  } else {
    const roots = readerContextRoots();
    const title = `${document.title} ${document.querySelector("h1")?.textContent || ""}`;
    const evidence = !hasOrdinarySafeSearchContext(title) && [...safeSearchSubjects].some(([subject, at]) => at > Date.now() - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
      && at <= Date.now() && matchesSafeSearchSubject(title, subject));
    if (!hasOrdinarySafeSearchContext(title) && isExplicitLinkCollection(readerFileDestinations(roots), evidence)) {
      redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
      return;
    }
  }
}

function installSafeSearchContextGuard(): void {
  if (typeof document === "undefined") return;
  let scanPending = false;
  const scheduleScan = () => {
    if (scanPending) return;
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
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
  function mergeEvidence(result: Record<string, unknown>): string[] {
    const now = Date.now();
    for (const [subject, at] of safeSearchSubjects) {
      if (at <= now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS || at > now) safeSearchSubjects.delete(subject);
    }
    const candidates: Array<[string, unknown]> = [];
    const saved = result[SAFE_SEARCH_EVIDENCE_KEY];
    if (saved && typeof saved === "object") {
      // Retain evidence written by previous versions during migration.
      candidates.push(...Object.entries(saved));
    }
    const expiredKeys: string[] = [];
    const oldestBucket = Math.floor((now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS) / SAFE_SEARCH_EVIDENCE_LIFETIME_MS);
    for (const [key, entry] of Object.entries(result)) {
      if (!key.startsWith(SAFE_SEARCH_SUBJECT_KEY_PREFIX) || !entry || typeof entry !== "object") continue;
      const { subject, observedAt } = entry as { subject?: unknown; observedAt?: unknown };
      if (typeof subject !== "string" || typeof observedAt !== "number"
        || key !== safeSearchSubjectStorageKey(subject, observedAt)) continue;
      candidates.push([subject, observedAt]);
      // No current observation can write to a completely expired bucket,
      // including a renewal of the same subject in another tab.
      if (Math.floor(observedAt / SAFE_SEARCH_EVIDENCE_LIFETIME_MS) < oldestBucket) expiredKeys.push(key);
    }
    const valid = candidates.filter((entry): entry is [string, number] => typeof entry[1] === "number"
      && entry[1] <= now && entry[1] > now - SAFE_SEARCH_EVIDENCE_LIFETIME_MS
      && safeSearchSubject(entry[0]) === entry[0]).sort((a, b) => b[1] - a[1]);
    for (const [subject, at] of valid) {
      if (!safeSearchSubjects.has(subject) && safeSearchSubjects.size >= 64) continue;
      safeSearchSubjects.set(subject, Math.max(at, safeSearchSubjects.get(subject) || 0));
    }
    return expiredKeys;
  }
  async function loadEvidence(): Promise<void> {
    try {
      const storage = safeSearchContextStorage();
      const result = await storage?.get(null);
      if (!result) return;
      const expiredKeys = mergeEvidence(result);
      if (expiredKeys.length) void storage?.remove(expiredKeys).catch(() => {});
      scheduleScan();
    } catch { /* Local page evidence still enforces this rule. */ }
  }
  try {
    const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || globalThis.chrome;
    // Subscribe before loading the snapshot so observations from other tabs
    // cannot be missed while the initial storage read is pending.
    api?.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const evidence: Record<string, unknown> = {};
      for (const [key, change] of Object.entries(changes)) {
        if ((key === SAFE_SEARCH_EVIDENCE_KEY || key.startsWith(SAFE_SEARCH_SUBJECT_KEY_PREFIX))
          && change.newValue !== undefined) evidence[key] = change.newValue;
      }
      if (!Object.keys(evidence).length) return;
      mergeEvidence(evidence);
      scheduleScan();
    });
  } catch { /* Local page evidence still enforces this rule. */ }
  void loadEvidence();
  addEventListener("popstate", scheduleScan, true);
  addEventListener("hashchange", scheduleScan, true);
}

function containsExplicitPersonSearchText(rawValue: string): boolean {
  const query = normalizeExplicitMediaText(decodeNestedSearchValue(rawValue).replace(/\+/gu, " "));
  const tokens = query.match(/[\p{L}\p{M}][\p{L}\p{M}'’.-]*/gu)
    ?.map(token => token.replace(/^[^\p{L}\p{M}]+|[^\p{L}\p{M}]+$/gu, ""))
    .filter(Boolean) || [];
  if (tokens.length < 2) return false;
  const normalized = tokens.map(token => token.toLocaleLowerCase("en-US"));
  const markerIndex = normalized.findIndex(token => PERSON_EXPOSURE_MARKERS.has(token));
  if (markerIndex < 0) return false;
  const marker = normalized[markerIndex];
  const ordinaryContext = ["leak", "leaks", "leaked", "leakd", "lek", "leks"].includes(marker)
    ? PERSON_LEAK_CONTEXT
    : PERSON_NUDE_CONTEXT;
  if (normalized.some((token, index) => index !== markerIndex && PERSON_INTIMATE_CONTEXT.has(token))) return true;
  if (marker === "naked" && /(?:^|[^\p{L}\p{N}])naked[\s_-]+(?:eye|cakes?)(?=$|[^\p{L}\p{N}])/iu.test(query)) return false;
  const possibleNameTokens = tokens.filter((_token, index) => (
    index !== markerIndex
      && !PERSON_NAME_FILLER_WORDS.has(normalized[index])
      && !ordinaryContext.has(normalized[index])
  ));
  if (possibleNameTokens.length >= 2
      && possibleNameTokens.some(startsWithUppercaseLetter)) return true;
  if (normalized.some(token => ordinaryContext.has(token))) return false;
  const structuralName = normalized.filter((token, index) => (
    index !== markerIndex && !PERSON_NAME_FILLER_WORDS.has(token)
  ));
  return structuralName.length >= 2 && structuralName.length <= 4
    && structuralName.every(token => (
      token.length >= 2
        && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*$/u.test(token)
    ));
}

function startsWithUppercaseLetter(value: string): boolean {
  const first = value.match(/[\p{L}]/u)?.[0] || "";
  return Boolean(first && first === first.toLocaleUpperCase("en-US") && first !== first.toLocaleLowerCase("en-US"));
}

function decodeNestedSearchValue(rawValue: string): string {
  return decodeSearchQueryValue(rawValue);
}

function googleSafeSearchRedirect(rawUrl: string, baseUrl = location.href): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || !GOOGLE_SEARCH_HOSTNAMES.has(hostname)
    || url.pathname !== "/search") return null;
  if (url.searchParams.get("safe") === "active") return null;
  url.searchParams.set("safe", "active");
  return url.href;
}

function alwaysOnSearchRedirect(rawUrl: string, baseUrl = location.href): string | null {
  return explicitSearchBlockRedirect(rawUrl, baseUrl) ?? googleSafeSearchRedirect(rawUrl, baseUrl);
}

function enforceGoogleSafeSearchForCurrentNavigation(): void {
  lastInspectedSearchUrl = location.href;
  const redirect = alwaysOnSearchRedirect(location.href);
  if (redirect && redirect !== location.href) location.replace(redirect);
}

function enforceGoogleSafeSearchForLink(event: MouseEvent): void {
  if (enforceExplicitSearchControlInteraction(event)) return;
  const target = eventTargetElement(event);
  if (!target) return;
  const anchor = target.closest<HTMLAnchorElement>("a[href]");
  if (!anchor) return;
  observeSafeSearchNotice();
  const label = [anchor.textContent, anchor.getAttribute("title"), anchor.getAttribute("aria-label")].filter(Boolean).join(" ");
  if (containsExplicitMediaLabel(label) || contextualLinkIsBlocked(anchor)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"), "assign");
    return;
  }
  const redirect = alwaysOnSearchRedirect(anchor.href);
  if (!redirect || redirect === anchor.href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  redirectAfterSearchWarning(redirect, "assign");
}

function enforceGoogleSafeSearchForForm(event: SubmitEvent): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;
  const submitter = event.submitter as HTMLButtonElement | HTMLInputElement | null;
  const method = submitter?.hasAttribute("formmethod") === true
    ? submitter.formMethod
    : form.method || "get";
  const action = submitter?.hasAttribute("formaction") === true
    ? submitter.formAction
    : form.action || location.href;
  let target: URL;
  try {
    target = new URL(action, location.href);
  } catch {
    return;
  }
  const fields = formDataEntries(form, submitter);
  const explicitFormSearch = explicitSearchTextFromForm(form, fields);
  const directBlock = explicitSearchBlockRedirect(target.href);
  if (explicitFormSearch || directBlock) {
    event.preventDefault();
    event.stopImmediatePropagation();
    redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"), "assign");
    return;
  }
  if (method.toLowerCase() !== "get") return;
  target.search = "";
  for (const [name, value] of fields) target.searchParams.append(name, value);
  const redirect = alwaysOnSearchRedirect(target.href);
  if (!redirect || redirect === target.href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  redirectAfterSearchWarning(redirect, "assign");
}

function formDataEntries(
  form: HTMLFormElement,
  submitter: HTMLButtonElement | HTMLInputElement | null
): Array<[string, string]> {
  let fields: FormData;
  try {
    fields = submitter ? new FormData(form, submitter) : new FormData(form);
  } catch {
    fields = new FormData(form);
  }
  return [...fields].map(([name, value]) => [name, typeof value === "string" ? value : value.name]);
}

function explicitSearchTextFromForm(form: HTMLFormElement, fields: Array<[string, string]>): boolean {
  const formIsSearch = elementLooksLikeSearchContainer(form)
    || looksLikeSearchRoute(form.action || "");
  if (fields.some(([name, value]) => (
    isProtectedSearchParameter(name, formIsSearch)
      && containsExplicitSearchText(value)
  ))) return true;
  const controls = form.elements ? Array.from(form.elements) : [];
  return controls.some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)));
}

function enforceExplicitSearchControlInteraction(event: Event): boolean {
  if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return false;
  const target = eventTargetElement(event);
  if (!target) return false;
  // Short Reddit queries are checked on activation, not while typing Xbox.
  const activating = event.type === "keydown";
  let blocked = isSearchControl(target) && containsExplicitSearchText(searchControlValue(target), undefined, activating);
  if (!blocked && event.type === "click" && isSearchActivationControl(target)) {
    const container = target.closest("form, [role='search'], [data-search], [class*='search' i], [id*='search' i]");
    blocked = Boolean(container && explicitSearchTextInContainer(container));
  }
  if (!blocked) return false;
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
  redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"), "assign");
  return true;
}

function eventTargetElement(event: Event): Element | null {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  const pathElement = path.find((item): item is Element => item instanceof Element);
  return pathElement || (event.target instanceof Element ? event.target : null);
}

function isSearchControl(value: unknown): value is Element {
  if (!(value instanceof Element)) return false;
  const tagName = String((value as HTMLElement).tagName || "").toLowerCase();
  const editable = (value as HTMLElement).isContentEditable === true;
  if (!editable && tagName !== "input" && tagName !== "textarea") return false;
  const type = (value.getAttribute("type") || "").toLowerCase();
  // Tracking fields, checkboxes and submit labels are not user search text.
  // Real hidden query fields are still checked through URL/submission policy.
  if (tagName === "input" && !["", "text", "search"].includes(type)) return false;
  if (value.closest("[hidden], [aria-hidden='true']") || value.getAttribute("disabled") !== null) return false;
  if (typeof getComputedStyle === "function") {
    const style = getComputedStyle(value);
    if (style.display === "none" || style.visibility === "hidden") return false;
  }
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

function searchControlValue(value: unknown): string {
  if (!(value instanceof Element)) return "";
  const controlValue = (value as HTMLInputElement | HTMLTextAreaElement).value;
  return typeof controlValue === "string" ? controlValue : String(value.textContent || "");
}

function isSearchActivationControl(value: Element): boolean {
  const tagName = String((value as HTMLElement).tagName || "").toLowerCase();
  if (tagName !== "button" && !(tagName === "input" && ["button", "submit", "image"].includes((value.getAttribute("type") || "").toLowerCase()))) {
    return false;
  }
  const descriptor = [value.textContent, value.getAttribute("aria-label"), value.getAttribute("title"), value.getAttribute("id")]
    .filter(Boolean).join(" ");
  return /search|find/iu.test(descriptor) || Boolean(value.closest("[role='search']"));
}

function elementLooksLikeSearchContainer(value: Element): boolean {
  const descriptor = [
    value.getAttribute?.("role"), value.getAttribute?.("aria-label"),
    value.getAttribute?.("id"), value.getAttribute?.("class")
  ].filter(Boolean).join(" ");
  return /(?:^|[-_\s])search(?:$|[-_\s])/iu.test(descriptor);
}

function explicitSearchTextInContainer(container: Element, includeRedditShorthand = true): boolean {
  const controls = container.querySelectorAll?.("input, textarea, [contenteditable='true'], [role='searchbox']") || [];
  return Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control), undefined, includeRedditShorthand));
}

function scanExistingSearchControls(root: ParentNode): boolean {
  const controls = root.querySelectorAll?.(
    "input[type='search'], [role='searchbox'], input[name], textarea[name], [contenteditable='true']"
  ) || [];
  if (Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control), undefined, false))) {
    redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
    return true;
  }
  return false;
}

function installDynamicSearchGuard(): void {
  if (typeof document === "undefined") return;
  if (containsExplicitMediaLabel(document.title)) {
    redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
    return;
  }
  scanExistingSearchControls(document);
  if (typeof MutationObserver !== "function" || !document.documentElement) return;
  new MutationObserver((records) => {
    if (containsExplicitMediaLabel(document.title)) {
      redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
      return;
    }
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          if ((isSearchControl(node) && containsExplicitSearchText(searchControlValue(node), undefined, false))
            || explicitSearchTextInContainer(node, false)) {
            redirectAfterSearchWarning(chrome.runtime.getURL("blocked.html"));
            return;
          }
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
}

function checkForSearchUrlChange(): void {
  if (lastInspectedSearchUrl === location.href) return;
  enforceGoogleSafeSearchForCurrentNavigation();
  if (typeof document !== "undefined") scanSafeSearchContext();
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
installSafeSearchContextGuard();
