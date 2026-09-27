(() => {
  'use strict';
  const redditHost = host => /(^|\.)reddit\.com$/i.test(host);
  if (!redditHost(location.hostname)) return;
  const text = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff]/g, '').replace(/\s+/g, ' ').trim();
  const explicit = value => /(?:^|[\W_])sex(?:$|[\W_])|porn|p0rn|prno|xxx|nsfw|hentai|rule[\s_-]*34|gonewild|onlyfans|fansly|nudes?|naked|blowjob|handjob|cumshot|hardcore\s+sex|sex\s+(?:videos?|tapes?)/i.test(text(value));
  const unsafeMedia = value => /(?:^|[^\p{L}\p{N}])(?:(?:adult|unreviewed)[\s_-]+videos?|x{1,2}[\s_-]+(?:videos?|photos?|pics?))(?:$|[^\p{L}\p{N}])/iu.test(text(value));
  const unreviewedLabel = value => /^(?:(?:show|view|see|more|show more|view more)\s+)?unreviewed[\s_-]+videos?(?:\s*\(\d+\))?$/i.test(text(value));
  const decode = value => {
    for (let pass = 0; pass < 3; pass++) {
      try { const next = decodeURIComponent(value); if (next === value) break; value = next; } catch { break; }
    }
    return text(value.replace(/\+/g, ' '));
  };
  const unsafeQuery = value => explicit(decode(value)) || unsafeMedia(decode(value)) || /^x{1,2}$/i.test(decode(value));
  const ageConfirmation = value => /\b(?:i\s*(?:am|'m|’m)|im)\s+(?:over\s+)?(?:18|eighteen)\b|\b(?:yes|continue|enter|view|confirm).{0,30}(?:18\+|over\s+18|adult|mature|nsfw)\b/i.test(text(value));
  const safeURL = value => {
    let url;
    try { url = new URL(value, location.href); } catch { return null; }
    if (!redditHost(url.hostname)) return null;
    const path = decode(url.pathname);
    if (/^\/(?:over18|api\/over18)(?:\/|$)/i.test(path)
      || explicit(path) || unsafeMedia(path) || url.searchParams.getAll('q').some(unsafeQuery)) return 'https://www.reddit.com/';
    if (/(?:^|\/)search(?:\.json)?\/?$/i.test(path)) {
      url.searchParams.set('include_over_18', 'off');
      url.searchParams.set('nsfw', '0');
      if (url.href !== new URL(value, location.href).href) return url.href;
    }
    return null;
  };
  const enforceURL = () => {
    const destination = safeURL(location.href);
    if (destination) { location.replace(destination); return true; }
    return false;
  };
  if (enforceURL()) return;

  const controls = 'button, input, label, a[href], [role="button"], [role="switch"], [role="checkbox"], [role="menuitem"], shreddit-switch';
  const cards = 'shreddit-post, shreddit-search-result, article, .thing, [data-testid="post-container"], [role="article"], .Post';
  const markers = '[nsfw]:not([nsfw="false"]), [over-18]:not([over-18="false"]), [is-nsfw]:not([is-nsfw="false"]), [data-nsfw="true"], [data-over18="true"], [data-over-18="true"], .over18, .nsfw-stamp, shreddit-age-gate, x-stage, [data-testid="content-gate"]';
  const observed = new WeakSet();
  const roots = new Set();
  let queued = false;
  const descriptor = element => text([
    element.textContent, element.getAttribute('aria-label'), element.getAttribute('title'),
    element.getAttribute('name'), element.getAttribute('id'), element.getAttribute('value'),
    ...(element.labels ? Array.from(element.labels, label => label.textContent) : []),
    ...(element.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => element.getRootNode().getElementById?.(id)?.textContent)
  ].filter(Boolean).join(' '));
  const controlBlocked = element => {
    const label = descriptor(element);
    if (ageConfirmation(label) || unreviewedLabel(element.textContent) || unreviewedLabel(element.getAttribute('aria-label'))) return true;
    // Freeze both directions of these settings. Merely changing checked/ARIA
    // would leave Reddit's account preference and component state unchanged.
    if (/safe[\s_-]*search|blur.{0,25}(?:nsfw|mature|adult)|(?:show|include|allow|view|enable|display).{0,40}(?:nsfw|mature|adult)|(?:over_18|search_include_over_18)/i.test(label)) return true;
    if (/^(?:yes|continue|view|show|enter|confirm)$/i.test(label)) {
      const context = element.closest('[role="dialog"], dialog, form, shreddit-age-gate, [data-testid="content-gate"]') || element.getRootNode().host;
      return Boolean(context && /18\+|over 18|adult|mature|nsfw/i.test(descriptor(context)));
    }
    return false;
  };
  const conceal = element => {
    element.setAttribute('data-vigil-reddit-blocked', '');
    if (element.style.getPropertyValue('display') !== 'none' || element.style.getPropertyPriority('display') !== 'important') element.style.setProperty('display', 'none', 'important');
    element.querySelectorAll('video, audio').forEach(media => { try { media.pause(); } catch {} });
  };
  const container = element => {
    for (let node = element; node; node = node.getRootNode().host) {
      const card = node.closest(cards);
      if (card) return card;
    }
    return element;
  };
  const authors = '[author], [data-author], [author-name], [data-testid="post_author_link"], [slot="authorName"], .author';
  const unsafeAuthor = element => [element.getAttribute('author'), element.getAttribute('data-author'), element.getAttribute('author-name'),
    ...(element.matches('[data-testid="post_author_link"], [slot="authorName"], .author') ? [element.textContent] : [])].some(explicit);
  const hideAuthors = root => {
    if (root instanceof HTMLElement && root.matches(authors) && unsafeAuthor(root)) conceal(container(root));
    for (const author of root.querySelectorAll(authors)) if (unsafeAuthor(author)) conceal(container(author));
    for (const anchor of root.querySelectorAll('a[href]')) {
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (redditHost(url.hostname) && /^\/(?:u|user)\//i.test(decode(url.pathname))
        && (explicit(decode(url.pathname)) || explicit(anchor.textContent))) conceal(container(anchor));
    }
  };
  const categoryLabels = 'h1, h2, h3, h4, [role="heading"], span, p, div, summary, [aria-label]';
  const isUnreviewedLabel = element => unreviewedLabel(element.textContent) || unreviewedLabel(element.getAttribute('aria-label'));
  const unreviewedContainer = label => {
    const card = container(label);
    if (card !== label) return card;
    // Only ascend into a local media group. Never hide the page/feed or a
    // wrapper containing other categories alongside the unreviewed results.
    let node = label;
    for (let depth = 0; node && depth < 5; depth++, node = node.parentElement || node.getRootNode().host) {
      if (node.matches('body, html, main, [role="main"]')) break;
      const headings = [...node.querySelectorAll('h1, h2, h3, h4, [role="heading"]')];
      if (headings.some(heading => !heading.closest(cards) && !isUnreviewedLabel(heading))) break;
      if (node.matches('section, [role="region"], [role="dialog"]')
        || node.querySelector(`${cards}, video, shreddit-player, img`)) return node;
    }
    return label;
  };
  const hideUnreviewed = root => {
    for (const label of root.querySelectorAll(categoryLabels)) {
      if (isUnreviewedLabel(label)) conceal(unreviewedContainer(label));
    }
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; scan(); });
  };
  const observe = root => {
    roots.add(root);
    if (observed.has(root)) return;
    observed.add(root);
    new MutationObserver(schedule).observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['nsfw', 'over-18', 'is-nsfw', 'data-nsfw', 'data-over18', 'data-over-18', 'aria-label', 'aria-labelledby', 'aria-checked', 'checked', 'href', 'class', 'post-title', 'subreddit-prefixed-name', 'author', 'data-author', 'author-name', 'data-testid', 'slot', 'title', 'style'] });
    const style = document.createElement('style');
    style.textContent = '[data-vigil-reddit-blocked], shreddit-post[nsfw]:not([nsfw="false"]), .thing.over18, shreddit-age-gate, [data-testid="content-gate"] { display:none !important; visibility:hidden !important; }';
    (root === document ? document.documentElement : root).append(style);
  };
  const scan = () => {
    if (!document.documentElement || enforceURL()) return;
    observe(document);
    for (const root of roots) {
      if (root !== document && !root.host.isConnected) { roots.delete(root); continue; }
      // Open shadow roots are independent trees and require their own observer
      // and stylesheet. Periodic discovery also catches late attachShadow calls.
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) observe(element.shadowRoot);
      hideUnreviewed(root);
      hideAuthors(root);
      for (const element of root.querySelectorAll(markers)) {
        // x-stage is also used for ordinary dialogs; only age gates are blocked.
        if (element.localName !== 'x-stage' || /18\+|over 18|adult|mature|nsfw/i.test(descriptor(element))) conceal(container(element));
      }
      for (const element of root.querySelectorAll(cards)) {
        const title = [element.getAttribute('post-title'), element.getAttribute('subreddit-prefixed-name'), element.querySelector('h1, h2, h3, [slot="title"], .title')?.textContent].filter(Boolean).join(' ');
        if (explicit(title) || unsafeMedia(title)) conceal(element);
      }
      for (const element of root.querySelectorAll(controls)) {
        if (controlBlocked(element)) conceal(element);
      }
      for (const anchor of root.querySelectorAll('a[href]')) {
        const destination = safeURL(anchor.href);
        if (destination === 'https://www.reddit.com/' && new URL(anchor.href, location.href).pathname !== '/') conceal(container(anchor));
        else if (destination) anchor.href = destination;
      }
    }
  };
  // Inspect every composed-path control: the innermost span alone can miss
  // the actual button when it is inside Reddit's web components.
  const guard = event => {
    if (event.type === 'keydown' && !['Enter', ' '].includes(event.key)) return;
    // Catch newly inserted reveal controls before MutationObserver runs.
    for (const element of event.composedPath()) {
      if (element instanceof HTMLElement && element.matches(`${cards}, section, [role="region"], [role="dialog"]`)) {
        hideUnreviewed(element);
        hideAuthors(element);
      }
    }
    for (const element of event.composedPath()) {
      if (!(element instanceof HTMLElement)) continue;
      const anchor = element.closest('a[href]');
      const destination = anchor && safeURL(anchor.href);
      const blocked = element.hasAttribute('data-vigil-reddit-blocked') || (element.matches(controls) && controlBlocked(element));
      if (!blocked && !destination) continue;
      if (event.cancelable) event.preventDefault();
      event.stopImmediatePropagation();
      if (destination && !blocked && event.type === 'click') location.assign(destination);
      else if (blocked) conceal(element);
      return;
    }
    if (event.type === 'submit' && event.target instanceof HTMLFormElement) {
      const form = event.target;
      const url = new URL(form.action || location.href, location.href);
      if (redditHost(url.hostname) && /(?:^|\/)search\/?$/i.test(url.pathname)) {
        for (const [name, value] of new FormData(form)) if (typeof value === 'string') url.searchParams.set(name, value);
        const destination = safeURL(url.href);
        if (destination) { event.preventDefault(); event.stopImmediatePropagation(); location.assign(destination); }
      }
    }
  };
  for (const name of ['pointerdown', 'mousedown', 'touchstart', 'click', 'keydown', 'change', 'input', 'submit']) window.addEventListener(name, guard, { capture: true, passive: false });
  addEventListener('popstate', scan, true);
  addEventListener('pageshow', scan, true);
  if (document.documentElement) scan();
  else document.addEventListener('DOMContentLoaded', scan, { once: true });
  setInterval(scan, 1000);
})();
