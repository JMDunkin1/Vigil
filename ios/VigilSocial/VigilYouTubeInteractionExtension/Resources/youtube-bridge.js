(() => {
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
