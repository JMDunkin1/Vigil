browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'VIGIL_YOUTUBE') return undefined;
  const host = new URL(sender.url || 'about:blank').hostname;
  if (!/^(www\.|m\.)?youtube\.com$/.test(host) || message.youtube?.action === 'external') return Promise.resolve({ ok: false });
  return browser.runtime.sendNativeMessage('tech.caseline.vigil', {
    ...message.youtube, client: `safari:${sender.tab?.id}:${message.youtube.client}`
  });
});


// Navigation provenance is kept in extension storage, outside page control.
// Reloads, typed URLs, missing referrers and YouTube new tabs do not grant an
// exemption. Source tabs on other sites can authorize a clicked video link.
const isYouTube = url => {
  try { return /(^|\.)youtube(?:-nocookie)?\.com$/.test(new URL(url).hostname) || new URL(url).hostname === 'youtu.be'; }
  catch { return false; }
};
const externalGrant = async (url, source) => {
  if (source !== true) return;
  const target = new URL(url);
  if (!isYouTube(url) || /^\/shorts\//.test(target.pathname)) return;
  const id = target.hostname === 'youtu.be' ? target.pathname.slice(1) : target.searchParams.get('v');
  if (!/^[\w-]{11}$/.test(id || '')) return;
  await browser.runtime.sendNativeMessage('tech.caseline.vigil', { action: 'external', videoId: id });
};
browser.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  void (async () => {
    const key = `youtube-source:${details.tabId}`;
    const previous = (await browser.storage.local.get(key))[key];
    await browser.storage.local.set({ [key]: /^https?:/.test(details.url) && !isYouTube(details.url) });
    if (details.transitionType === 'link' && !details.transitionQualifiers?.includes('forward_back')) await externalGrant(details.url, previous);
  })().catch(() => {});
});
browser.webNavigation.onCreatedNavigationTarget.addListener(details => {
  void (async () => {
    const key = `youtube-source:${details.sourceTabId}`;
    const previous = (await browser.storage.local.get(key))[key];
    await externalGrant(details.url, previous);
  })().catch(() => {});
});

browser.tabs.onRemoved.addListener(tabId => {
  void browser.storage.local.remove(`youtube-source:${tabId}`).catch(() => {});
});
