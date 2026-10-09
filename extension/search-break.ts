import { limitedSearchPage, limitedSearchWarning } from "../src/searchBreak.js";

export const checkSearchBreakBeforeNavigation: () => Promise<boolean> | undefined = (() => {
  if (globalThis.top !== globalThis.self || typeof document === "undefined" || typeof document.addEventListener !== "function") return () => undefined;
  const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
  let warningURL = "";
  let warningID = "";
  let reported = false;
  let pending: Promise<boolean> | undefined;
  let lastStatusAt = 0;
  let scheduled = false;

  function check(warningsOnly = false): Promise<boolean> | undefined {
    if (document.hidden) return;
    const url = location.href;
    if (warningURL !== url) {
      warningURL = url; warningID = limitedSearchPage(url) ? crypto.randomUUID() : ""; reported = false;
    }
    const notice = !reported && limitedSearchPage(url) ? findNotice() : "";
    if (!notice && warningsOnly) return;
    if (pending) return pending.then(blocked => blocked || check(warningsOnly) || false);
    if (!notice && Date.now() - lastStatusAt < 1000) return;
    lastStatusAt = Date.now();
    const work = async (): Promise<boolean> => {
      try {
        const result = await api.runtime.sendMessage({ type: "VIGIL_SEARCH_BREAK", action: notice ? "search-break-warning" : "search-break-status",
          id: warningID, warning: notice, url });
        if (result?.ok && notice && warningURL === url) reported = true;
        if (result?.ok && result.blocked && location.href === url) {
          location.replace(api.runtime.getURL("search-break.html"));
          return true;
        }
      } catch { /* The background retains the durable break across page retries. */ }
      return false;
    };
    const next = work();
    pending = next;
    void next.finally(() => { if (pending === next) pending = undefined; });
    return next;
  }

  function findNotice(): string {
    // Read visible, standalone notice text, never a search query, result title,
    // quoted code sample, or a result snippet describing this feature.
    for (const node of document.querySelectorAll<HTMLElement>("[role='alert'], [role='alert'] *, [role='status'], [role='status'] *, [role='dialog'], [role='dialog'] *, [aria-live], [aria-live] *, #taw *, #topstuff *, #botstuff *, #search div, #search span, #search p")) {
      const text = node.innerText?.trim() || "";
      if (!limitedSearchWarning(text) || !node.getClientRects().length
          || getComputedStyle(node).visibility !== "visible"
          || node.closest("#rso, article, a, h3, input, textarea, pre, code, [hidden], [aria-hidden='true']")) continue;
      let resultCard = false;
      for (let parent = node.parentElement; parent && parent !== document.body && parent !== document.documentElement && !["search", "topstuff", "botstuff", "taw"].includes(parent.id); parent = parent.parentElement) {
        if (parent.querySelector("a h3")) { resultCard = true; break; }
      }
      if (!resultCard) return text;
    }
    return "";
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; void check(); }, 100);
  }
  function observe(): void {
    if (document.documentElement) new MutationObserver(schedule).observe(document.documentElement,
      { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["hidden", "style", "class", "aria-hidden"] });
    void check();
  }
  if (document.documentElement) observe();
  else document.addEventListener("DOMContentLoaded", observe, { once: true });
  addEventListener("pageshow", schedule);
  addEventListener("popstate", schedule);
  document.addEventListener("visibilitychange", schedule);
  setInterval(() => { void check(); }, 1000);
  return () => check(true);
})();
