(() => {
  'use strict';
  if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(location.hostname)) return;
  if (/^\/accounts\//i.test(location.pathname)) return;
  if (window.__vigilYouTubeLimits) return;
  window.__vigilYouTubeLimits = true;
  const topFrame = window.top === window;
  const playerFrame = topFrame || /^\/embed\/[\w-]{11}\/?$/.test(location.pathname);
  const accountFetch = typeof fetch === 'function' ? fetch.bind(window) : null;
  const pending = new Map();
  const client = crypto.randomUUID();
  const verifiedWatchPages = new Set();
  let state = window.webkit?.messageHandlers?.vigilYouTube && window.__vigilYouTubeInitialStatus?.ok
    && Math.abs(Date.now() - window.__vigilYouTubeInitialStatus.serverTime) < 6500
    ? window.__vigilYouTubeInitialStatus : null;
  delete window.__vigilYouTubeInitialStatus;
  let panel, message, statusLine, notice;
  let finishedScreen, finishedSignature = "";
  let lease = null, playing = null, played = 0, lastTick = 0, lastPosition = 0;
  let renewal = null;
  let resumeMedia = null, retryInterruptedPlay = false, queuedStart = false;
  let wantsPlayback = false, playAttempt = 0, pendingPlay = null, settlingPlayback = false;
  let previousRate = 1;
  let intent = '', busy = false, waiting = false, deadline = 0, route = location.href;
  let menuVideo = null, replayingSave = false;
  let spacePress = null, idleSince = null, playbackClock = null;
  let preparation = null;
  let watchLaterSync = null, watchLaterSnapshot = null, watchLaterCheckedAt = -Infinity;
  let watchLaterChanging = false;
  let watchLaterError = '';
  let watchLaterTools = null, bulkClearRunning = false, bulkClearStopped = false;
  let watchLaterMenuUntil = 0, watchLaterMenuEntry = null, watchLaterMenuPopup = null;
  const ownedMedia = new WeakSet();
  let pressedControl = null;
  const playControlSelector = '.ytp-play-button,.ytp-large-play-button,.ytp-cued-thumbnail-overlay,video,button[aria-label="Play"],button[aria-label="Play video"],button[aria-label="Pause"],button[aria-label="Pause video"]';
  const controlLabel = control => (control.getAttribute('aria-label') || control.getAttribute('title') || '').trim();
  const rememberPressedControl = event => {
    pressedControl = null;
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const control = event.target.closest(playControlSelector);
    if (control && currentID()) pressedControl = { control, id: currentID(), label: controlLabel(control), at: performance.now() };
  };
  // Mobile YouTube can handle touchend before the compatibility click and
  // change Play to Pause (or the reverse). Preserve what the user pressed.
  document.addEventListener('pointerdown', rememberPressedControl, true);
  document.addEventListener('touchstart', rememberPressedControl, { capture: true, passive: true });
  document.addEventListener('touchcancel', () => { pressedControl = null; }, true);
  document.addEventListener('pointercancel', () => { pressedControl = null; }, true);
  const idFrom = value => {
    try {
      const url = new URL(value, location.href);
      if (!/^(www\.|m\.)?youtube(?:-nocookie)?\.com$/.test(url.hostname) || /^\/shorts\//.test(url.pathname)) return '';
      const id = /^\/(embed|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : url.searchParams.get('v');
      return /^[\w-]{11}$/.test(id || '') ? id : '';
    } catch { return ''; }
  };
  const currentID = () => idFrom(location.href);
  const currentVideo = () => {
    const candidates = Array.from(document.querySelectorAll('video')).filter(video => video.isConnected !== false
      && !video.closest?.('ytd-video-preview,ytm-video-preview,ytd-moving-thumbnail-renderer'));
    const score = video => {
      const rect = video.getBoundingClientRect?.();
      const visible = rect && rect.width > 0 && rect.height > 0;
      const player = video.closest?.('ytm-player,ytd-player,#movie_player,#player-container-id');
      return (visible ? 1e9 : 0) + (player ? 1e6 : 0) + (visible ? Math.min(1e5, rect.width * rect.height) : 0);
    };
    return candidates.sort((left, right) => score(right) - score(left))[0] || null;
  };
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
      if (body.action === 'check') {
        const key = `${response.day}:${body.videoId}`;
        if (response.ok) verifiedWatchPages.add(key); else verifiedWatchPages.delete(key);
      }
      if (body.action === 'remove') verifiedWatchPages.delete(`${response.day}:${body.videoId}`);
      state = response; render();
    }
    if (!response?.ok) throw new Error(response?.message || 'Your allowance could not be checked. Reopen YouTube to retry.');
    return response;
  };
  function render() {
    updateFinishedScreen();
    if (!statusLine || !state) return;
    const remaining = Math.max(0, 7200000 - state.usedMs);
    const timeFinished = state.grace.status === 'ended' || remaining === 0
      && !(state.grace.status === 'active' && state.grace.usedMs < 1200000 && state.grace.videoId === currentID());
    const text = timeFinished ? 'Watch time used for today' : state.grace.status === 'active'
      ? `Finish this video · ${Math.ceil((1200000 - state.grace.usedMs) / 60000)} min left`
      : `${state.watchLaterOverflow ? 0 : 4 - state.slots.filter(Boolean).length} saves left · ${Math.ceil(remaining / 60000)} min left`;
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
  const pauseMedia = media => {
    if (!media) return;
    // The app's safety gate may still be waiting for a frame/text verdict.
    // Cancel its remembered Play too, so that reply cannot undo this Pause.
    window.__vigilEarlyMediaGate?.hold(media, false, true);
    if (media.dataset) delete media.dataset.vigilResumeWhenSafe;
    media.pause();
  };
  const observeMediaOwnership = media => {
    if (ownedMedia.has(media)) return;
    ownedMedia.add(media);
    // Removed elements no longer bubble Play to the document. YouTube can
    // still complete an old play() promise or restart its detached decoder.
    media.addEventListener('play', () => {
      if (media.isConnected === false) pauseMedia(media);
    }, true);
  };
  function adoptReplacementPlayer(replacement = null, resume = true) {
    if (!playing) return false;
    const previous = playing;
    const detached = previous.isConnected === false;
    // The short playback clock needs no layout scan for a connected owner.
    // Check a hidden connected predecessor only when another player starts.
    if (!detached && !replacement) return false;
    const rect = detached ? null : previous.getBoundingClientRect?.();
    if (!detached && !(rect && (rect.width === 0 || rect.height === 0))) return false;
    replacement ||= currentVideo();
    if (replacement === previous) return false;
    sample();
    observeMediaOwnership(previous);
    if (!replacement || !lease || busy || settlingPlayback || !wantsPlayback || intent !== currentID()
        || lease.videoId !== currentID() || performance.now() >= deadline) {
      if (detached) pauseMedia(previous);
      return false;
    }
    // Keep the same bounded authorization and settled time. The replacement's
    // play() still passes through the native frame/text safety gate.
    playing = replacement; resumeMedia = replacement;
    ++playAttempt; pendingPlay = null; retryInterruptedPlay = false;
    lastTick = performance.now(); lastPosition = replacement.currentTime;
    previousRate = replacement.playbackRate || 1; waiting = replacement.readyState < 3;
    observeMediaOwnership(replacement);
    pauseMedia(previous);
    if (resume || replacement.paused) playAuthorized(replacement);
    return true;
  }
  async function stop(ended = false) {
    settlingPlayback = true;
    ++playAttempt; pendingPlay = null;
    sample();
    const wasPaused = !playing || playing.paused;
    ended = ended || Boolean(playing?.ended);
    pauseMedia(playing);
    if (renewal) await renewal.catch(() => {});
    const old = lease; lease = null;
    const elapsed = played; played = 0;
    pauseMedia(playing);
    playing = null; retryInterruptedPlay = false;
    if (old) {
      try { await request({ action: 'settle', leaseId: old.id, playedMs: elapsed, ended }); }
      catch (error) {
        // A backgrounded tab may wake after its short authorization expires.
        // The paused video itself remains usable; the next Play gets a new lease.
        if (!wasPaused || error.message !== 'Playback authorization expired.') { settlingPlayback = false; throw error; }
      }
    }
    idleSince = null;
    settlingPlayback = false;
  }
  async function begin() {
    if (busy || lease || !intent || !playerFrame) return;
    const id = currentID();
    if (intent !== id || !id || /^\/shorts\//.test(location.pathname)) return;
    let media = currentVideo();
    if (!media) return;
    busy = true;
    updateHeldPlayer();
    try {
      // Reconcile on navigation, but do not hold existing playback permission
      // behind YouTube's network. Only a new saved-video import needs the list.
      void prepareCurrentVideo();
      let sent = performance.now(), response;
      try { response = await request({ action: 'start', videoId: id }); }
      catch (error) {
        if (error.message !== 'Save this video to Watch Later before playing.') throw error;
        show('Checking Watch Later…');
        const saved = await watchLaterMembership(id, true);
        if (!saved) throw error;
        await request({ action: 'save', ...saved });
        sent = performance.now(); response = await request({ action: 'start', videoId: id });
      }
      lease = response.lease;
      deadline = sent + (lease.expiresAt - response.serverTime) - 100;
      if (currentID() !== id || performance.now() >= deadline || intent !== id || !wantsPlayback) { await stop(); return; }
      // Authorization may outlive a YouTube player replacement during startup.
      media = currentVideo();
      if (!media) { await stop(); return; }
      playing = media; resumeMedia = media; played = 0; lastTick = performance.now(); lastPosition = media.currentTime; previousRate = media.playbackRate || 1; waiting = media.readyState < 3;
      observeMediaOwnership(media);
      // play() may remain pending throughout buffering. Do not hold the
      // authorization lock while WebKit waits for media data: renewals must
      // continue before the current bounded lease expires.
      updateHeldPlayer();
      playAuthorized(media);
    } catch (error) { intent = ''; await stop().catch(() => {}); show(error.message); }
    finally { releaseBusy(); }
  }
  function playAuthorized(media) {
    if (media !== playing || !lease || intent !== currentID()
        || lease.videoId !== currentID() || performance.now() >= deadline || !wantsPlayback || pendingPlay) return;
    const authorization = lease;
    const attempt = ++playAttempt;
    pendingPlay = attempt;
    retryInterruptedPlay = false;
    void media.play().then(() => {
      if (attempt !== playAttempt || playing !== media || lease?.id !== authorization.id) return;
      if (media.paused && media.dataset?.vigilPlaybackRequested === 'true') waiting = true;
      show('');
    }, error => {
      if (attempt !== playAttempt || playing !== media || lease?.id !== authorization.id || !wantsPlayback) return;
      if (error.name === 'AbortError' && intent === currentID()) {
        // canplay can precede the rejected promise. The bounded playback clock
        // also retries ready media, so that event ordering cannot strand Play.
        waiting = true;
        retryInterruptedPlay = true;
        return;
      }
      intent = '';
      void stop().catch(() => {}).finally(() => show(error.message));
    }).finally(() => { if (pendingPlay === attempt) pendingPlay = null; });
  }
  function pauseAuthorized() {
    sample(); wantsPlayback = false; retryInterruptedPlay = false; waiting = false;
    ++playAttempt; pendingPlay = null;
    pauseMedia(playing || currentVideo());
  }
  function positionAllowance() {
    if (!panel) return;
    const desktopHeader = !document.documentElement.hasAttribute?.('data-vigil-saves-finished')
      && location.hostname !== 'm.youtube.com' && (window.innerWidth || 1024) >= 768
      ? document.querySelector('ytd-masthead #start') : null;
    panel.toggleAttribute('data-desktop', Boolean(desktopHeader));
    // Keep the mobile strip outside YouTube's transformed/clipped app shell.
    // Reparent in both directions when navigation replaces the masthead.
    const parent = desktopHeader || document.body;
    if (parent && panel.parentNode !== parent) parent.append(panel);
    panel.hidden = Boolean(document.fullscreenElement || document.webkitFullscreenElement
      || document.querySelector('video')?.webkitDisplayingFullscreen
      || document.querySelector('.html5-video-player.ytp-fullscreen'));
    if (desktopHeader) {
      if (panel.style.bottom) panel.style.bottom = '';
      return;
    }
    if (panel.hidden) return;
    const viewport = window.visualViewport;
    const height = window.innerHeight || document.documentElement.clientHeight;
    const visibleBottom = Math.min(height, viewport ? viewport.offsetTop + viewport.height : height);
    let bottom = Math.max(0, height - visibleBottom);
    // The bottom tabs and collapsed player can be siblings of the header.
    // Use their visible bounds rather than assuming a particular phone size.
    for (const obstacle of document.querySelectorAll(
      'ytm-pivot-bar-renderer, ytm-miniplayer, ytm-miniplayer-renderer, ytd-miniplayer[active]'
    )) {
      const rect = obstacle.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top >= visibleBottom * .5
          && rect.top < visibleBottom && rect.bottom > 0) {
        bottom = Math.max(bottom, height - rect.top);
      }
    }
    const value = `calc(max(${Math.ceil(bottom)}px, env(safe-area-inset-bottom)) + 8px)`;
    // This owned panel needs a geometry update, not a custom-property change
    // that invalidates background/generated media throughout the page.
    if (panel.style.bottom !== value) panel.style.bottom = value;
  }
  for (const event of ['fullscreenchange', 'webkitfullscreenchange', 'webkitbeginfullscreen', 'webkitendfullscreen']) {
    document.addEventListener(event, positionAllowance, true);
  }
  window.addEventListener('resize', positionAllowance);
  window.visualViewport?.addEventListener('resize', positionAllowance);
  window.visualViewport?.addEventListener('scroll', positionAllowance);
  function mount() {
    if (!document.body || !playerFrame) return;
    if (panel) {
      if (!panel.isConnected) document.body.append(panel);
      if (notice && !notice.isConnected) document.body.append(notice);
      positionAllowance();
      return;
    }
    panel = document.createElement('aside'); panel.id = 'vigil-youtube-limits';
    const shadow = panel.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{display:block;position:fixed;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));bottom:calc(env(safe-area-inset-bottom) + 8px);z-index:2147483645;width:max-content;max-width:calc(100% - 24px);margin:0 auto;padding:7px 12px;box-sizing:border-box;border:1px solid var(--yt-spec-10-percent-layer,#ffffff26);border-radius:10px;background:var(--yt-spec-raised-background,#212121);color:var(--yt-spec-text-primary,#f1f1f1);box-shadow:0 2px 8px #0003;font:13px/1.4 Roboto,Arial,sans-serif;text-align:center;pointer-events:none;overflow-wrap:anywhere}:host([data-desktop]){display:inline-flex;position:relative;inset:auto;z-index:auto;width:auto;margin:0;border:0;border-radius:0;background:transparent;box-shadow:none;text-align:start;flex:0 0 auto;max-width:min(220px,30vw);padding:4px 12px;color:var(--yt-spec-text-secondary,#aaa);line-height:1.4;white-space:normal;overflow-wrap:anywhere}:host([hidden]){display:none!important}strong{font-weight:400}`;
    statusLine = document.createElement('strong'); statusLine.textContent = 'Checking allowance…';
    shadow.append(style, statusLine);
    panel.setAttribute('aria-label', 'YouTube daily allowance');
    document.body.append(panel);
    positionAllowance();
    notice = document.createElement('aside'); notice.id = 'vigil-youtube-notice'; notice.hidden = true;
    const noticeShadow = notice.attachShadow({mode:'closed'});
    const noticeStyle = document.createElement('style');
    noticeStyle.textContent = `:host{position:fixed;left:max(16px,env(safe-area-inset-left));top:calc(env(safe-area-inset-top) + 64px);z-index:2147483647;max-width:min(340px,calc(100vw - 32px));box-sizing:border-box;background:var(--yt-spec-raised-background,#212121);color:var(--yt-spec-text-primary,#f1f1f1);border:1px solid var(--yt-spec-10-percent-layer,#ffffff1a);border-radius:12px;box-shadow:0 4px 16px #0003;padding:14px 42px 14px 16px;font:14px/1.4 Roboto,Arial,sans-serif}:host([hidden]){display:none!important}@media(max-width:600px){:host{left:max(12px,env(safe-area-inset-left));top:calc(env(safe-area-inset-top) + 56px)}}button{position:absolute;right:6px;top:6px;width:30px;height:30px;border:0;border-radius:50%;background:transparent;color:inherit;font:24px/1 Arial;cursor:pointer}button:hover,button:focus-visible{background:#ffffff20}`;
    message = document.createElement('div'); message.setAttribute('role','status');
    const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = '×'; dismiss.setAttribute('aria-label','Dismiss notification');
    dismiss.addEventListener('click', () => { notice.hidden = true; });
    noticeShadow.append(noticeStyle, message, dismiss); document.body.append(notice);
    render();
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
    // Only parse the immediate argument/value. Searching for a later brace
    // can mistake the next bootstrap object for a string-valued setting.
    const start = offset;
    if (source[start] !== '{') return null;
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
  function youtubePageConfiguration(source) {
    const configuration = Object.create(null);
    // YouTube first calls set('EMERGENCY_BASE_URL', ...), then publishes its
    // JSON bootstrap, and may add more JSON settings in later script tags.
    for (const match of source.matchAll(/ytcfg\.set\(\s*(?=\{)/g)) {
      const value = jsonAfter(source.slice(match.index), /^ytcfg\.set\(\s*/);
      if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(configuration, value);
    }
    return configuration;
  }
  function watchLaterContinuationTokens(endpoint) {
    if (!endpoint || typeof endpoint !== 'object') return [];
    if (typeof endpoint.continuationCommand?.token === 'string') return [endpoint.continuationCommand.token];
    const commands = endpoint.commandExecutorCommand?.commands;
    return Array.isArray(commands) ? commands.flatMap(watchLaterContinuationTokens) : [];
  }
  async function watchLaterBrowseHeaders(config) {
    const headers = { 'Content-Type': 'application/json' };
    const context = config.INNERTUBE_CONTEXT?.client;
    const clientName = config.INNERTUBE_CONTEXT_CLIENT_NAME;
    if (clientName !== undefined) headers['X-Youtube-Client-Name'] = String(clientName);
    if (context?.clientVersion) headers['X-Youtube-Client-Version'] = context.clientVersion;
    if (/^\d+$/.test(String(config.SESSION_INDEX ?? '0'))) headers['X-Goog-AuthUser'] = String(config.SESSION_INDEX ?? '0');
    if (typeof config.DELEGATED_SESSION_ID === 'string' && /^\d+$/.test(config.DELEGATED_SESSION_ID)) {
      headers['X-Goog-PageId'] = config.DELEGATED_SESSION_ID;
    }
    // Private playlist continuations require the same session proof used by
    // YouTube's web client. Keep it inside this origin; never persist, bridge,
    // or log the cookie or proof, and never follow a credentialed redirect.
    const cookies = new Map(String(document.cookie || '').split(';').map(value => {
      const index = value.indexOf('=');
      return [value.slice(0, index).trim(), value.slice(index + 1)];
    }));
    const session = cookies.get('SAPISID') || cookies.get('__Secure-3PAPISID') || cookies.get('__Secure-1PAPISID');
    if (session) {
      const timestamp = Math.floor(Date.now() / 1000);
      const proof = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(`${timestamp} ${session} ${location.origin}`));
      const hash = [...new Uint8Array(proof)].map(value => value.toString(16).padStart(2, '0')).join('');
      headers.Authorization = `SAPISIDHASH ${timestamp}_${hash}`;
    }
    return headers;
  }
  function domCards() {
    const cards = [];
    for (const anchor of document.querySelectorAll('a[href*="watch?v="]')) {
      const videoId = idFrom(anchor.href);
      if (!videoId || cards.some(card => card.videoId === videoId)) continue;
      const container = anchor.closest(nativeCardSelector);
      if (!container || (feedName() && !standardFeedCard(container))) continue;
      const titleNode = container?.querySelector('h3,h4,#video-title,.media-item-headline');
      const title = (titleNode?.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || anchor.textContent || '').trim();
      if (validTitle(title)) cards.push({ videoId, title });
    }
    return cards;
  }
  function watchLaterRemoval(video) {
    // Accept only the removal command published by this exact playlist item.
    // Never construct an endpoint or infer an item identifier from its position.
    const matches = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      const edit = value.playlistEditEndpoint;
      const apiUrl = value.commandMetadata?.webCommandMetadata?.apiUrl;
      if (edit?.playlistId === 'WL' && apiUrl === '/youtubei/v1/browse/edit_playlist'
          && Array.isArray(edit.actions) && edit.actions.length === 1) {
        const action = edit.actions[0];
        const setVideoId = action.setVideoId;
        const removedVideoId = action.removedVideoId;
        if (action.action === 'ACTION_REMOVE_VIDEO'
            && (typeof setVideoId === 'string' && setVideoId.length > 0 && setVideoId.length <= 1024
              || removedVideoId === video.videoId)
            && (setVideoId === undefined || typeof setVideoId === 'string' && setVideoId.length > 0 && setVideoId.length <= 1024)
            && (removedVideoId === undefined || removedVideoId === video.videoId)) {
          matches.push({ apiUrl, action: { action: 'ACTION_REMOVE_VIDEO',
            ...(setVideoId ? { setVideoId } : {}), ...(removedVideoId ? { removedVideoId } : {}) } });
        }
      }
      for (const child of Object.values(value)) if (typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(video.menu);
    const unique = [...new Map(matches.map(item => [JSON.stringify(item), item])).values()];
    return unique.length === 1 ? unique[0] : null;
  }
  function emptyWatchLaterPage(data) {
    const browse = data?.contents?.twoColumnBrowseResultsRenderer || data?.contents?.singleColumnBrowseResultsRenderer;
    const selected = browse?.tabs?.filter(tab => tab.tabRenderer?.selected === true);
    if (selected?.length !== 1) return false;
    const sections = selected[0].tabRenderer.content?.sectionListRenderer?.contents;
    if (!Array.isArray(sections) || !sections.length) return false;
    const entries = sections.flatMap(section => section.itemSectionRenderer?.contents || [section]);
    // A known empty renderer in the selected playlist tab is positive evidence.
    // Unknown/error pages, empty objects and recommendations cannot mean empty.
    return entries.length > 0 && entries.every(entry => entry.messageRenderer
      && /^No videos in this playlist(?: yet)?[.!]?$/i.test(textOf(entry.messageRenderer.text).trim()));
  }
  function watchLaterPage(data, continuation = false, editing = false) {
    const lists = [];
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      const list = continuation ? value.playlistVideoListContinuation || value.appendContinuationItemsAction
        : value.playlistVideoListRenderer;
      if (list) { lists.push(list); return; }
      for (const child of Object.values(value)) if (typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(visit); else visit(child);
      }
    };
    visit(data);
    if (!continuation && lists.length === 0 && emptyWatchLaterPage(data)) return { cards: [], token: null };
    if (lists.length !== 1) throw new Error('Could not verify the Watch Later playlist. Please try again.');
    const list = lists[0];
    if (list.playlistId && list.playlistId !== 'WL'
        || list.targetId && !['WL', 'VLWL', 'playlist-video-list'].includes(list.targetId)) {
      throw new Error('Could not verify the Watch Later playlist. Please try again.');
    }
    const contents = list.contents || list.continuationItems;
    if (!Array.isArray(contents)) throw new Error('Could not read the complete Watch Later playlist. Please try again.');
    const cards = [], tokens = [];
    for (const item of contents) {
      const video = item.playlistVideoRenderer || item.playlistPanelVideoRenderer;
      if (video) {
        if (!/^[\w-]{11}$/.test(video.videoId || '')) throw new Error('Could not read a Watch Later entry. Please try again.');
        cards.push({ videoId: video.videoId, title: textOf(video.title).trim().slice(0, 200) || video.videoId,
          ...(editing ? { removal: watchLaterRemoval(video) } : {}) });
      } else if (item.continuationItemRenderer) {
        const next = watchLaterContinuationTokens(item.continuationItemRenderer.continuationEndpoint);
        if (next.length !== 1 || !next[0]) throw new Error('Could not read the complete Watch Later playlist. Please try again.');
        tokens.push(next[0]);
      } else if (!item.messageRenderer) {
        throw new Error('Could not read a Watch Later entry. Please try again.');
      }
    }
    for (const entry of list.continuations || []) {
      const token = entry.nextContinuationData?.continuation;
      if (!token) throw new Error('Could not read the complete Watch Later playlist. Please try again.');
      tokens.push(token);
    }
    if (new Set(tokens).size > 1) throw new Error('Could not read the complete Watch Later playlist. Please try again.');
    return { cards, token: tokens[0] || null };
  }
  async function readWatchLaterStart() {
    if (!accountFetch || !/^(www\.|m\.)?youtube\.com$/.test(location.hostname) || !topFrame) {
      throw new Error('Open YouTube to check your shared Watch Later.');
    }
    const options = { credentials: 'include', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) };
    const response = await accountFetch('/playlist?list=WL', options);
    if (!response.ok) throw new Error('Could not check Watch Later. Please try again.');
    const html = await response.text();
    const initial = jsonAfter(html, /(?:var\s+)?(?:window\s*\[\s*["']ytInitialData["']\s*\]|ytInitialData)\s*=\s*/);
    const config = youtubePageConfiguration(html);
    if (!initial || config?.LOGGED_IN !== true || typeof config.DATASYNC_ID !== 'string' || !config.DATASYNC_ID.trim()) {
      throw new Error('Sign in to the same YouTube account to check your shared Watch Later.');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(config.DATASYNC_ID));
    const accountKey = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    return { initial, config, accountKey };
  }
  async function readWatchLater(editing = false) {
    const { config, accountKey } = await readWatchLaterStart();
    const options = { credentials: 'include', cache: 'no-store', redirect: 'error' };
    // All surfaces must reconcile identical membership, including unavailable
    // entries. A desktop-only visible snapshot makes old phone entries look new.
    // This is the web client's include-unavailable mode, also used by yt-dlp.
    if (!config.INNERTUBE_CONTEXT) throw new Error('Could not verify the full Watch Later list.');
    const all = await accountFetch('/youtubei/v1/browse', {
      ...options, method: 'POST', signal: AbortSignal.timeout(10000), headers: await watchLaterBrowseHeaders(config),
      body: JSON.stringify({ context: config.INNERTUBE_CONTEXT, browseId: 'VLWL', params: 'wgYCCAA=' })
    });
    if (!all.ok) throw new Error('Could not read the complete Watch Later list. Please try again.');
    const data = await all.json();
    const cards = [], ids = new Set(), tokens = new Set();
    let page = watchLaterPage(data, false, editing);
    for (let i = 0; i < 100; i++) {
      for (const card of page.cards) {
        if (ids.has(card.videoId)) throw new Error('Watch Later changed while checking. Please try again.');
        ids.add(card.videoId); cards.push(card);
      }
      if (cards.length > 5000) throw new Error('Watch Later is too large to verify.');
      if (!page.token) return { accountKey, cards, ...(editing ? { config } : {}) };
      if (tokens.has(page.token) || !config.INNERTUBE_CONTEXT) break;
      tokens.add(page.token);
      const next = await accountFetch('/youtubei/v1/browse', {
        ...options, method: 'POST', signal: AbortSignal.timeout(10000), headers: await watchLaterBrowseHeaders(config),
        body: JSON.stringify({ context: config.INNERTUBE_CONTEXT, continuation: page.token })
      });
      if (!next.ok) throw new Error('Could not check Watch Later. Please try again.');
      page = watchLaterPage(await next.json(), true, editing);
    }
    throw new Error('Could not read the complete Watch Later playlist. Please try again.');
  }
  // BEGIN WATCH LATER MENU
  function removeWatchLaterMenuEntry() {
    watchLaterMenuEntry?.remove();
    watchLaterMenuEntry = null; watchLaterMenuPopup = null;
  }
  function watchLaterPlaylistPage() {
    return topFrame && location.pathname === '/playlist' && new URL(location.href).searchParams.get('list') === 'WL';
  }
  function mountWatchLaterMenu() {
    if (!watchLaterPlaylistPage()) { removeWatchLaterMenuEntry(); watchLaterMenuUntil = 0; return; }
    if (watchLaterMenuEntry) {
      const rect = watchLaterMenuPopup?.getBoundingClientRect();
      if (watchLaterMenuEntry.isConnected && rect?.width > 0 && rect.height > 0) return;
      removeWatchLaterMenuEntry();
    }
    if (performance.now() >= watchLaterMenuUntil) return;
    for (const popup of document.querySelectorAll('ytd-menu-popup-renderer,ytm-menu-popup-renderer')) {
      const rect = popup.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const entry = document.createElement('button'); entry.type = 'button';
      entry.textContent = 'Clear Watch Later…'; entry.setAttribute('data-vigil-watch-later-clear', '');
      entry.style.cssText = 'display:block;width:100%;min-height:44px;padding:12px 16px;border:0;background:transparent;color:inherit;font:14px Roboto,Arial,sans-serif;text-align:left;cursor:pointer';
      entry.addEventListener('click', event => {
        if (!event.isTrusted) return;
        event.preventDefault(); event.stopPropagation();
        popup.closest('tp-yt-iron-dropdown')?.close?.();
        void openWatchLaterTools();
      });
      (popup.querySelector('tp-yt-paper-listbox') || popup).append(entry);
      watchLaterMenuEntry = entry; watchLaterMenuPopup = popup;
      return;
    }
  }
  function watchLaterMenuClick(event) {
    if (!event.isTrusted || !(event.target instanceof Element) || watchLaterMenuEntry?.contains(event.target)) return;
    removeWatchLaterMenuEntry(); watchLaterMenuUntil = 0;
    if (!watchLaterPlaylistPage()) return;
    const button = event.target.closest('button,[role="button"]');
    const header = button?.closest('ytd-playlist-sidebar-renderer,ytd-playlist-header-renderer,ytd-playlist-sidebar-primary-info-renderer,ytm-playlist-header-renderer,ytm-playlist-metadata-renderer,yt-page-header-view-model,ytm-page-header-renderer');
    if (!header || !/^(?:action menu|more actions|more|playlist actions)$/i.test(controlLabel(button))) return;
    watchLaterMenuUntil = performance.now() + 2500;
    setTimeout(mountWatchLaterMenu, 0);
  }
  // END WATCH LATER MENU
  // BEGIN WATCH LATER BULK CLEAR
  async function clearWatchLaterSnapshot(reviewed, stopped, progress) {
    const fresh = await readWatchLater(true);
    const roster = snapshot => snapshot.cards.map(card => card.videoId).sort().join(',');
    if (fresh.accountKey !== reviewed.accountKey || roster(fresh) !== roster(reviewed)) {
      throw new Error('Watch Later changed. Review the current list before clearing it.');
    }
    const checkpoint = await request({ action: 'watch-later-checkpoint' });
    if (checkpoint.watchLater?.accountKey !== fresh.accountKey) {
      throw new Error('Use the same YouTube account as your shared Watch Later.');
    }
    if (fresh.cards.some(card => !card.removal) || !fresh.config?.INNERTUBE_CONTEXT) {
      throw new Error('YouTube did not provide a verified removal control for every video. Nothing was cleared.');
    }
    let submitted = 0, failure = '';
    try {
      for (let offset = 0; offset < fresh.cards.length && !stopped(); offset += 20) {
        // Recheck the selected account between bounded batches. Session material
        // stays on YouTube; it is never exported or sent to the companion.
        const identity = await readWatchLaterStart();
        if (identity.accountKey !== fresh.accountKey) throw new Error('The YouTube account changed. Clearing stopped.');
        if (stopped()) break;
        const batch = fresh.cards.slice(offset, offset + 20);
        const response = await accountFetch(batch[0].removal.apiUrl, {
          method: 'POST', credentials: 'include', cache: 'no-store', redirect: 'error',
          signal: AbortSignal.timeout(15000), headers: await watchLaterBrowseHeaders(identity.config),
          body: JSON.stringify({ context: identity.config.INNERTUBE_CONTEXT, playlistId: 'WL',
            actions: batch.map(card => card.removal.action) })
        });
        if (!response.ok) throw new Error('YouTube did not accept this batch. Clearing stopped; no automatic retry was made.');
        const reply = await response.json();
        if (reply.error || reply.status !== 'STATUS_SUCCEEDED') {
          throw new Error('YouTube did not confirm this batch. Clearing stopped; check the remaining list.');
        }
        submitted += batch.length;
        progress(submitted, fresh.cards.length);
        if (offset + 20 < fresh.cards.length && !stopped()) await new Promise(resolve => setTimeout(resolve, 750));
      }
    } catch (error) { failure = error.message; }
    // Verify actual membership even after Stop, a timeout, or a partial failure.
    // Reconciliation updates the account checkpoint; it never refunds daily slots.
    const after = await readWatchLater(true);
    if (after.accountKey !== fresh.accountKey) throw new Error('The account changed. Reopen Watch Later to verify what remains.');
    const remaining = new Set(after.cards.map(card => card.videoId));
    const removed = fresh.cards.filter(card => !remaining.has(card.videoId)).length;
    await reconcileWatchLater(true);
    if (!failure && !stopped() && removed !== fresh.cards.length) failure = 'Some videos remain in Watch Later. Review the list before trying again.';
    return { removed, remaining: after.cards.length, stopped: stopped(), failure };
  }
  function exportWatchLater(snapshot) {
    const exported = { exportedAt: new Date().toISOString(), playlist: 'Watch Later',
      videos: snapshot.cards.map(card => ({ videoId: card.videoId, title: card.title,
        url: `https://www.youtube.com/watch?v=${card.videoId}` })) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url;
    link.download = `watch-later-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  async function openWatchLaterTools() {
    if (!topFrame || !document.body || !/^(www\.|m\.)?youtube\.com$/.test(location.hostname)) return;
    if (watchLaterTools?.dialog.open) return;
    if (!watchLaterTools) {
      const host = document.createElement('aside'); host.id = 'vigil-watch-later-tools';
      const dialog = document.createElement('dialog');
      dialog.setAttribute('aria-label', 'Watch Later tools');
      const shadow = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `:host{display:contents}dialog{box-sizing:border-box;width:min(360px,calc(100vw - 32px));max-height:calc(100dvh - 48px);overflow:auto;
        margin:auto;padding:24px;border:1px solid #ffffff26;border-radius:14px;background:#212121;color:#f1f1f1;
        font:14px/1.5 Roboto,Arial,sans-serif;box-shadow:0 18px 70px #0006}dialog::backdrop{background:#0009}
        *{box-sizing:border-box}.header{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}
        h1{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.4px}#summary{min-height:21px;margin:0 0 12px;color:#aaa;font-variant-numeric:tabular-nums}
        button,.menu-toggle{min-height:44px;border:0;border-radius:9px;background:transparent;color:inherit;font:500 14px/1.3 Roboto,Arial,sans-serif;cursor:pointer;touch-action:manipulation}
        button:hover,.menu-toggle:hover{background:#ffffff12}button:focus-visible,.menu-toggle:focus-visible{outline:2px solid #3ea6ff;outline-offset:3px}
        button:disabled{opacity:.45;cursor:default}#clear{background:#c62828;color:#fff;width:100%;margin-top:16px;padding:12px}#clear[data-mode="done"],#clear[data-mode="stop"]{background:#ffffff14;color:inherit}[hidden]{display:none!important}
        progress{display:block;width:100%;height:6px;accent-color:#3ea6ff;border:0;border-radius:4px;overflow:hidden}
        progress::-webkit-progress-bar{background:#ffffff18;border-radius:4px}progress::-webkit-progress-value{background:#3ea6ff;border-radius:4px}
        details{position:relative;flex:0 0 auto}details[inert]{opacity:.45}.menu-toggle{display:grid;place-items:center;width:40px;font-size:24px;list-style:none}
        .menu-toggle::-webkit-details-marker{display:none}.menu{position:absolute;right:0;top:48px;z-index:2;min-width:156px;padding:6px;border:1px solid #ffffff26;border-radius:10px;background:#292929;box-shadow:0 6px 22px #0005}
        .menu button{display:block;width:100%;padding:10px 12px;text-align:left;white-space:nowrap}
        @media(prefers-color-scheme:light){dialog{background:#fff;color:#181818;border-color:#ddd}#summary{color:#606060}.menu{background:#fff;border-color:#ddd}
        button:hover,.menu-toggle:hover{background:#00000008}progress::-webkit-progress-bar{background:#00000012}}`;
      const header = document.createElement('div'); header.className = 'header';
      const heading = document.createElement('h1'); heading.textContent = 'Clear Watch Later';
      const options = document.createElement('details');
      const menuToggle = document.createElement('summary'); menuToggle.className = 'menu-toggle'; menuToggle.textContent = '⋮';
      menuToggle.setAttribute('aria-label', 'Watch Later options');
      const menu = document.createElement('div'); menu.className = 'menu';
      const summary = document.createElement('p'); summary.id = 'summary'; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
      const progress = document.createElement('progress'); progress.hidden = true; progress.max = 1; progress.value = 0; progress.setAttribute('aria-label', 'Clear Watch Later progress');
      const backup = document.createElement('button'); backup.type = 'button'; backup.textContent = 'Export list';
      const review = document.createElement('button'); review.type = 'button'; review.textContent = 'Refresh page';
      const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
      const clear = document.createElement('button'); clear.type = 'button'; clear.id = 'clear'; clear.textContent = 'Clear all'; clear.disabled = true;
      menu.append(backup, review, close); options.append(menuToggle, menu); header.append(heading, options);
      dialog.append(header, summary, progress, clear); shadow.append(style, dialog);
      watchLaterTools = { host, dialog, summary, progress, backup, review, clear, close, options, snapshot: null, opener: null, loading: false, empty: false };
      const stopOrClose = () => {
        if (bulkClearRunning) { bulkClearStopped = true; summary.textContent = 'Stopping…'; clear.disabled = true; }
        else dialog.close();
      };
      close.addEventListener('click', stopOrClose);
      dialog.addEventListener('cancel', event => { event.preventDefault(); if (options.open) options.open = false; else stopOrClose(); });
      dialog.addEventListener('close', () => watchLaterTools.opener?.focus?.());
      // Backdrop events target the dialog itself; content clicks remain inside.
      // Keep a running clear visible so its Stop control cannot be lost.
      let backdropPress = false;
      const outside = event => {
        const rect = dialog.getBoundingClientRect();
        return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right
          || event.clientY < rect.top || event.clientY > rect.bottom);
      };
      dialog.addEventListener('pointerdown', event => { backdropPress = outside(event); });
      dialog.addEventListener('click', event => {
        if (event.isTrusted && backdropPress && outside(event) && !bulkClearRunning) dialog.close();
        backdropPress = false;
      });
      backup.addEventListener('click', event => {
        if (event.isTrusted && watchLaterTools.snapshot) exportWatchLater(watchLaterTools.snapshot);
      });
      review.addEventListener('click', () => { if (!bulkClearRunning) location.reload(); });
      clear.addEventListener('click', event => {
        // No bridge or synthetic page event can start account deletions.
        if (!event.isTrusted) return;
        if (bulkClearRunning) stopOrClose();
        else if (watchLaterTools.empty) dialog.close();
        else if (watchLaterTools.snapshot && !watchLaterTools.loading) void runWatchLaterClear();
      });
      document.body.append(host);
    }
    watchLaterTools.opener = document.activeElement;
    if (!watchLaterTools.host.isConnected) document.body.append(watchLaterTools.host);
    watchLaterTools.dialog.showModal();
    await reviewWatchLaterTools();
  }
  async function reviewWatchLaterTools() {
    const ui = watchLaterTools;
    if (!ui || ui.loading || bulkClearRunning) return;
    ui.loading = true; ui.empty = false; ui.snapshot = null; ui.clear.disabled = true; ui.backup.disabled = true; ui.review.disabled = true;
    ui.progress.hidden = true; ui.progress.removeAttribute('value'); ui.summary.textContent = 'Checking…';
    try {
      await reconcileWatchLater(true);
      const snapshot = await readWatchLater(true);
      if (snapshot.accountKey !== watchLaterSnapshot?.accountKey) throw new Error('The YouTube account changed. Refresh the list.');
      ui.snapshot = snapshot;
      const count = snapshot.cards.length;
      ui.empty = count === 0;
      ui.summary.textContent = count ? `${count.toLocaleString()} saved videos` : 'No saved videos';
      ui.progress.max = Math.max(1, count); ui.progress.value = 0;
      ui.clear.textContent = ui.empty ? 'Done' : 'Clear all'; ui.clear.setAttribute('data-mode', ui.empty ? 'done' : 'clear');
      ui.clear.setAttribute('aria-label', ui.empty ? 'Close Watch Later tools' : `Clear all ${count.toLocaleString()} videos`);
      ui.clear.disabled = !ui.empty && snapshot.cards.some(card => !card.removal);
      ui.backup.disabled = !count;
      if (count && ui.clear.disabled) ui.summary.textContent = 'Removal controls unavailable.';
    } catch (error) { ui.summary.textContent = error.message; }
    finally { ui.loading = false; ui.review.disabled = false; }
  }
  async function runWatchLaterClear() {
    const ui = watchLaterTools;
    if (!ui?.snapshot || watchLaterChanging) return;
    bulkClearRunning = true; bulkClearStopped = false; watchLaterChanging = true;
    ui.empty = false; ui.progress.hidden = false; ui.clear.setAttribute('data-mode', 'stop');
    ui.clear.disabled = false; ui.clear.textContent = 'Stop'; ui.clear.setAttribute('aria-label', 'Stop clearing');
    ui.review.disabled = true; ui.backup.disabled = true; ui.close.disabled = true; ui.options.open = false; ui.options.inert = true;
    ui.progress.max = ui.snapshot.cards.length; ui.progress.value = 0; ui.summary.textContent = 'Checking…';
    try {
      const result = await clearWatchLaterSnapshot(ui.snapshot, () => bulkClearStopped, (submitted, total) => {
        ui.progress.value = submitted;
        if (!bulkClearStopped) ui.summary.textContent = `${submitted.toLocaleString()} / ${total.toLocaleString()}`;
      });
      ui.progress.value = result.removed; ui.empty = !result.failure && result.remaining === 0;
      ui.summary.textContent = result.failure || (result.remaining ? `${result.remaining.toLocaleString()} remaining` : 'No saved videos');
      if (!result.stopped && !result.failure) location.reload();
    } catch (error) { ui.summary.textContent = `${error.message} Refresh the list to check what remains.`; }
    finally {
      ui.snapshot = null; bulkClearRunning = false; watchLaterChanging = false;
      ui.clear.textContent = ui.empty ? 'Done' : 'Clear all'; ui.clear.setAttribute('data-mode', ui.empty ? 'done' : 'clear');
      ui.clear.setAttribute('aria-label', ui.empty ? 'Close Watch Later tools' : 'Clear Watch Later'); ui.clear.disabled = !ui.empty;
      ui.close.disabled = false; ui.review.disabled = false; ui.options.inert = false;
      watchLaterCheckedAt = -Infinity;
    }
  }
  // END WATCH LATER BULK CLEAR
  async function reconcileWatchLater(force = false) {
    if (watchLaterSync) {
      // Save confirmation must see a snapshot fetched after YouTube's click.
      if (!force) return watchLaterSync;
      await watchLaterSync.catch(() => {});
      return reconcileWatchLater(true);
    }
    if (!force && watchLaterSnapshot && watchLaterSnapshot.day === state?.day
        && performance.now() - watchLaterCheckedAt < 30000) return watchLaterSnapshot;
    watchLaterSync = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await request({ action: 'watch-later-checkpoint' });
        const snapshot = await readWatchLater();
        const known = new Set(before.watchLater?.videoIds || []);
        const candidates = snapshot.cards.filter(card => !known.has(card.videoId)
          && !before.slots.some(slot => slot?.videoId === card.videoId)).slice(0, 4);
        for (const card of snapshot.cards) if ((card.videoId === currentID() || before.slots.some(slot => slot?.videoId === card.videoId))
            && !candidates.some(item => item.videoId === card.videoId)) candidates.push(card);
        try {
          const reply = await request({ action: 'watch-later-sync', accountKey: snapshot.accountKey,
            videoIds: snapshot.cards.map(card => card.videoId), cards: candidates, complete: true,
            revision: before.watchLater?.revision || 0, day: before.day });
          watchLaterSnapshot = { ...snapshot, day: reply.day };
          watchLaterCheckedAt = performance.now();
          if (watchLaterError && message?.textContent === watchLaterError) show('');
          watchLaterError = '';
          return watchLaterSnapshot;
        } catch (error) {
          if (attempt || error.message !== 'Watch Later changed while checking. Please try again.') throw error;
        }
      }
    })();
    try { return await watchLaterSync; }
    catch (error) { watchLaterError = error.message; throw error; }
    finally { watchLaterSync = null; }
  }
  async function watchLaterMembership(videoId, force = false) {
    const snapshot = await reconcileWatchLater(force);
    return snapshot.cards.find(card => card.videoId === videoId) || null;
  }
  function prepareCurrentVideo() {
    const id = currentID();
    if (!playerFrame || !id) { preparation = null; return Promise.resolve(); }
    if (preparation?.id === id && preparation.day === state?.day
        && performance.now() - preparation.at < 30000) return preparation.promise;
    const entry = { id, day: state?.day, at: performance.now(), membership: null, membershipChecked: false, promise: null };
    preparation = entry;
    entry.promise = (async () => {
      // Import the whole account delta even when this video was saved locally.
      // External/search grants still play without waiting for this request.
      await reconcileWatchLater();
      try { await request({ action: 'check', videoId: id }); }
      catch (error) {
        if (error.message !== 'Save this video to Watch Later before playing.') throw error;
        entry.membership = await watchLaterMembership(id);
        entry.membershipChecked = true;
      }
      // A status reply can establish today's ledger for the first time.
      entry.day = state?.day;
    })();
    // Navigation prepares silently; Play reports a failed check if necessary.
    void entry.promise.catch(() => {});
    return entry.promise;
  }
  function rememberMenuVideo(target) {
    const card = target.closest(`${nativeCardSelector},ytm-playlist-video-renderer,ytd-playlist-video-renderer`);
    const anchor = card?.querySelector('a[href*="watch?v="]');
    const videoId = card ? (anchor ? idFrom(anchor.href) : null) : currentID();
    const title = card?.querySelector('h3,h4,#video-title,.media-item-headline')?.textContent?.trim() || document.querySelector('h1')?.textContent?.trim() || document.title;
    // Detached Save dialogs keep the selection from the originating card.
    if (card || videoId) menuVideo = videoId ? { videoId, title } : null;
  }
  async function standardWatchLaterChange(target, remove) {
    if (watchLaterChanging) return;
    preparation = null;
    const video = menuVideo;
    if (!video) { show('Open the video’s menu again to change Watch Later.'); return; }
    watchLaterChanging = true;
    let before;
    try {
      // Refresh the account before reserving locally. YouTube performs the
      // account change; its confirmed snapshot is shared by all installations.
      await reconcileWatchLater(true);
      before = state?.slots.find(slot => slot?.videoId === video.videoId);
      if (!remove) await request({ action: 'save', ...video });
      replayingSave = true;
      try { target.click(); } finally { replayingSave = false; }
      let saved = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 700));
        saved = await watchLaterMembership(video.videoId, true);
        if (Boolean(saved) !== remove) break;
      }
      if (remove && !saved) await request({ action: 'remove', videoId: video.videoId });
      else if (!remove && !saved && !before) {
        await request({ action: 'remove', videoId: video.videoId });
        throw new Error('YouTube did not save this video. Please try again.');
      }
      show('');
    } catch (error) { show(error.message); }
    finally { watchLaterChanging = false; }
  }
  function feedName() { return ['/', '/feed/recommended'].includes(location.pathname) ? 'home' : location.pathname === '/feed/subscriptions' ? 'subscriptions' : ''; }
  const nativeCardSelector = 'ytm-rich-item-renderer,ytm-video-with-context-renderer,ytd-rich-item-renderer,ytd-rich-grid-media,ytm-rich-grid-media,ytd-video-renderer,ytm-compact-video-renderer,ytd-grid-video-renderer,yt-lockup-view-model,ytm-lockup-view-model';
  // Feed sections are discovery modules, even when they contain ordinary watch
  // links. Reject the entire module without depending on its translated heading.
  const feedModuleSelector = [
    'ytd-rich-section-renderer', 'ytm-rich-section-renderer',
    'ytd-rich-shelf-renderer', 'ytm-rich-shelf-renderer', 'ytd-shelf-renderer', 'ytm-shelf-renderer',
    'ytd-reel-shelf-renderer', 'ytm-reel-shelf-renderer',
    'ytd-brand-video-shelf-renderer', 'ytm-brand-video-shelf-renderer',
    'ytd-brand-video-singleton-renderer', 'ytm-brand-video-singleton-renderer',
    'ytd-horizontal-card-list-renderer', 'ytm-horizontal-card-list-renderer',
    'ytd-horizontal-list-renderer', 'ytm-horizontal-list-renderer',
    'ytd-feed-nudge-renderer', 'ytm-feed-nudge-renderer',
    'ytd-feed-filter-chip-bar-renderer', 'ytm-feed-filter-chip-bar-renderer',
    'ytd-rich-grid-slim-media', 'ytm-rich-grid-slim-media',
    'ytd-statement-banner-renderer', 'ytm-statement-banner-renderer',
    'ytd-banner-promo-renderer', 'ytm-banner-promo-renderer',
    'ytd-video-display-full-buttoned-renderer', 'ytm-video-display-full-buttoned-renderer',
    'ytd-inline-survey-renderer', 'ytm-inline-survey-renderer',
    'ytd-in-feed-ad-layout-renderer', 'ytm-in-feed-ad-layout-renderer',
    'ytd-ad-slot-renderer', 'ytm-ad-slot-renderer',
    'ytd-display-ad-renderer', 'ytm-display-ad-renderer',
    'ytd-promoted-sparkles-web-renderer', 'ytm-promoted-sparkles-web-renderer',
    'ytd-promoted-video-renderer', 'ytm-promoted-video-renderer',
    'yt-shorts-lockup-view-model', 'ytm-shorts-lockup-view-model'
  ].join(',');
  function standardFeedCard(card) {
    return !card.closest(`${feedModuleSelector},ytd-watch-flexy,ytm-watch`)
      && !card.querySelector(feedModuleSelector);
  }
  function standardFeedItem(item) {
    if (!item || typeof item !== 'object') return null;
    const content = item.richItemRenderer?.content || item;
    // Only a direct video renderer is a feed entry. Recursing through arbitrary
    // containers would promote music shelves and featured campaigns into slots.
    if (!['videoRenderer', 'videoWithContextRenderer', 'gridVideoRenderer', 'compactVideoRenderer', 'lockupViewModel']
      .some(key => content[key])) return null;
    return videoCards(content).cards[0] || null;
  }
  let feedEnd;
  const nativeCache = new Map();
  function nativeFeedData(data, append = false) {
    const name = feedName();
    if (!name || !data || typeof data !== 'object') return data;
    // YouTube can publish the next watch document before updating History.
    // Its item sections contain watch details and controls, not feed slots.
    // Never splice cached feed cards into that incoming player document.
    if (data.playerResponse || data.currentVideoEndpoint?.watchEndpoint
        || data.contents?.singleColumnWatchNextResultsRenderer
        || data.contents?.twoColumnWatchNextResults
        || data.contents?.twoColumnWatchNextResultsRenderer) return data;
    // Recommendation selection lasts for this document only, on every surface.
    // Reloading lets YouTube choose again without touching the daily saves.
    const cached = nativeCache.get(name) || { items: [] };
    const lists = [];
    const scan = value => {
      if (!value || typeof value !== 'object') return;
      for (const kind of ['richGridRenderer', 'itemSectionRenderer', 'richGridContinuation', 'itemSectionContinuation', 'appendContinuationItemsAction', 'reloadContinuationItemsCommand']) {
        const items = value[kind]?.contents || value[kind]?.continuationItems;
        if (Array.isArray(items)) { lists.push(items); return; }
      }
      for (const child of Object.values(value)) if (child && typeof child === 'object') {
        if (Array.isArray(child)) child.forEach(scan); else scan(child);
      }
    };
    scan(data);
    if (!lists.length) return data;
    for (const list of lists) for (const item of list) {
      const card = standardFeedItem(item);
      if (card && cached.items.length < 20
          && !cached.items.some(old => old.card.videoId === card.videoId)) cached.items.push({ card, item });
    }
    // Reuse YouTube's own renderer models. YouTube continues to render every
    // thumbnail, title, three-dot menu and Save action itself.
    let inserted = false;
    const rendered = append ? new Set(domCards().map(card => card.videoId)) : new Set();
    for (const list of lists) {
      const other = cached.items.length < 20 ? list.filter(item => item.continuationItemRenderer) : [];
      list.splice(0, list.length, ...(inserted ? [] : cached.items.filter(entry => !rendered.has(entry.card.videoId)).map(entry => entry.item)), ...other);
      inserted = true;
    }
    nativeCache.set(name, cached);
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
    document.documentElement.toggleAttribute('data-vigil-standard-feed', Boolean(name));
    if (!name) {
      if (!lastFilteredFeed) return;
      lastFilteredFeed = '';
      feedEnd?.remove(); feedEnd = null;
      document.querySelectorAll('[data-vigil-feed-hidden]').forEach(node => node.removeAttribute('data-vigil-feed-hidden'));
      document.documentElement.removeAttribute('data-vigil-feed-complete');
      document.documentElement.removeAttribute('data-vigil-feed-pending');
      return;
    }
    lastFilteredFeed = name;
    document.documentElement.toggleAttribute('data-vigil-feed-pending', !state);
    if (!state) return;
    const models = websiteFeed ? [] : nativeCache.get(name)?.items.map(entry => entry.card) || [];
    const cards = [...models];
    for (const card of domCards()) if (!cards.some(old => old.videoId === card.videoId)) cards.push(card);
    const key = `${state.day}:${name}`;
    const selected = websiteCards.get(key) || [];
    for (const card of cards) if (selected.length < 20 && !selected.includes(card.videoId)) selected.push(card.videoId);
    websiteCards.set(key, selected);
    const allowed = new Set(selected);
    const visible = new Set();
    let last;
    for (const card of document.querySelectorAll(nativeCardSelector)) {
      // Rich-item wrappers and their inner video renderer are one visual card.
      if (card.parentElement?.closest(nativeCardSelector)) continue;
      const anchor = card.querySelector('a[href*="watch?v="]');
      const id = anchor && idFrom(anchor.href);
      const showCard = Boolean(id && allowed.has(id) && standardFeedCard(card) && !visible.has(id));
      card.toggleAttribute('data-vigil-feed-hidden', !showCard);
      if (showCard) { visible.add(id); last = card; }
    }
    document.documentElement.toggleAttribute('data-vigil-feed-complete', allowed.size === 20);
    if (allowed.size === 20 && last) {
      if (!feedEnd) { feedEnd = document.createElement('p'); feedEnd.id = 'vigil-feed-end'; feedEnd.textContent = 'You’ve reached the end of these 20 videos.'; feedEnd.style.cssText = 'grid-column:1/-1;text-align:center;padding:24px 12px;font:14px Roboto,Arial,sans-serif;color:inherit'; }
      if (last.nextElementSibling !== feedEnd) last.after(feedEnd);
    }
  }
  function updateFinishedScreen() {
    if (!topFrame || !document.documentElement) return;
    const full = Boolean(state?.watchLaterOverflow || state?.slots?.filter(Boolean).length === 4);
    const id = currentID();
    const slot = state?.slots?.find(slot => slot?.videoId === id);
    const grace = state?.grace;
    const timeFinished = Boolean(state && (grace?.status === 'ended'
      || state.usedMs >= 7200000 && !(grace?.status === 'active' && grace.usedMs < 1200000 && grace.videoId === id)));
    const permittedWatch = Boolean(id && ((slot && !slot.removed && !slot.completed)
      || state?.external?.includes(id) || !slot?.completed && verifiedWatchPages.has(`${state?.day}:${id}`)));
    const gated = timeFinished || full && !permittedWatch;
    document.documentElement.toggleAttribute('data-vigil-saves-finished', gated);
    document.documentElement.toggleAttribute('data-vigil-saves-full', full);
    if (!gated) { if (finishedScreen) finishedScreen.hidden = true; return; }
    if (!document.body) return;
    if (!finishedScreen) {
      finishedScreen = document.createElement('section'); finishedScreen.id = 'vigil-youtube-finished';
      finishedScreen.hidden = true;
      const shadow = finishedScreen.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = `
        :host{display:block;position:fixed;inset:0;z-index:2147483644;overflow:auto;box-sizing:border-box;
          padding:calc(env(safe-area-inset-top) + 72px) 24px calc(env(safe-area-inset-bottom) + 100px);
          background:var(--vigil-finished-bg,#0f0f0f)!important;color:var(--vigil-finished-text,#f1f1f1)!important;
          font:16px/1.5 Roboto,Arial,sans-serif}
        :host([hidden]){display:none!important}*{box-sizing:border-box}
        main{max-width:640px;margin:0 auto;color:var(--vigil-finished-text,#f1f1f1);
          animation:vigil-content-in 300ms cubic-bezier(.2,0,0,1) both}
        .brand{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:600;letter-spacing:-.2px}
        .brand-label{border:0;background:transparent;color:inherit;font:inherit;padding:0;min-height:44px;cursor:pointer}
        .brand-label:focus-visible{outline:2px solid var(--vigil-finished-focus,#3ea6ff);outline-offset:4px;border-radius:4px}
        .brand-mark{display:grid;place-items:center;width:32px;height:23px;border-radius:7px;background:#f03}
        .brand-mark::after{content:'';margin-left:2px;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:8px solid #fff}
        .count{margin-left:auto;padding:5px 10px;border-radius:8px;background:var(--vigil-finished-chip,#272727);
          color:var(--vigil-finished-secondary,#aaa);font-size:12px;font-weight:500;letter-spacing:0}
        h1{margin:36px 0 12px;font-size:clamp(26px,4.5vw,34px);font-weight:700;line-height:1.2;letter-spacing:-.7px}
        p{margin:0 0 30px;max-width:500px;color:var(--vigil-finished-secondary,#aaa);font-size:15px;line-height:1.6}
        nav{display:grid;gap:10px}
        a{display:flex;align-items:center;gap:16px;min-height:76px;padding:16px 18px;border-radius:12px;
          background:var(--vigil-finished-card,#212121);color:var(--vigil-finished-text,#f1f1f1);text-decoration:none;touch-action:manipulation;
          transition:background-color 150ms ease,transform 150ms ease;animation:vigil-content-in 280ms cubic-bezier(.2,0,0,1) both}
        a:nth-child(1){animation-delay:50ms}a:nth-child(2){animation-delay:80ms}a:nth-child(3){animation-delay:110ms}a:nth-child(4){animation-delay:140ms}
        @media(hover:hover){a:hover{background:var(--vigil-finished-hover,#303030)}}
        a:focus-visible{background:var(--vigil-finished-hover,#303030)}a:active{transform:scale(.99)}
        a:focus-visible{outline:2px solid var(--vigil-finished-focus,#3ea6ff);outline-offset:3px}
        .number{flex:0 0 28px;color:var(--vigil-finished-secondary,#aaa);font-size:13px;font-variant-numeric:tabular-nums}
        .title{flex:1;min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font-size:15px;font-weight:500;line-height:1.4}
        .play{display:grid;place-items:center;flex:0 0 34px;height:34px;border-radius:50%;background:var(--vigil-finished-chip,#272727)}
        .play::after{content:'';margin-left:2px;border-top:5px solid transparent;border-bottom:5px solid transparent;border-left:8px solid currentColor}
        @keyframes vigil-content-in{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
        @media(max-width:600px){:host{padding-top:calc(env(safe-area-inset-top) + 48px);padding-left:20px;padding-right:20px}h1{margin-top:30px}a{gap:12px;padding:14px;min-height:78px}}
        @media(prefers-reduced-motion:reduce){:host,main,a{animation:none!important;transition:none!important}a:active{transform:none}}
      `;
      shadow.append(style, document.createElement('main'));
      finishedScreen._content = shadow.querySelector('main');
    }
    if (!finishedScreen.isConnected) document.body.append(finishedScreen);
    // YouTube scopes some theme tokens to its app element. Copy only our
    // palette to the outside overlay; page-level section styles must not turn
    // its dark appearance into a black-on-white document.
    if (typeof window.getComputedStyle === 'function') {
      const theme = window.getComputedStyle(document.querySelector('ytd-app,ytm-app') || document.documentElement);
      for (const [own, native] of [
        ['bg', '--yt-spec-base-background'], ['text', '--yt-spec-text-primary'],
        ['secondary', '--yt-spec-text-secondary'], ['card', '--yt-spec-raised-background'],
        ['chip', '--yt-spec-badge-chip-background'], ['hover', '--yt-spec-button-chip-background-hover'],
        ['focus', '--yt-spec-call-to-action']
      ]) {
        const value = theme.getPropertyValue(native).trim();
        const property = `--vigil-finished-${own}`;
        if (value && finishedScreen.style.getPropertyValue(property) !== value) finishedScreen.style.setProperty(property, value);
        else if (!value && finishedScreen.style.getPropertyValue(property)) finishedScreen.style.removeProperty(property);
      }
    }
    const slots = timeFinished ? [] : state.slots.filter(slot => slot && !slot.removed && !slot.completed);
    const complete = !timeFinished && slots.length === 0;
    // Playback counters and slot locks change during polling. Only visible
    // content changes should rebuild rows or restart their entrance animation.
    const signature = JSON.stringify([state.day, timeFinished, slots.map(slot => [slot.videoId, slot.title])]);
    if (signature === finishedSignature) { finishedScreen.hidden = false; return; }
    finishedSignature = signature;
    const heading = document.createElement('h1'); heading.textContent = timeFinished ? 'You’ve run out of watch time today.'
      : complete ? 'You’ve watched all your saved videos today.' : 'You’ve saved all four videos today.';
    const description = document.createElement('p'); description.textContent = timeFinished || complete
      ? 'You’re done with YouTube for today. Come back tomorrow.'
      : 'Finish watching your saved videos, then you’re done with YouTube for today.';
    finishedScreen.setAttribute('aria-label', timeFinished ? 'Daily YouTube watch time complete' : 'Daily YouTube saves complete');
    const brand = document.createElement('div'); brand.className = 'brand';
    const mark = document.createElement('span'); mark.className = 'brand-mark'; mark.setAttribute('aria-hidden', 'true');
    const label = document.createElement(timeFinished ? 'span' : 'button'); label.textContent = timeFinished ? 'YouTube' : 'Watch Later';
    if (!timeFinished) {
      label.type = 'button'; label.setAttribute('aria-label', 'Watch Later tools');
      label.className = 'brand-label';
      label.addEventListener('click', event => { if (event.isTrusted) void openWatchLaterTools(); });
    }
    const count = document.createElement('span'); count.className = 'count'; count.textContent = timeFinished ? 'Time used' : complete ? '4 / 4 watched' : '4 / 4 saved';
    brand.append(mark, label, count);
    const list = document.createElement('nav'); list.setAttribute('aria-label', 'Your saved videos');
    const links = slots.map((slot, index) => {
      const link = document.createElement('a'); link.href = `/watch?v=${encodeURIComponent(slot.videoId)}`;
      const number = document.createElement('span'); number.className = 'number'; number.textContent = String(index + 1).padStart(2, '0'); number.setAttribute('aria-hidden', 'true');
      const title = document.createElement('span'); title.className = 'title'; title.textContent = slot.title || 'Watch saved video';
      const play = document.createElement('span'); play.className = 'play'; play.setAttribute('aria-hidden', 'true');
      // Navigate directly from this owned shadow surface. Native YouTube's
      // delegated handlers cannot resolve links inside a closed shadow root.
      link.addEventListener('click', event => {
        if (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); event.stopPropagation();
        location.assign(link.href);
      });
      link.append(number, title, play); return link;
    });
    list.append(...links);
    finishedScreen._content.replaceChildren(brand, heading, description, ...(slots.length ? [list] : []));
    finishedScreen.hidden = false;
  }
  function updateHeldPlayer() {
    // YouTube treats the interrupted autoplay attempt as buffering. Keep its
    // own Play controls available while the allowance gate holds playback.
    document.documentElement?.toggleAttribute('data-vigil-playback-held', Boolean(playerFrame && currentID() && !lease && !busy));
    document.documentElement?.toggleAttribute('data-vigil-playback-pending', Boolean(playerFrame && currentID() && (busy || (lease && waiting))));
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
  function clean() {
    if (!document.documentElement) return;
    updateHeldPlayer();
    document.documentElement.toggleAttribute('data-vigil-feed-pending', Boolean(feedName() && !state));
    mount();
    mountWatchLaterMenu();
    updateFinishedScreen();
    void filterNativeFeed();
    if (!document.getElementById('vigil-limits-style')) {
      const style = document.createElement('style'); style.id = 'vigil-limits-style';
      style.textContent = `html[data-vigil-feed-pending] :is(${nativeCardSelector}){display:none!important}` + 'a[href*="/shorts/"],ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-video-preview,ytm-video-preview,.ytp-autonav-toggle-button,.ytp-autonav-endscreen-countdown-container,[data-vigil-feed-hidden],html[data-vigil-feed-complete] ytd-continuation-item-renderer,html[data-vigil-feed-complete] ytm-continuation-item-renderer{display:none!important}';
      // Remove the desktop backdrop reserved for the hidden topic row.
      // Keep the native masthead controls and their normal 56px geometry.
      style.textContent += 'html[data-vigil-standard-feed] ytd-masthead #background,html[data-vigil-standard-feed] ytd-app #frosted-glass{height:var(--ytd-masthead-height,56px)!important;min-height:0!important;overflow:hidden!important}html[data-vigil-standard-feed] ytd-rich-grid-renderer #header{display:none!important}';
      style.textContent += 'html[data-vigil-saves-finished] body>:not(#vigil-youtube-finished):not(#vigil-youtube-limits):not(#vigil-youtube-notice):not(#vigil-watch-later-tools):not(style):not(script){display:none!important}html[data-vigil-saves-full] :is(ytd-watch-flexy #secondary,ytd-watch-next-secondary-results-renderer,ytm-watch-next-secondary-results-renderer,.ytp-endscreen-content,.ytp-ce-element,.ytp-pause-overlay,.ytp-suggestion-set){display:none!important}';
      style.textContent += `${unwantedShelfSelector},[data-vigil-shelf-hidden]{display:none!important}`;
      style.textContent += `html[data-vigil-standard-feed] :is(${feedModuleSelector}){display:none!important}`;
      // The mobile topic bar is fixed, but its wrapper still reserves 50–62px
      // above the first video after the bar is hidden. Collapse that wrapper
      // only on the feeds where we already remove its topic controls.
      style.textContent += 'html[data-vigil-standard-feed] ytm-rich-grid-renderer .rich-grid-sticky-header:has(ytm-feed-filter-chip-bar-renderer){display:none!important}';
      style.textContent += `html[data-vigil-standard-feed] :is(ytd-rich-item-renderer,ytm-rich-item-renderer):not(:has(:is(ytd-rich-grid-media,ytm-rich-grid-media,ytd-video-renderer,ytm-video-with-context-renderer,ytd-grid-video-renderer,ytm-compact-video-renderer,yt-lockup-view-model,ytm-lockup-view-model))){display:none!important}`;
      if (!topFrame) style.textContent += '.ytp-endscreen-content,.ytp-ce-element,.ytp-cards-button,.ytp-cards-teaser,.ytp-next-button,.ytp-playlist-menu-button,.ytp-pause-overlay,.ytp-suggestion-set,a[href*="feature=endscreen"]{display:none!important}';
      // YouTube owns control visibility and hit testing, including miniplayer
      // transitions. Forcing its hidden thumbnail/toolbar visible creates a
      // second, stale Play/Pause overlay over the real controls.
      style.textContent += 'html[data-vigil-playback-held] .ytp-spinner{display:none!important}';
      document.documentElement.append(style);
    }
    adoptReplacementPlayer();
    for (const media of document.querySelectorAll('video,audio')) {
      if (media.autoplay) media.autoplay = false;
      if (media.hasAttribute?.('autoplay')) media.removeAttribute('autoplay');
      if (!media.paused && (media !== playing || !lease || /^\/shorts\//.test(location.pathname))) media.pause();
    }

  }
  document.addEventListener('webkitbeginfullscreen', event => {
    if (!event.isTrusted || event.target !== currentVideo() || !currentID()) return;
    // Native full-screen Play has no DOM click. Entering the player arms the
    // same gated Play path, even before this video has played inline once.
    resumeMedia = event.target;
    intent = currentID();
  }, true);
  document.addEventListener('play', event => {
    if (event.target !== playing && event.target === currentVideo()) adoptReplacementPlayer(event.target, false);
    if (event.target !== playing || !lease || !wantsPlayback || currentID() !== lease.videoId || performance.now() >= deadline) {
      // A queued play event can arrive after Pause has already stopped media.
      // Only an actual native fullscreen start represents a new Play request.
      const nativeFullscreenPlay = event.isTrusted && !event.target.paused
        && event.target === resumeMedia && event.target.webkitDisplayingFullscreen
        && intent && intent === currentID();
      event.target.pause?.();
      // Native iOS fullscreen controls produce media events, not DOM clicks.
      // Only resume the same explicitly started video, and reacquire the normal
      // ledger authorization before allowing a single frame of playback.
      if (nativeFullscreenPlay) togglePlayback();
    }
    updateHeldPlayer();
  }, true);
  document.addEventListener('canplay', event => {
    if (!retryInterruptedPlay || event.target !== playing || !lease || intent !== currentID()
        || currentID() !== lease.videoId || performance.now() >= deadline) return;
    playAuthorized(playing);
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
  document.addEventListener('pause', event => {
    if (event.target !== playing || waiting || playing.seeking) return;
    sample(); retryInterruptedPlay = false; ++playAttempt; pendingPlay = null;
  }, true);
  document.addEventListener('click', event => {
    if (replayingSave || !event.isTrusted || !(event.target instanceof Element)) return;
    // A deliberate search result uses watch time without allocating Watch Later.
    // Persist the grant before same-tab navigation can tear down this bridge.
    const resultCard = event.target.closest('ytm-video-with-context-renderer,ytm-video-renderer,ytd-video-renderer,yt-lockup-view-model');
    const searchLink = location.pathname === '/results' && new URL(location.href).searchParams.get('search_query')?.trim()
      ? event.target.closest('a[href]') || (
        !event.target.closest('button,[role="button"],[role="menuitem"]')
          ? resultCard?.querySelector('a[href*="/watch?"],a[href*="/live/"]') : null
      ) : null;
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
    const playControl = event.target.closest(playControlSelector);
    if (playControl && currentID()) {
      // A tap on the playing surface belongs to YouTube's controls and seek
      // gestures; only its explicit Play/Pause buttons need direct toggling.
      if (playControl.tagName === 'VIDEO' && lease && playing && performance.now() < deadline) return;
      const press = pressedControl; pressedControl = null;
      const labelAtPress = press?.control === playControl && press.id === currentID()
        && performance.now() - press.at < 1500 ? press.label : controlLabel(playControl);
      const explicitPlay = /^play\b/i.test(labelAtPress)
        || playControl.matches?.('.ytp-large-play-button,.ytp-cued-thumbnail-overlay');
      const explicitPause = /^pause\b/i.test(labelAtPress);
      const applyControl = () => {
        if (explicitPause) pauseAuthorized();
        else if (explicitPlay && busy) { wantsPlayback = true; queuedStart = true; }
        else if (explicitPlay && lease && playing && lease.videoId === currentID() && performance.now() < deadline) {
          wantsPlayback = true; intent = currentID(); playAuthorized(playing);
        } else togglePlayback();
      };
      if (busy || (lease && playing && performance.now() < deadline)) {
        event.preventDefault(); event.stopImmediatePropagation();
        applyControl();
      } else {
        // Let the original trusted tap initialize YouTube and unlock WebKit
        // media. The play-event gate still pauses it until the ledger replies.
        applyControl();
      }
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
    if (busy) {
      if (settlingPlayback) { wantsPlayback = true; queuedStart = true; return; }
      if (wantsPlayback) { pauseAuthorized(); queuedStart = false; }
      else { wantsPlayback = true; queuedStart = true; }
      return;
    }
    if (lease && playing && performance.now() < deadline) {
      if (wantsPlayback && (!playing.paused || waiting || pendingPlay || retryInterruptedPlay)) pauseAuthorized();
      else { wantsPlayback = true; playAuthorized(playing); }
    } else {
      wantsPlayback = true;
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
    if (watchLaterTools?.dialog.open) return;
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
    if (watchLaterTools?.dialog.open) return;
    if (!event.isTrusted || event.key !== ' ' || !spacePress) return;
    event.preventDefault(); event.stopImmediatePropagation(); releaseSpace(true);
  }, true);
  window.addEventListener('blur', () => releaseSpace());
  window.addEventListener('pagehide', () => { bulkClearStopped = true; releaseSpace(); intent = ''; void stop().catch(() => {}); });
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
        preparation = null;
        watchLaterCheckedAt = -Infinity;
        refreshWatchLater();
        intent = ''; resumeMedia = null; wantsPlayback = false; queuedStart = false;
        void stop().then(() => request({ action: 'switch', videoId: currentID() })).catch(error => show(error.message));
      }
    }
    adoptReplacementPlayer();
    if (retryInterruptedPlay && wantsPlayback && playing?.readyState >= 3 && !playing.seeking) playAuthorized(playing);
    sample();
    if (lease && playing?.paused && !waiting) {
      idleSince ??= performance.now();
      if (!busy && performance.now() >= deadline - 1000) {
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
    updateHeldPlayer(); syncPlaybackClock();
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
  document.addEventListener('click', watchLaterMenuClick, true);
  if (topFrame && isolatedExtension) {
    const runtime = typeof browser !== 'undefined' ? browser.runtime : chrome.runtime;
    runtime.onMessage?.addListener(message => {
      if (message?.type === 'VIGIL_YOUTUBE_TOOLS') {
        void openWatchLaterTools();
        return Promise.resolve({ opened: true });
      }
      if (message?.type !== 'VIGIL_YOUTUBE_HEALTH') return undefined;
      return Promise.resolve({ loaded: true, allowanceLoaded: Boolean(state), watchLaterTools: true });
    });
  }
  setInterval(() => {
    if (playbackClock === null) playbackTick();
    void prepareCurrentVideo();
    clean();
  }, 500);
  function refreshWatchLater() {
    if (!topFrame || !/^(www\.|m\.)?youtube\.com$/.test(location.hostname) || document.hidden || watchLaterChanging) return;
    void reconcileWatchLater().catch(error => show(error.message));
  }
  window.addEventListener('focus', () => { watchLaterCheckedAt = -Infinity; refreshWatchLater(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { watchLaterCheckedAt = -Infinity; refreshWatchLater(); }
  });
  setInterval(() => {
    if (!lease && !busy) void request({ action: 'status' }).then(refreshWatchLater).catch(error => show(error.message));
  }, 30000);
  // A native installation check must test the working limiter and mounted
  // allowance, rather than the flag set before initialization has completed.
  window.__vigilYouTubeLimitsHealth = () => {
    clean(); render();
    return Boolean(state && panel?.isConnected && document.getElementById('vigil-limits-style'));
  };
  if (document.documentElement) clean();
  if (!document.body) document.addEventListener('DOMContentLoaded', clean, { once: true });
  refreshWatchLater();
  void prepareCurrentVideo();
})();
