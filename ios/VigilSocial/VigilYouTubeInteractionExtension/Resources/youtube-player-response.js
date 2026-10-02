(() => {
  'use strict';
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
  if (!allowedHosts.has(location.hostname) || window.__vigilYouTubeResponseGuard) return;
  window.__vigilYouTubeResponseGuard = true;
  const PLAYER_RESPONSE_PATHS = new Set([
    '/youtubei/v1/player', '/youtubei/v1/get_watch', '/youtubei/v1/next', '/get_watch', '/playlist'
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
    if (!value || typeof value !== 'object' || seen.has(value)) return true;
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
    // Mobile watch responses wrap the player beneath several renderer layers.
    // Remove only ad arrays belonging to a positively identified player.
    return Object.values(value).every(item => !item || typeof item !== 'object'
      || collectPlayerAdFields(item, targets, seen));
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
    if (descriptor && (!descriptor.configurable || !('value' in descriptor) || !descriptor.writable)) return;
    let current = descriptor?.value;
    current = clonedPrunedPlayerResponse(current) || current;
    try {
      Object.defineProperty(window, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? true,
        get: () => current,
        set: value => { current = clonedPrunedPlayerResponse(value) || value; }
      });
    } catch {}
  };
  installFetchPlayerResponseGuard();
  installXHRPlayerResponseGuard();
  installInitialPlayerResponseGuard();

})();
