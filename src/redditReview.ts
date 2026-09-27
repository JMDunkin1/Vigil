// URL shape is eligibility only. Permission to read a post lives in the
// extension background and is issued only for a click from an external search.
export function redditReviewHost(value: string): boolean {
  try {
    return /(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/iu.test(new URL(value).hostname);
  } catch { return false; }
}

export function redditReviewPostId(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !/^(www\.|old\.|new\.|np\.|m\.)?reddit\.com$/iu.test(url.hostname)) return null;
    // JSON, galleries, media viewers, feeds, short links and user posts are
    // deliberately excluded. Comment permalinks stay inside the selected post.
    const match = url.pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/[^/.]+(?:\/[a-z0-9]+)?)?\/?$/iu);
    return match?.[1].toLowerCase() || null;
  } catch { return null; }
}

export function redditReviewSearchPage(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const google = /^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(host) && url.pathname === "/search";
    const supported = google
      || (["www.bing.com", "bing.com", "search.brave.com", "kagi.com", "search.yahoo.com"].includes(host) && url.pathname === "/search")
      || (["duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com"].includes(host) && ["/", "/html/", "/html"].includes(url.pathname));
    if (!supported || !(url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim()) return null;
    // Tracking, pagination and a changed hash do not constitute a new search.
    const query = (url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim().replace(/\s+/gu, " ").toLowerCase();
    const identity = new URL(url.origin + url.pathname);
    identity.searchParams.set("q", query);
    return identity.href;
  } catch { return null; }
}

export function redditReviewDestination(value: string): string | null {
  try {
    let url = new URL(value);
    if (/^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(url.hostname) && url.pathname === "/url") {
      url = new URL(url.searchParams.get("url") || url.searchParams.get("q") || "");
    } else if (/(^|\.)duckduckgo\.com$/u.test(url.hostname) && url.pathname === "/l/") {
      url = new URL(url.searchParams.get("uddg") || "");
    } else if (/^(www\.)?bing\.com$/u.test(url.hostname) && url.pathname === "/ck/a") {
      const encoded = url.searchParams.get("u") || "";
      if (!encoded.startsWith("a1")) return null;
      url = new URL(atob(encoded.slice(2).replace(/-/gu, "+").replace(/_/gu, "/")));
    }
    if (!redditReviewPostId(url.href)) return null;
    return url.href;
  } catch { return null; }
}

// Google sometimes keeps the destination opaque until its /goto redirect.
// A short-lived navigation ticket can follow this wrapper; it is not a post
// grant until the browser actually arrives at a supported Reddit permalink.
export function redditReviewRedirect(value: string, source: string): boolean {
  try {
    const url = new URL(value);
    const page = new URL(source);
    return Boolean(redditReviewSearchPage(source) && url.protocol === "https:" && !url.username && !url.password && !url.port
      && url.hostname === page.hostname && ["/goto", "/url", "/l/", "/ck/a"].includes(url.pathname));
  } catch { return false; }
}

export function vigilReturnPage(value: string, extensionRoot: string): boolean {
  try {
    const url = new URL(value);
    const root = new URL(extensionRoot);
    if (url.protocol === root.protocol && url.host === root.host && ["/blocked.html", "/reddit-review-blocked.html"].includes(url.pathname)) return true;
    return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/blocked";
  } catch { return false; }
}
