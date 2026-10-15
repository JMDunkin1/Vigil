import { redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewTarget, redditReviewDestination, redditReviewRedirect, vigilReturnPage } from "../src/redditReview.js";

declare function fetchVigil(path: string, options: RequestInit): Promise<Response>;
const reviewApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
const reviewStorage = reviewApi.storage.session || reviewApi.storage.local;
const reviewPrefix = "vigil-reddit-review:";
const returnTransferPrefix = "vigil-block-return:";
interface ReturnTransfer { history: string[]; windowId: number; incognito: boolean; expiresAt: number; claimedTabId?: number; returning?: ReviewState["returning"]; failedReturns?: ReviewState["failedReturns"]; }
interface ReviewState {
  search?: string; selected?: string; post?: string;
  pending?: { source: string; sourceTabId: number; expiresAt: number };
  history?: string[]; windowId?: number; incognito?: boolean;
  returning?: { url: string; startedAt: number };
  failedReturns?: Array<{ url: string; expiresAt: number }>;
}
interface ReviewReturn { url: string; exhausted?: boolean; }
interface ReviewReply { ok: boolean; url?: string; handled?: boolean; retry?: boolean; exhausted?: boolean; }
let reviewQueue = Promise.resolve<unknown>(undefined);
function serializeReview<T>(work: () => Promise<T>): Promise<T> {
  const next = reviewQueue.then(work, work);
  reviewQueue = next.catch(() => {});
  return next;
}
async function readReview(tabId: number, tab: chrome.tabs.Tab): Promise<ReviewState> {
  const state: ReviewState = (await reviewStorage.get(`${reviewPrefix}${tabId}`))[`${reviewPrefix}${tabId}`] || {};
  if (state.windowId !== tab.windowId || state.incognito !== Boolean(tab.incognito)) return { windowId: tab.windowId, incognito: Boolean(tab.incognito) };
  return state;
}
async function writeReview(tabId: number, state: ReviewState): Promise<void> {
  await reviewStorage.set({ [`${reviewPrefix}${tabId}`]: state });
}
function returnTransferKey(raw: string, phase: "holding" | "blocker"): string | null {
  try {
    const url = new URL(raw);
    if (url.origin !== "http://127.0.0.1:8787" || url.pathname !== "/blocked" || url.username || url.password) return null;
    const match = url.hash.match(/^#vigil-(holding|blocker)-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u);
    return match?.[1] === phase ? returnTransferPrefix + match[2] : null;
  } catch { return null; }
}
async function preserveReplacementReturn(details: { tabId: number; frameId: number; url: string }): Promise<void> {
  if (details.frameId !== 0) return;
  const key = returnTransferKey(details.url, "holding");
  if (!key) return;
  // Read the saved source before its onRemoved cleanup. Native Safari may have
  // already closed it by the time tabs.get could resolve. The browser event,
  // not a page message, identifies the source tab.
  const state = (await reviewStorage.get(`${reviewPrefix}${details.tabId}`))[`${reviewPrefix}${details.tabId}`] as ReviewState | undefined;
  if (!state?.history?.length || typeof state.windowId !== "number" || typeof state.incognito !== "boolean") return;
  const stored = await reviewStorage.get(null);
  if (stored[key]) return;
  const expired = Object.keys(stored).filter(name => name.startsWith(returnTransferPrefix) && ((stored[name] as ReturnTransfer | undefined)?.expiresAt || 0) <= Date.now());
  if (expired.length) await reviewStorage.remove(expired);
  // Copy return candidates only, never Reddit grants or pending navigation tickets.
  await reviewStorage.set({ [key]: { history: state.history.filter(url => !redditReviewHost(url)).slice(-20),
    returning: state.returning, failedReturns: state.failedReturns,
    windowId: state.windowId, incognito: state.incognito, expiresAt: Date.now() + 30_000 } satisfies ReturnTransfer });
}
async function restoreReplacementReturn(tabId: number, tab: chrome.tabs.Tab, state: ReviewState): Promise<void> {
  const key = returnTransferKey(tab.url || "", "blocker");
  if (!key) return;
  const transfer = (await reviewStorage.get(key))[key] as ReturnTransfer | undefined;
  if (!transfer || transfer.claimedTabId !== undefined || transfer.expiresAt <= Date.now() || transfer.windowId !== tab.windowId || transfer.incognito !== Boolean(tab.incognito)) return;
  state.history = [...transfer.history];
  state.returning = transfer.returning;
  state.failedReturns = transfer.failedReturns;
  await writeReview(tabId, state);
  // Keep a short-lived receipt so a late holding-page event cannot recreate
  // a consumed transfer after the replacement has already claimed it.
  await reviewStorage.set({ [key]: { ...transfer, history: [], claimedTabId: tabId } });
}
function rememberReviewPage(state: ReviewState, url: string): void {
  if (!/^https?:/u.test(url) || vigilReturnPage(url, reviewApi.runtime.getURL("/"))) return;
  if (state.pending && redditReviewRedirect(url, state.pending.source)) return;
  if (state.history?.at(-1) !== url) state.history = [...(state.history || []), url].slice(-20);
}
async function reviewReturnURL(state: ReviewState, currentUrl: string): Promise<ReviewReturn> {
  state.failedReturns = (state.failedReturns || []).filter(entry => entry.expiresAt > Date.now());
  const failed = new Set(state.failedReturns.map(entry => entry.url));
  const candidates = [...new Set([...(state.history || [])].reverse())].filter(url => url !== currentUrl && !failed.has(url));
  // The monitor can supply a previous page even when the extension has just
  // restarted. Revalidate it alongside this tab's recorded navigation history.
  if (vigilReturnPage(currentUrl, reviewApi.runtime.getURL("/"))) {
    const back = new URL(currentUrl).searchParams.get("back");
    if (back && !failed.has(back) && !candidates.includes(back)) candidates.unshift(back);
  }
  if (!candidates.length && !redditReviewHost(currentUrl)) return { url: "about:blank", exhausted: failed.size > 0 };
  try {
    const body = { action: "browser-return", candidates, inspect: redditReviewHost(currentUrl) ? currentUrl : undefined };
    const result = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser
      ? await reviewApi.runtime.sendNativeMessage("tech.caseline.vigil", body)
      : await (await (globalThis as typeof globalThis & { fetchVigil: typeof fetchVigil }).fetchVigil("/api/extension/browser-health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (result?.ok && typeof result.interstitial === "string" && vigilReturnPage(result.interstitial, reviewApi.runtime.getURL("/"))) return { url: result.interstitial };
    if (result?.ok && typeof result.url === "string" && candidates.includes(result.url)) return { url: result.url };
    if (result?.ok && result.url === "about:blank") return { url: "about:blank", exhausted: true };
  } catch { /* An unavailable verifier must not choose another tab or window. */ }
  return { url: "about:blank" };
}
async function quietReviewReturn(tabId: number, state: ReviewState, currentUrl: string): Promise<ReviewReturn> {
  const result = await reviewReturnURL(state, currentUrl);
  const { url } = result;
  if (vigilReturnPage(url, reviewApi.runtime.getURL("/"))) return result;
  // A failed verifier or an empty history must not erase a later retry's
  // candidates. In particular, extension timeouts aren't a successful return.
  if (url === "about:blank" && vigilReturnPage(currentUrl, reviewApi.runtime.getURL("/"))) return result;
  const index = state.history?.lastIndexOf(url) ?? -1;
  state.history = index < 0 ? [] : state.history?.slice(0, index + 1);
  if (vigilReturnPage(currentUrl, reviewApi.runtime.getURL("/"))) state.returning = { url, startedAt: Date.now() };
  state.pending = undefined;
  state.post = redditReviewPostId(url) || undefined;
  await writeReview(tabId, state);
  return result;
}
function trackBlockedReturn(state: ReviewState): void {
  if (!state.returning) return;
  if (Date.now() - state.returning.startedAt <= 15_000) {
    // URL policy cannot predict a website's redirect or a later content guard.
    // If a return lands on another blocker, skip that destination next time.
    const start = state.history?.lastIndexOf(state.returning.url) ?? -1;
    const failed = start < 0 ? [state.returning.url] : (state.history || []).slice(start);
    state.failedReturns = [...(state.failedReturns || []), ...failed.map(url => ({ url, expiresAt: Date.now() + 5 * 60_000 }))].slice(-20);
  }
  state.returning = undefined;
}
async function acceptReviewArrival(tabId: number, state: ReviewState, url: string): Promise<boolean> {
  const post = redditReviewPostId(url);
  if (!post) return false;
  if (state.post === post) return true;
  if (!state.pending || state.pending.expiresAt < Date.now() || (state.selected && state.selected !== post)) return false;
  const sourceTabId = state.pending.sourceTabId;
  if (sourceTabId !== tabId) {
    const sourceTab = await reviewApi.tabs.get(sourceTabId).catch(() => null);
    if (sourceTab) {
      const sourceState = await readReview(sourceTabId, sourceTab);
      if (sourceState.search === state.search && sourceState.pending?.sourceTabId === sourceTabId) {
        sourceState.selected = post; sourceState.pending = undefined;
        await writeReview(sourceTabId, sourceState);
      }
    }
  }
  state.post = post;
  state.selected = post;
  state.pending = undefined;
  await writeReview(tabId, state);
  return true;
}
async function reviewMessage(message: { action?: string; url?: string; sourceUrl?: string; newTab?: boolean }, sender: chrome.runtime.MessageSender): Promise<ReviewReply> {
  const tabId = sender.tab?.id;
  if (tabId === undefined || sender.frameId !== 0 || !sender.url) return { ok: false };
  const current = await reviewApi.tabs.get(tabId);
  const sourceUrl = message.sourceUrl || sender.url;
  const currentURL = new URL(current.url || "about:blank"); currentURL.hash = "";
  const sourceURL = new URL(sourceUrl); sourceURL.hash = "";
  if (currentURL.href !== sourceURL.href || new URL(sender.url).origin !== sourceURL.origin) return { ok: false, handled: true };
  const state = await readReview(tabId, current);
  if (message.action === "return") {
    if (!vigilReturnPage(sender.url, reviewApi.runtime.getURL("/")) && !redditReviewHost(sender.url)) return { ok: false };
    await restoreReplacementReturn(tabId, current, state);
    if (vigilReturnPage(sender.url, reviewApi.runtime.getURL("/"))) trackBlockedReturn(state);
    await writeReview(tabId, state);
    return { ok: true, ...await quietReviewReturn(tabId, state, sender.url) };
  }
  if (message.action === "check") return { ok: Boolean(state.post && state.post === redditReviewPostId(sourceUrl)), retry: Boolean(state.pending && state.pending.expiresAt >= Date.now()) };
  if (message.action !== "open") return { ok: false };
  const search = redditReviewSearchPage(sourceUrl);
  const raw = String(message.url || "");
  const destination = redditReviewDestination(raw);
  const wrapped = !redditReviewTarget(raw) && redditReviewRedirect(raw, sourceUrl);
  const post = destination && redditReviewPostId(destination);
  if (!search || (!post && !wrapped)) return { ok: false };
  if (state.search === search && state.selected && post && state.selected !== post) return { ok: false };
  // Reserve this search synchronously; another result cannot race the wrapper.
  if (state.search === search && state.pending && state.pending.expiresAt >= Date.now()) return { ok: false };
  rememberReviewPage(state, sourceUrl);
  state.selected = state.search === search ? state.selected : undefined;
  state.search = search;
  state.pending = post ? undefined : { source: sourceUrl, sourceTabId: tabId, expiresAt: Date.now() + 15_000 };
  if (post) state.selected = post;
  await writeReview(tabId, state);
  let targetId = tabId;
  let targetState = state;
  if (message.newTab) {
    // Safari's default window is not necessarily the source's private window.
    const tab = await reviewApi.tabs.create({ url: "about:blank", active: true, openerTabId: tabId, windowId: current.windowId });
    if (tab.id === undefined || tab.windowId !== current.windowId || Boolean(tab.incognito) !== Boolean(current.incognito)) return { ok: false };
    targetId = tab.id;
    targetState = { windowId: tab.windowId, incognito: Boolean(tab.incognito), search, selected: state.selected, pending: state.pending };
  }
  targetState.post = post || undefined;
  await writeReview(targetId, targetState);
  await reviewApi.tabs.update(targetId, { url: destination || raw });
  return { ok: true };
}
reviewApi.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== "VIGIL_REDDIT_REVIEW") return undefined;
  void serializeReview(() => reviewMessage(message, sender)).then(reply, () => reply({ ok: false }));
  return true;
});
async function reviewNavigation(details: { tabId: number; frameId: number; url: string; transitionType?: string; transitionQualifiers?: string[] }): Promise<void> {
  if (details.frameId !== 0) return;
  const current = await reviewApi.tabs.get(details.tabId);
  if (current.url !== details.url) return;
  const state = await readReview(details.tabId, current);
  await restoreReplacementReturn(details.tabId, current, state);
  if (vigilReturnPage(details.url, reviewApi.runtime.getURL("/"))) trackBlockedReturn(state);
  else if (state.returning && details.url !== state.returning.url
    && (Date.now() - state.returning.startedAt > 15_000
      || (["link", "typed", "auto_bookmark", "keyword", "keyword_generated"].includes(details.transitionType || "")
        && !details.transitionQualifiers?.some(value => value === "server_redirect" || value === "client_redirect")))) state.returning = undefined;
  if (state.pending && ["typed", "auto_bookmark", "keyword", "keyword_generated"].includes(details.transitionType || "")
    && !details.transitionQualifiers?.some(value => value === "server_redirect" || value === "client_redirect")) state.pending = undefined;
  if (redditReviewHost(details.url)) {
    if (!await acceptReviewArrival(details.tabId, state, details.url)) {
      await reviewApi.tabs.update(details.tabId, { url: (await quietReviewReturn(details.tabId, state, details.url)).url });
      return;
    }
  } else if (!vigilReturnPage(details.url, reviewApi.runtime.getURL("/")) && details.url !== "about:blank") {
    state.post = undefined;
    if (state.pending && !redditReviewRedirect(details.url, state.pending.source)) state.pending = undefined;
  }
  rememberReviewPage(state, details.url);
  await writeReview(details.tabId, state);
}
for (const event of [reviewApi.webNavigation.onCommitted, reviewApi.webNavigation.onHistoryStateUpdated]) {
  event.addListener(details => {
    const navigation = serializeReview(async () => {
      await preserveReplacementReturn(details);
      await reviewNavigation(details);
    });
    void navigation.catch(() => {});
  });
}
reviewApi.webNavigation.onBeforeNavigate?.addListener(details => {
  void serializeReview(() => preserveReplacementReturn(details)).catch(() => {});
});
reviewApi.tabs.onRemoved.addListener(tabId => {
  void serializeReview(() => reviewStorage.remove(`${reviewPrefix}${tabId}`)).catch(() => {});
});
reviewApi.runtime.onStartup.addListener(() => {
  void serializeReview(async () => {
    const stored = await reviewStorage.get(null);
    await reviewStorage.remove(Object.keys(stored).filter(key => key.startsWith(reviewPrefix) || key.startsWith(returnTransferPrefix)));
  });
});
