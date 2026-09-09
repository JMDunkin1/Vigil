(() => {
  'use strict';
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
  if (/^\/accounts\//i.test(location.pathname)) return;
  if (window.__vigilYouTubeLimits) return;
  window.__vigilYouTubeLimits = true;
  const topFrame = window.top === window;
  const accountFetch = typeof fetch === 'function' ? fetch.bind(window) : null;
  const pending = new Map();
  const client = crypto.randomUUID();
  let state = null, panel, message, statusLine;
  let lease = null, playing = null, played = 0, lastTick = 0, lastPosition = 0;
  let renewal = null;
  let previousRate = 1;
  let intent = '', busy = false, waiting = false, deadline = 0, route = location.href;
  let menuVideo = null, replayingSave = false;
  const idFrom = value => {
    try {
      const url = new URL(value, location.href);
      if (!/^(www\.|m\.)?youtube\.com$/.test(url.hostname) || /^\/shorts\//.test(url.pathname)) return '';
      const id = url.searchParams.get('v') || (/^\/embed\//.test(url.pathname) ? url.pathname.split('/')[2] : '');
      return /^[\w-]{11}$/.test(id || '') ? id : '';
    } catch { return ''; }
  };
  const currentID = () => idFrom(location.href);
  const transport = async body => {
    body = { ...body, client };
    if (window.webkit?.messageHandlers?.vigilYouTube) {
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('The allowance check did not finish. Reopen Vigil YouTube to retry.')); }, 6500);
        pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
        const reply = window.webkit.messageHandlers.vigilYouTube.postMessage({ requestId, body });
        if (reply?.then) reply.then(value => { clearTimeout(timer); pending.delete(requestId); resolve(value); }, error => { clearTimeout(timer); pending.delete(requestId); reject(error); });
      });
    }
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) return browser.runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body });
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) return chrome.runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body });
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Vigil could not check the allowance. Try again.')); }, 6500);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      window.postMessage({ type: 'VIGIL_YOUTUBE_REQUEST', id, body }, location.origin);
    });
  };
  window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.type === 'VIGIL_YOUTUBE_REPLY') { pending.get(event.data.id)?.(event.data.value); pending.delete(event.data.id); } });
  window.__vigilYouTubeReply = (id, value) => { pending.get(id)?.(value); pending.delete(id); };
  const show = value => { if (message) message.textContent = value || ''; };
  const request = async body => {
    const response = await transport(body);
    if (response?.day) {
      if (state && response.day !== state.day) { intent = ''; }
      state = response; render();
    }
    if (!response?.ok) throw new Error(response?.message || 'Your allowance could not be checked. Reopen YouTube to retry.');
    return response;
  };
  function render() {
    if (!statusLine || !state) return;
    const remaining = Math.max(0, 7200000 - state.usedMs);
    statusLine.textContent = `${4 - state.slots.filter(Boolean).length} saves left · ${Math.ceil(remaining / 60000)} min left`;
    if (state.grace.status === 'active') statusLine.textContent = `Finish this video · ${Math.ceil((1200000 - state.grace.usedMs) / 60000)} min left`;
  }
  const sample = () => {
    if (!lease || !playing) return;
    const now = performance.now();
    const position = playing.currentTime;
    if (!playing.seeking && !waiting && position > lastPosition) {
      const elapsed = Math.min(Math.max(0, now - lastTick), (position - lastPosition) * 1000 / previousRate);
      played = Math.min(lease.milliseconds, played + elapsed);
    }
    lastTick = now; lastPosition = position; previousRate = playing.playbackRate || 1;
  };
  async function stop(ended = false) {
    sample();
    ended = ended || Boolean(playing?.ended);
    if (playing) playing.pause();
    if (renewal) await renewal.catch(() => {});
    const old = lease; lease = null;
    const elapsed = played; played = 0;
    if (playing) playing.pause();
    playing = null;
    if (old) await request({ action: 'settle', leaseId: old.id, playedMs: elapsed, ended });
  }
  async function begin() {
    if (busy || lease || !intent || !topFrame) return;
    const id = currentID();
    if (intent !== id || !id || /^\/shorts\//.test(location.pathname)) return;
    const media = document.querySelector('video');
    if (!media) return;
    busy = true;
    try {
      let sent = performance.now(), response;
      try { response = await request({ action: 'start', videoId: id }); }
      catch (error) {
        if (error.message !== 'Save this video to Watch Later before playing.') throw error;
        const saved = await watchLaterMembership(id);
        if (!saved) throw error;
        await request({ action: 'save', ...saved });
        sent = performance.now(); response = await request({ action: 'start', videoId: id });
      }
      lease = response.lease;
      deadline = sent + (lease.expiresAt - response.serverTime) - 100;
      if (currentID() !== id || performance.now() >= deadline || intent !== id) { await stop(); return; }
      playing = media; played = 0; lastTick = performance.now(); lastPosition = media.currentTime; previousRate = media.playbackRate || 1; waiting = media.readyState < 3;
      await media.play(); show('');
    } catch (error) { intent = ''; await stop().catch(() => {}); show(error.message); }
    finally { busy = false; }
  }
  function mount() {
    if (!document.body || panel || !topFrame) return;
    panel = document.createElement('aside'); panel.id = 'vigil-youtube-limits';
    const shadow = panel.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{display:block;position:relative;z-index:0;font:12px Roboto,Arial,sans-serif;color:var(--yt-spec-text-secondary,#888);padding:5px 12px;box-sizing:border-box;background:transparent}strong{font-weight:400}div:empty{display:none}div{padding:4px 0;line-height:18px}button{border:0;border-radius:18px;padding:6px 12px;background:rgba(127,127,127,.15);color:inherit;font:inherit}`;
    statusLine = document.createElement('strong'); statusLine.textContent = 'Checking allowance…';
    message = document.createElement('div'); message.setAttribute('role', 'status');
    shadow.append(style, statusLine, message);
    const header = document.querySelector('ytm-mobile-topbar-renderer,ytd-masthead');
    if (header?.parentNode) header.after(panel); else document.body.append(panel);
    void request({ action: 'status' }).catch(error => show(error.message));
  }
  // Feed metadata is read as data, never evaluated as page code.
  const textOf = value => typeof value === 'string' ? value : value?.simpleText || value?.content || value?.runs?.map(run => run.text || '').join('') || '';
  const validTitle = value => Boolean(value && !/^(?:\d+:)+\d+$/.test(value.trim()) && !/^save to watch later$/i.test(value.trim()));
  function videoCards(data) {
    const cards = [], continuations = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.reelShelfRenderer || value.shortsLockupViewModel || value.adSlotRenderer || value.promotedSparklesWebRenderer) return;
      if (value.continuationCommand?.token) continuations.push(value.continuationCommand.token);
      for (const key of ['videoRenderer', 'videoWithContextRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'playlistVideoRenderer', 'playlistPanelVideoRenderer', 'lockupViewModel']) {
        const video = value[key];
        if (!video) continue;
        const videoId = video.videoId || (video.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' ? video.contentId : '');
        const title = textOf(video.title || video.headline || video.metadata?.lockupMetadataViewModel?.title).trim();
        if (/^[\w-]{11}$/.test(videoId || '') && validTitle(title) && !video.navigationEndpoint?.reelWatchEndpoint && !cards.some(card => card.videoId === videoId)) {
          cards.push({ videoId, title, channel: textOf(video.ownerText || video.shortBylineText || video.longBylineText), duration: textOf(video.lengthText) });
        }
      }
      for (const child of Object.values(value)) if (typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(data);
    return { cards, continuations };
  }
  function jsonAfter(source, marker) {
    const match = marker.exec(source);
    if (!match) return null;
    let offset = match.index + match[0].length;
    while (/\s/.test(source[offset] || '') && offset < source.length) offset++;
    if (source.startsWith('JSON.parse(', offset)) offset += 11;
    while (/\s/.test(source[offset] || '') && offset < source.length) offset++;
    const quote = source[offset];
    if (quote === "'" || quote === '"') {
      let decoded = '';
      for (let i = offset + 1; i < source.length; i++) {
        const c = source[i];
        if (c === quote) { try { return JSON.parse(decoded); } catch { return null; } }
        if (c !== '\\') { decoded += c; continue; }
        const escape = source[++i];
        if (escape === 'x' || escape === 'u') {
          const length = escape === 'x' ? 2 : 4;
          const hex = source.slice(i + 1, i + 1 + length);
          if (!new RegExp(`^[0-9a-fA-F]{${length}}$`).test(hex)) return null;
          decoded += String.fromCharCode(parseInt(hex, 16)); i += length;
        } else decoded += ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[escape] ?? escape;
      }
      return null;
    }
    const start = source.indexOf('{', offset);
    if (start < 0) return null;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
      else if (c === '"') quoted = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
    }
    return null;
  }
  function domCards() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="watch?v="]')) {
      const videoId = idFrom(anchor.href);
      if (!videoId || cards.some(card => card.videoId === videoId)) continue;
      const container = anchor.closest('ytm-video-with-context-renderer,ytm-rich-item-renderer,ytd-rich-item-renderer,ytd-video-renderer,ytm-compact-video-renderer,ytd-grid-video-renderer');
      const titleNode = container?.querySelector('h3,h4,#video-title,.media-item-headline');
      const title = (titleNode?.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.textContent || '').trim();
      if (validTitle(title)) cards.push({ videoId, title });
    }
    return cards;
  }
  async function watchLaterMembership(videoId) {
    const response = await accountFetch('/playlist?list=WL', { credentials: 'include', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Could not check Watch Later. Please try again.');
    const html = await response.text();
    const initial = jsonAfter(html, /(?:var\s+)?ytInitialData\s*=\s*/);
    if (!initial) throw new Error('Could not check Watch Later. Please try again.');
    let page = videoCards(initial);
    const config = jsonAfter(html, /ytcfg\.set\(\s*/);
    for (let i = 0; i < 5; i++) {
      const card = page.cards.find(card => card.videoId === videoId);
      if (card) return card;
      const token = page.continuations[0];
      if (!token || !config?.INNERTUBE_CONTEXT) return null;
      const next = await accountFetch('/youtubei/v1/browse', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000), body: JSON.stringify({ context: config.INNERTUBE_CONTEXT, continuation: token }) });
      if (!next.ok) throw new Error('Could not check Watch Later. Please try again.');
      page = videoCards(await next.json());
    }
    throw new Error('Could not find this video in Watch Later. Open the playlist and try again.');
  }
  function rememberMenuVideo(target) {
    const card = target.closest('ytm-video-with-context-renderer,ytm-rich-item-renderer,ytd-rich-item-renderer,ytd-video-renderer,ytm-compact-video-renderer,ytd-grid-video-renderer,ytm-playlist-video-renderer,ytd-playlist-video-renderer');
    const anchor = card?.querySelector('a[href*="watch?v="]');
    const videoId = anchor ? idFrom(anchor.href) : currentID();
    const title = card?.querySelector('h3,h4,#video-title,.media-item-headline')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || document.title;
    if (videoId) menuVideo = { videoId, title };
  }
  async function standardWatchLaterChange(target, remove) {
    const video = menuVideo;
    if (!video) { show('Open the video’s menu again to change Watch Later.'); return; }
    const before = state?.slots.find(slot => slot?.videoId === video.videoId);
    try {
      // Reserve before allowing YouTube to save, so a fifth save cannot slip
      // through concurrent tabs. YouTube itself performs the account change.
      if (!remove) await request({ action: 'save', ...video });
      replayingSave = true;
      try { target.click(); } finally { replayingSave = false; }
      let saved = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 700));
        saved = await watchLaterMembership(video.videoId);
        if (Boolean(saved) !== remove) break;
      }
      if (remove && !saved) await request({ action: 'remove', videoId: video.videoId });
      else if (!remove && !saved && !before) {
        await request({ action: 'remove', videoId: video.videoId });
        throw new Error('YouTube did not save this video. Please try again.');
      }
      show('');
    } catch (error) { show(error.message); }
  }
  function feedName() { return ['/', '/feed/recommended'].includes(location.pathname) ? 'home' : location.pathname === '/feed/subscriptions' ? 'subscriptions' : ''; }
  const nativeCardSelector = 'ytm-rich-item-renderer,ytm-video-with-context-renderer,ytd-rich-item-renderer,ytd-video-renderer,ytm-compact-video-renderer,ytd-grid-video-renderer';
  let feedSync = false, feedSignature = '', feedEnd;
  const nativeCache = new Map();
  function nativeFeedData(data, append = false) {
    const name = feedName();
    if (!name || !data || typeof data !== 'object') return data;
    const day = state?.day || new Intl.DateTimeFormat('en-CA').format(new Date());
    const key = `vigil-native-feed:${name}`;
    let cached = nativeCache.get(name);
    if (!cached) { try { cached = JSON.parse(localStorage.getItem(key) || 'null'); } catch { /* No UI cache yet. */ } }
    if (!cached || cached.day !== day) cached = { day, items: [] };
    const lists = [];
    const scan = value => {
      if (!value || typeof value !== 'object') return;
      for (const kind of ['richGridRenderer', 'itemSectionRenderer', 'appendContinuationItemsAction', 'reloadContinuationItemsCommand']) {
        const items = value[kind]?.contents || value[kind]?.continuationItems;
        if (Array.isArray(items) && items.some(item => videoCards(item).cards.length)) lists.push(items);
      }
      for (const child of Object.values(value)) if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(scan); else scan(child);
      }
    };
    scan(data);
    if (!lists.length) return data;
    for (const list of lists) for (const item of list) {
      const card = videoCards(item).cards[0];
      if (card && cached.items.length < 20 && !cached.items.some(old => old.card.videoId === card.videoId)) cached.items.push({ card, item });
    }
    // Reuse YouTube's own renderer models. YouTube continues to render every
    // thumbnail, title, three-dot menu and Save action itself.
    let inserted = false;
    const rendered = append ? new Set(domCards().map(card => card.videoId)) : new Set();
    for (const list of lists) {
      const other = list.filter(item => !videoCards(item).cards.length && !(cached.items.length === 20 && item.continuationItemRenderer));
      list.splice(0, list.length, ...(inserted ? [] : cached.items.filter(entry => !rendered.has(entry.card.videoId)).map(entry => entry.item)), ...other);
      inserted = true;
    }
    nativeCache.set(name, cached);
    try { localStorage.setItem(key, JSON.stringify(cached)); } catch { /* The protected ledger remains authoritative. */ }
    return data;
  }
  if (topFrame) {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'ytInitialData');
    if (!descriptor || descriptor.configurable) {
      let initialValue = descriptor?.value;
      Object.defineProperty(window, 'ytInitialData', { configurable: true, enumerable: true,
        get: () => initialValue,
        set: value => {
          try { initialValue = typeof value === 'string' ? JSON.stringify(nativeFeedData(JSON.parse(value))) : nativeFeedData(value); }
          catch { initialValue = value; }
        }
      });
    }
  }
  if (topFrame && accountFetch) {
    const browseRequest = input => { try { return new URL(typeof input === 'string' ? input : input.url, location.href).pathname === '/youtubei/v1/browse'; } catch { return false; } };
    const transform = data => nativeFeedData(data, JSON.stringify(data).includes('appendContinuationItemsAction'));
    window.fetch = async (input, options) => {
      const response = await accountFetch(input, options);
      if (!feedName() || !browseRequest(input) || !response.ok) return response;
      try {
        const data = transform(await response.clone().json());
        const headers = new Headers(response.headers); headers.delete('content-length');
        return new Response(JSON.stringify(data), { status: response.status, statusText: response.statusText, headers });
      } catch { return response; }
    };
    if (typeof XMLHttpRequest !== 'undefined') {
      const open = XMLHttpRequest.prototype.open;
      const urls = new WeakMap();
      XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        urls.set(this, url);
        this.addEventListener('readystatechange', () => {
          if (this.readyState !== 4 || !feedName() || !browseRequest(urls.get(this))) return;
          try {
            if (this.responseType === 'json') { const data = transform(this.response); Object.defineProperty(this, 'response', { configurable: true, value: data }); }
            else if (!this.responseType || this.responseType === 'text') {
              const text = JSON.stringify(transform(JSON.parse(this.responseText)));
              Object.defineProperty(this, 'responseText', { configurable: true, value: text });
              Object.defineProperty(this, 'response', { configurable: true, value: text });
            }
          } catch { /* DOM filtering still applies if YouTube changes its response. */ }
        }, true);
        return open.call(this, method, url, ...rest);
      };
    }
  }
  async function filterNativeFeed() {
    const name = feedName();
    if (!name) {
      feedEnd?.remove(); feedEnd = null;
      document.querySelectorAll('[data-vigil-feed-hidden]').forEach(node => node.removeAttribute('data-vigil-feed-hidden'));
      document.documentElement.removeAttribute('data-vigil-feed-complete');
      return;
    }
    if (!state || feedSync) return;
    const models = nativeCache.get(name)?.items.map(entry => entry.card) || [];
    const cards = [...models];
    for (const card of domCards()) if (!cards.some(old => old.videoId === card.videoId)) cards.push(card);
    const signature = `${state.day}:${name}:${cards.map(card => card.videoId).join(',')}`;
    if (cards.length && signature !== feedSignature) {
      feedSync = true;
      try { await request({ action: 'feed', mode: 'native', feed: name, cards }); feedSignature = signature; }
      catch (error) { show(error.message); }
      finally { feedSync = false; }
    }
    const allowed = new Set((state.feeds[name] || []).map(card => card.videoId));
    let last;
    for (const card of document.querySelectorAll(nativeCardSelector)) {
      const anchor = card.querySelector('a[href*="watch?v="]');
      const id = anchor && idFrom(anchor.href);
      if (!id) continue;
      card.toggleAttribute('data-vigil-feed-hidden', !allowed.has(id));
      if (allowed.has(id)) last = card;
    }
    document.documentElement.toggleAttribute('data-vigil-feed-complete', allowed.size === 20);
    if (allowed.size === 20 && last) {
      if (!feedEnd) { feedEnd = document.createElement('p'); feedEnd.id = 'vigil-feed-end'; feedEnd.textContent = 'You’ve reached today’s feed.'; feedEnd.style.cssText = 'grid-column:1/-1;text-align:center;padding:24px 12px;font:14px Roboto,Arial,sans-serif;color:inherit'; }
      last.after(feedEnd);
    }
  }
  function clean() {
    mount();
    const content = document.querySelector('ytm-browse,ytd-browse,ytm-watch,ytd-watch-flexy');
    if (panel && content && panel.parentNode !== content) content.prepend(panel);
    void filterNativeFeed();
    if (!document.getElementById('vigil-limits-style')) {
      const style = document.createElement('style'); style.id = 'vigil-limits-style';
      style.textContent = 'a[href*="/shorts/"],ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-video-preview,ytm-video-preview,.ytp-autonav-toggle-button,.ytp-autonav-endscreen-countdown-container,[data-vigil-feed-hidden],html[data-vigil-feed-complete] ytd-continuation-item-renderer,html[data-vigil-feed-complete] ytm-continuation-item-renderer{display:none!important}';
      document.documentElement.append(style);
    }
    for (const media of document.querySelectorAll('video,audio')) {
      media.autoplay = false; media.removeAttribute('autoplay');
      if (media !== playing || !lease || /^\/shorts\//.test(location.pathname)) media.pause();
    }

  }
  document.addEventListener('play', event => {
    if (event.target !== playing || !lease || currentID() !== lease.videoId) event.target.pause?.();
  }, true);
  document.addEventListener('ratechange', event => { if (event.target === playing) sample(); }, true);
  document.addEventListener('loadstart', event => {
    if (event.target === playing) { intent = ''; void stop().catch(error => show(error.message)); }
  }, true);
  for (const event of ['waiting', 'seeking']) document.addEventListener(event, e => { if (e.target === playing) { sample(); waiting = true; } }, true);
  for (const event of ['playing', 'seeked']) document.addEventListener(event, e => { if (e.target === playing) { waiting = false; lastTick = performance.now(); lastPosition = playing.currentTime; } }, true);
  document.addEventListener('ended', event => { if (event.target === playing) { intent = ''; void stop(true).catch(error => show(error.message)); } }, true);
  // Native controls may resume only through a fresh, explicit playback action.
  document.addEventListener('click', event => {
    if (replayingSave || !event.isTrusted || !(event.target instanceof Element)) return;
    const target = event.target.closest('button,[role="menuitem"],[role="checkbox"],ytm-menu-service-item-renderer,ytd-menu-service-item-renderer,ytm-playlist-add-to-option-renderer,ytd-playlist-add-to-option-renderer') || event.target;
    const label = (target.getAttribute('aria-label') || target.textContent || '').trim().replace(/\s+/g, ' ');
    const option = target.closest('ytm-playlist-add-to-option-renderer,ytd-playlist-add-to-option-renderer');
    const watchLaterOption = option?.data?.playlistId === 'WL' || (option && /^watch later(?: private)?$/i.test(label));
    if (/^(save to watch later|remove from watch later)$/i.test(label) || watchLaterOption || (/^watch later$/i.test(label) && target.closest('[role=checkbox]'))) {
      const remove = /^remove/i.test(label) || target.getAttribute('aria-checked') === 'true' || target.querySelector('[aria-checked="true"]') !== null;
      event.preventDefault(); event.stopImmediatePropagation();
      void standardWatchLaterChange(target, remove);
      return;
    }
    rememberMenuVideo(event.target);
    if (event.target.closest('.ytp-play-button,video,button[aria-label="Play"],button[aria-label="Play video"]') && currentID() && !lease) { intent = currentID(); void begin(); }
  }, true);
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || ![' ', 'k'].includes(event.key) || /INPUT|TEXTAREA/.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
    if (!currentID()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (lease) { intent = ''; void stop().catch(error => show(error.message)); }
    else { intent = currentID(); void begin(); }
  }, true);
  window.addEventListener('pagehide', () => { intent = ''; void stop().catch(() => {}); });
  setInterval(() => {
    if (location.href !== route) {
      route = location.href; intent = '';
      void stop().then(() => request({ action: 'switch', videoId: currentID() })).catch(error => show(error.message));
    }
    sample();
    const remainingBudget = state?.grace.status === 'active' ? 1200000 - state.grace.usedMs : 7200000 - (state?.usedMs || 0);
    if (lease && remainingBudget > lease.milliseconds - lease.settledMs && !renewal && !busy && playing && !playing.paused && played >= lease.milliseconds - 500 && performance.now() < deadline) {
      const original = lease;
      const sent = performance.now();
      renewal = request({ action: 'renew', leaseId: original.id, playedMs: played }).then(response => {
        if (lease?.id === original.id && response.lease) {
          lease = response.lease;
          deadline = sent + (lease.expiresAt - response.serverTime) - 100;
        }
      }).catch(error => { intent = ''; show(error.message); }).finally(() => { renewal = null; });
    }
    if (!busy && lease && (played >= lease.milliseconds || performance.now() >= deadline || playing?.paused)) {
      const resume = intent && playing && !playing.paused && performance.now() < deadline;
      busy = true;
      void stop().then(() => { busy = false; if (resume) void begin(); }).catch(error => { busy = false; intent = ''; show(error.message); });
    }
  }, 50);
  setInterval(clean, 500);
  setInterval(() => { if (!lease && !busy) void request({ action: 'status' }).catch(error => show(error.message)); }, 30000);
  if (document.documentElement) clean();
  else document.addEventListener('DOMContentLoaded', clean, { once: true });
})();
