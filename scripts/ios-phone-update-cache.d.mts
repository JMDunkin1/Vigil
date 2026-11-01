export function ensurePhoneRuntime(root: string, build: () => Promise<unknown>): Promise<{ reused: boolean }>;
export function phoneBuildCacheRoot(root: string, edition: string, home?: string): string;
export function phoneUpdateIsCurrent(report: unknown, options?: { pushNotifications?: string; force?: boolean; replaceLegacy?: boolean }): boolean;
export function serviceLaunchReceiptMatches(selection: unknown, access: unknown, service: string, started: number): boolean;
export function withStablePhoneSources<T>(action: () => Promise<T>, retry: () => Promise<void> | void): Promise<T>;
