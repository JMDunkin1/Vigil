export interface PhoneSuiteOptions {
  bump: "patch" | "minor" | "major";
  device: string;
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
export function isLegacyPhoneBundleIdentifier(bundleIdentifier: unknown): boolean;
export function policyFreshnessProblems(options?: {
  installedProfileName?: string;
  receiptFingerprint?: string;
  livePolicyFingerprint?: string;
}): string[];
export function preservedPolicyReceipt(receipt: unknown): { policyFingerprint: string; policyArtifactHash: string };
export function implementationFingerprint(): Promise<{
  hash: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  blocklistPath: string;
}>;
