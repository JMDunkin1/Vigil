const GOOGLE_SEARCH_HOSTNAMES = new Set(["google.com", "www.google.com", "images.google.com"]);
const EXPLICIT_SEARCH_DOMAIN_SUFFIXES = ["google.com", "bing.com", "duckduckgo.com"];
const EXPLICIT_SEARCH_PARAMETER_NAMES = new Set(["q", "query", "search_query", "text"]);
const EXPLICIT_SEARCH_PATTERN = /porn|porno|xxx|nsfw|hentai|rule34|gonewild|onlyfans|fansly|chaturbate|stripchat|cam4|redtube|youporn|spankbang|xvideos|xnxx|xhamster|18(?:\+|plus|-plus)/iu;

function explicitSearchBlockRedirect(rawUrl: string, baseUrl = location.href): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:")
    || !isExplicitSearchDomain(url.hostname)) return null;
  for (const [name, rawValue] of url.searchParams) {
    if (!EXPLICIT_SEARCH_PARAMETER_NAMES.has(name.toLowerCase())) continue;
    if (EXPLICIT_SEARCH_PATTERN.test(decodeNestedSearchValue(rawValue))) {
      return chrome.runtime.getURL("blocked.html");
    }
  }
  return null;
}

function isExplicitSearchDomain(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase();
  return EXPLICIT_SEARCH_DOMAIN_SUFFIXES.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function decodeNestedSearchValue(rawValue: string): string {
  let value = rawValue;
  for (let pass = 0; pass < 2; pass += 1) {
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
  const redirect = alwaysOnSearchRedirect(location.href);
  if (redirect && redirect !== location.href) location.replace(redirect);
}

function enforceGoogleSafeSearchForLink(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
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
  if (method.toLowerCase() !== "get") return;
  const action = submitter?.hasAttribute("formaction") === true
    ? submitter.formAction
    : form.action || location.href;
  const target = new URL(action, location.href);
  target.search = "";
  const fields = submitter ? new FormData(form, submitter) : new FormData(form);
  for (const [name, value] of fields) {
    target.searchParams.append(name, typeof value === "string" ? value : value.name);
  }
  const redirect = alwaysOnSearchRedirect(target.href);
  if (!redirect || redirect === target.href) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  location.assign(redirect);
}

addEventListener("click", enforceGoogleSafeSearchForLink, true);
addEventListener("submit", enforceGoogleSafeSearchForForm, true);
enforceGoogleSafeSearchForCurrentNavigation();
