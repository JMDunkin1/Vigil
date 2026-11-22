export const COMBINED_SOCIAL_SERVICE_IDS: readonly string[];
export function ensurePhoneRuntime(root: string, build: () => Promise<unknown>): Promise<{ reused: boolean }>;
export function phoneBuildCacheRoot(root: string, edition: string, home?: string): string;
export function phoneUpdateIsCurrent(report: unknown, options?: { pushNotifications?: string; force?: boolean; replaceLegacy?: boolean; verifyServices?: boolean }): boolean;
export function reusableServiceLaunchBuild(receipt: unknown, options: {
  device: { udid?: string; osVersion?: string };
  installedApp?: { version?: string; bundleVersion?: string | number };
  edition: string;
  policyFingerprint: string;
  policyAlreadyCurrent: boolean;
  settingsChanged?: boolean;
  pushNotifications: string;
  replaceLegacy?: boolean;
  verifyServices?: boolean;
}): number | null;
export function serviceLaunchReceiptMatches(selection: unknown, access: unknown, service: string, started: number): boolean;
export function withStablePhoneSources<T>(action: () => Promise<T>, retry: () => Promise<void> | void): Promise<T>;
