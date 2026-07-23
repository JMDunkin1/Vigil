import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { managedFilterAllowsVigilPages } from "./blockedPageUrl.js";
import type { UnknownRecord } from "./types.js";

const execFileAsync = promisify(execFile);

export const APPLE_CONTENT_FILTER_DOMAIN = "com.apple.familycontrols.contentfilter";

export interface AppleContentFilterStatus extends UnknownRecord {
  required: boolean;
  current: boolean;
  restrictWeb: boolean;
  useContentFilter: boolean;
  allowListEnabled: boolean;
  denyUrlCount: number;
  siteAllowListCount: number;
  vigilPagesReachable: boolean;
  path: string;
  detail: string;
  error?: string;
}

interface AppleContentFilterOptions {
  path?: string;
  required?: boolean;
  username?: string;
}

export function appleContentFilterManagedPath(username = userInfo().username): string {
  return join("/Library/Managed Preferences", username, `${APPLE_CONTENT_FILTER_DOMAIN}.plist`);
}

export async function appleContentFilterStatus(options: AppleContentFilterOptions = {}): Promise<AppleContentFilterStatus> {
  const required = options.required !== false;
  const path = options.path || appleContentFilterManagedPath(options.username);
  try {
    const { stdout } = await execFileAsync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", path], {
      timeout: 5000,
      maxBuffer: 1024 * 512
    });
    return appleContentFilterStatusFromRecord(JSON.parse(stdout) as UnknownRecord, path, required);
  } catch (error) {
    return {
      required,
      current: false,
      restrictWeb: false,
      useContentFilter: false,
      allowListEnabled: false,
      denyUrlCount: 0,
      siteAllowListCount: 0,
      vigilPagesReachable: false,
      path,
      detail: "Apple Screen Time Limit Adult Websites is not active.",
      error: simplifyError(error)
    };
  }
}

export function appleContentFilterStatusFromRecord(
  record: UnknownRecord,
  path = appleContentFilterManagedPath(),
  required = true
): AppleContentFilterStatus {
  const restrictWeb = record.restrictWeb === true;
  const useContentFilter = record.useContentFilter === true;
  const allowListEnabled = record.allowListEnabled === true;
  const denyUrlCount = Math.max(
    Array.isArray(record.filterDenyList) ? record.filterDenyList.length : 0,
    Array.isArray(record.filterBlacklist) ? record.filterBlacklist.length : 0
  );
  const siteAllowList = [
    ...(Array.isArray(record.siteAllowList) ? record.siteAllowList : []),
    ...(Array.isArray(record.siteWhitelist) ? record.siteWhitelist : [])
  ];
  const siteAllowListCount = siteAllowList.length;
  const vigilPagesReachable = managedFilterAllowsVigilPages(siteAllowList);
  // `current` is an enforcement-health signal consumed by fail-closed
  // integrity logic. Keep it scoped to whether Apple's filter is active; the
  // branded-page reachability check is reported separately so an older-but-
  // still-enforcing profile is marked stale without triggering a false outage.
  const current = restrictWeb && useContentFilter;
  return {
    required,
    current,
    restrictWeb,
    useContentFilter,
    allowListEnabled,
    denyUrlCount,
    siteAllowListCount,
    vigilPagesReachable,
    path,
    detail: appleContentFilterDetail({
      filterActive: restrictWeb && useContentFilter,
      allowListEnabled,
      denyUrlCount,
      vigilPagesReachable
    })
  };
}

function appleContentFilterDetail({
  filterActive,
  allowListEnabled,
  denyUrlCount,
  vigilPagesReachable
}: {
  filterActive: boolean;
  allowListEnabled: boolean;
  denyUrlCount: number;
  vigilPagesReachable: boolean;
}): string {
  if (!filterActive) return "Apple Screen Time Limit Adult Websites is off.";
  if (!vigilPagesReachable) return "Apple Screen Time is active, but Vigil's local block page is not allowed.";
  if (allowListEnabled) return "Apple Screen Time web content is restricted to allowed websites.";
  return `Apple Screen Time Limit Adult Websites is on${denyUrlCount ? ` (${denyUrlCount} deny URLs)` : ""}.`;
}

function simplifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}
