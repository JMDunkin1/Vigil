export interface BlockPageDiagnosticInput {
  source: string;
  kind: string;
  target?: string;
  policyId?: string;
  until?: string;
  detail?: string;
}

const BLOCK_REFERENCE_KINDS: Record<string, string> = {
  "adult-blocklist": "ADULT", allowlist: "ALLOW", "app-lock": "APP",
  baseline: "BASE", "browser-control": "BROWSER", "browser-protection": "CONNECTION",
  "content-filter": "FILTER", "explicit-content": "CONTENT", integrity: "INTEGRITY",
  limit: "LIMIT", "url-pattern": "URL", focus: "FOCUS", lock: "LOCK",
  "search-break": "BREAK", https: "HTTPS", "filter-unavailable": "UNAVAILABLE"
};

// A readable screenshot reference, never an authorization token. Full context
// remains in the page's diagnostic metadata rather than its visible message.
export function blockPageDiagnostic(input: BlockPageDiagnosticInput) {
  const source = input.source.toUpperCase().replace(/[^A-Z0-9]/gu, "").slice(0, 12) || "UNKNOWN";
  const kind = input.kind.toLowerCase().trim().slice(0, 80) || "rule";
  const diagnostic = {
    schema: 1,
    source,
    kind,
    target: String(input.target || "").slice(0, 2048),
    policyId: String(input.policyId || "").slice(0, 240),
    until: String(input.until || "").slice(0, 80),
    detail: String(input.detail || "").slice(0, 2048)
  };
  const identity = JSON.stringify([source, kind, diagnostic.target, diagnostic.policyId, diagnostic.until]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index++) {
    hash = Math.imul(hash ^ identity.charCodeAt(index), 0x01000193) >>> 0;
  }
  return {
    ...diagnostic,
    reference: `V1-${source}-${BLOCK_REFERENCE_KINDS[kind] || "RULE"}-${hash.toString(16).padStart(8, "0").toUpperCase()}`
  };
}
