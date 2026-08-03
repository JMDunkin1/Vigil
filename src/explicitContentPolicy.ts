export const EXPLICIT_CONTENT_POLICY_SCHEMA_VERSION = 1;

export interface ExplicitContentContextualRule {
  id: string;
  contexts: readonly string[];
  markers: readonly string[];
}

export interface ExplicitContentTextPolicy {
  schemaVersion: number;
  terms: string[];
  phrases: string[];
  contextualRules: Array<{
    id: string;
    contexts: string[];
    markers: string[];
    maximumDistanceCharacters: number;
  }>;
}

export interface ExplicitContentTextPolicySource {
  blockedSites: readonly string[];
  comicSiteTerms: readonly string[];
  contextualRules: readonly ExplicitContentContextualRule[];
  searchTerms: readonly string[];
}

const UNAMBIGUOUS_EXPLICIT_PHRASES = [
  "pornographic content",
  "explicit sexual content",
  "hardcore pornography",
  "nude photos",
  "nude videos",
  "sex videos",
  "xxx videos"
] as const;

const CONTEXTUAL_MATCH_DISTANCE = 120;

/**
 * Produces the compact policy used by iOS page-text inspection from the same
 * explicit-site, search-term, and contextual-rule inputs as Vigil's main
 * navigation policy. URL-encoding-only age markers are deliberately omitted:
 * they are useful in a URL but too ambiguous in ordinary page prose.
 */
export function buildExplicitContentTextPolicy(source: ExplicitContentTextPolicySource): ExplicitContentTextPolicy {
  const terms = clean([
    ...source.searchTerms.filter(isUnambiguousPageTerm),
    ...source.comicSiteTerms,
    ...source.blockedSites.map(siteLabel)
  ]);
  const phrases = clean(UNAMBIGUOUS_EXPLICIT_PHRASES);
  const contextualRules = [...source.contextualRules]
    .map((rule) => ({
      id: rule.id.trim(),
      contexts: clean(rule.contexts),
      markers: clean(rule.markers.filter((marker) => marker !== "18" && marker !== "18plus")),
      maximumDistanceCharacters: CONTEXTUAL_MATCH_DISTANCE
    }))
    .filter((rule) => rule.id && rule.contexts.length && rule.markers.length)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    schemaVersion: EXPLICIT_CONTENT_POLICY_SCHEMA_VERSION,
    terms,
    phrases,
    contextualRules
  };
}

function clean(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
}

function isUnambiguousPageTerm(value: string): boolean {
  const term = value.trim().toLowerCase();
  return Boolean(term && !term.includes("%") && term !== "18+" && term !== "18-plus" && term !== "18plus");
}

function siteLabel(value: string): string {
  const host = value.trim().toLowerCase().replace(/^https?:\/\//u, "").split("/")[0] || "";
  return host.replace(/^www\./u, "").split(".")[0] || "";
}
