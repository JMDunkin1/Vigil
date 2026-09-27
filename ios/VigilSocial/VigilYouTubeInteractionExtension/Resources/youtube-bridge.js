(() => {
  // Safari does not reliably classify an incoming Google result as a "link"
  // navigation. Capture the trusted click in the isolated extension world and
  // persist its allowance before the source document is destroyed.
  if (!/(^|\.)(youtube(?:-nocookie)?\.com|youtu\.be)$/.test(location.hostname)) {
    if (window.top !== window) return;
    const externalClick = event => {
      if (!event.isTrusted || (event.type === 'auxclick' && event.button !== 1)) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return;
      try {
        const destination = anchor.href;
        let url = new URL(destination);
        if ((/(^|\.)google\.com$/.test(url.hostname) && url.pathname === '/url')
            || (/(^|\.)duckduckgo\.com$/.test(url.hostname) && url.pathname === '/l/')) {
          url = new URL(url.searchParams.get('url') || url.searchParams.get('q') || url.searchParams.get('uddg') || '');
        }
        if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return;
        const parts = url.pathname.split('/').filter(Boolean);
        const id = url.hostname === 'youtu.be' && parts.length === 1 ? parts[0]
          : /^(www\.|m\.)?youtube\.com$/.test(url.hostname)
            ? /^\/watch\/?$/.test(url.pathname) ? url.searchParams.get('v')
              : parts.length === 2 && ['live', 'embed'].includes(parts[0]) ? parts[1] : null
            : null;
        if (!/^[\w-]{11}$/.test(id || '')) return;
        const sameTab = event.type !== 'auxclick' && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
          && (!anchor.target || anchor.target === '_self');
        if (sameTab) { event.preventDefault(); event.stopImmediatePropagation(); }
        const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
        void Promise.resolve(runtime.sendMessage({ type: 'VIGIL_YOUTUBE_EXTERNAL_LINK', url: url.href }))
          .catch(() => {}).finally(() => { if (sameTab) location.assign(destination); });
      } catch { /* Unrecognized links retain the normal playback gate. */ }
    };
    document.addEventListener('click', externalClick, true);
    document.addEventListener('auxclick', externalClick, true);
    return;
  }
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== 'VIGIL_YOUTUBE_REQUEST') return;
    const { id, body } = event.data;
    if (typeof id !== 'string' || id.length > 100 || !body || body.action === 'external') return;
    const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    Promise.resolve(runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body })).then(
      value => window.postMessage({ type: 'VIGIL_YOUTUBE_REPLY', id, value }, location.origin),
      () => window.postMessage({ type: 'VIGIL_YOUTUBE_REPLY', id, value: { ok: false, message: 'Vigil could not check the allowance. Try again.' } }, location.origin)
    );
  });
})();
