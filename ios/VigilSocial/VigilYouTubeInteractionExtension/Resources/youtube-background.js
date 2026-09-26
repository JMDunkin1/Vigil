browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'VIGIL_YOUTUBE') return undefined;
  const host = new URL(sender.url || 'about:blank').hostname;
  if (!/^(www\.|m\.)?youtube\.com$/.test(host) || ['external', 'browser-filter-health', 'browser-navigation'].includes(message.youtube?.action)) return Promise.resolve({ ok: false });
  const reply = browser.runtime.sendNativeMessage('tech.caseline.vigil', {
    ...message.youtube, client: `safari:${sender.tab?.id}:${message.youtube.client}`
  });
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
    const previous = (await browser.storage.local.get(key))[key];
    // A YouTube recommendation opened in a new tab is still discovery.
    await browser.storage.local.set({ [`youtube-source:${details.tabId}`]: previous === true });
    await externalGrant(details.url, previous);
  })().catch(() => {});
});

browser.tabs.onRemoved.addListener(tabId => {
  void browser.storage.local.remove([`youtube-source:${tabId}`, `youtube-handoff:${tabId}`]).catch(() => {});
});
