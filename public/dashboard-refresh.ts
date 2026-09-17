interface DashboardRefreshOptions {
  document: Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
  timers: Pick<Window, "setTimeout" | "clearTimeout" | "setInterval" | "clearInterval">;
  refresh(): Promise<void>;
  renderCountdowns(): void;
  renderOnResume?(): void;
  onError?(error: unknown): void;
  pollMs: number;
}

// These timers update presentation only; enforcement runs independently.
export function startDashboardRefresh(options: DashboardRefreshOptions): () => void {
  let generation = 0;
  let pollTimer: number | undefined;
  let countdownTimer: number | undefined;
  let inFlight: Promise<void> | undefined;
  const clearTimers = () => {
    if (pollTimer !== undefined) options.timers.clearTimeout(pollTimer);
    if (countdownTimer !== undefined) options.timers.clearInterval(countdownTimer);
    pollTimer = undefined;
    countdownTimer = undefined;
  };
  const poll = async (currentGeneration: number) => {
    try {
      inFlight ||= options.refresh().finally(() => { inFlight = undefined; });
      await inFlight;
    } catch (error) {
      options.onError?.(error);
    } finally {
      if (currentGeneration === generation && !options.document.hidden) {
        pollTimer = options.timers.setTimeout(() => { void poll(currentGeneration); }, options.pollMs);
      }
    }
  };
  const visibilityChanged = () => {
    const currentGeneration = ++generation;
    clearTimers();
    if (options.document.hidden) return;
    (options.renderOnResume || options.renderCountdowns)();
    countdownTimer = options.timers.setInterval(options.renderCountdowns, 1_000);
    void poll(currentGeneration);
  };
  options.document.addEventListener("visibilitychange", visibilityChanged);
  visibilityChanged();
  return () => {
    generation += 1;
    clearTimers();
    options.document.removeEventListener("visibilitychange", visibilityChanged);
  };
}
