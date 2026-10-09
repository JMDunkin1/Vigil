// Search text belongs to declared query fields and discovery routes. Do not
// turn arbitrary URL metadata or route scaffolding into apparent search words.
export const SEARCH_PARAMETER_NAMES = new Set([
  "q", "query", "searchquery", "search_query", "search", "searchterm", "search_term",
  "keyword", "keywords", "term", "text", "p", "k", "s", "wd", "word", "tags", "tag", "mode"
]);
const SEARCH_ROUTE_CONTEXT_PATTERN = /(?:^|\/)(advancedsearch(?:\.(?:php|json|html|aspx))?|search(?:\.(?:php|json|html|aspx))?|results?|find|browse|tags?|tagged|hashtag|r|tag-[^/?#]+)(?=\/|$)/iu;
const STRUCTURED_SEARCH_PARAMETER_PATTERN = /^(q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|p|k|s|wd|word|tags|tag)\[(\d*|q|query|searchquery|search_query|search|searchterm|search_term|keyword|keywords|term|text|word|tags|tag)\]$/iu;

export function decodeSearchQueryValue(value: string): string {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = value.replace(/(?:%[a-f0-9]{2})+/giu, run => {
      try { return decodeURIComponent(run); }
      catch {
        return run.replace(/%([a-f0-9]{2})/giu, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
      }
    });
    if (next === value) break;
    value = next;
  }
  // URLSearchParams already decodes query separators. A percent-encoded plus
  // is literal content (for example 18+) and must survive nested decoding.
  return value;
}

export function isProtectedSearchParameter(name: string, onSearchRoute = false): boolean {
  const normalized = decodeSearchQueryValue(name).toLowerCase();
  return SEARCH_PARAMETER_NAMES.has(normalized)
    || (onSearchRoute && STRUCTURED_SEARCH_PARAMETER_PATTERN.test(normalized));
}

function searchRoutePath(value: string): string {
  return decodeSearchQueryValue(value.replace(/^#!?/u, "").split("?", 1)[0]);
}

export function looksLikeSearchRoute(value: string): boolean {
  return SEARCH_ROUTE_CONTEXT_PATTERN.test(searchRoutePath(value));
}

export function searchRouteText(value: string): string | null {
  const path = searchRoutePath(value);
  const match = SEARCH_ROUTE_CONTEXT_PATTERN.exec(path);
  if (!match) return null;
  // An embedded tag carries its value in the route segment itself. Keep that
  // segment so the existing platform-specific tag-adult rule retains context.
  const start = match[1].toLowerCase().startsWith("tag-")
    ? match.index + match[0].length - match[1].length
    : match.index + match[0].length;
  return path.slice(start).replace(/^\/+|\/+$/gu, "");
}

export function searchQueries(value: unknown): Array<{ query: string; hostname: string }> {
  let url: URL;
  try { url = new URL(String(value || "")); }
  catch { return []; }
  if (!["http:", "https:"].includes(url.protocol)) return [];
  const fragment = url.hash.replace(/^#!?/u, "");
  const pathIsSearch = looksLikeSearchRoute(url.pathname);
  const fragmentIsSearch = looksLikeSearchRoute(fragment);
  const queries = [...url.searchParams]
    .filter(([name]) => isProtectedSearchParameter(name, pathIsSearch || fragmentIsSearch))
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
    if (text) queries.push(text);
  }
  return queries.map(query => ({ query, hostname: url.hostname }));
}
