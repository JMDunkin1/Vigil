import type { SentinelState } from "./types.js";
import { clampInteger } from "./normalizers.js";

export class IntentReasonError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export function intentReasonPolicy(state: Pick<SentinelState, "settings">): { enabled: boolean; minLength: number } {
  const settings = state.settings;
  return {
    enabled: settings.intentReasonEnabled !== false,
    minLength: clampInteger(settings.intentReasonMinLength, 1, 280, 20)
  };
}

export function intentReasonSummary(state: Pick<SentinelState, "settings">) {
  const policy = intentReasonPolicy(state);
  return {
    ...policy,
    ok: !policy.enabled || policy.minLength >= 1,
    detail: policy.enabled
      ? `Intentional breaks require a reason of at least ${policy.minLength} characters.`
      : "Intentional breaks can be requested without a reason."
  };
}

export function assertIntentReason(state: Pick<SentinelState, "settings">, reason: unknown, label = "This action"): string {
  const normalized = normalizeIntentReason(reason);
  const policy = intentReasonPolicy(state);
  if (!policy.enabled) return normalized;
  if (normalized.length < policy.minLength) {
    throw new IntentReasonError(`${label} requires a reason of at least ${policy.minLength} characters.`);
  }
  return normalized;
}

export function normalizeIntentReason(reason: unknown): string {
  return String(reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
}
