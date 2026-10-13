import {
  BRICK_MODE_PROFILE_ID,
  DEFAULT_ALWAYS_BANNED_URL_PATTERNS,
  DEFAULT_EXPLICIT_URL_PATTERNS,
  DEFAULT_SHORT_FORM_URL_PATTERNS,
  NORMAL_PROFILE_ID,
  SOFT_BLOCK_PROFILE_ID
} from "./defaults.js";
import { decodeSearchQueryValue } from "./searchQueryContext.js";
import { normalizeAutomaticExplicitText } from "./explicitMediaContext.js";
import type { Profile } from "./types.js";

const PRESET_PROFILE_IDS = new Set(["default", NORMAL_PROFILE_ID, SOFT_BLOCK_PROFILE_ID, BRICK_MODE_PROFILE_ID]);
const EXPLICIT_PRESET_PATTERNS = DEFAULT_EXPLICIT_URL_PATTERNS.map(presetPatternKey);
const AUTOMATIC_KEYWORD_PATTERNS = new Set(EXPLICIT_PRESET_PATTERNS.filter(pattern => !pattern.includes(".") && !pattern.includes("/")));
const GENERATED_COMPONENT_PATTERNS = new Set([
  ...DEFAULT_EXPLICIT_URL_PATTERNS,
  ...DEFAULT_ALWAYS_BANNED_URL_PATTERNS,
  ...DEFAULT_SHORT_FORM_URL_PATTERNS
].map(presetPatternKey).filter(pattern => !AUTOMATIC_KEYWORD_PATTERNS.has(pattern)));

// Strings alone carry no authoring provenance. A short custom dictionary,
// including one saved under a preset ID, keeps its authored literal semantics.
// Only complete generated presets opt in to automatic content interpretation.
export function usesAutomaticExplicitUrlPolicy(profile: Profile | null | undefined): boolean {
  if (!profile || !PRESET_PROFILE_IDS.has(profile.id)) return false;
  const patterns = new Set((profile.blockedUrlPatterns || []).map(presetPatternKey));
  return EXPLICIT_PRESET_PATTERNS.every(pattern => patterns.has(pattern));
}

export function isAutomaticExplicitKeywordPattern(pattern: unknown): boolean {
  return AUTOMATIC_KEYWORD_PATTERNS.has(presetPatternKey(pattern));
}

// Return null for authored rules so the caller retains its original matcher.
// Generated rules describe an actual destination, never a domain mentioned in
// a filename, nonce, return URL, unrelated host, or another query parameter.
export function matchGeneratedPresetUrlPattern(pattern: unknown, url: URL): boolean | null {
  const key = presetPatternKey(pattern);
  if (!GENERATED_COMPONENT_PATTERNS.has(key)) return null;
  let target: URL;
  try { target = new URL(`https://${key}`); }
  catch { return false; }
  const hostname = normalizedHost(url.hostname);
  const targetHost = normalizedHost(target.hostname);
  if (!hostname || (hostname !== targetHost && !hostname.endsWith(`.${targetHost}`))) return false;
  const path = canonicalPath(url.pathname);
  const targetPath = canonicalPath(target.pathname);
  if (targetPath !== "/" && path !== targetPath && !path.startsWith(`${targetPath}/`)) return false;
  for (const [name, value] of target.searchParams) {
    const values = [...url.searchParams]
      .filter(([actualName]) => actualName.toLowerCase() === name.toLowerCase())
      .map(([, actualValue]) => normalizeAutomaticExplicitText(decodeSearchQueryValue(actualValue)).toLowerCase());
    const expected = decodeSearchQueryValue(value).normalize("NFKC").toLowerCase();
    const escaped = expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const bounded = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "u");
    if (!values.some(actualValue => bounded.test(actualValue))) return false;
  }
  return true;
}

function presetPatternKey(value: unknown): string {
  const text = String(value || "").trim().toLowerCase();
  return text.replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/\s+/gu, "").replace(/^\/+/, "");
}

function normalizedHost(value: string): string {
  return value.toLowerCase().replace(/\.$/u, "").replace(/^www\./u, "");
}

function canonicalPath(value: string): string {
  const segments: string[] = [];
  for (const segment of decodeSearchQueryValue(value).toLowerCase().split(/[/\\]+/u)) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}
