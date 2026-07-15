const ALLOW_JIT = "com.apple.security.cs.allow-jit";
const FORBIDDEN = [
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation"
];

export function verifyEntitlementObject(value, label, { requireJit = false, allowOnlyJit = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must contain a property-list dictionary.`);
  }
  if (requireJit && value[ALLOW_JIT] !== true) {
    throw new Error(`${label} must grant allow-jit with a boolean true value.`);
  }
  for (const forbidden of FORBIDDEN) {
    if (Object.hasOwn(value, forbidden)) throw new Error(`${label} contains forbidden entitlement ${forbidden}.`);
  }
  if (allowOnlyJit) {
    const unexpected = Object.keys(value).filter((key) => key !== ALLOW_JIT);
    if (unexpected.length) throw new Error(`${label} emitted unexpected entitlement(s): ${unexpected.join(", ")}.`);
  }
}
