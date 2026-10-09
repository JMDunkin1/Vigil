// Shared by the Mac authority and the phone's local, native Safari ledger.
export const SEARCH_BREAK_WINDOW_MS = 60_000;
export const SEARCH_BREAK_DURATION_MS = 150_000;
export const SEARCH_BREAK_THRESHOLD = 3;
export interface SearchBreakLedger {
  warnings: Array<{ id: string; at: number }>;
  until: number;
  observedAt: number;
}
export interface SearchBreakState { searchBreak?: SearchBreakLedger }
export interface SearchBreakRequest { action?: unknown; id?: unknown; warning?: unknown }

export function limitedSearchWarning(value: unknown): boolean {
  return typeof value === "string" && value.length <= 240
    && /^(?:some\s+)?results\s+are\s+limited\s+by\s+(?:safe\s*search|search)\s*[.!]?$/iu.test(value.replace(/\s+/gu, " ").trim());
}

export function limitedSearchPage(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      && ["google.com", "www.google.com", "images.google.com"].includes(url.hostname)
      && url.pathname === "/search" && Boolean(url.searchParams.get("q"));
  } catch { return false; }
}

export function activeSearchBreakUntil(state: SearchBreakState, now = Date.now()): number {
  const until = state.searchBreak?.until || 0;
  return Number.isFinite(until) && until > now ? until : 0;
}

export function searchBreakAction(state: SearchBreakState, body: SearchBreakRequest, now = Date.now()) {
  const previous = state.searchBreak;
  // A backwards clock adjustment must not reset the window or shorten a break.
  const observedAt = Math.max(now, previous?.observedAt || 0);
  const ledger: SearchBreakLedger = {
    warnings: (previous?.warnings || []).filter(item => observedAt - item.at <= SEARCH_BREAK_WINDOW_MS),
    until: previous?.until || 0, observedAt
  };
  let accepted = false;
  let triggered = false;
  if (body.action === "search-break-warning" && limitedSearchWarning(body.warning)
      && typeof body.id === "string" && /^[A-Za-z0-9:._-]{1,220}$/u.test(body.id)
      && ledger.until <= observedAt && !ledger.warnings.some(item => item.id === body.id)) {
    ledger.warnings.push({ id: body.id, at: observedAt });
    accepted = true;
    if (ledger.warnings.length >= SEARCH_BREAK_THRESHOLD) {
      ledger.until = observedAt + SEARCH_BREAK_DURATION_MS;
      ledger.warnings = [];
      triggered = true;
    }
  }
  // Status polling must not cause a disk write every second.
  if (accepted || (previous && ledger.warnings.length !== previous.warnings.length)) state.searchBreak = ledger;
  const until = activeSearchBreakUntil(state, observedAt);
  return { ok: true, accepted, triggered, blocked: until > 0, until,
    remainingMs: Math.max(0, until - observedAt), count: ledger.warnings.length, serverTime: observedAt };
}
