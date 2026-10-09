import { limitedSearchPage, limitedSearchWarning } from "../src/searchBreak.js";

declare function fetchVigil(path: string, options: RequestInit): Promise<Response>;
(() => {
  const api = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
  const safari = api.runtime.getURL("").startsWith("safari-web-extension:");
  const page = api.runtime.getURL("search-break.html");
  const cacheKey = "vigil-search-break-until";
  let queue = Promise.resolve<unknown>(undefined);
  let lastSweepUntil = 0;
  let status: { at: number; result: Record<string, unknown> } | undefined;

  async function action(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (body.action === "search-break-status" && status && now >= status.at && now - status.at < 500) return status.result;
    try {
      const result = safari
        ? await api.runtime.sendNativeMessage("tech.caseline.vigil", body)
        : await (await (globalThis as typeof globalThis & { fetchVigil: typeof fetchVigil }).fetchVigil("/api/extension/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
      if (!result?.ok) throw new Error("Search break authority unavailable");
      await api.storage.local.set({ [cacheKey]: result.until || 0 });
      status = { at: now, result };
      return result;
    } catch {
      const until = Number((await api.storage.local.get(cacheKey))[cacheKey] || 0);
      if (until > now) return { ok: true, blocked: true, until, remainingMs: until - now, serverTime: now };
      return { ok: false };
    }
  }

  async function sweep(result: Record<string, unknown>): Promise<void> {
    const until = Number(result.until || 0);
    if (!result.blocked || lastSweepUntil === until) return;
    const tabs = await api.tabs.query({});
    await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && /^https?:/u.test(tab.url || ""))
      .map(tab => api.tabs.update(tab.id!, { url: page })));
    lastSweepUntil = until;
  }

  api.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "VIGIL_SEARCH_BREAK" || sender.frameId && sender.frameId !== 0) return false;
    const work = async () => {
      if (!["search-break-warning", "search-break-status"].includes(message.action)) return { ok: false };
      const body: Record<string, unknown> = { action: message.action };
      if (message.action === "search-break-warning") {
        if (!limitedSearchPage(sender.url) || !limitedSearchWarning(message.warning) || sender.tab?.id === undefined
            || typeof message.id !== "string" || !/^[a-f0-9-]{36}$/u.test(message.id)) return { ok: false };
        const tab = await api.tabs.get(sender.tab.id);
        if (!tab.active || tab.url !== message.url || !limitedSearchPage(tab.url)) return { ok: false };
        Object.assign(body, { id: `${sender.tab.id}:${message.id}`, url: tab.url, warning: message.warning });
      } else if (!sender.url || (!/^https?:/u.test(sender.url) && sender.url !== page)) return { ok: false };
      const result = await action(body);
      await sweep(result);
      return result;
    };
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    void next.then(reply).catch(() => reply({ ok: false }));
    return true;
  });

  async function guard(tabId: number, url?: string): Promise<void> {
    if (!/^https?:/u.test(url || "")) return;
    const work = async () => {
      const result = await action({ action: "search-break-status" });
      if (result.blocked) {
        const tab = await api.tabs.get(tabId);
        if (/^https?:/u.test(tab.url || "")) await api.tabs.update(tabId, { url: page });
      }
    };
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    await next;
  }
  api.webNavigation.onCommitted.addListener(details => {
    if (details.frameId === 0) void guard(details.tabId, details.url).catch(() => {});
  });
  api.tabs.onActivated.addListener(({ tabId }) => {
    void api.tabs.get(tabId).then(tab => guard(tabId, tab.url)).catch(() => {});
  });
})();
