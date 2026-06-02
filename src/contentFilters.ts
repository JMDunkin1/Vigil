import { integrityLockdownActive } from "./integrityLockdown.js";
import { hostMatchesSiteTargets, normalizeHost } from "./policy.js";
import type { ActivePolicy, VigilState, UnknownRecord } from "./types.js";

interface ContentFilterRule {
  id: string;
  label: string;
  sites: string[];
  urlFilters: string[];
  paths: RegExp[];
}

export interface ContentFilterMatch extends UnknownRecord {
  id: string;
  label: string;
  hostname: string;
  url: string;
}

export interface ContentFilterRuleEntry {
  id: string;
  label: string;
  urlFilter: string;
  mode: string;
  kind: "content-filter";
  until: string;
}

export const CONTENT_FILTER_RULES: ContentFilterRule[] = [
  {
    id: "youtube-shorts",
    label: "YouTube Shorts",
    sites: ["youtube.com", "youtu.be"],
    urlFilters: ["||youtube.com/shorts", "||m.youtube.com/shorts"],
    paths: [/^\/shorts(?:\/|$)/i]
  },
  {
    id: "instagram-reels",
    label: "Instagram Reels",
    sites: ["instagram.com"],
    urlFilters: ["||instagram.com/reel", "||instagram.com/reels"],
    paths: [/^\/reels?(?:\/|$)/i]
  },
  {
    id: "facebook-reels",
    label: "Facebook Reels",
    sites: ["facebook.com", "fb.com"],
    urlFilters: ["||facebook.com/reel", "||facebook.com/watch/reel"],
    paths: [/^\/reel(?:\/|$)/i, /^\/watch\/reel(?:\/|$)/i]
  },
  {
    id: "reddit-popular",
    label: "Reddit Popular",
    sites: ["reddit.com", "redd.it"],
    urlFilters: ["||reddit.com/r/popular", "||reddit.com/r/all"],
    paths: [/^\/r\/popular(?:\/|$)/i, /^\/r\/all(?:\/|$)/i]
  },
  {
    id: "x-explore",
    label: "X Explore",
    sites: ["x.com", "twitter.com"],
    urlFilters: ["||x.com/explore", "||twitter.com/explore"],
    paths: [/^\/explore(?:\/|$)/i]
  },
  {
    id: "snapchat-spotlight",
    label: "Snapchat Spotlight",
    sites: ["snapchat.com"],
    urlFilters: ["||snapchat.com/spotlight"],
    paths: [/^\/spotlight(?:\/|$)/i]
  },
  {
    id: "tiktok-feed",
    label: "TikTok Feed",
    sites: ["tiktok.com", "tiktokv.com"],
    urlFilters: ["||tiktok.com"],
    paths: [/^\/(?:foryou|following|@|tag|music|video|t|$)/i]
  }
];

export function contentFilterEnabled(state: VigilState): boolean {
  return integrityLockdownActive(state) || state.settings?.contentFilterEnabled !== false;
}

export function matchContentFilterUrl(state: VigilState, value: unknown): ContentFilterMatch | null {
  if (!contentFilterEnabled(state)) return null;
  const parsed = parseUrl(value);
  if (!parsed) return null;
  const hostname = normalizeHost(parsed.hostname);
  for (const rule of CONTENT_FILTER_RULES) {
    if (!hostMatchesSiteTargets(hostname, rule.sites)) continue;
    if (!rule.paths.some((pattern) => pattern.test(parsed.pathname))) continue;
    return {
      id: rule.id,
      label: rule.label,
      hostname,
      url: parsed.toString()
    };
  }
  return null;
}

export function contentFilterRuleEntries(state: VigilState, policy: ActivePolicy | null | undefined): ContentFilterRuleEntry[] {
  if (!contentFilterEnabled(state) || !policy) return [];
  return CONTENT_FILTER_RULES.flatMap((rule) => {
    return rule.urlFilters.map((urlFilter) => ({
      id: rule.id,
      label: rule.label,
      urlFilter,
      mode: policy.session?.mode || "focus",
      kind: "content-filter",
      until: policy.endsAt || policy.session?.endsAt || ""
    }));
  });
}

function parseUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
