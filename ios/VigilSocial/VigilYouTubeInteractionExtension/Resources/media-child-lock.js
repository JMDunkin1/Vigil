(() => {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
  const explicitTitle = value => /(?:^|[^a-z0-9])(?:xxx|sex|porn(?:ography|ographic)?|p0rn|hentai|nsfw|gonewild|onlyfans|fansly|blowjob|cumshot)(?:$|[^a-z0-9])|\b(?:nude|naked|sex)\s+(?:videos?|photos?|tapes?)\b/i.test(String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, ''));
  const isX = /(^|\.)(x\.com|twitter\.com)$/i.test(location.hostname);
  const sensitiveWarning = value => /(?:this (?:post|media|profile|account)|the following media|content warning)[\s\S]{0,100}(?:sensitive|adult|nudity|sexual)|^(?:sensitive content|adult content|age.restricted content)$/i.test(String(value || '').trim());
  const scanX = root => {
    if (!isX) return;
    // Keep the whole post together: hiding only its label leaves attached media visible.
    for (const post of root.querySelectorAll('article, [data-testid="tweet"], [data-testid="UserCell"]')) {
      const text = post.textContent || '';
      if (explicitTitle(text) || sensitiveWarning(text) || post.querySelector('[data-testid*="sensitiveMedia" i], [data-testid*="sensitive_media" i]')) conceal(post);
    }
    for (const marker of root.querySelectorAll('span, [role="dialog"], [data-testid*="sensitive" i]')) {
      const text = (marker.textContent || '').trim();
      if (text.length > 700 || !sensitiveWarning(text)) continue;
      conceal(marker.closest('article, [role="dialog"], [data-testid="cellInnerDiv"]') || marker.parentElement || marker);
    }
    for (const control of root.querySelectorAll('button, a, input, label, [role="button"], [role="checkbox"], [role="switch"]')) {
      const text = [control.textContent, control.getAttribute('aria-label'), ...(control.labels || [])].map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ').trim();
      // Lock both directions of the preference controls. This is a browser-side
      // interlock, not a claim that X's account preference has been saved.
      if (text.length < 400 && /(?:display|show|hide|view|allow)\s+(?:media that may contain\s+)?sensitive (?:content|media)|(?:yes[,]?\s*)?i(?: am|'m|’m) (?:over )?18/i.test(text)) conceal(control);
      if (/^(?:show|view|continue|yes)$/i.test(text)) {
        const context = control.closest('article, [role="dialog"], [data-testid="cellInnerDiv"]');
        if (context && sensitiveWarning(context.textContent)) conceal(context);
      }
    }
  };
  const roots = new Set();
  const observers = new WeakMap();
  let pending = false;
  const conceal = element => {
    element.setAttribute('data-vigil-explicit-media', 'blocked');
    if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important') element.style.setProperty('display', 'none', 'important');
    element.querySelectorAll('video, audio').forEach(media => { try { media.pause(); } catch {} });
  };
  const mediaContainer = label => {
    // Select the smallest media-bearing ancestor, never an entire result grid.
    let node = label;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement || node.getRootNode().host) {
      if (node === document.body || node === document.documentElement) break;
      const media = node.querySelectorAll('img, picture, video, canvas, [style*="background-image"]');
      if (media.length > 4) break;
      if (media.length || node.matches('img, video, picture')) return node;
    }
    return label.closest('a, button, [role="link"], [role="button"]') || label;
  };
  const scan = () => {
    if (!document.documentElement) return;
    observe(document);
    for (const root of roots) {
      if (root !== document && !root.host.isConnected) { roots.delete(root); continue; }
      scanX(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) observe(element.shadowRoot);
        if (element.closest('[data-vigil-explicit-media="blocked"]')) {
          if (element.getAttribute('data-vigil-explicit-media') === 'blocked') conceal(element);
          continue;
        }
        if (element.matches('script, style, textarea, input, [contenteditable="true"]') || element.closest('script, style, [contenteditable="true"]')) continue;
        const label = [element.getAttribute('alt'), element.getAttribute('title'), element.getAttribute('aria-label'), element.getAttribute('data-title')].filter(Boolean).join(' ');
        // Short direct text catches catalog labels even if they use plain divs.
        const directText = Array.from(element.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent).join(' ').trim();
        if (explicitTitle(label) || (directText.length <= 180 && explicitTitle(directText))) {
          const target = mediaContainer(element);
          if (target !== element || element.matches('img, video, a, button, [role="link"], [role="button"]') || element.querySelector('img, video, picture')) conceal(target);
        }
      }
    }
  };
  const schedule = () => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; scan(); }, 0);
  };
  const observe = root => {
    roots.add(root);
    if (observers.has(root)) return;
    const observer = new MutationObserver(schedule);
    observers.set(root, observer);
    observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['alt','title','aria-label','data-title','data-testid','aria-checked','checked','style']});
    const style = document.createElement('style');
    style.textContent = '[data-vigil-explicit-media="blocked"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }';
    (root === document ? document.documentElement : root).append(style);
  };
  const guard = event => {
    if (isX) scan();
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.getAttribute('data-vigil-explicit-media') !== 'blocked') continue;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };
  for (const event of ['click','pointerdown','keydown','play']) window.addEventListener(event, guard, true);
  if (document.documentElement) scan();
  else document.addEventListener('DOMContentLoaded', scan, {once:true});
  addEventListener('pageshow', scan, true);
  const reportHealth = () => {
    if (window.top !== window || document.visibilityState !== 'visible' || !document.hasFocus()) return;
    // A successful scan precedes every report. The background supplies the
    // sender URL and browser identity; page-supplied identities are ignored.
    scan();
    const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
    try { Promise.resolve(runtime?.sendMessage({type:'VIGIL_BROWSER_FILTER_HEALTH', revision:'2026-09-17.1'})).catch(() => {}); } catch {}
  };
  reportHealth();
  addEventListener('focus', reportHealth, true);
  document.addEventListener('visibilitychange', reportHealth);
  setInterval(() => { scan(); reportHealth(); }, 1500);
})();
