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
browser.webNavigation.onCommitted.addListener(details => {
  void (details.frameId === 0 ? youtubeEmbeds.reset(details.tabId)
    : youtubeEmbeds.register({ tab: { id: details.tabId }, frameId: details.frameId, url: details.url, documentId: details.documentId })).catch(() => {});
});
browser.tabs.onRemoved.addListener(tabId => { void youtubeEmbeds.reset(tabId).catch(() => {}); });

browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'VIGIL_YOUTUBE') return undefined;
  const host = new URL(sender.url || 'about:blank').hostname;
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(host) || ['external', 'browser-filter-health', 'browser-navigation'].includes(message.youtube?.action)) return Promise.resolve({ ok: false });
  const reply = (async () => {
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
  void (async () => {
    const key = `youtube-source:${details.tabId}`;
    const handoffKey = `youtube-handoff:${details.tabId}`;
    const stored = await browser.storage.local.get([key, handoffKey]);
    const previous = stored[key];
    const id = youtubeVideoID(new URL(details.url));
    const linked = details.transitionType === 'link' && !details.transitionQualifiers?.includes('forward_back');
    const direct = ['typed', 'auto_bookmark'].includes(details.transitionType);
    const eligible = Boolean(id && ((linked && previous !== false) || direct
      || (stored[handoffKey]?.id === id && stored[handoffKey]?.eligible)));
    await browser.storage.local.set({ [handoffKey]: { id, eligible } });
    await browser.storage.local.set({ [key]: /^https?:/.test(details.url) && !isYouTube(details.url) });
    if (eligible) await externalGrant(details.url, true);
  })().catch(() => {});
});
browser.webNavigation.onHistoryStateUpdated?.addListener(details => {
  if (details.frameId !== 0) return;
  void (async () => {
    const key = `youtube-handoff:${details.tabId}`;
    const previous = (await browser.storage.local.get(key))[key];
    const id = youtubeVideoID(new URL(details.url));
    await browser.storage.local.set({ [key]: { id, eligible: Boolean(id && previous?.id === id && previous?.eligible) } });
  })().catch(() => {});
});
// Safari does not expose this optional event on every supported release.
browser.webNavigation.onCreatedNavigationTarget?.addListener(details => {
  void (async () => {
    const key = `youtube-source:${details.sourceTabId}`;
    const previous = details.sourceFrameId > 0 ? false : (await browser.storage.local.get(key))[key];
    // A YouTube recommendation opened in a new tab is still discovery.
    await browser.storage.local.set({ [`youtube-source:${details.tabId}`]: previous === true });
    await externalGrant(details.url, previous);
  })().catch(() => {});
});

browser.tabs.onRemoved.addListener(tabId => {
  void browser.storage.local.remove([`youtube-source:${tabId}`, `youtube-handoff:${tabId}`]).catch(() => {});
});
