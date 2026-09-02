import { SOFT_BLOCK_PROFILE_ID } from "./defaults.js";
import { activePolicy, baselinePolicy, hostMatchesSiteTargets, normalizeHost } from "./policy.js";
import type { ActivePolicy, VigilState, UnknownRecord } from "./types.js";

interface ContentFilterRule {
  id: string;
  label: string;
  sites: string[];
  urlFilters: string[];
  paths: RegExp[];
  fallbackUrl?: string;
  scope: "permanent" | "soft-lock";
}

export interface ContentFilterMatch extends UnknownRecord {
  id: string;
  label: string;
  hostname: string;
  url: string;
  fallbackUrl?: string;
}

export interface ContentFilterRuleEntry {
  id: string;
  label: string;
  urlFilter: string;
  fallbackUrl?: string;
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
    paths: [/^\/shorts(?:\/|$)/i],
    fallbackUrl: "https://www.youtube.com/",
    scope: "permanent"
  },
  {
    id: "instagram-reels",
    label: "Instagram Reels",
    sites: ["instagram.com"],
    // The plural route is Instagram's unbounded Reels destination. Singular
    // /reel/{id} permalinks remain available for items shared by a friend.
    urlFilters: ["||instagram.com/reels"],
    paths: [/^\/reels(?:\/|$)/i],
    fallbackUrl: "https://www.instagram.com/direct/inbox/",
    scope: "permanent"
  },
  {
    id: "instagram-explore",
    label: "Instagram Explore",
    sites: ["instagram.com"],
    urlFilters: ["||instagram.com/explore"],
    paths: [/^\/explore(?:\/|$)/i],
    fallbackUrl: "https://www.instagram.com/direct/inbox/",
    scope: "soft-lock"
  },
  {
    id: "instagram-shopping-live",
    label: "Instagram Shopping and Live",
    sites: ["instagram.com"],
    urlFilters: ["||instagram.com/shop", "||instagram.com/shopping", "||instagram.com/live"],
    paths: [/^\/(?:shop|shopping|live)(?:\/|$)/i],
    fallbackUrl: "https://www.instagram.com/direct/inbox/",
    scope: "soft-lock"
  },
  {
    id: "youtube-explore",
    label: "YouTube Explore and Recommendations",
    sites: ["youtube.com"],
    urlFilters: ["||youtube.com/feed/explore", "||m.youtube.com/feed/explore", "||youtube.com/feed/trending", "||m.youtube.com/feed/trending", "||youtube.com/feed/recommended", "||m.youtube.com/feed/recommended"],
    paths: [/^\/feed\/(?:explore|trending|recommended)(?:\/|$)/i],
    fallbackUrl: "https://www.youtube.com/feed/subscriptions",
    scope: "soft-lock"
  },
  {
    id: "facebook-reels",
    label: "Facebook Reels",
    sites: ["facebook.com", "fb.com"],
    urlFilters: ["||facebook.com/reel", "||facebook.com/watch/reel"],
    paths: [/^\/reel(?:\/|$)/i, /^\/watch\/reel(?:\/|$)/i],
    fallbackUrl: "https://www.facebook.com/",
    scope: "soft-lock"
  },
  {
    id: "reddit-popular",
    label: "Reddit Popular",
    sites: ["reddit.com", "redd.it"],
    urlFilters: ["||reddit.com/r/popular", "||reddit.com/r/all"],
    paths: [/^\/r\/popular(?:\/|$)/i, /^\/r\/all(?:\/|$)/i],
    fallbackUrl: "https://www.reddit.com/",
    scope: "soft-lock"
  },
  {
    id: "reddit-mature-gate",
    label: "Reddit mature-content gate",
    sites: ["reddit.com"],
    urlFilters: ["||reddit.com/over18"],
    paths: [/^\/over18(?:\/|$)/i],
    fallbackUrl: "https://www.reddit.com/",
    scope: "permanent"
  },
  {
    id: "x-explore",
    label: "X Explore",
    sites: ["x.com", "twitter.com"],
    urlFilters: ["||x.com/explore", "||twitter.com/explore"],
    paths: [/^\/explore(?:\/|$)/i],
    fallbackUrl: "https://x.com/home",
    scope: "soft-lock"
  },
  {
    id: "snapchat-spotlight",
    label: "Snapchat Spotlight",
    sites: ["snapchat.com"],
    urlFilters: ["||snapchat.com/spotlight", "||web.snapchat.com/spotlight"],
    paths: [/^\/spotlight(?:\/|$)/i],
    fallbackUrl: "https://web.snapchat.com/",
    scope: "permanent"
  },
  {
    id: "snapchat-discover",
    label: "Snapchat Discover",
    sites: ["snapchat.com"],
    urlFilters: ["||snapchat.com/discover"],
    paths: [/^\/discover(?:\/|$)/i],
    fallbackUrl: "https://web.snapchat.com/",
    scope: "permanent"
  },
  {
    id: "snapchat-public-stories",
    label: "Snapchat public Stories",
    sites: ["story.snapchat.com"],
    urlFilters: ["||story.snapchat.com"],
    paths: [/^\/(?:$|s(?:\/|$)|p(?:\/|$))/i],
    fallbackUrl: "https://web.snapchat.com/",
    scope: "permanent"
  },
  {
    id: "tiktok-feed",
    label: "TikTok Feed",
    sites: ["tiktok.com", "tiktokv.com"],
    urlFilters: ["||tiktok.com"],
    paths: [/^\/(?:foryou|following|@|tag|music|video|t|$)/i],
    scope: "soft-lock"
  }
];

export function contentFilterEnabled(state: VigilState): boolean {
  void state;
  return true;
}

export function matchContentFilterUrl(state: VigilState, value: unknown, policy: ActivePolicy | null = activePolicy(state) || baselinePolicy(state)): ContentFilterMatch | null {
  if (!contentFilterEnabled(state)) return null;
  const parsed = parseUrl(value);
  if (!parsed) return null;
  const hostname = normalizeHost(parsed.hostname);
  for (const rule of CONTENT_FILTER_RULES) {
    if (!contentFilterRuleApplies(rule, policy)) continue;
    if (!hostMatchesSiteTargets(hostname, rule.sites)) continue;
    if (!rule.paths.some((pattern) => pattern.test(parsed.pathname))) continue;
    return {
      id: rule.id,
      label: rule.label,
      hostname,
      url: parsed.toString(),
      fallbackUrl: rule.fallbackUrl
    };
  }
  return null;
}

export function contentFilterRuleEntries(state: VigilState, policy: ActivePolicy | null | undefined): ContentFilterRuleEntry[] {
  if (!contentFilterEnabled(state) || !policy) return [];
  return CONTENT_FILTER_RULES.filter((rule) => contentFilterRuleApplies(rule, policy)).flatMap((rule) => {
    return rule.urlFilters.map((urlFilter) => ({
      id: rule.id,
      label: rule.label,
      urlFilter,
      fallbackUrl: rule.fallbackUrl,
      mode: policy.session?.mode || "focus",
      kind: "content-filter",
      until: policy.endsAt || policy.session?.endsAt || ""
    }));
  });
}

function contentFilterRuleApplies(rule: ContentFilterRule, policy: ActivePolicy | null | undefined): boolean {
  if (rule.scope === "permanent") return true;
  return policy?.profile?.id === SOFT_BLOCK_PROFILE_ID;
}

function parseUrl(value: unknown): URL | null {
  try {
    const url = new URL(String(value || ""));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}
