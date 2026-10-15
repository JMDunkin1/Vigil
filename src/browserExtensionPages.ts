// Inline this helper into both browser guards. Losing the extension context
// must still leave restricted content, even when its block page is unavailable.
export function browserProtectionPageURL(page: "blocked.html" | "search-break.html"): string {
  try {
    const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || globalThis.chrome;
    const target = api.runtime.getURL(page);
    return typeof target === "string" && target ? target : "about:blank";
  } catch { return "about:blank"; }
}
