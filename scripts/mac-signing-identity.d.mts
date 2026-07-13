export function resolveMacSigningIdentity(env?: NodeJS.ProcessEnv): Promise<string>;
export function isLocallyRebuildableSignature(detail: string): boolean;
export function macSigningTimestamp(identity: string): "none" | undefined;
