const BLOCK_ATTEMPT_TYPES = new Set([
  "blocked_app",
  "blocked_site",
  "extension_blocked_site"
]);

export function interventionSummary(state, now = new Date()) {
  const settings = interventionSettings(state);
  const attempts = recentBlockAttempts(state, now, settings.windowMinutes);
  const strikeCount = settings.enabled
    ? Math.max(0, attempts.length - settings.threshold + 1)
    : 0;
  const extraDelaySeconds = settings.enabled
    ? Math.min(settings.maxExtraDelaySeconds, strikeCount * settings.extraDelaySeconds)
    : 0;
  const level = attempts.length >= settings.threshold + 3
    ? "high"
    : (attempts.length >= settings.threshold ? "elevated" : "calm");
  const oldestAttempt = attempts.at(-1);
  const resetsAt = oldestAttempt
    ? new Date(Date.parse(oldestAttempt.at) + settings.windowMinutes * 60 * 1000).toISOString()
    : null;

  return {
    enabled: settings.enabled,
    windowMinutes: settings.windowMinutes,
    threshold: settings.threshold,
    attempts: attempts.length,
    level,
    extraDelaySeconds,
    emergencyDelaySeconds: baseEmergencyDelaySeconds(state) + extraDelaySeconds,
    resetsAt,
    topTargets: topAttemptTargets(attempts),
    message: interventionMessage(attempts.length, settings, extraDelaySeconds)
  };
}

export function emergencyDelaySeconds(state, now = new Date()) {
  return interventionSummary(state, now).emergencyDelaySeconds;
}

export function recentBlockAttempts(state, now = new Date(), windowMinutes = 10) {
  const cutoff = now.getTime() - Math.max(1, Number(windowMinutes || 10)) * 60 * 1000;
  return (state.events || [])
    .filter((event) => BLOCK_ATTEMPT_TYPES.has(event.type))
    .map((event) => ({ ...event, target: eventTarget(event) }))
    .filter((event) => {
      const at = Date.parse(event.at || "");
      return Number.isFinite(at) && at >= cutoff && at <= now.getTime();
    })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

function interventionSettings(state) {
  const settings = state.settings || {};
  return {
    enabled: settings.interventionEnabled !== false,
    windowMinutes: clamp(settings.interventionWindowMinutes, 1, 240, 10),
    threshold: clamp(settings.interventionThreshold, 1, 50, 3),
    extraDelaySeconds: clamp(settings.interventionExtraDelaySeconds, 1, 3600, 45),
    maxExtraDelaySeconds: clamp(settings.interventionMaxExtraDelaySeconds, 1, 3600, 300)
  };
}

function baseEmergencyDelaySeconds(state) {
  return clamp(state.settings?.emergencyDelaySeconds, 1, 100000, 45);
}

function topAttemptTargets(attempts) {
  const counts = new Map();
  for (const attempt of attempts) {
    const target = attempt.target || { label: "unknown", type: "target" };
    const key = `${target.type}:${target.label}`;
    const existing = counts.get(key) || { ...target, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  }
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, 4);
}

function eventTarget(event) {
  const detail = event.detail || {};
  if (detail.site) return { type: "site", label: String(detail.site) };
  if (detail.app) return { type: "app", label: String(detail.app) };
  if (detail.target) return { type: "target", label: String(detail.target) };
  return { type: "target", label: event.type.replaceAll("_", " ") };
}

function interventionMessage(attempts, settings, extraDelaySeconds) {
  if (!settings.enabled) return "Adaptive friction is off.";
  if (!attempts) return "No recent blocked attempts.";
  if (!extraDelaySeconds) {
    return `${attempts}/${settings.threshold} recent blocked attempts before extra friction starts.`;
  }
  return `${attempts} recent blocked attempts added ${extraDelaySeconds}s to emergency unlocks.`;
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}
