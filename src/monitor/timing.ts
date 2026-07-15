export function activeSecondsBeforeIdleThreshold(seconds: number, idleSeconds: number, thresholdSeconds: number): number {
  const elapsed = finitePositiveSeconds(seconds);
  if (!elapsed) return 0;
  const threshold = idleUsageThresholdSeconds(thresholdSeconds);
  const idle = Math.max(0, Number.isFinite(Number(idleSeconds)) ? Number(idleSeconds) : 0);
  if (idle <= threshold) return elapsed;
  return roundSeconds(Math.max(0, elapsed - (idle - threshold)));
}

export function maxTrustedPollGapSeconds(pollIntervalMs: unknown): number {
  const intervalMs = Number(pollIntervalMs);
  const intervalSeconds = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs / 1000 : 3;
  return Math.max(10, intervalSeconds * 3);
}

export function isInterruptedPollGap(elapsedSeconds: unknown, pollIntervalMs: unknown): boolean {
  const elapsed = Number(elapsedSeconds);
  return Number.isFinite(elapsed) && elapsed > maxTrustedPollGapSeconds(pollIntervalMs);
}

export function idleUsageThresholdSeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 30 ? Math.min(3600, seconds) : 120;
}

export function roundSeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : 0;
}

function finitePositiveSeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}
