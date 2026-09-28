(() => {
// URL shape is eligibility only. Permission to read a post lives in the
// extension background and is issued only for a click from an external search.
function redditReviewHost(value) {
    try {
        return /(^|\.)(reddit\.com|redd\.it|redditmedia\.com)$/iu.test(new URL(value).hostname);
    }
    catch {
        return false;
    }
}
function redditReviewPostId(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port
            || !/^(www\.|old\.|new\.|np\.|m\.)?reddit\.com$/iu.test(url.hostname))
            return null;
        // JSON, galleries, media viewers, feeds, short links and user posts are
        // deliberately excluded. Comment permalinks stay inside the selected post.
        const match = url.pathname.match(/^\/(?:r\/[a-z0-9_]+\/)?comments\/([a-z0-9]+)(?:\/[^/.]+(?:\/[a-z0-9]+)?)?\/?$/iu);
        return match?.[1].toLowerCase() || null;
    }
    catch {
        return null;
    }
}
function redditReviewSearchPage(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password || url.port)
            return null;
        const host = url.hostname.toLowerCase();
        const google = /^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(host) && url.pathname === "/search";
        const supported = google
            || (["www.bing.com", "bing.com", "search.brave.com", "kagi.com", "search.yahoo.com"].includes(host) && url.pathname === "/search")
            || (["duckduckgo.com", "www.duckduckgo.com", "html.duckduckgo.com"].includes(host) && ["/", "/html/", "/html"].includes(url.pathname));
        if (!supported || !(url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim())
            return null;
        // Tracking, pagination and a changed hash do not constitute a new search.
        const query = (url.searchParams.get(host === "search.yahoo.com" ? "p" : "q") || "").trim().replace(/\s+/gu, " ").toLowerCase();
        const identity = new URL(url.origin + url.pathname);
        identity.searchParams.set("q", query);
        return identity.href;
    }
    catch {
        return null;
    }
}
function redditReviewDestination(value) {
    try {
        let url = new URL(value);
        if (/^(www\.)?google\.(com|co\.uk|com\.au|ca|de|fr|co\.in)$/u.test(url.hostname) && url.pathname === "/url") {
            url = new URL(url.searchParams.get("url") || url.searchParams.get("q") || "");
        }
        else if (/(^|\.)duckduckgo\.com$/u.test(url.hostname) && url.pathname === "/l/") {
            url = new URL(url.searchParams.get("uddg") || "");
        }
        else if (/^(www\.)?bing\.com$/u.test(url.hostname) && url.pathname === "/ck/a") {
            const encoded = url.searchParams.get("u") || "";
            if (!encoded.startsWith("a1"))
                return null;
            url = new URL(atob(encoded.slice(2).replace(/-/gu, "+").replace(/_/gu, "/")));
        }
        if (!redditReviewPostId(url.href))
            return null;
        return url.href;
    }
    catch {
        return null;
    }
}
// Google sometimes keeps the destination opaque until its /goto redirect.
// A short-lived navigation ticket can follow this wrapper; it is not a post
// grant until the browser actually arrives at a supported Reddit permalink.
function redditReviewRedirect(value, source) {
    try {
        const url = new URL(value);
        const page = new URL(source);
        return Boolean(redditReviewSearchPage(source) && url.protocol === "https:" && !url.username && !url.password && !url.port
            && url.hostname === page.hostname && ["/goto", "/url", "/l/", "/ck/a"].includes(url.pathname));
    }
    catch {
        return false;
    }
}
function vigilReturnPage(value, extensionRoot) {
    try {
        const url = new URL(value);
        const root = new URL(extensionRoot);
        if (url.protocol === root.protocol && url.host === root.host && ["/blocked.html", "/reddit-review-blocked.html"].includes(url.pathname))
            return true;
        return url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/blocked";
    }
    catch {
        return false;
    }
}

const reviewApi = globalThis.browser || chrome;
const reviewStorage = reviewApi.storage.session || reviewApi.storage.local;
const reviewPrefix = "vigil-reddit-review:";
const returnTransferPrefix = "vigil-block-return:";
let reviewQueue = Promise.resolve(undefined);
function serializeReview(work) {
    const next = reviewQueue.then(work, work);
    reviewQueue = next.catch(() => { });
    return next;
}
async function readReview(tabId, tab) {
    const state = (await reviewStorage.get(`${reviewPrefix}${tabId}`))[`${reviewPrefix}${tabId}`] || {};
    if (state.windowId !== tab.windowId || state.incognito !== Boolean(tab.incognito))
        return { windowId: tab.windowId, incognito: Boolean(tab.incognito) };
    return state;
}
async function writeReview(tabId, state) {
    await reviewStorage.set({ [`${reviewPrefix}${tabId}`]: state });
}
function returnTransferKey(raw, phase) {
    try {
        const url = new URL(raw);
        if (url.origin !== "http://127.0.0.1:8787" || url.pathname !== "/blocked" || url.username || url.password)
            return null;
        const match = url.hash.match(/^#vigil-(holding|blocker)-([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/u);
        return match?.[1] === phase ? returnTransferPrefix + match[2] : null;
    }
    catch {
        return null;
    }
}
async function preserveReplacementReturn(details) {
    if (details.frameId !== 0)
        return;
    const key = returnTransferKey(details.url, "holding");
    if (!key)
        return;
    // Read the saved source before its onRemoved cleanup. Native Safari may have
    // already closed it by the time tabs.get could resolve. The browser event,
    // not a page message, identifies the source tab.
    const state = (await reviewStorage.get(`${reviewPrefix}${details.tabId}`))[`${reviewPrefix}${details.tabId}`];
    if (!state?.history?.length || typeof state.windowId !== "number" || typeof state.incognito !== "boolean")
        return;
    const stored = await reviewStorage.get(null);
    if (stored[key])
        return;
    const expired = Object.keys(stored).filter(name => name.startsWith(returnTransferPrefix) && (stored[name]?.expiresAt || 0) <= Date.now());
    if (expired.length)
        await reviewStorage.remove(expired);
    // Copy return candidates only, never Reddit grants or pending navigation tickets.
    await reviewStorage.set({ [key]: { history: state.history.filter(url => !redditReviewHost(url)).slice(-20),
            windowId: state.windowId, incognito: state.incognito, expiresAt: Date.now() + 30_000 } });
}
async function restoreReplacementReturn(tabId, tab, state) {
    const key = returnTransferKey(tab.url || "", "blocker");
    if (!key)
        return;
    const transfer = (await reviewStorage.get(key))[key];
    if (!transfer || transfer.claimedTabId !== undefined || transfer.expiresAt <= Date.now() || transfer.windowId !== tab.windowId || transfer.incognito !== Boolean(tab.incognito))
        return;
    state.history = [...transfer.history];
    await writeReview(tabId, state);
    // Keep a short-lived receipt so a late holding-page event cannot recreate
    // a consumed transfer after the replacement has already claimed it.
    await reviewStorage.set({ [key]: { ...transfer, history: [], claimedTabId: tabId } });
}
function rememberReviewPage(state, url) {
    if (!/^https?:/u.test(url) || vigilReturnPage(url, reviewApi.runtime.getURL("/")))
        return;
    if (state.pending && redditReviewRedirect(url, state.pending.source))
        return;
    if (state.history?.at(-1) !== url)
        state.history = [...(state.history || []), url].slice(-20);
}
async function reviewReturnURL(state, currentUrl) {
    const candidates = [...(state.history || [])].reverse().filter(url => url !== currentUrl);
    // The monitor can supply a previous page even when the extension has just
    // restarted. Revalidate it alongside this tab's recorded navigation history.
    if (vigilReturnPage(currentUrl, reviewApi.runtime.getURL("/"))) {
        const back = new URL(currentUrl).searchParams.get("back");
        if (back && !candidates.includes(back))
            candidates.unshift(back);
    }
    if (!candidates.length && !redditReviewHost(currentUrl))
        return "about:blank";
    try {
        const body = { action: "browser-return", candidates, inspect: redditReviewHost(currentUrl) ? currentUrl : undefined };
        const result = globalThis.browser
            ? await reviewApi.runtime.sendNativeMessage("tech.caseline.vigil", body)
            : await (await globalThis.fetchVigil("/api/extension/browser-health", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
        if (result?.ok && typeof result.interstitial === "string" && vigilReturnPage(result.interstitial, reviewApi.runtime.getURL("/")))
            return result.interstitial;
        if (result?.ok && typeof result.url === "string" && candidates.includes(result.url))
            return result.url;
    }
    catch { /* An unavailable verifier must not choose another tab or window. */ }
    return "about:blank";
}
async function quietReviewReturn(tabId, state, currentUrl) {
    const url = await reviewReturnURL(state, currentUrl);
    if (vigilReturnPage(url, reviewApi.runtime.getURL("/")))
        return url;
    // A failed verifier or an empty history must not erase a later retry's
    // candidates. In particular, extension timeouts aren't a successful return.
    if (url === "about:blank" && vigilReturnPage(currentUrl, reviewApi.runtime.getURL("/")))
        return url;
    const index = state.history?.lastIndexOf(url) ?? -1;
    state.history = index < 0 ? [] : state.history?.slice(0, index + 1);
    state.pending = undefined;
    state.post = redditReviewPostId(url) || undefined;
    await writeReview(tabId, state);
    return url;
}
async function acceptReviewArrival(tabId, state, url) {
    const post = redditReviewPostId(url);
    if (!post)
        return false;
    if (state.post === post)
        return true;
    if (!state.pending || state.pending.expiresAt < Date.now() || (state.selected && state.selected !== post))
        return false;
    const sourceTabId = state.pending.sourceTabId;
    if (sourceTabId !== tabId) {
        const sourceTab = await reviewApi.tabs.get(sourceTabId).catch(() => null);
        if (sourceTab) {
            const sourceState = await readReview(sourceTabId, sourceTab);
            if (sourceState.search === state.search && sourceState.pending?.sourceTabId === sourceTabId) {
                sourceState.selected = post;
                sourceState.pending = undefined;
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
async function reviewMessage(message, sender) {
    const tabId = sender.tab?.id;
    if (tabId === undefined || sender.frameId !== 0 || !sender.url)
        return { ok: false };
    const current = await reviewApi.tabs.get(tabId);
    const sourceUrl = message.sourceUrl || sender.url;
    const currentURL = new URL(current.url || "about:blank");
    currentURL.hash = "";
    const sourceURL = new URL(sourceUrl);
    sourceURL.hash = "";
    if (currentURL.href !== sourceURL.href || new URL(sender.url).origin !== sourceURL.origin)
        return { ok: false, handled: true };
    const state = await readReview(tabId, current);
    if (message.action === "return") {
        if (!vigilReturnPage(sender.url, reviewApi.runtime.getURL("/")) && !redditReviewHost(sender.url))
            return { ok: false };
        await restoreReplacementReturn(tabId, current, state);
        return { ok: true, url: await quietReviewReturn(tabId, state, sender.url) };
    }
    if (message.action === "check")
        return { ok: Boolean(state.post && state.post === redditReviewPostId(sourceUrl)), retry: Boolean(state.pending && state.pending.expiresAt >= Date.now()) };
    if (message.action !== "open")
        return { ok: false };
    const search = redditReviewSearchPage(sourceUrl);
    const raw = String(message.url || "");
    const destination = redditReviewDestination(raw);
    const wrapped = redditReviewRedirect(raw, sourceUrl);
    const post = destination && redditReviewPostId(destination);
    if (!search || (!post && !wrapped))
        return { ok: false };
    if (state.search === search && state.selected && post && state.selected !== post)
        return { ok: false };
    // Reserve this search synchronously; another result cannot race the wrapper.
    if (state.search === search && state.pending && state.pending.expiresAt >= Date.now())
        return { ok: false };
    rememberReviewPage(state, sourceUrl);
    state.selected = state.search === search ? state.selected : undefined;
    state.search = search;
    state.pending = post ? undefined : { source: sourceUrl, sourceTabId: tabId, expiresAt: Date.now() + 15_000 };
    if (post)
        state.selected = post;
    await writeReview(tabId, state);
    let targetId = tabId;
    let targetState = state;
    if (message.newTab) {
        // Safari's default window is not necessarily the source's private window.
        const tab = await reviewApi.tabs.create({ url: "about:blank", active: true, openerTabId: tabId, windowId: current.windowId });
        if (tab.id === undefined || tab.windowId !== current.windowId || Boolean(tab.incognito) !== Boolean(current.incognito))
            return { ok: false };
        targetId = tab.id;
        targetState = { windowId: tab.windowId, incognito: Boolean(tab.incognito), search, selected: state.selected, pending: state.pending };
    }
    targetState.post = post || undefined;
    await writeReview(targetId, targetState);
    await reviewApi.tabs.update(targetId, { url: destination || raw });
    return { ok: true };
}
reviewApi.runtime.onMessage.addListener((message, sender, reply) => {
    if (message?.type !== "VIGIL_REDDIT_REVIEW")
        return undefined;
    void serializeReview(() => reviewMessage(message, sender)).then(reply, () => reply({ ok: false }));
    return true;
});
async function reviewNavigation(details) {
    if (details.frameId !== 0)
        return;
    const current = await reviewApi.tabs.get(details.tabId);
    if (current.url !== details.url)
        return;
    const state = await readReview(details.tabId, current);
    await restoreReplacementReturn(details.tabId, current, state);
    if (state.pending && ["typed", "auto_bookmark", "keyword", "keyword_generated"].includes(details.transitionType || "")
        && !details.transitionQualifiers?.some(value => value === "server_redirect" || value === "client_redirect"))
        state.pending = undefined;
    if (redditReviewHost(details.url)) {
        if (!await acceptReviewArrival(details.tabId, state, details.url)) {
            await reviewApi.tabs.update(details.tabId, { url: await quietReviewReturn(details.tabId, state, details.url) });
            return;
        }
    }
    else if (!vigilReturnPage(details.url, reviewApi.runtime.getURL("/")) && details.url !== "about:blank") {
        state.post = undefined;
        if (state.pending && !redditReviewRedirect(details.url, state.pending.source))
            state.pending = undefined;
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
        void navigation.catch(() => { });
    });
}
reviewApi.webNavigation.onBeforeNavigate?.addListener(details => {
    void serializeReview(() => preserveReplacementReturn(details)).catch(() => { });
});
reviewApi.tabs.onRemoved.addListener(tabId => {
    void serializeReview(() => reviewStorage.remove(`${reviewPrefix}${tabId}`)).catch(() => { });
});
reviewApi.runtime.onStartup.addListener(() => {
    void serializeReview(async () => {
        const stored = await reviewStorage.get(null);
        await reviewStorage.remove(Object.keys(stored).filter(key => key.startsWith(reviewPrefix) || key.startsWith(returnTransferPrefix)));
    });
});


})();
