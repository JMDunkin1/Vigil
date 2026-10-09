// BEGIN GENERATED YOUTUBE EMBED POLICY
function youtubeEmbedID(value) {
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
            || !/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(url.hostname)
            || url.searchParams.has('list') || url.searchParams.has('playlist'))
            return null;
        return /^\/embed\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] || null;
    }
    catch {
        return null;
    }
}
function createYouTubeEmbedPolicy(api) {
    const queues = new Map();
    function serial(tabId, operation) {
        const next = (queues.get(tabId) || Promise.resolve()).catch(() => { }).then(operation);
        void queues.set(tabId, next);
        const cleanup = () => { if (queues.get(tabId) === next)
            queues.delete(tabId); };
        void next.then(cleanup, cleanup);
        return next;
    }
    const key = (tabId) => `youtube-embeds:${tabId}`;
    async function inspect(sender, register) {
        const tabId = sender.tab?.id, frameId = sender.frameId;
        if (tabId === undefined || frameId === undefined || frameId <= 0)
            return null;
        return serial(tabId, async () => {
            const frames = await api.frames(tabId);
            const frame = frames?.find(item => item.frameId === frameId);
            const top = frames?.find(item => item.frameId === 0);
            if (!frame || !top || frame.url !== sender.url
                || (sender.documentId && frame.documentId && sender.documentId !== frame.documentId))
                return null;
            const topIdentity = top.documentId || top.url;
            const stored = (await api.storage.get(key(tabId)))[key(tabId)];
            const record = stored?.top === topIdentity ? stored : { top: topIdentity, frames: {} };
            const id = youtubeEmbedID(frame.url);
            let parent = frame, external = true;
            const seen = new Set([frameId]);
            while (parent.frameId !== 0) {
                const ancestor = frames.find(item => item.frameId === parent.parentFrameId);
                if (!ancestor || seen.has(ancestor.frameId)) {
                    external = false;
                    break;
                }
                seen.add(ancestor.frameId);
                const url = new URL(ancestor.url);
                if (!/^https?:$/.test(url.protocol) || /(^|\.)(youtube(?:-nocookie)?\.com|youtu\.be)$/.test(url.hostname)) {
                    external = false;
                    break;
                }
                parent = ancestor;
            }
            // Pin the first document in each frame until the containing page reloads.
            // A recommendation navigating that frame must not mint another exemption.
            if (register && !Object.hasOwn(record.frames, String(frameId))) {
                record.frames[frameId] = external ? id : null;
                await api.storage.set({ [key(tabId)]: record });
            }
            return external && id && record.frames[frameId] === id ? id : null;
        });
    }
    return {
        register: (sender) => inspect(sender, true),
        eligible: async (sender, videoId) => Boolean(videoId && await inspect(sender, false) === videoId),
        reset: (tabId) => serial(tabId, () => api.storage.set({ [key(tabId)]: null }))
    };
}
// END GENERATED YOUTUBE EMBED POLICY
const youtubeEmbeds = createYouTubeEmbedPolicy({
  storage: browser.storage.local,
  frames: tabId => browser.webNavigation.getAllFrames({ tabId })
});
const youtubeNavigationPending = new Map();
function serializeYouTubeNavigation(tabId, work) {
  const next = (youtubeNavigationPending.get(tabId) || Promise.resolve()).catch(() => {}).then(work);
  youtubeNavigationPending.set(tabId, next);
  const cleanup = () => { if (youtubeNavigationPending.get(tabId) === next) youtubeNavigationPending.delete(tabId); };
  void next.then(cleanup, cleanup);
  return next;
}
browser.webNavigation.onCommitted.addListener(details => {
  void (details.frameId === 0 ? youtubeEmbeds.reset(details.tabId)
    : youtubeEmbeds.register({ tab: { id: details.tabId }, frameId: details.frameId, url: details.url, documentId: details.documentId })).catch(() => {});
});
browser.tabs.onRemoved.addListener(tabId => { void youtubeEmbeds.reset(tabId).catch(() => {}); });

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type === 'VIGIL_YOUTUBE_EXTERNAL_LINK') {
    return (async () => {
      // Only the external top-level document can attest to a result click.
      // YouTube pages, embeds, and page-world bridge messages cannot grant it.
      const source = new URL(sender.url || 'about:blank');
      if (sender.frameId !== 0 || sender.tab?.id === undefined || !/^https?:$/.test(source.protocol)
          || isYouTube(source.href)) return { ok: false };
      const target = new URL(message.url);
      const id = youtubeVideoID(target);
      if (!id) return { ok: false };
      const result = await browser.runtime.sendNativeMessage('tech.caseline.vigil', { action: 'external', videoId: id });
      if (result?.ok) await browser.storage.local.set({ [`youtube-handoff:${sender.tab.id}`]: { id, eligible: true } });
      return result;
    })().catch(() => ({ ok: false }));
  }
  if (message?.type !== 'VIGIL_YOUTUBE') return undefined;
  const host = new URL(sender.url || 'about:blank').hostname;
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(host) || ['external', 'browser-filter-health', 'browser-navigation'].includes(message.youtube?.action)) return Promise.resolve({ ok: false });
  const reply = (async () => {
    // A document-start Play can arrive before the incoming-link grant finishes.
    if (message.youtube?.action === 'start') await youtubeNavigationPending.get(sender.tab?.id);
    if (message.youtube?.action === 'start' && await youtubeEmbeds.eligible(sender, message.youtube.videoId)) {
      const grant = await browser.runtime.sendNativeMessage('tech.caseline.vigil', { action: 'external', videoId: message.youtube.videoId });
      if (!grant?.ok) return grant;
    }
    return browser.runtime.sendNativeMessage('tech.caseline.vigil', {
      ...message.youtube, client: `safari:${sender.tab?.id}:${sender.frameId}:${message.youtube.client}`
    });
  })().catch(() => ({ ok: false, message: 'Vigil could not check the allowance. Try again.' }));
  if (message.youtube?.action === 'search') {
    return reply.then(async result => {
      if (result?.ok) await browser.storage.local.set({ [`youtube-handoff:${sender.tab?.id}`]: { id: message.youtube.videoId, eligible: true } });
      return result;
    });
  }
  return reply;
});

// Navigation provenance is kept in extension storage, outside page control.
// Direct address-bar/bookmark requests and incoming links use time only.
// Reloads and links originating in YouTube retain their existing permission.
const isYouTube = url => {
  try { return /(^|\.)youtube(?:-nocookie)?\.com$/.test(new URL(url).hostname) || new URL(url).hostname === 'youtu.be'; }
  catch { return false; }
};
const externalGrant = async (url, source) => {
  if (source !== true) return;
  const target = new URL(url);
  if (!isYouTube(url) || /^\/shorts\//.test(target.pathname)) return;
  const id = youtubeVideoID(target);
  if (!/^[\w-]{11}$/.test(id || '')) return;
  await browser.runtime.sendNativeMessage('tech.caseline.vigil', { action: 'external', videoId: id });
};
const youtubeVideoID = target => {
  if (target.protocol !== 'https:' || target.username || target.password || (target.port && target.port !== '443')) return null;
  const parts = target.pathname.split('/').filter(Boolean);
  const id = target.hostname === 'youtu.be' && parts.length === 1 ? parts[0]
    : /^(www\.|m\.)?youtube\.com$/.test(target.hostname)
      ? /^\/watch\/?$/.test(target.pathname) ? target.searchParams.get('v')
        : parts.length === 2 && ['live', 'embed'].includes(parts[0]) ? parts[1] : null
      : null;
  return /^[\w-]{11}$/.test(id || '') ? id : null;
};
browser.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  void serializeYouTubeNavigation(details.tabId, async () => {
    const key = `youtube-source:${details.tabId}`;
    const handoffKey = `youtube-handoff:${details.tabId}`;
    const stored = await browser.storage.local.get([key, handoffKey]);
    let previous = stored[key];
    // Safari omits transitionType for native-app links. A fresh top-level tab
    // without a YouTube opener is a direct entry; reused YouTube tabs and
    // recommendation tabs keep their discovery gate.
    if (previous === undefined && browser.tabs.get) {
      const tab = await browser.tabs.get(details.tabId);
      if (tab.openerTabId !== undefined) {
        const openerSource = (await browser.storage.local.get(`youtube-source:${tab.openerTabId}`))[`youtube-source:${tab.openerTabId}`];
        const opener = await browser.tabs.get(tab.openerTabId);
        previous = openerSource === true && !isYouTube(opener.url || '') ? true : false;
      }
    }
    const id = youtubeVideoID(new URL(details.url));
    const linked = details.transitionType === 'link' && !details.transitionQualifiers?.includes('forward_back');
    const direct = ['typed', 'auto_bookmark', 'start_page', 'auto_toplevel'].includes(details.transitionType)
      && !details.transitionQualifiers?.includes('forward_back');
    const incoming = !details.transitionType && previous !== false
      && !details.transitionQualifiers?.includes('forward_back');
    const eligible = Boolean(id && ((linked && previous !== false) || direct || incoming
      || (stored[handoffKey]?.id === id && stored[handoffKey]?.eligible)));
    await browser.storage.local.set({ [handoffKey]: { id, eligible } });
    await browser.storage.local.set({ [key]: /^https?:/.test(details.url) && !isYouTube(details.url) });
    if (eligible) await externalGrant(details.url, true);
  }).catch(() => {});
});
browser.webNavigation.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0) return;
  void serializeYouTubeNavigation(details.tabId, async () => {
    const key = `youtube-handoff:${details.tabId}`;
    const previous = (await browser.storage.local.get(key))[key];
    const id = youtubeVideoID(new URL(details.url));
    await browser.storage.local.set({ [key]: { id, eligible: Boolean(id && previous?.id === id && previous?.eligible) } });
  }).catch(() => {});
});
// Safari does not expose this optional event on every supported release.
browser.webNavigation.onCreatedNavigationTarget?.addListener(details => {
  void serializeYouTubeNavigation(details.tabId, async () => {
    const key = `youtube-source:${details.sourceTabId}`;
    const previous = details.sourceFrameId > 0 ? false : (await browser.storage.local.get(key))[key];
    // A YouTube recommendation opened in a new tab is still discovery.
    await browser.storage.local.set({ [`youtube-source:${details.tabId}`]: previous === true });
    await externalGrant(details.url, previous);
  }).catch(() => {});
});

browser.tabs.onRemoved.addListener(tabId => {
  void browser.storage.local.remove([`youtube-source:${tabId}`, `youtube-handoff:${tabId}`]).catch(() => {});
});

// BEGIN GENERATED SEARCH BREAK
(() => {
function limitedSearchWarning(value) {
    return typeof value === "string" && value.length <= 240
        && /^(?:some\s+)?results\s+are\s+limited\s+by\s+(?:safe\s*search|search)\s*[.!]?$/iu.test(value.replace(/\s+/gu, " ").trim());
}
function limitedSearchPage(value) {
    try {
        const url = new URL(String(value));
        return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
            && ["google.com", "www.google.com", "images.google.com"].includes(url.hostname)
            && url.pathname === "/search" && Boolean(url.searchParams.get("q"));
    }
    catch {
        return false;
    }
}

(() => {
    const api = globalThis.browser || chrome;
    const safari = api.runtime.getURL("").startsWith("safari-web-extension:");
    const page = api.runtime.getURL("search-break.html");
    const cacheKey = "vigil-search-break-until";
    let queue = Promise.resolve(undefined);
    let lastSweepUntil = 0;
    let status;
    async function action(body) {
        const now = Date.now();
        if (body.action === "search-break-status" && status && now >= status.at && now - status.at < 500)
            return status.result;
        try {
            const result = safari
                ? await api.runtime.sendNativeMessage("tech.caseline.vigil", body)
                : await (await globalThis.fetchVigil("/api/extension/youtube", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
            if (!result?.ok)
                throw new Error("Search break authority unavailable");
            await api.storage.local.set({ [cacheKey]: result.until || 0 });
            status = { at: now, result };
            return result;
        }
        catch {
            const until = Number((await api.storage.local.get(cacheKey))[cacheKey] || 0);
            if (until > now)
                return { ok: true, blocked: true, until, remainingMs: until - now, serverTime: now };
            return { ok: false };
        }
    }
    async function sweep(result) {
        const until = Number(result.until || 0);
        if (!result.blocked || lastSweepUntil === until)
            return;
        const tabs = await api.tabs.query({});
        await Promise.allSettled(tabs.filter(tab => tab.id !== undefined && /^https?:/u.test(tab.url || ""))
            .map(tab => api.tabs.update(tab.id, { url: page })));
        lastSweepUntil = until;
    }
    api.runtime.onMessage.addListener((message, sender, reply) => {
        if (message?.type !== "VIGIL_SEARCH_BREAK" || sender.frameId && sender.frameId !== 0)
            return false;
        const work = async () => {
            if (!["search-break-warning", "search-break-status"].includes(message.action))
                return { ok: false };
            const body = { action: message.action };
            if (message.action === "search-break-warning") {
                if (!limitedSearchPage(sender.url) || !limitedSearchWarning(message.warning) || sender.tab?.id === undefined
                    || typeof message.id !== "string" || !/^[a-f0-9-]{36}$/u.test(message.id))
                    return { ok: false };
                const tab = await api.tabs.get(sender.tab.id);
                if (!tab.active || tab.url !== message.url || !limitedSearchPage(tab.url))
                    return { ok: false };
                Object.assign(body, { id: `${sender.tab.id}:${message.id}`, url: tab.url, warning: message.warning });
            }
            else if (!sender.url || (!/^https?:/u.test(sender.url) && sender.url !== page))
                return { ok: false };
            const result = await action(body);
            await sweep(result);
            return result;
        };
        const next = queue.then(work, work);
        queue = next.catch(() => { });
        void next.then(reply).catch(() => reply({ ok: false }));
        return true;
    });
    async function guard(tabId, url) {
        if (!/^https?:/u.test(url || ""))
            return;
        const work = async () => {
            const result = await action({ action: "search-break-status" });
            if (result.blocked) {
                const tab = await api.tabs.get(tabId);
                if (/^https?:/u.test(tab.url || ""))
                    await api.tabs.update(tabId, { url: page });
            }
        };
        const next = queue.then(work, work);
        queue = next.catch(() => { });
        await next;
    }
    api.webNavigation.onCommitted.addListener(details => {
        if (details.frameId === 0)
            void guard(details.tabId, details.url).catch(() => { });
    });
    api.tabs.onActivated.addListener(({ tabId }) => {
        void api.tabs.get(tabId).then(tab => guard(tabId, tab.url)).catch(() => { });
    });
})();

})();
// END GENERATED SEARCH BREAK
