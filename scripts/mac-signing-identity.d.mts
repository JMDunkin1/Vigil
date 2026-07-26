export function resolveMacSigningIdentity(env?: NodeJS.ProcessEnv, preferredIdentity?: string): Promise<string>;
export function selectMacSigningIdentity(identities: readonly string[], preferredIdentity?: string): string;
export function isLocallyRebuildableSignature(detail: string): boolean;
export function designatedRequirementFromCodesignOutput(stdout?: string, stderr?: string): string;
export function signingIdentityFromCodesignDetail(detail: string): string;
export function macSigningTimestamp(identity: string): "none" | undefined;
