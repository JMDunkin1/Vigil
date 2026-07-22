export interface MacBuildVersionOptions {
  requireExplicit?: boolean;
}

export const LOCAL_MAC_BUILD_VERSION: string;
export function resolveMacBuildVersion(
  env?: NodeJS.ProcessEnv,
  options?: MacBuildVersionOptions
): string;
