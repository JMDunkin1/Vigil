export function resolveMacSigningIdentity(env?: NodeJS.ProcessEnv, preferredIdentity?: string): Promise<string>;
export function selectMacSigningIdentity(identities: readonly string[], preferredIdentity?: string): string;
export function isLocallyRebuildableSignature(detail: string): boolean;
export function macSigningTimestamp(identity: string): "none" | undefined;
