import { redditReviewHost, redditReviewPostId, redditReviewSearchPage, redditReviewDestination, redditReviewRedirect, vigilReturnPage } from "../src/redditReview.js";

declare function fetchVigil(path: string, options: RequestInit): Promise<Response>;
const reviewApi: typeof chrome = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser || chrome;
const reviewStorage = reviewApi.storage.session || reviewApi.storage.local;
const reviewPrefix = "vigil-reddit-review:";
interface ReviewState {
  search?: string; selected?: string; post?: string;
  pending?: { source: string; sourceTabId: number; expiresAt: number };
  history?: string[]; windowId?: number; incognito?: boolean;
}
interface ReviewReply { ok: boolean; url?: string; handled?: boolean; retry?: boolean; }
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
function rememberReviewPage(state: ReviewState, url: string): void {
  if (!/^https?:/u.test(url) || vigilReturnPage(url, reviewApi.runtime.getURL("/"))) return;
  if (state.pending && redditReviewRedirect(url, state.pending.source)) return;
  if (state.history?.at(-1) !== url) state.history = [...(state.history || []), url].slice(-20);
}
async function reviewReturnURL(state: ReviewState, currentUrl: string): Promise<string> {
  const candidates = [...(state.history || [])].reverse().filter(url => url !== currentUrl);
  if (!candidates.length && !redditReviewHost(currentUrl)) return "about:blank";
  try {
    const body = { action: "browser-return", candidates, inspect: redditReviewHost(currentUrl) ? currentUrl : undefined };
    const result = (globalThis as typeof globalThis & { browser?: typeof chrome }).browser
      ? await reviewApi.runtime.sendNativeMessage("tech.caseline.vigil", body)
      : await (await (globalThis as typeof globalThis & { fetchVigil: typeof fetchVigil }).fetchVigil("/api/extension/browser-health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    if (result?.ok && typeof result.interstitial === "string" && vigilReturnPage(result.interstitial, reviewApi.runtime.getURL("/"))) return result.interstitial;
    if (result?.ok && typeof result.url === "string" && candidates.includes(result.url)) return result.url;
  } catch { /* An unavailable verifier must not choose another tab or window. */ }
  return "about:blank";
}
async function quietReviewReturn(tabId: number, state: ReviewState, currentUrl: string): Promise<string> {
  const url = await reviewReturnURL(state, currentUrl);
  if (vigilReturnPage(url, reviewApi.runtime.getURL("/"))) return url;
  const index = state.history?.lastIndexOf(url) ?? -1;
  state.history = index < 0 ? [] : state.history?.slice(0, index + 1);
  state.pending = undefined;
  state.post = redditReviewPostId(url) || undefined;
  await writeReview(tabId, state);
  return url;
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
    return { ok: true, url: await quietReviewReturn(tabId, state, sender.url) };
  }
  if (message.action === "check") return { ok: Boolean(state.post && state.post === redditReviewPostId(sourceUrl)), retry: Boolean(state.pending && state.pending.expiresAt >= Date.now()) };
  if (message.action !== "open") return { ok: false };
  const search = redditReviewSearchPage(sourceUrl);
  const raw = String(message.url || "");
  const destination = redditReviewDestination(raw);
  const wrapped = redditReviewRedirect(raw, sourceUrl);
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
  if (state.pending && ["typed", "auto_bookmark", "keyword", "keyword_generated"].includes(details.transitionType || "")
    && !details.transitionQualifiers?.some(value => value === "server_redirect" || value === "client_redirect")) state.pending = undefined;
  if (redditReviewHost(details.url)) {
    if (!await acceptReviewArrival(details.tabId, state, details.url)) {
      await reviewApi.tabs.update(details.tabId, { url: await quietReviewReturn(details.tabId, state, details.url) });
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
  event.addListener(details => { void serializeReview(() => reviewNavigation(details)).catch(() => {}); });
}
reviewApi.tabs.onRemoved.addListener(tabId => {
  void serializeReview(() => reviewStorage.remove(`${reviewPrefix}${tabId}`)).catch(() => {});
});
reviewApi.runtime.onStartup.addListener(() => {
  void serializeReview(async () => {
    const stored = await reviewStorage.get(null);
    await reviewStorage.remove(Object.keys(stored).filter(key => key.startsWith(reviewPrefix)));
  });
});
