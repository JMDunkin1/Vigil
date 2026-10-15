export const RENEWAL_WINDOW_MS: number;
export const FRESH_SIGNING_WINDOW_MS: number;
export interface SigningProfile { name: string; expiresAt: string; uuid?: string; teamIdentifier?: string }
export interface RenewalResult {
  status: "unconfigured" | "unverified" | "current" | "sources-changed" | "due" | "renewed" | "needs-connection";
  expiresAt?: string;
  device?: string;
  detail?: string;
}
export function signingProfilesNeedingRefresh<T extends SigningProfile>(profiles: T[], now?: number, window?: number): T[];
export function freshSigningBuild<T extends SigningProfile>(options: {
  build: () => Promise<void>;
  readProfiles: () => Promise<T[]>;
  quarantine: (profiles: T[]) => Promise<void>;
  now?: () => number;
  window?: number;
}): Promise<T[]>;
export function renewalDecision(receipt: unknown, fingerprint: string, now?: number): RenewalResult;
export function verifiedLauncherState(receipt: unknown, now?: number): { schemaVersion: number; expiresAt: string; updatedAt?: string };
export function publishPhoneLauncherState(receipt: unknown, root?: string, home?: string): Promise<string[]>;
export function withPhoneUpdateLock<T>(root: string, action: () => Promise<T>): Promise<T>;
export function renewalLaunchAgent(options: { root: string; node: string; home: string; device: string; server: string }): string;
export function installPhoneRenewal(device: string, server: string, root?: string): Promise<void>;
export function runPhoneRenewal(options: { receipt: unknown; fingerprint: string; now?: number; update: (device: string) => Promise<void> }): Promise<RenewalResult>;
