import { DEFAULT_EXPLICIT_BLOCKED_SITES } from "./defaults.js";
import { DEFAULT_FILTER_BYPASS_BLOCKED_SITES, DEFAULT_PRIORITY_ADULT_BLOCKED_SITES } from "./priorityBlockedDomains.js";

// These domains are denied in every built-in profile. Bundling them keeps
// permanent protection independent of pairing, worker startup, and the finite
// dynamic-rule snapshot. The native policy remains authoritative for other rules.
export function browserPermanentBlockedDomains(): string[] {
  return [...new Set([
    ...DEFAULT_EXPLICIT_BLOCKED_SITES,
    ...DEFAULT_PRIORITY_ADULT_BLOCKED_SITES,
    ...DEFAULT_FILTER_BYPASS_BLOCKED_SITES
  ])].sort();
}

export function browserPermanentDomainRules(): chrome.declarativeNetRequest.Rule[] {
  const requestDomains = browserPermanentBlockedDomains();
  return [
    {
      id: 1,
      priority: 1_000,
      action: { type: "redirect", redirect: { extensionPath: "/blocked.html" } },
      condition: { requestDomains, resourceTypes: ["main_frame"] }
    },
    {
      id: 2,
      priority: 1_000,
      action: { type: "block" },
      condition: {
        requestDomains,
        resourceTypes: ["sub_frame", "script", "image", "stylesheet", "object", "xmlhttprequest", "ping", "csp_report", "media", "font", "websocket", "webtransport", "webbundle", "other"]
      }
    }
  ] as chrome.declarativeNetRequest.Rule[];
}
