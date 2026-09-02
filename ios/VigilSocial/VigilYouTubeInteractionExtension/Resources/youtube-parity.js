(() => {
  'use strict';

  if (window.top !== window) return;
  const currentHost = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
  const maturePlatform = currentHost === 'reddit.com' || currentHost.endsWith('.reddit.com') || currentHost === 'redd.it'
    ? 'reddit'
    : currentHost === 'x.com' || currentHost.endsWith('.x.com') || currentHost === 'twitter.com' || currentHost.endsWith('.twitter.com')
      ? 'x'
      : null;
  if (maturePlatform) {
    installMatureContentInterlock(maturePlatform);
    return;
  }

  if (window.__vigilYouTubeParityInstalled) return;
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
  if (!allowedHosts.has(String(location.hostname || '').toLowerCase())) return;
  window.__vigilYouTubeParityInstalled = true;

  function installMatureContentInterlock(platform) {
    if (window.__vigilMatureContentInterlockInstalled) return;
    window.__vigilMatureContentInterlockInstalled = true;
    const normalizedText = value => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const ageGateRoute = value => {
      try {
        const url = new URL(String(value || ''), location.href);
        const host = url.hostname.toLowerCase().replace(/^www\./, '');
        return (host === 'reddit.com' || host.endsWith('.reddit.com')) && /^\/over18(?:\/|$)/i.test(url.pathname);
      } catch { return false; }
    };
    const safeDestination = platform === 'reddit' ? 'https://www.reddit.com/' : 'https://x.com/home';
    if (ageGateRoute(location.href)) {
      location.replace(safeDestination);
      return;
    }
    const markerText = value => /^(?:nsfw|18\+|mature content|adult content|sensitive content|this (?:media|post|profile|community) may contain sensitive (?:content|material))\.?$/i.test(normalizedText(value));
    const xMarkerText = value => /^(?:sensitive content|this (?:media|post|profile) may contain sensitive (?:content|material))\.?$/i.test(normalizedText(value));
    const revealText = value => {
      const text = normalizedText(value);
      return [
        /\b(?:show|display|view|reveal|see|allow|enable)\s+(?:(?:potentially\s+)?(?:sensitive|mature|adult|nsfw))(?:\s+(?:content|media|posts?|communities|profiles?|images?))?\b/i,
        /\bdisplay\s+media\s+that\s+may\s+contain\s+sensitive\s+(?:content|material)\b/i,
        /\b(?:yes[,]?\s*)?(?:i(?:'|’)m|i am)\s+(?:over\s+)?18\b/i,
        /\bcontinue(?:\s+to)?\s+(?:18\+|mature|adult|nsfw)\b/i,
        /\bshow\s+mature\s*\(?18\+\)?\s*content\b/i
      ].some(pattern => pattern.test(text));
    };
    const safeSelect = (selector, scope = document) => {
      const matches = [];
      try {
        if (scope instanceof HTMLElement && scope.matches(selector)) matches.push(scope);
        matches.push(...scope.querySelectorAll(selector));
      } catch {}
      return matches;
    };
    const contentContainer = element => {
      const selectors = platform === 'reddit'
        ? ['shreddit-post', 'article', '.thing', "[data-testid='post-container']", "[role='article']", '.Post', "[data-click-id='background']", "[role='dialog']"]
        : ['article', "[data-testid='cellInnerDiv']", "[role='article']", "[role='dialog']"];
      for (const selector of selectors) {
        const container = element.closest?.(selector);
        if (container instanceof HTMLElement) return container;
      }
      return null;
    };
    const markContent = marker => {
      const container = contentContainer(marker) || marker;
      if (!(container instanceof HTMLElement)) return;
      container.setAttribute('data-vigil-mature-content', 'blocked');
      container.querySelectorAll('video, audio').forEach(media => {
        try { media.pause(); } catch {}
      });
    };
    const controlDescriptor = element => {
      const values = [
        element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
        element.getAttribute?.('data-testid'), element.getAttribute?.('name'),
        element.getAttribute?.('value'), element.textContent
      ];
      if (element instanceof HTMLInputElement) {
        for (const label of element.labels || []) values.push(label.textContent);
      }
      return normalizedText(values.filter(Boolean).join(' ').slice(0, 900));
    };
    const revealControl = element => {
      const descriptor = controlDescriptor(element);
      if (revealText(descriptor)) return true;
      if (!/^(?:show|view|continue|yes|enable|allow)$/i.test(descriptor)) return false;
      const context = element.closest?.("[role='dialog'], [role='menuitem'], label, li, form, article");
      return Boolean(context && /\b(?:nsfw|18\+|mature|adult|sensitive)\b/i.test(String(context.textContent || '').slice(0, 900)));
    };
    const blockControl = control => {
      if (!(control instanceof HTMLElement)) return;
      control.setAttribute('data-vigil-mature-control', 'blocked');
      control.setAttribute('aria-disabled', 'true');
      control.setAttribute('aria-hidden', 'true');
      control.setAttribute('tabindex', '-1');
      if (control instanceof HTMLButtonElement || control instanceof HTMLInputElement) control.disabled = true;
      if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) control.checked = false;
      const container = contentContainer(control);
      if (container && !control.closest("label, [role='menuitem'], form")) markContent(container);
    };
    let scanning = false;
    const scan = (scope = document) => {
      if (scanning || !document.documentElement) return;
      scanning = true;
      try {
        const structured = platform === 'reddit'
          ? ['shreddit-post[nsfw]', 'shreddit-post[over-18]', '.thing.over18', "[data-nsfw='true' i]", "[data-over-18='true' i]", "[data-over18='true' i]"]
          : ["[data-testid*='sensitiveMedia' i]", "[data-testid*='sensitive_media' i]", "[aria-label*='sensitive content' i]", "[aria-label*='sensitive media' i]"];
        for (const selector of structured) safeSelect(selector, scope).slice(0, 400).forEach(markContent);
        const textSelector = platform === 'reddit'
          ? ".thing .nsfw-stamp, [data-testid='post-container'] [class*='badge' i], shreddit-post [slot*='flair' i], [class*='nsfw' i], [data-testid*='label' i]"
          : "article span, [role='dialog'] span, [data-testid*='sensitive' i]";
        safeSelect(textSelector, scope)
          .slice(0, 800)
          .forEach(marker => { if (platform === 'x' ? xMarkerText(marker.textContent) : markerText(marker.textContent)) markContent(marker); });
        safeSelect("a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem']", scope)
          .slice(0, 800)
          .forEach(control => { if (revealControl(control)) blockControl(control); });
      } finally { scanning = false; }
    };
    const install = () => {
      const root = document.documentElement;
      if (!root) return;
      root.setAttribute('data-vigil-mature-interlock', platform);
      if (!document.getElementById('vigil-mature-content-style')) {
        const style = document.createElement('style');
        style.id = 'vigil-mature-content-style';
        style.textContent = `
          html[data-vigil-mature-interlock] [data-vigil-mature-control="blocked"] { display: none !important; visibility: hidden !important; pointer-events: none !important; }
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] img,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] picture,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] video,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] audio,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] canvas,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] iframe,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] object,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] embed,
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] svg[role="img"],
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"] [style*="background-image" i] { display: none !important; visibility: hidden !important; pointer-events: none !important; background-image: none !important; }
          html[data-vigil-mature-interlock] [data-vigil-mature-content="blocked"]::before { content: "Mature media removed by Vigil"; display: block !important; box-sizing: border-box !important; margin: 8px 0 !important; padding: 14px 16px !important; border: 1px solid rgba(183,121,82,.55) !important; border-radius: 10px !important; background: #211d1a !important; color: #eadfd7 !important; font: 600 14px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif !important; text-align: center !important; }
        `;
        root.append(style);
      }
      scan();
      const guard = event => {
        if (event instanceof KeyboardEvent && event.key !== 'Enter' && event.key !== ' ') return;
        const target = (event.composedPath?.() || []).find(value => value instanceof HTMLElement)
          || (event.target instanceof HTMLElement ? event.target : null);
        if (!target) return;
        const control = target.closest("a[href], button, input, label, [role='button'], [role='switch'], [role='menuitem'], form") || target;
        const anchor = control.closest?.('a[href]');
        if (!control.closest("[data-vigil-mature-control='blocked']") && !revealControl(control) && !ageGateRoute(anchor?.href || '')) return;
        if (event.cancelable) event.preventDefault();
        event.stopImmediatePropagation();
        blockControl(control);
        if (anchor && ageGateRoute(anchor.href)) location.replace(safeDestination);
        scan();
      };
      for (const eventName of ['pointerdown', 'mousedown', 'touchstart', 'click', 'submit', 'change', 'input', 'keydown']) document.addEventListener(eventName, guard, true);
      new MutationObserver(records => {
        const scopes = new Set();
        for (const record of records) {
          if (record.target instanceof HTMLElement) scopes.add(record.target);
          else if (record.target.parentElement) scopes.add(record.target.parentElement);
          for (const node of record.addedNodes) {
            if (node instanceof HTMLElement) scopes.add(node);
            else if (node.parentElement) scopes.add(node.parentElement);
          }
        }
        if (scopes.size > 40) scan();
        else scopes.forEach(scan);
      }).observe(root, {
        childList: true, subtree: true, characterData: true, attributes: true,
        attributeFilter: ['aria-label', 'aria-checked', 'data-testid', 'href', 'nsfw', 'over-18', 'data-nsfw', 'data-over-18', 'data-over18', 'title']
      });
      addEventListener('pageshow', () => scan(), true);
      addEventListener('popstate', () => ageGateRoute(location.href) ? location.replace(safeDestination) : scan(), true);
      setInterval(() => ageGateRoute(location.href) ? location.replace(safeDestination) : scan(), 1500);
    };
    if (document.documentElement) install();
    else document.addEventListener('DOMContentLoaded', install, { once: true });
  }

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
    if (Array.isArray(value)) return value.every(item => collectPlayerAdFields(item, targets, seen));
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
    return collectPlayerAdFields(value.playerResponse, targets, seen);
  };
  const prunePlayerResponse = value => {
    const targets = [];
    try {
      if (!collectPlayerAdFields(value, targets) || targets.length === 0) return false;
      return targets.every(([target, key]) => Reflect.deleteProperty(target, key));
    } catch { return false; }
  };
  const clonedPrunedPlayerResponse = value => {
    try {
      const clone = JSON.parse(JSON.stringify(value));
      return prunePlayerResponse(clone) ? clone : null;
    } catch { return null; }
  };
  const rewrittenHeaders = response => {
    const headers = new Headers(response.headers);
    for (const name of [
      'content-encoding', 'content-length', 'content-md5', 'content-range',
      'digest', 'etag', 'transfer-encoding'
    ]) headers.delete(name);
    return headers;
  };
  const eligiblePlayerResponse = response => response instanceof Response
    && !response.bodyUsed && response.status === 200 && !response.redirected
    && ['basic', 'cors', 'default'].includes(response.type)
    && (!response.url || playerResponseURL(response.url))
    && /(?:^|[/+])json(?:\s*;|$)/i.test(response.headers.get('content-type') || '');
  const rewrittenPlayerResponse = responseBefore => {
    if (!eligiblePlayerResponse(responseBefore)) return Promise.resolve(responseBefore);
    return responseBefore.clone().json().then(payload => {
      if (!prunePlayerResponse(payload)) return responseBefore;
      const responseAfter = new Response(JSON.stringify(payload), {
        status: responseBefore.status,
        statusText: responseBefore.statusText,
        headers: rewrittenHeaders(responseBefore)
      });
      for (const property of ['ok', 'redirected', 'type', 'url']) {
        try { Object.defineProperty(responseAfter, property, { value: responseBefore[property] }); } catch {}
      }
      return responseAfter;
    }).catch(() => responseBefore);
  };
  const installFetchPlayerResponseGuard = () => {
    if (typeof window.fetch !== 'function') return;
    const nativeFetch = window.fetch;
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, argumentsList) {
        const result = Reflect.apply(target, thisArg, argumentsList);
        return playerResponseURL(argumentsList[0])
          ? result.then(rewrittenPlayerResponse, () => result)
          : result;
      }
    });
  };
  const installXHRPlayerResponseGuard = () => {
    const NativeXHR = window.XMLHttpRequest;
    if (typeof NativeXHR !== 'function') return;
    const guarded = new WeakSet();
    window.XMLHttpRequest = class extends NativeXHR {
      open(method, url, ...rest) {
        guarded.delete(this);
        if (playerResponseURL(url)) guarded.add(this);
        return super.open(method, url, ...rest);
      }
      get response() {
        const raw = super.response;
        if (!guarded.has(this) || this.readyState !== 4 || Number(this.status) !== 200) return raw;
        const responseURL = String(this.responseURL || '');
        if (responseURL && !playerResponseURL(responseURL)) return raw;
        const contentType = String(this.getResponseHeader?.('content-type') || '');
        if (contentType && !/(?:^|[/+])json(?:\s*;|$)/i.test(contentType)) return raw;
        if (!['', 'text', 'json'].includes(String(this.responseType || ''))) return raw;
        try {
          const wasText = typeof raw === 'string';
          const payload = wasText ? JSON.parse(raw) : clonedPrunedPlayerResponse(raw);
          if (!payload || (wasText && !prunePlayerResponse(payload))) return raw;
          return wasText ? JSON.stringify(payload) : payload;
        } catch { return raw; }
      }
      get responseText() {
        const value = this.response;
        return typeof value === 'string' ? value : super.responseText;
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
        set: value => { current = clonedPrunedPlayerResponse(value) || value; }
      });
    } catch {}
  };
  installFetchPlayerResponseGuard();
  installXHRPlayerResponseGuard();
  installInitialPlayerResponseGuard();

  const STYLE_ID = 'vigil-youtube-parity-style';
  const MORE_VIDEOS_ATTRIBUTE = 'data-vigil-youtube-more-videos';
  const PLAYER_SELECTOR = 'ytm-player, ytd-player, #player-container-id, #player';
  const SEEK_CONTROL_SELECTOR = [
    '[role="slider"]', '[aria-valuenow]', 'input[type="range"]',
    '.ytp-progress-bar', '.ytp-progress-list', '.ytp-scrubber-container'
  ].join(',');
  const AD_PLAYER_STATE_SELECTOR = '.ad-showing, .ad-interrupting';
  const AD_SKIP_SELECTOR = [
    '.ytp-ad-skip-button', '.ytp-ad-skip-button-modern', '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-container button', 'button[aria-label^="Skip ad" i]',
    'button[aria-label^="Skip ads" i]'
  ].join(',');
  const EDGE_GESTURE_WIDTH = 24;
  const html = document.documentElement;
  const focusedEntryURL = 'https://m.youtube.com/feed/subscriptions';
  let gesture = null;
  let adAuditTimer = 0;
  let adEpochPlayer = null;
  let attemptedSkipControl = null;
  let observedMoreVideosPlayerState = [];
  let moreVideosPlayerStateObserver = null;
  let suppressPlayerClickUntil = 0;

  const decodedPath = value => {
    let pathname = String(value || '/');
    for (let pass = 0; pass < 3; pass += 1) {
      try {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      } catch { break; }
    }
    return pathname.replace(/\\+/g, '/').toLowerCase();
  };
  const isShortsPath = pathname => /(?:^|\/)shorts(?:\/|$)/.test(decodedPath(pathname));
  const isShortsRoute = () => isShortsPath(location.pathname);
  const isWatchRoute = () => decodedPath(location.pathname) === '/watch';
  const recoverFromShorts = () => {
    if (!isShortsRoute()) return false;
    try { location.replace(focusedEntryURL); } catch { location.href = focusedEntryURL; }
    return true;
  };
  if (recoverFromShorts()) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    ytd-comments, ytd-comments-header-renderer, ytd-comment-thread-renderer,
    ytd-item-section-renderer[section-identifier="comment-item-section"],
    ytm-comments-entry-point-header-renderer, ytm-comments-header-renderer,
    ytm-comment-section-renderer,
    ytm-engagement-panel-section-list-renderer[target-id*="comments" i],
    [section-identifier="comments-entry-point"], #comments, #comments-button,
    a[href*="#comments" i], button[aria-label*="comment" i],
    ytm-promoted-sparkles-web-renderer, ytd-promoted-sparkles-web-renderer,
    ytm-companion-ad-renderer, ytd-companion-slot-renderer,
    ytm-display-ad-renderer, ytd-display-ad-renderer,
    ytm-promoted-video-renderer, ytd-promoted-video-renderer,
    ytm-ad-slot-renderer, ytd-ad-slot-renderer,
    ytm-in-feed-ad-layout-renderer, ytd-in-feed-ad-layout-renderer,
    ytd-banner-promo-renderer, #masthead-ad {
      display: none !important; visibility: hidden !important; pointer-events: none !important;
    }
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-player, ytd-player, .html5-video-player
    ) :is(
      .ytp-more-videos-button, .ytp-more-videos-view, .ytp-fullscreen-grid,
      .ytp-pause-overlay, .ytp-pause-overlay-container, .ytp-endscreen-content
    ),
    html:not([${MORE_VIDEOS_ATTRIBUTE}="allowed"]) :is(
      ytm-fullscreen-related-videos-entry-point-view-model,
      .ytmFullscreenRelatedVideosEntryPointViewModelHost,
      .fullscreen-watch-next-entrypoint-wrapper, .fullscreen-more-videos-endpoint,
      .fullscreen-recommendations-wrapper, .fullscreen-recommendation,
      .ytFullscreenVideoRecommendationsHost,
      .ytFullscreenVideoRecommendationsRecommendation
    ) {
      visibility: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
    :is(ytm-player, ytd-player),
    :is(ytm-player, ytd-player) :is(video, .html5-video-container, .ytp-cued-thumbnail-overlay-image) {
      touch-action: pan-x pan-down pinch-zoom !important;
    }
  `;
  const installStyle = () => {
    if (!document.getElementById(STYLE_ID)) (document.head || html).append(style);
  };
  const mainVideo = () => Array.from(document.querySelectorAll('video'))
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
  const playerForVideo = video => video?.closest('ytm-player')
    || video?.closest('ytd-player') || video?.closest('#player-container-id')
    || video?.closest('#player') || video?.parentElement || null;
  const videoIsFullscreen = video => Boolean(
    document.fullscreenElement || document.webkitFullscreenElement || video?.webkitDisplayingFullscreen
  );
  const moreVideosAllowedForState = (fullscreen, width, height) => Boolean(
    fullscreen && Number(width) > Number(height) && Number(height) > 0
  );
  const playerIsExpandedFullscreen = video => videoIsFullscreen(video)
    || Boolean(video?.closest(
      '.html5-video-player.ytp-fullscreen, ytm-player[fullscreen], ytd-player[fullscreen]'
    ));
  const observeMoreVideosPlayerState = video => {
    const candidates = [video?.closest('.html5-video-player'), video?.closest('ytm-player'),
      video?.closest('ytd-player')].filter((value, index, all) => value && all.indexOf(value) === index);
    if (candidates.length === observedMoreVideosPlayerState.length
        && candidates.every((value, index) => value === observedMoreVideosPlayerState[index])) return;
    moreVideosPlayerStateObserver?.disconnect();
    observedMoreVideosPlayerState = candidates;
    moreVideosPlayerStateObserver = new MutationObserver(scheduleMoreVideosAvailability);
    candidates.forEach(value => moreVideosPlayerStateObserver.observe(value, {
      attributes: true, attributeFilter: ['class', 'fullscreen']
    }));
  };
  const updateMoreVideosAvailability = () => {
    const video = mainVideo();
    observeMoreVideosPlayerState(video);
    const width = Number(window.visualViewport?.width || innerWidth || 0);
    const height = Number(window.visualViewport?.height || innerHeight || 0);
    const allowed = moreVideosAllowedForState(playerIsExpandedFullscreen(video), width, height);
    html.setAttribute(MORE_VIDEOS_ATTRIBUTE, allowed ? 'allowed' : 'suppressed');
    return allowed;
  };
  function scheduleMoreVideosAvailability() {
    installStyle();
    updateMoreVideosAvailability();
    requestAnimationFrame(updateMoreVideosAvailability);
  }
  const enterFullscreen = video => {
    if (!video || videoIsFullscreen(video)) return false;
    const control = playerForVideo(video)?.querySelector(
      '.ytp-fullscreen-button, button[aria-label*="full screen" i], button[title*="full screen" i]'
    );
    try {
      if (control instanceof HTMLElement) control.click();
      else if (typeof video.webkitEnterFullscreen === 'function') video.webkitEnterFullscreen();
      else if (typeof video.requestFullscreen === 'function') void video.requestFullscreen();
      else return false;
      return true;
    } catch { return false; }
  };
  const visibleElement = element => {
    if (!(element instanceof Element) || !element.isConnected) return false;
    const computedStyle = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return computedStyle.display !== 'none' && computedStyle.visibility !== 'hidden'
      && rect.width > 0 && rect.height > 0;
  };
  const suppressYouTubeAds = () => {
    const player = Array.from(document.querySelectorAll(AD_PLAYER_STATE_SELECTOR))
      .find(value => value.querySelector('video'));
    if (!player) { adEpochPlayer = null; attemptedSkipControl = null; return false; }
    if (player !== adEpochPlayer) { adEpochPlayer = player; attemptedSkipControl = null; }
    const skip = Array.from(player.querySelectorAll(AD_SKIP_SELECTOR))
      .find(value => visibleElement(value) && !value.matches(':disabled, [aria-disabled="true"]'));
    if (!(skip instanceof HTMLElement)) {
      if (attemptedSkipControl && (!visibleElement(attemptedSkipControl)
          || attemptedSkipControl.matches(':disabled, [aria-disabled="true"]'))) {
        attemptedSkipControl = null;
      }
      return false;
    }
    if (skip === attemptedSkipControl) return false;
    attemptedSkipControl = skip;
    try { skip.click(); return true; } catch { attemptedSkipControl = null; return false; }
  };
  const scheduleAdAudit = () => {
    if (adAuditTimer) return;
    adAuditTimer = setTimeout(() => { adAuditTimer = 0; suppressYouTubeAds(); }, 80);
  };
  const blocksPlayerGesture = (target, player) => {
    if (!target || !player) return true;
    if (target.closest(SEEK_CONTROL_SELECTOR)
        || target.closest('a, input, textarea, select')) return true;
    const button = target.closest('button, [role="button"]');
    if (!button || !player.contains(button)) return false;
    const buttonRect = button.getBoundingClientRect();
    const playerRect = player.getBoundingClientRect();
    return buttonRect.width < playerRect.width * 0.72
      || buttonRect.height < playerRect.height * 0.72;
  };
  const resetGesture = () => {
    const active = gesture;
    gesture = null;
    active?.player.removeAttribute('data-vigil-youtube-gesture-player');
    if (active) {
      active.player.style.transform = active.originalTransform;
      active.player.style.transition = active.originalTransition;
    }
  };
  const beginGesture = (event, point, pointerID = null) => {
    const target = event.target instanceof Element ? event.target : null;
    const video = mainVideo();
    const player = playerForVideo(video);
    if (!point || !isWatchRoute() || videoIsFullscreen(video) || !video || !player
        || point.clientX <= EDGE_GESTURE_WIDTH || point.clientX >= innerWidth - EDGE_GESTURE_WIDTH
        || !(target === player || player.contains(target)) || blocksPlayerGesture(target, player)) return;
    player.setAttribute('data-vigil-youtube-gesture-player', 'true');
    gesture = {
      player, video, pointerID, startX: point.clientX, startY: point.clientY,
      lastX: point.clientX, lastY: point.clientY, startedAt: performance.now(),
      originalTransform: player.style.transform, originalTransition: player.style.transition
    };
  };
  const moveGesture = (event, point, pointerID = null) => {
    if (!gesture || !point || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const dx = point.clientX - gesture.startX;
    const dy = point.clientY - gesture.startY;
    gesture.lastX = point.clientX;
    gesture.lastY = point.clientY;
    // Downward movement belongs to YouTube/WebKit. Only upward fullscreen is custom.
    if (dy >= 0 || Math.abs(dy) < Math.abs(dx) * 1.15 || Math.abs(dy) < 10) return;
    event.preventDefault();
    const progress = Math.max(-72, dy);
    gesture.player.style.transition = 'none';
    gesture.player.style.transform = `translate3d(0, ${progress}px, 0)`;
  };
  const endGesture = (event, point, pointerID = null) => {
    if (!gesture || (gesture.pointerID != null && gesture.pointerID !== pointerID)) return;
    const active = gesture;
    const dx = (point?.clientX ?? active.lastX) - active.startX;
    const dy = (point?.clientY ?? active.lastY) - active.startY;
    const velocity = dy / Math.max(1, performance.now() - active.startedAt) * 1000;
    resetGesture();
    if (Math.abs(dy) > Math.abs(dx) * 1.15 && (dy <= -72 || velocity <= -520)
        && enterFullscreen(active.video)) suppressPlayerClickUntil = performance.now() + 500;
  };
  const cancelGesture = pointerID => {
    if (gesture?.pointerID != null && gesture.pointerID !== pointerID) return;
    resetGesture();
  };

  if ('PointerEvent' in window) {
    document.addEventListener('pointerdown', event => {
      if ((!event.pointerType || event.pointerType === 'touch') && event.isPrimary) {
        beginGesture(event, event, event.pointerId);
      }
    }, { capture: true, passive: true });
    document.addEventListener('pointermove', event => {
      if (event.isPrimary) moveGesture(event, event, event.pointerId);
    }, { capture: true, passive: false });
    document.addEventListener('pointerup', event => {
      if (event.isPrimary) endGesture(event, event, event.pointerId);
    }, { capture: true, passive: true });
    document.addEventListener('pointercancel', event => cancelGesture(event.pointerId), true);
  } else {
    const point = event => event.changedTouches?.[0] || event.touches?.[0] || null;
    document.addEventListener('touchstart', event => {
      if (event.touches.length === 1) beginGesture(event, point(event));
    }, { capture: true, passive: true });
    document.addEventListener('touchmove', event => {
      if (event.touches.length === 1) moveGesture(event, point(event));
    }, { capture: true, passive: false });
    document.addEventListener('touchend', event => endGesture(event, point(event)), {
      capture: true, passive: true
    });
    document.addEventListener('touchcancel', () => cancelGesture(), true);
  }

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (performance.now() < suppressPlayerClickUntil && target?.closest(PLAYER_SELECTOR)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const link = target?.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    let destination;
    try { destination = new URL(link.href, location.href); } catch { return; }
    if (allowedHosts.has(destination.hostname.toLowerCase()) && isShortsPath(destination.pathname)) {
      event.preventDefault(); event.stopImmediatePropagation(); location.assign(focusedEntryURL);
    }
  }, true);

  installStyle();
  updateMoreVideosAvailability();
  const mutationChangesPlayerTopology = mutation => {
    const selector = `${PLAYER_SELECTOR}, video`;
    return [...mutation.addedNodes, ...mutation.removedNodes].some(node => (
      node instanceof Element && (node.matches(selector) || node.querySelector(selector))
    ));
  };
  new MutationObserver(mutations => {
    if (mutations.some(value => value.addedNodes.length > 0)) scheduleAdAudit();
    if (mutations.some(mutationChangesPlayerTopology)) {
      scheduleMoreVideosAvailability();
    }
    recoverFromShorts();
  }).observe(html, { childList: true, subtree: true });
  for (const name of [
    'popstate', 'pageshow', 'yt-navigate-finish', 'yt-page-data-updated',
    'state-navigateend', 'state-navigatecomplete', '__vigilRouteChanged'
  ]) {
    addEventListener(name, recoverFromShorts, true);
    document.addEventListener(name, recoverFromShorts, true);
  }
  for (const name of ['fullscreenchange', 'webkitfullscreenchange',
    'webkitbeginfullscreen', 'webkitendfullscreen']) {
    document.addEventListener(name, scheduleMoreVideosAvailability, true);
  }
  addEventListener('resize', scheduleMoreVideosAvailability);
  addEventListener('orientationchange', scheduleMoreVideosAvailability);
  window.visualViewport?.addEventListener('resize', scheduleMoreVideosAvailability);
  document.addEventListener('play', scheduleAdAudit, true);
  document.addEventListener('durationchange', scheduleAdAudit, true);
  suppressYouTubeAds();
  setInterval(() => {
    installStyle(); suppressYouTubeAds(); updateMoreVideosAvailability(); recoverFromShorts();
  }, 1000);

  Object.defineProperty(window, '__vigilYouTubeParityTest', {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      suppressYouTubeAds, moreVideosAllowedForState, updateMoreVideosAvailability,
      enterFullscreen, playerForVideo, isShortsRoute, isWatchRoute
    })
  });
})();
