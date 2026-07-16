import { createHash } from "node:crypto";

/** Persist a fixed-size digest while the browser companion continues to use
 * the canonical JSON signature for independent normalization checks. */
export function compactExtensionRuleSignature(signature: unknown): string {
  const value = String(signature || "");
  if (/^sha256:[a-f0-9]{64}$/u.test(value)) return value;
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
