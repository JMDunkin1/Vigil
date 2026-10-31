// Shared by the search and media guards. Keep the title, citation, snippet,
// thumbnail and sitelinks together without hiding neighboring results.
export function isGoogleSearchResultsPage(): boolean {
  return /^(?:(?:www|images)\.)?google\.(?:com|[a-z]{2,3}|(?:com|co)\.[a-z]{2})$/u.test(String(location.hostname || "").toLowerCase().replace(/\.$/u, ""))
    && location.pathname === "/search";
}

export function googleSearchResultContainer(element: Element): HTMLElement | null {
  if (!isGoogleSearchResultsPage() || element.closest("header, nav, footer, form, [role='navigation'], [role='search'], #searchform")) return null;
  // AI Overview recommendations are list rows. Hiding only their linked name
  // leaves a dangling description, so keep each recommendation together.
  const row = element.closest<HTMLElement>("li, [role='listitem']");
  if (row && row.querySelectorAll("h3").length <= 1 && !row.querySelector("input, textarea")) return row;
  const results = element.closest("#rso, #search");
  if (!results) return element.closest<HTMLElement>("p");
  let card: HTMLElement | null = null;
  for (let candidate: Element | null = element, depth = 0; candidate && candidate !== results && depth < 16;
    candidate = candidate.parentElement, depth += 1) {
    if (!(candidate instanceof HTMLElement) || candidate.matches("main, [role='main'], #center_col, #rcnt")) break;
    // Current desktop/mobile wrappers can contain several sitelink headings.
    // A wrapper around independent result cards is a group, not one result.
    const headings = candidate.querySelectorAll("h3").length;
    const sitelinkTable = Boolean(candidate.querySelector("table"))
      && [...candidate.querySelectorAll("h3")].filter(heading => !heading.closest("table")).length === 1;
    if (candidate.matches(".MjjYud, .g, .Gx5Zad")
      && !candidate.querySelector(".MjjYud, .g, .Gx5Zad") && (headings <= 1 || sitelinkTable)) return candidate;
    if (headings > 1) break;
    if (headings === 1) card = candidate;
  }
  return card;
}

export function googleSearchResultDestinations(anchor: HTMLAnchorElement): string[] {
  if (!isGoogleSearchResultsPage()) return [];
  const destinations = new Set<string>();
  let url: URL;
  try { url = new URL(anchor.href, location.href); } catch { return []; }
  if (!/^https?:$/u.test(url.protocol)) return [];
  const google = /^(?:www\.)?google\.(?:com|[a-z]{2,3}|(?:com|co)\.[a-z]{2})$/u.test(url.hostname);
  if (!google) destinations.add(url.href);
  else if (["/url", "/goto", "/aclk", "/imgres"].includes(url.pathname)) {
    for (const key of ["q", "url", "adurl", "imgurl"]) {
      const value = url.searchParams.get(key) || "";
      if (/^https?:\/\//iu.test(value)) {
        try { destinations.add(new URL(value).href); } catch { /* Ignore malformed redirect destinations. */ }
      }
    }
    // Opaque redirects cannot be decoded as URLs. The rendered citation still
    // identifies the result's actual domain without interpreting opaque bytes.
    const card = googleSearchResultContainer(anchor);
    for (const citation of (card || anchor).querySelectorAll("cite")) {
      const text = (citation.textContent || "").normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
      const first = text.split(/[\s›»]/u)[0];
      try {
        const cited = new URL(/^https?:\/\//iu.test(first) ? first : `https://${first}`);
        if (/^[a-z0-9.-]+\.[a-z]{2,}$/iu.test(cited.hostname)) destinations.add(`${cited.origin}/`);
      } catch { /* A citation need not contain a URL. */ }
    }
  }
  return [...destinations];
}
