(() => {
  'use strict';
  if (!/^https?:$/.test(location.protocol)) return;
  const isContextualPlatform = /(^|\.)(reddit\.com|deviantart\.com|artstation\.com|pixiv\.net|behance\.net|newgrounds\.com|furaffinity\.net|tumblr\.com|pinterest\.(?:com|co\.uk)|x\.com|twitter\.com|bsky\.app|patreon\.com|itch\.io|discord(?:app)?\.com)$/i.test(location.hostname);
  const explicitTitle = value => {
    const text = String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '');
    if (/(?:^|[^\p{L}\p{N}])(?:r[\s_.-]*34|rule[\s_.-]*34|p[\s_.-]*[o0][\s_.-]*r[\s_.-]*n|s[\s_.-]*3[\s_.-]*x|nud(?:s|3s?)?|(?:s[e3]x|nud(?:s|[e3]s?)?|p[o0]rn|r34|nsfw){2,})(?:$|[^\p{L}\p{N}]|videos?\b|photos?\b|pics?\b)/iu.test(text)) return true;
    // Catalog titles use XXX without a following word such as "videos".
    // Match the title token on every host, not arbitrary URL/identifier substrings.
    const titleMarkers = text.replace(/\b(?:chapter|volume|section|book|part|act|super bowl)\s+xxx\b/giu, '');
    if (/(?:^|[^\p{L}\p{N}])xxx(?:$|[^\p{L}\p{N}])/iu.test(titleMarkers)) return true;
    return /(?:^|[^a-z0-9])(?:porn(?:ography|ographic)?|p0rn|hentai|nsfw|gonewild|onlyfans|fansly|blowjob|cumshot)(?:$|[^a-z0-9])|\b(?:nude|naked|sex|xxx)\s+(?:videos?|photos?|tapes?)\b/i.test(text)
      || (isContextualPlatform && /(?:^|[^\p{L}\p{N}])(?:sex|sexual|nude|nudes|nudity|naked|erotic|erotica|lewd|fetish|uncensored|r[\s_-]*18g?|18\s*\+|成人向け|成人向|(?:adult|mature|explicit)[\s_-]+content)(?:$|[^\p{L}\p{N}])/iu.test(text));
  };
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
  // Reddit has a stricter dedicated guard and external-search review flow.
  // These platforms share label/age protections without inheriting Reddit's
  // single-post navigation rules (which would break messaging and creator pages).
  const isMixedPlatform = isContextualPlatform && !/(^|\.)reddit\.com$/i.test(location.hostname);
  const cards = 'article, [data-testid="tweet"], [data-testid="UserCell"], [data-testid^="feedItem"], [data-testid="post"], [data-tag="post-card"], [data-testid="post-card"], .game_cell, [id^="chat-messages-"]';
  const controls = 'button, a, input, label, select, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"]';
  const describe = element => [element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'), element.getAttribute('name'), ...(element.labels || []),
    ...(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => element.getRootNode().getElementById?.(id))]
    .map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').trim();
  const adultWarning = value => sensitiveWarning(value)
    || /(?:age[ -]restricted|adults?[ -]only|adult content|sexually (?:explicit|suggestive)|sexual content|\bnsfw\b|\br[ -]?18g?\b|18\s*\+|成人向け|成人向)/i.test(value);
  const ageConfirmation = value => /(?:i\s*(?:am|'m|’m)|yes[,]?\s*i(?:m|'m|’m)?|confirm[^.]{0,30}(?:age|over)|(?:enter|continue|view|show)[^.]{0,30}(?:over|age))[^.]{0,35}(?:18|eighteen)|(?:18|eighteen)[^.]{0,30}(?:or older|years or over)/i.test(value);
  const sensitivePreference = value => /(?:safe[ -]?search|(?:blur|hide|show|display|allow|include|filter|block|enable|disable|view)[^.]{0,65}(?:sensitive|adult|explicit|sexual|nudity|nsfw|r[ -]?18)|(?:sensitive|adult|explicit|sexual|nudity|nsfw|r[ -]?18)[^.]{0,65}(?:blur|hide|show|display|allow|include|filter|block|enable|disable))/i.test(value);
  const localContainer = element => {
    for (let node = element; node; node = node.getRootNode().host) {
      const card = node.closest(`${cards}, [role="dialog"], dialog, [data-testid*="contentWarning" i], [data-testid*="ageGate" i]`);
      if (card) return card;
      const form = node.closest('form');
      if (form && describe(form).length < 700 && adultWarning(describe(form))) return form;
    }
    return null;
  };
  const explicitAccount = value => explicitTitle(value) || /porn|p0rn|nsfw|onlyfans|fansly|gonewild|xxx/i.test(String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, ''));
  const authorMarkers = '[author], [data-author], [author-name], .author, .user_name, [data-testid="User-Name"], [data-testid="postAuthor"], [data-testid="post-author"], [data-tag="creator-name"]';
  const scanMixedPlatforms = root => {
    if (!isMixedPlatform) return;
    for (const author of root.querySelectorAll(authorMarkers)) {
      if ([author.getAttribute('author'), author.getAttribute('data-author'), author.getAttribute('author-name'),
        ...(author.matches(cards) ? [] : [author.textContent])].some(explicitAccount)) conceal(localContainer(author) || author);
    }
    for (const anchor of root.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      const samePlatform = url.hostname === location.hostname;
      let account = null;
      if (samePlatform && isX) account = url.pathname.match(/^\/([^/]+)(?:\/|$)/)?.[1];
      else if (samePlatform && /(^|\.)bsky\.app$/i.test(url.hostname)) account = url.pathname.match(/^\/profile\/([^/]+)/)?.[1];
      else if (samePlatform && /(^|\.)patreon\.com$/i.test(url.hostname)) account = url.pathname.match(/^\/c\/([^/]+)/)?.[1];
      if (account) {
        try { account = decodeURIComponent(account); } catch { /* Keep undecodable text bounded to the account segment. */ }
        if (explicitAccount(account)) conceal(localContainer(anchor) || anchor);
      }
    }
    for (const card of root.querySelectorAll(cards)) {
      if (explicitTitle(describe(card)) || adultWarning(card.textContent || '')
        || card.querySelector('[data-nsfw="true"], [data-adult="true"], [data-rating="adult"], [data-x-restrict="1"], [data-x-restrict="2"]')) conceal(card);
    }
    for (const element of root.querySelectorAll('*')) {
      if (element.matches('script, style, textarea, input, [contenteditable="true"]') || element.closest('[contenteditable="true"], script, style')) continue;
      const text = describe(element);
      const marked = element.matches('[data-nsfw="true"], [data-adult="true"], [data-rating="adult"], [data-x-restrict="1"], [data-x-restrict="2"]');
      // Bound prose checks so a label cannot erase a whole feed or channel.
      if (marked || (text.length < 700 && (adultWarning(text) || ageConfirmation(text)))) {
        const container = localContainer(element);
        if (container) conceal(container);
        else if (marked || element.matches('span, p, h1, h2, h3, label, button, summary') || element.childElementCount === 0) {
          if (!element.matches('html, body, main, nav, form')) conceal(mediaContainer(element));
        }
      }
    }
    for (const control of root.querySelectorAll(controls)) {
      const text = describe(control);
      const group = control.closest('label, fieldset, [role="group"], [role="radiogroup"]');
      const groupText = group && describe(group);
      const adultContext = localContainer(control);
      if ((text.length < 500 && (sensitivePreference(text) || ageConfirmation(text)))
        || (groupText && groupText.length < 700 && sensitivePreference(groupText))
        || (adultContext && adultWarning(describe(adultContext)) && /^(?:show|view|reveal|continue|enter|yes|confirm|accept)$/i.test(text))) {
        conceal(group || control);
      }
    }
  };
  const roots = new Set();
  const observers = new WeakMap();
  let pending = false;
  const conceal = element => {
    element.setAttribute('data-vigil-explicit-media', 'blocked');
    if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important') element.style.setProperty('display', 'none', 'important');
    if (element.matches('video, audio')) { try { element.pause(); } catch {} }
    element.querySelectorAll('video, audio').forEach(media => { try { media.pause(); } catch {} });
  };
  const mediaContainer = label => {
    // Select the smallest media-bearing ancestor, never an entire result grid.
    // An explicit poster label must remove its card, not just the image.
    let node = label.matches('img, video, picture, canvas')
      ? label.parentElement || label
      : label;
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
      scanMixedPlatforms(root);
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
          if (target !== element || element.matches('img, video, a, button, [role="link"], [role="button"]') || element.querySelector('img, video, picture') || (isMixedPlatform && !element.matches('main, nav, body, html'))) conceal(target);
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
    try {
      observer.observe(root, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['alt','title','aria-label','data-title','data-testid','data-nsfw','data-adult','data-rating','data-x-restrict','author','data-author','author-name','href','class','aria-labelledby','name','value','aria-checked','checked','style']});
      const style = document.createElement('style');
      style.textContent = '[data-vigil-explicit-media="blocked"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }';
      (root === document ? document.documentElement : root).append(style);
      observers.set(root, observer);
    } catch (error) {
      // A later complete scan must retry all setup, rather than attest a root
      // whose mutation observer or hiding style was never installed.
      observer.disconnect();
      throw error;
    }
  };
  const guard = event => {
    if (isX || isMixedPlatform) scan();
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue;
      if (element.getAttribute('data-vigil-explicit-media') !== 'blocked') continue;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
  };
  for (const event of ['click','pointerdown','keydown','submit','change','play']) window.addEventListener(event, guard, true);
  const runtime = globalThis.browser?.runtime || globalThis.chrome?.runtime;
  // Safari enforces the filters directly without a separate page-connection
  // timeout. Keep every scan and guard running, but avoid sending unused
  // health messages. Chrome retains its existing reporting protocol.
  let reportsHealth = true;
  try { reportsHealth = !String(runtime?.getURL?.('') || '').startsWith('safari-web-extension:'); }
  catch { /* Identifying a stale extension context must not stop its filters. */ }
  const reportHealth = () => {
    // Every frame keeps its filters active, including hidden and newly parsed
    // frames that cannot attest the visible top-level page.
    // A transient DOM failure must not end the reporting lifecycle. A failed
    // scan provides no health evidence; the next lifecycle event or heartbeat
    // must perform the complete scan again before it can report success.
    try { scan(); } catch { return; }
    if (!reportsHealth) return;
    if (window.top !== window || document.visibilityState !== 'visible' || !document.documentElement) return;
    // A successful scan precedes every report. The background supplies the
    // sender URL and verifies its active, focused window. Safari can leave
    // focus in its address bar after a private search: document.hasFocus()
    // would reject a visible, protected page in that case.
    try { Promise.resolve(runtime?.sendMessage({type:'VIGIL_BROWSER_FILTER_HEALTH', revision:'2026-09-17.1'})).catch(() => {}); } catch {}
  };
  document.addEventListener('DOMContentLoaded', reportHealth, {once:true});
  addEventListener('pageshow', reportHealth, true);
  addEventListener('focus', reportHealth, true);
  document.addEventListener('visibilitychange', reportHealth);
  // Browser focus can return to the address bar without a DOM focus or
  // visibility event. Re-scan on a background request without reloading the
  // document, losing a form, or changing its navigation history.
  runtime?.onMessage?.addListener(message => {
    if (message?.type === 'VIGIL_REQUEST_BROWSER_FILTER_HEALTH') reportHealth();
  });
  setInterval(reportHealth, 1500);
  reportHealth();
})();
