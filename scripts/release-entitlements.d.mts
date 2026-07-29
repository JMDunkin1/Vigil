export interface EntitlementVerificationOptions {
  requireJit?: boolean;
  allowOnlyJit?: boolean;
}

export interface EntitlementSourceVerificationOptions extends EntitlementVerificationOptions {
  parse?: (source: string) => unknown | Promise<unknown>;
}

export function verifyEntitlementObject(
  value: unknown,
  label: string,
  options?: EntitlementVerificationOptions
): void;

export function verifyEntitlementSource(
  source: unknown,
  label: string,
  options?: EntitlementSourceVerificationOptions
): Promise<void>;
