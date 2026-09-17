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
  let state = null, panel, message, statusLine, notice;
  let lease = null, playing = null, played = 0, lastTick = 0, lastPosition = 0;
  let renewal = null;
  let resumeMedia = null, startControl = null, retryInterruptedPlay = false, queuedStart = false;
  let previousRate = 1;
  let intent = '', busy = false, waiting = false, deadline = 0, route = location.href;
  let menuVideo = null, replayingSave = false;
  let spacePress = null, idleSince = null, playbackClock = null;
  const idFrom = value => {
    try {
      const url = new URL(value, location.href);
      if (!/^(www\.|m\.)?youtube\.com$/.test(url.hostname) || /^\/shorts\//.test(url.pathname)) return '';
      const id = url.searchParams.get('v') || (/^\/embed\//.test(url.pathname) ? url.pathname.split('/')[2] : '');
      return /^[\w-]{11}$/.test(id || '') ? id : '';
    } catch { return ''; }
  };
  const currentID = () => idFrom(location.href);
  const extensionRequest = (runtime, body) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Vigil could not check your allowance. Reload this page to retry.')), 6500);
    Promise.resolve().then(() => runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body }))
      .then(resolve, reject).finally(() => clearTimeout(timer));
  });
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
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) return extensionRequest(browser.runtime, body);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) return extensionRequest(chrome.runtime, body);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Vigil could not check the allowance. Try again.')); }, 6500);
      pending.set(id, value => { clearTimeout(timer); resolve(value); });
      window.postMessage({ type: 'VIGIL_YOUTUBE_REQUEST', id, body }, location.origin);
    });
  };
  window.addEventListener('message', event => { if (event.source === window && event.origin === location.origin && event.data?.type === 'VIGIL_YOUTUBE_REPLY') { pending.get(event.data.id)?.(event.data.value); pending.delete(event.data.id); } });
  window.__vigilYouTubeReply = (id, value) => { pending.get(id)?.(value); pending.delete(id); };
  const show = value => {
    if (message) message.textContent = value === 'Save this video to Watch Later before playing.' ? 'Save this video to Watch Later first.' : value || '';
    if (notice) notice.hidden = !value;
  };
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
    const text = state.grace.status === 'active'
      ? `Finish this video · ${Math.ceil((1200000 - state.grace.usedMs) / 60000)} min left`
      : `${4 - state.slots.filter(Boolean).length} saves left · ${Math.ceil(remaining / 60000)} min left`;
    if (statusLine.textContent !== text) statusLine.textContent = text;
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
    const wasPaused = !playing || playing.paused;
    ended = ended || Boolean(playing?.ended);
    if (playing) playing.pause();
    if (renewal) await renewal.catch(() => {});
    const old = lease; lease = null;
    const elapsed = played; played = 0;
    if (playing) playing.pause();
    playing = null; retryInterruptedPlay = false;
    if (old) {
      try { await request({ action: 'settle', leaseId: old.id, playedMs: elapsed, ended }); }
      catch (error) {
        // A backgrounded tab may wake after its short authorization expires.
        // The paused video itself remains usable; the next Play gets a new lease.
        if (!wasPaused || error.message !== 'Playback authorization expired.') throw error;
      }
    }
    idleSince = null;
  }
  async function begin() {
    if (busy || lease || !intent || !topFrame) return;
    const id = currentID();
    if (intent !== id || !id || /^\/shorts\//.test(location.pathname)) return;
    let media = document.querySelector('video');
    if (!media) return;
    busy = true;
    const control = startControl; startControl = null;
    updateHeldPlayer();
    try {
      let sent = performance.now(), response;
      try { response = await request({ action: 'start', videoId: id }); }
      catch (error) {
        if (error.message !== 'Save this video to Watch Later before playing.') throw error;
        show('Checking Watch Later…');
        const saved = await watchLaterMembership(id);
        if (!saved) throw error;
        await request({ action: 'save', ...saved });
        sent = performance.now(); response = await request({ action: 'start', videoId: id });
      }
      lease = response.lease;
      deadline = sent + (lease.expiresAt - response.serverTime) - 100;
      if (currentID() !== id || performance.now() >= deadline || intent !== id) { await stop(); return; }
      // Authorization may outlive a YouTube player replacement during startup.
      media = document.querySelector('video');
      if (!media) { await stop(); return; }
      playing = media; resumeMedia = media; played = 0; lastTick = performance.now(); lastPosition = media.currentTime; previousRate = media.playbackRate || 1; waiting = media.readyState < 3;
      // play() may remain pending throughout buffering. Do not hold the
      // authorization lock while WebKit waits for media data: renewals must
      // continue before the current bounded lease expires.
      updateHeldPlayer();
      // Let YouTube initialize its source and update its own paused/buffering UI.
      // Calling video.play() alone skips the handler we intercepted above.
      if (media.paused && control?.isConnected && control !== media) control.click();
      const authorization = lease;
      void media.play().then(() => {
        if (playing === media && lease?.id === authorization.id) {
          // The phone's content guard resolves play() while it classifies the
          // source, then resumes it once safe. This is pending startup, not a
          // user pause: retain bounded authorization without charging time.
          if (media.paused && media.dataset?.vigilPlaybackRequested === 'true') waiting = true;
          show('');
        }
      }, error => {
        // A late rejection from a replaced player must not stop a newer lease.
        if (playing !== media || lease?.id !== authorization.id) return;
        // A source reload aborts a pending play promise. Wait for that source
        // instead of revoking the user's request and requiring a page refresh.
        if (error.name === 'AbortError' && waiting && intent === currentID()) {
          retryInterruptedPlay = true;
          return;
        }
        intent = '';
        void stop().catch(() => {}).finally(() => show(error.message));
      });
    } catch (error) { intent = ''; await stop().catch(() => {}); show(error.message); }
    finally { releaseBusy(); }
  }
  function positionAllowance() {
    if (!panel) return;
    const desktopHeader = document.querySelector('ytd-masthead #start');
    panel.toggleAttribute('data-desktop', Boolean(desktopHeader));
    if (desktopHeader && panel.parentNode !== desktopHeader) desktopHeader.append(panel);
    panel.hidden = Boolean(document.fullscreenElement || document.webkitFullscreenElement
      || document.querySelector('video')?.webkitDisplayingFullscreen
      || document.querySelector('.html5-video-player.ytp-fullscreen'));
  }
  for (const event of ['fullscreenchange', 'webkitfullscreenchange', 'webkitbeginfullscreen', 'webkitendfullscreen']) {
    document.addEventListener(event, positionAllowance, true);
  }
  function mount() {
    if (!document.body || !topFrame) return;
    if (panel) {
      if (!panel.isConnected) document.body.append(panel);
      if (notice && !notice.isConnected) document.body.append(notice);
      positionAllowance();
      return;
    }
    panel = document.createElement('aside'); panel.id = 'vigil-youtube-limits';
    const shadow = panel.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{display:block;position:relative;z-index:0;font:12px Roboto,Arial,sans-serif;color:var(--yt-spec-text-secondary,#888);padding:5px 12px;box-sizing:border-box;background:transparent}:host([data-desktop]){display:inline-flex;position:relative;flex:0 0 auto;max-width:min(220px,30vw);padding:4px 12px;color:var(--yt-spec-text-secondary,#aaa);line-height:1.4;white-space:normal;overflow-wrap:anywhere}:host([hidden]){display:none!important}strong{font-weight:400}`;
    statusLine = document.createElement('strong'); statusLine.textContent = 'Checking allowance…';
    shadow.append(style, statusLine);
    const header = document.querySelector('ytm-mobile-topbar-renderer,ytd-masthead');
    if (header?.parentNode) header.after(panel); else document.body.append(panel);
    positionAllowance();
    notice = document.createElement('aside'); notice.id = 'vigil-youtube-notice'; notice.hidden = true;
    const noticeShadow = notice.attachShadow({mode:'closed'});
    const noticeStyle = document.createElement('style');
    noticeStyle.textContent = `:host{position:fixed;left:max(16px,env(safe-area-inset-left));top:calc(env(safe-area-inset-top) + 64px);z-index:2147483647;max-width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:var(--yt-spec-raised-background,#212121);color:var(--yt-spec-text-primary,#f1f1f1);border:1px solid var(--yt-spec-10-percent-layer,#ffffff1a);border-radius:12px;box-shadow:0 4px 16px #0003;padding:14px 42px 14px 16px;font:14px/1.4 Roboto,Arial,sans-serif}:host([hidden]){display:none!important}@media(max-width:600px){:host{left:max(12px,env(safe-area-inset-left));top:calc(env(safe-area-inset-top) + 56px)}}button{position:absolute;right:6px;top:6px;width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:inherit;font:24px/1 Arial;cursor:pointer}button:hover,button:focus-visible{background:#ffffff20}`;
    message = document.createElement('div'); message.setAttribute('role','status');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label','Dismiss notification');
    dismiss.addEventListener('click', () => { notice.hidden = true; });
    noticeShadow.append(noticeStyle, message, dismiss); document.body.append(notice);
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
      if (!container || (feedName() && container.closest('ytd-watch-flexy,ytm-watch'))) continue;
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
  // Page-world optimizations must never prevent Safari's isolated controls
  // from starting. Its isolated APIs do not intercept YouTube's own requests.
  const isolatedExtension = (typeof browser !== 'undefined' && Boolean(browser.runtime?.sendMessage))
    || (typeof chrome !== 'undefined' && Boolean(chrome.runtime?.sendMessage));
  const websiteFeed = !window.webkit?.messageHandlers?.vigilYouTube;
  const websiteCards = new Map();
  if (topFrame && !websiteFeed) {
    try {
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
    } catch { /* The DOM limiter remains authoritative. */ }
  }
  if (topFrame && accountFetch && !websiteFeed) {
    try {
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
    } catch { /* Optional request interception must not disable enforcement. */ }
  }
  let lastFilteredFeed = '';
  async function filterNativeFeed() {
    const name = feedName();
    if (!name) {
      if (!lastFilteredFeed) return;
      lastFilteredFeed = '';
      feedEnd?.remove(); feedEnd = null;
      document.querySelectorAll('[data-vigil-feed-hidden]').forEach(node => node.removeAttribute('data-vigil-feed-hidden'));
      document.documentElement.removeAttribute('data-vigil-feed-complete');
      return;
    }
    lastFilteredFeed = name;
    document.documentElement.toggleAttribute('data-vigil-feed-pending', !state);
    if (!state || feedSync) return;
    const models = websiteFeed ? [] : nativeCache.get(name)?.items.map(entry => entry.card) || [];
    const cards = [...models];
    for (const card of domCards()) if (!cards.some(old => old.videoId === card.videoId)) cards.push(card);
    const signature = `${state.day}:${name}:${cards.map(card => card.videoId).join(',')}`;
    if (!websiteFeed && cards.length && signature !== feedSignature) {
      feedSync = true;
      try { await request({ action: 'feed', mode: 'native', feed: name, cards }); feedSignature = signature; }
      catch (error) { show(error.message); }
      finally { feedSync = false; }
    }
    if (websiteFeed) {
      const key = `${state.day}:${name}`;
      const selected = websiteCards.get(key) || [];
      for (const card of cards) if (selected.length < 20 && !selected.includes(card.videoId)) selected.push(card.videoId);
      websiteCards.set(key, selected);
    }
    const allowed = new Set(websiteFeed ? websiteCards.get(`${state.day}:${name}`) || [] : (state.feeds[name] || []).map(card => card.videoId));
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
      if (last.nextElementSibling !== feedEnd) last.after(feedEnd);
    }
  }
  function updateHeldPlayer() {
    // YouTube treats the interrupted autoplay attempt as buffering. Keep its
    // own Play controls available while the allowance gate holds playback.
    document.documentElement?.toggleAttribute('data-vigil-playback-held', Boolean(topFrame && currentID() && !lease && !busy));
  }
  // Hide complete shelves so headings, menus, counts, and dividers disappear too.
  const unwantedShelfSelector = [
    'ytd-reel-shelf-renderer', 'ytm-reel-shelf-renderer',
    ':is(ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer,ytm-pivot-bar-item-renderer):has(a[href^="/shorts"])',
    'ytd-rich-shelf-renderer[is-shorts]',
    'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
    ':is(ytd-rich-section-renderer,ytd-rich-shelf-renderer,ytd-shelf-renderer,ytm-rich-section-renderer):has(a[href*="/shorts/"])',
    'yt-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model',
    'ytd-rich-section-renderer:has(ytd-feed-nudge-renderer)',
    'ytd-feed-nudge-renderer'
  ].join(',');
  function cleanShelfHeadings() {
    for (const heading of document.querySelectorAll(':is(ytd-rich-shelf-renderer,ytd-shelf-renderer,ytd-rich-section-renderer,ytd-feed-nudge-renderer) :is(#title,h2,[role=heading])')) {
      if (!/^(shorts|explore more topics|(?:(?:new|trending|popular|top) )?music videos(?: this week)?)$/i.test((heading.textContent || '').trim())) continue;
      const shelf = heading.closest('ytd-rich-section-renderer')
        || heading.closest('ytd-rich-shelf-renderer,ytd-shelf-renderer,ytd-feed-nudge-renderer');
      if (shelf && !shelf.hasAttribute('data-vigil-shelf-hidden')) shelf.setAttribute('data-vigil-shelf-hidden', '');
    }
  }
  function clean() {
    updateHeldPlayer();
    document.documentElement.toggleAttribute('data-vigil-feed-pending', Boolean(feedName() && !state));
    mount();
    cleanShelfHeadings();
    void filterNativeFeed();
    if (!document.getElementById('vigil-limits-style')) {
      const style = document.createElement('style'); style.id = 'vigil-limits-style';
      style.textContent = `html[data-vigil-feed-pending] :is(${nativeCardSelector}){display:none!important}` + 'a[href*="/shorts/"],ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-video-preview,ytm-video-preview,.ytp-autonav-toggle-button,.ytp-autonav-endscreen-countdown-container,[data-vigil-feed-hidden],html[data-vigil-feed-complete] ytd-continuation-item-renderer,html[data-vigil-feed-complete] ytm-continuation-item-renderer{display:none!important}';
      style.textContent += `${unwantedShelfSelector},[data-vigil-shelf-hidden]{display:none!important}`;
      style.textContent += 'html[data-vigil-playback-held] .ytp-spinner{display:none!important}html[data-vigil-playback-held] .ytp-large-play-button,html[data-vigil-playback-held] .ytp-cued-thumbnail-overlay{display:block!important}html[data-vigil-playback-held] .ytp-chrome-bottom{display:block!important;opacity:1!important}';
      document.documentElement.append(style);
    }
    for (const media of document.querySelectorAll('video,audio')) {
      if (media.autoplay) media.autoplay = false;
      if (media.hasAttribute?.('autoplay')) media.removeAttribute('autoplay');
      if (!media.paused && (media !== playing || !lease || /^\/shorts\//.test(location.pathname))) media.pause();
    }

  }
  document.addEventListener('play', event => {
    if (event.target !== playing || !lease || currentID() !== lease.videoId || performance.now() >= deadline) {
      event.target.pause?.();
      // Native iOS fullscreen controls produce media events, not DOM clicks.
      // Only resume the same explicitly started video, and reacquire the normal
      // ledger authorization before allowing a single frame of playback.
      if (event.isTrusted && event.target === resumeMedia && event.target.webkitDisplayingFullscreen
          && intent && intent === currentID()) togglePlayback();
    }
    updateHeldPlayer();
  }, true);
  document.addEventListener('canplay', event => {
    if (!retryInterruptedPlay || event.target !== playing || !lease || intent !== currentID()
        || currentID() !== lease.videoId || performance.now() >= deadline) return;
    retryInterruptedPlay = false;
    void playing.play().catch(error => show(error.message));
  }, true);
  document.addEventListener('ratechange', event => { if (event.target === playing) sample(); }, true);
  document.addEventListener('loadstart', event => {
    if (event.target !== playing) return;
    // YouTube reloads this element when changing quality. Keep the existing
    // bounded authorization for the same video while the new source buffers.
    if (currentID() !== lease?.videoId) { intent = ''; void stop().catch(error => show(error.message)); return; }
    sample(); waiting = true;
  }, true);
  for (const event of ['waiting', 'seeking']) document.addEventListener(event, e => { if (e.target === playing) { sample(); waiting = true; } }, true);
  for (const event of ['playing', 'seeked']) document.addEventListener(event, e => { if (e.target === playing) { waiting = false; lastTick = performance.now(); lastPosition = playing.currentTime; } }, true);
  document.addEventListener('ended', event => { if (event.target === playing) { intent = ''; void stop(true).catch(error => show(error.message)); } }, true);
  // Keep transient player pauses local; settle an idle lease before its expiry.
  // Native controls can pause/resume within the existing bounded lease.
  document.addEventListener('click', event => {
    if (replayingSave || !event.isTrusted || !(event.target instanceof Element)) return;
    // A deliberate search result uses watch time without allocating Watch Later.
    // Persist the grant before same-tab navigation can tear down this bridge.
    const searchLink = location.pathname === '/results' && location.search.includes('search_query=')
      ? event.target.closest('a[href]') : null;
    const searchID = searchLink && idFrom(searchLink.href);
    if (searchID) {
      const destination = searchLink.href;
      const sameTab = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
        && (!searchLink.target || searchLink.target === '_self');
      if (sameTab) { event.preventDefault(); event.stopImmediatePropagation(); }
      void request({ action: 'search', videoId: searchID }).then(() => {
        if (sameTab) location.assign(destination);
      }).catch(error => show(error.message));
      return;
    }
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
    const playControl = event.target.closest('.ytp-play-button,.ytp-large-play-button,.ytp-cued-thumbnail-overlay,video,button[aria-label="Play"],button[aria-label="Play video"]');
    if (playControl && currentID() && (!lease || performance.now() >= deadline)) {
      event.preventDefault(); event.stopImmediatePropagation();
      startControl = playControl;
      togglePlayback();
    }
  }, true);
  function releaseBusy() {
    busy = false;
    updateHeldPlayer(); syncPlaybackClock();
    if (queuedStart) {
      queuedStart = false;
      if (intent === currentID()) void begin();
    }
  }
  const togglePlayback = () => {
    if (busy) { queuedStart = true; return; }
    if (lease && playing && performance.now() < deadline) {
      if (playing.paused) void playing.play().catch(error => show(error.message)); else playing.pause();
    } else {
      intent = currentID();
      if (lease && !busy) {
        busy = true;
        void stop().then(() => { releaseBusy(); void begin(); }).catch(error => { intent = ''; releaseBusy(); show(error.message); });
      } else void begin();
    }
  };
  const releaseSpace = (toggle = false) => {
    const press = spacePress; spacePress = null;
    if (!press) return;
    if (press.holding) { sample(); press.media.playbackRate = press.rate; previousRate = press.rate; }
    else if (toggle) togglePlayback();
    syncPlaybackClock();
  };
  document.addEventListener('keydown', event => {
    if (!event.isTrusted || ![' ', 'k'].includes(event.key) || /INPUT|TEXTAREA|SELECT/.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
    if (!currentID()) return;
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.repeat) return;
    if (event.key === ' ') {
      if (!spacePress) spacePress = {started: performance.now(), media: playing, rate: playing?.playbackRate || 1, holding:false};
      syncPlaybackClock();
    } else togglePlayback();
  }, true);
  document.addEventListener('keyup', event => {
    if (!event.isTrusted || event.key !== ' ' || !spacePress) return;
    event.preventDefault(); event.stopImmediatePropagation(); releaseSpace(true);
  }, true);
  window.addEventListener('blur', () => releaseSpace());
  window.addEventListener('pagehide', () => { releaseSpace(); intent = ''; void stop().catch(() => {}); });
  const playbackTick = () => {
    if (spacePress && !spacePress.holding && performance.now() - spacePress.started >= 350 && lease && playing === spacePress.media && !playing.paused && performance.now() < deadline) {
      sample(); spacePress.holding = true; playing.playbackRate = 2; previousRate = 2;
    }
    if (location.href !== route) {
      releaseSpace();
      const previousID = idFrom(route);
      route = location.href;
      // YouTube rewrites list/index/time parameters while opening Watch Later.
      // Those same-video updates must not cancel a pending or active Play.
      if (!previousID || previousID !== currentID()) {
        intent = ''; resumeMedia = null; startControl = null; queuedStart = false;
        void stop().then(() => request({ action: 'switch', videoId: currentID() })).catch(error => show(error.message));
      }
    }
    sample();
    if (lease && playing?.paused && !waiting) {
      idleSince ??= performance.now();
      if (!busy && (performance.now() - idleSince >= 1000 || performance.now() >= deadline - 1000)) {
        busy = true;
        void stop().catch(error => show(error.message)).finally(releaseBusy);
      }
    } else idleSince = null;
    const remainingBudget = state?.grace.status === 'active' ? 1200000 - state.grace.usedMs : 7200000 - (state?.usedMs || 0);
    // Safari's native bridge and durable ledger write can take more than 500 ms.
    // Renew halfway through the two-second reservation, without extending it locally.
    if (lease && remainingBudget > lease.milliseconds - lease.settledMs && !renewal && !busy && playing && (!playing.paused || waiting) && (played >= lease.milliseconds - 1000 || performance.now() >= deadline - 1000) && performance.now() < deadline) {
      const original = lease;
      const sent = performance.now();
      renewal = request({ action: 'renew', leaseId: original.id, playedMs: played }).then(response => {
        if (lease?.id === original.id && response.lease) {
          lease = response.lease;
          deadline = sent + (lease.expiresAt - response.serverTime) - 100;
        }
      }).catch(error => { intent = ''; show(error.message); }).finally(() => { renewal = null; });
    }
    if (!busy && lease && (played >= lease.milliseconds || performance.now() >= deadline)) {
      const resume = intent && playing && !playing.paused && performance.now() < deadline;
      busy = true;
      void stop().then(() => { releaseBusy(); if (resume) void begin(); }).catch(error => { intent = ''; releaseBusy(); show(error.message); });
    }
    syncPlaybackClock();
  };
  // Media progress remains the clock when Safari throttles background tab timers.
  // Keep the interval as a fallback for stalls and expiring authorizations.
  document.addEventListener('timeupdate', event => {
    if (lease && event.target === playing) playbackTick();
  }, true);
  function syncPlaybackClock() {
    if (lease || spacePress) {
      if (playbackClock === null) playbackClock = setInterval(playbackTick, 50);
    } else if (playbackClock !== null) {
      clearInterval(playbackClock); playbackClock = null;
    }
  }
  if (topFrame && isolatedExtension) {
    const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    runtime.onMessage?.addListener(message => {
      if (message?.type !== 'VIGIL_YOUTUBE_HEALTH') return undefined;
      return Promise.resolve({ loaded: true, allowanceLoaded: Boolean(state) });
    });
  }
  setInterval(() => {
    if (playbackClock === null) playbackTick();
    clean();
  }, 500);
  setInterval(() => { if (!lease && !busy) void request({ action: 'status' }).catch(error => show(error.message)); }, 30000);
  if (document.documentElement) clean();
  else document.addEventListener('DOMContentLoaded', clean, { once: true });
})();
