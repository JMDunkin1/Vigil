export interface EntitlementVerificationOptions {
  requireJit?: boolean;
  allowOnlyJit?: boolean;
}

export function verifyEntitlementObject(
  value: unknown,
  label: string,
  options?: EntitlementVerificationOptions
): void;
