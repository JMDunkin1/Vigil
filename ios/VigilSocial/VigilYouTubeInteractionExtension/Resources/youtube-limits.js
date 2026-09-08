(() => {
  'use strict';
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
  if (/^\/accounts\//i.test(location.pathname)) return;
  if (window.__vigilYouTubeLimits) return;
  window.__vigilYouTubeLimits = true;
  const topFrame = window.top === window;
  const pending = new Map();
  const client = crypto.randomUUID();
  let state = null, panel, message, slots, feedPanel, statusLine;
  let lease = null, playing = null, played = 0, lastTick = 0, lastPosition = 0;
  let renewal = null;
  let previousRate = 1;
  let intent = '', busy = false, waiting = false, deadline = 0, route = location.href;
  let feedBusy = false, requestedFeed = '', feedRoute = '';
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
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Connect to Vigil to continue watching.')); }, 4500);
        pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
        window.webkit.messageHandlers.vigilYouTube.postMessage({ requestId, body });
      });
    }
    if (typeof browser !== 'undefined' && browser.runtime?.sendMessage) return browser.runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body });
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) return chrome.runtime.sendMessage({ type: 'VIGIL_YOUTUBE', youtube: body });
    throw new Error('Connect to Vigil to continue watching.');
  };
  window.__vigilYouTubeReply = (id, value) => { pending.get(id)?.(value); pending.delete(id); };
  const show = value => { if (message) message.textContent = value || ''; };
  const request = async body => {
    const response = await transport(body);
    if (response?.day) {
      if (state && response.day !== state.day) { intent = ''; feedPanel?.remove(); feedPanel = null; requestedFeed = ''; }
      state = response; render();
    }
    if (!response?.ok) throw new Error(response?.message || 'Connect to Vigil to continue watching.');
    return response;
  };
  const button = (label, handler) => {
    const item = document.createElement('button'); item.textContent = label; item.type = 'button';
    item.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); void handler().catch(error => show(error.message)); });
    return item;
  };
  const save = async (id, title = id, replace) => {
    try { await request({ action: 'save', videoId: id, title, replace }); show('Saved to Watch Later.'); }
    catch (error) {
      show(error.message);
      if (error.message === 'Watch Later is full. Replace an unwatched video to save this one.') {
        for (const slot of state?.slots || []) if (slot && !slot.locked) {
          message.append(button(`Replace ${slot.title}`, () => save(id, title, slot.videoId)));
        }
      }
    }
  };
  function render() {
    if (!slots || !state) return;
    statusLine.textContent = `Watch Later · ${state.slots.filter(Boolean).length} of 4 slots used · Playback ${Math.floor(state.usedMs / 60000)} min of 120 min`;
    if (state.grace.status === 'active') statusLine.textContent += ` · Finish this video: ${Math.ceil((1200000 - state.grace.usedMs) / 1000)} sec remaining`;
    slots.replaceChildren();
    for (const slot of state.slots) {
      const row = document.createElement('div');
      if (!slot) row.textContent = 'Empty slot';
      else if (slot.removed) row.textContent = 'Used today';
      else {
        row.textContent = `${slot.title} · ${slot.locked ? 'Used today' : 'Replaceable'} `;
        row.append(button('Play', async () => {
          if (currentID() === slot.videoId) { intent = slot.videoId; await begin(); }
          else location.assign(`/watch?v=${encodeURIComponent(slot.videoId)}`);
        }), button('Remove', async () => { await stop(); await request({ action: 'remove', videoId: slot.videoId }); }));
      }
      slots.append(row);
    }
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
      const sent = performance.now();
      const response = await request({ action: 'start', videoId: id });
      lease = response.lease;
      deadline = sent + (lease.expiresAt - response.serverTime) - 100;
      if (currentID() !== id || performance.now() >= deadline || intent !== id) { await stop(); return; }
      playing = media; played = 0; lastTick = performance.now(); lastPosition = media.currentTime; previousRate = media.playbackRate || 1; waiting = media.readyState < 3;
      await media.play(); show('');
    } catch (error) { intent = ''; await stop().catch(() => {}); show(error.message); }
    finally { busy = false; }
  }
  function mount() {
    if (!document.documentElement || panel || !topFrame) return;
    panel = document.createElement('section'); panel.id = 'vigil-youtube-limits';
    const shadow = panel.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = ':host{display:block!important;position:relative!important;z-index:2147483646!important;background:#17201c!important;color:#fff!important;font:14px system-ui!important;padding:14px!important}button{background:#d5efb9;color:#17201c;border:0;border-radius:6px;padding:7px 10px;margin:4px;cursor:pointer}summary{cursor:pointer}div{margin:5px 0}a{color:inherit}';
    statusLine = document.createElement('strong'); statusLine.textContent = 'Watch Later · Connecting to Vigil…';
    message = document.createElement('div'); message.setAttribute('role', 'status');
    slots = document.createElement('div');
    const details = document.createElement('details'), summary = document.createElement('summary'); summary.textContent = 'Today’s Watch Later';
    details.append(summary, slots);
    shadow.append(style, statusLine, message, details,
      button('Save this video', async () => { const id = currentID(); if (id) await save(id, document.title); }),
      button('Play this video', async () => { intent = currentID(); await begin(); }),
      button('Pause', async () => { intent = ''; await stop(); }));
    document.documentElement.prepend(panel);
    void request({ action: 'status' }).catch(error => show(error.message));
  }
  function feedName() { return ['/', '/feed/recommended'].includes(location.pathname) ? 'home' : location.pathname === '/feed/subscriptions' ? 'subscriptions' : ''; }
  async function feed() {
    const name = feedName();
    if (name === 'home' && ['blocked', 'pending'].includes(document.documentElement.getAttribute('data-vigil-feature-home'))) return;
    if (!name || !topFrame || feedBusy) return;
    if (feedRoute !== location.pathname) { feedPanel?.remove(); feedPanel = null; feedRoute = location.pathname; requestedFeed = ''; }
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="watch?v="]')) {
      const id = idFrom(anchor.href);
      if (id && !cards.some(card => card.videoId === id)) cards.push({ videoId: id, title: (anchor.getAttribute('title') || anchor.textContent || id).trim().slice(0, 200) });
      if (cards.length === 20) break;
    }
    if (!state?.feeds[name] && (!cards.length || requestedFeed === name)) return;
    feedBusy = true;
    try {
      if (!state?.feeds[name]) { requestedFeed = name; await request({ action: 'feed', feed: name, cards }); }
      if (feedName() !== name || feedPanel) return;
      feedPanel = document.createElement('section'); feedPanel.id = 'vigil-daily-feed';
      feedPanel.style.cssText = 'display:grid;gap:16px;padding:20px;background:#fff;color:#17201c;position:relative;z-index:2147483645';
      for (const card of state?.feeds[name] || []) {
        const row = document.createElement('article'), title = document.createElement('div');
        title.textContent = card.title;
        row.append(title, button('Save to Watch Later', () => save(card.videoId, card.title)));
        feedPanel.append(row);
      }
      const end = document.createElement('p'); end.textContent = 'You’ve reached today’s feed.'; feedPanel.append(end);
      panel.after(feedPanel);
    } catch (error) { requestedFeed = ''; show(error.message); }
    finally { feedBusy = false; }
  }
  function clean() {
    mount();
    const daily = Boolean(feedName());
    const blockedHome = feedName() === 'home' && ['blocked', 'pending'].includes(document.documentElement.getAttribute('data-vigil-feature-home'));
    if (feedPanel) feedPanel.hidden = blockedHome;
    document.documentElement.toggleAttribute('data-vigil-daily-feed', daily);
    if (!daily) { feedPanel?.remove(); feedPanel = null; feedRoute = ''; }
    if (!document.getElementById('vigil-limits-style')) {
      const style = document.createElement('style'); style.id = 'vigil-limits-style';
      style.textContent = 'a[href*="/shorts/"],ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-video-preview,ytm-video-preview,ytd-continuation-item-renderer,ytm-continuation-item-renderer,.ytp-autonav-toggle-button,.ytp-autonav-endscreen-countdown-container{display:none!important}html[data-vigil-daily-feed] ytd-browse,html[data-vigil-daily-feed] ytm-browse{display:none!important}';
      document.documentElement.append(style);
    }
    for (const media of document.querySelectorAll('video,audio')) {
      media.autoplay = false; media.removeAttribute('autoplay');
      if (media !== playing || !lease || /^\/shorts\//.test(location.pathname)) media.pause();
    }
    void feed();
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
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const anchor = event.target.closest('a[href]');
    const id = anchor && idFrom(anchor.href);
    if (id && !state?.slots.some(slot => slot?.videoId === id && !slot.removed)) {
      event.preventDefault(); event.stopImmediatePropagation();
      intent = ''; void stop().then(() => save(id, anchor.textContent || id)).catch(error => show(error.message));
    }
    if (event.target.closest('.ytp-play-button,video') && currentID() && !lease) { intent = currentID(); void begin(); }
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
