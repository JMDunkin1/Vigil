import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  const current = restrictWeb && useContentFilter;
  return {
    required,
    current,
    restrictWeb,
    useContentFilter,
    allowListEnabled,
    denyUrlCount,
    path,
    detail: appleContentFilterDetail({ current, allowListEnabled, denyUrlCount })
  };
}

function appleContentFilterDetail({ current, allowListEnabled, denyUrlCount }: { current: boolean; allowListEnabled: boolean; denyUrlCount: number }): string {
  if (!current) return "Apple Screen Time Limit Adult Websites is off.";
  if (allowListEnabled) return "Apple Screen Time web content is restricted to allowed websites.";
  return `Apple Screen Time Limit Adult Websites is on${denyUrlCount ? ` (${denyUrlCount} deny URLs)` : ""}.`;
}

function simplifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error || "");
}
