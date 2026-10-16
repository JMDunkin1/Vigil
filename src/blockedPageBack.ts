// This function is also embedded in classic extension scripts and block pages.
// Keep it self-contained: every destination still runs ordinary browser guards.
export function blockedPageBack(destination = "", exhausted = false): void {
  const state = blockedPageBack as typeof blockedPageBack & { busyUntil?: number; attempt?: { steps: number; length: number; at: number; entryKey?: string } };
  const now = Date.now();
  if ((state.busyUntil || 0) > now) return;
  const key = "vigil-blocked-page-back";
  if (destination && destination !== "about:blank") {
    try { sessionStorage.removeItem(key); } catch { /* Storage can be unavailable in private tabs. */ }
    state.attempt = undefined;
    state.busyUntil = now + 1500;
    location.replace(destination);
    return;
  }
  if (!exhausted && history.length > 1) {
    let previous = state.attempt;
    const navigation = (globalThis as typeof globalThis & {
      navigation?: { currentEntry?: { key: string; index: number }; entries(): { key: string; index: number }[] };
    }).navigation;
    const entry = navigation?.currentEntry;
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || "null") as typeof previous;
      const earlierEntry = stored?.entryKey && entry && navigation?.entries().some(candidate =>
        candidate.key === stored.entryKey && candidate.index > entry.index);
      // A tab-wide timestamp cannot distinguish a denied-entry bounce from a
      // successful Back followed by Forward and reload. Reuse it only when the
      // attempted blocker remains ahead of this earlier history entry.
      if (earlierEntry) previous = stored || previous;
    } catch { /* Retain the in-document fallback when provenance is unavailable. */ }
    const retry = previous && Number.isInteger(previous.steps) && previous.steps > 0
      && Number.isInteger(previous.length) && previous.length >= history.length
      && previous.at <= now && now - previous.at < 30_000;
    const steps = retry && previous ? previous.steps + 1 : 1;
    if (steps < history.length) {
      // A denied entry can redirect back here after native Back. Remember the
      // attempt in this tab and advance past it on a retry, including reloads.
      state.attempt = { steps, length: history.length, at: now, entryKey: entry?.key };
      try { sessionStorage.setItem(key, JSON.stringify(state.attempt)); } catch { /* The same document still remembers retries. */ }
      state.busyUntil = now + 1500;
      const source = location.href;
      const fallback = setTimeout(() => {
        if (location.href !== source) return;
        // history.length includes forward entries. If the larger traversal
        // overshoots the beginning, a single step can still reach a real page.
        if (steps > 1) history.back();
        state.busyUntil = 0;
        blockedPageBack("", true);
      }, 1500);
      // A timer frozen in BFCache must not navigate when this page is restored.
      addEventListener("pagehide", () => { clearTimeout(fallback); state.attempt = undefined; state.busyUntil = 0; }, { once: true });
      if (steps === 1) history.back();
      else history.go(-steps);
      return;
    }
  }
  let status = document.querySelector<HTMLElement>("#vigilBackStatus");
  if (!status) {
    status = document.createElement("p");
    status.id = "vigilBackStatus";
    status.className = "message";
    status.hidden = true;
    status.setAttribute("role", "status");
    (document.querySelector("main") || document.body).append(status);
  }
  status.textContent = "There isn’t an available previous page in this tab. Close this tab or enter another address.";
  const back = document.querySelector<HTMLElement>("#leaveBlockedPage");
  back?.setAttribute("aria-describedby", status.id);
  back?.setAttribute("title", status.textContent);
}
