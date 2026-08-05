(() => {
  'use strict';

  if (window.top !== window || window.__vigilYouTubeParityInstalled) return;
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (!allowedHosts.has(String(location.hostname || '').toLowerCase())) return;
  window.__vigilYouTubeParityInstalled = true;

  const PLAYER_RESPONSE_PATHS = new Set([
    '/youtubei/v1/player', '/youtubei/v1/get_watch', '/get_watch', '/playlist'
  ]);
  const PLAYER_AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];

  const playerResponseURL = value => {
    let raw = value;
    if (typeof Request !== 'undefined' && value instanceof Request) raw = value.url;
    else if (value instanceof URL) raw = value.href;
    let url;
    try { url = new URL(String(raw || ''), location.href); } catch { return false; }
    return url.protocol === 'https:' && (!url.port || url.port === '443')
      && allowedHosts.has(url.hostname.toLowerCase())
      && PLAYER_RESPONSE_PATHS.has(url.pathname);
  };

  const plainRecord = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const playablePlayerResponse = value => plainRecord(value)
    && plainRecord(value.videoDetails)
    && typeof value.videoDetails.videoId === 'string'
    && value.videoDetails.videoId.length > 0
    && (plainRecord(value.streamingData) || plainRecord(value.playabilityStatus));

  const collectPlayerAdFields = (value, targets, seen = new WeakSet()) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      return value.every(item => collectPlayerAdFields(item, targets, seen));
    }
    if (!plainRecord(value)) return false;
    if (playablePlayerResponse(value)) {
      for (const key of PLAYER_AD_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.configurable || !Array.isArray(descriptor.value)) return false;
        targets.push([value, key]);
      }
    }
    if (!Object.prototype.hasOwnProperty.call(value, 'playerResponse')) return true;
    const nested = value.playerResponse;
    if (!nested || typeof nested !== 'object') return false;
    return collectPlayerAdFields(nested, targets, seen);
  };

  const prunePlayerResponse = value => {
    const targets = [];
    try {
      if (!collectPlayerAdFields(value, targets) || targets.length === 0) return false;
      for (const [target, key] of targets) {
        if (!Reflect.deleteProperty(target, key)) return false;
      }
      return true;
    } catch {
      return false;
    }
  };

  const clonedPrunedPlayerResponse = value => {
    try {
      const clone = JSON.parse(JSON.stringify(value));
      return prunePlayerResponse(clone) ? clone : null;
    } catch {
      return null;
    }
  };

  const rewrittenHeaders = response => {
    const headers = new Headers(response.headers);
    for (const name of [
      'content-encoding', 'content-length', 'content-md5', 'content-range',
      'digest', 'etag', 'transfer-encoding'
    ]) headers.delete(name);
    return headers;
  };

  const eligiblePlayerResponse = response => {
    if (!(response instanceof Response) || response.bodyUsed || response.status !== 200
        || response.redirected || !['basic', 'cors', 'default'].includes(response.type)) return false;
    if (response.url && !playerResponseURL(response.url)) return false;
    return /(?:^|[/+])json(?:\s*;|$)/i.test(response.headers.get('content-type') || '');
  };

  const rewrittenPlayerResponse = responseBefore => {
    if (!eligiblePlayerResponse(responseBefore)) return Promise.resolve(responseBefore);
    return responseBefore.clone().json()
      .then(payload => {
        if (!prunePlayerResponse(payload)) return responseBefore;
        const responseAfter = new Response(JSON.stringify(payload), {
          status: responseBefore.status,
          statusText: responseBefore.statusText,
          headers: rewrittenHeaders(responseBefore)
        });
        for (const property of ['ok', 'redirected', 'type', 'url']) {
          try {
            Object.defineProperty(responseAfter, property, {
              configurable: true,
              value: responseBefore[property]
            });
          } catch {}
        }
        return responseAfter;
      })
      .catch(() => responseBefore);
  };

  const installFetchPlayerResponseGuard = () => {
    if (typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch;
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        if (!playerResponseURL(argumentsList[0])) return result;
        return result.then(rewrittenPlayerResponse, () => result);
      }
    });
  };

  const installXHRPlayerResponseGuard = () => {
    const NativeXHR = window.XMLHttpRequest;
    if (typeof NativeXHR !== 'function') return;
    const guardedRequests = new WeakMap();
    window.XMLHttpRequest = class extends NativeXHR {
      open(method, url, ...rest) {
        guardedRequests.delete(this);
        if (playerResponseURL(url)) guardedRequests.set(this, { cached: undefined, raw: undefined });
        return super.open(method, url, ...rest);
      }

      get response() {
        const raw = super.response;
        const state = guardedRequests.get(this);
        if (!state || this.readyState !== 4) return raw;
        if ((Number(this.status) || 0) !== 200) return raw;
        const responseURL = String(this.responseURL || '');
        if (responseURL && !playerResponseURL(responseURL)) return raw;
        const contentType = String(this.getResponseHeader?.('content-type') || '');
        if (contentType && !/(?:^|[/+])json(?:\s*;|$)/i.test(contentType)) return raw;
        if (!['', 'text', 'json'].includes(String(this.responseType || ''))) return raw;
        if (state.raw === raw && state.cached !== undefined) return state.cached;
        state.raw = raw;
        let payload;
        let wasText = false;
        if (typeof raw === 'string') {
          try {
            payload = JSON.parse(raw);
            wasText = true;
          } catch {
            state.cached = raw;
            return raw;
          }
        } else {
          payload = clonedPrunedPlayerResponse(raw);
          if (!payload) {
            state.cached = raw;
            return raw;
          }
        }
        if (wasText && (!payload || typeof payload !== 'object' || !prunePlayerResponse(payload))) {
          state.cached = raw;
          return raw;
        }
        state.cached = wasText ? JSON.stringify(payload) : payload;
        return state.cached;
      }

      get responseText() {
        const guarded = this.response;
        return typeof guarded === 'string' ? guarded : super.responseText;
      }
    };
  };

  const installInitialPlayerResponseGuard = () => {
    const key = 'ytInitialPlayerResponse';
    const descriptor = Object.getOwnPropertyDescriptor(window, key);
    if (descriptor) {
      if ('value' in descriptor && descriptor.configurable) {
        const sanitized = clonedPrunedPlayerResponse(descriptor.value);
        if (sanitized) {
          try { Object.defineProperty(window, key, { ...descriptor, value: sanitized }); } catch {}
        }
      }
      return;
    }
    let current;
    try {
      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: value => {
          current = clonedPrunedPlayerResponse(value) || value;
        }
      });
    } catch {}
  };

  installFetchPlayerResponseGuard();
  installXHRPlayerResponseGuard();
  installInitialPlayerResponseGuard();

  const MINI_ATTRIBUTE = 'data-vigil-youtube-miniplayer';
  const NATIVE_MINI_ATTRIBUTE = 'data-vigil-youtube-native-miniplayer';
  const SHELL_ID = 'vigil-youtube-miniplayer-shell';
  const HIDDEN_HANDLE_ID = 'vigil-youtube-miniplayer-handle';
  const HISTORY_STATE_KEY = '__vigilYouTubeMiniplayer';
  const HISTORY_MARKER_KIND = 'vigil-youtube-miniplayer-history-v1';
  const STYLE_ID = 'vigil-youtube-parity-style';
  const MORE_VIDEOS_ATTRIBUTE = 'data-vigil-youtube-more-videos';
  const WATCH_SELECTOR = 'ytm-watch, ytd-watch-flexy, [page-subtype="watch"]';
  const PLAYER_SELECTOR = 'ytm-player, ytd-player, #player-container-id, #player';
  const SEEK_CONTROL_SELECTOR = [
    '[role="slider"]', '[aria-valuenow]', 'input[type="range"]',
    '.ytp-progress-bar', '.ytp-progress-list', '.ytp-scrubber-container'
  ].join(',');
  const FORM_CONTROL_SELECTOR = 'a, input, textarea, select';
  const AD_PLAYER_STATE_SELECTOR = '.ad-showing, .ad-interrupting';
  const COSMETIC_AD_SURFACE_SELECTOR = [
    'ytm-promoted-sparkles-web-renderer', 'ytd-promoted-sparkles-web-renderer',
    'ytm-companion-ad-renderer', 'ytd-companion-slot-renderer',
    'ytm-display-ad-renderer', 'ytd-display-ad-renderer',
    'ytm-promoted-video-renderer', 'ytd-promoted-video-renderer',
    'ytm-ad-slot-renderer', 'ytd-ad-slot-renderer',
    'ytm-in-feed-ad-layout-renderer', 'ytd-in-feed-ad-layout-renderer',
    'ytd-banner-promo-renderer', '#masthead-ad'
  ].join(',');
  const AD_SKIP_SELECTOR = [
    '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern',
    '.ytp-skip-ad-button', '.ytp-ad-skip-button-container button',
    'button[aria-label^="Skip ad" i]', 'button[aria-label^="Skip ads" i]'
  ].join(',');
  const EDGE_GESTURE_WIDTH = 24;
  const html = document.documentElement;
  const miniPointers = new Map();

  let gesture = null;
  let pinchGesture = null;
  let miniPlayer = null;
  let miniVideo = null;
  let miniVideoID = '';
  let miniWatchURL = '';
  let miniOriginMarker = null;
  let miniSessionID = '';
  let miniRouteIndex = null;
  let miniRouteURLs = [];
  let miniObservedHistoryLength = 0;
  let miniOriginalPushState = null;
  let miniOriginalReplaceState = null;
  let miniInstalledPushState = null;
  let miniInstalledReplaceState = null;
  let miniHistoryMutationSerial = 0;
  let miniOriginHistoryMarkerWritten = false;
  let miniWasPlaying = false;
  let miniEndedHandler = null;
  let hiddenPlayerWasPlaying = false;
  let restoreMode = null;
  let restoreTargetURL = '';
  let restoreGeneration = 0;
  let restoreFallbackStartURL = '';
  let restoreFallbackMutationSerial = 0;
  let pendingDestinationWatch = false;
  let miniTapTimer = 0;
  let restoreFallbackTimer = 0;
  let restoreSettleTimer = 0;
  let restoreSettleAttempts = 0;
  let restoreCandidateWatch = null;
  let restoreCandidateSince = 0;
  let browseTransitionTimer = 0;
  let browseTransitionAttempts = 0;
  let lastMiniTapAt = 0;
  let suppressShellClickUntil = 0;
  let ignoreMediaPauseUntil = 0;
  let routePlaybackTransitionUntil = 0;
  let lastPlaybackResumeAttemptAt = 0;
  let playbackRecoveryTimer = 0;
  let adAuditTimer = 0;
  let adEpochPlayer = null;
  let attemptedSkipControl = null;
  let observedAdPlayer = null;
  let adPlayerStateObserver = null;
  let observedMoreVideosPlayerState = [];
  let moreVideosPlayerStateObserver = null;
  let nativeMiniPlayer = null;
  let lastRoute = location.href;
  let suppressPlayerClickUntil = 0;

  const decodedPath = value => {
    let pathname = String(value || '/');
    for (let pass = 0; pass < 3; pass += 1) {
      try {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      } catch {
        break;
      }
    }
    return pathname.replace(/\\+/g, '/').toLowerCase();
  };

  const decodedPathname = () => decodedPath(location.pathname);
  const isShortsPath = pathname => /(?:^|\/)shorts(?:\/|$)/.test(decodedPath(pathname));
  const isShortsRoute = () => isShortsPath(location.pathname);
  const isWatchRoute = () => decodedPathname() === '/watch';
  const focusedEntryURL = 'https://m.youtube.com/feed/subscriptions';

  const recoverFromShorts = () => {
    if (!isShortsRoute()) return false;
    try {
      location.replace(focusedEntryURL);
    } catch {
      location.href = focusedEntryURL;
    }
    return true;
  };

  if (recoverFromShorts()) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    html[${MINI_ATTRIBUTE}="true"] {
      --vigil-youtube-mini-width: clamp(176px, 56vw, 224px);
      --vigil-youtube-mini-bottom: calc(env(safe-area-inset-bottom, 0px) + 68px);
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] {
      position: absolute !important;
      z-index: 0 !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
      margin: 0 !important;
      border-radius: inherit !important;
      overflow: hidden !important;
      background: #000 !important;
      box-shadow: none !important;
      transform: none !important;
      transition: none !important;
      touch-action: none !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] video {
      width: 100% !important;
      height: 100% !important;
      object-fit: cover !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] :is(
      #player-container-id, #player, .html5-video-player, .html5-video-container
    ) {
      position: absolute !important;
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      min-width: 0 !important;
      min-height: 0 !important;
      max-width: none !important;
      max-height: none !important;
    }
    html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"] :is(
      .ytp-chrome-bottom, .ytp-chrome-top, .ytp-gradient-bottom, .ytp-gradient-top,
      .ytp-pause-overlay, .ytp-ce-element, .ytp-cued-thumbnail-overlay,
      .ytp-spinner, .ytp-bezel, .ytp-paid-content-overlay
    ) {
      display: none !important;
    }
    ${COSMETIC_AD_SURFACE_SELECTOR} {
      display: none !important;
    }
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-player, ytd-player, .html5-video-player
    ) :is(
      .ytp-more-videos-button, .ytp-more-videos-view, .ytp-fullscreen-grid,
      .ytp-pause-overlay, .ytp-pause-overlay-container, .ytp-endscreen-content
    ) {
      /* Keep YouTube's fullscreen-grid component measurable while suppressed.
         Its expand control is initialized inside this tree and can remain inert
         after an initial display:none layout, even once landscape fullscreen
         makes the grid eligible again. */
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-fullscreen-related-videos-entry-point-view-model,
      .ytmFullscreenRelatedVideosEntryPointViewModelHost,
      .fullscreen-watch-next-entrypoint-wrapper,
      .fullscreen-more-videos-endpoint,
      .fullscreen-recommendations-wrapper,
      .fullscreen-recommendation,
      .ytFullscreenVideoRecommendationsHost,
      .ytFullscreenVideoRecommendationsRecommendation
    ) {
      visibility: hidden !important;
      opacity: 0 !important;
      pointer-events: none !important;
    }
    html[${NATIVE_MINI_ATTRIBUTE}="true"],
    html[${NATIVE_MINI_ATTRIBUTE}="true"] body {
      width: 100% !important;
      height: 100% !important;
      min-height: 0 !important;
      margin: 0 !important;
      overflow: hidden !important;
      background: #000 !important;
    }
    html[${NATIVE_MINI_ATTRIBUTE}="true"] body > :not(:has([data-vigil-youtube-native-player="true"])) {
      display: none !important;
    }
    html[${NATIVE_MINI_ATTRIBUTE}="true"] [data-vigil-youtube-native-player="true"] {
      position: fixed !important;
      z-index: 2147483647 !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      min-width: 0 !important;
      min-height: 0 !important;
      margin: 0 !important;
      overflow: hidden !important;
      background: #000 !important;
      transform: none !important;
    }
    html[${NATIVE_MINI_ATTRIBUTE}="true"] [data-vigil-youtube-native-player="true"] video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
    }
    #${SHELL_ID} {
      all: initial;
      box-sizing: border-box;
      position: fixed;
      z-index: 2147483646;
      right: 12px;
      bottom: var(--vigil-youtube-mini-bottom);
      width: var(--vigil-youtube-mini-width);
      aspect-ratio: 16 / 9;
      display: block;
      padding: 0;
      border: 0;
      border-radius: 12px;
      overflow: hidden;
      color: #fff;
      background: #000;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .34);
      -webkit-user-select: none;
      user-select: none;
      touch-action: none;
      transition: width 180ms ease, height 180ms ease, opacity 180ms ease;
    }
    #${SHELL_ID}[data-size="large"] {
      --vigil-youtube-mini-width: min(calc(100vw - 24px), 344px);
    }
    #${SHELL_ID} button {
      all: initial;
      box-sizing: border-box;
      position: absolute;
      z-index: 2;
      top: 7px;
      width: 36px;
      height: 36px;
      display: grid;
      place-items: center;
      color: #fff;
      border-radius: 50%;
      background: rgba(0, 0, 0, .62);
      font: 600 20px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      text-align: center;
      -webkit-tap-highlight-color: transparent;
    }
    #${SHELL_ID} .vigil-youtube-mini-play { left: 7px; }
    #${SHELL_ID} .vigil-youtube-mini-close { right: 7px; }
    #${SHELL_ID} button:focus-visible {
      outline: 2px solid #fff;
      outline-offset: 2px;
    }
    #${HIDDEN_HANDLE_ID} {
      all: initial;
      box-sizing: border-box;
      position: fixed;
      z-index: 2147483646;
      top: var(--vigil-youtube-hidden-top, 55%);
      width: 30px;
      height: 52px;
      display: grid;
      place-items: center;
      border: 0;
      color: #fff;
      background: rgba(20, 20, 20, .96);
      box-shadow: 0 6px 18px rgba(0, 0, 0, .34);
      font: 600 26px/1 -apple-system, BlinkMacSystemFont, sans-serif;
      -webkit-tap-highlight-color: transparent;
    }
    #${HIDDEN_HANDLE_ID}[data-side="left"] {
      left: 0;
      border-radius: 0 12px 12px 0;
    }
    #${HIDDEN_HANDLE_ID}[data-side="right"] {
      right: 0;
      border-radius: 12px 0 0 12px;
    }
    :is(ytm-player, ytd-player),
    :is(ytm-player, ytd-player) :is(video, .html5-video-container, .ytp-cued-thumbnail-overlay-image) {
      touch-action: pan-x pinch-zoom !important;
    }
    @media (prefers-reduced-motion: reduce) {
      html[${MINI_ATTRIBUTE}="true"] [data-vigil-youtube-active-player="true"],
      #${SHELL_ID}, #${HIDDEN_HANDLE_ID} { transition: none !important; }
    }
  `;

  const installStyle = () => {
    if (!document.getElementById(STYLE_ID)) {
      (document.head || document.documentElement).append(style);
    }
  };

  const videoID = () => new URL(location.href).searchParams.get('v') || '';

  const mainVideo = () => {
    const videos = Array.from(document.querySelectorAll('video'));
    return videos
      .filter(video => {
        const rect = video.getBoundingClientRect();
        return rect.width >= 180 && rect.height >= 90;
      })
      .sort((left, right) => {
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftPlayer = left.closest(PLAYER_SELECTOR) ? 10_000_000 : 0;
        const rightPlayer = right.closest(PLAYER_SELECTOR) ? 10_000_000 : 0;
        return (rightPlayer + rightRect.width * rightRect.height)
          - (leftPlayer + leftRect.width * leftRect.height);
      })[0] || null;
  };

  const playerForVideo = video => {
    if (!video) return null;
    // Move the outer player host. Moving the inner #player leaves it clipped
    // by ytm-player's overflow/transform containment on the live mobile site.
    return video.closest('ytm-player')
      || video.closest('ytd-player')
      || video.closest('#player-container-id')
      || video.closest('#player')
      || video.parentElement;
  };

  const videoIsFullscreen = video => Boolean(
    document.fullscreenElement
      || document.webkitFullscreenElement
      || video?.webkitDisplayingFullscreen
  );

  const moreVideosAllowedForState = (fullscreen, width, height) => Boolean(
    fullscreen && Number(width) > Number(height) && Number(height) > 0
  );

  const playerIsExpandedFullscreen = video => videoIsFullscreen(video)
    || Boolean(video?.closest(
      '.html5-video-player.ytp-fullscreen, ytm-player[fullscreen], ytd-player[fullscreen]'
    ));

  const observeMoreVideosPlayerState = video => {
    const candidates = [
      video?.closest('.html5-video-player'),
      video?.closest('ytm-player'),
      video?.closest('ytd-player')
    ].filter((element, index, all) => element && all.indexOf(element) === index);
    if (candidates.length === observedMoreVideosPlayerState.length
        && candidates.every((element, index) => element === observedMoreVideosPlayerState[index])) return;
    moreVideosPlayerStateObserver?.disconnect();
    observedMoreVideosPlayerState = candidates;
    moreVideosPlayerStateObserver = new MutationObserver(scheduleMoreVideosAvailability);
    candidates.forEach(element => moreVideosPlayerStateObserver.observe(element, {
      attributes: true,
      attributeFilter: ['class', 'fullscreen']
    }));
  };

  const updateMoreVideosAvailability = () => {
    const video = mainVideo();
    observeMoreVideosPlayerState(video);
    const viewport = window.visualViewport;
    const width = Number(viewport?.width || innerWidth || 0);
    const height = Number(viewport?.height || innerHeight || 0);
    const allowed = moreVideosAllowedForState(
      playerIsExpandedFullscreen(video), width, height
    );
    html.setAttribute(MORE_VIDEOS_ATTRIBUTE, allowed ? 'allowed' : 'suppressed');
    return allowed;
  };

  const scheduleMoreVideosAvailability = () => {
    installStyle();
    updateMoreVideosAvailability();
    requestAnimationFrame(updateMoreVideosAvailability);
    setTimeout(updateMoreVideosAvailability, 180);
  };

  const enterFullscreen = video => {
    if (!video || videoIsFullscreen(video)) return false;
    const player = playerForVideo(video);
    const control = player?.querySelector(
      '.ytp-fullscreen-button, button[aria-label*="full screen" i], button[title*="full screen" i]'
    );
    try {
      if (control instanceof HTMLElement) control.click();
      else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
      else if (typeof video.requestFullscreen === 'function') void video.requestFullscreen();
      else return false;
      return true;
    } catch {
      return false;
    }
  };

  const blocksPlayerGesture = (target, player, point) => {
    if (!target || !player || !point) return true;
    if (target.closest(SEEK_CONTROL_SELECTOR) || target.closest(FORM_CONTROL_SELECTOR)) return true;
    const button = target.closest('button, [role="button"]');
    if (!button || !player.contains(button)) return false;
    const buttonRect = button.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    // YouTube sometimes implements the whole video canvas as an invisible
    // button. Preserve real, compact controls but do not let that full-player
    // hit target make the swipe unreachable.
    return buttonRect.width < playerRect.width * .72
      || buttonRect.height < playerRect.height * .72;
  };

  const blocksMiniInteraction = (target, point) => {
    if (!target) return true;
    if (target.closest('.vigil-youtube-mini-play, .vigil-youtube-mini-close')) return true;
    return Boolean(miniPlayer?.contains(target) && blocksPlayerGesture(target, miniPlayer, point || {}));
  };

  const canDecorateHistoryState = state => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
    if (Object.prototype.toString.call(state) !== '[object Object]') return false;
    const prototype = Object.getPrototypeOf(state);
    if (prototype === null || prototype === Object.prototype) return true;
    const constructor = prototype.constructor;
    // WKWebView can expose structured-cloned route dictionaries through a
    // platform realm whose Object constructor is not reference-equal to this
    // script's Object. Keep those records eligible without flattening Date,
    // Map, Set, Array, or other tagged structured-clone values.
    return constructor == null || constructor.name === 'Object';
  };

  const isMiniHistoryMarker = marker => Boolean(
    marker && typeof marker === 'object'
      && marker.kind === HISTORY_MARKER_KIND
      && typeof marker.session === 'string'
      && Number.isInteger(marker.index)
      && typeof marker.hadPrevious === 'boolean'
  );

  const currentMiniHistoryMarker = () => {
    const state = history.state;
    if (!canDecorateHistoryState(state)) return null;
    const marker = state[HISTORY_STATE_KEY];
    return isMiniHistoryMarker(marker) ? marker : null;
  };

  const decoratedMiniHistoryState = (state, index) => {
    if (!canDecorateHistoryState(state)) return null;
    const nextState = { ...state };
    const existing = state[HISTORY_STATE_KEY];
    const activeMarker = isMiniHistoryMarker(existing) && existing.session === miniSessionID
      ? existing
      : null;
    const hadPrevious = activeMarker
      ? activeMarker.hadPrevious
      : Object.prototype.hasOwnProperty.call(state, HISTORY_STATE_KEY);
    const marker = {
      kind: HISTORY_MARKER_KIND,
      session: miniSessionID,
      index,
      hadPrevious
    };
    if (hadPrevious) marker.previous = activeMarker ? activeMarker.previous : existing;
    nextState[HISTORY_STATE_KEY] = marker;
    return nextState;
  };

  const restoredMiniHistoryState = state => {
    if (!canDecorateHistoryState(state)) return null;
    const marker = state[HISTORY_STATE_KEY];
    if (!isMiniHistoryMarker(marker)) return null;
    const nextState = { ...state };
    if (marker.hadPrevious) nextState[HISTORY_STATE_KEY] = marker.previous;
    else delete nextState[HISTORY_STATE_KEY];
    return nextState;
  };

  const installMiniHistoryTracking = () => {
    if (miniOriginalPushState || miniOriginalReplaceState) return;
    miniOriginalPushState = history.pushState;
    miniOriginalReplaceState = history.replaceState;
    const originalPushState = miniOriginalPushState;
    const originalReplaceState = miniOriginalReplaceState;
    miniInstalledPushState = function pushVigilMiniState(state, title, url) {
      if (!miniSessionID) return originalPushState.call(this, state, title, url);
      const nextIndex = Number.isInteger(miniRouteIndex)
        ? miniRouteIndex + 1
        : null;
      const nextState = Number.isInteger(nextIndex) && canDecorateHistoryState(state)
        ? decoratedMiniHistoryState(state, nextIndex) || state
        : state;
      const result = originalPushState.call(this, nextState, title, url);
      miniHistoryMutationSerial += 1;
      if (Number.isInteger(nextIndex)) {
        miniRouteIndex = nextIndex;
        miniRouteURLs = miniRouteURLs.slice(0, nextIndex);
        miniRouteURLs[nextIndex] = location.href;
      } else miniRouteIndex = null;
      miniObservedHistoryLength = history.length;
      return result;
    };
    miniInstalledReplaceState = function replaceVigilMiniState(state, title, url) {
      if (!miniSessionID) return originalReplaceState.call(this, state, title, url);
      const marker = currentMiniHistoryMarker();
      const trackedIndex = Number.isInteger(miniRouteIndex)
          && miniRouteURLs[miniRouteIndex] === location.href
        ? miniRouteIndex
        : null;
      const index = marker?.session === miniSessionID ? marker.index : trackedIndex;
      const nextState = Number.isInteger(index) && canDecorateHistoryState(state)
        ? decoratedMiniHistoryState(state, index) || state
        : state;
      const result = originalReplaceState.call(this, nextState, title, url);
      miniHistoryMutationSerial += 1;
      if (Number.isInteger(index)) {
        miniRouteIndex = index;
        miniRouteURLs[index] = location.href;
      } else miniRouteIndex = null;
      return result;
    };
    history.pushState = miniInstalledPushState;
    history.replaceState = miniInstalledReplaceState;
  };

  const uninstallMiniHistoryTracking = () => {
    if (miniOriginalPushState && history.pushState === miniInstalledPushState) {
      history.pushState = miniOriginalPushState;
    }
    if (miniOriginalReplaceState && history.replaceState === miniInstalledReplaceState) {
      history.replaceState = miniOriginalReplaceState;
    }
    miniOriginalPushState = null;
    miniOriginalReplaceState = null;
    miniInstalledPushState = null;
    miniInstalledReplaceState = null;
  };

  const writeMiniHistoryMarker = index => {
    if (!miniSessionID || !Number.isInteger(index)) return false;
    const nextState = decoratedMiniHistoryState(history.state, index);
    if (!nextState) return false;
    const replaceState = miniOriginalReplaceState || history.replaceState;
    try {
      replaceState.call(history, nextState, '', location.href);
      return true;
    } catch {
      return false;
    }
  };

  const clearCurrentMiniHistoryMarker = () => {
    const marker = currentMiniHistoryMarker();
    if (!marker || marker.session !== miniSessionID) return;
    const nextState = restoredMiniHistoryState(history.state);
    if (!nextState) return;
    const replaceState = miniOriginalReplaceState || history.replaceState;
    try { replaceState.call(history, nextState, '', location.href); } catch {}
  };

  const clearStaleMiniHistoryMarkers = () => {
    for (let pass = 0; pass < 4; pass += 1) {
      const marker = currentMiniHistoryMarker();
      if (!marker || marker.session === miniSessionID) return;
      const nextState = restoredMiniHistoryState(history.state);
      if (!nextState) return;
      const replaceState = miniOriginalReplaceState || history.replaceState;
      try { replaceState.call(history, nextState, '', location.href); } catch { return; }
    }
  };

  const reconcilePopRouteIndex = ({
    currentLength, observedLength, routeIndex, currentURL, routeURLs, markerIndex
  }) => {
    if (!Number.isInteger(routeIndex) || currentLength !== observedLength) return null;
    if (Number.isInteger(markerIndex)) {
      // A traversal must change entries. An equal marker can only be stale or
      // copied by a router that retained the native pushState function.
      return markerIndex !== routeIndex ? markerIndex : null;
    }
    const candidates = routeURLs
      .map((url, index) => (url === currentURL && index !== routeIndex ? index : -1))
      .filter(index => index >= 0);
    return candidates.length === 1 ? candidates[0] : null;
  };

  const syncMiniHistoryRoute = event => {
    const marker = currentMiniHistoryMarker();
    const currentURL = location.href;
    const isPopState = event?.type === 'popstate';
    const markerIndex = marker?.session === miniSessionID
        && miniRouteURLs[marker.index] === currentURL
      ? marker.index
      : null;
    if (isPopState) {
      // Reconcile traversals before considering growth. If history grew
      // without our wrapper observing it, no Back distance is safe to infer.
      miniRouteIndex = reconcilePopRouteIndex({
        currentLength: history.length,
        observedLength: miniObservedHistoryLength,
        routeIndex: miniRouteIndex,
        currentURL,
        routeURLs: miniRouteURLs,
        markerIndex
      });
      miniObservedHistoryLength = history.length;
      return;
    }
    if (Number.isInteger(miniRouteIndex)
        && history.length > miniObservedHistoryLength) {
      // On non-traversal events, growth is the strongest signal. A page
      // router can cache native pushState and copy the prior entry's marker.
      const nextIndex = miniRouteIndex + history.length - miniObservedHistoryLength;
      miniRouteURLs = miniRouteURLs.slice(0, nextIndex);
      miniRouteURLs[nextIndex] = currentURL;
      miniRouteIndex = nextIndex;
      writeMiniHistoryMarker(nextIndex);
    } else if (history.length === miniObservedHistoryLength
        && Number.isInteger(miniRouteIndex)
        && miniRouteURLs[miniRouteIndex] === currentURL) {
      // The wrapped page router already recorded this route.
    } else {
      // A cached native replaceState or unobserved router mutation cannot be
      // placed safely. Fall back to the saved Watch URL rather than risk a
      // Back operation that leaves YouTube.
      miniRouteIndex = null;
    }
    miniObservedHistoryLength = history.length;
  };

  const markRoutePlaybackTransition = () => {
    // Live m.youtube.com can issue several pause() calls while its Polymer
    // router swaps Watch for Browse. Preserve the user's playing intent for
    // the whole transition; the old one-pause/350ms allowance expired before
    // slower phones finished rendering Home.
    routePlaybackTransitionUntil = performance.now() + 3200;
  };

  const pauseMiniVideoInternally = () => {
    ignoreMediaPauseUntil = performance.now() + 800;
    try { miniVideo?.pause(); } catch {}
  };

  const handleMiniVideoPlay = event => {
    if (event.currentTarget !== miniVideo) return;
    miniWasPlaying = true;
    syncPlayButton();
  };

  const handleMiniVideoPause = event => {
    if (event.currentTarget !== miniVideo) return;
    const now = performance.now();
    if (now <= routePlaybackTransitionUntil && miniWasPlaying) {
      scheduleMiniPlaybackRecovery();
    } else if (now > ignoreMediaPauseUntil) {
      miniWasPlaying = false;
    }
    syncPlayButton();
  };

  const maintainMiniPlayback = (force = false) => {
    if (!html.hasAttribute(MINI_ATTRIBUTE)
        || html.hasAttribute('data-vigil-youtube-miniplayer-hidden')
        || !miniWasPlaying || !miniVideo?.paused || miniVideo.ended) return;
    const now = performance.now();
    if (!force && now - lastPlaybackResumeAttemptAt < 300) return;
    lastPlaybackResumeAttemptAt = now;
    try {
      const result = miniVideo.play();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {}
  };

  const scheduleMiniPlaybackRecovery = () => {
    if (playbackRecoveryTimer || !miniWasPlaying) return;
    playbackRecoveryTimer = setTimeout(() => {
      playbackRecoveryTimer = 0;
      maintainMiniPlayback(true);
      if (miniWasPlaying && miniVideo?.paused
          && performance.now() <= routePlaybackTransitionUntil) {
        scheduleMiniPlaybackRecovery();
      }
    }, 90);
  };

  const visibleElement = element => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const activeAdPlayer = () => Array.from(document.querySelectorAll(AD_PLAYER_STATE_SELECTOR))
    .find(player => player.querySelector('video')) || null;

  const enabledSkipControl = element => visibleElement(element)
    && !element.matches(':disabled, [aria-disabled="true"]');

  const suppressYouTubeAds = () => {
    const player = activeAdPlayer();
    if (!player) {
      adEpochPlayer = null;
      attemptedSkipControl = null;
      return false;
    }
    if (player !== adEpochPlayer) {
      adEpochPlayer = player;
      attemptedSkipControl = null;
    }
    observeAdPlayerState(player);
    const skip = Array.from(player.querySelectorAll(AD_SKIP_SELECTOR))
      .find(enabledSkipControl);
    if (!(skip instanceof HTMLElement)) {
      // YouTube can reuse the same button for a later ad after hiding or
      // disabling it. Re-arm only after that control leaves its clickable
      // state; never hammer a still-visible control once per audit interval.
      if (attemptedSkipControl && !enabledSkipControl(attemptedSkipControl)) {
        attemptedSkipControl = null;
      }
      return false;
    }
    if (skip === attemptedSkipControl) return false;
    attemptedSkipControl = skip;
    try {
      skip.click();
      return true;
    } catch {
      attemptedSkipControl = null;
      return false;
    }
  };

  const scheduleAdAudit = () => {
    if (adAuditTimer) return;
    adAuditTimer = setTimeout(() => {
      adAuditTimer = 0;
      suppressYouTubeAds();
    }, 80);
  };

  const observeAdPlayerState = player => {
    if (player === observedAdPlayer) return;
    adPlayerStateObserver?.disconnect();
    observedAdPlayer = player;
    adPlayerStateObserver = new MutationObserver(records => {
      const changed = records.some(record => {
        const wasActive = /(?:^|\s)(?:ad-showing|ad-interrupting)(?:\s|$)/
          .test(String(record.oldValue || ''));
        const isActive = record.target instanceof Element
          && record.target.matches(AD_PLAYER_STATE_SELECTOR);
        return wasActive !== isActive;
      });
      if (!changed) return;
      adEpochPlayer = null;
      attemptedSkipControl = null;
      scheduleAdAudit();
    });
    adPlayerStateObserver.observe(player, {
      attributes: true,
      attributeFilter: ['class'],
      attributeOldValue: true
    });
  };

  const clearDrag = () => {
    document.getElementById(SHELL_ID)?.style.removeProperty('opacity');
  };

  const setDrag = (x, y) => {
    const shell = document.getElementById(SHELL_ID);
    const start = gesture?.startRect;
    if (!shell || !start) return;
    const maximumLeft = Math.max(8, innerWidth - start.width - 8);
    const maximumTop = Math.max(8, innerHeight - start.height - 8);
    const left = Math.max(8, Math.min(maximumLeft, start.left + x));
    const top = Math.max(8, Math.min(maximumTop, start.top + y));
    shell.style.left = `${left}px`;
    shell.style.top = `${top}px`;
    shell.style.right = 'auto';
    shell.style.bottom = 'auto';
    if (Math.abs(x) > 18) {
      shell.style.opacity = String(Math.max(.4, 1 - Math.abs(x) / Math.max(innerWidth, 320)));
    }
  };

  const destroyMiniChrome = () => {
    document.getElementById(HIDDEN_HANDLE_ID)?.remove();
    document.getElementById(SHELL_ID)?.remove();
  };

  const resetMiniState = () => {
    clearTimeout(miniTapTimer);
    clearTimeout(restoreFallbackTimer);
    clearTimeout(restoreSettleTimer);
    clearTimeout(browseTransitionTimer);
    clearTimeout(playbackRecoveryTimer);
    miniTapTimer = 0;
    restoreFallbackTimer = 0;
    restoreSettleTimer = 0;
    restoreSettleAttempts = 0;
    restoreCandidateWatch = null;
    restoreCandidateSince = 0;
    browseTransitionTimer = 0;
    playbackRecoveryTimer = 0;
    browseTransitionAttempts = 0;
    lastMiniTapAt = 0;
    restoreGeneration += 1;
    restoreMode = null;
    restoreTargetURL = '';
    restoreFallbackStartURL = '';
    restoreFallbackMutationSerial = 0;
    pendingDestinationWatch = false;
    miniPointers.clear();
    pinchGesture = null;
    miniOriginMarker?.remove();
    miniOriginMarker = null;
    clearDrag();
    html.removeAttribute(MINI_ATTRIBUTE);
    html.removeAttribute('data-vigil-youtube-miniplayer-hidden');
    miniPlayer?.removeAttribute('data-vigil-youtube-active-player');
    if (miniVideo) {
      miniVideo.removeEventListener('play', handleMiniVideoPlay);
      miniVideo.removeEventListener('pause', handleMiniVideoPause);
      if (miniEndedHandler) miniVideo.removeEventListener('ended', miniEndedHandler);
    }
    miniEndedHandler = null;
    clearCurrentMiniHistoryMarker();
    uninstallMiniHistoryTracking();
    miniPlayer = null;
    miniVideo = null;
    miniVideoID = '';
    miniWatchURL = '';
    miniSessionID = '';
    miniRouteIndex = null;
    miniRouteURLs = [];
    miniObservedHistoryLength = 0;
    miniHistoryMutationSerial = 0;
    miniOriginHistoryMarkerWritten = false;
    miniWasPlaying = false;
    hiddenPlayerWasPlaying = false;
    ignoreMediaPauseUntil = 0;
    routePlaybackTransitionUntil = 0;
    lastPlaybackResumeAttemptAt = 0;
  };

  const isRenderedWatchSurface = watch => {
    if (!(watch instanceof Element) || watch.closest('[hidden]')) return false;
    for (let node = watch; node instanceof Element; node = node.parentElement) {
      const computed = getComputedStyle(node);
      if (computed.display === 'none' || computed.visibility === 'hidden') return false;
    }
    const rect = watch.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    return Array.from(watch.querySelectorAll('ytm-player, ytd-player, video, h1'))
      .some(candidate => {
        const candidateRect = candidate.getBoundingClientRect();
        return candidateRect.width > 0 && candidateRect.height > 0;
      });
  };

  const renderedWatchSurface = () => Array.from(document.querySelectorAll(WATCH_SELECTOR))
    .find(isRenderedWatchSurface) || null;

  const settledWatchSurface = () => {
    const watch = renderedWatchSurface();
    if (!watch) {
      restoreCandidateWatch = null;
      restoreCandidateSince = 0;
      return null;
    }
    if (watch !== restoreCandidateWatch) {
      restoreCandidateWatch = watch;
      restoreCandidateSince = performance.now();
      return null;
    }
    return performance.now() - restoreCandidateSince >= 240 ? watch : null;
  };

  const beginRestoreMode = (mode, targetURL = '') => {
    clearTimeout(restoreFallbackTimer);
    clearTimeout(restoreSettleTimer);
    restoreFallbackTimer = 0;
    restoreSettleTimer = 0;
    restoreGeneration += 1;
    restoreMode = mode;
    restoreTargetURL = targetURL;
    restoreSettleAttempts = 0;
    restoreCandidateWatch = null;
    restoreCandidateSince = 0;
    restoreFallbackStartURL = mode === 'fallback' ? location.href : '';
    restoreFallbackMutationSerial = miniHistoryMutationSerial;
    pendingDestinationWatch = false;
    return restoreGeneration;
  };

  const cancelRestoreMode = () => {
    clearTimeout(restoreFallbackTimer);
    clearTimeout(restoreSettleTimer);
    restoreFallbackTimer = 0;
    restoreSettleTimer = 0;
    restoreGeneration += 1;
    restoreMode = null;
    restoreTargetURL = '';
    restoreFallbackStartURL = '';
    restoreFallbackMutationSerial = 0;
    restoreSettleAttempts = 0;
    restoreCandidateWatch = null;
    restoreCandidateSince = 0;
  };

  const originRestoreMatches = () => {
    if (restoreMode !== 'origin'
        || miniRouteIndex !== 0
        || miniRouteURLs[0] !== miniWatchURL
        || location.href !== miniWatchURL) return false;
    if (!miniOriginHistoryMarkerWritten) return true;
    const marker = currentMiniHistoryMarker();
    return marker?.session === miniSessionID && marker.index === 0;
  };

  const fallbackNavigationObserved = () => restoreMode === 'fallback'
    && (miniHistoryMutationSerial > restoreFallbackMutationSerial
      || location.href !== restoreFallbackStartURL);

  const restoreRouteMatches = () => {
    if (!isWatchRoute() || videoID() !== miniVideoID) return false;
    if (restoreMode === 'origin') return originRestoreMatches();
    if (restoreMode === 'fallback') return fallbackNavigationObserved();
    return restoreMode === 'current';
  };

  const restorePlayerHost = watch => {
    if (!miniPlayer || !isRenderedWatchSurface(watch)) return false;
    const originWatch = miniOriginMarker?.parentElement?.closest(WATCH_SELECTOR);
    if (miniOriginMarker?.isConnected && miniOriginMarker.parentNode
        && originWatch === watch) {
      miniOriginMarker.parentNode.insertBefore(miniPlayer, miniOriginMarker);
      miniOriginMarker.remove();
      miniOriginMarker = null;
      return true;
    }
    const replacement = Array.from(watch.querySelectorAll('ytm-player, ytd-player'))
      .find(candidate => candidate !== miniPlayer);
    if (replacement) replacement.replaceWith(miniPlayer);
    else watch.prepend(miniPlayer);
    return true;
  };

  const resumeRestoredPlayback = video => {
    if (!video) return;
    const resume = () => {
      if (!video.isConnected || !video.paused || video.ended) return;
      try {
        const result = video.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {}
    };
    requestAnimationFrame(resume);
    setTimeout(resume, 140);
  };

  const finishRestore = () => {
    if (!restoreMode || !miniPlayer || !isWatchRoute() || videoID() !== miniVideoID) {
      return false;
    }
    if (!restoreRouteMatches()) {
      if (restoreMode === 'origin') navigateToSavedWatch();
      return false;
    }
    const watch = settledWatchSurface();
    if (!watch || !restorePlayerHost(watch)) return false;
    const restoredVideo = miniVideo;
    const shouldResume = miniWasPlaying && !restoredVideo?.ended;
    const shell = document.getElementById(SHELL_ID);
    document.getElementById(HIDDEN_HANDLE_ID)?.remove();
    shell?.remove();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    resetMiniState();
    if (shouldResume) resumeRestoredPlayback(restoredVideo);
    return true;
  };

  const finishDestinationWatchHandoff = () => {
    if (!pendingDestinationWatch || !miniPlayer || !isWatchRoute()
        || videoID() === miniVideoID) return false;
    const watch = settledWatchSurface();
    if (!watch) return false;
    const replacement = Array.from(watch.querySelectorAll('ytm-player, ytd-player'))
      .find(candidate => candidate !== miniPlayer);
    if (replacement) {
      releaseMiniPlayer(true);
      return true;
    }
    if (!restorePlayerHost(watch)) return false;
    const destinationVideo = miniVideo;
    const shouldResume = miniWasPlaying && !destinationVideo?.ended;
    destroyMiniChrome();
    resetMiniState();
    if (shouldResume) resumeRestoredPlayback(destinationVideo);
    return true;
  };

  const scheduleFinishRestore = () => {
    if ((!restoreMode && !pendingDestinationWatch) || !miniPlayer) return false;
    if (restoreSettleTimer) return true;
    const delay = restoreSettleAttempts === 0 ? 0 : 50;
    const generation = restoreGeneration;
    restoreSettleTimer = setTimeout(() => {
      restoreSettleTimer = 0;
      if (generation !== restoreGeneration) {
        scheduleFinishRestore();
        return;
      }
      const finished = restoreMode
        ? finishRestore()
        : finishDestinationWatchHandoff();
      if (finished) return;
      if (generation !== restoreGeneration) {
        scheduleFinishRestore();
        return;
      }
      if ((!restoreMode && !pendingDestinationWatch) || !miniPlayer
          || !isWatchRoute()) return;
      restoreSettleAttempts += 1;
      if (restoreSettleAttempts < 24) scheduleFinishRestore();
    }, delay);
    return true;
  };

  const fallbackWatchURL = () => {
    if (!miniWatchURL) return '';
    try {
      const destination = new URL(miniWatchURL);
      const position = Number(miniVideo?.currentTime || 0);
      if (Number.isFinite(position) && position >= 2 && !destination.searchParams.has('t')) {
        destination.searchParams.set('t', `${Math.floor(position)}s`);
      }
      return destination.href;
    } catch {
      return miniWatchURL;
    }
  };

  const armSavedWatchFallback = generation => {
    if (generation !== restoreGeneration
        || (restoreMode !== 'origin' && restoreMode !== 'current')) return false;
    clearTimeout(restoreFallbackTimer);
    restoreFallbackTimer = setTimeout(() => {
      if (generation === restoreGeneration
          && (restoreMode === 'origin' || restoreMode === 'current')) {
        navigateToSavedWatch();
      }
    }, 1200);
    return true;
  };

  const navigateToSavedWatch = () => {
    if (restoreMode === 'fallback') return true;
    const destination = fallbackWatchURL();
    if (!destination) return false;
    const generation = beginRestoreMode('fallback', destination);
    const link = document.createElement('a');
    link.href = restoreTargetURL;
    link.className = 'yt-simple-endpoint';
    link.hidden = true;
    link.setAttribute('aria-hidden', 'true');
    (document.body || document.documentElement).append(link);
    try { link.click(); } catch {}
    link.remove();
    clearTimeout(restoreFallbackTimer);
    restoreFallbackTimer = setTimeout(() => {
      if (restoreMode === 'fallback' && generation === restoreGeneration) {
        location.assign(restoreTargetURL);
      }
    }, 1200);
    scheduleFinishRestore();
    return true;
  };

  const restoreMiniPlayer = () => {
    if (!miniPlayer || !miniWatchURL) return false;
    if (restoreMode) return true;
    markRoutePlaybackTransition();
    document.getElementById(HIDDEN_HANDLE_ID)?.remove();
    const shell = document.getElementById(SHELL_ID);
    if (shell) shell.style.display = '';
    html.removeAttribute('data-vigil-youtube-miniplayer-hidden');
    if (isWatchRoute() && videoID() === miniVideoID) {
      const generation = beginRestoreMode('current');
      scheduleFinishRestore();
      armSavedWatchFallback(generation);
      return true;
    }

    const trackedIndex = Number.isInteger(miniRouteIndex)
        && miniRouteIndex > 0
        && miniRouteURLs[0] === miniWatchURL
        && miniRouteURLs[miniRouteIndex] === location.href
      ? miniRouteIndex
      : null;
    if (!Number.isInteger(trackedIndex)) return navigateToSavedWatch();
    const generation = beginRestoreMode('origin');
    try { history.go(-trackedIndex); } catch { return navigateToSavedWatch(); }
    armSavedWatchFallback(generation);
    return true;
  };

  const releaseMiniPlayer = (pauseVideo = false) => {
    const video = miniVideo;
    const player = miniPlayer;
    if (pauseVideo) {
      if (video === miniVideo) pauseMiniVideoInternally();
      else try { video?.pause(); } catch {}
    }
    if (player && document.getElementById(SHELL_ID)?.contains(player)) player.remove();
    destroyMiniChrome();
    resetMiniState();
  };

  const exitMiniPlayer = () => {
    if (!miniPlayer) return;
    if (isWatchRoute() && videoID() === miniVideoID) {
      const generation = restoreMode
        ? restoreGeneration
        : beginRestoreMode('current');
      scheduleFinishRestore();
      armSavedWatchFallback(generation);
      return;
    }
    releaseMiniPlayer(true);
  };

  const dismissMiniPlayer = () => {
    releaseMiniPlayer(true);
  };

  const syncPlayButton = () => {
    const button = document.querySelector(`#${SHELL_ID} .vigil-youtube-mini-play`);
    if (!(button instanceof HTMLButtonElement) || !miniVideo) return;
    const playing = !miniVideo.paused && !miniVideo.ended;
    button.textContent = playing ? '❚❚' : '▶';
    button.setAttribute('aria-label', playing ? 'Pause video' : 'Play video');
  };

  const togglePlayback = event => {
    event.preventDefault();
    event.stopPropagation();
    if (!miniVideo) return;
    try {
      if (miniVideo.paused) {
        miniWasPlaying = true;
        const result = miniVideo.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } else {
        miniWasPlaying = false;
        pauseMiniVideoInternally();
      }
    } catch {}
    setTimeout(syncPlayButton, 0);
  };

  const toggleMiniSize = () => {
    const shell = document.getElementById(SHELL_ID);
    if (!shell) return false;
    const next = shell.dataset.size === 'large' ? 'small' : 'large';
    shell.dataset.size = next;
    shell.style.removeProperty('left');
    shell.style.removeProperty('top');
    shell.style.removeProperty('right');
    shell.style.removeProperty('bottom');
    shell.style.removeProperty('width');
    return true;
  };

  const handleMiniTap = () => {
    const now = performance.now();
    if (lastMiniTapAt > 0 && now - lastMiniTapAt <= 320) {
      clearTimeout(miniTapTimer);
      miniTapTimer = 0;
      lastMiniTapAt = 0;
      toggleMiniSize();
      return;
    }
    lastMiniTapAt = now;
    clearTimeout(miniTapTimer);
    miniTapTimer = setTimeout(() => {
      miniTapTimer = 0;
      lastMiniTapAt = 0;
      restoreMiniPlayer();
    }, 340);
  };

  const showHiddenMiniPlayer = () => {
    const shell = document.getElementById(SHELL_ID);
    document.getElementById(HIDDEN_HANDLE_ID)?.remove();
    if (!shell) return;
    shell.style.display = '';
    shell.style.opacity = '';
    html.removeAttribute('data-vigil-youtube-miniplayer-hidden');
    if (hiddenPlayerWasPlaying) {
      try {
        const result = miniVideo?.play();
        if (result && typeof result.catch === 'function') result.catch(() => {});
      } catch {}
    }
    hiddenPlayerWasPlaying = false;
  };

  const hideMiniPlayer = side => {
    const shell = document.getElementById(SHELL_ID);
    if (!shell || !miniVideo) return;
    const rect = shell.getBoundingClientRect();
    hiddenPlayerWasPlaying = !miniVideo.paused && !miniVideo.ended;
    pauseMiniVideoInternally();
    shell.style.display = 'none';
    shell.style.opacity = '';
    html.setAttribute('data-vigil-youtube-miniplayer-hidden', side);
    document.getElementById(HIDDEN_HANDLE_ID)?.remove();
    const handle = document.createElement('button');
    handle.id = HIDDEN_HANDLE_ID;
    handle.type = 'button';
    handle.dataset.side = side;
    handle.textContent = side === 'left' ? '›' : '‹';
    handle.setAttribute('aria-label', 'Show miniplayer');
    handle.style.setProperty(
      '--vigil-youtube-hidden-top',
      `${Math.max(12, Math.min(innerHeight - 64, rect.top + rect.height / 2 - 26))}px`
    );
    handle.addEventListener('click', showHiddenMiniPlayer, true);
    document.documentElement.append(handle);
  };

  const normalizedNavigationLabel = value => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const navigationControl = label => {
    const normalized = normalizedNavigationLabel(label);
    for (const item of document.querySelectorAll(
      'ytm-pivot-bar-item-renderer, ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer'
    )) {
      if (normalizedNavigationLabel(item.textContent) !== normalized) continue;
      return item.querySelector('a, button, [role="tab"]') || item;
    }
    if (normalized === 'home') {
      const watchHome = document.querySelector([
        'button[role="link"][aria-label="YouTube Home"]',
        'ytm-home-logo button[role="link"]',
        'a[aria-label="YouTube Home"]'
      ].join(','));
      if (watchHome instanceof HTMLElement) return watchHome;
    }
    const href = normalized === 'home' ? '/' : '/feed/subscriptions';
    return document.querySelector(`a[href="${href}"], a[aria-label="${label}"]`);
  };

  const activateBrowseSurface = () => {
    const homePolicy = html.getAttribute('data-vigil-feature-home');
    const label = homePolicy === 'blocked' || homePolicy === 'pending'
      ? 'Subscriptions'
      : 'Home';
    const path = decodedPathname();
    if ((label === 'Home' && (path === '/' || path === ''))
        || (label === 'Subscriptions'
          && (path === '/feed/subscriptions' || path.startsWith('/feed/subscriptions/')))) {
      return true;
    }
    const control = navigationControl(label);
    if (!(control instanceof HTMLElement)) return false;
    markRoutePlaybackTransition();
    try { control.click(); } catch { return false; }
    return true;
  };

  const ensureBrowseSurface = () => {
    clearTimeout(browseTransitionTimer);
    browseTransitionTimer = 0;
    if (!html.hasAttribute(MINI_ATTRIBUTE) || restoreMode) return;
    if (!isWatchRoute()) {
      browseTransitionAttempts = 0;
      return;
    }
    browseTransitionAttempts += 1;
    activateBrowseSurface();
    if (browseTransitionAttempts >= 12) {
      // Never strand a floating player over the Watch page if YouTube has not
      // rendered a usable browse control. Restore the full player so the next
      // swipe can retry against a settled navigation surface.
      const generation = beginRestoreMode('current');
      scheduleFinishRestore();
      armSavedWatchFallback(generation);
      return;
    }
    browseTransitionTimer = setTimeout(ensureBrowseSurface, 140);
  };

  const createShell = () => {
    destroyMiniChrome();
    const shell = document.createElement('div');
    shell.id = SHELL_ID;
    shell.dataset.size = 'small';
    shell.setAttribute('role', 'group');
    shell.setAttribute('aria-label', 'YouTube miniplayer');

    const play = document.createElement('button');
    play.className = 'vigil-youtube-mini-play';
    play.type = 'button';
    play.addEventListener('click', togglePlayback, true);

    const close = document.createElement('button');
    close.className = 'vigil-youtube-mini-close';
    close.type = 'button';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Close miniplayer');
    close.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      dismissMiniPlayer();
    }, true);

    shell.append(miniPlayer, play, close);
    shell.addEventListener('click', event => {
      const target = event.target instanceof Element ? event.target : null;
      if (blocksMiniInteraction(target, event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (performance.now() < suppressShellClickUntil) return;
      handleMiniTap();
    }, true);
    document.documentElement.append(shell);
    syncPlayButton();
  };

  const recoverMiniPlayerOwnership = () => {
    if (!miniPlayer || !miniVideo || !html.hasAttribute(MINI_ATTRIBUTE)) return false;
    let shell = document.getElementById(SHELL_ID);
    if (!shell) {
      createShell();
      shell = document.getElementById(SHELL_ID);
    }
    if (!shell) return false;

    // Polymer tears down the outgoing Watch component after the Home route is
    // already visible. Its disconnected callback can reclaim either the
    // ytm-player host or the media element even though Vigil moved that node
    // into the floating shell first. Reassert ownership instead of treating
    // that temporary disconnect as the user closing the miniplayer.
    if (!miniPlayer.isConnected || !shell.contains(miniPlayer)) {
      try { shell.prepend(miniPlayer); } catch {}
    }
    if (!miniVideo.isConnected || !miniPlayer.contains(miniVideo)) {
      try { miniPlayer.prepend(miniVideo); } catch {}
    }
    miniPlayer.setAttribute('data-vigil-youtube-active-player', 'true');
    return shell.isConnected && miniPlayer.isConnected && miniVideo.isConnected;
  };

  const exitNativeMiniPlayer = () => {
    html.removeAttribute(NATIVE_MINI_ATTRIBUTE);
    nativeMiniPlayer?.removeAttribute('data-vigil-youtube-native-player');
    nativeMiniPlayer = null;
  };

  const requestNativeMiniPlayer = (video, player) => {
    const bridge = window.webkit?.messageHandlers?.vigil;
    if (!bridge || typeof bridge.postMessage !== 'function') return false;
    nativeMiniPlayer = player;
    player.setAttribute('data-vigil-youtube-native-player', 'true');
    html.setAttribute(NATIVE_MINI_ATTRIBUTE, 'true');
    try {
      const homePolicy = html.getAttribute('data-vigil-feature-home');
      const browseURL = homePolicy === 'blocked' || homePolicy === 'pending'
        ? focusedEntryURL
        : 'https://m.youtube.com/';
      bridge.postMessage({
        type: 'youtubeMinimize',
        videoID: videoID(),
        watchURL: location.href,
        browseURL,
        wasPlaying: !video.paused && !video.ended
      });
      return true;
    } catch {
      exitNativeMiniPlayer();
      return false;
    }
  };

  const enterMiniPlayer = () => {
    if (!isWatchRoute() || isShortsRoute()) return false;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!video || !player || videoIsFullscreen(video)) return false;
    if (requestNativeMiniPlayer(video, player)) return true;
    if (html.hasAttribute(MINI_ATTRIBUTE)) return true;
    installStyle();
    miniVideo = video;
    miniPlayer = player;
    miniVideoID = videoID();
    miniWatchURL = location.href;
    miniSessionID = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    clearStaleMiniHistoryMarkers();
    miniRouteIndex = 0;
    miniRouteURLs = [location.href];
    miniObservedHistoryLength = history.length;
    miniHistoryMutationSerial = 0;
    miniOriginHistoryMarkerWritten = false;
    installMiniHistoryTracking();
    miniOriginHistoryMarkerWritten = writeMiniHistoryMarker(0);
    miniWasPlaying = !video.paused && !video.ended;
    browseTransitionAttempts = 0;
    markRoutePlaybackTransition();
    miniOriginMarker = document.createComment('Vigil YouTube player origin');
    miniPlayer.parentNode?.insertBefore(miniOriginMarker, miniPlayer);
    miniPlayer.setAttribute('data-vigil-youtube-active-player', 'true');
    html.setAttribute(MINI_ATTRIBUTE, 'true');
    createShell();
    video.addEventListener('play', handleMiniVideoPlay);
    video.addEventListener('pause', handleMiniVideoPause);
    const sessionID = miniSessionID;
    miniEndedHandler = () => {
      if (miniSessionID !== sessionID || miniVideo !== video) return;
      // YouTube reuses the content video element for ads. Finishing a skipped
      // ad must hand off to the requested video, not close the miniplayer as
      // though the requested video itself ended.
      if (activeAdPlayer()) {
        miniWasPlaying = true;
        markRoutePlaybackTransition();
        scheduleMiniPlaybackRecovery();
        return;
      }
      dismissMiniPlayer();
    };
    video.addEventListener('ended', miniEndedHandler);
    scheduleMiniPlaybackRecovery();
    requestAnimationFrame(ensureBrowseSurface);
    return true;
  };

  const resetGesture = () => {
    const activeGesture = gesture;
    gesture = null;
    if (!html.hasAttribute(MINI_ATTRIBUTE)) {
      const player = activeGesture?.player
        || document.querySelector('[data-vigil-youtube-gesture-player="true"]');
      player?.removeAttribute('data-vigil-youtube-gesture-player');
      if (player && activeGesture?.mode === 'full') {
        player.style.transform = activeGesture.originalTransform;
        player.style.transition = activeGesture.originalTransition;
      }
    }
    clearDrag();
  };

  const beginGesture = (event, point, pointerID = null) => {
    if (!point || recoverFromShorts()) return;
    const target = event.target instanceof Element ? event.target : null;
    const shell = target?.closest(`#${SHELL_ID}`);
    const activePlayer = miniPlayer && (target === miniPlayer || miniPlayer.contains(target));

    if (html.getAttribute(MINI_ATTRIBUTE) === 'true') {
      if (!shell && !activePlayer) return;
      if (blocksMiniInteraction(target, point)) return;
      gesture = {
        mode: 'mini', startX: point.clientX, startY: point.clientY,
        lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false,
        pointerID, startRect: (shell || miniPlayer).getBoundingClientRect()
      };
      return;
    }

    const video = mainVideo();
    const player = playerForVideo(video);
    if (!isWatchRoute() || videoIsFullscreen(video)
        || point.clientX <= EDGE_GESTURE_WIDTH
        || point.clientX >= innerWidth - EDGE_GESTURE_WIDTH
        || !video || !player
        || !(target === player || player.contains(target))
        || blocksPlayerGesture(target, player, point)) return;
    player.setAttribute('data-vigil-youtube-gesture-player', 'true');
    gesture = {
      mode: 'full', player, startX: point.clientX, startY: point.clientY,
      lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(), moved: false,
      originalTransform: player.style.transform, originalTransition: player.style.transition,
      pointerID, video
    };
  };

  const moveGesture = (event, point, pointerID = null) => {
    if (!gesture || !point || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = point.clientX - gesture.startX;
    const dy = point.clientY - gesture.startY;
    gesture.lastX = point.clientX;
    gesture.lastY = point.clientY;

    if (gesture.mode === 'full') {
      if (Math.abs(dy) < Math.abs(dx) * 1.15) return;
      if (Math.abs(dy) >= 10) {
        gesture.moved = true;
        event.preventDefault();
        const progress = Math.max(-72, Math.min(dy, 150));
        const scale = dy >= 0
          ? Math.max(.76, 1 - progress / 625)
          : Math.min(1.04, 1 + Math.abs(progress) / 1800);
        gesture.player.style.transition = 'none';
        gesture.player.style.transform = `translate3d(0, ${progress}px, 0) scale(${scale})`;
      }
      return;
    }

    if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return;
    gesture.moved = true;
    event.preventDefault();
    setDrag(dx, dy);
  };

  const endGesture = (event, point, pointerID = null) => {
    if (!gesture || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = (point?.clientX ?? gesture.lastX) - gesture.startX;
    const dy = (point?.clientY ?? gesture.lastY) - gesture.startY;
    const elapsed = Math.max(1, performance.now() - gesture.startedAt);
    const verticalVelocity = dy / elapsed * 1000;
    const horizontalVelocity = dx / elapsed * 1000;
    const mode = gesture.mode;
    const moved = gesture.moved;

    if (mode === 'full') {
      const player = gesture.player;
      const video = gesture.video;
      const originalTransform = gesture.originalTransform;
      const originalTransition = gesture.originalTransition;
      player.style.transition = 'transform 180ms ease';
      player.style.transform = originalTransform;
      player.removeAttribute('data-vigil-youtube-gesture-player');
      gesture = null;
      setTimeout(() => {
        player.style.transition = originalTransition;
        player.style.transform = originalTransform;
      }, 190);
      const verticalDominant = Math.abs(dy) > Math.abs(dx) * 1.15;
      if (verticalDominant && (dy >= 72 || verticalVelocity >= 520)) {
        suppressPlayerClickUntil = performance.now() + 500;
        enterMiniPlayer();
      } else if (verticalDominant && (dy <= -72 || verticalVelocity <= -520)) {
        // Invoke YouTube's own fullscreen control before suppressing the
        // synthetic click iOS may emit after the completed swipe.
        enterFullscreen(video);
        suppressPlayerClickUntil = performance.now() + 500;
      }
      return;
    }

    const startRect = gesture.startRect;
    resetGesture();
    suppressShellClickUntil = performance.now() + 500;
    const horizontalHide = Math.abs(dx) >= Math.max(76, (startRect?.width || 160) * .45)
      || (Math.abs(horizontalVelocity) >= 850 && Math.abs(dx) > Math.abs(dy));
    if (horizontalHide) {
      hideMiniPlayer(dx < 0 ? 'left' : 'right');
    } else if (dy <= -34 && Math.abs(dy) > Math.abs(dx)) {
      restoreMiniPlayer();
    } else if (!moved) {
      handleMiniTap();
    }
  };

  const cancelGesture = (pointerID = null) => {
    if (gesture?.pointerID != null && gesture.pointerID !== pointerID) return;
    resetGesture();
  };

  const pointerDistance = points => {
    const [first, second] = points;
    return Math.hypot(second.x - first.x, second.y - first.y);
  };

  const beginPinchGesture = () => {
    const shell = document.getElementById(SHELL_ID);
    const points = [...miniPointers.values()];
    if (!shell || points.length !== 2) return false;
    const rect = shell.getBoundingClientRect();
    pinchGesture = {
      startDistance: Math.max(1, pointerDistance(points)),
      startWidth: rect.width,
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2
    };
    gesture = null;
    clearTimeout(miniTapTimer);
    miniTapTimer = 0;
    lastMiniTapAt = 0;
    return true;
  };

  const resizeForPinch = event => {
    if (!pinchGesture || miniPointers.size < 2) return false;
    const shell = document.getElementById(SHELL_ID);
    if (!shell) return false;
    const distance = pointerDistance([...miniPointers.values()].slice(0, 2));
    const maximum = Math.max(176, Math.min(344, innerWidth - 24));
    const width = Math.max(176, Math.min(maximum,
      pinchGesture.startWidth * distance / pinchGesture.startDistance));
    const height = width * 9 / 16;
    const left = Math.max(8, Math.min(innerWidth - width - 8, pinchGesture.centerX - width / 2));
    const top = Math.max(8, Math.min(innerHeight - height - 8, pinchGesture.centerY - height / 2));
    shell.dataset.size = 'custom';
    shell.style.width = `${width}px`;
    shell.style.left = `${left}px`;
    shell.style.top = `${top}px`;
    shell.style.right = 'auto';
    shell.style.bottom = 'auto';
    event.preventDefault();
    return true;
  };

  if ('PointerEvent' in window) {
    document.addEventListener('pointerdown', event => {
      if (event.pointerType && event.pointerType !== 'touch') return;
      const target = event.target instanceof Element ? event.target : null;
      if (html.hasAttribute(MINI_ATTRIBUTE)
          && target?.closest(`#${SHELL_ID}`)
          && !blocksMiniInteraction(target, event)) {
        miniPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (miniPointers.size === 2 && beginPinchGesture()) return;
      }
      if (!event.isPrimary) return;
      beginGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', event => {
      if (miniPointers.has(event.pointerId)) {
        miniPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (resizeForPinch(event)) return;
      }
      if (!event.isPrimary) return;
      moveGesture(event, event, event.pointerId);
    }, { capture: true, passive: false });
    document.addEventListener('pointerup', event => {
      const wasPinching = Boolean(pinchGesture);
      miniPointers.delete(event.pointerId);
      if (wasPinching) {
        if (miniPointers.size < 2) pinchGesture = null;
        suppressShellClickUntil = performance.now() + 500;
        return;
      }
      if (!event.isPrimary) return;
      endGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointercancel', event => {
      miniPointers.delete(event.pointerId);
      if (miniPointers.size < 2) pinchGesture = null;
      cancelGesture(event.pointerId);
    }, true);
  } else {
    const touchPoint = event => event.changedTouches?.[0] || event.touches?.[0] || null;
    document.addEventListener('touchstart', event => {
      if (event.touches.length !== 1) return;
      beginGesture(event, touchPoint(event));
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', event => {
      if (event.touches.length !== 1) return;
      moveGesture(event, touchPoint(event));
    }, { capture: true, passive: false });
    document.addEventListener('touchend', event => endGesture(event, touchPoint(event)), {
      capture: true, passive: true
    });
    document.addEventListener('touchcancel', () => cancelGesture(), true);
  }

  document.addEventListener('fullscreenchange', () => {
    if (document.fullscreenElement) exitMiniPlayer();
    scheduleMoreVideosAvailability();
  });
  document.addEventListener('webkitfullscreenchange', scheduleMoreVideosAvailability);
  document.addEventListener('webkitbeginfullscreen', scheduleMoreVideosAvailability, true);
  document.addEventListener('webkitendfullscreen', scheduleMoreVideosAvailability, true);
  addEventListener('resize', scheduleMoreVideosAvailability);
  addEventListener('orientationchange', scheduleMoreVideosAvailability);
  window.visualViewport?.addEventListener('resize', scheduleMoreVideosAvailability);

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (performance.now() < suppressPlayerClickUntil
        && target?.closest(PLAYER_SELECTOR)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const link = target?.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (allowedHosts.has(destination.hostname.toLowerCase())
      && isShortsPath(destination.pathname)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (html.hasAttribute(MINI_ATTRIBUTE)) activateBrowseSurface();
      else location.assign(focusedEntryURL);
    } else if (html.hasAttribute(MINI_ATTRIBUTE)
        && allowedHosts.has(destination.hostname.toLowerCase())) {
      markRoutePlaybackTransition();
    }
  }, true);

  const routeAudit = event => {
    if (recoverFromShorts()) return;
    if (!html.hasAttribute(MINI_ATTRIBUTE)) clearStaleMiniHistoryMarkers();
    const route = location.href;
    if (route === lastRoute) {
      if (html.hasAttribute(MINI_ATTRIBUTE) && event?.type === 'popstate') {
        syncMiniHistoryRoute(event);
        if (restoreMode === 'origin' && !originRestoreMatches()) {
          navigateToSavedWatch();
          return;
        }
      }
      if (restoreMode || pendingDestinationWatch) {
        scheduleFinishRestore();
        return;
      }
      if (html.hasAttribute(MINI_ATTRIBUTE)) {
        recoverMiniPlayerOwnership();
        maintainMiniPlayback();
      }
      return;
    }
    const previousVideoID = miniVideoID;
    lastRoute = route;
    if (!html.hasAttribute(MINI_ATTRIBUTE)) return;
    markRoutePlaybackTransition();
    syncMiniHistoryRoute(event);
    if (restoreMode === 'origin' && event?.type === 'popstate'
        && !originRestoreMatches()) {
      navigateToSavedWatch();
      return;
    }
    if (isWatchRoute() && videoID() === previousVideoID) {
      if (!restoreMode) {
        const generation = beginRestoreMode('current');
        armSavedWatchFallback(generation);
      }
      pendingDestinationWatch = false;
      scheduleFinishRestore();
    } else if (isWatchRoute() && videoID() !== previousVideoID) {
      if (restoreMode === 'origin' || restoreMode === 'fallback') {
        // A restore traversal that reached another video did not reach its
        // verified origin. Keep restore ownership and use the saved Watch URL;
        // do not misclassify the wrong page as an intentional handoff.
        navigateToSavedWatch();
      } else {
        if (restoreMode === 'current') cancelRestoreMode();
        pendingDestinationWatch = true;
        restoreSettleAttempts = 0;
        restoreCandidateWatch = null;
        restoreCandidateSince = 0;
        scheduleFinishRestore();
      }
    } else {
      if (restoreMode === 'current') cancelRestoreMode();
      pendingDestinationWatch = false;
      recoverMiniPlayerOwnership();
      maintainMiniPlayback();
    }
  };

  installStyle();
  updateMoreVideosAvailability();
  const mutationChangesPlayerTopology = mutation => {
    const selector = `${WATCH_SELECTOR}, ${PLAYER_SELECTOR}, video`;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(node => (
      node instanceof Element && (node.matches(selector) || node.querySelector(selector))
    ));
  };

  new MutationObserver(mutations => {
    if (mutations.some(mutation => mutation.addedNodes.length > 0)) scheduleAdAudit();
    const playerTopologyChanged = mutations.some(mutationChangesPlayerTopology);
    if (playerTopologyChanged) scheduleMoreVideosAvailability();
    if ((restoreMode || pendingDestinationWatch) && playerTopologyChanged) {
      restoreCandidateSince = performance.now();
    }
    routeAudit();
  }).observe(document.documentElement, {
    childList: true, subtree: true
  });
  addEventListener('popstate', routeAudit, true);
  addEventListener('pageshow', routeAudit, true);
  addEventListener('pageshow', scheduleMoreVideosAvailability, true);
  addEventListener('pagehide', () => {
    html.setAttribute(MORE_VIDEOS_ATTRIBUTE, 'suppressed');
  }, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      html.setAttribute(MORE_VIDEOS_ATTRIBUTE, 'suppressed');
      return;
    }
    scheduleMoreVideosAvailability();
  }, true);
  for (const name of [
    'yt-navigate-finish', 'yt-page-data-updated',
    'state-navigateend', 'state-navigatecomplete', '__vigilRouteChanged'
  ]) {
    addEventListener(name, routeAudit, true);
    document.addEventListener(name, routeAudit, true);
  }
  document.addEventListener('play', scheduleAdAudit, true);
  document.addEventListener('durationchange', scheduleAdAudit, true);
  suppressYouTubeAds();
  setInterval(suppressYouTubeAds, 1000);
  setInterval(() => {
    installStyle();
    updateMoreVideosAvailability();
  }, 1000);
  setInterval(routeAudit, 400);

  Object.defineProperty(window, '__vigilYouTubeParityTest', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      enterMiniPlayer,
      exitMiniPlayer,
      dismissMiniPlayer,
      restoreMiniPlayer,
      handleMiniTap,
      toggleMiniSize,
      activateBrowseSurface,
      suppressYouTubeAds,
      recoverMiniPlayerOwnership,
      reconcilePopRouteIndexForTest: reconcilePopRouteIndex,
      moreVideosAllowedForState,
      updateMoreVideosAvailability,
      enterFullscreen,
      playerForVideo,
      isShortsRoute,
      isWatchRoute
    })
  });
  Object.defineProperty(window, '__vigilExitNativeYouTubeMiniPlayer', {
    configurable: false,
    enumerable: false,
    value: exitNativeMiniPlayer
  });
})();
