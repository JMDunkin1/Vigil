export class IntentReasonError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function intentReasonPolicy(state) {
  const settings = state.settings || {};
  return {
    enabled: settings.intentReasonEnabled !== false,
    minLength: clampInteger(settings.intentReasonMinLength, 1, 280, 20)
  };
}

export function intentReasonSummary(state) {
  const policy = intentReasonPolicy(state);
  return {
    ...policy,
    ok: !policy.enabled || policy.minLength >= 1,
    detail: policy.enabled
      ? `Intentional breaks require a reason of at least ${policy.minLength} characters.`
      : "Intentional breaks can be requested without a reason."
  };
}

export function assertIntentReason(state, reason, label = "This action") {
  const normalized = normalizeIntentReason(reason);
  const policy = intentReasonPolicy(state);
  if (!policy.enabled) return normalized;
  if (normalized.length < policy.minLength) {
    throw new IntentReasonError(`${label} requires a reason of at least ${policy.minLength} characters.`);
  }
  return normalized;
}

export function normalizeIntentReason(reason) {
  return String(reason || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}
