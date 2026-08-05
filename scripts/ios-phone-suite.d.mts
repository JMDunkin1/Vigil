export interface PhoneSuiteOptions {
  allowEditionDowngrade: boolean;
  bump: "patch" | "minor" | "major";
  device: string;
  edition: "" | "personal" | "enhanced";
  force: boolean;
  json: boolean;
  noPolicy: boolean;
  replaceLegacy: boolean;
  server: string;
}

export function parseArguments(args: string[]): { command: string; options: PhoneSuiteOptions };
export function incrementVersion(version: string, level: "patch" | "minor" | "major"): string;
export function iosSdkSupportsDevice(iosSdk: number, deviceOsVersion: string): boolean;
export function isPhoneImplementationFile(path: string): boolean;
export function isSocialAppImplementationFile(path: string, appId: "instagram" | "youtube"): boolean;
export function isLegacyPhoneBundleIdentifier(bundleIdentifier: unknown): boolean;
export function policyFreshnessProblems(options?: {
  installedProfileName?: string;
  receiptFingerprint?: string;
  livePolicyFingerprint?: string;
}): string[];
export function preservedPolicyReceipt(receipt: unknown): { policyFingerprint: string; policyArtifactHash: string };
export function receiptPhoneEdition(receipt: unknown): "personal" | "enhanced";
export function removalPasswordFromProfile(profile: unknown): string;
export interface SafariExtensionUpdateContract {
  bundleIdentifier: string;
  sha256: string;
  manifestVersion: number;
  hostPermissions: string[];
  contentScriptMatches: string[];
  permissions: string[];
}
export function safariExtensionUpdateProblems(
  previousReceipt: unknown,
  nextApps: Array<{ bundleId: string; youtubeInteractionExtension?: SafariExtensionUpdateContract | null }> | null | undefined
): string[];
export interface PhoneBlocklistReadiness {
  ready: boolean;
  path: string;
  domainCount: number;
  snapshotHash: string;
  payloadSha256: string;
  artifactSha256: string;
  bytes: number;
  generatedAt: string;
  source: { id?: string; label?: string; url?: string; homepage?: string; license?: string } | null;
  error: string;
}
export function inspectPhoneBlocklistBytes(value: Uint8Array, path?: string): PhoneBlocklistReadiness;
export function phoneBlocklistReadiness(explicitPath?: string): Promise<PhoneBlocklistReadiness>;
export function blocklistReadinessProblems(readiness: PhoneBlocklistReadiness, serverState?: unknown): string[];
export function deployedBlocklistProblems(receipt: unknown, readiness: PhoneBlocklistReadiness, requiredBundleIds?: string[]): string[];
export function signingCapabilitySummary(variant: unknown): { variant: string; mediaCapability: string };
export function implementationFingerprint(edition?: "personal" | "enhanced"): Promise<{
  hash: string;
  edition: "personal" | "enhanced";
  files: Array<{ path: string; bytes: number; sha256: string }>;
  blocklistPath: string;
}>;
export function socialAppImplementationFingerprint(
  appId: "instagram" | "youtube"
): Promise<{
  hash: string;
  appId: "instagram" | "youtube";
  files: Array<{ path: string; bytes: number; sha256: string }>;
}>;
export function socialAppsNeedingUpdate(
  release: { apps: Record<string, { version: string; build: number }> },
  installedApps?: Array<{ bundleIdentifier?: string; version?: string; bundleVersion?: string | number }>
): Array<"instagram" | "youtube">;
