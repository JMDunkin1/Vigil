import assert from "node:assert/strict";
import { defaultState } from "../src/defaults.js";
import { hardeningDriftPolicyFingerprint, policyBoundaryTransitionFingerprint } from "../src/monitor.js";
import type { Session } from "../src/types.js";

const state = defaultState();
const boundary = new Date(2026, 8, 17, 13, 0).getTime();
const session = (device: "computer" | "phone", endsAt: number): Session => ({
  id: `${device}-session`,
  title: `${device} focus`,
  mode: "focus",
  profileId: "default",
  lockLevel: "deep",
  startedAt: new Date(boundary - 60_000).toISOString(),
  endsAt: new Date(endsAt).toISOString(),
  deviceTargets: [device]
});
state.activeSessions = {
  computer: session("computer", boundary),
  phone: session("phone", boundary + 60_000)
};
state.activeSession = state.activeSessions.computer || null;
state.limitBlocks = [{
  id: "expired-limit", ruleId: "rule", ruleName: "Expired limit", type: "time", lockLevel: "deep",
  apps: [], sites: ["example.com"], createdAt: new Date(boundary - 60_000).toISOString(),
  until: new Date(boundary).toISOString(), progress: {}, deviceTargets: ["computer"]
}];
const original = structuredClone(state);
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child);
}
freeze(state);

const before = JSON.parse(policyBoundaryTransitionFingerprint(state, new Date(boundary - 1)));
const after = JSON.parse(policyBoundaryTransitionFingerprint(state, new Date(boundary)));
assert.equal(before.policies.computer.session.id, "computer-session");
assert.equal(before.policies.phone.session.id, "phone-session");
assert.equal(after.policies.computer, null, "computer expiry must be evaluated at the exact boundary");
assert.equal(after.policies.phone.session.id, "phone-session", "computer cleanup must not expire the phone session");
assert.deepEqual(before.activeLimitIds.computer, ["expired-limit"]);
assert.deepEqual(after.activeLimitIds.computer, []);
assert.notEqual(before.extensionRules.expectedSignature, after.extensionRules.expectedSignature,
  "expired site limits must change the expected browser rules");

const hardenedBefore = JSON.parse(hardeningDriftPolicyFingerprint(state, new Date(boundary - 1)));
const hardenedAfter = JSON.parse(hardeningDriftPolicyFingerprint(state, new Date(boundary)));
assert.equal(hardenedBefore.activePolicy.session.id, "computer-session");
assert.equal(hardenedAfter.activePolicy, null);
assert.equal(hardenedAfter.limitBlocks.length, 1, "raw attestation inputs must retain the original state");
assert.deepEqual(state, original, "policy evaluation must not mutate committed state or expiry records");
assert.equal(policyBoundaryTransitionFingerprint(state, new Date(boundary - 1)), JSON.stringify(before),
  "evaluating after expiry must not contaminate a later before-boundary comparison");
