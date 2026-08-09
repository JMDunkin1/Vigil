const GOOGLE_SEARCH_HOSTNAMES = new Set(["google.com", "www.google.com", "images.google.com"]);
const EXPLICIT_SEARCH_PARAMETER_NAMES = new Set([
  "q", "query", "search_query", "search", "searchterm", "search_term",
  "keyword", "keywords", "term", "text", "p", "k", "s", "wd"
]);
const EXPLICIT_SEARCH_PATTERN = /porn|porno|xxx|nsfw|hentai|rule34|gonewild|onlyfans|fansly|chaturbate|stripchat|cam4|redtube|youporn|spankbang|xvideos|xnxx|xhamster|18(?:\+|plus|-plus)/iu;
const SEARCH_ROUTE_PATTERN = /(?:^|[/#])(?:advancedsearch(?:\.php)?|search(?:\.php)?|results?|find|browse)(?:[/?.#]|$)/iu;
const SEARCH_DESCRIPTOR_PATTERN = /(?:^|[-_\s])(?:search|query|keyword)(?:$|[-_\s])/iu;
let lastInspectedSearchUrl = location.href;

function explicitSearchBlockRedirect(rawUrl: string, baseUrl = location.href): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  for (const [name, rawValue] of url.searchParams) {
    if (!EXPLICIT_SEARCH_PARAMETER_NAMES.has(name.toLowerCase())) continue;
    if (containsExplicitSearchText(rawValue)) return chrome.runtime.getURL("blocked.html");
  }
  const decodedPath = decodeNestedSearchValue(url.pathname);
  const decodedHash = decodeNestedSearchValue(url.hash.replace(/^#/u, ""));
  if ((SEARCH_ROUTE_PATTERN.test(decodedPath) && containsExplicitSearchText(decodedPath))
    || (SEARCH_ROUTE_PATTERN.test(decodedHash) && containsExplicitSearchText(decodedHash))) {
    return chrome.runtime.getURL("blocked.html");
  }
  return null;
}

function containsExplicitSearchText(rawValue: string): boolean {
  const decoded = decodeNestedSearchValue(rawValue);
  return EXPLICIT_SEARCH_PATTERN.test(decoded) || EXPLICIT_SEARCH_PATTERN.test(decoded.replace(/\+/gu, " "));
}

function decodeNestedSearchValue(rawValue: string): string {
  let value = rawValue;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      break;
    }
  }
  return value;
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
  const redirect = alwaysOnSearchRedirect(anchor.href);
  if (!redirect || redirect === anchor.href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(redirect);
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
    location.assign(chrome.runtime.getURL("blocked.html"));
    return;
  }
  if (method.toLowerCase() !== "get") return;
  target.search = "";
  for (const [name, value] of fields) target.searchParams.append(name, value);
  const redirect = alwaysOnSearchRedirect(target.href);
  if (!redirect || redirect === target.href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(redirect);
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
    || SEARCH_ROUTE_PATTERN.test(form.action || "");
  if (fields.some(([name, value]) => (
    (formIsSearch || EXPLICIT_SEARCH_PARAMETER_NAMES.has(name.toLowerCase()))
      && containsExplicitSearchText(value)
  ))) return true;
  const controls = form.elements ? Array.from(form.elements) : [];
  return controls.some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)));
}

function enforceExplicitSearchControlInteraction(event: Event): boolean {
  if (event.type === "keydown" && (event as KeyboardEvent).key !== "Enter") return false;
  const target = eventTargetElement(event);
  if (!target) return false;
  let blocked = isSearchControl(target) && containsExplicitSearchText(searchControlValue(target));
  if (!blocked && event.type === "click" && isSearchActivationControl(target)) {
    const container = target.closest("form, [role='search'], [data-search], [class*='search' i], [id*='search' i]");
    blocked = Boolean(container && explicitSearchTextInContainer(container));
  }
  if (!blocked) return false;
  if (event.cancelable) event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(chrome.runtime.getURL("blocked.html"));
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

function explicitSearchTextInContainer(container: Element): boolean {
  const controls = container.querySelectorAll?.("input, textarea, [contenteditable='true'], [role='searchbox']") || [];
  return Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)));
}

function scanExistingSearchControls(root: ParentNode): void {
  const controls = root.querySelectorAll?.(
    "input[type='search'], [role='searchbox'], input[name], textarea[name], [contenteditable='true']"
  ) || [];
  if (Array.from(controls).some((control) => isSearchControl(control) && containsExplicitSearchText(searchControlValue(control)))) {
    location.replace(chrome.runtime.getURL("blocked.html"));
  }
}

function installDynamicSearchGuard(): void {
  if (typeof document === "undefined") return;
  scanExistingSearchControls(document);
  if (typeof MutationObserver !== "function" || !document.documentElement) return;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) {
          if ((isSearchControl(node) && containsExplicitSearchText(searchControlValue(node)))
            || explicitSearchTextInContainer(node)) {
            location.replace(chrome.runtime.getURL("blocked.html"));
            return;
          }
        }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

function checkForSearchUrlChange(): void {
  if (lastInspectedSearchUrl === location.href) return;
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
